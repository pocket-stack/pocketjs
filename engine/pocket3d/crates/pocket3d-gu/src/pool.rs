//! Per-frame bump arena for GE-visible transient data (spliced index lists,
//! dynamic mesh vertices). Same discipline as the 2D backend's vertex pool:
//! blocks are retained across frames and `reset()` is only safe after the
//! frame loop's `sceGuSync` — the GE reads this memory asynchronously.

use alloc::boxed::Box;
use alloc::vec::Vec;
use core::ffi::c_void;

use psp::sys;

const BLOCK: usize = 64 * 1024;

#[repr(C, align(16))]
struct Block([u8; BLOCK]);

pub struct FramePool {
    blocks: Vec<Box<Block>>,
    block: usize,
    used: usize,
}

impl FramePool {
    pub const fn new() -> Self {
        Self {
            blocks: Vec::new(),
            block: 0,
            used: 0,
        }
    }

    /// Rewind the pool. ONLY after the frame loop synced the GE.
    pub fn reset(&mut self) {
        self.block = 0;
        self.used = 0;
    }

    /// Bump-allocate `bytes` (16-aligned). Panics via OOM if the allocator
    /// is exhausted; single allocations above the block size are unsupported
    /// (split your data — 64 KB of u16 indices is ~10x a worst-case frame).
    pub fn alloc(&mut self, bytes: usize) -> *mut u8 {
        assert!(bytes <= BLOCK, "FramePool allocation too large");
        let aligned = bytes.div_ceil(16) * 16;
        if self.blocks.is_empty() {
            self.blocks.push(new_block());
        }
        if self.used + aligned > BLOCK {
            self.block += 1;
            self.used = 0;
            if self.block == self.blocks.len() {
                self.blocks.push(new_block());
            }
        }
        let p = unsafe { (self.blocks[self.block].0.as_mut_ptr()).add(self.used) };
        self.used += aligned;
        p
    }

    /// Copy `data` into the pool and write it back for the GE.
    pub fn upload(&mut self, data: &[u8]) -> *const u8 {
        let dst = self.alloc(data.len());
        unsafe {
            core::ptr::copy_nonoverlapping(data.as_ptr(), dst, data.len());
            sys::sceKernelDcacheWritebackRange(dst as *const c_void, data.len() as u32);
        }
        dst
    }
}

impl Default for FramePool {
    fn default() -> Self {
        Self::new()
    }
}

fn new_block() -> Box<Block> {
    // Zeroing 64 KB once per block creation is fine (blocks are retained).
    unsafe { Box::new_zeroed().assume_init() }
}
