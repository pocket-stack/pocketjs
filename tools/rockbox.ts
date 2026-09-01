import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractHostBuildInputs } from "../framework/src/manifest/host-build-inputs.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import {
  ROCKBOX_IPOD_CLASSIC_TARGET_ID,
  resolveRockboxBuildPlan,
} from "./rockbox-profile.ts";
import { POCKETROCK_QUICKJS_REVISION } from "./quickjs-bytecode.ts";
import {
  POCKET_SECTION,
  decodePocketPackage,
  findSection,
  findVariant,
} from "../contracts/spec/pocket-package.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));
const hostDirectory = join(repository, "hosts/rockbox");
const outputDirectory = join(repository, "dist/rockbox");
const pocketRockCoreFlags =
  "EXTRA_DEFINES+=-DHAVE_POCKETROCK_RUNTIME -DPOCKETROCK_MINIMAL_UI -DPOCKETROCK_ARENA_MIB=12 -DTLSF_STATISTIC=1 -ffunction-sections -fdata-sections";
const planPath = join(repository, ".pocket/rockbox-ipod-classic-dev/plan.json");
const embeddedPath = join(outputDirectory, "generated/app_data.c");
const defaultManifest = join(hostDirectory, "demo.pocket.json");
const targetJson = join(hostDirectory, "targets/armv5te-rockbox-eabi.json");
const coreDirectory = join(repository, "engine/symbian");
const coreArchive = join(
  coreDirectory,
  "target/armv5te-rockbox-eabi/release/libpocketjs_symbian_core.a",
);
const quickJsCheckout = join(outputDirectory, "quickjs-rs");
const quickJsPatch = join(repository, "tools/rockbox/quickjs.patch");
const command = Bun.argv[2] ?? "doctor";
const bundledPocketApps = [
  ["apps/hero-rockbox/pocket.json", "hero", "hero.pocket"],
  ["apps/pocketjs-tests/pocket.json", "pocketjs-tests", "pocketjs-tests.pocket"],
] as const;

