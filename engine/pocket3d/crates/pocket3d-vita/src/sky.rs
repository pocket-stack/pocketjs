//! Fullscreen Vita-resolution sky gradient.

use glam::Vec3;

use crate::camera::Camera3d;
use crate::pool::FramePool;
use crate::{SCREEN_HEIGHT, SCREEN_WIDTH};

#[derive(Clone, Copy, Debug)]
pub struct SkyParams {
    pub zenith: Vec3,
    pub horizon: Vec3,
}

impl Default for SkyParams {
    fn default() -> Self {
        Self {
            zenith: Vec3::new(0.34, 0.48, 0.66),
            horizon: Vec3::new(0.93, 0.79, 0.62),
        }
    }
}

fn pack(color: Vec3) -> u32 {
    let red = (color.x.clamp(0.0, 1.0) * 255.0) as u32;
    let green = (color.y.clamp(0.0, 1.0) * 255.0) as u32;
    let blue = (color.z.clamp(0.0, 1.0) * 255.0) as u32;
    0xff00_0000 | (blue << 16) | (green << 8) | red
}

fn sample(parameters: &SkyParams, elevation: f32) -> Vec3 {
    let amount = libm::powf(libm::sinf(elevation).clamp(0.0, 1.0), 0.65);
    parameters.horizon + (parameters.zenith - parameters.horizon) * amount
}

/// Queue a backdrop covering every pixel of the 960x544 physical framebuffer.
///
/// # Safety
///
/// A `pocket3d_vita` pass must be active, and `pool` must remain at a stable
/// address until `pocket3d_vita::end_3d` flushes it.
pub unsafe fn draw(pool: &mut FramePool, camera: &Camera3d, parameters: &SkyParams) {
    crate::activate_pool(pool);
    let top = pack(sample(parameters, camera.pitch + camera.fov_y * 0.5));
    let bottom = pack(sample(parameters, camera.pitch - camera.fov_y * 0.5));
    let top_left = [0.0, 0.0];
    let top_right = [SCREEN_WIDTH, 0.0];
    let bottom_left = [0.0, SCREEN_HEIGHT];
    let bottom_right = [SCREEN_WIDTH, SCREEN_HEIGHT];
    pool.queue_backdrop_triangle([top_left, top_right, bottom_left], [top, top, bottom]);
    pool.queue_backdrop_triangle(
        [top_right, bottom_right, bottom_left],
        [top, bottom, bottom],
    );
}
