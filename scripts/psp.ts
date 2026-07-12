// scripts/psp.ts <app> [cargo args…] — build the app JS+pak (scripts/
// build.ts), then the EBOOT:
//   POCKETJS_APP=<app> rustup run nightly-2026-05-28 cargo psp
// inside native/, with the exact env block from dreamcart runtime/build.ts
// (LLVM PATH, TARGET_CFLAGS, AR_mipsel_sony_psp=llvm-ar,
//  RUST_PSP_TARGET=native/targets/mipsel-sony-psp.json, RUST_PSP_ABORT_ONLY=1,
//  RUSTFLAGS "-A linker-messages …"). Needs a rust-psp SDK: set PSP_SDK or
// keep mipsel-sony-psp next to this checkout / in a sibling dreamcart checkout.
//
// Demo entries: `bun scripts/psp.ts hero` prefers demos/hero/main.tsx (the
// mounting entry — demos/hero/app.tsx only exports the component) when it exists.
//
// --capture builds the E2E frame-dump EBOOT (cargo psp --features capture)
// and bakes the POCKETJS_CAPTURE_INPUT env ("frame:mask,…") into the binary —
// used by test/e2e-ppsspp.ts, never by normal builds.
// --bench additionally enables native microsecond timing output to
// ms0:/PocketJS-bench.jsonl and implies --capture.

import { $ } from "bun";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FRAMEWORKS,
  parseFramework,
  type PocketFramework,
} from "../compiler/jsx-plugin.ts";
import type { PocketConfig } from "../src/config.ts";

const pspUiDir = new URL("..", import.meta.url).pathname; // PocketJS/
const nativeDir = pspUiDir + "native/";
const root = new URL("../..", import.meta.url).pathname; // parent of PocketJS checkout
const home = process.env.HOME ?? "";

function dreamcartWorktreeSdkCandidates(): string[] {
  const base = root + "../dreamcart/";
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${base}${entry.name}/mipsel-sony-psp`);
  } catch {
    return [];
  }
}

const sdkCandidates = [
  process.env.PSP_SDK,
  root + "mipsel-sony-psp",
  root + "dreamcart/mipsel-sony-psp",
  home ? `${home}/code/dreamcart/mipsel-sony-psp` : "",
  ...dreamcartWorktreeSdkCandidates(),
].filter((p): p is string => !!p);
const sdk =
  sdkCandidates.find((p) => existsSync(`${p}/psp/lib/libc.a`)) ??
  sdkCandidates[0] ??
  root + "mipsel-sony-psp";
const llvm = existsSync("/opt/homebrew/opt/llvm/bin")
  ? "/opt/homebrew/opt/llvm/bin"
  : "/usr/local/opt/llvm/bin";
const pspTarget = nativeDir + "targets/mipsel-sony-psp.json";

const TOOLCHAIN = "nightly-2026-05-28";
const rustup =
  Bun.which("rustup") ?? (existsSync(`${home}/.cargo/bin/rustup`) ? `${home}/.cargo/bin/rustup` : null);

// ---------------------------------------------------------------------------
// CLI: first bare arg = app name; everything else is passed to cargo psp.
// ---------------------------------------------------------------------------

const argv = Bun.argv.slice(2);
let appArg = "";
let capture = false;
let bench = false;
let frameworkFlag: string | undefined;
let configPath = pspUiDir + "pocket.config.ts";
let useConfig = true;
const cargoArgs: string[] = [];
const buildFlags: string[] = [];
for (const a of argv) {
  if (a === "--capture") capture = true; // E2E frame-dump build (test/e2e-ppsspp.ts)
  else if (a === "--bench") {
    bench = true;
    capture = true;
  }
  else if (a.startsWith("--framework=")) {
    frameworkFlag = a.slice("--framework=".length);
    buildFlags.push(a);
  }
  else if (a.startsWith("--config=")) {
    configPath = resolvePath(pspUiDir, a.slice("--config=".length));
    buildFlags.push(a);
  }
  else if (a === "--no-config") {
    useConfig = false;
    buildFlags.push(a);
  }
  else if (!appArg && !a.startsWith("-")) appArg = a;
  else cargoArgs.push(a);
}
const features = [capture ? "capture" : "", bench ? "bench" : ""].filter(Boolean);
if (features.length > 0) cargoArgs.push("--features", features.join(","));
if (!appArg) {
  console.error("usage: bun scripts/psp.ts <app> [--capture|--bench] [cargo args…]   e.g. bun scripts/psp.ts hero --release");
  process.exit(1);
}

// Prereqs (fail fast with actionable messages).
if (!rustup) {
  console.error("PocketJS psp: rustup not found — run `bun run bootstrap` in the dreamcart repo");
  process.exit(1);
}
if (!existsSync(`${sdk}/psp/lib/libc.a`)) {
  console.error(
    `PocketJS psp: PSP SDK missing (looked in ${sdkCandidates.join(", ")}) — set PSP_SDK or run \`bun run bootstrap\` in the dreamcart repo`,
  );
  process.exit(1);
}
if (!existsSync(`${llvm}/clang`)) {
  console.error(`PocketJS psp: Homebrew LLVM missing at ${llvm} (brew install llvm)`);
  process.exit(1);
}

