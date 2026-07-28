//! QuickJS `globalThis.ui` bindings for the classic ESP32 host.

use alloc::string::String;

use libquickjs_sys::*;
use pocketjs_core::Ui;

static mut UI: Option<Ui> = None;

pub unsafe fn init(width: f32, height: f32) -> &'static mut Ui {
    UI = Some(Ui::new_with_raster_density(1));
    let instance = ui();
    instance.set_viewport(width, height);
    instance
}

pub unsafe fn clear() {
    UI = None;
}

pub unsafe fn ui() -> &'static mut Ui {
    UI.as_mut().expect("PocketJS UI is not initialized")
}

#[inline]
unsafe fn arg_i32(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, index: isize) -> i32 {
    if index as i32 >= argc {
        return 0;
    }
    let mut value = 0;
    JS_ToInt32(ctx, &mut value, *argv.offset(index));
    value
}

#[inline]
unsafe fn arg_f64(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, index: isize) -> f64 {
    if index as i32 >= argc {
        return 0.0;
    }
    let mut value = 0.0;
    JS_ToFloat64(ctx, &mut value, *argv.offset(index));
    value
}

unsafe fn buffer_bytes(ctx: *mut JSContext, value: JSValue) -> Option<(*const u8, usize)> {
    let mut len: size_t = 0;
    let pointer = JS_GetArrayBuffer(ctx, &mut len, value);
    if !pointer.is_null() {
        return Some((pointer.cast_const(), len));
    }
    JS_FreeValue(ctx, JS_GetException(ctx));
    let buffer = JS_GetPropertyStr(ctx, value, b"buffer\0".as_ptr().cast());
    let mut buffer_len: size_t = 0;
    let buffer_pointer = JS_GetArrayBuffer(ctx, &mut buffer_len, buffer);
    JS_FreeValue(ctx, buffer);
    if buffer_pointer.is_null() {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return None;
    }
    let offset_value = JS_GetPropertyStr(ctx, value, b"byteOffset\0".as_ptr().cast());
    let mut offset = 0;
    JS_ToInt32(ctx, &mut offset, offset_value);
    JS_FreeValue(ctx, offset_value);
    let length_value = JS_GetPropertyStr(ctx, value, b"byteLength\0".as_ptr().cast());
    let mut view_len = 0;
    JS_ToInt32(ctx, &mut view_len, length_value);
    JS_FreeValue(ctx, length_value);
    if offset < 0 || view_len < 0 || offset as usize + view_len as usize > buffer_len {
        return None;
    }
    Some((buffer_pointer.add(offset as usize).cast_const(), view_len as usize))
}

#[inline]
fn read_f64_le(bytes: &[u8], offset: usize) -> f64 {
    let mut raw = [0u8; 8];
    raw.copy_from_slice(&bytes[offset..offset + 8]);
    f64::from_le_bytes(raw)
}

unsafe extern "C" fn create_node(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    JS_NewInt32(ctx, ui().create_node(arg_i32(ctx, argc, argv, 0) as u8))
}

unsafe extern "C" fn destroy_node(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().destroy_node(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
}

unsafe extern "C" fn insert_before(
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

unsafe extern "C" fn remove_child(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().remove_child(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1));
    JS_UNDEFINED
}

unsafe extern "C" fn set_style(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().set_style(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1));
    JS_UNDEFINED
}

unsafe extern "C" fn set_prop(
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

unsafe extern "C" fn set_prop_batch(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_UNDEFINED;
    }
    let Some((pointer, len)) = buffer_bytes(ctx, *argv) else {
        return JS_UNDEFINED;
    };
    let instance = ui();
    for record in core::slice::from_raw_parts(pointer, len).chunks_exact(24) {
        instance.set_prop(
            read_f64_le(record, 0) as i32,
            read_f64_le(record, 8) as u8,
            read_f64_le(record, 16),
        );
    }
    JS_UNDEFINED
}

