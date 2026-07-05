//! pocketjs-3ds-ffi — the extern "C" bridge the 3DS C host (native-3ds/source/
//! main.c) calls. It is the 3DS analogue of native/src/ffi.rs (PSP) and
//! wasm/src/lib.rs (web): the QuickJS `globalThis.ui` ops forward here, per
//! vblank the host ticks the core and asks for a frame, and the core stays
//! entirely unaware of citro/QuickJS.
//!
//! ABI notes (differ from the wasm host — the 3DS shares one address space with
//! Rust, so there is no linear-memory alloc dance):
//!   - strings/buffers cross as a raw (ptr, len) the C host already holds
//!     (JS_ToCStringLen / JS_GetArrayBuffer pointers). UTF-8 for text.
//!   - `pj_render()` returns a pointer to a stable RGBA8 framebuffer,
//!     SCREEN_W*SCREEN_H*4 bytes, row-major, top-left origin (== little-endian
//!     ABGR, the spec color order). The C host uploads it as a citro texture
//!     once per frame and blits it scaled onto the top screen.
//!   - single-threaded by construction (the QuickJS thread), so `static mut`
//!     matches native/src/ffi.rs style.
//!
//! v1 render path = the SAME deterministic software rasterizer that backs the
//! wasm/Bun goldens (reused verbatim from wasm/src/raster.rs), so 3DS output is
//! pixel-identical to the web host at the same screen size. A GPU-native
//! DrawList→citro3d backend (mirroring native/src/ge.rs) is the v2 perf path;
//! see native-3ds/README.md.

#![no_std]
#![allow(static_mut_refs)] // single-threaded; one global Ui + framebuffer

extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;
use core::alloc::{GlobalAlloc, Layout};
use core::ffi::c_void;

use pocketjs_core::spec::{self, SCREEN_H, SCREEN_W};
use pocketjs_core::Ui;

// Reuse the proven, platform-agnostic rasterizer with ZERO changes to wasm/core
// (it is allocation-free and only depends on pocketjs_core). Path is relative to
// this source dir.
#[path = "../../../wasm/src/raster.rs"]
mod raster;

// ---- runtime: no_std staticlib linked into the devkitARM C host --------------
// Route Rust's heap through the C host's newlib allocator (memalign honors
// Rust's alignment — e.g. Texture's Vec<u128> wants 16; free() accepts memalign
// pointers). This is the 3DS analogue of native/src/alloc.rs (PSP arena) and
// keeps -Z build-std to core+alloc (no std, so no pthread-3ds/shim-3ds).

extern "C" {
    fn memalign(align: usize, size: usize) -> *mut c_void;
    fn free(ptr: *mut c_void);
    fn abort() -> !;
}

struct CHeap;
unsafe impl GlobalAlloc for CHeap {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        memalign(if l.align() < 8 { 8 } else { l.align() }, l.size()) as *mut u8
    }
    unsafe fn dealloc(&self, p: *mut u8, _l: Layout) {
        free(p as *mut c_void)
    }
    // realloc falls back to GlobalAlloc's default (alloc + copy + dealloc), which
    // preserves alignment — plain C realloc would not.
}

#[global_allocator]
static HEAP: CHeap = CHeap;

#[panic_handler]
fn on_panic(_: &core::panic::PanicInfo) -> ! {
    unsafe { abort() }
}

const FB_BYTES: usize = (SCREEN_W * SCREEN_H * 4) as usize;

static mut UI: Option<Ui> = None;
static mut FRAMEBUFFER: [u8; FB_BYTES] = [0; FB_BYTES];
/// pak image name -> texture handle, built by pj_feed_pak; the C host reads it
/// out to register `ui.__textures` so JSX `src="<name>"` resolves (parity with
/// native/src/ffi.rs's __textures table).
static mut TEXTURES: Vec<(String, i32)> = Vec::new();

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

// ---- lifecycle --------------------------------------------------------------

/// Create (or reset) the Ui instance. Idempotent; call once before feeding the
/// pak or evaluating the bundle.
#[no_mangle]
pub extern "C" fn pj_init() {
    unsafe {
        UI = Some(Ui::new());
        TEXTURES = Vec::new();
    }
}

