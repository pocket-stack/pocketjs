//! The `pocket_core_*` C entry points declared in `include/pocket_core.h`.

use alloc::boxed::Box;
use core::{ptr, slice, str};

use pocketjs_core::raster;
use pocketjs_core::Ui;
use pocketjs_sifli_epic::{RenderTargetState, Renderer, RendererConfig};

use crate::gpu::SifliGpu;

/// Largest number of persistent framebuffers one core tracks damage for
/// (`POCKET_CORE_MAX_TARGETS`).
pub const MAX_RENDER_TARGETS: usize = 4;

pub struct PocketCore {
    ui: Ui,
    renderer: Renderer,
    gpu: SifliGpu,
    trackers: [RenderTargetState; MAX_RENDER_TARGETS],
    target_count: usize,
    physical_width: u32,
    physical_height: u32,
    physical_pixels: usize,
    scale: u32,
}

/// Mirrors `PocketRenderStats` in `include/pocket_core.h` (append-only).
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct PocketRenderStats {
    pub draw_words: u32,
    pub damage_regions: u32,
    pub damage_pixels: u32,
    pub full_redraw: u32,
    pub full_redraw_promoted: u32,
    pub glyph_misses: u32,
    pub epic_fills: u32,
    pub epic_gradients: u32,
    pub epic_blends: u32,
    pub epic_copies: u32,
    pub software_ops: u32,
    pub software_words: u32,
    pub fences: u32,
    pub cpu_tiles: u32,
    pub cpu_tile_pixels: u32,
    pub mask_bands: u32,
}

const _: () = assert!(core::mem::size_of::<PocketRenderStats>() == 16 * 4);

#[inline]
unsafe fn core_mut<'a>(handle: *mut PocketCore) -> Option<&'a mut PocketCore> {
    handle.as_mut()
}

#[inline]
unsafe fn bytes<'a>(data: *const u8, len: usize) -> Option<&'a [u8]> {
    if data.is_null() {
        None
    } else {
        Some(slice::from_raw_parts(data, len))
    }
}

