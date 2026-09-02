//! Commands the planner emits and an executor runs in painter order.
//!
//! Every rectangle and point is in physical target coordinates of the target
//! bound by [`crate::submit::Submit::begin`]. Commands never carry the
//! target itself; the executor bound it once and owns the pixels until
//! [`crate::submit::Frame::finish`].

use crate::geom::{Quad, Rect};

/// Source texture layout as stored by the PocketJS core.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PixelFormat {
    /// PSM_5650: RGB565 with red in the low bits.
    Psm5650,
    /// PSM_8888: R, G, B, A bytes.
    Rgba8888,
    /// PSM_T8: 8-bit indices into a 256 x u32 ABGR palette.
    T8Clut,
}

/// Texture sampling filter requested by the DrawList.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Filter {
    #[default]
    Nearest,
    Linear,
}

/// Axis flips applied to an axis-aligned blit.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mirror {
    pub x: bool,
    pub y: bool,
}

/// Identity modulate word (no color change, full alpha).
pub const MODULATE_NONE: u32 = 0xffff_ffff;

/// Where a blit reads its texels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TexSrc<'a> {
    /// A copy the executor registered earlier (its own format and memory).
    Native { id: u32 },
    /// The core's portable bytes, valid until the next fence.
    Portable {
        pixels: &'a [u8],
        /// 1024-byte ABGR palette for [`PixelFormat::T8Clut`].
        palette: Option<&'a [u8]>,
        width: u32,
        height: u32,
        format: PixelFormat,
    },
    /// One ABGR color covering the whole source rectangle.
    Solid { abgr: u32 },
}

impl TexSrc<'_> {
    pub fn format(&self) -> PixelFormat {
        match self {
            TexSrc::Native { .. } => PixelFormat::Rgba8888,
            TexSrc::Portable { format, .. } => *format,
            TexSrc::Solid { .. } => PixelFormat::Rgba8888,
        }
    }
}

/// One of the executor-owned A8 scratch planes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MaskId(pub u8);

/// One of the executor-owned RGB565 scratch tiles used for CPU fallback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TileId(pub u8);

/// A window into an A8 plane: byte `offset + y * stride + x` covers the
/// target pixel at `(rect.x + x, rect.y + y)` of the command's rectangle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MaskRef {
    pub mask: MaskId,
    pub offset: u32,
    pub stride: u32,
}

/// Gradient colors at the rectangle's corners, packed ABGR.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Corners {
    pub top_left: u32,
    pub top_right: u32,
    pub bottom_left: u32,
    pub bottom_right: u32,
}

/// One executor command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cmd<'a> {
    /// Opaque fill.
    Fill { dst: Rect, color: [u8; 3] },
    /// Solid color blended with `alpha` (src-over).
    FillAlpha { dst: Rect, color: [u8; 3], alpha: u8 },
    /// A8 coverage blended with one color; `alpha` scales every coverage
    /// byte.
    BlendA8 {
        dst: Rect,
        mask: MaskRef,
        color: [u8; 3],
        alpha: u8,
    },
    /// Two-axis linear gradient between four corner colors over `dst`.
    Gradient { dst: Rect, corners: Corners },
    /// Axis-aligned texture blit: `src_rect` texels scaled to `dst`, writes
    /// clipped to `clip` without changing the sampling phase.
    Blit {
        src: TexSrc<'a>,
        src_rect: Rect,
        dst: Rect,
        clip: Rect,
        mirror: Mirror,
        modulate: u32,
        filter: Filter,
    },
    /// Four-point texture blit: the edges of `src_rect` map to `quad`
    /// (TL, BL, BR, TR); writes clipped to `clip`.
    BlitQuad {
        src: TexSrc<'a>,
        src_rect: Rect,
        quad: Quad,
        clip: Rect,
        modulate: u32,
        filter: Filter,
    },
    /// Copy target pixels of `src` into a tightly packed tile.
    TileOut { tile: TileId, src: Rect },
    /// Copy a tightly packed tile back over `dst`.
    TileIn { tile: TileId, dst: Rect },
    /// Complete every earlier command before continuing.
    Fence,
}
