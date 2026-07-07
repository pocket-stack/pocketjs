// aot/compiler/targets/host.ts — shared pieces for the pj_frame-core targets
// (3ds, nds). Both consoles run the same platform-free game core from
// runtime/shared/ (compiled against the target's runtime.h via -I), and both
// ship a host-compiled dylib of that exact core next to the device binary so
// the E2E harness can drive it over Bun FFI (test/harness/host_runner.ts).

import { $ } from "bun";
import { existsSync } from "node:fs";
import type { TargetBuildResult } from "./index.ts";

const ROOT = new URL("../../..", import.meta.url).pathname; // repo root
export const SHARED_RT = ROOT + "aot/runtime/shared";

/** Platform-free game logic (no renderer): every pj_frame target links these. */
export const LOGIC_MODULES = ["core", "cart", "map", "player", "actor", "camera", "script_vm", "textbox", "debug"] as const;

export const logicSources = (): string[] => LOGIC_MODULES.map((m) => `${SHARED_RT}/${m}.c`);

/** The shared software renderer (host harness backend; also the 3DS device renderer). */
export const softRenderSource = (): string => `${SHARED_RT}/render_soft.c`;

export function hostDylibPath(outPath: string): string {
  return outPath.replace(/\.(3dsx|nds)$/, "") + ".host.dylib";
}

/** Compile the shared core + software renderer + this game's cart into a host dylib. */
export async function buildHostDylib(rtDir: string, outPath: string): Promise<string> {
  const dylib = hostDylibPath(outPath);
  const sources = [...logicSources(), softRenderSource(), `${rtDir}/gen_cart.c`];
  // DEVELOPER_DIR: use the CommandLineTools clang when the Xcode.app license
  // hasn't been accepted (the CLT ships its own license-free toolchain).
  const env = { ...process.env };
  if (!env.DEVELOPER_DIR && existsSync("/Library/Developer/CommandLineTools/usr/bin/clang")) {
    env.DEVELOPER_DIR = "/Library/Developer/CommandLineTools";
  }
  await $`clang -O2 -Wall -fno-strict-aliasing -dynamiclib -I${rtDir} ${sources} -o ${dylib}`.env(env).quiet();
  return dylib;
}

/**
 * Missing-toolchain policy, shared by both backends: with PJ_<T>_HOST_ONLY set
 * the build degrades to the harness dylib (already built); otherwise it fails
 * loudly with an install hint.
 */
export function hostOnlyFallback(outPath: string, target: string, envVar: string, hint: string): TargetBuildResult {
  if (!process.env[envVar]) {
    throw new Error(`${target}: ${hint} (${envVar}=1 builds only the host harness dylib)`);
  }
  const dylib = hostDylibPath(outPath);
  console.warn(`${target}: ${envVar} — skipped device build, host dylib at ${dylib}`);
  return { rom: dylib, size: Bun.file(dylib).size };
}
