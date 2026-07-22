//! The set: a framed box whose interior is dressed like a theater stage —
//! wing after wing of cut-metal curtains, each carrying a face in profile,
//! receding to a glow. Everything is authored procedurally at load time;
//! the airbrush shading is painted by `paint` and the geometry's only job
//! is to give those ramps silhouettes to hug.
//!
//! Units are scene millimeters-ish; the frame opening is 84×84 centered at
//! the origin, front face +Z, the corridor runs to z = -125.

use std::sync::Arc;

use glam::{Mat4, Vec2, Vec3};
use pocket3d::gpu::Gpu;
use pocket3d::model::{ModelAsset, ModelInstance, ModelVertex};
use pocket3d::renderer::Renderer;
use pocket3d::scene::Scene;

use crate::paint::{self, Img};

/// Half-size of the frame opening (the hole in the cream face).
pub const OPEN: f32 = 44.0;
/// Half-size of the frame's outer edge.
pub const OUTER: f32 = 54.0;
/// Half-size of the box interior — the mat bevel closes 44 → 42, so the
/// blue reveal is visible on every side like a gallery mat.
pub const BOX: f32 = 42.0;
/// Where the bevel lands and the interior begins.
pub const BEVEL_Z: f32 = -6.0;
/// The back wall.
pub const BACK_Z: f32 = -125.0;
/// Where the light lives — in front of the deep folds, so its spikes lie
/// over their edges the way the sleeve's starburst does.
pub const STAR: Vec3 = Vec3::new(0.0, -4.0, -86.0);

// ---------------------------------------------------------------------------
// Mesh scaffolding
// ---------------------------------------------------------------------------

#[derive(Default)]
struct MeshBuf {
    v: Vec<ModelVertex>,
    i: Vec<u32>,
}

impl MeshBuf {
    fn vert(pos: Vec3, uv: [f32; 2]) -> ModelVertex {
        ModelVertex {
            pos: pos.to_array(),
            normal: [0.0, 0.0, 1.0],
            uv,
            joints: [0; 4],
            weights: [1.0, 0.0, 0.0, 0.0],
        }
    }

    /// Emit a quad wound so it faces `hint` (the renderer culls back faces).
    fn quad(&mut self, p: [Vec3; 4], uv: [[f32; 2]; 4], hint: Vec3) {
        let n = (p[1] - p[0]).cross(p[2] - p[0]);
        let base = self.v.len() as u32;
        if n.dot(hint) >= 0.0 {
            for k in 0..4 {
                self.v.push(Self::vert(p[k], uv[k]));
            }
        } else {
            for k in [0usize, 3, 2, 1] {
                self.v.push(Self::vert(p[k], uv[k]));
            }
        }
        self.i
            .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }

    /// Emit a quad exactly as wound.
    fn quad_raw(&mut self, p: [Vec3; 4], uv: [[f32; 2]; 4]) {
        let base = self.v.len() as u32;
        for k in 0..4 {
            self.v.push(Self::vert(p[k], uv[k]));
        }
        self.i
            .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }

    /// Emit a quad visible from both sides (rims, free-floating bands).
    fn quad_ds(&mut self, p: [Vec3; 4], uv: [[f32; 2]; 4]) {
        self.quad_raw(p, uv);
        self.quad_raw([p[3], p[2], p[1], p[0]], [uv[3], uv[2], uv[1], uv[0]]);
    }

    fn build(
        self,
        gpu: &Gpu,
        renderer: &Renderer,
        label: &str,
        img: Option<&Img>,
    ) -> Arc<ModelAsset> {
        ModelAsset::from_geometry(
            gpu,
            &renderer.model_material_layout,
            &renderer.samplers,
            label,
            &self.v,
            &self.i,
            img.map(|m| (m.w, m.h, m.px.as_slice())),
        )
    }
}

