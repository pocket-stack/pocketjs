//! CLUT8 texture binding for cooked textures. Texel data and palettes are
//! consumed in place (already swizzled + mip-chained by the cooker, already
//! written back by `writeback` at load).

use core::ffi::c_void;

use pocket3d_bsp::cooked::{mip_stride, CookedTexture};
use psp::sys::{self, ClutPixelFormat, MipmapLevel, TexturePixelFormat};

const MIP_LEVELS: [MipmapLevel; 8] = [
    MipmapLevel::None,
    MipmapLevel::Level1,
    MipmapLevel::Level2,
    MipmapLevel::Level3,
    MipmapLevel::Level4,
    MipmapLevel::Level5,
    MipmapLevel::Level6,
    MipmapLevel::Level7,
];

/// Bind a cooked CLUT8 texture (palette + all mip levels).
pub unsafe fn bind(t: &CookedTexture) {
    sys::sceGuClutMode(ClutPixelFormat::Psm8888, 0, 0xff, 0);
    sys::sceGuClutLoad(32, t.palette.as_ptr() as *const c_void);
    sys::sceGuTexMode(
        TexturePixelFormat::PsmT8,
        (t.levels as i32 - 1).max(0),
        0,
        1, // swizzled
    );
    for (level, mip) in t.mips.iter().enumerate() {
        let w = (t.width >> level).max(1) as i32;
        let h = (t.height >> level).max(1) as i32;
        sys::sceGuTexImage(
            MIP_LEVELS[level],
            w,
            h,
            mip_stride(t.width, level as u32) as i32,
            mip.as_ptr() as *const c_void,
        );
    }
}
