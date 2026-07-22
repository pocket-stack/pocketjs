//! Cooked-world rendering: PVS/frustum gathering, then indexed GPU draws.
//!
//! The cooked `.p3d` vertex/index data is copied once per map into an
//! uncached GXM-mapped slab. Each frame gathers PVS-visible faces into
//! per-batch index runs, merges adjacent runs, and submits them in two
//! hardware passes: textured opaque, then a multiply-blended gouraud pass
//! that applies the baked per-vertex lighting. Masked "cutout" textures
//! (fences, grates) are staged through the [`FramePool`] and drawn late with
//! alpha blending and a flat per-visible-run light tint, because GXM has no
//! fixed-function alpha test.

#[cfg(test)]
use glam::Vec2;
use glam::Vec3;
#[cfg(target_os = "vita")]
use pocket3d_bsp::cooked::FaceRun;
use pocket3d_bsp::cooked::{CookedMap, VERTEX_STRIDE};
use pocket3d_bsp::vis::VisSet;

use crate::camera::Camera3d;
use crate::pool::FramePool;
use crate::texture::{TextureBank, UploadError};

#[derive(Clone, Copy, Debug)]
struct WorldVertex {
    #[cfg(test)]
    uv: Vec2,
    color: u32,
    position: Vec3,
}

/// Camera-independent metadata for one masked index run. Sums let adjacent
/// runs merge without decoding or copying their vertices again per frame.
#[cfg(any(target_os = "vita", test))]
#[derive(Clone, Copy, Debug)]
struct MaskedMeta {
    batch: u16,
    index_base: u32,
    index_count: u32,
    color_sum: [f32; 3],
    position_sum: Vec3,
}

/// A lazily uploaded cooked world.
///
/// On Vita, drop an uploaded renderer only after the scene that last used it
/// has been presented and before `vita2d_fini`. Dropping a never-uploaded
/// renderer is graphics-state independent.
pub struct WorldRenderer<'a> {
    map: CookedMap<'a>,
    vis: VisSet,
    /// Per-batch `(index_base, index_count)` ranges gathered this frame.
    runs: Vec<Vec<(u32, u32)>>,
    textures: TextureBank,
    #[cfg(target_os = "vita")]
    geometry: Option<crate::gxm::GpuSlab>,
    #[cfg(target_os = "vita")]
    geometry_error: Option<&'static str>,
    #[cfg(target_os = "vita")]
    masked_faces: Vec<Option<MaskedMeta>>,
    #[cfg(target_os = "vita")]
    masked_always: Vec<Option<MaskedMeta>>,
    #[cfg(target_os = "vita")]
    visible_masked: Vec<MaskedMeta>,
    pub last_faces: u32,
    pub last_tris: u32,
    /// Direct resident-buffer draw calls emitted before FramePool flush.
    /// Masked runs are queued here but submitted later by the pool.
    pub last_direct_draw_calls: u32,
    pub last_texture_error: Option<UploadError>,
}

impl<'a> WorldRenderer<'a> {
    /// Build CPU visibility state without touching Vita graphics state.
    /// Textures and the GPU geometry slab upload lazily on the first draw
    /// after vita2d initialization.
    pub fn new(map: CookedMap<'a>) -> Self {
        #[cfg(target_os = "vita")]
        let masked_faces = map
            .faces
            .iter()
            .map(|run| masked_meta(&map, *run))
            .collect();
        #[cfg(target_os = "vita")]
        let masked_always = map
            .always_runs
            .iter()
            .map(|run| masked_meta(&map, *run))
            .collect();
        let mut runs = Vec::new();
        runs.resize_with(map.batches.len(), Vec::new);
        let vis = VisSet::new(map.faces.len());
        let textures = TextureBank::new(map.textures.len());
        Self {
            map,
            vis,
            runs,
            textures,
            #[cfg(target_os = "vita")]
            geometry: None,
            #[cfg(target_os = "vita")]
            geometry_error: None,
            #[cfg(target_os = "vita")]
            masked_faces,
            #[cfg(target_os = "vita")]
            masked_always,
            #[cfg(target_os = "vita")]
            visible_masked: Vec::new(),
            last_faces: 0,
            last_tris: 0,
            last_direct_draw_calls: 0,
            last_texture_error: None,
        }
    }

