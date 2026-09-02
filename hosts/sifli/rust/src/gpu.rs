//! The `Submit` executor over the C command queue (`include/pocketjs_gpu.h`).
//!
//! Commands are translated into `PocketjsGpuCmd` records and handed to the
//! C driver in fixed-size batches; masks and tiles are driver-owned SRAM the
//! driver exposes by id. Struct layouts are mirrored from the header and
//! size-checked at compile time for the firmware target.

use core::slice;

use pocketjs_sifli_epic::{
    Capabilities, Cmd, Filter, Formats, Frame, MaskId, PixelFormat, Point, Rect, Submit,
    SubmitError, TargetKind, TexSrc, Thresholds, TileId,
};

pub const ABI_VERSION: u32 = 1;

const CAP_FILL_OPAQUE: u32 = 1 << 0;
const CAP_FILL_ALPHA: u32 = 1 << 1;
const CAP_A8_BLEND: u32 = 1 << 2;
const CAP_GRADIENT: u32 = 1 << 3;
const CAP_COPY_PSM5650: u32 = 1 << 4;
const CAP_DIRECT_CPU_WRITES: u32 = 1 << 5;
const CAP_BLIT_NATIVE: u32 = 1 << 6;
const CAP_BLIT_QUAD_NATIVE: u32 = 1 << 7;
const CAP_BLIT_MODULATE: u32 = 1 << 8;

const FORMAT_PSM5650: u32 = 1 << 0;
const FORMAT_RGBA8888: u32 = 1 << 1;
const FORMAT_T8CLUT: u32 = 1 << 2;

const OP_FILL: u32 = 1;
const OP_FILL_ALPHA: u32 = 2;
const OP_BLEND_A8: u32 = 3;
const OP_GRADIENT: u32 = 4;
const OP_BLIT: u32 = 5;
const OP_BLIT_QUAD: u32 = 6;
const OP_TILE_OUT: u32 = 7;
const OP_TILE_IN: u32 = 8;
const OP_FENCE: u32 = 9;

const FLAG_MIRROR_X: u32 = 1 << 0;
const FLAG_MIRROR_Y: u32 = 1 << 1;
const FLAG_LINEAR: u32 = 1 << 2;

const SRC_PORTABLE: u32 = 0;
const SRC_NATIVE: u32 = 1;
const SRC_SOLID: u32 = 2;

const PIXEL_PSM5650: u32 = 0;
const PIXEL_RGBA8888: u32 = 1;
const PIXEL_T8CLUT: u32 = 2;

const TARGET_FRAMEBUFFER: u32 = 0;
const TARGET_STRIP: u32 = 1;

const GPU_FAILED: i32 = -0x7fff;

