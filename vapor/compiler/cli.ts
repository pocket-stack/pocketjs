#!/usr/bin/env bun
// vapor/compiler/cli.ts — compile a Pocket Vapor component to a cartridge.
//
//   bun vapor/compiler/cli.ts vapor/examples/todo/todo.tsx [--target gba|gb|nes] [--out dist/vapor]
//
// Prints the reactive graph and the memory plan, then builds the cart.

import { basename, join, resolve } from "node:path";
import { compileVaporApp, VAPOR_TARGETS, type VaporTargetName } from "./compile.ts";
import { buildRom } from "./rom.ts";

const args = process.argv.slice(2);
const entry = args.find((a) => !a.startsWith("--"));
if (!entry) {
  console.error("usage: bun vapor/compiler/cli.ts <component.tsx> [--target gba|gb|nes] [--out <dir>]");
  process.exit(2);
}
const outIdx = args.indexOf("--out");
const outDir = resolve(outIdx >= 0 ? args[outIdx + 1] : "dist/vapor");
const targetIdx = args.indexOf("--target");
const target = (targetIdx >= 0 ? args[targetIdx + 1] : "gba") as VaporTargetName;
if (!(target in VAPOR_TARGETS)) {
  console.error(`unknown target: ${target}`);
  process.exit(2);
}

const source = await Bun.file(entry).text();
const name = basename(entry).replace(/\.tsx$/, "");
const app = compileVaporApp(entry, source, name === "todo" ? "VAPOR TODO" : name.toUpperCase(), target);

console.log(`== reactive graph (${target}) ==`);
console.log(app.graph);
console.log("\n== memory plan ==");
console.log(app.plan);

const ext = target === "gba" ? "gba" : target === "gb" ? "gb" : "nes";
const rom = join(outDir, `${name}.${ext}`);
const { romBytes } = await buildRom(app, target, rom);
await Bun.write(join(outDir, `${name}.${target}.debug.json`), JSON.stringify(app.debugSlots, null, 2));
console.log(`\n${rom}  (${(romBytes / 1024).toFixed(1)} KB)`);
