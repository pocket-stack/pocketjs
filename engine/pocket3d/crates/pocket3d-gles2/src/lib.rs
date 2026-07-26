#![no_std]

//! `pocket3d-gles2` — the constrained OpenGL ES 2 Pocket3D backend.
//!
//! The crate consumes the existing borrowed [`pocket3d_bsp::cooked::CookedMap`]
//! representation. It keeps immutable world geometry in one VBO/IBO pair,
//! uploads one palette-expanded texture at a time, and submits PVS/frustum
//! culled index runs with depth testing. `{` textures use an alpha-discard
//! fragment program while retaining depth writes.
//!
//! The caller owns the EGL context, color/depth surface and buffer swap. All
//! GPU methods are therefore `unsafe` and render-thread-only. On ordinary
//! host targets the CPU planning and texture conversion API remains usable;
//! GPU entry points return [`RenderError::UnsupportedHost`] without touching
//! or requiring a GL implementation.

extern crate alloc;

#[cfg(test)]
extern crate std;

// The Symbian allocator used by the native host supports alignments up to 8.
// Cargo feature unification applies `glam/scalar-math` to pocket3d-bsp too.
const _: () = assert!(core::mem::align_of::<glam::Mat4>() <= 8);
const _: () = assert!(core::mem::align_of::<glam::Vec3>() <= 8);

pub mod camera;
#[cfg(target_os = "none")]
mod gl;
pub mod mesh;
pub mod texture;
pub mod world;

pub use camera::Camera3d;
pub use mesh::{BlendMode, ColorVertex, DynamicCounters, DynamicRenderer};
pub use texture::{expand_level0_rgba, TextureDecodeError};
pub use world::{FrameOptions, RenderError, TextureUpload, Viewport, WorldCounters, WorldRenderer};
