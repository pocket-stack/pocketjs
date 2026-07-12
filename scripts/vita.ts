import { $ } from "bun";
import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FRAMEWORKS,
  parseFramework,
  type PocketFramework,
} from "../compiler/jsx-plugin.ts";
import type { PocketConfig } from "../src/config.ts";

const pspUiDir = new URL("..", import.meta.url).pathname; // PocketJS/
const nativeDir = pspUiDir + "native-vita/";
const home = process.env.HOME ?? "";

// ---------------------------------------------------------------------------
// CLI: first bare arg = app name; everything else is passed to cargo vita
// ---------------------------------------------------------------------------

const argv = Bun.argv.slice(2);
let appArg = "";
let capture = false;
let frameworkFlag: string | undefined;
let configPath = pspUiDir + "pocket.config.ts";
let useConfig = true;
const cargoArgs: string[] = [];
const buildFlags: string[] = [];

for (const a of argv) {
  if (a === "--capture") {
    capture = true;
  } else if (a.startsWith("--framework=")) {
    frameworkFlag = a.slice("--framework=".length);
    buildFlags.push(a);
  } else if (a.startsWith("--config=")) {
    configPath = resolvePath(pspUiDir, a.slice("--config=".length));
    buildFlags.push(a);
  } else if (a === "--no-config") {
    useConfig = false;
    buildFlags.push(a);
  } else if (!appArg && !a.startsWith("-")) {
    appArg = a;
  } else {
    cargoArgs.push(a);
  }
}

if (!appArg) {
  console.error("usage: bun scripts/vita.ts <app> [--capture] [cargo args…]   e.g. bun scripts/vita.ts hero --release");
  process.exit(1);
}

// Prereqs
if (!process.env.VITASDK && !existsSync(`${home}/vitasdk`)) {
  console.error("PocketJS vita: VITASDK environment variable not set. Please set it to your VitaSDK path.");
  process.exit(1);
}

const vitasdk = process.env.VITASDK || `${home}/vitasdk`;
const rustup = Bun.which("rustup") ?? `${home}/.cargo/bin/rustup`;
if (!existsSync(rustup)) {
  console.error("PocketJS vita: rustup not found (expected ~/.cargo/bin/rustup)");
  process.exit(1);
}
if (!existsSync(`${vitasdk}/bin/arm-vita-eabi-gcc`)) {
  console.error(`PocketJS vita: incomplete VitaSDK at ${vitasdk}`);
  process.exit(1);
}

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

console.log(`PocketJS vita: building app "${app}" (framework=${framework})`);
await $`bun scripts/build.ts ${app} ${buildFlags}`.cwd(pspUiDir);

// ---------------------------------------------------------------------------
// 2. cargo vita build vpk
// ---------------------------------------------------------------------------

const env = {
  ...process.env,
  // cargo-vita probes `rustc` from PATH even when cargo itself was launched
  // through `rustup run`. Keep the rustup shim ahead of Homebrew's stable
  // compiler and expose VitaSDK tools without requiring shell dotfiles.
  PATH: `${vitasdk}/bin:${home}/.cargo/bin:${process.env.PATH ?? ""}`,
  VITASDK: vitasdk,
  POCKETJS_APP: outputApp,
  TARGET_AR: 'arm-vita-eabi-ar',
  AR_armv7_sony_vita_newlibeabihf: 'arm-vita-eabi-ar',
  TARGET_CC: 'arm-vita-eabi-gcc',
  CC_armv7_sony_vita_newlibeabihf: 'arm-vita-eabi-gcc',
  TARGET_CXX: 'arm-vita-eabi-g++',
  CXX_armv7_sony_vita_newlibeabihf: 'arm-vita-eabi-g++',
  POCKETJS_CAPTURE_INPUT: process.env.POCKETJS_CAPTURE_INPUT ?? "",
  POCKETJS_CAPTURE_FRAMES: process.env.POCKETJS_CAPTURE_FRAMES ?? "",
  POCKETJS_CAPTURE_DIR: process.env.POCKETJS_CAPTURE_DIR ?? "ux0:data/pocketjs-captures",
};

if (capture) cargoArgs.push("--features", "capture");

console.log(`PocketJS vita: cargo vita build vpk (app=${outputApp}${capture ? ", capture" : ""})`);
// Forward to cargo-vita
await $`${rustup} run nightly-2026-05-28 cargo vita build vpk ${cargoArgs}`.cwd(nativeDir).env(env);

console.log(`output: ${nativeDir}target/armv7-sony-vita-newlibeabihf/.../pocketjs-vita.vpk`);
