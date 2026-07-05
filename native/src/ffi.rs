//! QuickJS bindings: the `globalThis.ui` namespace — the PSP side of the
//! HostOps contract (spec/spec.ts OP table; JS caller in src/host.ts).
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
//! handles, built at boot from pak::feed's table. src/index.ts's PSP branch
//! walks it and calls renderer.registerTexture(name, handle) so JSX
//! `src="<name>"` resolves.

use alloc::string::String;
use alloc::vec::Vec;
use core::ffi::c_void;

use libquickjs_sys::*;
use pocketjs_core::Ui;

static mut UI: Option<Ui> = None;

/// Create the single core instance (call once, on the worker thread, AFTER
/// the arena-backed global allocator is linked in — Ui::new allocates).
pub unsafe fn init_ui() -> &'static mut Ui {
    UI = Some(Ui::new());
    ui()
}

/// The single core instance. Panics if init_ui was never called.
pub unsafe fn ui() -> &'static mut Ui {
    UI.as_mut().expect("ffi::init_ui not called")
}

// ---------------------------------------------------------------------------
// arg helpers
// ---------------------------------------------------------------------------

#[inline]
unsafe fn arg_i32(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> i32 {
    if (i as i32) >= argc {
        return 0;
    }
    let mut out: i32 = 0;
    JS_ToInt32(ctx, &mut out, *argv.offset(i));
    out
}

#[inline]
unsafe fn arg_f64(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> f64 {
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
    let buf = JS_GetPropertyStr(ctx, val, b"buffer\0".as_ptr() as *const _);
    let mut blen: size_t = 0;
    let bp = JS_GetArrayBuffer(ctx, &mut blen, buf);
    // `val` retains its ArrayBuffer, so dropping this extra ref is safe.
    JS_FreeValue(ctx, buf);
    if bp.is_null() {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return None;
    }
    let off_v = JS_GetPropertyStr(ctx, val, b"byteOffset\0".as_ptr() as *const _);
    let mut off: i32 = 0;
    JS_ToInt32(ctx, &mut off, off_v);
    JS_FreeValue(ctx, off_v);
    let len_v = JS_GetPropertyStr(ctx, val, b"byteLength\0".as_ptr() as *const _);
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
        // GE samples RAM: write the core's aligned copy back once at upload.
        if let Some((px, _, _, _)) = ui().texture(handle) {
            psp::sys::sceKernelDcacheWritebackRange(px.as_ptr() as *const c_void, px.len() as u32);
        }
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

/// Not used on PSP (pak.rs feeds the core natively before eval), but
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
    let ok = ui().load_font_atlas(core::slice::from_raw_parts(p, len));
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
// registration
// ---------------------------------------------------------------------------

unsafe fn add_fn(
    ctx: *mut JSContext,
    obj: JSValue,
    name: &'static [u8], // NUL-terminated
    f: unsafe extern "C" fn(*mut JSContext, JSValue, i32, *mut JSValue) -> JSValue,
    nargs: i32,
) {
    let v = JS_NewCFunction2(ctx, Some(f), name.as_ptr() as *const _, nargs, JS_CFUNC_generic, 0);
    JS_SetPropertyStr(ctx, obj, name.as_ptr() as *const _, v);
}

/// Install `globalThis.ui` (full HostOps surface + `__textures` + `__sprites`).
/// `textures` and `sprites` come from pak::feed.
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
    add_fn(ctx, ui_obj, b"setText\0", js_set_text, 2);
    add_fn(ctx, ui_obj, b"replaceText\0", js_replace_text, 2);
    add_fn(ctx, ui_obj, b"uploadTexture\0", js_upload_texture, 4);
    add_fn(ctx, ui_obj, b"setImage\0", js_set_image, 2);
    add_fn(ctx, ui_obj, b"setSprite\0", js_set_sprite, 5);
    add_fn(ctx, ui_obj, b"animate\0", js_animate, 6);
    add_fn(ctx, ui_obj, b"cancelAnim\0", js_cancel_anim, 1);
    add_fn(ctx, ui_obj, b"setFocus\0", js_set_focus, 1);
    add_fn(ctx, ui_obj, b"loadStyles\0", js_load_styles, 1);
    add_fn(ctx, ui_obj, b"loadFontAtlas\0", js_load_font_atlas, 1);
    add_fn(ctx, ui_obj, b"measureText\0", js_measure_text, 2);

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
    JS_SetPropertyStr(ctx, ui_obj, b"__textures\0".as_ptr() as *const _, tex_obj);

    // ui.__sprites: pak sprite name -> { handle, frames, cols, step }. The JS
    // runtime (src/index.ts) reads these and registerSprite()s them; <Sprite>
    // then binds via setSprite. Same feed-once-at-boot pattern as __textures.
    let spr_obj = JS_NewObject(ctx);
    for s in sprites {
        let mut cname: Vec<u8> = Vec::with_capacity(s.name.len() + 1);
        cname.extend_from_slice(s.name.as_bytes());
        cname.push(0);
        let meta = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, meta, b"handle\0".as_ptr() as *const _, JS_NewInt32(ctx, s.handle));
        JS_SetPropertyStr(ctx, meta, b"frames\0".as_ptr() as *const _, JS_NewInt32(ctx, s.frames as i32));
        JS_SetPropertyStr(ctx, meta, b"cols\0".as_ptr() as *const _, JS_NewInt32(ctx, s.cols as i32));
        JS_SetPropertyStr(ctx, meta, b"step\0".as_ptr() as *const _, JS_NewInt32(ctx, s.step as i32));
        JS_SetPropertyStr(ctx, spr_obj, cname.as_ptr() as *const _, meta);
    }
    JS_SetPropertyStr(ctx, ui_obj, b"__sprites\0".as_ptr() as *const _, spr_obj);

    // JS_SetPropertyStr consumes ownership of ui_obj.
    JS_SetPropertyStr(ctx, global, b"ui\0".as_ptr() as *const _, ui_obj);
}
