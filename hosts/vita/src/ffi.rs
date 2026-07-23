//! QuickJS bindings: the `globalThis.ui` namespace — the native-console side of the
//! HostOps contract (contracts/spec/spec.ts OP table; JS caller in framework/src/host.ts).
//!
//! Registration pattern copied from dreamcart runtime/src/gfx.rs register():
//! JS_NewCFunction2 + JS_SetPropertyStr onto a JS_NewObject installed on the
//! global (JS_SetPropertyStr consumes ownership).
//!
//! One `Ui` instance, one JS thread — `static mut` matches the established
//! dreamcart style. All ops are synchronous; the JS renderer keeps a mirror
//! tree so reconciler reads never cross this boundary.
//!
//! Extra (not a spec op): `ui.__textures` — a plain JS object mapping the
//! pak image names (`ui:img.<name>` -> `<name>`) to their upload_texture
//! handles, built at boot from pak::feed's table. framework/src/index.ts's PSP branch
//! walks it and calls renderer.registerTexture(name, handle) so JSX
//! `src="<name>"` resolves.

use alloc::string::String;
use alloc::vec::Vec;

use libquickjs_sys::*;
use pocketjs_core::Ui;

static mut UI: Option<Ui> = None;

/// Create a fresh core for one guest. Replacing an old value is defensive;
/// normal switching calls `reset_ui` during the previous runtime's explicit
/// shutdown.
///
/// # Safety
///
/// Call once per guest on the Vita render thread, with no outstanding reference
/// to the process-global UI.
pub unsafe fn init_ui() -> &'static mut Ui {
    let mut instance = Ui::new_with_raster_density(crate::graphics::RASTER_DENSITY);
    instance.set_viewport(
        crate::graphics::LOGICAL_W as f32,
        crate::graphics::LOGICAL_H as f32,
    );
    UI = Some(instance);
    ui()
}

/// The single core instance. Panics if init_ui was never called.
///
/// # Safety
///
/// The caller must stay on the Vita render thread and must not create another
/// live mutable reference to the global UI.
pub unsafe fn ui() -> &'static mut Ui {
    UI.as_mut().expect("ffi::init_ui not called")
}

/// Drop the outgoing guest's entire retained core (tree, styles, animations,
/// font atlases and CPU texture copies). GPU handles must be retired first.
///
/// # Safety
///
/// Call on the render thread with no outstanding `Ui` reference and only after
/// `graphics::reset_guest` has made the GPU idle.
pub unsafe fn reset_ui() {
    UI = None;
}

// ---------------------------------------------------------------------------
// arg helpers
// ---------------------------------------------------------------------------

