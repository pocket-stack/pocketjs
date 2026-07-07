//! Tree walk -> DrawList + the CPU CLIP STAGE [R].
//!
//! Word/byte layout is pinned in spec/spec.ts ("DRAWLIST op format"); op
//! codes in spec::draw_op. GUARANTEE upheld here: every coordinate emitted is
//! inside [0, viewport w] x [0, viewport h] — never negative, never off-screen —
//! because the PSP GE wraps i16 coordinates. Clipping re-interpolates UVs
//! (TEX_QUAD) and gradient endpoint colors (GRAD_RECT).
//!
//! Transforms (translate/scale/rotate) compose down the walk as 2D affines.
//! Axis-aligned content uses RECT/GRAD_RECT/TEX_QUAD; ROTATED solid/gradient
//! boxes are corner-transformed, Sutherland-Hodgman-clipped and emitted as
//! TRI ops. v1 degradations (documented):
//!   - rotated IMAGE quads are conservatively culled (no textured-tri op);
//!   - glyph cells position along the rotated/scaled frame but stay upright
//!     and unscaled (bitmap cells); glyphs whose cell top-left leaves the
//!     screen range or whose cell leaves the clip rect are dropped;
//!   - rounded corners and shadows are emitted for axis-aligned boxes as
//!     deterministic alpha-covered RECT spans; rotated rounded boxes degrade
//!     to square fills;
//!   - opacity multiplies vertex alpha down the subtree (wrong on overlap,
//!     per DESIGN.md punt list).

use alloc::vec::Vec;

use crate::layout::{floorf, roundf};
use crate::spec;
use crate::style::{self, StyleTable, NO_GRADIENT};
use crate::text::Fonts;
use crate::tree::Tree;

/// The core -> backend command list: flat little-endian u32 words.
/// Format pinned in spec/spec.ts ("DRAWLIST op format"); op codes in
/// spec::draw_op. On wasm the host reads this as a Uint32Array; on PSP,
/// native/src/ge.rs walks it into sceGu calls.
pub struct DrawList {
    pub words: Vec<u32>,
}

impl DrawList {
    pub fn new() -> Self {
        DrawList { words: Vec::new() }
    }
}

impl Default for DrawList {
    fn default() -> Self {
        Self::new()
    }
}

// ---- small math (no_std: no libm, no micromath — local polyfills) -----------

const PI: f32 = core::f32::consts::PI;

#[inline]
fn clampf(x: f32, lo: f32, hi: f32) -> f32 {
    if x < lo {
        lo
    } else if x > hi {
        hi
    } else {
        x
    }
}

/// sin for rotate: range-reduce to [-pi/2, pi/2], 5-term Taylor (max error
/// well under a hundredth of a pixel at screen scale). Deterministic f32.
fn sinf(x: f32) -> f32 {
    // reduce to [-pi, pi]
    let mut r = x - (2.0 * PI) * floorf((x + PI) / (2.0 * PI));
    // fold into [-pi/2, pi/2]
    if r > PI / 2.0 {
        r = PI - r;
    } else if r < -PI / 2.0 {
        r = -PI - r;
    }
    let x2 = r * r;
    r * (1.0 + x2 * (-1.0 / 6.0 + x2 * (1.0 / 120.0 + x2 * (-1.0 / 5040.0 + x2 * (1.0 / 362880.0)))))
}

#[inline]
fn cosf(x: f32) -> f32 {
    sinf(x + PI / 2.0)
}

/// Row-major 2D affine: p' = (a*x + c*y + tx, b*x + d*y + ty).
#[derive(Clone, Copy, Debug)]
pub struct Affine {
    pub a: f32,
    pub b: f32,
    pub c: f32,
    pub d: f32,
    pub tx: f32,
    pub ty: f32,
}

impl Affine {
    pub const IDENTITY: Affine = Affine { a: 1.0, b: 0.0, c: 0.0, d: 1.0, tx: 0.0, ty: 0.0 };

    #[inline]
    fn translate(tx: f32, ty: f32) -> Affine {
        Affine { tx, ty, ..Affine::IDENTITY }
    }

    /// self ∘ other (apply `other` first, then `self`).
    fn then(&self, o: &Affine) -> Affine {
        Affine {
            a: self.a * o.a + self.c * o.b,
            b: self.b * o.a + self.d * o.b,
            c: self.a * o.c + self.c * o.d,
            d: self.b * o.c + self.d * o.d,
            tx: self.a * o.tx + self.c * o.ty + self.tx,
            ty: self.b * o.tx + self.d * o.ty + self.ty,
        }
    }

    #[inline]
    fn apply(&self, x: f32, y: f32) -> (f32, f32) {
        (self.a * x + self.c * y + self.tx, self.b * x + self.d * y + self.ty)
    }

    /// True when the transform maps axis-aligned rects to axis-aligned,
    /// non-mirrored rects.
    #[inline]
    fn is_axis_aligned(&self) -> bool {
        self.b == 0.0 && self.c == 0.0 && self.a > 0.0 && self.d > 0.0
    }
}

// ---- 3D transforms (perspective subtrees) ---------------------------------------
//
// A node with `perspective > 0` becomes a 3D CONTEXT ROOT: its subtree
// composes 3x4 affine matrices (implicit preserve-3d), every painted box is
// projected through the root's perspective distance about the root center,
// and the projected quads are painter-sorted by camera-space depth before
// being clipped and emitted as TRIs. Glyph runs project their anchor and draw
// upright/unscaled (same contract as 2D rotation); images and box decoration
// (radius/border/shadow) are not part of the 3D contract.

/// Row-major 3x4 affine 3D matrix (the w row is implicitly [0,0,0,1] — all
/// composed ops are affine; perspective happens at projection time).
#[derive(Clone, Copy)]
struct Mat34 {
    m: [f32; 12],
}

impl Mat34 {
    const IDENTITY: Mat34 = Mat34 { m: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0] };

    /// self ∘ other (apply `other` first, then `self`).
    fn then(&self, o: &Mat34) -> Mat34 {
        let a = &self.m;
        let b = &o.m;
        let mut out = [0.0f32; 12];
        for row in 0..3 {
            for col in 0..4 {
                let mut v = a[row * 4] * b[col] + a[row * 4 + 1] * b[4 + col] + a[row * 4 + 2] * b[8 + col];
                if col == 3 {
                    v += a[row * 4 + 3];
                }
                out[row * 4 + col] = v;
            }
        }
        Mat34 { m: out }
    }

    #[inline]
    fn apply(&self, x: f32, y: f32, z: f32) -> (f32, f32, f32) {
        let m = &self.m;
        (
            m[0] * x + m[1] * y + m[2] * z + m[3],
            m[4] * x + m[5] * y + m[6] * z + m[7],
            m[8] * x + m[9] * y + m[10] * z + m[11],
        )
    }

    fn translate(x: f32, y: f32, z: f32) -> Mat34 {
        Mat34 { m: [1.0, 0.0, 0.0, x, 0.0, 1.0, 0.0, y, 0.0, 0.0, 1.0, z] }
    }

    fn rot_x(deg: f32) -> Mat34 {
        let r = deg * (PI / 180.0);
        let (s, c) = (sinf(r), cosf(r));
        // Screen y grows DOWN: positive rotateX tips the top edge away, like CSS.
        Mat34 { m: [1.0, 0.0, 0.0, 0.0, 0.0, c, s, 0.0, 0.0, -s, c, 0.0] }
    }

    fn rot_y(deg: f32) -> Mat34 {
        let r = deg * (PI / 180.0);
        let (s, c) = (sinf(r), cosf(r));
        Mat34 { m: [c, 0.0, s, 0.0, 0.0, 1.0, 0.0, 0.0, -s, 0.0, c, 0.0] }
    }

    fn rot_z(deg: f32) -> Mat34 {
        let r = deg * (PI / 180.0);
        let (s, c) = (sinf(r), cosf(r));
        Mat34 { m: [c, -s, 0.0, 0.0, s, c, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0] }
    }

    fn scale(sx: f32, sy: f32) -> Mat34 {
        Mat34 { m: [sx, 0.0, 0.0, 0.0, 0.0, sy, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0] }
    }
}

/// One depth-sorted paintable inside a 3D context.
enum Item3 {
    /// Projected flat-color quad (screen space, pre-clip).
    Quad { pts: [(f32, f32); 4], color: u32 },
    /// Projected textured quad (an image node; UVs ride the corners).
    TexQuad { pts: [(f32, f32); 4], uv: [(f32, f32); 4], tex: u32, modulate: u32 },
    /// A text node's glyph run, anchored at its projected origin.
    Run { slot: u32, origin: (f32, f32), opacity: f32 },
}

/// Screen-space clip rect (x0 <= x1, y0 <= y1), f32 but integer-valued.
#[derive(Clone, Copy, Debug)]
struct Clip {
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
}

impl Clip {
    /// The full-viewport clip (the PSP screen, or whatever `Ui::set_viewport`
    /// established).
    fn viewport(screen: (f32, f32)) -> Clip {
        Clip { x0: 0.0, y0: 0.0, x1: screen.0, y1: screen.1 }
    }

    fn intersect(&self, o: &Clip) -> Clip {
        Clip {
            x0: self.x0.max(o.x0),
            y0: self.y0.max(o.y0),
            x1: self.x1.min(o.x1),
            y1: self.y1.min(o.y1),
        }
    }

    #[inline]
    fn is_empty(&self) -> bool {
        self.x1 <= self.x0 || self.y1 <= self.y0
    }
}

// ---- word packing -------------------------------------------------------------

#[inline]
fn xy_word(x: f32, y: f32) -> u32 {
    let xi = roundf(x) as i32 as i16 as u16 as u32;
    let yi = roundf(y) as i32 as i16 as u16 as u32;
    xi | (yi << 16)
}

#[inline]
fn wh_word(w: f32, h: f32) -> u32 {
    let wi = roundf(w) as i32 as u16 as u32;
    let hi = roundf(h) as i32 as u16 as u32;
    wi | (hi << 16)
}

