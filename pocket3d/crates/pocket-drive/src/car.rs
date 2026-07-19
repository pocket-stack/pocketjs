//! Cars: prebuilt box-art meshes (drawn in place from the heap — built
//! once, written back once, never mutated) and the route follower that
//! drives them along the baked street loop.

use alloc::vec::Vec;

use glam::{Mat4, Vec3};
use pocket3d_gu::to_psp_matrix;
use psp::sys::{self, GuPrimitive};

use crate::scene::{pack, Vert32, VTYPE_32};
use crate::stream::Streamer;

// ---- route sampling ---------------------------------------------------

/// Positive wrap of an arclength into [0, total) (`f32::rem_euclid` is
/// std-only).
pub fn wrap_s(s: f32, total: f32) -> f32 {
    let r = s % total;
    if r < 0.0 { r + total } else { r }
}

/// Position + unit tangent at arclength `s` (binary search over the baked
/// cumulative arclengths).
pub fn route_sample(streamer: &Streamer, s: f32) -> ((f32, f32), (f32, f32)) {
    let n = streamer.route_len();
    let (mut lo, mut hi) = (0usize, n - 1);
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        if streamer.route(mid).s <= s {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let a = streamer.route(lo);
    let b = streamer.route(hi);
    let seg = (b.s - a.s).max(1e-3);
    let t = ((s - a.s) / seg).clamp(0.0, 1.0);
    let (dx, dz) = (b.x - a.x, b.z - a.z);
    let len = libm::sqrtf(dx * dx + dz * dz).max(1e-3);
    ((a.x + dx * t, a.z + dz * t), (dx / len, dz / len))
}

/// Route speed-class factor at arclength `s`.
fn route_speed(streamer: &Streamer, s: f32) -> f32 {
    let n = streamer.route_len();
    let (mut lo, mut hi) = (0usize, n - 1);
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        if streamer.route(mid).s <= s {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    streamer.route(lo).speed.max(0.5)
}

// ---- follower ---------------------------------------------------------

pub struct Follower {
    pub s: f32,
    /// +1 drives the route forward, -1 backward (oncoming traffic).
    pub dir: f32,
    /// Lateral offset to the right of travel, units.
    pub lane: f32,
    pub base_speed: f32, // units/s
    v: f32,
}

impl Follower {
    pub fn new(s: f32, dir: f32, lane: f32, base_speed: f32) -> Self {
        Self { s, dir, lane, base_speed, v: 0.0 }
    }

    /// Advance one tick. `throttle` scales the target speed (boost/brake);
    /// corners are anticipated by comparing tangents a car-length ahead.
    pub fn update(&mut self, streamer: &Streamer, total: f32, throttle: f32, dt: f32) {
        let (_, t0) = route_sample(streamer, self.s);
        let ahead = wrap_s(self.s + self.dir * 140.0, total);
        let (_, t1) = route_sample(streamer, ahead);
        let dot = (t0.0 * t1.0 + t0.1 * t1.1).clamp(-1.0, 1.0);
        let ang = libm::acosf(dot);
        let corner = (1.0 - 1.35 * ang).clamp(0.30, 1.0);
        let class = route_speed(streamer, self.s);
        let target = self.base_speed * class * corner * throttle;
        self.v += (target - self.v) * 0.055;
        self.s = wrap_s(self.s + self.dir * self.v * dt, total);
    }

    /// World pose: position (with lane offset) and yaw facing travel.
    pub fn pose(&self, streamer: &Streamer) -> (Vec3, f32) {
        let (p, t) = route_sample(streamer, self.s);
        let (tx, tz) = (t.0 * self.dir, t.1 * self.dir);
        // Right of travel: (-tz, tx).
        let x = p.0 + -tz * self.lane;
        let z = p.1 + tx * self.lane;
        let yaw = libm::atan2f(-tx, -tz);
        (Vec3::new(x, 0.0, z), yaw)
    }

    pub fn speed(&self) -> f32 {
        self.v
    }
}

// ---- meshes -----------------------------------------------------------

const GLASS: [f32; 3] = [0.085, 0.105, 0.15];
const TIRE: [f32; 3] = [0.045, 0.05, 0.06];
const TAIL: [f32; 3] = [1.0, 0.16, 0.13];
const HEAD: [f32; 3] = [1.0, 0.94, 0.78];

pub const PLAYER_BODY: [f32; 3] = [0.90, 0.92, 0.95];
pub const TRAFFIC_BODIES: [[f32; 3]; 6] = [
    [0.44, 0.46, 0.50],
    [0.24, 0.26, 0.32],
    [0.48, 0.20, 0.19],
    [0.20, 0.30, 0.44],
    [0.58, 0.58, 0.60],
    [0.30, 0.26, 0.22],
];

fn shade(c: [f32; 3], k: f32) -> u32 {
    pack([c[0] * k, c[1] * k, c[2] * k])
}

/// Axis-aligned box as 12 triangles with per-face fake lighting.
fn push_box(v: &mut Vec<Vert32>, c: [f32; 3], lit: bool, center: [f32; 3], half: [f32; 3]) {
    let [cx, cy, cz] = center;
    let [hx, hy, hz] = half;
    let p = |sx: f32, sy: f32, sz: f32| (cx + sx * hx, cy + sy * hy, cz + sz * hz);
    // (corner signs per face, brightness)
    let faces: [([[f32; 3]; 4], f32); 6] = [
        ([[-1., 1., -1.], [1., 1., -1.], [1., 1., 1.], [-1., 1., 1.]], 1.0), // top
        ([[-1., -1., 1.], [1., -1., 1.], [1., -1., -1.], [-1., -1., -1.]], 0.38), // bottom
        ([[1., -1., -1.], [1., -1., 1.], [1., 1., 1.], [1., 1., -1.]], 0.72), // +x
        ([[-1., -1., 1.], [-1., -1., -1.], [-1., 1., -1.], [-1., 1., 1.]], 0.72), // -x
        ([[-1., -1., -1.], [1., -1., -1.], [1., 1., -1.], [-1., 1., -1.]], 0.62), // -z front
        ([[1., -1., 1.], [-1., -1., 1.], [-1., 1., 1.], [1., 1., 1.]], 0.58), // +z rear
    ];
    for (corners, bright) in faces {
        let color = if lit { shade(c, bright) } else { pack(c) };
        let q: [(f32, f32, f32); 4] =
            core::array::from_fn(|i| p(corners[i][0], corners[i][1], corners[i][2]));
        for &(a, b, cc) in &[(0usize, 1usize, 2usize), (0, 2, 3)] {
            for &i in &[a, b, cc] {
                v.push(Vert32 { color, x: q[i].0, y: q[i].1, z: q[i].2 });
            }
        }
    }
}

/// A ~4.6 m sedan in 0.25 m units, nose toward -Z (yaw-0 forward).
pub fn build_car(body: [f32; 3]) -> Vec<Vert32> {
    let mut v = Vec::new();
    push_box(&mut v, body, true, [0.0, 2.6, 0.2], [3.8, 1.8, 9.0]); // body
    push_box(&mut v, GLASS, true, [0.0, 5.3, 0.8], [3.3, 1.05, 4.6]); // cabin
    for &(x, z) in &[(-3.3, -5.4), (3.3, -5.4), (-3.3, 5.4), (3.3, 5.4)] {
        push_box(&mut v, TIRE, true, [x, 1.4, z], [0.7, 1.4, 1.4]);
    }
    push_box(&mut v, TAIL, false, [0.0, 3.9, 9.15], [3.0, 0.30, 0.15]); // light bar
    push_box(&mut v, HEAD, false, [-2.3, 3.4, -9.1], [1.0, 0.25, 0.15]);
    push_box(&mut v, HEAD, false, [2.3, 3.4, -9.1], [1.0, 0.25, 0.15]);
    v
}

/// Draw a prebuilt car mesh (heap-resident, already written back).
pub unsafe fn draw_car(mesh: &[Vert32], pos: Vec3, yaw: f32) {
    let model = Mat4::from_translation(pos) * Mat4::from_rotation_y(yaw);
    sys::sceGuSetMatrix(sys::MatrixMode::Model, &to_psp_matrix(model));
    sys::sceGuDrawArray(
        GuPrimitive::Triangles,
        VTYPE_32,
        mesh.len() as i32,
        core::ptr::null(),
        mesh.as_ptr() as *const core::ffi::c_void,
    );
    sys::sceGuSetMatrix(sys::MatrixMode::Model, &to_psp_matrix(Mat4::IDENTITY));
}
