//! chorus — a dream-corridor diorama that lives on the desktop.
//!
//! A pocket-widget study of the airbrush-chrome record-sleeve look: a
//! framed box recedes wing by wing — cut-metal curtains carrying faces in
//! profile — to a starburst deep inside. The whole set is procedural
//! (geometry in `diorama`, painted ramps in `paint`, everything unlit so
//! the airbrush shading is exactly what you painted), and the window is a
//! borderless, transparent, always-on-top widget.
//!
//!   cargo run -p chorus
//!   cargo run -p chorus -- --screenshot out.png --yaw 18 --pitch -8
//!
//! Interactions: drag inside the frame to orbit and peer around the
//! curtains, scroll to move closer, double-click to dive between the home
//! and close framings, drag the frame itself to move the window, arrows
//! nudge, R recenters, Esc quits. `--still` freezes the star and fog, and
//! the widget then renders zero frames at rest.

mod diorama;
mod paint;

use std::path::PathBuf;

use anyhow::{Result, anyhow};
use glam::{Mat3, Vec2, Vec3};
use pocket_widget::shell::{WidgetConfig, WidgetGame};
use pocket3d::camera::Camera;
use pocket3d::gpu::{Gpu, OFFSCREEN_FORMAT, OffscreenTarget};
use pocket3d::hud::Hud;
use pocket3d::input::Input;
use pocket3d::renderer::Renderer;
use pocket3d::scene::{Beam, Scene, Sprite};
use winit::event::MouseButton;
use winit::keyboard::KeyCode;

use diorama::{OPEN, STAR};

/// Window size, logical px.
const WIN_W: u32 = 400;
const WIN_H: u32 = 460;

/// The camera orbits this point; the whole interaction is spherical
/// coordinates around it.
const PIVOT: Vec3 = Vec3::new(0.0, -4.0, -30.0);
const HOME_DIST: f32 = 310.0;
const PEER_DIST: f32 = 150.0;
const DIST_RANGE: (f32, f32) = (130.0, 420.0);
const YAW_MAX: f32 = 0.55;
const PITCH_MAX: f32 = 0.38;
/// Double-click window in ticks (60 Hz).
const DOUBLE_CLICK_TICKS: u64 = 21;
/// Framing ease duration in ticks.
const EASE_TICKS: f32 = 24.0;

/// Fog puffs: (base position, size, alpha, drift phase, drift amplitude).
/// Inside along the floor, on the sill, and spilling out over the desk.
const FOG: [([f32; 3], f32, f32, f32, f32); 16] = [
    // deep interior
    ([-20.0, -34.0, -70.0], 34.0, 0.10, 0.0, 2.0),
    ([12.0, -36.0, -55.0], 30.0, 0.12, 1.3, 2.5),
    ([-4.0, -33.0, -42.0], 26.0, 0.10, 2.1, 2.0),
    ([26.0, -35.0, -30.0], 28.0, 0.11, 3.2, 2.2),
    ([-28.0, -36.0, -26.0], 30.0, 0.12, 4.0, 2.6),
    // the sill
    ([-14.0, -43.0, -6.0], 30.0, 0.14, 0.7, 3.0),
    ([14.0, -45.0, -2.0], 34.0, 0.15, 1.9, 3.2),
    ([34.0, -49.0, 2.0], 26.0, 0.08, 2.8, 2.4),
    ([-38.0, -48.0, 0.0], 26.0, 0.08, 3.9, 2.6),
    // the spill, out front and below
    ([-26.0, -54.0, 8.0], 40.0, 0.13, 0.4, 3.6),
    ([4.0, -58.0, 12.0], 44.0, 0.12, 1.6, 4.0),
    ([30.0, -55.0, 9.0], 34.0, 0.11, 2.5, 3.0),
    ([-46.0, -50.0, 6.0], 30.0, 0.09, 3.4, 2.8),
    ([46.0, -50.0, 5.0], 28.0, 0.08, 4.4, 2.6),
    // the wisp climbing the left frame edge
    ([-50.0, -8.0, 3.0], 18.0, 0.05, 5.1, 2.0),
    ([-46.0, 10.0, 2.0], 14.0, 0.04, 5.9, 1.6),
];

struct ChorusGame {
    scene: Scene,
    camera: Camera,
    hud: Hud,
    window_px: (u32, u32),
    ticks: u64,

