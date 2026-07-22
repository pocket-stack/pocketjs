#!/usr/bin/env bun
// vapor/test/harness/nes_runner.ts — headless NES scenario driver on jsnes.
//
//   bun vapor/test/harness/nes_runner.ts <rom.nes> <scenario.txt>
//
// Same line protocol as mgba_runner (A/P/R/D/S), with one deliberate
// difference carried over from Pocket Static: A/P counts are ENGINE TICKS,
// not video frames — cc65 code can take several video frames per main-loop
// iteration, so the runner paces on the debug block's frame counter at
// $0204. Press masks use the shared GBA bit order and are translated to
// jsnes buttons here.

import { Controller, NES } from "jsnes";

const [rom, scenarioPath] = process.argv.slice(2);
if (!rom || !scenarioPath) {
  console.log(JSON.stringify({ ok: false, error: "usage: nes_runner <rom> <scenario>" }));
  process.exit(2);
}

let frameBuffer: ArrayLike<number> | null = null;
const nes = new NES({
  onFrame: (buf: ArrayLike<number>) => {
    frameBuffer = buf;
  },
  onAudioSample: () => {},
});

const bytes = new Uint8Array(await Bun.file(rom).arrayBuffer());
nes.loadROM(Buffer.from(bytes).toString("latin1"));

const DBG_FRAME = 0x0204;
const cpu = (nes as unknown as { cpu: { mem: number[] } }).cpu;
const mem = (addr: number): number => cpu.mem[addr] & 0xff;
const tickCount = (): number =>
  mem(DBG_FRAME) | (mem(DBG_FRAME + 1) << 8) | (mem(DBG_FRAME + 2) << 16) | (mem(DBG_FRAME + 3) << 24);

function advanceTicks(n: number): void {
  const target = tickCount() + n;
  let guard = n * 30 + 3000; // cc65 headroom: a tick may span several frames
  while (tickCount() < target && guard-- > 0) nes.frame();
  if (guard <= 0) throw new Error(`tick advance stalled (wanted ${n} ticks)`);
}

// shared GBA-order mask bit -> jsnes button
type ButtonKey = Parameters<NES["buttonDown"]>[1];
const BUTTONS: [number, ButtonKey][] = [
  [1 << 0, Controller.BUTTON_A],
  [1 << 1, Controller.BUTTON_B],
  [1 << 2, Controller.BUTTON_SELECT],
  [1 << 3, Controller.BUTTON_START],
  [1 << 4, Controller.BUTTON_RIGHT],
  [1 << 5, Controller.BUTTON_LEFT],
  [1 << 6, Controller.BUTTON_UP],
  [1 << 7, Controller.BUTTON_DOWN],
];

async function screenshot(path: string): Promise<void> {
  if (!frameBuffer) return;
  const w = 256;
  const h = 240;
  const header = `P6\n${w} ${h}\n255\n`;
  const out = new Uint8Array(header.length + w * h * 3);
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

const reads: Record<string, number | string> = {};
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
    } else if (op === "D") {
      const [name, addrHex, len] = line.slice(1).trim().split(/\s+/);
      const addr = parseInt(addrHex, 16);
      let hex = "";
      for (let i = 0; i < Number(len); i++) hex += mem(addr + i).toString(16).padStart(2, "0");
      reads[name] = hex;
    } else if (op === "S") {
      await screenshot(line.slice(1).trim());
    }
  }
  console.log(JSON.stringify({ ok: true, reads }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e), reads }));
  process.exit(1);
}
