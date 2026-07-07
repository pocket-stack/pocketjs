// host-web/wasm-ops.js — the ONE wasm <-> HostOps binding, shared verbatim by
// the browser dev host (engine.js) and the headless golden harness
// (test/golden.ts). Plain ES module, zero dependencies; needs only
// WebAssembly + TextEncoder (both exist in every browser and in Bun — the
// QuickJS "no TextEncoder" constraint applies only to src/pak.ts, which
// this file is not).
//
// ABI (see wasm/src/lib.rs): one export per ui.* op; strings/buffers cross
// via linear memory — ui_alloc(len) -> ptr, write bytes, call, ui_free.
// ui_render() returns the RGBA8 480x272 framebuffer pointer.

export const FB_W = 480;
export const FB_H = 272;

const encoder = new TextEncoder();

/**
 * Instantiate pocketjs.wasm and return { ops, init, tick, render, exports }.
 * `ops` is a complete HostOps (src/host.ts) — hand it to the app bundle as
 * globalThis.ui before eval'ing it.
 *
 * @param {ArrayBuffer | Uint8Array | WebAssembly.Module} wasm
 */
export async function createWasmUi(wasm) {
  const source = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  const instance = await WebAssembly.instantiate(source, {});
  const ex = instance.exports;
  ex.ui_init();

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

  /** @type {import("../src/host.ts").HostOps} */
  const ops = {
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
    loadStyles: (buf) => {
      withBytes(buf, (p, l) => ex.ui_load_styles(p, l));
    },
    loadFontAtlas: (buf) => {
      withBytes(buf, (p, l) => ex.ui_load_font_atlas(p, l));
    },
    measureText: (str, fontSlot) => withStr(str, (p, l) => ex.ui_measure_text(p, l, fontSlot)),
    // DevTools ops (spec ops 18..22, DEVTOOLS.md) — debug-only, default-off.
    debugInspect: (id) => ex.ui_debug_inspect(id),
    debugRectXY: () => ex.ui_debug_rect_xy(),
    debugRectWH: () => ex.ui_debug_rect_wh(),
    debugPause: (on) => ex.ui_debug_pause(on ? 1 : 0),
    debugStep: () => ex.ui_debug_step(),
  };

  return {
    ops,
    exports: ex,
    /** Reset the core to a fresh Ui (fresh tree/styles/atlases/textures). */
    init: () => ex.ui_init(),
    /** Advance exactly one fixed-dt (1/60 s) frame. */
    tick: () => ex.ui_tick(),
    /** Rasterize and return the RGBA8 framebuffer as a fresh view. */
    render() {
      const ptr = ex.ui_render();
      return new Uint8Array(ex.memory.buffer, ptr, FB_W * FB_H * 4);
    },
  };
}

/**
 * Upload every `ui:img.*` pak entry through ops.uploadTexture and return a
 * Map of image name (the JSX `src` key) -> texture handle. Blob layout is the
 * compiler/pak.ts IMG entry: 8-byte header {u16 w, u16 h, u8 psm, 3B pad} +
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