    pub fn map(&self) -> &CookedMap<'a> {
        &self.map
    }

    /// Whether the immutable cooked vertex/index slab reached GPU-visible
    /// memory. Capture builds expose this as an explicit backend health check.
    pub fn gpu_geometry_resident(&self) -> bool {
        #[cfg(target_os = "vita")]
        {
            self.geometry.is_some()
        }
        #[cfg(not(target_os = "vita"))]
        {
            false
        }
    }

    /// The permanent geometry upload error, if the first upload failed.
    pub fn geometry_error(&self) -> Option<&'static str> {
        #[cfg(target_os = "vita")]
        {
            self.geometry_error
        }
        #[cfg(not(target_os = "vita"))]
        {
            None
        }
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

    /// Gather PVS-visible faces into per-batch merged index runs and update
    /// `last_faces`. Shared by the Vita submission path and host tests.
    fn gather_runs(&mut self, camera: &Camera3d) {
        let frustum = camera.frustum();
        self.vis
            .update(&self.map.vis, self.map.collision.planes(), camera.pos);

        for ranges in &mut self.runs {
            ranges.clear();
        }
        #[cfg(target_os = "vita")]
        self.visible_masked.clear();
        let runs = &mut self.runs;
        #[cfg(target_os = "vita")]
        let masked_faces = &self.masked_faces;
        #[cfg(target_os = "vita")]
        let visible_masked = &mut self.visible_masked;
        let mut faces = 0u32;
        self.vis
            .gather_faces(&self.map.vis, &frustum, |face_index| {
                let run = &self.map.faces[face_index as usize];
                if run.batch == 0xffff {
                    return;
                }
                #[cfg(target_os = "vita")]
                if let Some(meta) = masked_faces[face_index as usize] {
                    visible_masked.push(meta);
                    faces += 1;
                    return;
                }
                runs[run.batch as usize].push((run.index_base, run.index_count as u32));
                faces += 1;
            });
        for (index, run) in self.map.always_runs.iter().enumerate() {
            let _ = index;
            if run.batch == 0xffff {
                continue;
            }
            #[cfg(target_os = "vita")]
            if let Some(meta) = self.masked_always[index] {
                self.visible_masked.push(meta);
                continue;
            }
            runs[run.batch as usize].push((run.index_base, run.index_count as u32));
        }
        for ranges in &mut self.runs {
            merge_runs(ranges);
        }
        #[cfg(target_os = "vita")]
        merge_masked_runs(&mut self.visible_masked);
        self.last_faces = faces;
    }

    /// Queue PVS-visible world triangles into the active 3D pass.
    ///
    /// # Safety
    ///
    /// A `pocket3d_vita` pass and vita2d scene must be active. `pool` must be
    /// the pass's sole, stable frame pool until `pocket3d_vita::end_3d`.
    /// `self` must remain alive through `end_3d`, which consumes resident
    /// masked-run pointers, and must not be dropped until after the enclosing
    /// scene is presented.
    pub unsafe fn draw(&mut self, pool: &mut FramePool, camera: &Camera3d) {
        let (view_proj, _) = crate::activate_pool(pool);
        self.gather_runs(camera);
        self.last_direct_draw_calls = 0;

        if let Err(error) = self.textures.upload_missing(&self.map.textures) {
            // Geometry remains visible via the gouraud fallback when a Vita
            // texture allocation fails. Keep the first error inspectable.
            self.last_texture_error = Some(error);
        } else {
            self.last_texture_error = None;
        }

        self.last_tris = self.runs.iter().flatten().map(|(_, count)| count / 3).sum();
        #[cfg(target_os = "vita")]
        {
            self.last_tris += self
                .visible_masked
                .iter()
                .map(|run| run.index_count / 3)
                .sum::<u32>();
        }

        #[cfg(target_os = "vita")]
        self.submit(pool, &view_proj.to_cols_array());
        #[cfg(not(target_os = "vita"))]
        {
            let _ = view_proj;
            pool.last.triangles += self.last_tris;
        }
    }

    #[cfg(target_os = "vita")]
    unsafe fn submit(&mut self, pool: &mut FramePool, view_proj: &[f32; 16]) {
        use crate::gxm::{self, DepthMode};

        // Partition non-masked batches into textured or gouraud fallback.
        // Masked runs are tracked separately with precomputed metadata.
        let batch_class = |batch_index: usize| -> BatchClass {
            let batch = &self.map.batches[batch_index];
            if self.runs[batch_index].is_empty() {
                return BatchClass::Empty;
            }
            let texture_index = batch.texture as usize;
            if self.textures.handle(texture_index).is_null() {
                return BatchClass::Fallback;
            }
            BatchClass::Textured
        };
        let triangles_for = |expected: BatchClass| -> u32 {
            self.runs
                .iter()
                .enumerate()
                .filter(|(index, _)| batch_class(*index) == expected)
                .flat_map(|(_, ranges)| ranges)
                .map(|(_, count)| count / 3)
                .sum()
        };
        let textured_triangles = triangles_for(BatchClass::Textured);
        let fallback_triangles = triangles_for(BatchClass::Fallback);
        let masked_gpu_triangles = self
            .visible_masked
            .iter()
            .filter(|run| {
                let batch = &self.map.batches[run.batch as usize];
                !self.textures.handle(batch.texture as usize).is_null()
            })
            .map(|run| run.index_count / 3)
            .sum::<u32>();
        let masked_fallback_triangles = self
            .visible_masked
            .iter()
            .filter(|run| {
                let batch = &self.map.batches[run.batch as usize];
                self.textures.handle(batch.texture as usize).is_null()
            })
            .map(|run| run.index_count / 3)
            .sum::<u32>();
        // Textured world geometry has a texture pass and a baked-light
        // multiply pass. Other classes have one GPU pass.
        let direct_submissions =
            textured_triangles * 2 + fallback_triangles + masked_fallback_triangles;
        let world_submissions = direct_submissions + masked_gpu_triangles;

        let Ok(pipeline) = gxm::pipeline() else {
            pool.last.triangles += world_submissions;
            pool.last.dropped_triangles += world_submissions;
            pool.last.submission_errors += 1;
            return;
        };
        if self.geometry.is_none() && self.geometry_error.is_none() {
            match upload_geometry(&self.map) {
                Ok(geometry) => self.geometry = Some(geometry),
                Err(error) => self.geometry_error = Some(error),
            }
        }
        let Some(geometry) = &self.geometry else {
            pool.last.triangles += world_submissions;
            pool.last.dropped_triangles += world_submissions;
            pool.last.submission_errors += 1;
            return;
        };
        let verts = geometry.as_ptr();
        let indices = verts.add(index_slab_offset(&self.map)).cast::<u16>();

        // Masked runs are staged into `FramePool` and counted by `flush`.
        // Count both resident-buffer passes here so `dropped_triangles` and
        // `triangles` use the same unit: attempted GPU triangle submissions.
        pool.last.triangles += direct_submissions;

        gxm::set_depth(DepthMode::Opaque);

        // Pass 1: textured opaque batches.
        let draws_before = pool.last.draw_calls;
        let mut bound = pipeline.bind_world_textured(view_proj);
        if bound {
            for batch_index in 0..self.map.batches.len() {
                if batch_class(batch_index) != BatchClass::Textured {
                    continue;
                }
                let batch = &self.map.batches[batch_index];
                if !pipeline.set_texture(self.textures.handle(batch.texture as usize))
                    || !pipeline
                        .set_stream(verts.add(batch.vert_base as usize * VERTEX_STRIDE).cast())
                {
                    record_failed_runs(pool, &self.runs[batch_index]);
                    continue;
                }
                for &(base, count) in &self.runs[batch_index] {
                    if pipeline.draw_indexed(indices.add(base as usize), count) {
                        pool.last.draw_calls += 1;
                    } else {
                        record_failed_draw(pool, count);
                    }
                }
            }
        } else {
            record_failed_class(pool, &self.runs, &batch_class, BatchClass::Textured);
        }

        // Gouraud fallback for batches without a resident texture.
        bound = pipeline.bind_world_gouraud(view_proj);
        if bound {
            for batch_index in 0..self.map.batches.len() {
                if batch_class(batch_index) != BatchClass::Fallback {
                    continue;
                }
                let batch = &self.map.batches[batch_index];
                if !pipeline.set_stream(verts.add(batch.vert_base as usize * VERTEX_STRIDE).cast())
                {
                    record_failed_runs(pool, &self.runs[batch_index]);
                    continue;
                }
                for &(base, count) in &self.runs[batch_index] {
                    if pipeline.draw_indexed(indices.add(base as usize), count) {
                        pool.last.draw_calls += 1;
                    } else {
                        record_failed_draw(pool, count);
                    }
                }
            }
            for run in &self.visible_masked {
                let batch = &self.map.batches[run.batch as usize];
                if !self.textures.handle(batch.texture as usize).is_null() {
                    continue;
                }
                if pipeline.set_stream(verts.add(batch.vert_base as usize * VERTEX_STRIDE).cast())
                    && pipeline.draw_indexed(indices.add(run.index_base as usize), run.index_count)
                {
                    pool.last.draw_calls += 1;
                } else {
                    record_failed_draw(pool, run.index_count);
                }
            }
        } else {
            record_failed_class(pool, &self.runs, &batch_class, BatchClass::Fallback);
            if masked_fallback_triangles > 0 {
                pool.last.dropped_triangles += masked_fallback_triangles;
                pool.last.submission_errors += 1;
            }
        }

        // Pass 2: multiply the baked per-vertex lighting over pass 1.
        bound = pipeline.bind_world_light(view_proj);
        if bound {
            for batch_index in 0..self.map.batches.len() {
                if batch_class(batch_index) != BatchClass::Textured {
                    continue;
                }
                let batch = &self.map.batches[batch_index];
                if !pipeline.set_stream(verts.add(batch.vert_base as usize * VERTEX_STRIDE).cast())
                {
                    record_failed_runs(pool, &self.runs[batch_index]);
                    continue;
                }
                for &(base, count) in &self.runs[batch_index] {
                    if pipeline.draw_indexed(indices.add(base as usize), count) {
                        pool.last.draw_calls += 1;
                    } else {
                        record_failed_draw(pool, count);
                    }
                }
            }
        } else {
            record_failed_class(pool, &self.runs, &batch_class, BatchClass::Textured);
        }

        // Masked cutouts: queue resident slab ranges with metadata computed
        // once at map load. No vertex decoding, copying or pool allocation is
        // needed on steady-state frames.
        // The stock fragment shader cannot discard alpha-tested texels, so
        // the pool draws these runs back-to-front after other world-space
        // translucency, with a depth test and no depth writes.
        for run in &self.visible_masked {
            let batch = &self.map.batches[run.batch as usize];
            let texture = self.textures.handle(batch.texture as usize);
            if texture.is_null() || run.index_count == 0 {
                continue;
            }
            let scale = 1.0 / (255.0 * run.index_count as f32);
            pool.masked_runs.push(crate::pool::MaskedRun {
                texture,
                tint: [
                    run.color_sum[0] * scale,
                    run.color_sum[1] * scale,
                    run.color_sum[2] * scale,
                    1.0,
                ],
                center: run.position_sum / run.index_count as f32,
                vertices: verts.add(batch.vert_base as usize * VERTEX_STRIDE).cast(),
                indices: indices.add(run.index_base as usize),
                index_count: run.index_count,
            });
        }
        self.last_direct_draw_calls = pool.last.draw_calls - draws_before;
    }
}

