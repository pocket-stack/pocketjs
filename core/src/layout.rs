//! taffy integration: resolved styles -> taffy::Style, text measure
//! functions, dirty tracking and rounded layout readback.
//!
//! Strategy (v1, documented): the taffy tree is REBUILT from scratch on every
//! relayout instead of incrementally synced. Relayouts only happen when the
//! dirty flag is set (structure/layout-prop mutations, layout-prop animation
//! frames), and UI trees on a 480x272 screen are small, so the rebuild is
//! well inside budget and keeps the sync logic trivially correct.
//!
//! Text nodes: a text ELEMENT becomes a taffy measure leaf over its
//! concatenated inline run; text children of a text element are absorbed into
//! that run (never flex items). Text nodes whose run is EMPTY (Solid `<Show>`
//! markers) are excluded from the taffy tree entirely [R].

use alloc::string::String;
use alloc::vec::Vec;

use taffy::{AvailableSpace, Size, TaffyTree};

use crate::spec;
use crate::style::{self, Resolved, StyleTable};
use crate::text::Fonts;
use crate::tree::{LayoutRect, Tree};

/// Measure context attached to text leaves (taffy NodeContext).
pub struct MeasureCtx {
    pub text: String,
    pub slot: u8,
    pub tracking: f32,
    /// NAN = atlas default.
    pub line_height: f32,
}

/// The layout engine: one TaffyTree + the dirty flag.
pub struct LayoutEngine {
    pub taffy: TaffyTree<MeasureCtx>,
    pub dirty: bool,
    /// Layout viewport in px. Defaults to the PSP screen; desktop hosts set it
    /// through `Ui::set_viewport` (the draw clip stage uses the same bounds).
    pub viewport: (f32, f32),
}

impl Default for LayoutEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl LayoutEngine {
    pub fn new() -> LayoutEngine {
        LayoutEngine {
            taffy: TaffyTree::new(),
            dirty: true,
            viewport: (spec::SCREEN_W as f32, spec::SCREEN_H as f32),
        }
    }
}

/// floor() without std (coordinates are far from i32 limits).
#[inline]
pub fn floorf(x: f32) -> f32 {
    let t = x as i32 as f32; // trunc toward zero
    if x < t {
        t - 1.0
    } else {
        t
    }
}

/// round-half-up without std.
#[inline]
pub fn roundf(x: f32) -> f32 {
    floorf(x + 0.5)
}

/// Map an f32 dimension prop to taffy: NAN = auto, ANY negative = 100%
/// (the SIZE_FULL sentinel — spec.ts pins "any negative value is treated as
/// this sentinel"; "-full" is the only percentage v1 supports), else px.
fn dim(v: f32) -> taffy::Dimension {
    if v.is_nan() {
        taffy::Dimension::auto()
    } else if v < 0.0 {
        taffy::Dimension::percent(1.0)
    } else {
        taffy::Dimension::length(v)
    }
}

/// margin/inset value: NAN = auto, else px. Unlike `dim`, negatives are REAL
/// offsets (CSS negative margins / `inset-[-10]` outsets), not the SIZE_FULL
/// sentinel — that sentinel is pinned to width/height only (spec.ts).
fn lpa(v: f32) -> taffy::LengthPercentageAuto {
    if v.is_nan() {
        taffy::LengthPercentageAuto::auto()
    } else {
        taffy::LengthPercentageAuto::length(v)
    }
}

fn lp(v: f32) -> taffy::LengthPercentage {
    if v.is_nan() {
        taffy::LengthPercentage::length(0.0)
    } else {
        taffy::LengthPercentage::length(v)
    }
}

/// Map a resolved style onto taffy::Style (spec prop groups -> flexbox).
pub fn to_taffy(r: &Resolved) -> taffy::Style {
    let mut s = taffy::Style::default();
    s.display = if r.display == spec::Display::None as u8 {
        taffy::Display::None
    } else {
        taffy::Display::Flex
    };
    s.position = if r.pos_type == spec::PosType::Absolute as u8 {
        taffy::Position::Absolute
    } else {
        taffy::Position::Relative
    };
    s.overflow = taffy::Point {
        x: if r.overflow == spec::Overflow::Hidden as u8 {
            taffy::Overflow::Hidden
        } else {
            taffy::Overflow::Visible
        },
        y: if r.overflow == spec::Overflow::Hidden as u8 {
            taffy::Overflow::Hidden
        } else {
            taffy::Overflow::Visible
        },
    };
    s.flex_direction = if r.flex_dir == spec::FlexDir::Col as u8 {
        taffy::FlexDirection::Column
    } else {
        taffy::FlexDirection::Row
    };
    s.flex_wrap = if r.flex_wrap != 0 {
        taffy::FlexWrap::Wrap
    } else {
        taffy::FlexWrap::NoWrap
    };
    s.justify_content = Some(match r.justify {
        j if j == spec::Justify::Center as u8 => taffy::JustifyContent::CENTER,
        j if j == spec::Justify::End as u8 => taffy::JustifyContent::FLEX_END,
        j if j == spec::Justify::Between as u8 => taffy::JustifyContent::SPACE_BETWEEN,
        j if j == spec::Justify::Around as u8 => taffy::JustifyContent::SPACE_AROUND,
        _ => taffy::JustifyContent::FLEX_START,
    });
    s.align_items = Some(match r.align {
        a if a == spec::Align::Start as u8 => taffy::AlignItems::FLEX_START,
        a if a == spec::Align::Center as u8 => taffy::AlignItems::CENTER,
        a if a == spec::Align::End as u8 => taffy::AlignItems::FLEX_END,
        _ => taffy::AlignItems::STRETCH,
    });
    s.flex_grow = r.grow;
    s.flex_shrink = r.shrink;
    s.flex_basis = dim(r.basis);
    s.gap = Size {
        width: lp(r.gap),
        height: lp(r.gap),
    };
    s.size = Size {
        width: dim(r.width),
        height: dim(r.height),
    };
    s.min_size = Size {
        width: dim(r.min_w),
        height: dim(r.min_h),
    };
    s.max_size = Size {
        width: dim(r.max_w),
        height: dim(r.max_h),
    };
    // padding/margin/inset arrays are [t, r, b, l].
    s.padding = taffy::Rect {
        top: lp(r.padding[0]),
        right: lp(r.padding[1]),
        bottom: lp(r.padding[2]),
        left: lp(r.padding[3]),
    };
    s.margin = taffy::Rect {
        top: lpa(r.margin[0]),
        right: lpa(r.margin[1]),
        bottom: lpa(r.margin[2]),
        left: lpa(r.margin[3]),
    };
    s.inset = taffy::Rect {
        top: lpa(r.inset[0]),
        right: lpa(r.inset[1]),
        bottom: lpa(r.inset[2]),
        left: lpa(r.inset[3]),
    };
    s
}

