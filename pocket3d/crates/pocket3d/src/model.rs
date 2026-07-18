//! Skinned/static model assets (glTF) and scene instances.

use std::cell::Cell;
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

#[derive(Default, Clone, Copy)]
pub struct ModelLoadOptions {
    /// Halve textures until no side exceeds this (mip-friendly box filter).
    /// Character/prop authoring resolutions routinely exceed what small
    /// windows can display; this is the biggest single memory lever.
    pub max_texture_dim: Option<u32>,
}

pub struct Skin {
    /// Node index per joint.
    pub joints: Vec<usize>,
    pub inverse_bind: Vec<Mat4>,
}

/// One morph target of a primitive, stored sparse: only vertices the target
/// actually displaces. Deltas are in object space (bake transform applied).
pub struct MorphTargetData {
    /// (vertex index within the primitive, position delta).
    pub pos: Vec<(u32, Vec3)>,
    /// (vertex index within the primitive, normal delta).
    pub normal: Vec<(u32, Vec3)>,
}

/// A primitive that carries morph targets. Its base vertices are kept on the
/// CPU; morphed copies are written into a per-instance overlay buffer.
pub struct MorphPrim {
    /// Index into [`ModelAsset::primitives`].
    pub primitive: usize,
    /// First vertex of this primitive in the shared asset vertex buffer.
    pub vertex_base: u32,
    pub vertex_count: u32,
    /// First vertex of this primitive in a [`MorphState`] overlay buffer.
    pub overlay_offset: u32,
    base: Vec<ModelVertex>,
    pub targets: Vec<MorphTargetData>,
}

/// All morph-bearing primitives of one glTF mesh. VRM blend-shape binds
/// address targets as (glTF mesh index, target index), which maps here.
pub struct MorphMesh {
    /// glTF mesh index.
    pub mesh: usize,
    pub target_count: usize,
    pub prims: Vec<MorphPrim>,
}

/// Per-instance morph weights + the GPU overlay holding morphed vertices.
/// Weights are set by game code; the overlay upload happens lazily during
/// render prepare, and costs nothing on frames where no weight changed.
pub struct MorphState {
    /// Parallel to [`ModelAsset::morph_meshes`]; one weight per target.
    weights: Vec<Vec<f32>>,
    /// Bitmask of morph meshes needing recompute (interior mutability so the
    /// renderer can flush during prepare without a `&mut Scene`).
    dirty: Cell<u64>,
    buffer: wgpu::Buffer,
}

impl MorphState {
    /// `mesh_slot` indexes [`ModelAsset::morph_meshes`].
    pub fn set_weight(&mut self, mesh_slot: usize, target: usize, weight: f32) {
        let Some(w) = self
            .weights
            .get_mut(mesh_slot)
            .and_then(|m| m.get_mut(target))
        else {
            return;
        };
        if *w != weight {
            *w = weight;
            let bit = if mesh_slot < 64 {
                1u64 << mesh_slot
            } else {
                u64::MAX
            };
            self.dirty.set(self.dirty.get() | bit);
        }
    }

    pub fn weight(&self, mesh_slot: usize, target: usize) -> f32 {
        self.weights
            .get(mesh_slot)
            .and_then(|m| m.get(target))
            .copied()
            .unwrap_or(0.0)
    }

    pub(crate) fn buffer(&self) -> &wgpu::Buffer {
        &self.buffer
    }

    /// Recompute + upload overlay vertices for meshes whose weights changed.
    pub(crate) fn upload_if_dirty(&self, gpu: &Gpu, asset: &ModelAsset) {
        let dirty = self.dirty.replace(0);
        if dirty == 0 {
            return;
        }
        for (mi, mesh) in asset.morph_meshes.iter().enumerate() {
            if mi < 64 && dirty & (1u64 << mi) == 0 {
                continue;
            }
            let weights = &self.weights[mi];
            for prim in &mesh.prims {
                let mut verts = prim.base.clone();
                for (ti, target) in prim.targets.iter().enumerate() {
                    let w = weights.get(ti).copied().unwrap_or(0.0);
                    if w.abs() < 1e-4 {
                        continue;
                    }
                    for &(vi, d) in &target.pos {
                        let v = &mut verts[vi as usize];
                        v.pos = (Vec3::from(v.pos) + d * w).to_array();
                    }
                    for &(vi, d) in &target.normal {
                        let v = &mut verts[vi as usize];
                        v.normal = (Vec3::from(v.normal) + d * w).to_array();
                    }
                }
                gpu.queue.write_buffer(
                    &self.buffer,
                    prim.overlay_offset as u64 * std::mem::size_of::<ModelVertex>() as u64,
                    bytemuck::cast_slice(&verts),
                );
            }
        }
    }
}

