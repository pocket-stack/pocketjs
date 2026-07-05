// PocketJS spec — THE single source of truth for every cross-language constant.
//
// Everything the TS runtime (src/), the compiler (compiler/), the Rust core
// (core/), the wasm host and the PSP native host agree on is pinned HERE, in
// plain data. `spec/gen-rust.ts` deterministically generates `core/src/spec.rs`
// from this file; `test/contract.ts` regenerates it in-memory and byte-compares
// against the committed file, so TS and Rust can never drift.
//
// Conventions (repo-wide, non-negotiable):
//   - Little-endian EVERYWHERE (PSP, wasm32, x86/ARM hosts are all LE).
//   - Colors are u32 ABGR: bits 0-7 = R, 8-15 = G, 16-23 = B, 24-31 = A
//     (0xAABBGGRR — the PSP GE COLOR_8888 vertex/tex format; matches the
//     dreamcart runtime's Vertex2D color, runtime/src/gfx.rs).
//   - All byte offsets in format comments are from the start of the blob
//     unless stated otherwise.
//
// If you change ANY value here: run `bun spec/gen-rust.ts`, commit the
// regenerated core/src/spec.rs, and bump the relevant format VERSION if the
// change alters a binary layout.

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

/** Logical (and physical PSP) screen size. Every host renders 480x272. */
export const SCREEN_W = 480;
export const SCREEN_H = 272;

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

/** Element kinds — the `type` argument of `createNode`. */
export const NODE_TYPE = {
  view: 0,
  text: 1,
  image: 2,
  // A native video surface: an image-like box whose pixels are supplied every
  // frame by the host's decoder (PSP Media Engine), not the core texture table.
  // The core stays codec-agnostic — a video node carries an opaque decoder
  // handle (node.vid) and emits a VIDEO_QUAD at its laid-out rect; the backend
  // binds the decoder's current frame buffer. See DESIGN.md "Video".
  video: 3,
} as const;

// ---------------------------------------------------------------------------
// Node ids
// ---------------------------------------------------------------------------
// Node handles are generation-tagged i32s: id = (generation << ID_SLOT_BITS) | slot.
// Slot = index into the core node arena; generation increments when a slot is
// reused, so a stale id from JS is detected and the op becomes a no-op.
// Bit 31 stays 0 (ids are always positive); 0 is "no node" (e.g. insertBefore
// anchor 0 = append, setFocus 0 = clear focus).

export const ID_SLOT_BITS = 20;
export const ID_SLOT_MASK = 0xfffff;
/**
 * Maximum tree depth (root = depth 0). `insertBefore` rejects inserts whose
 * parent already sits at the cap (silent no-op, same contract as stale ids).
 * This bounds every recursive tree walk (layout build/readback, paint,
 * subtree destroy) so deep runaway trees cannot overflow the small PSP
 * thread stacks. Far above any real 480x272 UI.
 */
export const MAX_TREE_DEPTH = 64;
/** Node 1 (slot 1, generation 0) is the pre-created full-screen root (flex column). */
export const ROOT_ID = 1;
/** `setStyle(id, STYLE_ID_NONE)` clears the node back to default style. */
export const STYLE_ID_NONE = -1;

/**
 * f32 sentinel for `w-full` / `h-full` (PROP.width/height): 100% of the
 * parent. This is the ONLY percentage v1 supports (DESIGN.md punts the rest).
 * Any negative width/height value is treated as this sentinel by the core;
 * the sentinel is NOT animatable (animate() to/from it is a no-op).
 */
export const SIZE_FULL = -1;

