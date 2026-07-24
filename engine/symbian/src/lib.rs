//! Symbian C ABI for PocketJS's retained UI core and deterministic software
//! rasterizer.
//!
//! The Qt host owns QuickJS and calls this library synchronously from its UI
//! thread. There is exactly one `Ui` instance. Strings and blobs are borrowed
//! as `(ptr, len)` for the duration of a call and copied by the core whenever
//! they must outlive it.
//!
//! Rendering returns tightly packed, top-left-origin ARGB32 pixels. On the
//! little-endian ARM target that is B,G,R,A byte order, exactly what Qt 4's
//! `QImage::Format_ARGB32` expects. The pointer remains valid until the next
//! render, viewport change, init, or shutdown call.

#![cfg_attr(target_os = "none", no_std)]
#![cfg_attr(target_os = "none", feature(alloc_error_handler))]
#![allow(static_mut_refs)]
#![allow(clippy::not_unsafe_ptr_arg_deref)]

extern crate alloc;

use alloc::vec::Vec;
#[cfg(target_os = "none")]
use core::alloc::{GlobalAlloc, Layout};
#[cfg(target_os = "none")]
use core::ffi::c_void;
use pocketjs_core::damage::{DamagePolicy, DamageTracker, DEFAULT_DAMAGE_REGIONS};
use pocketjs_core::raster;
use pocketjs_core::Ui;

#[cfg(target_os = "none")]
unsafe extern "C" {
    fn malloc(size: usize) -> *mut c_void;
    fn realloc(ptr: *mut c_void, size: usize) -> *mut c_void;
    fn free(ptr: *mut c_void);
    fn abort() -> !;
}

#[cfg(target_os = "none")]
struct CAllocator;

#[cfg(target_os = "none")]
unsafe impl GlobalAlloc for CAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        malloc(layout.size().max(1)).cast()
    }

    unsafe fn dealloc(&self, ptr: *mut u8, _layout: Layout) {
        free(ptr.cast());
    }

    unsafe fn realloc(&self, ptr: *mut u8, _layout: Layout, size: usize) -> *mut u8 {
        realloc(ptr.cast(), size.max(1)).cast()
    }
}

#[cfg(target_os = "none")]
#[global_allocator]
static ALLOCATOR: CAllocator = CAllocator;

#[cfg(target_os = "none")]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    unsafe { abort() }
}

#[cfg(target_os = "none")]
#[alloc_error_handler]
fn allocation_error(_layout: Layout) -> ! {
    unsafe { abort() }
}

static mut UI: Option<Ui> = None;
static mut FRAMEBUFFER: Vec<u8> = Vec::new();
static mut DAMAGE_TRACKER: DamageTracker<DEFAULT_DAMAGE_REGIONS> = DamageTracker::new();
static mut FRAMEBUFFER_WIDTH: u32 = 0;
static mut FRAMEBUFFER_HEIGHT: u32 = 0;
static mut FRAMEBUFFER_STRIDE: u32 = 0;

#[inline]
fn ui() -> &'static mut Ui {
    unsafe { UI.get_or_insert_with(Ui::new) }
}

#[inline]
unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        core::slice::from_raw_parts(ptr, len)
    }
}

#[inline]
unsafe fn text<'a>(ptr: *const u8, len: usize) -> &'a str {
    core::str::from_utf8(bytes(ptr, len)).unwrap_or("")
}

#[inline]
fn read_f64_le(record: &[u8], offset: usize) -> f64 {
    let mut raw = [0u8; 8];
    raw.copy_from_slice(&record[offset..offset + 8]);
    f64::from_le_bytes(raw)
}

fn clear_framebuffer() {
    unsafe {
        FRAMEBUFFER.clear();
        DAMAGE_TRACKER = DamageTracker::new();
        FRAMEBUFFER_WIDTH = 0;
        FRAMEBUFFER_HEIGHT = 0;
        FRAMEBUFFER_STRIDE = 0;
    }
}

// ---- lifecycle and transfer buffers ---------------------------------------

/// Reset the single UI instance. `raster_density == 0` selects density 1.
#[no_mangle]
pub extern "C" fn ui_init(raster_density: u32) {
    unsafe {
        UI = Some(Ui::new_with_raster_density(raster_density.max(1)));
    }
    clear_framebuffer();
}

