// vapor/test/parity.test.ts — the Pocket Vapor claim, executed on three consoles.
//
// One tape of button presses drives FOUR implementations of todo.tsx:
//   oracle: real vue 3.6 runtime-with-vapor over the micro-DOM (JS),
//           booted per target with that console's screen geometry
//   GBA:    compiled ARM7 in headless libmgba          (30x20)
//   GB:     compiled SM83 (sdcc) in headless libmgba   (20x18)
//   NES:    compiled 6502 (cc65) in jsnes              (22x18)
// After every press the logical cell grid (chars + palettes) must match
// cell-for-cell, read from the PVDB debug block each runtime keeps at its
// console's fixed address. GB/NES pacing notes: the GB scenario uses video
// frames with generous hold/release margins (a flush can span frames on a
// 1 MHz SM83); the NES runner paces on the debug frame counter directly.

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { compileVaporApp, VAPOR_TARGETS, type VaporTargetName } from "../compiler/compile.ts";
import { buildRom } from "../compiler/rom.ts";
import { Button } from "../host/input.ts";
import { bootOracle } from "../oracle/boot.ts";

const HERE = import.meta.dir;
const ENTRY = join(HERE, "..", "examples", "todo", "todo.tsx");
const OUT = join(HERE, "..", "..", "dist", "vapor");
const MGBA_RUNNER = join(HERE, "harness", "mgba_runner");
const NES_RUNNER = join(HERE, "harness", "nes_runner.ts");

// Every interaction the app has: navigation, toggle, filters (Right works on
// every pad; R is GBA-only), delete, clear-completed, the editor, emptying
// the list, and re-adding from the empty state.
const TAPE: number[] = [
  Button.Down,
  Button.Down,
  Button.A, // toggle last
  Button.Up,
  Button.A, // un-done the middle todo
  Button.Right, // ACTIVE
  Button.Down,
  Button.A, // toggle under ACTIVE -> row leaves the view
  Button.Right, // DONE
  Button.Right, // ALL
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

interface TargetRig {
  name: VaporTargetName;
  ext: string;
  charsAddr: number;
  palsAddr: number;
  tripsAddr: number;
  boot: string; // scenario advance before step 0
  press: (mask: number) => string;
  run: (rom: string, scenario: string) => Promise<string>;
}

const RIGS: TargetRig[] = [
  {
    name: "gba",
    ext: "gba",
    charsAddr: 0x2000100,
    palsAddr: 0x2000360,
    tripsAddr: 0x200000c,
    boot: "A 5",
    press: (mask) => `P ${mask.toString(16)} 2 4`,
    run: async (rom, scenario) => await $`${MGBA_RUNNER} ${rom} ${scenario}`.text(),
  },
  {
    name: "gb",
    ext: "gb",
    charsAddr: 0xd840,
    palsAddr: 0xd9a8,
    tripsAddr: 0xd80c,
    boot: "A 90", // app_init alone spans ~26 video frames on the 1 MHz SM83
    press: (mask) => `P ${mask.toString(16)} 16 40`,
    run: async (rom, scenario) => await $`${MGBA_RUNNER} ${rom} ${scenario}`.text(),
  },
  {
    name: "nes",
    ext: "nes",
    charsAddr: 0x0240,
    palsAddr: 0x03cc,
    tripsAddr: 0x020c,
    boot: "A 5", // engine ticks: the runner paces on the debug frame counter
    press: (mask) => `P ${mask.toString(16)} 2 4`,
    run: async (rom, scenario) => await $`bun ${NES_RUNNER} ${rom} ${scenario}`.text(),
  },
];

interface DeviceStep {
  chars: string[];
  pals: number[][];
}

function decodeGrid(charsHex: string, palsHex: string, w: number, h: number): DeviceStep {
  const chars: string[] = [];
  const pals: number[][] = [];
  for (let y = 0; y < h; y++) {
    let row = "";
    const palRow: number[] = [];
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const code = parseInt(charsHex.slice(i * 2, i * 2 + 2), 16);
      row += String.fromCharCode(code || 32);
      palRow.push(parseInt(palsHex.slice(i * 2, i * 2 + 2), 16));
    }
    chars.push(row);
    pals.push(palRow);
  }
  return { chars, pals };
}

const deviceRuns = new Map<VaporTargetName, { steps: DeviceStep[]; trips: number }>();

beforeAll(async () => {
  if (!existsSync(MGBA_RUNNER)) await $`bun ${join(HERE, "harness", "build.ts")}`.quiet();
  const source = await Bun.file(ENTRY).text();

  for (const rig of RIGS) {
    const t = VAPOR_TARGETS[rig.name];
    const cells = t.width * t.height;
    const app = compileVaporApp(ENTRY, source, "VAPOR TODO", rig.name);
    const rom = join(OUT, `todo.${rig.ext}`);
    await buildRom(app, rig.name, rom);

    const lines: string[] = [
      rig.boot,
      `D chars0 0x${rig.charsAddr.toString(16)} ${cells}`,
      `D pals0 0x${rig.palsAddr.toString(16)} ${cells}`,
    ];
    TAPE.forEach((b, i) => {
      lines.push(rig.press(1 << b));
      lines.push(`D chars${i + 1} 0x${rig.charsAddr.toString(16)} ${cells}`);
      lines.push(`D pals${i + 1} 0x${rig.palsAddr.toString(16)} ${cells}`);
    });
    lines.push(`R trips 0x${rig.tripsAddr.toString(16)} 1`);
    const scenario = join(OUT, `parity-${rig.name}.txt`);
    await Bun.write(scenario, lines.join("\n") + "\n");

    const out = await rig.run(rom, scenario);
    const parsed = JSON.parse(out) as { ok: boolean; reads: Record<string, string | number> };
    expect(parsed.ok).toBe(true);
    const steps: DeviceStep[] = [];
    for (let i = 0; i <= TAPE.length; i++) {
      steps.push(
        decodeGrid(parsed.reads[`chars${i}`] as string, parsed.reads[`pals${i}`] as string, t.width, t.height),
      );
    }
    deviceRuns.set(rig.name, { steps, trips: parsed.reads.trips as number });
  }
}, 120000);

describe("oracle == device, three consoles", () => {
  for (const rig of RIGS) {
    test(`${rig.name}: every step of the tape renders identically`, async () => {
      const t = VAPOR_TARGETS[rig.name];
      const oracle = await bootOracle({ width: t.width, height: t.height });
      const { steps } = deviceRuns.get(rig.name)!;
      const compare = (step: number, label: string) => {
        const want = oracle.grid();
        const got = steps[step];
        for (let y = 0; y < t.height; y++) {
          expect(`${label} y=${y}: ${got.chars[y]}`).toBe(`${label} y=${y}: ${want.chars[y]}`);
          expect(`${label} y=${y} pal: ${got.pals[y].join(",")}`).toBe(
            `${label} y=${y} pal: ${want.pals[y].join(",")}`,
          );
        }
      };
      compare(0, `${rig.name} boot`);
      for (let i = 0; i < TAPE.length; i++) {
        await oracle.press(TAPE[i]);
        compare(i + 1, `${rig.name} step ${i} (btn ${TAPE[i]})`);
      }
      oracle.unmount();
    });

    test(`${rig.name}: no runtime tripwires fired`, () => {
      expect(deviceRuns.get(rig.name)!.trips).toBe(0);
    });
  }
});
