//! DrawList → wgpu. The third DrawList backend (after the PSP GE and the
//! wasm software rasterizer), executing the closed 7-op set pinned in
//! spec.ts "DRAWLIST op format".
//!
//! The core's CPU clip stage guarantees every coordinate is inside
//! [0, viewport] — this backend only batches: one vertex stream, draw calls
//! split where the bound texture or scissor rect changes. Rendering is
//! 1:1 (one UI px = one target px); hosts that want the chunky PSP look
//! upscale the result themselves (see `examples/uihost`).
//!
//! Color space: DrawList colors and pak images are sRGB-encoded; the shader
//! linearizes them and the sRGB render target re-encodes on store.

use anyhow::Result;
use pocket3d::gpu::Gpu;
use pocketjs_core::{TexView, Ui, spec};

/// One glyph atlas uploaded as an R8 grid texture (16 cells per row).
/// Cells are stored at coverage resolution (logical cell × raster density);
/// glyphs draw at their logical size × the render scale, so a density-2
/// atlas under a 2× scale samples 1:1.
struct FontTexture {
    bind: wgpu::BindGroup,
    /// Texel cell dimensions (coverage resolution).
    cell_w: u32,
    cell_h: u32,
    /// Logical cell dimensions (what GLYPH_RUN coordinates address).
    logical_w: f32,
    logical_h: f32,
    tex_w: f32,
    tex_h: f32,
    cols: u32,
    glyph_count: u16,
}