    /// Orbit state (user-controlled part of the camera).
    yaw: f32,
    pitch: f32,
    dist: f32,
    /// Cursor grab: (cursor at press, yaw at press, pitch at press).
    grab: Option<(Vec2, f32, f32)>,
    /// Peer framing: dist eases toward PEER_DIST while 1.
    peer: bool,
    blend: f32,
    /// Dist as set by scrolling in the current framing.
    dist_home: f32,
    last_open_click: Option<u64>,

    animate: bool,
    dirty: bool,
    exit: bool,
    quit_after: Option<u64>,
}

impl ChorusGame {
    fn new(animate: bool) -> Self {
        let scene = Scene {
            transparent_clear: true,
            ..Default::default()
        };
        let camera = Camera {
            pos: PIVOT + Vec3::new(0.0, 0.0, HOME_DIST),
            fov_y: 28f32.to_radians(),
            znear: 20.0,
            zfar: 1500.0,
            ..Default::default()
        };
        Self {
            scene,
            camera,
            hud: Hud::default(),
            window_px: (WIN_W, WIN_H),
            ticks: 0,
            yaw: 0.0,
            pitch: 0.0,
            dist: HOME_DIST,
            grab: None,
            peer: false,
            blend: 0.0,
            dist_home: HOME_DIST,
            last_open_click: None,
            animate,
            dirty: true,
            exit: false,
            quit_after: None,
        }
    }

    /// Does a window ray pass through the frame opening? (The z=0 plane is
    /// the frame face; anything through the hole is scene interaction,
    /// anything on or outside the frame is a window gesture.)
    fn through_opening(&self, cursor: Vec2) -> bool {
        let (origin, dir) = self
            .camera
            .screen_ray(cursor, (self.window_px.0 as f32, self.window_px.1 as f32));
        if dir.z.abs() < 1e-5 {
            return false;
        }
        let t = -origin.z / dir.z;
        if t <= 0.0 {
            return false;
        }
        let hit = origin + dir * t;
        hit.x.abs() < OPEN && hit.y.abs() < OPEN
    }

    /// The star and the fog — rebuilt every tick, a couple dozen quads.
    fn dress(&mut self, t: f32) {
        let (tw, drift) = if self.animate {
            (
                1.0 + 0.08 * (t * 2.3).sin() + 0.04 * (t * 3.9 + 1.7).sin(),
                1.0,
            )
        } else {
            (1.0, 0.0)
        };
        self.scene.sprites.clear();
        self.scene.beams.clear();

        // Starburst: a hot core, two halos, long thin spikes.
        let star = |v: Vec3| STAR + v;
        self.scene.sprites.push(Sprite {
            pos: STAR,
            size: 7.0 * tw,
            color: [1.0, 1.0, 1.0, 1.0],
        });
        self.scene.sprites.push(Sprite {
            pos: STAR,
            size: 18.0 * tw,
            color: [0.8, 0.95, 1.0, 0.5],
        });
        self.scene.sprites.push(Sprite {
            pos: STAR,
            size: 40.0,
            color: [0.6, 0.8, 1.0, 0.2],
        });
        let spike = |a: Vec3, b: Vec3, w: f32, alpha: f32| Beam {
            a: star(a),
            b: star(b),
            width: w,
            color: [0.88, 0.96, 1.0, alpha],
        };
        let (h, v, d) = (30.0 * tw, 20.0 * tw, 10.0 * tw);
        self.scene.beams.push(spike(
            Vec3::new(-h, 0.0, 0.0),
            Vec3::new(h, 0.0, 0.0),
            1.5,
            0.85,
        ));
        self.scene.beams.push(spike(
            Vec3::new(0.0, -v, 0.0),
            Vec3::new(0.0, v, 0.0),
            1.5,
            0.85,
        ));
        self.scene.beams.push(spike(
            Vec3::new(-d, -d, 0.0),
            Vec3::new(d, d, 0.0),
            1.0,
            0.5,
        ));
        self.scene.beams.push(spike(
            Vec3::new(-d, d, 0.0),
            Vec3::new(d, -d, 0.0),
            1.0,
            0.5,
        ));

        // Fog: additive pale blue, drifting on staggered phases.
        for (base, size, alpha, phase, amp) in FOG {
            let p = Vec3::from(base)
                + Vec3::new(
                    (t * 0.35 + phase).sin() * amp * drift,
                    (t * 0.22 + phase * 1.7).sin() * amp * 0.35 * drift,
                    0.0,
                );
            self.scene.sprites.push(Sprite {
                pos: p,
                size,
                color: [0.55, 0.68, 0.9, alpha],
            });
        }
    }
}

