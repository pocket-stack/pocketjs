#![cfg_attr(not(feature = "std"), no_std)]
#![cfg_attr(not(feature = "std"), feature(alloc_error_handler))]
#![allow(static_mut_refs)]

extern crate alloc;

#[cfg(not(feature = "std"))]
mod allocator;
mod ffi;
mod libretro;
mod pak;

use alloc::vec;
use alloc::vec::Vec;
#[cfg(not(feature = "std"))]
use core::alloc::Layout;
use core::ffi::c_void;
use core::ptr;

use libquickjs_sys::*;
use pocketjs_core::{package, raster, spec};

use libretro::*;

const WIDTH: u32 = 320;
const HEIGHT: u32 = 240;
const FPS: f64 = 60.0;

static mut ENVIRONMENT: Option<Environment> = None;
static mut VIDEO_REFRESH: Option<VideoRefresh> = None;
static mut AUDIO_SAMPLE: Option<AudioSample> = None;
static mut AUDIO_BATCH: Option<AudioBatch> = None;
static mut INPUT_POLL: Option<InputPoll> = None;
static mut INPUT_STATE: Option<InputState> = None;

struct RuntimeState {
    runtime: *mut JSRuntime,
    context: *mut JSContext,
    global: JSValue,
    frame: JSValue,
    framebuffer: Vec<u16>,
}

static mut STATE: Option<RuntimeState> = None;

extern "C" {
    fn JS_ExecutePendingJob(runtime: *mut JSRuntime, context: *mut *mut JSContext) -> i32;
    fn JS_NewArrayBuffer(
        context: *mut JSContext,
        buffer: *mut u8,
        length: usize,
        free_fn: Option<unsafe extern "C" fn(*mut JSRuntime, *mut c_void, *mut c_void)>,
        opaque: *mut c_void,
        shared: i32,
    ) -> JSValue;
}

#[no_mangle]
pub unsafe extern "C" fn retro_set_environment(callback: Option<Environment>) {
    ENVIRONMENT = callback;
}

#[no_mangle]
pub unsafe extern "C" fn retro_set_video_refresh(callback: Option<VideoRefresh>) {
    VIDEO_REFRESH = callback;
}

#[no_mangle]
pub unsafe extern "C" fn retro_set_audio_sample(callback: Option<AudioSample>) {
    AUDIO_SAMPLE = callback;
}

#[no_mangle]
pub unsafe extern "C" fn retro_set_audio_sample_batch(callback: Option<AudioBatch>) {
    AUDIO_BATCH = callback;
}

#[no_mangle]
pub unsafe extern "C" fn retro_set_input_poll(callback: Option<InputPoll>) {
    INPUT_POLL = callback;
}

#[no_mangle]
pub unsafe extern "C" fn retro_set_input_state(callback: Option<InputState>) {
    INPUT_STATE = callback;
}

#[no_mangle]
pub unsafe extern "C" fn retro_init() {
    if let Some(environment) = ENVIRONMENT {
        let mut format = PIXEL_FORMAT_RGB565;
        environment(ENV_SET_PIXEL_FORMAT, (&mut format as *mut u32).cast());
    }
}

#[no_mangle]
pub unsafe extern "C" fn retro_deinit() {
    retro_unload_game();
}

#[no_mangle]
pub extern "C" fn retro_api_version() -> u32 {
    API_VERSION
}

#[no_mangle]
pub unsafe extern "C" fn retro_get_system_info(info: *mut SystemInfo) {
    if let Some(info) = info.as_mut() {
        *info = SystemInfo {
            library_name: b"PocketJS\0".as_ptr().cast(),
            library_version: b"0.1.0\0".as_ptr().cast(),
            valid_extensions: b"pocket\0".as_ptr().cast(),
            need_fullpath: false,
            block_extract: false,
        };
    }
}

#[no_mangle]
pub unsafe extern "C" fn retro_get_system_av_info(info: *mut SystemAvInfo) {
    if let Some(info) = info.as_mut() {
        *info = SystemAvInfo {
            geometry: GameGeometry {
                base_width: WIDTH,
                base_height: HEIGHT,
                max_width: WIDTH,
                max_height: HEIGHT,
                aspect_ratio: WIDTH as f32 / HEIGHT as f32,
            },
            timing: SystemTiming {
                fps: FPS,
                sample_rate: 44_100.0,
            },
        };
    }
}

#[no_mangle]
pub extern "C" fn retro_set_controller_port_device(_port: u32, _device: u32) {}

