#![allow(static_mut_refs)]

extern crate alloc;

use core::ffi::c_void;
use std::fmt;
use std::string::String;

use libquickjs_sys::*;
use pocketjs_core::Ui;

pub mod dbg;
pub mod ffi;
pub mod graphics;
pub mod input;
pub mod pak;

extern "C" {
    fn JS_NewArray(ctx: *mut JSContext) -> JSValue;
    fn JS_SetPropertyUint32(
        ctx: *mut JSContext,
        this_obj: JSValue,
        index: u32,
        value: JSValue,
    ) -> i32;
    fn JS_NewArrayBuffer(
        ctx: *mut JSContext,
        buf: *mut u8,
        len: usize,
        free_func: Option<unsafe extern "C" fn(*mut JSRuntime, *mut c_void, *mut c_void)>,
        opaque: *mut c_void,
        is_shared: i32,
    ) -> JSValue;
    fn JS_ExecutePendingJob(rt: *mut JSRuntime, pctx: *mut *mut JSContext) -> i32;
    fn sceClibPrintf(fmt: *const i8, ...) -> i32;
}

pub fn vita_log(args: fmt::Arguments<'_>) {
    use std::fmt::Write;
    let mut line = String::new();
    let _ = line.write_fmt(args);
    line.push('\0');
    unsafe {
        sceClibPrintf(c"%s\n".as_ptr(), line.as_ptr());
    }
}

unsafe fn exception_string(ctx: *mut JSContext) -> String {
    let value = JS_GetException(ctx);
    let mut len: size_t = 0;
    let ptr = JS_ToCStringLen2(ctx, &mut len, value, 0);
    let message = if ptr.is_null() {
        String::from("unknown JavaScript exception")
    } else {
        let bytes = core::slice::from_raw_parts(ptr as *const u8, len);
        let text = String::from_utf8_lossy(bytes).into_owned();
        JS_FreeCString(ctx, ptr);
        text
    };
    JS_FreeValue(ctx, value);
    message
}

/// Reusable PocketJS Vita host. External games can register additional
/// QuickJS namespaces through `context()`/`global()` before calling `eval()`.
pub struct Runtime {
    rt: *mut JSRuntime,
    ctx: *mut JSContext,
    global: JSValue,
    frame_fn: JSValue,
}

impl Runtime {
    /// Initialize vita2d, the PocketJS core, pak textures and QuickJS.
    /// `app_pak` must outlive the runtime because `globalThis.__pak` borrows it.
    ///
    /// # Safety
    ///
    /// Construct only one runtime, on the Vita render thread. The caller must
    /// keep all subsequent runtime and graphics access on that thread.
    pub unsafe fn new(app_pak: &'static [u8]) -> Result<Self, String> {
        graphics::init().map_err(String::from)?;
        input::init();

        let ui = ffi::init_ui();
        pak::install(app_pak);
        let (textures, sprites) = pak::feed(ui, app_pak);

        let rt = JS_NewRuntime();
        if rt.is_null() {
            return Err(String::from("JS_NewRuntime failed"));
        }
        let ctx = JS_NewContext(rt);
        if ctx.is_null() {
            JS_FreeRuntime(rt);
            return Err(String::from("JS_NewContext failed"));
        }
        let global = JS_GetGlobalObject(ctx);
        ffi::register(ctx, global, &textures, &sprites);
        if !app_pak.is_empty() {
            let ptr = app_pak.as_ptr() as *mut u8;
            let buffer = JS_NewArrayBuffer(ctx, ptr, app_pak.len(), None, ptr as *mut c_void, 0);
            JS_SetPropertyStr(ctx, global, c"__pak".as_ptr(), buffer);
        }
        Ok(Self {
            rt,
            ctx,
            global,
            frame_fn: JS_UNDEFINED,
        })
    }

    #[inline]
    pub fn context(&self) -> *mut JSContext {
        self.ctx
    }

    #[inline]
    pub fn global(&self) -> JSValue {
        self.global
    }

