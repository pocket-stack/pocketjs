// tools/3ds.ts <app> [cargo args…] — build the app JS+pak (tools/build.ts), the
// Rust core staticlib, QuickJS, and the .3dsx for the out-of-registry "3ds-dev"
// profile (tools/3ds-profile.ts).
//
//   bun tools/3ds.ts 3ds-demo
//   bun tools/3ds.ts 3ds-demo --capture           (e2e frame-dump build)
//   bun tools/3ds.ts --plan=<resolved-plan.json> --project-root=<dir>
//
// The toolchain spans two environments. The Rust half compiles on macOS:
// armv6k-nintendo-3ds is a built-in rustc target, so -Z build-std works
// host-side with no devkitARM present. The C half compiles inside the
// devkitpro/devkitarm container, which owns arm-none-eabi-gcc, libctru,
// citro3d, picasso and 3dsxtool. Both halves see the same repository through
// one bind mount at /repo.
//
//   1. tools/build.ts        -> <outdir>/<output>.js + <outdir>/<output>.pak
//   2. cargo build --release -> hosts/3ds/core/target/armv6k-nintendo-3ds/release/
//                               libpocketjs_3ds_core.a   (macOS)
//   3. QuickJS               -> dist/3ds/quickjs/libquickjs.a  (container, cached)
//   4. hosts/3ds/Makefile    -> dist/3ds/<output>.3dsx          (container)
//
// <output> is the resolved plan's app.output, not the bare app argument.
//
// dist/3ds/ is this target's own output tree. A 3DS build never writes into
// dist/, where a PSP or Vita build keeps target-flavored bundles of the same
// name.
//
// ---------------------------------------------------------------------------
// The contract with hosts/3ds/Makefile
// ---------------------------------------------------------------------------
// The Makefile runs in the container with CWD /repo/hosts/3ds and receives all
// paths as container paths. It gets the twelve variables hostBuildEnvironment()
// emits (POCKETJS_APP_OUTPUT, POCKETJS_EMBED_APP, POCKETJS_OUTPUT_DIR,
// POCKETJS_TARGET, POCKETJS_HOST_ABI, POCKETJS_LOGICAL_WIDTH/HEIGHT,
// POCKETJS_PHYSICAL_WIDTH/HEIGHT, POCKETJS_PRESENTATION,
// POCKETJS_RASTER_DENSITY) — POCKETJS_TARGET and POCKETJS_HOST_ABI are the
// values the host must publish as ui.__host / ui.__hostAbi, so the C compile
// derives -DPOCKETJS_TARGET_ID and -DPOCKETJS_HOST_ABI from them rather than
// from literals — plus:
//
//   POCKETJS_CORE_LIB      absolute path to libpocketjs_3ds_core.a
//   POCKETJS_QUICKJS_DIR   directory holding quickjs.h and libquickjs.a
//   POCKETJS_APP_JS        the guest bundle to embed
//   POCKETJS_APP_PAK       the guest pak to embed
//   POCKETJS_BUILD_DIR     scratch directory for objects, .shbin and the .elf
//   POCKETJS_OUT_3DSX      the .3dsx path to write
//   POCKETJS_SMDH_TITLE    application title  (3dsxtool --smdh metadata)
//   POCKETJS_SMDH_AUTHOR   application id
//   POCKETJS_SMDH_DESC     application description
//   POCKETJS_CAPTURE       "1" under --capture, "" otherwise
//   POCKETJS_CAPTURE_INPUT scripted input tape ("frame:mask,…"), baked in
//   POCKETJS_CAP_START     first frame to dump
//   POCKETJS_CAP_N         how many frames to dump
//
// The default goal must produce POCKETJS_OUT_3DSX and nothing outside
// POCKETJS_BUILD_DIR and dist/3ds/.

import { $ } from "bun";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import {
  extractHostBuildInputs,
  hostBuildEnvironment,
} from "../framework/src/manifest/host-build-inputs.ts";
import {
  verifyPlanHash,
  type ResolvedBuildPlan,
} from "../framework/src/manifest/plan.ts";
import {
  THREE_DS_DEV_TARGET_ID,
  resolve3dsBuildPlan,
} from "./3ds-profile.ts";

const repository = new URL("..", import.meta.url).pathname; // PocketJS/
const hostDirectory = `${repository}hosts/3ds/`;
const coreDirectory = `${hostDirectory}core/`;