/// One live image texture, cached by core SLOT. `handle` is the
/// generation-tagged handle the upload was made for; a slot whose current
/// handle differs (freed, then reused) is re-uploaded by `sync_textures`.
struct ImageBind {
    handle: i32,
    bind: wgpu::BindGroup,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct UiVertex {
    pos: [f32; 2],
    uv: [f32; 2],
    color: u32,
    mode: u32,
}

const MODE_SOLID: u32 = 0;
const MODE_IMAGE: u32 = 1;
const MODE_GLYPH: u32 = 2;

#[derive(Clone, Copy, PartialEq, Eq)]
enum TexBind {
    White,
    Font(u8),
    Image(i32),
}

struct DrawCmd {
    scissor: (u32, u32, u32, u32),
    tex: TexBind,
    start: u32,
    end: u32,
}

/// Renders a `pocketjs_core::Ui`'s DrawList into any render target.
pub struct UiRenderer {
    pipeline: wgpu::RenderPipeline,
    bind_layout: wgpu::BindGroupLayout,
    /// Linear sampler: fonts, the white pixel, and `TexView::linear` images.
    sampler: wgpu::Sampler,
    /// Nearest sampler: images without the linear hint (the PSP default).
    sampler_nearest: wgpu::Sampler,
    white: wgpu::BindGroup,
    fonts: Vec<Option<FontTexture>>,
    images: Vec<Option<ImageBind>>,
    vbuf: Option<wgpu::Buffer>,
    vbuf_capacity: u64,
    verts: Vec<UiVertex>,
    cmds: Vec<DrawCmd>,
}

impl UiRenderer {
    pub fn new(gpu: &Gpu, target_format: wgpu::TextureFormat) -> UiRenderer {
        let device = &gpu.device;
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("pocket-ui shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/ui.wgsl").into()),
        });
        let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("pocket-ui tex"),
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
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("pocket-ui pipeline layout"),
            bind_group_layouts: &[&bind_layout],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("pocket-ui pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: size_of::<UiVertex>() as u64,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &wgpu::vertex_attr_array![
                        0 => Float32x2,
                        1 => Float32x2,
                        2 => Unorm8x4,
                        3 => Uint32,
                    ],
                }],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: target_format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("pocket-ui sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let sampler_nearest = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("pocket-ui sampler nearest"),
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        // 1x1 opaque white for untextured geometry.
        let white_tex = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("pocket-ui white"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        gpu.queue.write_texture(
            white_tex.as_image_copy(),
            &[255u8, 255, 255, 255],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
        );
        let white_view = white_tex.create_view(&Default::default());
        let white = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pocket-ui white bind"),
            layout: &bind_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&white_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });

        UiRenderer {
            pipeline,
            bind_layout,
            sampler,
            sampler_nearest,
            white,
            fonts: Vec::new(),
            images: Vec::new(),
            vbuf: None,
            vbuf_capacity: 0,
            verts: Vec::new(),
            cmds: Vec::new(),
        }
    }

    /// Build this frame's DrawList from `ui` and record it into `encoder` as
    /// one render pass over `view` (`target_px` must equal the core's
    /// viewport for 1:1 rendering). `load` chooses clear-vs-composite:
    /// `Clear` for a standalone UI host, `Load` for an overlay pass.
    pub fn render(
        &mut self,
        gpu: &Gpu,
        ui: &mut Ui,
        encoder: &mut wgpu::CommandEncoder,
        view: &wgpu::TextureView,
        target_px: (u32, u32),
        load: wgpu::LoadOp<wgpu::Color>,
    ) -> Result<()> {
        let words: Vec<u32> = ui.draw().words.clone();
        self.render_words(gpu, ui, &words, encoder, view, target_px, load)
    }

    /// Like [`render`](Self::render), but over a DrawList the host already
    /// built with `ui.draw()`. Hosts that hash the DrawList per tick to skip
    /// unchanged frames (pocket-widget's demand rendering) pass the words
    /// they hashed instead of paying for a second tree walk.
    #[allow(clippy::too_many_arguments)]
    pub fn render_words(
        &mut self,
        gpu: &Gpu,
        ui: &Ui,
        words: &[u32],
        encoder: &mut wgpu::CommandEncoder,
        view: &wgpu::TextureView,
        target_px: (u32, u32),
        load: wgpu::LoadOp<wgpu::Color>,
    ) -> Result<()> {
        self.render_words_scaled(gpu, ui, words, encoder, view, target_px, 1.0, load)
    }

    /// Like [`render_words`](Self::render_words), with a logical→physical
    /// scale: DrawList coordinates are multiplied by `scale` into a
    /// `target_px`-sized view (`target_px` = core viewport × `scale` for
    /// 1:1). With density-`scale` font atlases and pak assets this is the
    /// Vita presentation model on wgpu — a desktop widget on a 2× display
    /// passes `scale = 2.0` and gets native-resolution text, not upscale.
    #[allow(clippy::too_many_arguments)]
    pub fn render_words_scaled(
        &mut self,
        gpu: &Gpu,
        ui: &Ui,
        words: &[u32],
        encoder: &mut wgpu::CommandEncoder,
        view: &wgpu::TextureView,
        target_px: (u32, u32),
        scale: f32,
        load: wgpu::LoadOp<wgpu::Color>,
    ) -> Result<()> {
        self.sync_textures(gpu, ui);
        self.build_batches(words, target_px, scale);

        // Upload vertices.
        let bytes: &[u8] = bytemuck::cast_slice(&self.verts);
        if !bytes.is_empty() {
            if self.vbuf.is_none() || self.vbuf_capacity < bytes.len() as u64 {
                let cap = (bytes.len() as u64).next_power_of_two().max(64 * 1024);
                self.vbuf = Some(gpu.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("pocket-ui vertices"),
                    size: cap,
                    usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                }));
                self.vbuf_capacity = cap;
            }
            gpu.queue
                .write_buffer(self.vbuf.as_ref().unwrap(), 0, bytes);
        }

        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("pocket-ui pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        if self.verts.is_empty() {
            return Ok(());
        }
        pass.set_pipeline(&self.pipeline);
        pass.set_vertex_buffer(0, self.vbuf.as_ref().unwrap().slice(..));
        for cmd in &self.cmds {
            if cmd.start == cmd.end {
                continue;
            }
            let (x, y, w, h) = cmd.scissor;
            if w == 0 || h == 0 {
                continue;
            }
            pass.set_scissor_rect(x, y, w, h);
            let bind = match cmd.tex {
                TexBind::White => &self.white,
                TexBind::Font(slot) => {
                    match self.fonts.get(slot as usize).and_then(|f| f.as_ref()) {
                        Some(f) => &f.bind,
                        None => continue,
                    }
                }
                TexBind::Image(handle) => {
                    // Generation-tagged handle → slot; draw only while the
                    // cached entry is for this exact handle. A stale handle
                    // (freed slot, possibly reused since) draws nothing —
                    // mirroring the core contract.
                    let slot = (handle as u32 & spec::TEX_SLOT_MASK) as usize;
                    match self.images.get(slot).and_then(|i| i.as_ref()) {
                        Some(i) if i.handle == handle => &i.bind,
                        _ => continue,
                    }
                }
            };
            pass.set_bind_group(0, bind, &[]);
            pass.draw(cmd.start..cmd.end, 0..1);
        }
        Ok(())
    }

    // ---- batching -----------------------------------------------------------

    fn build_batches(&mut self, words: &[u32], target_px: (u32, u32), scale: f32) {
        self.verts.clear();
        self.cmds.clear();
        let full = (0u32, 0u32, target_px.0, target_px.1);
        let mut scissor_stack: Vec<(u32, u32, u32, u32)> = Vec::new();
        let mut scissor = full;
        let mut cur_tex = TexBind::White;
        let mut cur_start = 0u32;
        let (tw, th) = (target_px.0 as f32, target_px.1 as f32);
        let s = scale;

        macro_rules! flush {
            ($new_tex:expr, $new_scissor:expr) => {{
                let end = self.verts.len() as u32;
                if end > cur_start {
                    self.cmds.push(DrawCmd {
                        scissor,
                        tex: cur_tex,
                        start: cur_start,
                        end,
                    });
                    cur_start = end;
                }
                cur_tex = $new_tex;
                scissor = $new_scissor;
            }};
        }

        let ndc = |x: f32, y: f32| -> [f32; 2] { [x / tw * 2.0 - 1.0, 1.0 - y / th * 2.0] };
        // DrawList coordinates are logical; scale them into the physical
        // target here so every consumer below works in target px.
        let xy = |w: u32| -> (f32, f32) {
            (
                ((w & 0xffff) as u16 as i16) as f32 * s,
                ((w >> 16) as u16 as i16) as f32 * s,
            )
        };
        let wh = |w: u32| -> (f32, f32) {
            ((w & 0xffff) as f32 * s, ((w >> 16) & 0xffff) as f32 * s)
        };

        let quad = |verts: &mut Vec<UiVertex>,
                    p0: [f32; 2],
                    p1: [f32; 2],
                    uv0: [f32; 2],
                    uv1: [f32; 2],
                    colors: [u32; 4],
                    mode: u32| {
            // Corner order TL, TR, BR, BL; two CCW triangles.
            let tl = UiVertex {
                pos: ndc(p0[0], p0[1]),
                uv: uv0,
                color: colors[0],
                mode,
            };
            let tr = UiVertex {
                pos: ndc(p1[0], p0[1]),
                uv: [uv1[0], uv0[1]],
                color: colors[1],
                mode,
            };
            let br = UiVertex {
                pos: ndc(p1[0], p1[1]),
                uv: uv1,
                color: colors[2],
                mode,
            };
            let bl = UiVertex {
                pos: ndc(p0[0], p1[1]),
                uv: [uv0[0], uv1[1]],
                color: colors[3],
                mode,
            };
            verts.extend_from_slice(&[tl, tr, br, tl, br, bl]);
        };

        let mut i = 0usize;
        while i < words.len() {
            match words[i] {
                spec::draw_op::RECT => {
                    if i + 4 > words.len() {
                        break;
                    }
                    let (x, y) = xy(words[i + 1]);
                    let (w, h) = wh(words[i + 2]);
                    let c = words[i + 3];
                    if w > 0.0 && h > 0.0 && (c >> 24) != 0 {
                        quad(
                            &mut self.verts,
                            [x, y],
                            [x + w, y + h],
                            [0.0, 0.0],
                            [1.0, 1.0],
                            [c; 4],
                            MODE_SOLID,
                        );
                    }
                    i += 4;
                }
                spec::draw_op::GRAD_RECT => {
                    if i + 6 > words.len() {
                        break;
                    }
                    let (x, y) = xy(words[i + 1]);
                    let (w, h) = wh(words[i + 2]);
                    let (from, to, dir) = (words[i + 3], words[i + 4], words[i + 5]);
                    // Corner colors per spec GradDir (TL, TR, BR, BL).
                    let colors = if dir == spec::GradDir::ToTop as u32 {
                        [to, to, from, from]
                    } else if dir == spec::GradDir::ToLeft as u32 {
                        [to, from, from, to]
                    } else if dir == spec::GradDir::ToRight as u32 {
                        [from, to, to, from]
                    } else {
                        [from, from, to, to] // ToBottom
                    };
                    if w > 0.0 && h > 0.0 {
                        quad(
                            &mut self.verts,
                            [x, y],
                            [x + w, y + h],
                            [0.0, 0.0],
                            [1.0, 1.0],
                            colors,
                            MODE_SOLID,
                        );
                    }
                    i += 6;
                }
                spec::draw_op::GLYPH_RUN => {
                    if i + 3 > words.len() {
                        break;
                    }
                    let slot = (words[i + 1] & 0xff) as u8;
                    let n = (words[i + 1] >> 16) as usize;
                    let color = words[i + 2];
                    if i + 3 + 2 * n > words.len() {
                        break;
                    }
                    if cur_tex != TexBind::Font(slot) {
                        flush!(TexBind::Font(slot), scissor);
                    }
                    if let Some(font) = self.fonts.get(slot as usize).and_then(|f| f.as_ref()) {
                        // UVs address coverage texels; the draw rect is the
                        // logical cell × scale (1:1 texels when the atlas
                        // density matches the scale).
                        let (cw, ch) = (font.cell_w as f32, font.cell_h as f32);
                        let (dw, dh) = (font.logical_w * s, font.logical_h * s);
                        for pair in words[i + 3..i + 3 + 2 * n].as_chunks::<2>().0 {
                            let (gx, gy) = xy(pair[0]);
                            let gid = (pair[1] & 0xffff) as u16;
                            if gid >= font.glyph_count {
                                continue;
                            }
                            let col = (gid as u32 % font.cols) as f32;
                            let row = (gid as u32 / font.cols) as f32;
                            let u0 = col * cw / font.tex_w;
                            let v0 = row * ch / font.tex_h;
                            let u1 = (col * cw + cw) / font.tex_w;
                            let v1 = (row * ch + ch) / font.tex_h;
                            quad(
                                &mut self.verts,
                                [gx, gy],
                                [gx + dw, gy + dh],
                                [u0, v0],
                                [u1, v1],
                                [color; 4],
                                MODE_GLYPH,
                            );
                        }
                    }
                    i += 3 + 2 * n;
                }
                spec::draw_op::TEX_QUAD => {
                    if i + 9 > words.len() {
                        break;
                    }
                    let handle = words[i + 1] as i32;
                    let (x, y) = xy(words[i + 2]);
                    let (w, h) = wh(words[i + 3]);
                    let u0 = f32::from_bits(words[i + 4]);
                    let v0 = f32::from_bits(words[i + 5]);
                    let u1 = f32::from_bits(words[i + 6]);
                    let v1 = f32::from_bits(words[i + 7]);
                    let modulate = words[i + 8];
                    if cur_tex != TexBind::Image(handle) {
                        flush!(TexBind::Image(handle), scissor);
                    }
                    if w > 0.0 && h > 0.0 {
                        quad(
                            &mut self.verts,
                            [x, y],
                            [x + w, y + h],
                            [u0, v0],
                            [u1, v1],
                            [modulate; 4],
                            MODE_IMAGE,
                        );
                    }
                    i += 9;
                }
                spec::draw_op::SCISSOR => {
                    if i + 3 > words.len() {
                        break;
                    }
                    let (x, y) = xy(words[i + 1]);
                    let (w, h) = wh(words[i + 2]);
                    scissor_stack.push(scissor);
                    // Rects arrive pre-intersected with enclosing scissors;
                    // clamp to the target for the GPU's benefit.
                    let x0 = (x.max(0.0) as u32).min(target_px.0);
                    let y0 = (y.max(0.0) as u32).min(target_px.1);
                    let x1 = ((x + w).max(0.0) as u32).min(target_px.0);
                    let y1 = ((y + h).max(0.0) as u32).min(target_px.1);
                    flush!(
                        cur_tex,
                        (x0, y0, x1.saturating_sub(x0), y1.saturating_sub(y0))
                    );
                    i += 3;
                }
                spec::draw_op::SCISSOR_POP => {
                    let restored = scissor_stack.pop().unwrap_or(full);
                    flush!(cur_tex, restored);
                    i += 1;
                }
                spec::draw_op::TEX_TRI => {
                    if i + 12 > words.len() {
                        break;
                    }
                    let handle = words[i + 1] as i32;
                    if cur_tex != TexBind::Image(handle) {
                        flush!(TexBind::Image(handle), scissor);
                    }
                    let modulate = words[i + 11];
                    let mut v = [UiVertex {
                        pos: [0.0, 0.0],
                        uv: [0.0, 0.0],
                        color: 0,
                        mode: MODE_IMAGE,
                    }; 3];
                    for k in 0..3 {
                        let (x, y) = xy(words[i + 2 + k * 3]);
                        v[k].pos = ndc(x, y);
                        v[k].uv = [
                            f32::from_bits(words[i + 3 + k * 3]),
                            f32::from_bits(words[i + 4 + k * 3]),
                        ];
                        v[k].color = modulate;
                    }
                    self.verts.extend_from_slice(&v);
                    i += 12;
                }
                spec::draw_op::TRI => {
                    if i + 7 > words.len() {
                        break;
                    }
                    if cur_tex != TexBind::White {
                        flush!(TexBind::White, scissor);
                    }
                    let mut v = [UiVertex {
                        pos: [0.0, 0.0],
                        uv: [0.0, 0.0],
                        color: 0,
                        mode: MODE_SOLID,
                    }; 3];
                    for k in 0..3 {
                        let (x, y) = xy(words[i + 1 + k]);
                        v[k].pos = ndc(x, y);
                        v[k].color = words[i + 4 + k];
                    }
                    self.verts.extend_from_slice(&v);
                    i += 7;
                }
                // The op set is closed per DrawList version; anything else
                // means corrupt data — stop instead of misinterpreting.
                _ => break,
            }
        }
        let end = self.verts.len() as u32;
        if end > cur_start {
            self.cmds.push(DrawCmd {
                scissor,
                tex: cur_tex,
                start: cur_start,
                end,
            });
        }
    }

    // ---- texture sync ---------------------------------------------------------

    /// Mirror the core's textures into GPU resources. Font atlases are
    /// append-only; image slots are not — `freeTexture` empties a slot and
    /// a later upload reuses it under a new generation-tagged handle, so
    /// each slot re-uploads whenever its current handle changes and drops
    /// its cache entry when the core frees it.
    fn sync_textures(&mut self, gpu: &Gpu, ui: &Ui) {
        // Font slots. A slot re-uploads when its glyph count moved — hosts
        // may extend an atlas at runtime (IME input rasterizing new
        // codepoints) and reload it via loadFontAtlas.
        if self.fonts.len() < spec::MAX_FONT_SLOTS {
            self.fonts.resize_with(spec::MAX_FONT_SLOTS, || None);
        }
        for slot in 0..spec::MAX_FONT_SLOTS as u8 {
            let Some(atlas) = ui.font_atlas(slot) else {
                continue;
            };
            if self.fonts[slot as usize]
                .as_ref()
                .is_some_and(|f| f.glyph_count == atlas.glyph_count)
            {
                continue;
            }
            self.fonts[slot as usize] = Some(self.upload_font(gpu, atlas));
        }
        // Image texture slots.
        let slots = ui.texture_slot_count();
        if self.images.len() < slots {
            self.images.resize_with(slots, || None);
        }
        for slot in 0..slots {
            match ui.texture_at(slot as u32) {
                Some((handle, view)) => {
                    if self.images[slot].as_ref().is_some_and(|e| e.handle == handle) {
                        continue;
                    }
                    self.images[slot] = to_rgba8(&view).map(|rgba| ImageBind {
                        handle,
                        bind: self.upload_image(gpu, &rgba, view.w, view.h, view.linear),
                    });
                }
                None => self.images[slot] = None,
            }
        }
    }

    fn upload_font(&self, gpu: &Gpu, atlas: &pocketjs_core::text::Atlas) -> FontTexture {
        // Cells upload at coverage resolution (logical × raster density) —
        // a density-2 atlas keeps its full detail for scaled rendering.
        let (cov_w, cov_h) = (atlas.coverage_width(), atlas.coverage_height());
        // Wider grids for big (CJK-extended) atlases keep the texture under
        // dimension limits: 16 cols x 3500 density-2 cells would be ~8000 px
        // tall; 64 cols stays square-ish.
        let max_cols = if atlas.glyph_count > 512 { 64u32 } else { 16u32 };
        let cols = max_cols.min(atlas.glyph_count.max(1) as u32);
        let rows = (atlas.glyph_count as u32).div_ceil(cols).max(1);
        let tex_w = cols * cov_w;
        let tex_h = rows * cov_h;
        let mut pixels = vec![0u8; (tex_w * tex_h) as usize];
        for gid in 0..atlas.glyph_count {
            let gx = (gid as u32 % cols) * cov_w;
            let gy = (gid as u32 / cols) * cov_h;
            let rows_bytes = atlas.glyph_rows(gid);
            let bpr = atlas.bytes_per_row();
            for y in 0..cov_h {
                let src = &rows_bytes[(y as usize) * bpr..][..cov_w as usize];
                let dst = ((gy + y) * tex_w + gx) as usize;
                pixels[dst..dst + cov_w as usize].copy_from_slice(src);
            }
        }
        let tex = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("pocket-ui font atlas"),
            size: wgpu::Extent3d {
                width: tex_w,
                height: tex_h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        gpu.queue.write_texture(
            tex.as_image_copy(),
            &pixels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(tex_w),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: tex_w,
                height: tex_h,
                depth_or_array_layers: 1,
            },
        );
        let view = tex.create_view(&Default::default());
        let bind = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pocket-ui font bind"),
            layout: &self.bind_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        });
        FontTexture {
            bind,
            cell_w: cov_w,
            cell_h: cov_h,
            logical_w: atlas.cell_w as f32,
            logical_h: atlas.cell_h as f32,
            tex_w: tex_w as f32,
            tex_h: tex_h as f32,
            cols,
            glyph_count: atlas.glyph_count,
        }
    }

    fn upload_image(&self, gpu: &Gpu, rgba: &[u8], w: u32, h: u32, linear: bool) -> wgpu::BindGroup {
        let tex = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("pocket-ui image"),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        gpu.queue.write_texture(
            tex.as_image_copy(),
            rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(w * 4),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        let view = tex.create_view(&Default::default());
        gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pocket-ui image bind"),
            layout: &self.bind_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(if linear {
                        &self.sampler
                    } else {
                        &self.sampler_nearest
                    }),
                },
            ],
        })
    }
}

