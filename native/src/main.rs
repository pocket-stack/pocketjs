#![no_std]
#![no_main]
#![feature(alloc_error_handler)]
#![feature(asm_experimental_arch)]
#![allow(static_mut_refs)]

//! PocketJS PSP host: boots QuickJS on a 2 MB worker thread, evaluates the
//! embedded app bundle, then drives frame(buttons) per vblank while the Rust
//! core ticks animations/layout and the GE backend draws the DrawList.
//!
//! Boot skeleton COPIED from the proven dreamcart runtime/src/main.rs with the
//! gfx/gfx3d/bridge registrations replaced by the PocketJS stack:
//!   - allocator.rs (src/alloc.rs): arena-backed #[global_allocator] [R]
//!   - pak.rs: feeds styles/atlases/images to the core BEFORE JS eval
//!   - ffi.rs: globalThis.ui — the HostOps surface over the single core Ui
//!   - ge.rs: DrawList -> sceGu with a per-frame bump vertex arena [R]
//!
//! Frame order (DESIGN.md): sceCtrlRead -> sceGuStart -> JS frame(buttons)
//! -> drain jobs (JS_ExecutePendingJob, local extern) -> core.tick(1/60) ->
//! ge::render(core.draw()) -> sceGuFinish/Sync/WaitVblank/Swap -> pool reset.

extern crate alloc;

use core::ffi::c_void;

use libquickjs_sys::*;
use psp::sys::{
    self, CtrlMode, DisplayPixelFormat, GuContextType, GuState, GuSyncBehavior, GuSyncMode,
    IoOpenFlags, SceCtrlData, ShadingModel, TexturePixelFormat, ThreadAttributes,
};
#[cfg(feature = "capture")]
use psp::sys::DisplaySetBufSync;
use psp::vram_alloc::get_vram_allocator;
use psp::{Align16, BUF_WIDTH, SCREEN_HEIGHT, SCREEN_WIDTH};

// A crate-root module literally named `alloc` would collide with
// `extern crate alloc` — keep the DESIGN.md file name, alias the module.
#[path = "alloc.rs"]
mod allocator;
mod arena;
mod c_heap;
mod pak;
mod ffi;
mod ge;
mod qjs_alloc;
mod video;

psp::module!("pocketjs", 1, 1);

// GE display list buffer (1 MB), 16-byte aligned.
static mut LIST: Align16<[u32; 0x40000]> = Align16([0; 0x40000]);

// App bundle selected by POCKETJS_APP (see build.rs), NUL-terminated there for
// JS_Eval (which wants input[len] == '\0'). Empty when built with no app.
static APP_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/game.js"));
// Asset pack: styles.bin + font atlases + images (.pak container). Fed to
// the core natively (pak.rs) BEFORE JS eval; also exposed read-only to JS
// as __pak. Aliases .rodata — JS must never write through it.
static APP_PAK: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/app.pak"));
static POCKETJS_TRACE: &str = env!("POCKETJS_TRACE");

// Build-time scripted input for deterministic PPSSPPHeadless captures
// (test/e2e-ppsspp.ts). Baked by build.rs from the POCKETJS_CAPTURE_INPUT env;
// same "frame:mask,frame:mask" format as dreamcart's PSPJS_CAPTURE_INPUT.
#[cfg(feature = "capture")]
static POCKETJS_CAPTURE_INPUT: &str = env!("POCKETJS_CAPTURE_INPUT");
// Per-demo capture window, also baked by build.rs (each e2e spec builds its
// own EBOOT, so the window travels with its input script). Empty -> defaults
// (CAP_START=16, CAP_N=32). Duplicated per-spec in test/e2e-ppsspp.ts.
#[cfg(feature = "capture")]
static POCKETJS_CAP_START: &str = env!("POCKETJS_CAP_START");
#[cfg(feature = "capture")]
static POCKETJS_CAP_N: &str = env!("POCKETJS_CAP_N");

