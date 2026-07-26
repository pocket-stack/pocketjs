//! First-person camera shared with the other cooked-world backends.

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
            aspect: 640.0 / 360.0,
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

    /// GLES consumes the OpenGL -w..w clip-depth convention.
    pub fn proj(&self) -> Mat4 {
        glam::camera::rh::proj::opengl::perspective(
            self.fov_y,
            self.aspect.max(f32::EPSILON),
            self.znear,
            self.zfar,
        )
    }

    pub fn view_proj(&self) -> Mat4 {
        self.proj() * self.view()
    }

    pub fn frustum(&self) -> Frustum {
        Frustum::from_clip(self.view_proj(), false)
    }

    /// Match projection aspect to a live framebuffer. Zero-sized transient
    /// resize events leave the previous aspect untouched and return false.
    pub fn set_viewport(&mut self, width: u32, height: u32) -> bool {
        if width == 0 || height == 0 {
            return false;
        }
        self.aspect = width as f32 / height as f32;
        true
    }

    pub fn with_viewport(mut self, width: u32, height: u32) -> Self {
        let _ = self.set_viewport(width, height);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn viewport_updates_projection_aspect() {
        let mut camera = Camera3d::default();
        assert!(camera.set_viewport(360, 640));
        assert!((camera.aspect - 360.0 / 640.0).abs() < f32::EPSILON);
        assert!(!camera.set_viewport(0, 640));
        assert!((camera.aspect - 360.0 / 640.0).abs() < f32::EPSILON);
    }

    #[test]
    fn default_axes_match_other_pocket3d_backends() {
        let camera = Camera3d::default();
        assert_eq!(camera.forward(), Vec3::NEG_Z);
        assert_eq!(camera.forward_flat(), Vec3::NEG_Z);
        assert_eq!(camera.right(), Vec3::X);
    }
}
