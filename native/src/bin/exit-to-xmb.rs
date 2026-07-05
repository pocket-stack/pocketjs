#![no_std]
#![no_main]
#![feature(alloc_error_handler)]

//! Tiny PSPLINK helper loaded by `bun psplink` when quitting the Mac-side
//! switcher. It returns the PSP to the XMB instead of leaving it at the PSPLINK
//! loader or inside the last launched PocketJS demo.

use core::alloc::{GlobalAlloc, Layout};

psp::module!("pocketjs_exit", 1, 1);

struct NoAlloc;

unsafe impl GlobalAlloc for NoAlloc {
    unsafe fn alloc(&self, _layout: Layout) -> *mut u8 {
        core::ptr::null_mut()
    }

    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
}

#[global_allocator]
static ALLOC: NoAlloc = NoAlloc;

#[alloc_error_handler]
fn alloc_error(_layout: Layout) -> ! {
    unsafe {
        psp::sys::sceKernelExitGame();
    }
    loop {}
}

fn psp_main() {
    unsafe {
        psp::sys::sceKernelExitGame();
    }
}
