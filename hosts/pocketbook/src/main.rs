//! pocketbook-host — the PocketJS UI runtime on PocketBook e-readers.
//!
//! Reuses the backend-agnostic `ui` surface (`pocket_ui_surface::UiSurface`)
//! and the core's software rasterizer, then blits the frame as RGB24 (inkview
//! converts to gray on grayscale panels, writes RGB on color panels). See
//! `pocketjs-inkview-implementation.md`
//! at the repo root for the full design and the ground-truth API notes.
//!
//! Event-loop model (mirrors `inkview-slint`): `iv_main` runs on the main
//! thread forwarding every `Event` into an mpsc channel; a second thread owns
//! the `Screen` and the PocketJS tick/render loop, pulling events with a
//! timeout so it ticks on a fixed cadence even when idle.

mod framebuffer;
mod input;
mod refresh;

use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use inkview::Event;
use pocket_mod::Guest;
use pocket_ui_surface::UiSurface;

use framebuffer::DirtyRect;

/// Host platform-contract identity. Must match `pocketbook.hostAbi` in
/// contracts/spec/platforms.ts, or plan-built bundles refuse this host
/// (framework/src/host.ts::assertNativeHostContract).
const HOST_ID: &str = "pocketbook";
const HOST_ABI: u32 = 4;

/// Logical tick cadence. E-ink doesn't need 60 fps; ~30 fps keeps animations
/// smooth while sparing CPU and battery.
const TICK_MS: u64 = 33;

/// Logical viewport the pocketbook target profile bakes bundles for
/// (contracts/spec/platforms.ts). Must match the bundle: the framework lays
/// the app out for this size, so the host presents exactly it.
const LOGICAL_W: u32 = 480;
const LOGICAL_H: u32 = 272;
/// Raster density the target profile bakes font atlases/images at; the host
/// must render at the same density for crisp output. 480×272 also stays
/// ≤511 px/axis, keeping touch coordinates inside the 9-bit wire format
/// (framework/src/touch.ts).
const DENSITY: u32 = 2;

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    // &'static Inkview so both the render thread (Screen::new) and the main
    // thread (iv_main) can reference it — same pattern as the slint demo.
    let iv: &'static inkview::bindings::Inkview = Box::leak(Box::new(inkview::load()));

    let (tx, rx) = mpsc::channel::<Event>();

    let render = std::thread::spawn(move || run(iv, rx));

    // Main thread: the inkview event loop. Forward every event to the render
    // thread; if it has gone away (send fails), ask inkview to close the app.
    inkview::iv_main(iv, move |ev| {
        if tx.send(ev).is_err() {
            // SAFETY: the render thread owns the only other use of `iv` and has
            // dropped its receiver (send failed), so it is quiescent; CloseApp
            // only asks inkview to tear down its main loop. Mirrors the
            // inkview-slint demo's shutdown path.
            unsafe {
                iv.CloseApp();
            }
        }
        Some(())
    });

    render
        .join()
        .map_err(|_| anyhow::anyhow!("render thread panicked"))?
}

/// The render thread: boot the guest, then tick/render until Exit.
fn run(iv: &'static inkview::bindings::Inkview, rx: mpsc::Receiver<Event>) -> Result<()> {
    // inkview delivers Init first; wait for it before touching the framebuffer.
    if rx.recv().context("event channel closed before Init")? != Event::Init {
        anyhow::bail!("expected EVT_INIT first");
    }

    let mut screen = inkview::screen::Screen::new(iv);
    let phys_w = screen.width();
    let phys_h = screen.height();

    let geo = Geometry::for_panel(phys_w, phys_h);
    log::info!(
        "pocketbook: panel {phys_w}x{phys_h}, logical {}x{} @{}x, render {}x{} +({},{})",
        geo.logical_w,
        geo.logical_h,
        geo.density,
        geo.render_w,
        geo.render_h,
        geo.ox,
        geo.oy
    );

    // Boot the guest exactly like uihost: feed pak, mount ui, eval bundle.
    let pak = std::fs::read(pak_path()).with_context(|| format!("reading {}", pak_path()))?;
    let bundle =
        std::fs::read_to_string(js_path()).with_context(|| format!("reading {}", js_path()))?;

    let surface =
        UiSurface::new_with_density((geo.logical_w as f32, geo.logical_h as f32), geo.density);
    surface.set_identity(HOST_ID, HOST_ABI);
    surface.feed_pak(&pak);

    let guest = Guest::new()?;
    surface.mount(&guest)?;
    guest.eval("app", &bundle)?;
    anyhow::ensure!(
        guest.has_frame(),
        "bundle installed no frame() — is this a PocketJS app?"
    );

    let mut fb = framebuffer::FramebufferPipeline::new(geo.render_w, geo.render_h, geo.density);
    let mut refresh = refresh::Refresh::new();
    let mut input = input::Input::new(
        geo.density,
        geo.ox as i32,
        geo.oy as i32,
        geo.logical_w as u32,
        geo.logical_h as u32,
    );

    // First paint: render one frame and full-update so the screen starts clean.
    tick(
        &guest,
        &surface,
        &mut fb,
        &mut refresh,
        &mut input,
        &mut screen,
        &geo,
        true,
    )?;

    let mut last_tick = Instant::now();
    loop {
        // Pull events until the tick deadline, then drain any burst.
        let deadline = last_tick + Duration::from_millis(TICK_MS);
        let mut quit = false;
        let mut full = false;
        loop {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            match rx.recv_timeout(deadline - now) {
                Ok(ev) => match input.on_event(ev) {
                    input::Outcome::Quit => {
                        quit = true;
                        break;
                    }
                    input::Outcome::FullRedraw => full = true,
                    input::Outcome::Continue => {}
                },
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    quit = true;
                    break;
                }
            }
        }
        while let Ok(ev) = rx.try_recv() {
            match input.on_event(ev) {
                input::Outcome::Quit => quit = true,
                input::Outcome::FullRedraw => full = true,
                input::Outcome::Continue => {}
            }
        }
        if quit {
            break;
        }

        last_tick = Instant::now();
        tick(
            &guest,
            &surface,
            &mut fb,
            &mut refresh,
            &mut input,
            &mut screen,
            &geo,
            full,
        )?;
    }
    Ok(())
}

