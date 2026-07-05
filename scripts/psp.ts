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
import { existsSync, readdirSync, statSync } from "node:fs";
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
let nativeBin: string | undefined;
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
  else if (a.startsWith("--native-bin=")) {
    nativeBin = a.slice("--native-bin=".length);
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
if (nativeBin && appArg) {
  console.error("PocketJS psp: --native-bin builds a standalone PSP bin and cannot be combined with an app name");
  process.exit(1);
}
if (!appArg && !nativeBin) {
  console.error("usage: bun scripts/psp.ts <app> [--capture|--bench] [cargo args…]   e.g. bun scripts/psp.ts hero --release");
  console.error("       bun scripts/psp.ts --native-bin=<bin> [cargo args…]");
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

const config = nativeBin ? {} : await loadConfig();
const framework: PocketFramework | undefined = nativeBin
  ? undefined
  : frameworkFlag
    ? parseFramework(frameworkFlag, "--framework")
    : parseFramework(config.framework, "pocket.config.ts");
const outputApp = nativeBin ? "" : `${app}${FRAMEWORKS[framework].outputSuffix}`;

// ---------------------------------------------------------------------------
// 1. Build the app bundle + pak -> dist/<app>.js + dist/<app>.pak
// ---------------------------------------------------------------------------

if (nativeBin) {
  console.log(`PocketJS psp: building native bin "${nativeBin}"`);
  cargoArgs.push("--bin", nativeBin);
} else {
  console.log(`PocketJS psp: building app "${app}" (framework=${framework})`);
  await $`bun scripts/build.ts ${app} ${buildFlags}`.cwd(pspUiDir);
  cargoArgs.push("--bin", "pocketjs-psp");
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

console.log(nativeBin ? `PocketJS psp: cargo psp (bin=${nativeBin})` : `PocketJS psp: cargo psp (app=${outputApp})`);
await $`${rustup} run ${TOOLCHAIN} cargo psp ${cargoArgs}`.cwd(nativeDir).env(env);

const profile = outputProfile(cargoArgs);
const binName = nativeBin ?? "pocketjs-psp";
const binEboot = `${nativeDir}target/mipsel-sony-psp/${profile}/${binName}.EBOOT.PBP`;
const conventionalEboot = `${nativeDir}target/mipsel-sony-psp/${profile}/EBOOT.PBP`;
if (!nativeBin && existsSync(binEboot)) {
  await Bun.write(conventionalEboot, await Bun.file(binEboot).arrayBuffer());
}
const eboot = nativeBin ? binEboot : conventionalEboot;
if (nativeBin) {
  console.log(`prx: ${nativeDir}target/mipsel-sony-psp/${profile}/${nativeBin}.prx`);
}
console.log(`output: ${eboot}`);
