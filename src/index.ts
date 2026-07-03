// psp-ui public entry: render(<App/>) + the re-exported app-facing surface.
//
// Frame contract (every host): once per vblank/rAF tick the host calls
// `globalThis.frame(buttons)` (spec BTN bitmask). render() installs that
// handler as input edge-detection + focus + onPress, THEN the renderer's
// end-of-frame sweep [R] — so Solid effects triggered by input run before
// detached subtrees are destroyed.

// queueMicrotask polyfill (QuickJS lacks it; Solid's resource/transition paths
// reference it lazily, so installing at module-eval time is early enough).
if (typeof (globalThis as { queueMicrotask?: unknown }).queueMicrotask !== "function") {
  (globalThis as { queueMicrotask?: (fn: () => void) => void }).queueMicrotask = (
    fn: () => void,
  ) => {
    Promise.resolve().then(fn);
  };
}

import { detectHost, installFrameHandler, installHost, type HostOps } from "./host.ts";
import {
  registerTexture as rendererRegisterTexture,
  render as rendererRender,
  rootMirror,
  runSweep,
  setStyleResolver,
  type NodeMirror,
} from "./renderer.ts";
import { registerStyles, resolveStyle } from "./styles.ts";
import { handleFrame, setInputRoot } from "./input.ts";
import { entries as dcpakEntries, get as dcpakGet, hasPack, loadPack } from "./dcpak.ts";
import { STYLE_IDS as DEFAULT_STYLE_IDS } from "./styles.generated.ts";

export interface RenderOptions {
  /** web/wasm/test hosts inject their ops here; omit on PSP (globalThis.ui). */
  ops?: HostOps;
  /** STYLE_IDS table (styles.generated.ts) — class literal → styleId. */
  styles?: Record<string, number>;
  /** App pack; defaults to globalThis.__dcpak when present. */
  dcpak?: ArrayBuffer;
}

export interface MountOptions extends RenderOptions {
  /** Runs once per host frame before built-in focus/onPress/sweep handling. */
  beforeFrame?: (buttons: number) => void;
}

/** dcpak entry keys the runtime understands when it loads a pack JS-side.
 * Must match compiler/dcpak.ts (KEY_STYLES / keyFont). */
const STYLES_KEY = "ui:styles";
const FONT_PREFIX = "ui:font.";
const IMG_PREFIX = "ui:img.";

function globalOps(): HostOps | undefined {
  return (globalThis as { ui?: HostOps }).ui;
}

function uploadDcpakImages(ops: HostOps): void {
  // PSP native dcpak.rs already uploaded pack images and exposed the handle
  // table through ui.__textures; web/wasm/test hosts need the JS-side upload.
  if ((ops as HostOps & { __textures?: unknown }).__textures) return;
  for (const key of dcpakEntries(IMG_PREFIX)) {
    const blob = dcpakGet(key);
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const w = dv.getUint16(0, true);
    const h = dv.getUint16(2, true);
    const psm = blob[4];
    const handle = ops.uploadTexture(blob.subarray(8), w, h, psm);
    if (handle >= 0) rendererRegisterTexture(key.slice(IMG_PREFIX.length), handle);
  }
}

function prependFrameHandler(fn: (buttons: number) => void): void {
  const g = globalThis as { frame?: (buttons: number) => void };
  const engineFrame = g.frame;
  if (typeof engineFrame !== "function") {
    throw new Error("psp-ui: mount() expected render() to install globalThis.frame");
  }
  g.frame = (buttons: number) => {
    fn(buttons);
    engineFrame(buttons);
  };
}

/**
 * Mount the app into the native root node and wire the frame loop. Returns a
 * disposer that unmounts and destroys the app subtree.
 *
 * On PSP the native bin has already fed styles/atlases to the core from the
 * dcpak (zero QuickJS transit); on injected hosts (web/test) render() pushes
 * them through ops.loadStyles/loadFontAtlas here.
 */
export function render(code: () => unknown, opts: RenderOptions = {}): () => void {
  const host = detectHost(opts.ops);
  installHost(host);

  setStyleResolver(resolveStyle);
  if (opts.styles) registerStyles(opts.styles);

  if (host.kind === "psp") {
    // PSP native host: native/src/dcpak.rs already fed styles/atlases to the
    // core and uploaded the pack's images at boot, leaving a name -> texture-
    // handle table on the ui namespace (ffi.rs). Bind it so <image src="name">
    // resolves through the renderer's texture registry.
    const tex = (host.ops as HostOps & { __textures?: Record<string, number> }).__textures;
    if (tex) {
      for (const key in tex) rendererRegisterTexture(key, tex[key]);
    }
  }

  if (host.kind === "injected") {
    if (opts.dcpak) loadPack(opts.dcpak);
    if (hasPack()) {
      for (const key of dcpakEntries()) {
        if (key === STYLES_KEY) {
          host.ops.loadStyles?.(dcpakGet(key));
        } else if (key.startsWith(FONT_PREFIX)) {
          host.ops.loadFontAtlas?.(dcpakGet(key));
        }
        // images: hosts upload + registerTexture() themselves (w/h/psm live
        // in host-specific metadata, not in the runtime).
      }
    }
  }

  setInputRoot(rootMirror);
  installFrameHandler((buttons: number) => {
    handleFrame(buttons); // edge-detect, focus nav, onPress (runs effects)
    runSweep(); // then destroy subtrees still detached [R]
  });

  const dispose = rendererRender(code as () => NodeMirror, rootMirror);
  return () => {
    dispose(); // tears down reactivity only — universal keeps the nodes
    setInputRoot(null); // drops focus state (native focus dies with the nodes)
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
 * upload dcpak images for injected hosts, mount the component, and optionally
 * prepend app frame logic before the built-in input/focus/sweep frame.
 */
export function mount(code: () => unknown, opts: MountOptions = {}): () => void {
  const ops = opts.ops ?? globalOps();
  if (!ops) {
    throw new Error("psp-ui: mount() requires globalThis.ui or opts.ops");
  }
  if (opts.dcpak) loadPack(opts.dcpak);
  uploadDcpakImages(ops);
  const dispose = render(code, {
    ops,
    styles: opts.styles ?? DEFAULT_STYLE_IDS,
    dcpak: opts.dcpak,
  });
  if (opts.beforeFrame) prependFrameHandler(opts.beforeFrame);
  return dispose;
}

// ---- app-facing re-exports ----------------------------------------------------

export {
  createSignal,
  createEffect,
  createMemo,
  onMount,
  onCleanup,
  batch,
  untrack,
  For,
  Show,
  Index,
  Switch,
  Match,
} from "solid-js";

export { animate, spring, cancelAnim, type AnimateOptions, type EasingName } from "./anim.ts";
export { View, Text, Image, type ViewProps, type TextProps, type ImageProps } from "./primitives.ts";
export { BTN, PROP, ENUMS, SCREEN_W, SCREEN_H } from "../spec/spec.ts";
export type { HostOps, Host } from "./host.ts";
export { detectHost, installHost, getOps } from "./host.ts";
export type { NodeMirror } from "./renderer.ts";
export { retain, release, runSweep, registerTexture, missCounters } from "./renderer.ts";
export { registerStyles, resolveStyle } from "./styles.ts";
export { handleFrame, focusNode, getFocused } from "./input.ts";
export { entries as dcpakEntries, get as dcpakGet, loadPack, resetPack } from "./dcpak.ts";
