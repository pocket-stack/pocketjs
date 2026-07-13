// PocketJS runtime entry: render(<App/>) / mount(<App/>).
//
// Frame contract (every host): once per vblank/rAF tick the host calls
// `globalThis.frame(buttons)` (spec BTN bitmask). render() installs that
// handler as app frame hooks, input edge-detection + focus + onPress, THEN the
// renderer's end-of-frame sweep [R] — so Solid effects triggered by input run
// before detached subtrees are destroyed.

// queueMicrotask polyfill (QuickJS lacks it; Solid's resource/transition paths
// reference it lazily, so installing at module-eval time is early enough).
if (typeof (globalThis as { queueMicrotask?: unknown }).queueMicrotask !== "function") {
  (globalThis as { queueMicrotask?: (fn: () => void) => void }).queueMicrotask = (
    fn: () => void,
  ) => {
    Promise.resolve().then(fn);
  };
}

import { detectHost, hostViewport, installFrameHandler, installHost, type HostOps } from "./host.ts";
import { initDevtools, wrapFrameHandler } from "./devtools.ts";
import {
  createElement,
  registerTexture as rendererRegisterTexture,
  registerSprite as rendererRegisterSprite,
  setProp,
  insertNode,
  render as rendererRender,
  rootMirror,
  runSweep,
  setStyleResolver,
  type NodeMirror,
} from "./renderer.ts";
import { setOverlayRoot } from "./overlay.ts";
import { registerStyles, resolveStyle } from "./styles.ts";
import { handleFrame, setInputRoot } from "./input.ts";
import { __setAnalog, resetFrameHooks, runFrameHooks } from "./frame.ts";
import { __resetTouches, __setTouches } from "./touch.ts";
import { __advanceClock, resetClock } from "./clock.ts";
import { __drainEffects, resetEffects } from "./effects.ts";
import { entries as pakEntries, get as pakGet, hasPack, loadPack } from "./pak.ts";
import { STYLE_IDS as DEFAULT_STYLE_IDS } from "./styles.generated.ts";
import { ENUMS, SCREEN_H, SCREEN_W } from "../spec/spec.ts";

export interface RenderOptions {
  /** web/wasm/test hosts inject their ops here; omit on PSP (globalThis.ui). */
  ops?: HostOps;
  /** STYLE_IDS table (styles.generated.ts) — class literal → styleId. */
  styles?: Record<string, number>;
  /** App pack; defaults to globalThis.__pak when present. */
  pak?: ArrayBuffer;
}

export type MountOptions = RenderOptions;

/** pak entry keys the runtime understands when it loads a pack JS-side.
 * Must match compiler/pak.ts (KEY_STYLES / keyFont). */
const STYLES_KEY = "ui:styles";
const FONT_PREFIX = "ui:font.";
const IMG_PREFIX = "ui:img.";
const SPRITE_PREFIX = "ui:sprite.";

export function frameworkName(): "Solid" {
  return "Solid";
}

function globalOps(): HostOps | undefined {
  return (globalThis as { ui?: HostOps }).ui;
}

function uploadPakImages(ops: HostOps): void {
  // PSP native pak.rs already uploaded pack images and exposed the handle
  // table through ui.__textures; web/wasm/test hosts need the JS-side upload.
  if ((ops as HostOps & { __textures?: unknown }).__textures) return;
  for (const key of pakEntries(IMG_PREFIX)) {
    const blob = pakGet(key);
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const w = dv.getUint16(0, true);
    const h = dv.getUint16(2, true);
    const psm = blob[4];
    const handle = ops.uploadTexture(blob.subarray(8), w, h, psm);
    if (handle >= 0) rendererRegisterTexture(key.slice(IMG_PREFIX.length), handle);
  }
}

/**
 * Upload every ui:sprite.<name> atlas and register its animation metadata.
 * Same as uploadPakImages but for the SPRITE ATLAS entry (compiler/pak.ts
 * encodeSpriteEntry): 16-byte header {u16 atlasW, u16 atlasH, u8 psm, u8 pad,
 * u16 frameCount, u16 cols, u16 frameStep, 4B pad} + atlas pixels. The core
 * auto-plays the animation — nothing per-frame happens here.
 */
function uploadPakSprites(ops: HostOps): void {
  if ((ops as HostOps & { __sprites?: unknown }).__sprites) return; // PSP fed natively
  for (const key of pakEntries(SPRITE_PREFIX)) {
    const blob = pakGet(key);
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const w = dv.getUint16(0, true);
    const h = dv.getUint16(2, true);
    const psm = blob[4];
    const frames = dv.getUint16(6, true);
    const cols = dv.getUint16(8, true);
    const step = dv.getUint16(10, true);
    const handle = ops.uploadTexture(blob.subarray(16), w, h, psm);
    if (handle >= 0) {
      rendererRegisterSprite(key.slice(SPRITE_PREFIX.length), { handle, frames, cols, step });
    }
  }
}

function createLayer(style: Record<string, number>): NodeMirror {
  const layer = createElement("view");
  setProp(layer, "style", style, undefined);
  return layer;
}

/**
 * Mount the app into the native root node and wire the frame loop. Returns a
 * disposer that unmounts and destroys the app subtree.
 *
 * On native hosts the device bin has already fed styles/atlases to the core from the
 * pak (zero QuickJS transit); on injected hosts (web/test) render() pushes
 * them through ops.loadStyles/loadFontAtlas here.
 */
