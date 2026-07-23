#!/usr/bin/env bun
// vapor/compiler/cli.ts — compile a Pocket Vapor component to a cartridge.
//
//   bun vapor/compiler/cli.ts <component.tsx> [--target gba|gb|nes|esp32] [--out dist/vapor]
//   bun vapor/compiler/cli.ts check <component.tsx> [--strict]
//
// `check` runs the compiler frontend for EVERY target and prints the
// diagnostics matrix — the compile-time answer to "which consoles can run
// this file, and what degrades where". No toolchains needed.

import { basename, join, resolve } from "node:path";
import { compileVaporApp, VAPOR_TARGETS, type VaporTargetName } from "./compile.ts";
import { buildRom } from "./rom.ts";

let args = process.argv.slice(2);

if (args[0] === "check") {
  args = args.slice(1);
  const entry = args.find((a) => !a.startsWith("--"));
  if (!entry) {
    console.error("usage: bun vapor/compiler/cli.ts check <component.tsx> [--strict]");
    process.exit(2);
  }
  const strict = args.includes("--strict");
  const source = await Bun.file(entry).text();
  let failed = false;
  for (const target of Object.keys(VAPOR_TARGETS) as VaporTargetName[]) {
    try {
      const app = compileVaporApp(entry, source, "CHECK", target, { strict });
      const t = VAPOR_TARGETS[target];
      console.log(`${target.padEnd(4)} OK    ${t.width}x${t.height}, ${app.styles.pairs.length} style pairs`);
      for (const warning of app.diagnostics) console.log(`     warn  ${warning}`);
    } catch (e) {
      failed = true;
      console.log(`${target.padEnd(4)} FAIL`);
      for (const line of String(e instanceof Error ? e.message : e).split("\n"))
        console.log(`     error ${line}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
const entry = args.find((a) => !a.startsWith("--"));
if (!entry) {
  console.error(
    "usage: bun vapor/compiler/cli.ts <component.tsx> [--target gba|gb|nes|esp32] [--out <dir>]",
  );
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

const ext =
  target === "gba"
    ? "gba"
    : target === "gb"
      ? "gb"
      : target === "nes"
        ? "nes"
        : target === "esp32"
          ? "esp32.bin"
          : target satisfies never;
const rom = join(outDir, `${name}.${ext}`);
const { romBytes } = await buildRom(app, target, rom);
await Bun.write(join(outDir, `${name}.${target}.debug.json`), JSON.stringify(app.debugSlots, null, 2));
console.log(`\n${rom}  (${(romBytes / 1024).toFixed(1)} KB)`);
