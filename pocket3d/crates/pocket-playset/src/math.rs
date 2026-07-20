//! The shared math foundation: the world basis and scalar helpers, ported
//! from playset/modules/math/{world-basis,scalar-utils}.ts.
//!
//! DELIBERATE NARROWING: the TS WorldBasis is configurable (any axis/sign
//! assignment); every playset game — and every GameBlocks demo — uses
//! DEFAULT_WORLD_BASIS, so the native core hard-codes it:
//!
//! ```text
//! right = +X    up = +Y    forward = -Z
//! ```
//!
//! so `right(v) = v.x`, `up(v) = v.y`, `forward(v) = -v.z`, and
//! `from_basis(r, u, f) = vec3(r, u, -f)`. Games that need a different basis
//! stay on the TS path (which remains the reference implementation).
//!
//! PRECISION: everything is f32 — the PSP FPU is single-precision, and f64
//! there is soft-float (~50x slower). f32 IEEE-754 add/sub/mul/div/sqrt are
//! bit-exact across hosts, so desktop and PSP still agree bit for bit; only
//! the transcendentals (sin/cos/tan/exp/atan2/powf) route through `libm` on
//! both sides — never the platform libm — for the same reason.

#![allow(clippy::excessive_precision)]

use glam::{Quat, Vec3};

/// Planar epsilon, the f32 analogue of the TS VECTOR_EPS.
pub const EPS: f32 = 1e-6;

// ---------------------------------------------------------------------------
// float shims — ALWAYS libm, never std, so both hosts get identical results
// ---------------------------------------------------------------------------

pub mod fmath {
    #[inline]
    pub fn sin(x: f32) -> f32 {
        libm::sinf(x)
    }
    #[inline]
    pub fn cos(x: f32) -> f32 {
        libm::cosf(x)
    }
    #[inline]
    pub fn tan(x: f32) -> f32 {
        libm::tanf(x)
    }
    #[inline]
    pub fn atan2(y: f32, x: f32) -> f32 {
        libm::atan2f(y, x)
    }
    #[inline]
    pub fn exp(x: f32) -> f32 {
        libm::expf(x)
    }
    #[inline]
    pub fn powf(x: f32, y: f32) -> f32 {
        libm::powf(x, y)
    }
    #[inline]
    pub fn sqrt(x: f32) -> f32 {
        libm::sqrtf(x)
    }
    #[inline]
    pub fn floor(x: f32) -> f32 {
        libm::floorf(x)
    }
    #[inline]
    pub fn abs(x: f32) -> f32 {
        libm::fabsf(x)
    }
}

// ---------------------------------------------------------------------------
// scalar utils (playset/modules/math/scalar-utils.ts)
// ---------------------------------------------------------------------------