pub struct ModelAsset {
    pub vbuf: wgpu::Buffer,
    pub ibuf: wgpu::Buffer,
    pub primitives: Vec<Primitive>,
    pub skeleton: Skeleton,
    /// All skins in the file. The joint palette concatenates them in order;
    /// vertex joint indices were remapped at load to address the combined
    /// palette (multi-skin characters: body + visor etc.).
    pub skins: Vec<Skin>,
    pub clips: Vec<Clip>,
    /// Meshes carrying morph targets (facial blend shapes etc.).
    pub morph_meshes: Vec<MorphMesh>,
    /// Parallel to `primitives`: (morph mesh slot, prim slot) when morphing.
    pub prim_morph: Vec<Option<(usize, usize)>>,
    /// Rest-pose bounds (object space; skinned primitives measured through
    /// their rest-pose joint matrices, so units/orientation baked into the
    /// rig — cm exports, Z-up meshes — are already resolved).
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
    /// Skins concatenate in file order, matching the load-time joint remap.
    pub fn joint_palette(&self, anim: &AnimState, out: &mut Vec<Mat4>) {
        let mut globals = Vec::new();
        let clip = self.clips.get(anim.clip);
        self.skeleton
            .global_transforms(clip, anim.time, anim.looping, &mut globals);
        self.palette_from_globals(&globals, out);
    }

    /// Joint palette from externally computed node globals (procedural poses:
    /// look-at, physics bones). Same skin concatenation as `joint_palette`.
    pub fn palette_from_globals(&self, globals: &[Mat4], out: &mut Vec<Mat4>) {
        out.clear();
        for skin in &self.skins {
            for (i, &node) in skin.joints.iter().enumerate() {
                out.push(globals[node] * skin.inverse_bind[i]);
            }
        }
        if out.is_empty() {
            out.push(Mat4::IDENTITY);
        }
    }

    /// Which slot in `morph_meshes` a glTF mesh landed in.
    pub fn morph_mesh_slot(&self, gltf_mesh: usize) -> Option<usize> {
        self.morph_meshes.iter().position(|m| m.mesh == gltf_mesh)
    }