unsafe fn set_text_body(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, replace: bool) {
    if argc < 2 {
        return;
    }
    let id = arg_i32(ctx, argc, argv, 0);
    let mut len = 0;
    let pointer = JS_ToCStringLen2(ctx, &mut len, *argv.offset(1), 0);
    if pointer.is_null() {
        return;
    }
    let value = String::from_utf8_lossy(core::slice::from_raw_parts(pointer.cast(), len));
    if replace {
        ui().replace_text(id, &value);
    } else {
        ui().set_text(id, &value);
    }
    JS_FreeCString(ctx, pointer);
}

unsafe extern "C" fn set_text(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    set_text_body(ctx, argc, argv, false);
    JS_UNDEFINED
}

unsafe extern "C" fn replace_text(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    set_text_body(ctx, argc, argv, true);
    JS_UNDEFINED
}

unsafe extern "C" fn upload_texture(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 4 {
        return JS_NewInt32(ctx, -1);
    }
    let Some((pointer, len)) = buffer_bytes(ctx, *argv) else {
        return JS_NewInt32(ctx, -1);
    };
    let handle = ui().upload_texture(
        core::slice::from_raw_parts(pointer, len),
        arg_i32(ctx, argc, argv, 1) as u32,
        arg_i32(ctx, argc, argv, 2) as u32,
        arg_i32(ctx, argc, argv, 3) as u32,
    );
    JS_NewInt32(ctx, handle)
}

unsafe extern "C" fn upload_img_entry(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_NewInt32(ctx, -1);
    }
    let Some((pointer, len)) = buffer_bytes(ctx, *argv) else {
        return JS_NewInt32(ctx, -1);
    };
    JS_NewInt32(ctx, ui().upload_img_entry(core::slice::from_raw_parts(pointer, len)))
}

unsafe extern "C" fn free_texture(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().free_texture(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
}

unsafe extern "C" fn set_image(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().set_image(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1));
    JS_UNDEFINED
}

