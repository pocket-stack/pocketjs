//! The `ui` surface: one `pocketjs_core::Ui` core + the HostOps contract
//! (spec/spec.ts OP table; JS caller in src/host.ts) mounted into a guest
//! as `globalThis.ui`.
//!
//! Boot contract mirrors the PSP host (`native/src/ffi.rs` + `pak.rs`):
//! styles/atlases feed the core natively BEFORE the bundle evals, pak images
//! and sprites upload natively, and the (name → handle) tables are exposed
//! as `ui.__textures` / `ui.__sprites`, which is exactly what routes
//! `src/host.ts::detectHost` onto its PSP branch. One desktop addition:
//! `ui.__viewport = {w, h}` tells the framework the logical UI size (the PSP
//! host omits it and the framework defaults to 480x272).

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

use anyhow::Result;
use pocket_mod::Guest;
use pocket_mod::qjs::{Coerced, Function, Object, TypedArray};
use pocketjs_core::Ui;

use crate::dbg::DbgMailbox;
use crate::pak::walk_pak;

/// One sprite-atlas registration from the pak (`ui.__sprites[name]`).
struct SpriteReg {
    name: String,
    handle: i32,
    frames: u16,
    cols: u16,
    step: u16,
}

struct Inner {
    ui: Ui,
    /// The fed pak, kept whole: `loadTileTexture` decodes TILESET entries
    /// out of it on demand (tile bytes never transit the JS heap).
    pak: Vec<u8>,
    /// pak image name → core texture handle (`ui.__textures`).
    textures: Vec<(String, i32)>,
    sprites: Vec<SpriteReg>,
    /// Host service channel (spec ops 30..32): in-process JSON-line queues.
    /// On consoles the mailbox is files under a tethered share; here the
    /// widget host *is* the companion process, so lines just cross a queue.
    svc_in: VecDeque<String>,
    svc_out: VecDeque<String>,
    /// Platform-contract identity published as `ui.__host`/`ui.__hostAbi`.
    /// Bundles built from a resolved plan refuse hosts whose identity does
    /// not match their target (src/host.ts assertNativeHostContract).
    host_id: String,
    host_abi: Option<u32>,
}

/// The `ui` surface. Clone-cheap handle; single-threaded like the guest.
#[derive(Clone)]
pub struct UiSurface {
    inner: Rc<RefCell<Inner>>,
}

impl UiSurface {
    /// A fresh core sized to `viewport` (logical px; pass (480, 272) to host
    /// stock PSP apps).
    pub fn new(viewport: (f32, f32)) -> UiSurface {
        Self::new_with_density(viewport, 1)
    }

    /// A fresh core with a raster density > 1 (the Vita model: logical
    /// layout unchanged, core-baked bitmaps and font coverage at `density`
    /// samples per logical px). Pair with density-`density` paks and
    /// `UiRenderer::render_words_scaled` for native-resolution output on
    /// high-DPI displays.
    pub fn new_with_density(viewport: (f32, f32), density: u32) -> UiSurface {
        let mut ui = Ui::new_with_raster_density(density);
        ui.set_viewport(viewport.0, viewport.1);
        UiSurface {
            inner: Rc::new(RefCell::new(Inner {
                ui,
                pak: Vec::new(),
                textures: Vec::new(),
                sprites: Vec::new(),
                svc_in: VecDeque::new(),
                svc_out: VecDeque::new(),
                host_id: "desktop".into(),
                host_abi: None,
            })),
        }
    }

    /// Declare this host's platform-contract identity (a POCKET_TARGETS id
    /// + its hostAbi) before `mount`. Plan-built bundles assert it; the
    /// default "desktop" (no ABI) serves plan-less development hosts.
    pub fn set_identity(&self, host_id: &str, host_abi: u32) {
        let mut inner = self.inner.borrow_mut();
        inner.host_id = host_id.to_string();
        inner.host_abi = Some(host_abi);
    }

    /// Queue one JSON line for the guest's next `svcPoll` (host → guest).
    pub fn svc_push(&self, line: impl Into<String>) {
        self.inner.borrow_mut().svc_in.push_back(line.into());
    }

    /// Drain the lines the guest sent with `svcSend` (guest → host).
    pub fn svc_drain(&self) -> Vec<String> {
        self.inner.borrow_mut().svc_out.drain(..).collect()
    }

