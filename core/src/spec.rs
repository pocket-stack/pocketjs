//! GENERATED — do not edit; run `bun spec/gen-rust.ts` (from PocketJS/).
//!
//! Source of truth: PocketJS/spec/spec.ts — every constant here mirrors it.
//! test/contract.ts regenerates this file in-memory and byte-compares;
//! if that fails, run `bun spec/gen-rust.ts` and commit the result.

#![allow(dead_code)]
#![allow(clippy::all)]

/// Logical (and physical PSP) screen size.
pub const SCREEN_W: u32 = 480;
pub const SCREEN_H: u32 = 272;

/// Node ids are generation-tagged: id = (generation << ID_SLOT_BITS) | slot.
/// Bit 31 stays 0; id 0 = "no node" (append anchor / clear focus).
pub const ID_SLOT_BITS: u32 = 20;
pub const ID_SLOT_MASK: u32 = 0xfffff;
/// Maximum tree depth (root = depth 0). insert_before rejects inserts whose
/// parent already sits at the cap (silent no-op, stale-id contract) so every
/// recursive tree walk stays bounded on small PSP thread stacks.
pub const MAX_TREE_DEPTH: u32 = 64;
/// Node 1 (slot 1, gen 0) is the pre-created full-screen root (flex column).
pub const ROOT_ID: i32 = 1;
/// `set_style(id, STYLE_ID_NONE)` clears a node back to default style.
pub const STYLE_ID_NONE: i32 = -1;
/// f32 sentinel for `w-full`/`h-full` (prop::WIDTH/HEIGHT): 100% of the
/// parent. Any negative width/height is treated as this sentinel; it is
/// NOT animatable (tweens to/from it are no-ops).
pub const SIZE_FULL: f32 = -1.0;

/// Textures must be power-of-two and no larger than this per side.
pub const TEX_MAX_DIM: u32 = 512;
/// Texture handles are generation-tagged like node ids:
/// handle = (generation << TEX_SLOT_BITS) | slot; bit 31 stays 0.
pub const TEX_SLOT_BITS: u32 = 20;
pub const TEX_SLOT_MASK: u32 = 0xfffff;
/// Max baked font-atlas slots.
pub const MAX_FONT_SLOTS: usize = 16;
/// Transition mask value meaning "every animatable prop".
pub const TRANSITION_MASK_ALL: u32 = 0xffffffff;
/// Core tick timestep: exactly 1/60 s (fixed — enables byte-exact goldens).
pub const FIXED_DT: f32 = 1.0 / 60.0;

/// Element kinds — the `create_node` argument.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NodeType {
    View = 0,
    Text = 1,
    Image = 2,
}

/// UI op codes (the wasm/FFI ABI identity of each `ui.*` op; 0 reserved).
/// Signatures are documented in spec.ts and DESIGN.md.
pub mod op {
    pub const CREATE_NODE: u8 = 1;
    pub const DESTROY_NODE: u8 = 2;
    pub const INSERT_BEFORE: u8 = 3;
    pub const REMOVE_CHILD: u8 = 4;
    pub const SET_STYLE: u8 = 5;
    pub const SET_PROP: u8 = 6;
    pub const SET_TEXT: u8 = 7;
    pub const REPLACE_TEXT: u8 = 8;
    pub const UPLOAD_TEXTURE: u8 = 9;
    pub const SET_IMAGE: u8 = 10;
    pub const ANIMATE: u8 = 11;
    pub const CANCEL_ANIM: u8 = 12;
    pub const SET_FOCUS: u8 = 13;
    pub const LOAD_STYLES: u8 = 14;
    pub const LOAD_FONT_ATLAS: u8 = 15;
    pub const MEASURE_TEXT: u8 = 16;
    pub const SET_SPRITE: u8 = 17;
    pub const DEBUG_INSPECT: u8 = 18;
    pub const DEBUG_RECT_X_Y: u8 = 19;
    pub const DEBUG_RECT_W_H: u8 = 20;
    pub const DEBUG_PAUSE: u8 = 21;
    pub const DEBUG_STEP: u8 = 22;
    pub const LOAD_TILE_TEXTURE: u8 = 23;
    pub const FREE_TEXTURE: u8 = 24;
    pub const UPLOAD_IMG_ENTRY: u8 = 25;
    pub const SET_ACTIVE: u8 = 26;
}

