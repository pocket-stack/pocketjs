//! Frame, incremental, and strip rendering over any [`Submit`] executor.

use alloc::vec::Vec;

use pocketjs_core::damage::{
    DamagePlan, DamagePolicy, DamageTarget, DamageTracker, DEFAULT_DAMAGE_REGIONS,
};
use pocketjs_core::Ui;

use crate::emit::Context;
use crate::geom::{local_physical_rect, physical_rect, Clip, Rect};
use crate::plan::{self, PlanItem};
use crate::submit::{Frame, Submit, TargetKind};

const MAX_DAMAGE_REGIONS: usize = DEFAULT_DAMAGE_REGIONS;
const FULL_REDRAW_PERCENT: u8 = 75;
const DAMAGE_TARGET_SIGNATURE: u64 = u32::from_be_bytes(*b"EPC6") as u64;

/// Renderer configuration. Executor capabilities come from the executor
/// itself ([`Submit::caps`]); the renderer only needs the integer scale.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RendererConfig {
    /// Physical pixels per logical pixel (1 through 4).
    pub scale: u32,
}

impl Default for RendererConfig {
    fn default() -> Self {
        RendererConfig { scale: 1 }
    }
}

/// Per-frame backend accounting for profiling and regression logs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RenderStats {
    /// Opaque and translucent solid fills submitted to hardware.
    pub epic_fills: u32,
    pub epic_gradients: u32,
    /// A8 coverage blends.
    pub epic_blends: u32,
    /// Texture blits and four-point quads.
    pub epic_copies: u32,
    /// DrawList operations rendered by the core rasterizer.
    pub software_ops: u32,
    pub software_words: u32,
    /// Number of disjoint physical framebuffer regions repainted.
    pub damage_regions: u32,
    /// Total physical pixels repainted across all damage regions.
    pub damage_pixels: u32,
    /// Bounding rectangle of every repainted physical region.
    pub damage_bounds: Rect,
    /// True for an initial, invalidated, or heuristically promoted full frame.
    pub full_redraw: bool,
    /// True only when the 75% damage policy promoted a partial plan to full.
    pub full_redraw_promoted: bool,
    /// Fences issued before CPU work or plane reuse.
    pub fences: u32,
    /// CPU fallback tile round-trips and the physical pixels they copied.
    pub cpu_tiles: u32,
    pub cpu_tile_pixels: u32,
    /// A8 runs split across more than one plane band (bands counted).
    pub mask_bands: u32,
}

/// Core damage snapshot describing the pixels stored in one framebuffer.
pub type RenderTargetState = DamageTracker<MAX_DAMAGE_REGIONS>;

/// Damage plan produced for one persistent render target.
pub type RenderDamagePlan = DamagePlan<MAX_DAMAGE_REGIONS>;

/// Persistent DrawList renderer. The plan and fallback buffers are reused
/// across frames.
pub struct Renderer {
    config: RendererConfig,
    plan: Vec<PlanItem>,
    fallback_words: Vec<u32>,
    mask_index: u8,
}

impl Renderer {
    pub fn new(config: RendererConfig) -> Option<Self> {
        if !(1..=pocketjs_core::raster::MAX_RENDER_SCALE).contains(&config.scale) {
            return None;
        }
        Some(Self {
            config,
            plan: Vec::with_capacity(64),
            fallback_words: Vec::with_capacity(64),
            mask_index: 0,
        })
    }

    pub fn config(&self) -> RendererConfig {
        self.config
    }

    /// Kept for host compatibility. Texture classification lives in the
    /// core (`Ui::texture_coverage_only`), so the renderer holds no derived
    /// resource state; framebuffer states must still be invalidated
    /// separately after output-affecting changes performed outside `Ui`.
    pub fn invalidate_resources(&mut self) {}

    /// Render a complete DrawList. `destination` dimensions must equal the
    /// UI viewport multiplied by `config.scale`.
    pub fn render<G: Submit>(
        &mut self,
        ui: &Ui,
        words: &[u32],
        destination: &mut [u16],
        width: u32,
        height: u32,
        gpu: &mut G,
    ) -> Option<RenderStats> {
        let screen = self.target_screen(ui, destination, width, height)?;
        let damage = DamagePlan::<MAX_DAMAGE_REGIONS>::full(screen);
        self.render_damage(
            ui,
            words,
            destination,
            width,
            height,
            &damage,
            true,
            false,
            gpu,
        )
    }

