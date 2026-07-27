#include <windows.h>
#include <stdlib.h>
#include <string.h>

#include "pocketjs_wm6_core.h"
#include "quickjs.h"
#include "wm6_quickjs_abi.h"

typedef struct Wm6QuickJS {
    JSRuntime *runtime;
    JSContext *context;
    char printed[256];
} Wm6QuickJS;

typedef enum Wm6HostOperation {
    WM6_HOST_CREATE_NODE,
    WM6_HOST_DESTROY_NODE,
    WM6_HOST_INSERT_BEFORE,
    WM6_HOST_REMOVE_CHILD,
    WM6_HOST_SET_STYLE,
    WM6_HOST_SET_PROP,
    WM6_HOST_SET_PROP_BATCH,
    WM6_HOST_SET_TEXT,
    WM6_HOST_REPLACE_TEXT,
    WM6_HOST_UPLOAD_TEXTURE,
    WM6_HOST_UPLOAD_IMG_ENTRY,
    WM6_HOST_FREE_TEXTURE,
    WM6_HOST_SET_IMAGE,
    WM6_HOST_SET_SPRITE,
    WM6_HOST_ANIMATE,
    WM6_HOST_CANCEL_ANIM,
    WM6_HOST_SET_FOCUS,
    WM6_HOST_SET_ACTIVE,
    WM6_HOST_HIT_TEST,
    WM6_HOST_SET_CURSOR,
    WM6_HOST_SET_CURSOR_POS,
    WM6_HOST_LOAD_STYLES,
    WM6_HOST_LOAD_FONT_ATLAS,
    WM6_HOST_MEASURE_TEXT,
    WM6_HOST_DEBUG_INSPECT,
    WM6_HOST_DEBUG_RECT_XY,
    WM6_HOST_DEBUG_RECT_WH,
    WM6_HOST_DEBUG_PAUSE,
    WM6_HOST_DEBUG_STEP
} Wm6HostOperation;

static void copy_text(char *output, unsigned int capacity, const char *text)
{
    unsigned int index;

    if (!output || capacity == 0)
        return;
    index = 0;
    while (text && text[index] != '\0' && index + 1 < capacity) {
        output[index] = text[index];
        index++;
    }
    output[index] = '\0';
}

static void copy_exception(JSContext *context, char *output,
                           unsigned int capacity)
{
    JSValue exception;
    const char *text;

    exception = JS_GetException(context);
    text = JS_ToCString(context, exception);
    copy_text(output, capacity, text ? text : "JavaScript exception");
    if (text)
        JS_FreeCString(context, text);
    JS_FreeValue(context, exception);
}

static JSValue runtime_print(JSContext *context, JSValueConst this_value,
                             int argument_count, JSValueConst *arguments)
{
    Wm6QuickJS *host;
    const char *text;

    (void)this_value;
    host = (Wm6QuickJS *)JS_GetContextOpaque(context);
    if (!host || argument_count < 1)
        return JS_UNDEFINED;
    text = JS_ToCString(context, arguments[0]);
    if (!text)
        return JS_EXCEPTION;
    copy_text(host->printed, sizeof(host->printed), text);
    JS_FreeCString(context, text);
    return JS_UNDEFINED;
}

static int int_argument(JSContext *context, int argument_count,
                        JSValueConst *arguments, int index, int32_t *value)
{
    if (index >= argument_count) {
        JS_ThrowTypeError(context, "missing argument %d", index);
        return 0;
    }
    return JS_ToInt32(context, value, arguments[index]) == 0;
}

static int uint_argument(JSContext *context, int argument_count,
                         JSValueConst *arguments, int index, uint32_t *value)
{
    if (index >= argument_count) {
        JS_ThrowTypeError(context, "missing argument %d", index);
        return 0;
    }
    return JS_ToUint32(context, value, arguments[index]) == 0;
}

static int float_argument(JSContext *context, int argument_count,
                          JSValueConst *arguments, int index, double *value)
{
    if (index >= argument_count) {
        JS_ThrowTypeError(context, "missing argument %d", index);
        return 0;
    }
    return JS_ToFloat64(context, value, arguments[index]) == 0;
}

