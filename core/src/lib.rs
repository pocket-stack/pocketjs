//! pocketjs-core — the platform-agnostic retained UI core.
//!
//! One `Ui` instance owns the node tree, style table, taffy layout, font
//! atlases, animation tracks and the per-frame `DrawList`. Hosts (PSP QuickJS
//! FFI, wasm extern "C" mirror) call the op surface below; nothing here knows
//! about sceGu, canvas or QuickJS.
//!
//! Invariants upheld (from DESIGN.md, all [R]):
//!   - Node ids are generation-tagged: (gen << spec::ID_SLOT_BITS) | slot;
//!     ops on stale ids are silent no-ops.
//!   - `insert_before` has DOM move semantics: an attached child is unlinked
//!     from its old parent first. anchor 0 = append.
//!   - `destroy_node` destroys the subtree, frees its anim tracks, and clears
//!     focus if the focused node is inside.
//!   - `tick()` advances EXACTLY spec::FIXED_DT per call (frame content is a
//!     pure function of frame index — byte-exact goldens depend on it).
//!   - `draw()` output is fully CPU-clipped: every coordinate in the DrawList
//!     is inside [0, SCREEN_W] x [0, SCREEN_H] (see spec.ts DRAWLIST comment).
//!
//! Animation value plumbing: a running track writes its per-frame value into
//! the node's `anim_values` (applied last in style resolution). On completion
//! a TRANSITION track just removes its entry (the resolved style now equals
//! the target); an EXPLICIT `animate()` track persists its final value as a
//! dynamic override. `cancel_anim` freezes the current value as a dynamic
//! override.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

use alloc::vec::Vec;

pub mod anim;
pub mod draw;
pub mod layout;
pub mod spec;
pub mod style;
pub mod text;
pub mod tree;

pub use draw::DrawList;

/// One uploaded texture. Pixels are copied into 16-byte-aligned storage so
/// the PSP GE can sample them directly (the wasm rasterizer reads them via
/// `Ui::texture`).
pub struct Texture {
    /// 16-byte-aligned backing store (`u128` chunks).
    data: Vec<u128>,
    byte_len: usize,
    pub w: u32,
    pub h: u32,
    /// spec::psm::* pixel format.
    pub psm: u32,
}

impl Texture {
    pub fn pixels(&self) -> &[u8] {
        // Safe: the Vec<u128> owns at least byte_len initialized bytes.
        unsafe { core::slice::from_raw_parts(self.data.as_ptr() as *const u8, self.byte_len) }
    }
}

/// The retained UI core. One per host/screen.
pub struct Ui {
    tree: tree::Tree,
    styles: style::StyleTable,
    fonts: text::Fonts,
    anims: anim::Anims,
    layout: layout::LayoutEngine,
    textures: Vec<Texture>,
    focused: i32,
    draw_list: DrawList,
    /// Frame counter advanced by `tick()` (drives fixed-dt animation).
    frame: u64,
}

impl Default for Ui {
    fn default() -> Self {
        Self::new()
    }
}

impl Ui {
    /// Create a core with the pre-created root node (`spec::ROOT_ID`,
    /// full-screen flex column) already in the tree.
    pub fn new() -> Self {
        Ui {
            tree: tree::Tree::new(),
            styles: style::StyleTable::new(),
            fonts: text::Fonts::new(),
            anims: anim::Anims::new(),
            layout: layout::LayoutEngine::new(),
            textures: Vec::new(),
            focused: 0,
            draw_list: DrawList::new(),
            frame: 0,
        }
    }

    // ---- tree ops ---------------------------------------------------------

    /// Create a detached node of `node_type` (spec::NodeType value).
    /// Returns its generation-tagged id, or 0 on failure.
    pub fn create_node(&mut self, node_type: u8) -> i32 {
        if node_type > spec::NodeType::Image as u8 {
            return 0;
        }
        self.tree.alloc(node_type)
    }