/// Build the taffy node for `slot`'s subtree. Returns None for excluded
/// nodes (empty text runs).
fn build(tree: &mut Tree, styles: &StyleTable, taffy: &mut TaffyTree<MeasureCtx>, slot: u32) -> Option<taffy::NodeId> {
    let resolved = style::resolve(&tree.slots[slot as usize], styles, true);
    let node_type = tree.slots[slot as usize].node_type;
    if node_type == spec::NodeType::Text as u8 {
        let mut run = String::new();
        tree.collect_run(slot, &mut run);
        if run.is_empty() {
            tree.slots[slot as usize].taffy = None;
            return None; // empty text nodes never consume gap/flex space [R]
        }
        let ctx = MeasureCtx {
            text: run,
            slot: resolved.font_slot as u8,
            tracking: resolved.tracking,
            line_height: resolved.line_height,
        };
        let nid = taffy.new_leaf_with_context(to_taffy(&resolved), ctx).ok()?;
        tree.slots[slot as usize].taffy = Some(nid);
        return Some(nid);
    }
    let children = tree.slots[slot as usize].children.clone();
    let mut kids: Vec<taffy::NodeId> = Vec::with_capacity(children.len());
    for c in children {
        if let Some(cs) = tree.resolve(c) {
            if let Some(k) = build(tree, styles, taffy, cs) {
                kids.push(k);
            }
        }
    }
    let nid = taffy.new_with_children(to_taffy(&resolved), &kids).ok()?;
    tree.slots[slot as usize].taffy = Some(nid);
    Some(nid)
}

/// Copy rounded layout output back into the node tree.
fn readback(tree: &mut Tree, taffy: &TaffyTree<MeasureCtx>, slot: u32) {
    match tree.slots[slot as usize].taffy {
        Some(nid) => {
            if let Ok(l) = taffy.layout(nid) {
                tree.slots[slot as usize].layout = LayoutRect {
                    x: roundf(l.location.x),
                    y: roundf(l.location.y),
                    w: roundf(l.size.width),
                    h: roundf(l.size.height),
                };
            }
        }
        None => tree.slots[slot as usize].layout = LayoutRect::default(),
    }
    let children = tree.slots[slot as usize].children.clone();
    for c in children {
        if let Some(cs) = tree.resolve(c) {
            readback(tree, taffy, cs);
        }
    }
}

/// Full relayout: rebuild the taffy tree, compute with text measurement,
/// read the rounded results back, clear the dirty flag.
pub fn relayout(tree: &mut Tree, styles: &StyleTable, fonts: &Fonts, eng: &mut LayoutEngine) {
    eng.taffy.clear();
    for n in tree.slots.iter_mut() {
        n.taffy = None;
    }
    let root_slot = crate::tree::split_id(spec::ROOT_ID).1;
    let Some(root_nid) = build(tree, styles, &mut eng.taffy, root_slot) else {
        eng.dirty = false;
        return;
    };
    let _ = eng.taffy.compute_layout_with_measure(
        root_nid,
        Size {
            width: AvailableSpace::Definite(eng.viewport.0),
            height: AvailableSpace::Definite(eng.viewport.1),
        },
        |known, _available, _id, ctx, _style| -> Size<f32> {
            match ctx {
                Some(m) => {
                    let (w, h) = fonts.measure_run(&m.text, m.slot, m.tracking, m.line_height);
                    Size {
                        width: known.width.unwrap_or(w),
                        height: known.height.unwrap_or(h),
                    }
                }
                None => Size { width: 0.0, height: 0.0 },
            }
        },
    );
    readback(tree, &eng.taffy, root_slot);
    eng.dirty = false;
}

/// Smoke helper proving the pinned taffy feature set
/// (alloc + taffy_tree + flexbox + content_size, no default features)
/// actually resolves and compiles for every target.
pub fn taffy_smoke() -> taffy::TaffyTree<()> {
    taffy::TaffyTree::new()
}