static int nonnegative_uint_argument(JSContext *context, int argument_count,
                                     JSValueConst *arguments, int index,
                                     uint32_t *value)
{
    double raw;

    raw = 0.0;
    if (!float_argument(context, argument_count, arguments, index, &raw))
        return 0;
    if (raw <= 0.0)
        *value = 0;
    else if (raw >= 4294967295.0)
        *value = 0xffffffffU;
    else
        *value = (uint32_t)raw;
    return 1;
}

static int string_argument(JSContext *context, int argument_count,
                           JSValueConst *arguments, int index,
                           const char **text, size_t *length)
{
    if (index >= argument_count) {
        JS_ThrowTypeError(context, "missing argument %d", index);
        return 0;
    }
    *text = JS_ToCStringLen2(context, length, arguments[index], 0);
    return *text != NULL;
}

static int bytes_argument(JSContext *context, int argument_count,
                          JSValueConst *arguments, int index,
                          const uint8_t **data, size_t *length)
{
    JSValue buffer;
    JSValue direct_error;
    uint8_t *base;
    uint8_t *direct;
    size_t offset;
    size_t byte_length;
    size_t bytes_per_element;
    size_t buffer_length;

    if (index >= argument_count) {
        JS_ThrowTypeError(context, "missing argument %d", index);
        return 0;
    }
    direct = JS_GetArrayBuffer(context, length, arguments[index]);
    if (!JS_HasException(context)) {
        *data = direct;
        return 1;
    }
    direct_error = JS_GetException(context);
    JS_FreeValue(context, direct_error);

    offset = 0;
    byte_length = 0;
    bytes_per_element = 0;
    buffer = JS_GetTypedArrayBuffer(
        context,
        arguments[index],
        &offset,
        &byte_length,
        &bytes_per_element);
    if (JS_IsException(buffer))
        return 0;
    buffer_length = 0;
    base = JS_GetArrayBuffer(context, &buffer_length, buffer);
    if (JS_HasException(context)) {
        JS_FreeValue(context, buffer);
        return 0;
    }
    (void)bytes_per_element;
    if (offset > buffer_length || byte_length > buffer_length - offset) {
        JS_FreeValue(context, buffer);
        JS_ThrowRangeError(
            context, "typed array is outside its backing buffer");
        return 0;
    }
    *data = base ? base + offset : NULL;
    *length = byte_length;
    JS_FreeValue(context, buffer);
    return 1;
}