    /// Destroy `id` and its whole subtree; frees anim tracks; clears focus
    /// if the focused node was inside. Stale/unknown ids are no-ops.
    pub fn destroy_node(&mut self, id: i32) {
        if id == spec::ROOT_ID || self.tree.resolve(id).is_none() {
            return;
        }
        if self.focused != 0 && self.tree.is_in_subtree(id, self.focused) {
            self.focused = 0;
        }
        self.tree.detach(id);
        let mut slots = Vec::new();
        self.tree.collect_subtree(id, &mut slots);
        for slot in slots {
            let nid = self.tree.slots[slot as usize].id(slot);
            self.anims.kill_node(nid);
            self.tree.free_slot(slot);
        }
        self.layout.dirty = true;
    }

    /// Insert `child` under `parent` before `anchor` (0 = append). DOM move
    /// semantics: if `child` is attached anywhere it is unlinked first.
    pub fn insert_before(&mut self, parent: i32, child: i32, anchor: i32) {
        if self.tree.insert_before(parent, child, anchor) {
            self.layout.dirty = true;
        }
    }

    /// Detach `child` from `parent`, keeping the node alive (Solid re-inserts
    /// during reorder; the JS renderer sweep destroys still-detached nodes).
    pub fn remove_child(&mut self, parent: i32, child: i32) {
        if self.tree.remove_child(parent, child) {
            self.layout.dirty = true;
        }
    }

    // ---- styling ----------------------------------------------------------

    /// Apply style-table record `style_id` (spec::STYLE_ID_NONE clears).
    /// Starts transitions for the animatable old→new diff if the node already
    /// had an established style and the new record carries a transition block.
    pub fn set_style(&mut self, id: i32, style_id: i32) {
        let Some(slot) = self.tree.resolve(id) else { return };
        let old = style::resolve(&self.tree.slots[slot as usize], &self.styles, true);
        let was_initialized = self.tree.slots[slot as usize].style_initialized;
        {
            let node = &mut self.tree.slots[slot as usize];
            node.style_id = if style_id < 0 {
                spec::STYLE_ID_NONE
            } else {
                style_id
            };
            node.style_initialized = true;
        }
        self.retarget(slot, &old, was_initialized);
        self.layout.dirty = true;
    }

    /// Set a single dynamic prop. `value` carries the payload per
    /// spec::PROP_VALUE_KIND: f32 props pass the number; color/int props pass
    /// the u32 bits as an integral f64.
    pub fn set_prop(&mut self, id: i32, prop: u8, value: f64) {
        let kind = spec::PROP_VALUE_KIND[prop as usize];
        if kind == 0xff {
            return;
        }
        let Some(slot) = self.tree.resolve(id) else { return };
        let bits = prop_bits(kind, value);
        // A direct set wins over any running animation on the same prop.
        let nid = self.tree.slots[slot as usize].id(slot);
        self.anims.kill_for(nid, prop);
        let node = &mut self.tree.slots[slot as usize];
        tree::Node::remove_entry(&mut node.anim_values, prop);
        tree::Node::put_entry(&mut node.overrides, prop, bits);
        if spec::is_layout_dirtying(prop) {
            self.layout.dirty = true;
        }
    }

    // ---- text ------------------------------------------------------------

    /// Set the UTF-8 content of a text node. Empty text nodes are excluded
    /// from layout until they become non-empty.
    pub fn set_text(&mut self, id: i32, text: &str) {
        let Some(slot) = self.tree.resolve(id) else { return };
        if self.tree.slots[slot as usize].node_type != spec::NodeType::Text as u8
            || self.tree.slots[slot as usize].text == text
        {
            return;
        }
        let root_slot = self.text_layout_root(slot);
        let old_size = self.measure_text_layout(root_slot);
        {
            let node = &mut self.tree.slots[slot as usize];
            node.text.clear();
            node.text.push_str(text);
        }
        if old_size != self.measure_text_layout(root_slot) {
            self.layout.dirty = true;
        }
    }

