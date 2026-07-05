//! Skinned/static model assets (glTF) and scene instances.

use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};

use crate::anim::{AnimState, Channel, ChannelPath, Clip, Interpolation, NodeTrs, Skeleton};
use crate::gpu::Gpu;
use crate::texture::{GpuTexture, Samplers, create_rgba_texture};

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct ModelVertex {
    pub pos: [f32; 3],
    pub normal: [f32; 3],
    pub uv: [f32; 2],
    pub joints: [u32; 4],
    pub weights: [f32; 4],
}

impl ModelVertex {
    pub const LAYOUT: wgpu::VertexBufferLayout<'static> = wgpu::VertexBufferLayout {
        array_stride: std::mem::size_of::<ModelVertex>() as u64,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &wgpu::vertex_attr_array![
            0 => Float32x3, 1 => Float32x3, 2 => Float32x2, 3 => Uint32x4, 4 => Float32x4
        ],
    };
}

pub struct Primitive {
    pub first_index: u32,
    pub index_count: u32,
    pub bind_group: wgpu::BindGroup,
}

pub struct Skin {
    /// Node index per joint.
    pub joints: Vec<usize>,
    pub inverse_bind: Vec<Mat4>,
}

pub struct ModelAsset {
    pub vbuf: wgpu::Buffer,
    pub ibuf: wgpu::Buffer,
    pub primitives: Vec<Primitive>,
    pub skeleton: Skeleton,
    pub skin: Option<Skin>,
    pub clips: Vec<Clip>,
    /// Rest-pose bounds (object space).
    pub aabb: (Vec3, Vec3),
    #[allow(dead_code)]
    textures: Vec<GpuTexture>,
}

impl ModelAsset {
    pub fn clip_named(&self, name: &str) -> Option<usize> {
        self.clips.iter().position(|c| c.name == name)
    }

    pub fn height(&self) -> f32 {
        (self.aabb.1.y - self.aabb.0.y).max(0.001)
    }

    /// Joint palette for the given animation state (identity if no skin).
    pub fn joint_palette(&self, anim: &AnimState, out: &mut Vec<Mat4>) {
        let mut globals = Vec::new();
        let clip = self.clips.get(anim.clip);
        self.skeleton
            .global_transforms(clip, anim.time, anim.looping, &mut globals);
        out.clear();
        match &self.skin {
            Some(skin) => {
                for (i, &node) in skin.joints.iter().enumerate() {
                    out.push(globals[node] * skin.inverse_bind[i]);
                }
            }
            None => out.push(Mat4::IDENTITY),
        }
    }