#[inline]
pub fn clamp(v: f32, lo: f32, hi: f32) -> f32 {
    // Math.max(min, Math.min(max, value)) — matches TS on inverted ranges.
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

#[inline]
pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

#[inline]
pub fn fract(v: f32) -> f32 {
    v - fmath::floor(v)
}

/// dt-stable exponential smoothing factor: `1 - e^(-dt/lag)`.
#[inline]
pub fn smoothing_alpha(lag: f32, dt: f32) -> f32 {
    let d = if dt > 0.0 { dt } else { 0.0 };
    if lag <= 0.0 {
        return 1.0;
    }
    1.0 - fmath::exp(-d / lag)
}

#[inline]
pub fn smooth_toward(current: f32, target: f32, lag: f32, dt: f32) -> f32 {
    current + (target - current) * smoothing_alpha(lag, dt)
}

// ---------------------------------------------------------------------------
// world basis (right = +X, up = +Y, forward = -Z)
// ---------------------------------------------------------------------------

#[inline]
pub fn right_of(v: Vec3) -> f32 {
    v.x
}
#[inline]
pub fn up_of(v: Vec3) -> f32 {
    v.y
}
#[inline]
pub fn forward_of(v: Vec3) -> f32 {
    -v.z
}

/// `WorldBasis.fromBasisComponents`.
#[inline]
pub fn from_basis(right: f32, up: f32, forward: f32) -> Vec3 {
    Vec3::new(right, up, -forward)
}

/// `WorldBasis.setHeight` — replaces the up component in place.
#[inline]
pub fn set_height(v: &mut Vec3, height: f32) {
    v.y = height;
}

pub const UP: Vec3 = Vec3::Y;

/// `WorldBasis.surfaceNormalFromSlopes`.
#[inline]
pub fn surface_normal_from_slopes(right_slope: f32, forward_slope: f32) -> Vec3 {
    normalize_or(from_basis(-right_slope, 1.0, -forward_slope), UP)
}

/// `WorldBasis.forwardToYaw`.
#[inline]
pub fn forward_to_yaw(forward: Vec3) -> f32 {
    let r = right_of(forward);
    let f = forward_of(forward);
    if r * r + f * f <= EPS {
        return 0.0;
    }
    fmath::atan2(-r, f)
}

/// Planar (right/forward) distance between two points.
#[inline]
pub fn planar_distance(a: Vec3, b: Vec3) -> f32 {
    let dr = right_of(a) - right_of(b);
    let df = forward_of(a) - forward_of(b);
    fmath::sqrt(dr * dr + df * df)
}

/// three.js `Vector3.normalize()` semantics: zero-length vectors stay zero.
/// (`fallback` is for the places the TS code relied on a defined direction.)
#[inline]
pub fn normalize_or(v: Vec3, fallback: Vec3) -> Vec3 {
    let len_sq = v.length_squared();
    if len_sq <= 0.0 {
        return fallback;
    }
    v / fmath::sqrt(len_sq)
}

/// three.js `Vector3.projectOnPlane(normal)`: `v - normal * (v · normal)`.
/// `normal` must already be unit length (every caller passes a basis axis).
#[inline]
pub fn project_on_plane(v: Vec3, normal: Vec3) -> Vec3 {
    v - normal * v.dot(normal)
}

/// An orthonormal body frame: the presentation currency of every motion
/// controller (`{right, up, forward}` — GameBlocks' pose frame).
#[derive(Clone, Copy, Debug)]
pub struct Frame {
    pub right: Vec3,
    pub up: Vec3,
    pub forward: Vec3,
}

impl Frame {
    pub const IDENTITY: Frame = Frame {
        right: Vec3::X,
        up: Vec3::Y,
        forward: Vec3::NEG_Z,
    };

    /// The quaternion that maps the canonical upright mesh axes
    /// (+X right, +Y up, -Z forward) onto this frame — what a visual node's
    /// pose needs. `Quat::from_mat3` of the basis columns.
    pub fn to_quat(self) -> Quat {
        let m = glam::Mat3::from_cols(self.right, self.up, -self.forward);
        Quat::from_mat3(&m).normalize()
    }
}

/// `WorldBasis.yawPitchRollFrame(yaw)` with pitch = roll = 0.
#[inline]
pub fn yaw_frame(yaw: f32) -> Frame {
    let (sin_yaw, cos_yaw) = (fmath::sin(yaw), fmath::cos(yaw));
    let forward = normalize_or(from_basis(-sin_yaw, 0.0, cos_yaw), Vec3::NEG_Z);
    let right = normalize_or(from_basis(cos_yaw, 0.0, sin_yaw), Vec3::X);
    let up = normalize_or(right.cross(forward), UP);
    Frame { right, up, forward }
}

/// `buildOrientationBasis(yaw, surfaceNormal)` — the yaw frame re-squared
/// against a surface normal (arcade-car-motion-controller.ts).
#[inline]
pub fn orientation_frame(yaw: f32, surface_normal: Vec3) -> Frame {
    let up = normalize_or(surface_normal, UP);
    let yawed = yaw_frame(yaw);
    let forward = normalize_or(project_on_plane(yawed.forward, up), yawed.forward);
    let right = normalize_or(forward.cross(up), yawed.right);
    let forward = normalize_or(up.cross(right), forward);
    Frame { right, up, forward }
}

/// Quaternion from an intrinsic XYZ Euler — the wheel-spin/steer mirrors
/// (three.js `Quaternion.setFromEuler`, default 'XYZ' order).
pub fn quat_from_euler_xyz(x: f32, y: f32, z: f32) -> Quat {
    let (s1, c1) = (fmath::sin(x * 0.5), fmath::cos(x * 0.5));
    let (s2, c2) = (fmath::sin(y * 0.5), fmath::cos(y * 0.5));
    let (s3, c3) = (fmath::sin(z * 0.5), fmath::cos(z * 0.5));
    Quat::from_xyzw(
        s1 * c2 * c3 + c1 * s2 * s3,
        c1 * s2 * c3 - s1 * c2 * s3,
        c1 * c2 * s3 + s1 * s2 * c3,
        c1 * c2 * c3 - s1 * s2 * s3,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basis_round_trips() {
        let v = from_basis(3.0, 5.0, 7.0);
        assert_eq!(v, Vec3::new(3.0, 5.0, -7.0));
        assert_eq!(right_of(v), 3.0);
        assert_eq!(up_of(v), 5.0);
        assert_eq!(forward_of(v), 7.0);
    }

    #[test]
    fn yaw_zero_faces_negative_z() {
        let f = yaw_frame(0.0);
        assert!((f.forward - Vec3::NEG_Z).length() < 1e-6);
        assert!((f.right - Vec3::X).length() < 1e-6);
        assert!((f.up - Vec3::Y).length() < 1e-6);
    }

    #[test]
    fn forward_to_yaw_inverts_yaw_frame() {
        for &yaw in &[0.0f32, 0.7, -1.2, 3.0] {
            let f = yaw_frame(yaw);
            assert!((forward_to_yaw(f.forward) - yaw).abs() < 1e-4);
        }
    }

    #[test]
    fn flat_ground_normal_is_up() {
        assert!((surface_normal_from_slopes(0.0, 0.0) - UP).length() < 1e-6);
    }

    #[test]
    fn smoothing_matches_closed_form() {
        let a = smoothing_alpha(0.16, 1.0 / 60.0);
        assert!((a - (1.0 - (-(1.0 / 60.0) / 0.16f32).exp())).abs() < 1e-6);
        assert_eq!(smoothing_alpha(0.0, 0.5), 1.0);
    }
}