/// Drop all retained UI, texture, font, and framebuffer allocations.
#[no_mangle]
pub extern "C" fn ui_shutdown() {
    unsafe {
        UI = None;
    }
    clear_framebuffer();
}

/// Set the logical viewport. The E7 host follows the current full-screen Qt
/// client size, including 640x360 landscape and 360x640 portrait.
#[no_mangle]
pub extern "C" fn ui_set_viewport(width: f32, height: f32) {
    ui().set_viewport(width, height);
    clear_framebuffer();
}

#[no_mangle]
pub extern "C" fn ui_viewport_width() -> u32 {
    ui().viewport().0 as u32
}

#[no_mangle]
pub extern "C" fn ui_viewport_height() -> u32 {
    ui().viewport().1 as u32
}

/// Optional C-side scratch allocation. The caller must release it with the
/// exact same `len`; ordinary borrowed HostOps arguments do not need this.
#[no_mangle]
pub extern "C" fn ui_alloc(len: usize) -> *mut u8 {
    let mut value = Vec::<u8>::with_capacity(len.max(1));
    let ptr = value.as_mut_ptr();
    core::mem::forget(value);
    ptr
}

#[no_mangle]
pub extern "C" fn ui_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        unsafe {
            drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
        }
    }
}

// ---- HostOps core ----------------------------------------------------------

#[no_mangle]
pub extern "C" fn ui_create_node(node_type: u32) -> i32 {
    ui().create_node(node_type as u8)
}

#[no_mangle]
pub extern "C" fn ui_destroy_node(id: i32) {
    ui().destroy_node(id);
}

#[no_mangle]
pub extern "C" fn ui_insert_before(parent: i32, child: i32, anchor: i32) {
    ui().insert_before(parent, child, anchor);
}

#[no_mangle]
pub extern "C" fn ui_remove_child(parent: i32, child: i32) {
    ui().remove_child(parent, child);
}

#[no_mangle]
pub extern "C" fn ui_set_style(id: i32, style_id: i32) {
    ui().set_style(id, style_id);
}

#[no_mangle]
pub extern "C" fn ui_set_prop(id: i32, prop: u32, value: f64) {
    ui().set_prop(id, prop as u8, value);
}

/// Apply packed little-endian Float64 triples `[nodeId, propId, value]`.
/// A trailing partial record is ignored.
#[no_mangle]
pub extern "C" fn ui_set_prop_batch(ptr: *const u8, len: usize) {
    let (records, _) = unsafe { bytes(ptr, len) }.as_chunks::<24>();
    let instance = ui();
    for record in records {
        instance.set_prop(
            read_f64_le(record, 0) as i32,
            read_f64_le(record, 8) as u8,
            read_f64_le(record, 16),
        );
    }
}

#[no_mangle]
pub extern "C" fn ui_set_text(id: i32, ptr: *const u8, len: usize) {
    ui().set_text(id, unsafe { text(ptr, len) });
}

#[no_mangle]
pub extern "C" fn ui_replace_text(id: i32, ptr: *const u8, len: usize) {
    ui().replace_text(id, unsafe { text(ptr, len) });
}

#[no_mangle]
pub extern "C" fn ui_upload_texture(
    ptr: *const u8,
    len: usize,
    width: u32,
    height: u32,
    psm: u32,
) -> i32 {
    ui().upload_texture(unsafe { bytes(ptr, len) }, width, height, psm)
}

#[no_mangle]
pub extern "C" fn ui_upload_img_entry(ptr: *const u8, len: usize) -> i32 {
    ui().upload_img_entry(unsafe { bytes(ptr, len) })
}

/// Decode one tile from a complete TILESET pak entry.
#[no_mangle]
pub extern "C" fn ui_upload_tileset_tile(ptr: *const u8, len: usize, index: u32) -> i32 {
    ui().upload_tileset_tile(unsafe { bytes(ptr, len) }, index)
}

