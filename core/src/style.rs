//! Style table parse + resolve.
//!
//! Parses styles.bin (spec.ts "STYLE TABLE binary format", constants in
//! spec::style_table) with unaligned little-endian reads over `&[u8]`, and
//! resolves a node's effective style: defaults → base variant → focus variant
//! (node focused) → active variant (node active) → dynamic `set_prop`
//! overrides → live animation values.
//!
//! Transition spawning on `set_style`/`set_focus` diffs live in lib.rs (they
//! coordinate the tree, this table and the anim track list).

use alloc::vec::Vec;

use crate::spec;
use crate::tree::Node;

/// Sentinel for "no gradient configured" (GradDir ordinals are 0..=3).
pub const NO_GRADIENT: u32 = 0xffff_ffff;

// ---- unaligned LE readers ---------------------------------------------------

#[inline]
fn rd_u16(b: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(off)?, *b.get(off + 1)?]))
}

#[inline]
fn rd_u32(b: &[u8], off: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *b.get(off)?,
        *b.get(off + 1)?,
        *b.get(off + 2)?,
        *b.get(off + 3)?,
    ]))
}

// ---- table ------------------------------------------------------------------

/// A style record's transition block.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Transition {
    /// Anim-bit mask over spec.ts ANIMATABLE order (spec::ANIM_BIT).
    pub mask: u32,
    pub dur_ms: u16,
    pub delay_ms: u16,
    /// spec::Easing ordinal.
    pub easing: u8,
}

/// One parsed style record. Variant prop lists are (prop id, raw u32).
#[derive(Clone, Default)]
pub struct StyleRecord {
    pub transition: Option<Transition>,
    pub base: Vec<(u8, u32)>,
    pub focus: Vec<(u8, u32)>,
    pub active: Vec<(u8, u32)>,
}

/// The whole styles.bin table; styleId = record index.
#[derive(Default)]
pub struct StyleTable {
    pub records: Vec<StyleRecord>,
}

impl StyleTable {
    pub fn new() -> StyleTable {
        StyleTable { records: Vec::new() }
    }

    /// Parse a styles.bin blob. `None` on bad magic/version/truncation.
    pub fn parse(bytes: &[u8]) -> Option<StyleTable> {
        use spec::style_table as st;
        if rd_u32(bytes, 0)? != st::MAGIC || rd_u16(bytes, 4)? != st::VERSION {
            return None;
        }
        let count = rd_u16(bytes, 6)? as usize;
        let mut records = Vec::with_capacity(count);
        let mut o = st::HEADER_SIZE;
        for _ in 0..count {
            let flags = *bytes.get(o)?;
            o += 1;
            let mut rec = StyleRecord::default();
            if flags & st::HAS_TRANSITION != 0 {
                rec.transition = Some(Transition {
                    mask: rd_u32(bytes, o)?,
                    dur_ms: rd_u16(bytes, o + 4)?,
                    delay_ms: rd_u16(bytes, o + 6)?,
                    easing: *bytes.get(o + 8)?,
                });
                o += st::TRANSITION_SIZE;
            }
            for v in 0..3u8 {
                let bit = match v {
                    0 => st::VARIANT_BASE,
                    1 => st::VARIANT_FOCUS,
                    _ => st::VARIANT_ACTIVE,
                };
                if flags & bit == 0 {
                    continue;
                }
                let n = *bytes.get(o)? as usize;
                o += 1;
                let mut props = Vec::with_capacity(n);
                for _ in 0..n {
                    let prop = *bytes.get(o)?;
                    let value = rd_u32(bytes, o + 2)?;
                    props.push((prop, value));
                    o += st::PROP_RECORD_SIZE;
                }
                match v {
                    0 => rec.base = props,
                    1 => rec.focus = props,
                    _ => rec.active = props,
                }
            }
            records.push(rec);
        }
        Some(StyleTable { records })
    }

    /// Record for a style id (STYLE_ID_NONE / out-of-range → None).
    #[inline]
    pub fn record(&self, style_id: i32) -> Option<&StyleRecord> {
        if style_id < 0 {
            None
        } else {
            self.records.get(style_id as usize)
        }
    }
}

// ---- resolved style ----------------------------------------------------------