/** The dev profile's target id; a plan for any other target is rejected. */
const TARGET_ID = THREE_DS_DEV_TARGET_ID;
const RUST_TARGET = "armv6k-nintendo-3ds";
/** Produced by the `pocketjs-3ds-core` staticlib crate in hosts/3ds/core. */
const CORE_STATIC_LIBRARY = "libpocketjs_3ds_core.a";
const CONTAINER_IMAGE = "devkitpro/devkitarm:latest";
const CONTAINER_REPOSITORY = "/repo";
const CONTAINER_OUTPUT = "/out";

// The QuickJS revision hosts/psp/Cargo.toml pins, unpacked by cargo into the
// git checkout cache. libquickjs-sys's build.rs is bypassed: it would need the
// `cc` crate to find a 3DS-capable compiler on macOS, and there is none.
const QUICKJS_CHECKOUT =
  ".cargo/git/checkouts/quickjs-rs-1bf011a924d415f9/ba5bdd0/libquickjs-sys/embed/quickjs";
const QUICKJS_SOURCES = [
  "quickjs.c",
  "cutils.c",
  "libregexp.c",
  "libunicode.c",
  "dtoa.c",
] as const;
const QUICKJS_HEADERS = [
  "cutils.h",
  "dtoa.h",
  "libregexp-opcode.h",
  "libregexp.h",
  "libunicode-table.h",
  "libunicode.h",
  "list.h",
  "quickjs-atom.h",
  "quickjs-opcode.h",
  "quickjs.h",
] as const;

/** The devkitARM ABI, published by the toolchain itself in 3dsvars.sh. */
const ARM_ARCHITECTURE_FLAGS = [
  "-march=armv6k",
  "-mtune=mpcore",
  "-mfloat-abi=hard",
  "-mtp=soft",
  "-mword-relocations",
  "-ffunction-sections",
  "-fdata-sections",
];

