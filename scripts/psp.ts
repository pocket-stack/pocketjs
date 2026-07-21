// scripts/psp.ts <app> [cargo args…] — build the app JS+pak (scripts/
// build.ts), then the EBOOT:
//   POCKETJS_APP_OUTPUT=<app> POCKETJS_EMBED_APP=1 cargo psp
// inside native/, with the canonical env from scripts/psp-toolchain.ts
// (LLVM PATH, TARGET_CFLAGS, AR_mipsel_sony_psp=llvm-ar,
//  RUST_PSP_TARGET=native/targets/mipsel-sony-psp.json, RUST_PSP_ABORT_ONLY=1,
//  RUSTFLAGS "-A linker-messages …"). `bun run bootstrap` installs the exact
//  Rust, cargo-psp and SDK revisions into the shared pocket-stack cache.
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
import { existsSync, statSync, unlinkSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FRAMEWORKS,
  parseFramework,
  type PocketFramework,
} from "../compiler/jsx-plugin.ts";
import type { PocketConfig } from "../src/config.ts";
import {
  extractHostBuildInputs,
  hostBuildEnvironment,
} from "../src/manifest/host-build-inputs.ts";
import { verifyPlanHash, type ResolvedBuildPlan } from "../src/manifest/plan.ts";
import { resolvePspBuildToolchain } from "./psp-toolchain.ts";

const pspUiDir = new URL("..", import.meta.url).pathname; // PocketJS/
const nativeDir = pspUiDir + "native/";
const pspTarget = nativeDir + "targets/mipsel-sony-psp.json";

// ---------------------------------------------------------------------------
// CLI: first bare arg = app name; everything else is passed to cargo psp.
// ---------------------------------------------------------------------------

const argv = Bun.argv.slice(2);
let appArg = "";
let capture = false;
let bench = false;
let frameworkFlag: string | undefined;
let configPath = pspUiDir + "pocket.config.ts";
let configFlagged = false;
let useConfig = true;
let planPath: string | undefined;
let projectRoot = process.cwd();
let outputDir = pspUiDir + "dist/";
let skipBuild = false;
let launcherRegistry = "";
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
    configFlagged = true;
    buildFlags.push(a);
  }
  else if (a === "--no-config") {
    useConfig = false;
    buildFlags.push(a);
  }
  else if (a.startsWith("--plan=")) planPath = resolvePath(a.slice("--plan=".length));
  // Multi-app embed (LAUNCHER.md): the TSV registry scripts/launcher.ts
  // emits; build.rs appends one embedded bundle per line after app 0.
  else if (a.startsWith("--launcher-registry=")) launcherRegistry = resolvePath(a.slice("--launcher-registry=".length));
  else if (a.startsWith("--project-root=")) projectRoot = resolvePath(a.slice("--project-root=".length));
  else if (a.startsWith("--outdir=")) outputDir = resolvePath(a.slice("--outdir=".length)) + "/";
  else if (a === "--skip-build") skipBuild = true;
  else if (!appArg && !a.startsWith("-")) appArg = a;
  else cargoArgs.push(a);
}
const features = [capture ? "capture" : "", bench ? "bench" : ""].filter(Boolean);
if (features.length > 0) cargoArgs.push("--features", features.join(","));
if (!appArg && !planPath) {
  console.error("usage: bun scripts/psp.ts <app> [--plan=<resolved-plan.json>] [--capture|--bench] [cargo args…]   e.g. bun scripts/psp.ts hero --release");
  process.exit(1);
}