// ---------------------------------------------------------------------------
// UI ops (the `ui.*` native contract — see DESIGN.md table)
// ---------------------------------------------------------------------------
// Numeric codes are the wasm/FFI ABI identity of each op. 0 is reserved
// (invalid/nop). Codes are append-only: never renumber, never reuse.
//
// Signatures (authoritative; hosts marshal them however they like):
//   createNode(type:i32) -> id            destroyNode(id)          [subtree]
//   insertBefore(parent, child, anchorOr0) [DOM move semantics; 0 = append]
//   removeChild(parent, child)             [keeps node alive for re-insert]
//   setStyle(id, styleId)                  [STYLE_ID_NONE clears]
//   setProp(id, propId:i32, value:f64)     [colors/enums pass u32 bits as number]
//   setText(id, str) / replaceText(id, str)         [UTF-8; text nodes only]
//   uploadTexture(buf, w, h, psm) -> handle          [pow2 <= 512, copied]
//   setImage(id, texHandle)                [texHandle < 0 clears the image —
//                                           handles are 0-based, so 0 is real]
//   animate(id, propId, to:f64, durMs, easing, delayMs) -> animId [from = current]
//   cancelAnim(animId)
//   setFocus(idOr0)                        [applies focus: variant natively]
//   loadStyles(buf) / loadFontAtlas(buf)   [web/test hosts only; PSP feeds core
//                                           natively from the pak]
//   measureText(str, fontSlot) -> width:f32
//   videoOpen(path, w, h, loopFlag) -> handle   [open a native decoder for a
//                                           host-fs stream; handle < 0 = failure]
//   videoControl(handle, cmd:VIDEO_CMD, arg)    [play/pause/stop/seek/close]
//   videoBind(nodeId, handle)              [attach a decoder to a video node —
//                                           handle < 0 clears]
//   videoState(handle) -> packed status    [VIDEO_STATE bits | (ptsMs << 8)]
//   These four are OPTIONAL on HostOps: wasm/test hosts that cannot decode omit
//   them and render a placeholder for VIDEO_QUAD instead.

export const OP = {
  createNode: 1,
  destroyNode: 2,
  insertBefore: 3,
  removeChild: 4,
  setStyle: 5,
  setProp: 6,
  setText: 7,
  replaceText: 8,
  uploadTexture: 9,
  setImage: 10,
  animate: 11,
  cancelAnim: 12,
  setFocus: 13,
  loadStyles: 14,
  loadFontAtlas: 15,
  measureText: 16,
  videoOpen: 17,
  videoControl: 18,
  videoBind: 19,
  videoState: 20,
} as const;

// ---------------------------------------------------------------------------
// Video decoder control (native Video component — DESIGN.md "Video")
// ---------------------------------------------------------------------------
// `videoControl(handle, cmd, arg)` command codes. The core never interprets
// these — they cross straight to the host decoder (native/src/video.rs on PSP).
// Append-only.

export const VIDEO_CMD = {
  play: 0,
  pause: 1,
  stop: 2, // stop + rewind to the start (stays open)
  seek: 3, // arg = target position in ms
  close: 4, // tear the decoder down (frees buffers + the decode thread)
} as const;

// `videoState(handle)` low byte: coarse playback state. High bits carry the
// current presentation timestamp in ms (state | (ptsMs << 8)).
export const VIDEO_STATE = {
  idle: 0,
  playing: 1,
  paused: 2,
  ended: 3,
  error: 4,
} as const;

// ---------------------------------------------------------------------------
// Property ids (u8, stable, append-only within each group)
// ---------------------------------------------------------------------------
// Grouped with numeric gaps for growth:
//   1  .. 63   layout      (taffy inputs + display/overflow/z)
//   64 .. 95   visual      (paint-only box decoration)
//   96 .. 127  text        (font + text run styling)
//   128.. 159  transform   (paint-only, never relayouts)
// 0 is reserved (invalid). NEVER renumber a shipped id.