    /// Solid universal calls this on text updates; same semantics as
    /// `set_text`.
    pub fn replace_text(&mut self, id: i32, text: &str) {
        self.set_text(id, text);
    }

    /// Measure `text` at `font_slot` (px width). Layout measures natively;
    /// this is the JS-facing convenience.
    pub fn measure_text(&self, text: &str, font_slot: u8) -> f32 {
        self.fonts.measure_run(text, font_slot, 0.0, f32::NAN).0
    }

    // ---- assets ----------------------------------------------------------

    /// Upload a texture (raw pixels in `psm` format — spec::psm::*, pow2
    /// dims <= spec::TEX_MAX_DIM). Bytes are copied. Returns handle or -1.
    pub fn upload_texture(&mut self, data: &[u8], w: u32, h: u32, psm: u32) -> i32 {
        let bpp = match psm {
            spec::psm::PSM_4444 => 2usize,
            spec::psm::PSM_8888 => 4usize,
            _ => return -1,
        };
        let pow2 = |v: u32| v > 0 && v <= spec::TEX_MAX_DIM && v & (v - 1) == 0;
        if !pow2(w) || !pow2(h) {
            return -1;
        }
        let byte_len = w as usize * h as usize * bpp;
        if data.len() < byte_len {
            return -1;
        }
        let mut chunks = alloc::vec![0u128; (byte_len + 15) / 16];
        unsafe {
            core::ptr::copy_nonoverlapping(data.as_ptr(), chunks.as_mut_ptr() as *mut u8, byte_len);
        }
        self.textures.push(Texture { data: chunks, byte_len, w, h, psm });
        (self.textures.len() - 1) as i32
    }

    /// Bind an uploaded texture to an image node. Handles are 0-based, so
    /// tex < 0 CLEARS the binding (node.tex = -1, the "none" sentinel);
    /// unknown positive handles are ignored.
    pub fn set_image(&mut self, id: i32, tex: i32) {
        if tex >= 0 && tex as usize >= self.textures.len() {
            return;
        }
        let Some(slot) = self.tree.resolve(id) else { return };
        let node = &mut self.tree.slots[slot as usize];
        if node.node_type == spec::NodeType::Image as u8 {
            node.tex = if tex < 0 { -1 } else { tex };
        }
    }

    /// Parse a styles.bin blob (spec.ts STYLE TABLE format). Replaces the
    /// current table. Returns false on bad magic/version.
    pub fn load_styles(&mut self, bytes: &[u8]) -> bool {
        match style::StyleTable::parse(bytes) {
            Some(t) => {
                self.styles = t;
                self.layout.dirty = true;
                true
            }
            None => false,
        }
    }

    /// Parse a font-atlas blob (spec.ts FONT ATLAS format) and register it at
    /// the slot in its header. Returns false on bad magic/version.
    pub fn load_font_atlas(&mut self, bytes: &[u8]) -> bool {
        let ok = self.fonts.load(bytes);
        if ok {
            self.layout.dirty = true;
        }
        ok
    }

    // ---- animation ---------------------------------------------------------

