//! The rifle: procedural viewmodel, hitscan firing, effects.

use std::sync::Arc;

use pocket3d::model::{ModelAsset, ModelVertex};
use pocket3d::prelude::*;
use pocket3d::renderer::Renderer;

pub const FIRE_INTERVAL: f32 = 0.105; // ~570 rpm
pub const RELOAD_TIME: f32 = 2.4;
pub const MAG_SIZE: u32 = 30;
pub const DAMAGE_BODY: i32 = 34;
pub const DAMAGE_HEAD: i32 = 100;
pub const RANGE: f32 = 8192.0;

pub struct Weapon {
    pub ammo: u32,
    pub reserve: u32,
    pub cooldown: f32,
    pub reload_left: f32,
    /// 0..1 visual recoil, decays.
    pub recoil: f32,
}

impl Default for Weapon {
    fn default() -> Self {
        Self {
            ammo: MAG_SIZE,
            reserve: 90,
            cooldown: 0.0,
            reload_left: 0.0,
            recoil: 0.0,
        }
    }
}

impl Weapon {
    pub fn reloading(&self) -> bool {
        self.reload_left > 0.0
    }

    pub fn can_fire(&self) -> bool {
        self.cooldown <= 0.0 && self.ammo > 0 && !self.reloading()
    }

    pub fn tick(&mut self, dt: f32) {
        self.cooldown -= dt;
        self.recoil = (self.recoil - dt * 3.0).max(0.0);
        if self.reload_left > 0.0 {
            self.reload_left -= dt;
            if self.reload_left <= 0.0 {
                let want = MAG_SIZE - self.ammo;
                let take = want.min(self.reserve);
                self.ammo += take;
                self.reserve -= take;
            }
        }
    }

    pub fn trigger_reload(&mut self) {
        if !self.reloading() && self.ammo < MAG_SIZE && self.reserve > 0 {
            self.reload_left = RELOAD_TIME;
        }
    }

