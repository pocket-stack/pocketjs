//! Dynamic untextured meshes (actors, effects, and first-person models).

use glam::Mat4;

use crate::pool::FramePool;

/// Vertex-colored mesh vertex (`color: u32 ABGR`, position in world units).
/// The layout doubles as the GPU stream format for staged dynamic draws.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ColorVert {
    pub color: u32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

fn stage(out: &mut Vec<ColorVert>, vertices: &[ColorVert], model: Mat4) {
    out.reserve(vertices.len());
    for vertex in vertices {
        let position = model.transform_point3(glam::Vec3::new(vertex.x, vertex.y, vertex.z));
        out.push(ColorVert {
            color: vertex.color,
            x: position.x,
            y: position.y,
            z: position.z,
        });
    }
}

/// Queue an opaque, depth-tested triangle list with a model transform.
/// After [`clear_depth_for_viewmodel`], triangles land on the overlay layer
/// instead (drawn last, unconditionally, painter-sorted among themselves).
///
/// # Safety
///
/// A `pocket3d_vita` pass must be active, and `pool` must be the same stable
/// allocation used by every other draw in that pass.
pub unsafe fn draw_color_tris(pool: &mut FramePool, vertices: &[ColorVert], model: Mat4) {
    let (_, layer) = crate::activate_pool(pool);
    let target = if layer > 0 {
        &mut pool.viewmodel
    } else {
        &mut pool.opaque
    };
    stage(target, vertices, model);
}

/// Queue a translucent, depth-tested triangle list that leaves the depth
/// buffer untouched (tracers, muzzle flashes, impact sprites).
///
/// # Safety
///
/// Same contract as [`draw_color_tris`].
pub unsafe fn draw_blend_tris(pool: &mut FramePool, vertices: &[ColorVert], model: Mat4) {
    let (_, layer) = crate::activate_pool(pool);
    let target = if layer > 0 {
        &mut pool.viewmodel
    } else {
        &mut pool.blended
    };
    stage(target, vertices, model);
}

/// Queue an additive, depth-tested triangle list that leaves the depth buffer
/// untouched (muzzle flashes, tracers and impact sprites).
///
/// # Safety
///
/// Same contract as [`draw_color_tris`].
pub unsafe fn draw_additive_tris(pool: &mut FramePool, vertices: &[ColorVert], model: Mat4) {
    let (_, layer) = crate::activate_pool(pool);
    let target = if layer > 0 {
        &mut pool.viewmodel
    } else {
        &mut pool.additive
    };
    stage(target, vertices, model);
}

/// Move subsequent dynamic draws onto the overlay layer so the first-person
/// model cannot be occluded by world/actor triangles, mirroring the PSP
/// depth-clear contract.
///
/// # Safety
///
/// A `pocket3d_vita` pass must be active on the current render thread.
pub unsafe fn clear_depth_for_viewmodel() {
    crate::advance_layer();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_applies_the_model_transform() {
        let mut out = Vec::new();
        stage(
            &mut out,
            &[ColorVert {
                color: 0xff00_00ff,
                x: 1.0,
                y: 2.0,
                z: 3.0,
            }],
            Mat4::from_translation(glam::Vec3::new(10.0, 0.0, -10.0)),
        );
        assert_eq!(
            out,
            [ColorVert {
                color: 0xff00_00ff,
                x: 11.0,
                y: 2.0,
                z: -7.0,
            }]
        );
    }

    #[test]
    fn additive_draws_use_the_non_writing_queue() {
        let mut pool = FramePool::new();
        let vertices = [ColorVert {
            color: 0x80ff_ffff,
            x: 1.0,
            y: 2.0,
            z: 3.0,
        }; 3];
        unsafe {
            crate::begin_3d(&crate::Camera3d::default());
            draw_additive_tris(&mut pool, &vertices, Mat4::IDENTITY);
        }
        assert_eq!(pool.additive, vertices);
        assert!(pool.opaque.is_empty());
        unsafe { crate::end_3d() };
        assert_eq!(pool.last.additive_triangles, 1);
    }
}