#[inline]
/// Read an integer argument from a QuickJS callback.
///
/// # Safety
///
/// `ctx` and the first `argc` entries of `argv` must be valid for the duration
/// of the call.
pub unsafe fn arg_i32(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> i32 {
    if (i as i32) >= argc {
        return 0;
    }
    let mut out: i32 = 0;
    JS_ToInt32(ctx, &mut out, *argv.offset(i));
    out
}

#[inline]
/// Read a floating-point argument from a QuickJS callback.
///
/// # Safety
///
/// `ctx` and the first `argc` entries of `argv` must be valid for the duration
/// of the call.
pub unsafe fn arg_f64(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> f64 {
    if (i as i32) >= argc {
        return 0.0;
    }
    let mut out: f64 = 0.0;
    JS_ToFloat64(ctx, &mut out, *argv.offset(i));
    out
}

/// Borrow the bytes behind an ArrayBuffer OR a typed-array view (host.ts
/// passes Uint8Arrays). The returned pointer is only valid until the next JS
/// allocation — callers must consume it before returning to JS.
unsafe fn buffer_bytes(ctx: *mut JSContext, val: JSValue) -> Option<(*const u8, usize)> {
    let mut len: size_t = 0;
    let p = JS_GetArrayBuffer(ctx, &mut len, val);
    if !p.is_null() {
        return Some((p as *const u8, len));
    }
    // Not an ArrayBuffer: clear the pending TypeError, try `.buffer` +
    // `.byteOffset`/`.byteLength` (typed-array view).
    JS_FreeValue(ctx, JS_GetException(ctx));
    let buf = JS_GetPropertyStr(ctx, val, c"buffer".as_ptr());
    let mut blen: size_t = 0;
    let bp = JS_GetArrayBuffer(ctx, &mut blen, buf);
    // `val` retains its ArrayBuffer, so dropping this extra ref is safe.
    JS_FreeValue(ctx, buf);
    if bp.is_null() {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return None;
    }
    let off_v = JS_GetPropertyStr(ctx, val, c"byteOffset".as_ptr());
    let mut off: i32 = 0;
    JS_ToInt32(ctx, &mut off, off_v);
    JS_FreeValue(ctx, off_v);
    let len_v = JS_GetPropertyStr(ctx, val, c"byteLength".as_ptr());
    let mut vlen: i32 = 0;
    JS_ToInt32(ctx, &mut vlen, len_v);
    JS_FreeValue(ctx, len_v);
    if off < 0 || vlen < 0 || (off as usize) + (vlen as usize) > blen {
        return None;
    }
    Some((bp.add(off as usize) as *const u8, vlen as usize))
}

// ---------------------------------------------------------------------------
// ops
// ---------------------------------------------------------------------------

unsafe extern "C" fn js_create_node(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let t = arg_i32(ctx, argc, argv, 0);
    JS_NewInt32(ctx, ui().create_node(t as u8))
}

unsafe extern "C" fn js_destroy_node(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().destroy_node(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
}

unsafe extern "C" fn js_insert_before(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().insert_before(
        arg_i32(ctx, argc, argv, 0),
        arg_i32(ctx, argc, argv, 1),
        arg_i32(ctx, argc, argv, 2),
    );
    JS_UNDEFINED
}

unsafe extern "C" fn js_remove_child(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().remove_child(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1));
    JS_UNDEFINED
}

unsafe extern "C" fn js_set_style(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().set_style(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1));
    JS_UNDEFINED
}

unsafe extern "C" fn js_set_prop(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().set_prop(
        arg_i32(ctx, argc, argv, 0),
        arg_i32(ctx, argc, argv, 1) as u8,
        arg_f64(ctx, argc, argv, 2),
    );
    JS_UNDEFINED
}

#[inline]
fn read_f64_le(bytes: &[u8], offset: usize) -> f64 {
    let mut raw = [0u8; 8];
    raw.copy_from_slice(&bytes[offset..offset + 8]);
    f64::from_le_bytes(raw)
}

/// Apply packed Float64 triples `[nodeId, propId, value]` through one
/// QuickJS/C boundary. The buffer is borrowed only for this synchronous call.
unsafe extern "C" fn js_set_prop_batch(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_UNDEFINED;
    }
    let Some((ptr, len)) = buffer_bytes(ctx, *argv.offset(0)) else {
        return JS_UNDEFINED;
    };
    let bytes = core::slice::from_raw_parts(ptr, len);
    let instance = ui();
    for record in bytes.chunks_exact(24) {
        instance.set_prop(
            read_f64_le(record, 0) as i32,
            read_f64_le(record, 8) as u8,
            read_f64_le(record, 16),
        );
    }
    JS_UNDEFINED
}

/// Shared body of setText/replaceText (identical core semantics).
unsafe fn set_text_impl(ctx: *mut JSContext, argc: i32, argv: *mut JSValue) -> JSValue {
    if argc < 2 {
        return JS_UNDEFINED;
    }
    let id = arg_i32(ctx, argc, argv, 0);
    let mut len: size_t = 0;
    let s = JS_ToCStringLen2(ctx, &mut len, *argv.offset(1), 0);
    if s.is_null() {
        return JS_UNDEFINED;
    }
    // Lossy: QuickJS encodes lone UTF-16 surrogates (e.g. a string sliced
    // mid-emoji) as WTF-8 bytes that are invalid UTF-8 — they become U+FFFD
    // (matching the web host) instead of silently dropping the whole update.
    let text =
        alloc::string::String::from_utf8_lossy(core::slice::from_raw_parts(s as *const u8, len));
    ui().set_text(id, &text);
    JS_FreeCString(ctx, s);
    JS_UNDEFINED
}