/// Multiply a packed ABGR color's alpha by `opacity` (0..1).
fn scale_alpha(color: u32, opacity: f32) -> u32 {
    if opacity >= 1.0 {
        return color;
    }
    let a = ((color >> 24) & 0xff) as f32 * clampf(opacity, 0.0, 1.0);
    (color & 0x00ff_ffff) | ((((a + 0.5) as u32) & 0xff) << 24)
}

#[inline]
fn alpha(color: u32) -> u32 {
    color >> 24
}

#[inline]
fn with_alpha_abgr(color: u32, a: u32) -> u32 {
    (color & 0x00ff_ffff) | ((a & 0xff) << 24)
}

#[inline]
fn scale_alpha_coverage(color: u32, coverage: u32) -> u32 {
    let a = ((alpha(color) * coverage.min(255) + 127) / 255).min(255);
    with_alpha_abgr(color, a)
}

#[inline]
fn ceilf(x: f32) -> f32 {
    -floorf(-x)
}

// ---- fills ---------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Fill {
    Flat(u32),
    /// from/to already opacity-scaled; dir = spec::GradDir ordinal.
    Grad { from: u32, to: u32, dir: u32 },
}

/// Color of a local-rect corner under a fill. Corner order: 0 TL, 1 TR,
/// 2 BR, 3 BL.
fn corner_color(fill: &Fill, corner: usize) -> u32 {
    match *fill {
        Fill::Flat(c) => c,
        Fill::Grad { from, to, dir } => {
            let at_from = match dir {
                d if d == spec::GradDir::ToTop as u32 => corner == 2 || corner == 3, // from at bottom
                d if d == spec::GradDir::ToLeft as u32 => corner == 1 || corner == 2, // from at right
                d if d == spec::GradDir::ToRight as u32 => corner == 0 || corner == 3, // from at left
                _ => corner == 0 || corner == 1, // ToBottom: from at top
            };
            if at_from {
                from
            } else {
                to
            }
        }
    }
}

fn lerp_color(a: u32, b: u32, f: f32) -> u32 {
    crate::anim::interp(a, b, f, true)
}

#[inline]
fn sqrtf(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    let mut y = f32::from_bits((x.to_bits() >> 1) + 0x1fc0_0000);
    y = 0.5 * (y + x / y);
    y = 0.5 * (y + x / y);
    y = 0.5 * (y + x / y);
    y
}

#[inline]
fn coverage_from_unit(x: f32) -> u32 {
    let v = clampf(x, 0.0, 1.0);
    (v * 255.0 + 0.5) as u32
}

#[inline]
fn coverage_mul(a: u32, b: u32) -> u32 {
    ((a.min(255) * b.min(255) + 127) / 255).min(255)
}

fn pixel_interval_coverage(pixel: i32, start: f32, end: f32) -> u32 {
    let a = (pixel as f32).max(start);
    let b = ((pixel + 1) as f32).min(end);
    if b <= a {
        0
    } else {
        coverage_from_unit(b - a)
    }
}

fn gradient_run_limit(fill: &Fill) -> i32 {
    match *fill {
        Fill::Grad { dir, .. } if dir == spec::GradDir::ToLeft as u32 || dir == spec::GradDir::ToRight as u32 => 4,
        _ => 1_000_000,
    }
}

fn vertical_gradient(fill: &Fill) -> bool {
    match *fill {
        Fill::Grad { dir, .. } => dir == spec::GradDir::ToTop as u32 || dir == spec::GradDir::ToBottom as u32,
        _ => false,
    }
}

fn fill_color_at(fill: &Fill, x0: f32, y0: f32, x1: f32, y1: f32, sx0: i32, sy: i32, sx1: i32, coverage: u32) -> u32 {
    let color = match *fill {
        Fill::Flat(color) => color,
        Fill::Grad { from, to, dir } => {
            let horizontal = dir == spec::GradDir::ToLeft as u32 || dir == spec::GradDir::ToRight as u32;
            let (p, denom) = if horizontal {
                (((sx0 + sx1) as f32 * 0.5) - x0, x1 - x0)
            } else {
                (sy as f32 + 0.5 - y0, y1 - y0)
            };
            let f = if denom <= 0.0 { 0.0 } else { clampf(p / denom, 0.0, 1.0) };
            if dir == spec::GradDir::ToTop as u32 || dir == spec::GradDir::ToLeft as u32 {
                lerp_color(to, from, f)
            } else {
                lerp_color(from, to, f)
            }
        }
    };
    scale_alpha_coverage(color, coverage)
}

// ---- the walker ------------------------------------------------------------------

/// Baked antialiased disc sprites keyed by integer radius — rounded corners
/// render as four O(1) corner TEX_QUADs + three RECTs instead of per-row
/// coverage spans (the spans measured ~7 ms/frame of CPU on real PSP
/// hardware for rounded-heavy screens).
pub struct DiscCache {
    /// (radius px, texture handle)
    entries: Vec<(u32, u32)>,
}

impl DiscCache {
    pub const fn new() -> DiscCache {
        DiscCache { entries: Vec::new() }
    }
}

impl Default for DiscCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Get (or bake + upload) the AA disc texture for `r_px`. The disc is a
/// 2r x 2r circle, supersampled 4x4, white RGB with coverage alpha
/// (PSM_8888), padded to pow2 — corners sample their quadrant and modulate
/// by the fill color, which matches the old span math's scale_alpha exactly
/// up to AA rounding.
fn disc_texture(cache: &mut DiscCache, textures: &mut Vec<crate::Texture>, r_px: u32) -> Option<(u32, u32)> {
    if let Some(&(_, handle)) = cache.entries.iter().find(|&&(r, _)| r == r_px) {
        let dim = pow2_at_least(2 * r_px);
        return Some((handle, dim));
    }
    let size = 2 * r_px;
    let dim = pow2_at_least(size);
    if dim > spec::TEX_MAX_DIM {
        return None;
    }
    let byte_len = (dim * dim * 4) as usize;
    let mut px = alloc::vec![0u8; byte_len];
    let c = r_px as f32; // disc center (r, r)
    let rr = c * c;
    for y in 0..size {
        for x in 0..size {
            let mut covered = 0u32;
            for sy in 0..4u32 {
                for sx in 0..4u32 {
                    let fx = x as f32 + (sx as f32 + 0.5) / 4.0;
                    let fy = y as f32 + (sy as f32 + 0.5) / 4.0;
                    let dx = fx - c;
                    let dy = fy - c;
                    if dx * dx + dy * dy <= rr {
                        covered += 1;
                    }
                }
            }
            if covered > 0 {
                let o = ((y * dim + x) * 4) as usize;
                px[o] = 255;
                px[o + 1] = 255;
                px[o + 2] = 255;
                px[o + 3] = ((covered * 255 + 8) / 16) as u8;
            }
        }
    }
    let mut chunks = alloc::vec![0u128; byte_len.div_ceil(16)];
    unsafe {
        core::ptr::copy_nonoverlapping(px.as_ptr(), chunks.as_mut_ptr() as *mut u8, byte_len);
    }
    textures.push(crate::Texture { data: chunks, byte_len, w: dim, h: dim, psm: spec::psm::PSM_8888 });
    let handle = (textures.len() - 1) as u32;
    cache.entries.push((r_px, handle));
    Some((handle, dim))
}

#[inline]
fn pow2_at_least(n: u32) -> u32 {
    let mut p = 1u32;
    while p < n {
        p <<= 1;
    }
    p
}

struct Walker<'a> {
    tree: &'a Tree,
    styles: &'a StyleTable,
    fonts: &'a Fonts,
    /// Global vblank counter — drives deterministic sprite frame selection.
    frame: u64,
    /// Viewport bounds in px — every emitted coordinate is clipped to
    /// [0, screen.0] x [0, screen.1] (i16-safe; hosts cap it well under 32k).
    screen: (f32, f32),
    glyph_scratch: Vec<crate::text::GlyphPos>,
    /// Core texture list (baked corner discs append lazily during the walk).
    textures: &'a mut Vec<crate::Texture>,
    discs: &'a mut DiscCache,
    /// DevTools: slot to capture the world AABB of (u32::MAX = none).
    inspect_slot: u32,
    /// World AABB of `inspect_slot`, set when the walk reaches it.
    inspect_hit: Option<Clip>,
}

/// Build the full DrawList for the current (laid-out) tree. `frame` is the
/// core's vblank counter (Ui.frame); animated sprites pick their cell from it.
/// `screen` is the viewport every coordinate is clipped to.
#[allow(clippy::too_many_arguments)]
pub fn build(
    tree: &Tree,
    styles: &StyleTable,
    fonts: &Fonts,
    frame: u64,
    screen: (f32, f32),
    textures: &mut Vec<crate::Texture>,
    discs: &mut DiscCache,
    dl: &mut DrawList,
    inspect_id: i32,
) -> Option<(f32, f32, f32, f32)> {
    dl.words.clear();
    // DevTools (DEVTOOLS.md): slot of the inspected node, u32::MAX = none.
    // Nodes inside a perspective subtree take the paint_3d path and are not
    // captured (only the 2D walk composes a world Affine per node).
    let inspect_slot = if inspect_id != 0 {
        tree.resolve(inspect_id).unwrap_or(u32::MAX)
    } else {
        u32::MAX
    };
    let mut w = Walker {
        tree,
        styles,
        fonts,
        frame,
        screen,
        glyph_scratch: Vec::new(),
        textures,
        discs,
        inspect_slot,
        inspect_hit: None,
    };
    let root_slot = crate::tree::split_id(spec::ROOT_ID).1;
    w.paint(root_slot, Affine::IDENTITY, 1.0, Clip::viewport(screen), dl);
    if let Some(hit) = w.inspect_hit {
        w.emit_highlight(dl, &hit);
    }
    w.inspect_hit.map(|c| (c.x0, c.y0, c.x1 - c.x0, c.y1 - c.y0))
}

