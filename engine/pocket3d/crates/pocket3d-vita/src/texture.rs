//! `.p3d` CLUT8 texture conversion and vita2d texture ownership.
//!
//! The cooker stores PSP-GE swizzled index planes. Vita uploads use linear
//! RGBA8 textures, so level zero is unswizzled and palette-expanded once.

use core::ptr::NonNull;

use pocket3d_bsp::cooked::{mip_rows, mip_stride, CookedTexture};
#[cfg(target_os = "vita")]
use vita2d_sys as v2d;

#[cfg(target_os = "vita")]
type TextureHandle = NonNull<v2d::vita2d_texture>;
#[cfg(not(target_os = "vita"))]
type TextureHandle = NonNull<core::ffi::c_void>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UploadErrorKind {
    MissingLevelZero,
    TruncatedSwizzle,
    TruncatedPalette,
    OutOfMemory,
    UnsupportedHost,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UploadError {
    pub texture: usize,
    pub kind: UploadErrorKind,
}

/// Expand the first `.p3d` mip to tightly packed RGBA8 pixels.
///
/// This function is platform-independent so cooker/runtime compatibility can
/// be covered by ordinary host tests.
pub fn expand_level0_rgba(texture: &CookedTexture<'_>) -> Result<Vec<u8>, UploadErrorKind> {
    let source = texture
        .mips
        .first()
        .copied()
        .ok_or(UploadErrorKind::MissingLevelZero)?;
    if texture.palette.len() < 256 * 4 {
        return Err(UploadErrorKind::TruncatedPalette);
    }

    let width = texture.width.max(1) as usize;
    let height = texture.height.max(1) as usize;
    let stride = mip_stride(texture.width.max(1), 0);
    let rows = mip_rows(texture.height.max(1), 0);
    let expected = stride
        .checked_mul(rows)
        .ok_or(UploadErrorKind::TruncatedSwizzle)?;
    if source.len() < expected {
        return Err(UploadErrorKind::TruncatedSwizzle);
    }

    let mut rgba = vec![0u8; width * height * 4];
    let mut source_offset = 0usize;
    for block_y in 0..rows / 8 {
        for block_x in 0..stride / 16 {
            for row in 0..8 {
                let y = block_y * 8 + row;
                for column in 0..16 {
                    let x = block_x * 16 + column;
                    let index = source[source_offset + column] as usize;
                    if x < width && y < height {
                        let palette = &texture.palette[index * 4..index * 4 + 4];
                        let destination = (y * width + x) * 4;
                        rgba[destination..destination + 4].copy_from_slice(palette);
                        // Masked palettes intentionally carry alpha zero at
                        // index 255. Clear RGB too so linear filtering cannot
                        // bleed the palette's arbitrary transparent color.
                        if palette[3] == 0 {
                            rgba[destination..destination + 3].fill(0);
                        }
                    }
                }
                source_offset += 16;
            }
        }
    }
    Ok(rgba)
}

pub(crate) struct TextureBank {
    handles: Vec<Option<TextureHandle>>,
}

impl TextureBank {
    pub(crate) fn new(count: usize) -> Self {
        Self {
            handles: vec![None; count],
        }
    }

    #[cfg(target_os = "vita")]
    pub(crate) fn has_resident(&self) -> bool {
        self.handles.iter().any(Option::is_some)
    }

    #[cfg(target_os = "vita")]
    pub(crate) fn handle(&self, index: usize) -> *const v2d::vita2d_texture {
        self.handles
            .get(index)
            .and_then(|handle| *handle)
            .map_or(core::ptr::null(), |handle| handle.as_ptr().cast_const())
    }

    /// Upload any textures that do not yet have a Vita allocation.
    ///
    /// The caller must initialize vita2d before invoking this on Vita.
    pub(crate) unsafe fn upload_missing(
        &mut self,
        textures: &[CookedTexture<'_>],
    ) -> Result<(), UploadError> {
        for (index, texture) in textures.iter().enumerate() {
            if self.handles[index].is_some() {
                continue;
            }
            let handle = upload_texture(texture).map_err(|kind| UploadError {
                texture: index,
                kind,
            })?;
            self.handles[index] = Some(handle);
        }
        Ok(())
    }
}

impl Drop for TextureBank {
    fn drop(&mut self) {
        #[cfg(target_os = "vita")]
        unsafe {
            for texture in self.handles.drain(..).flatten() {
                v2d::vita2d_free_texture(texture.as_ptr());
            }
        }
    }
}

#[cfg(target_os = "vita")]
unsafe fn upload_texture(
    texture: &CookedTexture<'_>,
) -> Result<NonNull<v2d::vita2d_texture>, UploadErrorKind> {
    let rgba = expand_level0_rgba(texture)?;
    let width = texture.width.max(1);
    let height = texture.height.max(1);
    let raw = v2d::vita2d_create_empty_texture(width, height);
    let handle = NonNull::new(raw).ok_or(UploadErrorKind::OutOfMemory)?;

    let stride = v2d::vita2d_texture_get_stride(raw) as usize;
    let row_bytes = width as usize * 4;
    let destination = v2d::vita2d_texture_get_datap(raw).cast::<u8>();
    if destination.is_null() || stride < row_bytes {
        v2d::vita2d_free_texture(raw);
        return Err(UploadErrorKind::OutOfMemory);
    }
    for y in 0..height as usize {
        core::ptr::copy_nonoverlapping(
            rgba.as_ptr().add(y * row_bytes),
            destination.add(y * stride),
            row_bytes,
        );
    }

    v2d::vita2d_texture_set_filters(
        raw,
        v2d::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR,
        v2d::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR,
    );
    v2d::sceGxmTextureSetUAddrMode(
        &mut (*raw).gxm_tex,
        v2d::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_REPEAT,
    );
    v2d::sceGxmTextureSetVAddrMode(
        &mut (*raw).gxm_tex,
        v2d::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_REPEAT,
    );
    Ok(handle)
}

#[cfg(not(target_os = "vita"))]
unsafe fn upload_texture(_texture: &CookedTexture<'_>) -> Result<TextureHandle, UploadErrorKind> {
    Err(UploadErrorKind::UnsupportedHost)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::string::String;

    fn swizzle(indices: &[u8], width: usize, height: usize) -> Vec<u8> {
        let stride = width.max(16);
        let rows = height.div_ceil(8) * 8;
        let mut linear = vec![0u8; stride * rows];
        for y in 0..height {
            linear[y * stride..y * stride + width]
                .copy_from_slice(&indices[y * width..(y + 1) * width]);
        }
        let mut result = Vec::with_capacity(linear.len());
        for block_y in 0..rows / 8 {
            for block_x in 0..stride / 16 {
                for row in 0..8 {
                    let start = (block_y * 8 + row) * stride + block_x * 16;
                    result.extend_from_slice(&linear[start..start + 16]);
                }
            }
        }
        result
    }

    #[test]
    fn unswizzles_and_expands_narrow_level_zero() {
        let width = 8usize;
        let height = 4usize;
        let indices: Vec<u8> = (0..width * height).map(|value| value as u8).collect();
        let mip = swizzle(&indices, width, height);
        let mut palette = vec![0u8; 1024];
        for index in 0..256usize {
            palette[index * 4..index * 4 + 4].copy_from_slice(&[
                index as u8,
                255 - index as u8,
                7,
                255,
            ]);
        }
        let texture = CookedTexture {
            name: String::from("test"),
            width: width as u32,
            height: height as u32,
            levels: 1,
            masked: false,
            palette: &palette,
            mips: vec![&mip],
        };

        let rgba = expand_level0_rgba(&texture).unwrap();
        assert_eq!(rgba.len(), width * height * 4);
        for (pixel, index) in rgba.chunks_exact(4).zip(indices) {
            assert_eq!(pixel, [index, 255 - index, 7, 255]);
        }
    }

    #[test]
    fn clears_rgb_for_transparent_palette_entries() {
        let mip = swizzle(&[255], 1, 1);
        let mut palette = vec![0u8; 1024];
        palette[255 * 4..256 * 4].copy_from_slice(&[200, 100, 50, 0]);
        let texture = CookedTexture {
            name: String::from("masked"),
            width: 1,
            height: 1,
            levels: 1,
            masked: true,
            palette: &palette,
            mips: vec![&mip],
        };
        assert_eq!(expand_level0_rgba(&texture).unwrap(), [0, 0, 0, 0]);
    }
}
