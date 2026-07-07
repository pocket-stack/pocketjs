// aot/compiler/targets/nds.ts — the Nintendo DS backend.
//
// The DS 2D hardware is "GBA x2" (same 4bpp tiles + BGR555 palettes), so it
// ships the exact GBA lowering: the same PJGB chunk container, target-neutral
// text wrapping/glyph budget following TARGETS["nds"]. Only the packaging
// differs. Every build produces TWO artifacts from the same gen_cart.c:
//
//   <out>.nds         — BlocksDS homebrew ROM (DS flashcart / emulator)
//   <out>.host.dylib  — the SAME core compiled for the host with the shared
//                       software renderer, driven by the E2E harness over
//                       Bun FFI (test/harness/host_runner.ts)
//
// The game core is runtime/shared/ compiled against runtime/nds/runtime.h;
// render_ds.c (dual-engine hardware renderer) + nds_main.c are device-only.
//
// Device build: arm9-only against BlocksDS libnds + BlocksDS's default ARM7,
// combined with ndstool. BlocksDS (NOT devkitPro/calico) is deliberate:
// legacy flashcart loaders never hand off calico's ARM7-DLDI thread, so
// calico homebrew hangs at their "Loading…" splash. Toolchain:
// $WONDERFUL_TOOLCHAIN or ~/.pocketjs/toolchains/wonderful.
// Set PJ_NDS_HOST_ONLY=1 to skip the device build (harness-only).

import { $ } from "bun";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { emitCartC } from "../pack.ts";
import { lowerGba } from "./gba.ts";
import { buildHostDylib, hostOnlyFallback, logicSources } from "./host.ts";
import type { CompileOutput } from "../index.ts";
import type { TargetBuildResult } from "./index.ts";

const ROOT = new URL("../../..", import.meta.url).pathname; // repo root
const RT = ROOT + "aot/runtime/nds";

function wonderful(): string | null {
  const cands = [process.env.WONDERFUL_TOOLCHAIN, homedir() + "/.pocketjs/toolchains/wonderful", "/opt/wonderful"];
  for (const c of cands) {
    if (c && existsSync(c + "/thirdparty/blocksds/core/libs/libnds/lib/libnds9.a")) return c;
  }
  return null;
}

// The prebuilt default ARM7 core shipped by BlocksDS.
function defaultArm7(blocksds: string): string | null {
  const arm7 = `${blocksds}/sys/default_arm7/arm7.elf`;
  return existsSync(arm7) ? arm7 : null;
}