// Prereqs (fail fast with one PocketJS-owned setup path).
let toolchain: ReturnType<typeof resolvePspBuildToolchain>;
try {
  toolchain = resolvePspBuildToolchain();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const sdk = toolchain.sdk.path;

// A bare component demo (demos/<app>/app.tsx exporting the component) needs
// the mounting entry demos/<app>/main.tsx (imports mount() + STYLE_IDS).
function mountedAppName(arg: string): string {
  const bare = arg.replace(/\.tsx?$/, "").replace(/-main$/, "");
  if (existsSync(`${pspUiDir}demos/${bare}/main.tsx`) || existsSync(`${pspUiDir}demos/${bare}-main.tsx`)) {
    return `${bare}-main`;
  }
  return arg;
}

let buildPlan: ResolvedBuildPlan | undefined;
if (planPath) {
  buildPlan = await Bun.file(planPath).json() as ResolvedBuildPlan;
  if (!verifyPlanHash(buildPlan) || buildPlan.target.id !== "psp") {
    throw new Error(`PocketJS psp: invalid PSP ResolvedBuildPlan at ${planPath}`);
  }
  if (frameworkFlag || configFlagged) {
    throw new Error("PocketJS psp: framework/config overrides are forbidden with --plan");
  }
}

const app = buildPlan
  ? resolvePath(projectRoot, buildPlan.app.entry)
  : appArg
    ? mountedAppName(appArg)
    : "";

async function loadConfig(): Promise<PocketConfig> {
  if (!useConfig || !existsSync(configPath)) return {};
  const url = pathToFileURL(configPath);
  url.searchParams.set("mtime", String(statSync(configPath).mtimeMs));
  const mod = await import(url.href) as { default?: PocketConfig; config?: PocketConfig };
  return mod.default ?? mod.config ?? {};
}

const config = buildPlan ? {} : await loadConfig();
const framework: PocketFramework = buildPlan
  ? parseFramework(buildPlan.app.framework, "ResolvedBuildPlan")
  : frameworkFlag
    ? parseFramework(frameworkFlag, "--framework")
    : parseFramework(config.framework, "pocket.config.ts");
const outputApp = buildPlan
  ? buildPlan.app.output
  : `${app}${FRAMEWORKS[framework].outputSuffix}`;

// ---------------------------------------------------------------------------
// 1. Build the app bundle + pak -> dist/<app>.js + dist/<app>.pak
// ---------------------------------------------------------------------------

console.log(`PocketJS psp: building app "${app}" (framework=${framework})`);
if (!skipBuild) {
  if (buildPlan) {
    await $`bun scripts/build.ts --plan=${planPath!} --project-root=${projectRoot} --outdir=${outputDir}`.cwd(pspUiDir);
  } else {
    await $`bun scripts/build.ts ${app} ${buildFlags}`.cwd(pspUiDir);
  }
}
cargoArgs.push("--bin", "pocketjs-psp");

// ---------------------------------------------------------------------------
// 1b. Per-app XMB metadata: <app dir>/psp/Psp.toml -> native/Psp.toml.
// cargo-psp reads Psp.toml from its CWD (native/) and packs it into
// PARAM.SFO / ICON0 / PIC1. The fragment lives NEXT TO THE APP ENTRY —
// demos/<app>/psp/Psp.toml for legacy demo builds, <entry dir>/psp/Psp.toml
// for --plan builds (where `app` is the entry's absolute path, so the demo
// naming convention does not apply). It keeps its art beside it with
// relative paths; they are rewritten absolute here. No fragment => the
// generated file is REMOVED, so one app's title/cover never leaks into
// another app's EBOOT. native/Psp.toml is build output (gitignored).
// ---------------------------------------------------------------------------
const GENERATED_MARK = "# GENERATED by scripts/psp.ts";
const fragmentHome = buildPlan
  ? resolvePath(projectRoot, buildPlan.app.entry, "..", "psp")
  : `${pspUiDir}demos/${app.replace(/-main$/, "")}/psp`;
const xmbFragment = `${fragmentHome}/Psp.toml`;
const xmbFragmentLabel = xmbFragment.startsWith(pspUiDir)
  ? xmbFragment.slice(pspUiDir.length)
  : xmbFragment;
const generatedPspToml = `${nativeDir}Psp.toml`;
const generatedExisting =
  existsSync(generatedPspToml) && (await Bun.file(generatedPspToml).text()).startsWith(GENERATED_MARK);
if (existsSync(xmbFragment)) {
  if (existsSync(generatedPspToml) && !generatedExisting) {
    console.error(
      "PocketJS psp: native/Psp.toml exists but was not generated by this script — " +
        "per-app XMB metadata lives in <app dir>/psp/Psp.toml; move or delete the file to continue.",
    );
    process.exit(1);
  }
  const fragDir = `${fragmentHome}/`;
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
      `PocketJS psp: XMB asset path(s) in ${xmbFragmentLabel} did not resolve:\n` +
        badAssets.map((b) => `  ${b}`).join("\n") +
        `\n(use double-quoted paths relative to the fragment's directory)`,
    );
    process.exit(1);
  }
  await Bun.write(
    generatedPspToml,
    `${GENERATED_MARK} from ${xmbFragmentLabel} — do not edit.\n${rewritten}`,
  );
  console.log(`PocketJS psp: XMB metadata from ${xmbFragmentLabel}`);
} else if (generatedExisting) {
  unlinkSync(generatedPspToml); // a previous demo's cover must not leak into this EBOOT
} else if (existsSync(generatedPspToml)) {
  console.log("PocketJS psp: note — hand-authored native/Psp.toml found; cargo-psp will apply it.");
}