/// Property ids (u8, stable, append-only). Groups:
/// 1..63 layout | 64..95 visual | 96..127 text | 128..159 transform.
pub mod prop {
    pub const WIDTH: u8 = 1;
    pub const HEIGHT: u8 = 2;
    pub const MIN_W: u8 = 3;
    pub const MIN_H: u8 = 4;
    pub const MAX_W: u8 = 5;
    pub const MAX_H: u8 = 6;
    pub const PADDING_T: u8 = 8;
    pub const PADDING_R: u8 = 9;
    pub const PADDING_B: u8 = 10;
    pub const PADDING_L: u8 = 11;
    pub const MARGIN_T: u8 = 12;
    pub const MARGIN_R: u8 = 13;
    pub const MARGIN_B: u8 = 14;
    pub const MARGIN_L: u8 = 15;
    pub const GAP: u8 = 16;
    pub const FLEX_DIR: u8 = 17;
    pub const JUSTIFY: u8 = 18;
    pub const ALIGN: u8 = 19;
    pub const GROW: u8 = 20;
    pub const SHRINK: u8 = 21;
    pub const BASIS: u8 = 22;
    pub const FLEX_WRAP: u8 = 23;
    pub const POS_TYPE: u8 = 24;
    pub const INSET_T: u8 = 25;
    pub const INSET_R: u8 = 26;
    pub const INSET_B: u8 = 27;
    pub const INSET_L: u8 = 28;
    pub const DISPLAY: u8 = 29;
    pub const OVERFLOW: u8 = 30;
    pub const Z_INDEX: u8 = 31;
    pub const BG_COLOR: u8 = 64;
    pub const GRAD_FROM: u8 = 65;
    pub const GRAD_TO: u8 = 66;
    pub const GRAD_DIR: u8 = 67;
    pub const RADIUS: u8 = 68;
    pub const OPACITY: u8 = 69;
    pub const BORDER_COLOR: u8 = 70;
    pub const BORDER_WIDTH: u8 = 71;
    pub const SHADOW: u8 = 72;
    pub const BEVEL_OUTER_LIGHT: u8 = 77;
    pub const BEVEL_OUTER_DARK: u8 = 78;
    pub const BEVEL_INNER_LIGHT: u8 = 79;
    pub const BEVEL_INNER_DARK: u8 = 80;
    pub const BEVEL_WIDTH: u8 = 81;
    pub const TEXT_COLOR: u8 = 96;
    pub const FONT_SLOT: u8 = 97;
    pub const TEXT_ALIGN: u8 = 98;
    pub const LINE_HEIGHT: u8 = 99;
    pub const TRACKING: u8 = 100;
    pub const TRANSLATE_X: u8 = 128;
    pub const TRANSLATE_Y: u8 = 129;
    pub const SCALE: u8 = 130;
    pub const ROTATE: u8 = 131;
    pub const SCALE_X: u8 = 132;
    pub const SCALE_Y: u8 = 133;
    pub const ORIGIN_X: u8 = 134;
    pub const ORIGIN_Y: u8 = 135;
    pub const ROTATE_X: u8 = 136;
    pub const ROTATE_Y: u8 = 137;
    pub const TRANSLATE_Z: u8 = 138;
    pub const PERSPECTIVE: u8 = 139;
    pub const ARC_START: u8 = 140;
    pub const ARC_SWEEP: u8 = 141;
    pub const ARC_WIDTH: u8 = 142;
}

/// How a prop's u32 payload is interpreted (see spec.ts VALUE_KIND).
pub mod value_kind {
    pub const F32: u8 = 0;
    pub const COLOR: u8 = 1;
    pub const INT: u8 = 2;
}

/// PROP_VALUE_KIND[prop id] -> value_kind (0xff = unassigned id).
pub const PROP_VALUE_KIND: [u8; 256] = [
    0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x02, 0x02, 0x02, 0x00, 0x00, 0x00, 0x02, 0x02, 0x00, 0x00, 0x00, 0x00, 0x02, 0x02, 0x02,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x01, 0x01, 0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x02, 0xff, 0xff, 0xff, 0xff, 0x01, 0x01, 0x01,
    0x01, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x01, 0x02, 0x02, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
];

