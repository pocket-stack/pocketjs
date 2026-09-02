//! `pocketjs-sifli`: the PocketJS core and hybrid renderer as a C staticlib
//! for SiFli SF32LB5x firmware.
//!
//! The C host (`hosts/sifli/components/pocketjs_host`) owns QuickJS, input,
//! the heap, and the framebuffers; this crate owns the retained tree,
//! layout, animation, the DrawList, and the renderer. Rendering goes through
//! the GPU command queue in `hosts/sifli/components/pocketjs_gpu`
//! (`include/pocketjs_gpu.h`); the exported entry points are declared in
//! `include/pocket_core.h`.

#![no_std]
#![allow(clippy::missing_safety_doc)] // One shared pointer contract covers the C ABI.

extern crate alloc;

use core::alloc::{GlobalAlloc, Layout};
use core::ffi::c_void;
use core::panic::PanicInfo;

mod abi;
mod gpu;

pub use abi::{PocketCore, PocketRenderStats};
pub use gpu::SifliGpu;

extern "C" {
    fn pocket_heap_alloc(size: usize, align: usize) -> *mut c_void;
    fn pocket_heap_free(ptr: *mut c_void);
    fn pocket_rust_panic() -> !;
}

/// Every Rust allocation comes from the host's shared heap so the core, the
/// renderer, and QuickJS draw from one accounted pool.
struct HostAllocator;

unsafe impl GlobalAlloc for HostAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        pocket_heap_alloc(layout.size(), layout.align()).cast()
    }

    unsafe fn dealloc(&self, ptr: *mut u8, _layout: Layout) {
        pocket_heap_free(ptr.cast());
    }
}

#[global_allocator]
static ALLOCATOR: HostAllocator = HostAllocator;

#[panic_handler]
fn panic(_info: &PanicInfo<'_>) -> ! {
    unsafe { pocket_rust_panic() }
}