#[cfg(target_os = "vita")]
#[derive(Clone, Copy, PartialEq, Eq)]
enum BatchClass {
    Empty,
    Textured,
    Fallback,
}

#[cfg(target_os = "vita")]
fn record_failed_draw(pool: &mut FramePool, index_count: u32) {
    pool.last.dropped_triangles += index_count / 3;
    pool.last.submission_errors += 1;
}

#[cfg(target_os = "vita")]
fn record_failed_runs(pool: &mut FramePool, runs: &[(u32, u32)]) {
    pool.last.dropped_triangles += runs.iter().map(|(_, count)| count / 3).sum::<u32>();
    pool.last.submission_errors += 1;
}

#[cfg(target_os = "vita")]
fn record_failed_class(
    pool: &mut FramePool,
    runs: &[Vec<(u32, u32)>],
    class: &impl Fn(usize) -> BatchClass,
    expected: BatchClass,
) {
    let triangles = runs
        .iter()
        .enumerate()
        .filter(|(index, _)| class(*index) == expected)
        .flat_map(|(_, ranges)| ranges)
        .map(|(_, count)| count / 3)
        .sum::<u32>();
    if triangles > 0 {
        pool.last.dropped_triangles += triangles;
        pool.last.submission_errors += 1;
    }
}

#[cfg(target_os = "vita")]
fn index_slab_offset(map: &CookedMap<'_>) -> usize {
    map.verts.len().next_multiple_of(2)
}