/// ANIM_BIT[prop id] -> transition-mask bit index (0xff = not animatable).
/// The bit order is spec.ts ANIMATABLE order — append-only.
pub const ANIM_BIT: [u8; 256] = [
    0xff, 0x00, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09,
    0x0a, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0b, 0xff, 0xff, 0x0c, 0x0d, 0x0e, 0x0f, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x10, 0x11, 0x12, 0xff, 0x13, 0x14, 0x15, 0x16, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x17, 0xff, 0xff, 0x18, 0x19, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0xff, 0xff, 0x20, 0x21, 0x22, 0xff, 0x23, 0x24, 0x25, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
];

/// Bitset over prop ids: animatable props (tween/spring/transition targets).
pub const ANIMATABLE_BITS: [u64; 4] = [0x000000001e41ff06, 0x00000019000000f7, 0x000000000000773f, 0x0000000000000000];
/// Bitset over prop ids: props whose change invalidates layout.
pub const LAYOUT_DIRTY_BITS: [u64; 4] = [0x000000007fffff7e, 0x0000001e00000000, 0x0000000000000000, 0x0000000000000000];

pub const fn is_animatable(prop: u8) -> bool {
    ANIMATABLE_BITS[(prop >> 6) as usize] & (1u64 << (prop & 63)) != 0
}
pub const fn is_layout_dirtying(prop: u8) -> bool {
    LAYOUT_DIRTY_BITS[(prop >> 6) as usize] & (1u64 << (prop & 63)) != 0
}

/// flex-direction.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FlexDir {
    Row = 0,
    Col = 1,
}

/// justify-content.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Justify {
    Start = 0,
    Center = 1,
    End = 2,
    Between = 3,
    Around = 4,
}

/// align-items.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Align {
    Start = 0,
    Center = 1,
    End = 2,
    Stretch = 3,
}

/// position type.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PosType {
    Relative = 0,
    Absolute = 1,
}

/// display (None removes from layout AND paint).
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Display {
    Flex = 0,
    None = 1,
}

/// overflow (Hidden => scissor in draw).
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Overflow {
    Visible = 0,
    Hidden = 1,
}

/// text alignment within the node box.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TextAlign {
    Left = 0,
    Center = 1,
    Right = 2,
}

/// gradient direction (`bg-gradient-to-t|b|l|r`).
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GradDir {
    ToTop = 0,
    ToBottom = 1,
    ToLeft = 2,
    ToRight = 3,
}

/// animation easing. Spring/SpringBouncy ignore durMs (physics decide); OutBack overshoots ~10%.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Easing {
    Linear = 0,
    EaseIn = 1,
    EaseOut = 2,
    EaseInOut = 3,
    OutBack = 4,
    Spring = 5,
    SpringBouncy = 6,
    CubicBezier = 7,
}

/// PSM texture pixel formats — MUST equal rust-psp TexturePixelFormat
/// (sceGuTexMode arg; verified against rust-psp/psp/src/sys/gu.rs).
/// PSM_T8 (CLUT8) uploads as: 1024-byte palette (256 x u32 ABGR), then
/// w*h index bytes.
pub mod psm {
    pub const PSM_4444: u32 = 2;
    pub const PSM_8888: u32 = 3;
    pub const PSM_T8: u32 = 5;
}

/// IMG entry flags (compiler/pak.ts IMG entry byte 5; v1 wrote 0).
pub mod img {
    pub const FLAG_RLE: u8 = 1; // pixel stream is PackBits-RLE
    pub const FLAG_LINEAR: u8 = 2; // bilinear sampling
}

/// TILESET pak entry (deep-zoom tile grids; full layout in spec.ts).
/// One shared 256-color palette per entry; solid tiles live in the dir.
pub mod tileset {
    pub const MAGIC: u32 = 0x53544b50; // 'PKTS' LE
    pub const VERSION: u16 = 1;
    pub const HEADER_SIZE: usize = 32;
    pub const DIR_ENTRY_SIZE: usize = 8;
    pub const ABSENT: u32 = 0xffffffff;
    pub const FLAG_RLE: u16 = 1;
    pub const FLAG_LINEAR: u16 = 2;
}

