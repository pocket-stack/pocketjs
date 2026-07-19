//! note-widget — a markdown sticky note on the desktop.
//!
//! The first *flat* pocket-widget runtime (WIDGET.md): no scene, no camera —
//! the borderless window IS a live PocketJS `ui` surface, rendered by the
//! same DrawList backend as every other host and governed by the shell's
//! demand rendering: the guest ticks at 60 Hz always, a GPU frame renders
//! only when the DrawList hash moves. A settled note costs ticks
//! (microseconds), zero frames.
//!
//!   bun scripts/build.ts note-main --density=2
//!   cargo run -p note-widget
//!   cargo run -p note-widget -- --file ~/notes/todo.md --width 380 --height 520
//!
//! The host is the guest's companion process over the spec svc channel
//! (ops 30..32): real keyboard/mouse/wheel/resize go in as JSON lines,
//! save/quit intents come back. Clicks synthesize BTN_CIRCLE, so the
//! framework's hover-focus + onPress pipeline dispatches them — the app
//! never sees a platform event, only spec inputs. Drag the header to move,
//! drag the dotted corner (or any edge, macOS) to resize, ⌘Q/⌘W quits.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use glam::Vec2;
use pocket3d::gpu::{Gpu, OFFSCREEN_FORMAT, OffscreenTarget};
use pocket3d::input::{EditKey, Input};
use pocket_mod::Guest;
use pocket_ui_wgpu::{UiRenderer, UiSurface};
use pocket_widget::shell::{FlatWidget, WidgetConfig};
use winit::keyboard::KeyCode;

/// Header strip height in logical px — mirrors HEADER_H in demos/note/app.tsx.
const HEADER_H: f32 = 30.0;
/// Header pixels reserved for the EDIT/••• buttons (not a drag region).
const HEADER_BUTTONS_W: f32 = 86.0;
/// Resize grip square in the bottom-right corner, logical px.
const GRIP: f32 = 18.0;
/// The spec CIRCLE bit — the framework's onPress button.
const BTN_CIRCLE: u32 = 0x2000;

struct NoteGame {
    surface: UiSurface,
    guest: Guest,
    renderer: Option<UiRenderer>,
    file: PathBuf,
    /// Current logical viewport (the core's), tracked against the window.
    logical: (u32, u32),
    /// DrawList words of the latest tick + their hash (the dirty signal).
    words: Vec<u32>,
    hash: u64,
    dirty: bool,
    exit: bool,
    booted: bool,
    last_mouse: Option<(f32, f32)>,
    /// Window scale factor from the latest tick (cursor px → logical).
    scale: f64,
    ticks: u64,
    /// Headless scripting (--type/--click/--key events by frame).
    script: Vec<(u64, ScriptEvent)>,
    /// Scripted click: CIRCLE held until this tick.
    script_click_until: u64,
    quit_after: Option<u64>,
}

enum ScriptEvent {
    Click(f32, f32),
    Type(String),
    Key(String),
    Scroll(f32),
}

impl NoteGame {
    fn new(surface: UiSurface, guest: Guest, file: PathBuf, logical: (u32, u32)) -> Self {
        NoteGame {
            surface,
            guest,
            renderer: None,
            file,
            logical,
            words: Vec::new(),
            hash: 0,
            dirty: true,
            exit: false,
            booted: false,
            last_mouse: None,
            scale: 1.0,
            ticks: 0,
            script: Vec::new(),
            script_click_until: 0,
            quit_after: None,
        }
    }

    fn svc(&self, value: serde_json::Value) {
        self.surface.svc_push(value.to_string());
    }

    /// The svc hello: viewport first, then the document (order matters — the
    /// app lays text out against the viewport it was just told about).
    fn send_hello(&mut self) {
        self.svc(serde_json::json!({"t": "hello", "w": self.logical.0, "h": self.logical.1}));
        let text = std::fs::read_to_string(&self.file).unwrap_or_default();
        if !text.is_empty() {
            self.svc(serde_json::json!({"t": "load", "text": text}));
        }
        log::info!(
            "note-widget: {} ({} bytes)",
            self.file.display(),
            text.len()
        );
    }

    fn save(&self, text: &str) {
        // Atomic-enough: temp in the same directory, then rename.
        let tmp = self.file.with_extension("md.tmp");
        let write = std::fs::write(&tmp, text).and_then(|()| std::fs::rename(&tmp, &self.file));
        match write {
            Ok(()) => log::info!("note-widget: saved {} bytes", text.len()),
            Err(e) => log::warn!("note-widget: save failed: {e}"),
        }
    }

