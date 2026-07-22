// COPIED VERBATIM from dreamcart runtime/src/qjs_alloc.rs (proven on hardware).
// See Cargo.toml TODO list before changing anything here.

//! Back QuickJS's allocator with the single-arena sub-allocator (`arena.rs`).
//!
//! rust-psp's startup does not set up a C heap, so newlib `malloc` (used by the
//! bundled QuickJS) has no backing memory and hangs/corrupts during
//! `JS_NewRuntime`. We instead create the runtime via `JS_NewRuntime2` with these
//! hooks. They route every allocation through `arena`, which sub-allocates from
//! ONE big kernel block — crucial because the PSP kernel caps the number of
//! objects and one-kernel-block-per-allocation exhausts it on large bundles.

use core::ffi::c_void;
use core::ptr;

use libquickjs_sys::*;

use crate::arena;

// A 16-byte header keeps user pointers 16-byte aligned and stores the request
// size so `free`/`realloc`/`usable_size` can recover it.
const HEADER: usize = 16;

#[inline]
unsafe fn raw_alloc(size: usize) -> *mut c_void {
    if size == 0 {
        return ptr::null_mut();
    }
    let p = arena::alloc(size + HEADER, 16);
    if p.is_null() {
        return ptr::null_mut();
    }
    *(p as *mut usize) = size;
    p.add(HEADER) as *mut c_void
}

#[inline]
unsafe fn raw_free(ptr: *mut c_void) {
    if ptr.is_null() {
        return;
    }
    let base = (ptr as *mut u8).sub(HEADER);
    let size = *(base as *mut usize);
    arena::dealloc(base, size + HEADER, 16);
}

#[inline]
unsafe fn raw_realloc(p: *mut c_void, size: usize) -> *mut c_void {
    if p.is_null() {
        return raw_alloc(size);
    }
    if size == 0 {
        raw_free(p);
        return ptr::null_mut();
    }
    let base = (p as *mut u8).sub(HEADER);
    let old = *(base as *mut usize);
    // No in-place grow in the free-list heap: allocate, copy, free.
    let np = raw_alloc(size);
    if np.is_null() {
        return ptr::null_mut();
    }
    let copy = if old < size { old } else { size };
    ptr::copy_nonoverlapping(base.add(HEADER), np as *mut u8, copy);
    arena::dealloc(base, old + HEADER, 16);
    np
}

unsafe extern "C" fn qjs_malloc(_s: *mut JSMallocState, size: size_t) -> *mut c_void {
    raw_alloc(size as usize)
}

unsafe extern "C" fn qjs_free(_s: *mut JSMallocState, ptr: *mut c_void) {
    raw_free(ptr)
}

unsafe extern "C" fn qjs_realloc(
    _s: *mut JSMallocState,
    ptr: *mut c_void,
    size: size_t,
) -> *mut c_void {
    raw_realloc(ptr, size as usize)
}

unsafe extern "C" fn qjs_usable_size(ptr: *const c_void) -> size_t {
    if ptr.is_null() {
        return 0;
    }
    (*((ptr as *const u8).sub(HEADER) as *const usize)) as size_t
}

/// Create a QuickJS runtime that allocates through the Rust/PSP allocator.
pub unsafe fn new_runtime() -> *mut JSRuntime {
    let mf = JSMallocFunctions {
        js_malloc: Some(qjs_malloc),
        js_free: Some(qjs_free),
        js_realloc: Some(qjs_realloc),
        js_malloc_usable_size: Some(qjs_usable_size),
    };
    // JS_NewRuntime2 copies `mf` into the runtime, so a stack value is fine.
    JS_NewRuntime2(&mf, ptr::null_mut())
}
