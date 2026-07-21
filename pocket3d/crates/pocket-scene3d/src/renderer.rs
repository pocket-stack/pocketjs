//! Store -> wgpu. Renders one scene into a rect of any color target:
//! (1) gradient sky, (2) opaque vertex-lit meshes, (3) transparent/additive
//! meshes + sprite/beam pools — one render pass, viewport+scissor set to the
//! sceneQuad rect, own depth texture sized to the target.
//!
//! Geometry uploads are cached by geom id; ids are never reused (ops.ts), so
//! entries never go stale — a freed geom simply stops being referenced (its
//! cache entry is dropped the next frame it is seen dead).
//!
//! Merged static scenery (batch.rs) rides the same pass: the store hands back
//! one [`StaticBatch`] per (draw state, spatial cell), each of which is just a
//! draw whose model matrix is identity because its vertices are already in
//! world space. Batches are frustum-culled and blend-sorted by exactly the
//! code that handles nodes, and the nodes they subsume are skipped in the
//! walk — ge3d.rs does the same thing in the same order, so the two hosts
//! cannot drift.

use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};
use pocket3d::gpu::{DEPTH_FORMAT, DepthTarget, Gpu};

use crate::store::{BEAM_STRIDE, CpuMesh, Material, PoolKind, SPRITE_STRIDE, Store, mat_flags};