    /// The material bind group layout for model primitives (group 1).
    pub fn material_layout(gpu: &Gpu) -> wgpu::BindGroupLayout {
        gpu.device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("model material"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            })
    }

    /// Build an asset from raw geometry (procedural models). `image` is an
    /// optional RGBA8 texture; omit it for a plain white surface.
    pub fn from_geometry(
        gpu: &Gpu,
        layout: &wgpu::BindGroupLayout,
        samplers: &Samplers,
        label: &str,
        vertices: &[ModelVertex],
        indices: &[u32],
        image: Option<(u32, u32, &[u8])>,
    ) -> Arc<Self> {
        use wgpu::util::DeviceExt;
        let (tw, th, tpx): (u32, u32, &[u8]) = image.unwrap_or((1, 1, &[255u8, 255, 255, 255]));
        let tex = create_rgba_texture(gpu, label, tw, th, tpx, true, false);
        let bind_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&tex.view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&samplers.aniso_repeat),
                },
            ],
        });
        let vbuf = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: bytemuck::cast_slice(vertices),
                usage: wgpu::BufferUsages::VERTEX,
            });
        let ibuf = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: bytemuck::cast_slice(indices),
                usage: wgpu::BufferUsages::INDEX,
            });
        let mut aabb = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
        for v in vertices {
            let p = Vec3::from(v.pos);
            aabb.0 = aabb.0.min(p);
            aabb.1 = aabb.1.max(p);
        }
        Arc::new(Self {
            vbuf,
            ibuf,
            primitives: vec![Primitive {
                first_index: 0,
                index_count: indices.len() as u32,
                bind_group,
            }],
            skeleton: Skeleton {
                parents: Vec::new(),
                rest: Vec::new(),
                order: Vec::new(),
            },
            skin: None,
            clips: Vec::new(),
            aabb,
            textures: vec![tex],
        })
    }

    pub fn load_glb(
        gpu: &Gpu,
        layout: &wgpu::BindGroupLayout,
        samplers: &Samplers,
        path: &Path,
    ) -> Result<Arc<Self>> {
        let (doc, buffers, images) =
            gltf::import(path).with_context(|| format!("importing {}", path.display()))?;

        // --- textures ------------------------------------------------------
        let mut textures = Vec::new();
        for (i, img) in images.iter().enumerate() {
            let rgba = to_rgba8(img);
            textures.push(create_rgba_texture(
                gpu,
                &format!("model img {i}"),
                img.width,
                img.height,
                &rgba,
                true,
                true,
            ));
        }
        // 1x1 white fallback.
        let white = create_rgba_texture(gpu, "white", 1, 1, &[255, 255, 255, 255], true, false);

        // --- nodes / skeleton ----------------------------------------------
        let node_count = doc.nodes().count();
        let mut parents = vec![usize::MAX; node_count];
        let mut rest = vec![NodeTrs::IDENTITY; node_count];
        for node in doc.nodes() {
            let (t, r, s) = node.transform().decomposed();
            rest[node.index()] = NodeTrs {
                translation: Vec3::from(t),
                rotation: glam::Quat::from_array(r),
                scale: Vec3::from(s),
            };
            for child in node.children() {
                parents[child.index()] = node.index();
            }
        }
        // Parents-first order via DFS from roots.
        let mut order = Vec::with_capacity(node_count);
        let mut stack: Vec<usize> = (0..node_count)
            .filter(|&i| parents[i] == usize::MAX)
            .collect();
        stack.reverse();
        let children_of: Vec<Vec<usize>> = doc
            .nodes()
            .map(|n| n.children().map(|c| c.index()).collect())
            .collect();
        while let Some(i) = stack.pop() {
            order.push(i);
            for &c in children_of[i].iter().rev() {
                stack.push(c);
            }
        }
        let skeleton = Skeleton {
            parents,
            rest,
            order,
        };

        // --- skin ------------------------------------------------------------
        let skin = doc.skins().next().map(|s| {
            let reader = s.reader(|b| buffers.get(b.index()).map(|d| d.0.as_slice()));
            let inverse_bind: Vec<Mat4> = reader
                .read_inverse_bind_matrices()
                .map(|it| it.map(|m| Mat4::from_cols_array_2d(&m)).collect())
                .unwrap_or_default();
            let joints: Vec<usize> = s.joints().map(|j| j.index()).collect();
            let inverse_bind = if inverse_bind.len() == joints.len() {
                inverse_bind
            } else {
                vec![Mat4::IDENTITY; joints.len()]
            };
            Skin {
                joints,
                inverse_bind,
            }
        });

        // --- meshes ----------------------------------------------------------
        // Global transforms of the rest pose, to bake node placement into
        // non-skinned primitives.
        let mut rest_globals = Vec::new();
        skeleton.global_transforms(None, 0.0, false, &mut rest_globals);

        let mut vertices: Vec<ModelVertex> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();
        let mut primitives_meta: Vec<(u32, u32, Option<usize>)> = Vec::new(); // (first, count, image)
        let mut aabb = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));

        for node in doc.nodes() {
            let Some(mesh) = node.mesh() else { continue };
            let skinned = node.skin().is_some() && skin.is_some();
            let bake = if skinned {
                Mat4::IDENTITY
            } else {
                rest_globals[node.index()]
            };
            let normal_bake = bake.inverse().transpose();

            for prim in mesh.primitives() {
                let reader = prim.reader(|b| buffers.get(b.index()).map(|d| d.0.as_slice()));
                let Some(pos_iter) = reader.read_positions() else {
                    continue;
                };
                let base = vertices.len() as u32;

                let positions: Vec<[f32; 3]> = pos_iter.collect();
                let normals: Vec<[f32; 3]> = reader
                    .read_normals()
                    .map(|it| it.collect())
                    .unwrap_or_else(|| vec![[0.0, 1.0, 0.0]; positions.len()]);
                let uvs: Vec<[f32; 2]> = reader
                    .read_tex_coords(0)
                    .map(|it| it.into_f32().collect())
                    .unwrap_or_else(|| vec![[0.0, 0.0]; positions.len()]);
                let joints: Vec<[u16; 4]> = reader
                    .read_joints(0)
                    .map(|it| it.into_u16().collect())
                    .unwrap_or_else(|| vec![[0, 0, 0, 0]; positions.len()]);
                let weights: Vec<[f32; 4]> = reader
                    .read_weights(0)
                    .map(|it| it.into_f32().collect())
                    .unwrap_or_else(|| vec![[1.0, 0.0, 0.0, 0.0]; positions.len()]);

                for i in 0..positions.len() {
                    let p = bake.transform_point3(Vec3::from(positions[i]));
                    let n = normal_bake
                        .transform_vector3(Vec3::from(normals[i]))
                        .normalize_or_zero();
                    aabb.0 = aabb.0.min(p);
                    aabb.1 = aabb.1.max(p);
                    let (j, w) = if skinned {
                        (joints[i], weights[i])
                    } else {
                        ([0; 4], [1.0, 0.0, 0.0, 0.0])
                    };
                    vertices.push(ModelVertex {
                        pos: p.to_array(),
                        normal: n.to_array(),
                        uv: uvs[i],
                        joints: [j[0] as u32, j[1] as u32, j[2] as u32, j[3] as u32],
                        weights: w,
                    });
                }

                let first = indices.len() as u32;
                match reader.read_indices() {
                    Some(idx) => indices.extend(idx.into_u32().map(|i| base + i)),
                    None => indices.extend(base..vertices.len() as u32),
                }
                let count = indices.len() as u32 - first;

                let image = prim
                    .material()
                    .pbr_metallic_roughness()
                    .base_color_texture()
                    .map(|t| t.texture().source().index());
                primitives_meta.push((first, count, image));
            }
        }

        // --- animations -------------------------------------------------------
        let mut clips = Vec::new();
        for anim in doc.animations() {
            let mut channels = Vec::new();
            let mut duration = 0.0f32;
            for ch in anim.channels() {
                let reader = ch.reader(|b| buffers.get(b.index()).map(|d| d.0.as_slice()));
                let Some(times) = reader.read_inputs().map(|it| it.collect::<Vec<f32>>()) else {
                    continue;
                };
                if let Some(&last) = times.last() {
                    duration = duration.max(last);
                }
                let interpolation = match ch.sampler().interpolation() {
                    gltf::animation::Interpolation::Step => Interpolation::Step,
                    // Cubic spline collapses to linear over its key values.
                    _ => Interpolation::Linear,
                };
                let cubic =
                    ch.sampler().interpolation() == gltf::animation::Interpolation::CubicSpline;
                let (path, values) = match reader.read_outputs() {
                    Some(gltf::animation::util::ReadOutputs::Translations(it)) => {
                        (ChannelPath::Translation, flatten3(it.collect(), cubic))
                    }
                    Some(gltf::animation::util::ReadOutputs::Scales(it)) => {
                        (ChannelPath::Scale, flatten3(it.collect(), cubic))
                    }
                    Some(gltf::animation::util::ReadOutputs::Rotations(rot)) => (
                        ChannelPath::Rotation,
                        flatten4(rot.into_f32().collect(), cubic),
                    ),
                    _ => continue,
                };
                channels.push(Channel {
                    node: ch.target().node().index(),
                    path,
                    interpolation,
                    times,
                    values,
                });
            }
            clips.push(Clip {
                name: anim.name().unwrap_or("anim").to_string(),
                duration,
                channels,
            });
        }
        log::info!(
            "{}: {} verts, {} clips {:?}, skin joints {}",
            path.display(),
            vertices.len(),
            clips.len(),
            clips.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            skin.as_ref().map(|s| s.joints.len()).unwrap_or(0)
        );

        // --- upload ------------------------------------------------------------
        use wgpu::util::DeviceExt;
        let vbuf = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("model vbuf"),
                contents: bytemuck::cast_slice(&vertices),
                usage: wgpu::BufferUsages::VERTEX,
            });
        let ibuf = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("model ibuf"),
                contents: bytemuck::cast_slice(&indices),
                usage: wgpu::BufferUsages::INDEX,
            });

        let primitives = primitives_meta
            .into_iter()
            .map(|(first, count, image)| {
                let view = image
                    .and_then(|i| textures.get(i))
                    .map(|t| &t.view)
                    .unwrap_or(&white.view);
                let bind_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("model material"),
                    layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::Sampler(&samplers.aniso_repeat),
                        },
                    ],
                });
                Primitive {
                    first_index: first,
                    index_count: count,
                    bind_group,
                }
            })
            .collect();

        textures.push(white);
        Ok(Arc::new(Self {
            vbuf,
            ibuf,
            primitives,
            skeleton,
            skin,
            clips,
            aabb,
            textures,
        }))
    }
}

