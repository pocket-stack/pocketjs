//! Dynamic untextured colored geometry for actors, effects and viewmodels.

use core::mem::{align_of, size_of};

use glam::Mat4;

use crate::{RenderError, Viewport};

/// OpenStrike-compatible colored vertex.
///
/// `color` is numeric ABGR (`0xAABBGGRR`); on the little-endian cooked
/// targets its bytes are normalized RGBA when fed to GLES.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ColorVertex {
    pub color: u32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

const _: () = assert!(size_of::<ColorVertex>() == 16);
const _: () = assert!(align_of::<ColorVertex>() <= 8);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BlendMode {
    /// Depth test + depth writes, no blending (bots and opaque models).
    Opaque,
    /// Source-alpha additive color, depth test with no depth writes
    /// (muzzle flashes, tracers and impact sprites).
    Additive,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DynamicCounters {
    /// Counters accumulate until [`DynamicRenderer::reset_counters`].
    pub triangles: u32,
    pub draw_calls: u32,
    pub opaque_draw_calls: u32,
    pub additive_draw_calls: u32,
    pub frame_clears: u32,
    pub depth_clears: u32,
    /// Current grow-only streaming VBO capacity.
    pub buffer_capacity_bytes: u32,
}

/// Reusable colored-triangle GLES2 renderer.
///
/// A single dynamic VBO grows geometrically to the largest submitted list and
/// is then updated with `glBufferSubData`; steady-state bot/effect/viewmodel
/// draws do not allocate GPU buffers.
pub struct DynamicRenderer {
    counters: DynamicCounters,
    last_gl_error: Option<u32>,
    #[cfg(target_os = "none")]
    gpu: Option<crate::gl::DynamicGpu>,
}

impl DynamicRenderer {
    pub const fn new() -> Self {
        Self {
            counters: DynamicCounters {
                triangles: 0,
                draw_calls: 0,
                opaque_draw_calls: 0,
                additive_draw_calls: 0,
                frame_clears: 0,
                depth_clears: 0,
                buffer_capacity_bytes: 0,
            },
            last_gl_error: None,
            #[cfg(target_os = "none")]
            gpu: None,
        }
    }

    pub fn counters(&self) -> DynamicCounters {
        self.counters
    }

    pub fn reset_counters(&mut self) {
        let capacity = self.counters.buffer_capacity_bytes;
        self.counters = DynamicCounters {
            buffer_capacity_bytes: capacity,
            ..DynamicCounters::default()
        };
    }

    /// Raw error from the most recent failed GLES call; cleared by a
    /// successful GPU operation or context reset.
    pub fn last_gl_error(&self) -> Option<u32> {
        self.last_gl_error
    }

    pub fn gpu_ready(&self) -> bool {
        #[cfg(target_os = "none")]
        {
            self.gpu.is_some()
        }
        #[cfg(not(target_os = "none"))]
        {
            false
        }
    }

    /// Compile the color pipeline and create its initially empty VBO.
    ///
    /// # Safety
    ///
    /// The intended GLES2 context must be current on the render thread.
    pub unsafe fn initialize_gpu(&mut self) -> Result<(), RenderError> {
        #[cfg(target_os = "none")]
        {
            if self.gpu.is_some() {
                return Ok(());
            }
            match crate::gl::DynamicGpu::new() {
                Ok(gpu) => {
                    self.gpu = Some(gpu);
                    self.last_gl_error = None;
                    Ok(())
                }
                Err(error) => {
                    self.capture_error(error);
                    Err(error)
                }
            }
        }
        #[cfg(not(target_os = "none"))]
        {
            Err(RenderError::UnsupportedHost)
        }
    }

    /// Draw one unindexed triangle list with `model` and `view_proj`.
    ///
    /// # Safety
    ///
    /// The renderer's GLES2 context must be current on this thread.
    pub unsafe fn draw_color_tris(
        &mut self,
        vertices: &[ColorVertex],
        model: Mat4,
        view_proj: Mat4,
        mode: BlendMode,
    ) -> Result<DynamicCounters, RenderError> {
        if !vertices.len().is_multiple_of(3) || vertices.len() > i32::MAX as usize {
            return Err(RenderError::InvalidTriangleList);
        }

        #[cfg(target_os = "none")]
        {
            let Some(gpu) = self.gpu.as_mut() else {
                return Err(RenderError::NotInitialized);
            };
            match gpu.draw_color_tris(
                vertices,
                &model.to_cols_array(),
                &view_proj.to_cols_array(),
                mode,
            ) {
                Ok(()) => {
                    if !vertices.is_empty() {
                        let triangles = (vertices.len() / 3) as u32;
                        self.counters.triangles = self.counters.triangles.saturating_add(triangles);
                        self.counters.draw_calls = self.counters.draw_calls.saturating_add(1);
                        match mode {
                            BlendMode::Opaque => {
                                self.counters.opaque_draw_calls =
                                    self.counters.opaque_draw_calls.saturating_add(1);
                            }
                            BlendMode::Additive => {
                                self.counters.additive_draw_calls =
                                    self.counters.additive_draw_calls.saturating_add(1);
                            }
                        }
                    }
                    self.counters.buffer_capacity_bytes =
                        gpu.buffer_capacity().min(u32::MAX as usize) as u32;
                    self.last_gl_error = None;
                    Ok(self.counters)
                }
                Err(error) => {
                    self.capture_error(error);
                    Err(error)
                }
            }
        }
        #[cfg(not(target_os = "none"))]
        {
            let _ = (vertices, model, view_proj, mode);
            Err(RenderError::UnsupportedHost)
        }
    }

    /// Clear the native color surface, and optionally depth, before a menu or
    /// loading-screen UI frame that has no world draw.
    ///
    /// This does not require the dynamic shader/VBO to be initialized.
    ///
    /// # Safety
    ///
    /// The intended GLES2 context must be current on this thread.
    pub unsafe fn clear_frame(
        &mut self,
        viewport: Viewport,
        color: [f32; 4],
        clear_depth: bool,
    ) -> Result<DynamicCounters, RenderError> {
        if !viewport.valid() {
            return Err(RenderError::InvalidViewport);
        }
        #[cfg(target_os = "none")]
        {
            match crate::gl::clear_frame(viewport, Some(color), clear_depth) {
                Ok(()) => {
                    self.counters.frame_clears = self.counters.frame_clears.saturating_add(1);
                    self.last_gl_error = None;
                    Ok(self.counters)
                }
                Err(error) => {
                    self.capture_error(error);
                    Err(error)
                }
            }
        }
        #[cfg(not(target_os = "none"))]
        {
            let _ = (viewport, color, clear_depth);
            Err(RenderError::UnsupportedHost)
        }
    }

    /// Clear only depth before the first-person model pass.
    ///
    /// # Safety
    ///
    /// The renderer's GLES2 context must be current.
    pub unsafe fn clear_depth_for_viewmodel(&mut self) -> Result<DynamicCounters, RenderError> {
        #[cfg(target_os = "none")]
        {
            let Some(gpu) = self.gpu.as_mut() else {
                return Err(RenderError::NotInitialized);
            };
            match gpu.clear_depth_for_viewmodel() {
                Ok(()) => {
                    self.counters.depth_clears = self.counters.depth_clears.saturating_add(1);
                    self.last_gl_error = None;
                    Ok(self.counters)
                }
                Err(error) => {
                    self.capture_error(error);
                    Err(error)
                }
            }
        }
        #[cfg(not(target_os = "none"))]
        {
            Err(RenderError::UnsupportedHost)
        }
    }

    /// Delete resources through their live owning context.
    ///
    /// # Safety
    ///
    /// The original context must be current and no queued draw may reference
    /// this renderer.
    pub unsafe fn shutdown_gpu(&mut self) -> Result<(), RenderError> {
        #[cfg(target_os = "none")]
        {
            if let Some(gpu) = self.gpu.take() {
                gpu.destroy();
            }
            self.counters.buffer_capacity_bytes = 0;
            self.last_gl_error = None;
            Ok(())
        }
        #[cfg(not(target_os = "none"))]
        {
            Err(RenderError::UnsupportedHost)
        }
    }

    /// Forget handles after external EGL context destruction, without GL.
    pub fn abandon_lost_context(&mut self) {
        #[cfg(target_os = "none")]
        {
            let _ = self.gpu.take();
        }
        self.counters.buffer_capacity_bytes = 0;
        self.last_gl_error = None;
    }

    #[cfg(target_os = "none")]
    fn capture_error(&mut self, error: RenderError) {
        if let RenderError::Gl(code) = error {
            self.last_gl_error = Some(code);
        }
    }
}

impl Default for DynamicRenderer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_vertex_matches_openstrike_layout_and_alignment() {
        let vertex = ColorVertex {
            color: 0xff11_2233,
            x: 1.0,
            y: 2.0,
            z: 3.0,
        };
        let base = &vertex as *const ColorVertex as usize;
        assert_eq!(size_of::<ColorVertex>(), 16);
        assert!(align_of::<ColorVertex>() <= 8);
        assert_eq!((&vertex.color as *const u32 as usize) - base, 0);
        assert_eq!((&vertex.x as *const f32 as usize) - base, 4);
        assert_eq!((&vertex.y as *const f32 as usize) - base, 8);
        assert_eq!((&vertex.z as *const f32 as usize) - base, 12);
        assert_eq!(vertex.color.to_le_bytes(), [0x33, 0x22, 0x11, 0xff]);
    }

    #[test]
    fn rejects_non_triangle_lists_before_gpu_access() {
        let mut renderer = DynamicRenderer::new();
        let vertices = [ColorVertex {
            color: 0xffff_ffff,
            x: 0.0,
            y: 0.0,
            z: 0.0,
        }; 2];
        assert_eq!(
            unsafe {
                renderer.draw_color_tris(
                    &vertices,
                    Mat4::IDENTITY,
                    Mat4::IDENTITY,
                    BlendMode::Opaque,
                )
            },
            Err(RenderError::InvalidTriangleList)
        );
    }

    #[cfg(not(target_os = "none"))]
    #[test]
    fn host_path_is_explicitly_unsupported_without_gl_symbols() {
        let mut renderer = DynamicRenderer::new();
        let vertices = [ColorVertex {
            color: 0xffff_ffff,
            x: 0.0,
            y: 0.0,
            z: 0.0,
        }; 3];
        assert_eq!(
            unsafe { renderer.initialize_gpu() },
            Err(RenderError::UnsupportedHost)
        );
        assert_eq!(
            unsafe {
                renderer.draw_color_tris(
                    &vertices,
                    Mat4::IDENTITY,
                    Mat4::IDENTITY,
                    BlendMode::Additive,
                )
            },
            Err(RenderError::UnsupportedHost)
        );
        assert_eq!(
            unsafe { renderer.clear_depth_for_viewmodel() },
            Err(RenderError::UnsupportedHost)
        );
        assert_eq!(
            unsafe {
                renderer.clear_frame(
                    crate::Viewport::new(0, 0, 640, 360),
                    [0.0, 0.0, 0.0, 1.0],
                    true,
                )
            },
            Err(RenderError::UnsupportedHost)
        );
        assert_eq!(
            unsafe { renderer.shutdown_gpu() },
            Err(RenderError::UnsupportedHost)
        );
        assert!(!renderer.gpu_ready());
        assert_eq!(renderer.counters(), DynamicCounters::default());
        assert_eq!(renderer.last_gl_error(), None);
    }
}
