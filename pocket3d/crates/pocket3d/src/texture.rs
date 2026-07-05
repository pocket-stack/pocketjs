//! Texture upload with CPU mip generation.

use crate::gpu::Gpu;

pub struct GpuTexture {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub size: (u32, u32),
}

/// Upload an RGBA8 image, optionally generating a full mip chain on the CPU
/// (simple box filter — plenty for retro-density textures).
pub fn create_rgba_texture(
    gpu: &Gpu,
    label: &str,
    width: u32,
    height: u32,
    rgba: &[u8],
    srgb: bool,
    mips: bool,
) -> GpuTexture {
    assert_eq!(
        rgba.len(),
        (width * height * 4) as usize,
        "{label}: bad rgba size"
    );
    let mip_level_count = if mips {
        32 - width.max(height).leading_zeros()
    } else {
        1
    };
    let format = if srgb {
        wgpu::TextureFormat::Rgba8UnormSrgb
    } else {
        wgpu::TextureFormat::Rgba8Unorm
    };
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });

    let mut level_data: Vec<u8> = rgba.to_vec();
    let (mut w, mut h) = (width, height);
    for level in 0..mip_level_count {
        gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: level,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &level_data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(w * 4),
                rows_per_image: Some(h),
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        if level + 1 < mip_level_count {
            let (nw, nh) = ((w / 2).max(1), (h / 2).max(1));
            level_data = downsample(&level_data, w, h, nw, nh);
            (w, h) = (nw, nh);
        }
    }

    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    GpuTexture {
        texture,
        view,
        size: (width, height),
    }
}

fn downsample(src: &[u8], w: u32, h: u32, nw: u32, nh: u32) -> Vec<u8> {
    let mut out = vec![0u8; (nw * nh * 4) as usize];
    for y in 0..nh {
        for x in 0..nw {
            let mut acc = [0u32; 4];
            let mut count = 0u32;
            for dy in 0..2u32 {
                for dx in 0..2u32 {
                    let sx = (x * 2 + dx).min(w - 1);
                    let sy = (y * 2 + dy).min(h - 1);
                    let si = ((sy * w + sx) * 4) as usize;
                    for c in 0..4 {
                        acc[c] += src[si + c] as u32;
                    }
                    count += 1;
                }
            }
            let di = ((y * nw + x) * 4) as usize;
            for c in 0..4 {
                out[di + c] = (acc[c] / count) as u8;
            }
        }
    }
    out
}

/// Standard samplers shared across passes.
pub struct Samplers {
    /// Trilinear + anisotropic, repeat — world albedo and model textures.
    pub aniso_repeat: wgpu::Sampler,
    /// Bilinear clamp — lightmap pages.
    pub linear_clamp: wgpu::Sampler,
}

impl Samplers {
    pub fn new(gpu: &Gpu) -> Self {
        let aniso_repeat = gpu.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("aniso repeat"),
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            address_mode_w: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            anisotropy_clamp: 8,
            ..Default::default()
        });
        let linear_clamp = gpu.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("linear clamp"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });
        Self {
            aniso_repeat,
            linear_clamp,
        }
    }
}