fn push_unlit(scene: &mut Scene, asset: Arc<ModelAsset>, transform: Mat4) {
    let mut inst = ModelInstance::new(asset);
    inst.transform = transform;
    inst.lit = 0.0;
    scene.models.push(inst);
}

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

/// Non-uniform Catmull-Rom through (t, value) controls — C1 profiles, no
/// polyline corners for the chrome bands to kink on.
fn spline(controls: &[(f32, f32)], t: f32) -> f32 {
    let n = controls.len();
    if t <= controls[0].0 {
        return controls[0].1;
    }
    if t >= controls[n - 1].0 {
        return controls[n - 1].1;
    }
    let mut k = 0;
    while k + 2 < n && controls[k + 1].0 < t {
        k += 1;
    }
    let p1 = controls[k];
    let p2 = controls[k + 1];
    let p0 = if k > 0 { controls[k - 1] } else { p1 };
    let p3 = if k + 2 < n { controls[k + 2] } else { p2 };
    let h = (p2.0 - p1.0).max(1e-5);
    let s = ((t - p1.0) / h).clamp(0.0, 1.0);
    let m1 = (p2.1 - p0.1) / (p2.0 - p0.0).max(1e-5) * h;
    let m2 = (p3.1 - p1.1) / (p3.0 - p1.0).max(1e-5) * h;
    let (s2, s3) = (s * s, s * s * s);
    (2.0 * s3 - 3.0 * s2 + 1.0) * p1.1
        + (s3 - 2.0 * s2 + s) * m1
        + (-2.0 * s3 + 3.0 * s2) * p2.1
        + (s3 - s2) * m2
}

/// A face in profile, top of head → neck, as (t, reach) controls where
/// reach 1.0 is the nose tip. Variants so the cast aren't clones; features
/// are kept broad — small wiggles read as noise at curtain scale, not lips.
fn face_controls(variant: u32) -> Vec<(f32, f32)> {
    match variant {
        0 => vec![
            (0.0, 0.04),
            (0.1, 0.3),
            (0.2, 0.38),
            (0.27, 0.26),
            (0.36, 0.5),
            (0.42, 1.0),
            (0.455, 0.52),
            (0.5, 0.62),
            (0.54, 0.48),
            (0.585, 0.66),
            (0.64, 0.4),
            (0.72, 0.56),
            (0.82, 0.24),
            (1.0, 0.02),
        ],
        1 => vec![
            (0.0, 0.03),
            (0.12, 0.34),
            (0.22, 0.42),
            (0.29, 0.3),
            (0.38, 0.56),
            (0.45, 1.0),
            (0.49, 0.44),
            (0.545, 0.64),
            (0.6, 0.4),
            (0.66, 0.6),
            (0.73, 0.34),
            (0.8, 0.44),
            (0.88, 0.18),
            (1.0, 0.02),
        ],
        2 => vec![
            (0.0, 0.05),
            (0.09, 0.26),
            (0.18, 0.34),
            (0.25, 0.24),
            (0.33, 0.46),
            (0.39, 1.0),
            (0.43, 0.46),
            (0.49, 0.6),
            (0.55, 0.42),
            (0.61, 0.58),
            (0.68, 0.34),
            (0.76, 0.46),
            (0.86, 0.2),
            (1.0, 0.02),
        ],
        // Minimal: forehead, nose, one lip, chin — for the smallest wings,
        // where finer features would alias into wiggles.
        _ => vec![
            (0.0, 0.05),
            (0.14, 0.3),
            (0.26, 0.24),
            (0.36, 0.52),
            (0.43, 1.0),
            (0.48, 0.46),
            (0.56, 0.62),
            (0.64, 0.34),
            (0.75, 0.48),
            (0.86, 0.18),
            (1.0, 0.04),
        ],
    }
}

// ---------------------------------------------------------------------------
// Curtains
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub enum Attach {
    Left,
    Right,
    Top,
    Bottom,
}

