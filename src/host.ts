// Host binding layer — the JS side of the `ui.*` native contract (DESIGN.md
// table, codes pinned in spec/spec.ts OP). Every op is SYNCHRONOUS; the
// renderer keeps a JS mirror tree so reconciler reads never cross this
// boundary.
//
// Two host kinds:
//   - "native":   QuickJS on a framework-owned device runtime — the native
//                 bin installs a `globalThis.ui` namespace. NON-strict:
//                 unknown classes/textures bump a counter instead of throwing
//                 (a crash on hardware is worse than a missing style).
//   - "injected": web/wasm/Bun-test hosts pass their own HostOps object into
//                 render(). Strict: unknown classes/textures throw loudly.

import {
  abgr,
  PROP_VALUE_KIND,
  VALUE_KIND,
  type PropName,
} from "../spec/spec.ts";

// Replaced by scripts/build.ts for manifest-driven builds. `typeof` keeps
// legacy/test bundles valid until they opt into a ResolvedBuildPlan.
declare const __POCKET_TARGET__: string;
declare const __POCKET_HOST_ABI__: number;
declare const __POCKET_CONTRACT_HASH__: string;

export interface BuildHostContract {
  readonly target: string;
  readonly hostAbi: number;
  readonly contractHash: string;
}

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

  // -- streamed textures (spec ops 23..25) — deep-zoom tile canvases. Native
  //    hosts (PSP, uihost) implement loadTileTexture so tile bytes never
  //    transit the JS heap; hosts without it fall back to __pak +
  //    uploadTexture in src/tiles.ts. -------------------------------------
  /** Decode tile `index` of a TILESET pak entry (`key`) into a texture.
   *  → generation-tagged handle, or -1 (absent/solid/malformed tile). */
  loadTileTexture?(key: string, index: number): number;
  /** Release a texture slot. The handle is dead afterwards (stale handles
   *  draw nothing — handles are generation-tagged, spec TEX_SLOT_BITS). */
  freeTexture?(handle: number): void;
  /** Upload a self-contained IMG entry blob (compiler/pak.ts layout, incl.
   *  PSM_T8 palette + RLE/filter flags). → handle or -1. */
  uploadImgEntry?(blob: Uint8Array): number;

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
  /** Framework target/profile identity (for example "psp" or "vita"). */
  __host?: string;
  /** Version of the JS/native HostOps ABI implemented by this namespace. */
  __hostAbi?: number;
  /** Hash of the exact ResolvedBuildPlan embedded into the native package. */
  __contractHash?: string;
}

export interface Host {
  ops: HostOps;
  /** Transport/ownership, deliberately independent from the target name. */
  kind: "native" | "injected";
  /** Target/profile reported by the host; "injected" for test/web adapters. */
  target: string;
  /** Strict hosts throw on unknown class/src; native hosts count silently. */
  strict: boolean;
}

let current: Host | null = null;

export function embeddedBuildHostContract(): BuildHostContract | null {
  const target = typeof __POCKET_TARGET__ === "string" ? __POCKET_TARGET__ : "";
  const hostAbi = typeof __POCKET_HOST_ABI__ === "number" ? __POCKET_HOST_ABI__ : 0;
  const contractHash =
    typeof __POCKET_CONTRACT_HASH__ === "string" ? __POCKET_CONTRACT_HASH__ : "";
  return target && hostAbi > 0 && contractHash ? { target, hostAbi, contractHash } : null;
}

/** Fail before mounting when a bundle was packaged with the wrong native host. */
export function assertNativeHostContract(
  ops: HostOps,
  expected: BuildHostContract | null = embeddedBuildHostContract(),
): void {
  if (!expected) return;
  if (ops.__host !== expected.target) {
    throw new Error(
      `PocketJS: native target mismatch (bundle=${expected.target}, host=${ops.__host ?? "missing"})`,
    );
  }
  if (ops.__hostAbi !== expected.hostAbi) {
    throw new Error(
      `PocketJS: native host ABI mismatch (bundle=${expected.hostAbi}, host=${ops.__hostAbi ?? "missing"})`,
    );
  }
  if (ops.__contractHash !== expected.contractHash) {
    throw new Error(
      `PocketJS: build contract mismatch (bundle=${expected.contractHash}, host=${ops.__contractHash ?? "missing"})`,
    );
  }
}

/**
 * Resolve the host: injected ops win; otherwise `globalThis.ui` (native
 * QuickJS).
 * Throws when neither exists — PocketJS cannot run without a native tree.
 *
 * Exception: when the injected ops ARE a self-identified native namespace
 * (demo entries commonly pass `globalThis.ui` explicitly), object identity
 * plus `ui.__host` keeps it native and non-strict. Web/wasm adapters also
 * publish `globalThis.ui`, but intentionally omit `__host` and stay injected.
 * No texture-table or target-specific feature detection is involved.
 */
export function detectHost(injected?: HostOps): Host {
  const native = (globalThis as { ui?: HostOps }).ui;
  if (injected) {
    if (native !== undefined && injected === native && typeof native.__host === "string") {
      assertNativeHostContract(native);
      return { ops: injected, kind: "native", target: native.__host, strict: false };
    }
    return { ops: injected, kind: "injected", target: injected.__host ?? "injected", strict: true };
  }
  if (native && typeof native.__host === "string") {
    assertNativeHostContract(native);
    return { ops: native, kind: "native", target: native.__host, strict: false };
  }
  if (native) {
    return { ops: native, kind: "injected", target: "injected", strict: true };
  }
  throw new Error(
    "PocketJS: no host — pass HostOps to render() (web/test) or run under a native runtime (globalThis.ui)",
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
// `globalThis.frame(buttons, analog?)` with the PSP button bitmask (spec BTN)
// and, when the host has an analog stick, the packed nub value
// (x << 8 | y, each axis 0..255, 128 = center — spec ANALOG_CENTER). Hosts
// without a stick pass one argument; the runtime defaults to center, so every
// pre-analog host, tape and golden is unchanged. index.ts composes input
// edge-detection + the renderer's end-of-frame sweep into that entry point
// via installFrameHandler.

export function installFrameHandler(fn: (buttons: number, analog?: number) => void): void {
  (globalThis as { frame?: (buttons: number, analog?: number) => void }).frame = fn;
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
