// aot/compiler/targets/3ds.ts — the 3DS backend.
//
// The 3DS has a flat address space and a software-rendering runtime, so it
// ships the exact GBA lowering: the same PJGB chunk container, 4bpp tiles and
// BGR555 palettes (lowerGba is target-parameterized — text wrapping and glyph
// slots follow TARGETS["3ds"]). Only the packaging differs. Every build
// produces TWO artifacts from the same gen_cart.c:
//
//   <out>.3dsx        — devkitARM/libctru homebrew binary for console/emulator
//   <out>.host.dylib  — the SAME core compiled for the host, driven by the
//                       E2E harness (test/harness/host_runner.ts) over Bun FFI
//
// The game core is runtime/shared/ (logic + software renderer) compiled
// against runtime/3ds/runtime.h; ctru_main.c is the only device-specific file.
// Toolchain: $DEVKITPRO or ~/.pocketjs/toolchains/devkitpro (same convention
// as GBDK). Set PJ_3DS_HOST_ONLY=1 to skip the device build (harness-only).

import { $ } from "bun";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { emitCartC } from "../pack.ts";
import { lowerGba } from "./gba.ts";
import { buildHostDylib, hostOnlyFallback, logicSources, softRenderSource } from "./host.ts";
import type { CompileOutput } from "../index.ts";
import type { TargetBuildResult } from "./index.ts";

const ROOT = new URL("../../..", import.meta.url).pathname; // repo root
const RT = ROOT + "aot/runtime/3ds";

function devkitPro(): string | null {
  const cands = [process.env.DEVKITPRO, homedir() + "/.pocketjs/toolchains/devkitpro", "/opt/devkitpro"];
  for (const c of cands) {
    if (c && existsSync(c + "/devkitARM/bin/arm-none-eabi-gcc")) return c;
  }
  return null;
}

// Generate an SMDH (icon + title metadata) so the Homebrew Launcher shows a
// real name/author instead of a nameless default. Best-effort: a missing
// smdhtool or icon just means a bare .3dsx (still boots fine).
async function buildSmdh(outPath: string, dkp: string, title: string, env: Record<string, string>): Promise<string | null> {
  const smdhtool = existsSync(`${dkp}/tools/bin/smdhtool`) ? `${dkp}/tools/bin/smdhtool` : null;
  const icon = `${dkp}/libctru/default_icon.png`;
  if (!smdhtool || !existsSync(icon)) return null;
  const smdh = outPath.replace(/\.3dsx$/, "") + ".smdh";
  const name = title.replace(/[^\x20-\x7e]/g, "").trim() || "PocketJS";
  await $`${smdhtool} --create ${name} ${"PocketJS-AOT cartridge"} ${"PocketJS"} ${icon} ${smdh}`.env(env).quiet();
  return smdh;
}

async function buildDevice(outPath: string, dkp: string, title: string): Promise<void> {
  const gcc = `${dkp}/devkitARM/bin/arm-none-eabi-gcc`;
  const tool3dsx = existsSync(`${dkp}/tools/bin/3dsxtool`)
    ? `${dkp}/tools/bin/3dsxtool`
    : `${dkp}/devkitARM/bin/3dsxtool`;
  const elf = outPath.replace(/\.3dsx$/, "") + ".elf";

  const ARCH = ["-march=armv6k", "-mtune=mpcore", "-mfloat-abi=hard", "-mtp=soft"];
  const CFLAGS = [...ARCH, "-O2", "-ffunction-sections", "-fdata-sections", "-fno-strict-aliasing", "-Wall", "-D__3DS__"];
  const sources = [...logicSources(), softRenderSource(), `${RT}/ctru_main.c`, `${RT}/gen_cart.c`];

  const env = { ...process.env, DEVKITPRO: dkp, DEVKITARM: `${dkp}/devkitARM` };
  await $`${gcc} ${CFLAGS} -I${RT} -I${dkp}/libctru/include ${sources} -specs=3dsx.specs -Wl,--gc-sections -L${dkp}/libctru/lib -lctru -lm -o ${elf}`
    .env(env)
    .quiet();

  const smdh = await buildSmdh(outPath, dkp, title, env);
  if (smdh) await $`${tool3dsx} ${elf} ${outPath} --smdh=${smdh}`.env(env).quiet();
  else await $`${tool3dsx} ${elf} ${outPath}`.env(env).quiet();
}

export async function build3ds(out: CompileOutput, outPath: string): Promise<TargetBuildResult> {
  const { blob } = lowerGba(out);
  await Bun.write(`${RT}/gen_cart.c`, emitCartC(blob));

  await buildHostDylib(RT, outPath);

  const dkp = devkitPro();
  if (!dkp) {
    return hostOnlyFallback(
      outPath,
      "3ds",
      "PJ_3DS_HOST_ONLY",
      "devkitARM not found (set $DEVKITPRO or install to ~/.pocketjs/toolchains/devkitpro)",
    );
  }

  await buildDevice(outPath, dkp, out.game.title);
  return { rom: outPath, size: Bun.file(outPath).size };
}
