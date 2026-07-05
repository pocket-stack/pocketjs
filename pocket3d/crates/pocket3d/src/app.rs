//! Windowed application loop (winit 0.30) with fixed-step simulation.
//!
//! Games implement [`Game`]; the same object can also be driven headlessly
//! by calling `tick`/`compose` directly (see OpenStrike's script mode).

use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use winit::application::ApplicationHandler;
use winit::event::{DeviceEvent, DeviceId, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::keyboard::KeyCode;
use winit::window::{CursorGrabMode, Window, WindowId};

use crate::camera::Camera;
use crate::gpu::Gpu;
use crate::hud::Hud;
use crate::input::Input;
use crate::renderer::Renderer;
use crate::scene::Scene;
use crate::time::FixedTimestep;

pub struct AppConfig {
    pub title: String,
    pub size: (u32, u32),
    pub tick_hz: f32,
    /// Grab + hide the cursor for mouse look (Esc toggles).
    pub capture_mouse: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            title: "Pocket3D".into(),
            size: (1600, 900),
            tick_hz: 64.0,
            capture_mouse: true,
        }
    }
}

/// What the app loop needs from a game.
pub trait Game {
    /// Called once after the GPU exists — load assets here.
    fn init(&mut self, gpu: &Gpu, renderer: &mut Renderer) -> Result<()>;
    /// Called once per rendered frame before fixed ticks (mouse look etc.).
    fn frame(&mut self, dt: f32, input: &Input);
    /// Fixed-step simulation.
    fn tick(&mut self, dt: f32, input: &Input);
    /// Provide the frame to draw. `time` is seconds since launch.
    fn compose(&mut self, alpha: f32, time: f32, size: (u32, u32)) -> (&Scene, &Camera, &Hud);
    /// Return true to quit.
    fn wants_exit(&self) -> bool {
        false
    }
}

pub fn run(config: AppConfig, game: impl Game) -> Result<()> {
    let event_loop = EventLoop::new()?;
    let mut app = WinitApp {
        config,
        game,
        state: None,
        error: None,
    };
    event_loop.run_app(&mut app)?;
    match app.error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

struct WindowState {
    window: Arc<Window>,
    surface: wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,
    gpu: Gpu,
    renderer: Renderer,
    input: Input,
    timestep: FixedTimestep,
    start: Instant,
    last_frame: Instant,
    mouse_captured: bool,
}

struct WinitApp<G: Game> {
    config: AppConfig,
    game: G,
    state: Option<WindowState>,
    error: Option<anyhow::Error>,
}

impl<G: Game> WinitApp<G> {
    fn init_state(&mut self, event_loop: &ActiveEventLoop) -> Result<WindowState> {
        let attrs = Window::default_attributes()
            .with_title(self.config.title.clone())
            .with_inner_size(winit::dpi::LogicalSize::new(
                self.config.size.0,
                self.config.size.1,
            ));
        let window = Arc::new(event_loop.create_window(attrs)?);
        let instance = Gpu::new_instance();
        let surface = instance.create_surface(window.clone())?;
        let gpu = Gpu::from_instance_for_surface(instance, &surface)?;

        let px = window.inner_size();
        let mut surface_config = surface
            .get_default_config(&gpu.adapter, px.width.max(1), px.height.max(1))
            .ok_or_else(|| anyhow::anyhow!("surface not supported by adapter"))?;
        surface_config.present_mode = wgpu::PresentMode::AutoVsync;
        surface.configure(&gpu.device, &surface_config);

        let mut renderer = Renderer::new(&gpu, surface_config.format)?;
        self.game.init(&gpu, &mut renderer)?;

        let mut state = WindowState {
            window,
            surface,
            surface_config,
            gpu,
            renderer,
            input: Input::default(),
            timestep: FixedTimestep::new(self.config.tick_hz),
            start: Instant::now(),
            last_frame: Instant::now(),
            mouse_captured: false,
        };
        if self.config.capture_mouse {
            set_mouse_capture(&mut state, true);
        }
        Ok(state)
    }

    fn redraw(&mut self, event_loop: &ActiveEventLoop) {
        let Some(state) = self.state.as_mut() else {
            return;
        };

        let now = Instant::now();
        let dt = (now - state.last_frame).as_secs_f32();
        state.last_frame = now;

        self.game.frame(dt, &state.input);
        let ticks = state.timestep.advance(dt);
        for _ in 0..ticks {
            self.game.tick(state.timestep.step, &state.input);
        }
        state.input.end_frame();

        if self.game.wants_exit() {
            event_loop.exit();
            return;
        }

        let frame = match state.surface.get_current_texture() {
            Ok(f) => f,
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                state
                    .surface
                    .configure(&state.gpu.device, &state.surface_config);
                return;
            }
            Err(e) => {
                log::error!("surface error: {e}");
                return;
            }
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let size = (state.surface_config.width, state.surface_config.height);
        let (scene, camera, hud) = self.game.compose(
            state.timestep.alpha(),
            state.start.elapsed().as_secs_f32(),
            size,
        );
        state
            .renderer
            .render(&state.gpu, &view, size, scene, camera, hud);
        state.window.pre_present_notify();
        frame.present();
    }
}

fn set_mouse_capture(state: &mut WindowState, captured: bool) {
    if captured {
        let grabbed = state
            .window
            .set_cursor_grab(CursorGrabMode::Locked)
            .or_else(|_| state.window.set_cursor_grab(CursorGrabMode::Confined))
            .is_ok();
        state.window.set_cursor_visible(!grabbed);
        state.mouse_captured = grabbed;
    } else {
        let _ = state.window.set_cursor_grab(CursorGrabMode::None);
        state.window.set_cursor_visible(true);
        state.mouse_captured = false;
        state.input.clear();
    }
}

impl<G: Game> ApplicationHandler for WinitApp<G> {
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
            }
            WindowEvent::KeyboardInput { .. } => {
                if state.input.key_pressed(KeyCode::Escape) {
                    let captured = !state.mouse_captured;
                    set_mouse_capture(state, captured);
                }
            }
            WindowEvent::MouseInput { .. } => {
                // Clicking back into the window recaptures the mouse.
                if !state.mouse_captured {
                    set_mouse_capture(state, true);
                }
            }
            WindowEvent::Focused(false) => set_mouse_capture(state, false),
            WindowEvent::RedrawRequested => self.redraw(event_loop),
            _ => {}
        }
    }

    fn device_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        _device_id: DeviceId,
        event: DeviceEvent,
    ) {
        if let Some(state) = self.state.as_mut()
            && state.mouse_captured
        {
            state.input.on_device_event(&event);
        }
    }

    fn about_to_wait(&mut self, _event_loop: &ActiveEventLoop) {
        if let Some(state) = &self.state {
            state.window.request_redraw();
        }
    }
}
