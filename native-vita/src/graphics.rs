use vita2d_sys::*;
use pocketjs_core::{spec, text::Atlas};
use std::collections::HashMap;

static mut TEXTURES: Option<HashMap<i32, *mut vita2d_texture>> = None;
/// slot -> (atlas texture, cell_w, cell_h). The atlas texture is a vertical
/// strip of `glyph_count` cells (RGBA, white with per-pixel coverage as
/// alpha) built once in `register_font_atlas`; GLYPH_RUN tints it per draw.
static mut FONT_TEXTURES: Option<HashMap<u8, (*mut vita2d_texture, u32, u32)>> = None;

unsafe fn get_textures() -> &'static mut HashMap<i32, *mut vita2d_texture> {
    if TEXTURES.is_none() {
        TEXTURES = Some(HashMap::new());
    }
    TEXTURES.as_mut().unwrap()
}

unsafe fn get_font_textures() -> &'static mut HashMap<u8, (*mut vita2d_texture, u32, u32)> {
    if FONT_TEXTURES.is_none() {
        FONT_TEXTURES = Some(HashMap::new());
    }
    FONT_TEXTURES.as_mut().unwrap()
}

/// Copy `data` (tightly packed, `psm`-encoded, row-major) into a freshly
/// created vita2d texture, respecting the GPU's (possibly padded) stride,
/// and register it under `handle` for TEX_QUAD draws. Called once per
/// pak-fed image/sprite (pak::feed) or per `ui.uploadTexture()` call (ffi.rs).
pub unsafe fn register_texture(handle: i32, data: &[u8], w: u32, h: u32, psm: u32) {
    let (format, bpp) = match psm {
        spec::psm::PSM_8888 => (SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_U8U8U8U8_ABGR, 4usize),
        spec::psm::PSM_4444 => (SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_U4U4U4U4_ABGR, 2usize),
        _ => return,
    };
    let tex = vita2d_create_empty_texture_format(w, h, format);
    if tex.is_null() {
        return;
    }
    let stride = vita2d_texture_get_stride(tex) as usize;
    let dst = vita2d_texture_get_datap(tex) as *mut u8;
    let row_bytes = w as usize * bpp;
    if data.len() < row_bytes * h as usize {
        vita2d_free_texture(tex);
        return;
    }
    for row in 0..h as usize {
        core::ptr::copy_nonoverlapping(
            data.as_ptr().add(row * row_bytes),
            dst.add(row * stride),
            row_bytes,
        );
    }
    if let Some(old) = get_textures().insert(handle, tex) {
        vita2d_free_texture(old);
    }
}

/// Build the RGBA (white, coverage-as-alpha) strip texture for a parsed font
/// atlas and register it under `slot`. `atlas.bitmap` is `glyph_count` cells
/// of `cell_h x cell_w` alpha bytes stacked vertically (text.rs doc comment).
pub unsafe fn register_font_atlas(slot: u8, atlas: &Atlas) {
    let (cw, ch) = (atlas.cell_w, atlas.cell_h);
    let h = ch * atlas.glyph_count as u32;
    if cw == 0 || h == 0 {
        return;
    }
    let tex = vita2d_create_empty_texture_format(
        cw,
        h,
        SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_U8U8U8U8_ABGR,
    );
    if tex.is_null() {
        return;
    }
    let stride = vita2d_texture_get_stride(tex) as usize;
    let dst = vita2d_texture_get_datap(tex) as *mut u8;
    for (row, cov_row) in atlas.bitmap.chunks_exact(cw as usize).enumerate() {
        let dst_row = dst.add(row * stride);
        for (x, &coverage) in cov_row.iter().enumerate() {
            let o = x * 4;
            *dst_row.add(o) = 255;
            *dst_row.add(o + 1) = 255;
            *dst_row.add(o + 2) = 255;
            *dst_row.add(o + 3) = coverage;
        }
    }
    if let Some((old, _, _)) = get_font_textures().insert(slot, (tex, cw, ch)) {
        vita2d_free_texture(old);
    }
}

#[inline]
fn xy(word: u32) -> (i16, i16) {
    ((word & 0xffff) as u16 as i16, (word >> 16) as u16 as i16)
}

