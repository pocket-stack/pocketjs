use alloc::string::String;
use alloc::vec::Vec;

use libquickjs_sys::*;
use pocketjs_core::Ui;

use crate::pak::SpriteReg;

static mut UI: Option<Ui> = None;
static mut PAK: &[u8] = &[];

pub unsafe fn init_ui() -> &'static mut Ui {
    UI = Some(Ui::new());
    let ui = UI.as_mut().unwrap();
    ui.set_viewport(320.0, 240.0);
    ui
}

pub unsafe fn drop_ui() {
    UI = None;
    PAK = &[];
}

pub unsafe fn ui() -> &'static mut Ui {
    UI.as_mut().expect("SF2000 UI is not initialized")
}

pub unsafe fn install_pak(pak: &'static [u8]) {
    PAK = pak;
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
    let mut len = 0;
    let direct = JS_GetArrayBuffer(ctx, &mut len, value);
    if !direct.is_null() {
        return Some((direct, len));
    }
    JS_FreeValue(ctx, JS_GetException(ctx));
    let buffer = JS_GetPropertyStr(ctx, value, b"buffer\0".as_ptr().cast());
    let mut buffer_len = 0;
    let base = JS_GetArrayBuffer(ctx, &mut buffer_len, buffer);
    JS_FreeValue(ctx, buffer);
    if base.is_null() {
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
    Some((base.add(offset as usize), view_len as usize))
}

macro_rules! op {
    ($name:ident($ctx:ident, $argc:ident, $argv:ident) $body:block) => {
        unsafe extern "C" fn $name(
            $ctx: *mut JSContext,
            _this: JSValue,
            $argc: i32,
            $argv: *mut JSValue,
        ) -> JSValue $body
    };
}

op!(create_node(ctx, argc, argv) {
    JS_NewInt32(ctx, ui().create_node(arg_i32(ctx, argc, argv, 0) as u8))
});
op!(destroy_node(ctx, argc, argv) {
    ui().destroy_node(arg_i32(ctx, argc, argv, 0)); JS_UNDEFINED
});
op!(insert_before(ctx, argc, argv) {
    ui().insert_before(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1), arg_i32(ctx, argc, argv, 2)); JS_UNDEFINED
});
op!(remove_child(ctx, argc, argv) {
    ui().remove_child(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1)); JS_UNDEFINED
});
op!(set_style(ctx, argc, argv) {
    ui().set_style(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1)); JS_UNDEFINED
});
op!(set_prop(ctx, argc, argv) {
    ui().set_prop(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1) as u8, arg_f64(ctx, argc, argv, 2)); JS_UNDEFINED
});
op!(set_prop_batch(ctx, argc, argv) {
    if argc > 0 {
        if let Some((ptr, len)) = buffer_bytes(ctx, *argv) {
            for record in core::slice::from_raw_parts(ptr, len).chunks_exact(24) {
                let read = |offset| {
                    let mut raw = [0u8; 8];
                    raw.copy_from_slice(&record[offset..offset + 8]);
                    f64::from_le_bytes(raw)
                };
                ui().set_prop(read(0) as i32, read(8) as u8, read(16));
            }
        }
    }
    JS_UNDEFINED
});

