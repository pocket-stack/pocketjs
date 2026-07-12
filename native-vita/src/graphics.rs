//! vita2d/GXM DrawList backend shared by PocketJS apps and games.
//!
//! The core stays at its deterministic 480x272 logical viewport. Every
//! coordinate is multiplied by two at this boundary, filling the Vita's
//! native 960x544 framebuffer exactly without relayout.

use std::collections::HashMap;
#[cfg(feature = "capture")]
use std::fs;
#[cfg(feature = "capture")]
use std::io;
#[cfg(feature = "capture")]
use std::path::Path;

use pocketjs_core::{spec, text::Atlas, Ui};
use vita2d_sys::*;

mod build_plan {
    include!(concat!(env!("OUT_DIR"), "/build_plan.rs"));
}

pub use build_plan::{INTEGER_SCALE, LOGICAL_H, LOGICAL_W, PHYSICAL_H, PHYSICAL_W, SCALE};
pub const DEFAULT_POOL_BYTES: u32 = 2 * 1024 * 1024;

#[derive(Clone, Copy)]
struct Texture {
    ptr: *mut vita2d_texture,
    w: u32,
    h: u32,
}

#[derive(Clone, Copy)]
struct FontTexture {
    ptr: *mut vita2d_texture,
    cell_w: u32,
    cell_h: u32,
    cols: u32,
}

static mut INITIALIZED: bool = false;
static mut TEXTURES: Option<HashMap<i32, Texture>> = None;
static mut FONTS: Option<HashMap<u8, FontTexture>> = None;

unsafe fn textures() -> &'static mut HashMap<i32, Texture> {
    if TEXTURES.is_none() {
        TEXTURES = Some(HashMap::new());
    }
    TEXTURES.as_mut().unwrap()
}

unsafe fn fonts() -> &'static mut HashMap<u8, FontTexture> {
    if FONTS.is_none() {
        FONTS = Some(HashMap::new());
    }
    FONTS.as_mut().unwrap()
}

pub fn init() -> Result<(), &'static str> {
    init_with_pool(DEFAULT_POOL_BYTES)
}

/// Initialize vita2d once. Games with large projected worlds should call
/// this with a larger pool before constructing `Runtime` (8 MiB is typical).
pub fn init_with_pool(pool_bytes: u32) -> Result<(), &'static str> {
    unsafe {
        if INITIALIZED {
            return Ok(());
        }
        if vita2d_init_advanced(pool_bytes) < 0 {
            return Err("vita2d_init_advanced failed");
        }
        vita2d_set_vblank_wait(1);
        vita2d_set_clear_color(0xff00_0000);
        INITIALIZED = true;
        Ok(())
    }
}

/// Start and clear one shared scene. Draw 3D first, then call
/// `Runtime::render_over`, then `present` exactly once.
///
/// # Safety
///
/// Call on the Vita render thread after [`init`], with no scene already open.
pub unsafe fn begin_frame(clear: u32) {
    vita2d_set_clear_color(clear);
    vita2d_start_drawing();
    vita2d_disable_clipping();
    vita2d_clear_screen();
}

/// Finish, wait for GXM, and make the rendered buffer current/front.
///
/// # Safety
///
/// Call on the Vita render thread with exactly one scene opened by
/// [`begin_frame`] or `vita2d_start_drawing`.
pub unsafe fn present() {
    vita2d_disable_clipping();
    vita2d_end_drawing();
    vita2d_wait_rendering_done();
    vita2d_swap_buffers();
}