    fn forward_edits(&mut self, input: &Input) {
        // Batch runs of typed chars into one line; ⌘-chords are shortcuts,
        // not text.
        let mut chars = String::new();
        for key in input.edits() {
            let named = match key {
                EditKey::Char(c) => {
                    if !input.super_down() {
                        chars.push(*c);
                    }
                    continue;
                }
                EditKey::Backspace => "Backspace",
                EditKey::Delete => "Delete",
                EditKey::Enter => "Enter",
                EditKey::Tab => "Tab",
                EditKey::Left => "Left",
                EditKey::Right => "Right",
                EditKey::Up => "Up",
                EditKey::Down => "Down",
                EditKey::Home => "Home",
                EditKey::End => "End",
                EditKey::PageUp => "PageUp",
                EditKey::PageDown => "PageDown",
                EditKey::Escape => "Escape",
            };
            if !chars.is_empty() {
                self.svc(serde_json::json!({"t": "ch", "s": std::mem::take(&mut chars)}));
            }
            self.svc(serde_json::json!({"t": "key", "k": named}));
        }
        if !chars.is_empty() {
            self.svc(serde_json::json!({"t": "ch", "s": chars}));
        }
    }

    fn run_script(&mut self) {
        let due: Vec<usize> = self
            .script
            .iter()
            .enumerate()
            .filter(|(_, (at, _))| *at == self.ticks)
            .map(|(i, _)| i)
            .collect();
        for i in due.into_iter().rev() {
            let (_, ev) = self.script.remove(i);
            match ev {
                ScriptEvent::Click(x, y) => {
                    // Hover first (focuses the target), then hold CIRCLE for
                    // a few ticks — the same order a real pointer produces.
                    self.svc(serde_json::json!({"t": "mouse", "x": x, "y": y}));
                    self.script_click_until = self.ticks + 4;
                }
                ScriptEvent::Type(s) => self.svc(serde_json::json!({"t": "ch", "s": s})),
                ScriptEvent::Key(k) => self.svc(serde_json::json!({"t": "key", "k": k})),
                ScriptEvent::Scroll(dy) => self.svc(serde_json::json!({"t": "scroll", "dy": dy})),
            }
        }
    }
}

impl FlatWidget for NoteGame {
    fn init(&mut self, gpu: &Gpu, format: wgpu::TextureFormat) -> Result<()> {
        self.renderer = Some(UiRenderer::new(gpu, format));
        Ok(())
    }

    fn tick(&mut self, _dt: f32, input: &Input, window_px: (u32, u32), scale: f64) -> Result<()> {
        self.scale = scale;
        if !self.booted {
            self.booted = true;
            self.send_hello();
        }

        // ⌘Q / ⌘W quit (the widget has no titlebar close button).
        if input.super_down()
            && (input.key_pressed(KeyCode::KeyQ) || input.key_pressed(KeyCode::KeyW))
        {
            self.exit = true;
        }
        if let Some(limit) = self.quit_after
            && self.ticks >= limit
        {
            self.exit = true;
        }

        // Window → core viewport. Live resizes relayout the core and tell
        // the app (which re-wraps against the new width).
        let logical = (
            ((window_px.0 as f64 / scale).round() as u32).max(1),
            ((window_px.1 as f64 / scale).round() as u32).max(1),
        );
        if logical != self.logical {
            self.logical = logical;
            self.surface
                .with_ui(|ui| ui.set_viewport(logical.0 as f32, logical.1 as f32));
            self.svc(serde_json::json!({"t": "resize", "w": logical.0, "h": logical.1}));
        }

        // Keyboard / wheel / pointer → svc lines (logical px).
        self.forward_edits(input);
        let scroll = input.scroll();
        if scroll.y != 0.0 {
            self.svc(serde_json::json!({"t": "scroll", "dy": scroll.y / scale as f32}));
        }
        if let Some(cursor) = input.cursor() {
            let m = (cursor.x / scale as f32, cursor.y / scale as f32);
            if self.last_mouse != Some(m) {
                self.last_mouse = Some(m);
                self.svc(serde_json::json!({"t": "mouse", "x": m.0, "y": m.1}));
            }
        }

        // Headless script events (windowed runs have none).
        if !self.script.is_empty() {
            self.run_script();
        }
        let mouse_down = input.mouse_button_down(winit::event::MouseButton::Left)
            || self.ticks < self.script_click_until;

        // The guest turn (Law 3: exactly one per tick). Clicks are CIRCLE —
        // hover already focused what's under the pointer.
        let buttons = if mouse_down { BTN_CIRCLE } else { 0 };
        self.guest.frame(buttons)?;
        self.surface.tick();

        // Guest → host intents.
        for line in self.surface.svc_drain() {
            match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(v) => match v["t"].as_str() {
                    Some("save") => self.save(v["text"].as_str().unwrap_or_default()),
                    Some("quit") => self.exit = true,
                    other => log::warn!("note-widget: unknown intent {other:?}"),
                },
                Err(e) => log::warn!("note-widget: bad svc line from guest: {e}"),
            }
        }