impl WidgetGame for ChorusGame {
    fn init(&mut self, gpu: &Gpu, renderer: &mut Renderer) -> Result<()> {
        diorama::build(gpu, renderer, &mut self.scene);
        log::info!(
            "chorus: {} set pieces, {} fog puffs",
            self.scene.models.len(),
            FOG.len()
        );
        Ok(())
    }

    fn tick(&mut self, _dt: f32, input: &Input, window_px: (u32, u32)) -> Result<()> {
        self.window_px = window_px;
        if input.key_pressed(KeyCode::Escape)
            || self.quit_after.is_some_and(|limit| self.ticks >= limit)
        {
            self.exit = true;
        }

        // --- orbit: drag inside the opening -------------------------------
        let cursor = input.cursor();
        if let Some(c) = cursor {
            if input.mouse_button_pressed(MouseButton::Left) && self.through_opening(c) {
                self.grab = Some((c, self.yaw, self.pitch));
                let double = self
                    .last_open_click
                    .is_some_and(|at| self.ticks - at <= DOUBLE_CLICK_TICKS);
                self.last_open_click = Some(self.ticks);
                if double {
                    self.peer = !self.peer;
                }
            }
            if let Some((c0, yaw0, pitch0)) = self.grab {
                let (w, h) = (window_px.0 as f32, window_px.1 as f32);
                let yaw = (yaw0 + (c.x - c0.x) / w * 1.6).clamp(-YAW_MAX, YAW_MAX);
                let pitch = (pitch0 + (c.y - c0.y) / h * 1.2).clamp(-PITCH_MAX, PITCH_MAX);
                if yaw != self.yaw || pitch != self.pitch {
                    self.yaw = yaw;
                    self.pitch = pitch;
                    self.dirty = true;
                }
            }
        }
        if !input.mouse_button_down(MouseButton::Left) {
            self.grab = None;
        }

        // --- keyboard nudge + reset ---------------------------------------
        let nudge = 0.014;
        for (code, dy, dp) in [
            (KeyCode::ArrowLeft, -nudge, 0.0),
            (KeyCode::ArrowRight, nudge, 0.0),
            (KeyCode::ArrowUp, 0.0, nudge),
            (KeyCode::ArrowDown, 0.0, -nudge),
        ] {
            if input.key_down(code) {
                self.yaw = (self.yaw + dy).clamp(-YAW_MAX, YAW_MAX);
                self.pitch = (self.pitch + dp).clamp(-PITCH_MAX, PITCH_MAX);
                self.dirty = true;
            }
        }
        if input.key_pressed(KeyCode::KeyR) {
            self.yaw = 0.0;
            self.pitch = 0.0;
            self.dist_home = HOME_DIST;
            self.peer = false;
            self.dirty = true;
        }

        // --- dolly: scroll ------------------------------------------------
        let scroll = input.scroll().y;
        if scroll != 0.0 {
            self.dist_home = (self.dist_home - scroll * 0.7).clamp(DIST_RANGE.0, DIST_RANGE.1);
            self.dirty = true;
        }

        // --- peer framing ease --------------------------------------------
        let target = if self.peer { 1.0 } else { 0.0 };
        if self.blend != target {
            let step = 1.0 / EASE_TICKS;
            self.blend = if self.blend < target {
                (self.blend + step).min(target)
            } else {
                (self.blend - step).max(target)
            };
            self.dirty = true;
        }

        if self.animate {
            self.dirty = true; // the star breathes, the fog drifts
        }
        self.ticks += 1;
        Ok(())
    }

    fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    fn prepare(&mut self, _gpu: &Gpu) -> Result<()> {
        Ok(())
    }

