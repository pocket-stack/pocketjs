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

  // --- native <Video> (web fallback) ---------------------------------------
  // Drive HTML5 <video> elements and feed their frames to the wasm rasterizer
  // as RGBA8888 surfaces. In a HEADLESS host (Bun goldens: no `document`),
  // videoOpen tracks the handle but uploads NO surface, so raster.rs draws its
  // deterministic checker placeholder — keeping goldens byte-stable.
  const hasDOM = typeof document !== "undefined";
  const videos = new Map();
  let nextVideoHandle = 0;

  // "host0:/clip.pmf" -> "/clip.mp4": browsers can't play PMF, so the dev
  // server serves a web-friendly encode next to the demo. Missing file => the
  // <video> never yields frames => raster draws the checker placeholder.
  const webUrlForPath = (path) =>
    "/" + (String(path).split(/[\\/]/).pop() || "clip").replace(/\.pmf$/i, ".mp4");

  function videoOpen(path, w, h, loopFlag) {
    const handle = nextVideoHandle++;
    if (handle >= 4) return -1; // raster.rs MAX_VIDEO_SURFACES
    const entry = { w, h, ptr: 0, el: null, ctx: null, ended: false };
    if (hasDOM) {
      const el = document.createElement("video");
      el.src = webUrlForPath(path);
      el.loop = !!loopFlag;
      el.muted = true; // v1 is silent; also unblocks autoplay
      el.playsInline = true;
      el.autoplay = true;
      el.addEventListener("ended", () => {
        entry.ended = true;
      });
      el.play?.().catch(() => {});
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      entry.el = el;
      entry.ctx = canvas.getContext("2d", { willReadFrequently: true });
      entry.ptr = ex.ui_alloc(w * h * 4);
    }
    videos.set(handle, entry);
    return handle;
  }

  function videoControl(handle, cmd, _arg) {
    const v = videos.get(handle);
    if (!v) return;
    if (cmd === 0) v.el?.play?.().catch(() => {}); // play
    else if (cmd === 1) v.el?.pause?.(); // pause
    else if (cmd === 2) {
      if (v.el) {
        v.el.pause();
        v.el.currentTime = 0;
      }
    } else if (cmd === 4) {
      // close
      v.el?.pause?.();
      if (v.ptr) {
        ex.ui_video_surface(handle, 0, 0, 0);
        ex.ui_free(v.ptr, v.w * v.h * 4);
      }
      videos.delete(handle);
    }
  }

  function videoState(handle) {
    const v = videos.get(handle);
    if (!v) return 4; // VIDEO_STATE.error
    if (v.ended) return 3; // ended
    if (v.el && v.el.paused) return 2; // paused
    return 1; // playing
  }

  // Blit each active <video>'s current frame into its wasm RGBA surface. Called
  // once per frame by engine.js BEFORE render(). No-op in a headless host.
  function pumpVideos() {
    if (!hasDOM) return;
    for (const [handle, v] of videos) {
      if (!v.el || !v.ptr || v.el.readyState < 2) continue;
      try {
        v.ctx.drawImage(v.el, 0, 0, v.w, v.h);
        const img = v.ctx.getImageData(0, 0, v.w, v.h);
        // Rebuilt each call: memory.buffer detaches whenever linear memory grows.
        new Uint8Array(ex.memory.buffer, v.ptr, v.w * v.h * 4).set(img.data);
        ex.ui_video_surface(handle, v.ptr, v.w, v.h);
      } catch {
        /* frame not decodable yet */
      }
    }
  }

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
    videoOpen,
    videoControl,
    videoBind: (nodeId, handle) => ex.ui_set_video(nodeId, handle),
    videoState,
  };

  return {
    ops,
    exports: ex,
    /** Blit active <video> frames into wasm surfaces; call before render(). */
    pumpVideos,
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