// ---------------------------------------------------------------------------
// 2. cargo psp with the canonical PocketJS cross environment.
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

const hostEnvironment = buildPlan
  ? hostBuildEnvironment(extractHostBuildInputs(buildPlan, { expectedTarget: "psp" }), {
      outputDirectory: outputDir,
      embedApp: true,
    })
  : {
      POCKETJS_APP_OUTPUT: outputApp,
      POCKETJS_EMBED_APP: "1",
      POCKETJS_OUTPUT_DIR: outputDir,
      POCKETJS_TARGET: "psp",
      POCKETJS_HOST_ABI: "1",
      POCKETJS_LOGICAL_WIDTH: "480",
      POCKETJS_LOGICAL_HEIGHT: "272",
      POCKETJS_PHYSICAL_WIDTH: "480",
      POCKETJS_PHYSICAL_HEIGHT: "272",
      POCKETJS_PRESENTATION: "native",
      POCKETJS_RASTER_DENSITY: "1",
    };

const env = {
  ...toolchain.environment,
  RUSTFLAGS: rustflags,
  CRATE_CC_NO_DEFAULTS: "1",
  TARGET_CC: "clang",
  TARGET_AR: `${toolchain.llvmBin}/llvm-ar`,
  // Match the Rust PSP target's +noabicalls mode. -G0 avoids clang's MIPS
  // backend selecting unsupported GP-relative accesses for large C sources.
  TARGET_CFLAGS:
    `-target mipsel-sony-psp -mcpu=mips2 -msingle-float -mlittle-endian -mno-abicalls -fno-pic -G0 -mno-check-zero-division ` +
    `-fno-stack-protector -I${sdk}/psp/include -I${sdk}/psp/sdk/include`,
  // CRITICAL: archive MIPS objects with llvm-ar (Apple ar drops them -> undefined JS_*).
  AR_mipsel_sony_psp: `${toolchain.llvmBin}/llvm-ar`,
  RANLIB_mipsel_sony_psp: `${toolchain.llvmBin}/llvm-ranlib`,
  RUST_PSP_TARGET: pspTarget,
  // panic-abort EBOOTs: no panic_unwind/libunwind in build-std.
  RUST_PSP_ABORT_ONLY: "1",
  // Keep PSP dev builds fast (opt-level 0 is unusably slow on hardware).
  CARGO_PROFILE_DEV_OPT_LEVEL: process.env.CARGO_PROFILE_DEV_OPT_LEVEL ?? "3",
  ...hostEnvironment,
  // Scripted capture input + per-demo capture window, baked into the EBOOT
  // by native/build.rs (only consumed under --capture; harmless otherwise).
  // Explicit so stale values never linger in the cargo fingerprint.
  POCKETJS_CAPTURE_INPUT: process.env.POCKETJS_CAPTURE_INPUT ?? "",
  POCKETJS_TRACE: process.env.POCKETJS_TRACE ?? "",
  POCKETJS_CAP_START: process.env.POCKETJS_CAP_START ?? "",
  POCKETJS_CAP_N: process.env.POCKETJS_CAP_N ?? "",
  POCKETJS_ARENA_BYTES: process.env.POCKETJS_ARENA_BYTES ?? "",
  POCKETJS_BENCH_DUMP_FRAMES: process.env.POCKETJS_BENCH_DUMP_FRAMES ?? "",
  // Multi-app embed (LAUNCHER.md): empty = single-app table of one.
  POCKETJS_LAUNCHER_REGISTRY: launcherRegistry,
};

function outputProfile(args: string[]): string {
  const inlineProfile = args.find((arg) => arg.startsWith("--profile="));
  if (inlineProfile) return inlineProfile.slice("--profile=".length);
  const profileFlag = args.indexOf("--profile");
  if (profileFlag !== -1 && args[profileFlag + 1]) return args[profileFlag + 1];
  return args.includes("--release") || args.includes("-r") ? "release" : "debug";
}

console.log(`PocketJS psp: cargo psp (app=${outputApp})`);
await $`${toolchain.rustup} run ${toolchain.manifest.rust.toolchain} cargo psp ${cargoArgs}`.cwd(nativeDir).env(env);

const profile = outputProfile(cargoArgs);
const binEboot = `${nativeDir}target/mipsel-sony-psp/${profile}/pocketjs-psp.EBOOT.PBP`;
const conventionalEboot = `${nativeDir}target/mipsel-sony-psp/${profile}/EBOOT.PBP`;
if (existsSync(binEboot)) {
  await Bun.write(conventionalEboot, await Bun.file(binEboot).arrayBuffer());
}
console.log(`output: ${conventionalEboot}`);
