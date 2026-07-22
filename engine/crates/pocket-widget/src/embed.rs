//! A PocketJS `ui` surface embedded in a 3D widget.
//!
//! The core renders off-window into an [`OffscreenTarget`] whose texture
//! view binds onto any mesh via `ModelAsset::from_geometry_textured` — the
//! screen inside a widget is a real app, not a video. The per-tick DrawList
//! content hash doubles as the dirty signal: an app showing a settled frame
//! re-renders nothing, which is the heart of the shell's demand rendering.

use anyhow::Result;
use pocket_ui_wgpu::{UiRenderer, UiSurface};
use pocket3d::gpu::{Gpu, OFFSCREEN_FORMAT, OffscreenTarget};

pub struct EmbeddedUi {
    surface: UiSurface,
    renderer: UiRenderer,
    target: OffscreenTarget,
    px: (u32, u32),
    logical_to_physical_scale: f32,
    /// The DrawList words of the latest tick (what render draws).
    words: Vec<u32>,
    hash: u64,
    /// The target holds a frame older than `words`.
    texture_dirty: bool,
}

impl EmbeddedUi {
    /// Wrap a booted surface (pak fed, mounted, bundle evaluated) with a
    /// render target of `px` pixels. For 1:1 rendering `px` must equal the
    /// surface's logical viewport — (480, 272) for stock PSP apps.
    pub fn new(gpu: &Gpu, surface: UiSurface, px: (u32, u32)) -> EmbeddedUi {
        Self::new_with_scale(gpu, surface, px, 1.0)
    }

    /// Wrap a density-N surface in a physical target. DrawList coordinates
    /// stay logical while font/image assets and the output target use N×
    /// pixels, matching the Vita/Retina presentation model.
    pub fn new_with_scale(
        gpu: &Gpu,
        surface: UiSurface,
        px: (u32, u32),
        logical_to_physical_scale: f32,
    ) -> EmbeddedUi {
        EmbeddedUi {
            surface,
            renderer: UiRenderer::new(gpu, OFFSCREEN_FORMAT),
            target: OffscreenTarget::new(gpu, px.0, px.1),
            px,
            logical_to_physical_scale,
            words: Vec::new(),
            hash: 0,
            texture_dirty: true,
        }
    }

    /// Advance the core one frame — call once per host tick, after the
    /// guest turn. Returns true when the DrawList changed, i.e. the widget
    /// needs a GPU frame to show it.
    pub fn tick(&mut self) -> bool {
        self.surface.tick();
        let (hash, words) = self.surface.with_ui(|ui| {
            let words = &ui.draw().words;
            let hash = fnv1a64(words);
            (hash, (hash != self.hash).then(|| words.clone()))
        });
        let Some(words) = words else { return false };
        self.words = words;
        self.hash = hash;
        self.texture_dirty = true;
        true
    }

    /// Render the latest DrawList into the target if it changed since the
    /// last render (self-submitting; call before the scene pass that samples
    /// the texture). Returns whether a pass was recorded.
    pub fn render_if_dirty(&mut self, gpu: &Gpu) -> Result<bool> {
        if !self.texture_dirty {
            return Ok(false);
        }
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        self.surface.with_ui(|ui| {
            self.renderer.render_words_scaled(
                gpu,
                ui,
                &self.words,
                &mut encoder,
                &self.target.view,
                self.px,
                self.logical_to_physical_scale,
                wgpu::LoadOp::Clear(wgpu::Color::BLACK),
            )
        })?;
        gpu.queue.submit([encoder.finish()]);
        self.texture_dirty = false;
        Ok(true)
    }

    /// The texture view a screen mesh's material binds.
    pub fn view(&self) -> &wgpu::TextureView {
        &self.target.view
    }

    /// The render target (headless capture: `read_rgba` / `save_png`).
    pub fn target(&self) -> &OffscreenTarget {
        &self.target
    }

    pub fn surface(&self) -> &UiSurface {
        &self.surface
    }

    pub fn size(&self) -> (u32, u32) {
        self.px
    }

    /// Deterministic hash of the most recent DrawList. Headless products can
    /// pin this as an app-state acceptance without reading GPU pixels.
    pub fn content_hash(&self) -> u64 {
        self.hash
    }
}

/// FNV-1a 64 over the DrawList words. Texture contents are covered too:
/// handles in the words are generation-tagged, so re-uploaded pixels change
/// the handle and therefore the hash.
fn fnv1a64(words: &[u32]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for w in words {
        for b in w.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

#[cfg(test)]
mod tests {
    use super::fnv1a64;

    #[test]
    fn hash_distinguishes_word_streams() {
        assert_ne!(fnv1a64(&[1, 2, 3]), fnv1a64(&[1, 2, 4]));
        assert_ne!(fnv1a64(&[]), fnv1a64(&[0]));
        assert_eq!(fnv1a64(&[7, 7]), fnv1a64(&[7, 7]));
    }

    #[test]
    fn hash_is_order_sensitive() {
        assert_ne!(fnv1a64(&[1, 2]), fnv1a64(&[2, 1]));
    }
}