static JSValue runtime_host_operation(
    JSContext *context,
    JSValueConst this_value,
    int argument_count,
    JSValueConst *arguments,
    int magic)
{
    int32_t a;
    int32_t b;
    int32_t c;
    uint32_t ua;
    uint32_t ub;
    uint32_t uc;
    uint32_t ud;
    double da;
    double db;
    double dc;
    double dd;
    const uint8_t *bytes;
    size_t byte_length;
    const char *text;
    size_t text_length;

    (void)this_value;
    a = b = c = 0;
    ua = ub = uc = ud = 0;
    da = db = dc = dd = 0.0;
    bytes = NULL;
    byte_length = 0;
    text = NULL;
    text_length = 0;

    switch ((Wm6HostOperation)magic) {
    case WM6_HOST_CREATE_NODE:
        if (!uint_argument(context, argument_count, arguments, 0, &ua))
            return JS_EXCEPTION;
        return JS_NewInt32(context, ui_create_node(ua));
    case WM6_HOST_DESTROY_NODE:
        if (!int_argument(context, argument_count, arguments, 0, &a))
            return JS_EXCEPTION;
        ui_destroy_node(a);
        return JS_UNDEFINED;
    case WM6_HOST_INSERT_BEFORE:
        if (!int_argument(context, argument_count, arguments, 0, &a) ||
            !int_argument(context, argument_count, arguments, 1, &b) ||
            !int_argument(context, argument_count, arguments, 2, &c))
            return JS_EXCEPTION;
        ui_insert_before(a, b, c);
        return JS_UNDEFINED;
    case WM6_HOST_REMOVE_CHILD:
        if (!int_argument(context, argument_count, arguments, 0, &a) ||
            !int_argument(context, argument_count, arguments, 1, &b))
            return JS_EXCEPTION;
        ui_remove_child(a, b);
        return JS_UNDEFINED;
    case WM6_HOST_SET_STYLE:
        if (!int_argument(context, argument_count, arguments, 0, &a) ||
            !int_argument(context, argument_count, arguments, 1, &b))
            return JS_EXCEPTION;
        ui_set_style(a, b);
        return JS_UNDEFINED;
    case WM6_HOST_SET_PROP:
        if (!int_argument(context, argument_count, arguments, 0, &a) ||
            !uint_argument(context, argument_count, arguments, 1, &ua) ||
            !float_argument(context, argument_count, arguments, 2, &da))
            return JS_EXCEPTION;
        ui_set_prop(a, ua, da);
        return JS_UNDEFINED;
    case WM6_HOST_SET_PROP_BATCH:
        if (!bytes_argument(
                context, argument_count, arguments, 0, &bytes, &byte_length))
            return JS_EXCEPTION;
        ui_set_prop_batch(bytes, byte_length);
        return JS_UNDEFINED;
    case WM6_HOST_SET_TEXT:
    case WM6_HOST_REPLACE_TEXT:
        if (!int_argument(context, argument_count, arguments, 0, &a) ||
            !string_argument(
                context, argument_count, arguments, 1, &text, &text_length))
            return JS_EXCEPTION;
        if (magic == WM6_HOST_SET_TEXT)
            ui_set_text(a, (const uint8_t *)text, text_length);
        else
            ui_replace_text(a, (const uint8_t *)text, text_length);
        JS_FreeCString(context, text);
        return JS_UNDEFINED;
    case WM6_HOST_UPLOAD_TEXTURE:
        if (!bytes_argument(
                context, argument_count, arguments, 0, &bytes, &byte_length) ||
            !uint_argument(context, argument_count, arguments, 1, &ua) ||
            !uint_argument(context, argument_count, arguments, 2, &ub) ||
            !uint_argument(context, argument_count, arguments, 3, &uc))
            return JS_EXCEPTION;
        return JS_NewInt32(
            context, ui_upload_texture(bytes, byte_length, ua, ub, uc));
    case WM6_HOST_UPLOAD_IMG_ENTRY:
        if (!bytes_argument(
                context, argument_count, arguments, 0, &bytes, &byte_length))
            return JS_EXCEPTION;
        return JS_NewInt32(context, ui_upload_img_entry(bytes, byte_length));
    case WM6_HOST_FREE_TEXTURE:
        if (!int_argument(context, argument_count, arguments, 0, &a))
            return JS_EXCEPTION;
        ui_free_texture(a);
        return JS_UNDEFINED;
    case WM6_HOST_SET_IMAGE:
        if (!int_argument(context, argument_count, arguments, 0, &a) ||
            !int_argument(context, argument_count, arguments, 1, &b))
            return JS_EXCEPTION;
        ui_set_image(a, b);
        return JS_UNDEFINED;
    case WM6_HOST_SET_SPRITE:
        if (!int_argument(context, argument_count, arguments, 0, &a) ||
            !int_argument(context, argument_count, arguments, 1, &b) ||
            !nonnegative_uint_argument(
                context, argument_count, arguments, 2, &ua) ||
            !nonnegative_uint_argument(
                context, argument_count, arguments, 3, &ub) ||
            !nonnegative_uint_argument(
                context, argument_count, arguments, 4, &uc))
            return JS_EXCEPTION;
        ui_set_sprite(a, b, ua, ub, uc);
        return JS_UNDEFINED;
    case WM6_HOST_ANIMATE:
        if (!int_argument(context, argument_count, arguments, 0, &a) ||
            !uint_argument(context, argument_count, arguments, 1, &ua) ||
            !float_argument(context, argument_count, arguments, 2, &da) ||
            !nonnegative_uint_argument(
                context, argument_count, arguments, 3, &ub) ||
            !uint_argument(context, argument_count, arguments, 4, &uc) ||
            !nonnegative_uint_argument(
                context, argument_count, arguments, 5, &ud))
            return JS_EXCEPTION;
        return JS_NewInt32(context, ui_animate(a, ua, da, ub, uc, ud));
    case WM6_HOST_CANCEL_ANIM:
        if (!int_argument(context, argument_count, arguments, 0, &a))
            return JS_EXCEPTION;
        ui_cancel_anim(a);
        return JS_UNDEFINED;
    case WM6_HOST_SET_FOCUS:
        if (!int_argument(context, argument_count, arguments, 0, &a))
            return JS_EXCEPTION;
        ui_set_focus(a);
        return JS_UNDEFINED;
    case WM6_HOST_SET_ACTIVE:
        if (!int_argument(context, argument_count, arguments, 0, &a) ||
            !int_argument(context, argument_count, arguments, 1, &b))
            return JS_EXCEPTION;
        ui_set_active(a, b);
        return JS_UNDEFINED;
    case WM6_HOST_HIT_TEST:
        if (!float_argument(context, argument_count, arguments, 0, &da) ||
            !float_argument(context, argument_count, arguments, 1, &db))
            return JS_EXCEPTION;
        return JS_NewInt32(context, ui_hit_test((float)da, (float)db));
    case WM6_HOST_SET_CURSOR:
        if (!int_argument(context, argument_count, arguments, 0, &a) ||
            !float_argument(context, argument_count, arguments, 1, &da) ||
            !float_argument(context, argument_count, arguments, 2, &db) ||
            !float_argument(context, argument_count, arguments, 3, &dc) ||
            !float_argument(context, argument_count, arguments, 4, &dd))
            return JS_EXCEPTION;
        ui_set_cursor(a, (float)da, (float)db, (float)dc, (float)dd);
        return JS_UNDEFINED;
    case WM6_HOST_SET_CURSOR_POS:
        if (!float_argument(context, argument_count, arguments, 0, &da) ||
            !float_argument(context, argument_count, arguments, 1, &db))
            return JS_EXCEPTION;
        ui_set_cursor_pos((float)da, (float)db);
        return JS_UNDEFINED;
    case WM6_HOST_LOAD_STYLES:
    case WM6_HOST_LOAD_FONT_ATLAS:
        if (!bytes_argument(
                context, argument_count, arguments, 0, &bytes, &byte_length))
            return JS_EXCEPTION;
        if (magic == WM6_HOST_LOAD_STYLES)
            return JS_NewBool(context, ui_load_styles(bytes, byte_length));
        return JS_NewBool(context, ui_load_font_atlas(bytes, byte_length));
    case WM6_HOST_MEASURE_TEXT:
        if (!string_argument(
                context, argument_count, arguments, 0, &text, &text_length))
            return JS_EXCEPTION;
        if (!uint_argument(context, argument_count, arguments, 1, &ua)) {
            JS_FreeCString(context, text);
            return JS_EXCEPTION;
        }
        da = ui_measure_text((const uint8_t *)text, text_length, ua);
        JS_FreeCString(context, text);
        return JS_NewFloat64(context, da);
    case WM6_HOST_DEBUG_INSPECT:
        if (!int_argument(context, argument_count, arguments, 0, &a))
            return JS_EXCEPTION;
        ui_debug_inspect(a);
        return JS_UNDEFINED;
    case WM6_HOST_DEBUG_RECT_XY:
        return JS_NewInt32(context, ui_debug_rect_xy());
    case WM6_HOST_DEBUG_RECT_WH:
        return JS_NewInt32(context, ui_debug_rect_wh());
    case WM6_HOST_DEBUG_PAUSE:
        if (!int_argument(context, argument_count, arguments, 0, &a))
            return JS_EXCEPTION;
        ui_debug_pause(a);
        return JS_UNDEFINED;
    case WM6_HOST_DEBUG_STEP:
        ui_debug_step();
        return JS_UNDEFINED;
    }
    return JS_ThrowInternalError(context, "unknown PocketJS HostOp");
}

