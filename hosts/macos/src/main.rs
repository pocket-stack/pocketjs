//! pocket-macos — the PocketJS UI runtime in a gpui window.
//!
//! The same app bundle + pak the consoles boot runs here in a QuickJS guest
//! (pocket-mod) driving the same pocketjs-core, painted by the gpui backend
//! (engine/backends/gpui, docs/BACKENDS.md) instead of the portable
//! atlas-blitting pipeline. Apps that enhance `text.layout.native` get host
//! (CoreText) text measurement and shaping — the host installs the core
//! measurer BEFORE the guest mounts; everything else renders from the baked
//! atlases exactly like every other backend.
//!
//! Determinism (docs/DETERMINISM.md): the guest ticks on a fixed 60 Hz
//! virtual clock from a foreground timer loop — exactly one `guest.frame()`
//! plus one `surface.tick()` per tick, NEVER from a paint callback. Painting
//! is demand-driven: a tick that changes the DrawList content hash notifies
//! the window; unchanged ticks paint nothing (the pocket-widget governor's
//! discipline, restated on gpui).
//!
//! Input modes:
//! - console — PSP button mapping (arrows = D-pad, Z/Enter = CROSS, …), for
//!   fixed-viewport console apps, letterboxed & size-locked.
//! - editor — the NOTE COMPANION adapter, the svc JSON-line dialect
//!   note-widget speaks (apps/note/svc.ts): keyboard/IME/pointer/scroll
//!   forwarded as lines, guest intents (save/quit/copy/caret) handled here.
//!   An app protocol, not a capability: the live-viewport hook and button
//!   map work for every app regardless of this flag.

use std::cell::{Cell, RefCell};
use std::ops::Range;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, anyhow};
use gpui::{
    App, AppContext as _, Application, Bounds, ClipboardItem, Context, Entity, EntityInputHandler,
    FocusHandle, Focusable, InteractiveElement, IntoElement, KeyDownEvent, KeyUpEvent, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, Point, Render,
    ScrollWheelEvent, SharedString, Styled, TitlebarOptions, UTF16Selection, Window, WindowBounds,
    WindowOptions, canvas, div, point, px, size,
};
use pocket_mod::Guest;
use pocket_ui_gpui::{GpuiRenderer, TextConfig, native_measure};
use pocket_ui_surface::UiSurface;

const HOST_ID: &str = "macos-app";
const HOST_ABI: u32 = 3;
const TICK_HZ: f64 = 60.0;
const MAX_CATCHUP_TICKS: u32 = 6;

// spec BTN bits (contracts/spec/spec.ts) — console input mode.
const BTN_SELECT: u32 = 0x0001;
const BTN_START: u32 = 0x0008;
const BTN_UP: u32 = 0x0010;
const BTN_RIGHT: u32 = 0x0020;
const BTN_DOWN: u32 = 0x0040;
const BTN_LEFT: u32 = 0x0080;
const BTN_LTRIGGER: u32 = 0x0100;
const BTN_RTRIGGER: u32 = 0x0200;
const BTN_TRIANGLE: u32 = 0x1000;
const BTN_CIRCLE: u32 = 0x2000;
const BTN_CROSS: u32 = 0x4000;
const BTN_SQUARE: u32 = 0x8000;

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

#[derive(Clone)]
enum ScriptEvent {
    /// Push typed characters at a tick (svc `ch` line).
    Type(u64, String),
    /// Press-and-release the pointer at logical (x, y) at a tick.
    Click(u64, f32, f32),
    /// Hold a console button for ~6 ticks starting at a tick.
    Press(u64, u32),
}

