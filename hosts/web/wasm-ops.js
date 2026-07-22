// hosts/web/wasm-ops.js — the ONE wasm <-> HostOps binding, shared verbatim by
// the browser dev host (engine.js) and the headless golden harness
// (tests/golden.ts). Plain ES module, zero dependencies; needs only
// WebAssembly + TextEncoder (both exist in every browser and in Bun — the
// QuickJS "no TextEncoder" constraint applies only to framework/src/pak.ts, which
// this file is not).
//
// ABI (see engine/wasm/src/lib.rs): one export per ui.* op; strings/buffers cross
// via linear memory — ui_alloc(len) -> ptr, write bytes, call, ui_free.
// ui_render() returns the byte-exact RGBA8 framebuffer pointer at the
// logical viewport size; ui_render_scaled(n) renders the DrawList at n×.

export const FB_W = 480;
export const FB_H = 272;

const encoder = new TextEncoder();

/**
 * Instantiate pocketjs.wasm and return
 * { ops, init, tick, drawHash, render, renderScaled, exports }.
 * `ops` is a complete HostOps (framework/src/host.ts) — hand it to the app bundle as
 * globalThis.ui before eval'ing it.
 *
 * @param {ArrayBuffer | Uint8Array | WebAssembly.Module} wasm
 */