pub struct Curtain {
    pub attach: Attach,
    /// (s, reach) controls: how far the free edge reaches from the attach
    /// wall, in world units, along the span.
    pub controls: Vec<(f32, f32)>,
    /// World range along the span axis (y top→bottom for Left/Right,
    /// x left→right for Top/Bottom).
    pub span: (f32, f32),
    /// Front face z; the slab extends `thickness` behind it.
    pub z: f32,
    pub thickness: f32,
}

/// A curtain is a thick cutout slab: a front face whose gradient bands hug
/// the free edge (offset columns, denser near the edge), plus a shaded rim
/// along the cut. The attach side melts into its wall.
fn build_curtain(
    gpu: &Gpu,
    renderer: &Renderer,
    label: &str,
    c: &Curtain,
    stops: &[(f32, [f32; 3])],
    seed: u32,
) -> Arc<ModelAsset> {
    const SAMPLES: usize = 160;
    const COLS: usize = 14;
    let img = paint::chrome_ramp(512, 64, stops, seed);
    let mut m = MeshBuf::default();

    let point = |s: f32, reach: f32| -> Vec2 {
        let a = c.span.0 + (c.span.1 - c.span.0) * s;
        match c.attach {
            Attach::Left => Vec2::new(-BOX + reach, a),
            Attach::Right => Vec2::new(BOX - reach, a),
            Attach::Top => Vec2::new(a, BOX - reach),
            Attach::Bottom => Vec2::new(a, -BOX + reach),
        }
    };

    // Sample the reach curve, then relax it a little — the spline is C1
    // but tight feature clusters can still micro-overshoot, and airbrush
    // art has no corners anywhere.
    let mut reach: Vec<f32> = (0..=SAMPLES)
        .map(|k| spline(&c.controls, k as f32 / SAMPLES as f32))
        .collect();
    for _ in 0..2 {
        let prev = reach.clone();
        for k in 1..SAMPLES {
            reach[k] = prev[k - 1] * 0.25 + prev[k] * 0.5 + prev[k + 1] * 0.25;
        }
    }
    let edge: Vec<(f32, Vec2)> = reach
        .iter()
        .enumerate()
        .map(|(k, &r)| {
            let s = k as f32 / SAMPLES as f32;
            (s, point(s, r))
        })
        .collect();
    let span_len = (c.span.1 - c.span.0).abs();

    // Front face: columns lerp edge → wall, packed toward the edge so the
    // first bands run parallel to the silhouette.
    let col_pos = |k: usize, s: f32, f: f32| -> Vec2 {
        let e = edge[k].1;
        let w = point(s, 0.0);
        e + (w - e) * f
    };
    for j in 0..COLS {
        let f0 = (j as f32 / COLS as f32).powf(0.55);
        let f1 = ((j + 1) as f32 / COLS as f32).powf(0.55);
        for k in 0..SAMPLES {
            let (s0, s1) = (edge[k].0, edge[k + 1].0);
            let a = col_pos(k, s0, f0).extend(c.z);
            let b = col_pos(k, s0, f1).extend(c.z);
            let d = col_pos(k + 1, s1, f0).extend(c.z);
            let e2 = col_pos(k + 1, s1, f1).extend(c.z);
            let (v0, v1) = (s0 * span_len / 44.0, s1 * span_len / 44.0);
            m.quad(
                [a, b, e2, d],
                [[f0, v0], [f1, v0], [f1, v1], [f0, v1]],
                Vec3::Z,
            );
        }
    }

    // Rim along the free edge: bright lip at the front, falling into the
    // ramp's first shadow at the back of the cut.
    for k in 0..SAMPLES {
        let (s0, p0) = edge[k];
        let (s1, p1) = edge[k + 1];
        let (v0, v1) = (s0 * span_len / 44.0, s1 * span_len / 44.0);
        m.quad_ds(
            [
                p0.extend(c.z),
                p1.extend(c.z),
                p1.extend(c.z - c.thickness),
                p0.extend(c.z - c.thickness),
            ],
            [[0.005, v0], [0.005, v1], [0.12, v1], [0.12, v0]],
        );
    }

    m.build(gpu, renderer, label, Some(&img))
}