        // DrawList content hash → demand rendering (embed.rs's trick, flat).
        let (hash, words) = self.surface.with_ui(|ui| {
            let words = &ui.draw().words;
            let hash = fnv1a64(words);
            (hash, (hash != self.hash).then(|| words.clone()))
        });
        if let Some(words) = words {
            log::debug!("note-widget: DrawList changed at tick {}", self.ticks);
            self.words = words;
            self.hash = hash;
            self.dirty = true;
        }

        self.ticks += 1;
        Ok(())
    }

    fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    fn render(&mut self, gpu: &Gpu, view: &wgpu::TextureView, window_px: (u32, u32)) -> Result<()> {
        let renderer = self.renderer.as_mut().expect("init ran");
        let scale = window_px.0 as f32 / self.logical.0.max(1) as f32;
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        self.surface.with_ui(|ui| {
            renderer.render_words_scaled(
                gpu,
                ui,
                &self.words,
                &mut encoder,
                view,
                window_px,
                scale,
                // Transparent clear: the app's rounded-xl background is the
                // window shape; the corners really are see-through.
                wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
            )
        })?;
        gpu.queue.submit([encoder.finish()]);
        Ok(())
    }

    fn drag_at(&mut self, cursor: Vec2) -> bool {
        // The header is the move handle, minus the buttons on its right.
        let (x, y) = (cursor.x / self.scale as f32, cursor.y / self.scale as f32);
        y < HEADER_H && x < self.logical.0 as f32 - HEADER_BUTTONS_W
    }

    fn resize_at(&mut self, cursor: Vec2) -> bool {
        let (x, y) = (cursor.x / self.scale as f32, cursor.y / self.scale as f32);
        x > self.logical.0 as f32 - GRIP && y > self.logical.1 as f32 - GRIP
    }

    fn wants_exit(&self) -> bool {
        self.exit
    }
}

/// FNV-1a 64 over the DrawList words (embed.rs's dirty signal).
fn fnv1a64(words: &[u32]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for w in words {
        for b in w.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

// ---------------------------------------------------------------------------
// boot + CLI
// ---------------------------------------------------------------------------

struct Args {
    app: String,
    js: Option<PathBuf>,
    pak: Option<PathBuf>,
    file: Option<PathBuf>,
    size: (u32, u32),
    density: u32,
    screenshot: Option<PathBuf>,
    frames: u64,
    script: Vec<(u64, ScriptEvent)>,
    auto_quit: Option<f32>,
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        app: "note-main".into(),
        js: None,
        pak: None,
        file: None,
        size: (420, 560),
        density: 2,
        screenshot: None,
        frames: 40,
        script: Vec::new(),
        auto_quit: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        let mut val = |name: &str| -> Result<String> {
            it.next().ok_or_else(|| anyhow!("{name} needs a value"))
        };
        /// `spec@frame` → (frame, spec).
        fn at(v: &str, flag: &str) -> Result<(u64, String)> {
            let (spec, frame) = v
                .rsplit_once('@')
                .ok_or_else(|| anyhow!("{flag} wants value@frame"))?;
            Ok((frame.parse()?, spec.to_string()))
        }
        match a.as_str() {
            "--app" => args.app = val("--app")?,
            "--js" => args.js = Some(PathBuf::from(val("--js")?)),
            "--pak" => args.pak = Some(PathBuf::from(val("--pak")?)),
            "--file" => args.file = Some(PathBuf::from(val("--file")?)),
            "--width" => args.size.0 = val("--width")?.parse()?,
            "--height" => args.size.1 = val("--height")?.parse()?,
            "--density" => args.density = val("--density")?.parse()?,
            "--screenshot" => args.screenshot = Some(PathBuf::from(val("--screenshot")?)),
            "--frames" => args.frames = val("--frames")?.parse()?,
            "--click" => {
                let (frame, spec) = at(&val("--click")?, "--click")?;
                let (x, y) = spec
                    .split_once(',')
                    .ok_or_else(|| anyhow!("--click wants x,y@frame"))?;
                args.script
                    .push((frame, ScriptEvent::Click(x.trim().parse()?, y.trim().parse()?)));
            }
            "--type" => {
                let (frame, s) = at(&val("--type")?, "--type")?;
                args.script.push((frame, ScriptEvent::Type(s)));
            }
            "--key" => {
                let (frame, k) = at(&val("--key")?, "--key")?;
                args.script.push((frame, ScriptEvent::Key(k)));
            }
            "--scroll" => {
                let (frame, dy) = at(&val("--scroll")?, "--scroll")?;
                args.script.push((frame, ScriptEvent::Scroll(dy.parse()?)));
            }
            "--auto-quit" => args.auto_quit = Some(val("--auto-quit")?.parse()?),
            other => return Err(anyhow!("unknown flag {other}")),
        }
    }
    Ok(args)
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
        "no {ext} for app '{app}' in {} — build it first: bun scripts/build.ts {app} --density=2",
        dist.display()
    ))
}

