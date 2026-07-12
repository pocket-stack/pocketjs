// test/golden.ts — headless byte-exact pixel goldens for the wasm rasterizer.
//
// Loads host-web/pocketjs.wasm under Bun, installs the SAME HostOps binding the
// browser host uses (host-web/wasm-ops.js), evals a dist/<demo>.js bundle with
// globalThis.ui + globalThis.__pak pre-installed (the host contract), drives
// N fixed-dt frames with a scripted input function, captures the RGBA
// framebuffer at chosen frames and byte-compares the encoded PNG against the
// committed test/goldens/<demo>.<frame>.png.
//
//   bun test/golden.ts            # compare (builds wasm/bundle if missing)
//   UPDATE=1 bun test/golden.ts   # (re)write goldens
//
// Determinism: core ticks exactly 1/60 s per frame (frame content is a pure
// function of frame index), the rasterizer is integer/exact-f32 math, and the
// PNG encoder (Bun.deflateSync) is deterministic — so byte equality holds.
// On mismatch a <demo>.<frame>.actual.png is written next to the golden.

import { existsSync, mkdirSync } from "node:fs";
import { createWasmUi } from "../host-web/wasm-ops.js";
import { BTN, SCREEN_H, SCREEN_W } from "../spec/spec.ts";

const ROOT = new URL("..", import.meta.url).pathname; // PocketJS/
const DIST = ROOT + "dist/";
const GOLDEN_DIR = ROOT + "test/goldens/";
const WASM_PATH = ROOT + "host-web/pocketjs.wasm";
const UPDATE = !!process.env.UPDATE;

const W = SCREEN_W;
const H = SCREEN_H;

// ---------------------------------------------------------------------------
// Ensure build artifacts exist (missing only — never silently rebuild stale)
// ---------------------------------------------------------------------------