/// A node's fully-resolved effective style. Dimension-like f32 fields use NAN
/// for "auto/unset"; -1.0 encodes 100% ("-full", the only percent in v1).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Resolved {
    pub width: f32,
    pub height: f32,
    pub min_w: f32,
    pub min_h: f32,
    pub max_w: f32,
    pub max_h: f32,
    /// t, r, b, l
    pub padding: [f32; 4],
    /// t, r, b, l
    pub margin: [f32; 4],
    pub gap: f32,
    pub flex_dir: u8,
    pub justify: u8,
    pub align: u8,
    pub grow: f32,
    pub shrink: f32,
    pub basis: f32,
    pub flex_wrap: u8,
    pub pos_type: u8,
    /// t, r, b, l (NAN = auto)
    pub inset: [f32; 4],
    pub display: u8,
    pub overflow: u8,
    pub z_index: i32,
    pub bg_color: u32,
    pub grad_from: u32,
    pub grad_to: u32,
    /// spec::GradDir ordinal, or NO_GRADIENT.
    pub grad_dir: u32,
    pub radius: f32,
    pub opacity: f32,
    pub border_color: u32,
    pub border_width: f32,
    pub shadow: u32,
    pub text_color: u32,
    pub font_slot: u32,
    pub text_align: u8,
    /// NAN = use the atlas default.
    pub line_height: f32,
    pub tracking: f32,
    pub translate_x: f32,
    pub translate_y: f32,
    pub scale: f32,
    pub rotate: f32,
    pub scale_x: f32,
    pub scale_y: f32,
}

impl Default for Resolved {
    fn default() -> Resolved {
        Resolved {
            width: f32::NAN,
            height: f32::NAN,
            min_w: f32::NAN,
            min_h: f32::NAN,
            max_w: f32::NAN,
            max_h: f32::NAN,
            padding: [0.0; 4],
            margin: [0.0; 4],
            gap: 0.0,
            flex_dir: spec::FlexDir::Row as u8,
            justify: spec::Justify::Start as u8,
            align: spec::Align::Stretch as u8,
            grow: 0.0,
            shrink: 1.0,
            basis: f32::NAN,
            flex_wrap: 0,
            pos_type: spec::PosType::Relative as u8,
            inset: [f32::NAN; 4],
            display: spec::Display::Flex as u8,
            overflow: spec::Overflow::Visible as u8,
            z_index: 0,
            bg_color: 0,
            grad_from: 0,
            grad_to: 0,
            grad_dir: NO_GRADIENT,
            radius: 0.0,
            opacity: 1.0,
            border_color: 0,
            border_width: 0.0,
            shadow: 0,
            text_color: 0xffff_ffff,
            font_slot: 0,
            text_align: spec::TextAlign::Left as u8,
            line_height: f32::NAN,
            tracking: 0.0,
            translate_x: 0.0,
            translate_y: 0.0,
            scale: 1.0,
            rotate: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
        }
    }
}

impl Resolved {
    /// Apply one (prop id, raw u32 payload). Unknown props are ignored.
    pub fn apply(&mut self, prop: u8, bits: u32) {
        use spec::prop as p;
        let f = f32::from_bits(bits);
        match prop {
            p::WIDTH => self.width = f,
            p::HEIGHT => self.height = f,
            p::MIN_W => self.min_w = f,
            p::MIN_H => self.min_h = f,
            p::MAX_W => self.max_w = f,
            p::MAX_H => self.max_h = f,
            p::PADDING_T => self.padding[0] = f,
            p::PADDING_R => self.padding[1] = f,
            p::PADDING_B => self.padding[2] = f,
            p::PADDING_L => self.padding[3] = f,
            p::MARGIN_T => self.margin[0] = f,
            p::MARGIN_R => self.margin[1] = f,
            p::MARGIN_B => self.margin[2] = f,
            p::MARGIN_L => self.margin[3] = f,
            p::GAP => self.gap = f,
            p::FLEX_DIR => self.flex_dir = bits as u8,
            p::JUSTIFY => self.justify = bits as u8,
            p::ALIGN => self.align = bits as u8,
            p::GROW => self.grow = f,
            p::SHRINK => self.shrink = f,
            p::BASIS => self.basis = f,
            p::FLEX_WRAP => self.flex_wrap = bits as u8,
            p::POS_TYPE => self.pos_type = bits as u8,
            p::INSET_T => self.inset[0] = f,
            p::INSET_R => self.inset[1] = f,
            p::INSET_B => self.inset[2] = f,
            p::INSET_L => self.inset[3] = f,
            p::DISPLAY => self.display = bits as u8,
            p::OVERFLOW => self.overflow = bits as u8,
            p::Z_INDEX => self.z_index = bits as i32,
            p::BG_COLOR => self.bg_color = bits,
            p::GRAD_FROM => self.grad_from = bits,
            p::GRAD_TO => self.grad_to = bits,
            p::GRAD_DIR => self.grad_dir = bits,
            p::RADIUS => self.radius = f,
            p::OPACITY => self.opacity = f,
            p::BORDER_COLOR => self.border_color = bits,
            p::BORDER_WIDTH => self.border_width = f,
            p::SHADOW => self.shadow = bits,
            p::TEXT_COLOR => self.text_color = bits,
            p::FONT_SLOT => self.font_slot = bits,
            p::TEXT_ALIGN => self.text_align = bits as u8,
            p::LINE_HEIGHT => self.line_height = f,
            p::TRACKING => self.tracking = f,
            p::TRANSLATE_X => self.translate_x = f,
            p::TRANSLATE_Y => self.translate_y = f,
            p::SCALE => self.scale = f,
            p::ROTATE => self.rotate = f,
            p::SCALE_X => self.scale_x = f,
            p::SCALE_Y => self.scale_y = f,
            _ => {}
        }
    }

