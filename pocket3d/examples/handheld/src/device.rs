//! The PSP shell, authored procedurally.
//!
//! An original PSP-1000-silhouette handheld built from primitives at load
//! time — no committed binary asset, no ripped geometry (Sony's trade dress
//! is why WIDGET.md wants the shape "generic handheld, obviously
//! PSP-adjacent"). Every interactive part is its own `ModelAsset` +
//! `ModelInstance`, so a press animates by nudging the instance transform
//! and picking reuses the asset's AABB under that same transform.
//!
//! Units are millimeters, device centered at the origin, front face +Z,
//! +Y up. Real PSP-1000: 170 × 74 × 23 mm with a 480×272 screen.

use std::sync::Arc;

use glam::{Mat4, Vec2, Vec3};
use pocket3d::gpu::Gpu;
use pocket3d::model::{ModelAsset, ModelInstance, ModelVertex};
use pocket3d::renderer::Renderer;
use pocket3d::scene::Scene;
use pocket_widget::parts::{PartMap, PartShape, btn};

pub const BODY_W: f32 = 170.0;
pub const BODY_H: f32 = 74.0;
pub const BODY_D: f32 = 20.0;
/// PSP screen glass: 480×272 px at this physical width.
pub const SCREEN_W: f32 = 86.0;
pub const SCREEN_H: f32 = SCREEN_W * 272.0 / 480.0;
/// Screen center sits slightly above the device midline, like the original.
pub const SCREEN_CENTER: Vec3 = Vec3::new(0.0, 2.0, 10.3);
/// How far a pressed cap travels into the body.
pub const PRESS_TRAVEL: f32 = 1.8;
/// Maximum analog-nub slide from center.
pub const NUB_TRAVEL: f32 = 4.0;

const FACE_Z: f32 = BODY_D / 2.0; // 10.0

/// One built part: scene instance index + picking shape index share `name`.
pub struct DevicePart {
    pub name: &'static str,
    pub buttons: u32,
    /// Index into `Scene::models`.
    pub instance: usize,
    /// Rest transform (presses/nub slides offset from this).
    pub base: Mat4,
    /// Rest tint (hover highlights scale from this).
    pub tint: [f32; 4],
}

pub struct Device {
    pub parts: Vec<DevicePart>,
    pub map: PartMap,
}

