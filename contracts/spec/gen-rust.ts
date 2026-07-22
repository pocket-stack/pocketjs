// Deterministic codegen: contracts/spec/spec.ts -> engine/core/src/spec.rs.
//
// Run from PocketJS/:  bun contracts/spec/gen-rust.ts
//
// tests/contract.ts imports generateRust() and byte-compares its output against
// the committed engine/core/src/spec.rs, so the generated file can never drift from
// spec.ts. Keep this generator free of anything non-deterministic (no dates,
// no env, no object-key sorting surprises — insertion order only).

import {
  ANALOG_CENTER,
  ANIMATABLE,
  ANIM_BEZIER_EXTRA_SIZE,
  ANIM_ENTRY_HEADER_SIZE,
  ANIM_FILL_BACKWARDS,
  ANIM_FILL_FORWARDS,
  ANIM_SEGMENT_SIZE,
  BTN,
  IMG_FLAG_LINEAR,
  IMG_FLAG_RLE,
  PAK_ALIGN,
  PAK_DTYPE,
  PAK_ENTRY_SIZE,
  PAK_FNV1A_OFFSET_BASIS,
  PAK_FNV1A_PRIME,
  PAK_HEADER_SIZE,
  PAK_MAGIC,
  PAK_VERSION,
  DRAW_OP,
  ENUMS,
  FIXED_DT,
  FONT_CMAP_ENTRY_SIZE,
  FONT_FLAG_BOLD,
  FONT_HEADER_SIZE,
  FONT_MAGIC,
  FONT_VERSION,
  ID_SLOT_BITS,
  ID_SLOT_MASK,
  LAYOUT_DIRTYING,
  MAX_FONT_SLOTS,
  MAX_TREE_DEPTH,
  NODE_TYPE,
  OP,
  PROP,
  PROP_VALUE_KIND,
  PSM,
  ROOT_ID,
  SCREEN_H,
  SCREEN_W,
  SIZE_FULL,
  STYLE_HAS_ANIMATION,
  STYLE_HAS_TRANSITION,
  STYLE_HEADER_SIZE,
  STYLE_ID_NONE,
  STYLE_MAGIC,
  STYLE_PROP_RECORD_SIZE,
  STYLE_TRANSITION_SIZE,
  STYLE_VARIANT_ACTIVE,
  STYLE_VARIANT_BASE,
  STYLE_VARIANT_FOCUS,
  STYLE_VERSION,
  STREAM_ARING_MAGIC,
  STREAM_ARING_OFF,
  STREAM_CHUNK_HEADER_SIZE,
  STREAM_FLAG_ENDED,
  STREAM_HEADER_BLOCK_SIZE,
  STREAM_HEADER_SIZE,
  STREAM_MAGIC,
  STREAM_SLOT_HEADER_SIZE,
  STREAM_VERSION,
  STREAM_VRING_MAGIC,
  STREAM_VRING_OFF,
  SVC_IMG_MAX_BYTES,
  SVC_POLL_BUF,
  TEX_MAX_DIM,
  TEX_SLOT_BITS,
  TEX_SLOT_MASK,
  TILESET_ABSENT,
  TILESET_DIR_ENTRY_SIZE,
  TILESET_FLAG_LINEAR,
  TILESET_FLAG_RLE,
  TILESET_HEADER_SIZE,
  TILESET_MAGIC,
  TILESET_VERSION,
  TRANSITION_MASK_ALL,
  VALUE_KIND,
  type PropName,
} from "./spec.ts";

/** camelCase -> SCREAMING_SNAKE_CASE (width -> WIDTH, paddingT -> PADDING_T). */
function screaming(name: string): string {
  return name.replace(/([A-Z])/g, "_$1").toUpperCase();
}

function hex(n: number, pad = 8): string {
  return "0x" + (n >>> 0).toString(16).padStart(pad, "0");
}

/** [u64; 4] bitset literal over u8 prop ids. */
function bitset(props: readonly PropName[]): string {
  const words = [0n, 0n, 0n, 0n];
  for (const p of props) {
    const id = PROP[p];
    words[id >> 6] |= 1n << BigInt(id & 63);
  }
  return `[${words.map((w) => "0x" + w.toString(16).padStart(16, "0")).join(", ")}]`;
}

/** [u8; 256] literal from a sparse map (0xff = unassigned), 16 per line. */
function u8Table(get: (id: number) => number): string {
  const rows: string[] = [];
  for (let base = 0; base < 256; base += 16) {
    const row: string[] = [];
    for (let i = base; i < base + 16; i++) row.push("0x" + get(i).toString(16).padStart(2, "0"));
    rows.push("    " + row.join(", ") + ",");
  }
  return "[\n" + rows.join("\n") + "\n]";
}