/// The sceneQuad rect in target pixels (already clipped by the DrawList's
/// CPU clip stage; clamped again here for the GPU's benefit).
#[derive(Clone, Copy, Debug)]
pub struct SceneRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct GlobalsRaw {
    view_proj: [[f32; 4]; 4],
    cam_right: [f32; 4],
    cam_up: [f32; 4],
    cam_fwd: [f32; 4],
    cam_pos: [f32; 4],
    sun_dir: [f32; 4],
    sun_color: [f32; 4],
    amb_sky: [f32; 4],
    amb_ground: [f32; 4],
    fog_color: [f32; 4],
    fog_params: [f32; 4],
    sky_zenith: [f32; 4],
    sky_horizon: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct DrawRaw {
    model: [[f32; 4]; 4],
    color: [f32; 4],
    misc: [u32; 4],
}

/// Dynamic-offset stride for per-draw uniforms (wgpu default alignment).
const DRAW_STRIDE: u64 = 256;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct MeshVertex {
    pos: [f32; 3],
    normal: [f32; 3],
    color: [f32; 3],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct PoolVertex {
    pos: [f32; 3],
    uv: [f32; 2],
    color: u32, // ABGR bytes = little-endian r,g,b,a = Unorm8x4 rgba
}

struct GpuGeom {
    vbuf: wgpu::Buffer,
    ibuf: wgpu::Buffer,
    index_count: u32,
    /// Local-space bounding sphere (AABB midpoint + max vertex distance from
    /// it) — the frustum-cull bound, mirroring ge3d.rs's `bake_geom`.
    bound_center: Vec3,
    bound_radius: f32,
}

/// Six frustum planes (a,b,c,d) with unit normals, inside = ax+by+cz+d >= 0.
///
/// Culling is a pure optimization: the sphere encloses every vertex and its
/// radius is scaled by the world matrix's longest basis vector, so a rejected
/// draw provably covers no pixel — VERIFIED, rally screenshots at frames 30 /
/// 120 / 400 are byte-identical with and without it. It exists on BOTH
/// renderers so the PSP and desktop paths stay the same algorithm; measured on
/// rally it takes 707 submissions / 23,585 triangles per frame down to ~66 /
/// ~6,400 (see ge3d.rs, where that also buys back GE time).
struct Frustum {
    planes: [[f32; 4]; 6],
}

impl Frustum {
    /// Gribb-Hartmann extraction from `clip = proj * view`. `proj` here is the
    /// DirectX-style 0..1-depth projection wgpu consumes, so the near plane is
    /// row2 alone (ge3d.rs's GL-style -1..1 projection uses `w + z` instead —
    /// that is the only line that differs between the two copies).
    fn from_clip(clip: Mat4) -> Frustum {
        let row = |i: usize| [clip.x_axis[i], clip.y_axis[i], clip.z_axis[i], clip.w_axis[i]];
        let (r0, r1, r2, r3) = (row(0), row(1), row(2), row(3));
        let norm = |mut p: [f32; 4]| {
            let len = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
            if len > 1e-20 {
                let inv = 1.0 / len;
                p[0] *= inv;
                p[1] *= inv;
                p[2] *= inv;
                p[3] *= inv;
            }
            p
        };
        let add = |a: [f32; 4], b: [f32; 4]| [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
        let sub = |a: [f32; 4], b: [f32; 4]| [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
        Frustum {
            planes: [
                norm(add(r3, r0)), // left
                norm(sub(r3, r0)), // right
                norm(add(r3, r1)), // bottom
                norm(sub(r3, r1)), // top
                norm(r2),          // near (0..1 depth)
                norm(sub(r3, r2)), // far
            ],
        }
    }

    /// True when the sphere is entirely outside at least one plane.
    fn rejects(&self, c: Vec3, r: f32) -> bool {
        self.planes
            .iter()
            .any(|p| p[0] * c.x + p[1] * c.y + p[2] * c.z + p[3] < -r)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Blend {
    Opaque,
    Alpha,
    Additive,
}

impl Blend {
    /// A batch carries a material handle like any node does, so the two paths
    /// read the flags through one function rather than two copies of it.
    fn of(flags: u32) -> Blend {
        if flags & mat_flags::ADDITIVE != 0 {
            Blend::Additive
        } else if flags & mat_flags::TRANSPARENT != 0 {
            Blend::Alpha
        } else {
            Blend::Opaque
        }
    }
}

struct PendingDraw {
    geom: i32,
    offset: u32,
    blend: Blend,
    double_sided: bool,
    /// View depth for back-to-front ordering of the blended set.
    depth: f32,
}

/// u32 ABGR -> gamma-space RGBA floats.
fn abgr_f(c: u32) -> [f32; 4] {
    [
        (c & 0xff) as f32 / 255.0,
        ((c >> 8) & 0xff) as f32 / 255.0,
        ((c >> 16) & 0xff) as f32 / 255.0,
        ((c >> 24) & 0xff) as f32 / 255.0,
    ]
}

/// Per-channel ABGR x ABGR (the tint/entry-color modulate, byte math).
fn abgr_mul(a: u32, b: u32) -> u32 {
    let ch = |sa: u32, sb: u32| ((a >> sa & 0xff) * (b >> sb & 0xff) / 255) << sa;
    ch(0, 0) | ch(8, 8) | ch(16, 16) | ch(24, 24)
}

pub struct SceneRenderer {
    globals_buf: wgpu::Buffer,
    globals_bg: wgpu::BindGroup,
    draw_bgl: wgpu::BindGroupLayout,
    draw_buf: wgpu::Buffer,
    draw_bg: wgpu::BindGroup,
    draw_capacity: u64,
    pipe_sky: wgpu::RenderPipeline,
    /// [opaque, alpha, additive] x [cull-back, double-sided].
    pipe_mesh: [[wgpu::RenderPipeline; 2]; 3],
    pipe_pool_alpha: wgpu::RenderPipeline,
    pipe_pool_additive: wgpu::RenderPipeline,
    geoms: HashMap<i32, GpuGeom>,
    depth: Option<DepthTarget>,
    pool_vbuf: wgpu::Buffer,
    pool_vbuf_capacity: u64,
}

impl SceneRenderer {
    pub fn new(gpu: &Gpu, target_format: wgpu::TextureFormat) -> SceneRenderer {
        let device = &gpu.device;
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("pocket-scene3d shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/scene3d.wgsl").into()),
        });

        let globals_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("scene3d globals bgl"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let globals_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("scene3d globals"),
            size: size_of::<GlobalsRaw>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let globals_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("scene3d globals bg"),
            layout: &globals_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: globals_buf.as_entire_binding(),
            }],
        });

        let draw_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("scene3d draw bgl"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: true,
                    min_binding_size: wgpu::BufferSize::new(size_of::<DrawRaw>() as u64),
                },
                count: None,
            }],
        });
        let draw_capacity = 64 * DRAW_STRIDE;
        let draw_buf = Self::make_draw_buf(device, draw_capacity);
        let draw_bg = Self::make_draw_bg(device, &draw_bgl, &draw_buf);

        // -- sky ------------------------------------------------------------
        let sky_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("scene3d sky layout"),
            bind_group_layouts: &[&globals_bgl],
            push_constant_ranges: &[],
        });
        let pipe_sky = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("scene3d sky"),
            layout: Some(&sky_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_sky"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_sky"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: target_format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: false,
                depth_compare: wgpu::CompareFunction::Always,
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        // -- meshes -----------------------------------------------------------
        let mesh_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("scene3d mesh layout"),
            bind_group_layouts: &[&globals_bgl, &draw_bgl],
            push_constant_ranges: &[],
        });
        let make_mesh = |blend: Blend, double_sided: bool| {
            let (blend_state, fs, depth_write) = match blend {
                Blend::Opaque => (None, "fs_mesh_opaque", true),
                Blend::Alpha => (Some(wgpu::BlendState::ALPHA_BLENDING), "fs_mesh", false),
                Blend::Additive => (
                    Some(wgpu::BlendState {
                        color: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::SrcAlpha,
                            dst_factor: wgpu::BlendFactor::One,
                            operation: wgpu::BlendOperation::Add,
                        },
                        alpha: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::One,
                            dst_factor: wgpu::BlendFactor::One,
                            operation: wgpu::BlendOperation::Add,
                        },
                    }),
                    "fs_mesh",
                    false,
                ),
            };
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("scene3d mesh"),
                layout: Some(&mesh_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_mesh"),
                    compilation_options: Default::default(),
                    buffers: &[wgpu::VertexBufferLayout {
                        array_stride: size_of::<MeshVertex>() as u64,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &wgpu::vertex_attr_array![
                            0 => Float32x3,
                            1 => Float32x3,
                            2 => Float32x3,
                        ],
                    }],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(fs),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: target_format,
                        blend: blend_state,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    cull_mode: (!double_sided).then_some(wgpu::Face::Back),
                    ..Default::default()
                },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: DEPTH_FORMAT,
                    depth_write_enabled: depth_write,
                    depth_compare: wgpu::CompareFunction::LessEqual,
                    stencil: Default::default(),
                    bias: Default::default(),
                }),
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            })
        };
        let pipe_mesh = [
            [make_mesh(Blend::Opaque, false), make_mesh(Blend::Opaque, true)],
            [make_mesh(Blend::Alpha, false), make_mesh(Blend::Alpha, true)],
            [make_mesh(Blend::Additive, false), make_mesh(Blend::Additive, true)],
        ];

        // -- pools ---------------------------------------------------------------
        let make_pool = |additive: bool| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("scene3d pool"),
                layout: Some(&sky_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_pool"),
                    compilation_options: Default::default(),
                    buffers: &[wgpu::VertexBufferLayout {
                        array_stride: size_of::<PoolVertex>() as u64,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &wgpu::vertex_attr_array![
                            0 => Float32x3,
                            1 => Float32x2,
                            2 => Unorm8x4,
                        ],
                    }],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_pool"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: target_format,
                        blend: Some(if additive {
                            wgpu::BlendState {
                                color: wgpu::BlendComponent {
                                    src_factor: wgpu::BlendFactor::SrcAlpha,
                                    dst_factor: wgpu::BlendFactor::One,
                                    operation: wgpu::BlendOperation::Add,
                                },
                                alpha: wgpu::BlendComponent {
                                    src_factor: wgpu::BlendFactor::One,
                                    dst_factor: wgpu::BlendFactor::One,
                                    operation: wgpu::BlendOperation::Add,
                                },
                            }
                        } else {
                            wgpu::BlendState::ALPHA_BLENDING
                        }),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    cull_mode: None,
                    ..Default::default()
                },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: DEPTH_FORMAT,
                    depth_write_enabled: false,
                    depth_compare: wgpu::CompareFunction::LessEqual,
                    stencil: Default::default(),
                    bias: Default::default(),
                }),
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            })
        };
        let pipe_pool_alpha = make_pool(false);
        let pipe_pool_additive = make_pool(true);

        let pool_vbuf_capacity = 16 * 1024;
        let pool_vbuf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("scene3d pool vbuf"),
            size: pool_vbuf_capacity,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        SceneRenderer {
            globals_buf,
            globals_bg,
            draw_bgl,
            draw_buf,
            draw_bg,
            draw_capacity,
            pipe_sky,
            pipe_mesh,
            pipe_pool_alpha,
            pipe_pool_additive,
            geoms: HashMap::new(),
            depth: None,
            pool_vbuf,
            pool_vbuf_capacity,
        }
    }

    fn make_draw_buf(device: &wgpu::Device, size: u64) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("scene3d draws"),
            size,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }

    fn make_draw_bg(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        buf: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("scene3d draw bg"),
            layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: buf,
                    offset: 0,
                    size: wgpu::BufferSize::new(size_of::<DrawRaw>() as u64),
                }),
            }],
        })
    }

    fn upload_geom(gpu: &Gpu, mesh: &CpuMesh) -> GpuGeom {
        let white = [1.0f32; 3];
        let verts: Vec<MeshVertex> = (0..mesh.positions.len())
            .map(|i| MeshVertex {
                pos: mesh.positions[i],
                normal: mesh.normals[i],
                color: mesh.colors.as_ref().map_or(white, |c| c[i]),
            })
            .collect();
        let vbuf = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("scene3d geom vbuf"),
            size: (verts.len() * size_of::<MeshVertex>()).max(4) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        gpu.queue.write_buffer(&vbuf, 0, bytemuck::cast_slice(&verts));
        let ibuf = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("scene3d geom ibuf"),
            size: (mesh.indices.len() * 4).max(4) as u64,
            usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        gpu.queue.write_buffer(&ibuf, 0, bytemuck::cast_slice(&mesh.indices));
        let mut lo = Vec3::splat(f32::INFINITY);
        let mut hi = Vec3::splat(f32::NEG_INFINITY);
        for p in &mesh.positions {
            let v = Vec3::from_array(*p);
            lo = lo.min(v);
            hi = hi.max(v);
        }
        let bound_center = if mesh.positions.is_empty() { Vec3::ZERO } else { (lo + hi) * 0.5 };
        let bound_radius = mesh
            .positions
            .iter()
            .map(|p| (Vec3::from_array(*p) - bound_center).length_squared())
            .fold(0.0f32, f32::max)
            .sqrt();
        GpuGeom {
            vbuf,
            ibuf,
            index_count: mesh.indices.len() as u32,
            bound_center,
            bound_radius,
        }
    }

    /// Render `scene_handle` of `store` into `rect` of `target_view`.
    /// Returns false (recording nothing) when the scene is dead or the rect
    /// is empty. `load` is Clear for the frame's first pass, Load after.
    #[allow(clippy::too_many_arguments)]
    pub fn render(
        &mut self,
        gpu: &Gpu,
        encoder: &mut wgpu::CommandEncoder,
        target_view: &wgpu::TextureView,
        target_size: (u32, u32),
        store: &mut Store,
        scene_handle: i32,
        rect: SceneRect,
        load: wgpu::LoadOp<wgpu::Color>,
    ) -> bool {
        // Merge frozen scenery before anything reads the scene. This is the
        // only mutable touch of the store in the whole pass, and it is
        // idempotent, so the shared reborrow below covers the rest.
        store.ensure_static_batches(scene_handle);
        let store: &Store = store;
        let Some(scene) = store.scene(scene_handle) else { return false };
        // Clamp the rect to the target (integer viewport == scissor).
        let x0 = (rect.x.max(0.0) as u32).min(target_size.0);
        let y0 = (rect.y.max(0.0) as u32).min(target_size.1);
        let x1 = ((rect.x + rect.w).max(0.0) as u32).min(target_size.0);
        let y1 = ((rect.y + rect.h).max(0.0) as u32).min(target_size.1);
        let (rw, rh) = (x1.saturating_sub(x0), y1.saturating_sub(y0));
        if rw == 0 || rh == 0 {
            return false;
        }
        if self.depth.as_ref().map(|d| d.size) != Some(target_size) {
            self.depth = Some(DepthTarget::new(gpu, target_size.0, target_size.1));
        }

        // -- globals ---------------------------------------------------------
        let env = &scene.env;
        let cam = env.camera;
        let aspect = rw as f32 / rh as f32;
        let znear = cam.znear.max(1e-3);
        let zfar = cam.zfar.max(znear + 1e-3);
        let view = Mat4::from_rotation_translation(cam.q, cam.p).inverse();
        // DirectX-style 0..1 clip depth, matching wgpu (pocket3d::camera).
        let proj = glam::camera::rh::proj::directx::perspective(cam.fov_y, aspect, znear, zfar);
        let right = cam.q * Vec3::X;
        let up = cam.q * Vec3::Y;
        let fwd = cam.q * Vec3::NEG_Z;
        let tan_f = (cam.fov_y * 0.5).tan();
        let rgb1 = |c: u32| {
            let f = abgr_f(c);
            [f[0], f[1], f[2], 1.0]
        };
        let globals = GlobalsRaw {
            view_proj: (proj * view).to_cols_array_2d(),
            cam_right: right.extend(tan_f * aspect).to_array(),
            cam_up: up.extend(tan_f).to_array(),
            cam_fwd: fwd.extend(0.0).to_array(),
            cam_pos: cam.p.extend(0.0).to_array(),
            sun_dir: env
                .sun
                .map_or([0.0; 4], |(d, _)| d.extend(1.0).to_array()),
            sun_color: env.sun.map_or([0.0; 4], |(_, c)| rgb1(c)),
            amb_sky: env.ambient.map_or([0.0; 4], |(s, _)| {
                let mut v = rgb1(s);
                v[3] = 1.0;
                v
            }),
            amb_ground: env.ambient.map_or([0.0; 4], |(_, g)| rgb1(g)),
            fog_color: env.fog.map_or([0.0; 4], |(c, _, _)| {
                let mut v = rgb1(c);
                v[3] = 1.0;
                v
            }),
            fog_params: env.fog.map_or([0.0; 4], |(_, n, f)| [n, f, 0.0, 0.0]),
            sky_zenith: env.sky.map_or([0.0; 4], |(z, _)| rgb1(z)),
            sky_horizon: env.sky.map_or([0.0; 4], |(_, h)| rgb1(h)),
        };
        gpu.queue.write_buffer(&self.globals_buf, 0, bytemuck::bytes_of(&globals));

        // -- collect draws (world transforms top-down, visibility pruned) -----
        let frustum = Frustum::from_clip(proj * view);
        let mut draws: Vec<PendingDraw> = Vec::new();
        let mut draw_data: Vec<DrawRaw> = Vec::new();

        // Merged static scenery first. Identity model matrix (batch vertices
        // are world-space already), the batch's own bounding sphere through
        // the same frustum test, and the same opaque/blended split — a batch
        // is a normal draw that happens to cover a whole cell of the map.
        for b in store.static_batches(scene_handle) {
            if frustum.rejects(b.bound_center, b.bound_radius) {
                continue;
            }
            let Some(mesh) = store.geom(b.geom) else { continue };
            if mesh.indices.is_empty() {
                continue;
            }
            let Some(Material { color, flags }) = store.material(b.mat) else { continue };
            self.geoms.entry(b.geom).or_insert_with(|| Self::upload_geom(gpu, mesh));
            draws.push(PendingDraw {
                geom: b.geom,
                offset: (draw_data.len() as u64 * DRAW_STRIDE) as u32,
                blend: Blend::of(flags),
                double_sided: flags & mat_flags::DOUBLE_SIDED != 0,
                // The batch's centre, not its (identity) origin: the blended
                // ordering is a distance sort, and a world-space batch's
                // origin is wherever the scene's origin happens to sit.
                depth: (b.bound_center - cam.p).dot(fwd),
            });
            draw_data.push(DrawRaw {
                model: Mat4::IDENTITY.to_cols_array_2d(),
                color: {
                    let m = abgr_f(color);
                    let t = abgr_f(b.tint);
                    [m[0] * t[0], m[1] * t[1], m[2] * t[2], m[3] * t[3]]
                },
                misc: [flags, 0, 0, 0],
            });
        }

        let mut stack: Vec<(i32, Mat4)> = scene
            .root
            .iter()
            .rev()
            .map(|&id| (id, Mat4::IDENTITY))
            .collect();
        while let Some((id, parent_world)) = stack.pop() {
            let Some(node) = store.node(id) else { continue };
            if !node.visible {
                continue; // hidden nodes hide their subtree
            }
            let world =
                parent_world * Mat4::from_scale_rotation_translation(node.s, node.q, node.p);
            for &c in node.children.iter().rev() {
                stack.push((c, world));
            }
            // A batch already drew this node's mesh. Its children are NOT
            // implied — freeze is per node, and a frozen post can carry a
            // moving flag — so this skips the draw only, after the descent.
            if store.node_batched(id) {
                continue;
            }
            if node.geom == 0 || node.mat == 0 {
                continue; // bare group
            }
            let Some(mesh) = store.geom(node.geom) else { continue }; // dangling: draws nothing
            if mesh.indices.is_empty() {
                continue;
            }
            let Some(Material { color, flags }) = store.material(node.mat) else { continue };
            let geom = self
                .geoms
                .entry(node.geom)
                .or_insert_with(|| Self::upload_geom(gpu, mesh));
            // Cull HERE, not by skipping the subtree: a group node's own
            // bounds say nothing about where its children sit in this store.
            let center = world.transform_point3(geom.bound_center);
            let scale2 = world
                .x_axis
                .truncate()
                .length_squared()
                .max(world.y_axis.truncate().length_squared())
                .max(world.z_axis.truncate().length_squared());
            if frustum.rejects(center, geom.bound_radius * scale2.sqrt()) {
                continue;
            }
            let pos = world.w_axis.truncate();
            draws.push(PendingDraw {
                geom: node.geom,
                offset: (draw_data.len() as u64 * DRAW_STRIDE) as u32,
                blend: Blend::of(flags),
                double_sided: flags & mat_flags::DOUBLE_SIDED != 0,
                depth: (pos - cam.p).dot(fwd),
            });
            draw_data.push(DrawRaw {
                model: world.to_cols_array_2d(),
                color: {
                    let m = abgr_f(color);
                    let t = abgr_f(node.tint);
                    [m[0] * t[0], m[1] * t[1], m[2] * t[2], m[3] * t[3]]
                },
                misc: [flags, 0, 0, 0],
            });
        }

        // Upload per-draw uniforms (256-byte strided).
        if !draw_data.is_empty() {
            let bytes_needed = draw_data.len() as u64 * DRAW_STRIDE;
            if bytes_needed > self.draw_capacity {
                self.draw_capacity = bytes_needed.next_power_of_two();
                self.draw_buf = Self::make_draw_buf(&gpu.device, self.draw_capacity);
                self.draw_bg = Self::make_draw_bg(&gpu.device, &self.draw_bgl, &self.draw_buf);
            }
            let mut bytes = vec![0u8; bytes_needed as usize];
            for (i, d) in draw_data.iter().enumerate() {
                let off = i * DRAW_STRIDE as usize;
                bytes[off..off + size_of::<DrawRaw>()].copy_from_slice(bytemuck::bytes_of(d));
            }
            gpu.queue.write_buffer(&self.draw_buf, 0, &bytes);
        }

        // -- pool vertices (billboards face the camera; ribbons face it too) --
        let mut pool_verts: Vec<PoolVertex> = Vec::new();
        let mut pool_ranges: Vec<(u32, u32, bool)> = Vec::new(); // (start, end, additive)
        for &pid in &scene.pools {
            let Some(pool) = store.pool(pid) else { continue };
            if pool.count == 0 {
                continue;
            }
            let Some(mat) = store.material(pool.mat) else { continue };
            let additive = mat.flags & mat_flags::ADDITIVE != 0;
            let start = pool_verts.len() as u32;
            let mut quad = |corners: [Vec3; 4], uvs: [[f32; 2]; 4], color: u32| {
                for i in [0usize, 1, 2, 0, 2, 3] {
                    pool_verts.push(PoolVertex { pos: corners[i].to_array(), uv: uvs[i], color });
                }
            };
            match pool.kind {
                PoolKind::Sprite => {
                    for i in 0..pool.count {
                        let e = &pool.live[i * SPRITE_STRIDE..(i + 1) * SPRITE_STRIDE];
                        let p = Vec3::new(e[0], e[1], e[2]);
                        let h = e[3] * 0.5;
                        quad(
                            [
                                p - right * h + up * h,
                                p + right * h + up * h,
                                p + right * h - up * h,
                                p - right * h - up * h,
                            ],
                            [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]],
                            abgr_mul(mat.color, pool.colors[i]),
                        );
                    }
                }
                PoolKind::Beam => {
                    for i in 0..pool.count {
                        let e = &pool.live[i * BEAM_STRIDE..(i + 1) * BEAM_STRIDE];
                        let a = Vec3::new(e[0], e[1], e[2]);
                        let b = Vec3::new(e[3], e[4], e[5]);
                        let mid = (a + b) * 0.5;
                        let side =
                            (b - a).cross(cam.p - mid).normalize_or_zero() * (e[6] * 0.5);
                        // v pinned to 0.5: the soft falloff runs across width.
                        quad(
                            [a - side, b - side, b + side, a + side],
                            [[0.0, 0.5], [0.0, 0.5], [1.0, 0.5], [1.0, 0.5]],
                            abgr_mul(mat.color, pool.colors[i]),
                        );
                    }
                }
            }
            pool_ranges.push((start, pool_verts.len() as u32, additive));
        }
        if !pool_verts.is_empty() {
            let bytes: &[u8] = bytemuck::cast_slice(&pool_verts);
            if bytes.len() as u64 > self.pool_vbuf_capacity {
                self.pool_vbuf_capacity = (bytes.len() as u64).next_power_of_two();
                self.pool_vbuf = gpu.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("scene3d pool vbuf"),
                    size: self.pool_vbuf_capacity,
                    usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
            }
            gpu.queue.write_buffer(&self.pool_vbuf, 0, bytes);
        }

        // Blended set draws back-to-front after all opaques.
        let mut order: Vec<usize> = (0..draws.len()).collect();
        order.sort_by(|&a, &b| {
            let (da, db) = (&draws[a], &draws[b]);
            let ka = da.blend != Blend::Opaque;
            let kb = db.blend != Blend::Opaque;
            ka.cmp(&kb).then(if ka {
                db.depth.total_cmp(&da.depth) // blended: far -> near
            } else {
                std::cmp::Ordering::Equal
            })
        });

        // -- record ------------------------------------------------------------
        let depth_view = &self.depth.as_ref().unwrap().view;
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("scene3d pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target_view,
                resolve_target: None,
                ops: wgpu::Operations { load, store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: depth_view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(1.0),
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        pass.set_viewport(x0 as f32, y0 as f32, rw as f32, rh as f32, 0.0, 1.0);
        pass.set_scissor_rect(x0, y0, rw, rh);
        pass.set_bind_group(0, &self.globals_bg, &[]);

        // (1) sky.
        if env.sky.is_some() {
            pass.set_pipeline(&self.pipe_sky);
            pass.draw(0..3, 0..1);
        }

        // (2) opaque meshes, (3) blended meshes.
        let mut current: Option<(Blend, bool)> = None;
        for i in order {
            let d = &draws[i];
            let Some(geom) = self.geoms.get(&d.geom) else { continue };
            let key = (d.blend, d.double_sided);
            if current != Some(key) {
                let row = match d.blend {
                    Blend::Opaque => 0,
                    Blend::Alpha => 1,
                    Blend::Additive => 2,
                };
                pass.set_pipeline(&self.pipe_mesh[row][d.double_sided as usize]);
                current = Some(key);
            }
            pass.set_bind_group(1, &self.draw_bg, &[d.offset]);
            pass.set_vertex_buffer(0, geom.vbuf.slice(..));
            pass.set_index_buffer(geom.ibuf.slice(..), wgpu::IndexFormat::Uint32);
            pass.draw_indexed(0..geom.index_count, 0, 0..1);
        }

        // (3b) sprite/beam pools.
        if !pool_verts.is_empty() {
            pass.set_vertex_buffer(0, self.pool_vbuf.slice(..));
            for (start, end, additive) in pool_ranges {
                pass.set_pipeline(if additive {
                    &self.pipe_pool_additive
                } else {
                    &self.pipe_pool_alpha
                });
                pass.draw(start..end, 0..1);
            }
        }
        true
    }
}
