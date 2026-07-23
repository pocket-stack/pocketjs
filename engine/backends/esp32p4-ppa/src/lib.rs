//! Hybrid PocketJS DrawList backend for the ESP32-P4 PPA.
//!
//! The render target is always opaque RGB565. Hardware-friendly operations
//! are submitted through [`PpaOps`]; unsupported operations are executed in
//! order by the core's RGB565 software rasterizer. A single aligned A8 scratch
//! plane batches glyphs and alpha-only quads, so antialiasing never requires
//! a 32-bit color framebuffer.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

use alloc::vec::Vec;

use pocketjs_core::raster::{linear_sample_coordinates, pack_rgb565, render_scaled_rgb565_over};
use pocketjs_core::{spec, TexView, Ui};

const MASK_ALIGNMENT: usize = 128;
const CLIP_DEPTH: usize = 32;
const TEXTURE_CLASS_CACHE_LEN: usize = 64;

/// Integer pixel rectangle, using half-open bounds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    #[inline]
    pub const fn area(self) -> u32 {
        self.w.saturating_mul(self.h)
    }

    #[inline]
    const fn is_empty(self) -> bool {
        self.w == 0 || self.h == 0
    }
}

/// Quarter-turn transform supported by the PPA SRM engine.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum QuarterTurn {
    #[default]
    None,
    Ccw90,
    Ccw180,
    Ccw270,
}

/// Scale/rotate/mirror controls passed to the host's PPA SRM implementation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SrmTransform {
    pub rotation: QuarterTurn,
    pub mirror_x: bool,
    pub mirror_y: bool,
}

/// Narrow hardware surface implemented by an ESP-IDF host.
///
/// All calls are synchronous from the DrawList interpreter's perspective:
/// once a method returns `true`, the destination pixels must be visible to
/// subsequent CPU or PPA operations. Returning `false` requests the ordered
/// software fallback.
pub trait PpaOps {
    /// Fill `rect` in the full RGB565 destination.
    fn fill_rgb565(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        rect: Rect,
        color: u16,
    ) -> bool;

    /// Blend an A8 plane over the full RGB565 destination with one fixed RGB
    /// color. `global_alpha` scales every coverage byte.
    fn blend_a8_rgb565(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        mask: &[u8],
        rect: Rect,
        color: [u8; 3],
        global_alpha: u8,
    ) -> bool;

    /// Copy an opaque PSP PSM 5650 texture into the RGB565 destination with
    /// PPA SRM. PSM 5650 stores R and B opposite to ESP RGB565, so the host
    /// must enable the PPA input RGB swap.
    fn srm_psm5650_to_rgb565(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        source: &[u8],
        source_width: u32,
        source_height: u32,
        source_rect: Rect,
        destination_rect: Rect,
        transform: SrmTransform,
    ) -> bool;
}

/// Heuristics controlling when transaction overhead is worth paying.
#[derive(Clone, Copy, Debug)]
pub struct RendererConfig {
    pub scale: u32,
    pub min_fill_pixels: u32,
    pub min_blend_pixels: u32,
    pub min_srm_pixels: u32,
}

impl Default for RendererConfig {
    fn default() -> Self {
        Self {
            scale: 1,
            min_fill_pixels: 1024,
            min_blend_pixels: 256,
            min_srm_pixels: 256,
        }
    }
}

/// Per-frame backend accounting for profiling and regression logs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RenderStats {
    pub ppa_fills: u32,
    pub ppa_blends: u32,
    pub ppa_srm: u32,
    pub software_ops: u32,
    pub software_words: u32,
}

/// Persistent DrawList renderer. The A8 plane and fallback word buffer are
/// reused across frames.
pub struct Renderer {
    config: RendererConfig,
    mask_storage: Vec<u128>,
    mask_offset: usize,
    mask_len: usize,
    fallback_words: Vec<u32>,
    alpha_texture_cache: Vec<(i32, bool)>,
}

impl Renderer {
    pub fn new(config: RendererConfig) -> Option<Self> {
        if !(1..=pocketjs_core::raster::MAX_RENDER_SCALE).contains(&config.scale) {
            return None;
        }
        Some(Self {
            config,
            mask_storage: Vec::new(),
            mask_offset: 0,
            mask_len: 0,
            fallback_words: Vec::with_capacity(16),
            alpha_texture_cache: Vec::new(),
        })
    }

    pub fn config(&self) -> RendererConfig {
        self.config
    }

