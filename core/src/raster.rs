//! Deterministic software rasterizer: executes the core DrawList (spec.ts
//! "DRAWLIST op format") over an RGBA8 framebuffer. DrawList coordinates
//! remain logical; [`render_scaled`] maps them directly onto an integer-scaled
//! physical surface without first rasterizing a low-resolution image.
//!
//! Determinism rules (byte-exact goldens depend on this):
//!   - Color math is INTEGER (u32/i64) everywhere: blending, gouraud triangle
//!     interpolation, texture modulation.
//!   - Triangle coverage uses exact integer edge functions evaluated at
//!     doubled pixel-center coordinates (vertex coords are i16 integers, so
//!     nothing ever rounds).
//!   - The only f32 involved is gradient/texture-coordinate interpolation —
//!     plain IEEE-754 add/mul/div on finite values (identical on every
//!     platform; no transcendental calls, no NaN paths: every divisor is
//!     checked > 0 first).
//!
//! Clipping: the core pre-clips every op to the screen AND to enclosing
//! scissors, but per the documented core degradations GLYPH_RUN cells and
//! (defensively) TEX_QUAD texels still rely on the backend scissor for
//! partial overlap at clip edges — so we keep a scissor stack and pixel-clip
//! EVERY op against the current rect (a no-op for the pre-clipped ones).
//!
//! Framebuffer layout: row-major, top-left origin, 4 bytes/px R,G,B,A —
//! which is exactly a little-endian ABGR u32 (0xAABBGGRR), the spec color
//! format, so channel bytes map 1:1. The buffer is treated as opaque: the
//! destination alpha is always written back as 255.

use crate::spec::{self, draw_op, SCREEN_H, SCREEN_W};
use crate::{TexView, Ui};

pub const MAX_RENDER_SCALE: u32 = 4;

/// Integer clip rect: x0/y0 inclusive, x1/y1 exclusive.
#[derive(Clone, Copy)]
struct Clip {
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
}

impl Clip {
    #[inline]
    fn intersect(&self, o: Clip) -> Clip {
        Clip {
            x0: self.x0.max(o.x0),
            y0: self.y0.max(o.y0),
            x1: self.x1.min(o.x1),
            y1: self.y1.min(o.y1),
        }
    }
}

// ---- word decoding -----------------------------------------------------------

#[inline]
fn xy(word: u32, scale: i32) -> (i32, i32) {
    (
        (word & 0xffff) as u16 as i16 as i32 * scale,
        (word >> 16) as u16 as i16 as i32 * scale,
    )
}