fn flatten3(v: Vec<[f32; 3]>, cubic: bool) -> Vec<f32> {
    strip_cubic(v, cubic)
        .into_iter()
        .flat_map(|a| a.into_iter())
        .collect()
}

fn flatten4(v: Vec<[f32; 4]>, cubic: bool) -> Vec<f32> {
    strip_cubic(v, cubic)
        .into_iter()
        .flat_map(|a| a.into_iter())
        .collect()
}

/// Cubic-spline outputs store [in-tangent, value, out-tangent] per key;
/// keep just the values.
fn strip_cubic<T: Copy>(v: Vec<T>, cubic: bool) -> Vec<T> {
    if !cubic {
        return v;
    }
    v.chunks_exact(3).map(|c| c[1]).collect()
}

fn to_rgba8(img: &gltf::image::Data) -> Vec<u8> {
    use gltf::image::Format;
    let n = (img.width * img.height) as usize;
    match img.format {
        Format::R8G8B8A8 => img.pixels.clone(),
        Format::R8G8B8 => {
            let mut out = Vec::with_capacity(n * 4);
            for c in img.pixels.chunks_exact(3) {
                out.extend_from_slice(&[c[0], c[1], c[2], 255]);
            }
            out
        }
        Format::R8 => {
            let mut out = Vec::with_capacity(n * 4);
            for &g in &img.pixels {
                out.extend_from_slice(&[g, g, g, 255]);
            }
            out
        }
        Format::R8G8 => {
            let mut out = Vec::with_capacity(n * 4);
            for c in img.pixels.chunks_exact(2) {
                out.extend_from_slice(&[c[0], c[1], 0, 255]);
            }
            out
        }
        // 16-bit and float formats: take the high byte / clamp.
        _ => {
            log::warn!("unsupported glTF image format {:?}; using grey", img.format);
            vec![128; n * 4]
        }
    }
}

/// A model placed in the scene.
pub struct ModelInstance {
    pub asset: Arc<ModelAsset>,
    pub transform: Mat4,
    pub tint: [f32; 4],
    pub anim: AnimState,
    /// 0..1 how strongly lighting applies (1 = fully lit by sun/ambient).
    pub lit: f32,
}

impl ModelInstance {
    pub fn new(asset: Arc<ModelAsset>) -> Self {
        Self {
            asset,
            transform: Mat4::IDENTITY,
            tint: [1.0; 4],
            anim: AnimState::default(),
            lit: 1.0,
        }
    }
}
