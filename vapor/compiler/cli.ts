#!/usr/bin/env bun
// vapor/compiler/cli.ts — compile a Pocket Vapor component to a .gba ROM.
//
//   bun vapor/compiler/cli.ts vapor/examples/todo/todo.tsx [--out dist/vapor]
//
// Prints the reactive graph and the memory plan, then builds the cart.

import { basename, join, resolve } from "node:path";
import { compileVaporApp } from "./compile.ts";
import { buildGbaRom } from "./rom.ts";

const args = process.argv.slice(2);
const entry = args.find((a) => !a.startsWith("--"));
if (!entry) {
  console.error("usage: bun vapor/compiler/cli.ts <component.tsx> [--out <dir>]");
  process.exit(2);
}
const outIdx = args.indexOf("--out");
const outDir = resolve(outIdx >= 0 ? args[outIdx + 1] : "dist/vapor");

const source = await Bun.file(entry).text();
const name = basename(entry).replace(/\.tsx$/, "");
const app = compileVaporApp(entry, source, name === "todo" ? "VAPOR TODO" : name.toUpperCase());

console.log("== reactive graph ==");
console.log(app.graph);
console.log("\n== memory plan ==");
console.log(app.plan);

const rom = join(outDir, `${name}.gba`);
const { romBytes } = await buildGbaRom(app, rom);
await Bun.write(join(outDir, `${name}.debug.json`), JSON.stringify(app.debugSlots, null, 2));
console.log(`\n${rom}  (${(romBytes / 1024).toFixed(1)} KB)`);
