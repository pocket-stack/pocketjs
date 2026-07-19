//! The widget window shell: two rates, one clock.
//!
//! The guest ticks at a fixed rate, always — one guest turn per host tick
//! (Law 3), so tapes, goldens and replays hold inside a widget. GPU frames
//! are demand-driven: a frame renders only when the game reports dirt (the
//! embedded UI changed, a part moved, the camera eased). No dirt → no render
//! pass, no present — the compositor retains the last frame and an idle
//! widget costs ticks (microseconds), not frames. macOS occlusion suspends
//! rendering entirely while ticks keep the app live behind other windows.
//!
//! This is a sibling of [`pocket3d::app::run`], not a wrapper: that loop
//! ties simulation to redraws (right for games rendering every frame),
//! while a widget must tick without rendering.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use glam::Vec2;
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::window::{Window, WindowId, WindowLevel};

use pocket3d::app::pick_alpha_mode;
use pocket3d::camera::Camera;
use pocket3d::gpu::Gpu;
use pocket3d::hud::Hud;
use pocket3d::input::Input;
use pocket3d::renderer::Renderer;
use pocket3d::scene::Scene;

pub struct WidgetConfig {
    pub title: String,
    /// Window size in logical px — fixed; widgets don't resize.
    pub size: (u32, u32),
    /// Fixed simulation rate — the guest cadence (60 = the PSP's).
    pub tick_hz: f32,
    /// Render cap for the active case (eases, drags). The loop sleeps
    /// between frames; dirt reported while pacing is latched, never lost.
    pub max_fps: f32,
    pub transparent: bool,
    pub decorations: bool,
    pub always_on_top: bool,
}

impl Default for WidgetConfig {
    fn default() -> Self {
        Self {
            title: "Pocket Widget".into(),
            size: (480, 260),
            tick_hz: 60.0,
            max_fps: 60.0,
            transparent: true,
            decorations: false,
            always_on_top: true,
        }
    }
}

/// What the widget loop needs from a product.
pub trait WidgetGame {
    /// Called once after the GPU exists — build assets, boot guests.
    fn init(&mut self, gpu: &Gpu, renderer: &mut Renderer) -> Result<()>;
    /// One fixed-step tick: the guest turn (`frame(buttons, analog)`), the
    /// embedded UI tick, interaction state. Runs whether or not a frame
    /// will render. `window_px` is the surface size in physical pixels —
    /// the space cursor positions live in, for picking. Mark dirt
    /// internally; the shell collects it via [`take_dirty`](Self::take_dirty).
    fn tick(&mut self, dt: f32, input: &Input, window_px: (u32, u32)) -> Result<()>;
    /// Consume the "needs a GPU frame" flag. Latched by the shell until a
    /// frame actually renders, so fps pacing never drops dirt.
    fn take_dirty(&mut self) -> bool;
    /// Record offscreen work that must land before the scene pass samples
    /// it (the embedded UI render). Called only on frames that render.
    fn prepare(&mut self, gpu: &Gpu) -> Result<()>;
    /// Provide the frame to draw. `time` is seconds since launch.
    fn compose(&mut self, time: f32, size: (u32, u32)) -> (&Scene, &Camera, &Hud);
    /// Left-press policy: return true to start an OS window drag at this
    /// cursor position (widget-style move) instead of interacting.
    fn drag_at(&mut self, cursor: Vec2) -> bool {
        let _ = cursor;
        false
    }
    fn wants_exit(&self) -> bool {
        false
    }
}