    fn compose(&mut self, time: f32, _size: (u32, u32)) -> (&Scene, &Camera, &Hud) {
        self.dress(time);
        // Idle sway on top of the user's orbit — the diorama breathes.
        let (sway_y, sway_p) = if self.animate && self.grab.is_none() {
            (
                (time * 0.45).sin() * 0.02,
                (time * 0.31 + 1.0).sin() * 0.014,
            )
        } else {
            (0.0, 0.0)
        };
        let ease = self.blend * self.blend * (3.0 - 2.0 * self.blend);
        let dist = self.dist_home + (PEER_DIST - self.dist_home) * ease;
        self.dist = dist;
        let rot = Mat3::from_rotation_y(self.yaw + sway_y)
            * Mat3::from_rotation_x(-(self.pitch + sway_p));
        self.camera.pos = PIVOT + rot * Vec3::new(0.0, 0.0, dist);
        self.camera.look_at(PIVOT);
        self.scene.time = time;
        (&self.scene, &self.camera, &self.hud)
    }

    fn drag_at(&mut self, cursor: Vec2) -> bool {
        // The frame (and everything outside it) is a handle; the view
        // through the opening is the scene.
        !self.through_opening(cursor)
    }

    fn wants_exit(&self) -> bool {
        self.exit
    }
}

// ---------------------------------------------------------------------------
// CLI + headless
// ---------------------------------------------------------------------------

struct Args {
    screenshot: Option<PathBuf>,
    frames: u32,
    yaw: f32,
    pitch: f32,
    dist: f32,
    still: bool,
    auto_quit: Option<f32>,
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        screenshot: None,
        frames: 30,
        yaw: 0.0,
        pitch: 0.0,
        dist: HOME_DIST,
        still: false,
        auto_quit: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        let mut val = |name: &str| -> Result<String> {
            it.next().ok_or_else(|| anyhow!("{name} needs a value"))
        };
        match a.as_str() {
            "--screenshot" => args.screenshot = Some(PathBuf::from(val("--screenshot")?)),
            "--frames" => args.frames = val("--frames")?.parse()?,
            "--yaw" => args.yaw = val("--yaw")?.parse::<f32>()?.to_radians(),
            "--pitch" => args.pitch = val("--pitch")?.parse::<f32>()?.to_radians(),
            "--dist" => args.dist = val("--dist")?.parse()?,
            "--still" => args.still = true,
            "--auto-quit" => args.auto_quit = Some(val("--auto-quit")?.parse()?),
            other => return Err(anyhow!("unknown flag {other}")),
        }
    }
    Ok(args)
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args = parse_args()?;
    let mut game = ChorusGame::new(!args.still);
    game.yaw = args.yaw.clamp(-YAW_MAX, YAW_MAX);
    game.pitch = args.pitch.clamp(-PITCH_MAX, PITCH_MAX);
    game.dist_home = args.dist.clamp(DIST_RANGE.0, DIST_RANGE.1);
    game.quit_after = args.auto_quit.map(|s| (s * 60.0) as u64);
    if let Some(out) = args.screenshot.clone() {
        headless(game, &args, &out)
    } else {
        pocket_widget::run(
            WidgetConfig {
                title: "Pocket Chorus".into(),
                size: (WIN_W, WIN_H),
                ..Default::default()
            },
            game,
        )
    }
}

/// N fixed ticks, one composite PNG at 2× — the alpha channel is the real
/// window transparency, so the spill fog glows over whatever it lands on.
fn headless(mut game: ChorusGame, args: &Args, out: &std::path::Path) -> Result<()> {
    let (w, h) = (WIN_W * 2, WIN_H * 2);
    let gpu = Gpu::new_headless()?;
    let mut renderer = Renderer::new(&gpu, OFFSCREEN_FORMAT)?;
    game.init(&gpu, &mut renderer)?;

    let input = Input::default();
    for _ in 0..args.frames {
        game.tick(1.0 / 60.0, &input, (w, h))?;
    }
    game.take_dirty();
    game.prepare(&gpu)?;
    let target = OffscreenTarget::new(&gpu, w, h);
    let (scene, camera, hud) = game.compose(args.frames as f32 / 60.0, (w, h));
    renderer.render(&gpu, &target.view, (w, h), scene, camera, hud);
    target.save_png(&gpu, out)?;
    println!(
        "chorus: wrote {} after {} frames (yaw {:.1}°, pitch {:.1}°, dist {:.0})",
        out.display(),
        args.frames,
        args.yaw.to_degrees(),
        args.pitch.to_degrees(),
        game.dist
    );
    Ok(())
}
