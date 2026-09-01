//! Incremental RGBA8 raster + tile-based damage refinement for the e-ink panel.
//!
//! Two damage layers compose here, each doing what the other cannot:
//!
//! 1. **DrawList damage** (`pocketjs_core::damage::DamageTracker`, via
//!    `raster::render_scaled_incremental`): compares the retained DrawList
//!    against the one whose pixels live in `rgba` and repaints only the
//!    changed regions — rasterization cost scales with what changed, and an
//!    idle frame costs nothing.
//! 2. **Pixel tile diff** (16×16, scoped to the damage regions): decides what
//!    the *panel* must refresh. E-ink updates are the expensive resource, and
//!    conservative DrawList regions can contain pixels that did not actually
//!    change — the tile diff trims the refresh to real pixel changes.
//!
//! `rgba` is the persistent render target (always the complete current
//! frame — `blit_all` can present it at any time); `prev` mirrors what was
//! last diffed against, advanced only inside the damaged tiles.
//!
//! inkview's `Screen::draw` is generic over the pixel format and branches on
//! the panel depth: on a grayscale panel (PocketBook Verse) it converts
//! `RGB24` → 8-bit gray internally (the same 0.2125R+0.7154G+0.0721B
//! luminance), while on a color panel (PocketBook Era Color, Kaleido 3) it
//! writes the RGB triple directly. One blit path therefore serves both gray
//! and color devices with no host-side conversion.

use inkview::screen::{Screen, RGB24};
use pocketjs_core::damage::{DamagePlan, DamagePolicy, DamageRect, DamageTracker};
use pocketjs_core::{raster, Ui};

use crate::Geometry;

/// One changed tile, in render-buffer pixel coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DirtyRect {
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
}

/// Dirty-tile granularity. 16×16 matches the slint backend's damage grain and
/// keeps partial-update rects small without an excessive rect count.
const TILE: usize = 16;

pub struct FramebufferPipeline {
    /// Persistent render target, RGBA8 — always the complete current frame.
    rgba: Vec<u8>,
    /// What the last diff ran against; advanced only inside dirty tiles.
    prev: Vec<u8>,
    w: usize,
    h: usize,
    density: u32,
    /// DrawList snapshot for the pixels retained in `rgba`.
    tracker: DamageTracker,
}

impl FramebufferPipeline {
    /// `w`/`h` are the RENDER-buffer dimensions (logical × density).
    pub fn new(w: usize, h: usize, density: u32) -> Self {
        let n = w * h * 4;
        Self {
            rgba: vec![0u8; n],
            prev: vec![0u8; n],
            w,
            h,
            density,
            tracker: DamageTracker::new(),
        }
    }

    /// Rasterize the DrawList into the retained RGBA8 buffer, repainting only
    /// DrawList damage. Returns the logical damage plan; malformed DrawLists
    /// conservatively fall back to a full render.
    pub fn rasterize(&mut self, ui: &Ui, words: &[u32]) -> DamagePlan {
        match raster::render_scaled_incremental(
            ui,
            words,
            &mut self.rgba,
            self.density,
            &mut self.tracker,
            DamagePolicy::default(),
        ) {
            Ok(plan) => plan,
            Err(_) => {
                raster::render_scaled(ui, words, &mut self.rgba, self.density);
                self.tracker.invalidate();
                let logical = DamageRect::new(
                    0,
                    0,
                    (self.w / self.density as usize) as i32,
                    (self.h / self.density as usize) as i32,
                );
                DamagePlan::full(logical)
            }
        }
    }

