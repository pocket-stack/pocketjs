#!/usr/bin/env bun
// aot/compiler/cli.ts — `pocket-aot build src/game.tsx --target gb --out dist/game.gb`
// (design §21). Also emits ir.json / debug.json for the emulator test harness.

import { resolve } from "node:path";
import { compile, debugInfo, irJson } from "./index.ts";
import { TARGETS, type TargetName } from "../spec/pjgb.ts";

// The target list, its ROM extensions, and everything else target-shaped come
// straight from spec TARGETS — adding a console never touches this file.
const TARGET_NAMES = Object.keys(TARGETS) as TargetName[];

function usage(): never {
  console.error(`usage: pocket-aot build <entry.tsx> [--target ${TARGET_NAMES.join("|")}] [--out <file>] [--no-rom]`);
  process.exit(2);
}

const [cmd, entryArg, ...rest] = process.argv.slice(2);
if (cmd !== "build" || !entryArg) usage();

let out = "";
let target: TargetName = "gba";
let doRom = true;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--out") out = rest[++i];
  else if (rest[i] === "--target") {
    const t = rest[++i];
    if (!TARGET_NAMES.includes(t as TargetName)) usage();
    target = t as TargetName;
  } else if (rest[i] === "--no-rom") doRom = false;
  else usage();
}
if (!out) out = `aot/dist/game${TARGETS[target].ext}`;

const entry = resolve(entryArg);
const outAbs = resolve(out);
const extPattern = new RegExp(`\\.(${TARGET_NAMES.map((t) => TARGETS[t].ext.slice(1)).join("|")})$`);
const base = outAbs.replace(extPattern, "");

const t0 = performance.now();
const built = await compile(entry, target);
const di = debugInfo(built) as Record<string, unknown>;

await Bun.write(base + ".ir.json", JSON.stringify(irJson(built), null, 2));
await Bun.write(base + ".debug.json", JSON.stringify(di, null, 2));

console.log(`PocketJS-AOT build: ${built.game.title} [${target}, ${built.mode}]`);
console.log(`  maps: ${built.model.maps.length}`);
console.log(`  scripts: ${built.ctx.scripts.length}   texts: ${built.ctx.texts.size}   flags: ${built.ctx.flags.size}`);
console.log(`  BG tiles: ${built.ctx.bgTilePx.length}   sprites: ${built.ctx.spriteProtos.length}   CJK glyphs: ${built.ctx.fullGlyphs.size}`);

if (doRom) {
  const { buildTarget } = await import("./targets/index.ts");
  const r = await buildTarget(built, outAbs);
  console.log(`  ROM: ${r.rom} (${r.size} bytes)`);
}
console.log(`  done in ${(performance.now() - t0).toFixed(0)}ms`);
