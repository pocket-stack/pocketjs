//! `.p3d` swizzled CLUT8 to linear RGBA8 conversion.
//!
//! The runtime expands only the texture currently being uploaded. The
//! temporary RGBA vector is dropped immediately after `glTexImage2D`, so
//! loading all map textures does not require a second full-map texture copy.

pub use pocket3d_bsp::cooked::{expand_level0_rgba, TextureDecodeError};

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::{string::String, vec, vec::Vec};
    use pocket3d_bsp::cooked::CookedTexture;

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

    fn palette() -> Vec<u8> {
        let mut palette = vec![0u8; 1024];
        for index in 0..256usize {
            palette[index * 4..index * 4 + 4].copy_from_slice(&[
                index as u8,
                255 - index as u8,
                (index ^ 0x55) as u8,
                255,
            ]);
        }
        palette
    }

    #[test]
    fn unswizzles_multiple_blocks_and_expands_palette() {
        let width = 32usize;
        let height = 11usize;
        let indices: Vec<u8> = (0..width * height)
            .map(|value| (value % 251) as u8)
            .collect();
        let mip = swizzle(&indices, width, height);
        let palette = palette();
        let texture = CookedTexture {
            name: String::from("blocks"),
            width: width as u32,
            height: height as u32,
            levels: 1,
            masked: false,
            palette: &palette,
            mips: vec![&mip],
        };

        let rgba = expand_level0_rgba(&texture).unwrap();
        assert_eq!(rgba.len(), width * height * 4);
        for (offset, index) in indices.into_iter().enumerate() {
            assert_eq!(
                &rgba[offset * 4..offset * 4 + 4],
                [index, 255 - index, index ^ 0x55, 255,]
            );
        }
    }

    #[test]
    fn clears_rgb_for_transparent_cutout_entry() {
        let mip = swizzle(&[255], 1, 1);
        let mut palette = palette();
        palette[255 * 4..256 * 4].copy_from_slice(&[200, 100, 50, 0]);
        let texture = CookedTexture {
            name: String::from("{fence"),
            width: 1,
            height: 1,
            levels: 1,
            masked: true,
            palette: &palette,
            mips: vec![&mip],
        };

        assert_eq!(expand_level0_rgba(&texture).unwrap(), [0, 0, 0, 0]);
    }

    #[test]
    fn distinguishes_missing_and_truncated_inputs() {
        let palette = palette();
        let missing = CookedTexture {
            name: String::from("missing"),
            width: 16,
            height: 8,
            levels: 0,
            masked: false,
            palette: &palette,
            mips: Vec::new(),
        };
        assert_eq!(
            expand_level0_rgba(&missing),
            Err(TextureDecodeError::MissingLevelZero)
        );

        let truncated_swizzle = [0u8; 127];
        let truncated = CookedTexture {
            name: String::from("truncated"),
            width: 16,
            height: 8,
            levels: 1,
            masked: false,
            palette: &palette,
            mips: vec![&truncated_swizzle],
        };
        assert_eq!(
            expand_level0_rgba(&truncated),
            Err(TextureDecodeError::TruncatedSwizzle)
        );

        let short_palette = CookedTexture {
            name: String::from("bad"),
            width: 16,
            height: 8,
            levels: 1,
            masked: false,
            palette: &palette[..16],
            mips: vec![&[0; 4]],
        };
        assert_eq!(
            expand_level0_rgba(&short_palette),
            Err(TextureDecodeError::TruncatedPalette)
        );
    }
}
