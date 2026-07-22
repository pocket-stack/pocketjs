//! Cooked-world rendering: PVS + frustum culling via `pocket3d_bsp::vis`,
//! then per-batch indexed draws over the `.p3d`'s in-place vertex data.

use alloc::vec::Vec;
use core::ffi::c_void;

use pocket3d_bsp::cooked::{CookedMap, VERTEX_STRIDE};
use pocket3d_bsp::types::SurfaceKind;
use pocket3d_bsp::vis::VisSet;
use psp::sys::{self, AlphaFunc, GuPrimitive, GuState, VertexType};

use crate::camera::Camera3d;
use crate::pool::FramePool;
use crate::texture;

/// World vertex flags: `u,v: f32`, `color: u32`, `x,y,z: i16` (matches
/// `cooked::VERTEX_STRIDE`), drawn indexed.
const WORLD_VTYPE: VertexType = VertexType::from_bits_truncate(
    VertexType::TEXTURE_32BITF.bits()
        | VertexType::COLOR_8888.bits()
        | VertexType::VERTEX_16BIT.bits()
        | VertexType::INDEX_16BIT.bits()
        | VertexType::TRANSFORM_3D.bits(),
);

pub struct WorldRenderer<'a> {
    map: CookedMap<'a>,
    vis: VisSet,
    /// Per-batch (index_base, index_count) runs gathered this frame.
    runs: Vec<Vec<(u32, u16)>>,
    /// Stats from the last `draw` (visible faces, triangles drawn).
    pub last_faces: u32,
    pub last_tris: u32,
}

impl<'a> WorldRenderer<'a> {
    pub fn new(map: CookedMap<'a>) -> Self {
        let mut runs = Vec::new();
        runs.resize_with(map.batches.len(), Vec::new);
        let vis = VisSet::new(map.faces.len());
        Self {
            map,
            vis,
            runs,
            last_faces: 0,
            last_tris: 0,
        }
    }

    pub fn map(&self) -> &CookedMap<'a> {
        &self.map
    }

    /// Record the world into the open display list. The camera position
    /// drives PVS (use the eye position); state comes from `begin_3d`.
    pub unsafe fn draw(&mut self, pool: &mut FramePool, cam: &Camera3d) {
        let map = &self.map;
        let frustum = cam.frustum();
        self.vis.update(&map.vis, map.collision.planes(), cam.pos);

        for r in &mut self.runs {
            r.clear();
        }
        let runs = &mut self.runs;
        let mut faces = 0u32;
        self.vis.gather_faces(&map.vis, &frustum, |face| {
            let run = &map.faces[face as usize];
            if run.batch != 0xffff {
                runs[run.batch as usize].push((run.index_base, run.index_count));
                faces += 1;
            }
        });
        // Brush-entity geometry is outside the PVS; draw it every frame.
        for run in &map.always_runs {
            if run.batch != 0xffff {
                runs[run.batch as usize].push((run.index_base, run.index_count));
            }
        }

        // The GE normalizes 16-bit positions to [-1,1) in 3D mode (÷32768);
        // scale back up in the model matrix so i16 world units come out 1:1.
        sys::sceGuSetMatrix(
            sys::MatrixMode::Model,
            &crate::to_psp_matrix(glam::Mat4::from_scale(glam::Vec3::splat(32768.0))),
        );

        let mut tris = 0u32;
        let mut alpha_test = false;
        for (bi, batch) in map.batches.iter().enumerate() {
            let batch_runs = &runs[bi];
            if batch_runs.is_empty() {
                continue;
            }
            let total: usize = batch_runs.iter().map(|&(_, n)| n as usize).sum();
            if total == 0 {
                continue;
            }

            // Splice the visible faces' index ranges into one pool buffer.
            let dst = pool.alloc(total * 2) as *mut u16;
            let mut off = 0usize;
            for &(base, count) in batch_runs {
                core::ptr::copy_nonoverlapping(
                    map.indices.as_ptr().add(base as usize),
                    dst.add(off),
                    count as usize,
                );
                off += count as usize;
            }
            sys::sceKernelDcacheWritebackRange(dst as *const c_void, (total * 2) as u32);

            let want_alpha = batch.kind == SurfaceKind::AlphaTest;
            if want_alpha != alpha_test {
                if want_alpha {
                    sys::sceGuEnable(GuState::AlphaTest);
                    sys::sceGuAlphaFunc(AlphaFunc::Greater, 0x40, 0xff);
                } else {
                    sys::sceGuDisable(GuState::AlphaTest);
                }
                alpha_test = want_alpha;
            }
            texture::bind(&map.textures[batch.texture as usize]);

            let verts = map
                .verts
                .as_ptr()
                .add(batch.vert_base as usize * VERTEX_STRIDE);
            sys::sceGuDrawArray(
                GuPrimitive::Triangles,
                WORLD_VTYPE,
                total as i32,
                dst as *const c_void,
                verts as *const c_void,
            );
            tris += total as u32 / 3;
        }
        if alpha_test {
            sys::sceGuDisable(GuState::AlphaTest);
        }
        sys::sceGuSetMatrix(
            sys::MatrixMode::Model,
            &crate::to_psp_matrix(glam::Mat4::IDENTITY),
        );
        self.last_faces = faces;
        self.last_tris = tris;
    }
}