export function generateRust(): string {
  const L: string[] = [];
  const put = (s = "") => L.push(s);

  put("//! GENERATED — do not edit; run `bun contracts/spec/gen-rust.ts` (from PocketJS/).");
  put("//!");
  put("//! Source of truth: PocketJS/spec/spec.ts — every constant here mirrors it.");
  put("//! tests/contract.ts regenerates this file in-memory and byte-compares;");
  put("//! if that fails, run `bun contracts/spec/gen-rust.ts` and commit the result.");
  put("");
  put("#![allow(dead_code)]");
  put("#![allow(clippy::all)]");
  put("");

  // --- scalars ---------------------------------------------------------------
  put("/// Logical (and physical PSP) screen size.");
  put(`pub const SCREEN_W: u32 = ${SCREEN_W};`);
  put(`pub const SCREEN_H: u32 = ${SCREEN_H};`);
  put("");
  put("/// Node ids are generation-tagged: id = (generation << ID_SLOT_BITS) | slot.");
  put("/// Bit 31 stays 0; id 0 = \"no node\" (append anchor / clear focus).");
  put(`pub const ID_SLOT_BITS: u32 = ${ID_SLOT_BITS};`);
  put(`pub const ID_SLOT_MASK: u32 = ${hex(ID_SLOT_MASK, 5)};`);
  put("/// Maximum tree depth (root = depth 0). insert_before rejects inserts whose");
  put("/// parent already sits at the cap (silent no-op, stale-id contract) so every");
  put("/// recursive tree walk stays bounded on small PSP thread stacks.");
  put(`pub const MAX_TREE_DEPTH: u32 = ${MAX_TREE_DEPTH};`);
  put("/// Node 1 (slot 1, gen 0) is the pre-created full-screen root (flex column).");
  put(`pub const ROOT_ID: i32 = ${ROOT_ID};`);
  put("/// `set_style(id, STYLE_ID_NONE)` clears a node back to default style.");
  put(`pub const STYLE_ID_NONE: i32 = ${STYLE_ID_NONE};`);
  put("/// f32 sentinel for `w-full`/`h-full` (prop::WIDTH/HEIGHT): 100% of the");
  put("/// parent. Any negative width/height is treated as this sentinel; it is");
  put("/// NOT animatable (tweens to/from it are no-ops).");
  if (SIZE_FULL !== -1) throw new Error("SIZE_FULL changed; update gen-rust.ts emission");
  put("pub const SIZE_FULL: f32 = -1.0;");
  put("");
  put("/// Textures must be power-of-two and no larger than this per side.");
  put(`pub const TEX_MAX_DIM: u32 = ${TEX_MAX_DIM};`);
  put("/// Texture handles are generation-tagged like node ids:");
  put("/// handle = (generation << TEX_SLOT_BITS) | slot; bit 31 stays 0.");
  put(`pub const TEX_SLOT_BITS: u32 = ${TEX_SLOT_BITS};`);
  put(`pub const TEX_SLOT_MASK: u32 = ${hex(TEX_SLOT_MASK, 5)};`);
  put("/// Max baked font-atlas slots.");
  put(`pub const MAX_FONT_SLOTS: usize = ${MAX_FONT_SLOTS};`);
  put("/// Transition mask value meaning \"every animatable prop\".");
  put(`pub const TRANSITION_MASK_ALL: u32 = ${hex(TRANSITION_MASK_ALL)};`);
  put("/// Core tick timestep: exactly 1/60 s (fixed — enables byte-exact goldens).");
  if (FIXED_DT !== 1 / 60) throw new Error("FIXED_DT changed; update gen-rust.ts emission");
  put("pub const FIXED_DT: f32 = 1.0 / 60.0;");
  put("");

  // --- node type enum ---------------------------------------------------------
  put("/// Element kinds — the `create_node` argument.");
  put("#[repr(u8)]");
  put("#[derive(Clone, Copy, PartialEq, Eq, Debug)]");
  put("pub enum NodeType {");
  for (const [name, v] of Object.entries(NODE_TYPE)) {
    put(`    ${name[0].toUpperCase()}${name.slice(1)} = ${v},`);
  }
  put("}");
  put("");

  // --- op codes ---------------------------------------------------------------
  put("/// UI op codes (the engine/wasm/FFI ABI identity of each `ui.*` op; 0 reserved).");
  put("/// Signatures are documented in spec.ts and docs/DESIGN.md.");
  put("pub mod op {");
  for (const [name, v] of Object.entries(OP)) {
    put(`    pub const ${screaming(name)}: u8 = ${v};`);
  }
  put("}");
  put("");

  // --- prop ids ---------------------------------------------------------------
  put("/// Property ids (u8, stable, append-only). Groups:");
  put("/// 1..63 layout | 64..95 visual | 96..127 text | 128..159 transform.");
  put("pub mod prop {");
  for (const [name, v] of Object.entries(PROP)) {
    put(`    pub const ${screaming(name)}: u8 = ${v};`);
  }
  put("}");
  put("");

  // --- value kinds --------------------------------------------------------------
  put("/// How a prop's u32 payload is interpreted (see spec.ts VALUE_KIND).");
  put("pub mod value_kind {");
  for (const [name, v] of Object.entries(VALUE_KIND)) {
    put(`    pub const ${screaming(name)}: u8 = ${v};`);
  }
  put("}");
  put("");
  put("/// PROP_VALUE_KIND[prop id] -> value_kind (0xff = unassigned id).");
  const kindById = new Map<number, number>();
  for (const [name, id] of Object.entries(PROP)) {
    kindById.set(id, PROP_VALUE_KIND[name as PropName]);
  }
  put(`pub const PROP_VALUE_KIND: [u8; 256] = ${u8Table((id) => kindById.get(id) ?? 0xff)};`);
  put("");

  // --- animatable / layout-dirtying ---------------------------------------------
  put("/// ANIM_BIT[prop id] -> transition-mask bit index (0xff = not animatable).");
  put("/// The bit order is spec.ts ANIMATABLE order — append-only.");
  const animBitById = new Map<number, number>();
  ANIMATABLE.forEach((name, bit) => animBitById.set(PROP[name], bit));
  put(`pub const ANIM_BIT: [u8; 256] = ${u8Table((id) => animBitById.get(id) ?? 0xff)};`);
  put("");
  put("/// Bitset over prop ids: animatable props (tween/spring/transition targets).");
  put(`pub const ANIMATABLE_BITS: [u64; 4] = ${bitset(ANIMATABLE)};`);
  put("/// Bitset over prop ids: props whose change invalidates layout.");
  put(`pub const LAYOUT_DIRTY_BITS: [u64; 4] = ${bitset(LAYOUT_DIRTYING)};`);
  put("");
  put("pub const fn is_animatable(prop: u8) -> bool {");
  put("    ANIMATABLE_BITS[(prop >> 6) as usize] & (1u64 << (prop & 63)) != 0");
  put("}");
  put("pub const fn is_layout_dirtying(prop: u8) -> bool {");
  put("    LAYOUT_DIRTY_BITS[(prop >> 6) as usize] & (1u64 << (prop & 63)) != 0");
  put("}");
  put("");

  // --- enums ------------------------------------------------------------------
  const enumDocs: Record<string, string> = {
    FlexDir: "flex-direction.",
    Justify: "justify-content.",
    Align: "align-items.",
    PosType: "position type.",
    Display: "display (None removes from layout AND paint).",
    Overflow: "overflow (Hidden => scissor in draw).",
    TextAlign: "text alignment within the node box.",
    GradDir: "gradient direction (`bg-gradient-to-t|b|l|r`).",
    Easing:
      "animation easing. Spring/SpringBouncy ignore durMs (physics decide); OutBack overshoots ~10%.",
  };
  for (const [ename, variants] of Object.entries(ENUMS)) {
    put(`/// ${enumDocs[ename] ?? ename}`);
    put("#[repr(u8)]");
    put("#[derive(Clone, Copy, PartialEq, Eq, Debug)]");
    put(`pub enum ${ename} {`);
    for (const [vname, v] of Object.entries(variants)) {
      put(`    ${vname} = ${v},`);
    }
    put("}");
    put("");
  }

  // --- psm --------------------------------------------------------------------
  put("/// PSM texture pixel formats — MUST equal rust-psp TexturePixelFormat");
  put("/// (sceGuTexMode arg; verified against rust-psp/psp/src/sys/gu.rs).");
  put("/// PSM_T8 (CLUT8) uploads as: 1024-byte palette (256 x u32 ABGR), then");
  put("/// w*h index bytes.");
  put("pub mod psm {");
  for (const [name, v] of Object.entries(PSM)) {
    put(`    pub const ${name}: u32 = ${v};`);
  }
  put("}");
  put("");

  // --- img entry flags ------------------------------------------------------------
  put("/// IMG entry flags (framework/compiler/pak.ts IMG entry byte 5; v1 wrote 0).");
  put("pub mod img {");
  put(`    pub const FLAG_RLE: u8 = ${IMG_FLAG_RLE}; // pixel stream is PackBits-RLE`);
  put(`    pub const FLAG_LINEAR: u8 = ${IMG_FLAG_LINEAR}; // bilinear sampling`);
  put("}");
  put("");

  // --- tileset ---------------------------------------------------------------------
  put("/// TILESET pak entry (deep-zoom tile grids; full layout in spec.ts).");
  put("/// One shared 256-color palette per entry; solid tiles live in the dir.");
  put("pub mod tileset {");
  put(`    pub const MAGIC: u32 = ${hex(TILESET_MAGIC)}; // 'PKTS' LE`);
  put(`    pub const VERSION: u16 = ${TILESET_VERSION};`);
  put(`    pub const HEADER_SIZE: usize = ${TILESET_HEADER_SIZE};`);
  put(`    pub const DIR_ENTRY_SIZE: usize = ${TILESET_DIR_ENTRY_SIZE};`);
  put(`    pub const ABSENT: u32 = ${hex(TILESET_ABSENT)};`);
  put(`    pub const FLAG_RLE: u16 = ${TILESET_FLAG_RLE};`);
  put(`    pub const FLAG_LINEAR: u16 = ${TILESET_FLAG_LINEAR};`);
  put("}");
  put("");

  // --- svc / stream -----------------------------------------------------------
  put("/// Host service channel limits (spec.ts SVC — pocket-svc/<app>/ mailbox).");
  put("pub mod svc {");
  put(`    pub const POLL_BUF: usize = ${SVC_POLL_BUF};`);
  put(`    pub const IMG_MAX_BYTES: usize = ${SVC_IMG_MAX_BYTES};`);
  put("}");
  put("");
  put("/// STREAM container (.pkst) — host-written video+audio ring file.");
  put("/// Full byte layout in spec.ts; parsed by engine/core/src/stream.rs.");
  put("pub mod stream {");
  put(`    pub const MAGIC: u32 = ${hex(STREAM_MAGIC)}; // 'PKST' LE`);
  put(`    pub const VERSION: u16 = ${STREAM_VERSION};`);
  put(`    pub const HEADER_SIZE: usize = ${STREAM_HEADER_SIZE};`);
  put(`    pub const VRING_MAGIC: u32 = ${hex(STREAM_VRING_MAGIC)}; // 'PKVR' LE`);
  put(`    pub const VRING_OFF: usize = ${STREAM_VRING_OFF};`);
  put(`    pub const ARING_MAGIC: u32 = ${hex(STREAM_ARING_MAGIC)}; // 'PKAR' LE`);
  put(`    pub const ARING_OFF: usize = ${STREAM_ARING_OFF};`);
  put(`    pub const HEADER_BLOCK_SIZE: usize = ${STREAM_HEADER_BLOCK_SIZE};`);
  put(`    pub const SLOT_HEADER_SIZE: usize = ${STREAM_SLOT_HEADER_SIZE};`);
  put(`    pub const CHUNK_HEADER_SIZE: usize = ${STREAM_CHUNK_HEADER_SIZE};`);
  put(`    pub const FLAG_ENDED: u16 = ${STREAM_FLAG_ENDED};`);
  put("}");
  put("");

  // --- style table --------------------------------------------------------------
  put("/// STYLE TABLE (styles.bin) format constants — full layout in spec.ts.");
  put("pub mod style_table {");
  put(`    pub const MAGIC: u32 = ${hex(STYLE_MAGIC)}; // 'DCST' LE`);
  put(`    pub const VERSION: u16 = ${STYLE_VERSION};`);
  put(`    pub const HEADER_SIZE: usize = ${STYLE_HEADER_SIZE};`);
  put(`    pub const TRANSITION_SIZE: usize = ${STYLE_TRANSITION_SIZE};`);
  put(`    pub const PROP_RECORD_SIZE: usize = ${STYLE_PROP_RECORD_SIZE};`);
  put(`    pub const VARIANT_BASE: u8 = ${STYLE_VARIANT_BASE};`);
  put(`    pub const VARIANT_FOCUS: u8 = ${STYLE_VARIANT_FOCUS};`);
  put(`    pub const VARIANT_ACTIVE: u8 = ${STYLE_VARIANT_ACTIVE};`);
  put(`    pub const HAS_TRANSITION: u8 = ${STYLE_HAS_TRANSITION};`);
  put(`    pub const HAS_ANIMATION: u8 = ${STYLE_HAS_ANIMATION};`);
  put(`    pub const ANIM_ENTRY_HEADER_SIZE: usize = ${ANIM_ENTRY_HEADER_SIZE};`);
  put(`    pub const ANIM_SEGMENT_SIZE: usize = ${ANIM_SEGMENT_SIZE};`);
  put(`    pub const ANIM_BEZIER_EXTRA_SIZE: usize = ${ANIM_BEZIER_EXTRA_SIZE};`);
  put(`    pub const ANIM_FILL_BACKWARDS: u8 = ${ANIM_FILL_BACKWARDS};`);
  put(`    pub const ANIM_FILL_FORWARDS: u8 = ${ANIM_FILL_FORWARDS};`);
  put("}");
  put("");

  // --- font atlas ---------------------------------------------------------------
  put("/// FONT ATLAS blob format constants — full layout in spec.ts.");
  put("pub mod font_atlas {");
  put(`    pub const MAGIC: u32 = ${hex(FONT_MAGIC)}; // 'DCFA' LE`);
  put(`    pub const VERSION: u16 = ${FONT_VERSION};`);
  put(`    pub const HEADER_SIZE: usize = ${FONT_HEADER_SIZE};`);
  put(`    pub const CMAP_ENTRY_SIZE: usize = ${FONT_CMAP_ENTRY_SIZE};`);
  put(`    pub const FLAG_BOLD: u8 = ${FONT_FLAG_BOLD};`);
  put("}");
  put("");

  // --- drawlist ------------------------------------------------------------------
  put("/// DrawList op codes (core -> backend Vec<u32> words; layout in spec.ts).");
  put("/// Word counts incl. header: RECT 4, GRAD_RECT 6, GLYPH_RUN 3+2n,");
  put("/// TEX_QUAD 9, SCISSOR 3, SCISSOR_POP 1, TRI 7.");
  put("pub mod draw_op {");
  for (const [name, v] of Object.entries(DRAW_OP)) {
    put(`    pub const ${screaming(name)}: u32 = ${v};`);
  }
  put("}");
  put("");

  // --- pak ----------------------------------------------------------------------
  put("/// .pak container constants (byte-compatible with dreamcart's format;");
  put("/// copied from framework/bake/pak.ts + docs/pak-format.md).");
  put("pub mod pak {");
  put(`    pub const MAGIC: u32 = ${hex(PAK_MAGIC)}; // 'DCPK' LE`);
  put(`    pub const VERSION: u16 = ${PAK_VERSION};`);
  put(`    pub const HEADER_SIZE: usize = ${PAK_HEADER_SIZE};`);
  put(`    pub const ENTRY_SIZE: usize = ${PAK_ENTRY_SIZE};`);
  put(`    pub const ALIGN: usize = ${PAK_ALIGN};`);
  put(`    pub const FNV1A_OFFSET_BASIS: u32 = ${hex(PAK_FNV1A_OFFSET_BASIS)};`);
  put(`    pub const FNV1A_PRIME: u32 = ${hex(PAK_FNV1A_PRIME)};`);
  for (const [name, v] of Object.entries(PAK_DTYPE)) {
    put(`    pub const DT_${name.toUpperCase()}: u8 = ${v};`);
  }
  put("}");
  put("");

  // --- buttons --------------------------------------------------------------------
  put("/// PSP button bitmask — identical on every host. Verified against");
  put("/// dreamcart web/engine.js and rust-psp/psp/src/sys/ctrl.rs (CtrlButtons).");
  put("pub mod btn {");
  for (const [name, v] of Object.entries(BTN)) {
    put(`    pub const ${name}: u32 = ${hex(v, 4)};`);
  }
  put("}");
  put("");
  put("/// frame(buttons, analog): analog packs the nub as (x << 8) | y, each");
  put("/// axis 0..255 with 128 = center. Hosts without a stick omit the arg;");
  put("/// the runtime defaults to this value (so old tapes/goldens hold).");
  put(`pub const ANALOG_CENTER: u32 = ${hex(ANALOG_CENTER, 4)};`);

  return L.join("\n") + "\n";
}

if (import.meta.main) {
  const out = new URL("../../engine/core/src/spec.rs", import.meta.url).pathname;
  await Bun.write(out, generateRust());
  console.log(`wrote ${out}`);
}