struct Args {
    app: String,
    js: Option<PathBuf>,
    pak: Option<PathBuf>,
    /// Editor-protocol document file (note-widget's --file).
    file: Option<PathBuf>,
    title: String,
    /// Logical viewport at boot (the plan's resolved size).
    viewport: (u32, u32),
    /// Fixed-viewport app: size-locked window, letterboxed canvas.
    fixed: bool,
    /// Install the native text measurer (plan feature text.layout.native).
    native_text: bool,
    /// svc editor protocol instead of console buttons.
    editor: bool,
    density: u32,
    script: Vec<ScriptEvent>,
    quit_after_ticks: Option<u64>,
    /// Benchmark typing storm: (chars/sec, start tick, duration ticks) —
    /// svc `ch` lines through the same edit path real typing takes.
    storm: Option<(u32, u64, u64)>,
    /// Print "READY <epoch_ms>" on the first painted frame — the desktop
    /// benchmark runner's cold-start marker (PR #294). Off by default.
    announce_ready: bool,
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        app: "note-main".into(),
        js: None,
        pak: None,
        file: None,
        title: "PocketJS".into(),
        viewport: (720, 480),
        fixed: false,
        native_text: false,
        editor: false,
        density: 2,
        script: Vec::new(),
        quit_after_ticks: None,
        storm: None,
        announce_ready: false,
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
            "--file" => args.file = Some(PathBuf::from(val("--file")?)),
            "--title" => args.title = val("--title")?,
            "--viewport" => {
                let v = val("--viewport")?;
                let (w, h) = v.split_once('x').ok_or_else(|| anyhow!("--viewport WxH"))?;
                args.viewport = (w.parse()?, h.parse()?);
            }
            "--fixed" => args.fixed = true,
            "--native-text" => args.native_text = true,
            "--editor" => args.editor = true,
            "--density" => args.density = val("--density")?.parse::<u32>()?.clamp(1, 4),
            "--type" => {
                // --type TEXT@TICK
                let v = val("--type")?;
                let (s, t) = v
                    .rsplit_once('@')
                    .ok_or_else(|| anyhow!("--type TEXT@TICK"))?;
                args.script
                    .push(ScriptEvent::Type(t.parse()?, s.to_string()));
            }
            "--click" => {
                // --click X,Y@TICK
                let v = val("--click")?;
                let (xy, t) = v
                    .rsplit_once('@')
                    .ok_or_else(|| anyhow!("--click X,Y@TICK"))?;
                let (x, y) = xy
                    .split_once(',')
                    .ok_or_else(|| anyhow!("--click X,Y@TICK"))?;
                args.script
                    .push(ScriptEvent::Click(t.parse()?, x.parse()?, y.parse()?));
            }
            "--quit-after" => args.quit_after_ticks = Some(val("--quit-after")?.parse()?),
            "--announce-ready" => args.announce_ready = true,
            "--press" => {
                // --press NAME@TICK (console button script: up/down/left/
                // right/cross/circle/square/triangle/l/r/start/select)
                let v = val("--press")?;
                let (name, t) = v
                    .rsplit_once('@')
                    .ok_or_else(|| anyhow!("--press NAME@TICK"))?;
                let bit =
                    button_for(name).ok_or_else(|| anyhow!("--press: unknown button {name}"))?;
                args.script.push(ScriptEvent::Press(t.parse()?, bit));
            }
            "--storm" => {
                // --storm CPS@START+DUR (ticks)
                let v = val("--storm")?;
                let (cps, rest) = v
                    .split_once('@')
                    .ok_or_else(|| anyhow!("--storm CPS@START+DUR"))?;
                let (start, dur) = rest
                    .split_once('+')
                    .ok_or_else(|| anyhow!("--storm CPS@START+DUR"))?;
                args.storm = Some((cps.parse()?, start.parse()?, dur.parse()?));
            }
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
        .join("../../dist")
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
        "no {ext} for app '{app}' in {} — build it first: bun run macos {app}",
        dist.display()
    ))
}

/// Register the repo's Inter faces so native text shapes the same family the
/// portable backend bakes (system fallback covers everything else).
fn register_fonts(cx: &App) {
    let fonts_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets/fonts");
    let mut faces = Vec::new();
    for name in [
        "Inter-Regular.ttf",
        "Inter-Bold.ttf",
        "JetBrainsMono-Regular.ttf",
    ] {
        if let Ok(bytes) = std::fs::read(fonts_dir.join(name)) {
            faces.push(std::borrow::Cow::Owned(bytes));
        }
    }
    if !faces.is_empty()
        && let Err(e) = cx.text_system().add_fonts(faces)
    {
        log::warn!("pocket-macos: font registration failed: {e}");
    }
}

// ---------------------------------------------------------------------------
// the root view
// ---------------------------------------------------------------------------

struct PocketRoot {
    surface: UiSurface,
    guest: Guest,
    renderer: Rc<RefCell<GpuiRenderer>>,
    focus: FocusHandle,
    args: Args,

    booted: bool,
    exit: bool,
    ticks: u64,
    frames: Rc<Cell<u64>>,
    hash: u64,
    /// Live logical viewport (dynamic apps); pump applies render's readback.
    viewport: (u32, u32),
    pending_viewport: Option<(u32, u32)>,
    /// Letterbox origin for fixed apps (canvas centers the locked viewport).
    canvas_origin: Rc<Cell<Point<Pixels>>>,

