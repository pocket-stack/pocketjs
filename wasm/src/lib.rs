//! pocketjs-wasm — extern "C" mirror of the core op surface + software
//! rasterizer, for wasm32-unknown-unknown (no wasm-bindgen; the JS host talks
//! plain numbers + wasm linear memory).
//!
//! src/raster.rs holds the deterministic rasterizer (blend, gradients,
//! triangles, glyphs, textures); `ui_render()` runs the core DrawList through
//! it into FRAMEBUFFER.
//!
//! ABI (all little-endian, one exported fn per spec::op code):
//!   - Strings/buffers cross via linear memory: the host calls
//!     `ui_alloc(len)`, writes bytes at the returned offset, passes
//!     (ptr, len), then `ui_free(ptr, len)`. UTF-8 for text.
//!   - `ui_render()` returns the framebuffer pointer: RGBA8, tightly packed,
//!     SCREEN_W * SCREEN_H * 4 bytes, row-major, top-left origin. The pointer
//!     is stable for the instance lifetime.
//!   - Single-threaded by construction (one wasm instance per Ui).

#![allow(static_mut_refs)] // single-threaded wasm instance; one global Ui
// Every (ptr, len) export dereferences a host-written linear-memory buffer;
// safety IS the ABI contract (ui_alloc/ui_free above), not a Rust signature.
#![allow(clippy::not_unsafe_ptr_arg_deref)]

use pocketjs_core::spec::{SCREEN_H, SCREEN_W};
use pocketjs_core::Ui;

mod raster;

const FB_BYTES: usize = (SCREEN_W * SCREEN_H * 4) as usize;

static mut UI: Option<Ui> = None;
static mut FRAMEBUFFER: [u8; FB_BYTES] = [0; FB_BYTES];

#[inline]
fn ui() -> &'static mut Ui {
    unsafe { UI.get_or_insert_with(Ui::new) }
}

/// Borrow (ptr, len) from wasm linear memory. Empty slice on null.
#[inline]
unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        core::slice::from_raw_parts(ptr, len)
    }
}

/// Borrow (ptr, len) as UTF-8 (lossy inputs are rejected -> "").
#[inline]
unsafe fn text<'a>(ptr: *const u8, len: usize) -> &'a str {
    core::str::from_utf8(bytes(ptr, len)).unwrap_or("")
}

// ---- lifecycle -------------------------------------------------------------

/// Create (or reset) the Ui instance. Idempotent; call before anything else.
#[no_mangle]
pub extern "C" fn ui_init() {
    unsafe { UI = Some(Ui::new()) };
}

/// Allocate `len` bytes of scratch in linear memory for host -> wasm buffers.
#[no_mangle]
pub extern "C" fn ui_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let ptr = v.as_mut_ptr();
    core::mem::forget(v);
    ptr
}

/// Free a buffer previously returned by `ui_alloc` with the same `len`.
#[no_mangle]
pub extern "C" fn ui_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        unsafe { drop(Vec::from_raw_parts(ptr, 0, len.max(1))) };
    }
}

// ---- op mirror (see spec::op + DESIGN.md "The native contract") -------------

#[no_mangle]
pub extern "C" fn ui_create_node(node_type: u32) -> i32 {
    ui().create_node(node_type as u8)
}

#[no_mangle]
pub extern "C" fn ui_destroy_node(id: i32) {
    ui().destroy_node(id)
}

#[no_mangle]
pub extern "C" fn ui_insert_before(parent: i32, child: i32, anchor: i32) {
    ui().insert_before(parent, child, anchor)
}

#[no_mangle]
pub extern "C" fn ui_remove_child(parent: i32, child: i32) {
    ui().remove_child(parent, child)
}

#[no_mangle]
pub extern "C" fn ui_set_style(id: i32, style_id: i32) {
    ui().set_style(id, style_id)
}

#[no_mangle]
pub extern "C" fn ui_set_prop(id: i32, prop: u32, value: f64) {
    ui().set_prop(id, prop as u8, value)
}

