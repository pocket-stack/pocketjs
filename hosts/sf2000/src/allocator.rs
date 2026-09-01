use core::alloc::{GlobalAlloc, Layout};
use core::ffi::c_void;
use core::ptr;

extern "C" {
    fn malloc(size: usize) -> *mut c_void;
    fn free(ptr: *mut c_void);
}

struct ModuleAllocator;

unsafe impl GlobalAlloc for ModuleAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if layout.size() == 0 {
            return layout.align() as *mut u8;
        }
        let header = core::mem::size_of::<usize>();
        let Some(total) = layout
            .size()
            .checked_add(layout.align())
            .and_then(|n| n.checked_add(header))
        else {
            return ptr::null_mut();
        };
        let raw = malloc(total) as *mut u8;
        if raw.is_null() {
            return raw;
        }
        let start = raw.add(header) as usize;
        let aligned = (start + layout.align() - 1) & !(layout.align() - 1);
        let out = aligned as *mut u8;
        (out.sub(header) as *mut usize).write(raw as usize);
        out
    }

    unsafe fn dealloc(&self, ptr: *mut u8, _layout: Layout) {
        if !ptr.is_null() {
            let header = core::mem::size_of::<usize>();
            let raw = (ptr.sub(header) as *const usize).read() as *mut c_void;
            free(raw);
        }
    }

    unsafe fn realloc(&self, ptr: *mut u8, old: Layout, new_size: usize) -> *mut u8 {
        let Ok(new_layout) = Layout::from_size_align(new_size, old.align()) else {
            return ptr::null_mut();
        };
        let next = self.alloc(new_layout);
        if !next.is_null() {
            ptr::copy_nonoverlapping(ptr, next, old.size().min(new_size));
            self.dealloc(ptr, old);
        }
        next
    }
}

#[global_allocator]
static GLOBAL: ModuleAllocator = ModuleAllocator;

/// HCRTOS ships a newlib declaration for this GNU extension but its module
/// runtime does not export an implementation. QuickJS explicitly permits a
/// zero result on platforms without an allocator-size query.
#[no_mangle]
pub extern "C" fn malloc_usable_size(_ptr: *mut c_void) -> usize {
    0
}
