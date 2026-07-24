use pocketjs_core::{text::Atlas, Ui};

pub const LOGICAL_W: i32 = 480;
pub const LOGICAL_H: i32 = 272;
pub const RASTER_DENSITY: u32 = 2;
pub const INTEGER_SCALE: u32 = 2;
pub const CONTENT_W: usize = LOGICAL_W as usize * INTEGER_SCALE as usize;
pub const CONTENT_H: usize = LOGICAL_H as usize * INTEGER_SCALE as usize;
pub const CONTENT_BYTES: usize = CONTENT_W * CONTENT_H * 4;

pub fn register_texture(_ui: &Ui, _handle: i32) {}

pub fn free_texture(_handle: i32) {}

pub fn register_font_atlas(_slot: u8, _atlas: &Atlas) {}