    /// Render a complete DrawList. `destination` dimensions must equal the
    /// UI viewport multiplied by `config.scale`.
    pub fn render<O: PpaOps>(
        &mut self,
        ui: &Ui,
        words: &[u32],
        destination: &mut [u16],
        width: u32,
        height: u32,
        ppa: &mut O,
    ) -> Option<RenderStats> {
        let scale = self.config.scale;
        let (viewport_w, viewport_h) = ui.viewport();
        if viewport_w as u32 * scale != width
            || viewport_h as u32 * scale != height
            || destination.len() != width as usize * height as usize
        {
            return None;
        }
        self.ensure_mask(destination.len());
        let screen = Clip {
            x0: 0,
            y0: 0,
            x1: viewport_w as i32,
            y1: viewport_h as i32,
        };
        let mut stats = RenderStats::default();

        let full = Rect {
            x: 0,
            y: 0,
            w: width,
            h: height,
        };
        if ppa.fill_rgb565(destination, width, height, full, 0) {
            stats.ppa_fills += 1;
        } else {
            destination.fill(0);
        }

        let mut stack = [screen; CLIP_DEPTH];
        let mut depth = 0usize;
        let mut clip = screen;
        let mut i = 0usize;
        while i < words.len() {
            match words[i] {
                spec::draw_op::RECT if i + 4 <= words.len() => {
                    let rect = logical_rect(words[i + 1], words[i + 2]).intersect(clip);
                    let op = &words[i..i + 4];
                    if !rect.is_empty()
                        && self.try_rect(
                            destination,
                            width,
                            height,
                            rect,
                            words[i + 3],
                            ppa,
                            &mut stats,
                        )
                    {
                        i += 4;
                    } else {
                        self.software_op(ui, destination, clip, op, &mut stats);
                        i += 4;
                    }
                }
                spec::draw_op::GRAD_RECT if i + 6 <= words.len() => {
                    self.software_op(ui, destination, clip, &words[i..i + 6], &mut stats);
                    i += 6;
                }
                spec::draw_op::GLYPH_RUN if i + 3 <= words.len() => {
                    let count = (words[i + 1] >> 16) as usize;
                    let next = i.checked_add(3 + count * 2)?;
                    if next > words.len() {
                        return None;
                    }
                    if !self.try_glyph_run(
                        ui,
                        destination,
                        width,
                        height,
                        clip,
                        &words[i..next],
                        ppa,
                        &mut stats,
                    ) {
                        self.software_op(ui, destination, clip, &words[i..next], &mut stats);
                    }
                    i = next;
                }
                spec::draw_op::TEX_QUAD if i + 9 <= words.len() => {
                    let next = self.try_tex_quad_run(
                        ui,
                        words,
                        i,
                        destination,
                        width,
                        height,
                        clip,
                        ppa,
                        &mut stats,
                    );
                    if let Some(next) = next {
                        i = next;
                    } else {
                        self.software_op(ui, destination, clip, &words[i..i + 9], &mut stats);
                        i += 9;
                    }
                }
                spec::draw_op::SCISSOR if i + 3 <= words.len() => {
                    if depth >= stack.len() {
                        return None;
                    }
                    stack[depth] = clip;
                    depth += 1;
                    clip = screen.intersect(logical_rect(words[i + 1], words[i + 2]));
                    i += 3;
                }
                spec::draw_op::SCISSOR_POP => {
                    if depth > 0 {
                        depth -= 1;
                        clip = stack[depth];
                    } else {
                        clip = screen;
                    }
                    i += 1;
                }
                spec::draw_op::TRI if i + 7 <= words.len() => {
                    self.software_op(ui, destination, clip, &words[i..i + 7], &mut stats);
                    i += 7;
                }
                spec::draw_op::TEX_TRI if i + 12 <= words.len() => {
                    self.software_op(ui, destination, clip, &words[i..i + 12], &mut stats);
                    i += 12;
                }
                _ => return None,
            }
        }
        Some(stats)
    }

    fn try_rect<O: PpaOps>(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        logical: Clip,
        color: u32,
        ppa: &mut O,
        stats: &mut RenderStats,
    ) -> bool {
        let (r, g, b, a) = channels(color);
        if a == 0 {
            return true;
        }
        let rect = physical_rect(logical, self.config.scale);
        if a == 255 && rect.area() >= self.config.min_fill_pixels {
            if ppa.fill_rgb565(destination, width, height, rect, pack_rgb565(r, g, b)) {
                stats.ppa_fills += 1;
                return true;
            }
        } else if rect.area() >= self.config.min_blend_pixels {
            let mask = self.mask_mut();
            fill_mask_rect(mask, width, rect, a as u8);
            if ppa.blend_a8_rgb565(
                destination,
                width,
                height,
                mask,
                rect,
                [r as u8, g as u8, b as u8],
                255,
            ) {
                stats.ppa_blends += 1;
                return true;
            }
        }
        false
    }

