use std::{collections::HashSet, sync::Arc, time::Instant};

use anyhow::{Context, Result, bail};
use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec4};
use pocket3d_core::{InputSnapshot, Vec2};
use pocket3d_render::SceneView;
use wgpu::util::DeviceExt;
use winit::{
    application::ApplicationHandler,
    event::{DeviceEvent, ElementState, MouseButton, WindowEvent},
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop},
    keyboard::{KeyCode, PhysicalKey},
    window::{Window, WindowId},
};

const OPENGL_TO_WGPU: Mat4 = Mat4::from_cols(
    Vec4::new(1.0, 0.0, 0.0, 0.0),
    Vec4::new(0.0, 1.0, 0.0, 0.0),
    Vec4::new(0.0, 0.0, 0.5, 0.0),
    Vec4::new(0.0, 0.0, 0.5, 1.0),
);

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Vertex {
    position: [f32; 3],
    color: [f32; 3],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Uniforms {
    view_proj: [[f32; 4]; 4],
}

pub fn run_game<F>(title: &str, step: F) -> Result<()>
where
    F: 'static + FnMut(&InputSnapshot, f32) -> SceneView,
{
    let event_loop = EventLoop::new()?;
    event_loop.set_control_flow(ControlFlow::Poll);
    let mut app = ViewerApp {
        title: title.to_string(),
        state: None,
        step,
        keys: HashSet::new(),
        mouse_left: false,
        look_delta: Vec2::ZERO,
        last_frame: Instant::now(),
    };
    event_loop.run_app(&mut app)?;
    Ok(())
}

struct ViewerApp<F>
where
    F: FnMut(&InputSnapshot, f32) -> SceneView,
{
    title: String,
    state: Option<GpuState>,
    step: F,
    keys: HashSet<KeyCode>,
    mouse_left: bool,
    look_delta: Vec2,
    last_frame: Instant,
}

impl<F> ApplicationHandler for ViewerApp<F>
where
    F: FnMut(&InputSnapshot, f32) -> SceneView,
{
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.state.is_some() {
            return;
        }
        let attrs = Window::default_attributes()
            .with_title(self.title.clone())
            .with_inner_size(winit::dpi::PhysicalSize::new(1280, 720));
        let window = Arc::new(event_loop.create_window(attrs).expect("create window"));
        self.state = Some(pollster::block_on(GpuState::new(window)).expect("initialize wgpu"));
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        let Some(state_id) = self.state.as_ref().map(|state| state.window.id()) else {
            return;
        };
        if id != state_id {
            return;
        }

        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(size) => {
                if let Some(state) = self.state.as_mut() {
                    state.resize(size.width, size.height);
                }
            }
            WindowEvent::KeyboardInput { event, .. } => {
                if let PhysicalKey::Code(code) = event.physical_key {
                    match event.state {
                        ElementState::Pressed => {
                            self.keys.insert(code);
                            if code == KeyCode::Escape {
                                event_loop.exit();
                            }
                        }
                        ElementState::Released => {
                            self.keys.remove(&code);
                        }
                    }
                }
            }
            WindowEvent::MouseInput {
                button: MouseButton::Left,
                state,
                ..
            } => {
                self.mouse_left = state == ElementState::Pressed;
            }
            WindowEvent::RedrawRequested => {
                let now = Instant::now();
                let dt = (now - self.last_frame).as_secs_f32().min(0.05);
                self.last_frame = now;
                let input = self.input_snapshot();
                let scene = (self.step)(&input, dt);
                self.look_delta = Vec2::ZERO;
                if let Some(state) = self.state.as_mut() {
                    if let Err(err) = state.render(&scene) {
                        log::warn!("render failed: {err:#}");
                    }
                    state.window.request_redraw();
                }
            }
            _ => {}
        }
    }

    fn device_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        _device_id: winit::event::DeviceId,
        event: DeviceEvent,
    ) {
        if let DeviceEvent::MouseMotion { delta } = event {
            self.look_delta += Vec2::new(delta.0 as f32, delta.1 as f32);
        }
    }

    fn about_to_wait(&mut self, _event_loop: &ActiveEventLoop) {
        if let Some(state) = &self.state {
            state.window.request_redraw();
        }
    }
}

impl<F> ViewerApp<F>
where
    F: FnMut(&InputSnapshot, f32) -> SceneView,
{
    fn input_snapshot(&self) -> InputSnapshot {
        let mut movement = Vec2::ZERO;
        if self.keys.contains(&KeyCode::KeyW) {
            movement.y += 1.0;
        }
        if self.keys.contains(&KeyCode::KeyS) {
            movement.y -= 1.0;
        }
        if self.keys.contains(&KeyCode::KeyD) {
            movement.x += 1.0;
        }
        if self.keys.contains(&KeyCode::KeyA) {
            movement.x -= 1.0;
        }
        if movement.length_squared() > 1.0 {
            movement = movement.normalize();
        }
        InputSnapshot {
            movement,
            look_delta: self.look_delta,
            jump: self.keys.contains(&KeyCode::Space),
            fire: self.mouse_left,
            sprint: self.keys.contains(&KeyCode::ShiftLeft)
                || self.keys.contains(&KeyCode::ShiftRight),
            debug_toggle: self.keys.contains(&KeyCode::F3),
        }
    }
}

struct GpuState {
    window: Arc<Window>,
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    uniform_buffer: wgpu::Buffer,
    uniform_bind_group: wgpu::BindGroup,
    depth: DepthTarget,
}

