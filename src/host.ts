// Host binding layer — the JS side of the `ui.*` native contract (DESIGN.md
// table, codes pinned in spec/spec.ts OP). Every op is SYNCHRONOUS; the
// renderer keeps a JS mirror tree so reconciler reads never cross this
// boundary.
//
// Two host kinds:
//   - "psp":      QuickJS on hardware/PPSSPP — the native bin installs a
//                 `globalThis.ui` namespace (native/src/ffi.rs). Detected
//                 automatically. NON-strict: unknown classes/textures bump a
//                 counter instead of throwing (a crash on hardware is worse
//                 than a missing style).
//   - "injected": web/wasm/Bun-test hosts pass their own HostOps object into
//                 render(). Strict: unknown classes/textures throw loudly.

import {
  abgr,
  PROP_VALUE_KIND,
  VALUE_KIND,
  type PropName,
} from "../spec/spec.ts";

/** The `ui.*` op surface. Handles are generation-tagged positive i32 ids;
 *  0 means "none" (anchor 0 = append, setFocus 0 = clear). */
export interface HostOps {
  /** type: spec NODE_TYPE (0 view, 1 text, 2 image) → new node id. */
  createNode(type: number): number;
  /** Destroys the whole subtree; frees anim tracks; clears focus if inside. */
  destroyNode(id: number): void;
  /** DOM move semantics (attached child is unlinked first); anchor 0 = append. */
  insertBefore(parent: number, child: number, anchorOr0: number): void;
  /** Detaches but keeps the node alive (Solid may re-insert it this frame). */
  removeChild(parent: number, child: number): void;
  /** styleId from the compiled style table; STYLE_ID_NONE (-1) clears. */
  setStyle(id: number, styleId: number): void;
  /** propId: spec PROP. Colors/enums pass their u32 bits as a number. */
  setProp(id: number, propId: number, value: number): void;
  /** UTF-8 text; text nodes only. */
  setText(id: number, str: string): void;
  /** Solid universal calls this on reactive text updates. */
  replaceText(id: number, str: string): void;
  /** pow2 dims ≤ 512; psm: spec PSM. Returns a texture handle. */
  uploadTexture(buf: Uint8Array, w: number, h: number, psm: number): number;
  /** texHandle < 0 clears the image (handles are 0-based: 0 is a real one). */
  setImage(id: number, texHandle: number): void;
  /**
   * Bind an animated sprite atlas to an image node: `atlas` is an uploaded
   * texture (a `cols`-wide grid of `frames` cells); the core auto-plays it,
   * one cell every `step` vblanks. `frames <= 0` clears it. Zero per-frame JS.
   */
  setSprite(id: number, atlas: number, frames: number, cols: number, step: number): void;
  /** from = current value; easing: spec ENUMS.Easing ordinal → animId. */
  animate(
    id: number,
    propId: number,
    to: number,
    durMs: number,
    easing: number,
    delayMs: number,
  ): number;
  cancelAnim(animId: number): void;
  /** 0 clears focus. Applies the `focus:` style variant natively. */
  setFocus(idOr0: number): void;
  /** web/test hosts only — on PSP the native bin feeds core from the pak. */
  loadStyles?(buf: Uint8Array): void;
  /** web/test hosts only — one call per baked font atlas blob. */
  loadFontAtlas?(buf: Uint8Array): void;
  /** JS-side convenience; layout measures natively. → width in px. */
  measureText(str: string, fontSlot: number): number;

  // -- DevTools ops (spec ops 18..22, DEVTOOLS.md). Optional: debug-only,
  //    default-off; hosts that predate them (e.g. pocket-mod) simply lack
  //    them and the shim feature-detects. ---------------------------------
  /** Set (0 = clear) the inspected node: the core captures its world AABB
   *  during paint and appends a highlight overlay on top. */
  debugInspect?(id: number): void;
  /** Packed x|y<<16 (i16 halves) of the last captured AABB; -1 if none. */
  debugRectXY?(): number;
  /** Packed w|h<<16 of the same AABB; -1 if none. */
  debugRectWH?(): number;
  /** Freeze the world: tick() no-ops (draw still runs). */
  debugPause?(on: boolean | number): void;
  /** Arm exactly one tick while paused. */
  debugStep?(): void;
  /** PSP mailbox transport (native/src/dbg.rs); absent elsewhere. */
  __dbgActive?(): boolean;
  __dbgPoll?(): string | undefined;
  __dbgSend?(line: string): void;
  /** PSP on-demand screenshot: dump the displayed framebuffer to
   *  pocketjs-dbg/shot.raw (bridge converts to PNG). → success. */
  __dbgShot?(): boolean;
  /** Host self-identification for DevTools' hello (e.g. "desktop"); hosts
   *  without it are inferred from the boot tables. */
  __host?: string;
}