unsafe extern "C" fn js_set_text(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    set_text_impl(ctx, argc, argv)
}

unsafe extern "C" fn js_replace_text(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    set_text_impl(ctx, argc, argv)
}

unsafe extern "C" fn js_upload_texture(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 4 {
        return JS_NewInt32(ctx, -1);
    }
    let Some((p, len)) = buffer_bytes(ctx, *argv.offset(0)) else {
        return JS_NewInt32(ctx, -1);
    };
    let w = arg_i32(ctx, argc, argv, 1);
    let h = arg_i32(ctx, argc, argv, 2);
    let psm = arg_i32(ctx, argc, argv, 3);
    let bytes = core::slice::from_raw_parts(p, len);
    let handle = ui().upload_texture(bytes, w as u32, h as u32, psm as u32);
    if handle >= 0 {
        // GE samples RAM: write the core's aligned copy (pixels + CLUT) back
        // once at upload.
        crate::graphics::register_texture(ui(), handle);
    }
    JS_NewInt32(ctx, handle)
}

/// loadTileTexture(key, index) -> handle | -1 (spec op 23): decode ONE tile
/// of a TILESET pak entry, looked up by key in the embedded pak at runtime
/// (pak::feed skips `ui:tile.*` — tiles stream on demand, they never bulk-
/// load at boot). Missing pak/key and malformed entries all surface as -1.
unsafe extern "C" fn js_load_tile_texture(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 2 {
        return JS_NewInt32(ctx, -1);
    }
    let mut len: size_t = 0;
    let s = JS_ToCStringLen2(ctx, &mut len, *argv.offset(0), 0);
    if s.is_null() {
        return JS_NewInt32(ctx, -1);
    }
    // Pak keys are UTF-8 by construction (framework/compiler/pak.ts); a WTF-8 lone
    // surrogate from JS can't match any entry, so treat it as a miss.
    let handle = match core::str::from_utf8(core::slice::from_raw_parts(s as *const u8, len)) {
        Ok(key) => match crate::pak::find(crate::pak::installed(), key) {
            Some(blob) => ui().upload_tileset_tile(blob, arg_i32(ctx, argc, argv, 1) as u32),
            None => -1,
        },
        Err(_) => -1,
    };
    JS_FreeCString(ctx, s);
    if handle >= 0 {
        crate::graphics::register_texture(ui(), handle);
    }
    JS_NewInt32(ctx, handle)
}

/// freeTexture(handle) (spec op 24). Stale/unknown handles are no-ops in the
/// core, so no validation here.
unsafe extern "C" fn js_free_texture(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let handle = arg_i32(ctx, argc, argv, 0);
    crate::graphics::free_texture(handle);
    ui().free_texture(handle);
    JS_UNDEFINED
}

/// uploadImgEntry(blob) -> handle | -1 (spec op 25): a self-contained IMG
/// pak entry (header + flags + pixel stream), the dynamic-image counterpart
/// of the boot-time `ui:img.*` feed.
unsafe extern "C" fn js_upload_img_entry(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_NewInt32(ctx, -1);
    }
    let Some((p, len)) = buffer_bytes(ctx, *argv.offset(0)) else {
        return JS_NewInt32(ctx, -1);
    };
    let handle = ui().upload_img_entry(core::slice::from_raw_parts(p, len));
    if handle >= 0 {
        crate::graphics::register_texture(ui(), handle);
    }
    JS_NewInt32(ctx, handle)
}

unsafe extern "C" fn js_set_image(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().set_image(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1));
    JS_UNDEFINED
}

unsafe extern "C" fn js_set_sprite(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().set_sprite(
        arg_i32(ctx, argc, argv, 0),
        arg_i32(ctx, argc, argv, 1),
        arg_i32(ctx, argc, argv, 2) as u32,
        arg_i32(ctx, argc, argv, 3) as u32,
        arg_i32(ctx, argc, argv, 4) as u32,
    );
    JS_UNDEFINED
}