static int add_host_operation(JSContext *context, JSValueConst object,
                              const char *name, int arity,
                              Wm6HostOperation operation)
{
    JSValue function;

    function = JS_NewCFunctionMagic(
        context,
        runtime_host_operation,
        name,
        arity,
        JS_CFUNC_generic_magic,
        (int)operation);
    return JS_SetPropertyStr(context, object, name, function) >= 0;
}

static int install_core_ui(JSContext *context, JSValueConst global,
                           unsigned int viewport_width,
                           unsigned int viewport_height)
{
    JSValue ui;
    JSValue viewport;

    ui = JS_NewObject(context);
    if (JS_IsException(ui))
        return 0;
#define ADD_HOST(name, arity, operation) \
    if (!add_host_operation(context, ui, name, arity, operation)) goto fail
    ADD_HOST("createNode", 1, WM6_HOST_CREATE_NODE);
    ADD_HOST("destroyNode", 1, WM6_HOST_DESTROY_NODE);
    ADD_HOST("insertBefore", 3, WM6_HOST_INSERT_BEFORE);
    ADD_HOST("removeChild", 2, WM6_HOST_REMOVE_CHILD);
    ADD_HOST("setStyle", 2, WM6_HOST_SET_STYLE);
    ADD_HOST("setProp", 3, WM6_HOST_SET_PROP);
    ADD_HOST("setPropBatch", 1, WM6_HOST_SET_PROP_BATCH);
    ADD_HOST("setText", 2, WM6_HOST_SET_TEXT);
    ADD_HOST("replaceText", 2, WM6_HOST_REPLACE_TEXT);
    ADD_HOST("uploadTexture", 4, WM6_HOST_UPLOAD_TEXTURE);
    ADD_HOST("uploadImgEntry", 1, WM6_HOST_UPLOAD_IMG_ENTRY);
    ADD_HOST("freeTexture", 1, WM6_HOST_FREE_TEXTURE);
    ADD_HOST("setImage", 2, WM6_HOST_SET_IMAGE);
    ADD_HOST("setSprite", 5, WM6_HOST_SET_SPRITE);
    ADD_HOST("animate", 6, WM6_HOST_ANIMATE);
    ADD_HOST("cancelAnim", 1, WM6_HOST_CANCEL_ANIM);
    ADD_HOST("setFocus", 1, WM6_HOST_SET_FOCUS);
    ADD_HOST("setActive", 2, WM6_HOST_SET_ACTIVE);
    ADD_HOST("hitTest", 2, WM6_HOST_HIT_TEST);
    ADD_HOST("setCursor", 5, WM6_HOST_SET_CURSOR);
    ADD_HOST("setCursorPos", 2, WM6_HOST_SET_CURSOR_POS);
    ADD_HOST("loadStyles", 1, WM6_HOST_LOAD_STYLES);
    ADD_HOST("loadFontAtlas", 1, WM6_HOST_LOAD_FONT_ATLAS);
    ADD_HOST("measureText", 2, WM6_HOST_MEASURE_TEXT);
    ADD_HOST("debugInspect", 1, WM6_HOST_DEBUG_INSPECT);
    ADD_HOST("debugRectXY", 0, WM6_HOST_DEBUG_RECT_XY);
    ADD_HOST("debugRectWH", 0, WM6_HOST_DEBUG_RECT_WH);
    ADD_HOST("debugPause", 1, WM6_HOST_DEBUG_PAUSE);
    ADD_HOST("debugStep", 0, WM6_HOST_DEBUG_STEP);
#undef ADD_HOST

    viewport = JS_NewObject(context);
    if (JS_IsException(viewport))
        goto fail;
    if (JS_SetPropertyStr(
            context, viewport, "w",
            JS_NewInt32(context, (int)viewport_width)) < 0 ||
        JS_SetPropertyStr(
            context, viewport, "h",
            JS_NewInt32(context, (int)viewport_height)) < 0 ||
        JS_SetPropertyStr(context, ui, "__viewport", viewport) < 0 ||
        JS_SetPropertyStr(
            context, ui, "__host",
            JS_NewString(context, "wm6-rust-core")) < 0 ||
        JS_SetPropertyStr(
            context, ui, "__hostAbi", JS_NewInt32(context, 1)) < 0 ||
        JS_SetPropertyStr(context, global, "ui", ui) < 0)
        goto fail_no_viewport;
    return 1;

fail_no_viewport:
    /* Ownership of successfully assigned values has already transferred. */
    return 0;
fail:
    JS_FreeValue(context, ui);
    return 0;
}

