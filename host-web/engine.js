// host-web/engine.js — the browser dev host for PocketJS.
//
// Loads pocketjs.wasm (core + software rasterizer), installs the HostOps
// binding (wasm-ops.js — shared with test/golden.ts) as globalThis.ui,
// installs the demo's .pak as globalThis.__pak, evals the demo bundle
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
import { drawHud, wasmMemoryBytes } from "./hud.js";

// spec/spec.ts BTN (plain module — keep the literal in sync with the spec).
export const BTN = {
  SELECT: 0x0001,
  START: 0x0008,
  UP: 0x0010,
  RIGHT: 0x0020,
  DOWN: 0x0040,
  LEFT: 0x0080,
  LTRIGGER: 0x0100,
  RTRIGGER: 0x0200,
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
  // Shoulder triggers: the literal L / R keys the shoulders are named after,
  // plus Q / E as an ergonomic left-hand alternate.
  KeyL: BTN.LTRIGGER,
  KeyR: BTN.RTRIGGER,
  KeyQ: BTN.LTRIGGER,
  KeyE: BTN.RTRIGGER,
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
// Virtual clock policy (DETERMINISM.md): virtual frames per second. One
// frame(buttons) transaction + 60/simHz core ticks per virtual frame, so
// ms-based animations cover the same VIRTUAL time at every rate. ?hz=2
// runs the 2 FPS world a headless agent sees — on a real screen.
const VALID_HZ = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];
let simHz = 60;
let logSink = () => {};
let fpsSink = () => {};
let statsFrames = 0;
let statsT = 0;
let hudFps = 0; // on-canvas HUD, sampled once/second (see hud.js)
let hudMem = 0;
let currentName = null; // demo currently loaded (devtools seek/replay reloads it)

// ---- DevTools device channel (DEVTOOLS.md) ---------------------------------
// This host is a DevTools "device": it connects to the dev server's WS hub
// and injects a transport into the runtime shim (src/devtools.ts) before the
// bundle evals. Host-level messages (seek/replay need a from-boot reload +
// deterministic fast-forward — only the host can do that) are intercepted
// here; everything else is queued for the shim to poll each frame.

let dtWs = null;
let dtInbox = []; // lines waiting for the shim's recv()
let dtOutbox = []; // lines buffered while the WS is (re)connecting
let dtBackoff = 500;

function dtSend(line) {
  if (dtWs && dtWs.readyState === 1) dtWs.send(line);
  else if (dtOutbox.length < 200) dtOutbox.push(line);
}

function connectDevtools() {
  let url;
  try {
    url = new URL("/ws?role=device", location.href);
  } catch {
    return; // not served over http (file://) — no devtools
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  try {
    dtWs = new WebSocket(url);
  } catch {
    return;
  }
  dtWs.onopen = () => {
    dtBackoff = 500;
    while (dtOutbox.length) dtWs.send(dtOutbox.shift());
  };
  dtWs.onmessage = (e) => {
    const line = typeof e.data === "string" ? e.data : "";
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg && msg.t === "seek") return void devtoolsSeek(msg.frame);
    if (msg && msg.t === "replay") return void devtoolsReplay(msg.tape);
    if (msg && msg.t === "screenshot") return void devtoolsScreenshot();
    dtInbox.push(line);
  };
  dtWs.onclose = () => {
    dtWs = null;
    setTimeout(connectDevtools, dtBackoff);
    dtBackoff = Math.min(dtBackoff * 2, 8000);
  };
  dtWs.onerror = () => {};
}

/** On-demand screenshot (host-level: the framebuffer lives here). Renders
 *  the current core output clean — no HUD overlay — and ships a PNG data
 *  URL back to the panel. */
function devtoolsScreenshot() {
  if (!wasm) return;
  const shot = document.createElement("canvas");
  shot.width = FB_W;
  shot.height = FB_H;
  const sctx = shot.getContext("2d");
  const img = sctx.createImageData(FB_W, FB_H);
  img.data.set(wasm.render());
  sctx.putImageData(img, 0, 0);
  const frame = globalThis.__pocketDevtools ? globalThis.__pocketDevtools.frame : 0;
  dtSend(JSON.stringify({ t: "screenshot", frame, data: shot.toDataURL("image/png") }));
}

/** Replay a tape from boot at normal speed: fresh core + bundle, the shim
 *  overrides live input with the tape's masks. */