    // console input
    buttons: u32,
    /// Buttons currently held by the --press script.
    script_buttons: u32,
    // editor input
    mouse_down: bool,
    click_edge: bool,
    last_mouse: Option<(f32, f32, bool)>,
    caret_rect: Option<(f32, f32, f32, f32)>,
    /// IME composition: preedit string (the guest mirrors it at the caret).
    marked: Option<String>,
    script: Vec<ScriptEvent>,
}

impl PocketRoot {
    fn boot(args: Args, window: &mut Window, cx: &mut Context<Self>) -> Result<Self> {
        let js_path = resolve_asset(args.js.clone(), &args.app, "js")?;
        let pak_path = resolve_asset(args.pak.clone(), &args.app, "pak")?;
        let bundle = std::fs::read_to_string(&js_path)
            .with_context(|| format!("reading {}", js_path.display()))?;
        let pak =
            std::fs::read(&pak_path).with_context(|| format!("reading {}", pak_path.display()))?;

        let surface = UiSurface::new_with_density(
            (args.viewport.0 as f32, args.viewport.1 as f32),
            args.density,
        );
        surface.set_identity(HOST_ID, HOST_ABI);
        // svcOpen denies by default (pocket-ui-surface); the adapter being
        // on is the one companion this host declares.
        if args.editor {
            surface.set_svc_allowlist(["note"]);
        }
        surface.feed_pak(&pak);
        let cfg = TextConfig::new("Inter");
        if args.native_text {
            // BEFORE mount: measurement feeds layout, and the guest must
            // never observe a provider swap (engine/core/src/lib.rs).
            surface.set_text_measure(native_measure(window.text_system().clone(), cfg.clone()));
        }
        let guest = Guest::new()?;
        surface.mount(&guest)?;
        guest.eval(&args.app, &bundle)?;
        if !guest.has_frame() {
            return Err(anyhow!(
                "bundle evaluated but installed no frame() — is this a PocketJS app?"
            ));
        }
        log::info!(
            "pocket-macos: booted {} ({} bytes js, {} bytes pak), native_text={}",
            args.app,
            bundle.len(),
            pak.len(),
            args.native_text
        );

        let renderer = Rc::new(RefCell::new(GpuiRenderer::new(cfg, args.density)));
        let focus = cx.focus_handle();
        let viewport = args.viewport;
        let script = args.script.clone();
        let root = PocketRoot {
            surface,
            guest,
            renderer,
            focus,
            args,
            booted: false,
            exit: false,
            ticks: 0,
            frames: Rc::new(Cell::new(0)),
            hash: 0,
            viewport,
            pending_viewport: None,
            canvas_origin: Rc::new(Cell::new(point(px(0.0), px(0.0)))),
            buttons: 0,
            script_buttons: 0,
            mouse_down: false,
            click_edge: false,
            last_mouse: None,
            caret_rect: None,
            marked: None,
            script,
        };
        root.spawn_tick_loop(cx);
        Ok(root)
    }

