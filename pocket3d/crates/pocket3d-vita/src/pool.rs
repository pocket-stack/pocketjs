//! Per-frame staging for dynamic (non-world) geometry.
//!
//! World geometry is submitted directly from GPU-resident buffers by
//! [`crate::world::WorldRenderer`]; this pool only stages the small dynamic
//! sets — the sky backdrop, actor meshes, translucent effects and the
//! first-person view model — and uploads them into vita2d's GPU-mapped
//! per-frame pool at [`FramePool::flush`]. Masked cutouts retain sortable
//! references into the world's resident buffers instead of copying vertices.

use glam::Vec3;

use crate::mesh::ColorVert;

#[cfg(target_os = "vita")]
type TextureHandle = *const vita2d_sys::vita2d_texture;
#[cfg(not(target_os = "vita"))]
type TextureHandle = *const core::ffi::c_void;

pub(crate) const BACKDROP_WVP: [f32; 16] = {
    // vita2d's screen-space ortho: x 0..960 -> -1..1, y 0..544 -> 1..-1,
    // vertex z 0..1 -> NDC 1..-1 (z = 0 is the far plane).
    let sx = 2.0 / crate::SCREEN_WIDTH;
    let sy = -2.0 / crate::SCREEN_HEIGHT;
    [
        sx, 0.0, 0.0, 0.0, //
        0.0, sy, 0.0, 0.0, //
        0.0, 0.0, -2.0, 0.0, //
        -1.0, 1.0, 1.0, 1.0,
    ]
};

/// One masked cutout run into the world's resident vertex/index slab.
pub(crate) struct MaskedRun {
    pub texture: TextureHandle,
    pub tint: [f32; 4],
    pub center: Vec3,
    pub vertices: *const core::ffi::c_void,
    pub indices: *const u16,
    pub index_count: u32,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct FrameStats {
    /// Triangle submissions attempted across all GPU passes. A textured world
    /// triangle contributes twice: once for texture and once for lighting.
    pub triangles: u32,
    pub draw_calls: u32,
    pub dropped_triangles: u32,
    pub submission_errors: u32,
    pub additive_triangles: u32,
}

/// CPU staging retained across frames. Call [`FramePool::reset`] after the
/// previous vita2d scene has completed and before [`crate::begin_3d`].
pub struct FramePool {
    /// Screen-space gradient triangles drawn at the far plane.
    pub(crate) backdrop: Vec<ColorVert>,
    /// Depth-tested opaque triangles in world space (actors).
    pub(crate) opaque: Vec<ColorVert>,
    /// Depth-tested, non-writing translucent triangles in world space.
    pub(crate) blended: Vec<ColorVert>,
    /// Depth-tested, non-writing additive triangles in world space.
    pub(crate) additive: Vec<ColorVert>,
    /// Overlay triangles drawn last, painter-sorted among themselves.
    pub(crate) viewmodel: Vec<ColorVert>,
    /// Masked world cutouts (alpha-blended, depth-tested, non-writing).
    pub(crate) masked_runs: Vec<MaskedRun>,
    /// Painter-sort storage retained across frames so the steady-state
    /// translucent/viewmodel path does not allocate.
    sort_order: Vec<(f32, u32)>,
    sort_vertices: Vec<ColorVert>,
    pub last: FrameStats,
}

impl FramePool {
    pub const fn new() -> Self {
        Self {
            backdrop: Vec::new(),
            opaque: Vec::new(),
            blended: Vec::new(),
            additive: Vec::new(),
            viewmodel: Vec::new(),
            masked_runs: Vec::new(),
            sort_order: Vec::new(),
            sort_vertices: Vec::new(),
            last: FrameStats {
                triangles: 0,
                draw_calls: 0,
                dropped_triangles: 0,
                submission_errors: 0,
                additive_triangles: 0,
            },
        }
    }

    pub fn reset(&mut self) {
        self.backdrop.clear();
        self.opaque.clear();
        self.blended.clear();
        self.additive.clear();
        self.viewmodel.clear();
        self.masked_runs.clear();
        self.last = FrameStats::default();
    }

