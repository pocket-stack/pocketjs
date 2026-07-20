//! handheld — a borderless 3D PSP on the desktop that runs Pocket apps.
//!
//! The first pocket-widget runtime (WIDGET.md): a transparent, undecorated,
//! always-on-top window framing a procedurally built PSP whose screen is a
//! live 480×272 PocketJS `ui` surface and whose buttons feed real BTN bits
//! to an unmodified app bundle. The same bundle boots on PSP hardware, in
//! uihost, on the Vita — and inside this widget, and cannot tell the
//! difference.
//!
//!   cargo run -p handheld -- --app hero
//!   cargo run -p handheld -- --app im --screenshot out.png --frames 30
//!
//! Interactions: click the caps (they depress and hold their BTN bit),
//! drag the analog nub, double-click the screen to zoom between the desk
//! framing and a screen-filling focus framing, drag the body to move the
//! window, Esc quits. The uihost keyboard map works throughout: arrows =
//! D-pad, Z/Enter = CROSS, X = CIRCLE, A = SQUARE, S = TRIANGLE, Q/W = L/R,
//! Tab = SELECT, Space = START, I/J/K/L = nub.
//!
//! Bundles/paks come from the PocketJS build (`bun scripts/build.ts <app>`);
//! the widget looks in `<repo>/dist` (override: POCKETJS_DIST or --js/--pak).

mod device;

use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use glam::{Mat4, Vec2, Vec3};
use pocket3d::camera::Camera;
use pocket3d::gpu::{Gpu, OFFSCREEN_FORMAT, OffscreenTarget};
use pocket3d::hud::Hud;
use pocket3d::input::Input;
use pocket3d::renderer::Renderer;
use pocket3d::scene::Scene;
use pocket_mod::Guest;
use pocket_ui_wgpu::UiSurface;
use pocket_widget::embed::EmbeddedUi;
use pocket_widget::parts::{analog_pack, btn, key_button};
use pocket_widget::shell::{WidgetConfig, WidgetGame};
use winit::keyboard::KeyCode;

use device::{Device, NUB_TRAVEL, PRESS_TRAVEL, SCREEN_CENTER};

const UI_W: u32 = 480;
const UI_H: u32 = 272;
/// Window size, logical px.
const WIN_W: u32 = 480;
const WIN_H: u32 = 260;

/// Keys the widget polls for held state (the shared uihost map + I/J/K/L
/// as a keyboard nub).
const KEYS: [KeyCode; 14] = [
    KeyCode::ArrowUp,
    KeyCode::ArrowDown,
    KeyCode::ArrowLeft,
    KeyCode::ArrowRight,
    KeyCode::KeyZ,
    KeyCode::Enter,
    KeyCode::KeyX,
    KeyCode::Backspace,
    KeyCode::KeyA,
    KeyCode::KeyS,
    KeyCode::KeyQ,
    KeyCode::KeyW,
    KeyCode::Tab,
    KeyCode::Space,
];

/// Camera framings: "desk" shows the whole device; "focus" fills the window
/// with the screen (effectively uihost with a bezel). Double-click the
/// screen to toggle; the camera eases between them.
const DESK_POS: Vec3 = Vec3::new(0.0, 46.0, 190.0);
const DESK_TARGET: Vec3 = Vec3::ZERO;
const FOCUS_POS: Vec3 = Vec3::new(0.0, SCREEN_CENTER.y, 106.3);
const FOCUS_TARGET: Vec3 = SCREEN_CENTER;
/// Framing ease duration in ticks (60 Hz).
const FRAMING_TICKS: f32 = 21.0;
/// Double-click window in ticks.
const DOUBLE_CLICK_TICKS: u64 = 21;

struct HandheldGame {
    // Boot state (pre-GPU) — consumed by init.
    boot_surface: Option<UiSurface>,
    guest: Guest,

    embedded: Option<EmbeddedUi>,
    dev: Option<Device>,
    scene: Scene,
    camera: Camera,
    hud: Hud,

