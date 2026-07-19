//! Scene pass: night-navigation backdrop, streamed city tiles, and the
//! route ribbon. Everything here is untextured vertex color — texturing is
//! disabled once for the whole 3D pass (`pass_begin`) instead of per draw.

use core::ffi::c_void;

use glam::{Mat4, Vec3};
use pocket3d_gu::{to_psp_matrix, Camera3d, FramePool};
use psp::sys::{self, ClearBuffer, GuPrimitive, GuState, VertexType};

use crate::car::{route_sample, wrap_s};
use crate::stream::Streamer;

// ---- palette ----------------------------------------------------------

pub const GROUND: [f32; 3] = [0.055, 0.068, 0.10];
pub const HAZE: [f32; 3] = [0.165, 0.205, 0.30];
pub const SKY_TOP: [f32; 3] = [0.03, 0.04, 0.085];
pub const ROUTE_BLUE: [f32; 3] = [0.28, 0.62, 1.0];

/// Fog range in units (0.25 m each): geometry fades into the haze band.
pub const FOG_NEAR: f32 = 1100.0;
pub const FOG_FAR: f32 = 2500.0;
/// Tiles farther than this (center distance) are skipped entirely.
pub const FAR_CULL: f32 = 2750.0;

pub fn pack(c: [f32; 3]) -> u32 {
    let r = (c[0].clamp(0.0, 1.0) * 255.0) as u32;
    let g = (c[1].clamp(0.0, 1.0) * 255.0) as u32;
    let b = (c[2].clamp(0.0, 1.0) * 255.0) as u32;
    0xff00_0000 | (b << 16) | (g << 8) | r
}