    /// Compute damage against the DrawList last committed to `target`.
    ///
    /// This does not mutate `target`. Call [`commit_damage`](Self::commit_damage)
    /// only after every corresponding output update has completed successfully,
    /// or [`abort_damage`](Self::abort_damage) after a failed/partial update.
    pub fn prepare_damage(
        &mut self,
        target: &RenderTargetState,
        ui: &Ui,
        words: &[u32],
    ) -> Option<RenderDamagePlan> {
        self.prepare_damage_with_reason(target, ui, words)
            .map(|(damage, _)| damage)
    }

    fn prepare_damage_with_reason(
        &mut self,
        target: &RenderTargetState,
        ui: &Ui,
        words: &[u32],
    ) -> Option<(RenderDamagePlan, bool)> {
        let damage_target = self.damage_target(ui)?;
        let raw = target.prepare(ui, words, damage_target).ok()?;
        let was_full = raw.is_full_redraw();
        let damage = raw
            .with_policy(DamagePolicy::new(FULL_REDRAW_PERCENT))
            .ok()?;
        let promoted = !was_full && damage.is_full_redraw();
        Some((damage, promoted))
    }

    /// Record a successfully presented DrawList in one persistent target.
    pub fn commit_damage(&self, target: &mut RenderTargetState, ui: &Ui, words: &[u32]) -> bool {
        let Some(damage_target) = self.damage_target(ui) else {
            target.invalidate();
            return false;
        };
        target.commit(ui, words, damage_target);
        true
    }

    /// Invalidate a persistent target after an aborted or partial update.
    pub fn abort_damage(&self, target: &mut RenderTargetState) {
        target.invalidate();
    }

    /// Repaint only pixels whose DrawList operations differ from the snapshot
    /// stored in `target`.
    ///
    /// The destination must retain the pixels produced by the same
    /// `RenderTargetState`; multi-buffered hosts therefore keep one state per
    /// buffer. Structural DrawList changes damage every unmatched old/new
    /// operation, while invalidated resources and damage covering most of the
    /// screen conservatively fall back to a full redraw.
    #[allow(clippy::too_many_arguments)]
    pub fn render_incremental<G: Submit>(
        &mut self,
        target: &mut RenderTargetState,
        ui: &Ui,
        words: &[u32],
        destination: &mut [u16],
        width: u32,
        height: u32,
        gpu: &mut G,
    ) -> Option<RenderStats> {
        self.target_screen(ui, destination, width, height)?;
        let (damage, promoted) = self.prepare_damage_with_reason(target, ui, words)?;
        let full_redraw = damage.is_full_redraw();

        let result = self.render_damage(
            ui,
            words,
            destination,
            width,
            height,
            &damage,
            full_redraw,
            promoted,
            gpu,
        );
        if result.is_some() {
            if !self.commit_damage(target, ui, words) {
                return None;
            }
        } else {
            self.abort_damage(target);
        }
        result
    }

