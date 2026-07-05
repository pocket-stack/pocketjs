// site/playground/host.js — a reusable PocketJS <canvas> host for the web.
//
// Loads pocketjs.wasm (Rust core + software rasterizer) once, binds it to a
// 480x272 canvas, and drives the fixed-timestep 60 Hz loop (dt clamp 250 ms,
// max 4 catch-up steps — the proven dreamcart driver shape). Two ways to run an
// app on it:
//   • runIIFE(jsText, pak)  — a prebuilt `bun scripts/build.ts` bundle
//     (globalThis.ui/__pak in, globalThis.frame out). Used by the homepage.
//   • reset() → (caller imports an ES module that calls mount()) → begin()
//     — the live-compiled playground path.
// Both end up driving the same globalThis.frame(buttons) contract.

import { createWasmUi, FB_W, FB_H } from "../../host-web/wasm-ops.js";

// spec/spec.ts BTN — the PSP button bitmask.
export const BTN = {
  SELECT: 0x0001, START: 0x0008,
  UP: 0x0010, RIGHT: 0x0020, DOWN: 0x0040, LEFT: 0x0080,
  LTRIGGER: 0x0100, RTRIGGER: 0x0200,
  TRIANGLE: 0x1000, CIRCLE: 0x2000, CROSS: 0x4000, SQUARE: 0x8000,
};

const KEYMAP = {
  ArrowUp: BTN.UP, ArrowRight: BTN.RIGHT, ArrowDown: BTN.DOWN, ArrowLeft: BTN.LEFT,
  KeyX: BTN.CROSS, Enter: BTN.CIRCLE, KeyZ: BTN.CIRCLE, KeyA: BTN.SQUARE,
  KeyS: BTN.TRIANGLE, ShiftLeft: BTN.SELECT, ShiftRight: BTN.SELECT, Space: BTN.START,
  // Shoulder triggers: literal L / R keys, plus Q / E as a left-hand alternate.
  KeyL: BTN.LTRIGGER, KeyR: BTN.RTRIGGER, KeyQ: BTN.LTRIGGER, KeyE: BTN.RTRIGGER,
};

export class PocketHost {
  constructor() {
    this.wasm = null;
    this.canvas = null;
    this.ctx = null;
    this.imageData = null;
    this.held = 0;
    this.rafId = 0;
    this.acc = 0;
    this.last = 0;
    this.frameCb = null;
    this.onLog = () => {};
    this.onFps = () => {};
    this.onError = () => {};
    this._statsFrames = 0;
    this._statsT = 0;
  }

  /** Bind to a canvas + instantiate the wasm. Call once. `wasmUrl` defaults to
   *  ./pocketjs.wasm (next to this module). */
  async mount(canvas, opts = {}) {
    this.onLog = opts.onLog ?? this.onLog;
    this.onFps = opts.onFps ?? this.onFps;
    this.onError = opts.onError ?? this.onError;
    this.canvas = canvas;
    canvas.width = FB_W;
    canvas.height = FB_H;
    this.ctx = canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;
    this.imageData = this.ctx.createImageData(FB_W, FB_H);

    // Keyboard only while the canvas is focused (an editor may share the page).
    canvas.tabIndex = 0;
    canvas.addEventListener("keydown", (e) => this._onKey(e, true));
    canvas.addEventListener("keyup", (e) => this._onKey(e, false));
    canvas.addEventListener("blur", () => (this.held = 0));

    const url = opts.wasmUrl ?? new URL("./pocketjs.wasm", import.meta.url).href;
    const res = await fetch(url);
    if (!res.ok) throw new Error("pocketjs.wasm not found at " + url);
    this.wasm = await createWasmUi(await res.arrayBuffer());
    this.onLog("wasm ready");
    return this;
  }

  get ops() {
    return this.wasm.ops;
  }

  _onKey(e, down) {
    const bit = KEYMAP[e.code];
    if (bit === undefined) return;
    e.preventDefault();
    if (down) this.held |= bit;
    else this.held &= ~bit;
  }

  /** Virtual on-screen d-pad/buttons. */
  press(bit, down) {
    if (down) this.held |= bit;
    else this.held &= ~bit;
  }

  /** Fresh core + host globals. Call before installing a new app. */
  reset() {
    this.stop();
    this.frameCb = null;
    this.wasm.init();
    globalThis.ui = this.wasm.ops;
    globalThis.frame = undefined;
    globalThis.__pak = undefined;
  }

  /** After the caller has mounted an app (globalThis.frame installed), start the
   *  loop with one immediate frame so the canvas is never blank. */
  begin() {
    if (typeof globalThis.frame !== "function") {
      throw new Error(
        "app did not install globalThis.frame — the entry must call mount()/render()",
      );
    }
    this.frameCb = globalThis.frame;
    this._safeFrame();
    this._blit();
    this._start();
  }

  /** Run a prebuilt IIFE bundle (dist/<app>.js + <app>.pak). */
  runIIFE(jsText, pakBuffer) {
    this.reset();
    globalThis.__pak = pakBuffer;
    // Fresh function scope per load so top-level vars can't collide.
    new Function(jsText + "\n//# sourceURL=pocketjs-demo.js")();
    this.begin();
  }

  _safeFrame() {
    if (!this.frameCb) return;
    try {
      this.frameCb(this.held);
      this.wasm.tick();
    } catch (e) {
      this.onError(e);
      this.onLog("FRAME ERROR: " + (e && e.stack ? e.stack : e));
      this.frameCb = null; // stop repeating the throw 60x/s
    }
  }

  _blit() {
    if (!this.wasm || !this.ctx) return;
    this.imageData.data.set(this.wasm.render());
    this.ctx.putImageData(this.imageData, 0, 0);
  }

  _tick = (now) => {
    this.rafId = requestAnimationFrame(this._tick);
    let dt = now - this.last;
    this.last = now;
    if (dt > 250) dt = 250;
    this.acc += dt;
    const STEP = 1000 / 60;
    let steps = 0;
    while (this.acc >= STEP && steps < 4) {
      this._safeFrame();
      this.acc -= STEP;
      steps++;
      this._statsFrames++;
    }
    if (steps > 0) this._blit();
    this._statsT += dt;
    if (this._statsT >= 1000) {
      this.onFps(Math.round((this._statsFrames * 1000) / this._statsT));
      this._statsFrames = 0;
      this._statsT = 0;
    }
  };

  _start() {
    if (this.rafId) return;
    this.last = performance.now();
    this.acc = 0;
    this.rafId = requestAnimationFrame(this._tick);
  }

  stop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.onFps(0);
  }
}
