//! Static lightmapped world geometry (format-agnostic).
//!
//! World formats (BSP today, anything later) produce a [`WorldSource`]; the
//! runtime uploads it once into a [`WorldModel`]. With feature `bsp`, a
//! `MapData` from `pocket3d-bsp` converts directly.

use bytemuck::{Pod, Zeroable};

use crate::gpu::Gpu;
use crate::texture::{GpuTexture, Samplers, create_rgba_texture};

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct WorldVertex {
    pub pos: [f32; 3],
    pub uv: [f32; 2],
    pub lm_uv: [f32; 2],
}

impl WorldVertex {
    pub const LAYOUT: wgpu::VertexBufferLayout<'static> = wgpu::VertexBufferLayout {
        array_stride: std::mem::size_of::<WorldVertex>() as u64,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x2, 2 => Float32x2],
    };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorldBatchKind {
    Opaque,
    AlphaTest,
    Sky,
}

pub struct SourceBatch {
    pub texture: usize,
    pub lightmap_page: usize,
    pub kind: WorldBatchKind,
    pub first_index: u32,
    pub index_count: u32,
}

pub struct SourceImage<'a> {
    pub width: u32,
    pub height: u32,
    pub rgba: &'a [u8],
}

/// Plain-data world description handed to the GPU uploader.
pub struct WorldSource<'a> {
    pub vertices: &'a [WorldVertex],
    pub indices: &'a [u32],
    pub batches: &'a [SourceBatch],
    pub textures: Vec<SourceImage<'a>>,
    pub lightmap_pages: Vec<SourceImage<'a>>,
}

pub struct WorldBatch {
    pub kind: WorldBatchKind,
    pub bind_group: wgpu::BindGroup,
    pub first_index: u32,
    pub index_count: u32,
}

pub struct WorldModel {
    pub vbuf: wgpu::Buffer,
    pub ibuf: wgpu::Buffer,
    pub batches: Vec<WorldBatch>,
    #[allow(dead_code)]
    textures: Vec<GpuTexture>,
    #[allow(dead_code)]
    lightmaps: Vec<GpuTexture>,
}

impl WorldModel {
    /// The material bind group layout world pipelines use (group 1).
    pub fn material_layout(gpu: &Gpu) -> wgpu::BindGroupLayout {
        gpu.device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("world material"),
                entries: &[
                    texture_entry(0),
                    sampler_entry(1),
                    texture_entry(2),
                    sampler_entry(3),
                ],
            })
    }

    pub fn new(
        gpu: &Gpu,
        layout: &wgpu::BindGroupLayout,
        samplers: &Samplers,
        source: &WorldSource,
    ) -> Self {
        use wgpu::util::DeviceExt;
        let vbuf = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("world vbuf"),
                contents: bytemuck::cast_slice(source.vertices),
                usage: wgpu::BufferUsages::VERTEX,
            });
        let ibuf = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("world ibuf"),
                contents: bytemuck::cast_slice(source.indices),
                usage: wgpu::BufferUsages::INDEX,
            });

        let textures: Vec<GpuTexture> = source
            .textures
            .iter()
            .enumerate()
            .map(|(i, img)| {
                create_rgba_texture(
                    gpu,
                    &format!("world tex {i}"),
                    img.width,
                    img.height,
                    img.rgba,
                    true,
                    true,
                )
            })
            .collect();
        let lightmaps: Vec<GpuTexture> = source
            .lightmap_pages
            .iter()
            .enumerate()
            .map(|(i, img)| {
                create_rgba_texture(
                    gpu,
                    &format!("lightmap page {i}"),
                    img.width,
                    img.height,
                    img.rgba,
                    false,
                    false,
                )
            })
            .collect();

        let fallback_lm = &lightmaps[0];
        let batches = source
            .batches
            .iter()
            .map(|b| {
                let albedo = &textures[b.texture.min(textures.len() - 1)];
                let lm = lightmaps.get(b.lightmap_page).unwrap_or(fallback_lm);
                let bind_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("world batch"),
                    layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(&albedo.view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::Sampler(&samplers.aniso_repeat),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: wgpu::BindingResource::TextureView(&lm.view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: wgpu::BindingResource::Sampler(&samplers.linear_clamp),
                        },
                    ],
                });
                WorldBatch {
                    kind: b.kind,
                    bind_group,
                    first_index: b.first_index,
                    index_count: b.index_count,
                }
            })
            .collect();

        Self {
            vbuf,
            ibuf,
            batches,
            textures,
            lightmaps,
        }
    }
}

fn texture_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}

fn sampler_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
        count: None,
    }
}

// ---------------------------------------------------------------------------
// First-class BSP support
// ---------------------------------------------------------------------------

#[cfg(feature = "bsp")]
impl WorldModel {
    /// Upload a parsed GoldSrc map.
    pub fn from_bsp(
        gpu: &Gpu,
        layout: &wgpu::BindGroupLayout,
        samplers: &Samplers,
        map: &pocket3d_bsp::MapData,
    ) -> Self {
        use pocket3d_bsp::SurfaceKind;
        use pocket3d_bsp::lightmap::PAGE_SIZE;

        // The layouts are identical; reinterpret instead of copying.
        let vertices: Vec<WorldVertex> = map
            .geometry
            .vertices
            .iter()
            .map(|v| WorldVertex {
                pos: v.pos,
                uv: v.uv,
                lm_uv: v.lm_uv,
            })
            .collect();
        let batches: Vec<SourceBatch> = map
            .geometry
            .batches
            .iter()
            .map(|b| SourceBatch {
                texture: b.texture,
                lightmap_page: b.lm_page,
                kind: match b.kind {
                    SurfaceKind::AlphaTest => WorldBatchKind::AlphaTest,
                    SurfaceKind::Sky => WorldBatchKind::Sky,
                    // Water renders as plain opaque for now.
                    _ => WorldBatchKind::Opaque,
                },
                first_index: b.first_index,
                index_count: b.index_count,
            })
            .collect();
        let textures: Vec<SourceImage> = map
            .textures
            .iter()
            .map(|t| SourceImage {
                width: t.width,
                height: t.height,
                rgba: &t.rgba,
            })
            .collect();
        let lightmap_pages: Vec<SourceImage> = map
            .geometry
            .lightmap_pages
            .iter()
            .map(|p| SourceImage {
                width: PAGE_SIZE,
                height: PAGE_SIZE,
                rgba: p,
            })
            .collect();

        Self::new(
            gpu,
            layout,
            samplers,
            &WorldSource {
                vertices: &vertices,
                indices: &map.geometry.indices,
                batches: &batches,
                textures,
                lightmap_pages,
            },
        )
    }
}