impl<'a> Walker<'a> {
    fn paint(&mut self, slot: u32, parent_world: Affine, opacity: f32, clip: Clip, dl: &mut DrawList) {
        let node = &self.tree.slots[slot as usize];
        let r = style::resolve(node, self.styles, true);
        if r.display == spec::Display::None as u8 {
            return;
        }
        let l = node.layout;
        // Local frame: layout position + translate, then rotate/scale about
        // the node center.
        let mut local = Affine::translate(l.x + r.translate_x, l.y + r.translate_y);
        if r.rotate != 0.0 || r.scale != 1.0 || r.scale_x != 1.0 || r.scale_y != 1.0 {
            // Transform origin: node center offset by the origin fractions
            // (`origin-*` utilities; e.g. origin-bottom = (0, +0.5)).
            let (cx, cy) = (l.w * (0.5 + r.origin_x), l.h * (0.5 + r.origin_y));
            let rad = r.rotate * (PI / 180.0);
            // rotate == 0 keeps EXACT axis alignment (the trig polyfill is a
            // few ulp off at multiples of pi/2, which would silently demote
            // scale-only transforms to the TRI path).
            let (s, c) = if r.rotate == 0.0 { (0.0, 1.0) } else { (sinf(rad), cosf(rad)) };
            let sx = r.scale * r.scale_x;
            let sy = r.scale * r.scale_y;
            // translate(c) * rotate * scale * translate(-c)
            let m = Affine {
                a: c * sx,
                b: s * sx,
                c: -s * sy,
                d: c * sy,
                tx: cx - (c * sx * cx - s * sy * cy),
                ty: cy - (s * sx * cx + c * sy * cy),
            };
            local = local.then(&m);
        }
        let world = parent_world.then(&local);
        // DevTools: capture the inspected node's border-box world AABB
        // (before the opacity cull so transparent nodes still highlight).
        if slot == self.inspect_slot {
            self.inspect_hit = Some(self.world_aabb(&world, l.w, l.h));
        }
        let op = clampf(opacity * r.opacity, 0.0, 1.0);
        if op <= 0.0 {
            return;
        }

        // -- background + shadow --------------------------------------------
        let has_grad = r.grad_dir != NO_GRADIENT && r.grad_dir <= spec::GradDir::ToRight as u32;
        let bg_color = scale_alpha(r.bg_color, op);
        let border_color = scale_alpha(r.border_color, op);
        let rounded_border = r.radius > 0.0 && r.border_width > 0.0 && alpha(border_color) > 0;
        let rounded_ring = rounded_border && (has_grad || alpha(bg_color) > 0);

        if r.shadow > 0 && (alpha(bg_color) > 0 || has_grad) {
            self.emit_shadow(dl, &world, l.w, l.h, r.radius, r.shadow, op, &clip);
        }

        let is_arc = r.arc_width > 0.0 && r.arc_sweep != 0.0;
        if is_arc {
            // Arc primitive: the bg color strokes an annular sector instead
            // of filling the box (spec.ts PROP.arcStart/arcSweep/arcWidth).
            if alpha(bg_color) > 0 {
                self.emit_arc(dl, &world, l.w, l.h, &r, bg_color, &clip);
            }
        } else if rounded_ring {
            self.emit_rounded_box(dl, &world, 0.0, 0.0, l.w, l.h, r.radius, Fill::Flat(border_color), &clip);
            let bw = r.border_width.min(l.w * 0.5).min(l.h * 0.5);
            if has_grad {
                let fill = Fill::Grad {
                    from: scale_alpha(r.grad_from, op),
                    to: scale_alpha(r.grad_to, op),
                    dir: r.grad_dir,
                };
                self.emit_rounded_box(dl, &world, bw, bw, l.w - bw, l.h - bw, (r.radius - bw).max(0.0), fill, &clip);
            } else {
                self.emit_rounded_box(
                    dl,
                    &world,
                    bw,
                    bw,
                    l.w - bw,
                    l.h - bw,
                    (r.radius - bw).max(0.0),
                    Fill::Flat(bg_color),
                    &clip,
                );
            }
        } else if has_grad {
            let fill = Fill::Grad {
                from: scale_alpha(r.grad_from, op),
                to: scale_alpha(r.grad_to, op),
                dir: r.grad_dir,
            };
            self.emit_rounded_box(dl, &world, 0.0, 0.0, l.w, l.h, r.radius, fill, &clip);
        } else if alpha(bg_color) > 0 {
            self.emit_rounded_box(dl, &world, 0.0, 0.0, l.w, l.h, r.radius, Fill::Flat(bg_color), &clip);
        }

        // -- border: 4 inset strips ------------------------------------------
        let bw = r.border_width;
        if !rounded_ring && bw > 0.0 && alpha(border_color) > 0 {
            if rounded_border {
                self.emit_rounded_border(dl, &world, 0.0, 0.0, l.w, l.h, r.radius, bw, Fill::Flat(border_color), &clip);
            } else {
                let bc = Fill::Flat(border_color);
                let bwx = bw.min(l.w * 0.5);
                let bwy = bw.min(l.h * 0.5);
                self.emit_box(dl, &world, 0.0, 0.0, l.w, bwy, bc, &clip); // top
                self.emit_box(dl, &world, 0.0, l.h - bwy, l.w, l.h, bc, &clip); // bottom
                self.emit_box(dl, &world, 0.0, bwy, bwx, l.h - bwy, bc, &clip); // left
                self.emit_box(dl, &world, l.w - bwx, bwy, l.w, l.h - bwy, bc, &clip); // right
            }
        }

        // -- text run ----------------------------------------------------------
        if node.node_type == spec::NodeType::Text as u8 {
            self.emit_text(dl, node, &r, &world, op, &clip, l.w);
            // Text children are absorbed into the run — do not recurse.
            return;
        }

        // -- image / animated sprite -------------------------------------------
        if node.node_type == spec::NodeType::Image as u8 && node.tex >= 0 {
            // Plain image samples the whole texture; a sprite samples the
            // current frame's atlas cell (auto-played from the vblank counter).
            let (fu0, fv0, fu1, fv1) = if node.sprite_frames > 0 {
                let cols = node.sprite_cols.max(1) as u32;
                let rows = (node.sprite_frames as u32).div_ceil(cols);
                let step = node.sprite_step.max(1) as u64;
                let elapsed = self.frame.wrapping_sub(node.sprite_start);
                let idx = ((elapsed / step) % node.sprite_frames as u64) as u32;
                let (cx, cy) = (idx % cols, idx / cols);
                (
                    cx as f32 / cols as f32,
                    cy as f32 / rows as f32,
                    (cx + 1) as f32 / cols as f32,
                    (cy + 1) as f32 / rows as f32,
                )
            } else {
                (0.0, 0.0, 1.0, 1.0)
            };
            self.emit_tex_quad(dl, &world, l.w, l.h, node.tex as u32, op, &clip, fu0, fv0, fu1, fv1);
        }

        // -- children (overflow-hidden scissor around them; z-index stable
        //    sort within siblings) ---------------------------------------------
        let mut child_clip = clip;
        let mut scissored = false;
        if r.overflow == spec::Overflow::Hidden as u8 {
            // Scissor rects are axis-aligned: rotated clip boxes use the AABB
            // of the transformed rect (conservative).
            let rect = self.world_aabb(&world, l.w, l.h);
            child_clip = clip.intersect(&rect);
            if child_clip.is_empty() {
                return; // nothing of the subtree can be visible
            }
            dl.words.push(spec::draw_op::SCISSOR);
            dl.words.push(xy_word(child_clip.x0, child_clip.y0));
            dl.words.push(wh_word(child_clip.x1 - child_clip.x0, child_clip.y1 - child_clip.y0));
            scissored = true;
        }

        if r.perspective > 0.0 {
            // 3D context root: the subtree composes 3x4 matrices, projects
            // through r.perspective about this node's center and painter-sorts.
            self.paint_3d(slot, &world, op, &child_clip, dl, r.perspective, l.w, l.h);
            if scissored {
                dl.words.push(spec::draw_op::SCISSOR_POP);
            }
            return;
        }

        // z-index is rare: detect it with the cheap z-only resolve, and only
        // allocate + sort when a child actually carries one (the hot path is
        // a straight index walk with zero allocations).
        let node = &self.tree.slots[slot as usize];
        let child_count = node.children.len();
        let mut needs_sort = false;
        for &cid in &node.children {
            if let Some(cs) = self.tree.resolve(cid) {
                if style::resolve_z(&self.tree.slots[cs as usize], self.styles) != 0 {
                    needs_sort = true;
                    break;
                }
            }
        }
        if !needs_sort {
            for i in 0..child_count {
                let cid = self.tree.slots[slot as usize].children[i];
                if let Some(cs) = self.tree.resolve(cid) {
                    self.paint(cs, world, op, child_clip, dl);
                }
            }
        } else {
            let node = &self.tree.slots[slot as usize];
            let mut order: Vec<(i32, u32)> = Vec::with_capacity(node.children.len());
            for &cid in &node.children {
                if let Some(cs) = self.tree.resolve(cid) {
                    let z = style::resolve_z(&self.tree.slots[cs as usize], self.styles);
                    order.push((z, cs));
                }
            }
            // Stable by construction: sort_by_key on Vec preserves insertion
            // order of equal keys (alloc's stable merge sort).
            order.sort_by_key(|&(z, _)| z);
            for (_, cs) in order {
                self.paint(cs, world, op, child_clip, dl);
            }
        }

        if scissored {
            dl.words.push(spec::draw_op::SCISSOR_POP);
        }
    }

    // ---- 3D context ---------------------------------------------------------

