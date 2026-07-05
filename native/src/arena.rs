// COPIED from dreamcart runtime/src/arena.rs (proven on hardware), with ONE
// change [R]: ensure_init calls sceKernelAllocPartitionMemory /
// sceKernelGetBlockHeadAddr DIRECTLY. In this crate the arena IS the
// #[global_allocator] (src/alloc.rs), so the original's alloc::alloc::alloc
// route would recurse infinitely. Margin is 6 MB (raised from 2 MB for the
// native <Video> component): most retained buffers/textures live inside the
// arena, but the scePsmfPlayer create-buffer + ME EDRAM may draw from the same
// primary user partition, so the margin covers those + late kernel allocations
// (utility thread stacks) + safety. See DESIGN.md "Video".


//! A single-arena sub-allocator for QuickJS + newlib `malloc` + Rust `alloc`.
//!
//! rust-psp's global allocator (`alloc_impl.rs`) calls `sceKernelAllocPartitionMemory`
//! for EVERY allocation — i.e. one kernel object per allocation. The PSP kernel
//! caps the number of objects (~4096 in PPSSPP), and QuickJS makes many thousands
//! of small allocations evaluating a large bundle, so it exhausts the slots and
//! the un-checked allocator writes to a null block head -> the `0x300000000` crash.
//!
//! Fix: grab ONE big block from the kernel up front and sub-allocate from it. Every
//! QuickJS / C `malloc` then comes from this arena and consumes ZERO additional
//! kernel objects.
//!
//! The sub-allocator is a SEGREGATED (power-of-two size-class) free list: alloc and
//! free are O(1) — pop/push a per-class free list, carving a fresh block from a bump
//! pointer when a class is empty. This matters enormously: QuickJS makes thousands
//! of small alloc/free per frame (every matrix/array/temporary), and a first-fit
//! linked-list allocator's O(free-holes) cost made that ~1 ms PER ALLOCATION on the
//! emulated core (the dominant per-frame cost). O(1) classes fixed it (car3d 15 ->
//! 60 fps). Blocks recycle within their class, so a steady per-frame workload stops
//! growing the bump and runs entirely from the free lists.
//!
//! Single-threaded (the QuickJS worker), so `static mut` matches the existing style.

use core::ffi::c_void;
use core::ptr;

use psp::sys::{self, SceSysMemBlockTypes, SceSysMemPartitionId};

// 32 power-of-two classes (16 B .. 2 GB) — covers any 32-bit PSP allocation.
const NCLASS: usize = 32;
const MIN_SHIFT: usize = 4; // smallest class = 16 bytes (>= a free-list next ptr)

static mut FREE: [*mut u8; NCLASS] = [ptr::null_mut(); NCLASS];
static mut BUMP: usize = 0;
static mut BUMP_END: usize = 0;
static mut INITED: bool = false;

/// Reserve the arena on first use: take most of the free partition in a single
/// kernel block, leaving a 2 MB margin for late kernel allocations (utility
/// thread stacks) + safety. Called lazily from `alloc` — the global allocator
/// can be hit before main-style init, so this must be self-contained.
///
/// [R] Direct syscalls (NOT alloc::alloc::alloc): this arena backs the crate's
/// #[global_allocator] (src/alloc.rs), so allocating through the Rust
/// allocator here would recurse straight back into `ensure_init`.
unsafe fn ensure_init() {
    if INITED {
        return;
    }
    INITED = true;
    let free = sys::sceKernelMaxFreeMemSize() as usize;
    // 2 MB covered late kernel allocations (utility thread stacks) + safety.
    // Raised to 6 MB for the native <Video> component (video.rs): the
    // scePsmfPlayer create-buffer (~3 MB) + ME EDRAM (~2 MB) may draw from this
    // same primary user partition (UNCERTAIN — validate on hardware; DESIGN.md
    // "Video"). Video frame buffers themselves come FROM the arena.
    let margin = 6 * 1024 * 1024;
    let size = if free > margin + 1024 * 1024 { free - margin } else { free / 2 };
    if size == 0 {
        return;
    }
    // ONE kernel object for the whole heap.
    let id = sys::sceKernelAllocPartitionMemory(
        SceSysMemPartitionId::SceKernelPrimaryUserPartition,
        b"PocketJS-arena\0".as_ptr(),
        SceSysMemBlockTypes::Low,
        size as u32,
        ptr::null_mut::<c_void>(),
    );
    if id.0 < 0 {
        return;
    }
    let base = sys::sceKernelGetBlockHeadAddr(id) as usize;
    if base != 0 {
        BUMP = (base + 15) & !15; // 16-align the bump start
        BUMP_END = base + size;
    }
}

/// Smallest power-of-two class index whose block (2^c) holds `need` bytes.
#[inline]
fn class_of(need: usize) -> usize {
    let mut c = MIN_SHIFT;
    while (1usize << c) < need {
        c += 1;
    }
    c
}

/// Allocate `size` bytes aligned to `align` from the arena (null on OOM).
#[inline]
pub unsafe fn alloc(size: usize, align: usize) -> *mut u8 {
    ensure_init();
    if size == 0 || BUMP == 0 {
        return ptr::null_mut();
    }
    let a = if align < 16 { 16 } else { align };
    // Block must hold `size` AND be sized up for `align`. Free-listed blocks
    // are only guaranteed aligned to the `a` of THEIR carve, so a pop must
    // re-check alignment (align > 16 requests fall through to a fresh carve
    // when the head block doesn't satisfy them).
    let c = class_of(if size > a { size } else { a });
    if c >= NCLASS {
        return ptr::null_mut();
    }
    let head = FREE[c];
    if !head.is_null() && (head as usize) & (a - 1) == 0 {
        FREE[c] = *(head as *mut *mut u8); // pop: next-pointer is stored in the block
        return head;
    }
    // Carve a fresh 2^c block from the bump pointer, aligned to `a` (minimal waste).
    let p = (BUMP + a - 1) & !(a - 1);
    let np = p + (1usize << c);
    if np > BUMP_END {
        return ptr::null_mut();
    }
    BUMP = np;
    p as *mut u8
}

/// Free a pointer previously returned by `alloc` with the SAME size + align.
#[inline]
pub unsafe fn dealloc(p: *mut u8, size: usize, align: usize) {
    if p.is_null() || size == 0 {
        return;
    }
    let a = if align < 16 { 16 } else { align };
    let c = class_of(if size > a { size } else { a });
    if c >= NCLASS {
        return;
    }
    *(p as *mut *mut u8) = FREE[c]; // push: store the old head in the freed block
    FREE[c] = p;
}
