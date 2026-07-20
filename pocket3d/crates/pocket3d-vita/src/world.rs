//! Cooked-world rendering: PVS/frustum gathering followed by CPU projection.

use glam::{Vec2, Vec3};
use pocket3d_bsp::cooked::{CookedMap, VERTEX_STRIDE};
use pocket3d_bsp::vis::VisSet;

use crate::camera::Camera3d;
use crate::pool::FramePool;
use crate::texture::{TextureBank, UploadError};

#[derive(Clone, Copy, Debug)]
struct WorldVertex {
    uv: Vec2,
    color: u32,
    position: Vec3,
}

pub struct WorldRenderer<'a> {
    map: CookedMap<'a>,
    vis: VisSet,
    /// Per-batch `(index_base, index_count)` ranges gathered this frame.
    runs: Vec<Vec<(u32, u16)>>,
    textures: TextureBank,
    pub last_faces: u32,
    pub last_tris: u32,
    pub last_texture_error: Option<UploadError>,
}

impl<'a> WorldRenderer<'a> {
    /// Build CPU visibility state without touching Vita graphics state.
    /// Textures upload lazily on the first draw after vita2d initialization.
    pub fn new(map: CookedMap<'a>) -> Self {
        let mut runs = Vec::new();
        runs.resize_with(map.batches.len(), Vec::new);
        let vis = VisSet::new(map.faces.len());
        let textures = TextureBank::new(map.textures.len());
        Self {
            map,
            vis,
            runs,
            textures,
            last_faces: 0,
            last_tris: 0,
            last_texture_error: None,
        }
    }

    pub fn map(&self) -> &CookedMap<'a> {
        &self.map
    }

    /// Eagerly upload level-zero RGBA textures. vita2d must be initialized.
    ///
    /// # Safety
    ///
    /// Call on the Vita render thread after vita2d initialization and outside
    /// concurrent access to the renderer.
    pub unsafe fn upload_textures(&mut self) -> Result<(), UploadError> {
        let result = self.textures.upload_missing(&self.map.textures);
        self.last_texture_error = result.err();
        result
    }

    /// Queue PVS-visible world triangles into the active 3D pass.
    ///
    /// # Safety
    ///
    /// A `pocket3d_vita` pass and vita2d scene must be active. `pool` must be
    /// the pass's sole, stable frame pool until `pocket3d_vita::end_3d`.
    pub unsafe fn draw(&mut self, pool: &mut FramePool, camera: &Camera3d) {
        let (_, layer) = crate::activate_pool(pool);
        let view_proj = camera.view_proj();
        let frustum = camera.frustum();
        self.vis
            .update(&self.map.vis, self.map.collision.planes(), camera.pos);

        for ranges in &mut self.runs {
            ranges.clear();
        }
        let runs = &mut self.runs;
        let mut faces = 0u32;
        self.vis
            .gather_faces(&self.map.vis, &frustum, |face_index| {
                let run = &self.map.faces[face_index as usize];
                if run.batch != 0xffff {
                    runs[run.batch as usize].push((run.index_base, run.index_count));
                    faces += 1;
                }
            });
        for run in &self.map.always_runs {
            if run.batch != 0xffff {
                runs[run.batch as usize].push((run.index_base, run.index_count));
            }
        }

        if let Err(error) = self.textures.upload_missing(&self.map.textures) {
            // Geometry remains visible with baked vertex colors when a Vita
            // texture allocation fails. Keep the first error inspectable.
            self.last_texture_error = Some(error);
        } else {
            self.last_texture_error = None;
        }

        let expected_triangles: usize = self
            .runs
            .iter()
            .flat_map(|ranges| ranges.iter())
            .map(|(_, count)| *count as usize / 3)
            .sum();
        pool.reserve_triangles(expected_triangles);

        let mut triangles = 0u32;
        for (batch_index, batch) in self.map.batches.iter().enumerate() {
            let texture = self.textures.handle(batch.texture as usize);
            for &(index_base, index_count) in &self.runs[batch_index] {
                let start = index_base as usize;
                let end = start + index_count as usize;
                for indices in self.map.indices[start..end].chunks_exact(3) {
                    let a = decode_vertex(
                        self.map.verts,
                        batch.vert_base as usize + indices[0] as usize,
                    );
                    let b = decode_vertex(
                        self.map.verts,
                        batch.vert_base as usize + indices[1] as usize,
                    );
                    let c = decode_vertex(
                        self.map.verts,
                        batch.vert_base as usize + indices[2] as usize,
                    );
                    pool.queue_world_triangle(
                        view_proj,
                        [a.position, b.position, c.position],
                        [a.uv, b.uv, c.uv],
                        [a.color, b.color, c.color],
                        texture,
                        layer,
                    );
                    triangles += 1;
                }
            }
        }
        self.last_faces = faces;
        self.last_tris = triangles;
    }
}

fn decode_vertex(bytes: &[u8], index: usize) -> WorldVertex {
    let start = index * VERTEX_STRIDE;
    let vertex = &bytes[start..start + VERTEX_STRIDE];
    WorldVertex {
        uv: Vec2::new(read_f32(vertex, 0), read_f32(vertex, 4)),
        color: read_u32(vertex, 8),
        position: Vec3::new(
            read_i16(vertex, 12) as f32,
            read_i16(vertex, 14) as f32,
            read_i16(vertex, 16) as f32,
        ),
    }
}

#[inline]
fn read_f32(bytes: &[u8], offset: usize) -> f32 {
    f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

#[inline]
fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

#[inline]
fn read_i16(bytes: &[u8], offset: usize) -> i16 {
    i16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_cooked_vertex_layout() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0.25f32.to_le_bytes());
        bytes.extend_from_slice(&0.75f32.to_le_bytes());
        bytes.extend_from_slice(&0xff11_2233u32.to_le_bytes());
        bytes.extend_from_slice(&(-12i16).to_le_bytes());
        bytes.extend_from_slice(&34i16.to_le_bytes());
        bytes.extend_from_slice(&(-56i16).to_le_bytes());
        bytes.extend_from_slice(&0i16.to_le_bytes());
        let vertex = decode_vertex(&bytes, 0);
        assert_eq!(vertex.uv, Vec2::new(0.25, 0.75));
        assert_eq!(vertex.color, 0xff11_2233);
        assert_eq!(vertex.position, Vec3::new(-12.0, 34.0, -56.0));
    }
}