    pub(crate) fn queue_backdrop_triangle(&mut self, positions: [[f32; 2]; 3], colors: [u32; 3]) {
        for index in 0..3 {
            self.backdrop.push(ColorVert {
                color: colors[index],
                x: positions[index][0],
                y: positions[index][1],
                z: 0.0,
            });
        }
    }

    /// Sort a staged triangle list back-to-front relative to the camera.
    fn painter_sort(
        vertices: &mut [ColorVert],
        eye: Vec3,
        forward: Vec3,
        order: &mut Vec<(f32, u32)>,
        sorted: &mut Vec<ColorVert>,
    ) {
        debug_assert_eq!(vertices.len() % 3, 0);
        let triangle_count = vertices.len() / 3;
        if triangle_count < 2 {
            return;
        }
        order.clear();
        order.reserve(triangle_count);
        for triangle in 0..triangle_count {
            let base = triangle * 3;
            let centroid = Vec3::new(
                vertices[base].x + vertices[base + 1].x + vertices[base + 2].x,
                vertices[base].y + vertices[base + 1].y + vertices[base + 2].y,
                vertices[base].z + vertices[base + 1].z + vertices[base + 2].z,
            ) / 3.0;
            order.push(((centroid - eye).dot(forward), triangle as u32));
        }
        order.sort_unstable_by(|left, right| {
            right
                .0
                .partial_cmp(&left.0)
                .unwrap_or(core::cmp::Ordering::Equal)
        });
        sorted.clear();
        sorted.reserve(vertices.len());
        for &(_, triangle) in order.iter() {
            let base = triangle as usize * 3;
            sorted.extend_from_slice(&vertices[base..base + 3]);
        }
        vertices.copy_from_slice(&sorted);
    }

    /// Upload and submit every staged list in back-to-front pass order.
    ///
    /// # Safety
    ///
    /// Vita: render thread, inside the pass opened by [`crate::begin_3d`].
    pub(crate) unsafe fn flush(&mut self, view_proj: &[f32; 16], eye: Vec3, forward: Vec3) {
        Self::painter_sort(
            &mut self.blended,
            eye,
            forward,
            &mut self.sort_order,
            &mut self.sort_vertices,
        );
        Self::painter_sort(
            &mut self.viewmodel,
            eye,
            forward,
            &mut self.sort_order,
            &mut self.sort_vertices,
        );
        self.masked_runs.sort_unstable_by(|left, right| {
            let left_depth = (left.center - eye).dot(forward);
            let right_depth = (right.center - eye).dot(forward);
            right_depth
                .partial_cmp(&left_depth)
                .unwrap_or(core::cmp::Ordering::Equal)
        });

        let staged_triangles = ((self.backdrop.len()
            + self.opaque.len()
            + self.blended.len()
            + self.additive.len()
            + self.viewmodel.len())
            / 3) as u32
            + self
                .masked_runs
                .iter()
                .map(|run| run.index_count / 3)
                .sum::<u32>();
        self.last.additive_triangles = (self.additive.len() / 3) as u32;
        self.last.triangles += staged_triangles;

        #[cfg(target_os = "vita")]
        self.submit(view_proj);
        #[cfg(not(target_os = "vita"))]
        let _ = view_proj;
    }