    /// Create per-instance morph state (overlay buffer starts at the rest
    /// shape). `None` when the asset has no morph targets.
    pub fn create_morph_state(&self, gpu: &Gpu) -> Option<MorphState> {
        use wgpu::util::DeviceExt;
        if self.morph_meshes.is_empty() {
            return None;
        }
        let mut init: Vec<ModelVertex> = Vec::new();
        for mesh in &self.morph_meshes {
            for prim in &mesh.prims {
                init.extend_from_slice(&prim.base);
            }
        }
        let buffer = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("morph overlay"),
                contents: bytemuck::cast_slice(&init),
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            });
        Some(MorphState {
            weights: self
                .morph_meshes
                .iter()
                .map(|m| vec![0.0; m.target_count])
                .collect(),
            dirty: Cell::new(0),
            buffer,
        })
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
            skins: Vec::new(),
            clips: Vec::new(),
            morph_meshes: Vec::new(),
            prim_morph: vec![None],
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
        Self::load_glb_opts(gpu, layout, samplers, path, &ModelLoadOptions::default())
    }

    pub fn load_glb_opts(
        gpu: &Gpu,
        layout: &wgpu::BindGroupLayout,
        samplers: &Samplers,
        path: &Path,
        opts: &ModelLoadOptions,
    ) -> Result<Arc<Self>> {
        let (doc, buffers, images) =
            gltf::import(path).with_context(|| format!("importing {}", path.display()))?;

        // --- textures ------------------------------------------------------
        // Only upload images a material actually samples (VRM files carry
        // thumbnails and utility maps), and optionally cap texture size —
        // authoring resolutions (4096²) dwarf what a small widget window can
        // ever show, and GPU memory is the dominant cost of a character.
        let used: std::collections::HashSet<usize> = doc
            .materials()
            .filter_map(|m| {
                m.pbr_metallic_roughness()
                    .base_color_texture()
                    .map(|t| t.texture().source().index())
            })
            .collect();
        let mut textures = Vec::new();
        for (i, img) in images.iter().enumerate() {
            if !used.contains(&i) {
                textures.push(create_rgba_texture(gpu, "unused", 1, 1, &[255; 4], true, false));
                continue;
            }
            let mut rgba = to_rgba8(img);
            let (mut w, mut h) = (img.width, img.height);
            if let Some(max) = opts.max_texture_dim {
                while w.max(h) > max && w % 2 == 0 && h % 2 == 0 {
                    rgba = downsample_rgba(&rgba, w, h);
                    w /= 2;
                    h /= 2;
                }
            }
            textures.push(create_rgba_texture(
                gpu,
                &format!("model img {i}"),
                w,
                h,
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

        // --- skins -----------------------------------------------------------
        // All of them: multi-skin characters (body + visor) address one
        // concatenated joint palette, so each skin gets a base offset and the
        // vertex joint indices are remapped below.
        let skins: Vec<Skin> = doc
            .skins()
            .map(|s| {
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
            })
            .collect();
        let skin_base: Vec<u32> = skins
            .iter()
            .scan(0u32, |acc, s| {
                let base = *acc;
                *acc += s.joints.len() as u32;
                Some(base)
            })
            .collect();

        // --- meshes ----------------------------------------------------------
        // Global transforms of the rest pose, to bake node placement into
        // non-skinned primitives.
        let mut rest_globals = Vec::new();
        skeleton.global_transforms(None, 0.0, false, &mut rest_globals);

        let mut vertices: Vec<ModelVertex> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();
        let mut primitives_meta: Vec<(u32, u32, Option<usize>)> = Vec::new(); // (first, count, image)
        let mut aabb = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
        let mut morph_meshes: Vec<MorphMesh> = Vec::new();
        let mut prim_morph: Vec<Option<(usize, usize)>> = Vec::new();
        let mut overlay_verts: u32 = 0;

        for node in doc.nodes() {
            let Some(mesh) = node.mesh() else { continue };
            let node_skin = node.skin().map(|s| s.index()).filter(|&i| i < skins.len());
            let bake = if node_skin.is_some() {
                Mat4::IDENTITY
            } else {
                rest_globals[node.index()]
            };
            let normal_bake = bake.inverse().transpose();
            // Rest-pose joint matrices for measuring skinned bounds: raw
            // vertices can live in an arbitrary rig space (cm, Z-up); only
            // the skinned result is in object space.
            let rest_palette: Vec<Mat4> = node_skin
                .map(|si| {
                    let s = &skins[si];
                    s.joints
                        .iter()
                        .enumerate()
                        .map(|(i, &n)| rest_globals[n] * s.inverse_bind[i])
                        .collect()
                })
                .unwrap_or_default();

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
                    let (j, w) = match node_skin {
                        Some(si) => {
                            // Bounds from the rest-pose skinned position.
                            let raw = Vec3::from(positions[i]);
                            let mut rest = Vec3::ZERO;
                            for k in 0..4 {
                                let m = rest_palette.get(joints[i][k] as usize);
                                if let Some(m) = m {
                                    rest += m.transform_point3(raw) * weights[i][k];
                                }
                            }
                            aabb.0 = aabb.0.min(rest);
                            aabb.1 = aabb.1.max(rest);
                            let base = skin_base[si];
                            (
                                [
                                    base + joints[i][0] as u32,
                                    base + joints[i][1] as u32,
                                    base + joints[i][2] as u32,
                                    base + joints[i][3] as u32,
                                ],
                                weights[i],
                            )
                        }
                        None => {
                            aabb.0 = aabb.0.min(p);
                            aabb.1 = aabb.1.max(p);
                            ([0; 4], [1.0, 0.0, 0.0, 0.0])
                        }
                    };
                    vertices.push(ModelVertex {
                        pos: p.to_array(),
                        normal: n.to_array(),
                        uv: uvs[i],
                        joints: j,
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

                // --- morph targets (sparse deltas, object space) -----------
                let mut targets: Vec<MorphTargetData> = Vec::new();
                for (tpos, tnorm, _ttan) in reader.read_morph_targets() {
                    let mut target = MorphTargetData {
                        pos: Vec::new(),
                        normal: Vec::new(),
                    };
                    if let Some(it) = tpos {
                        for (i, d) in it.enumerate() {
                            let d = bake.transform_vector3(Vec3::from(d));
                            if d.length_squared() > 1e-12 {
                                target.pos.push((i as u32, d));
                            }
                        }
                    }
                    if let Some(it) = tnorm {
                        for (i, d) in it.enumerate() {
                            let d = normal_bake.transform_vector3(Vec3::from(d));
                            if d.length_squared() > 1e-12 {
                                target.normal.push((i as u32, d));
                            }
                        }
                    }
                    targets.push(target);
                }
                if targets.is_empty() {
                    prim_morph.push(None);
                } else {
                    let mesh_idx = mesh.index();
                    let slot = morph_meshes
                        .iter()
                        .position(|m| m.mesh == mesh_idx)
                        .unwrap_or_else(|| {
                            morph_meshes.push(MorphMesh {
                                mesh: mesh_idx,
                                target_count: targets.len(),
                                prims: Vec::new(),
                            });
                            morph_meshes.len() - 1
                        });
                    let vertex_count = (vertices.len() as u32) - base;
                    let mm = &mut morph_meshes[slot];
                    mm.target_count = mm.target_count.max(targets.len());
                    prim_morph.push(Some((slot, mm.prims.len())));
                    mm.prims.push(MorphPrim {
                        primitive: primitives_meta.len(),
                        vertex_base: base,
                        vertex_count,
                        overlay_offset: overlay_verts,
                        base: vertices[base as usize..].to_vec(),
                        targets,
                    });
                    overlay_verts += vertex_count;
                }

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
            "{}: {} verts, {} clips {:?}, {} skin(s), {} joints",
            path.display(),
            vertices.len(),
            clips.len(),
            clips.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            skins.len(),
            skins.iter().map(|s| s.joints.len()).sum::<usize>()
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
            skins,
            clips,
            morph_meshes,
            prim_morph,
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
    v.as_chunks::<3>().0.iter().map(|c| c[1]).collect()
}

/// Box-filter 2×2 downsample (straight alpha; fine for albedo maps).
fn downsample_rgba(px: &[u8], w: u32, h: u32) -> Vec<u8> {
    let (nw, nh) = (w / 2, h / 2);
    let mut out = Vec::with_capacity((nw * nh * 4) as usize);
    for y in 0..nh {
        for x in 0..nw {
            let mut acc = [0u32; 4];
            for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                let src = (((y * 2 + dy) * w + x * 2 + dx) * 4) as usize;
                for c in 0..4 {
                    acc[c] += px[src + c] as u32;
                }
            }
            out.extend(acc.map(|v| (v / 4) as u8));
        }
    }
    out
}

fn to_rgba8(img: &gltf::image::Data) -> Vec<u8> {
    use gltf::image::Format;
    let n = (img.width * img.height) as usize;
    match img.format {
        Format::R8G8B8A8 => img.pixels.clone(),
        Format::R8G8B8 => {
            let mut out = Vec::with_capacity(n * 4);
            for c in img.pixels.as_chunks::<3>().0 {
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
            for c in img.pixels.as_chunks::<2>().0 {
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
    /// Explicit node globals (from `Skeleton::globals_from_locals`) override
    /// `anim` when set — for procedurally posed characters.
    pub pose: Option<Vec<Mat4>>,
    /// Morph weights + overlay buffer; create via `asset.create_morph_state`.
    pub morph: Option<MorphState>,
    /// Alpha-test threshold for this instance's primitives (0 = off).
    /// Anime-style characters use cutout textures for hair/lashes.
    pub cutout: f32,
}

impl ModelInstance {
    pub fn new(asset: Arc<ModelAsset>) -> Self {
        Self {
            asset,
            transform: Mat4::IDENTITY,
            tint: [1.0; 4],
            anim: AnimState::default(),
            lit: 1.0,
            pose: None,
            morph: None,
            cutout: 0.0,
        }
    }
}
