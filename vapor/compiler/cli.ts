#!/usr/bin/env bun
// vapor/compiler/cli.ts — compile a Pocket Vapor component to a cartridge.
//
//   bun vapor/compiler/cli.ts <component.tsx> [--target gba|gb|nes|esp32] [--out dist/vapor]
//   bun vapor/compiler/cli.ts check <component.tsx> [--strict] [--json]
//
// `check` runs the compiler frontend for EVERY target and prints the
// diagnostics matrix — the compile-time answer to "which devices can run
// this file, and what degrades where". No toolchains needed. Board rows
// evaluate the aot admission rule (derived demands ⊨ board profile); they
// inform, they never fail the check — an app is not obligated to fit every
// board. `--json` emits the same matrix plus the derived demands as data
// (the machine-readable half a store or CI consumes; see vapor/BOARDS.md).

import { basename, join, resolve } from "node:path";
import { admitBoard, listBoards, loadBoard, POCKET_PAD, type BoardIssue } from "./boards.ts";
import { compileVaporApp, VAPOR_TARGETS, type CompiledApp, type VaporTargetName } from "./compile.ts";
import { buildRom } from "./rom.ts";

let args = process.argv.slice(2);

if (args[0] === "check") {
  args = args.slice(1);
  const entry = args.find((a) => !a.startsWith("--"));
  if (!entry) {
    console.error("usage: bun vapor/compiler/cli.ts check <component.tsx> [--strict] [--json]");
    process.exit(2);
  }
  const strict = args.includes("--strict");
  const json = args.includes("--json");
  const source = await Bun.file(entry).text();
  const label = Math.max(5, ...listBoards().map((name) => name.length));
  let failed = false;

  interface TargetRow {
    ok: boolean;
    grid: string;
    stylePairs?: number;
    buttonsUsed?: string[];
    warnings: string[];
    errors: string[];
  }
  const targets: Record<string, TargetRow> = {};
  const apps: Partial<Record<VaporTargetName, CompiledApp>> = {};
  for (const target of Object.keys(VAPOR_TARGETS) as VaporTargetName[]) {
    const t = VAPOR_TARGETS[target];
    const grid = `${t.width}x${t.height}`;
    try {
      const app = compileVaporApp(entry, source, "CHECK", target, { strict });
      apps[target] = app;
      targets[target] = {
        ok: true,
        grid,
        stylePairs: app.styles.pairs.length,
        buttonsUsed: app.buttonsUsed.map((id) => POCKET_PAD[id]),
        warnings: app.diagnostics,
        errors: [],
      };
      if (!json) {
        console.log(`${target.padEnd(label)} OK    ${grid}, ${app.styles.pairs.length} style pairs`);
        for (const warning of app.diagnostics) console.log(`${" ".repeat(label + 1)}warn  ${warning}`);
      }
    } catch (e) {
      failed = true;
      const errors = String(e instanceof Error ? e.message : e).split("\n");
      targets[target] = { ok: false, grid, warnings: [], errors };
      if (!json) {
        console.log(`${target.padEnd(label)} FAIL`);
        for (const line of errors) console.log(`${" ".repeat(label + 1)}error ${line}`);
      }
    }
  }

  interface BoardRow {
    chip: string;
    target: VaporTargetName;
    ok: boolean;
    issues: BoardIssue[];
  }
  const boards: Record<string, BoardRow> = {};
  for (const name of listBoards()) {
    const board = loadBoard(name);
    const target: VaporTargetName = "esp32"; // the only board-backed target
    const app = apps[target];
    const issues = app
      ? admitBoard({ buttonsUsed: app.buttonsUsed }, board, VAPOR_TARGETS[target])
      : [{ code: "VB100", severity: "error" as const, message: `target ${target} failed to compile` }];
    const ok = issues.every((issue) => issue.severity !== "error");
    boards[name] = { chip: board.chip, target, ok, issues };
    if (!json) {
      console.log(`${name.padEnd(label)} ${ok ? "OK   " : "FAIL "} board (${board.chip})`);
      for (const issue of issues)
        console.log(`${" ".repeat(label + 1)}${issue.severity.padEnd(5)} ${issue.code}: ${issue.message}`);
    }
  }

  if (json) {
    console.log(JSON.stringify({ entry, strict, targets, boards }, null, 2));
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