// libquickjs-sys omits JS_NewArrayBuffer + JS_ExecutePendingJob; the linked
// QuickJS C library provides both (same local-extern pattern as dreamcart
// runtime/src/main.rs). size_t stays usize (MIPS o32).
extern "C" {
    fn JS_NewArrayBuffer(
        ctx: *mut JSContext,
        buf: *mut u8,
        len: usize,
        free_func: Option<unsafe extern "C" fn(*mut JSRuntime, *mut c_void, *mut c_void)>,
        opaque: *mut c_void,
        is_shared: i32,
    ) -> JSValue;
    fn JS_ExecutePendingJob(rt: *mut JSRuntime, pctx: *mut *mut JSContext) -> i32;
}

fn psp_main() {
    unsafe {
        reset_fpu_status();
        boot()
    }
}

/// Real PSP hardware can start a PSPLINK-loaded user thread with FPU
/// exceptions enabled. Taffy intentionally uses NaN sentinels for auto/
/// undefined dimensions; with invalid-operation traps enabled, ordinary
/// flexbox math over those sentinels raises FPE and the screen stays black.
/// Clear FCSR so exceptions are masked and NaNs propagate as the layout engine
/// expects. PPSSPP's software renderer path did not expose this.
#[inline]
unsafe fn reset_fpu_status() {
    core::arch::asm!("ctc1 $zero, $31", options(nostack, nomem));
}

#[inline]
fn trace_enabled() -> bool {
    POCKETJS_TRACE == "1"
}

unsafe fn trace_write(bytes: &[u8]) {
    let fd = sys::sceIoOpen(
        b"host0:/PocketJS-trace.txt\0".as_ptr(),
        IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT | IoOpenFlags::APPEND,
        0o777,
    );
    if fd.0 >= 0 {
        sys::sceIoWrite(fd, bytes.as_ptr() as *const c_void, bytes.len());
        sys::sceIoClose(fd);
    }
}

unsafe fn trace_reset() {
    if !trace_enabled() {
        return;
    }
    let fd = sys::sceIoOpen(
        b"host0:/PocketJS-trace.txt\0".as_ptr(),
        IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT | IoOpenFlags::TRUNC,
        0o777,
    );
    if fd.0 >= 0 {
        sys::sceIoClose(fd);
    }
}

unsafe fn trace(msg: &str) {
    if trace_enabled() {
        trace_write(b"[PocketJS trace] ");
        trace_write(msg.as_bytes());
        trace_write(b"\n");
        psp::dprintln!("[PocketJS trace] {}", msg);
    }
}

unsafe fn trace_pair(prefix: &[u8], msg: &str) {
    if trace_enabled() {
        trace_write(prefix);
        trace_write(msg.as_bytes());
        trace_write(b"\n");
    }
}

/// The `psp::module!` main thread has only a 256 KB stack; QuickJS compiling
/// a bundle overflows it. All real work runs on a 2 MB USER|VFPU worker
/// (VFPU flag required for sceGum on hardware).
unsafe fn boot() {
    trace_reset();
    trace("boot: creating worker thread");
    let id = sys::sceKernelCreateThread(
        b"pocketjs_main\0".as_ptr(),
        worker_main,
        32,              // priority
        2 * 1024 * 1024, // 2 MB stack
        ThreadAttributes::USER | ThreadAttributes::VFPU,
        core::ptr::null_mut(),
    );
    if id.0 >= 0 {
        trace("boot: starting worker thread");
        sys::sceKernelStartThread(id, 0, core::ptr::null_mut());
        sys::sceKernelWaitThreadEnd(id, core::ptr::null_mut());
    } else {
        trace("boot: create worker failed, running inline");
        run(); // fallback: small-stack inline
    }
}

unsafe extern "C" fn worker_main(_argc: usize, _argv: *mut c_void) -> i32 {
    reset_fpu_status();
    trace("worker: entered");
    run();
    0
}

/// Print the pending JS exception via the debug screen.
unsafe fn log_exception(ctx: *mut JSContext) {
    let e = JS_GetException(ctx);
    let mut len: size_t = 0;
    let s = JS_ToCStringLen2(ctx, &mut len, e, 0);
    if !s.is_null() {
        if let Ok(msg) = core::str::from_utf8(core::slice::from_raw_parts(s as *const u8, len)) {
            trace_pair(b"[PocketJS js error] ", msg);
            psp::dprintln!("[PocketJS js error] {}", msg);
        }
        JS_FreeCString(ctx, s);
    }
    JS_FreeValue(ctx, e);
}