pub fn run(config: WidgetConfig, game: impl WidgetGame) -> Result<()> {
    let event_loop = EventLoop::new()?;
    let mut app = WidgetApp {
        config,
        game,
        state: None,
        error: None,
        ticks: 0,
        frames: 0,
    };
    event_loop.run_app(&mut app)?;
    // The governor's receipt: how many fixed ticks ran vs. GPU frames
    // actually rendered. A settled widget should show frames ≪ ticks.
    log::info!(
        "pocket-widget: {} ticks, {} frames rendered ({:.1}%)",
        app.ticks,
        app.frames,
        100.0 * app.frames as f64 / app.ticks.max(1) as f64
    );
    match app.error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Catch-up bound: after an app-nap the loop resyncs instead of replaying
/// the gap (a widget needs liveness, not history).
const MAX_CATCHUP_TICKS: u32 = 6;

struct WindowState {
    window: Arc<Window>,
    surface: wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,
    gpu: Gpu,
    renderer: Renderer,
    input: Input,
    start: Instant,
    next_tick: Instant,
    last_render: Instant,
    /// Dirt latched from the game, waiting for a paced render.
    render_pending: bool,
    occluded: bool,
}

struct WidgetApp<G: WidgetGame> {
    config: WidgetConfig,
    game: G,
    state: Option<WindowState>,
    error: Option<anyhow::Error>,
    ticks: u64,
    frames: u64,
}

impl<G: WidgetGame> WidgetApp<G> {
    fn init_state(&mut self, event_loop: &ActiveEventLoop) -> Result<WindowState> {
        let attrs = Window::default_attributes()
            .with_title(self.config.title.clone())
            .with_inner_size(winit::dpi::LogicalSize::new(
                self.config.size.0,
                self.config.size.1,
            ))
            .with_transparent(self.config.transparent)
            .with_decorations(self.config.decorations)
            .with_resizable(false)
            .with_window_level(if self.config.always_on_top {
                WindowLevel::AlwaysOnTop
            } else {
                WindowLevel::Normal
            });
        let window = Arc::new(event_loop.create_window(attrs)?);
        let instance = Gpu::new_instance();
        let surface = instance.create_surface(window.clone())?;
        let gpu = Gpu::from_instance_for_surface(instance, &surface)?;

        let px = window.inner_size();
        let mut surface_config = surface
            .get_default_config(&gpu.adapter, px.width.max(1), px.height.max(1))
            .ok_or_else(|| anyhow::anyhow!("surface not supported by adapter"))?;
        surface_config.present_mode = wgpu::PresentMode::AutoVsync;
        if self.config.transparent {
            surface_config.alpha_mode = pick_alpha_mode(&surface, &gpu.adapter)?;
        }
        surface.configure(&gpu.device, &surface_config);

        let mut renderer = Renderer::new(&gpu, surface_config.format)?;
        self.game.init(&gpu, &mut renderer)?;

        let now = Instant::now();
        Ok(WindowState {
            window,
            surface,
            surface_config,
            gpu,
            renderer,
            input: Input::default(),
            start: now,
            next_tick: now,
            last_render: now - Duration::from_secs(1),
            render_pending: true, // first frame
            occluded: false,
        })
    }

    /// The governor: run due fixed ticks, collect dirt, schedule the next
    /// wake at whichever comes first — the next tick or a due render.
    fn pump(&mut self, event_loop: &ActiveEventLoop) {
        let Some(state) = self.state.as_mut() else {
            return;
        };
        let tick_dt = 1.0 / self.config.tick_hz.max(1.0);
        let tick_interval = Duration::from_secs_f32(tick_dt);
        let now = Instant::now();

        let window_px = (state.surface_config.width, state.surface_config.height);
        let mut ran = 0u32;
        while now >= state.next_tick && ran < MAX_CATCHUP_TICKS {
            if let Err(e) = self.game.tick(tick_dt, &state.input, window_px) {
                self.error = Some(e);
                event_loop.exit();
                return;
            }
            state.next_tick += tick_interval;
            ran += 1;
        }
        self.ticks += ran as u64;
        if ran == MAX_CATCHUP_TICKS && now >= state.next_tick {
            state.next_tick = now + tick_interval;
        }
        if ran > 0 {
            state.input.end_frame();
        }

        if self.game.wants_exit() {
            event_loop.exit();
            return;
        }

        if self.game.take_dirty() {
            state.render_pending = true;
        }

        let frame_interval = Duration::from_secs_f32(1.0 / self.config.max_fps.max(1.0));
        let mut wake = state.next_tick;
        if state.render_pending && !state.occluded {
            let due = state.last_render + frame_interval;
            if now >= due {
                state.window.request_redraw();
            } else {
                wake = wake.min(due);
            }
        }
        event_loop.set_control_flow(ControlFlow::WaitUntil(wake));
    }

    fn redraw(&mut self) -> Result<()> {
        let Some(state) = self.state.as_mut() else {
            return Ok(());
        };
        self.game.prepare(&state.gpu)?;

        let frame = match state.surface.get_current_texture() {
            Ok(f) => f,
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                state
                    .surface
                    .configure(&state.gpu.device, &state.surface_config);
                return Ok(()); // render_pending stays latched; next wake retries
            }
            Err(e) => return Err(anyhow::anyhow!("surface error: {e}")),
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let size = (state.surface_config.width, state.surface_config.height);
        let (scene, camera, hud) =
            self.game
                .compose(state.start.elapsed().as_secs_f32(), size);
        state
            .renderer
            .render(&state.gpu, &view, size, scene, camera, hud);
        state.window.pre_present_notify();
        frame.present();

        state.render_pending = false;
        state.last_render = Instant::now();
        self.frames += 1;
        Ok(())
    }
}

impl<G: WidgetGame> ApplicationHandler for WidgetApp<G> {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.state.is_none() {
            match self.init_state(event_loop) {
                Ok(s) => self.state = Some(s),
                Err(e) => {
                    self.error = Some(e);
                    event_loop.exit();
                }
            }
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        event: WindowEvent,
    ) {
        let Some(state) = self.state.as_mut() else {
            return;
        };
        state.input.on_window_event(&event);
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(size) => {
                state.surface_config.width = size.width.max(1);
                state.surface_config.height = size.height.max(1);
                state
                    .surface
                    .configure(&state.gpu.device, &state.surface_config);
                state.render_pending = true;
            }
            WindowEvent::Occluded(occluded) => {
                state.occluded = occluded;
                if !occluded {
                    state.render_pending = true; // repaint on reveal
                }
            }
            WindowEvent::MouseInput {
                state: elem_state,
                button: MouseButton::Left,
                ..
            } if elem_state == ElementState::Pressed => {
                if let Some(cursor) = state.input.cursor()
                    && self.game.drag_at(cursor)
                {
                    let _ = state.window.drag_window();
                    // macOS swallows the release once the OS drag session
                    // starts; clear the button so the next press edges.
                    state.input.inject_mouse_button(MouseButton::Left, false);
                }
            }
            WindowEvent::RedrawRequested => {
                if let Err(e) = self.redraw() {
                    self.error = Some(e);
                    event_loop.exit();
                }
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        self.pump(event_loop);
    }
}