#[no_mangle]
pub extern "C" fn pocket_core_create(
    logical_width: u32,
    logical_height: u32,
    scale: u32,
    raster_density: u32,
    target_count: u32,
) -> *mut PocketCore {
    if logical_width == 0
        || logical_height == 0
        || !(1..=raster::MAX_RENDER_SCALE).contains(&scale)
        || raster_density == 0
        || raster_density > raster::MAX_RENDER_SCALE
        || target_count == 0
        || target_count as usize > MAX_RENDER_TARGETS
    {
        return ptr::null_mut();
    }

    let Some(width) = logical_width.checked_mul(scale) else {
        return ptr::null_mut();
    };
    let Some(height) = logical_height.checked_mul(scale) else {
        return ptr::null_mut();
    };
    let Some(physical_pixels) = (width as usize).checked_mul(height as usize) else {
        return ptr::null_mut();
    };
    let Some(gpu) = SifliGpu::new() else {
        return ptr::null_mut();
    };

    let mut ui = Ui::new_with_raster_density(raster_density);
    ui.set_viewport(logical_width as f32, logical_height as f32);
    let Some(renderer) = Renderer::new(RendererConfig { scale }) else {
        return ptr::null_mut();
    };
    Box::into_raw(Box::new(PocketCore {
        ui,
        renderer,
        gpu,
        trackers: [
            RenderTargetState::new(),
            RenderTargetState::new(),
            RenderTargetState::new(),
            RenderTargetState::new(),
        ],
        target_count: target_count as usize,
        physical_width: width,
        physical_height: height,
        physical_pixels,
        scale,
    }))
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_destroy(handle: *mut PocketCore) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_set_tick_rate(handle: *mut PocketCore, hz: u32) -> i32 {
    core_mut(handle)
        .map(|state| i32::from(state.ui.set_tick_rate(hz)))
        .unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_load_styles(
    handle: *mut PocketCore,
    data: *const u8,
    len: usize,
) -> i32 {
    match (core_mut(handle), bytes(data, len)) {
        (Some(state), Some(data)) => i32::from(state.ui.load_styles(data)),
        _ => 0,
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_load_font_atlas(
    handle: *mut PocketCore,
    data: *const u8,
    len: usize,
) -> i32 {
    match (core_mut(handle), bytes(data, len)) {
        (Some(state), Some(data)) => i32::from(state.ui.load_font_atlas(data)),
        _ => 0,
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_upload_img_entry(
    handle: *mut PocketCore,
    data: *const u8,
    len: usize,
) -> i32 {
    match (core_mut(handle), bytes(data, len)) {
        (Some(state), Some(data)) => state.ui.upload_img_entry(data),
        _ => -1,
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_upload_texture(
    handle: *mut PocketCore,
    data: *const u8,
    len: usize,
    width: u32,
    height: u32,
    psm: u32,
) -> i32 {
    match (core_mut(handle), bytes(data, len)) {
        (Some(state), Some(data)) => state.ui.upload_texture(data, width, height, psm),
        _ => -1,
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_free_texture(handle: *mut PocketCore, texture: i32) {
    if let Some(state) = core_mut(handle) {
        state.ui.free_texture(texture);
    }
}

/// Content revision of `texture`, the key the GPU queue pairs with the
/// handle when the host registers a native copy; `u64::MAX` when the handle
/// is not a live texture.
#[no_mangle]
pub unsafe extern "C" fn pocket_core_texture_revision(handle: *mut PocketCore, texture: i32) -> u64 {
    core_mut(handle)
        .and_then(|state| state.ui.texture_revision(texture))
        .unwrap_or(u64::MAX)
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_create_node(handle: *mut PocketCore, node_type: u32) -> i32 {
    core_mut(handle)
        .map(|state| state.ui.create_node(node_type as u8))
        .unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_destroy_node(handle: *mut PocketCore, id: i32) {
    if let Some(state) = core_mut(handle) {
        state.ui.destroy_node(id);
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_insert_before(
    handle: *mut PocketCore,
    parent: i32,
    child: i32,
    anchor: i32,
) {
    if let Some(state) = core_mut(handle) {
        state.ui.insert_before(parent, child, anchor);
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_remove_child(
    handle: *mut PocketCore,
    parent: i32,
    child: i32,
) {
    if let Some(state) = core_mut(handle) {
        state.ui.remove_child(parent, child);
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_set_style(handle: *mut PocketCore, id: i32, style_id: i32) {
    if let Some(state) = core_mut(handle) {
        state.ui.set_style(id, style_id);
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_set_prop(
    handle: *mut PocketCore,
    id: i32,
    prop: u32,
    value: f64,
) {
    if let Some(state) = core_mut(handle) {
        state.ui.set_prop(id, prop as u8, value);
    }
}

unsafe fn set_text(handle: *mut PocketCore, id: i32, data: *const u8, len: usize, replace: bool) {
    let (Some(state), Some(data)) = (core_mut(handle), bytes(data, len)) else {
        return;
    };
    let Ok(text) = str::from_utf8(data) else {
        return;
    };
    if replace {
        state.ui.replace_text(id, text);
    } else {
        state.ui.set_text(id, text);
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_set_text(
    handle: *mut PocketCore,
    id: i32,
    data: *const u8,
    len: usize,
) {
    set_text(handle, id, data, len, false);
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_replace_text(
    handle: *mut PocketCore,
    id: i32,
    data: *const u8,
    len: usize,
) {
    set_text(handle, id, data, len, true);
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_measure_text(
    handle: *mut PocketCore,
    data: *const u8,
    len: usize,
    font_slot: u32,
) -> f32 {
    let (Some(state), Some(data)) = (core_mut(handle), bytes(data, len)) else {
        return 0.0;
    };
    str::from_utf8(data)
        .map(|text| state.ui.measure_text(text, font_slot as u8))
        .unwrap_or(0.0)
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_set_image(handle: *mut PocketCore, id: i32, texture: i32) {
    if let Some(state) = core_mut(handle) {
        state.ui.set_image(id, texture);
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_set_sprite(
    handle: *mut PocketCore,
    id: i32,
    atlas: i32,
    frames: u32,
    cols: u32,
    step: u32,
) {
    if let Some(state) = core_mut(handle) {
        state.ui.set_sprite(id, atlas, frames, cols, step);
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_animate(
    handle: *mut PocketCore,
    id: i32,
    prop: u32,
    to: f64,
    duration_ms: u32,
    easing: u32,
    delay_ms: u32,
) -> i32 {
    core_mut(handle)
        .map(|state| {
            state
                .ui
                .animate(id, prop as u8, to, duration_ms, easing as u8, delay_ms)
        })
        .unwrap_or(-1)
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_cancel_anim(handle: *mut PocketCore, animation: i32) {
    if let Some(state) = core_mut(handle) {
        state.ui.cancel_anim(animation);
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_set_focus(handle: *mut PocketCore, id: i32) {
    if let Some(state) = core_mut(handle) {
        state.ui.set_focus(id);
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_set_active(handle: *mut PocketCore, id: i32, active: i32) {
    if let Some(state) = core_mut(handle) {
        state.ui.set_active(id, active != 0);
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_hit_test(handle: *mut PocketCore, x: f32, y: f32) -> i32 {
    core_mut(handle)
        .map(|state| state.ui.hit_test(x, y))
        .unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_hit_test_bounds(
    handle: *mut PocketCore,
    x: f32,
    y: f32,
) -> i32 {
    core_mut(handle)
        .map(|state| state.ui.hit_test_bounds(x, y))
        .unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_touch_hits(
    handle: *mut PocketCore,
    packed: *const u32,
    count: usize,
    out: *mut i32,
) -> usize {
    if packed.is_null() || out.is_null() {
        return 0;
    }
    let Some(state) = core_mut(handle) else {
        return 0;
    };
    let count = count.min(8);
    let packed = slice::from_raw_parts(packed, count);
    let mut hits = [0i32; 8];
    let written = state.ui.touch_hits(packed, &mut hits);
    ptr::copy_nonoverlapping(hits.as_ptr(), out, written);
    written
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_set_cursor(
    handle: *mut PocketCore,
    texture: i32,
    hot_x: f32,
    hot_y: f32,
    width: f32,
    height: f32,
) {
    if let Some(state) = core_mut(handle) {
        state.ui.set_cursor(texture, hot_x, hot_y, width, height);
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_set_cursor_pos(handle: *mut PocketCore, x: f32, y: f32) {
    if let Some(state) = core_mut(handle) {
        state.ui.set_cursor_pos(x, y);
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_tick(handle: *mut PocketCore) {
    if let Some(state) = core_mut(handle) {
        state.ui.tick();
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_render_rgb565(
    handle: *mut PocketCore,
    framebuffer: *mut u16,
    pixel_count: usize,
    target_index: u32,
    out_stats: *mut PocketRenderStats,
) -> i32 {
    let Some(state) = core_mut(handle) else {
        return -1;
    };
    if framebuffer.is_null()
        || pixel_count != state.physical_pixels
        || target_index as usize >= state.target_count
    {
        return -1;
    }

    let (words_ptr, words_len) = {
        let draw_list = state.ui.draw();
        (draw_list.words.as_ptr(), draw_list.words.len())
    };
    let words = slice::from_raw_parts(words_ptr, words_len);
    let pixels = slice::from_raw_parts_mut(framebuffer, pixel_count);
    let ui_ptr: *const Ui = &state.ui;
    let renderer = &mut state.renderer;
    let tracker = &mut state.trackers[target_index as usize];

    let mut stats = PocketRenderStats {
        draw_words: words_len.min(u32::MAX as usize) as u32,
        glyph_misses: state.ui.glyph_misses(),
        ..PocketRenderStats::default()
    };

    match renderer.render_incremental(
        tracker,
        &*ui_ptr,
        words,
        pixels,
        state.physical_width,
        state.physical_height,
        &mut state.gpu,
    ) {
        Some(render) => {
            stats.damage_regions = render.damage_regions;
            stats.damage_pixels = render.damage_pixels;
            stats.full_redraw = u32::from(render.full_redraw);
            stats.full_redraw_promoted = u32::from(render.full_redraw_promoted);
            stats.epic_fills = render.epic_fills;
            stats.epic_gradients = render.epic_gradients;
            stats.epic_blends = render.epic_blends;
            stats.epic_copies = render.epic_copies;
            stats.software_ops = render.software_ops;
            stats.software_words = render.software_words;
            stats.fences = render.fences;
            stats.cpu_tiles = render.cpu_tiles;
            stats.cpu_tile_pixels = render.cpu_tile_pixels;
            stats.mask_bands = render.mask_bands;
        }
        None => {
            // Only a malformed DrawList or a driver failure reaches this;
            // the framebuffer may be partially updated, so repaint it whole.
            tracker.invalidate();
            raster::render_scaled_rgb565(&*ui_ptr, words, pixels, state.scale);
            stats.damage_regions = 1;
            stats.damage_pixels = state.physical_pixels.min(u32::MAX as usize) as u32;
            stats.full_redraw = 1;
            stats.software_ops = 1;
            stats.software_words = words_len.min(u32::MAX as usize) as u32;
        }
    }

    if !out_stats.is_null() {
        out_stats.write(stats);
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_render_rgb565_software(
    handle: *mut PocketCore,
    framebuffer: *mut u16,
    pixel_count: usize,
) -> i32 {
    let Some(state) = core_mut(handle) else {
        return -1;
    };
    if framebuffer.is_null() || pixel_count != state.physical_pixels {
        return -1;
    }
    let (words_ptr, words_len) = {
        let draw_list = state.ui.draw();
        (draw_list.words.as_ptr(), draw_list.words.len())
    };
    let words = slice::from_raw_parts(words_ptr, words_len);
    let pixels = slice::from_raw_parts_mut(framebuffer, pixel_count);
    raster::render_scaled_rgb565(&state.ui, words, pixels, state.scale);
    0
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_draw_hash(handle: *mut PocketCore) -> u64 {
    let Some(state) = core_mut(handle) else {
        return 0;
    };
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &word in state.ui.draw().words.iter() {
        for byte in word.to_le_bytes() {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    hash
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_debug_inspect(handle: *mut PocketCore, id: i32) {
    if let Some(state) = core_mut(handle) {
        state.ui.debug_inspect(id);
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_debug_rect_xy(handle: *mut PocketCore) -> i32 {
    core_mut(handle)
        .map(|state| state.ui.debug_rect_xy())
        .unwrap_or(-1)
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_debug_rect_wh(handle: *mut PocketCore) -> i32 {
    core_mut(handle)
        .map(|state| state.ui.debug_rect_wh())
        .unwrap_or(-1)
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_debug_pause(handle: *mut PocketCore, on: i32) {
    if let Some(state) = core_mut(handle) {
        state.ui.debug_pause(on != 0);
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_core_debug_step(handle: *mut PocketCore) {
    if let Some(state) = core_mut(handle) {
        state.ui.debug_step();
    }
}
