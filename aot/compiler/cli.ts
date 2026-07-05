#!/usr/bin/env bun
// aot/compiler/cli.ts — `pocket-aot build src/game.tsx --out dist/game.gba`
// (design §21). Also emits ir.json / debug.json for the emulator test harness.

import { resolve } from "node:path";
import { compile, debugInfo, irJson } from "./index.ts";
import { buildRom } from "./rom.ts";

function usage(): never {
  console.error("usage: pocket-aot build <entry.tsx> [--out <file.gba>] [--no-rom]");
  process.exit(2);
}

const [cmd, entryArg, ...rest] = process.argv.slice(2);
if (cmd !== "build" || !entryArg) usage();

let out = "aot/dist/pocket-town.gba";
let doRom = true;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--out") out = rest[++i];
  else if (rest[i] === "--no-rom") doRom = false;
  else usage();
}

const entry = resolve(entryArg);
const outAbs = resolve(out);
const base = outAbs.replace(/\.gba$/, "");

const t0 = performance.now();
const built = await compile(entry);
const di = debugInfo(built) as Record<string, unknown>;

await Bun.write(base + ".ir.json", JSON.stringify(irJson(built), null, 2));
await Bun.write(base + ".debug.json", JSON.stringify(di, null, 2));
await Bun.write(base + ".pjgb", built.blob);

console.log(`PocketJS-AOT build: ${built.game.title}`);
console.log(`  maps: ${built.model.maps.length}`);
console.log(`  scripts: ${built.ctx.scripts.length}   texts: ${built.ctx.texts.size}   flags: ${built.ctx.flags.size}`);
console.log(`  BG tiles: ${built.ctx.bgTiles.length}   OBJ tiles: ${built.ctx.objTiles.length}   sprites: ${built.ctx.spriteProtos.length}`);
console.log(`  cartridge: ${built.blob.length} bytes`);

if (doRom) {
  const r = await buildRom(built.blob, outAbs);
  console.log(`  ROM: ${r.gba} (${r.size} bytes)`);
}
console.log(`  done in ${(performance.now() - t0).toFixed(0)}ms`);