/// One fixed-step frame: guest turn → core tick → draw → raster → gray → blit
/// → panel update. Order matches uihost.
#[allow(clippy::too_many_arguments)]
fn tick(
    guest: &Guest,
    surface: &UiSurface,
    fb: &mut framebuffer::FramebufferPipeline,
    refresh: &mut refresh::Refresh,
    input: &mut input::Input,
    screen: &mut inkview::screen::Screen,
    geo: &Geometry,
    full: bool,
) -> Result<()> {
    let (buttons, analog, touches) = input.snapshot();
    guest.frame_with_touches(buttons, analog, &touches)?;

    surface.tick();

    // Rasterize at density → RGBA8 and diff against the previous frame
    // (buffer coords). The blit below reads the CURRENT frame, so the
    // previous-frame latch is advanced only after blitting.
    let dirty = surface.with_ui(|ui| {
        let words = ui.draw().words.clone();
        fb.rasterize(ui, &words);
        fb.diff()
    });

    if full {
        // Full redraw (first paint / return from background): blit everything
        // and flash the panel once for a clean, ghost-free image.
        fb.blit_all(screen, geo.ox, geo.oy);
        refresh.full(screen);
    } else if !dirty.is_empty() {
        fb.blit_dirty(screen, &dirty, geo.ox, geo.oy);
        let screen_dirty = offset_rects(&dirty, geo.ox, geo.oy);
        refresh.present(screen, &screen_dirty);
    } else {
        // No change this frame; still let the refresh policy run its quiet
        // cleanup timer (it no-ops when there's nothing pending).
        refresh.present(screen, &[]);
    }

    // Latch this frame as the previous one for the next diff.
    fb.advance();
    Ok(())
}

/// Render-buffer rects → screen rects (integer-fit origin offset).
fn offset_rects(rects: &[DirtyRect], ox: usize, oy: usize) -> Vec<DirtyRect> {
    rects
        .iter()
        .map(|r| DirtyRect {
            x: r.x + ox,
            y: r.y + oy,
            w: r.w,
            h: r.h,
        })
        .collect()
}

/// Logical-viewport / raster-density geometry for the current panel.
struct Geometry {
    logical_w: usize,
    logical_h: usize,
    density: u32,
    render_w: usize,
    render_h: usize,
    ox: usize,
    oy: usize,
}

impl Geometry {
    /// Present the bundle's fixed 480×272 @2x surface (a 960×544 render) and
    /// integer-fit center it on the actual panel. The panel size only sets the
    /// centering offset; the logical viewport and density are fixed to match
    /// the pocketbook target profile (and stay ≤511/axis, so touch coordinates
    /// fit the 9-bit wire format).
    fn for_panel(phys_w: usize, phys_h: usize) -> Self {
        let logical_w = LOGICAL_W as usize;
        let logical_h = LOGICAL_H as usize;
        let render_w = logical_w * DENSITY as usize;
        let render_h = logical_h * DENSITY as usize;
        let ox = phys_w.saturating_sub(render_w) / 2;
        let oy = phys_h.saturating_sub(render_h) / 2;
        Self {
            logical_w,
            logical_h,
            density: DENSITY,
            render_w,
            render_h,
            ox,
            oy,
        }
    }
}

fn pak_path() -> String {
    std::env::var("POCKET_PAK").unwrap_or_else(|_| "app.pak".into())
}

fn js_path() -> String {
    std::env::var("POCKET_JS").unwrap_or_else(|_| "app.js".into())
}
