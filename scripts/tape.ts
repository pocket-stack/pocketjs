// scripts/tape.ts — headless time-travel CLI (DEVTOOLS.md "the agent story").
// Replays an input tape deterministically against a demo bundle and answers
// debugging questions from the terminal: per-frame framebuffer hashes,
// first-divergent-frame regression checks, PNG renders of any frame, and
// the component tree as JSON at any frame — no screen, no hands needed.
//
//   bun scripts/tape.ts record <app> --frames N [--input "f:mask,..."] --out t.json
//   bun scripts/tape.ts replay <app> <tape.json> [--hashes out.json]
//   bun scripts/tape.ts replay <app> <tape.json> --assert hashes.json
//   bun scripts/tape.ts replay <app> <tape.json> --png 10,120 [--outdir dist/tape]
//   bun scripts/tape.ts tree   <app> <tape.json> --at N
//
// A tape asserted against stored hashes is a SESSION GOLDEN: a real
// interaction sequence replayed byte-for-byte against every future build
// (same determinism contract as test/golden.ts — fixed dt, no RNG/wall
// clock). `--assert` exits 1 and names the first divergent frame.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createWasmUi } from "../host-web/wasm-ops.js";
import { expandTape, expandTapeAnalog, type Tape } from "../src/devtools.ts";
import { encodePNG } from "../test/png.ts";
import { SCREEN_H, SCREEN_W } from "../spec/spec.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = ROOT + "dist/";
const WASM_PATH = ROOT + "host-web/pocketjs.wasm";

function ensureBuilt(path: string, cmd: string[]): void {
  if (existsSync(path)) return;
  console.log(`tape: ${path.slice(ROOT.length)} missing — running: ${cmd.join(" ")}`);
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0 || !existsSync(path)) {
    console.error(`tape: failed to produce ${path}`);
    process.exit(1);
  }
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** FNV-1a 32-bit over the RGBA framebuffer — cheap, deterministic, hex. */
function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

interface BootResult {
  frame: (buttons: number, lx?: number, ly?: number) => void;
  tick: () => void;
  render: () => Uint8Array;
  outbox: string[];
  pushCommand: (line: string) => void;
}

/** Boot a fresh core + bundle exactly like test/golden.ts, plus an
 *  in-process DevTools transport — this CLI is just a DevTools client. */
async function boot(app: string): Promise<BootResult> {
  ensureBuilt(WASM_PATH, ["bun", "scripts/wasm.ts"]);
  ensureBuilt(DIST + app + ".js", ["bun", "scripts/build.ts", app]);
  const wasm = await createWasmUi(await Bun.file(WASM_PATH).arrayBuffer());
  const g = globalThis as Record<string, unknown>;
  const inbox: string[] = [];
  const outbox: string[] = [];
  g.ui = wasm.ops;
  g.__pak = existsSync(DIST + app + ".pak")
    ? await Bun.file(DIST + app + ".pak").arrayBuffer()
    : undefined;
  g.frame = undefined;
  g.__pocketApp = app;
  g.__pocketDevtoolsTransport = {
    send: (line: string) => outbox.push(line),
    recv: () => (inbox.length ? inbox.shift() : null),
  };
  const src = await Bun.file(DIST + app + ".js").text();
  (0, eval)(src);
  const frame = g.frame as ((buttons: number, lx?: number, ly?: number) => void) | undefined;
  if (typeof frame !== "function") {
    throw new Error("bundle did not install globalThis.frame (does the entry call render()?)");
  }
  return {
    frame,
    tick: wasm.tick,
    render: () => wasm.render(),
    outbox,
    pushCommand: (line: string) => inbox.push(line),
  };
}