/// Build every part into `scene.models` and the pick map. `screen_view` is
/// the embedded UI's render target; colors are instance tints over white
/// geometry so parts share the plain-material path.
pub fn build(gpu: &Gpu, renderer: &Renderer, scene: &mut Scene, screen_view: &wgpu::TextureView) -> Device {
    let layout = &renderer.model_material_layout;
    let samplers = &renderer.samplers;
    let mut parts = Vec::new();
    let mut map = PartMap::default();

    let body_grey = [0.062, 0.062, 0.072, 1.0];
    let cap_grey = [0.135, 0.135, 0.152, 1.0];

    let push = |scene: &mut Scene,
                    map: &mut PartMap,
                    parts: &mut Vec<DevicePart>,
                    name: &'static str,
                    buttons: u32,
                    asset: Arc<ModelAsset>,
                    at: Vec3,
                    tint: [f32; 4],
                    lit: f32,
                    pick_pad: Vec3| {
        let base = Mat4::from_translation(at);
        let mut inst = ModelInstance::new(asset.clone());
        inst.transform = base;
        inst.tint = tint;
        inst.lit = lit;
        let instance = scene.models.len();
        scene.models.push(inst);
        map.push(PartShape {
            name: name.into(),
            buttons,
            transform: base,
            aabb: (asset.aabb.0 - pick_pad, asset.aabb.1 + pick_pad),
        });
        parts.push(DevicePart {
            name,
            buttons,
            instance,
            base,
            tint,
        });
    };

    // --- body: rounded-rect slab, near-black matte ------------------------
    let body = {
        let (v, i) = rounded_slab(BODY_W, BODY_H, BODY_D, 30.0, 12);
        ModelAsset::from_geometry(gpu, layout, samplers, "hh body", &v, &i, None)
    };
    push(scene, &mut map, &mut parts, "body", 0, body, Vec3::ZERO, body_grey, 1.0, Vec3::ZERO);

    // --- screen bezel (glossy inset) + the live screen --------------------
    let bezel = {
        let (v, i) = quad(SCREEN_W + 18.0, SCREEN_H + 10.0);
        ModelAsset::from_geometry(gpu, layout, samplers, "hh bezel", &v, &i, None)
    };
    push(
        scene, &mut map, &mut parts,
        "bezel", 0, bezel,
        Vec3::new(0.0, SCREEN_CENTER.y, FACE_Z + 0.15),
        [0.045, 0.045, 0.055, 1.0], 1.0, Vec3::ZERO,
    );
    let screen = {
        let (v, i) = quad(SCREEN_W, SCREEN_H);
        ModelAsset::from_geometry_textured(
            gpu, layout, "hh screen", &v, &i, screen_view, &samplers.linear_clamp,
        )
    };
    // Unlit: the app's own pixels, full brightness. Pick pad thickens the
    // flat quad so the slab test is robust.
    push(
        scene, &mut map, &mut parts,
        "screen", 0, screen, SCREEN_CENTER,
        [1.0; 4], 0.0, Vec3::new(0.0, 0.0, 0.5),
    );

    // --- D-pad (left): four caps + a dead center hub ----------------------
    let dpad_center = Vec2::new(-62.0, 2.0);
    let cap = {
        let (v, i) = box_mesh(11.0, 11.0, 3.0);
        ModelAsset::from_geometry(gpu, layout, samplers, "hh dpad cap", &v, &i, None)
    };
    let dirs: [(&'static str, u32, Vec2); 4] = [
        ("dpad_up", btn::UP, Vec2::new(0.0, 12.0)),
        ("dpad_down", btn::DOWN, Vec2::new(0.0, -12.0)),
        ("dpad_left", btn::LEFT, Vec2::new(-12.0, 0.0)),
        ("dpad_right", btn::RIGHT, Vec2::new(12.0, 0.0)),
    ];
    for (name, bits, off) in dirs {
        push(
            scene, &mut map, &mut parts,
            name, bits, cap.clone(),
            Vec3::new(dpad_center.x + off.x, dpad_center.y + off.y, FACE_Z + 1.5),
            cap_grey, 1.0, Vec3::ZERO,
        );
    }
    let hub = {
        let (v, i) = box_mesh(11.0, 11.0, 2.4);
        ModelAsset::from_geometry(gpu, layout, samplers, "hh dpad hub", &v, &i, None)
    };
    push(
        scene, &mut map, &mut parts,
        "dpad_hub", 0, hub,
        Vec3::new(dpad_center.x, dpad_center.y, FACE_Z + 1.2),
        cap_grey, 1.0, Vec3::ZERO,
    );

    // --- face buttons (right): the four glyph hues ------------------------
    let face_center = Vec2::new(62.0, 2.0);
    let button = {
        let (v, i) = cylinder(5.5, 3.0, 24);
        ModelAsset::from_geometry(gpu, layout, samplers, "hh button", &v, &i, None)
    };
    let faces: [(&'static str, u32, Vec2, [f32; 4]); 4] = [
        ("btn_triangle", btn::TRIANGLE, Vec2::new(0.0, 12.0), [0.22, 0.38, 0.28, 1.0]),
        ("btn_circle", btn::CIRCLE, Vec2::new(12.0, 0.0), [0.42, 0.22, 0.26, 1.0]),
        ("btn_cross", btn::CROSS, Vec2::new(0.0, -12.0), [0.22, 0.30, 0.44, 1.0]),
        ("btn_square", btn::SQUARE, Vec2::new(-12.0, 0.0), [0.37, 0.26, 0.40, 1.0]),
    ];
    for (name, bits, off, tint) in faces {
        push(
            scene, &mut map, &mut parts,
            name, bits, button.clone(),
            Vec3::new(face_center.x + off.x, face_center.y + off.y, FACE_Z + 1.5),
            tint, 1.0, Vec3::ZERO,
        );
    }

    // --- analog nub (bottom-left) -----------------------------------------
    let nub = {
        let (v, i) = cylinder(7.0, 2.5, 24);
        ModelAsset::from_geometry(gpu, layout, samplers, "hh nub", &v, &i, None)
    };
    push(
        scene, &mut map, &mut parts,
        "nub", 0, nub,
        Vec3::new(-62.0, -25.0, FACE_Z + 1.25),
        [0.185, 0.185, 0.205, 1.0], 1.0,
        // Generous pad: the nub is grabbed, not clicked precisely.
        Vec3::new(2.0, 2.0, 0.5),
    );

    // --- start / select (bottom-right) ------------------------------------
    let pill = {
        let (v, i) = box_mesh(11.0, 4.5, 2.0);
        ModelAsset::from_geometry(gpu, layout, samplers, "hh pill", &v, &i, None)
    };
    push(
        scene, &mut map, &mut parts,
        "btn_select", btn::SELECT, pill.clone(),
        Vec3::new(50.0, -25.0, FACE_Z + 1.0),
        cap_grey, 1.0, Vec3::splat(1.0),
    );
    push(
        scene, &mut map, &mut parts,
        "btn_start", btn::START, pill,
        Vec3::new(66.0, -25.0, FACE_Z + 1.0),
        cap_grey, 1.0, Vec3::splat(1.0),
    );

    // --- shoulder triggers: mostly seated in the body, a lip proud of the
    // top edge and slightly proud of the face so front clicks land ----------
    let trigger = {
        let (v, i) = box_mesh(26.0, 6.0, 6.5);
        ModelAsset::from_geometry(gpu, layout, samplers, "hh trigger", &v, &i, None)
    };
    push(
        scene, &mut map, &mut parts,
        "trig_l", btn::LTRIGGER, trigger.clone(),
        Vec3::new(-66.0, BODY_H / 2.0 + 0.2, FACE_Z - 2.9),
        cap_grey, 1.0, Vec3::ZERO,
    );
    push(
        scene, &mut map, &mut parts,
        "trig_r", btn::RTRIGGER, trigger,
        Vec3::new(66.0, BODY_H / 2.0 + 0.2, FACE_Z - 2.9),
        cap_grey, 1.0, Vec3::ZERO,
    );

    Device { parts, map }
}

// ---------------------------------------------------------------------------
// procedural meshes
// ---------------------------------------------------------------------------

/// Emit one triangle wound to face `normal` (auto-orients, so builders never
/// fight the pipeline's back-face culling).
fn tri(
    verts: &mut Vec<ModelVertex>,
    indices: &mut Vec<u32>,
    normal: Vec3,
    a: Vec3,
    b: Vec3,
    c: Vec3,
    uv: [[f32; 2]; 3],
) {
    let (b, c, uv) = if (b - a).cross(c - a).dot(normal) >= 0.0 {
        (b, c, uv)
    } else {
        (c, b, [uv[0], uv[2], uv[1]])
    };
    let base = verts.len() as u32;
    for (p, uv) in [(a, uv[0]), (b, uv[1]), (c, uv[2])] {
        verts.push(ModelVertex {
            pos: p.to_array(),
            normal: normal.to_array(),
            uv,
            joints: [0; 4],
            weights: [1.0, 0.0, 0.0, 0.0],
        });
    }
    indices.extend([base, base + 1, base + 2]);
}

const NO_UV: [[f32; 2]; 3] = [[0.0, 0.0]; 3];

/// A front-facing quad (+Z normal) with full 0..1 UVs, v=0 at the top —
/// exactly how an offscreen UI texture reads.
fn quad(w: f32, h: f32) -> (Vec<ModelVertex>, Vec<u32>) {
    let (hw, hh) = (w / 2.0, h / 2.0);
    let (mut v, mut i) = (Vec::new(), Vec::new());
    let tl = Vec3::new(-hw, hh, 0.0);
    let tr = Vec3::new(hw, hh, 0.0);
    let br = Vec3::new(hw, -hh, 0.0);
    let bl = Vec3::new(-hw, -hh, 0.0);
    tri(&mut v, &mut i, Vec3::Z, tl, tr, br, [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]);
    tri(&mut v, &mut i, Vec3::Z, tl, br, bl, [[0.0, 0.0], [1.0, 1.0], [0.0, 1.0]]);
    (v, i)
}

/// Axis-aligned box centered at the origin.
fn box_mesh(w: f32, h: f32, depth: f32) -> (Vec<ModelVertex>, Vec<u32>) {
    let half = Vec3::new(w / 2.0, h / 2.0, depth / 2.0);
    let (mut verts, mut indices) = (Vec::new(), Vec::new());
    for axis in 0..3 {
        for side in [-1.0f32, 1.0] {
            let normal = {
                let mut n = Vec3::ZERO;
                n[axis] = side;
                n
            };
            let (u, w_axis) = ((axis + 1) % 3, (axis + 2) % 3);
            let corner = |su: f32, sw: f32| {
                let mut p = normal * half;
                p[u] = su * half[u];
                p[w_axis] = sw * half[w_axis];
                p
            };
            let (a, b, c, d) = (
                corner(-1.0, -1.0),
                corner(1.0, -1.0),
                corner(1.0, 1.0),
                corner(-1.0, 1.0),
            );
            tri(&mut verts, &mut indices, normal, a, b, c, NO_UV);
            tri(&mut verts, &mut indices, normal, a, c, d, NO_UV);
        }
    }
    (verts, indices)
}

/// Cylinder along Z, centered, with flat caps.
fn cylinder(r: f32, depth: f32, segments: usize) -> (Vec<ModelVertex>, Vec<u32>) {
    let hz = depth / 2.0;
    let (mut verts, mut indices) = (Vec::new(), Vec::new());
    let ring: Vec<Vec2> = (0..segments)
        .map(|s| {
            let a = s as f32 / segments as f32 * std::f32::consts::TAU;
            Vec2::new(a.cos(), a.sin()) * r
        })
        .collect();
    for s in 0..segments {
        let (p0, p1) = (ring[s], ring[(s + 1) % segments]);
        // Caps.
        tri(
            &mut verts, &mut indices, Vec3::Z,
            Vec3::new(0.0, 0.0, hz), p0.extend(hz), p1.extend(hz), NO_UV,
        );
        tri(
            &mut verts, &mut indices, Vec3::NEG_Z,
            Vec3::new(0.0, 0.0, -hz), p0.extend(-hz), p1.extend(-hz), NO_UV,
        );
        // Wall (flat-shaded per segment; reads as molded plastic).
        let n = ((p0 + p1) / 2.0).extend(0.0).normalize();
        tri(&mut verts, &mut indices, n, p0.extend(hz), p1.extend(hz), p1.extend(-hz), NO_UV);
        tri(&mut verts, &mut indices, n, p0.extend(hz), p1.extend(-hz), p0.extend(-hz), NO_UV);
    }
    (verts, indices)
}

/// Rounded-rectangle slab: the PSP body silhouette extruded front-to-back.
fn rounded_slab(
    w: f32,
    h: f32,
    depth: f32,
    radius: f32,
    corner_segments: usize,
) -> (Vec<ModelVertex>, Vec<u32>) {
    let hz = depth / 2.0;
    let r = radius.min(w / 2.0).min(h / 2.0);
    let (cx, cy) = (w / 2.0 - r, h / 2.0 - r);
    // CCW outline seen from the front: corner arc centers TR, TL, BL, BR.
    let corners = [
        (Vec2::new(cx, cy), 0.0f32),
        (Vec2::new(-cx, cy), 90.0),
        (Vec2::new(-cx, -cy), 180.0),
        (Vec2::new(cx, -cy), 270.0),
    ];
    let mut outline: Vec<Vec2> = Vec::new();
    for (center, start_deg) in corners {
        for s in 0..=corner_segments {
            let a = (start_deg + 90.0 * s as f32 / corner_segments as f32).to_radians();
            outline.push(center + Vec2::new(a.cos(), a.sin()) * r);
        }
    }
    let (mut verts, mut indices) = (Vec::new(), Vec::new());
    let n = outline.len();
    for s in 0..n {
        let (p0, p1) = (outline[s], outline[(s + 1) % n]);
        // Front + back caps as fans from the center.
        tri(
            &mut verts, &mut indices, Vec3::Z,
            Vec3::new(0.0, 0.0, hz), p0.extend(hz), p1.extend(hz), NO_UV,
        );
        tri(
            &mut verts, &mut indices, Vec3::NEG_Z,
            Vec3::new(0.0, 0.0, -hz), p0.extend(-hz), p1.extend(-hz), NO_UV,
        );
        // Side wall; outward normal of a CCW edge is (dy, -dx).
        let e = p1 - p0;
        let wall_n = Vec3::new(e.y, -e.x, 0.0).normalize_or_zero();
        tri(&mut verts, &mut indices, wall_n, p0.extend(hz), p1.extend(hz), p1.extend(-hz), NO_UV);
        tri(&mut verts, &mut indices, wall_n, p0.extend(hz), p1.extend(-hz), p0.extend(-hz), NO_UV);
    }
    (verts, indices)
}