// Verified to build a 1.3 MB libquickjs.a exporting 181 JS_* symbols.
// JS_NO_NAN_BOXING matches libquickjs-sys's own Vita treatment (16-byte
// JSValue on 32-bit ARM). __TM_GMTOFF is how newlib gates struct tm's
// tm_gmtoff, which js_date_getTimezoneOffset reads on every target that is
// neither __PSP__ nor __vita__ — and the same two macros are why malloc.h has
// to be force-included here rather than by quickjs.c itself. devkitARM ships
// GCC 16, which promoted incompatible pointer types to errors; this is the
// same source that builds for PSP.
const QUICKJS_COMPILE_FLAGS = [
  ...ARM_ARCHITECTURE_FLAGS,
  "-O2",
  "-D__3DS__",
  "-DCONFIG_VERSION='\"pocket3ds\"'",
  "-D_GNU_SOURCE",
  "-DJS_NO_NAN_BOXING",
  "-D__TM_GMTOFF=tm_gmtoff",
  "-include",
  "malloc.h",
  "-fno-strict-aliasing",
  "-funsigned-char",
  "-Wno-incompatible-pointer-types",
  "-Wno-implicit-function-declaration",
  "-I.",
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface ThreeDsArguments {
  /** Bare app name (apps/<app>/pocket.json); empty when --plan is given. */
  readonly app: string;
  readonly planPath?: string;
  readonly projectRoot: string;
  /** Where tools/build.ts writes <app>.js and <app>.pak (trailing slash). */
  readonly outputDir: string;
  /** Where the .3dsx lands. */
  readonly packageDir: string;
  readonly skipBuild: boolean;
  readonly capture: boolean;
  readonly configPath: string;
  readonly configFlagged: boolean;
  readonly useConfig: boolean;
  /** Forwarded to tools/build.ts. */
  readonly buildFlags: readonly string[];
  /** Everything unrecognized, forwarded to cargo. */
  readonly cargoArgs: readonly string[];
}

export interface ParseOptions {
  readonly repositoryRoot?: string;
  readonly workingDirectory?: string;
}

export function parse3dsArguments(
  argv: readonly string[],
  options: ParseOptions = {},
): ThreeDsArguments {
  const root = options.repositoryRoot ?? repository;
  let app = "";
  let planPath: string | undefined;
  let projectRoot = options.workingDirectory ?? process.cwd();
  let outputDir = `${root}dist/3ds/guest/`;
  let packageDir = `${root}dist/3ds`;
  let skipBuild = false;
  let capture = false;
  let configPath = `${root}pocket.config.ts`;
  let configFlagged = false;
  let useConfig = true;
  const buildFlags: string[] = [];
  const cargoArgs: string[] = [];

  for (const a of argv) {
    if (a === "--capture") capture = true;
    else if (a === "--skip-build") skipBuild = true;
    else if (a.startsWith("--plan=")) planPath = resolvePath(a.slice("--plan=".length));
    else if (a.startsWith("--project-root=")) projectRoot = resolvePath(a.slice("--project-root=".length));
    else if (a.startsWith("--outdir=")) outputDir = resolvePath(a.slice("--outdir=".length)) + "/";
    else if (a.startsWith("--package-outdir=")) packageDir = resolvePath(a.slice("--package-outdir=".length));
    else if (a.startsWith("--config=")) {
      configPath = resolvePath(root, a.slice("--config=".length));
      configFlagged = true;
      buildFlags.push(a);
    } else if (a === "--no-config") {
      useConfig = false;
      buildFlags.push(a);
    } else if (!app && !a.startsWith("-")) app = a;
    else cargoArgs.push(a);
  }

  return {
    app,
    planPath,
    projectRoot,
    outputDir,
    packageDir,
    skipBuild,
    capture,
    configPath,
    configFlagged,
    useConfig,
    buildFlags,
    cargoArgs,
  };
}

const USAGE =
  "usage: bun tools/3ds.ts <app> [--plan=<resolved-plan.json>] [--project-root=<dir>] " +
  "[--outdir=<dir>] [--package-outdir=<dir>] [--skip-build] [--capture] [cargo args…]   " +
  "e.g. bun tools/3ds.ts 3ds-demo --capture";

// ---------------------------------------------------------------------------
// Container plumbing
// ---------------------------------------------------------------------------

interface Mount {
  readonly hostPath: string;
  readonly containerPath: string;
}

/**
 * Translate a macOS path into the container path it is mounted at. Longest
 * mount wins so a nested output directory maps through its own mount.
 */
export function containerPathFor(
  hostPath: string,
  mounts: readonly Mount[],
): string {
  const absolute = resolvePath(hostPath);
  const candidates = [...mounts].sort(
    (a, b) => resolvePath(b.hostPath).length - resolvePath(a.hostPath).length,
  );
  for (const mount of candidates) {
    const base = resolvePath(mount.hostPath);
    if (absolute === base) return mount.containerPath;
    if (absolute.startsWith(`${base}/`)) {
      return `${mount.containerPath}${absolute.slice(base.length)}`;
    }
  }
  throw new Error(
    `PocketJS 3ds: ${absolute} is outside every container mount ` +
      `(${mounts.map((mount) => resolvePath(mount.hostPath)).join(", ")}); ` +
      "keep --outdir/--package-outdir inside the repository or the project root",
  );
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function capture(
  command: string,
  args: readonly string[],
  cwd = repository,
): Promise<CommandResult> {
  const child = Bun.spawn({
    cmd: [command, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** Preamble every container script needs: the tools are not on PATH. */
const CONTAINER_PREAMBLE = [
  "set -euo pipefail",
  'export DEVKITPRO="${DEVKITPRO:-/opt/devkitpro}"',
  'export DEVKITARM="${DEVKITARM:-/opt/devkitpro/devkitARM}"',
  'export PATH="$DEVKITARM/bin:$DEVKITPRO/tools/bin:$PATH"',
].join("\n");

async function runContainer(
  script: string,
  mounts: readonly Mount[],
  workingDirectory: string,
  environment: Readonly<Record<string, string>>,
  label: string,
): Promise<void> {
  const args = ["run", "--rm", "--network=none"];
  for (const mount of mounts) {
    args.push("-v", `${resolvePath(mount.hostPath)}:${mount.containerPath}`);
  }
  args.push("-w", workingDirectory);
  for (const [key, value] of Object.entries(environment)) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(CONTAINER_IMAGE, "bash", "-c", `${CONTAINER_PREAMBLE}\n${script}`);
  const child = Bun.spawn({
    cmd: ["docker", ...args],
    cwd: repository,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`PocketJS 3ds: ${label} failed in ${CONTAINER_IMAGE} (${exitCode})`);
  }
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

async function preflightContainer(): Promise<string> {
  if (!Bun.which("docker")) {
    throw new Error(
      "PocketJS 3ds: docker was not found on PATH. The 3DS C toolchain " +
        "(arm-none-eabi-gcc, libctru, citro3d, picasso, 3dsxtool) only exists " +
        "in a container; install Docker Desktop and start it.",
    );
  }
  const daemon = await capture("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (daemon.exitCode !== 0) {
    throw new Error(
      "PocketJS 3ds: the Docker daemon is not responding — start Docker Desktop and retry.\n" +
        (daemon.stderr.trim() || daemon.stdout.trim()),
    );
  }
  const image = await capture("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    CONTAINER_IMAGE,
  ]);
  if (image.exitCode !== 0) {
    throw new Error(
      `PocketJS 3ds: the ${CONTAINER_IMAGE} image is not present locally. Run:\n` +
        `  docker pull ${CONTAINER_IMAGE}`,
    );
  }
  return image.stdout.trim();
}

/**
 * The toolchain the Rust core builds with: hosts/3ds/core/rust-toolchain.toml
 * owns the choice when it exists, otherwise plain nightly. -Z build-std needs
 * rust-src for whichever one wins.
 */
async function preflightRust(): Promise<{ rustup: string; toolchain: string }> {
  const rustup = Bun.which("rustup") ?? `${homedir()}/.cargo/bin/rustup`;
  if (!existsSync(rustup)) {
    throw new Error(
      "PocketJS 3ds: rustup not found (expected ~/.cargo/bin/rustup). Install Rust from https://rustup.rs.",
    );
  }
  let toolchain = "nightly";
  if (existsSync(`${coreDirectory}rust-toolchain.toml`)) {
    const active = await capture(rustup, ["show", "active-toolchain"], coreDirectory);
    const named = active.stdout.trim().split(/\s+/)[0];
    if (active.exitCode === 0 && named) toolchain = named;
  }
  const rustc = await capture(rustup, ["run", toolchain, "rustc", "--version"]);
  if (rustc.exitCode !== 0) {
    throw new Error(
      `PocketJS 3ds: the ${toolchain} toolchain is not installed. Run:\n` +
        `  rustup toolchain install ${toolchain}`,
    );
  }
  const components = await capture(rustup, [
    "component",
    "list",
    "--toolchain",
    toolchain,
    "--installed",
  ]);
  if (!components.stdout.split(/\r?\n/).some((line) => line.startsWith("rust-src"))) {
    throw new Error(
      `PocketJS 3ds: rust-src is required to build core/alloc for ${RUST_TARGET}. Run:\n` +
        `  rustup component add rust-src --toolchain ${toolchain}`,
    );
  }
  return { rustup, toolchain };
}

// ---------------------------------------------------------------------------
// QuickJS
// ---------------------------------------------------------------------------

function quickJsSourceDirectory(): string {
  const pinned = join(homedir(), QUICKJS_CHECKOUT);
  if (existsSync(join(pinned, "quickjs.c"))) return pinned;
  throw new Error(
    `PocketJS 3ds: the pinned QuickJS sources are absent at ${pinned}. ` +
      "They arrive with the PSP host's dependencies — run `cargo fetch` in hosts/psp/ " +
      "(or `bun run bootstrap`) and retry.",
  );
}

/**
 * Compile QuickJS for the 3DS in the container and cache the archive. The
 * stamp covers the sources, the flag set and the container image, so a new
 * devkitARM release or an edited flag rebuilds and nothing else does.
 */
export async function ensureQuickJs(
  cacheDirectory: string,
  imageId: string,
  mounts: readonly Mount[],
): Promise<void> {
  const sources = quickJsSourceDirectory();
  const files = [...QUICKJS_SOURCES, ...QUICKJS_HEADERS];
  const digest = createHash("sha256");
  digest.update(imageId);
  digest.update(QUICKJS_COMPILE_FLAGS.join(" "));
  for (const name of files) {
    const path = join(sources, name);
    if (!existsSync(path)) {
      throw new Error(`PocketJS 3ds: QuickJS source ${name} is missing from ${sources}`);
    }
    digest.update(name);
    digest.update(readFileSync(path));
  }
  const stamp = digest.digest("hex");
  const stampPath = join(cacheDirectory, ".stamp");
  const archive = join(cacheDirectory, "libquickjs.a");
  if (
    existsSync(archive) &&
    existsSync(stampPath) &&
    readFileSync(stampPath, "utf8").trim() === stamp
  ) {
    console.log(`PocketJS 3ds: QuickJS cached (${archive})`);
    return;
  }

  mkdirSync(cacheDirectory, { recursive: true });
  for (const name of files) copyFileSync(join(sources, name), join(cacheDirectory, name));
  const objects = QUICKJS_SOURCES.map((name) => name.replace(/\.c$/, ".o"));
  const script = [
    "rm -f *.o libquickjs.a",
    `for src in ${QUICKJS_SOURCES.join(" ")}; do`,
    '  echo "cc $src"',
    `  arm-none-eabi-gcc ${QUICKJS_COMPILE_FLAGS.join(" ")} -c "$src" -o "\${src%.c}.o"`,
    "done",
    // D: deterministic archive (zeroed mtime/uid/gid), so the cache stamp and
    // the archive agree run to run.
    `arm-none-eabi-ar rcsD libquickjs.a ${objects.join(" ")}`,
  ].join("\n");
  console.log("PocketJS 3ds: compiling QuickJS for armv6k-nintendo-3ds …");
  await runContainer(
    script,
    mounts,
    containerPathFor(cacheDirectory, mounts),
    {},
    "QuickJS compile",
  );
  if (!existsSync(archive)) {
    throw new Error(`PocketJS 3ds: QuickJS compile did not produce ${archive}`);
  }
  writeFileSync(stampPath, `${stamp}\n`);
}

// ---------------------------------------------------------------------------
// Build plan
// ---------------------------------------------------------------------------

function assert3dsPlan(plan: ResolvedBuildPlan, origin: string): ResolvedBuildPlan {
  if (!verifyPlanHash(plan) || plan.target.id !== TARGET_ID) {
    throw new Error(`PocketJS 3ds: invalid ${TARGET_ID} ResolvedBuildPlan at ${origin}`);
  }
  return plan;
}

async function loadBuildPlan(
  args: ThreeDsArguments,
): Promise<{ plan: ResolvedBuildPlan; planPath: string }> {
  if (args.planPath) {
    if (args.configFlagged || !args.useConfig) {
      throw new Error("PocketJS 3ds: config overrides are forbidden with --plan");
    }
    const plan = (await Bun.file(args.planPath).json()) as ResolvedBuildPlan;
    return { plan: assert3dsPlan(plan, args.planPath), planPath: args.planPath };
  }
  // An app outside this repository is named relative to --project-root.
  const candidates = [
    ...new Set([
      join(args.projectRoot, "apps", args.app, "pocket.json"),
      `${repository}apps/${args.app}/pocket.json`,
    ]),
  ];
  const manifest = candidates.find((path) => existsSync(path));
  if (!manifest) {
    throw new Error(
      `PocketJS 3ds: no manifest for "${args.app}" (looked in ${candidates.join(", ")}). ` +
        "A 3DS app declares its own 400x240 native viewport; the stock " +
        "integer-fit demos cannot be admitted.",
    );
  }
  const plan = assert3dsPlan(
    resolve3dsBuildPlan(JSON.parse(readFileSync(manifest, "utf8"))),
    manifest,
  );
  const planPath = `${repository}.pocket/3ds/${plan.app.output}.plan.json`;
  mkdirSync(resolvePath(planPath, ".."), { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return { plan, planPath };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export async function build3ds(argv: readonly string[]): Promise<string> {
  const args = parse3dsArguments(argv);
  if (!args.app && !args.planPath) throw new Error(USAGE);
  if (!existsSync(hostDirectory)) {
    throw new Error(`PocketJS 3ds: the host is absent at ${hostDirectory}`);
  }

  const imageId = await preflightContainer();
  const { rustup, toolchain } = await preflightRust();
  const { plan, planPath } = await loadBuildPlan(args);
  const inputs = extractHostBuildInputs(plan, { expectedTarget: TARGET_ID });

  // 1. guest bundle + pak
  console.log(`PocketJS 3ds: building app "${plan.app.output}" (${plan.app.framework})`);
  mkdirSync(args.outputDir, { recursive: true });
  if (!args.skipBuild) {
    await $`bun tools/build.ts --plan=${planPath} --project-root=${args.projectRoot} --outdir=${args.outputDir} ${args.buildFlags}`
      .cwd(repository);
  }
  const guestJavaScript = join(args.outputDir, `${inputs.appOutput}.js`);
  const guestPack = join(args.outputDir, `${inputs.appOutput}.pak`);
  for (const artifact of [guestJavaScript, guestPack]) {
    if (!existsSync(artifact)) {
      throw new Error(`PocketJS 3ds: the guest build did not produce ${artifact}`);
    }
  }

  // 2. the Rust core staticlib, on macOS
  console.log(`PocketJS 3ds: cargo build --release (${RUST_TARGET}, ${toolchain})`);
  await $`${rustup} run ${toolchain} cargo build --release ${args.cargoArgs}`
    .cwd(coreDirectory)
    .env({
      ...process.env,
      ...hostBuildEnvironment(inputs, {
        outputDirectory: args.outputDir,
        embedApp: true,
      }),
    });
  const releaseDirectory = `${coreDirectory}target/${RUST_TARGET}/release`;
  const coreLibrary = join(releaseDirectory, CORE_STATIC_LIBRARY);
  if (!existsSync(coreLibrary)) {
    const found = existsSync(releaseDirectory)
      ? readdirSync(releaseDirectory).filter((name) => name.endsWith(".a"))
      : [];
    throw new Error(
      `PocketJS 3ds: ${CORE_STATIC_LIBRARY} is absent from ${releaseDirectory}` +
        (found.length > 0 ? ` (found ${found.join(", ")})` : "") +
        " — hosts/3ds/core must be a staticlib crate named pocketjs-3ds-core",
    );
  }

  // 3-4. everything that needs devkitARM
  const distributionRoot = `${repository}dist/3ds`;
  const quickJsDirectory = join(distributionRoot, "quickjs");
  const buildDirectory = join(distributionRoot, "build");
  mkdirSync(buildDirectory, { recursive: true });
  mkdirSync(args.packageDir, { recursive: true });

  const mounts: Mount[] = [
    { hostPath: repository, containerPath: CONTAINER_REPOSITORY },
  ];
  const outsideRepository = [args.outputDir, args.packageDir, args.projectRoot].filter(
    (path) => !resolvePath(path).startsWith(`${resolvePath(repository)}/`),
  );
  if (outsideRepository.length > 0) {
    // One extra mount covers an app built outside the repository; a second
    // distinct root would need its own and is refused by containerPathFor.
    mounts.push({
      hostPath: resolvePath(outsideRepository[0]),
      containerPath: CONTAINER_OUTPUT,
    });
  }

  await ensureQuickJs(quickJsDirectory, imageId, mounts);

  const output = join(args.packageDir, `${inputs.appOutput}.3dsx`);
  const makeEnvironment: Record<string, string> = {
    ...hostBuildEnvironment(inputs, {
      outputDirectory: containerPathFor(args.outputDir, mounts),
      embedApp: true,
    }),
    POCKETJS_CORE_LIB: containerPathFor(coreLibrary, mounts),
    POCKETJS_QUICKJS_DIR: containerPathFor(quickJsDirectory, mounts),
    POCKETJS_APP_JS: containerPathFor(guestJavaScript, mounts),
    POCKETJS_APP_PAK: containerPathFor(guestPack, mounts),
    POCKETJS_BUILD_DIR: containerPathFor(buildDirectory, mounts),
    POCKETJS_OUT_3DSX: containerPathFor(output, mounts),
    POCKETJS_SMDH_TITLE: plan.app.title,
    POCKETJS_SMDH_AUTHOR: plan.app.id,
    POCKETJS_SMDH_DESC: `PocketJS ${plan.app.title}`,
    POCKETJS_CAPTURE: args.capture ? "1" : "",
    // Explicit so a previous run's tape never lingers in the object cache.
    POCKETJS_CAPTURE_INPUT: process.env.POCKETJS_CAPTURE_INPUT ?? "",
    POCKETJS_CAP_START: process.env.POCKETJS_CAP_START ?? "",
    POCKETJS_CAP_N: process.env.POCKETJS_CAP_N ?? "",
  };

  console.log(`PocketJS 3ds: make (${CONTAINER_IMAGE}${args.capture ? ", capture" : ""})`);
  await runContainer(
    `make -j${availableParallelism()}`,
    mounts,
    containerPathFor(hostDirectory, mounts),
    makeEnvironment,
    "hosts/3ds/Makefile",
  );
  if (!existsSync(output)) {
    throw new Error(`PocketJS 3ds: the container build did not produce ${output}`);
  }
  console.log(`output: ${output}`);
  return output;
}

if (import.meta.main) {
  try {
    await build3ds(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