unsafe extern "C" fn js_animate(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let id = arg_i32(ctx, argc, argv, 0);
    let prop = arg_i32(ctx, argc, argv, 1) as u8;
    let to = arg_f64(ctx, argc, argv, 2);
    let dur = arg_i32(ctx, argc, argv, 3).max(0) as u32;
    let easing = arg_i32(ctx, argc, argv, 4) as u8;
    let delay = arg_i32(ctx, argc, argv, 5).max(0) as u32;
    JS_NewInt32(ctx, ui().animate(id, prop, to, dur, easing, delay))
}

unsafe extern "C" fn js_cancel_anim(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().cancel_anim(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
}

unsafe extern "C" fn js_set_focus(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().set_focus(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
}

unsafe extern "C" fn js_set_active(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().set_active(
        arg_i32(ctx, argc, argv, 0),
        arg_i32(ctx, argc, argv, 1) != 0,
    );
    JS_UNDEFINED
}

// Virtual cursor ops (spec ops 27..29, input.cursor).

unsafe extern "C" fn js_hit_test(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let id = ui().hit_test(
        arg_f64(ctx, argc, argv, 0) as f32,
        arg_f64(ctx, argc, argv, 1) as f32,
    );
    JS_NewInt32(ctx, id)
}

unsafe extern "C" fn js_set_cursor(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().set_cursor(
        arg_i32(ctx, argc, argv, 0),
        arg_f64(ctx, argc, argv, 1) as f32,
        arg_f64(ctx, argc, argv, 2) as f32,
        arg_f64(ctx, argc, argv, 3) as f32,
        arg_f64(ctx, argc, argv, 4) as f32,
    );
    JS_UNDEFINED
}

unsafe extern "C" fn js_set_cursor_pos(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().set_cursor_pos(
        arg_f64(ctx, argc, argv, 0) as f32,
        arg_f64(ctx, argc, argv, 1) as f32,
    );
    JS_UNDEFINED
}

/// Normally fed natively at boot (pak.rs feeds the core natively before eval), but
/// registered so the full HostOps surface exists. Returns bool.
unsafe extern "C" fn js_load_styles(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_NewBool(ctx, false);
    }
    let Some((p, len)) = buffer_bytes(ctx, *argv.offset(0)) else {
        return JS_NewBool(ctx, false);
    };
    let ok = ui().load_styles(core::slice::from_raw_parts(p, len));
    JS_NewBool(ctx, ok)
}

unsafe extern "C" fn js_load_font_atlas(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_NewBool(ctx, false);
    }
    let Some((p, len)) = buffer_bytes(ctx, *argv.offset(0)) else {
        return JS_NewBool(ctx, false);
    };
    let bytes = core::slice::from_raw_parts(p, len);
    let ok = ui().load_font_atlas(bytes);
    if ok {
        let slot = bytes.get(12).copied().unwrap_or(0);
        if let Some(atlas) = ui().font_atlas(slot) {
            crate::graphics::register_font_atlas(slot, atlas);
        }
    }
    JS_NewBool(ctx, ok)
}

unsafe extern "C" fn js_measure_text(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_NewFloat64(ctx, 0.0);
    }
    let mut len: size_t = 0;
    let s = JS_ToCStringLen2(ctx, &mut len, *argv.offset(0), 0);
    if s.is_null() {
        return JS_NewFloat64(ctx, 0.0);
    }
    let slot = arg_i32(ctx, argc, argv, 1) as u8;
    // Lossy for the same reason as set_text_impl: lone surrogates -> U+FFFD.
    let text =
        alloc::string::String::from_utf8_lossy(core::slice::from_raw_parts(s as *const u8, len));
    let width = ui().measure_text(&text, slot);
    JS_FreeCString(ctx, s);
    JS_NewFloat64(ctx, width as f64)
}

// ---------------------------------------------------------------------------
// DevTools (spec ops 18..22 + the mailbox transport; docs/DEVTOOLS.md)
// ---------------------------------------------------------------------------

