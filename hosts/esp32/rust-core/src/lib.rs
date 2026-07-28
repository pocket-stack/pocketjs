#![no_std]
#![allow(static_mut_refs)]

extern crate alloc;

mod ffi_device;
mod ffi_ui;

use core::alloc::{GlobalAlloc, Layout};
use core::ffi::c_void;

use libquickjs_sys::*;
use pocketjs_core::{pak, raster, Ui};

struct EspAllocator;

extern "C" {
    fn pocketjs_heap_alloc(size: usize, align: usize) -> *mut c_void;
    fn pocketjs_heap_free(pointer: *mut c_void);
    fn pocketjs_qjs_alloc(size: usize) -> *mut c_void;
    fn pocketjs_qjs_free(pointer: *mut c_void);
    fn pocketjs_qjs_realloc(pointer: *mut c_void, size: usize) -> *mut c_void;
    fn pocketjs_qjs_usable_size(pointer: *const c_void) -> usize;
    fn pocketjs_log(message: *const u8, len: usize);
    fn pocketjs_panic();

    fn JS_ExecutePendingJob(runtime: *mut JSRuntime, context: *mut *mut JSContext) -> i32;
    fn JS_SetMemoryLimit(runtime: *mut JSRuntime, limit: usize);
    fn JS_SetMaxStackSize(runtime: *mut JSRuntime, stack_size: usize);
}

unsafe impl GlobalAlloc for EspAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        pocketjs_heap_alloc(layout.size().max(1), layout.align()).cast()
    }

    unsafe fn dealloc(&self, pointer: *mut u8, _layout: Layout) {
        pocketjs_heap_free(pointer.cast());
    }
}

#[global_allocator]
static GLOBAL_ALLOCATOR: EspAllocator = EspAllocator;

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    unsafe { pocketjs_panic() };
    loop {
        core::hint::spin_loop();
    }
}

static mut RUNTIME: *mut JSRuntime = core::ptr::null_mut();
static mut CONTEXT: *mut JSContext = core::ptr::null_mut();
static mut GLOBAL: JSValue = JS_UNDEFINED;
static mut FRAME_FUNCTION: JSValue = JS_UNDEFINED;
static mut LAST_DRAW_HASH: u64 = 0;
static mut QJS_PEAK_BYTES: usize = 0;

unsafe fn log(message: &str) {
    pocketjs_log(message.as_ptr(), message.len());
}

unsafe fn log_exception(ctx: *mut JSContext) {
    let exception = JS_GetException(ctx);
    let mut len = 0;
    let pointer = JS_ToCStringLen2(ctx, &mut len, exception, 0);
    if !pointer.is_null() {
        log("QuickJS exception: ");
        pocketjs_log(pointer.cast(), len);
        JS_FreeCString(ctx, pointer);
    }
    let stack = JS_GetPropertyStr(ctx, exception, b"stack\0".as_ptr().cast());
    if !JS_IsUndefined(stack) {
        let mut stack_len = 0;
        let stack_pointer = JS_ToCStringLen2(ctx, &mut stack_len, stack, 0);
        if !stack_pointer.is_null() {
            log("QuickJS stack: ");
            pocketjs_log(stack_pointer.cast(), stack_len);
            JS_FreeCString(ctx, stack_pointer);
        }
    }
    JS_FreeValue(ctx, stack);
    JS_FreeValue(ctx, exception);
}

unsafe extern "C" fn qjs_malloc(state: *mut JSMallocState, size: usize) -> *mut c_void {
    if size == 0 || state.is_null() {
        return core::ptr::null_mut();
    }
    let usable_request = size.saturating_add(core::mem::size_of::<usize>());
    if (*state).malloc_size.saturating_add(usable_request) > (*state).malloc_limit {
        return core::ptr::null_mut();
    }
    let pointer = pocketjs_qjs_alloc(size);
    if pointer.is_null() {
        return pointer;
    }
    let usable = pocketjs_qjs_usable_size(pointer);
    (*state).malloc_count += 1;
    (*state).malloc_size = (*state).malloc_size.saturating_add(usable);
    QJS_PEAK_BYTES = QJS_PEAK_BYTES.max((*state).malloc_size);
    pointer
}

