// aot/compiler/rom.ts — Stage 8: link the PJGB blob into a real .gba ROM.
// Emits gen_cart.c, cross-compiles the fixed C runtime with arm-none-eabi-gcc,
// objcopies to a raw ROM, and patches the GBA header complement checksum.

import { $ } from "bun";
import { emitCartC } from "./pack.ts";

const ROOT = new URL("../..", import.meta.url).pathname; // repo root
const RT = ROOT + "aot/runtime";
const DIST = ROOT + "aot/dist";

/** GBA header complement checksum over bytes 0xA0..0xBC, written at 0xBD. */
function patchHeaderChecksum(rom: Uint8Array): void {
  if (rom.length < 0xc0) throw new Error("ROM too small for a GBA header");
  let sum = 0;
  for (let a = 0xa0; a <= 0xbc; a++) sum += rom[a];
  rom[0xbd] = (-(0x19 + sum)) & 0xff;
}

export interface BuildRomResult {
  gba: string;
  elf: string;
  size: number;
}

export async function buildRom(blob: Uint8Array, outPath: string): Promise<BuildRomResult> {
  await Bun.write(RT + "/gen_cart.c", emitCartC(blob));

  const elf = DIST + "/game.elf";
  const CFLAGS = [
    "-mcpu=arm7tdmi",
    "-marm",
    "-ffreestanding",
    "-nostdlib",
    "-O2",
    "-fno-strict-aliasing",
    "-Wall",
  ];
  const sources = [
    `${RT}/crt0.s`,
    ...["cart", "video", "bg", "obj", "input", "map", "player", "actor", "camera", "script_vm", "textbox", "debug", "main", "gen_cart"].map(
      (m) => `${RT}/${m}.c`,
    ),
  ];

  await $`arm-none-eabi-gcc ${CFLAGS} -I${RT} -T${RT}/gba.ld ${sources} -lgcc -o ${elf}`.quiet();
  await $`arm-none-eabi-objcopy -O binary ${elf} ${outPath}`.quiet();

  const rom = new Uint8Array(await Bun.file(outPath).arrayBuffer());
  patchHeaderChecksum(rom);
  await Bun.write(outPath, rom);

  return { gba: outPath, elf, size: rom.length };
}
