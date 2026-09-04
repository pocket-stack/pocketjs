#![cfg_attr(not(feature = "std"), no_std)]
#[cfg(not(feature = "std"))]
use core::alloc::{GlobalAlloc, Layout};

#[cfg(not(feature = "std"))]
unsafe extern "C" {
    fn pocketjs_idf_rust_alloc(size: usize, alignment: usize) -> *mut u8;
    fn pocketjs_idf_rust_dealloc(pointer: *mut u8, size: usize, alignment: usize);
    fn pocketjs_idf_rust_panic();
}

#[cfg(not(feature = "std"))]
struct IdfAllocator;

#[cfg(not(feature = "std"))]
unsafe impl GlobalAlloc for IdfAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        pocketjs_idf_rust_alloc(layout.size(), layout.align())
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        pocketjs_idf_rust_dealloc(pointer, layout.size(), layout.align())
    }
}

#[cfg(not(feature = "std"))]
#[global_allocator]
static ALLOCATOR: IdfAllocator = IdfAllocator;

#[cfg(not(feature = "std"))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    unsafe { pocketjs_idf_rust_panic() };
    loop {
        core::hint::spin_loop();
    }
}
