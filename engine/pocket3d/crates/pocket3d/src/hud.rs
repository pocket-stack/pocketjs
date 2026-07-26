//! Immediate-mode 2D overlay: rects, bitmap text (8x8 font), crosshairs.
//!
//! Callers rebuild a [`Hud`] every frame; the renderer uploads and draws it
//! in one pass after the 3D scene. Coordinates are in pixels, origin top-left.

use bytemuck::{Pod, Zeroable};

pub const GLYPH: f32 = 8.0;

/// Atlas: 16x6 grid of 8x8 glyphs covering ASCII 0x20..=0x7F.
/// The last cell (0x7F, DEL) is baked solid white and used for plain rects.
pub const ATLAS_W: u32 = 16 * 8;
pub const ATLAS_H: u32 = 6 * 8;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct HudVertex {
    pub pos: [f32; 2],
    pub uv: [f32; 2],
    pub color: [f32; 4],
}

#[derive(Default)]
pub struct Hud {
    pub verts: Vec<HudVertex>,
}

impl Hud {
    pub fn clear(&mut self) {
        self.verts.clear();
    }

    fn quad(&mut self, x: f32, y: f32, w: f32, h: f32, uv: [f32; 4], color: [f32; 4]) {
        let (u0, v0, u1, v1) = (uv[0], uv[1], uv[2], uv[3]);
        let tl = HudVertex {
            pos: [x, y],
            uv: [u0, v0],
            color,
        };
        let tr = HudVertex {
            pos: [x + w, y],
            uv: [u1, v0],
            color,
        };
        let bl = HudVertex {
            pos: [x, y + h],
            uv: [u0, v1],
            color,
        };
        let br = HudVertex {
            pos: [x + w, y + h],
            uv: [u1, v1],
            color,
        };
        self.verts.extend_from_slice(&[tl, bl, br, tl, br, tr]);
    }

    /// Solid rectangle.
    pub fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, color: [f32; 4]) {
        self.quad(x, y, w, h, glyph_uv(0x7F), color);
    }

    /// Draw text with the builtin 8x8 font at integer `scale`.
    pub fn text(&mut self, x: f32, y: f32, scale: f32, color: [f32; 4], s: &str) {
        let mut cx = x;
        for ch in s.chars() {
            let code = ch as u32;
            if (0x20..0x7F).contains(&code) {
                if code != 0x20 {
                    self.quad(
                        cx,
                        y,
                        GLYPH * scale,
                        GLYPH * scale,
                        glyph_uv(code as u8),
                        color,
                    );
                }
                cx += GLYPH * scale;
            } else {
                cx += GLYPH * scale;
            }
        }
    }

    pub fn text_width(s: &str, scale: f32) -> f32 {
        s.chars().count() as f32 * GLYPH * scale
    }

    pub fn text_centered(&mut self, cx: f32, y: f32, scale: f32, color: [f32; 4], s: &str) {
        let w = Self::text_width(s, scale);
        self.text(cx - w / 2.0, y, scale, color, s);
    }

    /// Classic 4-line crosshair around the screen center.
    pub fn crosshair(&mut self, cx: f32, cy: f32, gap: f32, len: f32, th: f32, color: [f32; 4]) {
        self.rect(cx - gap - len, cy - th / 2.0, len, th, color);
        self.rect(cx + gap, cy - th / 2.0, len, th, color);
        self.rect(cx - th / 2.0, cy - gap - len, th, len, color);
        self.rect(cx - th / 2.0, cy + gap, th, len, color);
    }
}

fn glyph_uv(code: u8) -> [f32; 4] {
    let idx = (code - 0x20) as u32;
    let gx = (idx % 16) as f32 * GLYPH;
    let gy = (idx / 16) as f32 * GLYPH;
    [
        gx / ATLAS_W as f32,
        gy / ATLAS_H as f32,
        (gx + GLYPH) / ATLAS_W as f32,
        (gy + GLYPH) / ATLAS_H as f32,
    ]
}

/// Build the single-channel glyph atlas from the public-domain font8x8 set.
pub fn build_font_atlas() -> Vec<u8> {
    let mut pixels = vec![0u8; (ATLAS_W * ATLAS_H) as usize];
    for code in 0x20u8..0x7F {
        let glyph = font8x8::legacy::BASIC_LEGACY[code as usize];
        let idx = (code - 0x20) as u32;
        let ox = (idx % 16) * 8;
        let oy = (idx / 16) * 8;
        for (row, bits) in glyph.iter().enumerate() {
            for col in 0..8u32 {
                if bits & (1 << col) != 0 {
                    let px = ox + col;
                    let py = oy + row as u32;
                    pixels[(py * ATLAS_W + px) as usize] = 0xFF;
                }
            }
        }
    }
    // Solid-white cell for rect drawing (0x7F).
    let idx = (0x7F - 0x20) as u32;
    let (ox, oy) = (idx % 16 * 8, idx / 16 * 8);
    for r in 0..8 {
        for c in 0..8 {
            pixels[((oy + r) * ATLAS_W + ox + c) as usize] = 0xFF;
        }
    }
    pixels
}
