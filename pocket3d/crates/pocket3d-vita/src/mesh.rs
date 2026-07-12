//! Dynamic untextured meshes (actors, effects, and first-person models).

use glam::Mat4;

use crate::pool::FramePool;

/// Vertex-colored mesh vertex (`color: u32 ABGR`, position in world units).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ColorVert {
    pub color: u32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

/// Queue an untextured triangle list with a model transform.
///
/// # Safety
///
/// A `pocket3d_vita` pass must be active, and `pool` must be the same stable
/// allocation used by every other draw in that pass.
pub unsafe fn draw_color_tris(pool: &mut FramePool, vertices: &[ColorVert], model: Mat4) {
    let (view_proj, layer) = crate::activate_pool(pool);
    let transform = view_proj * model;
    pool.reserve_triangles(vertices.len() / 3);
    for triangle in vertices.chunks_exact(3) {
        pool.queue_color_triangle(
            transform,
            [
                glam::Vec3::new(triangle[0].x, triangle[0].y, triangle[0].z),
                glam::Vec3::new(triangle[1].x, triangle[1].y, triangle[1].z),
                glam::Vec3::new(triangle[2].x, triangle[2].y, triangle[2].z),
            ],
            [triangle[0].color, triangle[1].color, triangle[2].color],
            layer,
        );
    }
}

/// Start a later painter layer so the first-person model cannot be occluded
/// by world/actor triangles, mirroring the PSP depth-clear contract.
///
/// # Safety
///
/// A `pocket3d_vita` pass must be active on the current render thread.
pub unsafe fn clear_depth_for_viewmodel() {
    crate::advance_layer();
}
