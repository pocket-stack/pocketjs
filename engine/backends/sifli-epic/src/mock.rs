//! A software executor that runs every command with the core's exact pixel
//! formulas and records what it was asked to do. Tests compare the hybrid
//! output against `pocketjs_core::raster`, and hosts can use it to run the
//! renderer without hardware.

use alloc::vec::Vec;

use pocketjs_core::raster::pack_rgb565;

use crate::caps::Capabilities;
use crate::cmd::{Cmd, Corners, Filter, MaskId, MaskRef, Mirror, PixelFormat, TexSrc, TileId, MODULATE_NONE};
use crate::geom::{blend_rgb565_pixel, channels, Point, Rect};
use crate::submit::{Frame, Submit, SubmitError, TargetKind};

/// Recording software executor.
#[derive(Default)]
pub struct MockGpu {
    pub caps: Capabilities,
    masks: [Vec<u8>; 2],
    tiles: [Vec<u16>; 2],
    /// Counters per command kind.
    pub fills: u32,
    pub gradients: u32,
    pub blends: u32,
    /// Every `Blit` and `BlitQuad`.
    pub copies: u32,
    pub blits: u32,
    pub quads: u32,
    pub fences: u32,
    pub last_surface_width: u32,
    pub last_surface_height: u32,
    pub last_target_kind: Option<TargetKind>,
    pub last_fill_rect: Rect,
    pub last_blend_rect: Rect,
    /// Coverage bytes of the last `BlendA8`, row-major over its rectangle.
    pub last_mask: Vec<u8>,
    pub last_mask_max: u8,
    pub last_global_alpha: u8,
    pub last_blit_src: Rect,
    pub last_blit_dst: Rect,
    pub last_blit_clip: Rect,
    pub last_mirror: Mirror,
    pub last_format: Option<PixelFormat>,
    pub last_modulate: u32,
    pub last_filter: Filter,
    pub last_quad: [Point; 4],
    pub last_quad_clip: Rect,
    pub last_corners: Option<Corners>,
    /// Core texture handles the mock pretends to hold native copies of,
    /// with the id it reports for each.
    pub native: Vec<(i32, u32)>,
    pub last_native: Option<u32>,
}

impl MockGpu {
    pub fn new(caps: Capabilities) -> Self {
        MockGpu {
            caps,
            ..MockGpu::default()
        }
    }
}

/// One bound target of a [`MockGpu`].
pub struct MockFrame<'f> {
    gpu: &'f mut MockGpu,
    target: &'f mut [u16],
    width: u32,
    height: u32,
}

impl Submit for MockGpu {
    type Frame<'f>
        = MockFrame<'f>
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
        if target.len() != width as usize * height as usize {
            return Err(SubmitError::Failed);
        }
        self.last_surface_width = width;
        self.last_surface_height = height;
        self.last_target_kind = Some(kind);
        let pixels = width as usize * height as usize;
        let mask_bytes = if self.caps.mask_tile_bytes == 0 {
            pixels
        } else {
            self.caps.mask_tile_bytes as usize
        };
        for mask in &mut self.masks {
            if mask.len() < mask_bytes {
                mask.resize(mask_bytes, 0);
            }
        }
        let tile_pixels = self.caps.cpu_tile_pixels as usize;
        for tile in &mut self.tiles {
            if tile.len() < tile_pixels {
                tile.resize(tile_pixels, 0);
            }
        }
        Ok(MockFrame {
            gpu: self,
            target,
            width,
            height,
        })
    }
}

