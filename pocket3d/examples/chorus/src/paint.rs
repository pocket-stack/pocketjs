//! Procedural airbrush textures. Everything the diorama wears is painted
//! here at load time — multi-stop chrome ramps for the curtain layers, the
//! striped ceiling, the red-grid dark room, the pixel-city wall, the glow
//! wall behind everything. Deterministic (LCG grain), no assets on disk.

/// A painted RGBA8 image.
pub struct Img {
    pub w: u32,
    pub h: u32,
    pub px: Vec<u8>,
}

impl Img {
    pub fn new(w: u32, h: u32) -> Self {
        Self {
            w,
            h,
            px: vec![0; (w * h * 4) as usize],
        }
    }

    pub fn set(&mut self, x: u32, y: u32, c: [f32; 3]) {
        let i = ((y * self.w + x) * 4) as usize;
        self.px[i] = (c[0].clamp(0.0, 1.0) * 255.0) as u8;
        self.px[i + 1] = (c[1].clamp(0.0, 1.0) * 255.0) as u8;
        self.px[i + 2] = (c[2].clamp(0.0, 1.0) * 255.0) as u8;
        self.px[i + 3] = 255;
    }
}

/// Tiny deterministic noise source (screenshots stay byte-stable).
pub struct Lcg(pub u32);

impl Lcg {
    pub fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        (self.0 >> 8) as f32 / 16_777_216.0
    }
    /// Uniform in [-1, 1].
    pub fn signed(&mut self) -> f32 {
        self.next() * 2.0 - 1.0
    }
}

pub fn rgb(hex: u32) -> [f32; 3] {
    [
        ((hex >> 16) & 0xff) as f32 / 255.0,
        ((hex >> 8) & 0xff) as f32 / 255.0,
        (hex & 0xff) as f32 / 255.0,
    ]
}

fn lerp3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