unsafe fn set_text_body(ctx: *mut JSContext, argc: i32, argv: *mut JSValue) -> JSValue {
    if argc < 2 {
        return JS_UNDEFINED;
    }
    let id = arg_i32(ctx, argc, argv, 0);
    let mut len = 0;
    let string = JS_ToCStringLen2(ctx, &mut len, *argv.offset(1), 0);
    if !string.is_null() {
        let text = String::from_utf8_lossy(core::slice::from_raw_parts(string.cast(), len));
        ui().set_text(id, &text);
        JS_FreeCString(ctx, string);
    }
    JS_UNDEFINED
}
op!(set_text(ctx, argc, argv) { set_text_body(ctx, argc, argv) });
op!(replace_text(ctx, argc, argv) { set_text_body(ctx, argc, argv) });
op!(upload_texture(ctx, argc, argv) {
    if argc < 4 { return JS_NewInt32(ctx, -1); }
    let Some((ptr, len)) = buffer_bytes(ctx, *argv) else { return JS_NewInt32(ctx, -1); };
    let handle = ui().upload_texture(core::slice::from_raw_parts(ptr, len), arg_i32(ctx, argc, argv, 1) as u32, arg_i32(ctx, argc, argv, 2) as u32, arg_i32(ctx, argc, argv, 3) as u32);
    JS_NewInt32(ctx, handle)
});
op!(set_image(ctx, argc, argv) {
    ui().set_image(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1)); JS_UNDEFINED
});
op!(set_sprite(ctx, argc, argv) {
    ui().set_sprite(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1), arg_i32(ctx, argc, argv, 2) as u32, arg_i32(ctx, argc, argv, 3) as u32, arg_i32(ctx, argc, argv, 4) as u32); JS_UNDEFINED
});
op!(animate(ctx, argc, argv) {
    JS_NewInt32(ctx, ui().animate(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1) as u8, arg_f64(ctx, argc, argv, 2), arg_i32(ctx, argc, argv, 3).max(0) as u32, arg_i32(ctx, argc, argv, 4) as u8, arg_i32(ctx, argc, argv, 5).max(0) as u32))
});
op!(cancel_anim(ctx, argc, argv) {
    ui().cancel_anim(arg_i32(ctx, argc, argv, 0)); JS_UNDEFINED
});
op!(set_focus(ctx, argc, argv) {
    ui().set_focus(arg_i32(ctx, argc, argv, 0)); JS_UNDEFINED
});
op!(set_active(ctx, argc, argv) {
    ui().set_active(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1) != 0); JS_UNDEFINED
});
op!(load_styles(ctx, argc, argv) {
    let ok = if argc > 0 { buffer_bytes(ctx, *argv).map(|(p, n)| ui().load_styles(core::slice::from_raw_parts(p, n))).unwrap_or(false) } else { false };
    JS_NewBool(ctx, ok)
});
op!(load_font_atlas(ctx, argc, argv) {
    let ok = if argc > 0 { buffer_bytes(ctx, *argv).map(|(p, n)| ui().load_font_atlas(core::slice::from_raw_parts(p, n))).unwrap_or(false) } else { false };
    JS_NewBool(ctx, ok)
});
op!(measure_text(ctx, argc, argv) {
    if argc < 1 { return JS_NewFloat64(ctx, 0.0); }
    let mut len = 0;
    let string = JS_ToCStringLen2(ctx, &mut len, *argv, 0);
    if string.is_null() { return JS_NewFloat64(ctx, 0.0); }
    let text = String::from_utf8_lossy(core::slice::from_raw_parts(string.cast(), len));
    let width = ui().measure_text(&text, arg_i32(ctx, argc, argv, 1) as u8);
    JS_FreeCString(ctx, string);
    JS_NewFloat64(ctx, width as f64)
});
op!(free_texture(ctx, argc, argv) {
    ui().free_texture(arg_i32(ctx, argc, argv, 0)); JS_UNDEFINED
});
op!(upload_img_entry(ctx, argc, argv) {
    let handle = if argc > 0 { buffer_bytes(ctx, *argv).map(|(p, n)| ui().upload_img_entry(core::slice::from_raw_parts(p, n))).unwrap_or(-1) } else { -1 };
    JS_NewInt32(ctx, handle)
});
op!(load_tile_texture(ctx, argc, argv) {
    if argc < 2 { return JS_NewInt32(ctx, -1); }
    let mut len = 0;
    let string = JS_ToCStringLen2(ctx, &mut len, *argv, 0);
    if string.is_null() { return JS_NewInt32(ctx, -1); }
    let key = core::str::from_utf8(core::slice::from_raw_parts(string.cast(), len)).ok();
    let handle = key.and_then(|key| crate::pak::find(PAK, key)).map(|blob| ui().upload_tileset_tile(blob, arg_i32(ctx, argc, argv, 1) as u32)).unwrap_or(-1);
    JS_FreeCString(ctx, string);
    JS_NewInt32(ctx, handle)
});