async function devtoolsReplay(tape) {
  if (!currentName || !tape) return;
  await load(currentName, { tape });
}

/** Time-travel seek: reload from boot and deterministically fast-forward
 *  (tick-only, no render) to `frame` using the current session's own
 *  flight-recorder tape, then freeze the world there. */
async function devtoolsSeek(frame) {
  const shim = globalThis.__pocketDevtools;
  if (!currentName || !shim) return;
  const tape = shim.dumpTape();
  if (tape.startFrame > 0) {
    logSink(`seek: recorder wrapped — earliest reachable frame is ${tape.startFrame}`);
  }
  const target = Math.max(0, Math.min(frame | 0, tape.frames));
  await load(currentName, { tape, pauseAt: target });
}

function safeFrame() {
  if (!frameCb) return;
  try {
    frameCb(held); // JS: one virtual-frame transaction (input, effects, sweep)
    const ticks = 60 / simHz;
    for (let t = 0; t < ticks; t++) wasm.tick(); // core catch-up: 1/60 s each
  } catch (e) {
    logSink("FRAME ERROR: " + (e && e.stack ? e.stack : e));
    frameCb = null; // stop repeating the same throw 60x/s
  }
}

function blit() {
  if (!wasm || !ctx) return;
  imageData.data.set(wasm.render());
  ctx.putImageData(imageData, 0, 0);
  drawHud(ctx, FB_W, FB_H, hudFps, hudMem); // built-in on-canvas overlay
}

function tick(now) {
  rafId = requestAnimationFrame(tick);
  let dt = now - last;
  last = now;
  if (dt > 250) dt = 250; // avoid the catch-up spiral after tab hide
  acc += dt;
  const STEP = 1000 / simHz;
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
    // Sample FPS + memory once per second for the on-canvas HUD.
    hudFps = Math.round((statsFrames * 1000) / statsT);
    hudMem = wasmMemoryBytes(wasm);
    fpsSink(hudFps);
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
  const hzParam = Number(new URLSearchParams(location.search).get("hz"));
  if (VALID_HZ.includes(hzParam)) simHz = hzParam;
  const res = await fetch("pocketjs.wasm");
  if (!res.ok) throw new Error("pocketjs.wasm not found — run: bun scripts/wasm.ts");
  wasm = await createWasmUi(await res.arrayBuffer());
  connectDevtools();
  logSink("PocketJS wasm ready");
}

/**
 * Load (or reload) a demo: fresh core, __pak + globalThis.ui BEFORE eval,
 * fresh function scope per reload, then start the loop. Returns null on
 * success, the error otherwise.
 */
export async function load(name, opts = {}) {
  if (!wasm) throw new Error("mount() first");
  stop();
  frameCb = null;
  wasm.init(); // fresh Ui: tree/styles/atlases/textures all reset
  // Host contract (see demos/hero/main.tsx): both globals BEFORE eval, reset
  // EVERY load so nothing stale leaks across reloads.
  globalThis.ui = wasm.ops;
  globalThis.frame = undefined;
  globalThis.__simHz = simHz; // clock policy — before eval, like __pak
  // DevTools: identity + transport BEFORE eval; render() picks them up.
  globalThis.__pocketApp = name;
  dtInbox = [];
  globalThis.__pocketDevtoolsTransport = {
    send: dtSend,
    recv: () => (dtInbox.length ? dtInbox.shift() : null),
  };
  try {
    const pak = await fetch("dist/" + name + ".pak");
    globalThis.__pak = pak.ok ? await pak.arrayBuffer() : undefined;
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
  currentName = name;
  hudMem = wasmMemoryBytes(wasm); // so MEM shows before the first 1s sample
  if (opts.tape) {
    // Hand the tape to the shim: it overrides live input mask-for-mask.
    dtInbox.push(JSON.stringify({ t: "replay", tape: opts.tape }));
    if (opts.pauseAt > 0) {
      // Deterministic fast-forward: frame+tick only, no render, yielding to
      // the event loop so a long seek doesn't freeze the tab.
      for (let i = 0; i < opts.pauseAt && frameCb; i++) {
        safeFrame();
        if (i % 1200 === 1199) await new Promise((r) => setTimeout(r, 0));
      }
      dtInbox.push(JSON.stringify({ t: "pause" }));
    }
  }
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