unsafe fn run() {
    trace("run: entered");
    psp::enable_home_button();
    trace("run: home button enabled");
    init_graphics();
    trace("run: graphics initialized");
    init_media();
    trace("run: media modules loaded");

    // ---- Controller ----
    sys::sceCtrlSetSamplingCycle(0);
    sys::sceCtrlSetSamplingMode(CtrlMode::Analog);
    let mut pad = SceCtrlData::default();
    trace("run: controller initialized");

    // ---- Rust UI core (first allocation initializes the arena) ----
    trace("run: init ui begin");
    let ui = ffi::init_ui();
    trace("run: init ui ok");
    // Feed styles.bin + font atlases + images straight from .rodata to the
    // core BEFORE any JS runs (zero QuickJS-heap transit) [R].
    trace("run: pak feed begin");
    let textures = pak::feed(ui, APP_PAK);
    trace("run: pak feed ok");

    // ---- QuickJS ----
    trace("run: JS_NewRuntime begin");
    let rt = qjs_alloc::new_runtime();
    if rt.is_null() {
        halt("JS_NewRuntime returned null");
    }
    trace("run: JS_NewRuntime ok");
    trace("run: JS_NewContext begin");
    let ctx = JS_NewContext(rt);
    if ctx.is_null() {
        halt("JS_NewContext returned null");
    }
    trace("run: JS_NewContext ok");
    let global = JS_GetGlobalObject(ctx);
    trace("run: global object ok");

    // globalThis.ui — the full HostOps surface + the __textures table.
    trace("run: register ui begin");
    ffi::register(ctx, global, &textures);
    trace("run: register ui ok");

    // Expose the asset pack read-only as globalThis.__pak (zero-copy over
    // .rodata; free_func = None). Web/test hosts feed core through loadStyles/
    // loadFontAtlas ops instead — on PSP pak.rs already did it natively.
    if !APP_PAK.is_empty() {
        let ab = JS_NewArrayBuffer(
            ctx,
            APP_PAK.as_ptr() as *mut u8,
            APP_PAK.len(),
            None,
            core::ptr::null_mut(),
            0,
        );
        JS_SetPropertyStr(ctx, global, b"__pak\0".as_ptr() as *const _, ab);
        trace("run: __pak installed");
    }

    trace("run: JS_Eval begin");
    let res = JS_Eval(
        ctx,
        APP_JS.as_ptr() as *const _,
        APP_JS.len() - 1, // exclude the trailing NUL
        b"app.js\0".as_ptr() as *const _,
        JS_EVAL_TYPE_GLOBAL as i32,
    );
    if JS_ValueGetTag(res) == JS_TAG_EXCEPTION {
        log_exception(ctx);
        halt("JS_Eval threw");
    }
    JS_FreeValue(ctx, res);
    trace("run: JS_Eval ok");

    let frame_fn = JS_GetPropertyStr(ctx, global, b"frame\0".as_ptr() as *const _);
    if JS_IsUndefined(frame_fn) {
        halt("globalThis.frame is undefined");
    }
    trace("run: frame lookup ok");

    // ---- Fixed-timestep frame loop (~60 Hz via vblank) ----
    // The Rust frame counter is the capture identity (origin/main contract):
    // it indexes the baked input script AND names the dumped frame files, so
    // input at frame N and file fN-CAP_START refer to the same presented frame.
    // It is NOT the JS side's notion of frames — never key test state off JS.
    #[cfg_attr(not(feature = "capture"), allow(unused_variables, unused_mut))]
    let mut frame_count: u32 = 0;
    loop {
        if frame_count == 0 {
            trace("frame 0: begin");
        }
        // Still read sceCtrl even in capture builds so loop timing is
        // identical; the mask is then overridden by the baked script.
        sys::sceCtrlReadBufferPositive(&mut pad, 1);
        if frame_count == 0 {
            trace("frame 0: ctrl read ok");
        }
        let mask = pad.buttons.bits() as i32;
        #[cfg(feature = "capture")]
        let mask = capture_input_mask(frame_count, mask);

        sys::sceGuStart(GuContextType::Direct, &mut LIST as *mut _ as *mut c_void);
        if frame_count == 0 {
            trace("frame 0: gu start ok");
        }

        let mut args = [JS_NewInt32(ctx, mask)];
        let r = JS_Call(ctx, frame_fn, global, 1, args.as_mut_ptr());
        if frame_count == 0 {
            trace("frame 0: JS_Call returned");
        }
        if JS_ValueGetTag(r) == JS_TAG_EXCEPTION {
            log_exception(ctx);
        }
        JS_FreeValue(ctx, r); // leak guard: free the return value every frame
        if frame_count == 0 {
            trace("frame 0: JS return freed");
        }

        // Drain queued microtask jobs (queueMicrotask polyfill = promise jobs).
        loop {
            let mut pctx: *mut JSContext = core::ptr::null_mut();
            if JS_ExecutePendingJob(rt, &mut pctx) <= 0 {
                break;
            }
        }
        if frame_count == 0 {
            trace("frame 0: pending jobs drained");
        }

        // Core frame: animations at fixed dt = 1/60, relayout if dirty, then
        // the DrawList into the open display list. The raw-slice dance keeps
        // borrowck happy about the single static-mut Ui (one thread; render
        // only reads atlases/textures, never the DrawList's owner mutably).
        let ui = ffi::ui();
        ui.tick();
        if frame_count == 0 {
            trace("frame 0: ui tick ok");
        }
        let (words_ptr, words_len) = {
            let dl = ui.draw();
            (dl.words.as_ptr(), dl.words.len())
        };
        if frame_count == 0 {
            trace("frame 0: ui draw ok");
        }
        ge::render(ffi::ui(), core::slice::from_raw_parts(words_ptr, words_len));
        if frame_count == 0 {
            trace("frame 0: rendered");
        }

        sys::sceGuFinish();
        if frame_count == 0 {
            trace("frame 0: gu finish ok");
        }
        sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
        if frame_count == 0 {
            trace("frame 0: gu sync ok");
        }
        sys::sceDisplayWaitVblankStart();
        if frame_count == 0 {
            trace("frame 0: vblank ok");
        }
        sys::sceGuSwapBuffers();
        if frame_count == 0 {
            trace("frame 0: swap ok");
        }
        // GE has finished reading (sceGuSync above): rewind the per-frame
        // bump vertex arena [R].
        ge::reset_pool();
        if frame_count == 0 {
            trace("frame 0: pool reset ok");
        }

        // Capture build only (test/e2e-ppsspp.ts): dump the just-presented
        // display framebuffer for frames CAP_START..CAP_START+CAP_N to
        // ms0:/dc_cap/fNNNN.raw. No-op everywhere but PPSSPPHeadless.
        #[cfg(feature = "capture")]
        cap_dump_frame(frame_count);
        if frame_count == 0 {
            trace("frame 0: complete");
        }

        frame_count = frame_count.wrapping_add(1);
    }
}

