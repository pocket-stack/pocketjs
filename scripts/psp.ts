// scripts/psp.ts <app> [cargo args…] — build the app JS+dcpak (scripts/
// build.ts), then the EBOOT:
//   PSPUI_APP=<app> rustup run nightly-2026-05-28 cargo psp
// inside native/, with the exact env block from dreamcart runtime/build.ts
// (LLVM PATH, TARGET_CFLAGS, AR_mipsel_sony_psp=llvm-ar,
//  RUST_PSP_TARGET=native/targets/mipsel-sony-psp.json, RUST_PSP_ABORT_ONLY=1,
//  RUSTFLAGS "-A linker-messages …"). Needs a rust-psp SDK: set PSP_SDK or
// keep mipsel-sony-psp next to this checkout / in a sibling dreamcart checkout.
//
// Demo entries: `bun scripts/psp.ts hero` prefers demos/hero-main.tsx (the
// mounting entry — hero.tsx only exports the component) when it exists.
//
// --capture builds the E2E frame-dump EBOOT (cargo psp --features capture)
// and bakes the PSPUI_CAPTURE_INPUT env ("frame:mask,…") into the binary —
// used by test/e2e-ppsspp.ts, never by normal builds.

import { $ } from "bun";
import { existsSync } from "node:fs";

const pspUiDir = new URL("..", import.meta.url).pathname; // psp-ui/
const nativeDir = pspUiDir + "native/";
const root = new URL("../..", import.meta.url).pathname; // parent of psp-ui checkout
const sdkCandidates = [
  process.env.PSP_SDK,
  root + "mipsel-sony-psp",
  root + "dreamcart/mipsel-sony-psp",
].filter((p): p is string => !!p);
const sdk =
  sdkCandidates.find((p) => existsSync(`${p}/psp/lib/libc.a`)) ??
  sdkCandidates[0] ??
  root + "mipsel-sony-psp";
const llvm = existsSync("/opt/homebrew/opt/llvm/bin")
  ? "/opt/homebrew/opt/llvm/bin"
  : "/usr/local/opt/llvm/bin";
const home = process.env.HOME ?? "";
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
const cargoArgs: string[] = [];
for (const a of argv) {
  if (a === "--capture") capture = true; // E2E frame-dump build (test/e2e-ppsspp.ts)
  else if (!appArg && !a.startsWith("-")) appArg = a;
  else cargoArgs.push(a);
}
if (capture) cargoArgs.push("--features", "capture");
if (!appArg) {
  console.error("usage: bun scripts/psp.ts <app> [--capture] [cargo args…]   e.g. bun scripts/psp.ts hero --release");
  process.exit(1);
}

// Prereqs (fail fast with actionable messages).
if (!rustup) {
  console.error("psp-ui psp: rustup not found — run `bun run bootstrap` in the dreamcart repo");
  process.exit(1);
}
if (!existsSync(`${sdk}/psp/lib/libc.a`)) {
  console.error(
    `psp-ui psp: PSP SDK missing (looked in ${sdkCandidates.join(", ")}) — set PSP_SDK or run \`bun run bootstrap\` in the dreamcart repo`,
  );
  process.exit(1);
}
if (!existsSync(`${llvm}/clang`)) {
  console.error(`psp-ui psp: Homebrew LLVM missing at ${llvm} (brew install llvm)`);
  process.exit(1);
}

// A bare component demo (demos/<app>.tsx exporting the component) needs the
// mounting entry demos/<app>-main.tsx (imports render() + STYLE_IDS).
const app = existsSync(`${pspUiDir}demos/${appArg}-main.tsx`) ? `${appArg}-main` : appArg;

// ---------------------------------------------------------------------------
// 1. Build the app bundle + dcpak -> dist/<app>.js + dist/<app>.dcpak
// ---------------------------------------------------------------------------

console.log(`psp-ui psp: building app "${app}"`);
await $`bun scripts/build.ts ${app}`.cwd(pspUiDir);

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
  PSPUI_APP: app,
  // Scripted capture input + per-demo capture window, baked into the EBOOT
  // by native/build.rs (only consumed under --capture; harmless otherwise).
  // Explicit so stale values never linger in the cargo fingerprint.
  PSPUI_CAPTURE_INPUT: process.env.PSPUI_CAPTURE_INPUT ?? "",
  PSPUI_TRACE: process.env.PSPUI_TRACE ?? "",
  PSPUI_CAP_START: process.env.PSPUI_CAP_START ?? "",
  PSPUI_CAP_N: process.env.PSPUI_CAP_N ?? "",
};

function outputProfile(args: string[]): string {
  const inlineProfile = args.find((arg) => arg.startsWith("--profile="));
  if (inlineProfile) return inlineProfile.slice("--profile=".length);
  const profileFlag = args.indexOf("--profile");
  if (profileFlag !== -1 && args[profileFlag + 1]) return args[profileFlag + 1];
  return args.includes("--release") || args.includes("-r") ? "release" : "debug";
}

console.log(`psp-ui psp: cargo psp (app=${app})`);
await $`${rustup} run ${TOOLCHAIN} cargo psp ${cargoArgs}`.cwd(nativeDir).env(env);

const profile = outputProfile(cargoArgs);
const eboot = `${nativeDir}target/mipsel-sony-psp/${profile}/EBOOT.PBP`;
console.log(`output: ${eboot}`);