    /// Consume one round; returns false if empty.
    pub fn fire(&mut self) -> bool {
        if !self.can_fire() {
            return false;
        }
        self.ammo -= 1;
        self.cooldown = FIRE_INTERVAL;
        self.recoil = (self.recoil + 0.35).min(1.0);
        true
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

// ---------------------------------------------------------------------------
// Timed world-space effects (flashes, tracers, impacts)
// ---------------------------------------------------------------------------

pub enum EffectKind {
    MuzzleFlash { pos: Vec3 },
    Tracer { a: Vec3, b: Vec3 },
    Impact { pos: Vec3 },
    BloodPuff { pos: Vec3 },
}

pub struct Effect {
    pub kind: EffectKind,
    pub age: f32,
    pub ttl: f32,
}

#[derive(Default)]
pub struct Effects {
    pub list: Vec<Effect>,
}

impl Effects {
    pub fn spawn(&mut self, kind: EffectKind, ttl: f32) {
        self.list.push(Effect {
            kind,
            age: 0.0,
            ttl,
        });
    }

    pub fn tick(&mut self, dt: f32) {
        for e in &mut self.list {
            e.age += dt;
        }
        self.list.retain(|e| e.age < e.ttl);
    }

    pub fn clear(&mut self) {
        self.list.clear();
    }

    /// Emit sprites/beams for this frame.
    pub fn emit(&self, sprites: &mut Vec<Sprite>, beams: &mut Vec<Beam>) {
        for e in &self.list {
            let f = 1.0 - (e.age / e.ttl).clamp(0.0, 1.0);
            match e.kind {
                EffectKind::MuzzleFlash { pos } => sprites.push(Sprite {
                    pos,
                    size: 14.0 + 6.0 * f,
                    color: [1.0, 0.85, 0.4, 0.9 * f],
                }),
                EffectKind::Tracer { a, b } => beams.push(Beam {
                    a,
                    b,
                    width: 1.6,
                    color: [1.0, 0.9, 0.55, 0.7 * f],
                }),
                EffectKind::Impact { pos } => sprites.push(Sprite {
                    pos,
                    size: 6.0 + 6.0 * (1.0 - f),
                    color: [0.9, 0.8, 0.6, 0.8 * f],
                }),
                EffectKind::BloodPuff { pos } => sprites.push(Sprite {
                    pos,
                    size: 10.0 + 8.0 * (1.0 - f),
                    color: [0.75, 0.1, 0.05, 0.8 * f],
                }),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Procedural rifle viewmodel
// ---------------------------------------------------------------------------

/// Material palette (one texel per entry).
const GUN_COLORS: [[u8; 4]; 6] = [
    [38, 38, 42, 255],   // 0 receiver: gunmetal
    [22, 22, 24, 255],   // 1 barrel: near-black
    [82, 58, 38, 255],   // 2 wood furniture
    [55, 55, 60, 255],   // 3 magazine
    [30, 30, 33, 255],   // 4 grip/sights
    [140, 120, 90, 255], // 5 accent
];

fn add_box(
    verts: &mut Vec<ModelVertex>,
    indices: &mut Vec<u32>,
    min: Vec3,
    max: Vec3,
    color: usize,
) {
    let u = (color as f32 + 0.5) / GUN_COLORS.len() as f32;
    let uv = [u, 0.5];
    let corners = |x: f32, y: f32, z: f32| {
        Vec3::new(
            if x > 0.0 { max.x } else { min.x },
            if y > 0.0 { max.y } else { min.y },
            if z > 0.0 { max.z } else { min.z },
        )
    };
    // (normal, four corners CCW seen from outside)
    let faces: [(Vec3, [Vec3; 4]); 6] = [
        (
            Vec3::X,
            [
                corners(1.0, -1.0, 1.0),
                corners(1.0, -1.0, -1.0),
                corners(1.0, 1.0, -1.0),
                corners(1.0, 1.0, 1.0),
            ],
        ),
        (
            -Vec3::X,
            [
                corners(-1.0, -1.0, -1.0),
                corners(-1.0, -1.0, 1.0),
                corners(-1.0, 1.0, 1.0),
                corners(-1.0, 1.0, -1.0),
            ],
        ),
        (
            Vec3::Y,
            [
                corners(-1.0, 1.0, 1.0),
                corners(1.0, 1.0, 1.0),
                corners(1.0, 1.0, -1.0),
                corners(-1.0, 1.0, -1.0),
            ],
        ),
        (
            -Vec3::Y,
            [
                corners(-1.0, -1.0, -1.0),
                corners(1.0, -1.0, -1.0),
                corners(1.0, -1.0, 1.0),
                corners(-1.0, -1.0, 1.0),
            ],
        ),
        (
            Vec3::Z,
            [
                corners(-1.0, -1.0, 1.0),
                corners(1.0, -1.0, 1.0),
                corners(1.0, 1.0, 1.0),
                corners(-1.0, 1.0, 1.0),
            ],
        ),
        (
            -Vec3::Z,
            [
                corners(1.0, -1.0, -1.0),
                corners(-1.0, -1.0, -1.0),
                corners(-1.0, 1.0, -1.0),
                corners(1.0, 1.0, -1.0),
            ],
        ),
    ];
    for (n, quad) in faces {
        let base = verts.len() as u32;
        for p in quad {
            verts.push(ModelVertex {
                pos: p.to_array(),
                normal: n.to_array(),
                uv,
                joints: [0; 4],
                weights: [1.0, 0.0, 0.0, 0.0],
            });
        }
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
}

/// Where the muzzle sits in viewmodel-local space (gun points -Z).
pub const MUZZLE_LOCAL: Vec3 = Vec3::new(0.0, 0.6, -31.0);

pub fn build_rifle(gpu: &Gpu, renderer: &Renderer) -> Arc<ModelAsset> {
    let mut v = Vec::new();
    let mut i = Vec::new();
    // Receiver.
    add_box(
        &mut v,
        &mut i,
        Vec3::new(-1.3, -2.0, -16.0),
        Vec3::new(1.3, 1.6, 4.0),
        0,
    );
    // Barrel + muzzle.
    add_box(
        &mut v,
        &mut i,
        Vec3::new(-0.45, 0.1, -30.0),
        Vec3::new(0.45, 1.0, -16.0),
        1,
    );
    add_box(
        &mut v,
        &mut i,
        Vec3::new(-0.65, -0.05, -32.0),
        Vec3::new(0.65, 1.15, -30.0),
        4,
    );
    // Wood handguard under the barrel.
    add_box(
        &mut v,
        &mut i,
        Vec3::new(-0.95, -1.3, -26.0),
        Vec3::new(0.95, 0.1, -16.0),
        2,
    );
    // Magazine (slightly raked).
    add_box(
        &mut v,
        &mut i,
        Vec3::new(-0.95, -6.4, -10.5),
        Vec3::new(0.95, -2.0, -6.0),
        3,
    );
    // Pistol grip.
    add_box(
        &mut v,
        &mut i,
        Vec3::new(-0.85, -5.2, -1.2),
        Vec3::new(0.85, -2.0, 1.6),
        4,
    );
    // Stock.
    add_box(
        &mut v,
        &mut i,
        Vec3::new(-1.05, -2.4, 4.0),
        Vec3::new(1.05, 1.0, 12.5),
        2,
    );
    // Front sight + rear sight.
    add_box(
        &mut v,
        &mut i,
        Vec3::new(-0.18, 1.0, -29.4),
        Vec3::new(0.18, 2.2, -28.6),
        4,
    );
    add_box(
        &mut v,
        &mut i,
        Vec3::new(-0.5, 1.6, -6.0),
        Vec3::new(0.5, 2.3, -4.8),
        4,
    );
    // Carry-handle hint above receiver.
    add_box(
        &mut v,
        &mut i,
        Vec3::new(-0.4, 1.6, -4.0),
        Vec3::new(0.4, 2.0, 2.0),
        0,
    );

    let mut px = Vec::new();
    for c in GUN_COLORS {
        px.extend_from_slice(&c);
    }
    ModelAsset::from_geometry(
        gpu,
        &renderer.model_material_layout,
        &renderer.samplers,
        "rifle",
        &v,
        &i,
        Some((GUN_COLORS.len() as u32, 1, &px)),
    )
}

/// A tiny deterministic PRNG (xorshift) — reproducible headless runs.
#[derive(Clone)]
pub struct Rng(pub u64);

impl Rng {
    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        (x >> 32) as u32
    }

    /// Uniform in [0, 1).
    pub fn f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / (1 << 24) as f32
    }

    /// Uniform in [-1, 1).
    pub fn signed(&mut self) -> f32 {
        self.f32() * 2.0 - 1.0
    }

    pub fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + self.f32() * (hi - lo)
    }
}