/// Commands per `pocketjs_gpu_submit` call.
const BATCH: usize = 32;

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct RawCaps {
    abi_version: u32,
    flags: u32,
    blit_formats: u32,
    blit_quad_formats: u32,
    coordinate_limit: u32,
    mask_tile_bytes: u32,
    cpu_tile_pixels: u32,
    min_fill: u32,
    min_gradient: u32,
    min_blend: u32,
    min_blit: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct RawRect {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct RawPoint {
    x: i32,
    y: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct RawCmd {
    op: u32,
    flags: u32,
    dst: RawRect,
    clip: RawRect,
    src: RawRect,
    quad: [RawPoint; 4],
    color: u32,
    corners: [u32; 4],
    src_kind: u32,
    src_id: u32,
    src_pixels: *const u8,
    src_len: usize,
    src_palette: *const u8,
    src_width: u32,
    src_height: u32,
    src_format: u32,
    mask_id: u32,
    mask_offset: u32,
    mask_stride: u32,
    tile_id: u32,
}

#[cfg(target_pointer_width = "32")]
const _: () = assert!(core::mem::size_of::<RawCmd>() == 156);
#[cfg(target_pointer_width = "64")]
const _: () = assert!(core::mem::size_of::<RawCmd>() == 176);
const _: () = assert!(core::mem::size_of::<RawCaps>() == 44);

impl Default for RawCmd {
    fn default() -> Self {
        RawCmd {
            op: 0,
            flags: 0,
            dst: RawRect::default(),
            clip: RawRect::default(),
            src: RawRect::default(),
            quad: [RawPoint::default(); 4],
            color: 0,
            corners: [0; 4],
            src_kind: SRC_PORTABLE,
            src_id: 0,
            src_pixels: core::ptr::null(),
            src_len: 0,
            src_palette: core::ptr::null(),
            src_width: 0,
            src_height: 0,
            src_format: 0,
            mask_id: 0,
            mask_offset: 0,
            mask_stride: 0,
            tile_id: 0,
        }
    }
}

extern "C" {
    fn pocketjs_gpu_caps(out: *mut RawCaps) -> i32;
    fn pocketjs_gpu_begin(
        target: *mut u16,
        pixels: usize,
        width: u32,
        height: u32,
        kind: u32,
    ) -> i32;
    fn pocketjs_gpu_submit(cmds: *const RawCmd, count: usize) -> i32;
    fn pocketjs_gpu_fence() -> i32;
    fn pocketjs_gpu_end() -> i32;
    fn pocketjs_gpu_mask(id: u32, len: *mut usize) -> *mut u8;
    fn pocketjs_gpu_tile(id: u32, len: *mut usize) -> *mut u16;
    fn pocketjs_gpu_native_texture(handle: i32, revision: u64) -> u32;
}

fn rect(r: Rect) -> RawRect {
    RawRect {
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
    }
}

fn point(p: Point) -> RawPoint {
    RawPoint { x: p.x, y: p.y }
}

fn formats(bits: u32) -> Formats {
    Formats {
        psm5650: bits & FORMAT_PSM5650 != 0,
        rgba8888: bits & FORMAT_RGBA8888 != 0,
        t8_clut: bits & FORMAT_T8CLUT != 0,
    }
}

fn capabilities(raw: &RawCaps) -> Capabilities {
    Capabilities {
        fill_opaque: raw.flags & CAP_FILL_OPAQUE != 0,
        fill_alpha: raw.flags & CAP_FILL_ALPHA != 0,
        a8_blend: raw.flags & CAP_A8_BLEND != 0,
        gradient: raw.flags & CAP_GRADIENT != 0,
        copy_psm5650: raw.flags & CAP_COPY_PSM5650 != 0,
        blit: formats(raw.blit_formats),
        blit_quad: formats(raw.blit_quad_formats),
        blit_native: raw.flags & CAP_BLIT_NATIVE != 0,
        blit_quad_native: raw.flags & CAP_BLIT_QUAD_NATIVE != 0,
        blit_modulate: raw.flags & CAP_BLIT_MODULATE != 0,
        coordinate_limit: raw.coordinate_limit,
        direct_cpu_writes: raw.flags & CAP_DIRECT_CPU_WRITES != 0,
        mask_tile_bytes: raw.mask_tile_bytes,
        cpu_tile_pixels: raw.cpu_tile_pixels,
        thresholds: Thresholds {
            min_fill: raw.min_fill,
            min_gradient: raw.min_gradient,
            min_blend: raw.min_blend,
            min_blit: raw.min_blit,
        },
    }
}

fn source(cmd: &mut RawCmd, src: &TexSrc<'_>) {
    match *src {
        TexSrc::Native { id } => {
            cmd.src_kind = SRC_NATIVE;
            cmd.src_id = id;
        }
        TexSrc::Solid { abgr } => {
            cmd.src_kind = SRC_SOLID;
            cmd.src_id = abgr;
        }
        TexSrc::Portable {
            pixels,
            palette,
            width,
            height,
            format,
        } => {
            cmd.src_kind = SRC_PORTABLE;
            cmd.src_pixels = pixels.as_ptr();
            cmd.src_len = pixels.len();
            cmd.src_palette = palette.map_or(core::ptr::null(), |p| p.as_ptr());
            cmd.src_width = width;
            cmd.src_height = height;
            cmd.src_format = match format {
                PixelFormat::Psm5650 => PIXEL_PSM5650,
                PixelFormat::Rgba8888 => PIXEL_RGBA8888,
                PixelFormat::T8Clut => PIXEL_T8CLUT,
            };
        }
    }
}

fn abgr(color: [u8; 3], alpha: u8) -> u32 {
    color[0] as u32 | ((color[1] as u32) << 8) | ((color[2] as u32) << 16) | ((alpha as u32) << 24)
}

fn encode(cmd: &Cmd<'_>) -> RawCmd {
    let mut raw = RawCmd::default();
    match *cmd {
        Cmd::Fill { dst, color } => {
            raw.op = OP_FILL;
            raw.dst = rect(dst);
            raw.color = abgr(color, 255);
        }
        Cmd::FillAlpha { dst, color, alpha } => {
            raw.op = OP_FILL_ALPHA;
            raw.dst = rect(dst);
            raw.color = abgr(color, alpha);
        }
        Cmd::BlendA8 {
            dst,
            mask,
            color,
            alpha,
        } => {
            raw.op = OP_BLEND_A8;
            raw.dst = rect(dst);
            raw.color = abgr(color, alpha);
            raw.mask_id = mask.mask.0 as u32;
            raw.mask_offset = mask.offset;
            raw.mask_stride = mask.stride;
        }
        Cmd::Gradient { dst, corners } => {
            raw.op = OP_GRADIENT;
            raw.dst = rect(dst);
            raw.corners = [
                corners.top_left,
                corners.top_right,
                corners.bottom_left,
                corners.bottom_right,
            ];
        }
        Cmd::Blit {
            src,
            src_rect,
            dst,
            clip,
            mirror,
            modulate,
            filter,
        } => {
            raw.op = OP_BLIT;
            source(&mut raw, &src);
            raw.src = rect(src_rect);
            raw.dst = rect(dst);
            raw.clip = rect(clip);
            raw.color = modulate;
            if mirror.x {
                raw.flags |= FLAG_MIRROR_X;
            }
            if mirror.y {
                raw.flags |= FLAG_MIRROR_Y;
            }
            if filter == Filter::Linear {
                raw.flags |= FLAG_LINEAR;
            }
        }
        Cmd::BlitQuad {
            src,
            src_rect,
            quad,
            clip,
            modulate,
            filter,
        } => {
            raw.op = OP_BLIT_QUAD;
            source(&mut raw, &src);
            raw.src = rect(src_rect);
            raw.quad = quad.map(point);
            raw.clip = rect(clip);
            raw.color = modulate;
            if filter == Filter::Linear {
                raw.flags |= FLAG_LINEAR;
            }
        }
        Cmd::TileOut { tile, src } => {
            raw.op = OP_TILE_OUT;
            raw.tile_id = tile.0 as u32;
            raw.clip = rect(src);
        }
        Cmd::TileIn { tile, dst } => {
            raw.op = OP_TILE_IN;
            raw.tile_id = tile.0 as u32;
            raw.dst = rect(dst);
        }
        Cmd::Fence => {
            raw.op = OP_FENCE;
        }
    }
    raw
}

fn status(code: i32) -> Result<(), SubmitError> {
    if code == 0 {
        Ok(())
    } else if code == GPU_FAILED {
        Err(SubmitError::Failed)
    } else {
        Err(SubmitError::Unsupported {
            index: (-code - 1).max(0) as usize,
        })
    }
}

/// The SiFli GPU command queue as a renderer executor.
pub struct SifliGpu {
    caps: Capabilities,
}

impl SifliGpu {
    /// Query the C driver's capabilities. `None` when the driver reports a
    /// different ABI version or is not initialized.
    pub fn new() -> Option<Self> {
        let mut raw = RawCaps::default();
        let code = unsafe { pocketjs_gpu_caps(&mut raw) };
        if code != 0 || raw.abi_version != ABI_VERSION {
            return None;
        }
        Some(SifliGpu {
            caps: capabilities(&raw),
        })
    }
}

/// One bound target of the command queue.
pub struct SifliFrame<'f> {
    gpu: &'f mut SifliGpu,
    target: &'f mut [u16],
}

impl Submit for SifliGpu {
    type Frame<'f>
        = SifliFrame<'f>
    where
        Self: 'f;

    fn caps(&self) -> &Capabilities {
        &self.caps
    }

    fn begin<'f>(
        &'f mut self,
        target: &'f mut [u16],
        width: u32,
        height: u32,
        kind: TargetKind,
    ) -> Result<Self::Frame<'f>, SubmitError> {
        let kind = match kind {
            TargetKind::Framebuffer => TARGET_FRAMEBUFFER,
            TargetKind::Strip => TARGET_STRIP,
        };
        let code =
            unsafe { pocketjs_gpu_begin(target.as_mut_ptr(), target.len(), width, height, kind) };
        if code != 0 {
            return Err(SubmitError::Failed);
        }
        Ok(SifliFrame { gpu: self, target })
    }
}