#[no_mangle]
pub extern "C" fn ui_set_text(id: i32, ptr: *const u8, len: usize) {
    ui().set_text(id, unsafe { text(ptr, len) })
}

#[no_mangle]
pub extern "C" fn ui_replace_text(id: i32, ptr: *const u8, len: usize) {
    ui().replace_text(id, unsafe { text(ptr, len) })
}

#[no_mangle]
pub extern "C" fn ui_upload_texture(ptr: *const u8, len: usize, w: u32, h: u32, psm: u32) -> i32 {
    ui().upload_texture(unsafe { bytes(ptr, len) }, w, h, psm)
}

/// Upload a self-contained IMG pak entry (spec op uploadImgEntry;
/// compiler/pak.ts layout — v2 PSM_T8 palette + optional RLE + filter flags
/// parsed core-side). Returns the generation-tagged handle or -1.
#[no_mangle]
pub extern "C" fn ui_upload_img_entry(ptr: *const u8, len: usize) -> i32 {
    ui().upload_img_entry(unsafe { bytes(ptr, len) })
}

/// Release a texture slot (spec op freeTexture). Stale handles are no-ops;
/// anything still referencing the freed handle draws nothing.
/// (No tileset op here — wasm hosts stream tiles via the JS __pak fallback
/// and this entry point.)
#[no_mangle]
pub extern "C" fn ui_free_texture(handle: i32) {
    ui().free_texture(handle)
}

#[no_mangle]
pub extern "C" fn ui_set_image(id: i32, tex: i32) {
    ui().set_image(id, tex)
}

#[no_mangle]
pub extern "C" fn ui_set_sprite(id: i32, atlas: i32, frames: u32, cols: u32, step: u32) {
    ui().set_sprite(id, atlas, frames, cols, step)
}

#[no_mangle]
pub extern "C" fn ui_animate(
    id: i32,
    prop: u32,
    to: f64,
    dur_ms: u32,
    easing: u32,
    delay_ms: u32,
) -> i32 {
    ui().animate(id, prop as u8, to, dur_ms, easing as u8, delay_ms)
}

#[no_mangle]
pub extern "C" fn ui_cancel_anim(anim_id: i32) {
    ui().cancel_anim(anim_id)
}

#[no_mangle]
pub extern "C" fn ui_set_focus(id: i32) {
    ui().set_focus(id)
}

#[no_mangle]
pub extern "C" fn ui_set_active(id: i32, active: i32) {
    ui().set_active(id, active != 0)
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

// ---- frame ------------------------------------------------------------------

/// Advance one fixed-dt (1/60 s) frame: animations, then layout if dirty.
#[no_mangle]
pub extern "C" fn ui_tick() {
    ui().tick()
}

// ---- DevTools ops (spec ops 18..22, DEVTOOLS.md) -----------------------------

#[no_mangle]
pub extern "C" fn ui_debug_inspect(id: i32) {
    ui().debug_inspect(id)
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
    ui().debug_pause(on != 0)
}

#[no_mangle]
pub extern "C" fn ui_debug_step() {
    ui().debug_step()
}

/// Rasterize the current tree and return the RGBA8 480x272 framebuffer
/// pointer (stable; SCREEN_W * SCREEN_H * 4 bytes).
#[no_mangle]
pub extern "C" fn ui_render() -> *const u8 {
    let u = ui();
    // draw() borrows `u` mutably for the returned &DrawList; the rasterizer
    // then needs a shared &Ui for atlases/textures. Both live in the single
    // static; nothing mutates during rasterization, and this module is
    // single-threaded by construction, so the raw-pointer reborrow is sound.
    let dl: *const pocketjs_core::DrawList = u.draw();
    let u_ref: &Ui = unsafe { &*(u as *const Ui) };
    unsafe { raster::render(u_ref, &(*dl).words, &mut FRAMEBUFFER) };
    unsafe { FRAMEBUFFER.as_ptr() }
}
