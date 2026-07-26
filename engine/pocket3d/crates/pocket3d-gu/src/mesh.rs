//! Dynamic meshes: viewmodels, actors, debris — anything built or posed on
//! the CPU per frame. Vertices go through the frame pool; the GE transforms
//! them with a per-draw model matrix.

use core::ffi::c_void;

use glam::Mat4;
use psp::sys::{self, GuPrimitive, GuState, VertexType};

use crate::pool::FramePool;
use crate::to_psp_matrix;

/// Untextured vertex-colored mesh vertex (`color: u32 ABGR`, `x,y,z: f32`).
#[repr(C)]
#[derive(Clone, Copy)]
pub struct ColorVert {
    pub color: u32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

const COLOR_VTYPE: VertexType = VertexType::from_bits_truncate(
    VertexType::COLOR_8888.bits()
        | VertexType::VERTEX_32BITF.bits()
        | VertexType::TRANSFORM_3D.bits(),
);

/// Draw an untextured triangle list with a model transform. Texturing state
/// is restored to enabled for the world/next binder.
pub unsafe fn draw_color_tris(pool: &mut FramePool, verts: &[ColorVert], model: Mat4) {
    if verts.is_empty() {
        return;
    }
    let bytes =
        core::slice::from_raw_parts(verts.as_ptr() as *const u8, core::mem::size_of_val(verts));
    let data = pool.upload(bytes);

    sys::sceGuSetMatrix(sys::MatrixMode::Model, &to_psp_matrix(model));
    sys::sceGuDisable(GuState::Texture2D);
    sys::sceGuDrawArray(
        GuPrimitive::Triangles,
        COLOR_VTYPE,
        verts.len() as i32,
        core::ptr::null(),
        data as *const c_void,
    );
    sys::sceGuEnable(GuState::Texture2D);
    sys::sceGuSetMatrix(sys::MatrixMode::Model, &to_psp_matrix(Mat4::IDENTITY));
}

/// Clear the depth buffer region-free (full clear) so a viewmodel drawn
/// afterwards never intersects world geometry — the GE equivalent of the
/// desktop renderer's depth-cleared viewmodel pass.
pub unsafe fn clear_depth_for_viewmodel() {
    sys::sceGuClearDepth(0);
    sys::sceGuClear(psp::sys::ClearBuffer::DEPTH_BUFFER_BIT);
}