async function buildDevice(outPath: string, wt: string, title: string): Promise<void> {
  const BLOCKSDS = `${wt}/thirdparty/blocksds/core`;
  const gcc = `${wt}/toolchain/gcc-arm-none-eabi/bin/arm-none-eabi-gcc`;
  const ndstool = `${BLOCKSDS}/tools/ndstool/ndstool`;
  const arm7 = defaultArm7(BLOCKSDS);
  if (!arm7) throw new Error("nds: BlocksDS default ARM7 core not found");
  const specs = `${BLOCKSDS}/sys/crts/ds_arm9.specs`;
  const elf = outPath.replace(/\.nds$/, "") + ".arm9.elf";

  // DS ARM9 (ARM946E-S). BlocksDS ds_arm9.specs supplies crt0/picolibc/linker
  // script; link -lnds9 -lc in a group. DYLD_LIBRARY_PATH is required because
  // the relocated toolchain's cc1/ld resolve libzstd by leaf name.
  const ARCH = ["-mthumb", "-mcpu=arm946e-s+nofp"];
  const CFLAGS = [...ARCH, "-O2", "-ffunction-sections", "-fdata-sections", "-fno-strict-aliasing", "-Wall", "-DARM9", "-D__NDS__", "-D__BLOCKSDS__"];
  const sources = [...logicSources(), `${RT}/render_ds.c`, `${RT}/nds_main.c`, `${RT}/gen_cart.c`];

  const env = {
    ...process.env,
    WONDERFUL_TOOLCHAIN: wt,
    BLOCKSDS,
    BLOCKSDSEXT: `${wt}/thirdparty/blocksds/external`,
    DYLD_LIBRARY_PATH: `${wt}/lib`,
    PATH: `${wt}/toolchain/gcc-arm-none-eabi/bin:${wt}/bin:${process.env.PATH ?? ""}`,
  };
  await $`${gcc} ${CFLAGS} -I${RT} -I${BLOCKSDS}/libs/libnds/include ${sources} -specs=${specs} -Wl,--gc-sections -L${BLOCKSDS}/libs/libnds/lib -Wl,--start-group -lnds9 -lc -Wl,--end-group -o ${elf}`
    .env(env)
    .quiet();

  // Banner: "title;subtitle1;subtitle2" shown by DS flashcart menus.
  const clean = title.replace(/[^\x20-\x7e]/g, "").trim() || "PocketJS";
  const banner = `${clean};PocketJS-AOT;`;
  const icon = `${BLOCKSDS}/sys/icon.bmp`;
  // A real 4-char game code + maker code (ndstool's default "####" is invalid
  // and trips some flashcart save handlers). And CRITICALLY: `-h 0x200` — the
  // classic NTR homebrew header. With the modern 0x4000 layout (ARM9 at the
  // retail secure-area offset), DSTT-family flashcart loaders classify the ROM
  // as RETAIL, look its game code up in their infolib.dat patch database, find
  // nothing, and die with "load rom errcode=-4". ARM9 at 0x200 routes them
  // onto their homebrew path instead. (Trade-off: 0x200 ROMs don't boot in DSi
  // mode — irrelevant for DS-mode flashcart targets.)
  const code = ("P" + clean.replace(/[^A-Za-z0-9]/g, "")).toUpperCase().slice(0, 4).padEnd(4, "X");
  const gopts = ["-g", code, "PJ", clean.slice(0, 12), "-h", "0x200"];
  if (existsSync(icon)) await $`${ndstool} -c ${outPath} -9 ${elf} -7 ${arm7} -b ${icon} ${banner} ${gopts}`.env(env).quiet();
  else await $`${ndstool} -c ${outPath} -9 ${elf} -7 ${arm7} ${gopts}`.env(env).quiet();

  // NB: we deliberately do NOT pre-patch a DLDI driver. The game links its cart
  // data and never touches the SD filesystem, so it needs no DLDI — and a
  // pre-patched section makes the flashcart loader's own DLDI patcher error out
  // ("load rom errcode=-4") on the r4isdhc DEMON kernel.

  // BlocksDS already emits a plain-DS (NTR) header, but its ndstool leaves the
  // header CRC (offset 0x15E, CRC-16/MODBUS over bytes 0x000..0x15D) unset —
  // and a picky flashcart loader may validate it. Force NTR unit code and
  // recompute the CRC ourselves. Also pad the file to the chip size the
  // header's capacity byte declares (128KB << n): flashcart loaders read by
  // declared capacity and can fail reading past a shorter file (emulators
  // merely warn "bad ROM size ... rounded").
  const raw = new Uint8Array(await Bun.file(outPath).arrayBuffer());
  const declared = 0x20000 << raw[0x14];
  const rom = raw.length < declared ? new Uint8Array(declared) : raw;
  if (rom !== raw) rom.set(raw);
  rom[0x12] = 0x00;
  const crc = headerCrc16(rom, 0x15e);
  rom[0x15e] = crc & 0xff;
  rom[0x15f] = (crc >> 8) & 0xff;
  await Bun.write(outPath, rom);
}

// DS header CRC (CRC-16/MODBUS: reflected poly 0xA001, init 0xFFFF).
function headerCrc16(data: Uint8Array, len: number): number {
  let crc = 0xffff;
  for (let i = 0; i < len; i++) {
    crc ^= data[i];
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc & 0xffff;
}

export async function buildNds(out: CompileOutput, outPath: string): Promise<TargetBuildResult> {
  const { blob } = lowerGba(out);
  await Bun.write(`${RT}/gen_cart.c`, emitCartC(blob));

  await buildHostDylib(RT, outPath);

  const wt = wonderful();
  if (!wt) {
    return hostOnlyFallback(
      outPath,
      "nds",
      "PJ_NDS_HOST_ONLY",
      "BlocksDS not found (set $WONDERFUL_TOOLCHAIN or install to ~/.pocketjs/toolchains/wonderful)",
    );
  }

  await buildDevice(outPath, wt, out.game.title);
  return { rom: outPath, size: Bun.file(outPath).size };
}