// ---------------------------------------------------------------------------
// Capture support (PPSSPPHeadless E2E, test/e2e-ppsspp.ts). Ported verbatim
// from origin/main:runtime/src/main.rs (parse_capture_u32, capture_input_mask,
// cap_dump_frame) with the capture window made per-build (POCKETJS_CAP_START /
// POCKETJS_CAP_N env, baked like the input script): PocketJS's frame 0 lands after
// the slow QuickJS bundle eval, but mount transitions and mount-started tweens
// (e.g. hero's 850 ms underline sweep) play out over the first frames, and
// each demo needs a different settle horizon.
// ---------------------------------------------------------------------------

#[cfg(feature = "capture")]
fn parse_capture_u32(s: &[u8], mut i: usize, end: usize) -> Option<u32> {
    while i < end && (s[i] == b' ' || s[i] == b'\t') {
        i += 1;
    }
    if i >= end {
        return None;
    }
    let hex = i + 1 < end && s[i] == b'0' && (s[i + 1] == b'x' || s[i + 1] == b'X');
    if hex {
        i += 2;
    }
    let mut out = 0u32;
    let mut any = false;
    while i < end {
        let c = s[i];
        let d = if c >= b'0' && c <= b'9' {
            c - b'0'
        } else if hex && c >= b'a' && c <= b'f' {
            c - b'a' + 10
        } else if hex && c >= b'A' && c <= b'F' {
            c - b'A' + 10
        } else if c == b' ' || c == b'\t' {
            break;
        } else {
            return None;
        };
        out = out.saturating_mul(if hex { 16 } else { 10 }).saturating_add(d as u32);
        any = true;
        i += 1;
    }
    if any { Some(out) } else { None }
}