    /// Diff the current frame against `prev` inside the plan's regions and
    /// return the changed tiles (buffer coordinates). Pixels outside the plan
    /// are untouched by construction, so they are never scanned. Does NOT
    /// advance `prev`; call [`Self::advance`] after blitting.
    pub fn diff(&self, plan: &DamagePlan) -> Vec<DirtyRect> {
        if plan.is_empty() {
            return Vec::new();
        }
        let (w, h) = (self.w, self.h);
        let tx = w.div_ceil(TILE);
        let ty = h.div_ceil(TILE);
        let mut flags = vec![false; tx * ty];
        for region in plan.regions() {
            let scale = self.density as usize;
            let x0 = (region.x0.max(0) as usize * scale).min(w);
            let y0 = (region.y0.max(0) as usize * scale).min(h);
            let x1 = (region.x1.max(0) as usize * scale).min(w);
            let y1 = (region.y1.max(0) as usize * scale).min(h);
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y * w + x) * 4;
                    // Alpha is always 255 (the raster clears opaque), so
                    // comparing RGB decides visibility.
                    if self.rgba[i] != self.prev[i]
                        || self.rgba[i + 1] != self.prev[i + 1]
                        || self.rgba[i + 2] != self.prev[i + 2]
                    {
                        flags[(y / TILE) * tx + (x / TILE)] = true;
                    }
                }
            }
        }
        flags
            .iter()
            .enumerate()
            .filter(|(_, d)| **d)
            .map(|(i, _)| {
                let px = (i % tx) * TILE;
                let py = (i / tx) * TILE;
                DirtyRect {
                    x: px,
                    y: py,
                    w: TILE.min(w - px),
                    h: TILE.min(h - py),
                }
            })
            .collect()
    }

    /// Latch the blitted tiles into `prev`. Pixels outside `dirty` are equal
    /// in both buffers already (unchanged, or repainted byte-identically).
    pub fn advance(&mut self, dirty: &[DirtyRect]) {
        for r in dirty {
            for dy in 0..r.h {
                let start = ((r.y + dy) * self.w + r.x) * 4;
                let end = start + r.w * 4;
                let (rgba, prev) = (&self.rgba[start..end], &mut self.prev[start..end]);
                prev.copy_from_slice(rgba);
            }
        }
    }

    /// Latch the complete frame (after a `blit_all` full presentation).
    pub fn advance_full(&mut self) {
        self.prev.copy_from_slice(&self.rgba);
    }

    /// Blit changed tiles to the inkview framebuffer, scaling through `geo`.
    /// Issues no panel update — the caller drives that through `refresh`.
    pub fn blit_dirty(&self, screen: &mut Screen, dirty: &[DirtyRect], geo: &Geometry) {
        for r in dirty {
            let (sx_min, sy_min, sw, sh) = geo.render_rect_to_screen(r.x, r.y, r.w, r.h);
            for dy in 0..sh {
                let sy = sy_min + dy;
                let src_y = geo.screen_to_render_y(sy);
                for dx in 0..sw {
                    let sx = sx_min + dx;
                    let src_x = geo.screen_to_render_x(sx);
                    let i = (src_y * self.w + src_x) * 4;
                    screen.draw(
                        sx,
                        sy,
                        RGB24(self.rgba[i], self.rgba[i + 1], self.rgba[i + 2]),
                    );
                }
            }
        }
    }

    /// Full-buffer blit scaled through `geo` (used on Show / before a
    /// full_update). `rgba` is always the complete current frame, so a full
    /// panel redraw needs no re-rasterization.
    pub fn blit_all(&self, screen: &mut Screen, geo: &Geometry) {
        for sy in geo.oy..(geo.oy + geo.disp_h) {
            let src_y = geo.screen_to_render_y(sy);
            for sx in geo.ox..(geo.ox + geo.disp_w) {
                let src_x = geo.screen_to_render_x(sx);
                let i = (src_y * self.w + src_x) * 4;
                screen.draw(
                    sx,
                    sy,
                    RGB24(self.rgba[i], self.rgba[i + 1], self.rgba[i + 2]),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocketjs_core::spec::draw_op;

    fn xy_word(x: i16, y: i16) -> u32 {
        x as u16 as u32 | ((y as u16 as u32) << 16)
    }

    fn wh_word(w: u16, h: u16) -> u32 {
        w as u32 | ((h as u32) << 16)
    }

    fn frame(x: i16, color: u32) -> Vec<u32> {
        vec![
            draw_op::RECT,
            xy_word(0, 0),
            wh_word(64, 32),
            0xff20_1008,
            draw_op::RECT,
            xy_word(x, 4),
            wh_word(6, 6),
            color,
        ]
    }

    fn reference(ui: &Ui, words: &[u32], w: usize, h: usize, density: u32) -> Vec<u8> {
        let mut full = vec![0u8; w * h * 4];
        raster::render_scaled(ui, words, &mut full, density);
        full
    }

    #[test]
    fn incremental_pipeline_matches_full_renders_across_frames() {
        let mut ui = Ui::new();
        ui.set_viewport(64.0, 32.0);
        let mut fb = FramebufferPipeline::new(64, 32, 1);
        let frames = [
            frame(2, 0xff00_00ff),
            frame(20, 0xff00_ff00),
            frame(40, 0xffff_0000),
        ];
        for words in &frames {
            let plan = fb.rasterize(&ui, words);
            let dirty = fb.diff(&plan);
            fb.advance(&dirty);
            assert_eq!(fb.rgba, reference(&ui, words, 64, 32, 1));
            assert_eq!(fb.prev, fb.rgba, "prev latches every changed pixel");
        }
    }

    #[test]
    fn unchanged_frames_produce_no_damage_and_no_dirty_tiles() {
        let mut ui = Ui::new();
        ui.set_viewport(64.0, 32.0);
        let mut fb = FramebufferPipeline::new(64, 32, 1);
        let words = frame(2, 0xff00_00ff);
        let plan = fb.rasterize(&ui, &words);
        assert!(plan.is_full_redraw(), "first frame repaints everything");
        let dirty = fb.diff(&plan);
        fb.advance(&dirty);

        let plan = fb.rasterize(&ui, &words);
        assert!(plan.is_empty(), "unchanged DrawList → zero raster work");
        assert!(fb.diff(&plan).is_empty());
    }

    #[test]
    fn dirty_tiles_are_scoped_to_the_damage_regions() {
        let mut ui = Ui::new();
        ui.set_viewport(64.0, 32.0);
        let mut fb = FramebufferPipeline::new(64, 32, 1);
        let plan = fb.rasterize(&ui, &frame(2, 0xff00_00ff));
        let dirty = fb.diff(&plan);
        fb.advance(&dirty);

        // Move the small rect: damage = old box ∪ new box, both in y 4..10.
        let plan = fb.rasterize(&ui, &frame(40, 0xff00_00ff));
        assert!(!plan.is_full_redraw());
        let dirty = fb.diff(&plan);
        assert!(!dirty.is_empty());
        for tile in &dirty {
            assert!(tile.y < 16, "dirty tiles stay in the damaged band");
        }
        fb.advance(&dirty);
        assert_eq!(fb.prev, fb.rgba);
    }

    #[test]
    fn equal_pixels_inside_damage_produce_no_panel_refresh() {
        // A DrawList change that renders identical pixels damages the region
        // but must not dirty any tile — the pixel diff is what protects the
        // e-ink panel from needless flashes.
        let mut ui = Ui::new();
        ui.set_viewport(64.0, 32.0);
        let mut fb = FramebufferPipeline::new(64, 32, 1);
        let base = vec![
            draw_op::RECT,
            xy_word(0, 0),
            wh_word(64, 32),
            0xff10_2030,
            draw_op::RECT,
            xy_word(4, 4),
            wh_word(8, 8),
            0xffff_ffff,
        ];
        // Same pixels: the white rect painted twice (opaque over itself).
        let repainted = vec![
            draw_op::RECT,
            xy_word(0, 0),
            wh_word(64, 32),
            0xff10_2030,
            draw_op::RECT,
            xy_word(4, 4),
            wh_word(8, 8),
            0xffff_ffff,
            draw_op::RECT,
            xy_word(4, 4),
            wh_word(8, 8),
            0xffff_ffff,
        ];
        let plan = fb.rasterize(&ui, &base);
        let dirty = fb.diff(&plan);
        fb.advance(&dirty);

        // Structural change (op count differs) → conservative full replan,
        // but the pixels are identical → zero dirty tiles, zero e-ink work.
        let plan = fb.rasterize(&ui, &repainted);
        assert!(plan.is_full_redraw());
        assert!(fb.diff(&plan).is_empty());
    }

    #[test]
    fn density_two_scopes_damage_to_physical_pixels() {
        let mut ui = Ui::new_with_raster_density(2);
        ui.set_viewport(32.0, 16.0);
        let mut fb = FramebufferPipeline::new(64, 32, 2);
        let plan = fb.rasterize(&ui, &frame(1, 0xff00_00ff));
        let dirty = fb.diff(&plan);
        fb.advance(&dirty);

        let words = frame(1, 0xff00_ff00);
        let plan = fb.rasterize(&ui, &words);
        assert!(!plan.is_full_redraw());
        let dirty = fb.diff(&plan);
        assert!(!dirty.is_empty());
        fb.advance(&dirty);
        assert_eq!(fb.rgba, reference(&ui, &words, 64, 32, 2));
        assert_eq!(fb.prev, fb.rgba);
    }
}