function loadTape(path: string): Tape {
  if (!existsSync(path)) {
    console.error(`tape: ${path} not found`);
    process.exit(1);
  }
  const tape = JSON.parse(readFileSync(path, "utf8")) as Tape;
  if (!Array.isArray(tape.masks)) {
    console.error(`tape: ${path} is not a tape (expected {v:2, masks:[[mask,count],…], lx?, ly?})`);
    process.exit(1);
  }
  if ((tape.startFrame ?? 0) > 0) {
    console.warn(
      `tape: WARNING — startFrame=${tape.startFrame}: the recorder ring wrapped, ` +
        "so this tape does not start at boot; replay is an approximation",
    );
  }
  return tape;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

const [, , cmd, app, tapePathArg] = process.argv;

async function cmdReplay(): Promise<void> {
  const tape = loadTape(tapePathArg);
  const masks = expandTape(tape);
  const lx = expandTapeAnalog(tape, "lx");
  const ly = expandTapeAnalog(tape, "ly");
  const hashesOut = argValue("--hashes");
  const assertPath = argValue("--assert");
  const pngFrames = new Set(
    (argValue("--png") ?? "").split(",").filter(Boolean).map((s) => Number(s)),
  );
  const outdir = argValue("--outdir") ?? DIST + "tape";
  const expected: string[] | null = assertPath
    ? (JSON.parse(readFileSync(assertPath, "utf8")) as { hashes: string[] }).hashes
    : null;

  const b = await boot(app);
  if (pngFrames.size) mkdirSync(outdir, { recursive: true });
  const hashes: string[] = [];
  for (let f = 0; f < masks.length; f++) {
    b.frame(masks[f], lx[f], ly[f]);
    b.tick();
    const fb = b.render();
    const h = fnv1a(fb);
    hashes.push(h);
    if (expected && expected[f] !== undefined && expected[f] !== h) {
      console.error(`tape: FIRST DIVERGENT FRAME ${f} — expected ${expected[f]}, got ${h}`);
      writeFileSync(`${outdir}/divergent.${f}.png`, encodePNG(fb.slice(), SCREEN_W, SCREEN_H));
      console.error(`tape: wrote ${outdir}/divergent.${f}.png`);
      process.exit(1);
    }
    if (pngFrames.has(f)) {
      writeFileSync(`${outdir}/${app}.${f}.png`, encodePNG(fb.slice(), SCREEN_W, SCREEN_H));
      console.log(`tape: wrote ${outdir}/${app}.${f}.png`);
    }
  }
  if (expected) {
    if (expected.length !== hashes.length) {
      console.error(`tape: frame count changed — expected ${expected.length}, replayed ${hashes.length}`);
      process.exit(1);
    }
    console.log(`tape: OK — ${hashes.length} frames match ${assertPath}`);
    return;
  }
  if (hashesOut) {
    writeFileSync(hashesOut, JSON.stringify({ app, frames: hashes.length, hashes }, null, 0) + "\n");
    console.log(`tape: wrote ${hashes.length} frame hashes to ${hashesOut}`);
  } else {
    console.log(`tape: replayed ${hashes.length} frames — final frame hash ${hashes[hashes.length - 1]}`);
  }
}

async function cmdTree(): Promise<void> {
  const tape = loadTape(tapePathArg);
  const masks = expandTape(tape);
  const lx = expandTapeAnalog(tape, "lx");
  const ly = expandTapeAnalog(tape, "ly");
  const at = Number(argValue("--at") ?? masks.length);
  const upTo = Math.min(at, masks.length);
  const b = await boot(app);
  for (let f = 0; f < upTo; f++) {
    b.frame(masks[f], lx[f], ly[f]);
    b.tick();
  }
  b.outbox.length = 0;
  b.pushCommand(JSON.stringify({ t: "getTree" }));
  b.frame(0, 128, 128); // poll runs at wrapper start: tree reflects state after frame `at`
  for (const line of b.outbox) {
    const msg = JSON.parse(line);
    if (msg.t === "tree") {
      console.log(JSON.stringify(msg.root, null, 2));
      return;
    }
  }
  console.error("tape: no tree response (bundle built before DevTools?)");
  process.exit(1);
}

async function cmdRecord(): Promise<void> {
  const frames = Number(argValue("--frames") ?? 300);
  const out = argValue("--out") ?? `${app}.tape.json`;
  // Input script: "frame:mask" or "frame:mask:lx:ly" (OpenStrike-compatible).
  // Each entry sets THAT frame's input; unscripted frames are idle (mask=0,
  // lx=128, ly=128). lx/ly are deadzone-snapped u8 (0..255, 128 = neutral).
  interface ScriptEntry { m: number; lx: number; ly: number }
  const script = new Map<number, ScriptEntry>();
  for (const entry of (argValue("--input") ?? "").split(",").filter(Boolean)) {
    const parts = entry.split(":");
    const f = Number(parts[0]);
    const m = Number(parts[1] ?? 0);
    const lx = parts[2] !== undefined ? Number(parts[2]) : 128;
    const ly = parts[3] !== undefined ? Number(parts[3]) : 128;
    script.set(f, { m, lx, ly });
  }
  const masks: [number, number][] = [];
  const lxRle: [number, number][] = [];
  const lyRle: [number, number][] = [];
  for (let f = 0; f < frames; f++) {
    const e = script.get(f) ?? { m: 0, lx: 128, ly: 128 };
    const lm = masks[masks.length - 1];
    if (lm && lm[0] === e.m) lm[1]++;
    else masks.push([e.m, 1]);
    const llx = lxRle[lxRle.length - 1];
    if (llx && llx[0] === e.lx) llx[1]++;
    else lxRle.push([e.lx, 1]);
    const lly = lyRle[lyRle.length - 1];
    if (lly && lly[0] === e.ly) lly[1]++;
    else lyRle.push([e.ly, 1]);
  }
  const tape: Tape = { v: 2, app, frames, masks, lx: lxRle, ly: lyRle, startFrame: 0 };
  writeFileSync(out, JSON.stringify(tape) + "\n");
  console.log(`tape: wrote ${out} (${frames} frames, v2)`);
}

if (cmd === "replay" && app && tapePathArg) await cmdReplay();
else if (cmd === "tree" && app && tapePathArg) await cmdTree();
else if (cmd === "record" && app) await cmdRecord();
else {
  console.log(
    "usage:\n" +
      '  bun scripts/tape.ts record <app> --frames N [--input "f:mask,..."] --out t.json\n' +
      "  bun scripts/tape.ts replay <app> <tape.json> [--hashes out.json | --assert hashes.json | --png f1,f2 [--outdir d]]\n" +
      "  bun scripts/tape.ts tree   <app> <tape.json> --at N",
  );
  process.exit(cmd ? 1 : 0);
}
