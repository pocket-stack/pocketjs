import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostBuildInputs } from "../framework/src/manifest/host-build-inputs.ts";
import {
  D211_LINUX_DEV_TARGET_ID,
  resolveD211LinuxBuildPlan,
} from "./d211-linux-profile.ts";
import {
  buildGuestBundle,
  ensureQuickJsCheckout,
  type GuestBundleRequest,
  mustRunCommand,
  printCheck,
  quickJsCheckoutStatus,
  readGuestBundle,
  runCommand,
  sha256File,
} from "./native-host-build.ts";

/**
 * ArtInChip D211DBV on Luban Linux 5.10.
 *
 * The cross-build runs on the canonical builder — the Ubuntu host with the
 * built Luban SDK — while `deploy` and `run` talk to the D211 attached over
 * ADB on the development machine:
 *
 *   Ubuntu: bun tools/d211-linux.ts build
 *   macOS:  bun tools/d211-linux.ts deploy
 *
 * The host contract is private until the hardware acceptance receipt passes.
 */

interface D211Toolchain {
  readonly toolchainVersion: string;
  readonly cachePath: string;
  readonly luban: {
    readonly outputDirectory: string;
    readonly gccPrefix: string;
  };
  readonly rust: {
    readonly toolchain: string;
    readonly target: string;
  };
  readonly quickjs: {
    readonly version: string;
    readonly repository: string;
    readonly revision: string;
  };
  readonly device: {
    readonly name: string;
    readonly platform: string;
    readonly cpu: string;
    readonly physicalViewport: readonly [number, number];
    readonly logicalViewport: readonly [number, number];
    readonly rasterDensity: number;
  };
  readonly app: {
    readonly manifest: string;
    readonly binary: string;
    readonly outputDirectory: string;
  };
}

const LABEL = "PocketJS D211 Linux";
const repository = fileURLToPath(new URL("..", import.meta.url));
const command = Bun.argv[2] ?? "doctor";
const toolchain = JSON.parse(
  readFileSync(join(repository, "tools/cli/d211-linux-toolchain.json"), "utf8"),
) as D211Toolchain;

const cache = join(homedir(), ".cache/pocket-stack", toolchain.cachePath);
const quickJsRoot = join(cache, "sources/quickjs-rs");
const lldShim = join(cache, "build/lld-shim");
const rustTargetDirectory = join(repository, ".pocket-build/d211-linux/rust-target");
const nativeBuild = join(repository, ".pocket-build/d211-linux/runtime");
const outputDirectory = join(repository, toolchain.app.outputDirectory);
const outputBinary = join(outputDirectory, toolchain.app.binary);
const outputReceipt = join(outputDirectory, "build-receipt.json");
const lubanSdkRoot = (process.env.D211_LUBAN_SDK ?? "").trim() || join(homedir(), "d211");
const lubanOutput = join(lubanSdkRoot, toolchain.luban.outputDirectory);
const lubanSysroot = join(lubanOutput, "host/riscv64-linux-gnu/sysroot");
const lubanGcc = join(
  lubanOutput,
  `host/bin/${toolchain.luban.gccPrefix}-gcc`,
);
const rustCoreArchive = join(
  rustTargetDirectory,
  `${toolchain.rust.target}/release/libpocketjs_symbian_core.a`,
);
const guest: GuestBundleRequest = {
  label: LABEL,
  repository,
  target: D211_LINUX_DEV_TARGET_ID,
  resolvePlan: (manifest) => resolveD211LinuxBuildPlan(manifest),
  manifestPath: join(repository, toolchain.app.manifest),
  planPath: join(repository, ".pocket/d211-linux/d211-demo.plan.json"),
  outputDirectory: join(repository, "dist/d211-linux/guest"),
};

function run(program: string, args: readonly string[]) {
  return runCommand(program, args, repository);
}

