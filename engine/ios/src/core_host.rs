//! External-guest mode: the JS engine lives elsewhere (a NativeScript
//! runtime), so this side owns only `pocketjs_core::Ui`, the pak feed, the
//! raster pipeline, and the svc queues. The host mounts `globalThis.ui` in
//! its own engine and delegates each op to the `pocket_apple_core_*` C ABI.
//! Same single-thread rules as the guest-owning mode.

use std::collections::VecDeque;
use std::ffi::{c_char, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::slice;

use pocket_ui_surface::walk_pak;
use pocketjs_core::damage::{DamagePolicy, DamageTracker};
use pocketjs_core::raster;
use pocketjs_core::Ui;

use crate::{
    set_last_error, PocketAppleFrame, MAX_TICK_HZ, MIN_TICK_HZ, POCKET_APPLE_MAX_DAMAGE_REGIONS,
};

const OK: i32 = 0;
const ERR_BAD_ARGUMENT: i32 = -1;
const ERR_BAD_STATE: i32 = -2;
const ERR_PANIC: i32 = -4;

pub struct SpriteReg {
    pub name: CString,
    pub handle: i32,
    pub frames: u16,
    pub cols: u16,
    pub step: u16,
}

pub struct PocketAppleCore {
    ui: Ui,
    framebuffer: Vec<u8>,
    tracker: DamageTracker,
    density: u32,
    logical_width: u32,
    logical_height: u32,
    textures: Vec<(CString, i32)>,
    sprites: Vec<SpriteReg>,
    svc_in: VecDeque<String>,
    svc_out: VecDeque<String>,
    svc_poll_batch: CString,
    ticked: bool,
    /// Whether any `core_animate` ran — an ms-to-frames conversion at the
    /// rate then in force, which `set_tick_rate` must therefore precede.
    animated: bool,
}

fn with_core<R>(
    handle: *mut PocketAppleCore,
    default: R,
    f: impl FnOnce(&mut PocketAppleCore) -> R,
) -> R {
    if handle.is_null() {
        set_last_error("null core handle");
        return default;
    }
    let state = unsafe { &mut *handle };
    match catch_unwind(AssertUnwindSafe(|| f(state))) {
        Ok(value) => value,
        Err(_) => {
            set_last_error("panic inside pocket-apple core");
            default
        }
    }
}

fn str_arg<'a>(bytes: *const u8, length: usize) -> Option<&'a str> {
    if bytes.is_null() {
        return Some("");
    }
    std::str::from_utf8(unsafe { slice::from_raw_parts(bytes, length) }).ok()
}

fn rd_u16(b: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(off)?, *b.get(off + 1)?]))
}

