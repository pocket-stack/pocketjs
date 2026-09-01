use core::ffi::{c_char, c_void};

pub const API_VERSION: u32 = 1;
pub const ENV_SET_PIXEL_FORMAT: u32 = 10;
pub const PIXEL_FORMAT_RGB565: u32 = 2;
pub const DEVICE_JOYPAD: u32 = 1;
pub const REGION_NTSC: u32 = 0;

pub mod joypad {
    pub const B: u32 = 0;
    pub const Y: u32 = 1;
    pub const SELECT: u32 = 2;
    pub const START: u32 = 3;
    pub const UP: u32 = 4;
    pub const DOWN: u32 = 5;
    pub const LEFT: u32 = 6;
    pub const RIGHT: u32 = 7;
    pub const A: u32 = 8;
    pub const X: u32 = 9;
    pub const L: u32 = 10;
    pub const R: u32 = 11;
}

pub type Environment = unsafe extern "C" fn(u32, *mut c_void) -> bool;
pub type VideoRefresh = unsafe extern "C" fn(*const c_void, u32, u32, usize);
pub type AudioSample = unsafe extern "C" fn(i16, i16);
pub type AudioBatch = unsafe extern "C" fn(*const i16, usize) -> usize;
pub type InputPoll = unsafe extern "C" fn();
pub type InputState = unsafe extern "C" fn(u32, u32, u32, u32) -> i16;

#[repr(C)]
pub struct SystemInfo {
    pub library_name: *const c_char,
    pub library_version: *const c_char,
    pub valid_extensions: *const c_char,
    pub need_fullpath: bool,
    pub block_extract: bool,
}

#[repr(C)]
pub struct GameGeometry {
    pub base_width: u32,
    pub base_height: u32,
    pub max_width: u32,
    pub max_height: u32,
    pub aspect_ratio: f32,
}

#[repr(C)]
pub struct SystemTiming {
    pub fps: f64,
    pub sample_rate: f64,
}

#[repr(C)]
pub struct SystemAvInfo {
    pub geometry: GameGeometry,
    pub timing: SystemTiming,
}

#[repr(C)]
pub struct GameInfo {
    pub path: *const c_char,
    pub data: *const c_void,
    pub size: usize,
    pub meta: *const c_char,
}