    /// Raw u32 payload of a prop's current value (inverse of `apply`; used
    /// for old/new diffing and animation "from = current"). 0 for unknown.
    pub fn get_bits(&self, prop: u8) -> u32 {
        use spec::prop as p;
        match prop {
            p::WIDTH => self.width.to_bits(),
            p::HEIGHT => self.height.to_bits(),
            p::MIN_W => self.min_w.to_bits(),
            p::MIN_H => self.min_h.to_bits(),
            p::MAX_W => self.max_w.to_bits(),
            p::MAX_H => self.max_h.to_bits(),
            p::PADDING_T => self.padding[0].to_bits(),
            p::PADDING_R => self.padding[1].to_bits(),
            p::PADDING_B => self.padding[2].to_bits(),
            p::PADDING_L => self.padding[3].to_bits(),
            p::MARGIN_T => self.margin[0].to_bits(),
            p::MARGIN_R => self.margin[1].to_bits(),
            p::MARGIN_B => self.margin[2].to_bits(),
            p::MARGIN_L => self.margin[3].to_bits(),
            p::GAP => self.gap.to_bits(),
            p::FLEX_DIR => self.flex_dir as u32,
            p::JUSTIFY => self.justify as u32,
            p::ALIGN => self.align as u32,
            p::GROW => self.grow.to_bits(),
            p::SHRINK => self.shrink.to_bits(),
            p::BASIS => self.basis.to_bits(),
            p::FLEX_WRAP => self.flex_wrap as u32,
            p::POS_TYPE => self.pos_type as u32,
            p::INSET_T => self.inset[0].to_bits(),
            p::INSET_R => self.inset[1].to_bits(),
            p::INSET_B => self.inset[2].to_bits(),
            p::INSET_L => self.inset[3].to_bits(),
            p::DISPLAY => self.display as u32,
            p::OVERFLOW => self.overflow as u32,
            p::Z_INDEX => self.z_index as u32,
            p::BG_COLOR => self.bg_color,
            p::GRAD_FROM => self.grad_from,
            p::GRAD_TO => self.grad_to,
            p::GRAD_DIR => self.grad_dir,
            p::RADIUS => self.radius.to_bits(),
            p::OPACITY => self.opacity.to_bits(),
            p::BORDER_COLOR => self.border_color,
            p::BORDER_WIDTH => self.border_width.to_bits(),
            p::SHADOW => self.shadow,
            p::TEXT_COLOR => self.text_color,
            p::FONT_SLOT => self.font_slot,
            p::TEXT_ALIGN => self.text_align as u32,
            p::LINE_HEIGHT => self.line_height.to_bits(),
            p::TRACKING => self.tracking.to_bits(),
            p::TRANSLATE_X => self.translate_x.to_bits(),
            p::TRANSLATE_Y => self.translate_y.to_bits(),
            p::SCALE => self.scale.to_bits(),
            p::ROTATE => self.rotate.to_bits(),
            p::SCALE_X => self.scale_x.to_bits(),
            p::SCALE_Y => self.scale_y.to_bits(),
            _ => 0,
        }
    }
}

/// Resolve a node's effective style. `with_anim` controls whether live
/// animation values participate (they do for painting/"from = current"; they
/// don't when computing a transition's target).
pub fn resolve(node: &Node, table: &StyleTable, with_anim: bool) -> Resolved {
    let mut r = Resolved::default();
    if let Some(rec) = table.record(node.style_id) {
        for &(p, v) in &rec.base {
            r.apply(p, v);
        }
        if node.focused {
            for &(p, v) in &rec.focus {
                r.apply(p, v);
            }
        }
        if node.active {
            for &(p, v) in &rec.active {
                r.apply(p, v);
            }
        }
    }
    for &(p, v) in &node.overrides {
        r.apply(p, v);
    }
    if with_anim {
        for &(p, v) in &node.anim_values {
            r.apply(p, v);
        }
    }
    r
}