    /// The fixed-step governor: absolute deadlines, bounded catch-up, and a
    /// resync that DROPS missed ticks rather than replaying them (liveness,
    /// not history — pocket-widget/src/shell.rs's contract).
    fn spawn_tick_loop(&self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let dt = Duration::from_secs_f64(1.0 / TICK_HZ);
            let mut next = Instant::now() + dt;
            loop {
                let now = Instant::now();
                if next > now {
                    cx.background_executor().timer(next - now).await;
                }
                let mut ran = 0u32;
                let mut done = false;
                while Instant::now() >= next && ran < MAX_CATCHUP_TICKS {
                    next += dt;
                    ran += 1;
                    match this.update(cx, |root, cx| {
                        root.pump(cx);
                        root.exit
                    }) {
                        Ok(false) => {}
                        _ => {
                            done = true;
                            break;
                        }
                    }
                }
                if done {
                    let _ = cx.update(|cx| cx.quit());
                    return;
                }
                if Instant::now() >= next {
                    next = Instant::now() + dt; // resync: drop the backlog
                }
            }
        })
        .detach();
    }

    fn svc(&self, value: serde_json::Value) {
        self.surface.svc_push(value.to_string());
    }

    /// The svc hello: viewport first, then the document (order matters — the
    /// app lays text out against the viewport it was just told about).
    fn send_hello(&mut self) {
        self.svc(serde_json::json!({"t": "hello", "w": self.viewport.0, "h": self.viewport.1}));
        if let Some(file) = &self.args.file {
            let text = std::fs::read_to_string(file).unwrap_or_default();
            if !text.is_empty() {
                self.svc(serde_json::json!({"t": "load", "text": text}));
            }
        }
    }

    fn save(&self, text: &str) {
        let Some(file) = &self.args.file else { return };
        let tmp = file.with_extension("md.tmp");
        let write = std::fs::write(&tmp, text).and_then(|()| std::fs::rename(&tmp, file));
        match write {
            Ok(()) => log::info!("pocket-macos: saved {} bytes", text.len()),
            Err(e) => log::warn!("pocket-macos: save failed: {e}"),
        }
    }

    fn run_script(&mut self) {
        let tick = self.ticks;
        for ev in self.script.clone() {
            match ev {
                ScriptEvent::Type(t, s) if t == tick => {
                    self.svc(serde_json::json!({"t": "ch", "s": s}))
                }
                ScriptEvent::Click(t, x, y) if t == tick => {
                    self.svc(serde_json::json!({"t": "mouse", "x": x, "y": y, "d": true}));
                    self.svc(serde_json::json!({"t": "mouse", "x": x, "y": y, "d": false}));
                    self.click_edge = true;
                }
                // Held for 6 ticks so edge-detected button handlers latch.
                ScriptEvent::Press(t, bit) if tick >= t && tick < t + 6 => {
                    self.script_buttons |= bit;
                }
                ScriptEvent::Press(t, bit) if tick == t + 6 => {
                    self.script_buttons &= !bit;
                }
                _ => {}
            }
        }
    }

    /// One virtual-clock transaction (Law 3: exactly one guest turn + one
    /// core tick), then demand-render arming off the DrawList content hash.
    fn pump(&mut self, cx: &mut Context<Self>) {
        if self.exit {
            return;
        }
        if !self.booted {
            self.booted = true;
            if self.args.editor {
                self.send_hello();
            }
        }
        // Window resizes land here (render records them), so the relayout is
        // part of the tick transaction, never of a paint.
        if let Some(vp) = self.pending_viewport.take()
            && vp != self.viewport
            && !self.args.fixed
        {
            self.viewport = vp;
            self.surface
                .with_ui(|ui| ui.set_viewport(vp.0 as f32, vp.1 as f32));
            // display.viewport.live is a HOST capability, not an editor
            // protocol: every dynamic app gets the framework's live-
            // viewport hook (framework/src/host.ts installResizeViewport-
            // Hook), inside the tick transaction. The note's svc resize
            // line is its companion dialect on top; its own
            // resizeViewport call is idempotent against this one.
            if let Err(e) = self.guest.eval(
                    "resize-hook",
                    &format!(
                        "globalThis.__pocketResizeViewport && globalThis.__pocketResizeViewport({}, {});",
                        vp.0, vp.1
                    ),
                ) {
                    log::warn!("pocket-macos: resize hook failed: {e}");
                }
            if self.args.editor {
                self.svc(serde_json::json!({"t": "resize", "w": vp.0, "h": vp.1}));
            }
        }
        if !self.script.is_empty() {
            self.run_script();
        }
        if let Some((cps, start, dur)) = self.args.storm
            && self.ticks >= start
            && self.ticks < start + dur
        {
            // Whole chars this tick, error-free over time (i*cps/60).
            let i = self.ticks - start;
            let n = ((i + 1) * cps as u64) / 60 - (i * cps as u64) / 60;
            if n > 0 {
                const STORM: &[u8] = b"the quick brown fox jumps over the lazy dog ";
                let s: String = (0..n)
                    .map(|k| STORM[((i * 8 + k) % STORM.len() as u64) as usize] as char)
                    .collect();
                self.svc(serde_json::json!({"t": "ch", "s": s}));
            }
        }
        let buttons = if self.args.editor {
            // Clicks are CIRCLE — hover already focused what's under the
            // pointer (note-widget's contract).
            if self.mouse_down || self.click_edge {
                BTN_CIRCLE
            } else {
                0
            }
        } else {
            self.buttons
        };
        self.click_edge = false;
        if let Err(e) = self.guest.frame(buttons) {
            log::error!("pocket-macos: guest frame error: {e}");
            self.exit = true;
            return;
        }
        self.surface.tick();

        // Guest → host intents (editor protocol).
        for line in self.surface.svc_drain() {
            match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(v) => match v["t"].as_str() {
                    Some("save") => self.save(v["text"].as_str().unwrap_or_default()),
                    Some("quit") => self.exit = true,
                    Some("menu") => {}
                    Some("copy") => {
                        cx.write_to_clipboard(ClipboardItem::new_string(
                            v["text"].as_str().unwrap_or_default().to_string(),
                        ));
                    }
                    Some("caret") => {
                        self.caret_rect = Some((
                            v["x"].as_f64().unwrap_or(0.0) as f32,
                            v["y"].as_f64().unwrap_or(0.0) as f32,
                            1.0,
                            v["h"].as_f64().unwrap_or(20.0) as f32,
                        ));
                    }
                    other => log::warn!("pocket-macos: unknown intent {other:?}"),
                },
                Err(e) => log::warn!("pocket-macos: bad svc line from guest: {e}"),
            }
        }

        // Tick before draw; arm a paint only when the content hash moved
        // (TEXT_RUN packs its run bytes into the words — the whole truth).
        let hash = self.surface.with_ui(|ui| fnv1a64(&ui.draw().words));
        if hash != self.hash {
            self.hash = hash;
            cx.notify();
        }

        self.ticks += 1;
        if let Some(limit) = self.args.quit_after_ticks
            && self.ticks >= limit
        {
            self.exit = true;
        }
        if self.exit {
            println!(
                "pocket-macos: {} ticks, {} frames rendered ({:.1}%)",
                self.ticks,
                self.frames.get(),
                self.frames.get() as f64 / self.ticks.max(1) as f64 * 100.0
            );
        }
    }

    // ---- editor input → svc lines ------------------------------------------

    fn on_key_down(&mut self, e: &KeyDownEvent, _w: &mut Window, cx: &mut Context<Self>) {
        let ks = &e.keystroke;
        if self.args.editor {
            let shift = ks.modifiers.shift;
            if ks.modifiers.platform {
                match ks.key.as_str() {
                    "q" | "w" => self.exit = true,
                    "z" => self.svc(
                        serde_json::json!({"t": "key", "k": if shift { "Redo" } else { "Undo" }}),
                    ),
                    "c" => self.svc(serde_json::json!({"t": "key", "k": "Copy"})),
                    "x" => self.svc(serde_json::json!({"t": "key", "k": "Cut"})),
                    "v" => {
                        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text())
                            && !text.is_empty()
                        {
                            self.svc(serde_json::json!({"t": "paste", "text": text}));
                        }
                    }
                    _ => {}
                }
                return;
            }
            let named = match ks.key.as_str() {
                "backspace" => Some("Backspace"),
                "delete" => Some("Delete"),
                "enter" => Some("Enter"),
                "tab" => Some("Tab"),
                "left" => Some("Left"),
                "right" => Some("Right"),
                "up" => Some("Up"),
                "down" => Some("Down"),
                "home" => Some("Home"),
                "end" => Some("End"),
                "pageup" => Some("PageUp"),
                "pagedown" => Some("PageDown"),
                "escape" => Some("Escape"),
                _ => None,
            };
            if let Some(k) = named {
                self.svc(serde_json::json!({"t": "key", "k": k, "sh": shift}));
            } else if self.marked.is_none() {
                // Plain typing (IME composition delivers through the input
                // handler instead — no double-input path).
                if let Some(s) = &ks.key_char
                    && !s.is_empty()
                {
                    self.svc(serde_json::json!({"t": "ch", "s": s}));
                }
            }
        } else {
            if ks.modifiers.platform && (ks.key == "q" || ks.key == "w") {
                self.exit = true;
                return;
            }
            if let Some(bit) = button_for(&ks.key) {
                self.buttons |= bit;
            }
        }
    }

    fn on_key_up(&mut self, e: &KeyUpEvent, _w: &mut Window, _cx: &mut Context<Self>) {
        if !self.args.editor
            && let Some(bit) = button_for(&e.keystroke.key)
        {
            self.buttons &= !bit;
        }
    }

    fn logical_pos(&self, position: Point<Pixels>) -> (f32, f32) {
        let origin = self.canvas_origin.get();
        (
            f32::from(position.x) - f32::from(origin.x),
            f32::from(position.y) - f32::from(origin.y),
        )
    }

    fn push_mouse(&mut self, x: f32, y: f32, down: bool, shift: bool) {
        let m = (x, y, down);
        if self.last_mouse != Some(m) {
            self.last_mouse = Some(m);
            self.svc(serde_json::json!({"t": "mouse", "x": x, "y": y, "d": down, "sh": shift}));
        }
    }

    fn on_mouse_down(&mut self, e: &MouseDownEvent, w: &mut Window, _cx: &mut Context<Self>) {
        self.focus.focus(w);
        if e.button != MouseButton::Left {
            return;
        }
        self.mouse_down = true;
        self.click_edge = true;
        if self.args.editor {
            let (x, y) = self.logical_pos(e.position);
            self.push_mouse(x, y, true, e.modifiers.shift);
        }
    }

    fn on_mouse_up(&mut self, e: &MouseUpEvent, _w: &mut Window, _cx: &mut Context<Self>) {
        if e.button != MouseButton::Left {
            return;
        }
        self.mouse_down = false;
        if self.args.editor {
            let (x, y) = self.logical_pos(e.position);
            self.push_mouse(x, y, false, e.modifiers.shift);
        }
    }

    fn on_mouse_move(&mut self, e: &MouseMoveEvent, _w: &mut Window, _cx: &mut Context<Self>) {
        if self.args.editor {
            let (x, y) = self.logical_pos(e.position);
            self.push_mouse(x, y, self.mouse_down, e.modifiers.shift);
        }
    }

    fn on_scroll(&mut self, e: &ScrollWheelEvent, w: &mut Window, _cx: &mut Context<Self>) {
        if self.args.editor {
            let dy = f32::from(e.delta.pixel_delta(w.line_height()).y);
            if dy != 0.0 {
                self.svc(serde_json::json!({"t": "scroll", "dy": dy}));
            }
        }
    }
}