fn decode_pix_header(blob: &[u8], pixels_off: usize) -> Option<(u32, u32, u32, &[u8])> {
    let w = rd_u16(blob, 0)? as u32;
    let h = rd_u16(blob, 2)? as u32;
    let psm = *blob.get(4)? as u32;
    let pixels = blob.get(pixels_off..)?;
    Some((w, h, psm, pixels))
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_create(
    density: u32,
    logical_width: u32,
    logical_height: u32,
) -> *mut PocketAppleCore {
    let result = catch_unwind(|| {
        if density == 0
            || density > raster::MAX_RENDER_SCALE
            || logical_width == 0
            || logical_height == 0
        {
            set_last_error("invalid density or viewport");
            return std::ptr::null_mut();
        }
        let mut ui = Ui::new_with_raster_density(density);
        ui.set_viewport(logical_width as f32, logical_height as f32);
        let pixel_len =
            (logical_width * density) as usize * (logical_height * density) as usize * 4;
        Box::into_raw(Box::new(PocketAppleCore {
            ui,
            framebuffer: vec![0; pixel_len],
            tracker: DamageTracker::default(),
            density,
            logical_width,
            logical_height,
            textures: Vec::new(),
            sprites: Vec::new(),
            svc_in: VecDeque::new(),
            svc_out: VecDeque::new(),
            svc_poll_batch: CString::default(),
            ticked: false,
            animated: false,
        }))
    });
    result.unwrap_or(std::ptr::null_mut())
}

/// Mirrors `UiSurface::feed_pak`: styles and font atlases feed the core,
/// images and sprite atlases upload as textures and land in the name tables
/// the host publishes as `ui.__textures` / `ui.__sprites`.
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_load_pak(
    handle: *mut PocketAppleCore,
    bytes: *const u8,
    length: usize,
) -> i32 {
    with_core(handle, ERR_PANIC, |state| {
        if bytes.is_null() || length == 0 {
            return ERR_BAD_ARGUMENT;
        }
        let pak = unsafe { slice::from_raw_parts(bytes, length) };
        for entry in walk_pak(pak) {
            if entry.key == "ui:styles" {
                if !state.ui.load_styles(entry.blob) {
                    log::warn!("pocket-apple: bad styles.bin in pak");
                }
            } else if entry.key.starts_with("ui:font.") {
                if !state.ui.load_font_atlas(entry.blob) {
                    log::warn!("pocket-apple: bad font atlas {}", entry.key);
                }
            } else if let Some(name) = entry.key.strip_prefix("ui:img.") {
                let Some((w, h, psm, pixels)) = decode_pix_header(entry.blob, 8) else {
                    continue;
                };
                let texture = state.ui.upload_texture(pixels, w, h, psm);
                if texture >= 0 {
                    if let Ok(name) = CString::new(name) {
                        state.textures.push((name, texture));
                    }
                }
            } else if let Some(name) = entry.key.strip_prefix("ui:sprite.") {
                let Some((w, h, psm, pixels)) = decode_pix_header(entry.blob, 16) else {
                    continue;
                };
                let (Some(frames), Some(cols), Some(step)) = (
                    rd_u16(entry.blob, 6),
                    rd_u16(entry.blob, 8),
                    rd_u16(entry.blob, 10),
                ) else {
                    continue;
                };
                let texture = state.ui.upload_texture(pixels, w, h, psm);
                if texture >= 0 {
                    if let Ok(name) = CString::new(name) {
                        state.sprites.push(SpriteReg {
                            name,
                            handle: texture,
                            frames,
                            cols,
                            step,
                        });
                    }
                }
            }
        }
        OK
    })
}

// ---- ui.* ops ------------------------------------------------------------

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_create_node(handle: *mut PocketAppleCore, node_type: u32) -> i32 {
    with_core(handle, 0, |state| state.ui.create_node(node_type as u8))
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_destroy_node(handle: *mut PocketAppleCore, id: i32) {
    with_core(handle, (), |state| state.ui.destroy_node(id));
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_insert_before(
    handle: *mut PocketAppleCore,
    parent: i32,
    child: i32,
    anchor: i32,
) {
    with_core(handle, (), |state| state.ui.insert_before(parent, child, anchor));
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_remove_child(
    handle: *mut PocketAppleCore,
    parent: i32,
    child: i32,
) {
    with_core(handle, (), |state| state.ui.remove_child(parent, child));
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_set_style(handle: *mut PocketAppleCore, id: i32, style: i32) {
    with_core(handle, (), |state| state.ui.set_style(id, style));
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_set_prop(
    handle: *mut PocketAppleCore,
    id: i32,
    prop: u32,
    value: f64,
) {
    with_core(handle, (), |state| state.ui.set_prop(id, prop as u8, value));
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_set_text(
    handle: *mut PocketAppleCore,
    id: i32,
    text: *const u8,
    length: usize,
) {
    with_core(handle, (), |state| {
        if let Some(text) = str_arg(text, length) {
            state.ui.set_text(id, text);
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_replace_text(
    handle: *mut PocketAppleCore,
    id: i32,
    text: *const u8,
    length: usize,
) {
    with_core(handle, (), |state| {
        if let Some(text) = str_arg(text, length) {
            state.ui.replace_text(id, text);
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_measure_text(
    handle: *mut PocketAppleCore,
    text: *const u8,
    length: usize,
    font_slot: u32,
) -> f32 {
    with_core(handle, 0.0, |state| {
        str_arg(text, length)
            .map(|text| state.ui.measure_text(text, font_slot as u8))
            .unwrap_or(0.0)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_upload_texture(
    handle: *mut PocketAppleCore,
    bytes: *const u8,
    length: usize,
    width: u32,
    height: u32,
    psm: u32,
) -> i32 {
    with_core(handle, -1, |state| {
        if bytes.is_null() || length == 0 {
            return -1;
        }
        let data = unsafe { slice::from_raw_parts(bytes, length) };
        state.ui.upload_texture(data, width, height, psm)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_set_image(handle: *mut PocketAppleCore, id: i32, texture: i32) {
    with_core(handle, (), |state| state.ui.set_image(id, texture));
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_set_sprite(
    handle: *mut PocketAppleCore,
    id: i32,
    atlas: i32,
    frames: u32,
    cols: u32,
    step: u32,
) {
    with_core(handle, (), |state| state.ui.set_sprite(id, atlas, frames, cols, step));
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_animate(
    handle: *mut PocketAppleCore,
    id: i32,
    prop: u32,
    to: f64,
    duration_ms: u32,
    easing: u32,
    delay_ms: u32,
) -> i32 {
    with_core(handle, -1, |state| {
        state.animated = true;
        state
            .ui
            .animate(id, prop as u8, to, duration_ms, easing as u8, delay_ms)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_cancel_anim(handle: *mut PocketAppleCore, anim_id: i32) {
    with_core(handle, (), |state| state.ui.cancel_anim(anim_id));
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_set_focus(handle: *mut PocketAppleCore, id: i32) {
    with_core(handle, (), |state| state.ui.set_focus(id));
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_set_active(handle: *mut PocketAppleCore, id: i32, active: i32) {
    with_core(handle, (), |state| state.ui.set_active(id, active != 0));
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_hit_test_bounds(
    handle: *mut PocketAppleCore,
    x: f32,
    y: f32,
) -> i32 {
    with_core(handle, 0, |state| state.ui.hit_test_bounds(x, y))
}

// ---- texture / sprite tables (published as ui.__textures / __sprites) ----

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_texture_count(handle: *mut PocketAppleCore) -> u32 {
    with_core(handle, 0, |state| state.textures.len() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_texture_name(
    handle: *mut PocketAppleCore,
    index: u32,
) -> *const c_char {
    with_core(handle, std::ptr::null(), |state| {
        state
            .textures
            .get(index as usize)
            .map(|(name, _)| name.as_ptr())
            .unwrap_or(std::ptr::null())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_texture_handle(
    handle: *mut PocketAppleCore,
    index: u32,
) -> i32 {
    with_core(handle, -1, |state| {
        state
            .textures
            .get(index as usize)
            .map(|(_, texture)| *texture)
            .unwrap_or(-1)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_sprite_count(handle: *mut PocketAppleCore) -> u32 {
    with_core(handle, 0, |state| state.sprites.len() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_sprite_name(
    handle: *mut PocketAppleCore,
    index: u32,
) -> *const c_char {
    with_core(handle, std::ptr::null(), |state| {
        state
            .sprites
            .get(index as usize)
            .map(|sprite| sprite.name.as_ptr())
            .unwrap_or(std::ptr::null())
    })
}

/// Packs handle plus atlas geometry: [handle, frames, cols, step].
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_sprite_info(
    handle: *mut PocketAppleCore,
    index: u32,
    out: *mut i32,
) -> i32 {
    with_core(handle, ERR_BAD_ARGUMENT, |state| {
        if out.is_null() {
            return ERR_BAD_ARGUMENT;
        }
        let Some(sprite) = state.sprites.get(index as usize) else {
            return ERR_BAD_ARGUMENT;
        };
        let slots = unsafe { slice::from_raw_parts_mut(out, 4) };
        slots[0] = sprite.handle;
        slots[1] = sprite.frames as i32;
        slots[2] = sprite.cols as i32;
        slots[3] = sprite.step as i32;
        OK
    })
}

// ---- svc channel ----------------------------------------------------------

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_svc_send(
    handle: *mut PocketAppleCore,
    text: *const u8,
    length: usize,
) {
    with_core(handle, (), |state| {
        if let Some(line) = str_arg(text, length) {
            state.svc_out.push_back(line.to_string());
        }
    });
}

/// Newline-joined batch of queued host lines, or NULL when empty. The
/// returned pointer stays valid until the next poll on the same handle.
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_svc_poll(handle: *mut PocketAppleCore) -> *const c_char {
    with_core(handle, std::ptr::null(), |state| {
        if state.svc_in.is_empty() {
            return std::ptr::null();
        }
        let mut batch = String::new();
        for line in state.svc_in.drain(..) {
            batch.push_str(&line);
            batch.push('\n');
        }
        state.svc_poll_batch = CString::new(batch).unwrap_or_default();
        state.svc_poll_batch.as_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_post_event(
    handle: *mut PocketAppleCore,
    line: *const c_char,
) -> i32 {
    with_core(handle, ERR_PANIC, |state| {
        if line.is_null() {
            return ERR_BAD_ARGUMENT;
        }
        match unsafe { std::ffi::CStr::from_ptr(line) }.to_str() {
            Ok(text) => {
                state.svc_in.push_back(text.to_string());
                OK
            }
            Err(_) => ERR_BAD_ARGUMENT,
        }
    })
}

/// Drains guest svcSend lines into `callback` (guest -> host effects).
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_drain_effects(
    handle: *mut PocketAppleCore,
    callback: Option<crate::PocketAppleEffectCallback>,
    context: *mut std::ffi::c_void,
) {
    with_core(handle, (), |state| {
        let Some(callback) = callback else { return };
        while let Some(line) = state.svc_out.pop_front() {
            if let Ok(line) = CString::new(line) {
                callback(line.as_ptr(), context);
            }
        }
    });
}

// ---- frame ----------------------------------------------------------------

/// Ticks per second of the core's virtual time. 1..=240; the guest bundle
/// mounted over this core must be built for the same rate, and the ui
/// namespace the embedder mounts must declare it as `ui.__tickHz`. Rejected
/// after the first `core_animate` or tick: animate converts ms to frames at
/// the rate then in force, so declare the rate before the guest evaluates.
#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_set_tick_rate(handle: *mut PocketAppleCore, hz: u32) -> i32 {
    with_core(handle, ERR_PANIC, |state| {
        if state.ticked || state.animated {
            set_last_error("tick rate must be set before the first animate or tick");
            return ERR_BAD_STATE;
        }
        if !(MIN_TICK_HZ..=MAX_TICK_HZ).contains(&hz) {
            set_last_error("tick rate must be 1 through 240 Hz");
            return ERR_BAD_ARGUMENT;
        }
        if !state.ui.set_tick_rate(hz) {
            set_last_error("tick rate must be set before the realm ticks");
            return ERR_BAD_STATE;
        }
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_tick(handle: *mut PocketAppleCore) {
    with_core(handle, (), |state| {
        state.ticked = true;
        state.ui.tick();
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_render(
    handle: *mut PocketAppleCore,
    out: *mut PocketAppleFrame,
) -> i32 {
    with_core(handle, ERR_PANIC, |state| {
        if out.is_null() {
            return ERR_BAD_ARGUMENT;
        }
        let words = state.ui.draw().words.clone();
        let plan = match raster::render_scaled_argb_incremental(
            &state.ui,
            &words,
            &mut state.framebuffer,
            state.density,
            &mut state.tracker,
            DamagePolicy::default(),
        ) {
            Ok(plan) => plan,
            Err(_) => {
                raster::render_scaled_argb(&state.ui, &words, &mut state.framebuffer, state.density);
                state.tracker.invalidate();
                pocketjs_core::damage::DamagePlan::full(pocketjs_core::damage::DamageRect::new(
                    0,
                    0,
                    state.logical_width as i32,
                    state.logical_height as i32,
                ))
            }
        };

        let width_px = state.logical_width * state.density;
        let frame = unsafe { &mut *out };
        frame.pixels = state.framebuffer.as_ptr();
        frame.width_px = width_px;
        frame.height_px = state.logical_height * state.density;
        frame.stride_bytes = width_px * 4;
        frame.full_redraw = i32::from(plan.is_full_redraw());
        frame.region_count = plan.region_count().min(POCKET_APPLE_MAX_DAMAGE_REGIONS) as u32;
        frame.regions = [[0; 4]; POCKET_APPLE_MAX_DAMAGE_REGIONS];
        for (slot, rect) in frame.regions.iter_mut().zip(plan.regions()) {
            let scale = state.density as i32;
            *slot = [
                rect.x0.max(0) * scale,
                rect.y0.max(0) * scale,
                (rect.x1 - rect.x0).max(0) * scale,
                (rect.y1 - rect.y0).max(0) * scale,
            ];
        }
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pocket_apple_core_destroy(handle: *mut PocketAppleCore) {
    if handle.is_null() {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        drop(Box::from_raw(handle));
    }));
}
