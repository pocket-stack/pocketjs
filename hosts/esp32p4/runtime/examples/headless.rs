//! Render a target-bound ESP32-P4 bundle with the exact device runtime on the
//! development machine. This is the pre-flash acceptance gate for QuickJS,
//! HostOps, PAK assets, fixed ticks, and the RGB565 renderer.

use std::env;
use std::ffi::c_char;
use std::fs;
use std::ptr;

use pocketjs_esp32p4_runtime::{
    pocketjs_runtime_create, pocketjs_runtime_destroy, pocketjs_runtime_frame,
    pocketjs_runtime_framebuffer_hash, pocketjs_runtime_framebuffer_height,
    pocketjs_runtime_framebuffer_width, pocketjs_runtime_last_error, PocketJsFrameStats,
};

fn runtime_error() -> String {
    let required = pocketjs_runtime_last_error(ptr::null_mut(), 0);
    let mut bytes = vec![0u8; required.saturating_add(1)];
    pocketjs_runtime_last_error(bytes.as_mut_ptr().cast::<c_char>(), bytes.len());
    String::from_utf8_lossy(&bytes[..required]).into_owned()
}

fn rgb565_to_ppm(framebuffer: &[u16], width: usize, height: usize) -> Vec<u8> {
    let mut ppm = format!("P6\n{width} {height}\n255\n").into_bytes();
    ppm.reserve(framebuffer.len() * 3);
    for pixel in framebuffer {
        let red = ((pixel >> 11) & 0x1f) as u8;
        let green = ((pixel >> 5) & 0x3f) as u8;
        let blue = (pixel & 0x1f) as u8;
        ppm.extend_from_slice(&[
            (red << 3) | (red >> 2),
            (green << 2) | (green >> 4),
            (blue << 3) | (blue >> 2),
        ]);
    }
    ppm
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    if arguments.len() < 3 || arguments.len() > 4 {
        return Err("usage: headless <app.js> <app.pak> <frame.ppm> [frames]".into());
    }
    let javascript = fs::read(&arguments[0])?;
    let pak = fs::read(&arguments[1])?;
    let output = &arguments[2];
    let frame_count = arguments
        .get(3)
        .map(|value| value.parse::<u32>())
        .transpose()?
        .unwrap_or(3);
    if frame_count == 0 {
        return Err("frames must be greater than zero".into());
    }

    let runtime = pocketjs_runtime_create(
        javascript.as_ptr(),
        javascript.len(),
        pak.as_ptr(),
        pak.len(),
    );
    if runtime.is_null() {
        return Err(format!("PocketJS runtime boot failed: {}", runtime_error()).into());
    }

    let width = pocketjs_runtime_framebuffer_width() as usize;
    let height = pocketjs_runtime_framebuffer_height() as usize;
    let mut framebuffer = vec![0u16; width * height];
    let mut stats = PocketJsFrameStats::default();
    for _ in 0..frame_count {
        if pocketjs_runtime_frame(
            runtime,
            0,
            ptr::null(),
            0,
            framebuffer.as_mut_ptr(),
            framebuffer.len(),
            &mut stats,
        ) == 0
        {
            pocketjs_runtime_destroy(runtime);
            return Err(format!("PocketJS frame failed: {}", runtime_error()).into());
        }
    }

    let framebuffer_hash =
        pocketjs_runtime_framebuffer_hash(framebuffer.as_ptr(), framebuffer.len());
    fs::write(output, rgb565_to_ppm(&framebuffer, width, height))?;
    pocketjs_runtime_destroy(runtime);
    println!(
        "PJHEADLESS frame={} draw={:016x} framebuffer={:016x} ppa={} software={} damage={} pixels={} output={}",
        stats.frame,
        stats.draw_hash,
        framebuffer_hash,
        stats.ppa_fills + stats.ppa_blends + stats.ppa_srm,
        stats.software_ops,
        stats.damage_regions,
        stats.damage_pixels,
        output,
    );
    Ok(())
}
