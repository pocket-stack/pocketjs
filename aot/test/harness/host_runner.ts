#!/usr/bin/env bun
// aot/test/harness/host_runner.ts — headless runner for the pj_frame-core
// targets (3ds, nds), speaking the same scenario JSON protocol as
// mgba_runner / nes_runner:
//
//   bun host_runner.ts <game.3dsx|game.nds> <scenario.json>
//
// Neither console has a scriptable emulator wired in, so this drives the
// runtime's HOST build: the target backend compiles the identical core (game
// logic, VM, software renderer, debug block) into <game>.host.dylib next to
// the device binary, and this runner ticks it over Bun FFI. Only the device
// shell (ctru_main.c / render_ds.c + nds_main.c) is outside the loop.
//
// Debug reads translate scenario bus addresses as (addr - debugAddr) into the
// core's exported block. Screenshots stack both screens into one PPM, with
// the top world viewport upscaled 2x exactly as the console presents it.

import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";
import { TARGETS, DEBUG_BLOCK_SIZE, type TargetName } from "../../spec/pjgb.ts";

const [romPath, scenarioPath] = process.argv.slice(2);
if (!romPath || !scenarioPath) {
  console.log(JSON.stringify({ ok: false, error: "usage: host_runner <game.3dsx|game.nds> <scenario.json>" }));
  process.exit(1);
}

type Step =
  | { op: "advance"; frames: number }
  | { op: "press"; buttons: string[]; frames: number; release?: number }
  | { op: "read"; name: string; addr: number; size: 1 | 2 | 4 }
  | { op: "screenshot"; path: string };

// Core key mask (GBA KEYINPUT bit layout, shared by every pj_frame core).
const BTN: Record<string, number> = {
  A: 0x01,
  B: 0x02,
  SELECT: 0x04,
  START: 0x08,
  RIGHT: 0x10,
  LEFT: 0x20,
  UP: 0x40,
  DOWN: 0x80,
};

// Per-target presentation: bottom-screen size is a hardware constant (the
// top viewport comes from TARGETS); everything else is identical.
const BOTTOM: Partial<Record<TargetName, { w: number; h: number }>> = {
  "3ds": { w: 320, h: 240 },
  nds: { w: 256, h: 192 },
};

const target = (Object.keys(TARGETS) as TargetName[]).find((t) => romPath.endsWith(TARGETS[t].ext) && BOTTOM[t]);
if (!target) {
  console.log(JSON.stringify({ ok: false, error: `not a pj_frame-core rom (want .3dsx/.nds): ${romPath}` }));
  process.exit(1);
}
const spec = TARGETS[target];
const TOP_W = spec.screenW;
const TOP_H = spec.screenH;
const { w: BOT_W, h: BOT_H } = BOTTOM[target]!;

const dylibPath = romPath.slice(0, -spec.ext.length) + ".host.dylib";
if (!(await Bun.file(dylibPath).exists())) {
  console.log(JSON.stringify({ ok: false, error: `host dylib not found: ${dylibPath} (build with --target ${target})` }));
  process.exit(1);
}

const lib = dlopen(dylibPath, {
  pj_init: { args: [], returns: FFIType.void },
  pj_frame: { args: [FFIType.u32], returns: FFIType.void },
  pj_top_fb: { args: [], returns: FFIType.ptr },
  pj_bottom_fb: { args: [], returns: FFIType.ptr },
  pj_debug_block: { args: [], returns: FFIType.ptr },
});

lib.symbols.pj_init();
const debugBlock = new Uint8Array(toArrayBuffer(lib.symbols.pj_debug_block()!, 0, DEBUG_BLOCK_SIZE));
const topFb = new Uint16Array(toArrayBuffer(lib.symbols.pj_top_fb()!, 0, TOP_W * TOP_H * 2));
const bottomFb = new Uint16Array(toArrayBuffer(lib.symbols.pj_bottom_fb()!, 0, BOT_W * BOT_H * 2));

const scenario = (await Bun.file(scenarioPath).json()) as { steps: Step[] };
const reads: Record<string, number> = {};

function frames(n: number, keys: number): void {
  for (let i = 0; i < n; i++) lib.symbols.pj_frame(keys >>> 0);
}

function busRead(addr: number, size: number): number {
  const off = addr - spec.debugAddr;
  let v = 0;
  for (let i = 0; i < size; i++) v |= (debugBlock[off + i] & 0xff) << (8 * i);
  return v >>> 0;
}

// BGR555 -> [r, g, b] bytes.
function rgb(v: number): [number, number, number] {
  const e = (c: number): number => (c << 3) | (c >> 2);
  return [e(v & 0x1f), e((v >> 5) & 0x1f), e((v >> 10) & 0x1f)];
}

async function screenshot(path: string): Promise<void> {
  const top2W = TOP_W * 2; // world viewport presented at 2x
  const W = Math.max(top2W, BOT_W);
  const H = TOP_H * 2 + BOT_H;
  const head = `P6\n${W} ${H}\n255\n`;
  const out = new Uint8Array(head.length + W * H * 3);
  for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i);
  const put = (x: number, y: number, c: [number, number, number]): void => {
    const o = head.length + (y * W + x) * 3;
    out[o] = c[0];
    out[o + 1] = c[1];
    out[o + 2] = c[2];
  };
  const topX = (W - top2W) / 2;
  for (let y = 0; y < TOP_H; y++)
    for (let x = 0; x < TOP_W; x++) {
      const c = rgb(topFb[y * TOP_W + x]);
      put(topX + x * 2, y * 2, c);
      put(topX + x * 2 + 1, y * 2, c);
      put(topX + x * 2, y * 2 + 1, c);
      put(topX + x * 2 + 1, y * 2 + 1, c);
    }
  const botX = (W - BOT_W) / 2;
  for (let y = 0; y < BOT_H; y++)
    for (let x = 0; x < BOT_W; x++) put(botX + x, TOP_H * 2 + y, rgb(bottomFb[y * BOT_W + x]));
  await Bun.write(path, out);
}

for (const step of scenario.steps) {
  if (step.op === "advance") {
    frames(step.frames, 0);
  } else if (step.op === "press") {
    let mask = 0;
    for (const b of step.buttons) mask |= BTN[b] ?? 0;
    frames(step.frames, mask);
    frames(step.release ?? 0, 0);
  } else if (step.op === "read") {
    reads[step.name] = busRead(step.addr, step.size);
  } else if (step.op === "screenshot") {
    await screenshot(step.path);
  }
}

console.log(JSON.stringify({ reads, ok: true }));