fn texture_rgba(view: pocketjs_core::TexView<'_>) -> Option<Vec<u8>> {
    let pixels = (view.w as usize).checked_mul(view.h as usize)?;
    let mut out = vec![0u8; pixels.checked_mul(4)?];
    match view.psm {
        spec::psm::PSM_8888 => {
            let len = out.len();
            if view.pixels.len() < len {
                return None;
            }
            out.copy_from_slice(&view.pixels[..len]);
        }
        spec::psm::PSM_4444 => {
            if view.pixels.len() < pixels * 2 {
                return None;
            }
            for (i, src) in view.pixels[..pixels * 2].chunks_exact(2).enumerate() {
                let px = u16::from_le_bytes([src[0], src[1]]);
                out[i * 4] = ((px & 0x000f) as u8) * 17;
                out[i * 4 + 1] = (((px >> 4) & 0x000f) as u8) * 17;
                out[i * 4 + 2] = (((px >> 8) & 0x000f) as u8) * 17;
                out[i * 4 + 3] = (((px >> 12) & 0x000f) as u8) * 17;
            }
        }
        spec::psm::PSM_T8 => {
            let palette = view.palette?;
            if palette.len() < 1024 || view.pixels.len() < pixels {
                return None;
            }
            for (i, &index) in view.pixels[..pixels].iter().enumerate() {
                let p = index as usize * 4;
                out[i * 4..i * 4 + 4].copy_from_slice(&palette[p..p + 4]);
            }
        }
        _ => return None,
    }
    Some(out)
}

unsafe fn upload_rgba(w: u32, h: u32, rgba: &[u8], linear: bool) -> Option<Texture> {
    if w == 0 || h == 0 || rgba.len() < w as usize * h as usize * 4 {
        return None;
    }
    let ptr = vita2d_create_empty_texture_format(
        w,
        h,
        SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_U8U8U8U8_ABGR,
    );
    if ptr.is_null() {
        return None;
    }
    let stride = vita2d_texture_get_stride(ptr) as usize;
    let dst = vita2d_texture_get_datap(ptr) as *mut u8;
    let row_bytes = w as usize * 4;
    for row in 0..h as usize {
        core::ptr::copy_nonoverlapping(
            rgba.as_ptr().add(row * row_bytes),
            dst.add(row * stride),
            row_bytes,
        );
    }
    let filter = if linear {
        SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR
    } else {
        SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_POINT
    };
    vita2d_texture_set_filters(ptr, filter, filter);
    Some(Texture { ptr, w, h })
}

pub fn register_texture(ui: &Ui, handle: i32) {
    let Some(view) = ui.texture(handle) else {
        return;
    };
    let Some(rgba) = texture_rgba(view) else {
        return;
    };
    unsafe {
        let Some(texture) = upload_rgba(view.w, view.h, &rgba, view.linear) else {
            return;
        };
        if let Some(old) = textures().insert(handle, texture) {
            vita2d_free_texture(old.ptr);
        }
    }
}

/// Resolve a DrawList texture in the Vita GPU cache, uploading core-owned
/// textures (for example the baked rounded-corner discs) on first use.
/// Pak/JS textures are registered eagerly, but textures minted internally by
/// `Ui::draw` never cross those upload hooks.
unsafe fn resolve_texture(ui: &Ui, handle: i32) -> Option<Texture> {
    if let Some(texture) = textures().get(&handle).copied() {
        return Some(texture);
    }
    register_texture(ui, handle);
    textures().get(&handle).copied()
}

pub fn free_texture(handle: i32) {
    unsafe {
        if let Some(texture) = textures().remove(&handle) {
            vita2d_free_texture(texture.ptr);
        }
    }
}

#[inline]
fn next_pow2(mut value: u32) -> u32 {
    if value <= 1 {
        return 1;
    }
    value -= 1;
    value |= value >> 1;
    value |= value >> 2;
    value |= value >> 4;
    value |= value >> 8;
    value |= value >> 16;
    value + 1
}