__declspec(dllexport) unsigned int __cdecl wm6_qjs_abi_version(void)
{
    return WM6_QJS_ABI_VERSION;
}

__declspec(dllexport) wm6_qjs_handle __cdecl wm6_qjs_create(
    unsigned int memory_limit,
    unsigned int stack_limit,
    unsigned int viewport_width,
    unsigned int viewport_height,
    char *error,
    unsigned int error_capacity)
{
    Wm6QuickJS *host;
    JSValue global;

    copy_text(error, error_capacity, "");
    host = (Wm6QuickJS *)malloc(sizeof(*host));
    if (!host) {
        copy_text(error, error_capacity, "host allocation failed");
        return NULL;
    }
    memset(host, 0, sizeof(*host));
    host->runtime = JS_NewRuntime();
    if (!host->runtime) {
        free(host);
        copy_text(error, error_capacity, "JS_NewRuntime failed");
        return NULL;
    }
    JS_SetMemoryLimit(host->runtime, memory_limit);
    JS_SetMaxStackSize(host->runtime, stack_limit);
    host->context = JS_NewContext(host->runtime);
    if (!host->context) {
        JS_FreeRuntime(host->runtime);
        free(host);
        copy_text(error, error_capacity, "JS_NewContext failed");
        return NULL;
    }
    JS_SetContextOpaque(host->context, host);
    ui_init(1);
    ui_set_viewport((float)viewport_width, (float)viewport_height);
    global = JS_GetGlobalObject(host->context);
    if (JS_SetPropertyStr(
            host->context,
            global,
            "print",
            JS_NewCFunction(host->context, runtime_print, "print", 1)) < 0 ||
        !install_core_ui(
            host->context, global, viewport_width, viewport_height)) {
        JS_FreeValue(host->context, global);
        ui_shutdown();
        JS_FreeContext(host->context);
        JS_FreeRuntime(host->runtime);
        free(host);
        copy_text(error, error_capacity, "registering PocketJS HostOps failed");
        return NULL;
    }
    JS_FreeValue(host->context, global);
    return (wm6_qjs_handle)host;
}