    window_px: (u32, u32),
    ticks: u64,
    prev_buttons: u32,
    /// Part index held by the mouse (its BTN bits stay down until release).
    mouse_part: Option<usize>,
    hover: Option<usize>,
    /// Cursor position where the nub was grabbed.
    nub_grab: Option<Vec2>,
    /// Nub deflection, −1..1 per axis (x right, y down).
    nub: Vec2,
    last_cursor: Option<Vec2>,
    /// 0 = desk framing, 1 = focus framing.
    focus: bool,
    blend: f32,
    last_screen_click: Option<u64>,
    /// Extra BTN bits held for the whole run (headless --hold).
    hold_mask: u32,
    /// Exit after this many ticks (--auto-quit smoke tests).
    quit_after: Option<u64>,
    dirty: bool,
    exit: bool,
}

impl HandheldGame {
    fn new(guest: Guest, surface: UiSurface, hold_mask: u32) -> Self {
        let mut scene = Scene::default();
        scene.transparent_clear = true;
        let mut camera = Camera {
            pos: DESK_POS,
            fov_y: 30f32.to_radians(),
            znear: 10.0,
            zfar: 2000.0,
            ..Default::default()
        };
        camera.look_at(DESK_TARGET);
        Self {
            boot_surface: Some(surface),
            guest,
            embedded: None,
            dev: None,
            scene,
            camera,
            hud: Hud::default(),
            window_px: (WIN_W, WIN_H),
            ticks: 0,
            prev_buttons: 0,
            mouse_part: None,
            hover: None,
            nub_grab: None,
            nub: Vec2::ZERO,
            last_cursor: None,
            focus: false,
            blend: 0.0,
            last_screen_click: None,
            hold_mask,
            quit_after: None,
            dirty: true,
            exit: false,
        }
    }

    fn pick(&self, cursor: Vec2) -> Option<usize> {
        let dev = self.dev.as_ref()?;
        let (origin, dir) = self.camera.screen_ray(
            cursor,
            (self.window_px.0 as f32, self.window_px.1 as f32),
        );
        dev.map.pick(origin, dir).map(|(i, _)| i)
    }

    /// Press/hover/nub state → instance transforms and tints. Runs every
    /// tick; the scene mutation is a handful of matrix writes.
    fn apply_visuals(&mut self, buttons: u32) {
        let Some(dev) = self.dev.as_ref() else { return };
        for (i, part) in dev.parts.iter().enumerate() {
            let inst = &mut self.scene.models[part.instance];
            let pressed = part.buttons != 0 && buttons & part.buttons == part.buttons;
            let mut offset = Vec3::ZERO;
            if pressed {
                offset.z -= PRESS_TRAVEL;
            }
            if part.name == "nub" {
                offset += Vec3::new(self.nub.x, -self.nub.y, 0.0) * NUB_TRAVEL;
            }
            inst.transform = Mat4::from_translation(offset) * part.base;
            let hovered = self.hover == Some(i) && part.buttons != 0;
            inst.tint = if hovered && !pressed {
                let t = part.tint;
                [t[0] * 1.35, t[1] * 1.35, t[2] * 1.35, t[3]]
            } else {
                part.tint
            };
        }
    }
}

impl WidgetGame for HandheldGame {
    fn init(&mut self, gpu: &Gpu, renderer: &mut Renderer) -> Result<()> {
        let surface = self.boot_surface.take().expect("init runs once");
        let embedded = EmbeddedUi::new(gpu, surface, (UI_W, UI_H));
        self.dev = Some(device::build(gpu, renderer, &mut self.scene, embedded.view()));
        self.embedded = Some(embedded);
        Ok(())
    }