function run(executable: string, args: readonly string[], cwd = repository): void {
  const result = Bun.spawnSync({
    cmd: [executable, ...args],
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  if (result.exitCode !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed (${result.exitCode})`);
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function quickJsSource(): string | undefined {
  const configured = process.env.POCKETJS_QUICKJS_DIR;
  if (configured && existsSync(join(configured, "quickjs.c"))) return configured;
  const nested = join(quickJsCheckout, "libquickjs-sys/embed/quickjs");
  return existsSync(join(nested, "quickjs.c")) ? nested : undefined;
}

function doctor(): void {
  const checks = [
    ["Bun", Bun.which("bun")],
    ["Rustup", Bun.which("rustup")],
    ["C compiler", Bun.which("cc")],
    ["Rockbox ARM compiler", Bun.which("arm-elf-eabi-gcc") ?? Bun.which("arm-none-eabi-gcc")],
  ] as const;
  for (const [label, path] of checks) {
    console.log(`${path ? "[ok]" : "[missing]"} ${label}: ${path ?? "not on PATH"}`);
  }
  const source = process.env.ROCKBOX_SOURCE;
  console.log(`${source && existsSync(join(source, "tools/configure")) ? "[ok]" : "[missing]"} Rockbox source: ${source ?? "set ROCKBOX_SOURCE"}`);
  const quickjs = quickJsSource();
  console.log(`${quickjs ? "[ok]" : "[missing]"} pinned QuickJS: ${quickjs ?? "run bun rockbox bootstrap"}`);
  if (checks.some(([, path]) => !path) || !source || !quickjs) process.exitCode = 1;
}

function bootstrap(): void {
  if (!existsSync(join(quickJsCheckout, ".git"))) {
    mkdirSync(outputDirectory, { recursive: true });
    run("git", ["clone", "--filter=blob:none", "--no-checkout",
      "https://github.com/pocket-stack/quickjs-rs.git", quickJsCheckout]);
  }
  run("git", ["-C", quickJsCheckout, "checkout", "--detach", POCKETROCK_QUICKJS_REVISION]);
  const reverse = Bun.spawnSync({
    cmd: ["git", "-C", quickJsCheckout, "apply", "--unidiff-zero",
      "--reverse", "--check", quickJsPatch],
    stdout: "ignore",
    stderr: "ignore",
  });
  if (reverse.exitCode !== 0) {
    run("git", ["-C", quickJsCheckout, "apply", "--unidiff-zero", quickJsPatch]);
  }
  console.log(`PocketJS Rockbox: pinned QuickJS ready at ${quickJsCheckout}`);
}

function currentPlan(manifestPath: string): ResolvedBuildPlan {
  return resolveRockboxBuildPlan(JSON.parse(readFileSync(manifestPath, "utf8")));
}

function cArray(name: string, bytes: Uint8Array): string {
  const rows: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    rows.push(`  ${[...bytes.subarray(offset, offset + 16)]
      .map((value) => `0x${value.toString(16).padStart(2, "0")}`).join(", ")},`);
  }
  return [`const unsigned char ${name}[] = {`, ...rows, "};",
    `const unsigned int ${name}_len = ${bytes.length}u;`, ""].join("\n");
}

function bundle(manifestPath: string): void {
  const plan = currentPlan(manifestPath);
  const inputs = extractHostBuildInputs(plan, {
    expectedTarget: ROCKBOX_IPOD_CLASSIC_TARGET_ID,
  });
  mkdirSync(dirname(planPath), { recursive: true });
  mkdirSync(outputDirectory, { recursive: true });
  mkdirSync(dirname(embeddedPath), { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  run(process.execPath, [join(repository, "tools/build.ts"), `--plan=${planPath}`,
    `--project-root=${repository}`, `--outdir=${outputDirectory}`]);
  const jsPath = join(outputDirectory, `${inputs.appOutput}.js`);
  const pakPath = join(outputDirectory, `${inputs.appOutput}.pak`);
  if (!existsSync(jsPath) || !existsSync(pakPath)) {
    throw new Error("PocketJS compiler did not emit JavaScript and pak artifacts");
  }
  writeFileSync(embeddedPath,
    cArray("pocket_app_js", readFileSync(jsPath)) +
    cArray("pocket_app_pak", readFileSync(pakPath)));
  console.log(`PocketJS Rockbox: embedded guest -> ${embeddedPath}`);
}

function buildCore(): void {
  run("cargo", ["build", "--release", "--locked", "--no-default-features",
    "--features", "software-only,host-allocator", "--target", targetJson,
    "-Z", "json-target-spec", "-Z", "build-std=core,alloc,compiler_builtins",
    "-Z", "build-std-features=compiler-builtins-mem"], coreDirectory);
  if (!existsSync(coreArchive)) throw new Error(`missing Rust core ${coreArchive}`);
}

function buildBundledPocketApps(destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const [manifest, output, installName] of bundledPocketApps) {
    const outdir = join(outputDirectory, "bundled-apps", output);
    rmSync(outdir, { recursive: true, force: true });
    run(process.execPath, [
      join(repository, "tools/pocket.ts"), "build",
      "--target", "rockbox-ip6g",
      "--manifest", join(repository, manifest),
      "--project-root", repository,
      "--outdir", outdir,
    ]);
    const packagePath = join(outdir, `${output}.pocket`);
    const variant = findVariant(
      decodePocketPackage(new Uint8Array(readFileSync(packagePath))),
      "rockbox-ip6g",
    );
    if (!variant || variant.hostAbi !== 10) {
      throw new Error(`${installName} is not a Rockbox Host ABI 10 package`);
    }
    copyFileSync(packagePath, join(destination, installName));
  }
}

function stagePocketRockFirmware(source: string): void {
  if (!quickJsSource()) bootstrap();
  buildCore();
  const shellOut = join(outputDirectory, "pocketrock-shell");
  run(process.execPath, [
    join(repository, "tools/pocket.ts"), "build",
    "--target", "rockbox-ip6g",
    "--manifest", join(repository, "apps/pocketrock/pocket.json"),
    "--project-root", repository,
    "--outdir", shellOut,
  ]);
  const packagePath = join(shellOut, "pocketrock-shell.pocket");
  const variant = findVariant(
    decodePocketPackage(new Uint8Array(readFileSync(packagePath))),
    "rockbox-ip6g",
  );
  if (!variant || variant.hostAbi !== 10) throw new Error("PocketRock Shell package ABI drift");
  const bytecode = findSection(variant, POCKET_SECTION.bytecode);
  const pak = findSection(variant, POCKET_SECTION.pak);
  if (!bytecode || !pak) throw new Error("PocketRock Shell package lacks bytecode or pak");

  const generated = join(source, "apps/pocketrock/generated");
  rmSync(generated, { recursive: true, force: true });
  mkdirSync(join(generated, "sys"), { recursive: true });
  writeFileSync(
    join(generated, "app_data.c"),
    cArray("pocketrock_shell_bytecode", bytecode) +
      cArray("pocketrock_shell_pak", pak),
  );
  const copies: Array<[string, string]> = [
    [join(repository, "hosts/rockbox/pocketrock_runtime_port.c"), "runtime_port.c"],
    [join(repository, "hosts/rockbox/pocketrock_service.c"), "service_bridge.c"],
    [join(repository, "hosts/rockbox/firmware_compat.c"), "firmware_compat.c"],
    [join(repository, "hosts/rockbox/firmware_compat.h"), "firmware_compat.h"],
    [join(repository, "hosts/rockbox/sys/time.h"), "sys/time.h"],
    [join(repository, "hosts/iphone2g/pocket_runtime.c"), "pocket_runtime.c"],
    [join(repository, "hosts/iphone2g/pocket_runtime.h"), "pocket_runtime.h"],
    [join(repository, "hosts/iphone2g/pocket_spec.h"), "pocket_spec.h"],
    [join(repository, "hosts/iphone2g/pocket_core.h"), "pocket_core.h"],
  ];
  for (const [from, to] of copies) {
    copyFileSync(from, join(generated, to));
  }
  const quickjs = quickJsSource();
  if (!quickjs) throw new Error("PocketRock QuickJS source unavailable");
  for (const name of [
    "quickjs.c", "quickjs.h", "quickjs-atom.h", "quickjs-opcode.h",
    "cutils.c", "cutils.h", "list.h", "libregexp.c", "libregexp.h",
    "libregexp-opcode.h", "libunicode.c", "libunicode.h", "libunicode-table.h",
    "dtoa.c", "dtoa.h",
  ]) copyFileSync(join(quickjs, name), join(generated, name));
  for (const [wrapper, sourceName] of [
    ["qjs_quickjs.c", "quickjs.c"], ["qjs_cutils.c", "cutils.c"],
    ["qjs_libregexp.c", "libregexp.c"], ["qjs_libunicode.c", "libunicode.c"],
    ["qjs_dtoa.c", "dtoa.c"],
  ]) {
    writeFileSync(join(generated, wrapper), `#include \"qjs_config.h\"\n#include \"${sourceName}\"\n`);
  }
  writeFileSync(join(generated, "qjs_config.h"), [
    "#ifndef POCKETROCK_QJS_CONFIG_H",
    "#define POCKETROCK_QJS_CONFIG_H",
    "#define POCKETJS_NO_MALLOC_USABLE_SIZE 1",
    "#define POCKETJS_NO_ATOMICS 1",
    "#define POCKETJS_FIXED_TIMEZONE 1",
    "#define CONFIG_VERSION \"pocketrock-quickjs-pinned\"",
    "#include \"firmware_compat.h\"",
    "#endif",
    "",
  ].join("\n"));
  for (const name of ["tlsf.c", "tlsf.h", "target.h"]) {
    copyFileSync(join(source, "lib/tlsf/src", name), join(generated, name));
  }
  copyFileSync(coreArchive, join(generated, "libpocketrock_runtime.a"));
  console.log(`PocketRock firmware runtime staged in ${generated}`);
}

function release(source: string, buildDirectory: string): void {
  const firmware = join(outputDirectory, "rockbox.ipod");
  if (!existsSync(firmware)) throw new Error("build PocketRock firmware before release");

  const stage = mkdtempSync(join(tmpdir(), "pocketrock-release-"));
  const baseZip = process.env.POCKETROCK_BASE_ZIP;
  if (baseZip) {
    if (!existsSync(baseZip)) throw new Error(`POCKETROCK_BASE_ZIP not found: ${baseZip}`);
    run("unzip", ["-q", baseZip, "-d", stage]);
  } else {
    run("make", ["NODEPS=1", pocketRockCoreFlags, "zip"], buildDirectory);
    run("unzip", ["-q", join(buildDirectory, "rockbox.zip"), "-d", stage]);
  }

  const rbdir = join(stage, ".rockbox");
  const pocketApps = join(rbdir, "pocketrock/apps");
  mkdirSync(pocketApps, { recursive: true });
  mkdirSync(join(rbdir, "pocketrock/logs"), { recursive: true });
  mkdirSync(join(rbdir, "themes"), { recursive: true });
  mkdirSync(join(rbdir, "wps"), { recursive: true });
  copyFileSync(firmware, join(rbdir, "rockbox.ipod"));
  copyFileSync(join(buildDirectory, "rockbox-info.txt"), join(rbdir, "rockbox-info.txt"));
  buildBundledPocketApps(pocketApps);
  copyFileSync(
    join(repository, "release/rockbox/themes/PocketRock.cfg"),
    join(rbdir, "themes/PocketRock.cfg"),
  );
  copyFileSync(
    join(repository, "release/rockbox/wps/pocketrock.sbs"),
    join(rbdir, "wps/pocketrock.sbs"),
  );
  copyFileSync(
    join(repository, "release/rockbox/wps/pocketrock.wps"),
    join(rbdir, "wps/pocketrock.wps"),
  );
  writeFileSync(join(pocketApps, "README.txt"),
    "Copy trusted rockbox-ip6g .pocket packages into this directory.\n");
  writeFileSync(join(rbdir, "pocketrock/NOTICE.txt"), [
    "PocketRock v0.1 combines Rockbox (GPLv2 or later) with PocketJS (MIT).",
    `Rockbox baseline: ${process.env.POCKETROCK_ROCKBOX_REVISION ?? "420537c8643cc6ffc844115d2fca9e6129f7ce71"}`,
    `PocketJS revision: ${process.env.POCKETROCK_POCKETJS_REVISION ?? "working tree"}`,
    `QuickJS revision: ${POCKETROCK_QUICKJS_REVISION}`,
    "Corresponding source archives are shipped beside this ZIP.",
    "Third-party .pocket applications are trusted and can access the iPod volume.",
    "",
  ].join("\n"));

  const zip = join(outputDirectory, "pocketrock-ipod6g-rockbox.zip");
  rmSync(zip, { force: true });
  run("zip", ["-q", "-r", zip, ".rockbox"], stage);
  run("git", ["archive", "--format=tar.gz", "-o",
    join(outputDirectory, "pocketrock-rockbox-source.tar.gz"), "HEAD"], source);
  run("git", ["archive", "--format=tar.gz", "-o",
    join(outputDirectory, "pocketrock-pocketjs-source.tar.gz"), "HEAD"], repository);

  const artifacts = [
    "pocketrock-ipod6g-rockbox.zip",
    "rockbox.ipod",
    "pocketrock-rockbox-source.tar.gz",
    "pocketrock-pocketjs-source.tar.gz",
  ];
  writeFileSync(join(outputDirectory, "SHA256SUMS"),
    artifacts.map((name) => `${sha256(join(outputDirectory, name))}  ${name}`).join("\n") + "\n");
  rmSync(stage, { recursive: true, force: true });
  console.log(`PocketRock release artifacts: ${outputDirectory}`);
}

function copySources(stage: string, quickjs: string): void {
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  mkdirSync(join(stage, "sys"), { recursive: true });
  for (const name of ["main.c", "input.c", "input.h", "framebuffer.c", "framebuffer.h",
    "compat.c", "compat.h", "runtime_port.c", "qjs_config.h", "qjs_quickjs.c",
    "qjs_cutils.c", "qjs_libregexp.c", "qjs_libunicode.c", "qjs_dtoa.c",
    "pocketjs.make"]) {
    copyFileSync(join(hostDirectory, name), join(stage, name));
  }
  copyFileSync(join(hostDirectory, "sys/time.h"), join(stage, "sys/time.h"));
  for (const name of ["pocket_runtime.c", "pocket_runtime.h", "pocket_spec.h",
    "pocket_core.h"]) {
    copyFileSync(join(repository, "hosts/iphone2g", name), join(stage, name));
  }
  for (const name of ["quickjs.c", "quickjs.h", "quickjs-atom.h", "quickjs-opcode.h",
    "cutils.c", "cutils.h", "list.h", "libregexp.c", "libregexp.h", "libregexp-opcode.h",
    "libunicode.c", "libunicode.h", "libunicode-table.h", "dtoa.c", "dtoa.h"]) {
    copyFileSync(join(quickjs, name), join(stage, name));
  }
  copyFileSync(embeddedPath, join(stage, "app_data.c"));
  copyFileSync(coreArchive, join(stage, "libpocketjs_rockbox_core.a"));
}

function configureRockbox(source: string, buildDirectory: string, simulator: boolean): void {
  mkdirSync(buildDirectory, { recursive: true });
  if (existsSync(join(buildDirectory, "Makefile"))) return;
  const args = ["--target=ipod6g", `--type=${simulator ? "s" : "n"}`, "--no-ccache"];
  if (!simulator && !Bun.which("arm-elf-eabi-gcc") && Bun.which("arm-none-eabi-gcc")) {
    args.push("--compiler-prefix=arm-none-eabi-");
  }
  run(join(source, "tools/configure"), args, buildDirectory);
}

function build(manifestPath: string, simulator: boolean): void {
  const source = resolve(process.env.ROCKBOX_SOURCE ?? "");
  if (!source || !existsSync(join(source, "tools/configure"))) {
    throw new Error("set ROCKBOX_SOURCE to a Rockbox source checkout");
  }
  if (!quickJsSource()) bootstrap();
  bundle(manifestPath);
  buildCore();
  const quickjs = quickJsSource();
  if (!quickjs) throw new Error("QuickJS bootstrap failed");
  const stage = join(source, "apps/plugins/pocketjs");
  copySources(stage, quickjs);
  const buildDirectory = resolve(process.env.ROCKBOX_BUILD ??
    join(outputDirectory, simulator ? "rockbox-sim-build" : "rockbox-ipod6g-build"));
  configureRockbox(source, buildDirectory, simulator);
  const makeTarget = join(buildDirectory, "apps/plugins/pocketjs/pocketjs.rock");
  run("make", ["-j", String(Math.max(1, navigator.hardwareConcurrency ?? 1)),
    "SELECTED_PLUGINS_SRC=", `SELECTED_PLUGINS_SUBDIRS=${stage}`,
    makeTarget], buildDirectory);
  const artifact = join(buildDirectory, "apps/plugins/pocketjs/pocketjs.rock");
  if (!existsSync(artifact)) throw new Error(`Rockbox did not emit ${artifact}`);
  mkdirSync(outputDirectory, { recursive: true });
  const destination = join(outputDirectory, simulator ? "pocketjs-sim.rock" : "pocketjs-ipod6g.rock");
  copyFileSync(artifact, destination);
  console.log(`PocketJS Rockbox: ${destination} (${statSync(destination).size} bytes)`);
}

const manifestArg = Bun.argv.find((value) => value.startsWith("--manifest="));
const manifestPath = resolve(manifestArg?.slice("--manifest=".length) ?? defaultManifest);
if (command === "doctor") doctor();
else if (command === "bootstrap") bootstrap();
else if (command === "bundle") bundle(manifestPath);
else if (command === "build") build(manifestPath, false);
else if (command === "firmware") {
  const source = resolve(process.env.ROCKBOX_SOURCE ?? "");
  if (!source || !existsSync(join(source, "tools/configure"))) {
    throw new Error("set ROCKBOX_SOURCE to the PocketRock Rockbox checkout");
  }
  stagePocketRockFirmware(source);
  const buildDirectory = resolve(process.env.ROCKBOX_BUILD ?? join(outputDirectory, "pocketrock-build"));
  configureRockbox(source, buildDirectory, false);
  run("make", ["-j", String(Math.max(1, navigator.hardwareConcurrency ?? 1)),
    pocketRockCoreFlags, "dep"], buildDirectory);
  run("make", ["-j", String(Math.max(1, navigator.hardwareConcurrency ?? 1)),
    pocketRockCoreFlags, "bin"], buildDirectory);
  mkdirSync(outputDirectory, { recursive: true });
  copyFileSync(join(buildDirectory, "rockbox.ipod"), join(outputDirectory, "rockbox.ipod"));
  console.log(`PocketRock firmware: ${join(outputDirectory, "rockbox.ipod")}`);
}
else if (command === "release") {
  const source = resolve(process.env.ROCKBOX_SOURCE ?? "");
  const buildDirectory = resolve(process.env.ROCKBOX_BUILD ?? join(outputDirectory, "pocketrock-build"));
  if (!source || !existsSync(join(source, "tools/configure"))) {
    throw new Error("set ROCKBOX_SOURCE to the PocketRock Rockbox checkout");
  }
  stagePocketRockFirmware(source);
  configureRockbox(source, buildDirectory, false);
  run("make", ["-j", String(Math.max(1, navigator.hardwareConcurrency ?? 1)),
    pocketRockCoreFlags, "dep"], buildDirectory);
  run("make", ["-j", String(Math.max(1, navigator.hardwareConcurrency ?? 1)),
    pocketRockCoreFlags, "bin"], buildDirectory);
  mkdirSync(outputDirectory, { recursive: true });
  copyFileSync(join(buildDirectory, "rockbox.ipod"), join(outputDirectory, "rockbox.ipod"));
  release(source, buildDirectory);
}
else if (command === "sim") build(manifestPath, true);
else if (command === "test") {
  mkdirSync(outputDirectory, { recursive: true });
  run("cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-Ihosts/iphone2g",
    "hosts/rockbox/framebuffer.c", "hosts/rockbox/input.c",
    "hosts/rockbox/tests/platform_test.c", "-o", join(outputDirectory, "platform-test")]);
  run(join(outputDirectory, "platform-test"), []);
  run("bun", ["test", "tests/rockbox-profile.test.ts"]);
} else if (command === "clean") {
  rmSync(join(outputDirectory, "generated"), { recursive: true, force: true });
  rmSync(planPath, { force: true });
} else {
  console.error("usage: bun rockbox <doctor|bootstrap|bundle|test|sim|build|firmware|release|clean> [--manifest=path]");
  process.exit(1);
}