__declspec(dllexport) int __cdecl wm6_qjs_set_pak(
    wm6_qjs_handle opaque,
    const unsigned char *data,
    unsigned int data_length,
    char *error,
    unsigned int error_capacity)
{
    Wm6QuickJS *host;
    JSValue global;
    JSValue pack;

    host = (Wm6QuickJS *)opaque;
    if (!host || (!data && data_length != 0))
        return -1;
    copy_text(error, error_capacity, "");
    global = JS_GetGlobalObject(host->context);
    pack = JS_NewArrayBufferCopy(host->context, data, data_length);
    if (JS_IsException(pack) ||
        JS_SetPropertyStr(host->context, global, "__pak", pack) < 0) {
        JS_FreeValue(host->context, global);
        copy_exception(host->context, error, error_capacity);
        return -2;
    }
    JS_FreeValue(host->context, global);
    return 0;
}

__declspec(dllexport) int __cdecl wm6_qjs_eval(
    wm6_qjs_handle opaque,
    const char *source,
    unsigned int source_length,
    char *output,
    unsigned int output_capacity)
{
    Wm6QuickJS *host;
    JSValue result;
    const char *text;

    host = (Wm6QuickJS *)opaque;
    if (!host || !source)
        return -1;
    host->printed[0] = '\0';
    copy_text(output, output_capacity, "");
    result = JS_Eval(host->context, source, source_length,
                     "pocketjs-wm6.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) {
        copy_exception(host->context, output, output_capacity);
        JS_FreeValue(host->context, result);
        return -2;
    }
    text = JS_ToCString(host->context, result);
    copy_text(output, output_capacity, text ? text : "ok");
    if (text)
        JS_FreeCString(host->context, text);
    JS_FreeValue(host->context, result);
    return 0;
}

__declspec(dllexport) int __cdecl wm6_qjs_drain_jobs(
    wm6_qjs_handle opaque,
    char *output,
    unsigned int output_capacity)
{
    Wm6QuickJS *host;
    JSContext *job_context;
    int count;

    host = (Wm6QuickJS *)opaque;
    if (!host)
        return -1;
    count = 0;
    while (JS_IsJobPending(host->runtime)) {
        job_context = NULL;
        if (JS_ExecutePendingJob(host->runtime, &job_context) < 0) {
            copy_exception(job_context ? job_context : host->context,
                           output, output_capacity);
            return -2;
        }
        count++;
    }
    copy_text(output, output_capacity,
              host->printed[0] ? host->printed : "no print output");
    return count;
}

