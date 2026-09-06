//! pocket-desktop-host — the PocketJS UI runtime in a native gpui window.
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
//! - System UI shell — the `system-ui` companion adapter: the same
//!   input-line dialect as the editor, extended with right-button mouse
//!   lines (b:2), alt/ctl key modifiers, F1–F12, platform-command chords
//!   (except command-Q = host quit and command-V = host-side paste), a boot epoch in the
//!   hello (for the guest's wall clock), a {t:"cursor"} guest intent that
//!   sets the window's pointer shape, and a {t:"paste-req"} guest intent
//!   answered with a paste line (menu-driven Paste). Wired when the plan's
//!   companion id is product-neutral; the note dialect stays byte-compatible
//!   (extra fields ignored). A resolved Pocket System may also bind installed
//!   packages as compositor surfaces. AppSupervisor owns every independent
//!   AppInstance and schedules them on this one process/thread.

use std::cell::{Cell, RefCell};
use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, anyhow};
use gpui::{
    App, AppContext as _, Application, Bounds, ClipboardItem, ContentMask, Context, CursorStyle,
    Entity, EntityInputHandler, FocusHandle, Focusable, InteractiveElement, IntoElement,
    KeyDownEvent, KeyUpEvent, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    ParentElement, Pixels, Point, Render, ScrollWheelEvent, SharedString, Styled, TitlebarOptions,
    UTF16Selection, Window, WindowBounds, WindowOptions, WindowTextSystem, canvas, div, point, px,
    size,
};
mod net;

use pocket_mod::Guest;
use pocket_ui_gpui::{GpuiRenderer, TextConfig, native_measure, native_wrap};
use pocket_ui_surface::UiSurface;
use serde::Deserialize;

