//! Bounded asynchronous device channel exposed as `globalThis.device`.

use libquickjs_sys::*;

use crate::ffi_ui::add_fn;

extern "C" {
    fn pocketjs_device_command(
        name: *const u8,
        name_len: usize,
        json: *const u8,
        json_len: usize,
    ) -> i32;
    fn pocketjs_device_poll(output: *mut u8, capacity: usize) -> usize;
    fn pocketjs_device_snapshot(output: *mut u8, capacity: usize) -> usize;
    fn JS_NewStringLen(ctx: *mut JSContext, value: *const u8, len: usize) -> JSValue;
}

unsafe fn with_string_pair(
    ctx: *mut JSContext,
    argc: i32,
    argv: *mut JSValue,
) -> Option<(*const i8, usize, *const i8, usize)> {
    if argc < 2 {
        return None;
    }
    let mut name_len = 0;
    let name = JS_ToCStringLen2(ctx, &mut name_len, *argv, 0);
    if name.is_null() {
        return None;
    }
    let mut json_len = 0;
    let json = JS_ToCStringLen2(ctx, &mut json_len, *argv.offset(1), 0);
    if json.is_null() {
        JS_FreeCString(ctx, name);
        return None;
    }
    Some((name, name_len, json, json_len))
}

unsafe extern "C" fn command(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let Some((name, name_len, json, json_len)) = with_string_pair(ctx, argc, argv) else {
        return JS_NewInt32(ctx, -1);
    };
    let id = pocketjs_device_command(name.cast(), name_len, json.cast(), json_len);
    JS_FreeCString(ctx, name);
    JS_FreeCString(ctx, json);
    JS_NewInt32(ctx, id)
}

unsafe extern "C" fn poll(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    let mut output = [0u8; 2048];
    let len = pocketjs_device_poll(output.as_mut_ptr(), output.len()).min(output.len());
    JS_NewStringLen(ctx, output.as_ptr(), len)
}

unsafe extern "C" fn snapshot(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    let mut output = [0u8; 1024];
    let len = pocketjs_device_snapshot(output.as_mut_ptr(), output.len()).min(output.len());
    JS_NewStringLen(ctx, output.as_ptr(), len)
}

pub unsafe fn register(ctx: *mut JSContext, global: JSValue) {
    let object = JS_NewObject(ctx);
    add_fn(ctx, object, b"command\0", command, 2);
    add_fn(ctx, object, b"poll\0", poll, 0);
    add_fn(ctx, object, b"snapshot\0", snapshot, 0);
    JS_SetPropertyStr(ctx, global, b"device\0".as_ptr().cast(), object);
}