fn button_for(key: &str) -> Option<u32> {
    Some(match key {
        "up" => BTN_UP,
        "down" => BTN_DOWN,
        "left" => BTN_LEFT,
        "right" => BTN_RIGHT,
        "z" | "enter" => BTN_CROSS,
        "x" | "backspace" => BTN_CIRCLE,
        "a" => BTN_SQUARE,
        "s" => BTN_TRIANGLE,
        "q" | "l" => BTN_LTRIGGER,
        "w" | "r" => BTN_RTRIGGER,
        "tab" => BTN_SELECT,
        "space" => BTN_START,
        _ => return None,
    })
}

fn epoch_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

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
// IME (EntityInputHandler): composition forwards over svc exactly like
// note-widget's winit path — preedit as {t:"ime"}, commits as {t:"ch"},
// candidate window docked at the guest-reported caret rect.
// ---------------------------------------------------------------------------

impl EntityInputHandler for PocketRoot {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        _adjusted: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let marked = self.marked.as_ref()?;
        let chars: Vec<u16> = marked.encode_utf16().collect();
        let slice = chars.get(range)?;
        Some(String::from_utf16_lossy(slice))
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let len = self.marked.as_ref().map_or(0, |s| s.encode_utf16().count());
        Some(UTF16Selection {
            range: len..len,
            reversed: false,
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        self.marked.as_ref().map(|s| 0..s.encode_utf16().count())
    }

    fn unmark_text(&mut self, _window: &mut Window, _cx: &mut Context<Self>) {
        if self.marked.take().is_some() {
            self.svc(serde_json::json!({"t": "ime", "s": "", "c": null}));
        }
    }

    fn replace_text_in_range(
        &mut self,
        _range: Option<Range<usize>>,
        text: &str,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) {
        // A commit ends the composition; the text lands as plain typing.
        if self.marked.take().is_some() {
            self.svc(serde_json::json!({"t": "ime", "s": "", "c": null}));
        }
        if !text.is_empty() {
            self.svc(serde_json::json!({"t": "ch", "s": text}));
        }
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _range: Option<Range<usize>>,
        new_text: &str,
        new_selected_range: Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) {
        let caret_utf16 =
            new_selected_range.map_or_else(|| new_text.encode_utf16().count(), |r| r.start);
        // The guest protocol wants a CHAR index into the preedit.
        let mut chars = 0usize;
        let mut u16s = 0usize;
        for ch in new_text.chars() {
            if u16s >= caret_utf16 {
                break;
            }
            u16s += ch.len_utf16();
            chars += 1;
        }
        self.marked = Some(new_text.to_string());
        self.svc(serde_json::json!({"t": "ime", "s": new_text, "c": chars}));
    }

    fn bounds_for_range(
        &mut self,
        _range: Range<usize>,
        element_bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let (x, y, w, h) = self.caret_rect?;
        Some(Bounds::new(
            point(
                element_bounds.origin.x + px(x),
                element_bounds.origin.y + px(y),
            ),
            size(px(w), px(h)),
        ))
    }

    fn character_index_for_point(
        &mut self,
        _point: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
}

impl Focusable for PocketRoot {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for PocketRoot {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Live resize readback: applied by the NEXT pump (tick transaction),
        // never here — rendering stays a pure function of the DrawList.
        let vs = window.viewport_size();
        let vp = (
            (f32::from(vs.width).round() as u32).max(1),
            (f32::from(vs.height).round() as u32).max(1),
        );
        if !self.args.fixed && vp != self.viewport {
            self.pending_viewport = Some(vp);
        }

        let surface = self.surface.clone();
        let renderer = self.renderer.clone();
        let frames = self.frames.clone();
        let announce_ready = self.args.announce_ready;
        let canvas_origin = self.canvas_origin.clone();
        let fixed = self
            .args
            .fixed
            .then_some((self.args.viewport.0 as f32, self.args.viewport.1 as f32));
        let entity: Entity<PocketRoot> = cx.entity();
        let focus = self.focus.clone();
        let ime = self.args.editor;

        div()
            .size_full()
            .bg(gpui::black())
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key_down))
            .on_key_up(cx.listener(Self::on_key_up))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_scroll_wheel(cx.listener(Self::on_scroll))
            .child(
                canvas(
                    |bounds, _window, _cx| bounds,
                    move |bounds, _state, window, cx| {
                        // Fixed apps: center the size-locked viewport.
                        let origin = match fixed {
                            Some((lw, lh)) => point(
                                bounds.origin.x
                                    + px(((f32::from(bounds.size.width) - lw) / 2.0).max(0.0)),
                                bounds.origin.y
                                    + px(((f32::from(bounds.size.height) - lh) / 2.0).max(0.0)),
                            ),
                            None => bounds.origin,
                        };
                        canvas_origin.set(origin);
                        if ime {
                            window.handle_input(
                                &focus,
                                gpui::ElementInputHandler::new(bounds, entity.clone()),
                                cx,
                            );
                        }
                        frames.set(frames.get() + 1);
                        if announce_ready && frames.get() == 1 {
                            // First painted frame — the benchmark runner's
                            // cold-start marker (--announce-ready; PR #294).
                            println!("READY {}", epoch_ms());
                        }
                        surface.with_ui(|ui| {
                            renderer.borrow_mut().paint(ui, origin, window, cx);
                        });
                    },
                )
                .size_full(),
            )
    }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args = parse_args()?;
    let title: SharedString = SharedString::from(args.title.clone());
    let logical = (args.viewport.0 as f32, args.viewport.1 as f32);
    let resizable = !args.fixed;
    *ARGS.lock().unwrap() = Some(args);