    /// Render one global logical dirty rectangle into a tightly packed
    /// full-width horizontal strip.
    ///
    /// `region.y..region.y + region.h` defines both the strip's global vertical
    /// interval and its height. The backing buffer is
    /// `viewport_width * region.h` pixels at `config.scale`; pixels outside
    /// `region.x..region.x + region.w` are left untouched. DrawList geometry and
    /// sampling remain in global viewport coordinates while all hardware
    /// rectangles and mask offsets are translated to strip-local coordinates.
    pub fn render_strip<G: Submit>(
        &mut self,
        ui: &Ui,
        words: &[u32],
        destination: &mut [u16],
        region: Rect,
        gpu: &mut G,
    ) -> Option<RenderStats> {
        if region.is_empty() {
            return None;
        }
        let (viewport_w, viewport_h) = ui.viewport();
        let logical_width = viewport_w as u32;
        let logical_height = viewport_h as u32;
        let x1 = region.x.checked_add(region.w)?;
        let y1 = region.y.checked_add(region.h)?;
        if logical_width == 0 || logical_height == 0 || x1 > logical_width || y1 > logical_height {
            return None;
        }

        let scale = self.config.scale;
        let width = logical_width.checked_mul(scale)?;
        let height = region.h.checked_mul(scale)?;
        if destination.len() != width as usize * height as usize {
            return None;
        }

        let screen = Clip::new(0, 0, logical_width as i32, logical_height as i32);
        let surface = Clip {
            x0: 0,
            y0: region.y as i32,
            x1: logical_width as i32,
            y1: y1 as i32,
        };
        let clip = Clip {
            x0: region.x as i32,
            y0: region.y as i32,
            x1: x1 as i32,
            y1: y1 as i32,
        };
        let mut stats = RenderStats {
            damage_regions: 1,
            damage_pixels: region.area().saturating_mul(scale).saturating_mul(scale),
            damage_bounds: physical_rect(clip, scale),
            ..RenderStats::default()
        };

        plan::build(ui, words, screen, &mut self.plan)?;
        let caps = *gpu.caps();
        let mut frame = gpu
            .begin(destination, width, height, TargetKind::Strip)
            .ok()?;
        let rendered = {
            let mut context = Context::new(
                caps,
                scale,
                surface,
                surface == screen,
                &mut stats,
                &mut self.fallback_words,
                &mut self.mask_index,
            );
            context
                .clear_region(ui, &mut frame, clip)
                .and_then(|()| context.emit_region(ui, words, &self.plan, &mut frame, clip))
        };
        let finished = frame.finish().is_ok();
        (rendered.is_some() && finished).then_some(stats)
    }

    fn damage_target(&self, ui: &Ui) -> Option<DamageTarget> {
        let scale = self.config.scale;
        let (viewport_w, viewport_h) = ui.viewport();
        let width = (viewport_w as u32).checked_mul(scale)?;
        let height = (viewport_h as u32).checked_mul(scale)?;
        if width == 0 || height == 0 {
            return None;
        }
        Some(DamageTarget::new(
            width,
            height,
            scale,
            DAMAGE_TARGET_SIGNATURE,
        ))
    }

    fn target_screen(&self, ui: &Ui, destination: &[u16], width: u32, height: u32) -> Option<Clip> {
        let scale = self.config.scale;
        let (viewport_w, viewport_h) = ui.viewport();
        if viewport_w as u32 * scale != width
            || viewport_h as u32 * scale != height
            || destination.len() != width as usize * height as usize
        {
            return None;
        }
        Some(Clip {
            x0: 0,
            y0: 0,
            x1: viewport_w as i32,
            y1: viewport_h as i32,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn render_damage<G: Submit>(
        &mut self,
        ui: &Ui,
        words: &[u32],
        destination: &mut [u16],
        width: u32,
        height: u32,
        damage: &DamagePlan<MAX_DAMAGE_REGIONS>,
        full_redraw: bool,
        full_redraw_promoted: bool,
        gpu: &mut G,
    ) -> Option<RenderStats> {
        let scale = self.config.scale;
        let surface = Clip {
            x0: 0,
            y0: 0,
            x1: (width / scale) as i32,
            y1: (height / scale) as i32,
        };
        let mut stats = RenderStats {
            damage_regions: damage.region_count() as u32,
            damage_pixels: damage
                .area()
                .saturating_mul(scale as u64)
                .saturating_mul(scale as u64)
                .min(u32::MAX as u64) as u32,
            damage_bounds: physical_rect(damage.bounds(), scale),
            full_redraw,
            full_redraw_promoted,
            ..RenderStats::default()
        };
        if damage.is_empty() {
            return Some(stats);
        }

        plan::build(ui, words, surface, &mut self.plan)?;
        let caps = *gpu.caps();
        let mut frame = gpu
            .begin(destination, width, height, TargetKind::Framebuffer)
            .ok()?;
        let rendered = {
            let mut context = Context::new(
                caps,
                scale,
                surface,
                true,
                &mut stats,
                &mut self.fallback_words,
                &mut self.mask_index,
            );
            let mut rendered = Some(());
            for &region in damage.regions() {
                if local_physical_rect(region, surface, scale).is_empty() {
                    continue;
                }
                rendered = context
                    .clear_region(ui, &mut frame, region)
                    .and_then(|()| context.emit_region(ui, words, &self.plan, &mut frame, region));
                if rendered.is_none() {
                    break;
                }
            }
            rendered
        };
        let finished = frame.finish().is_ok();
        (rendered.is_some() && finished).then_some(stats)
    }
}