fn mix(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

// ---- vertex layouts ---------------------------------------------------

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Vert2d {
    color: u32,
    x: i16,
    y: i16,
    z: i16,
    _pad: i16,
}

const VTYPE_2D: VertexType = VertexType::from_bits_truncate(
    VertexType::COLOR_8888.bits() | VertexType::VERTEX_16BIT.bits() | VertexType::TRANSFORM_2D.bits(),
);

/// Tile geometry: the cooked 12-byte `{color, i16 xyz}` vertex, indexed.
const VTYPE_TILE: VertexType = VertexType::from_bits_truncate(
    VertexType::COLOR_8888.bits()
        | VertexType::VERTEX_16BIT.bits()
        | VertexType::INDEX_16BIT.bits()
        | VertexType::TRANSFORM_3D.bits(),
);
const VTYPE_LINE: VertexType = VertexType::from_bits_truncate(
    VertexType::COLOR_8888.bits() | VertexType::VERTEX_16BIT.bits() | VertexType::TRANSFORM_3D.bits(),
);

/// CPU-built float geometry (ribbon, cars).
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Vert32 {
    pub color: u32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

pub const VTYPE_32: VertexType = VertexType::from_bits_truncate(
    VertexType::COLOR_8888.bits() | VertexType::VERTEX_32BITF.bits() | VertexType::TRANSFORM_3D.bits(),
);

// ---- pass state -------------------------------------------------------

/// After `begin_3d`: untextured pass, fog configured. Fog stays enabled for
/// all world-space draws and is disabled again in `pass_end`.
pub unsafe fn pass_begin() {
    sys::sceGuDisable(GuState::Texture2D);
    sys::sceGuFog(FOG_NEAR, FOG_FAR, pack(HAZE));
    sys::sceGuEnable(GuState::Fog);
}

pub unsafe fn pass_end() {
    sys::sceGuDisable(GuState::Fog);
    sys::sceGuEnable(GuState::Texture2D);
}

// ---- backdrop ---------------------------------------------------------

/// Clear, then fill the screen with the night gradient: sky down to a haze
/// band at the horizon row, ground shading darker toward the bottom. The
/// ground half is what reads as an infinite dark ground plane — zero
/// triangles of real geometry, and streamed tiles z-test over it.
pub unsafe fn backdrop(pool: &mut FramePool, cam: &Camera3d) {
    sys::sceGuClearColor(pack(GROUND));
    sys::sceGuClearDepth(0);
    sys::sceGuClear(ClearBuffer::COLOR_BUFFER_BIT | ClearBuffer::DEPTH_BUFFER_BIT);

    let half_fov_tan = libm::tanf(cam.fov_y * 0.5);
    let horizon = 136.0 * (1.0 + libm::tanf(cam.pitch) / half_fov_tan);
    let h = horizon.clamp(28.0, 244.0) as i16;

    // Sky gradient reaches the haze a little above the horizon so distant
    // fogged buildings melt into the band instead of silhouetting.
    let quads: [(i16, i16, [f32; 3], [f32; 3]); 3] = [
        (0, h - 22, SKY_TOP, mix(HAZE, SKY_TOP, 0.15)),
        (h - 22, h, mix(HAZE, SKY_TOP, 0.15), HAZE),
        (h, 272, mix(HAZE, GROUND, 0.35), GROUND),
    ];

    sys::sceGuDisable(GuState::DepthTest);
    sys::sceGuDisable(GuState::Fog);
    for (y0, y1, top, bottom) in quads {
        if y1 <= y0 {
            continue;
        }
        let (ct, cb) = (pack(top), pack(bottom));
        let strip = [
            Vert2d { color: ct, x: 0, y: y0, z: 0, _pad: 0 },
            Vert2d { color: ct, x: 480, y: y0, z: 0, _pad: 0 },
            Vert2d { color: cb, x: 0, y: y1, z: 0, _pad: 0 },
            Vert2d { color: cb, x: 480, y: y1, z: 0, _pad: 0 },
        ];
        let bytes = core::slice::from_raw_parts(
            strip.as_ptr() as *const u8,
            core::mem::size_of_val(&strip),
        );
        let data = pool.upload(bytes);
        sys::sceGuDrawArray(
            GuPrimitive::TriangleStrip,
            VTYPE_2D,
            4,
            core::ptr::null(),
            data as *const c_void,
        );
    }
    sys::sceGuEnable(GuState::Fog);
    sys::sceGuEnable(GuState::DepthTest);
}

// ---- tiles ------------------------------------------------------------

pub struct DrawStats {
    pub tiles: u32,
    pub tris: u32,
}

/// Draw every resident tile that survives distance + frustum culling.
/// A tile still rising is drawn with a squashed Y in its model matrix —
/// the streaming choreography.
pub unsafe fn draw_tiles(streamer: &Streamer, cam: &Camera3d, frame: u32) -> DrawStats {
    let frustum = cam.frustum();
    let ts = streamer.info.tile_size;
    let mut stats = DrawStats { tiles: 0, tris: 0 };

    for tz in 0..streamer.info.nz {
        for tx in 0..streamer.info.nx {
            let idx = tz * streamer.info.nx + tx;
            let Some((verts, indices, lines, rise)) = streamer.ready(idx, frame) else {
                continue;
            };
            let ox = streamer.info.origin_x + tx as f32 * ts;
            let oz = streamer.info.origin_z + tz as f32 * ts;
            let cx = ox + ts * 0.5 - cam.pos.x;
            let cz = oz + ts * 0.5 - cam.pos.z;
            if cx * cx + cz * cz > FAR_CULL * FAR_CULL {
                continue;
            }
            let d = streamer.dir(idx);
            let mins = Vec3::new(ox + d.min[0] as f32, d.min[1] as f32, oz + d.min[2] as f32);
            let maxs = Vec3::new(ox + d.max[0] as f32, d.max[1] as f32, oz + d.max[2] as f32);
            if !frustum.intersects_aabb(mins, maxs) {
                continue;
            }

            let model = Mat4::from_translation(Vec3::new(ox, 0.0, oz))
                * Mat4::from_scale(Vec3::new(32768.0, 32768.0 * rise, 32768.0));
            sys::sceGuSetMatrix(sys::MatrixMode::Model, &to_psp_matrix(model));

            if !indices.is_empty() {
                sys::sceGuDrawArray(
                    GuPrimitive::Triangles,
                    VTYPE_TILE,
                    (indices.len() / 2) as i32,
                    indices.as_ptr() as *const c_void,
                    verts.as_ptr() as *const c_void,
                );
                stats.tris += indices.len() as u32 / 6;
            }
            if !lines.is_empty() {
                sys::sceGuDrawArray(
                    GuPrimitive::Lines,
                    VTYPE_LINE,
                    (lines.len() / 12) as i32,
                    core::ptr::null(),
                    lines.as_ptr() as *const c_void,
                );
            }
            stats.tiles += 1;
        }
    }
    sys::sceGuSetMatrix(sys::MatrixMode::Model, &to_psp_matrix(Mat4::IDENTITY));
    stats
}

// ---- route ribbon -----------------------------------------------------

const RIBBON_BACK: f32 = 60.0; // units behind the car
const RIBBON_AHEAD: f32 = 1400.0; // units ahead
const RIBBON_HALF: f32 = 3.0;
const RIBBON_Y: f32 = 2.6;
const RIBBON_STEP: f32 = 40.0;

/// The Tesla-navigation blue path: a flat strip hugging the route from just
/// behind the car to a few hundred meters ahead, rebuilt each frame.
pub unsafe fn draw_ribbon(pool: &mut FramePool, streamer: &Streamer, car_s: f32, total: f32) {
    let color = pack(ROUTE_BLUE);
    let mut verts: [Vert32; 256] = [Vert32 { color, x: 0.0, y: 0.0, z: 0.0 }; 256];
    let mut n = 0usize;

    let steps = ((RIBBON_BACK + RIBBON_AHEAD) / RIBBON_STEP) as i32;
    let mut prev: Option<(f32, f32, f32, f32)> = None; // lx, lz, rx, rz
    for i in 0..=steps {
        let s = wrap_s(car_s - RIBBON_BACK + i as f32 * RIBBON_STEP, total);
        let (pos, tan) = route_sample(streamer, s);
        // Right of the tangent: (-tz, tx).
        let (rx, rz) = (-tan.1, tan.0);
        let l = (pos.0 + rx * RIBBON_HALF, pos.1 + rz * RIBBON_HALF);
        let r = (pos.0 - rx * RIBBON_HALF, pos.1 - rz * RIBBON_HALF);
        if let Some((plx, plz, prx, przz)) = prev {
            if n + 6 <= verts.len() {
                let quad = [
                    (plx, plz),
                    (prx, przz),
                    (l.0, l.1),
                    (prx, przz),
                    (r.0, r.1),
                    (l.0, l.1),
                ];
                for (x, z) in quad {
                    verts[n] = Vert32 { color, x, y: RIBBON_Y, z };
                    n += 1;
                }
            }
        }
        prev = Some((l.0, l.1, r.0, r.1));
    }
    if n == 0 {
        return;
    }
    let bytes = core::slice::from_raw_parts(verts.as_ptr() as *const u8, n * 16);
    let data = pool.upload(bytes);
    sys::sceGuDrawArray(
        GuPrimitive::Triangles,
        VTYPE_32,
        n as i32,
        core::ptr::null(),
        data as *const c_void,
    );
}
