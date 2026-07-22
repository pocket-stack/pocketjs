// vapor/test/parity.test.ts — the Pocket Vapor claim, executed.
//
// One tape of button presses drives BOTH implementations of todo.tsx:
//   oracle: real vue 3.6 runtime-with-vapor over the micro-DOM (JS)
//   device: the compiled .gba running in headless libmgba (ARM7TDMI)
// After every press the 30x20 cell grid (chars + palettes) must match
// cell-for-cell. Same file, same semantics, no JavaScript engine on device.

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { compileVaporApp } from "../compiler/compile.ts";
import { buildGbaRom } from "../compiler/rom.ts";
import { Button } from "../host/input.ts";
import { bootOracle } from "../oracle/boot.ts";
import { GRID_H, GRID_W } from "../oracle/paint.ts";

const HERE = import.meta.dir;
const ENTRY = join(HERE, "..", "examples", "todo", "todo.tsx");
const OUT = join(HERE, "..", "..", "dist", "vapor");
const ROM = join(OUT, "todo.gba");
const RUNNER = join(HERE, "harness", "mgba_runner");

// Every interaction the app has: navigation, toggle, filters, delete,
// clear-completed, the editor (put/scrub/backspace/save/cancel), emptying
// the list, and re-adding from the empty state.
const TAPE: number[] = [
  Button.Down,
  Button.Down,
  Button.A, // toggle last
  Button.Up,
  Button.A, // un-done the middle todo
  Button.R, // ACTIVE
  Button.Down,
  Button.A, // toggle under ACTIVE -> row leaves the view
  Button.R, // DONE
  Button.R, // ALL
  Button.B, // delete first
  Button.Select, // clear completed
  Button.Start, // edit mode
  Button.Left, // glyph wraps to "9"
  Button.Right,
  Button.Right, // glyph "B"
  Button.A, // put B
  Button.A, // put B
  Button.B, // backspace
  Button.A, // put B again
  Button.Start, // save "BB"
  Button.Start, // edit mode again
  Button.Select, // cancel
  Button.Down,
  Button.B, // delete
  Button.B, // delete
  Button.B, // delete -> NOTHING HERE
  Button.B, // delete on empty (no-op)
  Button.Start,
  Button.A,
  Button.Start, // add "A" from empty state
];

interface DeviceStep {
  chars: string[];
  pals: number[][];
}

let deviceSteps: DeviceStep[] = [];
let deviceTrips = 0;

function decodeGrid(charsHex: string, palsHex: string): DeviceStep {
  const chars: string[] = [];
  const pals: number[][] = [];
  for (let y = 0; y < GRID_H; y++) {
    let row = "";
    const palRow: number[] = [];
    for (let x = 0; x < GRID_W; x++) {
      const i = y * GRID_W + x;
      const code = parseInt(charsHex.slice(i * 2, i * 2 + 2), 16);
      row += String.fromCharCode(code || 32);
      palRow.push(parseInt(palsHex.slice(i * 2, i * 2 + 2), 16));
    }
    chars.push(row);
    pals.push(palRow);
  }
  return { chars, pals };
}

beforeAll(async () => {
  const source = await Bun.file(ENTRY).text();
  const app = compileVaporApp(ENTRY, source, "VAPOR TODO");
  await buildGbaRom(app, ROM);
  if (!existsSync(RUNNER)) await $`bun ${join(HERE, "harness", "build.ts")}`.quiet();

  const lines: string[] = ["A 5", "D chars0 0x2000100 600", "D pals0 0x2000360 600"];
  TAPE.forEach((b, i) => {
    lines.push(`P ${(1 << b).toString(16)} 2 4`);
    lines.push(`D chars${i + 1} 0x2000100 600`);
    lines.push(`D pals${i + 1} 0x2000360 600`);
  });
  lines.push("R trips 0x200000c 1");
  const scenario = join(OUT, "parity-scenario.txt");
  await Bun.write(scenario, lines.join("\n") + "\n");

  const out = await $`${RUNNER} ${ROM} ${scenario}`.text();
  const parsed = JSON.parse(out) as { ok: boolean; reads: Record<string, string | number> };
  expect(parsed.ok).toBe(true);
  deviceSteps = [];
  for (let i = 0; i <= TAPE.length; i++) {
    deviceSteps.push(decodeGrid(parsed.reads[`chars${i}`] as string, parsed.reads[`pals${i}`] as string));
  }
  deviceTrips = parsed.reads.trips as number;
});

describe("oracle == device", () => {
  test("every step of the tape renders identically", async () => {
    const oracle = await bootOracle();
    const compare = (step: number, label: string) => {
      const want = oracle.grid();
      const got = deviceSteps[step];
      for (let y = 0; y < GRID_H; y++) {
        expect(`${label} y=${y}: ${got.chars[y]}`).toBe(`${label} y=${y}: ${want.chars[y]}`);
        expect(`${label} y=${y} pal: ${got.pals[y].join(",")}`).toBe(
          `${label} y=${y} pal: ${want.pals[y].join(",")}`,
        );
      }
    };
    compare(0, "boot");
    for (let i = 0; i < TAPE.length; i++) {
      await oracle.press(TAPE[i]);
      compare(i + 1, `step ${i} (btn ${TAPE[i]})`);
    }
    oracle.unmount();
  });

  test("no runtime tripwires fired on device", () => {
    expect(deviceTrips).toBe(0);
  });
});