#[no_mangle]
pub extern "C" fn pj_screen_w() -> u32 {
    SCREEN_W
}
#[no_mangle]
pub extern "C" fn pj_screen_h() -> u32 {
    SCREEN_H
}

// ---- op mirror (spec::op + DESIGN.md "The native contract") -----------------

#[no_mangle]
pub extern "C" fn pj_create_node(node_type: u32) -> i32 {
    ui().create_node(node_type as u8)
}
#[no_mangle]
pub extern "C" fn pj_destroy_node(id: i32) {
    ui().destroy_node(id)
}
#[no_mangle]
pub extern "C" fn pj_insert_before(parent: i32, child: i32, anchor: i32) {
    ui().insert_before(parent, child, anchor)
}
#[no_mangle]
pub extern "C" fn pj_remove_child(parent: i32, child: i32) {
    ui().remove_child(parent, child)
}
#[no_mangle]
pub extern "C" fn pj_set_style(id: i32, style_id: i32) {
    ui().set_style(id, style_id)
}
#[no_mangle]
pub extern "C" fn pj_set_prop(id: i32, prop: u32, value: f64) {
    ui().set_prop(id, prop as u8, value)
}
#[no_mangle]
pub extern "C" fn pj_set_text(id: i32, ptr: *const u8, len: usize) {
    ui().set_text(id, unsafe { text(ptr, len) })
}
#[no_mangle]
pub extern "C" fn pj_replace_text(id: i32, ptr: *const u8, len: usize) {
    ui().replace_text(id, unsafe { text(ptr, len) })
}
#[no_mangle]
pub extern "C" fn pj_upload_texture(ptr: *const u8, len: usize, w: u32, h: u32, psm: u32) -> i32 {
    ui().upload_texture(unsafe { bytes(ptr, len) }, w, h, psm)
}
#[no_mangle]
pub extern "C" fn pj_set_image(id: i32, tex: i32) {
    ui().set_image(id, tex)
}
#[no_mangle]
pub extern "C" fn pj_animate(id: i32, prop: u32, to: f64, dur_ms: u32, easing: u32, delay_ms: u32) -> i32 {
    ui().animate(id, prop as u8, to, dur_ms, easing as u8, delay_ms)
}
#[no_mangle]
pub extern "C" fn pj_cancel_anim(anim_id: i32) {
    ui().cancel_anim(anim_id)
}
#[no_mangle]
pub extern "C" fn pj_set_focus(id: i32) {
    ui().set_focus(id)
}
#[no_mangle]
pub extern "C" fn pj_load_styles(ptr: *const u8, len: usize) -> i32 {
    ui().load_styles(unsafe { bytes(ptr, len) }) as i32
}
#[no_mangle]
pub extern "C" fn pj_load_font_atlas(ptr: *const u8, len: usize) -> i32 {
    ui().load_font_atlas(unsafe { bytes(ptr, len) }) as i32
}
#[no_mangle]
pub extern "C" fn pj_measure_text(ptr: *const u8, len: usize, font_slot: u32) -> f32 {
    ui().measure_text(unsafe { text(ptr, len) }, font_slot as u8)
}

// ---- frame ------------------------------------------------------------------

/// Advance one fixed-dt (1/60 s) frame: animations, then layout if dirty.
#[no_mangle]
pub extern "C" fn pj_tick() {
    ui().tick()
}

/// Rasterize the current tree into the stable framebuffer and return its
/// pointer (RGBA8, SCREEN_W*SCREEN_H*4). Mirrors wasm's ui_render(): draw()
/// borrows the Ui mutably for the &DrawList, then the rasterizer needs a shared
/// &Ui for atlases/textures — both live in the single static, single-threaded,
/// nothing mutates during rasterization, so the reborrow is sound.
#[no_mangle]
pub extern "C" fn pj_render() -> *const u8 {
    let u = ui();
    let dl: *const pocketjs_core::DrawList = u.draw();
    let u_ref: &Ui = unsafe { &*(u as *const Ui) };
    unsafe { raster::render(u_ref, &(*dl).words, &mut FRAMEBUFFER) };
    unsafe { FRAMEBUFFER.as_ptr() }
}

// ---- asset pack (native feed, parity with native/src/pak.rs) ----------------