unsafe extern "C" fn qjs_free(state: *mut JSMallocState, pointer: *mut c_void) {
    if pointer.is_null() {
        return;
    }
    let usable = pocketjs_qjs_usable_size(pointer);
    if !state.is_null() {
        (*state).malloc_count = (*state).malloc_count.saturating_sub(1);
        (*state).malloc_size = (*state).malloc_size.saturating_sub(usable);
    }
    pocketjs_qjs_free(pointer);
}

unsafe extern "C" fn qjs_realloc(
    state: *mut JSMallocState,
    pointer: *mut c_void,
    size: usize,
) -> *mut c_void {
    if pointer.is_null() {
        return qjs_malloc(state, size);
    }
    if size == 0 {
        qjs_free(state, pointer);
        return core::ptr::null_mut();
    }
    let old = pocketjs_qjs_usable_size(pointer);
    if !state.is_null()
        && (*state).malloc_size.saturating_sub(old).saturating_add(size) > (*state).malloc_limit
    {
        return core::ptr::null_mut();
    }
    let next = pocketjs_qjs_realloc(pointer, size);
    if next.is_null() {
        return next;
    }
    let usable = pocketjs_qjs_usable_size(next);
    if !state.is_null() {
        (*state).malloc_size = (*state).malloc_size.saturating_sub(old).saturating_add(usable);
        QJS_PEAK_BYTES = QJS_PEAK_BYTES.max((*state).malloc_size);
    }
    next
}

unsafe extern "C" fn qjs_usable_size(pointer: *const c_void) -> usize {
    pocketjs_qjs_usable_size(pointer)
}

static QJS_ALLOCATOR: JSMallocFunctions = JSMallocFunctions {
    js_malloc: Some(qjs_malloc),
    js_free: Some(qjs_free),
    js_realloc: Some(qjs_realloc),
    js_malloc_usable_size: Some(qjs_usable_size),
};