export async function createWasmUi(wasm, options = {}) {
  const source = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  const instance = await WebAssembly.instantiate(source, {});
  const ex = instance.exports;

  function integerInRange(value, name, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new RangeError(`${name} must be an integer from ${min} through ${max}, got ${value}`);
    }
    return value;
  }

  const viewportWidth = integerInRange(options.width ?? FB_W, "viewport width", 1, 32000);
  const viewportHeight = integerInRange(options.height ?? FB_H, "viewport height", 1, 32000);
  const initialDensity = integerInRange(options.rasterDensity ?? 1, "rasterDensity", 1, 255);

  const init = (rasterDensity = initialDensity) => {
    ex.ui_init(integerInRange(rasterDensity, "rasterDensity", 1, 255));
    // Older wasm binaries predate ui_set_viewport (same convention as
    // drawHash): tolerate them at the stock size, fail loud otherwise.
    if (ex.ui_set_viewport) ex.ui_set_viewport(viewportWidth, viewportHeight);
    else if (viewportWidth !== FB_W || viewportHeight !== FB_H) {
      throw new Error("this pocketjs.wasm predates ui_set_viewport — rebuild it: bun tools/wasm.ts");
    }
  };
  init(initialDensity);

  // Copy bytes into wasm scratch, run fn(ptr, len), free. Views are rebuilt
  // per call: memory.buffer is detached whenever linear memory grows.
  function withBytes(u8, fn) {
    const len = u8.length;
    const ptr = ex.ui_alloc(len);
    if (len > 0) new Uint8Array(ex.memory.buffer, ptr, len).set(u8);
    try {
      return fn(ptr, len);
    } finally {
      ex.ui_free(ptr, len);
    }
  }
  const withStr = (s, fn) => withBytes(encoder.encode(String(s)), fn);

  /** @type {import("../../framework/src/host.ts").HostOps} */
  const ops = {
    __viewport: { w: viewportWidth, h: viewportHeight },
    createNode: (type) => ex.ui_create_node(type),
    destroyNode: (id) => ex.ui_destroy_node(id),
    insertBefore: (parent, child, anchor) => ex.ui_insert_before(parent, child, anchor),
    removeChild: (parent, child) => ex.ui_remove_child(parent, child),
    setStyle: (id, styleId) => ex.ui_set_style(id, styleId),
    setProp: (id, propId, value) => ex.ui_set_prop(id, propId, value),
    setText: (id, str) => withStr(str, (p, l) => ex.ui_set_text(id, p, l)),
    replaceText: (id, str) => withStr(str, (p, l) => ex.ui_replace_text(id, p, l)),
    uploadTexture: (buf, w, h, psm) => withBytes(buf, (p, l) => ex.ui_upload_texture(p, l, w, h, psm)),
    setImage: (id, tex) => ex.ui_set_image(id, tex),
    setSprite: (id, atlas, frames, cols, step) => ex.ui_set_sprite(id, atlas, frames, cols, step),
    animate: (id, propId, to, durMs, easing, delayMs) =>
      ex.ui_animate(id, propId, to, durMs, easing, delayMs),
    cancelAnim: (animId) => ex.ui_cancel_anim(animId),
    setFocus: (id) => ex.ui_set_focus(id),
    setActive: (id, active) => ex.ui_set_active(id, active ? 1 : 0),
    loadStyles: (buf) => {
      withBytes(buf, (p, l) => ex.ui_load_styles(p, l));
    },
    loadFontAtlas: (buf) => {
      withBytes(buf, (p, l) => ex.ui_load_font_atlas(p, l));
    },
    measureText: (str, fontSlot) => withStr(str, (p, l) => ex.ui_measure_text(p, l, fontSlot)),
    // DevTools ops (spec ops 18..22, docs/DEVTOOLS.md) — debug-only, default-off.
    debugInspect: (id) => ex.ui_debug_inspect(id),
    debugRectXY: () => ex.ui_debug_rect_xy(),
    debugRectWH: () => ex.ui_debug_rect_wh(),
    debugPause: (on) => ex.ui_debug_pause(on ? 1 : 0),
    debugStep: () => ex.ui_debug_step(),
  };

  // Streamed-texture ops (spec ops 24/25) — feature-detected so a stale
  // pocketjs.wasm predating them still boots (the runtime falls back to
  // plain uploadTexture in framework/src/tiles.ts).
  if (ex.ui_free_texture) ops.freeTexture = (handle) => ex.ui_free_texture(handle);
  if (ex.ui_upload_img_entry) {
    ops.uploadImgEntry = (blob) => withBytes(blob, (p, l) => ex.ui_upload_img_entry(p, l));
  }

  // Virtual cursor ops (spec ops 27..29, input.cursor) — feature-detected so
  // a stale pocketjs.wasm predating them still boots (enableCursor falls
  // back to the classic d-pad focus model when the host lacks them).
  if (ex.ui_hit_test) ops.hitTest = (x, y) => ex.ui_hit_test(x, y);
  if (ex.ui_set_cursor) {
    ops.setCursor = (tex, hotX, hotY, w, h) => ex.ui_set_cursor(tex, hotX, hotY, w, h);
  }
  if (ex.ui_set_cursor_pos) ops.setCursorPos = (x, y) => ex.ui_set_cursor_pos(x, y);

  function framebufferView(ptr, scale) {
    if (!ptr) throw new Error(`pocketjs.wasm rejected render scale ${scale}`);
    return new Uint8Array(
      ex.memory.buffer,
      ptr,
      viewportWidth * scale * viewportHeight * scale * 4,
    );
  }

  return {
    ops,
    exports: ex,
    /** Reset the core and set raster samples per logical pixel (default 1). */
    init,
    /** Advance exactly one fixed-dt (1/60 s) frame. */
    tick: () => ex.ui_tick(),
    /** Hash the current DrawList without rasterizing it (BigInt, wasm i64). */
    drawHash: ex.ui_draw_hash ? () => ex.ui_draw_hash() : null,
    /** Rasterize the byte-exact framebuffer at the logical viewport size. */
    render() {
      return framebufferView(ex.ui_render(), 1);
    },
    /** Rasterize the logical DrawList directly at an integer physical scale. */
    renderScaled(scale) {
      scale = integerInRange(scale, "render scale", 1, 4);
      return framebufferView(ex.ui_render_scaled(scale), scale);
    },
  };
}

/**
 * Upload every `ui:img.*` pak entry through ops.uploadTexture and return a
 * Map of image name (the JSX `src` key) -> texture handle. Blob layout is the
 * framework/compiler/pak.ts IMG entry: 8-byte header {u16 w, u16 h, u8 psm, 3B pad} +
 * raw pixels. `getEntry(key)` / `listEntries(prefix)` come from the runtime's
 * pak reader (or any equivalent).
 */
export function uploadPackImages(ops, listEntries, getEntry) {
  const IMG_PREFIX = "ui:img.";
  const handles = new Map();
  for (const key of listEntries(IMG_PREFIX)) {
    const blob = getEntry(key);
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const w = dv.getUint16(0, true);
    const h = dv.getUint16(2, true);
    const psm = blob[4];
    const handle = ops.uploadTexture(blob.subarray(8), w, h, psm);
    if (handle >= 0) handles.set(key.slice(IMG_PREFIX.length), handle);
  }
  return handles;
}