    #[cfg(target_os = "vita")]
    unsafe fn submit(&mut self, view_proj: &[f32; 16]) {
        use crate::gxm::{self, ColorMode, DepthMode};

        let Ok(pipeline) = gxm::pipeline() else {
            let staged_triangles = ((self.backdrop.len()
                + self.opaque.len()
                + self.blended.len()
                + self.additive.len()
                + self.viewmodel.len())
                / 3) as u32
                + self
                    .masked_runs
                    .iter()
                    .map(|run| run.index_count / 3)
                    .sum::<u32>();
            self.last.dropped_triangles += staged_triangles;
            self.last.submission_errors += 1;
            return;
        };
        let stats = &mut self.last;

        // Sky backdrop: opaque at the far plane; depth handles the rest.
        if !self.backdrop.is_empty() {
            gxm::set_depth(DepthMode::Opaque);
            if pipeline.bind_dynamic_color(&BACKDROP_WVP, ColorMode::Opaque) {
                draw_color_list(stats, pipeline, &self.backdrop);
            } else {
                record_list_failure(stats, self.backdrop.len());
            }
        }

        if !self.opaque.is_empty() {
            gxm::set_depth(DepthMode::Opaque);
            if pipeline.bind_dynamic_color(view_proj, ColorMode::Opaque) {
                draw_color_list(stats, pipeline, &self.opaque);
            } else {
                record_list_failure(stats, self.opaque.len());
            }
        }

        if !self.blended.is_empty() {
            gxm::set_depth(DepthMode::TestOnly);
            if pipeline.bind_dynamic_color(view_proj, ColorMode::Alpha) {
                draw_color_list(stats, pipeline, &self.blended);
            } else {
                record_list_failure(stats, self.blended.len());
            }
        }

        if !self.additive.is_empty() {
            gxm::set_depth(DepthMode::TestOnly);
            if pipeline.bind_dynamic_color(view_proj, ColorMode::Additive) {
                draw_color_list(stats, pipeline, &self.additive);
            } else {
                record_list_failure(stats, self.additive.len());
            }
        }

        // The stock vita2d texture shader cannot discard alpha-tested texels.
        // Draw masked runs back-to-front after other world-space translucency:
        // opaque fence pixels cover effects in front-to-back order, while
        // transparent holes leave the earlier color intact. World/actor depth
        // testing still rejects an entire run when it is behind opaque scene
        // geometry.
        if !self.masked_runs.is_empty() {
            gxm::set_depth(DepthMode::TestOnly);
            if pipeline.bind_world_masked(view_proj) {
                for run in &self.masked_runs {
                    if pipeline.set_texture(run.texture)
                        && pipeline.set_tint(run.tint)
                        && pipeline.set_stream(run.vertices)
                        && pipeline.draw_indexed(run.indices, run.index_count)
                    {
                        stats.draw_calls += 1;
                    } else {
                        stats.dropped_triangles += run.index_count / 3;
                        stats.submission_errors += 1;
                    }
                }
            } else {
                stats.dropped_triangles += self
                    .masked_runs
                    .iter()
                    .map(|run| run.index_count / 3)
                    .sum::<u32>();
                stats.submission_errors += 1;
            }
        }

        if !self.viewmodel.is_empty() {
            gxm::set_depth(DepthMode::Overlay);
            if pipeline.bind_dynamic_color(view_proj, ColorMode::Opaque) {
                draw_color_list(stats, pipeline, &self.viewmodel);
            } else {
                record_list_failure(stats, self.viewmodel.len());
            }
        }
    }
}

/// Copy one staged list into vita2d's GPU pool and draw it.
#[cfg(target_os = "vita")]
unsafe fn draw_color_list(
    stats: &mut FrameStats,
    pipeline: &crate::gxm::Pipeline,
    vertices: &[ColorVert],
) {
    let bytes = core::mem::size_of_val(vertices);
    let destination = vita2d_sys::vita2d_pool_memalign(bytes as u32, 4);
    if destination.is_null() {
        stats.dropped_triangles += (vertices.len() / 3) as u32;
        stats.submission_errors += 1;
        return;
    }
    core::ptr::copy_nonoverlapping(vertices.as_ptr(), destination.cast(), vertices.len());
    for chunk_start in (0..vertices.len()).step_by(crate::gxm::SEQUENTIAL_INDEX_COUNT) {
        let count = (vertices.len() - chunk_start).min(crate::gxm::SEQUENTIAL_INDEX_COUNT);
        if pipeline.set_stream(destination.cast::<ColorVert>().add(chunk_start).cast())
            && pipeline.draw_sequential(count as u32)
        {
            stats.draw_calls += 1;
        } else {
            stats.dropped_triangles += (count / 3) as u32;
            stats.submission_errors += 1;
        }
    }
}

#[cfg(target_os = "vita")]
fn record_list_failure(stats: &mut FrameStats, vertex_count: usize) {
    stats.dropped_triangles += (vertex_count / 3) as u32;
    stats.submission_errors += 1;
}

impl Default for FramePool {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backdrop_triangles_sit_on_the_far_plane() {
        let mut pool = FramePool::new();
        pool.queue_backdrop_triangle([[0.0, 0.0], [960.0, 0.0], [0.0, 544.0]], [0xff00_0000; 3]);
        assert_eq!(pool.backdrop.len(), 3);
        assert!(pool.backdrop.iter().all(|vertex| vertex.z == 0.0));
    }