impl Frame for MockFrame<'_> {
    fn native_texture(&mut self, handle: i32, _revision: u64) -> Option<u32> {
        self.gpu
            .native
            .iter()
            .find(|(registered, _)| *registered == handle)
            .map(|(_, id)| *id)
    }

    fn submit(&mut self, cmds: &[Cmd<'_>]) -> Result<(), SubmitError> {
        for (index, cmd) in cmds.iter().enumerate() {
            if !self.execute(cmd) {
                return Err(SubmitError::Unsupported { index });
            }
        }
        Ok(())
    }

    fn fence(&mut self) -> Result<(), SubmitError> {
        self.gpu.fences += 1;
        Ok(())
    }

    fn mask_mut(&mut self, mask: MaskId) -> &mut [u8] {
        &mut self.gpu.masks[mask.0 as usize]
    }

    fn tile_mut(&mut self, tile: TileId) -> &mut [u16] {
        &mut self.gpu.tiles[tile.0 as usize]
    }

    fn target_mut(&mut self) -> Option<&mut [u16]> {
        if self.gpu.caps.direct_cpu_writes {
            Some(self.target)
        } else {
            None
        }
    }

    fn finish(self) -> Result<(), SubmitError> {
        Ok(())
    }
}

impl MockFrame<'_> {
    fn in_target(&self, rect: Rect) -> bool {
        rect.x.checked_add(rect.w).is_some_and(|x1| x1 <= self.width)
            && rect.y.checked_add(rect.h).is_some_and(|y1| y1 <= self.height)
    }

    fn execute(&mut self, cmd: &Cmd<'_>) -> bool {
        match *cmd {
            Cmd::Fill { dst, color } => {
                if !self.in_target(dst) {
                    return false;
                }
                self.gpu.fills += 1;
                self.gpu.last_fill_rect = dst;
                let packed = pack_rgb565(color[0] as u32, color[1] as u32, color[2] as u32);
                for y in dst.y..dst.y + dst.h {
                    let start = (y * self.width + dst.x) as usize;
                    self.target[start..start + dst.w as usize].fill(packed);
                }
                true
            }
            Cmd::FillAlpha { dst, color, alpha } => {
                if !self.in_target(dst) {
                    return false;
                }
                self.gpu.fills += 1;
                self.gpu.last_fill_rect = dst;
                for y in dst.y..dst.y + dst.h {
                    for x in dst.x..dst.x + dst.w {
                        blend_rgb565_pixel(
                            &mut self.target[(y * self.width + x) as usize],
                            color[0] as u32,
                            color[1] as u32,
                            color[2] as u32,
                            alpha as u32,
                        );
                    }
                }
                true
            }
            Cmd::BlendA8 {
                dst,
                mask,
                color,
                alpha,
            } => {
                if !self.in_target(dst) {
                    return false;
                }
                self.gpu.blends += 1;
                self.gpu.last_blend_rect = dst;
                self.gpu.last_global_alpha = alpha;
                let MaskRef {
                    mask: id,
                    offset,
                    stride,
                } = mask;
                let plane = &self.gpu.masks[id.0 as usize];
                self.gpu.last_mask.clear();
                let mut max = 0u8;
                for y in 0..dst.h {
                    for x in 0..dst.w {
                        let coverage = plane[(offset + y * stride + x) as usize];
                        max = max.max(coverage);
                        self.gpu.last_mask.push(coverage);
                        let scaled = (coverage as u32 * alpha as u32 + 127) / 255;
                        let index = ((dst.y + y) * self.width + dst.x + x) as usize;
                        blend_rgb565_pixel(
                            &mut self.target[index],
                            color[0] as u32,
                            color[1] as u32,
                            color[2] as u32,
                            scaled,
                        );
                    }
                }
                self.gpu.last_mask_max = max;
                true
            }
            Cmd::Gradient { dst, corners } => {
                if !self.in_target(dst) {
                    return false;
                }
                self.gpu.gradients += 1;
                self.gpu.last_corners = Some(corners);
                for y in 0..dst.h {
                    let fy = (y as f32 + 0.5) / dst.h as f32;
                    for x in 0..dst.w {
                        let fx = (x as f32 + 0.5) / dst.w as f32;
                        let top = lerp_color(corners.top_left, corners.top_right, fx);
                        let bottom = lerp_color(corners.bottom_left, corners.bottom_right, fx);
                        let (r, g, b, a) = channels(lerp_color(top, bottom, fy));
                        let index = ((dst.y + y) * self.width + dst.x + x) as usize;
                        blend_rgb565_pixel(&mut self.target[index], r, g, b, a);
                    }
                }
                true
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
                if !self.in_target(clip) || dst.is_empty() {
                    return false;
                }
                self.gpu.copies += 1;
                self.gpu.blits += 1;
                self.gpu.last_blit_src = src_rect;
                self.gpu.last_blit_dst = dst;
                self.gpu.last_blit_clip = clip;
                self.gpu.last_mirror = mirror;
                self.gpu.last_format = Some(src.format());
                self.gpu.last_modulate = modulate;
                self.gpu.last_filter = filter;
                self.gpu.last_native = match src {
                    TexSrc::Native { id } => Some(id),
                    _ => None,
                };
                let write = dst.intersect(clip);
                for y in write.y..write.y + write.h {
                    let dy = (y - dst.y) as f32 + 0.5;
                    let ty = sample_axis(src_rect.y, src_rect.h, dy, dst.h, mirror.y);
                    for x in write.x..write.x + write.w {
                        let dx = (x - dst.x) as f32 + 0.5;
                        let tx = sample_axis(src_rect.x, src_rect.w, dx, dst.w, mirror.x);
                        let (r, g, b, a) = modulated(sample(&src, tx, ty), modulate);
                        blend_rgb565_pixel(
                            &mut self.target[(y * self.width + x) as usize],
                            r,
                            g,
                            b,
                            a,
                        );
                    }
                }
                true
            }
            Cmd::BlitQuad {
                src,
                src_rect,
                quad,
                clip,
                modulate,
                filter,
            } => {
                if !self.in_target(clip) {
                    return false;
                }
                self.gpu.copies += 1;
                self.gpu.quads += 1;
                self.gpu.last_blit_src = src_rect;
                self.gpu.last_quad = quad;
                self.gpu.last_quad_clip = clip;
                self.gpu.last_format = Some(src.format());
                self.gpu.last_modulate = modulate;
                self.gpu.last_filter = filter;
                self.gpu.last_native = match src {
                    TexSrc::Native { id } => Some(id),
                    _ => None,
                };
                let [tl, bl, br, tr] = quad;
                let tex = |uv: (f32, f32)| {
                    (
                        src_rect.x as f32 + uv.0 * src_rect.w as f32,
                        src_rect.y as f32 + uv.1 * src_rect.h as f32,
                    )
                };
                let triangles = [
                    [(tl, (0.0, 0.0)), (bl, (0.0, 1.0)), (br, (1.0, 1.0))],
                    [(tl, (0.0, 0.0)), (br, (1.0, 1.0)), (tr, (1.0, 0.0))],
                ];
                for y in clip.y..clip.y + clip.h {
                    for x in clip.x..clip.x + clip.w {
                        let px = x as f32 + 0.5;
                        let py = y as f32 + 0.5;
                        for triangle in &triangles {
                            let Some((wu, wv)) = barycentric_uv(triangle, px, py) else {
                                continue;
                            };
                            let (tx, ty) = tex((wu, wv));
                            let tx = (tx as i32).clamp(
                                src_rect.x as i32,
                                (src_rect.x + src_rect.w) as i32 - 1,
                            );
                            let ty = (ty as i32).clamp(
                                src_rect.y as i32,
                                (src_rect.y + src_rect.h) as i32 - 1,
                            );
                            let (r, g, b, a) = modulated(sample(&src, tx, ty), modulate);
                            blend_rgb565_pixel(
                                &mut self.target[(y * self.width + x) as usize],
                                r,
                                g,
                                b,
                                a,
                            );
                            break;
                        }
                    }
                }
                true
            }
            Cmd::TileOut { tile, src } => {
                if !self.in_target(src) {
                    return false;
                }
                let plane = &mut self.gpu.tiles[tile.0 as usize];
                for y in 0..src.h {
                    let from = ((src.y + y) * self.width + src.x) as usize;
                    let to = (y * src.w) as usize;
                    plane[to..to + src.w as usize]
                        .copy_from_slice(&self.target[from..from + src.w as usize]);
                }
                true
            }
            Cmd::TileIn { tile, dst } => {
                if !self.in_target(dst) {
                    return false;
                }
                let plane = &self.gpu.tiles[tile.0 as usize];
                for y in 0..dst.h {
                    let from = (y * dst.w) as usize;
                    let to = ((dst.y + y) * self.width + dst.x) as usize;
                    self.target[to..to + dst.w as usize]
                        .copy_from_slice(&plane[from..from + dst.w as usize]);
                }
                true
            }
            Cmd::Fence => {
                self.gpu.fences += 1;
                true
            }
        }
    }
}