// A bare component demo (demos/<app>/app.tsx exporting the component) needs
// the mounting entry demos/<app>/main.tsx (imports mount() + STYLE_IDS).
function mountedAppName(arg: string): string {
  const bare = arg.replace(/\.tsx?$/, "").replace(/-main$/, "");
  if (existsSync(`${pspUiDir}demos/${bare}/main.tsx`) || existsSync(`${pspUiDir}demos/${bare}-main.tsx`)) {
    return `${bare}-main`;
  }
  return arg;
}

const app = appArg ? mountedAppName(appArg) : "";

async function loadConfig(): Promise<PocketConfig> {
  if (!useConfig || !existsSync(configPath)) return {};
  const url = pathToFileURL(configPath);
  url.searchParams.set("mtime", String(statSync(configPath).mtimeMs));
  const mod = await import(url.href) as { default?: PocketConfig; config?: PocketConfig };
  return mod.default ?? mod.config ?? {};
}

const config = await loadConfig();
const framework: PocketFramework = frameworkFlag
  ? parseFramework(frameworkFlag, "--framework")
  : parseFramework(config.framework, "pocket.config.ts");
const outputApp = `${app}${FRAMEWORKS[framework].outputSuffix}`;

// ---------------------------------------------------------------------------
// 1. Build the app bundle + pak -> dist/<app>.js + dist/<app>.pak
// ---------------------------------------------------------------------------

console.log(`PocketJS psp: building app "${app}" (framework=${framework})`);
await $`bun scripts/build.ts ${app} ${buildFlags}`.cwd(pspUiDir);
cargoArgs.push("--bin", "pocketjs-psp");

// ---------------------------------------------------------------------------
// 1b. Per-demo XMB metadata: demos/<app>/psp/Psp.toml -> native/Psp.toml.
// cargo-psp reads Psp.toml from its CWD (native/) and packs it into
// PARAM.SFO / ICON0 / PIC1. The fragment keeps its art next to it with
// relative paths; they are rewritten absolute here. No fragment => the
// generated file is REMOVED, so one demo's title/cover never leaks into
// another demo's EBOOT. native/Psp.toml is build output (gitignored).
// ---------------------------------------------------------------------------
const GENERATED_MARK = "# GENERATED by scripts/psp.ts";
const demoDir = app.replace(/-main$/, "");
const xmbFragment = `${pspUiDir}demos/${demoDir}/psp/Psp.toml`;
const generatedPspToml = `${nativeDir}Psp.toml`;
const generatedExisting =
  existsSync(generatedPspToml) && (await Bun.file(generatedPspToml).text()).startsWith(GENERATED_MARK);
