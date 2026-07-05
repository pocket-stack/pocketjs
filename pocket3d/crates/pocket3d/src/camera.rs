//! First-person camera. Right-handed, +Y up; yaw 0 looks down -Z.

use glam::{Mat4, Vec3};

#[derive(Clone, Copy, Debug)]
pub struct Camera {
    pub pos: Vec3,
    /// Radians around +Y. 0 = -Z, positive turns left (CCW seen from above).
    pub yaw: f32,
    /// Radians. Positive looks up. Clamped by callers to about +-89 deg.
    pub pitch: f32,
    pub fov_y: f32,
    pub znear: f32,
    pub zfar: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            pos: Vec3::ZERO,
            yaw: 0.0,
            pitch: 0.0,
            fov_y: 70f32.to_radians(),
            znear: 1.0,
            zfar: 16384.0,
        }
    }
}

impl Camera {
    pub fn forward(&self) -> Vec3 {
        let (sy, cy) = self.yaw.sin_cos();
        let (sp, cp) = self.pitch.sin_cos();
        Vec3::new(-sy * cp, sp, -cy * cp)
    }

    /// Horizontal forward (ignores pitch), normalized.
    pub fn forward_flat(&self) -> Vec3 {
        let (sy, cy) = self.yaw.sin_cos();
        Vec3::new(-sy, 0.0, -cy)
    }

    pub fn right(&self) -> Vec3 {
        let (sy, cy) = self.yaw.sin_cos();
        Vec3::new(cy, 0.0, -sy)
    }

    pub fn view(&self) -> Mat4 {
        glam::camera::rh::view::look_to_mat4(self.pos, self.forward(), Vec3::Y)
    }

    pub fn proj(&self, aspect: f32) -> Mat4 {
        // DirectX-style 0..1 clip depth, matching wgpu.
        glam::camera::rh::proj::directx::perspective(self.fov_y, aspect, self.znear, self.zfar)
    }

    pub fn view_proj(&self, aspect: f32) -> Mat4 {
        self.proj(aspect) * self.view()
    }

    /// Point the camera at a world position.
    pub fn look_at(&mut self, target: Vec3) {
        let d = target - self.pos;
        let flat = (d.x * d.x + d.z * d.z).sqrt();
        self.yaw = (-d.x).atan2(-d.z);
        self.pitch = d.y.atan2(flat);
    }
}
