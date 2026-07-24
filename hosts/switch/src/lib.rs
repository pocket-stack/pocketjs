#![no_std]
#![feature(alloc_error_handler)]
#![allow(static_mut_refs)]

extern crate alloc;

use alloc::alloc::{GlobalAlloc, Layout};
use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;
use core::ffi::{c_char, c_void};
use core::fmt;
use core::ptr;

use libquickjs_sys::*;

pub mod dbg;
#[path = "../../native/ffi.rs"]
pub mod ffi;
pub mod graphics;
#[path = "../../native/pak.rs"]
pub mod pak;
pub mod switch;

extern "C" {
    fn malloc(size: usize) -> *mut c_void;
    fn memalign(alignment: usize, size: usize) -> *mut c_void;
    fn free(pointer: *mut c_void);
    fn pocketjs_switch_log(bytes: *const u8, length: usize);
    fn pocketjs_switch_abort() -> !;

    fn JS_NewArrayBuffer(
        ctx: *mut JSContext,
        buffer: *mut u8,
        length: usize,
        free_function: Option<unsafe extern "C" fn(*mut JSRuntime, *mut c_void, *mut c_void)>,
        opaque: *mut c_void,
        shared: i32,
    ) -> JSValue;
    fn JS_ExecutePendingJob(runtime: *mut JSRuntime, context: *mut *mut JSContext) -> i32;
}

struct NewlibAllocator;

unsafe impl GlobalAlloc for NewlibAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let size = layout.size().max(1);
        if layout.align() <= 16 {
            malloc(size) as *mut u8
        } else {
            memalign(layout.align(), size) as *mut u8
        }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, _layout: Layout) {
        free(pointer as *mut c_void);
    }
}

#[global_allocator]
static ALLOCATOR: NewlibAllocator = NewlibAllocator;

#[alloc_error_handler]
fn allocation_error(_layout: Layout) -> ! {
    unsafe { pocketjs_switch_abort() }
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    unsafe { pocketjs_switch_abort() }
}

pub fn host_log(args: fmt::Arguments<'_>) {
    use core::fmt::Write;
    let mut message = String::new();
    if message.write_fmt(args).is_ok() {
        unsafe { pocketjs_switch_log(message.as_ptr(), message.len()) };
    }
}

unsafe fn exception_string(context: *mut JSContext) -> String {
    let value = JS_GetException(context);
    let mut length: size_t = 0;
    let raw = JS_ToCStringLen2(context, &mut length, value, 0);
    let message = if raw.is_null() {
        String::from("unknown JavaScript exception")
    } else {
        let bytes = core::slice::from_raw_parts(raw as *const u8, length);
        let text = String::from_utf8_lossy(bytes).into_owned();
        JS_FreeCString(context, raw);
        text
    };
    JS_FreeValue(context, value);
    message
}

struct Runtime {
    runtime: *mut JSRuntime,
    context: *mut JSContext,
    global: JSValue,
    frame: JSValue,
    pixels: Vec<u8>,
}

impl Runtime {
    unsafe fn new(app_pak: &'static [u8]) -> Result<Self, String> {
        let ui = ffi::init_ui();
        pak::install(app_pak);
        let (textures, sprites) = pak::feed(ui, app_pak);
        switch::upload_shot(ui);

        let runtime = JS_NewRuntime();
        if runtime.is_null() {
            ffi::reset_ui();
            pak::uninstall();
            return Err(String::from("JS_NewRuntime failed"));
        }
        let context = JS_NewContext(runtime);
        if context.is_null() {
            JS_FreeRuntime(runtime);
            ffi::reset_ui();
            pak::uninstall();
            return Err(String::from("JS_NewContext failed"));
        }
        let global = JS_GetGlobalObject(context);
        ffi::register(context, global, &textures, &sprites);
        if !app_pak.is_empty() {
            let pointer = app_pak.as_ptr() as *mut u8;
            let buffer =
                JS_NewArrayBuffer(context, pointer, app_pak.len(), None, pointer.cast(), 0);
            JS_SetPropertyStr(context, global, c"__pak".as_ptr(), buffer);
        }
        Ok(Self {
            runtime,
            context,
            global,
            frame: JS_UNDEFINED,
            pixels: vec![0; graphics::CONTENT_BYTES],
        })
    }

