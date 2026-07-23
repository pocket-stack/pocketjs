//! RGBA8 → Gray8 conversion + tile-based damage tracking for the e-ink panel.
//!
//! The core's software rasterizer (`pocketjs_core::raster::render_scaled`)
//! produces an RGBA8 framebuffer at `logical × density` resolution, cleared to
//! opaque black with every pixel alpha=255. We luminance-convert to Gray8 (the
//! panel's native 8-bit grayscale) and diff against the previous frame in
//! 16×16 tiles to drive partial panel updates.

use inkview::screen::{BB8, Screen};
use pocketjs_core::{Ui, raster};

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
    rgba: Vec<u8>,
    gray: Vec<u8>,
    prev: Vec<u8>,
    w: usize,
    h: usize,
    density: u32,
}

impl FramebufferPipeline {
    /// `w`/`h` are the RENDER-buffer dimensions (logical × density).
    pub fn new(w: usize, h: usize, density: u32) -> Self {
        let n = w * h;
        Self {
            rgba: vec![0u8; n * 4],
            gray: vec![255u8; n], // idle white (e-ink holds image without refresh)
            prev: vec![255u8; n],
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

    /// Luminance-convert RGBA8→Gray8 and return the changed tiles (buffer coords).
    pub fn convert_and_diff(&mut self) -> Vec<DirtyRect> {
        let n = self.w * self.h;
        for i in 0..n {
            let r = self.rgba[i * 4] as u32;
            let g = self.rgba[i * 4 + 1] as u32;
            let b = self.rgba[i * 4 + 2] as u32;
            // Integer form of inkview's 0.2125R + 0.7154G + 0.0721B.
            self.gray[i] = ((54 * r + 183 * g + 19 * b) >> 8) as u8;
        }
        let dirty = self.diff();
        std::mem::swap(&mut self.gray, &mut self.prev);
        dirty
    }

    fn diff(&self) -> Vec<DirtyRect> {
        let (w, h) = (self.w, self.h);
        let tx = w.div_ceil(TILE);
        let ty = h.div_ceil(TILE);
        let mut flags = vec![false; tx * ty];
        for y in 0..h {
            let row = y * w;
            for x in 0..w {
                let i = row + x;
                if self.gray[i] != self.prev[i] {
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

    /// Write changed tiles to the inkview framebuffer at screen offset (ox, oy).
    /// Issues no panel update — the caller drives that through `refresh`.
    pub fn blit_dirty(&self, screen: &mut Screen, dirty: &[DirtyRect], ox: usize, oy: usize) {
        for r in dirty {
            for y in r.y..(r.y + r.h) {
                for x in r.x..(r.x + r.w) {
                    screen.draw(x + ox, y + oy, BB8(self.gray[y * self.w + x]));
                }
            }
        }
    }

    /// Full-buffer blit at offset (used on Show / before a full_update).
    pub fn blit_all(&self, screen: &mut Screen, ox: usize, oy: usize) {
        for y in 0..self.h {
            for x in 0..self.w {
                screen.draw(x + ox, y + oy, BB8(self.gray[y * self.w + x]));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn luminance_matches_inkview_coefficients() {
        // Pure green → 0.7154*255 ≈ 182.
        let mut fb = FramebufferPipeline::new(1, 1, 1);
        fb.rgba.copy_from_slice(&[0, 255, 0, 255]);
        fb.prev[0] = 0; // force a diff so we can observe gray[0]
        fb.convert_and_diff();
        // After the swap, prev holds the freshly computed gray.
        assert_eq!(fb.prev[0], ((54 * 0 + 183 * 255 + 19 * 0) >> 8) as u8);
        assert!((fb.prev[0] as i32 - 182).abs() <= 1);
    }

    #[test]
    fn unchanged_frame_has_no_damage() {
        let mut fb = FramebufferPipeline::new(32, 32, 1);
        // Make gray == prev (both start white) → no damage.
        let dirty = fb.convert_and_diff();
        // raster buffer is black → gray becomes 0, differs from white prev.
        assert!(!dirty.is_empty());
        // Second pass with the same black buffer: gray == prev now → no damage.
        fb.gray.copy_from_slice(&fb.prev);
        let dirty2 = fb.convert_and_diff();
        assert!(dirty2.is_empty());
    }

    #[test]
    fn damage_reports_tile_bounds() {
        let mut fb = FramebufferPipeline::new(32, 32, 1);
        // Flip one pixel in the second tile column (x=16..31).
        fb.gray.copy_from_slice(&fb.prev);
        fb.gray[20] = 0; // y=0, x=20 → tile (1, 0)
        // diff() compares gray vs prev directly.
        let dirty = fb.diff();
        assert_eq!(dirty, vec![DirtyRect { x: 16, y: 0, w: 16, h: 16 }]);
    }
}