pub fn register_font_atlas(slot: u8, atlas: &Atlas) {
    let glyphs = atlas.glyph_count as u32;
    if glyphs == 0 || atlas.cell_w == 0 || atlas.cell_h == 0 {
        return;
    }
    let max_cols = (spec::TEX_MAX_DIM / atlas.cell_w).max(1);
    let mut cols = 1u32;
    while cols < max_cols && cols.saturating_mul(cols) < glyphs {
        cols += 1;
    }
    let rows = glyphs.div_ceil(cols);
    let tex_w = next_pow2(cols * atlas.cell_w);
    let tex_h = next_pow2(rows * atlas.cell_h);
    if tex_w > spec::TEX_MAX_DIM || tex_h > spec::TEX_MAX_DIM {
        return;
    }
    let mut rgba = vec![0u8; tex_w as usize * tex_h as usize * 4];
    for gid in 0..atlas.glyph_count {
        let src = atlas.glyph_rows(gid);
        let gx = (gid as u32 % cols) * atlas.cell_w;
        let gy = (gid as u32 / cols) * atlas.cell_h;
        for y in 0..atlas.cell_h as usize {
            for x in 0..atlas.cell_w as usize {
                let dst = ((gy as usize + y) * tex_w as usize + gx as usize + x) * 4;
                rgba[dst] = 255;
                rgba[dst + 1] = 255;
                rgba[dst + 2] = 255;
                rgba[dst + 3] = src[y * atlas.bytes_per_row() + x];
            }
        }
    }
    unsafe {
        let Some(texture) = upload_rgba(tex_w, tex_h, &rgba, false) else {
            return;
        };
        let font = FontTexture {
            ptr: texture.ptr,
            cell_w: atlas.cell_w,
            cell_h: atlas.cell_h,
            cols,
        };
        if let Some(old) = fonts().insert(slot, font) {
            vita2d_free_texture(old.ptr);
        }
    }
}

#[inline]
fn xy(word: u32) -> (f32, f32) {
    (
        (word & 0xffff) as u16 as i16 as f32 * SCALE,
        (word >> 16) as u16 as i16 as f32 * SCALE,
    )
}

#[inline]
fn wh(word: u32) -> (f32, f32) {
    ((word & 0xffff) as f32 * SCALE, (word >> 16) as f32 * SCALE)
}

unsafe fn color_vertices(values: &[vita2d_color_vertex], mode: SceGxmPrimitiveType) {
    let bytes = core::mem::size_of_val(values);
    let dst = vita2d_pool_memalign(bytes as u32, 4) as *mut vita2d_color_vertex;
    if dst.is_null() {
        return;
    }
    core::ptr::copy_nonoverlapping(values.as_ptr(), dst, values.len());
    vita2d_draw_array(mode, dst, values.len());
}

unsafe fn texture_vertices(
    texture: *const vita2d_texture,
    values: &[vita2d_texture_vertex],
    mode: SceGxmPrimitiveType,
    color: u32,
) {
    let bytes = core::mem::size_of_val(values);
    let dst = vita2d_pool_memalign(bytes as u32, 4) as *mut vita2d_texture_vertex;
    if dst.is_null() {
        return;
    }
    core::ptr::copy_nonoverlapping(values.as_ptr(), dst, values.len());
    vita2d_draw_array_textured(texture, mode, dst, values.len(), color);
}

/// Clear and draw one standalone UI scene. `present` remains explicit.
///
/// # Safety
///
/// Call on the Vita render thread after [`init`], with no scene already open.
pub unsafe fn render(ui: &Ui, words: &[u32]) {
    begin_frame(0xff00_0000);
    render_over(ui, words);
}

