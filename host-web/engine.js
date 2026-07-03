// host-web/engine.js — the browser dev host for psp-ui.
//
// Loads psp-ui.wasm (core + software rasterizer), installs the HostOps
// binding (wasm-ops.js — shared with test/golden.ts) as globalThis.ui,
// installs the demo's .dcpak as globalThis.__dcpak, evals the demo bundle
// (which mounts the app and installs globalThis.frame), then drives a
// fixed-timestep 60 Hz loop: frame(buttons) -> ui_tick -> ui_render ->
// putImageData onto a 480x272 canvas (CSS-scaled, pixelated).
//
// Loop shape (dt clamp 250 ms, max 4 catch-up steps) is copied from the
// proven dreamcart web/engine.js driver.
//
// Keyboard map (also listed on the page):
//   arrows = d-pad     Enter / Z = CIRCLE  X = CROSS
//   A = SQUARE         S = TRIANGLE        Shift = SELECT   Space = START

import { createWasmUi, FB_W, FB_H } from "./wasm-ops.js";

// spec/spec.ts BTN (plain module — keep the literal in sync with the spec).
export const BTN = {
  SELECT: 0x0001,
  START: 0x0008,
  UP: 0x0010,
  RIGHT: 0x0020,
  DOWN: 0x0040,
  LEFT: 0x0080,
  TRIANGLE: 0x1000,
  CIRCLE: 0x2000,
  CROSS: 0x4000,
  SQUARE: 0x8000,
};

const KEYMAP = {
  ArrowUp: BTN.UP,
  ArrowRight: BTN.RIGHT,
  ArrowDown: BTN.DOWN,
  ArrowLeft: BTN.LEFT,
  KeyX: BTN.CROSS,
  Enter: BTN.CIRCLE,
  KeyZ: BTN.CIRCLE,
  KeyA: BTN.SQUARE,
  KeyS: BTN.TRIANGLE,
  ShiftLeft: BTN.SELECT,
  ShiftRight: BTN.SELECT,
  Space: BTN.START,
};

let wasm = null; // createWasmUi result
let canvas = null;
let ctx = null;
let imageData = null;
let held = 0;
let rafId = 0;
let acc = 0;
let last = 0;
let frameCb = null;
let logSink = () => {};
let fpsSink = () => {};
let statsFrames = 0;
let statsT = 0;

function safeFrame() {
  if (!frameCb) return;
  try {
    frameCb(held); // JS: input edge-detect, effects, sweep
    wasm.tick(); // core: anims + layout, exactly 1/60 s
  } catch (e) {
    logSink("FRAME ERROR: " + (e && e.stack ? e.stack : e));
    frameCb = null; // stop repeating the same throw 60x/s
  }
}

function blit() {
  if (!wasm || !ctx) return;
  imageData.data.set(wasm.render());
  ctx.putImageData(imageData, 0, 0);
}

function tick(now) {
  rafId = requestAnimationFrame(tick);
  let dt = now - last;
  last = now;
  if (dt > 250) dt = 250; // avoid the catch-up spiral after tab hide
  acc += dt;
  const STEP = 1000 / 60;
  let steps = 0;
  while (acc >= STEP && steps < 4) {
    safeFrame();
    acc -= STEP;
    steps++;
    statsFrames++;
  }
  if (steps > 0) blit();
  statsT += dt;
  if (statsT >= 1000) {
    fpsSink(Math.round((statsFrames * 1000) / statsT));
    statsFrames = 0;
    statsT = 0;
  }
}

function start() {
  if (rafId) return;
  last = performance.now();
  acc = 0;
  rafId = requestAnimationFrame(tick);
}

function stop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

// ---- input -------------------------------------------------------------------

function onKey(down) {
  return (e) => {
    const bit = KEYMAP[e.code];
    if (bit === undefined) return;
    e.preventDefault();
    if (down) held |= bit;
    else held &= ~bit;
  };
}

/** Virtual on-screen buttons ([data-btn] elements). */
export function pressVirtual(bit, down) {
  if (down) held |= bit;
  else held &= ~bit;
}

// ---- lifecycle ------------------------------------------------------------------

/** Bind the host to a canvas + fetch/instantiate the wasm. Call once. */
export async function mount(theCanvas, opts = {}) {
  if (opts.onLog) logSink = opts.onLog;
  if (opts.onFps) fpsSink = opts.onFps;
  canvas = theCanvas;
  canvas.width = FB_W;
  canvas.height = FB_H;
  ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  imageData = ctx.createImageData(FB_W, FB_H);
  window.addEventListener("keydown", onKey(true));
  window.addEventListener("keyup", onKey(false));
  window.addEventListener("blur", () => {
    held = 0;
  });
  const res = await fetch("psp-ui.wasm");
  if (!res.ok) throw new Error("psp-ui.wasm not found — run: bun scripts/wasm.ts");
  wasm = await createWasmUi(await res.arrayBuffer());
  logSink("psp-ui wasm ready");
}

/**
 * Load (or reload) a demo: fresh core, __dcpak + globalThis.ui BEFORE eval,
 * fresh function scope per reload, then start the loop. Returns null on
 * success, the error otherwise.
 */
export async function load(name) {
  if (!wasm) throw new Error("mount() first");
  stop();
  frameCb = null;
  wasm.init(); // fresh Ui: tree/styles/atlases/textures all reset
  // Host contract (see demos/hero/main.tsx): both globals BEFORE eval, reset
  // EVERY load so nothing stale leaks across reloads.
  globalThis.ui = wasm.ops;
  globalThis.frame = undefined;
  try {
    const pak = await fetch("dist/" + name + ".dcpak");
    globalThis.__dcpak = pak.ok ? await pak.arrayBuffer() : undefined;
    const srcRes = await fetch("dist/" + name + ".js");
    if (!srcRes.ok) throw new Error("dist/" + name + ".js not found — run: bun scripts/build.ts " + name);
    const src = await srcRes.text();
    // Fresh function scope per reload (top-level vars must not collide).
    new Function(src + "\n//# sourceURL=" + name + ".js")();
    if (typeof globalThis.frame !== "function") {
      throw new Error(
        "bundle did not install globalThis.frame — the demo entry must call render() " +
          "(use the <demo>/main.tsx mounting entry, not the bare component module)",
      );
    }
    frameCb = globalThis.frame;
  } catch (e) {
    logSink("LOAD ERROR: " + (e && e.stack ? e.stack : e));
    blit(); // show whatever state the core is in
    return e;
  }
  logSink("loaded " + name);
  safeFrame(); // one immediate frame so the canvas isn't blank
  blit();
  start();
  return null;
}

/** The demo manifest from the dev server (serve.ts /demos endpoint). */
export async function listDemos() {
  const res = await fetch("demos");
  if (!res.ok) return [];
  return await res.json();
}