/// Source texel along one axis for destination offset `d` (pixel center),
/// using the core's `u = u0 + (u1 - u0) * (d / extent)` sampling.
fn sample_axis(origin: u32, span: u32, d: f32, extent: u32, mirror: bool) -> i32 {
    let ratio = span as f32 / extent as f32;
    let position = if mirror {
        (origin + span) as f32 - d * ratio
    } else {
        origin as f32 + d * ratio
    };
    (position as i32).clamp(origin as i32, (origin + span) as i32 - 1)
}

fn sample(src: &TexSrc<'_>, tx: i32, ty: i32) -> (u32, u32, u32, u32) {
    match *src {
        TexSrc::Solid { abgr } => channels(abgr),
        TexSrc::Native { .. } => (255, 0, 255, 255),
        TexSrc::Portable {
            pixels,
            palette,
            width,
            format,
            ..
        } => {
            let index = ty as usize * width as usize + tx as usize;
            match format {
                PixelFormat::Psm5650 => {
                    let o = index * 2;
                    let px16 = pixels[o] as u32 | ((pixels[o + 1] as u32) << 8);
                    let r5 = px16 & 0x1f;
                    let g6 = (px16 >> 5) & 0x3f;
                    let b5 = (px16 >> 11) & 0x1f;
                    (
                        (r5 << 3) | (r5 >> 2),
                        (g6 << 2) | (g6 >> 4),
                        (b5 << 3) | (b5 >> 2),
                        255,
                    )
                }
                PixelFormat::Rgba8888 => {
                    let o = index * 4;
                    (
                        pixels[o] as u32,
                        pixels[o + 1] as u32,
                        pixels[o + 2] as u32,
                        pixels[o + 3] as u32,
                    )
                }
                PixelFormat::T8Clut => {
                    let palette = palette.unwrap_or(&[]);
                    let o = pixels[index] as usize * 4;
                    (
                        palette[o] as u32,
                        palette[o + 1] as u32,
                        palette[o + 2] as u32,
                        palette[o + 3] as u32,
                    )
                }
            }
        }
    }
}

