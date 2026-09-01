import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractHostBuildInputs } from "../framework/src/manifest/host-build-inputs.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import {
  ROCKBOX_IPOD_CLASSIC_TARGET_ID,
  resolveRockboxBuildPlan,
} from "./rockbox-profile.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));
const hostDirectory = join(repository, "hosts/rockbox");
const outputDirectory = join(repository, "dist/rockbox");
const planPath = join(repository, ".pocket/rockbox-ipod-classic-dev/plan.json");
const embeddedPath = join(outputDirectory, "generated/app_data.c");
const defaultManifest = join(hostDirectory, "demo.pocket.json");
const targetJson = join(hostDirectory, "targets/armv5te-rockbox-eabi.json");
const coreDirectory = join(repository, "engine/symbian");
const coreArchive = join(
  coreDirectory,
  "target/armv5te-rockbox-eabi/release/libpocketjs_symbian_core.a",
);
const quickJsRevision = "ba5bdd0dc013518768e76cd9e05cd30ed53dd35b";
const quickJsCheckout = join(outputDirectory, "quickjs-rs");
const quickJsPatch = join(repository, "tools/rockbox/quickjs.patch");
const command = Bun.argv[2] ?? "doctor";

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
  run("git", ["-C", quickJsCheckout, "checkout", "--detach", quickJsRevision]);
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
  console.error("usage: bun rockbox <doctor|bootstrap|bundle|test|sim|build|clean> [--manifest=path]");
  process.exit(1);
}