    /// Paint the subtree of a perspective root: collect projected quads and
    /// glyph runs depth-first, painter-sort by camera-space depth (far first),
    /// then clip + emit. `w`/`h` are the root's layout size (the perspective
    /// origin sits at its center, CSS default).
    #[allow(clippy::too_many_arguments)]
    fn paint_3d(
        &mut self,
        root_slot: u32,
        root_world: &Affine,
        opacity: f32,
        clip: &Clip,
        dl: &mut DrawList,
        distance: f32,
        w: f32,
        h: f32,
    ) {
        let (cx, cy) = (w * 0.5, h * 0.5);
        let mut items: Vec<(f32, Item3)> = Vec::new();
        let root = &self.tree.slots[root_slot as usize];
        let children: Vec<i32> = root.children.clone();
        for cid in children {
            if let Some(cs) = self.tree.resolve(cid) {
                self.collect_3d(cs, &Mat34::IDENTITY, opacity, root_world, distance, cx, cy, &mut items);
            }
        }
        // Painter's algorithm: farthest (smallest camera z) first. total_cmp
        // keeps this deterministic; stable sort preserves tree order for ties.
        items.sort_by(|a, b| a.0.total_cmp(&b.0));
        for (_, item) in items {
            match item {
                Item3::Quad { pts, color } => {
                    let poly: Vec<ClipVert> = pts
                        .iter()
                        .map(|&(x, y)| ClipVert { x, y, color: unpack(color), u: 0.0, v: 0.0 })
                        .collect();
                    let clipped = sutherland_hodgman(&poly, clip);
                    for i in 1..clipped.len().saturating_sub(1) {
                        emit_tri(dl, &clipped[0], &clipped[i], &clipped[i + 1], clip, self.screen);
                    }
                }
                Item3::TexQuad { pts, uv, tex, modulate } => {
                    let poly: Vec<ClipVert> = pts
                        .iter()
                        .zip(uv.iter())
                        .map(|(&(x, y), &(u, v))| ClipVert { x, y, color: [255.0; 4], u, v })
                        .collect();
                    let clipped = sutherland_hodgman(&poly, clip);
                    for i in 1..clipped.len().saturating_sub(1) {
                        emit_tex_tri(dl, tex, modulate, &clipped[0], &clipped[i], &clipped[i + 1], clip, self.screen);
                    }
                }
                Item3::Run { slot, origin, opacity } => {
                    // (borrows through the walker's &'a Tree field, so the
                    // node ref is not tied to &mut self)
                    let node = &self.tree.slots[slot as usize];
                    let r = style::resolve(node, self.styles, true);
                    let anchor = Affine::translate(origin.0, origin.1);
                    self.emit_text(dl, node, &r, &anchor, opacity, clip, node.layout.w);
                }
            }
        }
    }

    /// Depth-first 3D collection. `m` maps node-local 3D coords into the
    /// context root's local space; projection happens here so every painted
    /// box becomes one flat screen quad + depth key.
    #[allow(clippy::too_many_arguments)]
    fn collect_3d(
        &self,
        slot: u32,
        m: &Mat34,
        opacity: f32,
        root_world: &Affine,
        distance: f32,
        cx: f32,
        cy: f32,
        items: &mut Vec<(f32, Item3)>,
    ) {
        let node = &self.tree.slots[slot as usize];
        let r = style::resolve(node, self.styles, true);
        if r.display == spec::Display::None as u8 {
            return;
        }
        let op = opacity * clampf(r.opacity, 0.0, 1.0);
        if op <= 0.0 {
            return;
        }
        let l = node.layout;
        // Local matrix, canonical function order (matches the CSS transform
        // lists this models: translate/translateZ leftmost, then rotate,
        // rotateX, rotateY, with 2D scale innermost), conjugated around the
        // transform origin.
        let (ox, oy) = (l.w * (0.5 + r.origin_x), l.h * (0.5 + r.origin_y));
        let mut local = Mat34::translate(l.x + r.translate_x, l.y + r.translate_y, r.translate_z)
            .then(&Mat34::translate(ox, oy, 0.0));
        if r.rotate != 0.0 {
            local = local.then(&Mat34::rot_z(r.rotate));
        }
        if r.rotate_x != 0.0 {
            local = local.then(&Mat34::rot_x(r.rotate_x));
        }
        if r.rotate_y != 0.0 {
            local = local.then(&Mat34::rot_y(r.rotate_y));
        }
        let (sx, sy) = (r.scale * r.scale_x, r.scale * r.scale_y);
        if sx != 1.0 || sy != 1.0 {
            local = local.then(&Mat34::scale(sx, sy));
        }
        local = local.then(&Mat34::translate(-ox, -oy, 0.0));
        let m2 = m.then(&local);

        let project = |x: f32, y: f32| -> ((f32, f32), f32) {
            let (px, py, pz) = m2.apply(x, y, 0.0);
            let denom = (distance - pz).max(1.0); // near guard
            let f = distance / denom;
            let lx = cx + (px - cx) * f;
            let ly = cy + (py - cy) * f;
            (root_world.apply(lx, ly), pz)
        };

        // Background -> one flat quad (gradients flatten to the mid-blend;
        // radius/border/shadow are outside the 3D contract).
        let color = if r.grad_dir != NO_GRADIENT && r.grad_dir <= spec::GradDir::ToRight as u32 {
            lerp_color(r.grad_from, r.grad_to, 0.5)
        } else {
            r.bg_color
        };
        let color = scale_alpha(color, op);
        if alpha(color) > 0 && l.w > 0.0 && l.h > 0.0 {
            let c0 = project(0.0, 0.0);
            let c1 = project(l.w, 0.0);
            let c2 = project(l.w, l.h);
            let c3 = project(0.0, l.h);
            let depth = (c0.1 + c1.1 + c2.1 + c3.1) * 0.25;
            items.push((depth, Item3::Quad { pts: [c0.0, c1.0, c2.0, c3.0], color }));
        }
        if node.node_type == spec::NodeType::Image as u8 && node.tex >= 0 && l.w > 0.0 && l.h > 0.0 {
            let (fu0, fv0, fu1, fv1) = if node.sprite_frames > 0 {
                let cols = node.sprite_cols.max(1) as u32;
                let rows = (node.sprite_frames as u32).div_ceil(cols);
                let step = node.sprite_step.max(1) as u64;
                let elapsed = self.frame.wrapping_sub(node.sprite_start);
                let idx = ((elapsed / step) % node.sprite_frames as u64) as u32;
                let (cx2, cy2) = (idx % cols, idx / cols);
                (
                    cx2 as f32 / cols as f32,
                    cy2 as f32 / rows as f32,
                    (cx2 + 1) as f32 / cols as f32,
                    (cy2 + 1) as f32 / rows as f32,
                )
            } else {
                (0.0, 0.0, 1.0, 1.0)
            };
            let c0 = project(0.0, 0.0);
            let c1 = project(l.w, 0.0);
            let c2 = project(l.w, l.h);
            let c3 = project(0.0, l.h);
            let depth = (c0.1 + c1.1 + c2.1 + c3.1) * 0.25 + 0.005;
            items.push((
                depth,
                Item3::TexQuad {
                    pts: [c0.0, c1.0, c2.0, c3.0],
                    uv: [(fu0, fv0), (fu1, fv0), (fu1, fv1), (fu0, fv1)],
                    tex: node.tex as u32,
                    modulate: scale_alpha(0xffff_ffff, op),
                },
            ));
        }
        if node.node_type == spec::NodeType::Text as u8 {
            // Glyphs anchor at the projected text origin and stay upright
            // (the 2D rotation contract). Depth = the anchor's z.
            let ((sx, sy), z) = project(0.0, 0.0);
            items.push((z + 0.01, Item3::Run { slot, origin: (sx, sy), opacity: op }));
            return; // text children are absorbed into the run
        }
        for &cid in &node.children {
            if let Some(cs) = self.tree.resolve(cid) {
                self.collect_3d(cs, &m2, op, root_world, distance, cx, cy, items);
            }
        }
    }