export const PROP = {
  // -- layout (1..63) --------------------------------------------------------
  width: 1, //          f32 px
  height: 2, //         f32 px
  minW: 3, //           f32 px
  minH: 4, //           f32 px
  maxW: 5, //           f32 px
  maxH: 6, //           f32 px
  paddingT: 8, //       f32 px
  paddingR: 9, //       f32 px
  paddingB: 10, //      f32 px
  paddingL: 11, //      f32 px
  marginT: 12, //       f32 px
  marginR: 13, //       f32 px
  marginB: 14, //       f32 px
  marginL: 15, //       f32 px
  gap: 16, //           f32 px (both axes)
  flexDir: 17, //       enum FlexDir
  justify: 18, //       enum Justify
  align: 19, //         enum Align (align-items)
  grow: 20, //          f32
  shrink: 21, //        f32
  basis: 22, //         f32 px
  flexWrap: 23, //      enum: 0 = nowrap, 1 = wrap
  posType: 24, //       enum PosType
  insetT: 25, //        f32 px (absolute positioning offsets)
  insetR: 26, //        f32 px
  insetB: 27, //        f32 px
  insetL: 28, //        f32 px
  display: 29, //       enum Display
  overflow: 30, //      enum Overflow (hidden => scissor in draw)
  zIndex: 31, //        i32 (paint order among siblings; layout-group id but paint-only)

  // -- visual (64..95) -------------------------------------------------------
  bgColor: 64, //       color u32 ABGR
  gradFrom: 65, //      color u32 ABGR (gradient start; used when gradDir set)
  gradTo: 66, //        color u32 ABGR
  gradDir: 67, //       enum GradDir
  radius: 68, //        f32 px corner radius
  opacity: 69, //       f32 0..1 (multiplies subtree alpha per-vertex; see DESIGN punts)
  borderColor: 70, //   color u32 ABGR
  borderWidth: 71, //   f32 px — drawn INSET, purely visual, does NOT affect layout
  shadow: 72, //        i32 baked shadow index: 0 = none, 1 = shadow, 2 = md, 3 = lg

  // -- text (96..127) --------------------------------------------------------
  textColor: 96, //     color u32 ABGR
  fontSlot: 97, //      i32 baked atlas slot (see FONT_ATLAS)
  textAlign: 98, //     enum TextAlign
  lineHeight: 99, //    f32 px (overrides the atlas default)
  tracking: 100, //     f32 px extra advance per glyph

  // -- transform (128..159) — paint-only, never relayouts ---------------------
  translateX: 128, //   f32 px
  translateY: 129, //   f32 px
  scale: 130, //        f32 (1 = identity, about the node center)
  rotate: 131, //       f32 degrees (about the node center)
  scaleX: 132, //       f32 (1 = identity, about the node center)
  scaleY: 133, //       f32 (1 = identity, about the node center)
} as const;

export type PropName = keyof typeof PROP;

// ---------------------------------------------------------------------------
// Animatable props + transition bit mapping
// ---------------------------------------------------------------------------
// ANIMATABLE is an ORDERED list: the index of a prop in this list is its
// "anim bit" — the bit used in the style-table transition `mask` (u32) and in
// core anim bookkeeping. Append-only; never reorder. 30/32 bits used.
// Everything not listed here is NOT animatable (enums, focus, shadow index...).

export const ANIMATABLE: readonly PropName[] = [
  // bit 0..
  "width", //        0
  "height", //       1
  "paddingT", //     2
  "paddingR", //     3
  "paddingB", //     4
  "paddingL", //     5
  "marginT", //      6
  "marginR", //      7
  "marginB", //      8
  "marginL", //      9
  "gap", //         10
  "basis", //       11
  "insetT", //      12
  "insetR", //      13
  "insetB", //      14
  "insetL", //      15
  "bgColor", //     16  (colors lerp per ABGR channel)
  "gradFrom", //    17
  "gradTo", //      18
  "radius", //      19
  "opacity", //     20
  "borderColor", // 21
  "borderWidth", // 22
  "textColor", //   23
  "lineHeight", //  24
  "tracking", //    25
  "translateX", //  26
  "translateY", //  27
  "scale", //       28
  "rotate", //      29
  "scaleX", //      30
  "scaleY", //      31
];

/** Anim bit index for a prop, or -1 if not animatable. */
export function animBit(prop: PropName): number {
  return ANIMATABLE.indexOf(prop);
}

/** Transition mask value meaning "every animatable prop" (transition-all). */
export const TRANSITION_MASK_ALL = 0xffffffff;

// Props whose change invalidates layout (taffy re-run + text re-measure).
// Everything else is paint-only (redraw, no relayout).
//   - zIndex is paint-only despite living in the layout id group.
//   - borderWidth is paint-only (border draws inset).
//   - textAlign/lineHeight/tracking/fontSlot re-run the inline text layout
//     (fontSlot/lineHeight/tracking also change measured size).
export const LAYOUT_DIRTYING: readonly PropName[] = [
  "width", "height", "minW", "minH", "maxW", "maxH",
  "paddingT", "paddingR", "paddingB", "paddingL",
  "marginT", "marginR", "marginB", "marginL",
  "gap", "flexDir", "justify", "align", "grow", "shrink", "basis", "flexWrap",
  "posType", "insetT", "insetR", "insetB", "insetL", "display", "overflow",
  "fontSlot", "textAlign", "lineHeight", "tracking",
];

