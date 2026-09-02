//! Integer geometry shared by the planner, the emitter, and executors.
//!
//! Logical coordinates are DrawList viewport pixels ([`Clip`], half-open,
//! signed). Physical coordinates are target pixels after the integer render
//! scale ([`Rect`], unsigned, target-local).

pub use pocketjs_core::damage::DamageRect as Clip;
pub use pocketjs_core::drawlist::{logical_rect, pack_xy, pack_wh, wh, xy};
use pocketjs_core::raster::pack_rgb565;

/// Physical target rectangle using half-open bounds.
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
    pub const fn is_empty(self) -> bool {
        self.w == 0 || self.h == 0
    }

    /// Intersection of two physical rectangles (empty when disjoint).
    pub fn intersect(self, other: Rect) -> Rect {
        let x0 = self.x.max(other.x);
        let y0 = self.y.max(other.y);
        let x1 = (self.x + self.w).min(other.x + other.w);
        let y1 = (self.y + self.h).min(other.y + other.h);
        if x1 <= x0 || y1 <= y0 {
            return Rect::default();
        }
        Rect {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        }
    }
}

/// One physical target coordinate used by texture transforms. Signed so a
/// quad may extend beyond the target before clipping.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

/// Four destination points ordered TL, BL, BR, TR. They map to the four
/// edges of a source rectangle, so mirroring is expressed by point order.
pub type Quad = [Point; 4];

/// Physical rectangle covering `clip` at `scale` (global target coordinates).
#[inline]
pub fn physical_rect(clip: Clip, scale: u32) -> Rect {
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

/// Physical rectangle covering `clip ∩ surface`, translated so `surface`'s
/// top-left corner is the target origin (strip-local coordinates).
#[inline]
pub fn local_physical_rect(clip: Clip, surface: Clip, scale: u32) -> Rect {
    let clip = clip.intersect(surface);
    if clip.is_empty() {
        return Rect::default();
    }
    Rect {
        x: (clip.x0 - surface.x0) as u32 * scale,
        y: (clip.y0 - surface.y0) as u32 * scale,
        w: (clip.x1 - clip.x0) as u32 * scale,
        h: (clip.y1 - clip.y0) as u32 * scale,
    }
}

/// Bounding box of four logical points.
pub fn point_bounds(points: [Point; 4]) -> Clip {
    let mut x0 = points[0].x;
    let mut y0 = points[0].y;
    let mut x1 = points[0].x;
    let mut y1 = points[0].y;
    for point in &points[1..] {
        x0 = x0.min(point.x);
        y0 = y0.min(point.y);
        x1 = x1.max(point.x);
        y1 = y1.max(point.y);
    }
    Clip { x0, y0, x1, y1 }
}

/// Split a packed ABGR color into `(r, g, b, a)` channels.
#[inline]
pub fn channels(color: u32) -> (u32, u32, u32, u32) {
    (
        color & 0xff,
        (color >> 8) & 0xff,
        (color >> 16) & 0xff,
        color >> 24,
    )
}

/// Opaque fill of one physical rectangle in a target of `stride` pixels.
pub fn fill_rgb565_rect(destination: &mut [u16], stride: u32, rect: Rect, color: u16) {
    for y in rect.y..rect.y + rect.h {
        let start = y as usize * stride as usize + rect.x as usize;
        destination[start..start + rect.w as usize].fill(color);
    }
}

/// The core's exact integer src-over blend of one RGB565 pixel.
#[inline]
pub fn blend_rgb565_pixel(pixel: &mut u16, r: u32, g: u32, b: u32, a: u32) {
    if a >= 255 {
        *pixel = pack_rgb565(r, g, b);
        return;
    }
    if a == 0 {
        return;
    }
    let r5 = (*pixel as u32 >> 11) & 0x1f;
    let g6 = (*pixel as u32 >> 5) & 0x3f;
    let b5 = *pixel as u32 & 0x1f;
    let dr = (r5 << 3) | (r5 >> 2);
    let dg = (g6 << 2) | (g6 >> 4);
    let db = (b5 << 3) | (b5 >> 2);
    let inverse = 255 - a;
    let mix = |source: u32, target: u32| (source * a + target * inverse + 127) / 255;
    *pixel = pack_rgb565(mix(r, dr), mix(g, dg), mix(b, db));
}
