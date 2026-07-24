//! RGBA8 raster buffer + tile-based damage tracking for the e-ink panel.
//!
//! The core's software rasterizer (`pocketjs_core::raster::render_scaled`)
//! produces an RGBA8 framebuffer at `logical × density` resolution, cleared to
//! opaque black with every pixel alpha=255. We diff it against the previous
//! frame in 16×16 tiles to drive partial panel updates, then blit the changed
//! pixels as `RGB24`.
//!
//! inkview's `Screen::draw` is generic over the pixel format and branches on
//! the panel depth: on a grayscale panel (PocketBook Verse) it converts
//! `RGB24` → 8-bit gray internally (the same 0.2125R+0.7154G+0.0721B
//! luminance), while on a color panel (PocketBook Era Color, Kaleido 3) it
//! writes the RGB triple directly. One blit path therefore serves both gray
//! and color devices with no host-side conversion.

use inkview::screen::{Screen, RGB24};
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
    /// Current frame, RGBA8 (raster output).
    rgba: Vec<u8>,
    /// Previous frame, RGBA8 (for damage diffing).
    prev: Vec<u8>,
    w: usize,
    h: usize,
    density: u32,
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
        }
    }

    /// Rasterize the DrawList into the RGBA8 buffer at density scale.
    /// `render_scaled` asserts the buffer is exactly `viewport×density` px.
    pub fn rasterize(&mut self, ui: &Ui, words: &[u32]) {
        raster::render_scaled(ui, words, &mut self.rgba, self.density);
    }

    /// Diff the current frame against the previous one and return the changed
    /// tiles (buffer coordinates). Does NOT advance the previous-frame buffer;
    /// call [`Self::advance`] after blitting.
    pub fn diff(&self) -> Vec<DirtyRect> {
        let (w, h) = (self.w, self.h);
        let tx = w.div_ceil(TILE);
        let ty = h.div_ceil(TILE);
        let mut flags = vec![false; tx * ty];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                // Alpha is always 255 (the raster clears opaque), so comparing
                // RGB decides visibility; a 4-byte compare would be equivalent.
                if self.rgba[i] != self.prev[i]
                    || self.rgba[i + 1] != self.prev[i + 1]
                    || self.rgba[i + 2] != self.prev[i + 2]
                {
                    flags[(y / TILE) * tx + (x / TILE)] = true;
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

    /// Latch the current frame as the previous one for the next diff.
    pub fn advance(&mut self) {
        std::mem::swap(&mut self.rgba, &mut self.prev);
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
    /// full_update).
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

    fn solid(fb: &mut FramebufferPipeline, r: u8, g: u8, b: u8) {
        for px in fb.rgba.chunks_exact_mut(4) {
            px[0] = r;
            px[1] = g;
            px[2] = b;
            px[3] = 255;
        }
    }

    #[test]
    fn identical_frames_have_no_damage() {
        let mut fb = FramebufferPipeline::new(32, 32, 1);
        solid(&mut fb, 10, 20, 30);
        fb.advance(); // prev = current
                      // Same content again → no diff.
        solid(&mut fb, 10, 20, 30);
        assert!(fb.diff().is_empty());
    }

    #[test]
    fn color_change_is_damage_even_at_equal_luminance() {
        // Diffing RGBA (not gray) means a hue shift at constant luminance is
        // still reported — conservative (over-reports), which is safe: it only
        // causes an extra blit, never a missed update. Matters for color panels.
        let mut fb = FramebufferPipeline::new(16, 16, 1);
        solid(&mut fb, 255, 0, 0);
        fb.advance();
        solid(&mut fb, 0, 0, 255);
        assert!(!fb.diff().is_empty());
    }

    #[test]
    fn damage_reports_tile_bounds() {
        let mut fb = FramebufferPipeline::new(32, 32, 1);
        // prev = black; change one pixel in tile column 1 (x=16..31).
        fb.advance();
        let i = (0 * 32 + 20) * 4; // y=0, x=20 → tile (1, 0)
        fb.rgba[i] = 255;
        fb.rgba[i + 3] = 255;
        assert_eq!(
            fb.diff(),
            vec![DirtyRect {
                x: 16,
                y: 0,
                w: 16,
                h: 16
            }]
        );
    }
}