fn modulated(texel: (u32, u32, u32, u32), modulate: u32) -> (u32, u32, u32, u32) {
    if modulate == MODULATE_NONE {
        return texel;
    }
    let (mr, mg, mb, ma) = channels(modulate);
    let (r, g, b, a) = texel;
    (
        (r * mr + 127) / 255,
        (g * mg + 127) / 255,
        (b * mb + 127) / 255,
        (a * ma + 127) / 255,
    )
}

/// Interpolated `(u, v)` at `(px, py)` inside a screen triangle, or `None`
/// when the point is outside.
fn barycentric_uv(triangle: &[(Point, (f32, f32)); 3], px: f32, py: f32) -> Option<(f32, f32)> {
    let [(a, ta), (b, tb), (c, tc)] = *triangle;
    let (ax, ay) = (a.x as f32, a.y as f32);
    let (bx, by) = (b.x as f32, b.y as f32);
    let (cx, cy) = (c.x as f32, c.y as f32);
    let area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if area == 0.0 {
        return None;
    }
    let w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
    let w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
    let w2 = 1.0 - w0 - w1;
    if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 {
        return None;
    }
    Some((
        w0 * ta.0 + w1 * tb.0 + w2 * tc.0,
        w0 * ta.1 + w1 * tb.1 + w2 * tc.1,
    ))
}

/// Round-to-nearest color interpolation matching the core's gradient lerp.
pub fn lerp_color(from: u32, to: u32, factor: f32) -> u32 {
    let mix = |a: u32, b: u32| {
        let value = a as f32 + (b as f32 - a as f32) * factor;
        (value + 0.5) as u32
    };
    let (fr, fg, fb, fa) = channels(from);
    let (tr, tg, tb, ta) = channels(to);
    mix(fr, tr) | (mix(fg, tg) << 8) | (mix(fb, tb) << 16) | (mix(fa, ta) << 24)
}