    /// Rasterize an annular sector ("stroke arc" with round caps) as
    /// alpha-covered RECT runs — deterministic 2x2 supersampled coverage.
    /// Axis-aligned worlds only; rotation belongs in arcStart.
    fn emit_arc(
        &self,
        dl: &mut DrawList,
        world: &Affine,
        w: f32,
        h: f32,
        r: &style::Resolved,
        color: u32,
        clip: &Clip,
    ) {
        if !world.is_axis_aligned() {
            return;
        }
        let (cx, cy) = world.apply(w * 0.5, h * 0.5);
        let s = world.d.max(0.0);
        let outer = (w.min(h) * 0.5) * s;
        let width = (r.arc_width * s).min(outer);
        if outer <= 0.0 || width <= 0.0 {
            return;
        }
        let rmid = outer - width * 0.5;
        let half = width * 0.5;
        // Ring test in squared space (|d - rmid| <= half without the sqrt).
        let ring_in = (rmid - half).max(0.0);
        let ring_in2 = ring_in * ring_in;
        let ring_out = rmid + half;
        let ring_out2 = ring_out * ring_out;
        let sweep = clampf(r.arc_sweep, -360.0, 360.0);
        let (a0, asweep) = if sweep < 0.0 { (r.arc_start + sweep, -sweep) } else { (r.arc_start, sweep) };
        let full = asweep >= 360.0;
        let major = asweep > 180.0;
        // 0 deg = 12 o'clock, clockwise positive.
        let dir = |deg: f32| {
            let rad = deg * (PI / 180.0);
            (sinf(rad), -cosf(rad))
        };
        let (svx, svy) = dir(a0);
        let (evx, evy) = dir(a0 + asweep);
        let cap0 = (cx + svx * rmid, cy + svy * rmid);
        let cap1 = (cx + evx * rmid, cy + evy * rmid);
        let half2 = half * half;

        let x0 = floorf(clampf(cx - outer, clip.x0, clip.x1)) as i32;
        let x1 = ceilf(clampf(cx + outer, clip.x0, clip.x1)) as i32;
        let y0 = floorf(clampf(cy - outer, clip.y0, clip.y1)) as i32;
        let y1 = ceilf(clampf(cy + outer, clip.y0, clip.y1)) as i32;

        let covered = |px: f32, py: f32| -> bool {
            let dx = px - cx;
            let dy = py - cy;
            let d2 = dx * dx + dy * dy;
            let in_ring = d2 >= ring_in2 && d2 <= ring_out2;
            if in_ring {
                let in_angle = full || {
                    let cross_s = svx * dy - svy * dx;
                    let cross_e = evx * dy - evy * dx;
                    if major { cross_s >= 0.0 || cross_e <= 0.0 } else { cross_s >= 0.0 && cross_e <= 0.0 }
                };
                if in_angle {
                    return true;
                }
            }
            if full {
                return false;
            }
            // Round caps at both endpoints.
            let d0x = px - cap0.0;
            let d0y = py - cap0.1;
            if d0x * d0x + d0y * d0y <= half2 {
                return true;
            }
            let d1x = px - cap1.0;
            let d1y = py - cap1.1;
            d1x * d1x + d1y * d1y <= half2
        };

        for row in y0..y1 {
            // Row clamp: only columns whose pixel can touch the OUTER circle
            // matter; the ring's inner hole is skipped analytically too (cap
            // discs sit ON the ring so they never reach into the hole). This
            // cuts the scanned pixels ~3x — the arc rasterizer runs every
            // frame on the PSP CPU.
            let dy = row as f32 + 0.5 - cy;
            let dy2 = dy * dy;
            if dy2 > ring_out2 + ring_out + 1.0 {
                continue;
            }
            let half_span = sqrtf((ring_out2 - dy2).max(0.0)) + 1.0;
            let row_x0 = (floorf(cx - half_span) as i32).max(x0);
            let row_x1 = (ceilf(cx + half_span) as i32).min(x1);
            let hole_span = if dy2 < ring_in2 { sqrtf(ring_in2 - dy2) - 1.0 } else { -1.0 };
            let (hole_x0, hole_x1) = if hole_span > 1.0 {
                ((cx - hole_span) as i32, (cx + hole_span) as i32)
            } else {
                (i32::MAX, i32::MIN)
            };
            let mut run_start = row_x0;
            let mut run_cov = 0u32;
            let flush = |dl: &mut DrawList, start: i32, end: i32, cov: u32| {
                if cov == 0 || end <= start {
                    return;
                }
                let c = scale_alpha(color, cov as f32 / 4.0);
                if alpha(c) == 0 {
                    return;
                }
                dl.words.push(spec::draw_op::RECT);
                dl.words.push(xy_word(start as f32, row as f32));
                dl.words.push(wh_word((end - start) as f32, 1.0));
                dl.words.push(c);
            };
            let mut col = row_x0;
            while col < row_x1 {
                if col >= hole_x0 && col < hole_x1 {
                    // Fully inside the ring hole: flush and jump across.
                    if run_cov != 0 {
                        flush(dl, run_start, col, run_cov);
                        run_cov = 0;
                    }
                    run_start = hole_x1;
                    col = hole_x1;
                    continue;
                }
                let mut cov = 0u32;
                for (ox, oy) in [(0.25f32, 0.25f32), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)] {
                    if covered(col as f32 + ox, row as f32 + oy) {
                        cov += 1;
                    }
                }
                if cov != run_cov {
                    flush(dl, run_start, col, run_cov);
                    run_start = col;
                    run_cov = cov;
                }
                col += 1;
            }
            flush(dl, run_start, row_x1, run_cov);
        }
    }

    /// AABB (intersected with the screen) of a local rect under `world`.
    fn world_aabb(&self, world: &Affine, w: f32, h: f32) -> Clip {
        let pts = [
            world.apply(0.0, 0.0),
            world.apply(w, 0.0),
            world.apply(w, h),
            world.apply(0.0, h),
        ];
        let mut c = Clip { x0: pts[0].0, y0: pts[0].1, x1: pts[0].0, y1: pts[0].1 };
        for &(x, y) in &pts[1..] {
            c.x0 = c.x0.min(x);
            c.y0 = c.y0.min(y);
            c.x1 = c.x1.max(x);
            c.y1 = c.y1.max(y);
        }
        // Conservative integer AABB: floor mins, ceil maxes.
        Clip {
            x0: floorf(clampf(c.x0, 0.0, self.screen.0)),
            y0: floorf(clampf(c.y0, 0.0, self.screen.1)),
            x1: ceilf(clampf(c.x1, 0.0, self.screen.0)),
            y1: ceilf(clampf(c.y1, 0.0, self.screen.1)),
        }
    }

    /// Emit a solid/gradient local-space rect under `world`: axis-aligned
    /// path (RECT/GRAD_RECT, clipped with color re-interpolation) or the
    /// rotated path (Sutherland-Hodgman -> TRI ops).
    #[allow(clippy::too_many_arguments)]
    fn emit_box(&self, dl: &mut DrawList, world: &Affine, x0: f32, y0: f32, x1: f32, y1: f32, fill: Fill, clip: &Clip) {
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        if world.is_axis_aligned() {
            let (sx0, sy0) = world.apply(x0, y0);
            let (sx1, sy1) = world.apply(x1, y1);
            let c = Clip {
                x0: sx0.max(clip.x0),
                y0: sy0.max(clip.y0),
                x1: sx1.min(clip.x1),
                y1: sy1.min(clip.y1),
            };
            if c.is_empty() || roundf(c.x1 - c.x0) <= 0.0 || roundf(c.y1 - c.y0) <= 0.0 {
                return;
            }
            match fill {
                Fill::Flat(color) => {
                    dl.words.push(spec::draw_op::RECT);
                    dl.words.push(xy_word(c.x0, c.y0));
                    dl.words.push(wh_word(c.x1 - c.x0, c.y1 - c.y0));
                    dl.words.push(color);
                }
                Fill::Grad { from, to, dir } => {
                    // Re-interpolate the endpoint colors over the clipped
                    // span so the visible slice keeps the exact gradient.
                    let (f0, f1) = if dir == spec::GradDir::ToLeft as u32 || dir == spec::GradDir::ToRight as u32 {
                        let w = sx1 - sx0;
                        ((c.x0 - sx0) / w, (c.x1 - sx0) / w)
                    } else {
                        let h = sy1 - sy0;
                        ((c.y0 - sy0) / h, (c.y1 - sy0) / h)
                    };
                    // ToTop/ToLeft run against the +axis: fraction measured
                    // from the far edge.
                    let (gf, gt) = if dir == spec::GradDir::ToTop as u32 || dir == spec::GradDir::ToLeft as u32 {
                        (lerp_color(to, from, f0), lerp_color(to, from, f1))
                    } else {
                        (lerp_color(from, to, f0), lerp_color(from, to, f1))
                    };
                    // Store colors back in "from/to along dir" order.
                    let (out_from, out_to) = if dir == spec::GradDir::ToTop as u32 || dir == spec::GradDir::ToLeft as u32 {
                        (gt, gf)
                    } else {
                        (gf, gt)
                    };
                    dl.words.push(spec::draw_op::GRAD_RECT);
                    dl.words.push(xy_word(c.x0, c.y0));
                    dl.words.push(wh_word(c.x1 - c.x0, c.y1 - c.y0));
                    dl.words.push(out_from);
                    dl.words.push(out_to);
                    dl.words.push(dir);
                }
            }
        } else {
            // Rotated: transform corners, Sutherland-Hodgman clip, fan into
            // TRI ops (gouraud carries any gradient through the clip).
            let corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)];
            let mut poly: Vec<ClipVert> = Vec::with_capacity(8);
            for (i, &(lx, ly)) in corners.iter().enumerate() {
                let (sx, sy) = world.apply(lx, ly);
                poly.push(ClipVert { x: sx, y: sy, color: unpack(corner_color(&fill, i)), u: 0.0, v: 0.0 });
            }
            let clipped = sutherland_hodgman(&poly, clip);
            if clipped.len() < 3 {
                return;
            }
            for i in 1..clipped.len() - 1 {
                emit_tri(dl, &clipped[0], &clipped[i], &clipped[i + 1], clip, self.screen);
            }
        }
    }

    /// DevTools highlight overlay (DEVTOOLS.md): translucent fill + 2 px
    /// edges over the inspected node's world AABB. Appended after the whole
    /// walk, so it renders on top and outside any scissor.
    fn emit_highlight(&self, dl: &mut DrawList, c: &Clip) {
        let vp = Clip::viewport(self.screen);
        const FILL: u32 = 0x4DF5B04B; // #4bb0f5 at ~30% alpha (ABGR)
        const EDGE: u32 = 0xFFF5B04B; // #4bb0f5 solid
        const T: f32 = 2.0;
        self.emit_screen_rect(dl, c.x0, c.y0, c.x1, c.y1, Fill::Flat(FILL), &vp);
        self.emit_screen_rect(dl, c.x0 - T, c.y0 - T, c.x1 + T, c.y0, Fill::Flat(EDGE), &vp);
        self.emit_screen_rect(dl, c.x0 - T, c.y1, c.x1 + T, c.y1 + T, Fill::Flat(EDGE), &vp);
        self.emit_screen_rect(dl, c.x0 - T, c.y0, c.x0, c.y1, Fill::Flat(EDGE), &vp);
        self.emit_screen_rect(dl, c.x1, c.y0, c.x1 + T, c.y1, Fill::Flat(EDGE), &vp);
    }

    /// Screen-space flat/grad rect helper (already-transformed coords).
    #[allow(clippy::too_many_arguments)]
    fn emit_screen_rect(&self, dl: &mut DrawList, x0: f32, y0: f32, x1: f32, y1: f32, fill: Fill, clip: &Clip) {
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        self.emit_box(dl, &Affine::IDENTITY, x0, y0, x1, y1, fill, clip);
    }

    /// One rounded-corner sprite: an r x r quadrant of the baked disc,
    /// clipped, with UVs re-interpolated over the visible part.
    #[allow(clippy::too_many_arguments)]
    fn emit_corner_quad(
        &self,
        dl: &mut DrawList,
        tex: u32,
        x: f32,
        y: f32,
        r: f32,
        u0: f32,
        v0: f32,
        du: f32,
        color: u32,
        clip: &Clip,
    ) {
        let c = Clip {
            x0: x.max(clip.x0),
            y0: y.max(clip.y0),
            x1: (x + r).min(clip.x1),
            y1: (y + r).min(clip.y1),
        };
        if c.is_empty() || roundf(c.x1 - c.x0) <= 0.0 || roundf(c.y1 - c.y0) <= 0.0 {
            return;
        }
        let cu0 = u0 + (c.x0 - x) / r * du;
        let cu1 = u0 + (c.x1 - x) / r * du;
        let cv0 = v0 + (c.y0 - y) / r * du;
        let cv1 = v0 + (c.y1 - y) / r * du;
        dl.words.push(spec::draw_op::TEX_QUAD);
        dl.words.push(tex);
        dl.words.push(xy_word(c.x0, c.y0));
        dl.words.push(wh_word(c.x1 - c.x0, c.y1 - c.y0));
        dl.words.push(cu0.to_bits());
        dl.words.push(cv0.to_bits());
        dl.words.push(cu1.to_bits());
        dl.words.push(cv1.to_bits());
        dl.words.push(color);
    }

    fn rounded_interval_at_row(
        &self,
        sx0: f32,
        sy0: f32,
        sx1: f32,
        sy1: f32,
        radius: f32,
        row_y: f32,
    ) -> Option<(f32, f32)> {
        if sx1 <= sx0 || sy1 <= sy0 || row_y < sy0 || row_y > sy1 {
            return None;
        }
        let w = sx1 - sx0;
        let h = sy1 - sy0;
        let r = radius.min(w * 0.5).min(h * 0.5);
        if r <= 0.5 {
            return Some((sx0, sx1));
        }
        let rr = r * r;
        let inset = if row_y < sy0 + r {
            let dy = sy0 + r - row_y;
            r - sqrtf((rr - dy * dy).max(0.0))
        } else if row_y > sy1 - r {
            let dy = row_y - (sy1 - r);
            r - sqrtf((rr - dy * dy).max(0.0))
        } else {
            0.0
        };
        Some((sx0 + inset, sx1 - inset))
    }

    #[allow(clippy::too_many_arguments)]
    fn emit_fractional_span(
        &self,
        dl: &mut DrawList,
        fill: &Fill,
        sx0: f32,
        sy0: f32,
        sx1: f32,
        sy1: f32,
        py: i32,
        h: i32,
        span_x0: f32,
        span_x1: f32,
        clip_x0: i32,
        clip_x1: i32,
        y_coverage: u32,
    ) {
        if y_coverage == 0 || span_x1 <= span_x0 {
            return;
        }
        let span_x0 = span_x0.max(clip_x0 as f32);
        let span_x1 = span_x1.min(clip_x1 as f32);
        if span_x1 <= span_x0 {
            return;
        }

        let left_edge = floorf(span_x0) as i32;
        let full_start = ceilf(span_x0) as i32;
        let full_end = floorf(span_x1) as i32;
        let right_edge = ceilf(span_x1) as i32;

        let mut emitted_left_edge = false;
        if left_edge < full_start && left_edge >= clip_x0 && left_edge < clip_x1 {
            let x_coverage = pixel_interval_coverage(left_edge, span_x0, span_x1);
            self.emit_rounded_span(
                dl,
                fill,
                sx0,
                sy0,
                sx1,
                sy1,
                py,
                h,
                left_edge,
                left_edge + 1,
                coverage_mul(x_coverage, y_coverage),
            );
            emitted_left_edge = true;
        }

        self.emit_rounded_span(
            dl,
            fill,
            sx0,
            sy0,
            sx1,
            sy1,
            py,
            h,
            full_start.max(clip_x0),
            full_end.min(clip_x1),
            y_coverage,
        );

        if full_end < right_edge
            && full_end >= clip_x0
            && full_end < clip_x1
            && !(emitted_left_edge && full_end == left_edge)
        {
            let x_coverage = pixel_interval_coverage(full_end, span_x0, span_x1);
            self.emit_rounded_span(
                dl,
                fill,
                sx0,
                sy0,
                sx1,
                sy1,
                py,
                h,
                full_end,
                full_end + 1,
                coverage_mul(x_coverage, y_coverage),
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn emit_rounded_span(
        &self,
        dl: &mut DrawList,
        fill: &Fill,
        sx0: f32,
        sy0: f32,
        sx1: f32,
        sy1: f32,
        py: i32,
        h: i32,
        x0: i32,
        x1: i32,
        coverage: u32,
    ) {
        if coverage == 0 || h <= 0 || x1 <= x0 {
            return;
        }
        let max_run = gradient_run_limit(fill);
        let mut x = x0;
        while x < x1 {
            let next = (x + max_run).min(x1);
            let color = fill_color_at(fill, sx0, sy0, sx1, sy1, x, py, next, coverage);
            if alpha(color) > 0 {
                dl.words.push(spec::draw_op::RECT);
                dl.words.push(xy_word(x as f32, py as f32));
                dl.words.push(wh_word((next - x) as f32, h as f32));
                dl.words.push(color);
            }
            x = next;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn emit_rounded_border(
        &mut self,
        dl: &mut DrawList,
        world: &Affine,
        x0: f32,
        y0: f32,
        x1: f32,
        y1: f32,
        radius: f32,
        border_width: f32,
        fill: Fill,
        clip: &Clip,
    ) {
        if radius <= 0.0 || border_width <= 0.0 || !world.is_axis_aligned() {
            let bwx = border_width.min((x1 - x0) * 0.5);
            let bwy = border_width.min((y1 - y0) * 0.5);
            self.emit_box(dl, world, x0, y0, x1, y0 + bwy, fill, clip);
            self.emit_box(dl, world, x0, y1 - bwy, x1, y1, fill, clip);
            self.emit_box(dl, world, x0, y0 + bwy, x0 + bwx, y1 - bwy, fill, clip);
            self.emit_box(dl, world, x1 - bwx, y0 + bwy, x1, y1 - bwy, fill, clip);
            return;
        }

        let (sx0, sy0) = world.apply(x0, y0);
        let (sx1, sy1) = world.apply(x1, y1);
        if sx1 <= sx0 || sy1 <= sy0 {
            return;
        }
        let w = sx1 - sx0;
        let h = sy1 - sy0;
        let scale_y = world.d.max(0.0);
        let bw = (border_width * scale_y).min(w * 0.5).min(h * 0.5);
        let r = (radius * scale_y).min(w * 0.5).min(h * 0.5);
        if bw <= 0.0 || r <= 0.5 {
            let local_bw = if scale_y > 0.0 { bw / scale_y } else { border_width };
            let bwx = local_bw.min((x1 - x0) * 0.5);
            let bwy = local_bw.min((y1 - y0) * 0.5);
            self.emit_box(dl, world, x0, y0, x1, y0 + bwy, fill, clip);
            self.emit_box(dl, world, x0, y1 - bwy, x1, y1, fill, clip);
            self.emit_box(dl, world, x0, y0 + bwy, x0 + bwx, y1 - bwy, fill, clip);
            self.emit_box(dl, world, x1 - bwx, y0 + bwy, x1, y1 - bwy, fill, clip);
            return;
        }

        let ix0 = floorf(sx0).max(floorf(clip.x0)).max(0.0) as i32;
        let iy0 = floorf(sy0).max(floorf(clip.y0)).max(0.0) as i32;
        let ix1 = ceilf(sx1).min(ceilf(clip.x1)).min(self.screen.0) as i32;
        let iy1 = ceilf(sy1).min(ceilf(clip.y1)).min(self.screen.1) as i32;
        if ix1 <= ix0 || iy1 <= iy0 {
            return;
        }

        let inner_sx0 = sx0 + bw;
        let inner_sy0 = sy0 + bw;
        let inner_sx1 = sx1 - bw;
        let inner_sy1 = sy1 - bw;
        let inner_r = (r - bw).max(0.0);
        let has_inner = inner_sx1 > inner_sx0 && inner_sy1 > inner_sy0;

        for py in iy0..iy1 {
            let y_coverage = pixel_interval_coverage(py, sy0, sy1);
            if y_coverage == 0 {
                continue;
            }
            let row_y = clampf(py as f32 + 0.5, sy0, sy1);
            let Some((outer_x0, outer_x1)) = self.rounded_interval_at_row(sx0, sy0, sx1, sy1, r, row_y) else {
                continue;
            };

            let inner = if has_inner && pixel_interval_coverage(py, inner_sy0, inner_sy1) > 0 {
                let inner_row_y = clampf(py as f32 + 0.5, inner_sy0, inner_sy1);
                self.rounded_interval_at_row(inner_sx0, inner_sy0, inner_sx1, inner_sy1, inner_r, inner_row_y)
            } else {
                None
            };

            if let Some((inner_x0, inner_x1)) = inner {
                self.emit_fractional_span(
                    dl,
                    &fill,
                    sx0,
                    sy0,
                    sx1,
                    sy1,
                    py,
                    1,
                    outer_x0,
                    inner_x0.min(outer_x1),
                    ix0,
                    ix1,
                    y_coverage,
                );
                self.emit_fractional_span(
                    dl,
                    &fill,
                    sx0,
                    sy0,
                    sx1,
                    sy1,
                    py,
                    1,
                    inner_x1.max(outer_x0),
                    outer_x1,
                    ix0,
                    ix1,
                    y_coverage,
                );
            } else {
                self.emit_fractional_span(
                    dl,
                    &fill,
                    sx0,
                    sy0,
                    sx1,
                    sy1,
                    py,
                    1,
                    outer_x0,
                    outer_x1,
                    ix0,
                    ix1,
                    y_coverage,
                );
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn emit_rounded_box(
        &mut self,
        dl: &mut DrawList,
        world: &Affine,
        x0: f32,
        y0: f32,
        x1: f32,
        y1: f32,
        radius: f32,
        fill: Fill,
        clip: &Clip,
    ) {
        if radius <= 0.0 || !world.is_axis_aligned() {
            self.emit_box(dl, world, x0, y0, x1, y1, fill, clip);
            return;
        }
        let (sx0, sy0) = world.apply(x0, y0);
        let (sx1, sy1) = world.apply(x1, y1);
        if sx1 <= sx0 || sy1 <= sy0 {
            return;
        }
        let w = sx1 - sx0;
        let h = sy1 - sy0;
        let scale_y = world.d.max(0.0);
        let r = (radius * scale_y).min(w * 0.5).min(h * 0.5);
        if r <= 0.5 {
            self.emit_box(dl, world, x0, y0, x1, y1, fill, clip);
            return;
        }
        // Flat fills: four baked-disc corner sprites + three rects — O(1)
        // ops per box instead of per-row coverage spans (the spans cost
        // ~7 ms/frame of PSP CPU on rounded-heavy screens). Gradients keep
        // the exact span path below.
        if let Fill::Flat(color) = fill {
            let r_px = roundf(r).max(1.0) as u32;
            // Bake discs only for small radii: UI corner radii recur and
            // cache forever, but ANIMATED radii (a scaling rounded-full
            // splash) mint a new radius every frame — baking those spiked a
            // real-PSP frame to 118 ms and grew the texture list unboundedly.
            // Large radii take the analytic span path below instead.
            const DISC_MAX_R: u32 = 32;
            if r_px <= DISC_MAX_R {
                if let Some((tex, dim)) = disc_texture(self.discs, self.textures, r_px) {
                    let rf = r_px as f32;
                    let du = rf / dim as f32; // one corner quadrant in UV space
                    let corners = [
                        (sx0, sy0, 0.0, 0.0),           // TL quadrant
                        (sx1 - rf, sy0, du, 0.0),       // TR
                        (sx0, sy1 - rf, 0.0, du),       // BL
                        (sx1 - rf, sy1 - rf, du, du),   // BR
                    ];
                    for &(cx, cy, u0, v0) in corners.iter() {
                        self.emit_corner_quad(dl, tex, cx, cy, rf, u0, v0, du, color, clip);
                    }
                    let mid = Fill::Flat(color);
                    // middle band (full width) + top/bottom strips between corners
                    self.emit_screen_rect(dl, sx0, sy0 + rf, sx1, sy1 - rf, mid, clip);
                    self.emit_screen_rect(dl, sx0 + rf, sy0, sx1 - rf, sy0 + rf, mid, clip);
                    self.emit_screen_rect(dl, sx0 + rf, sy1 - rf, sx1 - rf, sy1, mid, clip);
                    return;
                }
            }
        }
        let ix0 = floorf(sx0).max(floorf(clip.x0)).max(0.0) as i32;
        let iy0 = floorf(sy0).max(floorf(clip.y0)).max(0.0) as i32;
        let ix1 = ceilf(sx1).min(ceilf(clip.x1)).min(self.screen.0) as i32;
        let iy1 = ceilf(sy1).min(ceilf(clip.y1)).min(self.screen.1) as i32;
        if ix1 <= ix0 || iy1 <= iy0 {
            return;
        }
        let rr = r * r;
        let tall_middle = !vertical_gradient(&fill);
        let mid_y0 = if tall_middle {
            (ceilf(sy0 + r) as i32).max(iy0).min(iy1)
        } else {
            iy0
        };
        let mid_y1 = if tall_middle {
            (floorf(sy1 - r) as i32).max(iy0).min(iy1)
        } else {
            iy0
        };
        if tall_middle && mid_y1 > mid_y0 {
            let span_x0 = sx0.max(ix0 as f32);
            let span_x1 = sx1.min(ix1 as f32);
            if span_x1 > span_x0 {
                let left_edge = floorf(span_x0) as i32;
                let full_start = ceilf(span_x0) as i32;
                let full_end = floorf(span_x1) as i32;
                let right_edge = ceilf(span_x1) as i32;
                let h = mid_y1 - mid_y0;
                let mut emitted_left_edge = false;
                if left_edge < full_start && left_edge >= ix0 && left_edge < ix1 {
                    let x_coverage = pixel_interval_coverage(left_edge, span_x0, span_x1);
                    self.emit_rounded_span(
                        dl,
                        &fill,
                        sx0,
                        sy0,
                        sx1,
                        sy1,
                        mid_y0,
                        h,
                        left_edge,
                        left_edge + 1,
                        x_coverage,
                    );
                    emitted_left_edge = true;
                }
                let inner_x0 = full_start.max(ix0);
                let inner_x1 = full_end.min(ix1);
                self.emit_rounded_span(dl, &fill, sx0, sy0, sx1, sy1, mid_y0, h, inner_x0, inner_x1, 255);
                if full_end < right_edge
                    && full_end >= ix0
                    && full_end < ix1
                    && !(emitted_left_edge && full_end == left_edge)
                {
                    let x_coverage = pixel_interval_coverage(full_end, span_x0, span_x1);
                    self.emit_rounded_span(
                        dl,
                        &fill,
                        sx0,
                        sy0,
                        sx1,
                        sy1,
                        mid_y0,
                        h,
                        full_end,
                        full_end + 1,
                        x_coverage,
                    );
                }
            }
        }
        for py in iy0..iy1 {
            if tall_middle && py >= mid_y0 && py < mid_y1 {
                continue;
            }
            let y_coverage = pixel_interval_coverage(py, sy0, sy1);
            if y_coverage == 0 {
                continue;
            }

            let row_y = clampf(py as f32 + 0.5, sy0, sy1);
            let inset = if row_y < sy0 + r {
                let dy = sy0 + r - row_y;
                r - sqrtf((rr - dy * dy).max(0.0))
            } else if row_y > sy1 - r {
                let dy = row_y - (sy1 - r);
                r - sqrtf((rr - dy * dy).max(0.0))
            } else {
                0.0
            };
            let span_x0 = (sx0 + inset).max(ix0 as f32);
            let span_x1 = (sx1 - inset).min(ix1 as f32);
            if span_x1 <= span_x0 {
                continue;
            }

            let left_edge = floorf(span_x0) as i32;
            let full_start = ceilf(span_x0) as i32;
            let full_end = floorf(span_x1) as i32;
            let right_edge = ceilf(span_x1) as i32;

            let mut emitted_left_edge = false;
            if left_edge < full_start && left_edge >= ix0 && left_edge < ix1 {
                let x_coverage = pixel_interval_coverage(left_edge, span_x0, span_x1);
                self.emit_rounded_span(
                    dl,
                    &fill,
                    sx0,
                    sy0,
                    sx1,
                    sy1,
                    py,
                    1,
                    left_edge,
                    left_edge + 1,
                    coverage_mul(x_coverage, y_coverage),
                );
                emitted_left_edge = true;
            }

            let inner_x0 = full_start.max(ix0);
            let inner_x1 = full_end.min(ix1);
            self.emit_rounded_span(dl, &fill, sx0, sy0, sx1, sy1, py, 1, inner_x0, inner_x1, y_coverage);

            if full_end < right_edge && full_end >= ix0 && full_end < ix1 && !(emitted_left_edge && full_end == left_edge) {
                let x_coverage = pixel_interval_coverage(full_end, span_x0, span_x1);
                self.emit_rounded_span(
                    dl,
                    &fill,
                    sx0,
                    sy0,
                    sx1,
                    sy1,
                    py,
                    1,
                    full_end,
                    full_end + 1,
                    coverage_mul(x_coverage, y_coverage),
                );
            }
        }
    }

    fn emit_shadow(&mut self, dl: &mut DrawList, world: &Affine, w: f32, h: f32, radius: f32, level: u32, opacity: f32, clip: &Clip) {
        if !world.is_axis_aligned() {
            return;
        }
        let layers: &[(f32, f32, f32, u32)] = match level {
            1 => &[(0.0, 1.0, 0.0, 22), (0.0, 2.0, 1.0, 10)],
            2 => &[(0.0, 2.0, 1.0, 24), (0.0, 4.0, 2.0, 12), (0.0, 6.0, 3.0, 6)],
            _ => &[(0.0, 2.0, 1.0, 28), (0.0, 5.0, 3.0, 14), (0.0, 9.0, 5.0, 7)],
        };
        for &(dx, dy, spread, alpha) in layers {
            let color = scale_alpha(with_alpha_abgr(0x0000_0000, alpha), opacity);
            self.emit_rounded_box(
                dl,
                world,
                -spread + dx,
                -spread + dy,
                w + spread + dx,
                h + spread + dy,
                radius + spread,
                Fill::Flat(color),
                clip,
            );
        }
    }

    /// Emit an image TEX_QUAD (axis-aligned only; rotated images are
    /// conservatively culled — no textured-triangle op in the DrawList v1).
    #[allow(clippy::too_many_arguments)]
    fn emit_tex_quad(
        &self,
        dl: &mut DrawList,
        world: &Affine,
        w: f32,
        h: f32,
        tex: u32,
        op: f32,
        clip: &Clip,
        fu0: f32,
        fv0: f32,
        fu1: f32,
        fv1: f32,
    ) {
        if !world.is_axis_aligned() {
            // Rotated image: transform corners with their UVs, clip, fan into
            // TEX_TRIs (affine screen-space sampling).
            let corners = [
                (0.0, 0.0, fu0, fv0),
                (w, 0.0, fu1, fv0),
                (w, h, fu1, fv1),
                (0.0, h, fu0, fv1),
            ];
            let mut poly: Vec<ClipVert> = Vec::with_capacity(8);
            for &(lx, ly, u, v) in corners.iter() {
                let (sx, sy) = world.apply(lx, ly);
                poly.push(ClipVert { x: sx, y: sy, color: [255.0; 4], u, v });
            }
            let clipped = sutherland_hodgman(&poly, clip);
            let modulate = scale_alpha(0xffff_ffff, op);
            for i in 1..clipped.len().saturating_sub(1) {
                emit_tex_tri(dl, tex, modulate, &clipped[0], &clipped[i], &clipped[i + 1], clip, self.screen);
            }
            return;
        }
        let (sx0, sy0) = world.apply(0.0, 0.0);
        let (sx1, sy1) = world.apply(w, h);
        if sx1 <= sx0 || sy1 <= sy0 {
            return;
        }
        let c = Clip {
            x0: sx0.max(clip.x0),
            y0: sy0.max(clip.y0),
            x1: sx1.min(clip.x1),
            y1: sy1.min(clip.y1),
        };
        if c.is_empty() || roundf(c.x1 - c.x0) <= 0.0 || roundf(c.y1 - c.y0) <= 0.0 {
            return;
        }
        // UV re-interpolation over the clipped span, remapped into the frame's
        // atlas sub-rect [fu0,fu1] x [fv0,fv1] (the whole texture for images).
        let du = fu1 - fu0;
        let dv = fv1 - fv0;
        let u0 = fu0 + (c.x0 - sx0) / (sx1 - sx0) * du;
        let u1 = fu0 + (c.x1 - sx0) / (sx1 - sx0) * du;
        let v0 = fv0 + (c.y0 - sy0) / (sy1 - sy0) * dv;
        let v1 = fv0 + (c.y1 - sy0) / (sy1 - sy0) * dv;
        dl.words.push(spec::draw_op::TEX_QUAD);
        dl.words.push(tex);
        dl.words.push(xy_word(c.x0, c.y0));
        dl.words.push(wh_word(c.x1 - c.x0, c.y1 - c.y0));
        dl.words.push(u0.to_bits());
        dl.words.push(v0.to_bits());
        dl.words.push(u1.to_bits());
        dl.words.push(v1.to_bits());
        dl.words.push(scale_alpha(0xffff_ffff, op));
    }

    /// Emit the inline text run of a text element as one GLYPH_RUN.
    #[allow(clippy::too_many_arguments)]
    fn emit_text(
        &mut self,
        dl: &mut DrawList,
        node: &crate::tree::Node,
        r: &style::Resolved,
        world: &Affine,
        op: f32,
        clip: &Clip,
        box_w: f32,
    ) {
        let color = scale_alpha(r.text_color, op);
        if alpha(color) == 0 {
            return;
        }
        let slot = r.font_slot as u8;
        let Some(atlas) = self.fonts.atlas(slot) else { return };
        let (cell_w, cell_h) = (atlas.cell_w as f32, atlas.cell_h as f32);
        let mut run = alloc::string::String::new();
        // paint() gives us the node ref; re-walk its subtree for the run.
        // (node.children ids resolve through self.tree.)
        collect_run_of(self.tree, node, &mut run);
        if run.is_empty() {
            return;
        }
        let mut scratch = core::mem::take(&mut self.glyph_scratch);
        scratch.clear();
        self.fonts
            .layout_run(&run, slot, r.tracking, r.line_height, r.text_align, box_w, &mut scratch);
        let start = dl.words.len();
        dl.words.push(spec::draw_op::GLYPH_RUN);
        dl.words.push(0); // patched below: slot | count << 16
        dl.words.push(color);
        let mut n: u32 = 0;
        for g in &scratch {
            // Glyph cells stay axis-aligned; only the anchor transforms.
            let (sx, sy) = world.apply(g.x, g.y);
            let (rx, ry) = (roundf(sx), roundf(sy));
            // Coordinate-range invariant: cell top-left must sit in
            // [0,SCREEN]; cells that can't be represented are dropped, and
            // cells fully outside the clip are dropped (backend scissor
            // pixel-clips partial overlap inside overflow-hidden regions).
            if rx < 0.0 || ry < 0.0 || rx > self.screen.0 || ry > self.screen.1 {
                continue;
            }
            if rx + cell_w <= clip.x0 || rx >= clip.x1 || ry + cell_h <= clip.y0 || ry >= clip.y1 {
                continue;
            }
            if n == u16::MAX as u32 {
                break;
            }
            dl.words.push(xy_word(rx, ry));
            dl.words.push(g.gid as u32);
            n += 1;
        }
        if n == 0 {
            dl.words.truncate(start);
        } else {
            dl.words[start + 1] = (slot as u32) | (n << 16);
        }
        self.glyph_scratch = scratch;
    }
}

/// Concatenated inline run of a text element (own text + text-type
/// descendants through text nodes).
fn collect_run_of(tree: &Tree, node: &crate::tree::Node, out: &mut alloc::string::String) {
    out.push_str(&node.text);
    for &cid in &node.children {
        if let Some(cs) = tree.resolve(cid) {
            let child = &tree.slots[cs as usize];
            if child.node_type == spec::NodeType::Text as u8 {
                collect_run_of(tree, child, out);
            }
        }
    }
}

// ---- Sutherland-Hodgman with color interpolation -------------------------------

#[derive(Clone, Copy)]
struct ClipVert {
    x: f32,
    y: f32,
    color: [f32; 4], // r, g, b, a (ABGR channel order irrelevant: symmetric)
    /// Normalized texture coords (only meaningful on TEX_TRI paths; solid
    /// paths carry zeros).
    u: f32,
    v: f32,
}

fn unpack(c: u32) -> [f32; 4] {
    [
        (c & 0xff) as f32,
        ((c >> 8) & 0xff) as f32,
        ((c >> 16) & 0xff) as f32,
        ((c >> 24) & 0xff) as f32,
    ]
}

fn pack(c: [f32; 4]) -> u32 {
    let q = |v: f32| ((clampf(v, 0.0, 255.0) + 0.5) as u32) & 0xff;
    q(c[0]) | (q(c[1]) << 8) | (q(c[2]) << 16) | (q(c[3]) << 24)
}

fn lerp_vert(a: &ClipVert, b: &ClipVert, t: f32) -> ClipVert {
    ClipVert {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        color: [
            a.color[0] + (b.color[0] - a.color[0]) * t,
            a.color[1] + (b.color[1] - a.color[1]) * t,
            a.color[2] + (b.color[2] - a.color[2]) * t,
            a.color[3] + (b.color[3] - a.color[3]) * t,
        ],
        u: a.u + (b.u - a.u) * t,
        v: a.v + (b.v - a.v) * t,
    }
}

/// Emit one TEX_TRI op (degenerate triangles after rounding are dropped).
fn emit_tex_tri(
    dl: &mut DrawList,
    tex: u32,
    modulate: u32,
    v0: &ClipVert,
    v1: &ClipVert,
    v2: &ClipVert,
    clip: &Clip,
    screen: (f32, f32),
) {
    let px = |v: &ClipVert| {
        (
            clampf(roundf(clampf(v.x, clip.x0, clip.x1)), 0.0, screen.0),
            clampf(roundf(clampf(v.y, clip.y0, clip.y1)), 0.0, screen.1),
        )
    };
    let (x0, y0) = px(v0);
    let (x1, y1) = px(v1);
    let (x2, y2) = px(v2);
    let area2 = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if area2 == 0.0 {
        return;
    }
    dl.words.push(spec::draw_op::TEX_TRI);
    dl.words.push(tex);
    for (xy, vert) in [((x0, y0), v0), ((x1, y1), v1), ((x2, y2), v2)] {
        dl.words.push(xy_word(xy.0, xy.1));
        dl.words.push(vert.u.to_bits());
        dl.words.push(vert.v.to_bits());
    }
    dl.words.push(modulate);
}

/// Clip a convex polygon against the 4 half-planes of `clip`, interpolating
/// vertex colors along cut edges.
fn sutherland_hodgman(poly: &[ClipVert], clip: &Clip) -> Vec<ClipVert> {
    // edge: (inside predicate, intersection parameter solve)
    // Encode each edge as (axis, bound, keep_leq): axis 0 = x, 1 = y.
    let edges: [(usize, f32, bool); 4] = [
        (0, clip.x0, false), // x >= x0
        (0, clip.x1, true),  // x <= x1
        (1, clip.y0, false), // y >= y0
        (1, clip.y1, true),  // y <= y1
    ];
    let mut cur: Vec<ClipVert> = poly.to_vec();
    for &(axis, bound, keep_leq) in &edges {
        if cur.is_empty() {
            break;
        }
        let coord = |v: &ClipVert| if axis == 0 { v.x } else { v.y };
        let inside = |v: &ClipVert| {
            if keep_leq {
                coord(v) <= bound
            } else {
                coord(v) >= bound
            }
        };
        let mut next: Vec<ClipVert> = Vec::with_capacity(cur.len() + 1);
        for i in 0..cur.len() {
            let a = cur[i];
            let b = cur[(i + 1) % cur.len()];
            let (ia, ib) = (inside(&a), inside(&b));
            if ia {
                next.push(a);
            }
            if ia != ib {
                let da = coord(&a) - bound;
                let db = coord(&b) - bound;
                let t = da / (da - db);
                next.push(lerp_vert(&a, &b, t));
            }
        }
        cur = next;
    }
    cur
}

/// Emit one TRI op (degenerate triangles after rounding are dropped).
fn emit_tri(
    dl: &mut DrawList,
    v0: &ClipVert,
    v1: &ClipVert,
    v2: &ClipVert,
    clip: &Clip,
    screen: (f32, f32),
) {
    // Round + final clamp (interpolation is exact at clip bounds but stay
    // paranoid about float dust).
    let px = |v: &ClipVert| {
        (
            clampf(roundf(clampf(v.x, clip.x0, clip.x1)), 0.0, screen.0),
            clampf(roundf(clampf(v.y, clip.y0, clip.y1)), 0.0, screen.1),
        )
    };
    let (x0, y0) = px(v0);
    let (x1, y1) = px(v1);
    let (x2, y2) = px(v2);
    // Degenerate (zero-area after rounding)?
    let area2 = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if area2 == 0.0 {
        return;
    }
    dl.words.push(spec::draw_op::TRI);
    dl.words.push(xy_word(x0, y0));
    dl.words.push(xy_word(x1, y1));
    dl.words.push(xy_word(x2, y2));
    dl.words.push(pack(v0.color));
    dl.words.push(pack(v1.color));
    dl.words.push(pack(v2.color));
}