impl GpuState {
    async fn new(window: Arc<Window>) -> Result<Self> {
        let instance = wgpu::Instance::default();
        let surface = instance
            .create_surface(window.clone())
            .context("create wgpu surface")?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
                apply_limit_buckets: false,
            })
            .await
            .context("request wgpu adapter")?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("pocket3d-device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                experimental_features: wgpu::ExperimentalFeatures::disabled(),
                memory_hints: wgpu::MemoryHints::Performance,
                trace: wgpu::Trace::default(),
            })
            .await
            .context("request wgpu device")?;

        let size = window.inner_size();
        let config = surface
            .get_default_config(&adapter, size.width.max(1), size.height.max(1))
            .context("surface default config")?;
        surface.configure(&device, &config);
        let depth = DepthTarget::new(&device, config.width, config.height);

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("pocket3d-shader"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("pocket3d-uniforms"),
            contents: bytemuck::bytes_of(&Uniforms {
                view_proj: Mat4::IDENTITY.to_cols_array_2d(),
            }),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("pocket3d-bind-layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let uniform_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pocket3d-bind-group"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("pocket3d-pipeline-layout"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("pocket3d-pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<Vertex>() as u64,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[
                        wgpu::VertexAttribute {
                            offset: 0,
                            shader_location: 0,
                            format: wgpu::VertexFormat::Float32x3,
                        },
                        wgpu::VertexAttribute {
                            offset: 12,
                            shader_location: 1,
                            format: wgpu::VertexFormat::Float32x3,
                        },
                    ],
                })],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: config.format,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: Some(wgpu::Face::Back),
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DepthTarget::FORMAT,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });

        Ok(Self {
            window,
            surface,
            device,
            queue,
            config,
            pipeline,
            uniform_buffer,
            uniform_bind_group,
            depth,
        })
    }

    fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);
        self.depth = DepthTarget::new(&self.device, width, height);
    }

    fn render(&mut self, scene: &SceneView) -> Result<()> {
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                return Ok(());
            }
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                self.surface.configure(&self.device, &self.config);
                return Ok(());
            }
            wgpu::CurrentSurfaceTexture::Validation => bail!("surface texture validation error"),
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let vertices = build_vertices(scene);
        let vertex_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("pocket3d-frame-vertices"),
                contents: bytemuck::cast_slice(&vertices),
                usage: wgpu::BufferUsages::VERTEX,
            });
        let aspect = self.config.width as f32 / self.config.height.max(1) as f32;
        let view_proj = OPENGL_TO_WGPU
            * Mat4::perspective_rh(
                scene.camera.fov_y_radians,
                aspect,
                scene.camera.near,
                scene.camera.far,
            )
            * scene.camera.view_matrix();
        self.queue.write_buffer(
            &self.uniform_buffer,
            0,
            bytemuck::bytes_of(&Uniforms {
                view_proj: view_proj.to_cols_array_2d(),
            }),
        );

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("pocket3d-encoder"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("pocket3d-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.02,
                            g: 0.025,
                            b: 0.03,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.depth.view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.uniform_bind_group, &[]);
            pass.set_vertex_buffer(0, vertex_buffer.slice(..));
            pass.draw(0..vertices.len() as u32, 0..1);
        }
        self.queue.submit([encoder.finish()]);
        self.queue.present(frame);
        Ok(())
    }
}

fn build_vertices(scene: &SceneView) -> Vec<Vertex> {
    let mut vertices = Vec::new();
    for mesh in &scene.world_meshes {
        let color = color_for(mesh.material_name.as_deref().or(Some(mesh.name.as_str())));
        for tri in mesh.indices.chunks_exact(3) {
            for &idx in tri {
                let pos = mesh.positions[idx as usize];
                vertices.push(Vertex {
                    position: [pos.x, pos.y, pos.z],
                    color,
                });
            }
        }
    }
    vertices
}

fn color_for(name: Option<&str>) -> [f32; 3] {
    let mut hash = 0x811c9dc5u32;
    for b in name.unwrap_or("mesh").bytes() {
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    let r = 0.35 + ((hash & 0xff) as f32 / 255.0) * 0.45;
    let g = 0.35 + (((hash >> 8) & 0xff) as f32 / 255.0) * 0.45;
    let b = 0.35 + (((hash >> 16) & 0xff) as f32 / 255.0) * 0.45;
    [r, g, b]
}

struct DepthTarget {
    view: wgpu::TextureView,
}

impl DepthTarget {
    const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;

    fn new(device: &wgpu::Device, width: u32, height: u32) -> Self {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("pocket3d-depth"),
            size: wgpu::Extent3d {
                width: width.max(1),
                height: height.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: Self::FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        Self {
            view: texture.create_view(&wgpu::TextureViewDescriptor::default()),
        }
    }
}

const SHADER: &str = r#"
struct Uniforms {
  view_proj: mat4x4<f32>,
};

@group(0) @binding(0)
var<uniform> uniforms: Uniforms;

struct VertexIn {
  @location(0) position: vec3<f32>,
  @location(1) color: vec3<f32>,
};

struct VertexOut {
  @builtin(position) clip_position: vec4<f32>,
  @location(0) color: vec3<f32>,
};

@vertex
fn vs_main(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  out.clip_position = uniforms.view_proj * vec4<f32>(input.position, 1.0);
  out.color = input.color;
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4<f32> {
  return vec4<f32>(input.color, 1.0);
}
"#;
