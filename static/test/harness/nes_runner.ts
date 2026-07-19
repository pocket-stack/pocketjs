#!/usr/bin/env bun
// static/test/harness/nes_runner.ts — headless NES scenario driver on jsnes.
//
//   bun nes_runner.ts <rom.nes> <scenario.txt>
//
// Same line protocol as mgba_runner, with one deliberate difference: A/P
// counts are ENGINE TICKS, not video frames. cc65 code can take more than a
// video frame per rpg_tick, so the runner paces on the debug block's FRAME
// counter — scenarios stay tick-accurate at any emulation speed.

import { Controller, NES } from "jsnes";
import { DBG, KEYS, TARGETS } from "../../spec/isa.ts";

const [rom, scenarioPath] = process.argv.slice(2);
if (!rom || !scenarioPath) {
  console.log(JSON.stringify({ ok: false, error: "usage: nes_runner <rom> <scenario>" }));
  process.exit(2);
}

let frameBuffer: number[] | null = null;
const nes = new NES({
  onFrame: (buf: number[]) => {
    frameBuffer = buf;
  },
  onAudioSample: () => {},
});

const bytes = new Uint8Array(await Bun.file(rom).arrayBuffer());
nes.loadROM(Buffer.from(bytes).toString("latin1"));

const DEBUG = TARGETS.nes.debugAddr;
const mem = (addr: number): number => nes.cpu.mem[addr] & 0xff;
const tickCount = (): number =>
  mem(DEBUG + DBG.FRAME) |
  (mem(DEBUG + DBG.FRAME + 1) << 8) |
  (mem(DEBUG + DBG.FRAME + 2) << 16) |
  (mem(DEBUG + DBG.FRAME + 3) << 24);

function advanceTicks(n: number): void {
  const target = tickCount() + n;
  let guard = n * 12 + 1200; // cc65 headroom: a tick may span several frames
  while (tickCount() < target && guard-- > 0) nes.frame();
  if (guard <= 0) throw new Error(`tick advance stalled (wanted ${n} ticks)`);
}

const BUTTONS: [number, number][] = [
  [KEYS.A, Controller.BUTTON_A],
  [KEYS.B, Controller.BUTTON_B],
  [KEYS.SELECT, Controller.BUTTON_SELECT],
  [KEYS.START, Controller.BUTTON_START],
  [KEYS.UP, Controller.BUTTON_UP],
  [KEYS.DOWN, Controller.BUTTON_DOWN],
  [KEYS.LEFT, Controller.BUTTON_LEFT],
  [KEYS.RIGHT, Controller.BUTTON_RIGHT],
];

async function screenshot(path: string): Promise<void> {
  if (!frameBuffer) return;
  const w = 256;
  const h = 240;
  const out = new Uint8Array(15 + w * h * 3);
  const header = `P6\n${w} ${h}\n255\n`;
  out.set(new TextEncoder().encode(header), 0);
  let at = header.length;
  for (let i = 0; i < w * h; i++) {
    const p = frameBuffer[i];
    out[at++] = p & 0xff;
    out[at++] = (p >> 8) & 0xff;
    out[at++] = (p >> 16) & 0xff;
  }
  await Bun.write(path, out.subarray(0, at));
}

const reads: Record<string, number> = {};
const lines = (await Bun.file(scenarioPath).text()).split("\n");
try {
  for (const line of lines) {
    const op = line[0];
    if (op === "A") {
      advanceTicks(Number(line.slice(1).trim()));
    } else if (op === "P") {
      const [maskHex, hold, release] = line.slice(1).trim().split(/\s+/);
      const mask = parseInt(maskHex, 16);
      for (const [k, btn] of BUTTONS) if (mask & k) nes.buttonDown(1, btn);
      advanceTicks(Number(hold));
      for (const [k, btn] of BUTTONS) if (mask & k) nes.buttonUp(1, btn);
      advanceTicks(Number(release));
    } else if (op === "R") {
      const [name, addrHex, size] = line.slice(1).trim().split(/\s+/);
      const addr = parseInt(addrHex, 16);
      let v = mem(addr);
      if (Number(size) >= 2) v |= mem(addr + 1) << 8;
      if (Number(size) === 4) v = (v | (mem(addr + 2) << 16) | (mem(addr + 3) << 24)) >>> 0;
      reads[name] = v;
    } else if (op === "S") {
      await screenshot(line.slice(1).trim());
    }
  }
  console.log(JSON.stringify({ ok: true, reads }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e), reads }));
  process.exit(1);
}
