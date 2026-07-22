#!/usr/bin/env bun
// vapor/scripts/blog-shots.ts — bake the blog's screenshot matrix.
//   bun vapor/scripts/blog-shots.ts
//
// For each console (gba/gb/nes): build the todo ROM, replay a deterministic
// tape that opens the editor and TYPES "HELLO HN" with the glyph picker,
// and capture three moments — boot, mid-edit, and the saved todo in the
// list. PNGs land in site/assets/blog/ at 3x nearest-neighbour, cropped to
// each console's real visible canvas.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { createCanvas } from "@napi-rs/canvas";
import { compileVaporApp, type VaporTargetName } from "../compiler/compile.ts";
import { buildRom } from "../compiler/rom.ts";
import { Button } from "../host/input.ts";

const HERE = import.meta.dir;
const ROOT = join(HERE, "..", "..");
const ENTRY = join(HERE, "..", "examples", "todo", "todo.tsx");
const OUT = join(ROOT, "dist", "vapor");
const BLOG = join(ROOT, "site", "assets", "blog");
const MGBA = join(HERE, "..", "tests", "harness", "mgba_runner");
const NES = join(HERE, "..", "tests", "harness", "nes_runner.ts");

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789";

interface Rig {
  name: VaporTargetName;
  ext: string;
  boot: string;
  press: (b: number) => string;
  run: (rom: string, scenario: string) => Promise<void>;
  crop: { w: number; h: number };
}

const RIGS: Rig[] = [
  {
    name: "gba",
    ext: "gba",
    boot: "A 6",
    press: (b) => `P ${(1 << b).toString(16)} 2 4`,
    run: async (rom, sc) => void (await $`${MGBA} ${rom} ${sc}`.quiet()),
    crop: { w: 240, h: 160 },
  },
  {
    name: "gb",
    ext: "gb",
    boot: "A 120",
    press: (b) => `P ${(1 << b).toString(16)} 16 40`,
    run: async (rom, sc) => void (await $`${MGBA} ${rom} ${sc}`.quiet()),
    crop: { w: 160, h: 144 },
  },
  {
    name: "nes",
    ext: "nes",
    boot: "A 6",
    press: (b) => `P ${(1 << b).toString(16)} 2 8`,
    run: async (rom, sc) => void (await $`bun ${NES} ${rom} ${sc}`.quiet()),
    crop: { w: 256, h: 240 },
  },
];

/** Glyph-picker presses that type `text`, starting from glyph index 0. */
function typing(text: string, press: (b: number) => string): string[] {
  const lines: string[] = [];
  let at = 0;
  for (const ch of text) {
    const target = GLYPHS.indexOf(ch);
    if (target < 0) throw new Error(`untypeable char: ${ch}`);
    const right = (target - at + GLYPHS.length) % GLYPHS.length;
    const left = (at - target + GLYPHS.length) % GLYPHS.length;
    if (right <= left) for (let i = 0; i < right; i++) lines.push(press(Button.Right));
    else for (let i = 0; i < left; i++) lines.push(press(Button.Left));
    lines.push(press(Button.A));
    at = target;
  }
  return lines;
}

async function ppmToPng(src: string, dst: string, cw: number, chh: number, scale = 3): Promise<void> {
  const bytes = new Uint8Array(await Bun.file(src).arrayBuffer());
  const text = new TextDecoder().decode(bytes.slice(0, 64));
  const m = text.match(/^P6\n(\d+) (\d+)\n255\n/);
  if (!m) throw new Error(`not a P6 ppm: ${src}`);
  const w = Number(m[1]);
  const off = m[0].length;
  const canvas = createCanvas(cw * scale, chh * scale);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(cw * scale, chh * scale);
  for (let y = 0; y < chh * scale; y++) {
    for (let x = 0; x < cw * scale; x++) {
      const sx = (x / scale) | 0;
      const sy = (y / scale) | 0;
      const s = off + (sy * w + sx) * 3;
      const d = (y * cw * scale + x) * 4;
      img.data[d] = bytes[s];
      img.data[d + 1] = bytes[s + 1];
      img.data[d + 2] = bytes[s + 2];
      img.data[d + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  await Bun.write(dst, canvas.toBuffer("image/png"));
}

if (!existsSync(MGBA)) await $`bun ${join(HERE, "..", "tests", "harness", "build.ts")}`.quiet();
await $`mkdir -p ${BLOG} ${OUT}/shots`.quiet();

const source = await Bun.file(ENTRY).text();
for (const rig of RIGS) {
  const app = compileVaporApp(ENTRY, source, "VAPOR TODO", rig.name);
  const rom = join(OUT, `todo.${rig.ext}`);
  await buildRom(app, rig.name, rom);

  const shots = {
    boot: join(OUT, "shots", `blog-${rig.name}-boot.ppm`),
    edit: join(OUT, "shots", `blog-${rig.name}-edit.ppm`),
    added: join(OUT, "shots", `blog-${rig.name}-added.ppm`),
  };
  const lines = [
    rig.boot,
    `S ${shots.boot}`,
    rig.press(Button.Start), // open the editor
    ...typing("HELLO HN", rig.press),
    `S ${shots.edit}`,
    rig.press(Button.Start), // save
    rig.press(Button.Down),
    rig.press(Button.Down),
    rig.press(Button.Down), // cursor onto the new todo
    `S ${shots.added}`,
  ];
  const sc = join(OUT, `blog-${rig.name}.txt`);
  await Bun.write(sc, lines.join("\n") + "\n");
  await rig.run(rom, sc);

  for (const [kind, ppm] of Object.entries(shots)) {
    const png = join(BLOG, `vapor-${rig.name}-${kind}.png`);
    await ppmToPng(ppm, png, rig.crop.w, rig.crop.h);
    console.log(png);
  }
}