function ensureBuilt(path: string, cmd: string[]): void {
  if (existsSync(path)) return;
  console.log(`golden: ${path.slice(ROOT.length)} missing — running: ${cmd.join(" ")}`);
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0 || !existsSync(path)) {
    console.error(`golden: failed to produce ${path}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Minimal deterministic PNG encoder — shared with scripts/tape.ts (test/png.ts)
// ---------------------------------------------------------------------------

import { encodePNG as encodePNGShared } from "./png.ts";

function encodePNG(rgba: Uint8Array): Buffer {
  return encodePNGShared(rgba, W, H);
}

/** Distinct packed-pixel count — a golden must never be one flat color. */
function distinctPixels(rgba: Uint8Array): number {
  const seen = new Set<number>();
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, W * H);
  for (let i = 0; i < u32.length; i++) {
    seen.add(u32[i]);
    if (seen.size > 16) break; // enough to prove non-triviality
  }
  return seen.size;
}

// ---------------------------------------------------------------------------
// Demo specs (scripted input per DESIGN.md testing plan)
// ---------------------------------------------------------------------------

interface Spec {
  name: string;
  frames: number;
  /** Frame indices to capture+compare (after frame()+tick()+render()). */
  capture: number[];
  input?: (f: number) => number;
}

const SPECS: Spec[] = [
  {
    // hero: initial layout (f2) includes the SVG-baked spinner beside the
    // headline; f10 is mid focus transition after DOWN at f5; then five
    // CIRCLE presses (edge-detected pulses) settle by f80.
    name: "hero-main",
    frames: 90,
    capture: [2, 10, 80],
    input: (f) =>
      f === 5
        ? BTN.DOWN
        : f >= 20 && f <= 36 && (f - 20) % 4 === 0
          ? BTN.CIRCLE
          : 0,
  },
  {
    // cards: f2 = early layout (cards mid mount-fade, nothing focused);
    // RIGHT at f4 focuses card 0, RIGHT at f8 moves to card 1 — f12 is
    // mid focus-transition (card 0 settling back down, card 1 lifting);
    // CIRCLE at f18 opens card 1's detail panel; f24 catches the early spring
    // without a gray color fade, and f78 is fully settled.
    name: "cards-main",
    frames: 90,
    capture: [2, 12, 24, 78],
    input: (f) => (f === 4 || f === 8 ? BTN.RIGHT : f === 18 ? BTN.CIRCLE : 0),
  },
  {
    // stats: f2 = early layout (counters near 0, bar fills barely started —
    // staggered frame delays); f20 = mid animation (counters mid ease-out,
    // bars part-grown); RIGHT at f50 switches OVERVIEW -> SYSTEMS — f85 is
    // settled on the second tab (counters capped at f75, rows revealed).
    name: "stats-main",
    frames: 95,
    capture: [2, 20, 85],
    input: (f) => (f === 50 ? BTN.RIGHT : 0),
  },
  {
    // library: f2 = grid at rest, nothing focused; RIGHT@4 focuses tile 0,
    // RIGHT@8 moves to tile 1 (IRON VANGUARD) — CIRCLE@20 opens it: loading
    // screen mounts and its SVG-baked spinner cycles frames. The loading screen auto-advances
    // after LOADING_FRAMES=48 (screen -> "detail" at f68); f105 is the detail
    // panel's translateY spring fully settled. TRIANGLE@120 (well inside the
    // detail screen's active window) returns to the grid — f150 shows tile 1
    // re-focused via focusNode() (not d-pad traversal), settled.
    name: "library-main",
    frames: 170,
    capture: [2, 30, 105, 150],
    input: (f) =>
      f === 4 || f === 8 ? BTN.RIGHT : f === 20 ? BTN.CIRCLE : f === 120 ? BTN.TRIANGLE : 0,
  },
  {
    // settings: f2 = initial layout (SFX on, VIBRATION off, brightness 3/5,
    // THEME indigo, nothing focused). DOWN@4 focuses SFX, CIRCLE@10 toggles it
    // off (knob springs left); DOWN@16 focuses VIBRATION, CIRCLE@22 toggles it
    // on (knob springs right) — f26 is that mid-interaction moment. DOWN@28
    // focuses BRIGHTNESS, CIRCLE@34 cycles 3->4 (fill spring-widens); three
    // more DOWNs (40/44/48) walk the theme swatches to AMBER, CIRCLE@54
    // selects it (header title recolors indigo -> amber) — f90 is fully
    // settled: every control mid-demonstration at once.
    name: "settings-main",
    frames: 100,
    capture: [2, 26, 90],
    input: (f) =>
      f === 4
        ? BTN.DOWN
        : f === 10
          ? BTN.CIRCLE
          : f === 16
            ? BTN.DOWN
            : f === 22
              ? BTN.CIRCLE
              : f === 28
                ? BTN.DOWN
                : f === 34
                  ? BTN.CIRCLE
                  : f === 40 || f === 44 || f === 48
                    ? BTN.DOWN
                    : f === 54
                      ? BTN.CIRCLE
                      : 0,
  },
  {
    // notifications: f2 = early stagger-in (item 0's 250ms opacity/translateX
    // tween has barely started, items 1-3 still waiting out their 70/140/210ms
    // mount delays). DOWN@10 focuses item 0, DOWN@16 moves to item 1 (FRIEND
    // REQUEST); CIRCLE@24 dismisses it — an imperative 200ms fade+slide fired
    // straight from onPress — f34 is mid-fade (item 1 still in the <For> list,
    // ~half-transparent). The frame driver splices it out at f24+16=40 (focus
    // repairs to the next sibling, BATTERY); f60 is fully settled: 3 items
    // reflowed, "3 UNREAD".
    name: "notifications-main",
    frames: 70,
    capture: [2, 34, 60],
    input: (f) => (f === 10 || f === 16 ? BTN.DOWN : f === 24 ? BTN.CIRCLE : 0),
  },
  {
    // music: f2 = playing from mount (equalizer bars already mid-bounce —
    // they carry no transition class, so no mount-fade; the cover's
    // transition-colors is still mid mount-fade, same as cards.tsx's f2),
    // progress near 0%, track 0 highlighted. DOWN@4 focuses the cover
    // control, CIRCLE@10 pauses (bars drop to a flat 6px line, progress
    // freezes) — f20 shows that paused state, cover fully faded in. DOWN@30/36 walk to track row 1
    // (GLASS HORIZON), CIRCLE@42 selects it — selectTrack() resets position
    // AND resumes playback, so f60 shows track 1 highlighted, progress
    // advancing again, bars bouncing. RTRIGGER@70 skips to track 2 (STATIC
    // BLOOM, position reset) — f90 shows the skip landed, still playing.
    name: "music-main",
    frames: 100,
    capture: [2, 20, 60, 90],
    input: (f) =>
      f === 4
        ? BTN.DOWN
        : f === 10
          ? BTN.CIRCLE
          : f === 30 || f === 36
            ? BTN.DOWN
            : f === 42
              ? BTN.CIRCLE
              : f === 70
                ? BTN.RTRIGGER
                : 0,
  },
  {
    // gallery: full-screen L/R paging over baked bitmap tiles. Page 0
    // (SYNTHWAVE) reveals over 16f; RIGHT@22 moves grid focus tile0->tile1
    // (FocusGrid), CIRCLE@30 selects it (hint bar -> "VIEWING NEON"); f42 is
    // page 0 settled with tile 1 focused + selected. RTRIGGER@50/100/150 page
    // right through GOLDEN HOUR -> EVERGREEN -> NEBULA (settled at f82/132/178,
    // past the 18-frame slide; in-window neighbours are prefetched so no
    // spinner). LTRIGGER@190 pages back to EVERGREEN — f200 is MID-slide and
    // must show tiles, not a spinner (guards the reveal-latch: a replay
    // regression would render the loading spinner here); f226 settled.
    name: "gallery-main",
    frames: 236,
    capture: [42, 82, 132, 178, 200, 226],
    input: (f) =>
      f === 22
        ? BTN.RIGHT
        : f === 30
          ? BTN.CIRCLE
          : f === 50 || f === 100 || f === 150
            ? BTN.RTRIGGER
            : f === 190
              ? BTN.LTRIGGER
              : 0,
  },
];

SPECS.push({
  // chrome: bevel border rings (Win98 window mock, demos/chrome). f2 = initial
  // layout: double-ring raised window frame + buttons, double-ring sunken text
  // well, thin single-ring status cells, navy 2-stop caption gradient — every
  // bevel form in one frame. DOWN@4 focuses OK, RIGHT@8 moves to CANCEL — f12
  // shows the focus: face tint with the bevel rings unchanged. CIRCLE held
  // f16..22 — f18 shows the active: bevel INVERSION (pressed-in CANCEL); f26
  // is released and back to raised.
  name: "chrome-main",
  frames: 30,
  capture: [2, 12, 18, 26],
  input: (f) =>
    f === 4 ? BTN.DOWN : f === 8 ? BTN.RIGHT : f >= 16 && f <= 22 ? BTN.CIRCLE : 0,
});

SPECS.push({
  // im (Pocket Talk): bootstrap lands at f30 — f40 is the conversation list
  // (presence dots, unread badges, ellipsized previews, recency sort).
  // CIRCLE@60 opens MAYA CHEN — f80 is the thread bottom (wrapped bubbles,
  // lime read ticks). UP held 90..150 scrolls the virtual window up — f160
  // shows mid-history with a day chip. SELECT@170 jumps back to latest,
  // TRIANGLE@200 opens the on-screen keyboard, DOWN@230 walks focus to 'q',
  // CIRCLE@260 types it — f280 is the OSK with a live draft + counter.
  // START@300 sends; by f370 the ack and the delivery receipt have landed
  // (gray ✓✓ on the "q" bubble, MAYA about to type).
  name: "im-main",
  frames: 380,
  capture: [40, 80, 160, 280, 370],
  input: (f) =>
    f === 60
      ? BTN.CIRCLE
      : f >= 90 && f < 150
        ? BTN.UP
        : f === 170
          ? BTN.SELECT
          : f === 200
            ? BTN.TRIANGLE
            : f === 230
              ? BTN.DOWN
              : f === 260
                ? BTN.CIRCLE
                : f === 300
                  ? BTN.START
                  : 0,
});

SPECS.push({
  // motions: baked keyframe timelines (yui540 studies). Scene 0 (APP LAUNCH)
  // plays a 3-entry choreography with a 156-frame loop: f8 = press pulse
  // (backwards-fill start states), f60 = expanded full-stage hold, f120 =
  // returned card (forwards fill), f170 = second loop iteration mid-expand
  // (the style-level loop wraps every node's animation clock). RIGHT@200
  // remounts onto scene 1 (LAYOUT SWAP) — f236 is its split-pane phase.
  name: "motions-main",
  frames: 240,
  capture: [8, 60, 120, 170, 236],
  input: (f) => (f === 200 ? BTN.RIGHT : 0),
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

ensureBuilt(WASM_PATH, ["bun", "scripts/wasm.ts"]);
for (const spec of SPECS) {
  ensureBuilt(DIST + spec.name + ".js", ["bun", "scripts/build.ts", spec.name]);
}
mkdirSync(GOLDEN_DIR, { recursive: true });

const wasmBytes = await Bun.file(WASM_PATH).arrayBuffer();

async function runDemo(spec: Spec): Promise<Map<number, Uint8Array>> {
  // A fresh wasm instance per demo: fresh core, zero cross-demo state.
  const wasm = await createWasmUi(wasmBytes);
  const g = globalThis as Record<string, unknown>;
  g.ui = wasm.ops; // the host contract: HostOps BEFORE eval
  g.__pak = existsSync(DIST + spec.name + ".pak")
    ? await Bun.file(DIST + spec.name + ".pak").arrayBuffer()
    : undefined;
  g.frame = undefined;
  try {
    const src = await Bun.file(DIST + spec.name + ".js").text();
    (0, eval)(src); // IIFE mounts the app and installs globalThis.frame
    const frame = g.frame as ((buttons: number) => void) | undefined;
    if (typeof frame !== "function") {
      throw new Error("bundle did not install globalThis.frame (does the entry call render()?)");
    }
    const captures = new Map<number, Uint8Array>();
    const want = new Set(spec.capture);
    for (let f = 0; f < spec.frames; f++) {
      frame(spec.input ? spec.input(f) : 0); // input + effects + sweep
      wasm.tick(); // anims + layout, exactly 1/60 s
      if (want.has(f)) captures.set(f, wasm.render().slice());
    }
    return captures;
  } finally {
    delete g.ui;
    delete g.__pak;
    g.frame = undefined;
  }
}

let pass = 0;
let fail = 0;
for (const spec of SPECS) {
  let captures: Map<number, Uint8Array>;
  try {
    captures = await runDemo(spec);
  } catch (e) {
    console.log("FAIL ", spec.name, "- threw:", (e as Error)?.stack ?? e);
    fail++;
    continue;
  }
  for (const f of spec.capture) {
    const label = `${spec.name}.${f}`;
    const buf = captures.get(f)!;
    const distinct = distinctPixels(buf);
    if (distinct < 3) {
      console.log("FAIL ", label, `- degenerate frame (${distinct} distinct pixel value(s))`);
      await Bun.write(GOLDEN_DIR + label + ".actual.png", encodePNG(buf));
      fail++;
      continue;
    }
    const png = encodePNG(buf);
    const goldPath = GOLDEN_DIR + label + ".png";
    if (UPDATE || !existsSync(goldPath)) {
      await Bun.write(goldPath, png);
      console.log(UPDATE ? "WROTE" : "NEW  ", label);
      pass++;
    } else {
      const gold = new Uint8Array(await Bun.file(goldPath).arrayBuffer());
      let diff = png.length !== gold.length ? 1 : 0;
      for (let i = 0; i < png.length && diff === 0; i++) {
        if (png[i] !== gold[i]) diff = 1;
      }
      if (diff === 0) {
        console.log("PASS ", label);
        pass++;
      } else {
        await Bun.write(GOLDEN_DIR + label + ".actual.png", png);
        console.log("FAIL ", label, "- PNG bytes differ (see " + label + ".actual.png)");
        fail++;
      }
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