    /// Start a tween/spring on an animatable prop; `from` = current value.
    /// `easing` is a spec::Easing ordinal. Returns anim id, or -1 if the prop
    /// is not animatable. Layout-dirtying props relayout each animated frame.
    pub fn animate(
        &mut self,
        id: i32,
        prop: u8,
        to: f64,
        dur_ms: u32,
        easing: u8,
        delay_ms: u32,
    ) -> i32 {
        if !spec::is_animatable(prop) || easing > spec::Easing::SpringBouncy as u8 {
            return -1;
        }
        let Some(slot) = self.tree.resolve(id) else { return -1 };
        let kind = spec::PROP_VALUE_KIND[prop as usize];
        let is_color = kind == spec::value_kind::COLOR;
        let from = style::resolve(&self.tree.slots[slot as usize], &self.styles, true).get_bits(prop);
        let to_bits = prop_bits(kind, to);
        let nid = self.tree.slots[slot as usize].id(slot);
        if !is_color {
            let (f, t) = (f32::from_bits(from), f32::from_bits(to_bits));
            // SIZE_FULL sentinel (any negative width/height) is NOT animatable
            // per spec.ts: animate() to/from it is a no-op.
            if (prop == spec::prop::WIDTH || prop == spec::prop::HEIGHT) && (f < 0.0 || t < 0.0) {
                return -1;
            }
            // NaN endpoints (auto/unset) cannot tween — interp would hold NaN
            // for the whole duration. Snap: write the target directly as a
            // dynamic override (browser-style "transition from auto" snap).
            if f.is_nan() || t.is_nan() {
                self.anims.kill_for(nid, prop);
                let node = &mut self.tree.slots[slot as usize];
                tree::Node::remove_entry(&mut node.anim_values, prop);
                tree::Node::put_entry(&mut node.overrides, prop, to_bits);
                if spec::is_layout_dirtying(prop) {
                    self.layout.dirty = true;
                }
                return -1;
            }
        }
        let anim_id = self.anims.spawn(
            nid,
            prop,
            is_color,
            anim::TrackKind::Explicit,
            from,
            to_bits,
            dur_ms,
            easing,
            delay_ms,
        );
        if anim_id > 0 {
            let node = &mut self.tree.slots[slot as usize];
            tree::Node::put_entry(&mut node.anim_values, prop, from);
        }
        anim_id
    }

    /// Cancel a running animation (leaves the prop at its current value, as a
    /// dynamic override).
    pub fn cancel_anim(&mut self, anim_id: i32) {
        let Some(tslot) = self.anims.resolve(anim_id) else { return };
        let (node_id, prop) = {
            let t = &self.anims.tracks[tslot as usize];
            (t.node, t.prop)
        };
        if let Some(slot) = self.tree.resolve(node_id) {
            let node = &mut self.tree.slots[slot as usize];
            if let Some(cur) = tree::Node::find_entry(&node.anim_values, prop) {
                tree::Node::put_entry(&mut node.overrides, prop, cur);
                tree::Node::remove_entry(&mut node.anim_values, prop);
            }
        }
        self.anims.kill(tslot);
    }

    // ---- focus -------------------------------------------------------------

    /// Move focus to `id` (0 clears). Applies the `focus:` style variant
    /// natively — zero JS runs on focus change. Variant swaps run through the
    /// record's transition block like `set_style`.
    pub fn set_focus(&mut self, id: i32) {
        let target = if id == 0 { 0 } else if self.tree.resolve(id).is_some() { id } else { return };
        if target == self.focused {
            return;
        }
        let old_focused = self.focused;
        self.focused = target;
        if let Some(slot) = self.tree.resolve(old_focused) {
            let old = style::resolve(&self.tree.slots[slot as usize], &self.styles, true);
            self.tree.slots[slot as usize].focused = false;
            self.retarget(slot, &old, true);
        }
        if let Some(slot) = self.tree.resolve(target) {
            let old = style::resolve(&self.tree.slots[slot as usize], &self.styles, true);
            self.tree.slots[slot as usize].focused = true;
            self.retarget(slot, &old, true);
        }
        self.layout.dirty = true;
    }

    /// Set the `active:` pressed state (same native variant machinery as
    /// focus; exposed for the hosts' input layer — not a spec op).
    pub fn set_active(&mut self, id: i32, active: bool) {
        let Some(slot) = self.tree.resolve(id) else { return };
        if self.tree.slots[slot as usize].active == active {
            return;
        }
        let old = style::resolve(&self.tree.slots[slot as usize], &self.styles, true);
        self.tree.slots[slot as usize].active = active;
        self.retarget(slot, &old, true);
        self.layout.dirty = true;
    }

    // ---- frame -------------------------------------------------------------