    unsafe fn eval(&mut self, app_js: &[u8]) -> Result<(), String> {
        let result = JS_Eval(
            self.context,
            app_js.as_ptr() as *const c_char,
            app_js.len(),
            c"app.js".as_ptr(),
            JS_EVAL_TYPE_GLOBAL as i32,
        );
        if JS_IsException(result) {
            return Err(exception_string(self.context));
        }
        JS_FreeValue(self.context, result);
        self.frame = JS_GetPropertyStr(self.context, self.global, c"frame".as_ptr());
        if JS_IsUndefined(self.frame) {
            return Err(String::from("globalThis.frame is undefined"));
        }
        Ok(())
    }

    unsafe fn run_frame(&mut self, buttons: i32, analog: i32) -> Result<(), String> {
        let mut arguments = [
            JS_NewInt32(self.context, buttons),
            JS_NewInt32(self.context, analog),
        ];
        let result = JS_Call(
            self.context,
            self.frame,
            self.global,
            arguments.len() as i32,
            arguments.as_mut_ptr(),
        );
        if JS_IsException(result) {
            return Err(exception_string(self.context));
        }
        JS_FreeValue(self.context, result);
        loop {
            let mut pending_context = ptr::null_mut();
            let status = JS_ExecutePendingJob(self.runtime, &mut pending_context);
            if status > 0 {
                continue;
            }
            if status < 0 {
                return Err(exception_string(if pending_context.is_null() {
                    self.context
                } else {
                    pending_context
                }));
            }
            break;
        }

        ffi::ui().tick();
        let (words_pointer, words_length) = {
            let words = &ffi::ui().draw().words;
            (words.as_ptr(), words.len())
        };
        pocketjs_core::raster::render_scaled(
            ffi::ui(),
            core::slice::from_raw_parts(words_pointer, words_length),
            &mut self.pixels,
            graphics::INTEGER_SCALE,
        );
        Ok(())
    }

    unsafe fn shutdown(&mut self) {
        if self.context.is_null() {
            return;
        }
        if !JS_IsUndefined(self.frame) {
            JS_FreeValue(self.context, self.frame);
            self.frame = JS_UNDEFINED;
        }
        JS_FreeValue(self.context, self.global);
        self.global = JS_UNDEFINED;
        JS_FreeContext(self.context);
        self.context = ptr::null_mut();
        JS_FreeRuntime(self.runtime);
        self.runtime = ptr::null_mut();
        ffi::reset_ui();
        pak::uninstall();
    }
}

static mut RUNTIME: Option<Runtime> = None;

unsafe fn static_bytes(pointer: *const u8, length: usize) -> Option<&'static [u8]> {
    if length == 0 {
        return Some(&[]);
    }
    (!pointer.is_null()).then(|| core::slice::from_raw_parts(pointer, length))
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_switch_init(
    app_js: *const u8,
    app_js_length: usize,
    app_pak: *const u8,
    app_pak_length: usize,
) -> bool {
    if RUNTIME.is_some() {
        host_log(format_args!(
            "[PocketJS Switch] guest is already initialized"
        ));
        return false;
    }
    let (Some(js), Some(pak)) = (
        static_bytes(app_js, app_js_length),
        static_bytes(app_pak, app_pak_length),
    ) else {
        host_log(format_args!("[PocketJS Switch] invalid RomFS buffers"));
        return false;
    };
    if core::str::from_utf8(js).is_err() {
        host_log(format_args!("[PocketJS Switch] app.js is not UTF-8"));
        return false;
    }
    let mut runtime = match Runtime::new(pak) {
        Ok(runtime) => runtime,
        Err(error) => {
            host_log(format_args!("[PocketJS Switch] {error}"));
            return false;
        }
    };
    if let Err(error) = runtime.eval(js) {
        host_log(format_args!("[PocketJS Switch] {error}"));
        runtime.shutdown();
        return false;
    }
    RUNTIME = Some(runtime);
    host_log(format_args!("[PocketJS Switch] guest initialized"));
    true
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_switch_frame(
    buttons: i32,
    analog: i32,
    output: *mut *const u8,
    output_length: *mut usize,
) -> bool {
    let Some(runtime) = RUNTIME.as_mut() else {
        return false;
    };
    if let Err(error) = runtime.run_frame(buttons, analog) {
        host_log(format_args!("[PocketJS Switch] {error}"));
        return false;
    }
    if !output.is_null() {
        *output = runtime.pixels.as_ptr();
    }
    if !output_length.is_null() {
        *output_length = runtime.pixels.len();
    }
    true
}

#[no_mangle]
pub unsafe extern "C" fn pocketjs_switch_shutdown() {
    if let Some(mut runtime) = RUNTIME.take() {
        runtime.shutdown();
    }
}