#[cfg(target_os = "macos")]
const HOST_ID: &str = "macos-app";
#[cfg(target_os = "linux")]
const HOST_ID: &str = "linux-app";
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
compile_error!("pocket-desktop-host supports macOS and Linux");
const HOST_ABI: u32 = 4;
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
    /// Raw pointer line at a tick: kind 'd' presses, 'u' releases, 'm' moves
    /// with the current scripted button state (drag scripting).
    Mouse(u64, f32, f32, char),
    /// Named key with optional cmd+/alt+/ctl+/sh+ prefixes (svc `key` line).
    Key(u64, String, bool, bool, bool, bool),
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // serde requires the complete package plan; not every field is consumed yet.
struct ResolvedAppPlan {
    id: String,
    output: String,
    title: String,
    version: String,
    entry: String,
    framework: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedTargetPlan {
    id: String,
    host_abi: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct ResolvedViewportPlan {
    logical: [u32; 2],
    physical: [u32; 2],
    presentation: String,
    raster_density: u32,
    policy: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedPackagePlan {
    app: ResolvedAppPlan,
    target: ResolvedTargetPlan,
    viewport: ResolvedViewportPlan,
    features: HashMap<String, bool>,
    companions: Vec<String>,
    plan_hash: String,
}

#[derive(Clone, Debug, Deserialize)]
#[allow(dead_code)]
struct SystemIdentity {
    id: String,
    name: String,
    title: String,
    version: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct SystemPackagePlan {
    package: String,
    source: String,
    required: bool,
    plan: ResolvedPackagePlan,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemInstallationPlan {
    installed_packages: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemRolesPlan {
    #[serde(rename = "systemUI")]
    system_ui: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemLifecyclePlan {
    background_execution: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedSystemPlan {
    system: SystemIdentity,
    target: ResolvedTargetPlan,
    roles: SystemRolesPlan,
    lifecycle: SystemLifecyclePlan,
    #[allow(dead_code)]
    // The System owns installation state; AppSupervisor only runs its snapshot.
    installation: SystemInstallationPlan,
    #[serde(rename = "systemUI")]
    system_ui: SystemPackagePlan,
    applications: Vec<SystemPackagePlan>,
    #[allow(dead_code)]
    plan_hash: String,
}

impl ResolvedSystemPlan {
    fn validate_for_host(&self) -> Result<&SystemPackagePlan> {
        if self.target.id != HOST_ID || self.target.host_abi != HOST_ABI {
            return Err(anyhow!(
                "Pocket System targets {} ABI {}, host is {} ABI {}",
                self.target.id,
                self.target.host_abi,
                HOST_ID,
                HOST_ABI
            ));
        }
        if self.roles.system_ui != self.system_ui.package {
            return Err(anyhow!(
                "SystemUI role names {}, resolved package is {}",
                self.roles.system_ui,
                self.system_ui.package
            ));
        }
        let mut packages = HashSet::new();
        let mut outputs = HashSet::new();
        for package in std::iter::once(&self.system_ui).chain(self.applications.iter()) {
            if !packages.insert(package.package.clone()) {
                return Err(anyhow!("duplicate System package {}", package.package));
            }
            if !outputs.insert(package.plan.app.output.clone()) {
                return Err(anyhow!(
                    "duplicate System artifact output {}",
                    package.plan.app.output
                ));
            }
            if package.plan.app.id != package.package {
                return Err(anyhow!(
                    "package {} carries plan for {}",
                    package.package,
                    package.plan.app.id
                ));
            }
            if package.plan.target.id != self.target.id
                || package.plan.target.host_abi != self.target.host_abi
            {
                return Err(anyhow!(
                    "package {} resolved for {} ABI {}, not Pocket System target",
                    package.package,
                    package.plan.target.id,
                    package.plan.target.host_abi
                ));
            }
        }
        let installed: HashSet<String> = self
            .installation
            .installed_packages
            .iter()
            .cloned()
            .collect();
        if installed != packages {
            return Err(anyhow!(
                "resolved packages do not match the System installation snapshot"
            ));
        }
        if !self.system_ui.required {
            return Err(anyhow!("SystemUI package must be required"));
        }
        if self.system_ui.plan.features.get("ui.compositor-surfaces") != Some(&true) {
            return Err(anyhow!("SystemUI plan lacks ui.compositor-surfaces"));
        }
        for application in &self.applications {
            if !application.plan.companions.is_empty() {
                return Err(anyhow!(
                    "AppInstance {} declares unsupported companions",
                    application.package
                ));
            }
            if application.plan.features.get("ui.compositor-surfaces") == Some(&true) {
                return Err(anyhow!(
                    "AppInstance {} cannot host compositor surfaces",
                    application.package
                ));
            }
        }
        Ok(&self.system_ui)
    }
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
    /// Companion service names from the plan (svcOpen allowlist).
    companions: Vec<String>,
    /// Complete Pocket System resolution. None runs one ordinary package.
    system: Option<ResolvedSystemPlan>,
    /// `host:port` of a companion that speaks the SVC WIRE (PKNT) protocol.
    /// Set by a companion that opens this window itself.
    svc_connect: Option<String>,
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
        companions: Vec::new(),
        system: None,
        svc_connect: None,
        density: 2,
        script: Vec::new(),
        quit_after_ticks: None,
        storm: None,
        announce_ready: false,
    };
    let mut system_plan_path = None;
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
            "--companions" => {
                args.companions = val("--companions")?
                    .split(',')
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect();
            }
            "--system-plan" => {
                system_plan_path = Some(PathBuf::from(val("--system-plan")?));
            }
            "--svc-connect" => args.svc_connect = Some(val("--svc-connect")?),
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
            "--mouse" => {
                // --mouse X,Y[,d|u|r]@TICK — scripted pointer line (m = move,
                // r = right press+release).
                let v = val("--mouse")?;
                let (spec, t) = v
                    .rsplit_once('@')
                    .ok_or_else(|| anyhow!("--mouse X,Y[,d|u]@TICK"))?;
                let parts: Vec<&str> = spec.split(',').collect();
                if parts.len() < 2 || parts.len() > 3 {
                    return Err(anyhow!("--mouse X,Y[,d|u]@TICK"));
                }
                let kind = parts
                    .get(2)
                    .map_or('m', |s| s.chars().next().unwrap_or('m'));
                args.script.push(ScriptEvent::Mouse(
                    t.parse()?,
                    parts[0].parse()?,
                    parts[1].parse()?,
                    kind,
                ));
            }
            "--key" => {
                // --key [cmd+][alt+][ctl+][sh+]NAME@TICK — scripted svc key line.
                let v = val("--key")?;
                let (mut name, t) = v
                    .rsplit_once('@')
                    .ok_or_else(|| anyhow!("--key NAME@TICK"))?;
                let (mut cmd, mut alt, mut ctl, mut sh) = (false, false, false, false);
                loop {
                    if let Some(rest) = name.strip_prefix("cmd+") {
                        cmd = true;
                        name = rest;
                    } else if let Some(rest) = name.strip_prefix("alt+") {
                        alt = true;
                        name = rest;
                    } else if let Some(rest) = name.strip_prefix("ctl+") {
                        ctl = true;
                        name = rest;
                    } else if let Some(rest) = name.strip_prefix("sh+") {
                        sh = true;
                        name = rest;
                    } else {
                        break;
                    }
                }
                args.script.push(ScriptEvent::Key(
                    t.parse()?,
                    name.to_string(),
                    cmd,
                    alt,
                    ctl,
                    sh,
                ));
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
    if let Some(path) = system_plan_path {
        let bytes = std::fs::read(&path)
            .with_context(|| format!("reading Pocket System plan {}", path.display()))?;
        let system: ResolvedSystemPlan = serde_json::from_slice(&bytes)
            .with_context(|| format!("decoding Pocket System plan {}", path.display()))?;
        let shell = system.validate_for_host()?;
        args.app = shell.plan.app.output.clone();
        args.title = system.system.title.clone();
        args.viewport = (
            shell.plan.viewport.logical[0],
            shell.plan.viewport.logical[1],
        );
        args.fixed = shell.plan.viewport.policy == "fixed";
        args.native_text = shell
            .plan
            .features
            .get("text.layout.native")
            .copied()
            .unwrap_or(false);
        args.companions = shell.plan.companions.clone();
        args.editor = args.companions.iter().any(|companion| companion == "note");
        args.density = shell.plan.viewport.raster_density.clamp(1, 4);
        // System package assets are selected only by their resolved outputs;
        // command-line bundle overrides cannot replace the System UI shell.
        args.js = None;
        args.pak = None;
        args.system = Some(system);
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
        "no {ext} for app '{app}' in {} — build its resolved package artifacts first",
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
        log::warn!("pocket-desktop-host: font registration failed: {e}");
    }
}

// ---------------------------------------------------------------------------
// Native AppSupervisor
// ---------------------------------------------------------------------------

struct AppCatalogEntry {
    package: SystemPackagePlan,
    /// Native compositor handle published to the shell as `ui.__surfaces`.
    surface_handle: u32,
}

struct AppInstance {
    package: SystemPackagePlan,
    surface_handle: u32,
    surface: UiSurface,
    guest: Guest,
    renderer: GpuiRenderer,
    buttons: u32,
    visible: bool,
    focused: bool,
    order: usize,
    state: AppInstanceState,
}

struct AppSupervisor {
    catalog: Vec<AppCatalogEntry>,
    instances: Vec<AppInstance>,
    suppressed: HashSet<u32>,
    background_execution: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AppInstanceState {
    Running,
    Suspended,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SchedulingFact {
    visible: bool,
    focused: bool,
    order: usize,
    state: AppInstanceState,
}

fn focused_app_instance(facts: &[SchedulingFact]) -> Option<usize> {
    facts
        .iter()
        .enumerate()
        .filter(|(_, fact)| fact.visible && fact.focused && fact.state == AppInstanceState::Running)
        .max_by_key(|(_, fact)| fact.order)
        .map(|(index, _)| index)
}

fn scheduled_app_instances(facts: &[SchedulingFact]) -> Vec<usize> {
    let mut schedule: Vec<usize> = facts
        .iter()
        .enumerate()
        .filter(|(_, fact)| fact.state == AppInstanceState::Running)
        .map(|(index, _)| index)
        .collect();
    schedule.sort_by_key(|index| {
        let fact = facts[*index];
        (!fact.focused, Reverse(fact.order))
    });
    schedule
}

impl AppSupervisor {
    fn new(system: Option<&ResolvedSystemPlan>, shell: &UiSurface) -> Result<Self> {
        let Some(system) = system else {
            return Ok(Self {
                catalog: Vec::new(),
                instances: Vec::new(),
                suppressed: HashSet::new(),
                background_execution: "suspend".into(),
            });
        };
        system.validate_for_host()?;
        if system.lifecycle.background_execution != "suspend"
            && system.lifecycle.background_execution != "continue"
        {
            return Err(anyhow!("unknown System backgroundExecution policy"));
        }
        let mut catalog = Vec::new();
        for package in &system.applications {
            let surface_handle = shell
                .register_compositor_surface(package.package.clone())
                .ok_or_else(|| anyhow!("reserving compositor surface for {}", package.package))?;
            catalog.push(AppCatalogEntry {
                package: package.clone(),
                surface_handle: surface_handle as u32,
            });
        }
        Ok(Self {
            catalog,
            instances: Vec::new(),
            suppressed: HashSet::new(),
            background_execution: system.lifecycle.background_execution.clone(),
        })
    }

    fn open(&mut self, surface_handle: u32, text_system: Arc<WindowTextSystem>) -> Result<bool> {
        if self
            .instances
            .iter()
            .any(|instance| instance.surface_handle == surface_handle)
        {
            return Ok(false);
        }
        let entry = self
            .catalog
            .iter()
            .find(|entry| entry.surface_handle == surface_handle)
            .ok_or_else(|| anyhow!("unknown compositor surface handle {surface_handle}"))?;
        let plan = &entry.package.plan;
        let output = &plan.app.output;
        let js_path = resolve_asset(None, output, "js")?;
        let pak_path = resolve_asset(None, output, "pak")?;
        let bundle = std::fs::read_to_string(&js_path)
            .with_context(|| format!("reading {}", js_path.display()))?;
        let pak =
            std::fs::read(&pak_path).with_context(|| format!("reading {}", pak_path.display()))?;

        let surface = UiSurface::new_with_density(
            (
                plan.viewport.logical[0] as f32,
                plan.viewport.logical[1] as f32,
            ),
            plan.viewport.raster_density,
        );
        surface.set_identity(&plan.target.id, plan.target.host_abi);
        surface.set_tick_rate(TICK_HZ as u32);
        let cfg = TextConfig::new("Inter");
        if plan
            .features
            .get("text.layout.native")
            .copied()
            .unwrap_or(false)
        {
            surface.set_text_measure(native_measure(text_system.clone(), cfg.clone()));
            surface.set_text_wrap(native_wrap(text_system, cfg.clone()));
        }
        surface.feed_pak(&pak);
        let guest = Guest::new()?;
        surface.mount(&guest)?;
        guest.eval(output, &bundle)?;
        if !guest.has_frame() {
            return Err(anyhow!("{output} evaluated but installed no frame()"));
        }

        self.instances.push(AppInstance {
            package: entry.package.clone(),
            surface_handle: entry.surface_handle,
            surface,
            guest,
            renderer: GpuiRenderer::new(cfg, plan.viewport.raster_density),
            buttons: 0,
            visible: false,
            focused: false,
            order: 0,
            state: AppInstanceState::Running,
        });
        log::info!(
            "pocket-desktop-host: started AppInstance {} ({}, {}x{}, plan={})",
            entry.package.package,
            plan.app.title,
            plan.viewport.logical[0],
            plan.viewport.logical[1],
            plan.plan_hash
        );
        Ok(true)
    }

    /// Reconcile AppInstance lifecycle and scheduling facts from the shell core.
    /// The companion protocol is not involved in this per-frame path.
    fn sync(
        &mut self,
        shell: &UiSurface,
        text_system: Arc<WindowTextSystem>,
    ) -> Vec<(String, String)> {
        let bindings = shell.with_ui(|ui| ui.compositor_surface_bindings());
        let frames = shell.with_ui(|ui| ui.compositor_surface_frames());
        let live: HashSet<u32> = bindings.iter().map(|(handle, _)| *handle).collect();

        let mut dropped = Vec::new();
        self.instances.retain(|instance| {
            let keep = live.contains(&instance.surface_handle);
            if !keep {
                dropped.push(instance.package.package.clone());
            }
            keep
        });
        for package in dropped {
            log::info!("pocket-desktop-host: removed AppInstance {package}");
        }
        self.suppressed.retain(|handle| live.contains(handle));

        let mut failures = Vec::new();
        for (handle, _) in &bindings {
            if self
                .instances
                .iter()
                .any(|instance| instance.surface_handle == *handle)
                || self.suppressed.contains(handle)
            {
                continue;
            }
            if let Err(error) = self.open(*handle, text_system.clone()) {
                let package = self
                    .catalog
                    .iter()
                    .find(|entry| entry.surface_handle == *handle)
                    .map_or_else(
                        || format!("surface:{handle}"),
                        |entry| entry.package.package.clone(),
                    );
                self.suppressed.insert(*handle);
                failures.push((package, error.to_string()));
            }
        }

        for instance in &mut self.instances {
            instance.visible = false;
            instance.focused = bindings
                .iter()
                .find(|(handle, _)| *handle == instance.surface_handle)
                .is_some_and(|(_, focused)| *focused);
            if !instance.focused {
                instance.buttons = 0;
            }
        }
        for frame in frames {
            if let Some(instance) = self
                .instances
                .iter_mut()
                .find(|instance| instance.surface_handle == frame.handle)
            {
                instance.visible = true;
                instance.focused = frame.focused;
                instance.order = frame.order;
                if !frame.focused {
                    instance.buttons = 0;
                }
            }
        }
        for instance in &mut self.instances {
            if !instance.visible {
                instance.focused = false;
            }
            if !instance.focused {
                instance.buttons = 0;
            }
            if instance.state != AppInstanceState::Failed {
                instance.state = if instance.visible || self.background_execution == "continue" {
                    AppInstanceState::Running
                } else {
                    AppInstanceState::Suspended
                };
            }
        }
        failures
    }

    /// Focus is a compositor fact. Route hardware-neutral buttons to the
    /// top focused visible surface and keep their held state across ticks.
    fn set_focused_button(&mut self, button: u32, down: bool) -> bool {
        let facts: Vec<SchedulingFact> = self
            .instances
            .iter()
            .map(|instance| SchedulingFact {
                visible: instance.visible,
                focused: instance.focused,
                order: instance.order,
                state: instance.state,
            })
            .collect();
        let Some(index) = focused_app_instance(&facts) else {
            return false;
        };
        let instance = &mut self.instances[index];
        if down {
            instance.buttons |= button;
        } else {
            instance.buttons &= !button;
        }
        true
    }

    /// Scheduling happens in the native compositor. The System lifecycle
    /// policy maps hidden instances to Running or Suspended; focused/top
    /// surfaces receive their turn first, then remaining running instances.
    fn tick(&mut self) -> Vec<(String, String)> {
        let mut failures = Vec::new();
        let facts: Vec<SchedulingFact> = self
            .instances
            .iter()
            .map(|instance| SchedulingFact {
                visible: instance.visible,
                focused: instance.focused,
                order: instance.order,
                state: instance.state,
            })
            .collect();
        let schedule = scheduled_app_instances(&facts);
        for index in schedule {
            let instance = &mut self.instances[index];
            if let Err(error) = instance.guest.frame(instance.buttons) {
                instance.state = AppInstanceState::Failed;
                failures.push((instance.package.package.clone(), error.to_string()));
                continue;
            }
            instance.surface.tick();
        }
        failures
    }

    fn visible_hash(&self) -> u64 {
        let mut hash = 0xcbf2_9ce4_8422_2325u64;
        for instance in &self.instances {
            if !instance.visible || instance.state == AppInstanceState::Failed {
                continue;
            }
            instance.surface.with_ui(|ui| {
                let draw_hash = fnv1a64(&ui.draw().words);
                let raster_revision = ui.raster_revision();
                mix_app_instance_repaint_hash(
                    &mut hash,
                    instance.surface_handle,
                    draw_hash,
                    raster_revision,
                );
            });
        }
        hash
    }

    fn paint(
        &mut self,
        surface_handle: u32,
        full: Bounds<Pixels>,
        clip: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) -> bool {
        let Some(instance) = self.instances.iter_mut().find(|instance| {
            instance.surface_handle == surface_handle && instance.state != AppInstanceState::Failed
        }) else {
            return false;
        };
        window.with_content_mask(Some(ContentMask { bounds: clip }), |window| {
            instance.surface.with_ui(|ui| {
                instance.renderer.paint(ui, full.origin, window, cx);
            });
        });
        true
    }
}

// ---------------------------------------------------------------------------
// the root view
// ---------------------------------------------------------------------------

struct PocketRoot {
    surface: UiSurface,
    guest: Guest,
    renderer: Rc<RefCell<GpuiRenderer>>,
    app_supervisor: Rc<RefCell<AppSupervisor>>,
    text_system: Arc<WindowTextSystem>,
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
    /// Primary-button state of the --mouse script.
    script_mouse: bool,
    // editor/System UI shell input
    /// The generic System UI companion is in the resolved package plan.
    system_ui_input: bool,
    /// Pointer shape requested by the guest ({t:"cursor"} intent).
    cursor_style: CursorStyle,
    mouse_down: bool,
    click_edge: bool,
    last_mouse: Option<(f32, f32, bool)>,
    caret_rect: Option<(f32, f32, f32, f32)>,
    /// IME composition: preedit string (the guest mirrors it at the caret).
    marked: Option<String>,
    script: Vec<ScriptEvent>,
    /// Companion channel over TCP (--svc-connect). When present it owns the
    /// svc queues: lines arrive from the socket and the guest's replies go
    /// back out, instead of the in-process editor dialect.
    wire: Option<net::SvcWire>,
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
        let identity = args
            .system
            .as_ref()
            .and_then(|system| system.validate_for_host().ok())
            .map(|shell| (&shell.plan.target.id, shell.plan.target.host_abi));
        surface.set_identity(
            identity.map_or(HOST_ID, |(target, _)| target.as_str()),
            identity.map_or(HOST_ABI, |(_, abi)| abi),
        );
        // svcOpen denies by default (pocket-ui-surface); the allowlist is
        // exactly the plan's companion list (the product launcher derives it,
        // issue #295) — never an app-name convention.
        if !args.companions.is_empty() {
            surface.set_svc_allowlist(args.companions.iter().map(String::as_str));
        }
        surface.feed_pak(&pak);
        // Installed package handles must be in ui.__surfaces before the shell
        // evaluates and resolves its CompositorSurface package bindings.
        let app_supervisor = Rc::new(RefCell::new(AppSupervisor::new(
            args.system.as_ref(),
            &surface,
        )?));
        let text_system = window.text_system().clone();
        let cfg = TextConfig::new("Inter");
        if args.native_text {
            // BEFORE mount: measurement feeds layout, and the guest must
            // never observe a provider swap (engine/core/src/lib.rs).
            surface.set_text_measure(native_measure(text_system.clone(), cfg.clone()));
            // The wrapText op's break positions then come from gpui's
            // LineWrapper through the SAME TextConfig — measurement, wrap
            // and paint stay one provider.
            surface.set_text_wrap(native_wrap(text_system.clone(), cfg.clone()));
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
            "pocket-desktop-host: booted {} ({} bytes js, {} bytes pak), native_text={}",
            args.app,
            bundle.len(),
            pak.len(),
            args.native_text
        );

        let renderer = Rc::new(RefCell::new(GpuiRenderer::new(cfg, args.density)));
        let focus = cx.focus_handle();
        let viewport = args.viewport;
        let script = args.script.clone();
        let system_ui_input = args.companions.iter().any(|c| c == "system-ui");
        // A companion reachable over TCP takes the svc channel: the app's
        // dialect is its own business, so the host only moves whole lines.
        let wire = args.svc_connect.clone().map(|addr| {
            let app = args
                .companions
                .first()
                .cloned()
                .unwrap_or_else(|| args.app.clone());
            net::SvcWire::spawn(addr, app)
        });
        let root = PocketRoot {
            surface,
            guest,
            renderer,
            app_supervisor,
            text_system,
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
            script_mouse: false,
            system_ui_input,
            cursor_style: CursorStyle::Arrow,
            mouse_down: false,
            click_edge: false,
            last_mouse: None,
            caret_rect: None,
            marked: None,
            script,
            wire,
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

    /// Input lines flow when either JSON-line dialect is wired.
    fn forward_input(&self) -> bool {
        // A window whose companion is reached over the wire forwards input
        // too: the app on the other end is the only thing that knows what a
        // keystroke means, and a window that can only watch is not much of a
        // window.
        self.args.editor || self.system_ui_input || self.wire.is_some()
    }

    /// The svc hello: viewport first, then the document (order matters — the
    /// app lays text out against the viewport it was just told about). The
    /// epoch anchors the System UI's wall clock; the note dialect
    /// ignores it.
    fn send_hello(&mut self) {
        log::debug!(
            "pocket-desktop-host: svc hello (system_ui={}, editor={})",
            self.system_ui_input,
            self.args.editor
        );
        self.svc(serde_json::json!({
            "t": "hello", "w": self.viewport.0, "h": self.viewport.1,
            "epoch": epoch_ms() as u64,
        }));
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
            Ok(()) => log::info!("pocket-desktop-host: saved {} bytes", text.len()),
            Err(e) => log::warn!("pocket-desktop-host: save failed: {e}"),
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
                ScriptEvent::Mouse(t, x, y, kind) if t == tick => {
                    if kind == 'r' {
                        // Right click: press + release in one tick (b:2 lines).
                        self.svc(serde_json::json!(
                            {"t": "mouse", "x": x, "y": y, "d": true, "b": 2, "sh": false}
                        ));
                        self.svc(serde_json::json!(
                            {"t": "mouse", "x": x, "y": y, "d": false, "b": 2, "sh": false}
                        ));
                    } else {
                        let down = match kind {
                            'd' => {
                                self.script_mouse = true;
                                true
                            }
                            'u' => {
                                self.script_mouse = false;
                                false
                            }
                            _ => self.script_mouse,
                        };
                        self.svc(serde_json::json!(
                            {"t": "mouse", "x": x, "y": y, "d": down, "sh": false}
                        ));
                    }
                }
                ScriptEvent::Key(t, ref k, cmd, alt, ctl, sh) if t == tick => {
                    self.svc(serde_json::json!(
                        {"t": "key", "k": k, "cmd": cmd, "sh": sh, "alt": alt, "ctl": ctl}
                    ));
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
            if self.forward_input() {
                self.send_hello();
            }
        }
        // Inbound companion lines BEFORE the guest frame that reads them.
        // Draining after it costs every arriving line a whole tick of
        // latency, which on a terminal is a whole tick between a keystroke
        // and its echo. This is the order hosts/3ds/src/main.c pumps in.
        if let Some(wire) = self.wire.as_mut() {
            for line in wire.drain() {
                self.surface.svc_push(line);
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
                    log::warn!("pocket-desktop-host: resize hook failed: {e}");
                }
            if self.forward_input() {
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
            self.buttons | self.script_buttons
        };
        self.click_edge = false;
        if let Err(e) = self.guest.frame(buttons) {
            log::error!("pocket-desktop-host: guest frame error: {e}");
            self.exit = true;
            return;
        }
        self.surface.tick();

        // Live surface bindings are the lifecycle boundary. The shell core
        // supplies focus, visibility, geometry and painter order directly to
        // AppSupervisor through the native compositor; no companion message
        // participates here.
        let sync_failures = self
            .app_supervisor
            .borrow_mut()
            .sync(&self.surface, self.text_system.clone());
        for (package, message) in sync_failures {
            log::error!("pocket-desktop-host: starting AppInstance {package}: {message}");
        }

        // The guest's replies go out in the same tick it wrote them. It
        // drains first, so the editor matcher below finds an empty queue and
        // the two dialects never see each other's lines.
        if let Some(wire) = self.wire.as_mut() {
            for line in self.surface.svc_drain() {
                wire.send(line);
            }
        }

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
                    Some("paste-req") => {
                        // The guest can't read the system clipboard; answer a
                        // menu-driven Paste with the dialect's paste line.
                        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text())
                            && !text.is_empty()
                        {
                            self.svc(serde_json::json!({"t": "paste", "text": text}));
                        }
                    }
                    Some("caret") => {
                        self.caret_rect = Some((
                            v["x"].as_f64().unwrap_or(0.0) as f32,
                            v["y"].as_f64().unwrap_or(0.0) as f32,
                            1.0,
                            v["h"].as_f64().unwrap_or(20.0) as f32,
                        ));
                    }
                    Some("cursor") => {
                        let style = cursor_for(v["k"].as_str().unwrap_or("default"));
                        if style != self.cursor_style {
                            self.cursor_style = style;
                            cx.notify();
                        }
                    }
                    other => log::warn!("pocket-desktop-host: unknown intent {other:?}"),
                },
                Err(e) => log::warn!("pocket-desktop-host: bad svc line from guest: {e}"),
            }
        }

        // AppInstances run after shell commands have been applied and before
        // the composite hash is sampled. One failure cannot terminate or
        // corrupt sibling instances.
        let failures = self.app_supervisor.borrow_mut().tick();
        for (package, message) in failures {
            log::error!("pocket-desktop-host: AppInstance {package} frame failed: {message}");
        }

        // Tick before draw; arm a paint only when the content hash moved
        // (TEXT_RUN packs its run bytes into the words — the whole truth).
        let shell_hash = self.surface.with_ui(|ui| fnv1a64(&ui.draw().words));
        let child_hash = self.app_supervisor.borrow().visible_hash();
        let hash = shell_hash ^ child_hash.rotate_left(17);
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
                "pocket-desktop-host: {} ticks, {} frames rendered ({:.1}%)",
                self.ticks,
                self.frames.get(),
                self.frames.get() as f64 / self.ticks.max(1) as f64 * 100.0
            );
        }
    }

    // ---- editor input → svc lines ------------------------------------------

    fn on_key_down(&mut self, e: &KeyDownEvent, _w: &mut Window, cx: &mut Context<Self>) {
        let ks = &e.keystroke;
        if !ks.modifiers.platform
            && !ks.modifiers.alt
            && !ks.modifiers.control
            && let Some(button) = button_for(&ks.key)
            && self
                .app_supervisor
                .borrow_mut()
                .set_focused_button(button, true)
        {
            cx.stop_propagation();
            return;
        }
        if self.forward_input() {
            let shift = ks.modifiers.shift;
            if ks.modifiers.platform {
                if self.system_ui_input {
                    // The System UI dialect reserves command-Q for the host and
                    // command-V pastes here (the guest can't read the clipboard);
                    // every other chord goes to the guest as a cmd-flagged
                    // key line — the compositor owns its own shortcuts
                    // (command-W close, command-M minimize, command-` cycle).
                    match ks.key.as_str() {
                        "q" => self.exit = true,
                        "v" => {
                            if let Some(text) =
                                cx.read_from_clipboard().and_then(|item| item.text())
                                && !text.is_empty()
                            {
                                self.svc(serde_json::json!({"t": "paste", "text": text}));
                            }
                        }
                        k => self.svc(serde_json::json!({
                            "t": "key", "k": k, "cmd": true, "sh": shift,
                            "alt": ks.modifiers.alt, "ctl": ks.modifiers.control,
                        })),
                    }
                    // Consumed: don't let the platform menu system hunt for
                    // an unavailable key equivalent.
                    cx.stop_propagation();
                    return;
                }
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
                // Desk-dialect chord keys (Alt+F4, Ctrl+Esc, Alt+Tab).
                "f1" => Some("F1"),
                "f2" => Some("F2"),
                "f3" => Some("F3"),
                "f4" => Some("F4"),
                "f5" => Some("F5"),
                "f6" => Some("F6"),
                "f7" => Some("F7"),
                "f8" => Some("F8"),
                "f9" => Some("F9"),
                "f10" => Some("F10"),
                "f11" => Some("F11"),
                "f12" => Some("F12"),
                _ => None,
            };
            if let Some(k) = named {
                self.svc(serde_json::json!({
                    "t": "key", "k": k, "sh": shift,
                    "alt": ks.modifiers.alt, "ctl": ks.modifiers.control,
                }));
            } else if (ks.modifiers.control || ks.modifiers.alt) && ks.key.chars().count() == 1 {
                // A control or option chord produces no text, so it never
                // reaches the input handler below and would simply be lost.
                // It is also the whole vocabulary of a terminal: ctrl-C,
                // ctrl-D, alt-B. Apps that do not use chords ignore the line.
                self.svc(serde_json::json!({
                    "t": "key", "k": ks.key, "sh": shift,
                    "alt": ks.modifiers.alt, "ctl": ks.modifiers.control,
                }));
            }
            // Plain typing is NOT emitted here. gpui hands the unhandled key
            // event to the input context after this listener, and insertText:
            // always reaches the registered input handler — so the character
            // arrives once through replace_text_in_range. Emitting key_char
            // here as well delivered every keypress twice.
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

    fn on_key_up(&mut self, e: &KeyUpEvent, _w: &mut Window, cx: &mut Context<Self>) {
        if let Some(button) = button_for(&e.keystroke.key)
            && self
                .app_supervisor
                .borrow_mut()
                .set_focused_button(button, false)
        {
            cx.stop_propagation();
            return;
        }
        if !self.forward_input()
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
        match e.button {
            MouseButton::Left => {
                self.mouse_down = true;
                self.click_edge = true;
                if self.forward_input() {
                    let (x, y) = self.logical_pos(e.position);
                    self.push_mouse(x, y, true, e.modifiers.shift);
                }
            }
            // Right button is System UI-only (b:2 lines would read as
            // primary presses to the note protocol).
            MouseButton::Right if self.system_ui_input => {
                let (x, y) = self.logical_pos(e.position);
                self.svc(serde_json::json!(
                    {"t": "mouse", "x": x, "y": y, "d": true, "b": 2, "sh": e.modifiers.shift}
                ));
            }
            _ => {}
        }
    }

    fn on_mouse_up(&mut self, e: &MouseUpEvent, _w: &mut Window, _cx: &mut Context<Self>) {
        match e.button {
            MouseButton::Left => {
                self.mouse_down = false;
                if self.forward_input() {
                    let (x, y) = self.logical_pos(e.position);
                    self.push_mouse(x, y, false, e.modifiers.shift);
                }
            }
            MouseButton::Right if self.system_ui_input => {
                let (x, y) = self.logical_pos(e.position);
                self.svc(serde_json::json!(
                    {"t": "mouse", "x": x, "y": y, "d": false, "b": 2, "sh": e.modifiers.shift}
                ));
            }
            _ => {}
        }
    }

    fn on_mouse_move(&mut self, e: &MouseMoveEvent, _w: &mut Window, _cx: &mut Context<Self>) {
        if self.forward_input() {
            let (x, y) = self.logical_pos(e.position);
            self.push_mouse(x, y, self.mouse_down, e.modifiers.shift);
        }
    }

    fn on_scroll(&mut self, e: &ScrollWheelEvent, w: &mut Window, _cx: &mut Context<Self>) {
        if self.forward_input() {
            let dy = f32::from(e.delta.pixel_delta(w.line_height()).y);
            if dy != 0.0 {
                self.svc(serde_json::json!({"t": "scroll", "dy": dy}));
            }
        }
    }
}

/// {t:"cursor"} intent → pointer shape. Keys mirror CSS cursor names the
/// The System UI dialect uses these names; unknown keys use the arrow.
fn cursor_for(k: &str) -> CursorStyle {
    match k {
        "text" => CursorStyle::IBeam,
        "pointer" => CursorStyle::PointingHand,
        "move" => CursorStyle::OpenHand,
        "grabbing" => CursorStyle::ClosedHand,
        "ew" => CursorStyle::ResizeLeftRight,
        "ns" => CursorStyle::ResizeUpDown,
        "nwse" => CursorStyle::ResizeUpLeftDownRight,
        "nesw" => CursorStyle::ResizeUpRightDownLeft,
        _ => CursorStyle::Arrow,
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

fn mix_app_instance_repaint_hash(
    hash: &mut u64,
    surface_handle: u32,
    draw_hash: u64,
    raster_revision: u64,
) {
    for byte in surface_handle
        .to_le_bytes()
        .into_iter()
        .chain(draw_hash.to_le_bytes())
        .chain(raster_revision.to_le_bytes())
    {
        *hash ^= byte as u64;
        *hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
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
        let app_supervisor = self.app_supervisor.clone();
        let frames = self.frames.clone();
        let announce_ready = self.args.announce_ready;
        let canvas_origin = self.canvas_origin.clone();
        let fixed = self
            .args
            .fixed
            .then_some((self.args.viewport.0 as f32, self.args.viewport.1 as f32));
        let entity: Entity<PocketRoot> = cx.entity();
        let focus = self.focus.clone();
        let ime = self.forward_input();

        div()
            .size_full()
            .bg(gpui::black())
            .cursor(self.cursor_style)
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key_down))
            .on_key_up(cx.listener(Self::on_key_up))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_down(MouseButton::Right, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Right, cx.listener(Self::on_mouse_up))
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
                            renderer.borrow_mut().paint_with_compositor(
                                ui,
                                origin,
                                window,
                                cx,
                                &mut |surface_handle, full, clip, _focused, window, cx| {
                                    app_supervisor.borrow_mut().paint(
                                        surface_handle,
                                        full,
                                        clip,
                                        window,
                                        cx,
                                    );
                                },
                            );
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
            app_id: Some("dev.pocket-stack.desktop-host".into()),
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
                    eprintln!("pocket-desktop-host: {e:#}");
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
                eprintln!("pocket-desktop-host: open_window failed: {e:#}");
                std::process::exit(1);
            }
        }
    });
    Ok(())
}

/// Application::run wants a 'static closure; stash the parsed args for it.
static ARGS: std::sync::Mutex<Option<Args>> = std::sync::Mutex::new(None);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_supervisor_uses_lifecycle_focus_and_shell_painter_order() {
        let mut facts = [
            SchedulingFact {
                visible: true,
                focused: false,
                order: 10,
                state: AppInstanceState::Running,
            },
            SchedulingFact {
                visible: false,
                focused: false,
                order: 20,
                state: AppInstanceState::Suspended,
            },
            SchedulingFact {
                visible: true,
                focused: true,
                order: 30,
                state: AppInstanceState::Running,
            },
            SchedulingFact {
                visible: true,
                focused: true,
                order: 25,
                state: AppInstanceState::Failed,
            },
        ];
        assert_eq!(focused_app_instance(&facts), Some(2));
        assert_eq!(scheduled_app_instances(&facts), vec![2, 0]);
        facts[1].state = AppInstanceState::Running;
        assert_eq!(scheduled_app_instances(&facts), vec![2, 1, 0]);
    }

    #[test]
    fn app_instances_do_not_share_quickjs_globals() {
        let hero = Guest::new().unwrap();
        let settings = Guest::new().unwrap();
        hero.eval("hero", "globalThis.realmProbe = 41;").unwrap();
        settings
            .eval(
                "settings",
                "globalThis.realmProbeWasAbsent = typeof realmProbe === 'undefined';",
            )
            .unwrap();

        let hero_probe: i32 = hero.with(|ctx| ctx.globals().get("realmProbe").unwrap());
        let settings_absent: bool =
            settings.with(|ctx| ctx.globals().get("realmProbeWasAbsent").unwrap());
        assert_eq!(hero_probe, 41);
        assert!(settings_absent);
    }

    #[test]
    fn app_instance_repaint_hash_includes_raster_revision() {
        let surface = UiSurface::new((16.0, 16.0));
        let texture = surface.with_ui(|ui| {
            ui.upload_texture(
                &[0xff, 0xff, 0xff, 0xff],
                1,
                1,
                pocketjs_core::spec::psm::PSM_8888,
            )
        });
        assert!(texture >= 0);

        let (words_before, revision_before) =
            surface.with_ui(|ui| (ui.draw().words.clone(), ui.raster_revision()));
        let mut hash_before = 0xcbf2_9ce4_8422_2325u64;
        mix_app_instance_repaint_hash(&mut hash_before, 7, fnv1a64(&words_before), revision_before);

        surface.with_ui(|ui| ui.free_texture(texture));
        let (words_after, revision_after) =
            surface.with_ui(|ui| (ui.draw().words.clone(), ui.raster_revision()));
        let mut hash_after = 0xcbf2_9ce4_8422_2325u64;
        mix_app_instance_repaint_hash(&mut hash_after, 7, fnv1a64(&words_after), revision_after);

        assert_eq!(words_after, words_before);
        assert_ne!(revision_after, revision_before);
        assert_ne!(hash_after, hash_before);
    }

    #[test]
    fn resolved_system_plan_uses_the_exact_system_ui_wire_key() {
        let plan: ResolvedSystemPlan = serde_json::from_value(serde_json::json!({
            "system": {
                "id": "dev.pocket-stack.desktop",
                "name": "pocket-desktop",
                "title": "Pocket Desktop",
                "version": "0.1.0"
            },
            "target": { "id": HOST_ID, "hostAbi": 4 },
            "roles": { "systemUI": "dev.pocket-stack.shell" },
            "lifecycle": { "backgroundExecution": "suspend" },
            "installation": {
                "installedPackages": ["dev.pocket-stack.shell"]
            },
            "systemUI": {
                "package": "dev.pocket-stack.shell",
                "source": "apps/shell/pocket.json",
                "required": true,
                "plan": {
                    "app": {
                        "id": "dev.pocket-stack.shell",
                        "output": "shell-main",
                        "title": "System UI",
                        "version": "0.1.0",
                        "entry": "apps/shell/main.tsx",
                        "framework": "solid"
                    },
                    "target": { "id": HOST_ID, "hostAbi": 4 },
                    "viewport": {
                        "logical": [800, 600],
                        "physical": [1600, 1200],
                        "presentation": "native",
                        "rasterDensity": 2,
                        "policy": "dynamic"
                    },
                    "features": { "ui.compositor-surfaces": true },
                    "companions": ["system-ui"],
                    "planHash": "sha256:package"
                }
            },
            "applications": [],
            "planHash": "sha256:system"
        }))
        .unwrap();

        assert_eq!(plan.roles.system_ui, "dev.pocket-stack.shell");
        assert_eq!(plan.system_ui.package, "dev.pocket-stack.shell");
        assert!(plan.validate_for_host().is_ok());
    }
}
