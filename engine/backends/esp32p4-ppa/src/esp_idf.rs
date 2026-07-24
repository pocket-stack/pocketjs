//! ESP-IDF implementation of [`PpaOps`].
//!
//! Enable the `esp-idf` feature and link the `pocketjs_ppa` ESP-IDF component
//! from `hosts/esp32p4/components`. The C component owns the PPA clients and
//! keeps ESP-IDF headers out of this portable Rust crate.

use core::ffi::c_void;
use core::ptr;

use crate::{PpaOps, QuarterTurn, Rect, SrmTransform};

unsafe extern "C" {
    fn pocketjs_ppa_create(out_handle: *mut *mut c_void) -> i32;
    fn pocketjs_ppa_destroy(handle: *mut c_void);
    fn pocketjs_ppa_fill_rgb565(
        handle: *mut c_void,
        destination: *mut u16,
        destination_pixels: usize,
        width: u32,
        height: u32,
        x: u32,
        y: u32,
        rect_width: u32,
        rect_height: u32,
        color: u16,
    ) -> i32;
    fn pocketjs_ppa_blend_a8_rgb565(
        handle: *mut c_void,
        destination: *mut u16,
        destination_pixels: usize,
        width: u32,
        height: u32,
        mask: *const u8,
        mask_len: usize,
        x: u32,
        y: u32,
        rect_width: u32,
        rect_height: u32,
        red: u8,
        green: u8,
        blue: u8,
        global_alpha: u8,
    ) -> i32;
    fn pocketjs_ppa_srm_psm5650_rgb565(
        handle: *mut c_void,
        destination: *mut u16,
        destination_pixels: usize,
        width: u32,
        height: u32,
        source: *const u8,
        source_len: usize,
        source_width: u32,
        source_height: u32,
        source_x: u32,
        source_y: u32,
        source_rect_width: u32,
        source_rect_height: u32,
        destination_x: u32,
        destination_y: u32,
        destination_rect_width: u32,
        destination_rect_height: u32,
        quarter_turn: u32,
        mirror_x: i32,
        mirror_y: i32,
    ) -> i32;
}

/// Blocking ESP-IDF implementation backed by one FILL, BLEND, and SRM client.
///
/// Construction registers the three clients. Dropping the value unregisters
/// them, so it must be dropped before the ESP-IDF PPA driver is torn down.
pub struct EspIdfPpaOps {
    handle: *mut c_void,
}

impl EspIdfPpaOps {
    /// Register the PPA clients.
    ///
    /// The error value is the `esp_err_t` returned by the ESP-IDF component.
    pub fn new() -> Result<Self, i32> {
        let mut handle = ptr::null_mut();
        let result = unsafe { pocketjs_ppa_create(&mut handle) };
        if result == 0 && !handle.is_null() {
            Ok(Self { handle })
        } else if result != 0 {
            Err(result)
        } else {
            Err(-1)
        }
    }
}

impl Drop for EspIdfPpaOps {
    fn drop(&mut self) {
        unsafe {
            pocketjs_ppa_destroy(self.handle);
        }
        self.handle = ptr::null_mut();
    }
}

impl PpaOps for EspIdfPpaOps {
    fn fill_rgb565(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        rect: Rect,
        color: u16,
    ) -> bool {
        unsafe {
            pocketjs_ppa_fill_rgb565(
                self.handle,
                destination.as_mut_ptr(),
                destination.len(),
                width,
                height,
                rect.x,
                rect.y,
                rect.w,
                rect.h,
                color,
            ) != 0
        }
    }

    fn blend_a8_rgb565(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        mask: &[u8],
        rect: Rect,
        color: [u8; 3],
        global_alpha: u8,
    ) -> bool {
        unsafe {
            pocketjs_ppa_blend_a8_rgb565(
                self.handle,
                destination.as_mut_ptr(),
                destination.len(),
                width,
                height,
                mask.as_ptr(),
                mask.len(),
                rect.x,
                rect.y,
                rect.w,
                rect.h,
                color[0],
                color[1],
                color[2],
                global_alpha,
            ) != 0
        }
    }

    fn srm_psm5650_to_rgb565(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        source: &[u8],
        source_width: u32,
        source_height: u32,
        source_rect: Rect,
        destination_rect: Rect,
        transform: SrmTransform,
    ) -> bool {
        let quarter_turn = match transform.rotation {
            QuarterTurn::None => 0,
            QuarterTurn::Ccw90 => 1,
            QuarterTurn::Ccw180 => 2,
            QuarterTurn::Ccw270 => 3,
        };
        unsafe {
            pocketjs_ppa_srm_psm5650_rgb565(
                self.handle,
                destination.as_mut_ptr(),
                destination.len(),
                width,
                height,
                source.as_ptr(),
                source.len(),
                source_width,
                source_height,
                source_rect.x,
                source_rect.y,
                source_rect.w,
                source_rect.h,
                destination_rect.x,
                destination_rect.y,
                destination_rect.w,
                destination_rect.h,
                quarter_turn,
                transform.mirror_x as i32,
                transform.mirror_y as i32,
            ) != 0
        }
    }
}