/// Decode camera-independent masked-run metadata once while constructing the
/// renderer. Cooked-map validation guarantees every referenced index is in
/// the owning batch's vertex range.
#[cfg(target_os = "vita")]
fn masked_meta(map: &CookedMap<'_>, run: FaceRun) -> Option<MaskedMeta> {
    if run.batch == 0xffff || run.index_count == 0 {
        return None;
    }
    let batch = &map.batches[run.batch as usize];
    if !map
        .textures
        .get(batch.texture as usize)
        .is_some_and(|texture| texture.masked)
    {
        return None;
    }
    let mut color_sum = [0.0f32; 3];
    let mut position_sum = Vec3::ZERO;
    for offset in 0..run.index_count as usize {
        let index = map.indices[run.index_base as usize + offset];
        let vertex = decode_vertex(map.verts, batch.vert_base as usize + index as usize);
        color_sum[0] += (vertex.color & 0xff) as f32;
        color_sum[1] += ((vertex.color >> 8) & 0xff) as f32;
        color_sum[2] += ((vertex.color >> 16) & 0xff) as f32;
        position_sum += vertex.position;
    }
    Some(MaskedMeta {
        batch: run.batch,
        index_base: run.index_base,
        index_count: run.index_count as u32,
        color_sum,
        position_sum,
    })
}