    /// Feed an app pak: styles + font atlases go straight to the core,
    /// images/sprites upload as core textures. Call before `mount`.
    pub fn feed_pak(&self, pak: &[u8]) {
        let mut inner = self.inner.borrow_mut();
        inner.pak = pak.to_vec();
        for entry in walk_pak(pak) {
            if entry.key == "ui:styles" {
                if !inner.ui.load_styles(entry.blob) {
                    log::warn!("pocket-ui: bad styles.bin in pak");
                }
            } else if entry.key.starts_with("ui:font.") {
                if !inner.ui.load_font_atlas(entry.blob) {
                    log::warn!("pocket-ui: bad font atlas {}", entry.key);
                }
            } else if let Some(name) = entry.key.strip_prefix("ui:img.") {
                // IMG entry: 8-byte header {u16 w, u16 h, u8 psm, 3B pad} + pixels.
                let Some((w, h, psm, pixels)) = decode_pix_header(entry.blob, 8) else {
                    log::warn!("pocket-ui: bad image entry {}", entry.key);
                    continue;
                };
                let handle = inner.ui.upload_texture(pixels, w, h, psm);
                if handle >= 0 {
                    let name = name.to_string();
                    inner.textures.push((name, handle));
                } else {
                    log::warn!(
                        "pocket-ui: image {} rejected ({}x{} psm {})",
                        entry.key,
                        w,
                        h,
                        psm
                    );
                }
            } else if let Some(name) = entry.key.strip_prefix("ui:sprite.") {
                // SPRITE entry: 16-byte header {u16 w, u16 h, u8 psm, u8 pad,
                // u16 frames, u16 cols, u16 step, 4B pad} + atlas pixels.
                let Some((w, h, psm, pixels)) = decode_pix_header(entry.blob, 16) else {
                    log::warn!("pocket-ui: bad sprite entry {}", entry.key);
                    continue;
                };
                let (Some(frames), Some(cols), Some(step)) = (
                    rd_u16(entry.blob, 6),
                    rd_u16(entry.blob, 8),
                    rd_u16(entry.blob, 10),
                ) else {
                    continue;
                };
                let handle = inner.ui.upload_texture(pixels, w, h, psm);
                if handle >= 0 {
                    let name = name.to_string();
                    inner.sprites.push(SpriteReg {
                        name,
                        handle,
                        frames,
                        cols,
                        step,
                    });
                } else {
                    log::warn!("pocket-ui: sprite {} rejected", entry.key);
                }
            }
            // unknown keys: ignored (forward compatible)
        }
    }

    /// Advance the core one fixed-dt frame (call once per host tick, after
    /// the guest turn, before rendering).
    pub fn tick(&self) {
        self.inner.borrow_mut().ui.tick();
    }

    /// Borrow the core (the renderer reads the DrawList/textures/atlases
    /// through this; hosts can use it for `set_viewport` on resize).
    pub fn with_ui<R>(&self, f: impl FnOnce(&mut Ui) -> R) -> R {
        f(&mut self.inner.borrow_mut().ui)
    }