// libquickjs-sys omits JS_NewStringLen; the linked QuickJS C library provides
// it (same local-extern pattern as main.rs's JS_NewArrayBuffer).
extern "C" {
    fn JS_NewStringLen(ctx: *mut JSContext, str1: *const u8, len1: usize) -> JSValue;
}

unsafe extern "C" fn js_debug_inspect(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().debug_inspect(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
}

unsafe extern "C" fn js_debug_rect_xy(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    JS_NewInt32(ctx, ui().debug_rect_xy())
}

unsafe extern "C" fn js_debug_rect_wh(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    JS_NewInt32(ctx, ui().debug_rect_wh())
}

unsafe extern "C" fn js_debug_pause(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().debug_pause(arg_i32(ctx, argc, argv, 0) != 0);
    JS_UNDEFINED
}

unsafe extern "C" fn js_debug_step(
    _ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    ui().debug_step();
    JS_UNDEFINED
}

/// ui.__dbgActive() -> bool: whether the PSPLINK/memstick mailbox was found
/// at boot (dbg::init). The JS shim only builds a transport when true.
unsafe extern "C" fn js_dbg_active(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    JS_NewBool(ctx, crate::dbg::active())
}

/// ui.__dbgPoll() -> string | undefined: new complete JSON lines from the
/// bridge (may batch several). The shim rate-limits calls to ~every 10
/// frames; each call is a few sceIo round trips over usbhostfs.
unsafe extern "C" fn js_dbg_poll(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    match crate::dbg::poll() {
        Some(s) => JS_NewStringLen(ctx, s.as_ptr(), s.len()),
        None => JS_UNDEFINED,
    }
}

/// ui.__dbgShot() -> bool: dump the displayed framebuffer to
/// pocketjs-dbg/shot.raw (the bridge converts it to PNG panel-side).
unsafe extern "C" fn js_dbg_shot(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    JS_NewBool(ctx, crate::dbg::shot())
}

/// ui.__dbgSend(line): append one JSON line to the outbound mailbox.
unsafe extern "C" fn js_dbg_send(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc >= 1 {
        let mut len: size_t = 0;
        let s = JS_ToCStringLen2(ctx, &mut len, *argv.offset(0), 0);
        if !s.is_null() {
            crate::dbg::send(core::slice::from_raw_parts(s as *const u8, len));
            JS_FreeCString(ctx, s);
        }
    }
    JS_UNDEFINED
}

/// ui.appTable() -> JSON snapshot (spec op 39).
unsafe extern "C" fn js_app_table(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    let value = crate::switch::table_json();
    JS_NewStringLen(ctx, value.as_ptr(), value.len())
}

/// ui.appLaunch(output) -> 0|1 (spec op 40). The request is only recorded
/// here; main swaps guests after this frame has rendered and presented.
unsafe extern "C" fn js_app_launch(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_NewInt32(ctx, 0);
    }
    let mut len: size_t = 0;
    let raw = JS_ToCStringLen2(ctx, &mut len, *argv.offset(0), 0);
    if raw.is_null() {
        return JS_NewInt32(ctx, 0);
    }
    let scheduled = core::str::from_utf8(core::slice::from_raw_parts(raw as *const u8, len))
        .ok()
        .and_then(crate::switch::find);
    JS_FreeCString(ctx, raw);
    if let Some(index) = scheduled {
        crate::switch::request_launch(index);
        JS_NewInt32(ctx, 1)
    } else {
        JS_NewInt32(ctx, 0)
    }
}