fn note_file(explicit: Option<PathBuf>) -> PathBuf {
    explicit.unwrap_or_else(|| {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        Path::new(&home).join(".pocket-note.md")
    })
}

/// Boot the guest: feed the pak, mount `ui` (svc included), eval the bundle.
fn boot(args: &Args) -> Result<(Guest, UiSurface)> {
    let js_path = resolve_asset(args.js.clone(), &args.app, "js")?;
    let pak_path = resolve_asset(args.pak.clone(), &args.app, "pak")?;
    let bundle = std::fs::read_to_string(&js_path)
        .with_context(|| format!("reading {}", js_path.display()))?;
    let pak =
        std::fs::read(&pak_path).with_context(|| format!("reading {}", pak_path.display()))?;

    let surface = UiSurface::new_with_density(
        (args.size.0 as f32, args.size.1 as f32),
        args.density,
    );
    surface.feed_pak(&pak);
    let guest = Guest::new()?;
    surface.mount(&guest)?;
    guest.eval(&args.app, &bundle)?;
    if !guest.has_frame() {
        return Err(anyhow!(
            "bundle evaluated but installed no frame() — is this a PocketJS app?"
        ));
    }
    Ok((guest, surface))
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let mut args = parse_args()?;
    let (guest, surface) = boot(&args)?;
    let mut game = NoteGame::new(surface, guest, note_file(args.file.clone()), args.size);
    game.script = std::mem::take(&mut args.script);
    game.quit_after = args.auto_quit.map(|s| (s * 60.0) as u64);

    if let Some(out) = args.screenshot.clone() {
        headless(game, args, &out)
    } else {
        pocket_widget::run_flat(
            WidgetConfig {
                title: "Pocket Note".into(),
                size: args.size,
                resizable: true,
                min_size: (240, 180),
                ..Default::default()
            },
            game,
        )
    }
}

/// Headless: N fixed ticks at 1x scale (logical == physical), scripted svc
/// events, then one PNG at density scale. No window required.
fn headless(mut game: NoteGame, args: Args, out: &std::path::Path) -> Result<()> {
    let gpu = Gpu::new_headless()?;
    game.init(&gpu, OFFSCREEN_FORMAT)?;
    let mut input = Input::default();
    let px = (args.size.0, args.size.1);
    for _ in 0..args.frames {
        game.tick(1.0 / 60.0, &input, px, 1.0)?;
        input.end_frame();
    }
    let scale = args.density.max(1);
    let (w, h) = (args.size.0 * scale, args.size.1 * scale);
    let target = OffscreenTarget::new(&gpu, w, h);
    game.take_dirty();
    let renderer = game.renderer.as_mut().expect("init ran");
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    game.surface.with_ui(|ui| {
        renderer.render_words_scaled(
            &gpu,
            ui,
            &game.words,
            &mut encoder,
            &target.view,
            (w, h),
            scale as f32,
            wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
        )
    })?;
    gpu.queue.submit([encoder.finish()]);
    target.save_png(&gpu, out)?;
    println!(
        "note-widget: wrote {} after {} frames ({}x{} @{}x)",
        out.display(),
        args.frames,
        w,
        h,
        scale
    );
    Ok(())
}
