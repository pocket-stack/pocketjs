#!/usr/bin/env bun
// vapor/scripts/shot.ts — bake PNG screenshots of the todo ROM for the docs.
//   bun vapor/scripts/shot.ts
// Builds the ROM, replays a short tape in headless libmgba, and writes
// 3x-nearest-neighbour PNGs to vapor/docs/.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { createCanvas } from "@napi-rs/canvas";
import { compileVaporApp } from "../compiler/compile.ts";
import { buildGbaRom } from "../compiler/rom.ts";
import { Button } from "../host/input.ts";

const HERE = import.meta.dir;
const ROOT = join(HERE, "..", "..");
const ENTRY = join(HERE, "..", "examples", "todo", "todo.tsx");
const OUT = join(ROOT, "dist", "vapor");
const DOCS = join(HERE, "..", "docs");
const RUNNER = join(HERE, "..", "test", "harness", "mgba_runner");

const app = compileVaporApp(ENTRY, await Bun.file(ENTRY).text(), "VAPOR TODO");
const rom = join(OUT, "todo.gba");
await buildGbaRom(app, rom);
if (!existsSync(RUNNER)) await $`bun ${join(HERE, "..", "test", "harness", "build.ts")}`.quiet();
await $`mkdir -p ${DOCS} ${OUT}/shots`.quiet();

const press = (b: number) => `P ${(1 << b).toString(16)} 2 4`;
const lines = [
  "A 6",
  `S ${OUT}/shots/todo-boot.ppm`,
  press(Button.Down),
  press(Button.A),
  press(Button.R),
  `S ${OUT}/shots/todo-active.ppm`,
  press(Button.R),
  press(Button.R),
  press(Button.Start),
  press(Button.A),
  press(Button.Right),
  press(Button.A),
  `S ${OUT}/shots/todo-edit.ppm`,
];
const scenario = join(OUT, "shot-scenario.txt");
await Bun.write(scenario, lines.join("\n") + "\n");
await $`${RUNNER} ${rom} ${scenario}`.quiet();

async function ppmToPng(src: string, dst: string, scale = 3): Promise<void> {
  const bytes = new Uint8Array(await Bun.file(src).arrayBuffer());
  const text = new TextDecoder().decode(bytes.slice(0, 64));
  const m = text.match(/^P6\n(\d+) (\d+)\n255\n/);
  if (!m) throw new Error(`not a P6 ppm: ${src}`);
  const w = Number(m[1]);
  const h = Number(m[2]);
  const off = m[0].length;
  const canvas = createCanvas(w * scale, h * scale);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w * scale, h * scale);
  for (let y = 0; y < h * scale; y++) {
    for (let x = 0; x < w * scale; x++) {
      const sx = (x / scale) | 0;
      const sy = (y / scale) | 0;
      const s = off + (sy * w + sx) * 3;
      const d = (y * w * scale + x) * 4;
      img.data[d] = bytes[s];
      img.data[d + 1] = bytes[s + 1];
      img.data[d + 2] = bytes[s + 2];
      img.data[d + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  await Bun.write(dst, canvas.toBuffer("image/png"));
}

for (const name of ["todo-boot", "todo-active", "todo-edit"]) {
  await ppmToPng(join(OUT, "shots", `${name}.ppm`), join(DOCS, `${name}.png`));
  console.log(`${join(DOCS, `${name}.png`)}`);
}