// ---------------------------------------------------------------------------
// Prop value encoding
// ---------------------------------------------------------------------------
// Every prop value travels as ONE u32 (style table records) or one f64 that
// carries the same u32/f32 payload (setProp / animate). The kind pins how the
// u32 is interpreted:

export const VALUE_KIND = {
  /** IEEE-754 f32 bits (dimensions, scalars, degrees). */
  f32: 0,
  /** Packed color, u32 ABGR (0xAABBGGRR). */
  color: 1,
  /** Plain integer / enum ordinal stored as u32. */
  int: 2,
} as const;

export const PROP_VALUE_KIND: Record<PropName, number> = {
  width: VALUE_KIND.f32, height: VALUE_KIND.f32,
  minW: VALUE_KIND.f32, minH: VALUE_KIND.f32,
  maxW: VALUE_KIND.f32, maxH: VALUE_KIND.f32,
  paddingT: VALUE_KIND.f32, paddingR: VALUE_KIND.f32,
  paddingB: VALUE_KIND.f32, paddingL: VALUE_KIND.f32,
  marginT: VALUE_KIND.f32, marginR: VALUE_KIND.f32,
  marginB: VALUE_KIND.f32, marginL: VALUE_KIND.f32,
  gap: VALUE_KIND.f32,
  flexDir: VALUE_KIND.int, justify: VALUE_KIND.int, align: VALUE_KIND.int,
  grow: VALUE_KIND.f32, shrink: VALUE_KIND.f32, basis: VALUE_KIND.f32,
  flexWrap: VALUE_KIND.int, posType: VALUE_KIND.int,
  insetT: VALUE_KIND.f32, insetR: VALUE_KIND.f32,
  insetB: VALUE_KIND.f32, insetL: VALUE_KIND.f32,
  display: VALUE_KIND.int, overflow: VALUE_KIND.int, zIndex: VALUE_KIND.int,
  bgColor: VALUE_KIND.color, gradFrom: VALUE_KIND.color, gradTo: VALUE_KIND.color,
  gradDir: VALUE_KIND.int, radius: VALUE_KIND.f32, opacity: VALUE_KIND.f32,
  borderColor: VALUE_KIND.color, borderWidth: VALUE_KIND.f32,
  shadow: VALUE_KIND.int,
  textColor: VALUE_KIND.color, fontSlot: VALUE_KIND.int,
  textAlign: VALUE_KIND.int, lineHeight: VALUE_KIND.f32, tracking: VALUE_KIND.f32,
  translateX: VALUE_KIND.f32, translateY: VALUE_KIND.f32,
  scale: VALUE_KIND.f32, rotate: VALUE_KIND.f32,
  scaleX: VALUE_KIND.f32, scaleY: VALUE_KIND.f32,
};

// ---------------------------------------------------------------------------
// Style/layout enums (ordinals are the wire values — append-only)
// ---------------------------------------------------------------------------
// gen-rust.ts turns each entry into a #[repr(u8)] Rust enum of the same name.

export const ENUMS = {
  FlexDir: { Row: 0, Col: 1 },
  Justify: { Start: 0, Center: 1, End: 2, Between: 3, Around: 4 },
  Align: { Start: 0, Center: 1, End: 2, Stretch: 3 },
  PosType: { Relative: 0, Absolute: 1 },
  Display: { Flex: 0, None: 1 },
  Overflow: { Visible: 0, Hidden: 1 },
  TextAlign: { Left: 0, Center: 1, Right: 2 },
  /** Gradient direction: `bg-gradient-to-t|b|l|r`. */
  GradDir: { ToTop: 0, ToBottom: 1, ToLeft: 2, ToRight: 3 },
  /**
   * Animation easing. Spring/SpringBouncy ignore durMs (physics decide);
   * OutBack overshoots ~10%. All tick at fixed dt = 1/60 s.
   */
  Easing: {
    Linear: 0, EaseIn: 1, EaseOut: 2, EaseInOut: 3,
    OutBack: 4, Spring: 5, SpringBouncy: 6,
  },
} as const;