#[inline]
fn wh(word: u32, scale: i32) -> (i32, i32) {
    ((word & 0xffff) as i32 * scale, (word >> 16) as i32 * scale)
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

// ---- pixel ops -----------------------------------------------------------------

/// src-over blend one pixel (integer, round-to-nearest). Caller guarantees
/// (x, y) inside the framebuffer. Destination treated as opaque.
#[inline]
fn blend_px(fb: &mut [u8], stride: i32, x: i32, y: i32, r: u32, g: u32, b: u32, a: u32) {
    let o = ((y * stride + x) * 4) as usize;
    if a >= 255 {
        fb[o] = r as u8;
        fb[o + 1] = g as u8;
        fb[o + 2] = b as u8;
        fb[o + 3] = 255;
        return;
    }
    if a == 0 {
        return;
    }
    let ia = 255 - a;
    let mix = |s: u32, d: u8| ((s * a + d as u32 * ia + 127) / 255) as u8;
    fb[o] = mix(r, fb[o]);
    fb[o + 1] = mix(g, fb[o + 1]);
    fb[o + 2] = mix(b, fb[o + 2]);
    fb[o + 3] = 255;
}

/// Fill an already-clipped span rect with one flat color.
fn fill_rect(fb: &mut [u8], stride: i32, c: Clip, color: u32) {
    let (r, g, b, a) = channels(color);
    if a == 0 {
        return;
    }
    for y in c.y0..c.y1 {
        for x in c.x0..c.x1 {
            blend_px(fb, stride, x, y, r, g, b, a);
        }
    }
}

/// Integer lerp of two packed ABGR colors at f in [0,1] (round-to-nearest;
/// f itself is a deterministic f32 pixel-center fraction).
#[inline]
fn lerp_color(from: u32, to: u32, f: f32) -> u32 {
    let mix = |a: u32, b: u32| {
        let af = a as f32;
        (af + (b as f32 - af) * f + 0.5) as u32
    };
    let (fr, fg, fb_, fa) = channels(from);
    let (tr, tg, tb, ta) = channels(to);
    mix(fr, tr) | (mix(fg, tg) << 8) | (mix(fb_, tb) << 16) | (mix(fa, ta) << 24)
}

// ---- the interpreter --------------------------------------------------------------

/// Execute `words` into the byte-exact legacy 480x272 surface.
pub fn render(ui: &Ui, words: &[u32], fb: &mut [u8]) {
    render_scaled(ui, words, fb, 1);
}

/// Execute `words` (a full DrawList) directly into an integer-scaled physical
/// surface. `fb` must contain exactly `SCREEN_W*scale × SCREEN_H*scale` RGBA8
/// pixels. Geometry, clips and gradient/triangle sample points are evaluated
/// at physical resolution; textures are sampled over that destination and
/// font coverage accounts for the atlas's own raster density.
/// `ui` supplies font atlases and textures. The framebuffer is cleared to
/// opaque black first (the PSP host clears the draw buffer the same way).
pub fn render_scaled(ui: &Ui, words: &[u32], fb: &mut [u8], scale: u32) {
    assert!(
        (1..=MAX_RENDER_SCALE).contains(&scale),
        "render scale must be 1 through 4"
    );
    let scale = scale as i32;
    let width = SCREEN_W as i32 * scale;
    let height = SCREEN_H as i32 * scale;
    let expected = width as usize * height as usize * 4;
    assert_eq!(
        fb.len(),
        expected,
        "scaled framebuffer has the wrong byte length"
    );
    let screen = Clip {
        x0: 0,
        y0: 0,
        x1: width,
        y1: height,
    };
    // Clear: opaque black.
    for px in fb.chunks_exact_mut(4) {
        px[0] = 0;
        px[1] = 0;
        px[2] = 0;
        px[3] = 255;
    }

    let mut stack: [Clip; 32] = [screen; 32];
    let mut depth: usize = 0;
    let mut clip = screen;

    let mut i = 0usize;
    while i < words.len() {
        match words[i] {
            draw_op::RECT => {
                if i + 4 > words.len() {
                    return;
                }
                let (x, y) = xy(words[i + 1], scale);
                let (w, h) = wh(words[i + 2], scale);
                let c = clip.intersect(Clip {
                    x0: x,
                    y0: y,
                    x1: x + w,
                    y1: y + h,
                });
                if c.x0 < c.x1 && c.y0 < c.y1 {
                    fill_rect(fb, width, c, words[i + 3]);
                }
                i += 4;
            }
            draw_op::GRAD_RECT => {
                if i + 6 > words.len() {
                    return;
                }
                let (x, y) = xy(words[i + 1], scale);
                let (w, h) = wh(words[i + 2], scale);
                grad_rect(
                    fb,
                    width,
                    clip,
                    x,
                    y,
                    w,
                    h,
                    words[i + 3],
                    words[i + 4],
                    words[i + 5],
                );
                i += 6;
            }
            draw_op::GLYPH_RUN => {
                if i + 3 > words.len() {
                    return;
                }
                let slot = (words[i + 1] & 0xff) as u8;
                let n = (words[i + 1] >> 16) as usize;
                let color = words[i + 2];
                if i + 3 + 2 * n > words.len() {
                    return;
                }
                glyph_run(
                    ui,
                    fb,
                    width,
                    scale,
                    clip,
                    slot,
                    color,
                    &words[i + 3..i + 3 + 2 * n],
                );
                i += 3 + 2 * n;
            }
            draw_op::TEX_QUAD => {
                if i + 9 > words.len() {
                    return;
                }
                tex_quad(ui, fb, width, scale, clip, &words[i + 1..i + 9]);
                i += 9;
            }
            draw_op::SCISSOR => {
                if i + 3 > words.len() || depth >= stack.len() {
                    return;
                }
                stack[depth] = clip;
                depth += 1;
                let (x, y) = xy(words[i + 1], scale);
                let (w, h) = wh(words[i + 2], scale);
                // The core emits scissor rects already intersected with every
                // enclosing scissor — SET (still guard against the screen).
                clip = screen.intersect(Clip {
                    x0: x,
                    y0: y,
                    x1: x + w,
                    y1: y + h,
                });
                i += 3;
            }
            draw_op::SCISSOR_POP => {
                if depth > 0 {
                    depth -= 1;
                    clip = stack[depth];
                } else {
                    clip = screen;
                }
                i += 1;
            }
            draw_op::TRI => {
                if i + 7 > words.len() {
                    return;
                }
                tri(fb, width, scale, clip, &words[i + 1..i + 7]);
                i += 7;
            }
            draw_op::TEX_TRI => {
                if i + 12 > words.len() {
                    return;
                }
                tex_tri(ui, fb, width, scale, clip, &words[i + 1..i + 12]);
                i += 12;
            }
            // The op set is closed per DrawList version; anything else means
            // corrupt data — stop instead of misinterpreting the stream.
            _ => return,
        }
    }
}

// ---- GRAD_RECT: per-axis gouraud lerp ---------------------------------------------

#[allow(clippy::too_many_arguments)]
fn grad_rect(
    fb: &mut [u8],
    stride: i32,
    clip: Clip,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    from: u32,
    to: u32,
    dir: u32,
) {
    if w <= 0 || h <= 0 {
        return;
    }
    let c = clip.intersect(Clip {
        x0: x,
        y0: y,
        x1: x + w,
        y1: y + h,
    });
    if c.x0 >= c.x1 || c.y0 >= c.y1 {
        return;
    }
    let horizontal = dir == spec::GradDir::ToLeft as u32 || dir == spec::GradDir::ToRight as u32;
    // "from" sits at the axis start for ToBottom/ToRight, at the axis end for
    // ToTop/ToLeft (matches core draw.rs corner_color()).
    let reversed = dir == spec::GradDir::ToTop as u32 || dir == spec::GradDir::ToLeft as u32;
    let (a, b) = if reversed { (to, from) } else { (from, to) };
    if horizontal {
        let inv = 1.0f32 / w as f32;
        for px in c.x0..c.x1 {
            let f = ((px - x) as f32 + 0.5) * inv;
            let col = lerp_color(a, b, f);
            let (r, g, bb, al) = channels(col);
            if al == 0 {
                continue;
            }
            for py in c.y0..c.y1 {
                blend_px(fb, stride, px, py, r, g, bb, al);
            }
        }
    } else {
        let inv = 1.0f32 / h as f32;
        for py in c.y0..c.y1 {
            let f = ((py - y) as f32 + 0.5) * inv;
            let col = lerp_color(a, b, f);
            let (r, g, bb, al) = channels(col);
            if al == 0 {
                continue;
            }
            for px in c.x0..c.x1 {
                blend_px(fb, stride, px, py, r, g, bb, al);
            }
        }
    }
}

// ---- TRI: barycentric gouraud fill --------------------------------------------------

/// Exact integer edge function at doubled coordinates:
/// cross(b - a, p - a) where all inputs are 2x integer screen coords.
#[inline]
fn orient(ax: i64, ay: i64, bx: i64, by: i64, px: i64, py: i64) -> i64 {
    (bx - ax) * (py - ay) - (by - ay) * (px - ax)
}

fn tri(fb: &mut [u8], stride: i32, scale: i32, clip: Clip, p: &[u32]) {
    let (x0, y0) = xy(p[0], scale);
    let (x1, y1) = xy(p[1], scale);
    let (x2, y2) = xy(p[2], scale);
    let c0 = p[3];
    let (mut c1, mut c2) = (p[4], p[5]);
    // Doubled coords: vertices at 2*v, sample points at 2*px+1 (pixel center).
    let (ax, ay) = (2 * x0 as i64, 2 * y0 as i64);
    let (mut bx, mut by) = (2 * x1 as i64, 2 * y1 as i64);
    let (mut cx, mut cy) = (2 * x2 as i64, 2 * y2 as i64);
    let mut area = orient(ax, ay, bx, by, cx, cy);
    if area == 0 {
        return;
    }
    if area < 0 {
        // Wind CCW-positive so all edge functions share the sign of `area`.
        core::mem::swap(&mut bx, &mut cx);
        core::mem::swap(&mut by, &mut cy);
        core::mem::swap(&mut c1, &mut c2);
        area = -area;
    }
    let min_x = x0.min(x1).min(x2).max(clip.x0);
    let max_x = x0.max(x1).max(x2).min(clip.x1);
    let min_y = y0.min(y1).min(y2).max(clip.y0);
    let max_y = y0.max(y1).max(y2).min(clip.y1);
    let (r0, g0, b0, a0) = channels(c0);
    let (r1, g1, b1, a1) = channels(c1);
    let (r2, g2, b2, a2) = channels(c2);
    let flat = c0 == c1 && c1 == c2;
    let half = area / 2;
    for py in min_y..max_y {
        let sy = 2 * py as i64 + 1;
        for px in min_x..max_x {
            let sx = 2 * px as i64 + 1;
            // Barycentric weights of the OPPOSITE vertices.
            let w0 = orient(bx, by, cx, cy, sx, sy);
            let w1 = orient(cx, cy, ax, ay, sx, sy);
            let w2 = orient(ax, ay, bx, by, sx, sy);
            if w0 < 0 || w1 < 0 || w2 < 0 {
                continue;
            }
            if flat {
                blend_px(fb, stride, px, py, r0, g0, b0, a0);
            } else {
                // Integer barycentric interpolation, round-to-nearest.
                let mix = |v0: u32, v1: u32, v2: u32| {
                    ((v0 as i64 * w0 + v1 as i64 * w1 + v2 as i64 * w2 + half) / area) as u32
                };
                blend_px(
                    fb,
                    stride,
                    px,
                    py,
                    mix(r0, r1, r2),
                    mix(g0, g1, g2),
                    mix(b0, b1, b2),
                    mix(a0, a1, a2),
                );
            }
        }
    }
}

// ---- GLYPH_RUN: coverage atlas cells -----------------------------------------------

#[inline]
fn coverage_index(destination_px: i32, output_scale: i32, atlas_density: i32, limit: i32) -> usize {
    // Nearest-neighbour at destination pixel centers. This is identical to a
    // 1:1 lookup when output_scale == atlas_density, duplicates coverage when
    // the output is denser, and samples the center of each source interval
    // when a high-density atlas is rendered onto a lower-density surface.
    ((((2 * destination_px + 1) * atlas_density) / (2 * output_scale)).clamp(0, limit - 1)) as usize
}

#[allow(clippy::too_many_arguments)]
fn glyph_run(
    ui: &Ui,
    fb: &mut [u8],
    stride: i32,
    output_scale: i32,
    clip: Clip,
    slot: u8,
    color: u32,
    glyphs: &[u32],
) {
    let Some(atlas) = ui.font_atlas(slot) else {
        return;
    };
    let (r, g, b, a) = channels(color);
    if a == 0 {
        return;
    }
    let cell_w = atlas.cell_w as i32 * output_scale;
    let cell_h = atlas.cell_h as i32 * output_scale;
    let atlas_density = atlas.raster_density as i32;
    let coverage_w = atlas.coverage_width() as i32;
    let coverage_h = atlas.coverage_height() as i32;
    let bpr = atlas.bytes_per_row();
    for pair in glyphs.chunks_exact(2) {
        let (gx, gy) = xy(pair[0], output_scale);
        let gid = (pair[1] & 0xffff) as u16;
        if gid >= atlas.glyph_count {
            continue;
        }
        // Cell-vs-clip pixel window (partial glyphs at scissor edges clip here).
        let x0 = gx.max(clip.x0);
        let x1 = (gx + cell_w).min(clip.x1);
        let y0 = gy.max(clip.y0);
        let y1 = (gy + cell_h).min(clip.y1);
        if x0 >= x1 || y0 >= y1 {
            continue;
        }
        let rows = atlas.glyph_rows(gid);
        for py in y0..y1 {
            let sy = coverage_index(py - gy, output_scale, atlas_density, coverage_h);
            let row = &rows[sy * bpr..];
            for px in x0..x1 {
                let cx = coverage_index(px - gx, output_scale, atlas_density, coverage_w);
                let cov = row[cx] as u32;
                if cov != 0 {
                    blend_px(fb, stride, px, py, r, g, b, (a * cov + 127) / 255);
                }
            }
        }
    }
}

// ---- texel fetch + samplers ----------------------------------------------------------

/// Fetch texel `idx` (row-major) as (r, g, b, a) channels 0..255. None for
/// an unknown psm (corrupt stream — callers abort the op, matching the old
/// inline `_ => return` arms byte-for-byte on the known formats).
#[inline]
fn texel(view: &TexView, idx: usize) -> Option<(u32, u32, u32, u32)> {
    match view.psm {
        spec::psm::PSM_8888 => {
            let o = idx * 4;
            Some((
                view.pixels[o] as u32,
                view.pixels[o + 1] as u32,
                view.pixels[o + 2] as u32,
                view.pixels[o + 3] as u32,
            ))
        }
        spec::psm::PSM_4444 => {
            // u16 LE, nibbles A<<12 | B<<8 | G<<4 | R; expand n -> n*17.
            let o = idx * 2;
            let px16 = view.pixels[o] as u32 | ((view.pixels[o + 1] as u32) << 8);
            Some((
                (px16 & 0xf) * 17,
                ((px16 >> 4) & 0xf) * 17,
                ((px16 >> 8) & 0xf) * 17,
                ((px16 >> 12) & 0xf) * 17,
            ))
        }
        spec::psm::PSM_T8 => {
            // CLUT8: one palette index/px; palette bytes are RGBA in memory
            // (same byte order as 8888 pixels). Index * 4 <= 1020 < 1024, so
            // the lookup can never leave the 1024-byte CLUT.
            let pal = view.palette?;
            let o = view.pixels[idx] as usize * 4;
            Some((
                pal[o] as u32,
                pal[o + 1] as u32,
                pal[o + 2] as u32,
                pal[o + 3] as u32,
            ))
        }
        _ => None,
    }
}

/// Deterministic integer bilinear sample at normalized (u, v). Texel coords
/// are 24.8 fixed point centered on texel centers (`uf = u*w*256 - 128`);
/// the 4 clamp-addressed neighbors blend with 8-bit weights, horizontal
/// first then vertical — integer math only, so byte-exact on every host.
#[inline]
fn sample_linear(view: &TexView, u: f32, v: f32) -> Option<(u32, u32, u32, u32)> {
    let (tw_max, th_max) = (view.w as i32 - 1, view.h as i32 - 1);
    let uf = (u * view.w as f32 * 256.0) as i32 - 128;
    let vf = (v * view.h as f32 * 256.0) as i32 - 128;
    let tx0 = (uf >> 8).clamp(0, tw_max);
    let ty0 = (vf >> 8).clamp(0, th_max);
    let tx1 = (tx0 + 1).min(tw_max);
    let ty1 = (ty0 + 1).min(th_max);
    let fx = (uf & 255) as u32;
    let fy = (vf & 255) as u32;
    let w = view.w as i32;
    let c00 = texel(view, (ty0 * w + tx0) as usize)?;
    let c01 = texel(view, (ty0 * w + tx1) as usize)?;
    let c10 = texel(view, (ty1 * w + tx0) as usize)?;
    let c11 = texel(view, (ty1 * w + tx1) as usize)?;
    let lerp8 = |a: u32, b: u32, f: u32| (a * (256 - f) + b * f) >> 8;
    let mix = |c0: u32, c1: u32, c2: u32, c3: u32| lerp8(lerp8(c0, c1, fx), lerp8(c2, c3, fx), fy);
    Some((
        mix(c00.0, c01.0, c10.0, c11.0),
        mix(c00.1, c01.1, c10.1, c11.1),
        mix(c00.2, c01.2, c10.2, c11.2),
        mix(c00.3, c01.3, c10.3, c11.3),
    ))
}

// ---- TEX_TRI: barycentric textured triangle (affine UV; nearest, or integer
//      bilinear when the texture carries the linear flag) --------------------

fn tex_tri(ui: &Ui, fb: &mut [u8], stride: i32, scale: i32, clip: Clip, p: &[u32]) {
    let handle = p[0] as i32;
    let (x0, y0) = xy(p[1], scale);
    let (u0, v0) = (f32::from_bits(p[2]), f32::from_bits(p[3]));
    let (x1, y1) = xy(p[4], scale);
    let (mut u1, mut v1) = (f32::from_bits(p[5]), f32::from_bits(p[6]));
    let (x2, y2) = xy(p[7], scale);
    let (mut u2, mut v2) = (f32::from_bits(p[8]), f32::from_bits(p[9]));
    let modulate = p[10];
    let Some(view) = ui.texture(handle) else {
        return;
    };
    let (ax, ay) = (2 * x0 as i64, 2 * y0 as i64);
    let (mut bx, mut by) = (2 * x1 as i64, 2 * y1 as i64);
    let (mut cx, mut cy) = (2 * x2 as i64, 2 * y2 as i64);
    let mut area = orient(ax, ay, bx, by, cx, cy);
    if area == 0 {
        return;
    }
    if area < 0 {
        core::mem::swap(&mut bx, &mut cx);
        core::mem::swap(&mut by, &mut cy);
        core::mem::swap(&mut u1, &mut u2);
        core::mem::swap(&mut v1, &mut v2);
        area = -area;
    }
    let min_x = x0.min(x1).min(x2).max(clip.x0);
    let max_x = x0.max(x1).max(x2).min(clip.x1);
    let min_y = y0.min(y1).min(y2).max(clip.y0);
    let max_y = y0.max(y1).max(y2).min(clip.y1);
    let (mr, mg, mb, ma) = channels(modulate);
    let identity = modulate == 0xffff_ffff;
    let (twf, thf) = (view.w as f32, view.h as f32);
    let (tw_max, th_max) = (view.w as i32 - 1, view.h as i32 - 1);
    let inv_area = 1.0f32 / area as f32;
    for py in min_y..max_y {
        let sy = 2 * py as i64 + 1;
        for px in min_x..max_x {
            let sx = 2 * px as i64 + 1;
            let w0 = orient(bx, by, cx, cy, sx, sy);
            let w1 = orient(cx, cy, ax, ay, sx, sy);
            let w2 = orient(ax, ay, bx, by, sx, sy);
            if w0 < 0 || w1 < 0 || w2 < 0 {
                continue;
            }
            let (f0, f1, f2) = (
                w0 as f32 * inv_area,
                w1 as f32 * inv_area,
                w2 as f32 * inv_area,
            );
            let u = u0 * f0 + u1 * f1 + u2 * f2;
            let v = v0 * f0 + v1 * f1 + v2 * f2;
            // Nearest is the golden-pinned default path; linear is opt-in
            // per texture (spec::img::FLAG_LINEAR).
            let sample = if view.linear {
                sample_linear(&view, u, v)
            } else {
                let tx = ((u * twf) as i32).clamp(0, tw_max);
                let ty = ((v * thf) as i32).clamp(0, th_max);
                texel(&view, (ty * view.w as i32 + tx) as usize)
            };
            let Some((mut r, mut g, mut b, mut a)) = sample else {
                return;
            };
            if !identity {
                r = (r * mr + 127) / 255;
                g = (g * mg + 127) / 255;
                b = (b * mb + 127) / 255;
                a = (a * ma + 127) / 255;
            }
            blend_px(fb, stride, px, py, r, g, b, a);
        }
    }
}

// ---- TEX_QUAD: textured rect (nearest, or integer bilinear when the texture
//      carries the linear flag) --------------------------------------------------------

fn tex_quad(ui: &Ui, fb: &mut [u8], stride: i32, scale: i32, clip: Clip, p: &[u32]) {
    let handle = p[0] as i32;
    let (x, y) = xy(p[1], scale);
    let (w, h) = wh(p[2], scale);
    let u0 = f32::from_bits(p[3]);
    let v0 = f32::from_bits(p[4]);
    let u1 = f32::from_bits(p[5]);
    let v1 = f32::from_bits(p[6]);
    let modulate = p[7];
    if w <= 0 || h <= 0 {
        return;
    }
    let Some(view) = ui.texture(handle) else {
        return;
    };
    let c = clip.intersect(Clip {
        x0: x,
        y0: y,
        x1: x + w,
        y1: y + h,
    });
    if c.x0 >= c.x1 || c.y0 >= c.y1 {
        return;
    }
    let (mr, mg, mb, ma) = channels(modulate);
    let identity = modulate == 0xffff_ffff;
    let (twf, thf) = (view.w as f32, view.h as f32);
    let (tw_max, th_max) = (view.w as i32 - 1, view.h as i32 - 1);
    let inv_w = 1.0f32 / w as f32;
    let inv_h = 1.0f32 / h as f32;
    for py in c.y0..c.y1 {
        let v = v0 + (v1 - v0) * ((py - y) as f32 + 0.5) * inv_h;
        let ty = ((v * thf) as i32).clamp(0, th_max);
        for px in c.x0..c.x1 {
            let u = u0 + (u1 - u0) * ((px - x) as f32 + 0.5) * inv_w;
            // Nearest is the golden-pinned default path; linear is opt-in
            // per texture (spec::img::FLAG_LINEAR).
            let sample = if view.linear {
                sample_linear(&view, u, v)
            } else {
                let tx = ((u * twf) as i32).clamp(0, tw_max);
                texel(&view, (ty * view.w as i32 + tx) as usize)
            };
            let Some((mut r, mut g, mut b, mut a)) = sample else {
                return;
            };
            if !identity {
                // Integer modulate, round-to-nearest (includes alpha).
                r = (r * mr + 127) / 255;
                g = (g * mg + 127) / 255;
                b = (b * mb + 127) / 255;
                a = (a * ma + 127) / 255;
            }
            blend_px(fb, stride, px, py, r, g, b, a);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xy_word(x: i16, y: i16) -> u32 {
        x as u16 as u32 | ((y as u16 as u32) << 16)
    }

    fn wh_word(w: u16, h: u16) -> u32 {
        w as u32 | ((h as u32) << 16)
    }

    fn framebuffer(scale: u32) -> Vec<u8> {
        vec![0; SCREEN_W as usize * scale as usize * SCREEN_H as usize * scale as usize * 4]
    }

    fn rgba(fb: &[u8], scale: u32, x: usize, y: usize) -> [u8; 4] {
        let width = SCREEN_W as usize * scale as usize;
        let offset = (y * width + x) * 4;
        fb[offset..offset + 4].try_into().unwrap()
    }

    #[test]
    fn scale_one_wrapper_is_byte_exact() {
        let ui = Ui::new();
        let words = vec![
            draw_op::RECT,
            xy_word(3, 4),
            wh_word(7, 5),
            0xff33_2211,
            draw_op::GRAD_RECT,
            xy_word(12, 4),
            wh_word(8, 6),
            0xff00_0000,
            0xffff_ffff,
            spec::GradDir::ToRight as u32,
            draw_op::TRI,
            xy_word(24, 4),
            xy_word(30, 10),
            xy_word(20, 10),
            0xff00_00ff,
            0xff00_ff00,
            0xffff_0000,
        ];
        let mut legacy = framebuffer(1);
        let mut scaled = framebuffer(1);
        render(&ui, &words, &mut legacy);
        render_scaled(&ui, &words, &mut scaled, 1);
        assert_eq!(legacy, scaled);
    }

    #[test]
    fn geometry_gradients_triangles_and_scissors_use_physical_samples() {
        let ui = Ui::new();
        let words = vec![
            draw_op::SCISSOR,
            xy_word(1, 1),
            wh_word(2, 2),
            draw_op::RECT,
            xy_word(0, 0),
            wh_word(4, 4),
            0xff00_00ff,
            draw_op::SCISSOR_POP,
            draw_op::GRAD_RECT,
            xy_word(4, 0),
            wh_word(2, 2),
            0xff00_0000,
            0xffff_ffff,
            spec::GradDir::ToRight as u32,
            draw_op::TRI,
            xy_word(8, 0),
            xy_word(10, 2),
            xy_word(8, 2),
            0xff00_ff00,
            0xff00_ff00,
            0xff00_ff00,
        ];
        let mut fb = framebuffer(2);
        render_scaled(&ui, &words, &mut fb, 2);

        assert_eq!(rgba(&fb, 2, 1, 1), [0, 0, 0, 255]);
        assert_eq!(rgba(&fb, 2, 2, 2), [255, 0, 0, 255]);
        assert_eq!(rgba(&fb, 2, 5, 5), [255, 0, 0, 255]);
        assert_eq!(rgba(&fb, 2, 6, 6), [0, 0, 0, 255]);

        let gradient = (8..12).map(|x| rgba(&fb, 2, x, 0)[0]).collect::<Vec<_>>();
        assert_eq!(gradient.len(), 4);
        assert!(gradient.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(rgba(&fb, 2, 17, 2), [0, 255, 0, 255]);
    }

    fn density_two_font() -> Vec<u8> {
        let coverage = [
            0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 255,
        ];
        let mut atlas = Vec::new();
        atlas.extend_from_slice(&spec::font_atlas::MAGIC.to_le_bytes());
        atlas.extend_from_slice(&spec::font_atlas::VERSION.to_le_bytes());
        atlas.extend_from_slice(&1u16.to_le_bytes());
        atlas.extend_from_slice(&[2, 2, 2, 2, 0, 0, 2, 0]);
        atlas.extend_from_slice(&65u32.to_le_bytes());
        atlas.extend_from_slice(&0u16.to_le_bytes());
        atlas.extend_from_slice(&[2, 0]);
        atlas.extend_from_slice(&coverage);
        atlas
    }

    #[test]
    fn textures_and_font_coverage_are_sampled_at_physical_resolution() {
        let mut ui = Ui::new_with_raster_density(2);
        let pixels = (0..16)
            .flat_map(|value| [(value * 16) as u8, 0, 0, 255])
            .collect::<Vec<_>>();
        let texture = ui.upload_texture(&pixels, 4, 4, spec::psm::PSM_8888);
        assert!(texture >= 0);
        assert!(ui.load_font_atlas(&density_two_font()));

        let words = vec![
            draw_op::TEX_QUAD,
            texture as u32,
            xy_word(0, 0),
            wh_word(2, 2),
            0.0f32.to_bits(),
            0.0f32.to_bits(),
            1.0f32.to_bits(),
            1.0f32.to_bits(),
            0xffff_ffff,
            draw_op::GLYPH_RUN,
            1 << 16,
            0xffff_ffff,
            xy_word(3, 0),
            0,
        ];
        let mut fb = framebuffer(2);
        render_scaled(&ui, &words, &mut fb, 2);

        for y in 0..4 {
            for x in 0..4 {
                assert_eq!(rgba(&fb, 2, x, y)[0], ((y * 4 + x) * 16) as u8);
            }
        }
        let expected = density_two_font();
        let coverage = &expected[24..];
        for y in 0..4 {
            for x in 0..4 {
                assert_eq!(rgba(&fb, 2, 6 + x, y)[0], coverage[y * 4 + x]);
            }
        }
    }
}