export interface Host {
  ops: HostOps;
  kind: "psp" | "injected";
  /** Strict hosts throw on unknown class/src; PSP counts silently. */
  strict: boolean;
}

let current: Host | null = null;

/**
 * Resolve the host: injected ops win; otherwise `globalThis.ui` (PSP/QuickJS).
 * Throws when neither exists — PocketJS cannot run without a native tree.
 *
 * Exception: when the injected ops ARE the PSP native namespace (the demo
 * entries pass `globalThis.ui` explicitly), the host stays kind "psp"/
 * non-strict — `__textures` is set only by native ffi.rs, never by web/wasm/
 * test hosts, so those keep the strict injected contract. This also routes
 * render() into its PSP branch (bind native texture handles, skip the
 * loadStyles/loadFontAtlas re-feed the native pak walker already did).
 */
export function detectHost(injected?: HostOps): Host {
  const native = (globalThis as { ui?: HostOps & { __textures?: unknown } }).ui;
  if (injected) {
    if (native !== undefined && injected === native && native.__textures !== undefined) {
      return { ops: injected, kind: "psp", strict: false };
    }
    return { ops: injected, kind: "injected", strict: true };
  }
  if (native) return { ops: native, kind: "psp", strict: false };
  throw new Error(
    "PocketJS: no host — pass HostOps to render() (web/test) or run under the PSP runtime (globalThis.ui)",
  );
}

/** Install the active host. Called by render(); tests may call it directly. */
export function installHost(host: Host): void {
  current = host;
}

export function getHost(): Host {
  if (!current) {
    throw new Error("PocketJS: host not installed — call render() first");
  }
  return current;
}

export function getOps(): HostOps {
  return getHost().ops;
}

// ---------------------------------------------------------------------------
// Frame hookup
// ---------------------------------------------------------------------------
// Every host drives frames the same way: once per vblank/rAF tick it calls
// `globalThis.frame(buttons, lx, ly)` with the PSP button bitmask (spec BTN)
// and the analog stick axes (u8, 0..255, 128 = center). index.ts composes
// input edge-detection + the renderer's end-of-frame sweep into that entry
// point via installFrameHandler. lx/ly are optional trailing args — existing
// apps that only read `buttons` keep working unchanged.

export function installFrameHandler(fn: (buttons: number, lx?: number, ly?: number) => void): void {
  (globalThis as { frame?: (buttons: number, lx?: number, ly?: number) => void }).frame = fn;
}

// ---------------------------------------------------------------------------
// Prop value encoding
// ---------------------------------------------------------------------------

/** Parse '#rgb' | '#rrggbb' | '#rrggbbaa' (web RGB order) into u32 ABGR. */
export function parseHexColor(s: string): number {
  let hex = s.slice(1);
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  if (hex.length !== 6 && hex.length !== 8) {
    throw new Error(`PocketJS: bad color '${s}' (expected #rgb/#rrggbb/#rrggbbaa)`);
  }
  // Full-string validation: parseInt would silently accept a valid PREFIX
  // ("#ff00zz" -> 0xff00) and paint a wrong color instead of throwing.
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`PocketJS: bad color '${s}'`);
  const n = parseInt(hex, 16);
  if (hex.length === 6) {
    return abgr((n >>> 16) & 255, (n >>> 8) & 255, n & 255, 255);
  }
  return abgr((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

/**
 * Encode a JS-side prop value into the single number setProp/animate carries:
 * f32 props pass through, color/int props travel as their u32 bits. Strings
 * are parsed ('#rrggbb' for colors, numeric strings otherwise).
 */
export function encodePropValue(prop: PropName, value: number | string): number {
  const kind = PROP_VALUE_KIND[prop];
  if (typeof value === "string") {
    if (kind === VALUE_KIND.color) return parseHexColor(value);
    const n = Number(value);
    if (Number.isNaN(n)) {
      throw new Error(`PocketJS: non-numeric value '${value}' for prop '${prop}'`);
    }
    value = n;
  }
  if (kind === VALUE_KIND.color || kind === VALUE_KIND.int) return value >>> 0;
  return value;
}