    Application::new().run(move |cx: &mut App| {
        register_fonts(cx);
        let bounds = Bounds::centered(None, size(px(logical.0), px(logical.1)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some(title.clone()),
                ..Default::default()
            }),
            is_resizable: resizable,
            window_min_size: Some(size(px(240.0), px(180.0))),
            app_id: Some("dev.pocket-stack.macos".into()),
            ..Default::default()
        };
        let args = ARGS
            .lock()
            .unwrap()
            .take()
            .expect("args stashed before run");
        let window = cx.open_window(options, |window, cx| {
            cx.new(|cx| match PocketRoot::boot(args, window, cx) {
                Ok(root) => root,
                Err(e) => {
                    eprintln!("pocket-macos: {e:#}");
                    std::process::exit(1);
                }
            })
        });
        match window {
            Ok(handle) => {
                let _ = handle.update(cx, |root, window, _cx| {
                    window.focus(&root.focus);
                });
                cx.activate(true);
            }
            Err(e) => {
                eprintln!("pocket-macos: open_window failed: {e:#}");
                std::process::exit(1);
            }
        }
    });
    Ok(())
}

/// Application::run wants a 'static closure; stash the parsed args for it.
static ARGS: std::sync::Mutex<Option<Args>> = std::sync::Mutex::new(None);