    /// Advance one frame: tick animations by exactly spec::FIXED_DT, then
    /// re-run layout if dirty. Call once per vblank, BEFORE `draw()`.
    pub fn tick(&mut self) {
        self.frame = self.frame.wrapping_add(1);
        // Advance every live track (index loop: tracks may be killed inside).
        for tslot in 0..self.anims.tracks.len() as u32 {
            if !self.anims.tracks[tslot as usize].alive {
                continue;
            }
            let (value, done) = self.anims.tracks[tslot as usize].step();
            let (node_id, prop, kind, to) = {
                let t = &self.anims.tracks[tslot as usize];
                (t.node, t.prop, t.kind, t.to)
            };
            let Some(slot) = self.tree.resolve(node_id) else {
                self.anims.kill(tslot);
                continue;
            };
            let node = &mut self.tree.slots[slot as usize];
            if done {
                match kind {
                    // Transition target == the new resolved value: drop the
                    // anim entry and the style shows through seamlessly.
                    anim::TrackKind::Transition => {
                        tree::Node::remove_entry(&mut node.anim_values, prop)
                    }
                    // Explicit animate(): the final value persists as a
                    // dynamic override.
                    anim::TrackKind::Explicit => {
                        tree::Node::remove_entry(&mut node.anim_values, prop);
                        tree::Node::put_entry(&mut node.overrides, prop, to);
                    }
                }
                self.anims.kill(tslot);
            } else {
                tree::Node::put_entry(&mut node.anim_values, prop, value);
            }
            if spec::is_layout_dirtying(prop) {
                self.layout.dirty = true;
            }
        }
        if self.layout.dirty {
            layout::relayout(&mut self.tree, &self.styles, &self.fonts, &mut self.layout);
        }
    }

    /// Walk the tree into the DrawList (spec.ts DRAWLIST format) and return
    /// it. Output is valid until the next mutating call.
    pub fn draw(&mut self) -> &DrawList {
        if self.layout.dirty {
            layout::relayout(&mut self.tree, &self.styles, &self.fonts, &mut self.layout);
        }
        draw::build(&self.tree, &self.styles, &self.fonts, &mut self.draw_list);
        &self.draw_list
    }

    // ---- introspection (hosts/backends/tests; not spec ops) -----------------

    /// Currently focused node id (0 = none).
    pub fn focused(&self) -> i32 {
        self.focused
    }

    /// cmap-miss count (unmapped codepoints rendered as tofu).
    pub fn glyph_misses(&self) -> u32 {
        self.fonts.misses.get()
    }

    /// Rounded layout rect of a node, relative to its parent: (x, y, w, h).
    pub fn layout_of(&self, id: i32) -> Option<(f32, f32, f32, f32)> {
        let n = self.tree.get(id)?;
        Some((n.layout.x, n.layout.y, n.layout.w, n.layout.h))
    }

    /// The fully-resolved style of a node (variants + overrides + anims).
    pub fn resolved_style(&self, id: i32) -> Option<style::Resolved> {
        let n = self.tree.get(id)?;
        Some(style::resolve(n, &self.styles, true))
    }

    /// Pixels + metadata of an uploaded texture (backends sample this;
    /// bytes are 16-byte aligned): (pixels, w, h, psm).
    pub fn texture(&self, handle: i32) -> Option<(&[u8], u32, u32, u32)> {
        let t = self.textures.get(usize::try_from(handle).ok()?)?;
        Some((t.pixels(), t.w, t.h, t.psm))
    }

    /// A registered font atlas (backends read glyph bitmaps through this).
    pub fn font_atlas(&self, slot: u8) -> Option<&text::Atlas> {
        self.fonts.atlas(slot)
    }

    // ---- internals -----------------------------------------------------------

    /// The taffy leaf affected by a text-node content update. Text children
    /// are absorbed into the nearest top-level text ancestor instead of being
    /// laid out independently.
    fn text_layout_root(&self, mut slot: u32) -> u32 {
        loop {
            let parent = self.tree.slots[slot as usize].parent;
            let Some(parent_slot) = self.tree.resolve(parent) else { return slot };
            if self.tree.slots[parent_slot as usize].node_type != spec::NodeType::Text as u8 {
                return slot;
            }
            slot = parent_slot;
        }
    }