/// Parse a baked decimal/hex env value (POCKETJS_CAP_START / POCKETJS_CAP_N),
/// falling back when the env was empty or malformed.
#[cfg(feature = "capture")]
fn capture_env_u32(s: &str, default: u32) -> u32 {
    let b = s.as_bytes();
    parse_capture_u32(b, 0, b.len()).unwrap_or(default)
}

/// Build-time scripted input for deterministic PPSSPPHeadless captures.
///
/// Format: `frame:mask,frame:mask` where mask may be decimal or hex. The
/// active mask is the last threshold at or before `frame_count`, so
/// `0:0,20:0x40,24:0` means idle, press DOWN at frame 20, release at 24.
#[cfg(feature = "capture")]
fn capture_input_mask(frame_count: u32, fallback: i32) -> i32 {
    let s = POCKETJS_CAPTURE_INPUT.as_bytes();
    if s.is_empty() {
        return fallback;
    }
    let mut i = 0usize;
    let mut best_frame: Option<u32> = None;
    let mut best_mask = fallback as u32;
    while i < s.len() {
        while i < s.len() && (s[i] == b',' || s[i] == b';' || s[i] == b' ' || s[i] == b'\t') {
            i += 1;
        }
        let frame_start = i;
        while i < s.len() && s[i] != b':' && s[i] != b',' && s[i] != b';' {
            i += 1;
        }
        if i >= s.len() || s[i] != b':' {
            break;
        }
        let frame_end = i;
        i += 1;
        let mask_start = i;
        while i < s.len() && s[i] != b',' && s[i] != b';' {
            i += 1;
        }
        let mask_end = i;
        if let (Some(frame), Some(mask)) = (
            parse_capture_u32(s, frame_start, frame_end),
            parse_capture_u32(s, mask_start, mask_end),
        ) {
            if frame <= frame_count && best_frame.map_or(true, |best| frame >= best) {
                best_frame = Some(frame);
                best_mask = mask;
            }
        }
    }
    best_mask as i32
}

/// Dump the just-presented display framebuffer to `ms0:/dc_cap/fNNNN.raw`
/// (512-stride RGBA top-down, as the GE wrote it) for the frames in the
/// capture window. One headless run thus yields a deterministic frame-per-
/// index sequence of the scripted input path. NNNN = frame_count - cap_start.
/// The window (POCKETJS_CAP_START/POCKETJS_CAP_N, baked per build) must match the
/// spec's capStart/capN in test/e2e-ppsspp.ts — the driver bakes both.
#[cfg(feature = "capture")]
unsafe fn cap_dump_frame(frame_count: u32) {
    // Defaults: skip boot transients + 150 ms mount transitions; 32 frames.
    let cap_start = capture_env_u32(POCKETJS_CAP_START, 16);
    let cap_n = capture_env_u32(POCKETJS_CAP_N, 32);
    if frame_count < cap_start || frame_count >= cap_start + cap_n {
        return;
    }
    let idx = frame_count - cap_start;
    if idx == 0 {
        sys::sceIoMkdir(b"ms0:/dc_cap\0".as_ptr(), 0o777);
    }
    // "ms0:/dc_cap/fNNNN.raw\0" with the 4 digits (offsets 13..=16) patched from idx.
    let mut name: [u8; 22] = *b"ms0:/dc_cap/f0000.raw\0";
    let mut v = idx;
    let mut i = 16usize;
    loop {
        name[i] = b'0' + (v % 10) as u8;
        v /= 10;
        if i == 13 {
            break;
        }
        i -= 1;
    }
    // Resolve the current display buffer and read it straight from VRAM
    // (uncached mirror, so we see the GE's fresh output, not stale cache).
    let mut top: *mut c_void = core::ptr::null_mut();
    let mut bw: usize = 0;
    let mut fmt = DisplayPixelFormat::Psm8888;
    sys::sceDisplayGetFrameBuf(&mut top, &mut bw, &mut fmt, DisplaySetBufSync::Immediate);
    let mut addr = top as u32;
    if addr < 0x0400_0000 {
        addr += 0x0400_0000;
    }
    addr |= 0x4000_0000;
    let fd = sys::sceIoOpen(
        name.as_ptr(),
        IoOpenFlags::CREAT | IoOpenFlags::WR_ONLY | IoOpenFlags::TRUNC,
        0o777,
    );
    if fd.0 >= 0 {
        sys::sceIoWrite(fd, addr as *const c_void, 512 * 272 * 4);
        sys::sceIoClose(fd);
    }
    if idx + 1 == cap_n {
        sys::sceKernelExitGame();
    }
}