/// Merge adjacent masked ranges while preserving their weighted tint/center
/// sums. This reduces draw calls without any per-frame vertex decoding.
#[cfg(any(target_os = "vita", test))]
fn merge_masked_runs(runs: &mut Vec<MaskedMeta>) {
    if runs.len() < 2 {
        return;
    }
    runs.sort_unstable_by_key(|run| (run.batch, run.index_base));
    let mut write = 0usize;
    for read in 1..runs.len() {
        let next = runs[read];
        let current = &mut runs[write];
        if current.batch == next.batch
            && current.index_base.checked_add(current.index_count) == Some(next.index_base)
        {
            current.index_count += next.index_count;
            for channel in 0..3 {
                current.color_sum[channel] += next.color_sum[channel];
            }
            current.position_sum += next.position_sum;
        } else {
            write += 1;
            runs[write] = next;
        }
    }
    runs.truncate(write + 1);
}

/// Copy the cooked vertex and index data into one GPU-visible slab.
#[cfg(target_os = "vita")]
unsafe fn upload_geometry(map: &CookedMap<'_>) -> Result<crate::gxm::GpuSlab, &'static str> {
    let index_offset = index_slab_offset(map);
    let total = index_offset + map.indices.len() * 2;
    let slab = crate::gxm::GpuSlab::alloc(total)?;
    core::ptr::copy_nonoverlapping(map.verts.as_ptr(), slab.as_ptr(), map.verts.len());
    core::ptr::copy_nonoverlapping(
        map.indices.as_ptr(),
        slab.as_ptr().add(index_offset).cast::<u16>(),
        map.indices.len(),
    );
    Ok(slab)
}

#[cfg(target_os = "vita")]
impl Drop for WorldRenderer<'_> {
    fn drop(&mut self) {
        unsafe {
            // The slab and this renderer's textures may still be referenced
            // by in-flight GPU work; map changes are rare enough to drain.
            // A never-uploaded renderer is valid before vita2d_init and must
            // not touch the absent GXM context during destruction.
            if self.geometry.is_some() || self.textures.has_resident() {
                vita2d_sys::vita2d_wait_rendering_done();
            }
            if let Some(geometry) = self.geometry.take() {
                geometry.free();
            }
        }
    }
}

