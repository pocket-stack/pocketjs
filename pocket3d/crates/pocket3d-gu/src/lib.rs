#![no_std]

//! pocket3d-gu — the sceGu renderer backend for pocket3d on real PSP
//! hardware (and PPSSPP).
//!
//! Consumes the same plain data as the wgpu backend — cooked `.p3d` worlds
//! ([`pocket3d_bsp::cooked`]), PVS visibility ([`pocket3d_bsp::vis`]), and
//! simple dynamic meshes — and records GE commands into the display list the
//! caller owns. Like the 2D `ge` backend in the PocketJS PSP host, this crate
//! NEVER calls `sceGuStart`/`sceGuFinish`/`sceGuSync`/`sceGuSwapBuffers`:
//! the frame loop owns list lifecycle and present pacing.
//!
//! A game frame composes as:
//! ```text
//! sceGuStart
//!   gu::begin_3d(&camera)            // matrices, depth, texture state
//!   sky::draw(...)                   // clear + gradient backdrop
//!   world.draw(&mut pool, &camera)   // PVS + frustum-culled batches
//!   mesh::draw(...)                  // viewmodel / actors
//!   gu::end_3d()                     // hand a 2D-clean state to the HUD
//!   ge::render(ui, drawlist)         // PocketJS JSX HUD (pocketjs-psp)
//! sceGuFinish
//! ```

extern crate alloc;

pub mod camera;
pub mod mesh;
pub mod pool;
pub mod sky;
pub mod texture;
pub mod world;

use core::ffi::c_void;

use psp::sys::{
    self, DepthFunc, FrontFaceDirection, GuState, TextureColorComponent, TextureEffect,
    TextureFilter,
};

pub use camera::Camera3d;
pub use pool::FramePool;
pub use world::WorldRenderer;

/// Write a CPU-visible slice back to memory so the GE (which bypasses the
/// dcache) sees it. Call once at boot on embedded `.p3d` data, and after any
/// CPU write to memory the GE will read.
pub unsafe fn writeback(data: &[u8]) {
    sys::sceKernelDcacheWritebackRange(data.as_ptr() as *const c_void, data.len() as u32);
}

/// Convert a glam matrix to the GE's column-major float matrix.
#[inline]
pub fn to_psp_matrix(m: glam::Mat4) -> sys::ScePspFMatrix4 {
    // Both are column-major [x_axis, y_axis, z_axis, w_axis] of vec4.
    unsafe { core::mem::transmute::<[f32; 16], sys::ScePspFMatrix4>(m.to_cols_array()) }
}

/// Enter the 3D pass: projection/view from the camera, identity model,
/// inverted 16-bit depth (GE convention: near = 65535), modulate texturing
/// with bilinear + nearest-mip filtering, no blending, no face culling
/// (GoldSrc world winding is mixed; matches the wgpu backend).
pub unsafe fn begin_3d(cam: &Camera3d) {
    sys::sceGuSetMatrix(sys::MatrixMode::Projection, &to_psp_matrix(cam.proj()));
    sys::sceGuSetMatrix(sys::MatrixMode::View, &to_psp_matrix(cam.view()));
    sys::sceGuSetMatrix(sys::MatrixMode::Model, &to_psp_matrix(glam::Mat4::IDENTITY));

    sys::sceGuDepthRange(65535, 0);
    sys::sceGuDepthFunc(DepthFunc::GreaterOrEqual);
    sys::sceGuEnable(GuState::DepthTest);
    sys::sceGuEnable(GuState::ClipPlanes);
    sys::sceGuDisable(GuState::Blend);
    sys::sceGuDisable(GuState::CullFace);
    sys::sceGuFrontFace(FrontFaceDirection::Clockwise);

    sys::sceGuEnable(GuState::Texture2D);
    sys::sceGuTexFunc(TextureEffect::Modulate, TextureColorComponent::Rgba);
    sys::sceGuTexFilter(TextureFilter::LinearMipmapNearest, TextureFilter::Linear);
    sys::sceGuTexWrap(sys::GuTexWrapMode::Repeat, sys::GuTexWrapMode::Repeat);
    // Negative LOD bias: hold mip 0 roughly one distance ring longer. The
    // GE has no anisotropic filtering, so unbiased auto-LOD blurs floors at
    // glancing angles well before texel density demands it; -1.0 trades a
    // little far-field shimmer for visibly crisper near geometry at 480x272.
    sys::sceGuTexLevelMode(sys::TextureLevelMode::Auto, -1.0);
    sys::sceGuTexScale(1.0, 1.0);
    sys::sceGuTexOffset(0.0, 0.0);
}

/// Leave the 3D pass with state the 2D DrawList backend expects: depth and
/// texturing off (the HUD re-enables per batch), no stray alpha test.
pub unsafe fn end_3d() {
    sys::sceGuDisable(GuState::DepthTest);
    sys::sceGuDisable(GuState::ClipPlanes);
    sys::sceGuDisable(GuState::AlphaTest);
    sys::sceGuDisable(GuState::Texture2D);
    sys::sceGuTexFilter(TextureFilter::Nearest, TextureFilter::Nearest);
}