    #[allow(clippy::too_many_arguments)]
    fn try_glyph_run<O: PpaOps>(
        &mut self,
        ui: &Ui,
        destination: &mut [u16],
        width: u32,
        height: u32,
        clip: Clip,
        op: &[u32],
        ppa: &mut O,
        stats: &mut RenderStats,
    ) -> bool {
        let slot = (op[1] & 0xff) as u8;
        let color = op[2];
        let (r, g, b, a) = channels(color);
        if a == 0 {
            return true;
        }
        let Some(atlas) = ui.font_atlas(slot) else {
            return true;
        };
        let scale = self.config.scale as i32;
        let cell_w = atlas.cell_w as i32;
        let cell_h = atlas.cell_h as i32;
        let mut bounds = Clip::empty();
        for glyph in op[3..].chunks_exact(2) {
            let (x, y) = xy(glyph[0]);
            let gid = (glyph[1] & 0xffff) as u16;
            if gid < atlas.glyph_count {
                bounds = bounds.union(Clip {
                    x0: x,
                    y0: y,
                    x1: x + cell_w,
                    y1: y + cell_h,
                });
            }
        }
        bounds = bounds.intersect(clip);
        let rect = physical_rect(bounds, self.config.scale);
        if rect.is_empty() || rect.area() < self.config.min_blend_pixels {
            return false;
        }
        let mask = self.mask_mut();
        fill_mask_rect(mask, width, rect, 0);
        let density = atlas.raster_density as i32;
        let coverage_w = atlas.coverage_width() as i32;
        let coverage_h = atlas.coverage_height() as i32;
        let bpr = atlas.bytes_per_row();
        for glyph in op[3..].chunks_exact(2) {
            let (gx, gy) = xy(glyph[0]);
            let gid = (glyph[1] & 0xffff) as u16;
            if gid >= atlas.glyph_count {
                continue;
            }
            let rows = atlas.glyph_rows(gid);
            let x0 = (gx * scale).max(rect.x as i32);
            let y0 = (gy * scale).max(rect.y as i32);
            let x1 = ((gx + cell_w) * scale).min((rect.x + rect.w) as i32);
            let y1 = ((gy + cell_h) * scale).min((rect.y + rect.h) as i32);
            for py in y0..y1 {
                let sy = coverage_index(py - gy * scale, scale, density, coverage_h);
                let row = &rows[sy * bpr..];
                for px in x0..x1 {
                    let sx = coverage_index(px - gx * scale, scale, density, coverage_w);
                    composite_mask(
                        &mut mask[py as usize * width as usize + px as usize],
                        ((row[sx] as u32 * a + 127) / 255) as u8,
                    );
                }
            }
        }
        if ppa.blend_a8_rgb565(
            destination,
            width,
            height,
            mask,
            rect,
            [r as u8, g as u8, b as u8],
            255,
        ) {
            stats.ppa_blends += 1;
            true
        } else {
            false
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn try_tex_quad_run<O: PpaOps>(
        &mut self,
        ui: &Ui,
        words: &[u32],
        start: usize,
        destination: &mut [u16],
        width: u32,
        height: u32,
        clip: Clip,
        ppa: &mut O,
        stats: &mut RenderStats,
    ) -> Option<usize> {
        let op = &words[start..start + 9];
        let handle = op[1] as i32;
        let view = ui.texture(handle)?;

        if view.psm == spec::psm::PSM_5650 {
            let logical = logical_rect(op[2], op[3]).intersect(clip);
            let destination_rect = physical_rect(logical, self.config.scale);
            if destination_rect.area() >= self.config.min_srm_pixels {
                let (source_rect, mirror_x, mirror_y) = texture_source_rect(&view, op, logical)?;
                let one_to_one =
                    source_rect.w == destination_rect.w && source_rect.h == destination_rect.h;
                if (one_to_one || view.linear) && op[8] == 0xffff_ffff {
                    let transform = SrmTransform {
                        mirror_x,
                        mirror_y,
                        ..SrmTransform::default()
                    };
                    if ppa.srm_psm5650_to_rgb565(
                        destination,
                        width,
                        height,
                        view.pixels,
                        view.w,
                        view.h,
                        source_rect,
                        destination_rect,
                        transform,
                    ) {
                        stats.ppa_srm += 1;
                        return Some(start + 9);
                    }
                }
            }
            return None;
        }

        if !self.is_white_alpha_texture(handle, &view) {
            return None;
        }
        let modulate = op[8];
        let mut end = start;
        let mut bounds = Clip::empty();
        while end + 9 <= words.len()
            && words[end] == spec::draw_op::TEX_QUAD
            && words[end + 1] == handle as u32
            && words[end + 8] == modulate
        {
            bounds = bounds.union(logical_rect(words[end + 2], words[end + 3]).intersect(clip));
            end += 9;
        }
        let (r, g, b, a) = channels(modulate);
        if a == 0 {
            return Some(end);
        }
        let rect = physical_rect(bounds, self.config.scale);
        if rect.is_empty() || rect.area() < self.config.min_blend_pixels {
            return None;
        }
        let scale = self.config.scale;
        let mask = self.mask_mut();
        fill_mask_rect(mask, width, rect, 0);
        let mut cursor = start;
        while cursor < end {
            alpha_quad_into_mask(
                &view,
                &words[cursor..cursor + 9],
                clip,
                scale,
                mask,
                width,
                a as u8,
            );
            cursor += 9;
        }
        if ppa.blend_a8_rgb565(
            destination,
            width,
            height,
            mask,
            rect,
            [r as u8, g as u8, b as u8],
            255,
        ) {
            stats.ppa_blends += 1;
            Some(end)
        } else {
            None
        }
    }

    fn software_op(
        &mut self,
        ui: &Ui,
        destination: &mut [u16],
        clip: Clip,
        op: &[u32],
        stats: &mut RenderStats,
    ) {
        if clip.is_empty() {
            return;
        }
        self.fallback_words.clear();
        self.fallback_words.push(spec::draw_op::SCISSOR);
        self.fallback_words.push(pack_xy(clip.x0, clip.y0));
        self.fallback_words
            .push(pack_wh(clip.x1 - clip.x0, clip.y1 - clip.y0));
        self.fallback_words.extend_from_slice(op);
        render_scaled_rgb565_over(ui, &self.fallback_words, destination, self.config.scale);
        stats.software_ops += 1;
        stats.software_words += op.len() as u32;
    }

    fn ensure_mask(&mut self, len: usize) {
        if self.mask_len >= len {
            return;
        }
        let bytes = len + MASK_ALIGNMENT - 1;
        self.mask_storage = alloc::vec![0u128; bytes.div_ceil(16)];
        let base = self.mask_storage.as_ptr() as usize;
        self.mask_offset = (MASK_ALIGNMENT - base % MASK_ALIGNMENT) % MASK_ALIGNMENT;
        self.mask_len = len;
    }

    fn mask_mut(&mut self) -> &mut [u8] {
        unsafe {
            core::slice::from_raw_parts_mut(
                (self.mask_storage.as_mut_ptr() as *mut u8).add(self.mask_offset),
                self.mask_len,
            )
        }
    }

    fn is_white_alpha_texture(&mut self, handle: i32, view: &TexView<'_>) -> bool {
        // T8 video planes can replace their palette and indices in place, so
        // their classification is intentionally never cached.
        if view.psm == spec::psm::PSM_T8 {
            return is_white_alpha_texture(view);
        }
        if let Some((_, result)) = self
            .alpha_texture_cache
            .iter()
            .find(|(cached, _)| *cached == handle)
        {
            return *result;
        }
        let result = is_white_alpha_texture(view);
        if self.alpha_texture_cache.len() == TEXTURE_CLASS_CACHE_LEN {
            self.alpha_texture_cache.remove(0);
        }
        self.alpha_texture_cache.push((handle, result));
        result
    }
}

#[derive(Clone, Copy, Debug)]
struct Clip {
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
}

impl Clip {
    const fn empty() -> Self {
        Self {
            x0: i32::MAX,
            y0: i32::MAX,
            x1: i32::MIN,
            y1: i32::MIN,
        }
    }

    fn intersect(self, other: Self) -> Self {
        Self {
            x0: self.x0.max(other.x0),
            y0: self.y0.max(other.y0),
            x1: self.x1.min(other.x1),
            y1: self.y1.min(other.y1),
        }
    }

    fn union(self, other: Self) -> Self {
        if self.is_empty() {
            return other;
        }
        if other.is_empty() {
            return self;
        }
        Self {
            x0: self.x0.min(other.x0),
            y0: self.y0.min(other.y0),
            x1: self.x1.max(other.x1),
            y1: self.y1.max(other.y1),
        }
    }

    fn is_empty(self) -> bool {
        self.x0 >= self.x1 || self.y0 >= self.y1
    }
}

#[inline]
fn xy(word: u32) -> (i32, i32) {
    (
        (word & 0xffff) as u16 as i16 as i32,
        (word >> 16) as u16 as i16 as i32,
    )
}

#[inline]
fn wh(word: u32) -> (i32, i32) {
    ((word & 0xffff) as i32, (word >> 16) as i32)
}

#[inline]
fn logical_rect(xy_word: u32, wh_word: u32) -> Clip {
    let (x, y) = xy(xy_word);
    let (w, h) = wh(wh_word);
    Clip {
        x0: x,
        y0: y,
        x1: x + w,
        y1: y + h,
    }
}

#[inline]
fn physical_rect(clip: Clip, scale: u32) -> Rect {
    if clip.is_empty() {
        return Rect::default();
    }
    Rect {
        x: clip.x0 as u32 * scale,
        y: clip.y0 as u32 * scale,
        w: (clip.x1 - clip.x0) as u32 * scale,
        h: (clip.y1 - clip.y0) as u32 * scale,
    }
}

#[inline]
fn channels(color: u32) -> (u32, u32, u32, u32) {
    (
        color & 0xff,
        (color >> 8) & 0xff,
        (color >> 16) & 0xff,
        color >> 24,
    )
}

#[inline]
fn pack_xy(x: i32, y: i32) -> u32 {
    x as i16 as u16 as u32 | ((y as i16 as u16 as u32) << 16)
}

#[inline]
fn pack_wh(w: i32, h: i32) -> u32 {
    w as u16 as u32 | ((h as u16 as u32) << 16)
}

#[inline]
fn fill_mask_rect(mask: &mut [u8], stride: u32, rect: Rect, value: u8) {
    for y in rect.y..rect.y + rect.h {
        let start = y as usize * stride as usize + rect.x as usize;
        mask[start..start + rect.w as usize].fill(value);
    }
}

#[inline]
fn composite_mask(destination: &mut u8, source: u8) {
    let d = *destination as u32;
    let s = source as u32;
    *destination = (s + (d * (255 - s) + 127) / 255) as u8;
}

#[inline]
fn coverage_index(destination_px: i32, output_scale: i32, atlas_density: i32, limit: i32) -> usize {
    ((((2 * destination_px + 1) * atlas_density) / (2 * output_scale)).clamp(0, limit - 1)) as usize
}

fn texture_source_rect(
    view: &TexView<'_>,
    op: &[u32],
    clipped_destination: Clip,
) -> Option<(Rect, bool, bool)> {
    let destination = logical_rect(op[2], op[3]);
    if destination.is_empty() || clipped_destination.is_empty() {
        return None;
    }
    let u0 = f32::from_bits(op[4]);
    let v0 = f32::from_bits(op[5]);
    let u1 = f32::from_bits(op[6]);
    let v1 = f32::from_bits(op[7]);
    if !u0.is_finite() || !v0.is_finite() || !u1.is_finite() || !v1.is_finite() {
        return None;
    }
    let destination_w = (destination.x1 - destination.x0) as f32;
    let destination_h = (destination.y1 - destination.y0) as f32;
    let map_u = |x: i32| u0 + (u1 - u0) * (x - destination.x0) as f32 / destination_w;
    let map_v = |y: i32| v0 + (v1 - v0) * (y - destination.y0) as f32 / destination_h;
    let source_u0 = exact_texel_edge(map_u(clipped_destination.x0), view.w)?;
    let source_v0 = exact_texel_edge(map_v(clipped_destination.y0), view.h)?;
    let source_u1 = exact_texel_edge(map_u(clipped_destination.x1), view.w)?;
    let source_v1 = exact_texel_edge(map_v(clipped_destination.y1), view.h)?;
    let x0 = source_u0.min(source_u1);
    let y0 = source_v0.min(source_v1);
    let x1 = source_u0.max(source_u1);
    let y1 = source_v0.max(source_v1);
    (x1 > x0 && y1 > y0).then_some((
        Rect {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        },
        source_u0 > source_u1,
        source_v0 > source_v1,
    ))
}

/// PPA source block offsets are integral texels. Refuse fractional UV edges
/// instead of expanding them and changing the sampling transform. The small
/// tolerance only absorbs normal f32 interpolation error for exact atlas
/// boundaries.
#[inline]
fn exact_texel_edge(uv: f32, extent: u32) -> Option<u32> {
    let value = uv * extent as f32;
    if !value.is_finite() || value < 0.0 || value > extent as f32 {
        return None;
    }
    let rounded = (value + 0.5) as u32;
    let rounded_value = rounded as f32;
    let difference = if value >= rounded_value {
        value - rounded_value
    } else {
        rounded_value - value
    };
    (rounded <= extent && difference <= 0.0001).then_some(rounded)
}

fn is_white_alpha_texture(view: &TexView<'_>) -> bool {
    let count = view.w as usize * view.h as usize;
    match view.psm {
        spec::psm::PSM_8888 => view.pixels[..count * 4].chunks_exact(4).all(|p| {
            let white = p[0] == 255 && p[1] == 255 && p[2] == 255;
            white || (!view.linear && p[3] == 0)
        }),
        spec::psm::PSM_4444 => view.pixels[..count * 2].chunks_exact(2).all(|p| {
            let pixel = u16::from_le_bytes([p[0], p[1]]);
            pixel & 0x0fff == 0x0fff || (!view.linear && pixel >> 12 == 0)
        }),
        spec::psm::PSM_T8 => {
            let Some(palette) = view.palette else {
                return false;
            };
            view.pixels[..count].iter().all(|&index| {
                let p = index as usize * 4;
                let white = palette[p] == 255 && palette[p + 1] == 255 && palette[p + 2] == 255;
                white || (!view.linear && palette[p + 3] == 0)
            })
        }
        _ => false,
    }
}

#[inline]
fn texel_alpha(view: &TexView<'_>, x: i32, y: i32) -> u32 {
    let x = x.clamp(0, view.w as i32 - 1) as usize;
    let y = y.clamp(0, view.h as i32 - 1) as usize;
    let index = y * view.w as usize + x;
    match view.psm {
        spec::psm::PSM_8888 => view.pixels[index * 4 + 3] as u32,
        spec::psm::PSM_4444 => {
            let o = index * 2;
            ((u16::from_le_bytes([view.pixels[o], view.pixels[o + 1]]) >> 12) as u32) * 17
        }
        spec::psm::PSM_T8 => {
            let palette = view.palette.unwrap();
            palette[view.pixels[index] as usize * 4 + 3] as u32
        }
        _ => 0,
    }
}

fn sample_alpha(view: &TexView<'_>, u: f32, v: f32) -> u8 {
    if !view.linear {
        return texel_alpha(view, (u * view.w as f32) as i32, (v * view.h as f32) as i32) as u8;
    }
    let Some(sample) = linear_sample_coordinates(view.w, view.h, u, v) else {
        return 0;
    };
    let lerp = |a: u32, b: u32, f: u32| (a * (256 - f) + b * f) >> 8;
    let top = lerp(
        texel_alpha(view, sample.x0 as i32, sample.y0 as i32),
        texel_alpha(view, sample.x1 as i32, sample.y0 as i32),
        sample.fx,
    );
    let bottom = lerp(
        texel_alpha(view, sample.x0 as i32, sample.y1 as i32),
        texel_alpha(view, sample.x1 as i32, sample.y1 as i32),
        sample.fx,
    );
    lerp(top, bottom, sample.fy) as u8
}

#[allow(clippy::too_many_arguments)]
fn alpha_quad_into_mask(
    view: &TexView<'_>,
    op: &[u32],
    clip: Clip,
    scale: u32,
    mask: &mut [u8],
    stride: u32,
    global_alpha: u8,
) {
    let logical = logical_rect(op[2], op[3]).intersect(clip);
    if logical.is_empty() {
        return;
    }
    let (x, y) = xy(op[2]);
    let (w, h) = wh(op[3]);
    let scale_i = scale as i32;
    let physical = physical_rect(logical, scale);
    let u0 = f32::from_bits(op[4]);
    let v0 = f32::from_bits(op[5]);
    let u1 = f32::from_bits(op[6]);
    let v1 = f32::from_bits(op[7]);
    for py in physical.y..physical.y + physical.h {
        let v = v0 + (v1 - v0) * ((py as i32 - y * scale_i) as f32 + 0.5) / (h * scale_i) as f32;
        for px in physical.x..physical.x + physical.w {
            let u =
                u0 + (u1 - u0) * ((px as i32 - x * scale_i) as f32 + 0.5) / (w * scale_i) as f32;
            let alpha = (sample_alpha(view, u, v) as u32 * global_alpha as u32 + 127) / 255;
            composite_mask(
                &mut mask[py as usize * stride as usize + px as usize],
                alpha as u8,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    #[derive(Default)]
    struct MockPpa {
        fills: u32,
        blends: u32,
        srm: u32,
        last_mask_max: u8,
        last_mask: Vec<u8>,
        last_global_alpha: u8,
        last_source_rect: Rect,
        last_destination_rect: Rect,
        last_transform: SrmTransform,
    }

    impl PpaOps for MockPpa {
        fn fill_rgb565(
            &mut self,
            destination: &mut [u16],
            width: u32,
            _height: u32,
            rect: Rect,
            color: u16,
        ) -> bool {
            self.fills += 1;
            for y in rect.y..rect.y + rect.h {
                let start = y as usize * width as usize + rect.x as usize;
                destination[start..start + rect.w as usize].fill(color);
            }
            true
        }

        fn blend_a8_rgb565(
            &mut self,
            destination: &mut [u16],
            width: u32,
            _height: u32,
            mask: &[u8],
            rect: Rect,
            color: [u8; 3],
            global_alpha: u8,
        ) -> bool {
            self.blends += 1;
            self.last_mask_max = mask.iter().copied().max().unwrap_or(0);
            self.last_mask.clear();
            self.last_mask.extend_from_slice(mask);
            self.last_global_alpha = global_alpha;
            for y in rect.y..rect.y + rect.h {
                for x in rect.x..rect.x + rect.w {
                    let index = y as usize * width as usize + x as usize;
                    let alpha = (mask[index] as u32 * global_alpha as u32 + 127) / 255;
                    blend_rgb565(&mut destination[index], color, alpha);
                }
            }
            true
        }

        fn srm_psm5650_to_rgb565(
            &mut self,
            destination: &mut [u16],
            width: u32,
            _height: u32,
            source: &[u8],
            source_width: u32,
            _source_height: u32,
            source_rect: Rect,
            destination_rect: Rect,
            transform: SrmTransform,
        ) -> bool {
            self.srm += 1;
            self.last_source_rect = source_rect;
            self.last_destination_rect = destination_rect;
            self.last_transform = transform;
            if transform.rotation != QuarterTurn::None
                || source_rect.w != destination_rect.w
                || source_rect.h != destination_rect.h
            {
                return false;
            }
            for dy in 0..destination_rect.h {
                let sy = if transform.mirror_y {
                    source_rect.y + source_rect.h - 1 - dy
                } else {
                    source_rect.y + dy
                };
                for dx in 0..destination_rect.w {
                    let sx = if transform.mirror_x {
                        source_rect.x + source_rect.w - 1 - dx
                    } else {
                        source_rect.x + dx
                    };
                    let source_index = (sy * source_width + sx) as usize * 2;
                    let psm5650 =
                        u16::from_le_bytes([source[source_index], source[source_index + 1]]);
                    let rgb565 = ((psm5650 & 0x001f) << 11)
                        | (psm5650 & 0x07e0)
                        | ((psm5650 & 0xf800) >> 11);
                    let destination_index = (destination_rect.y + dy) as usize * width as usize
                        + (destination_rect.x + dx) as usize;
                    destination[destination_index] = rgb565;
                }
            }
            true
        }
    }

    fn blend_rgb565(destination: &mut u16, color: [u8; 3], alpha: u32) {
        if alpha == 0 {
            return;
        }
        if alpha >= 255 {
            *destination = pack_rgb565(color[0] as u32, color[1] as u32, color[2] as u32);
            return;
        }
        let r5 = (*destination as u32 >> 11) & 0x1f;
        let g6 = (*destination as u32 >> 5) & 0x3f;
        let b5 = *destination as u32 & 0x1f;
        let destination_color = [
            (r5 << 3) | (r5 >> 2),
            (g6 << 2) | (g6 >> 4),
            (b5 << 3) | (b5 >> 2),
        ];
        let inverse_alpha = 255 - alpha;
        let mix = |source: u8, destination: u32| {
            (source as u32 * alpha + destination * inverse_alpha + 127) / 255
        };
        *destination = pack_rgb565(
            mix(color[0], destination_color[0]),
            mix(color[1], destination_color[1]),
            mix(color[2], destination_color[2]),
        );
    }

    fn xy_word(x: i16, y: i16) -> u32 {
        x as u16 as u32 | ((y as u16 as u32) << 16)
    }

    fn wh_word(w: u16, h: u16) -> u32 {
        w as u32 | ((h as u32) << 16)
    }

    fn renderer() -> Renderer {
        Renderer::new(RendererConfig {
            scale: 1,
            min_fill_pixels: 1,
            min_blend_pixels: 1,
            min_srm_pixels: 1,
        })
        .unwrap()
    }

    #[test]
    fn accelerates_fills_and_keeps_gradient_fallback_in_order() {
        let mut ui = Ui::new();
        ui.set_viewport(8.0, 8.0);
        let words = vec![
            spec::draw_op::RECT,
            xy_word(0, 0),
            wh_word(8, 8),
            0xff00_00ff,
            spec::draw_op::GRAD_RECT,
            xy_word(2, 2),
            wh_word(4, 4),
            0xff00_0000,
            0xffff_ffff,
            spec::GradDir::ToRight as u32,
        ];
        let mut output = vec![0u16; 64];
        let mut ppa = MockPpa::default();
        let stats = renderer()
            .render(&ui, &words, &mut output, 8, 8, &mut ppa)
            .unwrap();

        assert_eq!(stats.ppa_fills, 2, "clear plus the red rectangle");
        assert_eq!(stats.software_ops, 1);
        assert_eq!(ppa.fills, 2);
        assert_eq!(output[0], pack_rgb565(255, 0, 0));
        assert_ne!(output[2 * 8 + 2], output[2 * 8 + 5]);
    }

    #[test]
    fn batches_white_alpha_quads_into_one_a8_blend() {
        let mut ui = Ui::new();
        ui.set_viewport(8.0, 8.0);
        let mut texture = vec![0u8; 4 * 4 * 4];
        for (i, pixel) in texture.chunks_exact_mut(4).enumerate() {
            pixel.copy_from_slice(&[255, 255, 255, (i * 17) as u8]);
        }
        let handle = ui.upload_texture(&texture, 4, 4, spec::psm::PSM_8888);
        let quad = |x: i16| {
            [
                spec::draw_op::TEX_QUAD,
                handle as u32,
                xy_word(x, 0),
                wh_word(4, 4),
                0.0f32.to_bits(),
                0.0f32.to_bits(),
                1.0f32.to_bits(),
                1.0f32.to_bits(),
                0xff00_ffff,
            ]
        };
        let words = [quad(0), quad(4)].concat();
        let mut output = vec![0u16; 64];
        let mut ppa = MockPpa::default();
        let stats = renderer()
            .render(&ui, &words, &mut output, 8, 8, &mut ppa)
            .unwrap();

        assert_eq!(stats.ppa_blends, 1);
        assert_eq!(stats.software_ops, 0);
        assert_eq!(ppa.blends, 1);
    }

    #[test]
    fn linear_alpha_mask_matches_core_edge_sampling() {
        let mut ui = Ui::new();
        ui.set_viewport(4.0, 1.0);
        let handle = ui.upload_texture_flags(
            &[
                255, 255, 255, 0, //
                255, 255, 255, 255,
            ],
            2,
            1,
            spec::psm::PSM_8888,
            spec::img::FLAG_LINEAR,
        );
        let words = [
            spec::draw_op::TEX_QUAD,
            handle as u32,
            xy_word(0, 0),
            wh_word(4, 1),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            0xff00_ffff,
        ];
        let mut expected = vec![0u16; 4];
        pocketjs_core::raster::render_scaled_rgb565(&ui, &words, &mut expected, 1);
        let mut output = vec![0u16; 4];
        let mut ppa = MockPpa::default();
        let stats = renderer()
            .render(&ui, &words, &mut output, 4, 1, &mut ppa)
            .unwrap();

        assert_eq!(stats.ppa_blends, 1);
        assert_eq!(stats.software_ops, 0);
        assert_eq!(&ppa.last_mask[..4], &[191, 63, 191, 255]);
        assert_eq!(output, expected);
    }

    #[test]
    fn linear_transparent_color_uses_software_fallback() {
        let mut ui = Ui::new();
        ui.set_viewport(4.0, 1.0);
        let handle = ui.upload_texture_flags(
            &[
                0, 0, 0, 0, //
                255, 255, 255, 255,
            ],
            2,
            1,
            spec::psm::PSM_8888,
            spec::img::FLAG_LINEAR,
        );
        let words = [
            spec::draw_op::TEX_QUAD,
            handle as u32,
            xy_word(0, 0),
            wh_word(4, 1),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            0xffff_ffff,
        ];
        let mut expected = vec![0u16; 4];
        pocketjs_core::raster::render_scaled_rgb565(&ui, &words, &mut expected, 1);
        let mut output = vec![0u16; 4];
        let mut ppa = MockPpa::default();
        let stats = renderer()
            .render(&ui, &words, &mut output, 4, 1, &mut ppa)
            .unwrap();

        assert_eq!(stats.ppa_blends, 0);
        assert_eq!(stats.software_ops, 1);
        assert_eq!(ppa.blends, 0);
        assert_eq!(output, expected);
    }

    #[test]
    fn nearest_transparent_color_remains_alpha_only() {
        let mut ui = Ui::new();
        ui.set_viewport(2.0, 1.0);
        let handle = ui.upload_texture(
            &[
                0, 0, 0, 0, //
                255, 255, 255, 255,
            ],
            2,
            1,
            spec::psm::PSM_8888,
        );
        let words = [
            spec::draw_op::TEX_QUAD,
            handle as u32,
            xy_word(0, 0),
            wh_word(2, 1),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            0xffff_ffff,
        ];
        let mut expected = vec![0u16; 2];
        pocketjs_core::raster::render_scaled_rgb565(&ui, &words, &mut expected, 1);
        let mut output = vec![0u16; 2];
        let mut ppa = MockPpa::default();
        let stats = renderer()
            .render(&ui, &words, &mut output, 2, 1, &mut ppa)
            .unwrap();

        assert_eq!(stats.ppa_blends, 1);
        assert_eq!(stats.software_ops, 0);
        assert_eq!(output, expected);
    }

    #[test]
    fn folds_global_alpha_into_a8_before_batching_overlaps() {
        let mut ui = Ui::new();
        ui.set_viewport(2.0, 2.0);
        let handle = ui.upload_texture(&[255, 255, 255, 255], 1, 1, spec::psm::PSM_8888);
        let quad = [
            spec::draw_op::TEX_QUAD,
            handle as u32,
            xy_word(0, 0),
            wh_word(2, 2),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            0x80ff_ffff,
        ];
        let words = [quad, quad].concat();
        let mut output = vec![0u16; 4];
        let mut ppa = MockPpa::default();
        renderer()
            .render(&ui, &words, &mut output, 2, 2, &mut ppa)
            .unwrap();

        assert_eq!(ppa.blends, 1);
        assert_eq!(ppa.last_global_alpha, 255);
        assert_eq!(ppa.last_mask_max, 192);
    }

    #[test]
    fn routes_opaque_psm5650_texture_to_srm() {
        let mut ui = Ui::new();
        ui.set_viewport(8.0, 8.0);
        let pixels = vec![0x1f, 0x00].repeat(64);
        let handle = ui.upload_texture(&pixels, 8, 8, spec::psm::PSM_5650);
        assert!(handle >= 0);
        let words = [
            spec::draw_op::TEX_QUAD,
            handle as u32,
            xy_word(0, 0),
            wh_word(8, 8),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            0xffff_ffff,
        ];
        let mut output = vec![0u16; 64];
        let mut ppa = MockPpa::default();
        let stats = renderer()
            .render(&ui, &words, &mut output, 8, 8, &mut ppa)
            .unwrap();

        assert_eq!(stats.ppa_srm, 1);
        assert_eq!(stats.software_ops, 0);
        assert_eq!(ppa.srm, 1);
        assert!(output.iter().all(|&pixel| pixel == pack_rgb565(255, 0, 0)));
    }

    #[test]
    fn clips_psm5650_source_and_destination_without_rescaling() {
        let mut ui = Ui::new();
        ui.set_viewport(8.0, 8.0);
        let pixels = vec![0x1f, 0x00].repeat(64);
        let handle = ui.upload_texture(&pixels, 8, 8, spec::psm::PSM_5650);
        let words = [
            spec::draw_op::SCISSOR,
            xy_word(2, 1),
            wh_word(4, 6),
            spec::draw_op::TEX_QUAD,
            handle as u32,
            xy_word(0, 0),
            wh_word(8, 8),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            0xffff_ffff,
            spec::draw_op::SCISSOR_POP,
        ];
        let mut output = vec![0u16; 64];
        let mut ppa = MockPpa::default();
        renderer()
            .render(&ui, &words, &mut output, 8, 8, &mut ppa)
            .unwrap();

        assert_eq!(
            ppa.last_source_rect,
            Rect {
                x: 2,
                y: 1,
                w: 4,
                h: 6,
            }
        );
        assert_eq!(ppa.last_destination_rect, ppa.last_source_rect);
        assert_eq!(ppa.last_transform, SrmTransform::default());
    }

    #[test]
    fn fractional_psm5650_uv_edges_use_ordered_software_fallback() {
        let mut ui = Ui::new();
        ui.set_viewport(8.0, 8.0);
        let pixels = vec![0x1f, 0x00].repeat(64);
        let handle = ui.upload_texture(&pixels, 8, 8, spec::psm::PSM_5650);
        let words = [
            spec::draw_op::TEX_QUAD,
            handle as u32,
            xy_word(0, 0),
            wh_word(8, 8),
            0.1f32.to_bits(),
            0.0f32.to_bits(),
            0.9f32.to_bits(),
            1.0f32.to_bits(),
            0xffff_ffff,
        ];
        let mut output = vec![0u16; 64];
        let mut ppa = MockPpa::default();
        let stats = renderer()
            .render(&ui, &words, &mut output, 8, 8, &mut ppa)
            .unwrap();

        assert_eq!(stats.ppa_srm, 0);
        assert_eq!(stats.software_ops, 1);
    }

    #[test]
    fn empty_scissors_skip_software_fallbacks() {
        let mut ui = Ui::new();
        ui.set_viewport(8.0, 8.0);
        let words = [
            spec::draw_op::SCISSOR,
            xy_word(20, 20),
            wh_word(4, 4),
            spec::draw_op::GRAD_RECT,
            xy_word(0, 0),
            wh_word(8, 8),
            0xff00_0000,
            0xffff_ffff,
            spec::GradDir::ToRight as u32,
            spec::draw_op::SCISSOR_POP,
        ];
        let mut output = vec![pack_rgb565(255, 0, 0); 64];
        let mut ppa = MockPpa::default();
        let stats = renderer()
            .render(&ui, &words, &mut output, 8, 8, &mut ppa)
            .unwrap();

        assert_eq!(stats.software_ops, 0);
        assert!(output.iter().all(|&pixel| pixel == 0));
    }
}