/// ui.appShot() -> frozen-frame texture handle or -1 (spec op 41).
unsafe extern "C" fn js_app_shot(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    JS_NewInt32(ctx, crate::switch::shot_handle())
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

/// Register one C function onto a JS object (shared by extra surfaces
/// like OpenStrike's `strike` namespace).
///
/// # Safety
///
/// `ctx` and `obj` must belong to the active QuickJS realm, `name` must be
/// NUL-terminated, and `f` must obey the QuickJS callback ABI.
pub unsafe fn add_fn(
    ctx: *mut JSContext,
    obj: JSValue,
    name: &'static [u8], // NUL-terminated
    f: unsafe extern "C" fn(*mut JSContext, JSValue, i32, *mut JSValue) -> JSValue,
    nargs: i32,
) {
    let v = JS_NewCFunction2(
        ctx,
        Some(f),
        name.as_ptr() as *const _,
        nargs,
        JS_CFUNC_generic,
        0,
    );
    JS_SetPropertyStr(ctx, obj, name.as_ptr() as *const _, v);
}

/// Install `globalThis.ui` (full HostOps surface + `__textures` + `__sprites`).
/// `textures` and `sprites` come from pak::feed.
///
/// # Safety
///
/// `ctx` and `global` must be live values from the same QuickJS realm, and
/// registration must run once on its owning thread.
pub unsafe fn register(
    ctx: *mut JSContext,
    global: JSValue,
    textures: &[(String, i32)],
    sprites: &[crate::pak::SpriteReg],
) {
    let ui_obj = JS_NewObject(ctx);

    add_fn(ctx, ui_obj, b"createNode\0", js_create_node, 1);
    add_fn(ctx, ui_obj, b"destroyNode\0", js_destroy_node, 1);
    add_fn(ctx, ui_obj, b"insertBefore\0", js_insert_before, 3);
    add_fn(ctx, ui_obj, b"removeChild\0", js_remove_child, 2);
    add_fn(ctx, ui_obj, b"setStyle\0", js_set_style, 2);
    add_fn(ctx, ui_obj, b"setProp\0", js_set_prop, 3);
    add_fn(ctx, ui_obj, b"setPropBatch\0", js_set_prop_batch, 1);
    add_fn(ctx, ui_obj, b"setText\0", js_set_text, 2);
    add_fn(ctx, ui_obj, b"replaceText\0", js_replace_text, 2);
    add_fn(ctx, ui_obj, b"uploadTexture\0", js_upload_texture, 4);
    add_fn(ctx, ui_obj, b"setImage\0", js_set_image, 2);
    add_fn(ctx, ui_obj, b"setSprite\0", js_set_sprite, 5);
    add_fn(ctx, ui_obj, b"animate\0", js_animate, 6);
    add_fn(ctx, ui_obj, b"cancelAnim\0", js_cancel_anim, 1);
    add_fn(ctx, ui_obj, b"setFocus\0", js_set_focus, 1);
    add_fn(ctx, ui_obj, b"setActive\0", js_set_active, 2);
    // Virtual cursor ops (spec ops 27..29, input.cursor).
    add_fn(ctx, ui_obj, b"hitTest\0", js_hit_test, 2);
    add_fn(ctx, ui_obj, b"setCursor\0", js_set_cursor, 5);
    add_fn(ctx, ui_obj, b"setCursorPos\0", js_set_cursor_pos, 2);
    add_fn(ctx, ui_obj, b"loadStyles\0", js_load_styles, 1);
    add_fn(ctx, ui_obj, b"loadFontAtlas\0", js_load_font_atlas, 1);
    add_fn(ctx, ui_obj, b"measureText\0", js_measure_text, 2);
    // DevTools ops + mailbox transport (docs/DEVTOOLS.md; debug-only, default-off).
    add_fn(ctx, ui_obj, b"debugInspect\0", js_debug_inspect, 1);
    add_fn(ctx, ui_obj, b"debugRectXY\0", js_debug_rect_xy, 0);
    add_fn(ctx, ui_obj, b"debugRectWH\0", js_debug_rect_wh, 0);
    add_fn(ctx, ui_obj, b"debugPause\0", js_debug_pause, 1);
    add_fn(ctx, ui_obj, b"debugStep\0", js_debug_step, 0);
    // Texture streaming ops (spec ops 23..25: deep-zoom tiles + dynamic IMGs).
    add_fn(ctx, ui_obj, b"loadTileTexture\0", js_load_tile_texture, 2);
    add_fn(ctx, ui_obj, b"freeTexture\0", js_free_texture, 1);
    add_fn(ctx, ui_obj, b"uploadImgEntry\0", js_upload_img_entry, 1);
    add_fn(ctx, ui_obj, b"__dbgActive\0", js_dbg_active, 0);
    add_fn(ctx, ui_obj, b"__dbgPoll\0", js_dbg_poll, 0);
    add_fn(ctx, ui_obj, b"__dbgSend\0", js_dbg_send, 1);
    add_fn(ctx, ui_obj, b"__dbgShot\0", js_dbg_shot, 0);
    // Optional launcher surface. Single-app VPKs omit these ops and preserve
    // the framework's documented degraded behavior.
    if crate::switch::multi() {
        add_fn(ctx, ui_obj, b"appTable\0", js_app_table, 0);
        add_fn(ctx, ui_obj, b"appLaunch\0", js_app_launch, 1);
        add_fn(ctx, ui_obj, b"appShot\0", js_app_shot, 0);
    }

    // Framework-owned host identity. The bundle rejects a VPK assembled for a
    // different target or HostOps ABI before app code mounts. planHash is a
    // build-time checksum and intentionally does not enter runtime handshake.
    let target = env!("POCKETJS_TARGET");
    JS_SetPropertyStr(
        ctx,
        ui_obj,
        c"__host".as_ptr(),
        JS_NewStringLen(ctx, target.as_ptr(), target.len()),
    );
    let host_abi = env!("POCKETJS_HOST_ABI").parse::<i32>().unwrap_or_default();
    JS_SetPropertyStr(
        ctx,
        ui_obj,
        c"__hostAbi".as_ptr(),
        JS_NewInt32(ctx, host_abi),
    );

    // Logical coordinates are part of the same resolved plan. Publishing
    // them keeps the JS root layer and native core viewport in lockstep.
    let viewport = JS_NewObject(ctx);
    JS_SetPropertyStr(
        ctx,
        viewport,
        c"w".as_ptr(),
        JS_NewInt32(ctx, crate::graphics::LOGICAL_W),
    );
    JS_SetPropertyStr(
        ctx,
        viewport,
        c"h".as_ptr(),
        JS_NewInt32(ctx, crate::graphics::LOGICAL_H),
    );
    JS_SetPropertyStr(ctx, ui_obj, c"__viewport".as_ptr(), viewport);

    // ui.__textures: pak image name -> texture handle (see module docs).
    let tex_obj = JS_NewObject(ctx);
    for (name, handle) in textures {
        let mut cname: Vec<u8> = Vec::with_capacity(name.len() + 1);
        cname.extend_from_slice(name.as_bytes());
        cname.push(0);
        JS_SetPropertyStr(
            ctx,
            tex_obj,
            cname.as_ptr() as *const _,
            JS_NewInt32(ctx, *handle),
        );
    }
    JS_SetPropertyStr(ctx, ui_obj, c"__textures".as_ptr(), tex_obj);

    // ui.__sprites: pak sprite name -> { handle, frames, cols, step }. The JS
    // runtime (framework/src/index.ts) reads these and registerSprite()s them; <Sprite>
    // then binds via setSprite. Same feed-once-at-boot pattern as __textures.
    let spr_obj = JS_NewObject(ctx);
    for s in sprites {
        let mut cname: Vec<u8> = Vec::with_capacity(s.name.len() + 1);
        cname.extend_from_slice(s.name.as_bytes());
        cname.push(0);
        let meta = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, meta, c"handle".as_ptr(), JS_NewInt32(ctx, s.handle));
        JS_SetPropertyStr(
            ctx,
            meta,
            c"frames".as_ptr(),
            JS_NewInt32(ctx, s.frames as i32),
        );
        JS_SetPropertyStr(ctx, meta, c"cols".as_ptr(), JS_NewInt32(ctx, s.cols as i32));
        JS_SetPropertyStr(ctx, meta, c"step".as_ptr(), JS_NewInt32(ctx, s.step as i32));
        JS_SetPropertyStr(ctx, spr_obj, cname.as_ptr() as *const _, meta);
    }
    JS_SetPropertyStr(ctx, ui_obj, c"__sprites".as_ptr(), spr_obj);

    // JS_SetPropertyStr consumes ownership of ui_obj.
    JS_SetPropertyStr(ctx, global, c"ui".as_ptr(), ui_obj);
}