    /// Mount `globalThis.ui` (ops + `__textures`/`__sprites`/`__viewport`)
    /// into `guest`. Call after `feed_pak`, before evaluating the bundle.
    pub fn mount(&self, guest: &Guest) -> Result<()> {
        guest.mount("ui", |ctx, ns| {
            macro_rules! op {
                ($name:literal, $f:expr) => {
                    ns.set($name, Function::new(ctx.clone(), $f)?)?;
                };
            }

            let ui = self.inner.clone();
            op!("createNode", move |t: i32| ui
                .borrow_mut()
                .ui
                .create_node(t as u8));

            let ui = self.inner.clone();
            op!("destroyNode", move |id: i32| ui
                .borrow_mut()
                .ui
                .destroy_node(id));

            let ui = self.inner.clone();
            op!("insertBefore", move |p: i32, c: i32, a: i32| {
                ui.borrow_mut().ui.insert_before(p, c, a)
            });

            let ui = self.inner.clone();
            op!("removeChild", move |p: i32, c: i32| ui
                .borrow_mut()
                .ui
                .remove_child(p, c));

            let ui = self.inner.clone();
            op!("setStyle", move |id: i32, style: i32| ui
                .borrow_mut()
                .ui
                .set_style(id, style));

            let ui = self.inner.clone();
            op!("setProp", move |id: i32, prop: i32, v: f64| {
                ui.borrow_mut().ui.set_prop(id, prop as u8, v)
            });

            // Text ops coerce like the PSP FFI does (JS_ToCString semantics —
            // Solid legitimately passes numbers through replaceText).
            let ui = self.inner.clone();
            op!("setText", move |id: i32, s: Coerced<String>| ui
                .borrow_mut()
                .ui
                .set_text(id, &s.0));

            let ui = self.inner.clone();
            op!("replaceText", move |id: i32, s: Coerced<String>| {
                ui.borrow_mut().ui.replace_text(id, &s.0)
            });

            let ui = self.inner.clone();
            op!(
                "uploadTexture",
                move |buf: TypedArray<u8>, w: i32, h: i32, psm: i32| {
                    let Some(bytes) = buf.as_bytes() else {
                        return -1;
                    };
                    ui.borrow_mut()
                        .ui
                        .upload_texture(bytes, w as u32, h as u32, psm as u32)
                }
            );

            let ui = self.inner.clone();
            op!("setImage", move |id: i32, tex: i32| ui
                .borrow_mut()
                .ui
                .set_image(id, tex));

            let ui = self.inner.clone();
            op!("setSprite", move |id: i32,
                                   atlas: i32,
                                   frames: i32,
                                   cols: i32,
                                   step: i32| {
                ui.borrow_mut().ui.set_sprite(
                    id,
                    atlas,
                    frames.max(0) as u32,
                    cols.max(0) as u32,
                    step.max(0) as u32,
                )
            });

            let ui = self.inner.clone();
            op!("animate", move |id: i32,
                                 prop: i32,
                                 to: f64,
                                 dur_ms: f64,
                                 easing: i32,
                                 delay_ms: f64| {
                ui.borrow_mut().ui.animate(
                    id,
                    prop as u8,
                    to,
                    dur_ms.max(0.0) as u32,
                    easing as u8,
                    delay_ms.max(0.0) as u32,
                )
            });

            let ui = self.inner.clone();
            op!("cancelAnim", move |id: i32| ui
                .borrow_mut()
                .ui
                .cancel_anim(id));

            let ui = self.inner.clone();
            op!("setFocus", move |id: i32| ui.borrow_mut().ui.set_focus(id));

            let ui = self.inner.clone();
            op!("setActive", move |id: i32, active: i32| {
                ui.borrow_mut().ui.set_active(id, active != 0)
            });

            // Virtual cursor ops (spec ops 27..29, input.cursor).
            let ui = self.inner.clone();
            op!("hitTest", move |x: f64, y: f64| {
                ui.borrow_mut().ui.hit_test(x as f32, y as f32)
            });

            let ui = self.inner.clone();
            op!("setCursor", move |tex: i32, hot_x: f64, hot_y: f64, w: f64, h: f64| {
                ui.borrow_mut().ui.set_cursor(tex, hot_x as f32, hot_y as f32, w as f32, h as f32)
            });

            let ui = self.inner.clone();
            op!("setCursorPos", move |x: f64, y: f64| {
                ui.borrow_mut().ui.set_cursor_pos(x as f32, y as f32)
            });

            let ui = self.inner.clone();
            op!("loadStyles", move |buf: TypedArray<u8>| {
                let Some(bytes) = buf.as_bytes() else {
                    return false;
                };
                ui.borrow_mut().ui.load_styles(bytes)
            });

            let ui = self.inner.clone();
            op!("loadFontAtlas", move |buf: TypedArray<u8>| {
                let Some(bytes) = buf.as_bytes() else {
                    return false;
                };
                ui.borrow_mut().ui.load_font_atlas(bytes)
            });

            let ui = self.inner.clone();
            op!("measureText", move |s: Coerced<String>, slot: i32| {
                ui.borrow_mut().ui.measure_text(&s.0, slot as u8) as f64
            });

            // ---- streamed textures (spec ops 23..25) ---------------------
            let ui = self.inner.clone();
            op!("loadTileTexture", move |key: Coerced<String>, index: i32| {
                if index < 0 {
                    return -1;
                }
                let mut inner = ui.borrow_mut();
                let inner = &mut *inner; // split borrow: pak read, core write
                match crate::pak::find_pak(&inner.pak, &key.0) {
                    Some(blob) => inner.ui.upload_tileset_tile(blob, index as u32),
                    None => -1,
                }
            });

            let ui = self.inner.clone();
            op!("freeTexture", move |handle: i32| ui
                .borrow_mut()
                .ui
                .free_texture(handle));

            let ui = self.inner.clone();
            op!("uploadImgEntry", move |buf: TypedArray<u8>| {
                let Some(bytes) = buf.as_bytes() else {
                    return -1;
                };
                ui.borrow_mut().ui.upload_img_entry(bytes)
            });

            // ---- DevTools ops (spec ops 18..22) + mailbox transport ------
            // Same names and semantics as the PSP FFI (native/src/ffi.rs +
            // native/src/dbg.rs): the shim's transport resolution and the
            // devtools bridge work against this host unchanged.
            let ui = self.inner.clone();
            op!("debugInspect", move |id: i32| ui
                .borrow_mut()
                .ui
                .debug_inspect(id));

            let ui = self.inner.clone();
            op!("debugRectXY", move || ui.borrow().ui.debug_rect_xy());

            let ui = self.inner.clone();
            op!("debugRectWH", move || ui.borrow().ui.debug_rect_wh());

            let ui = self.inner.clone();
            op!("debugPause", move |on: bool| ui
                .borrow_mut()
                .ui
                .debug_pause(on));

            let ui = self.inner.clone();
            op!("debugStep", move || ui.borrow_mut().ui.debug_step());

            let mbox = Rc::new(RefCell::new(DbgMailbox::probe()));
            let m = mbox.clone();
            op!("__dbgActive", move || m.borrow().is_some());

            let m = mbox.clone();
            op!("__dbgPoll", move || -> Option<String> {
                m.borrow_mut().as_mut().and_then(|b| b.poll())
            });

            let m = mbox;
            op!("__dbgSend", move |line: Coerced<String>| {
                if let Some(b) = m.borrow().as_ref() {
                    b.send(&line.0);
                }
            });

            // ---- host service channel (spec ops 30..32) ------------------
            // The widget/desktop host is its own companion process: svcOpen
            // always succeeds and lines cross an in-process queue instead of
            // a tethered share. Apps feature-detect exactly like on PSP.
            op!("svcOpen", move |_app: Coerced<String>| true);

            let ui = self.inner.clone();
            op!("svcPoll", move || -> Option<String> {
                let mut inner = ui.borrow_mut();
                if inner.svc_in.is_empty() {
                    return None;
                }
                // Batch per the HostOps contract: complete JSON lines,
                // newline-terminated, possibly several per poll.
                let mut batch = String::new();
                for line in inner.svc_in.drain(..) {
                    batch.push_str(&line);
                    batch.push('\n');
                }
                Some(batch)
            });

            let ui = self.inner.clone();
            op!("svcSend", move |line: Coerced<String>| {
                ui.borrow_mut().svc_out.push_back(line.0);
            });

            // ---- boot tables (PSP contract) + desktop viewport ----------
            let inner = self.inner.borrow();
            let textures = Object::new(ctx.clone())?;
            for (name, handle) in &inner.textures {
                textures.set(name.as_str(), *handle)?;
            }
            ns.set("__textures", textures)?;

            let sprites = Object::new(ctx.clone())?;
            for s in &inner.sprites {
                let rec = Object::new(ctx.clone())?;
                rec.set("handle", s.handle)?;
                rec.set("frames", s.frames as i32)?;
                rec.set("cols", s.cols as i32)?;
                rec.set("step", s.step as i32)?;
                sprites.set(s.name.as_str(), rec)?;
            }
            ns.set("__sprites", sprites)?;

            let (vw, vh) = inner.ui.viewport();
            let viewport = Object::new(ctx.clone())?;
            viewport.set("w", vw as f64)?;
            viewport.set("h", vh as f64)?;
            ns.set("__viewport", viewport)?;

            // Honest host label for DevTools' hello and the platform
            // contract (the shim would otherwise report "psp" — this
            // namespace passes its PSP-shaped host detection on purpose).
            ns.set("__host", inner.host_id.as_str())?;
            if let Some(abi) = inner.host_abi {
                ns.set("__hostAbi", abi)?;
            }

            Ok(())
        })
    }
}

#[inline]
fn rd_u16(b: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(off)?, *b.get(off + 1)?]))
}

/// Decode the shared {u16 w, u16 h, u8 psm} pixel-entry header; pixels start
/// at `pixels_off`.
fn decode_pix_header(blob: &[u8], pixels_off: usize) -> Option<(u32, u32, u32, &[u8])> {
    let w = rd_u16(blob, 0)? as u32;
    let h = rd_u16(blob, 2)? as u32;
    let psm = *blob.get(4)? as u32;
    let pixels = blob.get(pixels_off..)?;
    Some((w, h, psm, pixels))
}