// ---- deferred execution ------------------------------------------------------------

/// Owned copy of a command so it can be executed after the frame's borrows
/// ended.
enum OwnedSrc {
    Native(u32),
    Portable {
        pixels: Vec<u8>,
        palette: Option<Vec<u8>>,
        width: u32,
        height: u32,
        format: PixelFormat,
    },
    Solid(u32),
}

impl OwnedSrc {
    fn from(src: &TexSrc<'_>) -> OwnedSrc {
        match *src {
            TexSrc::Native { id } => OwnedSrc::Native(id),
            TexSrc::Portable {
                pixels,
                palette,
                width,
                height,
                format,
            } => OwnedSrc::Portable {
                pixels: pixels.to_vec(),
                palette: palette.map(|p| p.to_vec()),
                width,
                height,
                format,
            },
            TexSrc::Solid { abgr } => OwnedSrc::Solid(abgr),
        }
    }

    fn borrow(&self) -> TexSrc<'_> {
        match self {
            OwnedSrc::Native(id) => TexSrc::Native { id: *id },
            OwnedSrc::Portable {
                pixels,
                palette,
                width,
                height,
                format,
            } => TexSrc::Portable {
                pixels,
                palette: palette.as_deref(),
                width: *width,
                height: *height,
                format: *format,
            },
            OwnedSrc::Solid(abgr) => TexSrc::Solid { abgr: *abgr },
        }
    }
}

enum OwnedCmd {
    Plain(Cmd<'static>),
    Blit {
        src: OwnedSrc,
        src_rect: Rect,
        dst: Rect,
        clip: Rect,
        mirror: Mirror,
        modulate: u32,
        filter: Filter,
    },
    BlitQuad {
        src: OwnedSrc,
        src_rect: Rect,
        quad: [Point; 4],
        clip: Rect,
        modulate: u32,
        filter: Filter,
    },
}

impl OwnedCmd {
    fn from(cmd: &Cmd<'_>) -> OwnedCmd {
        match *cmd {
            Cmd::Blit {
                src,
                src_rect,
                dst,
                clip,
                mirror,
                modulate,
                filter,
            } => OwnedCmd::Blit {
                src: OwnedSrc::from(&src),
                src_rect,
                dst,
                clip,
                mirror,
                modulate,
                filter,
            },
            Cmd::BlitQuad {
                src,
                src_rect,
                quad,
                clip,
                modulate,
                filter,
            } => OwnedCmd::BlitQuad {
                src: OwnedSrc::from(&src),
                src_rect,
                quad,
                clip,
                modulate,
                filter,
            },
            Cmd::Fill { dst, color } => OwnedCmd::Plain(Cmd::Fill { dst, color }),
            Cmd::FillAlpha { dst, color, alpha } => {
                OwnedCmd::Plain(Cmd::FillAlpha { dst, color, alpha })
            }
            Cmd::BlendA8 {
                dst,
                mask,
                color,
                alpha,
            } => OwnedCmd::Plain(Cmd::BlendA8 {
                dst,
                mask,
                color,
                alpha,
            }),
            Cmd::Gradient { dst, corners } => OwnedCmd::Plain(Cmd::Gradient { dst, corners }),
            Cmd::TileOut { tile, src } => OwnedCmd::Plain(Cmd::TileOut { tile, src }),
            Cmd::TileIn { tile, dst } => OwnedCmd::Plain(Cmd::TileIn { tile, dst }),
            Cmd::Fence => OwnedCmd::Plain(Cmd::Fence),
        }
    }