impl Frame for SifliFrame<'_> {
    fn native_texture(&mut self, handle: i32, revision: u64) -> Option<u32> {
        let id = unsafe { pocketjs_gpu_native_texture(handle, revision) };
        (id != 0).then_some(id)
    }

    fn submit(&mut self, cmds: &[Cmd<'_>]) -> Result<(), SubmitError> {
        let mut batch = [RawCmd::default(); BATCH];
        for (chunk_index, chunk) in cmds.chunks(BATCH).enumerate() {
            for (slot, cmd) in batch.iter_mut().zip(chunk) {
                *slot = encode(cmd);
            }
            let code = unsafe { pocketjs_gpu_submit(batch.as_ptr(), chunk.len()) };
            status(code).map_err(|error| match error {
                SubmitError::Unsupported { index } => SubmitError::Unsupported {
                    index: chunk_index * BATCH + index,
                },
                other => other,
            })?;
        }
        Ok(())
    }

    fn fence(&mut self) -> Result<(), SubmitError> {
        status(unsafe { pocketjs_gpu_fence() })
    }

    fn mask_mut(&mut self, mask: MaskId) -> &mut [u8] {
        let mut len = 0usize;
        let plane = unsafe { pocketjs_gpu_mask(mask.0 as u32, &mut len) };
        if plane.is_null() {
            return &mut [];
        }
        unsafe { slice::from_raw_parts_mut(plane, len) }
    }

    fn tile_mut(&mut self, tile: TileId) -> &mut [u16] {
        let mut len = 0usize;
        let plane = unsafe { pocketjs_gpu_tile(tile.0 as u32, &mut len) };
        if plane.is_null() {
            return &mut [];
        }
        unsafe { slice::from_raw_parts_mut(plane, len) }
    }

    fn target_mut(&mut self) -> Option<&mut [u16]> {
        if self.gpu.caps.direct_cpu_writes {
            Some(self.target)
        } else {
            None
        }
    }

    fn finish(self) -> Result<(), SubmitError> {
        status(unsafe { pocketjs_gpu_end() })
    }
}