    fn tick(&mut self, dt: f32, input: &Input, window_px: (u32, u32)) -> Result<()> {
        self.window_px = window_px;
        if input.key_pressed(KeyCode::Escape)
            || self.quit_after.is_some_and(|limit| self.ticks >= limit)
        {
            self.exit = true;
        }

        // --- keyboard: held BTN bits + I/J/K/L nub ------------------------
        let mut buttons = self.hold_mask;
        for code in KEYS {
            if input.key_down(code)
                && let Some(bit) = key_button(code)
            {
                buttons |= bit;
            }
        }
        let key_axis = |neg: KeyCode, pos: KeyCode| {
            (input.key_down(pos) as i32 - input.key_down(neg) as i32) as f32
        };
        let key_nub = Vec2::new(
            key_axis(KeyCode::KeyJ, KeyCode::KeyL),
            key_axis(KeyCode::KeyI, KeyCode::KeyK),
        );

        // --- mouse: hover, press, nub drag --------------------------------
        let cursor = input.cursor();
        if let Some(c) = cursor {
            if self.nub_grab.is_none() && self.last_cursor != Some(c) {
                let hover = self.pick(c);
                if hover != self.hover {
                    self.hover = hover;
                    self.dirty = true;
                }
            }
            if input.mouse_button_pressed(winit::event::MouseButton::Left) {
                let hit = self.pick(c).map(|i| {
                    let p = &self.dev.as_ref().unwrap().parts[i];
                    (i, p.name, p.buttons)
                });
                log::debug!(
                    "press at {c:?}: {}",
                    hit.map_or("nothing", |(_, name, _)| name)
                );
                match hit {
                    Some((i, "nub", _)) => {
                        let _ = i;
                        self.nub_grab = Some(c);
                    }
                    Some((_, "screen", _)) => {
                        let double = self
                            .last_screen_click
                            .is_some_and(|t| self.ticks - t <= DOUBLE_CLICK_TICKS);
                        self.last_screen_click = Some(self.ticks);
                        if double {
                            self.focus = !self.focus;
                        }
                    }
                    Some((i, _, bits)) if bits != 0 => {
                        self.mouse_part = Some(i);
                    }
                    _ => {}
                }
            }
            if let Some(grab) = self.nub_grab {
                // Full tilt at 30 logical px of drag (scaled to physical).
                let full = 30.0 * self.window_px.0 as f32 / WIN_W as f32;
                let mut v = (c - grab) / full;
                if v.length() > 1.0 {
                    v = v.normalize();
                }
                if v != self.nub {
                    self.nub = v;
                    self.dirty = true;
                }
            }
            self.last_cursor = Some(c);
        }
        if !input.mouse_button_down(winit::event::MouseButton::Left) {
            if self.mouse_part.take().is_some() {
                self.dirty = true;
            }
            if self.nub_grab.take().is_some() {
                self.nub = Vec2::ZERO;
                self.dirty = true;
            }
        }
        if let Some(i) = self.mouse_part {
            buttons |= self.dev.as_ref().unwrap().parts[i].buttons;
        }
        if buttons != self.prev_buttons {
            self.prev_buttons = buttons;
            self.dirty = true;
        }

        // --- the guest turn (Law 3: exactly one per tick) ------------------
        let nub = if self.nub_grab.is_some() { self.nub } else { key_nub };
        let analog = analog_pack(nub.x, nub.y);
        self.guest.frame_with_analog(buttons, analog)?;
        if let Some(embedded) = self.embedded.as_mut()
            && embedded.tick()
        {
            self.dirty = true;
        }

        // --- camera framing ease ------------------------------------------
        let target = if self.focus { 1.0 } else { 0.0 };
        if self.blend != target {
            let step = dt * 60.0 / FRAMING_TICKS;
            self.blend = if self.blend < target {
                (self.blend + step).min(target)
            } else {
                (self.blend - step).max(target)
            };
            self.dirty = true;
        }

        self.apply_visuals(buttons);
        self.ticks += 1;
        Ok(())
    }

    fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    fn prepare(&mut self, gpu: &Gpu) -> Result<()> {
        if let Some(embedded) = self.embedded.as_mut() {
            embedded.render_if_dirty(gpu)?;
        }
        Ok(())
    }

    fn compose(&mut self, time: f32, _size: (u32, u32)) -> (&Scene, &Camera, &Hud) {
        let t = self.blend * self.blend * (3.0 - 2.0 * self.blend); // smoothstep
        self.camera.pos = DESK_POS.lerp(FOCUS_POS, t);
        self.camera.look_at(DESK_TARGET.lerp(FOCUS_TARGET, t));
        self.scene.time = time;
        (&self.scene, &self.camera, &self.hud)
    }