#[no_mangle]
pub extern "C" fn ui_update_texture_t8(
    handle: i32,
    palette_ptr: *const u8,
    palette_len: usize,
    pixels_ptr: *const u8,
    pixels_len: usize,
) -> i32 {
    ui().update_texture_t8(handle, unsafe { bytes(palette_ptr, palette_len) }, unsafe {
        bytes(pixels_ptr, pixels_len)
    }) as i32
}

#[no_mangle]
pub extern "C" fn ui_free_texture(handle: i32) {
    ui().free_texture(handle);
}

#[no_mangle]
pub extern "C" fn ui_set_image(id: i32, texture: i32) {
    ui().set_image(id, texture);
}

#[no_mangle]
pub extern "C" fn ui_set_sprite(id: i32, atlas: i32, frames: u32, columns: u32, step: u32) {
    ui().set_sprite(id, atlas, frames, columns, step);
}

#[no_mangle]
pub extern "C" fn ui_animate(
    id: i32,
    prop: u32,
    to: f64,
    duration_ms: u32,
    easing: u32,
    delay_ms: u32,
) -> i32 {
    ui().animate(id, prop as u8, to, duration_ms, easing as u8, delay_ms)
}

#[no_mangle]
pub extern "C" fn ui_cancel_anim(animation_id: i32) {
    ui().cancel_anim(animation_id);
}

#[no_mangle]
pub extern "C" fn ui_set_focus(id: i32) {
    ui().set_focus(id);
}

#[no_mangle]
pub extern "C" fn ui_set_active(id: i32, active: i32) {
    ui().set_active(id, active != 0);
}

#[no_mangle]
pub extern "C" fn ui_hit_test(x: f32, y: f32) -> i32 {
    ui().hit_test(x, y)
}

#[no_mangle]
pub extern "C" fn ui_set_cursor(texture: i32, hot_x: f32, hot_y: f32, width: f32, height: f32) {
    ui().set_cursor(texture, hot_x, hot_y, width, height);
}

#[no_mangle]
pub extern "C" fn ui_set_cursor_pos(x: f32, y: f32) {
    ui().set_cursor_pos(x, y);
}

#[no_mangle]
pub extern "C" fn ui_load_styles(ptr: *const u8, len: usize) -> i32 {
    ui().load_styles(unsafe { bytes(ptr, len) }) as i32
}

#[no_mangle]
pub extern "C" fn ui_load_font_atlas(ptr: *const u8, len: usize) -> i32 {
    ui().load_font_atlas(unsafe { bytes(ptr, len) }) as i32
}

#[no_mangle]
pub extern "C" fn ui_measure_text(ptr: *const u8, len: usize, font_slot: u32) -> f32 {
    ui().measure_text(unsafe { text(ptr, len) }, font_slot as u8)
}

// ---- fixed-step frame and DevTools ----------------------------------------

#[no_mangle]
pub extern "C" fn ui_tick() {
    ui().tick();
}

#[no_mangle]
pub extern "C" fn ui_draw_hash() -> u64 {
    draw_hash(&ui().draw().words)
}

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

#[no_mangle]
pub extern "C" fn ui_debug_inspect(id: i32) {
    ui().debug_inspect(id);
}

#[no_mangle]
pub extern "C" fn ui_debug_rect_xy() -> i32 {
    ui().debug_rect_xy()
}

#[no_mangle]
pub extern "C" fn ui_debug_rect_wh() -> i32 {
    ui().debug_rect_wh()
}

#[no_mangle]
pub extern "C" fn ui_debug_pause(on: i32) {
    ui().debug_pause(on != 0);
}

#[no_mangle]
pub extern "C" fn ui_debug_step() {
    ui().debug_step();
}

// ---- Qt-compatible ARGB32 framebuffer -------------------------------------

fn framebuffer_geometry(instance: &Ui, scale: u32) -> Option<(usize, usize, usize)> {
    if !(1..=raster::MAX_RENDER_SCALE).contains(&scale) {
        return None;
    }
    let (logical_width, logical_height) = instance.viewport();
    let width = (logical_width as usize).checked_mul(scale as usize)?;
    let height = (logical_height as usize).checked_mul(scale as usize)?;
    let byte_len = width.checked_mul(height)?.checked_mul(4)?;
    Some((width, height, byte_len))
}