export function render(code: () => unknown, opts: RenderOptions = {}): () => void {
  const host = detectHost(opts.ops);
  installHost(host);

  setStyleResolver(resolveStyle);
  if (opts.styles) registerStyles(opts.styles);

  if (host.kind === "native") {
    // Native host: its pak loader already fed styles/atlases to the
    // core and uploaded the pack's images at boot, leaving a name -> texture-
    // handle table on the ui namespace (ffi.rs). Bind it so <image src="name">
    // resolves through the renderer's texture registry.
    const tex = (host.ops as HostOps & { __textures?: Record<string, number> }).__textures;
    if (tex) {
      for (const key in tex) rendererRegisterTexture(key, tex[key]);
    }
    const spr = (
      host.ops as HostOps & {
        __sprites?: Record<string, { handle: number; frames: number; cols: number; step: number }>;
      }
    ).__sprites;
    if (spr) {
      for (const key in spr) rendererRegisterSprite(key, spr[key]);
    }
  }

  if (host.kind === "injected") {
    if (opts.pak) loadPack(opts.pak);
    if (hasPack()) {
      for (const key of pakEntries()) {
        if (key === STYLES_KEY) {
          host.ops.loadStyles?.(pakGet(key));
        } else if (key.startsWith(FONT_PREFIX)) {
          host.ops.loadFontAtlas?.(pakGet(key));
        }
        // images: hosts upload + registerTexture() themselves (w/h/psm live
        // in host-specific metadata, not in the runtime).
      }
    }
  }

  // Desktop hosts publish their logical UI size as ui.__viewport (the core
  // root is already sized to it via Ui::set_viewport); PSP/web hosts omit it
  // and keep the 480x272 contract.
  const viewport = hostViewport(host.ops);
  const layerW = viewport?.w ?? SCREEN_W;
  const layerH = viewport?.h ?? SCREEN_H;
  const appRoot = createLayer({
    width: layerW,
    height: layerH,
    overflow: ENUMS.Overflow.Hidden,
  });
  const overlayRoot = createLayer({
    width: layerW,
    height: layerH,
    posType: ENUMS.PosType.Absolute,
    insetT: 0,
    insetR: 0,
    insetB: 0,
    insetL: 0,
    zIndex: 1000,
  });
  insertNode(rootMirror, appRoot);
  insertNode(rootMirror, overlayRoot);
  setOverlayRoot(overlayRoot);

  setInputRoot(appRoot);
  resetFrameHooks();
  resetClock(); // latches the host's __simHz clock policy (DETERMINISM.md)
  resetEffects();
  initDevtools(host.ops); // DevTools shim (DEVTOOLS.md): flight recorder +
  // debug channel; one branch per frame when no transport is connected.
  installFrameHandler(
    wrapFrameHandler((buttons: number, analog: number, touches?: readonly number[]) => {
      __advanceClock(); // virtual frame++, fire due after() timers
      __setAnalog(analog); // latch the nub before any app code reads it
      __setTouches(touches); // latch logical front-panel contacts for this frame
      __drainEffects(); // frame-boundary deliveries enter the world first
      runFrameHooks(buttons); // app lifecycle callbacks: onFrame/onButtonPress/etc.
      handleFrame(buttons); // edge-detect, focus nav, onPress (runs effects)
      runSweep(); // then destroy subtrees still detached [R]
    }),
  );

  const dispose = rendererRender(code as () => NodeMirror, appRoot);
  return () => {
    __resetTouches();
    dispose(); // tears down reactivity only — universal keeps the nodes
    setInputRoot(null); // drops focus state (native focus dies with the nodes)
    setOverlayRoot(null);
    for (const child of rootMirror.children.splice(0)) {
      child.parent = null;
      host.ops.destroyNode(child.id); // recursive native destroy
    }
    runSweep(); // anything already detached this frame is garbage too
  };
}

/**
 * App-level entry point for demo/application bundles. It mirrors a web-style
 * mount call: pick the current host, feed the current generated style table,
 * upload pak images for injected hosts, and mount the component. Per-frame
 * app behavior belongs in component lifecycle callbacks such as onFrame/onButtonPress.
 */
export function mount(code: () => unknown, opts: MountOptions = {}): () => void {
  const ops = opts.ops ?? globalOps();
  if (!ops) {
    throw new Error("PocketJS: mount() requires globalThis.ui or opts.ops");
  }
  if (opts.pak) loadPack(opts.pak);
  uploadPakImages(ops);
  uploadPakSprites(ops);
  const dispose = render(code, {
    ops,
    styles: opts.styles ?? DEFAULT_STYLE_IDS,
    pak: opts.pak,
  });
  return dispose;
}

// ---- runtime re-exports -------------------------------------------------------

export type { HostOps, Host } from "./host.ts";
export { detectHost, installHost, getOps } from "./host.ts";
export { expandTape, type Tape, type DevtoolsTransport } from "./devtools.ts";
export type { NodeMirror } from "./renderer.ts";
export { retain, release, runSweep, registerTexture, missCounters } from "./renderer.ts";
export { registerStyles, resolveStyle } from "./styles.ts";
export { entries as pakEntries, get as pakGet, loadPack, resetPack } from "./pak.ts";