/// Merge index runs that are adjacent after sorting by base offset.
fn merge_runs(ranges: &mut Vec<(u32, u32)>) {
    if ranges.len() < 2 {
        return;
    }
    ranges.sort_unstable();
    let mut write = 0usize;
    for read in 1..ranges.len() {
        let (base, count) = ranges[read];
        let current = &mut ranges[write];
        if current.0 + current.1 == base {
            current.1 += count;
        } else {
            write += 1;
            ranges[write] = (base, count);
        }
    }
    ranges.truncate(write + 1);
}

fn decode_vertex(bytes: &[u8], index: usize) -> WorldVertex {
    let start = index * VERTEX_STRIDE;
    let vertex = &bytes[start..start + VERTEX_STRIDE];
    WorldVertex {
        #[cfg(test)]
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
#[cfg(test)]
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

    #[test]
    fn merges_adjacent_runs_after_sorting() {
        let mut runs = vec![(9u32, 3u32), (0, 3), (3, 6), (15, 3)];
        merge_runs(&mut runs);
        assert_eq!(runs, [(0, 12), (15, 3)]);
    }

    #[test]
    fn keeps_single_runs_untouched() {
        let mut runs = vec![(6u32, 3u32)];
        merge_runs(&mut runs);
        assert_eq!(runs, [(6, 3)]);
    }

    #[test]
    fn merges_masked_metadata_without_redecoding_vertices() {
        let mut runs = vec![
            MaskedMeta {
                batch: 2,
                index_base: 6,
                index_count: 3,
                color_sum: [3.0, 6.0, 9.0],
                position_sum: Vec3::new(3.0, 0.0, 0.0),
            },
            MaskedMeta {
                batch: 1,
                index_base: 9,
                index_count: 6,
                color_sum: [12.0, 18.0, 24.0],
                position_sum: Vec3::new(6.0, 12.0, 0.0),
            },
            MaskedMeta {
                batch: 1,
                index_base: 3,
                index_count: 6,
                color_sum: [6.0, 9.0, 12.0],
                position_sum: Vec3::new(6.0, 0.0, 0.0),
            },
        ];
        merge_masked_runs(&mut runs);
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].batch, 1);
        assert_eq!(runs[0].index_base, 3);
        assert_eq!(runs[0].index_count, 12);
        assert_eq!(runs[0].color_sum, [18.0, 27.0, 36.0]);
        assert_eq!(runs[0].position_sum, Vec3::new(12.0, 12.0, 0.0));
        assert_eq!(runs[1].batch, 2);
    }
}