    fn drag_at(&mut self, cursor: Vec2) -> bool {
        // Dragging anything inert moves the window — the pocket-character
        // "drag anywhere" feel, minus the interactive parts.
        match self.pick(cursor) {
            None => true,
            Some(i) => {
                let p = &self.dev.as_ref().unwrap().parts[i];
                p.buttons == 0 && !matches!(p.name, "nub" | "screen")
            }
        }
    }

    fn wants_exit(&self) -> bool {
        self.exit
    }
}

// ---------------------------------------------------------------------------
// boot + CLI
// ---------------------------------------------------------------------------

struct Args {
    app: String,
    js: Option<PathBuf>,
    pak: Option<PathBuf>,
    screenshot: Option<PathBuf>,
    frames: u32,
    hold: u32,
    /// Headless: click this window pixel (press mid-run, release at 2/3).
    click: Option<(f32, f32)>,
    /// Headless: (BTN bits, frame) taps — held for 6 ticks from that frame.
    taps: Vec<(u32, u32)>,
    /// Start in the screen-filling focus framing.
    focus: bool,
    /// Windowed smoke test: quit after this many seconds.
    auto_quit: Option<f32>,
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        app: "hero-main".into(),
        js: None,
        pak: None,
        screenshot: None,
        frames: 30,
        hold: 0,
        click: None,
        taps: Vec::new(),
        focus: false,
        auto_quit: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        let mut val = |name: &str| -> Result<String> {
            it.next().ok_or_else(|| anyhow!("{name} needs a value"))
        };
        match a.as_str() {
            "--app" => args.app = val("--app")?,
            "--js" => args.js = Some(PathBuf::from(val("--js")?)),
            "--pak" => args.pak = Some(PathBuf::from(val("--pak")?)),
            "--screenshot" => args.screenshot = Some(PathBuf::from(val("--screenshot")?)),
            "--frames" => args.frames = val("--frames")?.parse()?,
            "--hold" => {
                for name in val("--hold")?.split(',') {
                    args.hold |= hold_bit(name)?;
                }
            }
            "--click" => {
                let v = val("--click")?;
                let (x, y) = v
                    .split_once(',')
                    .ok_or_else(|| anyhow!("--click wants x,y"))?;
                args.click = Some((x.trim().parse()?, y.trim().parse()?));
            }
            "--tap" => {
                let v = val("--tap")?;
                let (name, frame) = v
                    .split_once('@')
                    .ok_or_else(|| anyhow!("--tap wants name@frame"))?;
                args.taps.push((hold_bit(name)?, frame.parse()?));
            }
            "--focus" => args.focus = true,
            "--auto-quit" => args.auto_quit = Some(val("--auto-quit")?.parse()?),
            other => return Err(anyhow!("unknown flag {other}")),
        }
    }
    Ok(args)
}

fn hold_bit(name: &str) -> Result<u32> {
    Ok(match name {
        "up" => btn::UP,
        "down" => btn::DOWN,
        "left" => btn::LEFT,
        "right" => btn::RIGHT,
        "cross" => btn::CROSS,
        "circle" => btn::CIRCLE,
        "square" => btn::SQUARE,
        "triangle" => btn::TRIANGLE,
        "start" => btn::START,
        "select" => btn::SELECT,
        "l" => btn::LTRIGGER,
        "r" => btn::RTRIGGER,
        other => return Err(anyhow!("unknown button '{other}'")),
    })
}

/// `<repo>/dist` — relative to this crate in the source tree, or
/// POCKETJS_DIST, or ./dist for standalone binaries.
fn dist_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("POCKETJS_DIST") {
        return Some(PathBuf::from(d));
    }
    let from_manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../dist")
        .canonicalize()
        .ok();
    from_manifest.or_else(|| {
        let cwd = PathBuf::from("dist");
        cwd.is_dir().then_some(cwd)
    })
}