unsafe fn halt(msg: &str) -> ! {
    trace_pair(b"[PocketJS halt] ", msg);
    psp::dprintln!("[PocketJS halt] {}", msg);
    psp::dprintln!("HOME exits. Last stage stays on screen.");
    loop {
        sys::sceDisplayWaitVblankStart();
    }
}

/// Load the AV codec modules the native <Video> component (video.rs) needs and
/// init the MPEG library. MANDATORY on real hardware — PPSSPP HLEs these for
/// free, but the metal will fail scePsmfPlayerCreate/decode without them.
/// Order matters: Atrac3Plus + MpegBase both require AvCodec first.
unsafe fn init_media() {
    sys::sceUtilityLoadAvModule(sys::AvModule::AvCodec);
    sys::sceUtilityLoadAvModule(sys::AvModule::MpegBase);
    sys::sceUtilityLoadAvModule(sys::AvModule::Atrac3Plus);
    sys::sceMpegInit();
}

/// Double-buffered 480x272 PSM8888 GU init — copied from dreamcart
/// runtime/src/main.rs init_graphics with the 3D-pass state trimmed to what a
/// 2D UI needs (scissor + smooth shading for gradient gouraud; depth test off).
unsafe fn init_graphics() {
    let allocator = match get_vram_allocator() {
        Ok(a) => a,
        Err(_) => halt("get_vram_allocator failed"),
    };
    let fbp0 = allocator
        .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, TexturePixelFormat::Psm8888)
        .as_mut_ptr_from_zero();
    let fbp1 = allocator
        .alloc_texture_pixels(BUF_WIDTH, SCREEN_HEIGHT, TexturePixelFormat::Psm8888)
        .as_mut_ptr_from_zero();

    sys::sceGuInit();
    sys::sceGuStart(GuContextType::Direct, &mut LIST as *mut _ as *mut c_void);
    sys::sceGuDrawBuffer(DisplayPixelFormat::Psm8888, fbp0 as _, BUF_WIDTH as i32);
    sys::sceGuDispBuffer(
        SCREEN_WIDTH as i32,
        SCREEN_HEIGHT as i32,
        fbp1 as _,
        BUF_WIDTH as i32,
    );
    sys::sceGuOffset(2048 - (SCREEN_WIDTH / 2), 2048 - (SCREEN_HEIGHT / 2));
    sys::sceGuViewport(2048, 2048, SCREEN_WIDTH as i32, SCREEN_HEIGHT as i32);
    sys::sceGuScissor(0, 0, SCREEN_WIDTH as i32, SCREEN_HEIGHT as i32);
    sys::sceGuEnable(GuState::ScissorTest);
    // Smooth shading: gradient rects gouraud-interpolate per-vertex color.
    sys::sceGuShadeModel(ShadingModel::Smooth);
    sys::sceGuFinish();
    sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
    sys::sceDisplayWaitVblankStart();
    sys::sceGuDisplay(true);
}