fn smooth(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Sample a multi-stop gradient at u∈[0,1]. Stops are (position, color),
/// positions ascending; interpolation is smoothstepped so bands stay soft —
/// the airbrush look lives in the easing.
pub fn grad(stops: &[(f32, [f32; 3])], u: f32) -> [f32; 3] {
    let u = u.clamp(0.0, 1.0);
    let mut prev = stops[0];
    for &s in stops {
        if u <= s.0 {
            let span = (s.0 - prev.0).max(1e-5);
            return lerp3(prev.1, s.1, smooth((u - prev.0) / span));
        }
        prev = s;
    }
    prev.1
}

/// Horizontal chrome ramp: u runs across (edge → wall), v gets faint
/// large-scale luminance sway + fine grain so flats never read sterile.
pub fn chrome_ramp(w: u32, h: u32, stops: &[(f32, [f32; 3])], seed: u32) -> Img {
    let mut img = Img::new(w, h);
    let mut noise = Lcg(seed);
    let grain: Vec<f32> = (0..(w * h)).map(|_| noise.signed() * 0.014).collect();
    for y in 0..h {
        let v = y as f32 / (h - 1).max(1) as f32;
        let sway = (v * std::f32::consts::TAU * 1.5).sin() * 0.02;
        for x in 0..w {
            let u = x as f32 / (w - 1) as f32;
            let mut c = grad(stops, u);
            let g = grain[(y * w + x) as usize] + sway;
            c = [c[0] + g, c[1] + g, c[2] + g];
            img.set(x, y, c);
        }
    }
    img
}

/// The ceiling: red/orange/green airbrush stripes running along x, receding
/// with depth (u = depth 0 front → 1 back), melting into the glow near the
/// back wall.
pub fn ceiling_stripes(w: u32, h: u32, seed: u32) -> Img {
    let stripes = [
        (0.00, rgb(0x2A1714)),
        (0.08, rgb(0x8E2418)),
        (0.16, rgb(0xD96A35)),
        (0.24, rgb(0xC3391F)),
        (0.32, rgb(0x1F3A28)),
        (0.40, rgb(0xD3542A)),
        (0.48, rgb(0x27492F)),
        (0.56, rgb(0xE0854A)),
        (0.64, rgb(0x7E1F14)),
        (0.72, rgb(0xD96A35)),
        (0.80, rgb(0x1F3A28)),
        (0.88, rgb(0xB93A20)),
        (1.00, rgb(0xE8D9BF)),
    ];
    let glow = rgb(0xF2EDE0);
    let mut img = Img::new(w, h);
    let mut noise = Lcg(seed);
    let grain: Vec<f32> = (0..(w * h)).map(|_| noise.signed() * 0.012).collect();
    for y in 0..h {
        for x in 0..w {
            let u = x as f32 / (w - 1) as f32;
            let mut c = grad(&stripes, u);
            // Melt into the back glow over the last stretch.
            let melt = smooth((u - 0.72) / 0.28);
            c = lerp3(c, glow, melt * 0.85);
            let g = grain[(y * w + x) as usize];
            img.set(x, y, [c[0] + g, c[1] + g, c[2] + g]);
        }
    }
    img
}

/// The left wall, two registers like the sleeve's left side: red/green
/// airbrush stripes across the top, and below them the dark room with a
/// red-lit brick grid smoldering in it. u = depth (front → back),
/// v = height (top → bottom).
pub fn grid_wall(w: u32, h: u32, seed: u32) -> Img {
    let stripes = [
        (0.00, rgb(0x7E1F14)),
        (0.07, rgb(0xC3391F)),
        (0.14, rgb(0xE0854A)),
        (0.2, rgb(0x27492F)),
        (0.27, rgb(0xD3542A)),
        (0.33, rgb(0x1F3A28)),
        (0.4, rgb(0x8E2418)),
    ];
    let base_top = rgb(0x131A2C);
    let base_bot = rgb(0x181F33);
    let ember = rgb(0xD8502E);
    let mut img = Img::new(w, h);
    let mut noise = Lcg(seed);
    let grain: Vec<f32> = (0..(w * h)).map(|_| noise.signed() * 0.012).collect();
    // Per-cell ember intensity.
    let (cw, ch) = (14u32, 9u32);
    let mut cell_noise = Lcg(seed ^ 0x5bd1);
    let cells: Vec<f32> = (0..((w / cw + 2) * (h / ch + 2)))
        .map(|_| cell_noise.next())
        .collect();
    let cells_per_row = w / cw + 2;
    for y in 0..h {
        let v = y as f32 / (h - 1) as f32;
        for x in 0..w {
            let u = x as f32 / (w - 1) as f32;
            let mut c = lerp3(base_top, base_bot, v);
            // Upper register: stripes, dimming as the room takes over.
            if v < 0.46 {
                let s = grad(&stripes, v);
                let hand_off = smooth((v - 0.3) / 0.16);
                // Stripes glow a little brighter deeper in (toward u=1).
                let lit = lerp3(s, [s[0] * 1.25, s[1] * 1.25, s[2] * 1.25], u * 0.6);
                c = lerp3(lit, c, hand_off);
            }
            // The grid lives in the lower middle of the room and dies out
            // toward the back and the floor.
            let zone = smooth((v - 0.42) / 0.16)
                * (1.0 - smooth((u - 0.55) / 0.3))
                * (1.0 - smooth((v - 0.92) / 0.08));
            if zone > 0.01 {
                let (gx, gy) = (x % cw, y % ch);
                let cell = cells[((y / ch) * cells_per_row + x / cw) as usize];
                let line = gx < 2 || gy < 2;
                if line {
                    let heat = zone * (0.25 + 0.75 * cell);
                    c = lerp3(c, ember, heat);
                } else {
                    // Bricks catch a little of the glow.
                    c = lerp3(c, rgb(0x3A1A1E), zone * 0.4 * cell);
                }
            }
            let g = grain[(y * w + x) as usize];
            img.set(x, y, [c[0] + g, c[1] + g, c[2] + g]);
        }
    }
    img
}

/// The pixel city: an indigo→periwinkle wall with washed rectangular blocks
/// like far-off lit windows. u = depth, v = height (top → bottom).
pub fn block_wall(w: u32, h: u32, seed: u32) -> Img {
    let mut img = Img::new(w, h);
    let mut noise = Lcg(seed);
    let vert = [
        (0.0, rgb(0x3A3E86)),
        (0.45, rgb(0x7A86C6)),
        (0.8, rgb(0xAEBBE4)),
        (1.0, rgb(0x8E9AD0)),
    ];
    for y in 0..h {
        let v = y as f32 / (h - 1) as f32;
        for x in 0..w {
            let u = x as f32 / (w - 1) as f32;
            let mut c = grad(&vert, v);
            // Brighter toward the deep end where the glow lives.
            c = lerp3(c, rgb(0xD9E0F2), smooth((u - 0.6) / 0.4) * 0.5);
            let g = noise.signed() * 0.008;
            img.set(x, y, [c[0] + g, c[1] + g, c[2] + g]);
        }
    }
    // Washed blocks, denser mid-wall.
    let mut rects = Lcg(seed ^ 0x9e37);
    for _ in 0..60 {
        let bw = (10.0 + rects.next() * 34.0) as u32;
        let bh = (8.0 + rects.next() * 22.0) as u32;
        let bx = (rects.next() * (w - bw - 1) as f32) as u32;
        let by = (rects.next() * (h - bh - 1) as f32) as u32;
        let tint = lerp3(rgb(0xC9D3F2), rgb(0xF2F5FC), rects.next());
        let a = 0.28 + rects.next() * 0.4;
        for y in by..by + bh {
            for x in bx..bx + bw {
                // Feather the block edges — hard rects at grazing angles
                // alias into streaks.
                let edge = (x - bx + 1)
                    .min(bx + bw - x)
                    .min(y - by + 1)
                    .min(by + bh - y) as f32
                    / 3.0;
                let i = ((y * img.w + x) * 4) as usize;
                let c = [
                    img.px[i] as f32 / 255.0,
                    img.px[i + 1] as f32 / 255.0,
                    img.px[i + 2] as f32 / 255.0,
                ];
                img.set(x, y, lerp3(c, tint, a * edge.min(1.0)));
            }
        }
    }
    img
}

/// The back wall: a warm white core (behind the star) breathing out to
/// lavender corners, with faint vertical fold shadows suggesting curtains
/// all the way down. (cx, cy) is the glow center in UV.
pub fn glow_wall(w: u32, h: u32, cx: f32, cy: f32, seed: u32) -> Img {
    let radial = [
        (0.0, rgb(0xFFFDF2)),
        (0.22, rgb(0xF6F0DF)),
        (0.5, rgb(0xD5D4E4)),
        (0.8, rgb(0xA7AACE)),
        (1.0, rgb(0x8F93BE)),
    ];
    let mut img = Img::new(w, h);
    let mut noise = Lcg(seed);
    for y in 0..h {
        let v = y as f32 / (h - 1) as f32;
        for x in 0..w {
            let u = x as f32 / (w - 1) as f32;
            let r = (((u - cx) * (u - cx) + (v - cy) * (v - cy)).sqrt() * 1.35).min(1.0);
            let mut c = grad(&radial, r);
            // Vertical fold hints, strongest away from the core.
            let fold = (u * std::f32::consts::TAU * 7.0).sin() * 0.05 * smooth((r - 0.25) / 0.5);
            let g = noise.signed() * 0.008 + fold;
            c = [c[0] + g, c[1] + g, c[2] + g];
            img.set(x, y, c);
        }
    }
    img
}

/// The floor: dusty blue fog brightening into the glow at the deep end.
/// u = depth (front → back), v across.
pub fn fog_floor(w: u32, h: u32, seed: u32) -> Img {
    let depth = [
        (0.0, rgb(0x5F739E)),
        (0.35, rgb(0x8CA2C8)),
        (0.7, rgb(0xC2D2E8)),
        (1.0, rgb(0xEDF2F8)),
    ];
    let mut img = Img::new(w, h);
    let mut noise = Lcg(seed);
    for y in 0..h {
        let v = y as f32 / (h - 1) as f32;
        for x in 0..w {
            let u = x as f32 / (w - 1) as f32;
            let mut c = grad(&depth, u);
            let billow = ((u * 9.0 + v * 4.0).sin() + (u * 4.0 - v * 7.0).cos()) * 0.012;
            let g = noise.signed() * 0.01 + billow;
            c = [c[0] + g, c[1] + g, c[2] + g];
            img.set(x, y, c);
        }
    }
    img
}

/// Frame front: warm gallery cream, barely shaded.
pub fn frame_face(w: u32, h: u32, seed: u32) -> Img {
    let mut img = Img::new(w, h);
    let mut noise = Lcg(seed);
    for y in 0..h {
        let v = y as f32 / (h - 1) as f32;
        for x in 0..w {
            let c = lerp3(rgb(0xF0ECE1), rgb(0xE2DDCE), v);
            let g = noise.signed() * 0.008;
            img.set(x, y, [c[0] + g, c[1] + g, c[2] + g]);
        }
    }
    img
}

/// Frame bevel: the lit blue windowsill between the cream face and the box.
pub fn bevel_ramp(w: u32, h: u32, seed: u32) -> Img {
    chrome_ramp(
        w,
        h,
        &[
            (0.0, rgb(0xD8DFF2)),
            (0.35, rgb(0xA9B6E0)),
            (0.75, rgb(0x7C8CC8)),
            (1.0, rgb(0x6474B4)),
        ],
        seed,
    )
}

/// The eye: pale sclera, rust ring, dark pupil, one glint. Radial, drawn
/// straight into a square texture.
pub fn iris(size: u32, seed: u32) -> Img {
    let stops = [
        (0.0, rgb(0x0A0A12)),
        (0.24, rgb(0x14090E)),
        (0.3, rgb(0x6E1F1A)),
        (0.42, rgb(0xC24A2C)),
        (0.52, rgb(0x7E2A3E)),
        (0.6, rgb(0xB8BEDC)),
        (0.72, rgb(0xE8ECF6)),
        (0.9, rgb(0xD5DEF0)),
        (1.0, rgb(0xC5D0E8)),
    ];
    let mut img = Img::new(size, size);
    let mut noise = Lcg(seed);
    for y in 0..size {
        let v = y as f32 / (size - 1) as f32 * 2.0 - 1.0;
        for x in 0..size {
            let u = x as f32 / (size - 1) as f32 * 2.0 - 1.0;
            let r = (u * u + v * v).sqrt().min(1.0);
            let mut c = grad(&stops, r);
            // Glint upper-left of the pupil.
            let gd = ((u + 0.12) * (u + 0.12) + (v + 0.16) * (v + 0.16)).sqrt();
            c = lerp3(c, [1.0, 1.0, 1.0], (1.0 - smooth(gd / 0.1)) * 0.9);
            let g = noise.signed() * 0.01;
            img.set(x, y, [c[0] + g, c[1] + g, c[2] + g]);
        }
    }
    img
}

// ---------------------------------------------------------------------------
// Curtain palettes — the cast of the corridor, front to back.
// ---------------------------------------------------------------------------

// Every ramp opens with a bright lip at u=0 (the lit profile edge — it is
// what makes the silhouettes read as cut metal) and settles toward its
// body color at the wall side.

/// One gradient: (position, color) stops across a curtain, edge → wall.
pub type Ramp = Vec<(f32, [f32; 3])>;

pub fn ramp_black_profile() -> Ramp {
    vec![
        (0.0, rgb(0xEDE7D6)),
        (0.02, rgb(0x4A4C54)),
        (0.06, rgb(0x181A24)),
        (0.3, rgb(0x0C0E16)),
        (0.7, rgb(0x121420)),
        (1.0, rgb(0x0A0C14)),
    ]
}

pub fn ramp_sage() -> Ramp {
    vec![
        (0.0, rgb(0xF7F3E2)),
        (0.045, rgb(0xA8A489)),
        (0.1, rgb(0xEFEACD)),
        (0.18, rgb(0x6E6F58)),
        (0.28, rgb(0xDDD8BB)),
        (0.4, rgb(0x7C7D63)),
        (0.55, rgb(0xCFC9AE)),
        (0.72, rgb(0x8B8A70)),
        (1.0, rgb(0x5E6050)),
    ]
}

pub fn ramp_pink() -> Ramp {
    vec![
        (0.0, rgb(0xF9F1E4)),
        (0.05, rgb(0xC9A9A2)),
        (0.12, rgb(0xF1DDD2)),
        (0.22, rgb(0x96716F)),
        (0.34, rgb(0xE7C9BE)),
        (0.5, rgb(0xA5807C)),
        (0.7, rgb(0xD9B9AE)),
        (1.0, rgb(0x7E625F)),
    ]
}

pub fn ramp_teal() -> Ramp {
    vec![
        (0.0, rgb(0xF1F7EF)),
        (0.06, rgb(0x9FBAAE)),
        (0.14, rgb(0xE2EEE5)),
        (0.26, rgb(0x6E948C)),
        (0.4, rgb(0xD2E4DA)),
        (0.6, rgb(0x7FA49B)),
        (1.0, rgb(0x5C8078)),
    ]
}

pub fn ramp_lavender() -> Ramp {
    vec![
        (0.0, rgb(0xF6F4F0)),
        (0.08, rgb(0xC3C4DA)),
        (0.2, rgb(0xECECF4)),
        (0.35, rgb(0x9FA3C6)),
        (0.55, rgb(0xDEDFED)),
        (1.0, rgb(0x8E93B8)),
    ]
}

pub fn ramp_warm_fold() -> Ramp {
    vec![
        (0.0, rgb(0xFAF6E8)),
        (0.08, rgb(0xD8CDB4)),
        (0.2, rgb(0xF4EEDA)),
        (0.38, rgb(0xB3A98E)),
        (0.6, rgb(0xE8E0C8)),
        (1.0, rgb(0x9C9278)),
    ]
}

pub fn ramp_valance() -> Ramp {
    vec![
        (0.0, rgb(0xF5F0DC)),
        (0.05, rgb(0x9A9A7A)),
        (0.12, rgb(0xE4DFC0)),
        (0.24, rgb(0x6E7054)),
        (0.4, rgb(0xCEC9A8)),
        (0.6, rgb(0x7E8062)),
        (1.0, rgb(0x5A5C48)),
    ]
}

pub fn ramp_dune() -> Ramp {
    vec![
        (0.0, rgb(0xFFEDCC)),
        (0.06, rgb(0xF0B265)),
        (0.16, rgb(0xC87A35)),
        (0.3, rgb(0xE89A4E)),
        (0.5, rgb(0xB96F2F)),
        (0.75, rgb(0xD98A40)),
        (1.0, rgb(0xA85F28)),
    ]
}

pub fn ramp_lid() -> Ramp {
    vec![
        (0.0, rgb(0xF2EFE2)),
        (0.06, rgb(0x8A8EA0)),
        (0.16, rgb(0xE6E7EE)),
        (0.32, rgb(0x525A74)),
        (0.55, rgb(0xC4C9D8)),
        (0.8, rgb(0x646C88)),
        (1.0, rgb(0x3A4058)),
    ]
}

/// Cube faces: glossy purple, one ramp per face packed vertically.
pub fn cube_faces(w: u32, h: u32, seed: u32) -> Img {
    let faces = [
        [(0.0, rgb(0xC9B4F0)), (1.0, rgb(0x9A7ED8))], // top
        [(0.0, rgb(0x7A5EC8)), (1.0, rgb(0x503CA0))], // front
        [(0.0, rgb(0x453394)), (1.0, rgb(0x2C2068))], // side
    ];
    let mut img = Img::new(w, h);
    let mut noise = Lcg(seed);
    let band = h / 3;
    for y in 0..h {
        let f = ((y / band) as usize).min(2);
        let v = (y % band) as f32 / band.max(1) as f32;
        for x in 0..w {
            let u = x as f32 / (w - 1) as f32;
            let mut c = grad(&faces[f], (u + v) * 0.5);
            let g = noise.signed() * 0.01;
            c = [c[0] + g, c[1] + g, c[2] + g];
            img.set(x, y, c);
        }
    }
    img
}