    #[test]
    fn painter_sort_orders_far_to_near() {
        let triangle = |z: f32, color: u32| {
            [
                ColorVert {
                    color,
                    x: 0.0,
                    y: 0.0,
                    z,
                },
                ColorVert {
                    color,
                    x: 1.0,
                    y: 0.0,
                    z,
                },
                ColorVert {
                    color,
                    x: 0.0,
                    y: 1.0,
                    z,
                },
            ]
        };
        let mut vertices = Vec::new();
        vertices.extend_from_slice(&triangle(-10.0, 1));
        vertices.extend_from_slice(&triangle(-50.0, 2));
        vertices.extend_from_slice(&triangle(-30.0, 3));
        let mut sort_order = Vec::new();
        let mut sorted = Vec::new();
        FramePool::painter_sort(
            &mut vertices,
            Vec3::ZERO,
            Vec3::NEG_Z,
            &mut sort_order,
            &mut sorted,
        );
        let colors: Vec<u32> = vertices
            .iter()
            .step_by(3)
            .map(|vertex| vertex.color)
            .collect();
        assert_eq!(colors, [2, 3, 1]);

        let allocations = (
            sort_order.as_ptr(),
            sort_order.capacity(),
            sorted.as_ptr(),
            sorted.capacity(),
        );
        FramePool::painter_sort(
            &mut vertices,
            Vec3::ZERO,
            Vec3::NEG_Z,
            &mut sort_order,
            &mut sorted,
        );
        assert_eq!(
            allocations,
            (
                sort_order.as_ptr(),
                sort_order.capacity(),
                sorted.as_ptr(),
                sorted.capacity(),
            )
        );
    }

    #[test]
    fn reset_clears_every_staged_class() {
        let mut pool = FramePool::new();
        pool.queue_backdrop_triangle([[0.0; 2]; 3], [0; 3]);
        pool.opaque.push(ColorVert {
            color: 0,
            x: 0.0,
            y: 0.0,
            z: 0.0,
        });
        pool.last.triangles = 7;
        pool.reset();
        assert!(pool.backdrop.is_empty());
        assert!(pool.opaque.is_empty());
        assert!(pool.additive.is_empty());
        assert_eq!(pool.last, FrameStats::default());
    }

    #[test]
    fn backdrop_wvp_maps_screen_corners_to_clip_corners() {
        let mul = |m: &[f32; 16], v: [f32; 4]| {
            let mut out = [0.0f32; 4];
            for j in 0..4 {
                out[j] = (0..4).map(|i| v[i] * m[i * 4 + j]).sum();
            }
            out
        };
        let top_left = mul(&BACKDROP_WVP, [0.0, 0.0, 0.0, 1.0]);
        assert_eq!(&top_left[..2], &[-1.0, 1.0]);
        let bottom_right = mul(&BACKDROP_WVP, [960.0, 544.0, 0.0, 1.0]);
        assert_eq!(&bottom_right[..2], &[1.0, -1.0]);
        // The far plane (vertex z = 0) reaches NDC z = +1.
        assert_eq!(mul(&BACKDROP_WVP, [0.0, 0.0, 0.0, 1.0])[2], 1.0);
        assert_eq!(mul(&BACKDROP_WVP, [0.0, 0.0, 1.0, 1.0])[2], -1.0);
    }
}
