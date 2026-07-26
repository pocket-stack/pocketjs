//! First-person camera for the GE pipeline. Same conventions as the desktop
//! `pocket3d::Camera` (right-handed, +Y up, yaw 0 looks down -Z, positive
//! pitch looks up) — only the projection differs: the GE consumes GL-style
//! -1..1 clip depth, not wgpu's 0..1.

use glam::{Mat4, Vec3};
use pocket3d_bsp::vis::Frustum;

#[inline]
fn sin_cos(x: f32) -> (f32, f32) {
    libm::sincosf(x)
}

#[derive(Clone, Copy, Debug)]
pub struct Camera3d {
    pub pos: Vec3,
    /// Radians around +Y. 0 = -Z, positive turns left (CCW seen from above).
    pub yaw: f32,
    /// Radians. Positive looks up. Clamp to about +-89 deg.
    pub pitch: f32,
    pub fov_y: f32,
    pub aspect: f32,
    pub znear: f32,
    pub zfar: f32,
}

impl Default for Camera3d {
    fn default() -> Self {
        Self {
            pos: Vec3::ZERO,
            yaw: 0.0,
            pitch: 0.0,
            fov_y: 70f32.to_radians(),
            aspect: 480.0 / 272.0,
            // GoldSrc scale; zfar trimmed to map scale for 16-bit depth.
            znear: 4.0,
            zfar: 8192.0,
        }
    }
}

impl Camera3d {
    pub fn forward(&self) -> Vec3 {
        let (sy, cy) = sin_cos(self.yaw);
        let (sp, cp) = sin_cos(self.pitch);
        Vec3::new(-sy * cp, sp, -cy * cp)
    }

    /// Horizontal forward (ignores pitch), normalized.
    pub fn forward_flat(&self) -> Vec3 {
        let (sy, cy) = sin_cos(self.yaw);
        Vec3::new(-sy, 0.0, -cy)
    }

    pub fn right(&self) -> Vec3 {
        let (sy, cy) = sin_cos(self.yaw);
        Vec3::new(cy, 0.0, -sy)
    }

    pub fn view(&self) -> Mat4 {
        glam::camera::rh::view::look_to_mat4(self.pos, self.forward(), Vec3::Y)
    }

    pub fn proj(&self) -> Mat4 {
        // GL-style -1..1 clip depth: what the GE consumes.
        glam::camera::rh::proj::opengl::perspective(self.fov_y, self.aspect, self.znear, self.zfar)
    }

    pub fn frustum(&self) -> Frustum {
        Frustum::from_clip(self.proj() * self.view(), false)
    }
}