    fn borrow(&self) -> Cmd<'_> {
        match self {
            OwnedCmd::Plain(cmd) => *cmd,
            OwnedCmd::Blit {
                src,
                src_rect,
                dst,
                clip,
                mirror,
                modulate,
                filter,
            } => Cmd::Blit {
                src: src.borrow(),
                src_rect: *src_rect,
                dst: *dst,
                clip: *clip,
                mirror: *mirror,
                modulate: *modulate,
                filter: *filter,
            },
            OwnedCmd::BlitQuad {
                src,
                src_rect,
                quad,
                clip,
                modulate,
                filter,
            } => Cmd::BlitQuad {
                src: src.borrow(),
                src_rect: *src_rect,
                quad: *quad,
                clip: *clip,
                modulate: *modulate,
                filter: *filter,
            },
        }
    }

    fn touches_mask(&self, mask: MaskId) -> bool {
        matches!(self, OwnedCmd::Plain(Cmd::BlendA8 { mask: m, .. }) if m.mask == mask)
    }

    fn touches_tile(&self, tile: TileId) -> bool {
        matches!(
            self,
            OwnedCmd::Plain(Cmd::TileOut { tile: t, .. }) | OwnedCmd::Plain(Cmd::TileIn { tile: t, .. })
                if *t == tile
        )
    }
}

/// A [`MockGpu`] that keeps every submitted command in flight until the next
/// fence or `finish`, proving that the renderer never touches a plane, tile,
/// or the target while hardware may still be using it. Those accesses panic
/// when commands are pending.
#[derive(Default)]
pub struct DeferredMockGpu {
    pub inner: MockGpu,
}

impl DeferredMockGpu {
    pub fn new(caps: Capabilities) -> Self {
        DeferredMockGpu {
            inner: MockGpu::new(caps),
        }
    }
}

/// One bound target of a [`DeferredMockGpu`].
pub struct DeferredFrame<'f> {
    inner: MockFrame<'f>,
    queue: Vec<OwnedCmd>,
}

impl Submit for DeferredMockGpu {
    type Frame<'f>
        = DeferredFrame<'f>
    where
        Self: 'f;

    fn caps(&self) -> &Capabilities {
        &self.inner.caps
    }

    fn begin<'f>(
        &'f mut self,
        target: &'f mut [u16],
        width: u32,
        height: u32,
        kind: TargetKind,
    ) -> Result<Self::Frame<'f>, SubmitError> {
        Ok(DeferredFrame {
            inner: self.inner.begin(target, width, height, kind)?,
            queue: Vec::new(),
        })
    }
}

impl DeferredFrame<'_> {
    fn drain(&mut self) -> Result<(), SubmitError> {
        let queue = core::mem::take(&mut self.queue);
        for (index, owned) in queue.iter().enumerate() {
            if !self.inner.execute(&owned.borrow()) {
                return Err(SubmitError::Unsupported { index });
            }
        }
        Ok(())
    }
}

impl Frame for DeferredFrame<'_> {
    fn native_texture(&mut self, handle: i32, revision: u64) -> Option<u32> {
        self.inner.native_texture(handle, revision)
    }

    fn submit(&mut self, cmds: &[Cmd<'_>]) -> Result<(), SubmitError> {
        self.queue.extend(cmds.iter().map(OwnedCmd::from));
        Ok(())
    }

    fn fence(&mut self) -> Result<(), SubmitError> {
        self.drain()?;
        self.inner.fence()
    }

    fn mask_mut(&mut self, mask: MaskId) -> &mut [u8] {
        assert!(
            !self.queue.iter().any(|cmd| cmd.touches_mask(mask)),
            "mask {} rewritten while a BlendA8 reading it is in flight",
            mask.0
        );
        self.inner.mask_mut(mask)
    }

    fn tile_mut(&mut self, tile: TileId) -> &mut [u16] {
        assert!(
            !self.queue.iter().any(|cmd| cmd.touches_tile(tile)),
            "tile {} accessed while a tile copy using it is in flight",
            tile.0
        );
        self.inner.tile_mut(tile)
    }

    fn target_mut(&mut self) -> Option<&mut [u16]> {
        assert!(
            self.queue.is_empty(),
            "target written while {} hardware commands are in flight",
            self.queue.len()
        );
        self.inner.target_mut()
    }

    fn finish(mut self) -> Result<(), SubmitError> {
        self.drain()
    }
}
