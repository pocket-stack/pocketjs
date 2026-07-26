//! Sky backdrop: clears color+depth, then draws a screen-space vertical
//! gradient whose endpoint colors follow the camera pitch — a per-vertex
//! approximation of the desktop `fs_sky` (zenith/horizon mix over the view
//! ray's elevation). Runs before the world with depth untouched, so world
//! geometry z-tests over it and sky brush faces (skipped at cook) read as
//! open sky.

use glam::Vec3;
use psp::sys::{self, ClearBuffer, GuPrimitive, GuState, VertexType};

use crate::camera::Camera3d;
use crate::pool::FramePool;

#[derive(Clone, Copy, Debug)]
pub struct SkyParams {
    pub zenith: Vec3,
    pub horizon: Vec3,
}

impl Default for SkyParams {
    fn default() -> Self {
        // Dust-flavored defaults, matching pocket3d::scene::Sky.
        Self {
            zenith: Vec3::new(0.34, 0.48, 0.66),
            horizon: Vec3::new(0.93, 0.79, 0.62),
        }
    }
}

#[repr(C)]
struct SkyVert {
    color: u32,
    x: i16,
    y: i16,
    z: i16,
    _pad: i16,
}

const SKY_VTYPE: VertexType = VertexType::from_bits_truncate(
    VertexType::COLOR_8888.bits()
        | VertexType::VERTEX_16BIT.bits()
        | VertexType::TRANSFORM_2D.bits(),
);

fn pack(c: Vec3) -> u32 {
    let r = (c.x.clamp(0.0, 1.0) * 255.0) as u32;
    let g = (c.y.clamp(0.0, 1.0) * 255.0) as u32;
    let b = (c.z.clamp(0.0, 1.0) * 255.0) as u32;
    0xff00_0000 | (b << 16) | (g << 8) | r
}

/// Sample the zenith/horizon gradient at a view-ray elevation (radians).
fn sample(params: &SkyParams, elev: f32) -> Vec3 {
    // Desktop fs_sky mixes on ray.y with a soft knee near the horizon.
    let t = libm::sinf(elev).clamp(0.0, 1.0);
    let t = libm::powf(t, 0.65);
    params.horizon + (params.zenith - params.horizon) * t
}

/// Clear and draw the gradient backdrop for this camera.
pub unsafe fn draw(pool: &mut FramePool, cam: &Camera3d, params: &SkyParams) {
    sys::sceGuClearColor(pack(params.horizon));
    sys::sceGuClearDepth(0);
    sys::sceGuClear(ClearBuffer::COLOR_BUFFER_BIT | ClearBuffer::DEPTH_BUFFER_BIT);

    let top = pack(sample(params, cam.pitch + cam.fov_y * 0.5));
    let bottom = pack(sample(params, cam.pitch - cam.fov_y * 0.5));

    let quad = [
        SkyVert {
            color: top,
            x: 0,
            y: 0,
            z: 0,
            _pad: 0,
        },
        SkyVert {
            color: top,
            x: 480,
            y: 0,
            z: 0,
            _pad: 0,
        },
        SkyVert {
            color: bottom,
            x: 0,
            y: 272,
            z: 0,
            _pad: 0,
        },
        SkyVert {
            color: bottom,
            x: 480,
            y: 272,
            z: 0,
            _pad: 0,
        },
    ];
    let bytes =
        core::slice::from_raw_parts(quad.as_ptr() as *const u8, core::mem::size_of_val(&quad));
    let verts = pool.upload(bytes);

    // Backdrop: no depth interaction, no texture. Restores the world pass
    // state from begin_3d before returning.
    sys::sceGuDisable(GuState::DepthTest);
    sys::sceGuDisable(GuState::Texture2D);
    sys::sceGuDrawArray(
        GuPrimitive::TriangleStrip,
        SKY_VTYPE,
        4,
        core::ptr::null(),
        verts as *const core::ffi::c_void,
    );
    sys::sceGuEnable(GuState::DepthTest);
    sys::sceGuEnable(GuState::Texture2D);
}