fn draw_hash(words: &[u32]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for word in words {
        for byte in word.to_le_bytes() {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    hash
}

unsafe fn feed_pak(instance: &mut Ui, bytes: &[u8]) -> bool {
    let mut styles = false;
    let mut fonts = 0;
    for entry in pak::entries(bytes) {
        if entry.key == "ui:styles" {
            styles = instance.load_styles(entry.blob);
        } else if entry.key.starts_with("ui:font.") && instance.load_font_atlas(entry.blob) {
            fonts += 1;
        } else if entry.key.starts_with("ui:img.") {
            let _ = instance.upload_img_entry(entry.blob);
        }
    }
    styles && fonts > 0
}

unsafe fn shutdown() {
    if !CONTEXT.is_null() {
        JS_FreeValue(CONTEXT, FRAME_FUNCTION);
        JS_FreeValue(CONTEXT, GLOBAL);
        JS_FreeContext(CONTEXT);
    }
    if !RUNTIME.is_null() {
        JS_FreeRuntime(RUNTIME);
    }
    FRAME_FUNCTION = JS_UNDEFINED;
    GLOBAL = JS_UNDEFINED;
    CONTEXT = core::ptr::null_mut();
    RUNTIME = core::ptr::null_mut();
    LAST_DRAW_HASH = 0;
    ffi_ui::clear();
}

/// Boot PocketJS Core, feed the PAK, then load and execute the complete
/// qjsc-produced application in QuickJS. Returns 0 on success and a stable
/// negative stage code on failure.
#[no_mangle]
pub extern "C" fn pocketjs_runtime_init(
    bytecode: *const u8,
    bytecode_len: usize,
    pak_bytes: *const u8,
    pak_len: usize,
    width: u32,
    height: u32,
) -> i32 {
    if bytecode.is_null() || bytecode_len == 0 || pak_bytes.is_null() || pak_len == 0 {
        return -1;
    }
    unsafe {
        shutdown();
        QJS_PEAK_BYTES = 0;
        let instance = ffi_ui::init(width as f32, height as f32);
        if !feed_pak(instance, core::slice::from_raw_parts(pak_bytes, pak_len)) {
            shutdown();
            return -2;
        }

        RUNTIME = JS_NewRuntime2(&QJS_ALLOCATOR, core::ptr::null_mut());
        if RUNTIME.is_null() {
            shutdown();
            return -3;
        }
        // Initial Solid/PocketJS mounting can transiently approach 1.6 MiB
        // while cycle collection runs; keep enough headroom to avoid an OOM
        // without allowing the guest to consume the full 4 MiB PSRAM pool.
        JS_SetMemoryLimit(RUNTIME, 2_400_000);
        // Solid's initial component mount is intentionally synchronous.
        // Keep this below the 80 KiB FreeRTOS task stack, leaving room for
        // the Rust/C++ bridge and exception reporting.
        JS_SetMaxStackSize(RUNTIME, 64 * 1024);
        CONTEXT = JS_NewContext(RUNTIME);
        if CONTEXT.is_null() {
            shutdown();
            return -4;
        }
        GLOBAL = JS_GetGlobalObject(CONTEXT);
        ffi_ui::register(CONTEXT, GLOBAL);
        ffi_device::register(CONTEXT, GLOBAL);
        JS_SetPropertyStr(
            CONTEXT,
            GLOBAL,
            b"__simHz\0".as_ptr().cast(),
            JS_NewInt32(CONTEXT, 60),
        );

        let function = JS_ReadObject(
            CONTEXT,
            bytecode,
            bytecode_len,
            JS_READ_OBJ_BYTECODE,
        );
        if JS_IsException(function) {
            log_exception(CONTEXT);
            JS_FreeValue(CONTEXT, function);
            shutdown();
            return -5;
        }

        // JS_EvalFunction consumes the bytecode function value.
        let result = JS_EvalFunction(CONTEXT, function);
        if JS_IsException(result) {
            log_exception(CONTEXT);
            JS_FreeValue(CONTEXT, result);
            shutdown();
            return -7;
        }
        JS_FreeValue(CONTEXT, result);

        FRAME_FUNCTION =
            JS_GetPropertyStr(CONTEXT, GLOBAL, b"frame\0".as_ptr().cast());
        if JS_IsUndefined(FRAME_FUNCTION) {
            shutdown();
            return -6;
        }
        ffi_ui::ui().tick();
        LAST_DRAW_HASH = 0;
        log("PocketJS runtime ready");
    }
    0
}

/// Drive one fixed 60 Hz guest frame. Returns 1 if the draw list changed.
#[no_mangle]
pub extern "C" fn pocketjs_runtime_frame(buttons: u32) -> i32 {
    unsafe {
        if CONTEXT.is_null() || RUNTIME.is_null() {
            return -1;
        }
        let mut arguments = [
            JS_NewInt32(CONTEXT, buttons as i32),
            JS_NewInt32(CONTEXT, 0x8080),
        ];
        let result = JS_Call(
            CONTEXT,
            FRAME_FUNCTION,
            GLOBAL,
            arguments.len() as i32,
            arguments.as_mut_ptr(),
        );
        if JS_IsException(result) {
            log_exception(CONTEXT);
            JS_FreeValue(CONTEXT, result);
            return -2;
        }
        JS_FreeValue(CONTEXT, result);
        loop {
            let mut job_context = core::ptr::null_mut();
            let status = JS_ExecutePendingJob(RUNTIME, &mut job_context);
            if status <= 0 {
                if status < 0 && !job_context.is_null() {
                    log_exception(job_context);
                }
                break;
            }
        }
        let instance = ffi_ui::ui();
        instance.tick();
        let hash = draw_hash(&instance.draw().words);
        if hash == LAST_DRAW_HASH {
            0
        } else {
            LAST_DRAW_HASH = hash;
            1
        }
    }
}

/// Render the current PocketJS draw list directly into a caller-owned RGB565
/// framebuffer. The buffer must contain width*height pixels.
#[no_mangle]
pub extern "C" fn pocketjs_runtime_render_rgb565(
    framebuffer: *mut u16,
    pixel_count: usize,
) -> i32 {
    if framebuffer.is_null() {
        return -1;
    }
    unsafe {
        let instance = ffi_ui::ui();
        let (width, height) = instance.viewport();
        let expected = width as usize * height as usize;
        if pixel_count < expected {
            return -2;
        }
        let draw_list: *const pocketjs_core::DrawList = instance.draw();
        let shared: &Ui = &*(instance as *const Ui);
        raster::render_scaled_rgb565(
            shared,
            &(*draw_list).words,
            core::slice::from_raw_parts_mut(framebuffer, expected),
            1,
        );
    }
    0
}

#[no_mangle]
pub extern "C" fn pocketjs_runtime_qjs_peak_bytes() -> usize {
    unsafe { QJS_PEAK_BYTES }
}

#[no_mangle]
pub extern "C" fn pocketjs_runtime_shutdown() {
    unsafe { shutdown() }
}