    #[inline]
    /// Borrow the runtime's process-global PocketJS core.
    ///
    /// # Safety
    ///
    /// Stay on the owning render thread and do not retain this reference
    /// across another call that accesses the core.
    pub unsafe fn ui(&mut self) -> &'static mut Ui {
        ffi::ui()
    }

    /// Evaluate a NUL-terminated bundle and retain `globalThis.frame`.
    ///
    /// # Safety
    ///
    /// Call on the runtime's owning thread. The bundle must obey PocketJS's
    /// single-realm host contract.
    pub unsafe fn eval(&mut self, app_js: &str) -> Result<(), String> {
        let Some(len) = app_js
            .len()
            .checked_sub(1)
            .filter(|_| app_js.as_bytes().last() == Some(&0))
        else {
            return Err(String::from("PocketJS Vita bundle must be NUL-terminated"));
        };
        let result = JS_Eval(
            self.ctx,
            app_js.as_ptr() as *const i8,
            len,
            c"game.js".as_ptr(),
            JS_EVAL_TYPE_GLOBAL as i32,
        );
        if JS_IsException(result) {
            return Err(exception_string(self.ctx));
        }
        JS_FreeValue(self.ctx, result);
        let frame_fn = JS_GetPropertyStr(self.ctx, self.global, c"frame".as_ptr());
        if JS_IsUndefined(frame_fn) {
            JS_FreeValue(self.ctx, frame_fn);
            return Err(String::from("globalThis.frame is undefined"));
        }
        if !JS_IsUndefined(self.frame_fn) {
            JS_FreeValue(self.ctx, self.frame_fn);
        }
        self.frame_fn = frame_fn;
        Ok(())
    }

    unsafe fn call_frame(&mut self, values: &mut [JSValue]) -> Result<(), String> {
        let result = JS_Call(
            self.ctx,
            self.frame_fn,
            self.global,
            values.len() as i32,
            values.as_mut_ptr(),
        );
        if JS_IsException(result) {
            return Err(exception_string(self.ctx));
        }
        JS_FreeValue(self.ctx, result);
        self.drain_jobs()
    }

    /// Run one guest frame with a Vita button mask.
    ///
    /// # Safety
    ///
    /// Call on the runtime's owning thread with no outstanding mutable UI
    /// borrow.
    pub unsafe fn frame(&mut self, buttons: i32) -> Result<(), String> {
        self.call_frame(&mut [JS_NewInt32(self.ctx, buttons)])
    }

    /// Two-argument variant for apps that consume the packed left analog
    /// value separately. Standard PocketJS bundles simply ignore arg 2.
    ///
    /// # Safety
    ///
    /// Call on the runtime's owning thread with no outstanding mutable UI
    /// borrow.
    pub unsafe fn frame_with_analog(&mut self, buttons: i32, analog: i32) -> Result<(), String> {
        self.call_frame(&mut [
            JS_NewInt32(self.ctx, buttons),
            JS_NewInt32(self.ctx, analog),
        ])
    }

    /// Full stock-host input frame: buttons, packed left analog, and a front
    /// touch snapshot already mapped into PocketJS logical coordinates.
    ///
    /// # Safety
    ///
    /// Call on the runtime's owning thread with no outstanding mutable UI
    /// borrow.
    pub unsafe fn frame_with_input(
        &mut self,
        buttons: i32,
        analog: i32,
        touches: &input::TouchSnapshot,
    ) -> Result<(), String> {
        let touch_array = JS_NewArray(self.ctx);
        for (index, packed) in touches.packed().iter().enumerate() {
            JS_SetPropertyUint32(
                self.ctx,
                touch_array,
                index as u32,
                JS_NewInt32(self.ctx, *packed as i32),
            );
        }
        let result = self.call_frame(&mut [
            JS_NewInt32(self.ctx, buttons),
            JS_NewInt32(self.ctx, analog),
            touch_array,
        ]);
        JS_FreeValue(self.ctx, touch_array);
        result
    }

    /// Drain QuickJS promise jobs queued by the current guest turn.
    ///
    /// # Safety
    ///
    /// Call only on the runtime's owning thread.
    pub unsafe fn drain_jobs(&mut self) -> Result<(), String> {
        loop {
            let mut pending_ctx: *mut JSContext = core::ptr::null_mut();
            let result = JS_ExecutePendingJob(self.rt, &mut pending_ctx);
            if result > 0 {
                continue;
            }
            if result < 0 {
                return Err(exception_string(if pending_ctx.is_null() {
                    self.ctx
                } else {
                    pending_ctx
                }));
            }
            return Ok(());
        }
    }

    /// Advance the fixed-step PocketJS core clock once.
    ///
    /// # Safety
    ///
    /// Call only on the runtime's owning thread with no outstanding UI borrow.
    pub unsafe fn tick(&mut self) {
        ffi::ui().tick();
    }

    fn draw_words(&mut self) -> (*const u32, usize) {
        unsafe {
            let list = ffi::ui().draw();
            (list.words.as_ptr(), list.words.len())
        }
    }

    /// Render a standalone PocketJS frame into a new vita2d scene.
    ///
    /// # Safety
    ///
    /// Call only on the Vita render thread with no scene already open.
    pub unsafe fn render(&mut self) {
        let (ptr, len) = self.draw_words();
        graphics::render(ffi::ui(), core::slice::from_raw_parts(ptr, len));
    }

    /// Composite the PocketJS DrawList into the caller's open vita2d scene.
    ///
    /// # Safety
    ///
    /// Call only on the Vita render thread while a vita2d scene is open.
    pub unsafe fn render_over(&mut self) {
        let (ptr, len) = self.draw_words();
        graphics::render_over(ffi::ui(), core::slice::from_raw_parts(ptr, len));
    }

    /// Write a deterministic native-density 960x544 golden for the current UI
    /// tree while retaining PocketJS's 480x272 logical layout contract.
    ///
    /// # Safety
    ///
    /// Call only on the runtime's owning thread with no outstanding UI borrow.
    #[cfg(feature = "capture")]
    pub unsafe fn capture_golden(&mut self, path: &str) -> std::io::Result<()> {
        let (ptr, len) = self.draw_words();
        graphics::capture_golden(ffi::ui(), core::slice::from_raw_parts(ptr, len), path)
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        unsafe {
            if !JS_IsUndefined(self.frame_fn) {
                JS_FreeValue(self.ctx, self.frame_fn);
            }
            JS_FreeValue(self.ctx, self.global);
            JS_FreeContext(self.ctx);
            JS_FreeRuntime(self.rt);
        }
    }
}