unsafe extern "C" fn set_sprite(
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

unsafe extern "C" fn animate(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    JS_NewInt32(
        ctx,
        ui().animate(
            arg_i32(ctx, argc, argv, 0),
            arg_i32(ctx, argc, argv, 1) as u8,
            arg_f64(ctx, argc, argv, 2),
            arg_i32(ctx, argc, argv, 3).max(0) as u32,
            arg_i32(ctx, argc, argv, 4) as u8,
            arg_i32(ctx, argc, argv, 5).max(0) as u32,
        ),
    )
}

unsafe extern "C" fn cancel_anim(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().cancel_anim(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
}

unsafe extern "C" fn set_focus(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().set_focus(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
}

unsafe extern "C" fn set_active(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    ui().set_active(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1) != 0);
    JS_UNDEFINED
}

unsafe extern "C" fn hit_test(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    JS_NewInt32(
        ctx,
        ui().hit_test(
            arg_f64(ctx, argc, argv, 0) as f32,
            arg_f64(ctx, argc, argv, 1) as f32,
        ),
    )
}

unsafe extern "C" fn set_cursor(
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

unsafe extern "C" fn set_cursor_pos(
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

unsafe extern "C" fn load_styles(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_NewBool(ctx, false);
    }
    let Some((pointer, len)) = buffer_bytes(ctx, *argv) else {
        return JS_NewBool(ctx, false);
    };
    JS_NewBool(ctx, ui().load_styles(core::slice::from_raw_parts(pointer, len)))
}

unsafe extern "C" fn load_font_atlas(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_NewBool(ctx, false);
    }
    let Some((pointer, len)) = buffer_bytes(ctx, *argv) else {
        return JS_NewBool(ctx, false);
    };
    JS_NewBool(ctx, ui().load_font_atlas(core::slice::from_raw_parts(pointer, len)))
}

unsafe extern "C" fn measure_text(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_NewFloat64(ctx, 0.0);
    }
    let mut len = 0;
    let pointer = JS_ToCStringLen2(ctx, &mut len, *argv, 0);
    if pointer.is_null() {
        return JS_NewFloat64(ctx, 0.0);
    }
    let value = String::from_utf8_lossy(core::slice::from_raw_parts(pointer.cast(), len));
    let width = ui().measure_text(&value, arg_i32(ctx, argc, argv, 1) as u8);
    JS_FreeCString(ctx, pointer);
    JS_NewFloat64(ctx, width as f64)
}

pub unsafe fn add_fn(
    ctx: *mut JSContext,
    object: JSValue,
    name: &'static [u8],
    callback: unsafe extern "C" fn(*mut JSContext, JSValue, i32, *mut JSValue) -> JSValue,
    argc: i32,
) {
    let function = JS_NewCFunction2(
        ctx,
        Some(callback),
        name.as_ptr().cast(),
        argc,
        JS_CFUNC_generic,
        0,
    );
    JS_SetPropertyStr(ctx, object, name.as_ptr().cast(), function);
}

extern "C" {
    fn JS_NewStringLen(ctx: *mut JSContext, value: *const u8, len: usize) -> JSValue;
}

pub unsafe fn register(ctx: *mut JSContext, global: JSValue) {
    let object = JS_NewObject(ctx);
    add_fn(ctx, object, b"createNode\0", create_node, 1);
    add_fn(ctx, object, b"destroyNode\0", destroy_node, 1);
    add_fn(ctx, object, b"insertBefore\0", insert_before, 3);
    add_fn(ctx, object, b"removeChild\0", remove_child, 2);
    add_fn(ctx, object, b"setStyle\0", set_style, 2);
    add_fn(ctx, object, b"setProp\0", set_prop, 3);
    add_fn(ctx, object, b"setPropBatch\0", set_prop_batch, 1);
    add_fn(ctx, object, b"setText\0", set_text, 2);
    add_fn(ctx, object, b"replaceText\0", replace_text, 2);
    add_fn(ctx, object, b"uploadTexture\0", upload_texture, 4);
    add_fn(ctx, object, b"uploadImgEntry\0", upload_img_entry, 1);
    add_fn(ctx, object, b"freeTexture\0", free_texture, 1);
    add_fn(ctx, object, b"setImage\0", set_image, 2);
    add_fn(ctx, object, b"setSprite\0", set_sprite, 5);
    add_fn(ctx, object, b"animate\0", animate, 6);
    add_fn(ctx, object, b"cancelAnim\0", cancel_anim, 1);
    add_fn(ctx, object, b"setFocus\0", set_focus, 1);
    add_fn(ctx, object, b"setActive\0", set_active, 2);
    add_fn(ctx, object, b"hitTest\0", hit_test, 2);
    add_fn(ctx, object, b"setCursor\0", set_cursor, 5);
    add_fn(ctx, object, b"setCursorPos\0", set_cursor_pos, 2);
    add_fn(ctx, object, b"loadStyles\0", load_styles, 1);
    add_fn(ctx, object, b"loadFontAtlas\0", load_font_atlas, 1);
    add_fn(ctx, object, b"measureText\0", measure_text, 2);

    JS_SetPropertyStr(
        ctx,
        object,
        b"__host\0".as_ptr().cast(),
        JS_NewStringLen(ctx, b"esp32".as_ptr(), 5),
    );
    JS_SetPropertyStr(ctx, object, b"__hostAbi\0".as_ptr().cast(), JS_NewInt32(ctx, 1));
    // Presence of this table marks the namespace as native and tells the
    // framework resources were fed directly from the immutable pak.
    JS_SetPropertyStr(ctx, object, b"__textures\0".as_ptr().cast(), JS_NewObject(ctx));
    JS_SetPropertyStr(ctx, object, b"__sprites\0".as_ptr().cast(), JS_NewObject(ctx));
    JS_SetPropertyStr(ctx, global, b"ui\0".as_ptr().cast(), object);
}
