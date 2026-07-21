// Vue Vapor runtime entry: render(<App/>) / mount(<App/>).

import "./prelude.ts";

import { detectHost, hostViewport, installFrameHandler, installHost, type HostOps } from "./host.ts";
import { initDevtools, wrapFrameHandler } from "./devtools.ts";
import {
  createElement,
  registerSprite as rendererRegisterSprite,
  registerTexture as rendererRegisterTexture,
  setProp,
  insertNode,
  render as rendererRender,
  rootMirror,
  runSweep,
  setStyleResolver,
  type NodeMirror,
} from "./renderer-vue-vapor.ts";
import { setOverlayRoot } from "./overlay.ts";
import { registerStyles, resolveStyle } from "./styles.ts";
import { handleFrame, setInputRoot } from "./input.ts";
import { __setAnalog, resetFrameHooks, runFrameHooks } from "./frame-vue-vapor.ts";
import { __resetTouches, __setTouches } from "./touch.ts";
import { __advanceClock, resetClock } from "./clock.ts";
import { __drainEffects, resetEffects } from "./effects.ts";
import { entries as pakEntries, get as pakGet, hasPack, loadPack } from "./pak.ts";
import { STYLE_IDS as DEFAULT_STYLE_IDS } from "./styles.generated.ts";
import { ENUMS, SCREEN_H, SCREEN_W } from "../spec/spec.ts";

export interface RenderOptions {
  /** web/wasm/test hosts inject their ops here; omit on PSP (globalThis.ui). */
  ops?: HostOps;
  /** STYLE_IDS table (styles.generated.ts) - class literal -> styleId. */
  styles?: Record<string, number>;
  /** App pack; defaults to globalThis.__pak when present. */
  pak?: ArrayBuffer;
}

export type MountOptions = RenderOptions;

const STYLES_KEY = "ui:styles";
const FONT_PREFIX = "ui:font.";
const IMG_PREFIX = "ui:img.";
const SPRITE_PREFIX = "ui:sprite.";

export function frameworkName(): "Vue Vapor" {
  return "Vue Vapor";
}

function globalOps(): HostOps | undefined {
  return (globalThis as { ui?: HostOps }).ui;
}

function uploadPakImages(ops: HostOps): void {
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

function uploadPakSprites(ops: HostOps): void {
  if ((ops as HostOps & { __sprites?: unknown }).__sprites) return;
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

export function render(code: () => unknown, opts: RenderOptions = {}): () => void {
  const host = detectHost(opts.ops);
  installHost(host);

  setStyleResolver(resolveStyle);
  if (opts.styles) registerStyles(opts.styles);

  if (host.kind === "native") {
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
      }
    }
  }

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
  resetClock(); // clock policy + effect shell (DETERMINISM.md), same as Solid
  resetEffects();
  initDevtools(host.ops); // DevTools shim (DEVTOOLS.md), same as the Solid path.
  installFrameHandler(
    wrapFrameHandler((buttons: number, analog: number, touches?: readonly number[]) => {
      __advanceClock();
      __setAnalog(analog);
      __setTouches(touches);
      __drainEffects();
      runFrameHooks(buttons);
      handleFrame(buttons);
      runSweep();
    }),
  );

  const dispose = rendererRender(code, appRoot);
  return () => {
    __resetTouches();
    dispose();
    setInputRoot(null);
    setOverlayRoot(null);
    for (const child of rootMirror.children.splice(0)) {
      child.parent = null;
      host.ops.destroyNode(child.id);
    }
    runSweep();
  };
}

export function mount(code: () => unknown, opts: MountOptions = {}): () => void {
  const ops = opts.ops ?? globalOps();
  if (!ops) {
    throw new Error("PocketJS: mount() requires globalThis.ui or opts.ops");
  }
  if (opts.pak) loadPack(opts.pak);
  uploadPakImages(ops);
  uploadPakSprites(ops);
  return render(code, {
    ops,
    styles: opts.styles ?? DEFAULT_STYLE_IDS,
    pak: opts.pak,
  });
}

export type { HostOps, Host } from "./host.ts";
export { detectHost, installHost, getOps } from "./host.ts";
export type { NodeMirror } from "./renderer-vue-vapor.ts";
export { retain, release, runSweep, registerTexture, registerSprite, missCounters } from "./renderer-vue-vapor.ts";
export { registerStyles, resolveStyle } from "./styles.ts";
export { entries as pakEntries, get as pakGet, loadPack, resetPack } from "./pak.ts";