__declspec(dllexport) const unsigned char *__cdecl wm6_qjs_frame(
    wm6_qjs_handle opaque,
    unsigned int buttons,
    const unsigned int *touches,
    unsigned int touch_count,
    unsigned int *width,
    unsigned int *height,
    unsigned int *stride,
    unsigned int *byte_length,
    char *error,
    unsigned int error_capacity)
{
    Wm6QuickJS *host;
    JSContext *job_context;
    JSValue global;
    JSValue frame;
    JSValue arguments[3];
    JSValue result;
    const uint8_t *pixels;
    size_t length;
    unsigned int touch_index;

    host = (Wm6QuickJS *)opaque;
    copy_text(error, error_capacity, "");
    if (!host || (!touches && touch_count != 0)) {
        copy_text(error, error_capacity, "invalid frame arguments");
        return NULL;
    }
    global = JS_GetGlobalObject(host->context);
    frame = JS_GetPropertyStr(host->context, global, "frame");
    if (!JS_IsFunction(host->context, frame)) {
        JS_FreeValue(host->context, frame);
        JS_FreeValue(host->context, global);
        copy_text(error, error_capacity, "globalThis.frame is missing");
        return NULL;
    }
    arguments[0] = JS_NewUint32(host->context, buttons);
    arguments[1] = JS_NewInt32(host->context, 0x8080);
    arguments[2] = JS_NewArray(host->context);
    if (touch_count > 8)
        touch_count = 8;
    for (touch_index = 0; touch_index < touch_count; touch_index++) {
        if (JS_SetPropertyUint32(
                host->context,
                arguments[2],
                touch_index,
                JS_NewUint32(host->context, touches[touch_index])) < 0) {
            JS_FreeValue(host->context, arguments[0]);
            JS_FreeValue(host->context, arguments[1]);
            JS_FreeValue(host->context, arguments[2]);
            JS_FreeValue(host->context, frame);
            JS_FreeValue(host->context, global);
            copy_exception(host->context, error, error_capacity);
            return NULL;
        }
    }
    result = JS_Call(
        host->context, frame, global, 3, arguments);
    JS_FreeValue(host->context, arguments[0]);
    JS_FreeValue(host->context, arguments[1]);
    JS_FreeValue(host->context, arguments[2]);
    JS_FreeValue(host->context, frame);
    JS_FreeValue(host->context, global);
    if (JS_IsException(result)) {
        copy_exception(host->context, error, error_capacity);
        JS_FreeValue(host->context, result);
        return NULL;
    }
    JS_FreeValue(host->context, result);
    while (JS_IsJobPending(host->runtime)) {
        job_context = NULL;
        if (JS_ExecutePendingJob(host->runtime, &job_context) < 0) {
            copy_exception(
                job_context ? job_context : host->context,
                error,
                error_capacity);
            return NULL;
        }
    }
    ui_tick();
    pixels = ui_render_incremental();
    length = ui_framebuffer_len();
    if (!pixels || length == 0) {
        copy_text(
            error, error_capacity,
            "PocketJS Rust core returned an empty framebuffer");
        return NULL;
    }
    if (width)
        *width = ui_framebuffer_width();
    if (height)
        *height = ui_framebuffer_height();
    if (stride)
        *stride = ui_framebuffer_stride();
    if (byte_length)
        *byte_length = length > 0xffffffffU
                           ? 0xffffffffU
                           : (unsigned int)length;
    return pixels;
}

__declspec(dllexport) void __cdecl wm6_qjs_destroy(wm6_qjs_handle opaque)
{
    Wm6QuickJS *host;

    host = (Wm6QuickJS *)opaque;
    if (!host)
        return;
    ui_shutdown();
    JS_FreeContext(host->context);
    JS_FreeRuntime(host->runtime);
    free(host);
}

BOOL WINAPI DllMain(HANDLE module, DWORD reason, LPVOID reserved)
{
    (void)module;
    (void)reason;
    (void)reserved;
    return TRUE;
}