if (existsSync(xmbFragment)) {
  if (existsSync(generatedPspToml) && !generatedExisting) {
    console.error(
      "PocketJS psp: native/Psp.toml exists but was not generated by this script — " +
        "per-demo XMB metadata lives in demos/<app>/psp/Psp.toml; move or delete the file to continue.",
    );
    process.exit(1);
  }
  const fragDir = `${pspUiDir}demos/${demoDir}/psp/`;
  const rewritten = (await Bun.file(xmbFragment).text()).replace(
    /^(\s*\w+_(?:png|pmf|at3))(\s*=\s*")(?!\/)([^"]+)(")/gm,
    (_m, key, eq, rel, close) => `${key}${eq}${fragDir}${rel}${close}`,
  );
  // Every asset key must have resolved to an absolute path that exists —
  // single-quoted strings, `~`, or drive paths would otherwise slip through
  // the rewrite and cargo-psp would pack missing/stale art without a word.
  const badAssets: string[] = [];
  for (const m of rewritten.matchAll(/^\s*(\w+_(?:png|pmf|at3))\s*=\s*(['"])(.*)\2\s*$/gm)) {
    if (!m[3].startsWith("/") || !existsSync(m[3])) badAssets.push(`${m[1]} = ${m[3]}`);
  }
  if (badAssets.length > 0) {
    console.error(
      `PocketJS psp: XMB asset path(s) in demos/${demoDir}/psp/Psp.toml did not resolve:\n` +
        badAssets.map((b) => `  ${b}`).join("\n") +
        `\n(use double-quoted paths relative to demos/${demoDir}/psp/)`,
    );
    process.exit(1);
  }
  await Bun.write(
    generatedPspToml,
    `${GENERATED_MARK} from demos/${demoDir}/psp/Psp.toml — do not edit.\n${rewritten}`,
  );
  console.log(`PocketJS psp: XMB metadata from demos/${demoDir}/psp/Psp.toml`);
} else if (generatedExisting) {
  unlinkSync(generatedPspToml); // a previous demo's cover must not leak into this EBOOT
} else if (existsSync(generatedPspToml)) {
  console.log("PocketJS psp: note — hand-authored native/Psp.toml found; cargo-psp will apply it.");
}

// ---------------------------------------------------------------------------
// 2. cargo psp with the dreamcart cross env (copied from runtime/build.ts)
// ---------------------------------------------------------------------------

const rustflags = [
  process.env.RUSTFLAGS,
  // Benign +abicalls(newlib) vs +noabicalls(rust-psp) linker warnings are
  // suppressed by default — set PSPJS_SHOW_LINKER_MESSAGES=1 for raw output.
  process.env.PSPJS_SHOW_LINKER_MESSAGES === "1" ? undefined : "-A linker-messages",
  "-A unexpected-cfgs",
  "-A unstable-name-collisions",
]
  .filter(Boolean)
  .join(" ");

const env = {
  ...process.env,
  PATH: `${llvm}:${home}/.cargo/bin:${process.env.PATH}`,
  RUSTFLAGS: rustflags,
  CRATE_CC_NO_DEFAULTS: "1",
  TARGET_CC: "clang",
  TARGET_AR: `${llvm}/llvm-ar`,
  // Match the Rust PSP target's +noabicalls mode. -G0 avoids clang's MIPS
  // backend selecting unsupported GP-relative accesses for large C sources.
  TARGET_CFLAGS:
    `-target mipsel-sony-psp -mcpu=mips2 -msingle-float -mlittle-endian -mno-abicalls -fno-pic -G0 -mno-check-zero-division ` +
    `-fno-stack-protector -I${sdk}/psp/include -I${sdk}/psp/sdk/include`,
  // CRITICAL: archive MIPS objects with llvm-ar (Apple ar drops them -> undefined JS_*).
  AR_mipsel_sony_psp: `${llvm}/llvm-ar`,
  RANLIB_mipsel_sony_psp: `${llvm}/llvm-ranlib`,
  RUST_PSP_TARGET: pspTarget,
  // panic-abort EBOOTs: no panic_unwind/libunwind in build-std.
  RUST_PSP_ABORT_ONLY: "1",
  // Keep PSP dev builds fast (opt-level 0 is unusably slow on hardware).
  CARGO_PROFILE_DEV_OPT_LEVEL: process.env.CARGO_PROFILE_DEV_OPT_LEVEL ?? "3",
  POCKETJS_APP: outputApp,
  // Scripted capture input + per-demo capture window, baked into the EBOOT
  // by native/build.rs (only consumed under --capture; harmless otherwise).
  // Explicit so stale values never linger in the cargo fingerprint.
  POCKETJS_CAPTURE_INPUT: process.env.POCKETJS_CAPTURE_INPUT ?? "",
  POCKETJS_TRACE: process.env.POCKETJS_TRACE ?? "",
  POCKETJS_CAP_START: process.env.POCKETJS_CAP_START ?? "",
  POCKETJS_CAP_N: process.env.POCKETJS_CAP_N ?? "",
  POCKETJS_ARENA_BYTES: process.env.POCKETJS_ARENA_BYTES ?? "",
  POCKETJS_BENCH_DUMP_FRAMES: process.env.POCKETJS_BENCH_DUMP_FRAMES ?? "",
};

function outputProfile(args: string[]): string {
  const inlineProfile = args.find((arg) => arg.startsWith("--profile="));
  if (inlineProfile) return inlineProfile.slice("--profile=".length);
  const profileFlag = args.indexOf("--profile");
  if (profileFlag !== -1 && args[profileFlag + 1]) return args[profileFlag + 1];
  return args.includes("--release") || args.includes("-r") ? "release" : "debug";
}

console.log(`PocketJS psp: cargo psp (app=${outputApp})`);
await $`${rustup} run ${TOOLCHAIN} cargo psp ${cargoArgs}`.cwd(nativeDir).env(env);

const profile = outputProfile(cargoArgs);
const binEboot = `${nativeDir}target/mipsel-sony-psp/${profile}/pocketjs-psp.EBOOT.PBP`;
const conventionalEboot = `${nativeDir}target/mipsel-sony-psp/${profile}/EBOOT.PBP`;
if (existsSync(binEboot)) {
  await Bun.write(conventionalEboot, await Bun.file(binEboot).arrayBuffer());
}
console.log(`output: ${conventionalEboot}`);