#[no_mangle]
pub unsafe extern "C" fn retro_load_game(game: *const GameInfo) -> bool {
    retro_unload_game();
    let Some(game) = game.as_ref() else {
        return false;
    };
    if game.data.is_null() || game.size == 0 {
        return false;
    }
    let bytes = core::slice::from_raw_parts(game.data.cast::<u8>(), game.size);
    let Ok(guest) = package::select_guest(bytes, "sf2000", 1, false) else {
        return false;
    };

    let ui = ffi::init_ui();
    let (textures, sprites) = pak::feed(ui, guest.pak);
    let pak_static: &'static [u8] = core::mem::transmute(guest.pak);
    ffi::install_pak(pak_static);

    let runtime = JS_NewRuntime();
    if runtime.is_null() {
        ffi::drop_ui();
        return false;
    }
    let context = JS_NewContext(runtime);
    if context.is_null() {
        JS_FreeRuntime(runtime);
        ffi::drop_ui();
        return false;
    }
    let global = JS_GetGlobalObject(context);
    ffi::register(context, global, &textures, &sprites);
    JS_SetPropertyStr(
        context,
        global,
        b"__simHz\0".as_ptr().cast(),
        JS_NewInt32(context, FPS as i32),
    );
    if !guest.pak.is_empty() {
        let buffer = JS_NewArrayBuffer(
            context,
            guest.pak.as_ptr() as *mut u8,
            guest.pak.len(),
            None,
            ptr::null_mut(),
            0,
        );
        JS_SetPropertyStr(context, global, b"__pak\0".as_ptr().cast(), buffer);
    }
    let result = JS_Eval(
        context,
        guest.js.as_ptr().cast(),
        guest.js.len() - 1,
        b"app.js\0".as_ptr().cast(),
        JS_EVAL_TYPE_GLOBAL as i32,
    );
    if JS_ValueGetTag(result) == JS_TAG_EXCEPTION {
        JS_FreeValue(context, result);
        JS_FreeValue(context, global);
        JS_FreeContext(context);
        JS_FreeRuntime(runtime);
        ffi::drop_ui();
        return false;
    }
    JS_FreeValue(context, result);
    let frame = JS_GetPropertyStr(context, global, b"frame\0".as_ptr().cast());
    if JS_IsUndefined(frame) {
        JS_FreeValue(context, frame);
        JS_FreeValue(context, global);
        JS_FreeContext(context);
        JS_FreeRuntime(runtime);
        ffi::drop_ui();
        return false;
    }
    STATE = Some(RuntimeState {
        runtime,
        context,
        global,
        frame,
        framebuffer: vec![0; (WIDTH * HEIGHT) as usize],
    });
    true
}

fn button(id: u32) -> bool {
    unsafe {
        INPUT_STATE
            .map(|state| state(0, DEVICE_JOYPAD, 0, id) != 0)
            .unwrap_or(false)
    }
}

fn buttons() -> u32 {
    let mut mask = 0;
    for (id, value) in [
        (joypad::SELECT, spec::btn::SELECT),
        (joypad::START, spec::btn::START),
        (joypad::UP, spec::btn::UP),
        (joypad::RIGHT, spec::btn::RIGHT),
        (joypad::DOWN, spec::btn::DOWN),
        (joypad::LEFT, spec::btn::LEFT),
        (joypad::L, spec::btn::LTRIGGER),
        (joypad::R, spec::btn::RTRIGGER),
        (joypad::X, spec::btn::TRIANGLE),
        (joypad::A, spec::btn::CIRCLE),
        (joypad::B, spec::btn::CROSS),
        (joypad::Y, spec::btn::SQUARE),
    ] {
        if button(id) {
            mask |= value;
        }
    }
    mask
}

#[no_mangle]
pub unsafe extern "C" fn retro_run() {
    let Some(state) = STATE.as_mut() else { return };
    if let Some(poll) = INPUT_POLL {
        poll();
    }
    let mut args = [
        JS_NewInt32(state.context, buttons() as i32),
        JS_NewInt32(state.context, spec::ANALOG_CENTER as i32),
    ];
    let result = JS_Call(
        state.context,
        state.frame,
        state.global,
        2,
        args.as_mut_ptr(),
    );
    JS_FreeValue(state.context, result);
    loop {
        let mut job_context = ptr::null_mut();
        if JS_ExecutePendingJob(state.runtime, &mut job_context) <= 0 {
            break;
        }
    }
    let ui = ffi::ui();
    ui.tick();
    let (words, len) = {
        let draw = ui.draw();
        (draw.words.as_ptr(), draw.words.len())
    };
    raster::render_scaled_rgb565(
        ui,
        core::slice::from_raw_parts(words, len),
        &mut state.framebuffer,
        1,
    );
    if let Some(video) = VIDEO_REFRESH {
        video(
            state.framebuffer.as_ptr().cast(),
            WIDTH,
            HEIGHT,
            WIDTH as usize * 2,
        );
    }
}

#[no_mangle]
pub unsafe extern "C" fn retro_unload_game() {
    if let Some(state) = STATE.take() {
        JS_FreeValue(state.context, state.frame);
        JS_FreeValue(state.context, state.global);
        JS_FreeContext(state.context);
        JS_FreeRuntime(state.runtime);
    }
    ffi::drop_ui();
}

#[no_mangle]
pub extern "C" fn retro_get_region() -> u32 {
    REGION_NTSC
}
#[no_mangle]
pub extern "C" fn retro_serialize_size() -> usize {
    0
}
#[no_mangle]
pub extern "C" fn retro_serialize(_data: *mut c_void, _size: usize) -> bool {
    false
}
#[no_mangle]
pub extern "C" fn retro_unserialize(_data: *const c_void, _size: usize) -> bool {
    false
}
#[no_mangle]
pub extern "C" fn retro_get_memory_data(_id: u32) -> *mut c_void {
    ptr::null_mut()
}
#[no_mangle]
pub extern "C" fn retro_get_memory_size(_id: u32) -> usize {
    0
}
#[no_mangle]
pub extern "C" fn retro_cheat_reset() {}
#[no_mangle]
pub extern "C" fn retro_cheat_set(_index: u32, _enabled: bool, _code: *const i8) {}

#[cfg(not(feature = "std"))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

#[cfg(not(feature = "std"))]
#[alloc_error_handler]
fn out_of_memory(_layout: Layout) -> ! {
    loop {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sf2000_geometry_matches_panel() {
        assert_eq!((WIDTH, HEIGHT), (320, 240));
    }
}