#[inline]
fn rd_u16(b: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(off)?, *b.get(off + 1)?]))
}
#[inline]
fn rd_u32(b: &[u8], off: usize) -> Option<u32> {
    Some(u32::from_le_bytes([*b.get(off)?, *b.get(off + 1)?, *b.get(off + 2)?, *b.get(off + 3)?]))
}

/// Feed the embedded `.pak` (styles.bin + font atlases + images) straight into
/// the core, exactly like native/src/pak.rs but without the PSP dcache/dprintln
/// bits (the CPU rasterizer reads core memory directly). Returns the number of
/// image textures registered; the C host then reads them via pj_texture_*.
/// Malformed entries are skipped, never fatal.
#[no_mangle]
pub extern "C" fn pj_feed_pak(ptr: *const u8, len: usize) -> i32 {
    let pak = unsafe { bytes(ptr, len) };
    let mut textures: Vec<(String, i32)> = Vec::new();
    let ok_header = matches!(
        (rd_u32(pak, 0), rd_u16(pak, 4)),
        (Some(m), Some(v)) if m == spec::pak::MAGIC && v == spec::pak::VERSION
    );
    if !ok_header {
        unsafe { TEXTURES = textures };
        return 0;
    }
    let (Some(count), Some(dir_off), Some(names_off)) =
        (rd_u32(pak, 8), rd_u32(pak, 12), rd_u32(pak, 16))
    else {
        return 0;
    };
    let count = (count as usize)
        .min(pak.len().saturating_sub(dir_off as usize) / spec::pak::ENTRY_SIZE);
    let u = ui();
    for i in 0..count {
        let e = dir_off as usize + i * spec::pak::ENTRY_SIZE;
        let (Some(blob_off), Some(blob_len), Some(name_off), Some(name_len)) =
            (rd_u32(pak, e + 4), rd_u32(pak, e + 8), rd_u32(pak, e + 12), rd_u16(pak, e + 16))
        else {
            continue;
        };
        let ns = names_off as usize + name_off as usize;
        let (Some(name_bytes), Some(blob)) = (
            pak.get(ns..ns + name_len as usize),
            pak.get(blob_off as usize..blob_off as usize + blob_len as usize),
        ) else {
            continue;
        };
        let Ok(key) = core::str::from_utf8(name_bytes) else { continue };
        if key == "ui:styles" {
            u.load_styles(blob);
        } else if key.starts_with("ui:font.") {
            u.load_font_atlas(blob);
        } else if let Some(name) = key.strip_prefix("ui:img.") {
            // IMG entry: 8-byte header {u16 w, u16 h, u8 psm, 3B pad} + pixels.
            let (Some(w), Some(h), Some(&psm)) = (rd_u16(blob, 0), rd_u16(blob, 2), blob.get(4))
            else {
                continue;
            };
            let Some(pixels) = blob.get(8..) else { continue };
            let handle = u.upload_texture(pixels, w as u32, h as u32, psm as u32);
            if handle >= 0 {
                textures.push((String::from(name), handle));
            }
        }
    }
    let n = textures.len() as i32;
    unsafe { TEXTURES = textures };
    n
}

/// Number of pak image textures registered by pj_feed_pak.
#[no_mangle]
pub extern "C" fn pj_texture_count() -> i32 {
    unsafe { TEXTURES.len() as i32 }
}

/// Texture handle for image index `i` (0..pj_texture_count).
#[no_mangle]
pub extern "C" fn pj_texture_handle(i: i32) -> i32 {
    unsafe { TEXTURES.get(i as usize).map(|(_, h)| *h).unwrap_or(-1) }
}

/// Copy image `i`'s name (NUL-terminated) into `out` (capacity `cap`); returns
/// the name length (excluding NUL), or -1 if `i` is out of range. The C host
/// uses this to build the `ui.__textures` name→handle map.
#[no_mangle]
pub extern "C" fn pj_texture_name(i: i32, out: *mut u8, cap: usize) -> i32 {
    unsafe {
        let Some((name, _)) = TEXTURES.get(i as usize) else { return -1 };
        let n = name.len().min(cap.saturating_sub(1));
        if !out.is_null() && cap > 0 {
            core::ptr::copy_nonoverlapping(name.as_ptr(), out, n);
            *out.add(n) = 0;
        }
        name.len() as i32
    }
}