// ---------------------------------------------------------------------------
// PSM texture pixel formats
// ---------------------------------------------------------------------------
// Values MUST equal rust-psp's TexturePixelFormat (sceGuTexMode arg), as used
// by the dreamcart runtime — verified against rust-psp/psp/src/sys/gu.rs
// (Psm4444 = 2, Psm8888 = 3) and runtime/src/gfx3d.rs psm_for(). v1 supports
// only these two (4444 for baked corner/shadow alpha sprites, 8888 for images).

export const PSM = {
  PSM_4444: 2, // RGBA 4444, 16-bit
  PSM_8888: 3, // RGBA 8888, 32-bit
} as const;

/** Textures must be power-of-two and no larger than this per side. */
export const TEX_MAX_DIM = 512;

// ---------------------------------------------------------------------------
// Font slots
// ---------------------------------------------------------------------------
// A "font slot" is one baked (family-weight, px) atlas. The compiler derives
// the slot list from the text-size utilities used (12/14/16/18/20/24/36 px,
// regular + bold — see DESIGN.md). Slot indices are assigned by the build and
// carried in each atlas header; the core just indexes a table.

export const MAX_FONT_SLOTS = 16;

// ---------------------------------------------------------------------------
// STYLE TABLE binary format — styles.bin  (version 1)
// ---------------------------------------------------------------------------
// Compiled by compiler/tailwind.ts; parsed by core/src/style.rs and (for
// tests) by decodeStyleTable below. Little-endian. Records are variable-size
// and written back-to-back with NO padding between fields or records; readers
// must use unaligned LE reads.
//
//   Header (8 bytes):
//     off 0  u32  magic      = 0x54534344  bytes 'D','C','S','T'
//     off 4  u16  version    = 1
//     off 6  u16  styleCount
//
//   Then styleCount records, back-to-back. styleId = record index (0-based).
//
//   Record:
//     off 0  u8   flags
//              bit 0  STYLE_VARIANT_BASE    base variant present
//              bit 1  STYLE_VARIANT_FOCUS   focus: variant present
//              bit 2  STYLE_VARIANT_ACTIVE  active: variant present
//              bit 3  STYLE_HAS_TRANSITION  transition block present
//              bits 4-7 reserved (0)
//     [if STYLE_HAS_TRANSITION] transition block (12 bytes):
//       +0  u32  mask     anim-bit mask of props that transition (see
//                         ANIMATABLE order; TRANSITION_MASK_ALL = all)
//       +4  u16  durMs
//       +6  u16  delayMs
//       +8  u8   easing   (ENUMS.Easing ordinal)
//       +9  u8[3] reserved (0)
//     Then, for each PRESENT variant in order base, focus, active:
//       +0  u8   propCount
//       then propCount x 6-byte prop records:
//         +0  u8   propId    (PROP value)
//         +1  u8   reserved  (0)
//         +2  u32  value     (per PROP_VALUE_KIND: f32 bits | ABGR | int)

export const STYLE_MAGIC = 0x54534344; // 'DCST' LE
export const STYLE_VERSION = 1;
export const STYLE_HEADER_SIZE = 8;
export const STYLE_TRANSITION_SIZE = 12;
export const STYLE_PROP_RECORD_SIZE = 6;

export const STYLE_VARIANT_BASE = 1 << 0;
export const STYLE_VARIANT_FOCUS = 1 << 1;
export const STYLE_VARIANT_ACTIVE = 1 << 2;
export const STYLE_HAS_TRANSITION = 1 << 3;

// ---- style table TS encoder/decoder (used by compiler + tests) ------------

export interface StyleProp {
  /** PROP id. */
  prop: number;
  /** Raw u32 payload (use f32Bits()/abgr() helpers to build it). */
  value: number;
}

export interface StyleTransition {
  /** Anim-bit mask (TRANSITION_MASK_ALL for transition-all). */
  mask: number;
  durMs: number;
  delayMs: number;
  /** ENUMS.Easing ordinal. */
  easing: number;
}