/** Doctor tolerates a missing binary instead of throwing on spawn. */
function probe(program: string, args: readonly string[]) {
  try {
    return run(program, args);
  } catch (error) {
    return { exitCode: -1, stdout: "", stderr: String(error) };
  }
}

function mustRun(
  program: string,
  args: readonly string[],
  cwd = repository,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return mustRunCommand(LABEL, program, args, cwd, env);
}

function rustSysroot(): string {
  return mustRun("rustup", [
    "run",
    toolchain.rust.toolchain,
    "rustc",
    "--print",
    "sysroot",
  ]).trim();
}

function lldPath(): string {
  return join(
    rustSysroot(),
    "lib/rustlib/x86_64-unknown-linux-gnu/bin/gcc-ld/ld.lld",
  );
}

/** Symlinks the nightly LLD under the Luban target prefix; never replaces it. */
function ensureLldShim(): void {
  mkdirSync(lldShim, { recursive: true });
  const lld = lldPath();
  if (!existsSync(lld)) {
    throw new Error(`${LABEL}: nightly LLD is absent: ${lld}`);
  }
  for (const name of ["ld.lld", `${toolchain.luban.gccPrefix}-ld.lld`]) {
    const link = join(lldShim, name);
    if (existsSync(link)) continue;
    try {
      symlinkSync(lld, link);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function targetInstalled(): boolean {
  const installed = probe("rustup", [
    "target",
    "list",
    "--installed",
    "--toolchain",
    toolchain.rust.toolchain,
  ]);
  return installed.exitCode === 0 &&
    installed.stdout.split("\n").includes(toolchain.rust.target);
}

function doctor(): void {
  const gccVersion = probe(lubanGcc, ["--version"]);
  const rustcVersion = probe("rustup", [
    "run",
    toolchain.rust.toolchain,
    "rustc",
    "--version",
  ]);
  const quickjs = quickJsCheckoutStatus(quickJsRoot, toolchain.quickjs);
  const checks = [
    printCheck(
      "Luban GCC wrapper",
      gccVersion.exitCode === 0,
      gccVersion.stdout.split("\n")[0] || lubanGcc,
    ),
    printCheck("Luban sysroot", existsSync(lubanSysroot), lubanSysroot),
    printCheck(
      "Rust nightly",
      rustcVersion.exitCode === 0,
      rustcVersion.stdout.trim() || toolchain.rust.toolchain,
    ),
    printCheck(
      `Rust target ${toolchain.rust.target}`,
      targetInstalled(),
      toolchain.rust.target,
    ),
    printCheck("nightly LLD", existsSync(lldPath()), lldPath()),
    printCheck("pinned QuickJS", quickjs.ok, quickjs.detail),
  ];
  if (checks.some((ok) => !ok)) process.exitCode = 1;
  else console.log(`[ok] toolchain: ${toolchain.toolchainVersion}`);
}

function setup(): void {
  ensureQuickJsCheckout(LABEL, quickJsRoot, toolchain.quickjs);
  ensureLldShim();
  doctor();
}

function buildRustCore(): string {
  mkdirSync(rustTargetDirectory, { recursive: true });
  mustRun(
    "rustup",
    [
      "run",
      toolchain.rust.toolchain,
      "cargo",
      "build",
      "--release",
      "--locked",
      "--features",
      "bare-platform,software-only",
      "--target",
      toolchain.rust.target,
    ],
    join(repository, "engine/ui-cabi"),
    { ...process.env, CARGO_TARGET_DIR: rustTargetDirectory },
  );
  if (!existsSync(rustCoreArchive)) {
    throw new Error(`${LABEL}: Rust core archive is absent: ${rustCoreArchive}`);
  }
  return rustCoreArchive;
}

function writeReceipt(buildId: string, inputs: HostBuildInputs): void {
  const src = join(nativeBuild, "staging", toolchain.app.binary);
  const elf = existsSync(join(nativeBuild, "pocketjs-d211.readelf.txt"))
    ? readFileSync(join(nativeBuild, "pocketjs-d211.readelf.txt"), "utf8")
    : "";
  const receipt = {
    schemaVersion: 1,
    toolchainVersion: toolchain.toolchainVersion,
    buildId,
    pocketJsCommit: mustRun("git", ["rev-parse", "HEAD"]),
    hostContract: inputs,
    device: toolchain.device,
    rustToolchain: toolchain.rust.toolchain,
    rustTarget: toolchain.rust.target,
    rustcVersion: mustRun("rustup", [
      "run",
      toolchain.rust.toolchain,
      "rustc",
      "--version",
    ]),
    gccVersion: mustRun(lubanGcc, ["--version"]).split("\n")[0],
    sysroot: lubanSysroot,
    lld: lldPath(),
    lldVersion: mustRun(lldPath(), ["--version"]).split("\n")[0],
    quickJsRevision: toolchain.quickjs.revision,
    quickJsVersion: toolchain.quickjs.version,
    guestJavaScriptSha256: sha256File(join(outputDirectory, "app.js")),
    guestPackSha256: sha256File(join(outputDirectory, "app.pak")),
    coreLibrarySha256: sha256File(rustCoreArchive),
    executableSha256: sha256File(src),
    executableBytes: readFileSync(src).byteLength,
    elf,
  };
  writeFileSync(outputReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`${LABEL}: receipt -> ${outputReceipt}`);
}

function buildRuntime(): void {
  ensureQuickJsCheckout(LABEL, quickJsRoot, toolchain.quickjs);
  ensureLldShim();
  const bundle = readGuestBundle(guest);
  const coreLibrary = buildRustCore();
  const buildId = randomBytes(8).toString("hex");
  const staging = join(nativeBuild, "staging");
  mkdirSync(staging, { recursive: true });
  mkdirSync(outputDirectory, { recursive: true });

  copyFileSync(coreLibrary, join(nativeBuild, "libpocketjs_symbian_core.a"));

  mustRun("bash", [join(repository, "tools/d211-linux/build-runtime.sh")], repository, {
    ...process.env,
    POCKET_BUILD_ID: buildId,
    POCKETJS_TARGET_ID: guest.target,
    POCKETJS_HOST_ABI: String(bundle.inputs.hostAbi),
    POCKET_RASTER_DENSITY: String(bundle.inputs.viewport.rasterDensity),
    POCKET_LOGICAL_WIDTH: String(bundle.inputs.viewport.logical[0]),
    POCKET_LOGICAL_HEIGHT: String(bundle.inputs.viewport.logical[1]),
    REPO_ROOT: repository,
    BUILD_DIR: nativeBuild,
    LUBAN_OUTPUT_DIR: lubanOutput,
    LUBAN_GCC_PREFIX: toolchain.luban.gccPrefix,
    LLD_SHIM_DIR: lldShim,
    QUICKJS_VERSION: toolchain.quickjs.version,
    QUICKJS_DIR: join(quickJsRoot, "libquickjs-sys/embed/quickjs"),
    QUICKJS_STATIC_FUNCTIONS: join(
      quickJsRoot,
      "libquickjs-sys/embed/static-functions.c",
    ),
    RUST_CORE_ARCHIVE: join(nativeBuild, "libpocketjs_symbian_core.a"),
  });

  const readelf = readFileSync(
    join(nativeBuild, "pocketjs-d211.readelf.txt"),
    "utf8",
  );
  const symbols = readFileSync(
    join(nativeBuild, "pocketjs-d211.symbols.txt"),
    "utf8",
  );
  const expectedElf = ["RISC-V", "RVC", "double-float ABI", "ld-linux-riscv64-lp64d.so.1"];
  for (const marker of expectedElf) {
    if (!readelf.includes(marker)) {
      throw new Error(`${LABEL}: linked ELF is missing ${marker}`);
    }
  }
  const expectedSymbols = [
    " main",
    " pocket_runtime_boot",
    " pocket_runtime_tick",
    " ui_render_incremental_scaled",
    " d211_input_open",
  ];
  for (const symbol of expectedSymbols) {
    if (!symbols.includes(symbol)) {
      throw new Error(`${LABEL}: linked ELF is missing${symbol}`);
    }
  }

  const staged = join(staging, toolchain.app.binary);
  copyFileSync(staged, outputBinary);
  copyFileSync(bundle.javaScript, join(outputDirectory, "app.js"));
  copyFileSync(bundle.pack, join(outputDirectory, "app.pak"));

  writeReceipt(buildId, bundle.inputs);
  console.log(`${LABEL}: ${toolchain.app.binary} -> ${outputBinary}`);
  console.log(`SHA-256: ${sha256File(outputBinary)}`);
}

function build(): void {
  buildGuestBundle(guest);
  buildRuntime();
}

function requireArtifacts(): void {
  for (const path of [outputBinary, join(outputDirectory, "app.js"), join(outputDirectory, "app.pak")]) {
    if (!existsSync(path)) {
      throw new Error(`${LABEL}: ${path} is absent; run \`bun tools/d211-linux.ts build\` on the builder and sync the artifacts`);
    }
  }
}

function requireAdb(): void {
  if (probe("adb", ["version"]).exitCode !== 0) {
    throw new Error(`${LABEL}: adb is not available on this machine`);
  }
}

/**
 * The application is installed on the rootfs, not /tmp: /tmp is a tmpfs on
 * this board and a resident bundle there costs RAM the 64 MB system cannot
 * spare (an install in /tmp OOM-killed the host under touch input).
 */
const DEVICE_DIRECTORY = "/opt/pocketjs";

function deploy(): void {
  requireAdb();
  requireArtifacts();
  mustRun("adb", ["shell", "mkdir", "-p", DEVICE_DIRECTORY]);
  mustRun("adb", ["push", outputBinary, `${DEVICE_DIRECTORY}/pocketjs-d211`]);
  mustRun("adb", ["push", join(outputDirectory, "app.js"), `${DEVICE_DIRECTORY}/app.js`]);
  mustRun("adb", ["push", join(outputDirectory, "app.pak"), `${DEVICE_DIRECTORY}/app.pak`]);
  mustRun("adb", ["shell", "chmod", "+x", `${DEVICE_DIRECTORY}/pocketjs-d211`]);
  console.log(`${LABEL}: installed to ${DEVICE_DIRECTORY} (rootfs, not tmpfs)`);
}

function runOnDevice(): void {
  requireAdb();
  const result = run("adb", [
    "shell",
    `cd ${DEVICE_DIRECTORY} && ./${toolchain.app.binary}`,
  ]);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

function stopUi(): void {
  requireAdb();
  /* test_lvgl ignores SIGTERM; SIGKILL is what actually releases the panel. */
  run("adb", ["shell", "killall", "-9", "test_lvgl"]);
  console.log(`${LABEL}: stopped test_lvgl (SIGKILL) when present`);
}

function receipt(): void {
  if (!existsSync(outputReceipt)) {
    throw new Error(`${LABEL}: no receipt at ${outputReceipt}`);
  }
  console.log(readFileSync(outputReceipt, "utf8"));
}

switch (command) {
  case "doctor":
    doctor();
    break;
  case "setup":
    setup();
    break;
  case "build-demo":
    buildGuestBundle(guest);
    break;
  case "build-runtime":
    buildRuntime();
    break;
  case "build":
    build();
    break;
  case "receipt":
    receipt();
    break;
  case "deploy":
    deploy();
    break;
  case "run":
    runOnDevice();
    break;
  case "stop-ui":
    stopUi();
    break;
  default:
    throw new Error(
      "usage: bun tools/d211-linux.ts <doctor|setup|build-demo|build-runtime|build|receipt|deploy|run|stop-ui>",
    );
}