#[inline]
fn wh(word: u32) -> (i32, i32) {
    ((word & 0xffff) as i32, (word >> 16) as i32)
}

pub unsafe fn render(words: &[u32]) {
    vita2d_start_drawing();
    vita2d_clear_screen();

    let mut scissors: Vec<(i32, i32, i32, i32)> = Vec::new();

    let n = words.len();
    let mut i = 0usize;
    while i < n {
        match words[i] {
            spec::draw_op::RECT if i + 4 <= n => {
                let (x, y) = xy(words[i + 1]);
                let (w, h) = wh(words[i + 2]);
                let color = words[i + 3];
                vita2d_draw_rectangle(x as f32, y as f32, w as f32, h as f32, color);
                i += 4;
            }
            spec::draw_op::GRAD_RECT if i + 6 <= n => {
                // vita2d doesn't have a gradient rect out of the box, fallback to solid from-color
                let (x, y) = xy(words[i + 1]);
                let (w, h) = wh(words[i + 2]);
                let from = words[i + 3];
                vita2d_draw_rectangle(x as f32, y as f32, w as f32, h as f32, from);
                i += 6;
            }
            spec::draw_op::TRI if i + 7 <= n => {
                // Fallback or ignore for vita2d, vita2d has no primitive for arbitary triangles out of the box without direct vitaGL
                i += 7;
            }
            spec::draw_op::GLYPH_RUN if i + 3 <= n => {
                let w1 = words[i + 1];
                let slot = (w1 & 0xffff) as u8;
                let count = (w1 >> 16) as usize;
                let color = words[i + 2];
                let body = i + 3;
                let next = body + count * 2;
                if next > n { break; }
                if let Some(&(tex, cw, ch)) = get_font_textures().get(&slot) {
                    for k in 0..count {
                        let idx = body + k * 2;
                        let (x, y) = xy(words[idx]);
                        let gid = words[idx + 1];
                        vita2d_draw_texture_tint_part(
                            tex,
                            x as f32,
                            y as f32,
                            0.0,
                            (gid * ch) as f32,
                            cw as f32,
                            ch as f32,
                            color,
                        );
                    }
                }
                i = next;
            }
            spec::draw_op::TEX_QUAD if i + 9 <= n => {
                let handle = words[i + 1] as i32;
                let (x, y) = xy(words[i + 2]);
                let (w, h) = wh(words[i + 3]);
                let u0 = f32::from_bits(words[i + 4]);
                let v0 = f32::from_bits(words[i + 5]);
                let u1 = f32::from_bits(words[i + 6]);
                let v1 = f32::from_bits(words[i + 7]);
                
                let tex_map = get_textures();
                if let Some(&tex) = tex_map.get(&handle) {
                    let tex_w = vita2d_texture_get_width(tex) as f32;
                    let tex_h = vita2d_texture_get_height(tex) as f32;
                    let tex_x = u0 * tex_w;
                    let tex_y = v0 * tex_h;
                    let tex_part_w = (u1 - u0) * tex_w;
                    let tex_part_h = (v1 - v0) * tex_h;
                    
                    let scale_x = w as f32 / tex_part_w;
                    let scale_y = h as f32 / tex_part_h;
                    
                    vita2d_draw_texture_part_scale(
                        tex,
                        x as f32,
                        y as f32,
                        tex_x,
                        tex_y,
                        tex_part_w,
                        tex_part_h,
                        scale_x,
                        scale_y,
                    );
                }
                i += 9;
            }
            spec::draw_op::SCISSOR if i + 3 <= n => {
                let (x, y) = xy(words[i + 1]);
                let (w, h) = wh(words[i + 2]);
                let x1 = x as i32 + w;
                let y1 = y as i32 + h;
                scissors.push((x as i32, y as i32, x1, y1));
                vita2d_set_clip_rectangle(x as i32, y as i32, x1, y1);
                i += 3;
            }
            spec::draw_op::SCISSOR_POP => {
                scissors.pop();
                match scissors.last() {
                    Some(&(x, y, w, h)) => vita2d_set_clip_rectangle(x, y, w, h),
                    None => vita2d_disable_clipping(),
                }
                i += 1;
            }
            _ => break,
        }
    }

    vita2d_end_drawing();
    vita2d_swap_buffers();
}
