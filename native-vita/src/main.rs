use std::ffi::c_void;
use vitasdk_sys::*;
use libquickjs_sys::*;

mod ffi;
mod graphics;
mod pak;

static APP_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/game.js"));
static APP_PAK: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/app.pak"));

/// VitaSDK reads this weak symbol to size the main thread's stack; the
/// default (256 KB) is exactly QuickJS's default stack budget
/// (JS_DEFAULT_STACK_SIZE), so by the time JS_NewRuntime() runs — after
/// vita2d/ctrl init and pak::feed have already used part of it — QuickJS's
/// shape-cloning during JS_Eval overflows the real stack and corrupts the
/// return chain, landing PC at 0x0.
#[no_mangle]
#[used]
pub static sceUserMainThreadStackSize: u32 = 1024 * 1024;

// ---------------------------------------------------------------------------
extern "C" {
    fn sceIoOpen(file: *const i8, flags: i32, mode: i32) -> i32;
    fn sceIoWrite(fd: i32, data: *const core::ffi::c_void, size: usize) -> i32;
    fn sceIoClose(fd: i32) -> i32;
    fn sceClibPrintf(fmt: *const i8, ...) -> i32;
}

macro_rules! vita_print {
    ($msg:expr) => {
        unsafe {
            let msg = concat!($msg, "\n\0");
            let fd = sceIoOpen(c"tty0:".as_ptr() as *const i8, 1, 0); // 1 = O_WRONLY
            if fd >= 0 {
                sceIoWrite(fd, msg.as_ptr() as *const _, msg.len() - 1);
                sceIoClose(fd);
            }
        }
    };
}

unsafe fn log_exception(ctx: *mut JSContext) {
    let e = JS_GetException(ctx);
    let mut len: size_t = 0;
    let s = JS_ToCStringLen2(ctx, &mut len, e, 0);
    if !s.is_null() {
        sceClibPrintf("[PocketJS js error] %.*s\n\0".as_ptr() as *const i8, len as i32, s);
        JS_FreeCString(ctx, s);
    }
    JS_FreeValue(ctx, e);
}

fn main() {
    unsafe {
        vita_print!("[PocketJS] PS Vita Host Initialized");

        vita_print!("[PocketJS] Init graphics");
        // Init graphics
        vita2d_sys::vita2d_init();
        vita2d_sys::vita2d_set_clear_color(0xFF000000);
        // Enable vsync so vita2d_swap_buffers blocks until vblank.
        vita2d_sys::vita2d_set_vblank_wait(1);

        // Configure SceCtrl
        vita_print!("[PocketJS] Configure input");
        vitasdk_sys::sceCtrlSetSamplingMode(SCE_CTRL_MODE_ANALOG);

        // Init UI core
        vita_print!("[PocketJS] Init UI core");
        let ui = ffi::init_ui();

        // Feed assets
        vita_print!("[PocketJS] Feed assets");
        let (textures, sprites) = pak::feed(ui, APP_PAK);

        // QuickJS
        vita_print!("[PocketJS] Init QuickJS");
        let rt = JS_NewRuntime();
        let ctx = JS_NewContext(rt);
        let global = JS_GetGlobalObject(ctx);

        ffi::register(ctx, global, &textures, &sprites);

        if !APP_PAK.is_empty() {
            vita_print!("[PocketJS] Exposing __pak arraybuffer");
            let p = APP_PAK.as_ptr() as *mut c_void;
            let ab = JS_NewArrayBuffer(
                ctx,
                p as *mut u8,
                APP_PAK.len() as u32,
                None,
                p as *mut c_void,
                0,
            );
            JS_SetPropertyStr(ctx, global, b"__pak\0".as_ptr() as *const _, ab);
        }

        vita_print!("[PocketJS] Evaluating JS");
        let res = JS_Eval(
            ctx,
            APP_JS.as_ptr() as *const i8,
            (APP_JS.len() - 1) as u32,
            c"game.js".as_ptr(),
            JS_EVAL_TYPE_GLOBAL as i32,
        );

        if JS_ValueGetTag(res) == JS_TAG_EXCEPTION {
            log_exception(ctx);
            return;
        }
        JS_FreeValue(ctx, res);

        let frame_fn = JS_GetPropertyStr(ctx, global, b"frame\0".as_ptr() as *const _);
        if JS_IsUndefined(frame_fn) {
            vita_print!("[PocketJS] globalThis.frame is undefined");
            return;
        }

        let mut pad_data: SceCtrlData = std::mem::zeroed();

        vita_print!("[PocketJS] Entering main loop");
        let mut loop_count = 0;
        loop {
            if loop_count < 10 {
                vita_print!("[PocketJS] loop start");
            }
            vitasdk_sys::sceCtrlPeekBufferPositive(0, &mut pad_data, 1);
            let mask = pad_data.buttons as i32;

            let mut args = [JS_NewInt32(ctx, mask)];
            let r = JS_Call(ctx, frame_fn, global, 1, args.as_mut_ptr());
            if JS_ValueGetTag(r) == JS_TAG_EXCEPTION {
                log_exception(ctx);
            }
            JS_FreeValue(ctx, r);

            loop {
                let mut pctx: *mut JSContext = std::ptr::null_mut();
                if JS_ExecutePendingJob(rt, &mut pctx) <= 0 {
                    break;
                }
            }

            let ui = ffi::ui();
            ui.tick();

            let dl = ui.draw();
            graphics::render(&dl.words);
            
            if loop_count < 10 {
                vita_print!("[PocketJS] loop end");
                loop_count += 1;
            }
        }
    }
}