/// Expand a core texture (PSM 8888/4444/T8) to tightly-packed RGBA8.
fn to_rgba8(view: &TexView) -> Option<Vec<u8>> {
    let count = (view.w * view.h) as usize;
    let pixels = view.pixels;
    match view.psm {
        spec::psm::PSM_8888 => {
            let bytes = count * 4;
            (pixels.len() >= bytes).then(|| pixels[..bytes].to_vec())
        }
        spec::psm::PSM_4444 => {
            // u16 LE, nibbles A<<12 | B<<8 | G<<4 | R; expand n -> n*17.
            if pixels.len() < count * 2 {
                return None;
            }
            let mut out = Vec::with_capacity(count * 4);
            for px in pixels[..count * 2].as_chunks::<2>().0 {
                let v = u16::from_le_bytes([px[0], px[1]]) as u32;
                out.push(((v & 0xf) * 17) as u8);
                out.push((((v >> 4) & 0xf) * 17) as u8);
                out.push((((v >> 8) & 0xf) * 17) as u8);
                out.push((((v >> 12) & 0xf) * 17) as u8);
            }
            Some(out)
        }
        spec::psm::PSM_T8 => {
            // Indices through the 1024-byte CLUT (256 x u32 ABGR — LE byte
            // order is r,g,b,a in memory, i.e. exactly the 8888 layout).
            let palette = view.palette?;
            if palette.len() < 1024 || pixels.len() < count {
                return None;
            }
            let mut out = Vec::with_capacity(count * 4);
            for &idx in &pixels[..count] {
                let p = idx as usize * 4;
                out.extend_from_slice(&palette[p..p + 4]);
            }
            Some(out)
        }
        _ => None,
    }
}