fn remember_framebuffer_geometry(width: usize, height: usize) {
    unsafe {
        FRAMEBUFFER_WIDTH = width as u32;
        FRAMEBUFFER_HEIGHT = height as u32;
        FRAMEBUFFER_STRIDE = (width * 4) as u32;
    }
}

fn render_at_scale(scale: u32, incremental: bool) -> *const u8 {
    let instance = ui();
    let Some((width, height, byte_len)) = framebuffer_geometry(instance, scale) else {
        return core::ptr::null();
    };
    let draw_list: *const pocketjs_core::DrawList = instance.draw();
    let instance_ref: &Ui = unsafe { &*(instance as *const Ui) };

    unsafe {
        if FRAMEBUFFER.len() != byte_len {
            FRAMEBUFFER.resize(byte_len, 0);
            DAMAGE_TRACKER.invalidate();
        }

        if incremental {
            if raster::render_scaled_argb_incremental(
                instance_ref,
                &(*draw_list).words,
                &mut FRAMEBUFFER,
                scale,
                &mut DAMAGE_TRACKER,
                DamagePolicy::default(),
            )
            .is_err()
            {
                raster::render_scaled_argb(
                    instance_ref,
                    &(*draw_list).words,
                    &mut FRAMEBUFFER,
                    scale,
                );
                DAMAGE_TRACKER.invalidate();
            }
        } else {
            raster::render_scaled_argb(instance_ref, &(*draw_list).words, &mut FRAMEBUFFER, scale);
            DAMAGE_TRACKER.invalidate();
        }

        remember_framebuffer_geometry(width, height);
        FRAMEBUFFER.as_ptr()
    }
}

/// Full ARGB32 render at the logical viewport size.
#[no_mangle]
pub extern "C" fn ui_render() -> *const u8 {
    render_at_scale(1, false)
}

#[no_mangle]
pub extern "C" fn ui_render_scaled(scale: u32) -> *const u8 {
    render_at_scale(scale, false)
}

#[no_mangle]
pub extern "C" fn ui_render_incremental() -> *const u8 {
    render_at_scale(1, true)
}

#[no_mangle]
pub extern "C" fn ui_render_incremental_scaled(scale: u32) -> *const u8 {
    render_at_scale(scale, true)
}

#[no_mangle]
pub extern "C" fn ui_framebuffer_width() -> u32 {
    unsafe { FRAMEBUFFER_WIDTH }
}

#[no_mangle]
pub extern "C" fn ui_framebuffer_height() -> u32 {
    unsafe { FRAMEBUFFER_HEIGHT }
}

#[no_mangle]
pub extern "C" fn ui_framebuffer_stride() -> u32 {
    unsafe { FRAMEBUFFER_STRIDE }
}

#[no_mangle]
pub extern "C" fn ui_framebuffer_len() -> usize {
    unsafe { FRAMEBUFFER.len() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocketjs_core::spec;

    #[test]
    fn hash_is_stable_and_argb_framebuffer_matches_qimage_layout() {
        let words = [0x0102_0304, 0x0506_0708];
        assert_eq!(draw_hash(&words), draw_hash(&words));
        assert_ne!(draw_hash(&words), draw_hash(&[0x0102_0304, 0x0506_0709]));

        ui_init(1);
        ui_set_viewport(2.0, 1.0);
        // Packed ABGR: R=0x33, G=0x22, B=0x11, A=0xff.
        ui_set_prop(
            spec::ROOT_ID,
            spec::prop::BG_COLOR as u32,
            0xff11_2233u32 as f64,
        );
        ui_tick();
        let framebuffer = ui_render();
        assert!(!framebuffer.is_null());
        assert_eq!(ui_framebuffer_width(), 2);
        assert_eq!(ui_framebuffer_height(), 1);
        assert_eq!(ui_framebuffer_stride(), 8);
        assert_eq!(ui_framebuffer_len(), 8);
        let pixels = unsafe { core::slice::from_raw_parts(framebuffer, 8) };
        assert_eq!(pixels, &[0x11, 0x22, 0x33, 0xff, 0x11, 0x22, 0x33, 0xff]);
        ui_shutdown();
    }
}
