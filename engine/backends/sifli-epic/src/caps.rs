//! What a hardware executor can do, decided before any command is built.
//!
//! The planner reads [`Capabilities`] once per frame and never issues a
//! command the executor cannot run; executors therefore do not "try and
//! decline". On the SiFli host the values come from the chip's SDK feature
//! gates (`bf0_hal_epic.h`) plus the VG Lite Kconfig; the presets below are
//! for tests and documentation.

/// Hardware engine that runs a command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    /// EPIC 2.5D blitter (SF32LB5x).
    Epic,
    /// VG Lite vector GPU (SF32LB58 only).
    VgLite,
}

/// Source texture layouts an engine reads directly.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Formats {
    /// PocketJS PSM_5650: RGB565 with red in the low bits.
    pub psm5650: bool,
    /// PocketJS PSM_8888: R, G, B, A byte order.
    pub rgba8888: bool,
    /// PocketJS PSM_T8: 8-bit indices plus a 256-entry ABGR palette.
    pub t8_clut: bool,
}

impl Formats {
    pub const NONE: Formats = Formats {
        psm5650: false,
        rgba8888: false,
        t8_clut: false,
    };
    pub const ALL: Formats = Formats {
        psm5650: true,
        rgba8888: true,
        t8_clut: true,
    };
}

/// Physical-pixel thresholds below which transaction overhead is not worth
/// paying and the CPU path is used instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Thresholds {
    pub min_fill: u32,
    pub min_gradient: u32,
    pub min_blend: u32,
    pub min_blit: u32,
}

impl Thresholds {
    /// Every operation goes to hardware; used by tests.
    pub const ALWAYS: Thresholds = Thresholds {
        min_fill: 1,
        min_gradient: 1,
        min_blend: 1,
        min_blit: 1,
    };
}

impl Default for Thresholds {
    fn default() -> Self {
        Thresholds {
            min_fill: 1024,
            min_gradient: 1024,
            min_blend: 256,
            min_blit: 256,
        }
    }
}

/// Capabilities of one executor, read by the planner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capabilities {
    /// Opaque rectangle fills.
    pub fill_opaque: bool,
    /// Translucent solid fills blended in hardware (EPIC MONO layer).
    pub fill_alpha: bool,
    /// A8 coverage planes blended with one fixed color.
    pub a8_blend: bool,
    /// Opaque two-stop linear gradients covering an unclipped rectangle.
    pub gradient: bool,
    /// Opaque PSM_5650 texture copies at 1:1 (with mirroring), or scaled
    /// when the texture requests bilinear sampling.
    pub copy_psm5650: bool,
    /// Axis-aligned texture blits with scaling, mirroring, and modulation for
    /// the listed formats.
    pub blit: Formats,
    /// Four-point (affine or projective) texture blits for the listed
    /// formats, including solid-color quads.
    pub blit_quad: Formats,
    /// Axis-aligned blits of textures the executor registered natively
    /// (`Frame::native_texture`), whatever their portable format.
    pub blit_native: bool,
    /// Four-point blits of natively registered textures.
    pub blit_quad_native: bool,
    /// Blits may multiply texels by the DrawList's RGB modulate color. When
    /// false only the modulate alpha is honoured and tinted blits stay on
    /// the CPU.
    pub blit_modulate: bool,
    /// Largest transaction extent in physical pixels per axis (EPIC
    /// coordinate registers); `u32::MAX` when unlimited.
    pub coordinate_limit: u32,
    /// The CPU may write the bound target directly after a fence. When
    /// false, CPU fallback renders into executor-owned tiles that hardware
    /// copies out of and back into the target.
    pub direct_cpu_writes: bool,
    /// Bytes per executor-owned A8 plane. 0 means every plane covers the
    /// whole target; otherwise A8 runs are split into row bands that fit.
    pub mask_tile_bytes: u32,
    /// Physical pixels per executor-owned RGB565 tile used for CPU fallback
    /// when `direct_cpu_writes` is false. CPU batches are split into row
    /// bands that fit.
    pub cpu_tile_pixels: u32,
    pub thresholds: Thresholds,
}

impl Capabilities {
    /// Everything on the CPU: the ordered software rasterizer only.
    pub const NONE: Capabilities = Capabilities {
        fill_opaque: false,
        fill_alpha: false,
        a8_blend: false,
        gradient: false,
        copy_psm5650: false,
        blit: Formats::NONE,
        blit_quad: Formats::NONE,
        blit_native: false,
        blit_quad_native: false,
        blit_modulate: false,
        coordinate_limit: u32::MAX,
        direct_cpu_writes: true,
        mask_tile_bytes: 0,
        cpu_tile_pixels: 0,
        thresholds: Thresholds::ALWAYS,
    };

    /// SF32LB58 EPIC: fills, MONO-layer alpha fills, A8 blends, corner
    /// gradients, axis-aligned VL blits of natively formatted textures. No
    /// color matrix (portable PSM_5650/PSM_8888 need native copies) and no
    /// 3x3 transform matrix. The framebuffer is GPU-only, so CPU fallback
    /// round-trips through 64 KB SRAM tiles and A8 planes are 64 KB bands.
    pub const SF32LB58X: Capabilities = Capabilities {
        fill_opaque: true,
        fill_alpha: true,
        a8_blend: true,
        gradient: true,
        copy_psm5650: false,
        blit: Formats::NONE,
        blit_quad: Formats::NONE,
        blit_native: true,
        blit_quad_native: false,
        blit_modulate: false,
        coordinate_limit: 1010,
        direct_cpu_writes: false,
        mask_tile_bytes: 64 * 1024,
        cpu_tile_pixels: 32 * 1024,
        thresholds: Thresholds {
            min_fill: 64,
            min_gradient: 64,
            min_blend: 64,
            min_blit: 64,
        },
    };

    /// SF32LB58 with VG Lite: adds modulated/bilinear axis-aligned blits and
    /// projective quads for every portable format.
    pub const SF32LB58X_VGLITE: Capabilities = Capabilities {
        blit: Formats::ALL,
        blit_quad: Formats::ALL,
        blit_quad_native: true,
        blit_modulate: true,
        ..Capabilities::SF32LB58X
    };

    /// Does any engine blit this texture format axis-aligned?
    pub fn blits(&self, format: crate::cmd::PixelFormat) -> bool {
        self.blit.accepts(format)
    }

    /// Does any engine blit this texture format through a four-point quad?
    pub fn blits_quad(&self, format: crate::cmd::PixelFormat) -> bool {
        self.blit_quad.accepts(format)
    }
}

impl Formats {
    pub fn accepts(&self, format: crate::cmd::PixelFormat) -> bool {
        match format {
            crate::cmd::PixelFormat::Psm5650 => self.psm5650,
            crate::cmd::PixelFormat::Rgba8888 => self.rgba8888,
            crate::cmd::PixelFormat::T8Clut => self.t8_clut,
        }
    }
}

impl Default for Capabilities {
    fn default() -> Self {
        Capabilities::SF32LB58X
    }
}