/// Draw a PocketJS HUD into the caller's open vita2d scene.
///
/// # Safety
///
/// Call on the Vita render thread while a vita2d scene is open. `words` and
/// every texture referenced by it must remain valid for this submission.
pub unsafe fn render_over(ui: &Ui, words: &[u32]) {
    let mut scissors: Vec<(i32, i32, i32, i32)> = Vec::new();
    let mut i = 0usize;
    while i < words.len() {
        match words[i] {
            spec::draw_op::RECT if i + 4 <= words.len() => {
                let (x, y) = xy(words[i + 1]);
                let (w, h) = wh(words[i + 2]);
                vita2d_draw_rectangle(x, y, w, h, words[i + 3]);
                i += 4;
            }
            spec::draw_op::GRAD_RECT if i + 6 <= words.len() => {
                let (x, y) = xy(words[i + 1]);
                let (w, h) = wh(words[i + 2]);
                let from = words[i + 3];
                let to = words[i + 4];
                let (tl, tr, bl, br) = match words[i + 5] {
                    d if d == spec::GradDir::ToTop as u32 => (to, to, from, from),
                    d if d == spec::GradDir::ToLeft as u32 => (to, from, to, from),
                    d if d == spec::GradDir::ToRight as u32 => (from, to, from, to),
                    _ => (from, from, to, to),
                };
                color_vertices(
                    &[
                        vita2d_color_vertex {
                            x,
                            y,
                            z: 0.5,
                            color: tl,
                        },
                        vita2d_color_vertex {
                            x: x + w,
                            y,
                            z: 0.5,
                            color: tr,
                        },
                        vita2d_color_vertex {
                            x,
                            y: y + h,
                            z: 0.5,
                            color: bl,
                        },
                        vita2d_color_vertex {
                            x: x + w,
                            y: y + h,
                            z: 0.5,
                            color: br,
                        },
                    ],
                    SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLE_STRIP,
                );
                i += 6;
            }
            spec::draw_op::TRI if i + 7 <= words.len() => {
                let mut vertices = [vita2d_color_vertex {
                    x: 0.0,
                    y: 0.0,
                    z: 0.5,
                    color: 0,
                }; 3];
                for k in 0..3 {
                    let (x, y) = xy(words[i + 1 + k]);
                    vertices[k] = vita2d_color_vertex {
                        x,
                        y,
                        z: 0.5,
                        color: words[i + 4 + k],
                    };
                }
                color_vertices(&vertices, SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES);
                i += 7;
            }
            spec::draw_op::GLYPH_RUN if i + 3 <= words.len() => {
                let meta = words[i + 1];
                let slot = (meta & 0xff) as u8;
                let count = (meta >> 16) as usize;
                let next = i + 3 + count * 2;
                if next > words.len() {
                    break;
                }
                if let Some(&font) = fonts().get(&slot) {
                    let color = words[i + 2];
                    for k in 0..count {
                        let (x, y) = xy(words[i + 3 + k * 2]);
                        let gid = words[i + 4 + k * 2] & 0xffff;
                        let sx = (gid % font.cols) * font.cell_w;
                        let sy = (gid / font.cols) * font.cell_h;
                        vita2d_draw_texture_tint_part_scale(
                            font.ptr,
                            x,
                            y,
                            sx as f32,
                            sy as f32,
                            font.cell_w as f32,
                            font.cell_h as f32,
                            SCALE,
                            SCALE,
                            color,
                        );
                    }
                }
                i = next;
            }
            spec::draw_op::TEX_QUAD if i + 9 <= words.len() => {
                let handle = words[i + 1] as i32;
                if let Some(texture) = resolve_texture(ui, handle) {
                    let (x, y) = xy(words[i + 2]);
                    let (w, h) = wh(words[i + 3]);
                    let u0 = f32::from_bits(words[i + 4]);
                    let v0 = f32::from_bits(words[i + 5]);
                    let u1 = f32::from_bits(words[i + 6]);
                    let v1 = f32::from_bits(words[i + 7]);
                    let tw = (u1 - u0) * texture.w as f32;
                    let th = (v1 - v0) * texture.h as f32;
                    if tw > 0.0 && th > 0.0 {
                        vita2d_draw_texture_tint_part_scale(
                            texture.ptr,
                            x,
                            y,
                            u0 * texture.w as f32,
                            v0 * texture.h as f32,
                            tw,
                            th,
                            w / tw,
                            h / th,
                            words[i + 8],
                        );
                    }
                }
                i += 9;
            }
            spec::draw_op::TEX_TRI if i + 12 <= words.len() => {
                let handle = words[i + 1] as i32;
                if let Some(texture) = resolve_texture(ui, handle) {
                    let mut vertices = [vita2d_texture_vertex {
                        x: 0.0,
                        y: 0.0,
                        z: 0.5,
                        u: 0.0,
                        v: 0.0,
                    }; 3];
                    for (k, vertex) in vertices.iter_mut().enumerate() {
                        let o = i + 2 + k * 3;
                        let (x, y) = xy(words[o]);
                        *vertex = vita2d_texture_vertex {
                            x,
                            y,
                            z: 0.5,
                            u: f32::from_bits(words[o + 1]),
                            v: f32::from_bits(words[o + 2]),
                        };
                    }
                    texture_vertices(
                        texture.ptr,
                        &vertices,
                        SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES,
                        words[i + 11],
                    );
                }
                i += 12;
            }
            spec::draw_op::SCISSOR if i + 3 <= words.len() => {
                let (x, y) = xy(words[i + 1]);
                let (w, h) = wh(words[i + 2]);
                let rect = (x as i32, y as i32, w as i32, h as i32);
                scissors.push(rect);
                vita2d_set_clip_rectangle(rect.0, rect.1, rect.0 + rect.2, rect.1 + rect.3);
                vita2d_enable_clipping();
                i += 3;
            }
            spec::draw_op::SCISSOR_POP => {
                scissors.pop();
                if let Some(&(x, y, w, h)) = scissors.last() {
                    vita2d_set_clip_rectangle(x, y, x + w, y + h);
                } else {
                    vita2d_disable_clipping();
                }
                i += 1;
            }
            _ => break,
        }
    }
    vita2d_disable_clipping();
}

