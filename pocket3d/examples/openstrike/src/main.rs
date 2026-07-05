//! OpenStrike — a single-player CS-like FPS on Pocket3D.

mod args;
mod bot;
mod game;
mod scripts;
mod weapon;

use anyhow::{Context, Result};
use pocket3d::app::{AppConfig, run};
use pocket3d::input::Input;
use pocket3d::prelude::*;
use pocket3d::winit::keyboard::KeyCode;

use crate::args::Args;
use crate::game::OpenStrike;

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args = Args::parse()?;

    let map_path = args.resolve_map_path()?;
    log::info!("loading {}", map_path.display());
    let map = pocket3d::bsp::load_map(&map_path, &args.wad_dirs())?;

    // Spawn selection.
    let spawn = if args.spawn_t {
        map.t_spawns.first().or(map.ct_spawns.first())
    } else {
        map.ct_spawns
            .get(args.spawn_index)
            .or(map.ct_spawns.first())
    }
    .copied()
    .context("map has no player spawns")?;
    let mut game = OpenStrike::new(map, spawn.pos, spawn.yaw, args.bots);
    if let Some(pos) = args.pos {
        game.player.state.pos = pos;
        game.player.prev_pos = pos;
    }
    if let Some(yaw) = args.yaw_deg {
        game.player.yaw = yaw.to_radians();
    }
    if let Some(pitch) = args.pitch_deg {
        game.player.pitch = pitch.to_radians();
    }
    game.debug_overlay = args.debug_overlay;
    game.auto_quit = args.auto_quit;

    if let Some(script) = &args.script {
        return scripts::run_script(game, script, &args);
    }
    if args.screenshot.is_some() {
        return scripts::run_screenshot(game, &args);
    }

    run(
        AppConfig {
            title: "OpenStrike (Pocket3D)".into(),
            size: (1600, 900),
            tick_hz: 64.0,
            capture_mouse: true,
        },
        Windowed { game },
    )
}

/// Adapter between the app loop and the game.
struct Windowed {
    game: OpenStrike,
}

impl Game for Windowed {
    fn init(&mut self, gpu: &Gpu, renderer: &mut Renderer) -> Result<()> {
        self.game.upload_world(gpu, renderer);
        Ok(())
    }

    fn frame(&mut self, _dt: f32, input: &Input) {
        let d = input.mouse_delta();
        self.game.apply_look(d.x, d.y);
        if input.key_pressed(KeyCode::F3) {
            self.game.debug_overlay = !self.game.debug_overlay;
        }
    }

    fn tick(&mut self, dt: f32, input: &Input) {
        self.game.tick(dt, input);
    }

    fn compose(&mut self, alpha: f32, time: f32, size: (u32, u32)) -> (&Scene, &Camera, &Hud) {
        self.game
            .compose_base(alpha, time, (size.0 as f32, size.1 as f32));
        (&self.game.scene, &self.game.camera, &self.game.hud)
    }

    fn wants_exit(&self) -> bool {
        self.game
            .auto_quit
            .is_some_and(|limit| self.game.time >= limit)
    }
}