type UiFunction = unsafe extern "C" fn(*mut JSContext, JSValue, i32, *mut JSValue) -> JSValue;

unsafe fn add_fn(
    ctx: *mut JSContext,
    object: JSValue,
    name: &'static [u8],
    function: UiFunction,
    nargs: i32,
) {
    let value = JS_NewCFunction2(
        ctx,
        Some(function),
        name.as_ptr().cast(),
        nargs,
        JS_CFUNC_generic,
        0,
    );
    JS_SetPropertyStr(ctx, object, name.as_ptr().cast(), value);
}

extern "C" {
    fn JS_NewStringLen(ctx: *mut JSContext, bytes: *const u8, len: usize) -> JSValue;
}

pub unsafe fn register(
    ctx: *mut JSContext,
    global: JSValue,
    textures: &[(String, i32)],
    sprites: &[SpriteReg],
) {
    let object = JS_NewObject(ctx);
    for (name, function, nargs) in [
        (
            b"createNode\0" as &'static [u8],
            create_node as UiFunction,
            1,
        ),
        (b"destroyNode\0", destroy_node, 1),
        (b"insertBefore\0", insert_before, 3),
        (b"removeChild\0", remove_child, 2),
        (b"setStyle\0", set_style, 2),
        (b"setProp\0", set_prop, 3),
        (b"setPropBatch\0", set_prop_batch, 1),
        (b"setText\0", set_text, 2),
        (b"replaceText\0", replace_text, 2),
        (b"uploadTexture\0", upload_texture, 4),
        (b"setImage\0", set_image, 2),
        (b"setSprite\0", set_sprite, 5),
        (b"animate\0", animate, 6),
        (b"cancelAnim\0", cancel_anim, 1),
        (b"setFocus\0", set_focus, 1),
        (b"setActive\0", set_active, 2),
        (b"loadStyles\0", load_styles, 1),
        (b"loadFontAtlas\0", load_font_atlas, 1),
        (b"measureText\0", measure_text, 2),
        (b"loadTileTexture\0", load_tile_texture, 2),
        (b"freeTexture\0", free_texture, 1),
        (b"uploadImgEntry\0", upload_img_entry, 1),
    ] {
        add_fn(ctx, object, name, function, nargs);
    }
    JS_SetPropertyStr(
        ctx,
        object,
        b"__host\0".as_ptr().cast(),
        JS_NewStringLen(ctx, b"sf2000".as_ptr(), 6),
    );
    JS_SetPropertyStr(
        ctx,
        object,
        b"__hostAbi\0".as_ptr().cast(),
        JS_NewInt32(ctx, 1),
    );

    let texture_object = JS_NewObject(ctx);
    for (name, handle) in textures {
        let value = JS_NewInt32(ctx, *handle);
        JS_SetPropertyStr(ctx, texture_object, nul(name).as_ptr().cast(), value);
    }
    JS_SetPropertyStr(ctx, object, b"__textures\0".as_ptr().cast(), texture_object);
    let sprite_object = JS_NewObject(ctx);
    for sprite in sprites {
        let meta = JS_NewObject(ctx);
        for (key, value) in [
            (b"handle\0" as &[u8], sprite.handle),
            (b"frames\0", sprite.frames as i32),
            (b"cols\0", sprite.cols as i32),
            (b"step\0", sprite.step as i32),
        ] {
            JS_SetPropertyStr(ctx, meta, key.as_ptr().cast(), JS_NewInt32(ctx, value));
        }
        JS_SetPropertyStr(ctx, sprite_object, nul(&sprite.name).as_ptr().cast(), meta);
    }
    JS_SetPropertyStr(ctx, object, b"__sprites\0".as_ptr().cast(), sprite_object);
    JS_SetPropertyStr(ctx, global, b"ui\0".as_ptr().cast(), object);
}

fn nul(value: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(value.len() + 1);
    bytes.extend_from_slice(value.as_bytes());
    bytes.push(0);
    bytes
}