export interface StyleRecord {
  base?: StyleProp[];
  focus?: StyleProp[];
  active?: StyleProp[];
  transition?: StyleTransition;
}

/** IEEE-754 f32 bits of a number, as u32 (round-trips through Math.fround). */
export function f32Bits(n: number): number {
  const buf = new DataView(new ArrayBuffer(4));
  buf.setFloat32(0, n, true);
  return buf.getUint32(0, true);
}

/** f32 value from its u32 bits (inverse of f32Bits). */
export function bitsF32(bits: number): number {
  const buf = new DataView(new ArrayBuffer(4));
  buf.setUint32(0, bits >>> 0, true);
  return buf.getFloat32(0, true);
}

/** Pack a color as u32 ABGR (0xAABBGGRR), the GE COLOR_8888 layout. */
export function abgr(r: number, g: number, b: number, a = 255): number {
  return (((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
}

/** Encode a style table to styles.bin bytes (see format comment above). */
export function encodeStyleTable(styles: readonly StyleRecord[]): Uint8Array {
  if (styles.length > 0xffff) throw new Error("styles.bin: too many styles");
  // size pass
  let size = STYLE_HEADER_SIZE;
  for (const s of styles) {
    size += 1; // flags
    if (s.transition) size += STYLE_TRANSITION_SIZE;
    for (const v of [s.base, s.focus, s.active]) {
      if (!v) continue;
      if (v.length > 0xff) throw new Error("styles.bin: >255 props in a variant");
      size += 1 + v.length * STYLE_PROP_RECORD_SIZE;
    }
  }
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, STYLE_MAGIC, true);
  dv.setUint16(4, STYLE_VERSION, true);
  dv.setUint16(6, styles.length, true);
  let o = STYLE_HEADER_SIZE;
  for (const s of styles) {
    let flags = 0;
    if (s.base) flags |= STYLE_VARIANT_BASE;
    if (s.focus) flags |= STYLE_VARIANT_FOCUS;
    if (s.active) flags |= STYLE_VARIANT_ACTIVE;
    if (s.transition) flags |= STYLE_HAS_TRANSITION;
    out[o++] = flags;
    if (s.transition) {
      dv.setUint32(o, s.transition.mask >>> 0, true);
      dv.setUint16(o + 4, s.transition.durMs, true);
      dv.setUint16(o + 6, s.transition.delayMs, true);
      out[o + 8] = s.transition.easing & 0xff;
      // +9..+12 reserved, already 0
      o += STYLE_TRANSITION_SIZE;
    }
    for (const v of [s.base, s.focus, s.active]) {
      if (!v) continue;
      out[o++] = v.length;
      for (const p of v) {
        out[o] = p.prop & 0xff;
        out[o + 1] = 0;
        dv.setUint32(o + 2, p.value >>> 0, true);
        o += STYLE_PROP_RECORD_SIZE;
      }
    }
  }
  return out;
}

/** Decode styles.bin (round-trips encodeStyleTable; used by tests). */
export function decodeStyleTable(bytes: Uint8Array): StyleRecord[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== STYLE_MAGIC) throw new Error("styles.bin: bad magic");
  if (dv.getUint16(4, true) !== STYLE_VERSION) throw new Error("styles.bin: bad version");
  const count = dv.getUint16(6, true);
  const styles: StyleRecord[] = [];
  let o = STYLE_HEADER_SIZE;
  for (let i = 0; i < count; i++) {
    const flags = bytes[o++];
    const s: StyleRecord = {};
    if (flags & STYLE_HAS_TRANSITION) {
      s.transition = {
        mask: dv.getUint32(o, true),
        durMs: dv.getUint16(o + 4, true),
        delayMs: dv.getUint16(o + 6, true),
        easing: bytes[o + 8],
      };
      o += STYLE_TRANSITION_SIZE;
    }
    const variants: Array<"base" | "focus" | "active"> = [];
    if (flags & STYLE_VARIANT_BASE) variants.push("base");
    if (flags & STYLE_VARIANT_FOCUS) variants.push("focus");
    if (flags & STYLE_VARIANT_ACTIVE) variants.push("active");
    for (const name of variants) {
      const n = bytes[o++];
      const props: StyleProp[] = [];
      for (let j = 0; j < n; j++) {
        props.push({ prop: bytes[o], value: dv.getUint32(o + 2, true) });
        o += STYLE_PROP_RECORD_SIZE;
      }
      s[name] = props;
    }
    styles.push(s);
  }
  return styles;
}

// ---------------------------------------------------------------------------
// FONT ATLAS binary format  (version 2)
// ---------------------------------------------------------------------------
// One blob per font slot, baked by compiler/bake-font.ts, parsed by
// core/src/text.rs. Glyph coverage is stored in fixed-size cells as one
// alpha byte per pixel, generated from horizontally-biased supersampling for
// smoother subpixel positioning.
//
//   Header (16 bytes):
//     off  0  u32  magic      = 0x41464344  bytes 'D','C','F','A'
//     off  4  u16  version    = 2
//     off  6  u16  glyphCount (including gid 0 = tofu box)
//     off  8  u8   cellW      cell width in px  (coverage cells are cellW x cellH)
//     off  9  u8   cellH      cell height in px
//     off 10  u8   baseline   px from cell TOP to the baseline
//     off 11  u8   lineHeight default line advance in px
//     off 12  u8   fontSlot   slot index this atlas binds (0..MAX_FONT_SLOTS-1)
//     off 13  u8   flags      bit 0 = bold; bits 1-7 reserved (0)
//     off 14  u16  reserved   (0)
//
//   cmap (glyphCount x 8 bytes) at FONT_HEADER_SIZE, SORTED ASCENDING by
//   codepoint so lookups binary-search. A codepoint miss resolves to gid 0
//   (tofu) and bumps the core's miss counter.
//     +0  u32  codepoint  (Unicode scalar)
//     +4  u16  gid        (0..glyphCount-1; index into the bitmap region)
//     +6  u8   advance    px advance for this glyph
//     +7  u8   xoff       left-side-bearing shift: px the outline was shifted
//                         RIGHT at bake so negative-LSB ink (î ï ĥ ǰ accents)
//                         stays inside the cell. Renderers place the cell at
//                         penX - xoff. 0 for most glyphs (was reserved; old
//                         atlases with 0 here remain valid).
//
//   coverage region at FONT_HEADER_SIZE + glyphCount*FONT_CMAP_ENTRY_SIZE:
//     glyphCount x cellH x cellW bytes. Each byte is alpha coverage 0..255
//     for one pixel, left-to-right, top row first. Glyph g's rows start at
//     coverageOffset + g * cellH * cellW.
//
//   gid 0 MUST be the tofu box (drawn for unmapped codepoints).

export const FONT_MAGIC = 0x41464344; // 'DCFA' LE
export const FONT_VERSION = 2;
export const FONT_HEADER_SIZE = 16;
export const FONT_CMAP_ENTRY_SIZE = 8;
export const FONT_FLAG_BOLD = 1 << 0;

// ---------------------------------------------------------------------------
// DRAWLIST op format  (core -> backend)
// ---------------------------------------------------------------------------
// The core's draw() output is a flat Vec<u32> of little-endian words (in TS a
// Uint32Array). Each op = 1 header word + fixed/derivable payload words, so a
// backend can also skip unknown ops... except there are none: the set below is
// closed per DrawList version; core and backend ship together.
//
// Word packings:
//   XY word:  bits 0-15  = x as i16 (two's complement)
//             bits 16-31 = y as i16
//   WH word:  bits 0-15  = w as u16, bits 16-31 = h as u16
//   f32s are stored as their IEEE-754 bits in one word.
//   colors are u32 ABGR.
//
// GUARANTEE (the core's CPU clip stage): every coordinate a backend receives
// is already clipped to [0, SCREEN_W] x [0, SCREEN_H] — always i16-safe, never
// negative, never off-screen. Backends do NO clipping (the PSP GE would wrap
// i16 coords otherwise).
//
// Ops (header word = op code; total word counts include the header):
//   RECT        (4 words):  op, xy, wh, color
//   GRAD_RECT   (6 words):  op, xy, wh, colorFrom, colorTo, dir (GradDir u32)
//   GLYPH_RUN   (3 + 2n):   op,
//                           word1: bits 0-7 fontSlot, bits 8-15 reserved(0),
//                                  bits 16-31 glyph count n (u16),
//                           word2: color,
//                           then n x { xy (glyph cell top-left),
//                                      word: bits 0-15 gid, bits 16-31 reserved(0) }
//   TEX_QUAD    (9 words):  op, texHandle, xy, wh, u0, v0, u1, v1 (f32 bits,
//                           normalized 0..1), color (modulate; 0xFFFFFFFF = none)
//   VIDEO_QUAD  (9 words):  op, vidHandle, xy, wh, u0, v0, u1, v1 (f32 bits,
//                           normalized 0..1), color — identical shape to TEX_QUAD
//                           but the handle is an OPAQUE host decoder handle, not
//                           a core texture id. The backend samples the decoder's
//                           current frame buffer (PSP: the front video surface).
//                           A backend that cannot decode draws a placeholder.
//   SCISSOR     (3 words):  op, xy, wh — push clip rect. The core emits rects
//                           already intersected with every enclosing scissor,
//                           so backends just SET the rect (a depth counter,
//                           not a rect stack, still needs the pop's restore —
//                           backends keep a stack of the received rects).
//   SCISSOR_POP (1 word):   op — restore the previous scissor (screen if empty).
//                           Core guarantees balanced SCISSOR/SCISSOR_POP.
//   TRI         (7 words):  op, xy0, xy1, xy2, color0, color1, color2 — one
//                           CPU-clipped screen-space triangle (gouraud when the
//                           corner colors differ, flat otherwise). The core
//                           emits these only for ROTATED solid/gradient boxes
//                           after Sutherland-Hodgman clipping; axis-aligned
//                           content always uses RECT/GRAD_RECT.

export const DRAW_OP = {
  rect: 1,
  gradRect: 2,
  glyphRun: 3,
  texQuad: 4,
  scissor: 5,
  scissorPop: 6,
  tri: 7,
  videoQuad: 8,
} as const;

// ---------------------------------------------------------------------------
// PAK container constants
// ---------------------------------------------------------------------------
// PocketJS packs (styles.bin, font atlases, images) reuse the dreamcart .pak
// container byte-for-byte so existing tooling can open them. Values copied
// from dreamcart framework/bake/pak.ts + docs/pak-format.md (v1).
// Header: magic u32, version u16, flags u16, entryCount u32, dirOffset u32,
// namesOffset u32, blobsOffset u32 (16-aligned), fileSize u32, reserved u32.
// Entry: keyHash(fnv1a) u32, blobOff u32, byteLen u32, nameOff u32,
// nameLen u16, dtype u8, reserved u8, reserved u32. Entries sorted by key;
// blobs 16-byte aligned.

export const PAK_MAGIC = 0x4b504344; // 'DCPK' LE
export const PAK_VERSION = 1;
export const PAK_HEADER_SIZE = 32;
export const PAK_ENTRY_SIZE = 24;
export const PAK_ALIGN = 16;
/** FNV-1a 32-bit params for entry keyHash (h ^= byte; h *= prime). */
export const PAK_FNV1A_OFFSET_BASIS = 0x811c9dc5;
export const PAK_FNV1A_PRIME = 0x01000193;

/** pak dtype codes (advisory element type of a blob). */
export const PAK_DTYPE = {
  u8: 0, i8: 1, u16: 2, i16: 3, u32: 4, i32: 5, f32: 6, f64: 7,
} as const;

// ---------------------------------------------------------------------------
// PSP button bitmask (identical on every host — Web/Bun hosts remap keys)
// ---------------------------------------------------------------------------
// Verified against dreamcart web/engine.js (BTN), framework/src/input.ts (Btn)
// and rust-psp/psp/src/sys/ctrl.rs (CtrlButtons).

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
} as const;

// ---------------------------------------------------------------------------
// Fixed timestep
// ---------------------------------------------------------------------------
/** Core animation/tick timestep: exactly 1/60 s. Frame content is a pure
 *  function of frame index — this is what makes byte-exact goldens possible. */
export const FIXED_DT = 1 / 60;