#[cfg(feature = "capture")]
fn validate_texture_residency(ui: &Ui, words: &[u32]) -> io::Result<()> {
    let mut i = 0usize;
    while i < words.len() {
        let next = match words[i] {
            spec::draw_op::RECT => i.checked_add(4),
            spec::draw_op::GRAD_RECT => i.checked_add(6),
            spec::draw_op::TRI => i.checked_add(7),
            spec::draw_op::GLYPH_RUN if i + 2 < words.len() => {
                let count = (words[i + 1] >> 16) as usize;
                i.checked_add(3 + count.saturating_mul(2))
            }
            spec::draw_op::TEX_QUAD | spec::draw_op::TEX_TRI => {
                let op = words[i];
                let handle = *words.get(i + 1).ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "truncated texture draw op")
                })? as i32;
                if ui.texture(handle).is_none() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("DrawList references stale texture handle {handle}"),
                    ));
                }
                let resident = unsafe { textures().contains_key(&handle) };
                if !resident {
                    return Err(io::Error::other(format!(
                        "Vita GPU texture {handle} was not resident after production rendering"
                    )));
                }
                i.checked_add(if op == spec::draw_op::TEX_QUAD { 9 } else { 12 })
            }
            spec::draw_op::SCISSOR => i.checked_add(3),
            spec::draw_op::SCISSOR_POP => i.checked_add(1),
            op => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("unknown DrawList op {op} at word {i}"),
                ));
            }
        }
        .filter(|next| *next <= words.len())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "truncated DrawList op"))?;
        i = next;
    }
    Ok(())
}

/// Render a deterministic golden at logical resolution and expand every pixel
/// using the build plan's integer scale. Vita3K's Vulkan framebuffer is not read back:
/// on current macOS builds that surface is not coherent with guest CDRAM and
/// produces black dumps. This still runs the real Vita QuickJS/input/frame
/// loop, while making the pixel oracle byte-stable and explicitly testing the
/// 480x272 -> 960x544 fullscreen mapping used by the production GXM renderer.
#[cfg(feature = "capture")]
pub fn capture_golden(ui: &Ui, words: &[u32], path: &str) -> io::Result<()> {
    // The pixels below come from the deterministic CPU oracle because current
    // Vita3K/macOS GXM readback is black. Still verify that the production
    // renderer made every core texture resident, so backend-only omissions
    // (notably rounded-corner discs) cannot hide behind a passing CPU golden.
    validate_texture_residency(ui, words)?;
    let mut logical = vec![0u8; LOGICAL_W as usize * LOGICAL_H as usize * 4];
    pocketjs_core::raster::render(ui, words, &mut logical);

    let mut pixels = vec![0u8; PHYSICAL_W as usize * PHYSICAL_H as usize * 4];
    for y in 0..LOGICAL_H as usize {
        for x in 0..LOGICAL_W as usize {
            let src = (y * LOGICAL_W as usize + x) * 4;
            for dy in 0..INTEGER_SCALE {
                for dx in 0..INTEGER_SCALE {
                    let dst =
                        ((y * INTEGER_SCALE + dy) * PHYSICAL_W as usize + x * INTEGER_SCALE + dx)
                            * 4;
                    pixels[dst..dst + 4].copy_from_slice(&logical[src..src + 4]);
                }
            }
        }
    }
    if let Some(parent) = Path::new(path).parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, pixels)
}