    fn measure_text_layout(&self, slot: u32) -> (f32, f32) {
        let node = &self.tree.slots[slot as usize];
        if node.node_type != spec::NodeType::Text as u8 {
            return (0.0, 0.0);
        }
        let resolved = style::resolve(node, &self.styles, true);
        let mut run = alloc::string::String::new();
        self.tree.collect_run(slot, &mut run);
        if run.is_empty() {
            return (0.0, 0.0);
        }
        self.fonts.measure_run(
            &run,
            resolved.font_slot as u8,
            resolved.tracking,
            resolved.line_height,
        )
    }

    /// After a style/variant mutation on `slot`: spawn transition tweens for
    /// the masked animatable props that changed (from = `old` appearance,
    /// to = the new resolved target sans animation values), and drop stale
    /// anim values so the new style shows through.
    fn retarget(&mut self, slot: u32, old: &style::Resolved, allow_transition: bool) {
        let node_id = self.tree.slots[slot as usize].id(slot);
        let target = style::resolve(&self.tree.slots[slot as usize], &self.styles, false);
        let transition = self
            .styles
            .record(self.tree.slots[slot as usize].style_id)
            .and_then(|r| r.transition);
        // Which props spawn tweens?
        let mut spawned: [bool; 256] = [false; 256];
        if allow_transition {
            if let Some(tr) = transition {
                for prop in 0u16..=255 {
                    let prop = prop as u8;
                    let bit = spec::ANIM_BIT[prop as usize];
                    if bit == 0xff || tr.mask & (1u32 << bit) == 0 {
                        continue;
                    }
                    let from = old.get_bits(prop);
                    let to = target.get_bits(prop);
                    if from == to {
                        continue;
                    }
                    let is_color = spec::PROP_VALUE_KIND[prop as usize] == spec::value_kind::COLOR;
                    if !is_color {
                        let (f, t) = (f32::from_bits(from), f32::from_bits(to));
                        // SIZE_FULL (any negative width/height) is NOT animatable
                        // (spec.ts), and NaN (auto) endpoints cannot tween: spawn
                        // nothing — the new resolved style shows through
                        // immediately (snap), matching browser transitions.
                        let sentinel = (prop == spec::prop::WIDTH || prop == spec::prop::HEIGHT)
                            && (f < 0.0 || t < 0.0);
                        if sentinel || f.is_nan() || t.is_nan() {
                            continue;
                        }
                    }
                    let aid = self.anims.spawn(
                        node_id,
                        prop,
                        is_color,
                        anim::TrackKind::Transition,
                        from,
                        to,
                        tr.dur_ms as u32,
                        tr.easing,
                        tr.delay_ms as u32,
                    );
                    if aid > 0 {
                        spawned[prop as usize] = true;
                        let node = &mut self.tree.slots[slot as usize];
                        tree::Node::put_entry(&mut node.anim_values, prop, from);
                    }
                }
            }
        }
        // Drop anim values that no live track backs (stale completions from a
        // previous style) so the new resolved style isn't masked. Props we
        // just spawned keep their entry; other live tracks keep theirs.
        let anims = &self.anims;
        let node = &mut self.tree.slots[slot as usize];
        node.anim_values
            .retain(|&(p, _)| spawned[p as usize] || anims.has_live(node_id, p));
    }
}

/// Convert a `set_prop`/`animate` f64 payload to raw u32 prop bits per its
/// VALUE_KIND (f32 props carry the number; color/int carry integral bits).
fn prop_bits(kind: u8, value: f64) -> u32 {
    if kind == spec::value_kind::F32 {
        (value as f32).to_bits()
    } else {
        // i64 route so negative ints (e.g. zIndex -1) wrap to their two's
        // complement u32 instead of saturating to 0.
        value as i64 as u32
    }
}

#[cfg(test)]
mod tests;