fn resolve_asset(explicit: Option<PathBuf>, app: &str, ext: &str) -> Result<PathBuf> {
    if let Some(p) = explicit {
        return p
            .canonicalize()
            .with_context(|| format!("missing {}", p.display()));
    }
    let dist =
        dist_dir().ok_or_else(|| anyhow!("cannot find PocketJS dist/ (set POCKETJS_DIST)"))?;
    let candidates = [format!("{app}.{ext}"), format!("{app}-main.{ext}")];
    for c in &candidates {
        let p = dist.join(c);
        if p.is_file() {
            return Ok(p);
        }
    }
    Err(anyhow!(
        "no {ext} for app '{app}' in {} — build it first: bun scripts/build.ts {app}",
        dist.display()
    ))
}

/// Boot the guest: feed the pak, mount `ui`, eval the bundle.
fn boot(args: &Args) -> Result<(Guest, UiSurface)> {
    let js_path = resolve_asset(args.js.clone(), &args.app, "js")?;
    let pak_path = resolve_asset(args.pak.clone(), &args.app, "pak")?;
    let bundle = std::fs::read_to_string(&js_path)
        .with_context(|| format!("reading {}", js_path.display()))?;
    let pak =
        std::fs::read(&pak_path).with_context(|| format!("reading {}", pak_path.display()))?;

    let surface = UiSurface::new((UI_W as f32, UI_H as f32));
    surface.feed_pak(&pak);
    let guest = Guest::new()?;
    surface.mount(&guest)?;
    guest.eval(&args.app, &bundle)?;
    if !guest.has_frame() {
        return Err(anyhow!(
            "bundle evaluated but installed no frame() — is this a PocketJS app?"
        ));
    }
    log::info!(
        "handheld: booted {} ({} bytes js, {} bytes pak)",
        args.app,
        bundle.len(),
        pak.len()
    );
    Ok((guest, surface))
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args = parse_args()?;
    let (guest, surface) = boot(&args)?;
    let mut game = HandheldGame::new(guest, surface, args.hold);
    game.quit_after = args.auto_quit.map(|s| (s * 60.0) as u64);
    if args.focus {
        game.focus = true;
        game.blend = 1.0;
    }
    if let Some(out) = args.screenshot.clone() {
        headless(game, &args, &out)
    } else {
        pocket_widget::run(
            WidgetConfig {
                title: "Pocket Handheld".into(),
                size: (WIN_W, WIN_H),
                ..Default::default()
            },
            game,
        )
    }
}

/// Headless: N fixed ticks, then one composite PNG at 2× (its alpha channel
/// is the actual window transparency). `--click x,y` scripts a cursor press
/// on that pixel for the middle third of the run — the full pick → part →
/// BTN → guest path, no window required.
fn headless(mut game: HandheldGame, args: &Args, out: &std::path::Path) -> Result<()> {
    let (w, h) = (WIN_W * 2, WIN_H * 2);
    let gpu = Gpu::new_headless()?;
    let mut renderer = Renderer::new(&gpu, OFFSCREEN_FORMAT)?;
    game.init(&gpu, &mut renderer)?;

    let mut input = Input::default();
    let base_hold = args.hold;
    let (press_at, release_at) = (args.frames / 3, args.frames * 2 / 3);
    for frame in 0..args.frames {
        game.hold_mask = base_hold
            | args
                .taps
                .iter()
                .filter(|&&(_, at)| (at..at + 6).contains(&frame))
                .fold(0, |acc, &(bits, _)| acc | bits);
        if let Some((x, y)) = args.click {
            input.inject_cursor(x, y);
            if frame == press_at {
                input.inject_mouse_button(winit::event::MouseButton::Left, true);
            }
            if frame == release_at {
                input.inject_mouse_button(winit::event::MouseButton::Left, false);
            }
        }
        game.tick(1.0 / 60.0, &input, (w, h))?;
        input.end_frame();
    }
    game.take_dirty();
    game.prepare(&gpu)?;
    let target = OffscreenTarget::new(&gpu, w, h);
    let (scene, camera, hud) = game.compose(args.frames as f32 / 60.0, (w, h));
    renderer.render(&gpu, &target.view, (w, h), scene, camera, hud);
    target.save_png(&gpu, out)?;
    println!(
        "handheld: wrote {} after {} frames (app {}, hold {:#06x})",
        out.display(),
        args.frames,
        args.app,
        args.hold
    );
    Ok(())
}