/// STYLE TABLE (styles.bin) format constants — full layout in spec.ts.
pub mod style_table {
    pub const MAGIC: u32 = 0x54534344; // 'DCST' LE
    pub const VERSION: u16 = 2;
    pub const HEADER_SIZE: usize = 12;
    pub const TRANSITION_SIZE: usize = 12;
    pub const PROP_RECORD_SIZE: usize = 6;
    pub const VARIANT_BASE: u8 = 1;
    pub const VARIANT_FOCUS: u8 = 2;
    pub const VARIANT_ACTIVE: u8 = 4;
    pub const HAS_TRANSITION: u8 = 8;
    pub const HAS_ANIMATION: u8 = 16;
    pub const ANIM_ENTRY_HEADER_SIZE: usize = 8;
    pub const ANIM_SEGMENT_SIZE: usize = 14;
    pub const ANIM_BEZIER_EXTRA_SIZE: usize = 16;
    pub const ANIM_FILL_BACKWARDS: u8 = 1;
    pub const ANIM_FILL_FORWARDS: u8 = 2;
}

/// FONT ATLAS blob format constants — full layout in spec.ts.
pub mod font_atlas {
    pub const MAGIC: u32 = 0x41464344; // 'DCFA' LE
    pub const VERSION: u16 = 3;
    pub const HEADER_SIZE: usize = 16;
    pub const CMAP_ENTRY_SIZE: usize = 8;
    pub const FLAG_BOLD: u8 = 1;
}

/// DrawList op codes (core -> backend Vec<u32> words; layout in spec.ts).
/// Word counts incl. header: RECT 4, GRAD_RECT 6, GLYPH_RUN 3+2n,
/// TEX_QUAD 9, SCISSOR 3, SCISSOR_POP 1, TRI 7.
pub mod draw_op {
    pub const RECT: u32 = 1;
    pub const GRAD_RECT: u32 = 2;
    pub const GLYPH_RUN: u32 = 3;
    pub const TEX_QUAD: u32 = 4;
    pub const SCISSOR: u32 = 5;
    pub const SCISSOR_POP: u32 = 6;
    pub const TRI: u32 = 7;
    pub const TEX_TRI: u32 = 8;
}

/// .pak container constants (byte-compatible with dreamcart's format;
/// copied from framework/bake/pak.ts + docs/pak-format.md).
pub mod pak {
    pub const MAGIC: u32 = 0x4b504344; // 'DCPK' LE
    pub const VERSION: u16 = 1;
    pub const HEADER_SIZE: usize = 32;
    pub const ENTRY_SIZE: usize = 24;
    pub const ALIGN: usize = 16;
    pub const FNV1A_OFFSET_BASIS: u32 = 0x811c9dc5;
    pub const FNV1A_PRIME: u32 = 0x01000193;
    pub const DT_U8: u8 = 0;
    pub const DT_I8: u8 = 1;
    pub const DT_U16: u8 = 2;
    pub const DT_I16: u8 = 3;
    pub const DT_U32: u8 = 4;
    pub const DT_I32: u8 = 5;
    pub const DT_F32: u8 = 6;
    pub const DT_F64: u8 = 7;
}

/// PSP button bitmask — identical on every host. Verified against
/// dreamcart web/engine.js and rust-psp/psp/src/sys/ctrl.rs (CtrlButtons).
pub mod btn {
    pub const SELECT: u32 = 0x0001;
    pub const START: u32 = 0x0008;
    pub const UP: u32 = 0x0010;
    pub const RIGHT: u32 = 0x0020;
    pub const DOWN: u32 = 0x0040;
    pub const LEFT: u32 = 0x0080;
    pub const LTRIGGER: u32 = 0x0100;
    pub const RTRIGGER: u32 = 0x0200;
    pub const TRIANGLE: u32 = 0x1000;
    pub const CIRCLE: u32 = 0x2000;
    pub const CROSS: u32 = 0x4000;
    pub const SQUARE: u32 = 0x8000;
}

/// frame(buttons, analog): analog packs the nub as (x << 8) | y, each
/// axis 0..255 with 128 = center. Hosts without a stick omit the arg;
/// the runtime defaults to this value (so old tapes/goldens hold).
pub const ANALOG_CENTER: u32 = 0x8080;
