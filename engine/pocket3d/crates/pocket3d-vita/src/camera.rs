//! First-person camera shared with the PSP and desktop Pocket3D backends.

use glam::{Mat4, Vec3};
use pocket3d_bsp::vis::Frustum;

#[inline]
fn sin_cos(value: f32) -> (f32, f32) {
    libm::sincosf(value)
}

#[derive(Clone, Copy, Debug)]
pub struct Camera3d {
    pub pos: Vec3,
    /// Radians around +Y. Zero looks down -Z.
    pub yaw: f32,
    /// Radians. Positive looks up.
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
            // Vita's 960x544 framebuffer has the PSP's exact aspect ratio.
            aspect: 960.0 / 544.0,
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

    /// OpenGL-style clip depth (-w..w), which the CPU clipper consumes.
    pub fn proj(&self) -> Mat4 {
        glam::camera::rh::proj::opengl::perspective(self.fov_y, self.aspect, self.znear, self.zfar)
    }

    pub fn view_proj(&self) -> Mat4 {
        self.proj() * self.view()
    }

    pub fn frustum(&self) -> Frustum {
        Frustum::from_clip(self.view_proj(), false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_camera_uses_vita_fullscreen_aspect() {
        let camera = Camera3d::default();
        assert!((camera.aspect - 960.0 / 544.0).abs() < f32::EPSILON);
        assert_eq!(camera.forward(), Vec3::NEG_Z);
        assert_eq!(camera.right(), Vec3::X);
    }
}
