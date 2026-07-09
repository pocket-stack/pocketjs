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

/// One playing baked-timeline instance: a node's style carries an animation
/// block, so timeline `anim` (styles.bin ANIM TABLE index) runs on `node`.
/// Instances of one style application are pushed contiguously in CSS
/// comma-list order — later instances override earlier ones while both write
/// a prop (retain() keeps the order stable).
struct TimelineInst {
    alive: bool,
    node: i32,
    /// styles.bin ANIM TABLE index.
    anim: u16,
    /// Frames since the style was applied (the node's animation clock).
    clock: u32,
    /// Whole-choreography loop period (style-level `animate-loop-[..]`);
    /// the clock wraps modulo this. 0 = play once.
    loop_frames: u16,
}

/// The retained UI core. One per host/screen.
pub struct Ui {
    tree: tree::Tree,
    styles: style::StyleTable,
    fonts: text::Fonts,
    anims: anim::Anims,
    timelines: Vec<TimelineInst>,
    layout: layout::LayoutEngine,
    textures: Vec<Texture>,
    /// Baked rounded-corner disc sprites (see draw::DiscCache).
    discs: draw::DiscCache,
    focused: i32,
    draw_list: DrawList,
    /// Frame counter advanced by `tick()` (drives fixed-dt animation).
    frame: u64,
    /// DevTools (spec ops 18..22, DEVTOOLS.md). All default-off.
    inspect_id: i32,
    /// World AABB (x, y, w, h) of the inspected node, captured by the last
    /// `draw()` that painted it.
    inspect_rect: Option<(f32, f32, f32, f32)>,
    /// The highlight box as actually drawn last frame — glides toward
    /// `inspect_rect` (draw::build lerps it); purely visual state.
    inspect_drawn: Option<(f32, f32, f32, f32)>,
    paused: bool,
    step_pending: bool,
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
            timelines: Vec::new(),
            layout: layout::LayoutEngine::new(),
            textures: Vec::new(),
            discs: draw::DiscCache::new(),
            focused: 0,
            draw_list: DrawList::new(),
            frame: 0,
            inspect_id: 0,
            inspect_rect: None,
            inspect_drawn: None,
            paused: false,
            step_pending: false,
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
        self.restart_timelines(slot);
        self.layout.mark_style(slot);
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
            self.layout.mark_style(slot);
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
        // Text updates ride the incremental style-dirty path (the restyle
        // branch re-collects the run and re-shapes ONCE). Only an empty <->
        // non-empty flip is structural: empty runs are excluded from the
        // taffy tree entirely, so the leaf has to (dis)appear.
        let root_slot = self.text_layout_root(slot);
        let mut run = alloc::string::String::new();
        self.tree.collect_run(root_slot, &mut run);
        let was_empty = run.is_empty();
        {
            let node = &mut self.tree.slots[slot as usize];
            node.text.clear();
            node.text.push_str(text);
        }
        run.clear();
        self.tree.collect_run(root_slot, &mut run);
        if was_empty != run.is_empty() {
            self.layout.dirty = true;
        } else if !run.is_empty() {
            self.layout.mark_style(root_slot);
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
            node.sprite_frames = 0; // set_image reverts a sprite to a static image
        }
    }

    /// Bind an ANIMATED SPRITE to an image node: `atlas` is an uploaded texture
    /// holding a `cols`-wide grid of `frames` cells; the core auto-plays it,
    /// advancing one cell every `step` vblanks (drawn as a UV sub-rect of the
    /// atlas). `frames == 0` clears the sprite (back to a plain/no image). The
    /// animation is deterministic — frame = (Ui.frame - start) / step % frames —
    /// and starts at frame 0 the moment the node is displayed.
    pub fn set_sprite(&mut self, id: i32, atlas: i32, frames: u32, cols: u32, step: u32) {
        if atlas >= 0 && atlas as usize >= self.textures.len() {
            return;
        }
        let frame = self.frame;
        let Some(slot) = self.tree.resolve(id) else { return };
        let node = &mut self.tree.slots[slot as usize];
        if node.node_type != spec::NodeType::Image as u8 {
            return;
        }
        if frames == 0 || atlas < 0 {
            node.sprite_frames = 0;
            node.tex = -1;
            return;
        }
        node.tex = atlas;
        node.sprite_frames = frames.min(u16::MAX as u32) as u16;
        node.sprite_cols = cols.clamp(1, u16::MAX as u32) as u16;
        node.sprite_step = step.clamp(1, u16::MAX as u32) as u16;
        node.sprite_start = frame;
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
                    self.layout.mark_style(slot);
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
            self.layout.mark_style(slot);
        }
        if let Some(slot) = self.tree.resolve(target) {
            let old = style::resolve(&self.tree.slots[slot as usize], &self.styles, true);
            self.tree.slots[slot as usize].focused = true;
            self.retarget(slot, &old, true);
            self.layout.mark_style(slot);
        }
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
        self.layout.mark_style(slot);
    }

    // ---- frame -------------------------------------------------------------

    /// Advance one frame: tick animations by exactly spec::FIXED_DT, then
    /// re-run layout if dirty. Call once per vblank, BEFORE `draw()`.
    pub fn tick(&mut self) {
        if self.paused {
            if !self.step_pending {
                return;
            }
            self.step_pending = false;
        }
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
                self.layout.mark_style(slot);
            }
        }
        self.tick_timelines();
        if self.layout.needs() {
            layout::relayout(&mut self.tree, &self.styles, &self.fonts, &mut self.layout);
        }
    }

    /// Advance every playing baked timeline one frame and write the sampled
    /// values into the nodes' `anim_values`. Instances of one node are
    /// processed as one contiguous batch so CSS comma-list precedence holds:
    /// the LAST animation currently writing a prop wins; an animation that is
    /// not applying (delay without backwards fill / finished without forwards
    /// fill) yields to earlier list entries, and the prop entry is dropped
    /// when nothing writes it.
    fn tick_timelines(&mut self) {
        use spec::style_table as st;
        // (prop, Some(bits) = write | None = drop) fold buffer, list order.
        let mut writes: Vec<(u8, Option<u32>)> = Vec::new();
        let mut i = 0usize;
        while i < self.timelines.len() {
            if !self.timelines[i].alive {
                i += 1;
                continue;
            }
            let node_id = self.timelines[i].node;
            let mut end = i;
            while end < self.timelines.len() && self.timelines[end].node == node_id {
                end += 1;
            }
            let Some(slot) = self.tree.resolve(node_id) else {
                for inst in &mut self.timelines[i..end] {
                    inst.alive = false;
                }
                i = end;
                continue;
            };
            writes.clear();
            for j in i..end {
                let inst = &mut self.timelines[j];
                if !inst.alive {
                    continue;
                }
                let Some(tl) = self.styles.anims.get(inst.anim as usize) else {
                    inst.alive = false;
                    continue;
                };
                let t_abs = if inst.loop_frames > 0 {
                    inst.clock % inst.loop_frames as u32
                } else {
                    inst.clock
                };
                inst.clock = inst.clock.wrapping_add(1);
                let rel = t_abs as i64 - tl.delay_frames as i64;
                let total = tl.period_frames as i64 * tl.iterations as i64; // 0 = infinite
                for track in &tl.tracks {
                    let is_color =
                        spec::PROP_VALUE_KIND[track.prop as usize] == spec::value_kind::COLOR;
                    let value: Option<u32> = if rel < 0 {
                        (tl.fill & st::ANIM_FILL_BACKWARDS != 0)
                            .then(|| anim::sample_track(track, 0, is_color))
                    } else if tl.iterations != 0 && rel >= total {
                        (tl.fill & st::ANIM_FILL_FORWARDS != 0)
                            .then(|| anim::sample_track(track, tl.period_frames as u32, is_color))
                    } else {
                        let lt = (rel % tl.period_frames as i64) as u32;
                        Some(anim::sample_track(track, lt, is_color))
                    };
                    match writes.iter_mut().find(|(p, _)| *p == track.prop) {
                        // Later list entries override — but only while writing.
                        Some(entry) => {
                            if value.is_some() {
                                entry.1 = value;
                            }
                        }
                        None => writes.push((track.prop, value)),
                    }
                }
            }
            let node = &mut self.tree.slots[slot as usize];
            for &(prop, value) in &writes {
                let prev = tree::Node::find_entry(&node.anim_values, prop);
                match value {
                    Some(bits) => {
                        if prev != Some(bits) {
                            tree::Node::put_entry(&mut node.anim_values, prop, bits);
                            if spec::is_layout_dirtying(prop) {
                                self.layout.mark_style(slot);
                            }
                        }
                    }
                    None => {
                        if prev.is_some() {
                            tree::Node::remove_entry(&mut node.anim_values, prop);
                            if spec::is_layout_dirtying(prop) {
                                self.layout.mark_style(slot);
                            }
                        }
                    }
                }
            }
            i = end;
        }
        self.timelines.retain(|t| t.alive);
    }

    /// After a style application on `slot`: stop the node's playing timelines
    /// and start the new record's animation block (if any) from frame 0.
    fn restart_timelines(&mut self, slot: u32) {
        let node_id = self.tree.slots[slot as usize].id(slot);
        for inst in self.timelines.iter_mut() {
            if inst.alive && inst.node == node_id {
                inst.alive = false;
            }
        }
        let style_id = self.tree.slots[slot as usize].style_id;
        let Some(animation) = self.styles.record(style_id).and_then(|r| r.animation.clone())
        else {
            return;
        };
        for &aid in &animation.anims {
            if (aid as usize) < self.styles.anims.len() {
                self.timelines.push(TimelineInst {
                    alive: true,
                    node: node_id,
                    anim: aid,
                    clock: 0,
                    loop_frames: animation.loop_frames,
                });
            }
        }
    }

    /// Walk the tree into the DrawList (spec.ts DRAWLIST format) and return
    /// it. Output is valid until the next mutating call.
    pub fn draw(&mut self) -> &DrawList {
        if self.layout.needs() {
            layout::relayout(&mut self.tree, &self.styles, &self.fonts, &mut self.layout);
        }
        let (target, drawn) = draw::build(
            &self.tree,
            &self.styles,
            &self.fonts,
            self.frame,
            self.layout.viewport,
            &mut self.textures,
            &mut self.discs,
            &mut self.draw_list,
            self.inspect_id,
            self.inspect_drawn,
        );
        self.inspect_drawn = drawn;
        if self.inspect_id != 0 {
            self.inspect_rect = target;
        }
        &self.draw_list
    }

    /// Resize the logical viewport (root node + layout bounds + draw clip).
    /// Defaults to the PSP's 480x272; desktop hosts call this with their
    /// surface size. Values are clamped to the DrawList's i16 coordinate
    /// range. PSP/wasm hosts never call this, so goldens are unaffected.
    pub fn set_viewport(&mut self, w: f32, h: f32) {
        let w = w.clamp(1.0, 32000.0);
        let h = h.clamp(1.0, 32000.0);
        if self.layout.viewport == (w, h) {
            return;
        }
        self.layout.viewport = (w, h);
        self.set_prop(spec::ROOT_ID, spec::prop::WIDTH, w as f64);
        self.set_prop(spec::ROOT_ID, spec::prop::HEIGHT, h as f64);
    }

    /// The current logical viewport (w, h) in px.
    pub fn viewport(&self) -> (f32, f32) {
        self.layout.viewport
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

    // ---- DevTools ops (spec ops 18..22, DEVTOOLS.md) ------------------------

    /// Set (0 = clear) the inspected node. The next `draw()` that paints it
    /// captures its world AABB and appends the highlight overlay on top.
    pub fn debug_inspect(&mut self, id: i32) {
        self.inspect_id = id;
        self.inspect_rect = None;
        // Keep inspect_drawn: switching targets glides the box from the old
        // node to the new one. Clearing (id 0) hides it via the draw path.
        if id == 0 {
            self.inspect_drawn = None;
        }
    }

    /// Packed `x | y << 16` (i16 halves) of the inspected node's last-drawn
    /// world AABB; -1 if it hasn't been painted since `debug_inspect`.
    pub fn debug_rect_xy(&self) -> i32 {
        match self.inspect_rect {
            Some((x, y, _, _)) => (x as i32 & 0xffff) | ((y as i32) << 16),
            None => -1,
        }
    }

    /// Packed `w | h << 16` of the same AABB; -1 if none.
    pub fn debug_rect_wh(&self) -> i32 {
        match self.inspect_rect {
            Some((_, _, w, h)) => (w as i32 & 0xffff) | ((h as i32) << 16),
            None => -1,
        }
    }

    /// Freeze (or resume) the world: while paused `tick()` is a no-op — the
    /// frame counter, tracks, timelines and sprite clocks all hold. `draw()`
    /// still runs so the highlight overlay stays live.
    pub fn debug_pause(&mut self, on: bool) {
        self.paused = on;
        if !on {
            self.step_pending = false;
        }
    }

    /// Arm exactly one `tick()` while paused (no-op when running).
    pub fn debug_step(&mut self) {
        if self.paused {
            self.step_pending = true;
        }
    }

    /// Whether the world is frozen by `debug_pause`.
    pub fn debug_paused(&self) -> bool {
        self.paused
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
                    // bits >= 32 are timeline/animate()-only (beyond the u32
                    // transition mask — see spec.ts ANIMATABLE).
                    if bit >= 32 || tr.mask & (1u32 << bit) == 0 {
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