// ---------------------------------------------------------------------------
// The set
// ---------------------------------------------------------------------------

/// Build the whole diorama into `scene.models`. Instances are static; all
/// motion in the widget is camera, sprites and beams.
pub fn build(gpu: &Gpu, renderer: &Renderer, scene: &mut Scene) {
    // --- frame -----------------------------------------------------------
    {
        let img = paint::frame_face(64, 256, 11);
        let mut m = MeshBuf::default();
        let ring = [
            // top band, bottom band, left band, right band
            [
                Vec3::new(-OUTER, OPEN, 0.0),
                Vec3::new(OUTER, OPEN, 0.0),
                Vec3::new(OUTER, OUTER, 0.0),
                Vec3::new(-OUTER, OUTER, 0.0),
            ],
            [
                Vec3::new(-OUTER, -OUTER, 0.0),
                Vec3::new(OUTER, -OUTER, 0.0),
                Vec3::new(OUTER, -OPEN, 0.0),
                Vec3::new(-OUTER, -OPEN, 0.0),
            ],
            [
                Vec3::new(-OUTER, -OPEN, 0.0),
                Vec3::new(-OPEN, -OPEN, 0.0),
                Vec3::new(-OPEN, OPEN, 0.0),
                Vec3::new(-OUTER, OPEN, 0.0),
            ],
            [
                Vec3::new(OPEN, -OPEN, 0.0),
                Vec3::new(OUTER, -OPEN, 0.0),
                Vec3::new(OUTER, OPEN, 0.0),
                Vec3::new(OPEN, OPEN, 0.0),
            ],
        ];
        for p in ring {
            let uv = [[0.2, 0.1], [0.8, 0.1], [0.8, 0.9], [0.2, 0.9]];
            m.quad(p, uv, Vec3::Z);
        }
        // Outer edge slab so the frame reads as a body from an angle.
        let rims: [([Vec3; 2], Vec3); 4] = [
            (
                [Vec3::new(-OUTER, OUTER, 0.0), Vec3::new(OUTER, OUTER, 0.0)],
                Vec3::Y,
            ),
            (
                [
                    Vec3::new(OUTER, -OUTER, 0.0),
                    Vec3::new(-OUTER, -OUTER, 0.0),
                ],
                -Vec3::Y,
            ),
            (
                [
                    Vec3::new(-OUTER, -OUTER, 0.0),
                    Vec3::new(-OUTER, OUTER, 0.0),
                ],
                -Vec3::X,
            ),
            (
                [Vec3::new(OUTER, OUTER, 0.0), Vec3::new(OUTER, -OUTER, 0.0)],
                Vec3::X,
            ),
        ];
        for ([a, b], n) in rims {
            let (a2, b2) = (a - Vec3::Z * 5.0, b - Vec3::Z * 5.0);
            m.quad(
                [a, b, b2, a2],
                [[0.3, 0.85], [0.7, 0.85], [0.7, 0.98], [0.3, 0.98]],
                n,
            );
        }
        // Exterior shell: the box itself, so orbiting shows a cream tunnel
        // book from the side instead of a view through culled backfaces.
        let shell: [([Vec3; 4], Vec3); 5] = [
            (
                [
                    Vec3::new(-OUTER, OUTER, 0.0),
                    Vec3::new(OUTER, OUTER, 0.0),
                    Vec3::new(OUTER, OUTER, BACK_Z - 2.0),
                    Vec3::new(-OUTER, OUTER, BACK_Z - 2.0),
                ],
                Vec3::Y,
            ),
            (
                [
                    Vec3::new(-OUTER, -OUTER, 0.0),
                    Vec3::new(OUTER, -OUTER, 0.0),
                    Vec3::new(OUTER, -OUTER, BACK_Z - 2.0),
                    Vec3::new(-OUTER, -OUTER, BACK_Z - 2.0),
                ],
                -Vec3::Y,
            ),
            (
                [
                    Vec3::new(-OUTER, -OUTER, 0.0),
                    Vec3::new(-OUTER, OUTER, 0.0),
                    Vec3::new(-OUTER, OUTER, BACK_Z - 2.0),
                    Vec3::new(-OUTER, -OUTER, BACK_Z - 2.0),
                ],
                -Vec3::X,
            ),
            (
                [
                    Vec3::new(OUTER, -OUTER, 0.0),
                    Vec3::new(OUTER, OUTER, 0.0),
                    Vec3::new(OUTER, OUTER, BACK_Z - 2.0),
                    Vec3::new(OUTER, -OUTER, BACK_Z - 2.0),
                ],
                Vec3::X,
            ),
            (
                [
                    Vec3::new(-OUTER, -OUTER, BACK_Z - 2.0),
                    Vec3::new(OUTER, -OUTER, BACK_Z - 2.0),
                    Vec3::new(OUTER, OUTER, BACK_Z - 2.0),
                    Vec3::new(-OUTER, OUTER, BACK_Z - 2.0),
                ],
                -Vec3::Z,
            ),
        ];
        for (p, n) in shell {
            m.quad(p, [[0.3, 0.2], [0.7, 0.2], [0.7, 0.8], [0.3, 0.8]], n);
        }
        let asset = m.build(gpu, renderer, "frame", Some(&img));
        push_unlit(scene, asset, Mat4::IDENTITY);
    }

    // --- bevel (the lit blue reveal, opening 42 splaying to 44) ----------
    {
        let img = paint::bevel_ramp(256, 64, 12);
        let mut m = MeshBuf::default();
        // Mat bevel: the opening closes 44 → 42 going back, so every band
        // tilts toward the viewer (hint +Z resolves all four windings).
        let splay: [[Vec3; 4]; 4] = [
            [
                Vec3::new(-OPEN, OPEN, 0.0),
                Vec3::new(OPEN, OPEN, 0.0),
                Vec3::new(BOX, BOX, BEVEL_Z),
                Vec3::new(-BOX, BOX, BEVEL_Z),
            ],
            [
                Vec3::new(-OPEN, -OPEN, 0.0),
                Vec3::new(OPEN, -OPEN, 0.0),
                Vec3::new(BOX, -BOX, BEVEL_Z),
                Vec3::new(-BOX, -BOX, BEVEL_Z),
            ],
            [
                Vec3::new(-OPEN, -OPEN, 0.0),
                Vec3::new(-OPEN, OPEN, 0.0),
                Vec3::new(-BOX, BOX, BEVEL_Z),
                Vec3::new(-BOX, -BOX, BEVEL_Z),
            ],
            [
                Vec3::new(OPEN, -OPEN, 0.0),
                Vec3::new(OPEN, OPEN, 0.0),
                Vec3::new(BOX, BOX, BEVEL_Z),
                Vec3::new(BOX, -BOX, BEVEL_Z),
            ],
        ];
        for p in splay {
            m.quad(p, [[0.0, 0.1], [0.0, 0.9], [1.0, 0.9], [1.0, 0.1]], Vec3::Z);
        }
        let asset = m.build(gpu, renderer, "bevel", Some(&img));
        push_unlit(scene, asset, Mat4::IDENTITY);
    }

    // --- interior walls --------------------------------------------------
    let wall = |gpu: &Gpu,
                renderer: &Renderer,
                scene: &mut Scene,
                label: &str,
                img: Img,
                p: [Vec3; 4],
                uv: [[f32; 2]; 4],
                hint: Vec3| {
        let mut m = MeshBuf::default();
        m.quad(p, uv, hint);
        let asset = m.build(gpu, renderer, label, Some(&img));
        push_unlit(scene, asset, Mat4::IDENTITY);
    };

    let d0 = BEVEL_Z;
    // Ceiling: stripes recede with depth.
    wall(
        gpu,
        renderer,
        scene,
        "ceiling",
        paint::ceiling_stripes(512, 128, 21),
        [
            Vec3::new(-BOX, BOX, d0),
            Vec3::new(BOX, BOX, d0),
            Vec3::new(BOX, BOX, BACK_Z),
            Vec3::new(-BOX, BOX, BACK_Z),
        ],
        [[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]],
        -Vec3::Y,
    );
    // Floor: fog gradient into the glow.
    wall(
        gpu,
        renderer,
        scene,
        "floor",
        paint::fog_floor(512, 128, 22),
        [
            Vec3::new(-BOX, -BOX, d0),
            Vec3::new(BOX, -BOX, d0),
            Vec3::new(BOX, -BOX, BACK_Z),
            Vec3::new(-BOX, -BOX, BACK_Z),
        ],
        [[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]],
        Vec3::Y,
    );
    // Left wall: the dark room with the ember grid.
    wall(
        gpu,
        renderer,
        scene,
        "left wall",
        paint::grid_wall(512, 256, 23),
        [
            Vec3::new(-BOX, BOX, d0),
            Vec3::new(-BOX, -BOX, d0),
            Vec3::new(-BOX, -BOX, BACK_Z),
            Vec3::new(-BOX, BOX, BACK_Z),
        ],
        [[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]],
        Vec3::X,
    );
    // Right wall: the pixel city.
    wall(
        gpu,
        renderer,
        scene,
        "right wall",
        paint::block_wall(512, 256, 24),
        [
            Vec3::new(BOX, BOX, d0),
            Vec3::new(BOX, -BOX, d0),
            Vec3::new(BOX, -BOX, BACK_Z),
            Vec3::new(BOX, BOX, BACK_Z),
        ],
        [[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]],
        -Vec3::X,
    );
    // Back wall: the glow.
    let cx = (STAR.x + BOX) / (2.0 * BOX);
    let cy = (BOX - STAR.y) / (2.0 * BOX);
    wall(
        gpu,
        renderer,
        scene,
        "back wall",
        paint::glow_wall(256, 256, cx, cy, 25),
        [
            Vec3::new(-BOX, BOX, BACK_Z),
            Vec3::new(BOX, BOX, BACK_Z),
            Vec3::new(BOX, -BOX, BACK_Z),
            Vec3::new(-BOX, -BOX, BACK_Z),
        ],
        [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]],
        Vec3::Z,
    );

    // --- the cast: curtains front to back --------------------------------
    // Reach = base + profile × amp: `base` sets how far the whole wing
    // stands from its wall, `amp` how far features breathe beyond that.
    // Each deeper wing reaches further toward the center than the one in
    // front of it, so they interleave like theater flats and the aperture
    // narrows to the star.
    let face = |variant: u32, base: f32, amp: f32, lift: f32| -> Vec<(f32, f32)> {
        face_controls(variant)
            .into_iter()
            .map(|(t, o)| ((t * 0.84 + lift).clamp(0.0, 1.0), base + o * amp))
            .collect()
    };

    let curtains: [(&str, Curtain, paint::Ramp, u32); 7] = [
        (
            "valance",
            Curtain {
                attach: Attach::Top,
                controls: vec![
                    (0.0, 28.0),
                    (0.18, 14.0),
                    (0.4, 23.0),
                    (0.6, 9.0),
                    (0.8, 17.0),
                    (1.0, 7.0),
                ],
                span: (-BOX, BOX),
                z: -16.0,
                thickness: 7.0,
            },
            paint::ramp_valance(),
            31,
        ),
        (
            "black profile",
            Curtain {
                attach: Attach::Left,
                controls: face(0, 14.0, 18.0, 0.10),
                span: (BOX, -BOX),
                z: -24.0,
                thickness: 7.0,
            },
            paint::ramp_black_profile(),
            32,
        ),
        (
            "sage profile",
            Curtain {
                attach: Attach::Right,
                controls: face(0, 14.0, 18.0, 0.04),
                span: (BOX, -BOX),
                z: -40.0,
                thickness: 8.0,
            },
            paint::ramp_sage(),
            33,
        ),
        (
            "pink profile",
            Curtain {
                attach: Attach::Left,
                controls: face(2, 20.0, 16.0, 0.16),
                span: (BOX, -BOX),
                z: -58.0,
                thickness: 7.0,
            },
            paint::ramp_pink(),
            34,
        ),
        (
            "teal profile",
            Curtain {
                attach: Attach::Right,
                controls: face(3, 20.0, 15.0, 0.22),
                span: (BOX, -BOX),
                z: -74.0,
                thickness: 6.0,
            },
            paint::ramp_teal(),
            35,
        ),
        (
            "fold left",
            Curtain {
                attach: Attach::Left,
                controls: vec![
                    (0.0, 36.0),
                    (0.14, 42.0),
                    (0.3, 37.0),
                    (0.45, 43.0),
                    (0.6, 38.0),
                    (0.74, 44.0),
                    (0.88, 38.0),
                    (1.0, 41.0),
                ],
                span: (BOX, -BOX),
                z: -90.0,
                thickness: 5.0,
            },
            paint::ramp_lavender(),
            36,
        ),
        (
            "fold right",
            Curtain {
                attach: Attach::Right,
                controls: vec![
                    (0.0, 38.0),
                    (0.16, 44.0),
                    (0.32, 38.0),
                    (0.5, 45.0),
                    (0.66, 39.0),
                    (0.82, 45.0),
                    (1.0, 40.0),
                ],
                span: (BOX, -BOX),
                z: -102.0,
                thickness: 5.0,
            },
            paint::ramp_warm_fold(),
            37,
        ),
    ];
    for (label, c, stops, seed) in &curtains {
        let asset = build_curtain(gpu, renderer, label, c, stops, *seed);
        push_unlit(scene, asset, Mat4::IDENTITY);
    }

    // --- the dunes -------------------------------------------------------
    let dunes = [
        (
            "dune",
            Curtain {
                attach: Attach::Bottom,
                controls: vec![
                    (0.0, 0.0),
                    (0.22, 13.0),
                    (0.4, 8.0),
                    (0.62, 26.0),
                    (0.8, 17.0),
                    (1.0, 22.0),
                ],
                span: (-8.0, BOX),
                z: -34.0,
                thickness: 10.0,
            },
            42u32,
        ),
        (
            "dune far",
            Curtain {
                attach: Attach::Bottom,
                controls: vec![(0.0, 0.0), (0.4, 18.0), (0.75, 10.0), (1.0, 14.0)],
                span: (2.0, BOX),
                z: -52.0,
                thickness: 8.0,
            },
            43,
        ),
    ];
    for (label, c, seed) in &dunes {
        let asset = build_curtain(gpu, renderer, label, c, &paint::ramp_dune(), *seed);
        push_unlit(scene, asset, Mat4::IDENTITY);
    }

    // --- the purple cube in the dark room --------------------------------
    {
        let img = paint::cube_faces(64, 96, 51);
        let mut m = MeshBuf::default();
        let s = 5.5;
        let f = |band: f32| -> [[f32; 2]; 4] {
            let v0 = band / 3.0 + 0.04;
            let v1 = (band + 1.0) / 3.0 - 0.04;
            [[0.1, v0], [0.9, v0], [0.9, v1], [0.1, v1]]
        };
        let c = [
            Vec3::new(-s, -s, -s),
            Vec3::new(s, -s, -s),
            Vec3::new(s, s, -s),
            Vec3::new(-s, s, -s),
            Vec3::new(-s, -s, s),
            Vec3::new(s, -s, s),
            Vec3::new(s, s, s),
            Vec3::new(-s, s, s),
        ];
        m.quad([c[7], c[6], c[2], c[3]], f(0.0), Vec3::Y); // top
        m.quad([c[4], c[5], c[6], c[7]], f(1.0), Vec3::Z); // front
        m.quad([c[5], c[1], c[2], c[6]], f(2.0), Vec3::X); // right
        m.quad([c[0], c[4], c[7], c[3]], f(2.0), -Vec3::X); // left
        let asset = m.build(gpu, renderer, "cube", Some(&img));
        push_unlit(
            scene,
            asset,
            Mat4::from_translation(Vec3::new(-25.0, -37.5, -50.0)) * Mat4::from_rotation_y(0.6),
        );
    }

    // --- the eye under the fog, out front --------------------------------
    {
        let img = paint::iris(128, 61);
        let mut m = MeshBuf::default();
        let r = 5.8;
        let center = Vec3::new(-14.0, -57.5, 6.0);
        m.quad_ds(
            [
                center + Vec3::new(-r, -r, 0.0),
                center + Vec3::new(r, -r, 0.0),
                center + Vec3::new(r, r, 0.0),
                center + Vec3::new(-r, r, 0.0),
            ],
            [[0.0, 1.0], [1.0, 1.0], [1.0, 0.0], [0.0, 0.0]],
        );
        let asset = m.build(gpu, renderer, "iris", Some(&img));
        push_unlit(scene, asset, Mat4::IDENTITY);
    }
    {
        // The lids: chrome waves — the upper one droops over the iris, the
        // lower one cradles it. u runs top→bottom of each band so the
        // bright lip lands on the lash line.
        let img = paint::chrome_ramp(256, 64, &paint::ramp_lid(), 62);
        let mut m = MeshBuf::default();
        const N: usize = 48;
        let (x0, x1) = (-34.0f32, 6.0f32);
        let upper_top = -48.0f32;
        let upper = |t: f32| -> f32 {
            -52.0 - 1.6 * (t * std::f32::consts::PI).sin() - 1.3 * t
                + 0.6 * (t * std::f32::consts::TAU * 1.7).sin()
        };
        let lower_bot = -65.5f32;
        let lower = |t: f32| -> f32 {
            -62.5 + 1.4 * (t * std::f32::consts::PI).sin() + 0.6 * t
                - 0.5 * (t * std::f32::consts::TAU * 1.3 + 0.8).sin()
        };
        for k in 0..N {
            let (t0, t1) = (k as f32 / N as f32, (k + 1) as f32 / N as f32);
            let (xa, xb) = (x0 + (x1 - x0) * t0, x0 + (x1 - x0) * t1);
            let z = 8.0;
            // Upper lid: band + under-rim.
            m.quad_ds(
                [
                    Vec3::new(xa, upper_top, z),
                    Vec3::new(xb, upper_top, z),
                    Vec3::new(xb, upper(t1), z),
                    Vec3::new(xa, upper(t0), z),
                ],
                [
                    [0.85, t0 * 1.4],
                    [0.85, t1 * 1.4],
                    [0.02, t1 * 1.4],
                    [0.02, t0 * 1.4],
                ],
            );
            m.quad_ds(
                [
                    Vec3::new(xa, upper(t0), z),
                    Vec3::new(xb, upper(t1), z),
                    Vec3::new(xb, upper(t1), z - 2.5),
                    Vec3::new(xa, upper(t0), z - 2.5),
                ],
                [[0.02, t0], [0.02, t1], [0.25, t1], [0.25, t0]],
            );
            // Lower lid.
            m.quad_ds(
                [
                    Vec3::new(xa, lower(t0), z),
                    Vec3::new(xb, lower(t1), z),
                    Vec3::new(xb, lower_bot, z),
                    Vec3::new(xa, lower_bot, z),
                ],
                [
                    [0.02, t0 * 1.4],
                    [0.02, t1 * 1.4],
                    [0.6, t1 * 1.4],
                    [0.6, t0 * 1.4],
                ],
            );
        }
        let asset = m.build(gpu, renderer, "lids", Some(&img));
        push_unlit(scene, asset, Mat4::IDENTITY);
    }
}
