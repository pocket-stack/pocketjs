//! DrawList -> sceGu. Walks the core's Vec<u32> (spec.ts "DRAWLIST op
//! format") and enqueues GE commands into the display list main.rs opened —
//! this module NEVER calls sceGuStart/Finish/Sync/SwapBuffers (dreamcart
//! contract).
//!
//! PER-FRAME BUMP VERTEX ARENA [R]: the GE consumes vertices ASYNCHRONOUSLY
//! in Direct mode, so a region handed to sceGuDrawArray must never be
//! rewritten within the frame. Every batch allocates fresh 16-byte-aligned
//! space from a Vec<Chunk16>-backed pool (grown through the arena-backed
//! global allocator, retained across frames); main.rs calls `reset_pool()`
//! only AFTER sceGuSync — the GE has finished reading by then.
//!
//! Coordinates arrive pre-clipped from the core (always inside
//! [0,480]x[0,272], i16-safe — the CPU clip stage guarantee), so no clamping
//! happens here. Glyph CELLS may overhang the screen edge by up to a cell
//! (only their top-left is range-guaranteed): far under i16 wrap range, and
//! the always-on scissor test pixel-clips them.
//!
//! UV semantics (VERIFIED on PPSSPP, and documented in rust-psp itself —
//! sceGuTexOffset/TexScale: "Only used by the 3D T&L pipe, renders done with
//! VertexType::TRANSFORM_2D are not affected"): in TRANSFORM_2D texture
//! coordinates are RAW TEXELS, not normalized. The DrawList's normalized f32
//! UVs are multiplied by the texture dimensions before hitting the vertices.
//!
//! GE state contract: Blend is enabled (SrcAlpha/OneMinusSrcAlpha) for the
//! whole pass; Texture2D only around TEX_QUADs; on exit Blend + Texture2D
//! are disabled, scissor is restored to full screen — sticky-state reset per
//! the dreamcart pass-boundary rule.

use alloc::vec::Vec;
use core::ffi::c_void;
use core::ptr::null;

use psp::sys::{
    self, BlendFactor, BlendOp, ClearBuffer, ClutPixelFormat, GuPrimitive, GuState, MipmapLevel,
    TextureColorComponent, TextureEffect, TextureFilter, TexturePixelFormat, VertexType,
};
use psp::{SCREEN_HEIGHT, SCREEN_WIDTH};
use pocketjs_core::{spec, text::Atlas, TexView, Ui};

// ---------------------------------------------------------------------------
// Vertex formats (GE fixed component order: [uv][color][pos])
// ---------------------------------------------------------------------------

/// COLOR_8888 | VERTEX_16BIT | TRANSFORM_2D — 12-byte stride (the GE derives
/// the stride from the vtype: 4B color + 6B pos, padded to 4-byte alignment).
#[repr(C)]
#[derive(Copy, Clone)]
struct VertC {
    color: u32,
    x: i16,
    y: i16,
    z: i16,
    _pad: i16,
}

/// TEXTURE_16BIT | COLOR_8888 | VERTEX_16BIT | TRANSFORM_2D — 16-byte stride
/// (4B uv + 4B color + 6B pos, padded).
#[repr(C)]
#[derive(Copy, Clone)]
struct VertTC {
    u: i16,
    v: i16,
    color: u32,
    x: i16,
    y: i16,
    z: i16,
    _pad: i16,
}

const VTYPE_C: VertexType = VertexType::from_bits_truncate(
    VertexType::COLOR_8888.bits() | VertexType::VERTEX_16BIT.bits() | VertexType::TRANSFORM_2D.bits(),
);
const VTYPE_TC: VertexType = VertexType::from_bits_truncate(
    VertexType::TEXTURE_16BIT.bits()
        | VertexType::COLOR_8888.bits()
        | VertexType::VERTEX_16BIT.bits()
        | VertexType::TRANSFORM_2D.bits(),
);

// ---------------------------------------------------------------------------
// Per-frame bump vertex arena [R]
// ---------------------------------------------------------------------------

#[repr(C, align(16))]
#[derive(Copy, Clone)]
struct Chunk16([u8; 16]);

const BLOCK_BYTES: usize = 64 * 1024;

struct Pool {
    blocks: Vec<Vec<Chunk16>>,
    cur: usize,
    off: usize,
}

static mut POOL: Option<Pool> = None;

struct FontTexture {
    source_ptr: usize,
    source_len: usize,
    glyph_count: u16,
    /// Source coverage-cell dimensions in texture texels.
    coverage_w: u32,
    coverage_h: u32,
    /// Destination cell dimensions in logical screen pixels.
    logical_w: u32,
    logical_h: u32,
    raster_density: u8,
    cols: u32,
    tex_w: u32,
    tex_h: u32,
    pixels: Vec<u128>,
}

static mut FONT_TEXTURES: Option<Vec<Option<FontTexture>>> = None;

/// Bump-allocate `bytes` (16-byte aligned) valid until `reset_pool()`.
/// Shared with ge3d.rs for its per-frame transients (sky strip, pool quads).
pub(crate) unsafe fn pool_alloc(bytes: usize) -> *mut u8 {
    if POOL.is_none() {
        POOL = Some(Pool { blocks: Vec::new(), cur: 0, off: 0 });
    }
    let pool = POOL.as_mut().unwrap();
    let need = (bytes + 15) & !15;
    loop {
        if pool.cur < pool.blocks.len() {
            let cap = pool.blocks[pool.cur].len() * 16;
            if pool.off + need <= cap {
                let p = (pool.blocks[pool.cur].as_mut_ptr() as *mut u8).add(pool.off);
                pool.off += need;
                return p;
            }
            pool.cur += 1;
            pool.off = 0;
        } else {
            // Grow: a standard block, or an exact-size one for oversize asks.
            let n = core::cmp::max(need, BLOCK_BYTES) / 16;
            pool.blocks.push(alloc::vec![Chunk16([0u8; 16]); n]);
        }
    }
}

/// Rewind the bump pool. ONLY call after sceGuSync — the GE reads the
/// vertex memory asynchronously until then.
pub unsafe fn reset_pool() {
    if let Some(pool) = POOL.as_mut() {
        pool.cur = 0;
        pool.off = 0;
    }
}

unsafe fn font_texture_slots() -> &'static mut Vec<Option<FontTexture>> {
    if FONT_TEXTURES.is_none() {
        let mut slots = Vec::new();
        for _ in 0..spec::MAX_FONT_SLOTS {
            slots.push(None);
        }
        FONT_TEXTURES = Some(slots);
    }
    FONT_TEXTURES.as_mut().unwrap()
}

#[inline]
fn next_pow2(mut v: u32) -> u32 {
    if v <= 1 {
        return 1;
    }
    v -= 1;
    v |= v >> 1;
    v |= v >> 2;
    v |= v >> 4;
    v |= v >> 8;
    v |= v >> 16;
    v + 1
}

fn font_grid(atlas: &Atlas) -> Option<(u32, u32, u32)> {
    let glyph_count = atlas.glyph_count as u32;
    let cell_w = atlas.coverage_width().max(1);
    let cell_h = atlas.coverage_height().max(1);
    if glyph_count == 0 || cell_w > spec::TEX_MAX_DIM || cell_h > spec::TEX_MAX_DIM {
        return None;
    }
    let max_cols = (spec::TEX_MAX_DIM / cell_w).max(1);
    let mut cols = 1u32;
    while cols < max_cols && cols.saturating_mul(cols) < glyph_count {
        cols += 1;
    }
    let mut rows = (glyph_count + cols - 1) / cols;
    let mut tex_w = next_pow2(cols * cell_w);
    let mut tex_h = next_pow2(rows * cell_h);
    if tex_w > spec::TEX_MAX_DIM || tex_h > spec::TEX_MAX_DIM {
        cols = max_cols;
        rows = (glyph_count + cols - 1) / cols;
        tex_w = next_pow2(cols * cell_w);
        tex_h = next_pow2(rows * cell_h);
    }
    if tex_w > spec::TEX_MAX_DIM || tex_h > spec::TEX_MAX_DIM {
        return None;
    }
    Some((cols, tex_w, tex_h))
}

unsafe fn build_font_texture(atlas: &Atlas) -> Option<FontTexture> {
    let (cols, tex_w, tex_h) = font_grid(atlas)?;
    let byte_len = tex_w as usize * tex_h as usize * 2;
    let mut pixels = alloc::vec![0u128; (byte_len + 15) / 16];
    let dst = pixels.as_mut_ptr() as *mut u8;
    let (cell_w, cell_h) = (
        atlas.coverage_width() as usize,
        atlas.coverage_height() as usize,
    );
    let bpr = atlas.bytes_per_row();
    for gid in 0..atlas.glyph_count {
        let src = atlas.glyph_rows(gid);
        let gx = (gid as u32 % cols) as usize * cell_w;
        let gy = (gid as u32 / cols) as usize * cell_h;
        for y in 0..cell_h {
            let row = &src[y * bpr..y * bpr + bpr];
            for x in 0..cell_w {
                let a4 = ((row[x] as u32 + 8) / 17).min(15) as u16;
                if a4 == 0 {
                    continue;
                }
                // PSM_4444 little-endian: ABBB GGGG RRRR nibbles. White
                // color lets TextureEffect::Modulate carry the vertex color.
                let px = (a4 << 12) | 0x0fff;
                let off = ((gy + y) * tex_w as usize + (gx + x)) * 2;
                *dst.add(off) = px as u8;
                *dst.add(off + 1) = (px >> 8) as u8;
            }
        }
    }
    sys::sceKernelDcacheWritebackRange(dst as *const c_void, byte_len as u32);
    Some(FontTexture {
        source_ptr: atlas.bitmap.as_ptr() as usize,
        source_len: atlas.bitmap.len(),
        glyph_count: atlas.glyph_count,
        coverage_w: atlas.coverage_width(),
        coverage_h: atlas.coverage_height(),
        logical_w: atlas.cell_w,
        logical_h: atlas.cell_h,
        raster_density: atlas.raster_density,
        cols,
        tex_w,
        tex_h,
        pixels,
    })
}

unsafe fn font_texture(atlas: &Atlas) -> Option<&'static FontTexture> {
    let slots = font_texture_slots();
    let idx = atlas.slot as usize;
    if idx >= slots.len() {
        return None;
    }
    let source_ptr = atlas.bitmap.as_ptr() as usize;
    let source_len = atlas.bitmap.len();
    let stale = match slots[idx].as_ref() {
        Some(tex) => {
            tex.source_ptr != source_ptr
                || tex.source_len != source_len
                || tex.glyph_count != atlas.glyph_count
                || tex.coverage_w != atlas.coverage_width()
                || tex.coverage_h != atlas.coverage_height()
                || tex.logical_w != atlas.cell_w
                || tex.logical_h != atlas.cell_h
                || tex.raster_density != atlas.raster_density
        }
        None => true,
    };
    if stale {
        slots[idx] = build_font_texture(atlas);
    }
    slots[idx].as_ref()
}

// ---------------------------------------------------------------------------
// word decoding (spec.ts DRAWLIST packings)
// ---------------------------------------------------------------------------

#[inline]
fn xy(word: u32) -> (i16, i16) {
    ((word & 0xffff) as u16 as i16, (word >> 16) as u16 as i16)
}

#[inline]
fn wh(word: u32) -> (i32, i32) {
    ((word & 0xffff) as i32, (word >> 16) as i32)
}

// ---------------------------------------------------------------------------
// draws
// ---------------------------------------------------------------------------

/// Max vertices per sceGuDrawArray call: the GE PRIM command packs the count
/// into its low 16 bits (rust-psp sends `(prim << 16) | count` unmasked), so
/// counts >= 0x10000 would corrupt the primitive field. 65532 is divisible by
/// both 2 and 3, preserving Sprites-pair and Triangles-triple granularity.
const MAX_PRIM_VERTS: i32 = 65532;

/// dcache-writeback a batch, then enqueue its draw — chunked so no single
/// PRIM exceeds the 16-bit vertex-count field (dense glyph runs can).
#[inline]
unsafe fn flush(prim: GuPrimitive, vtype: VertexType, count: i32, verts: *const c_void, bytes: usize) {
    if count <= 0 {
        return;
    }
    sys::sceKernelDcacheWritebackRange(verts, bytes as u32);
    let stride = bytes / count as usize;
    let mut done: i32 = 0;
    while done < count {
        let n = (count - done).min(MAX_PRIM_VERTS);
        sys::sceGuDrawArray(
            prim,
            vtype,
            n,
            null(),
            (verts as *const u8).add(done as usize * stride) as *const c_void,
        );
        done += n;
    }
}

/// dcache-writeback one texture's pixel plane AND its CLUT (PSM_T8): the GE
/// samples RAM, not the dcache — call ONCE per upload (pak::feed and the JS
/// upload ops in ffi.rs).
pub fn writeback_texture(ui: &Ui, handle: i32) {
    let Some(view) = ui.texture(handle) else { return };
    unsafe {
        sys::sceKernelDcacheWritebackRange(
            view.pixels.as_ptr() as *const c_void,
            view.pixels.len() as u32,
        );
        if let Some(pal) = view.palette {
            sys::sceKernelDcacheWritebackRange(pal.as_ptr() as *const c_void, pal.len() as u32);
        }
    }
}

/// Program the sampler for one core texture (pixels + CLUT were dcache-
/// written-back at upload). tbw = width (pow2 >= 8 from the compiler's
/// pow2<=512 check).
unsafe fn apply_texture(view: &TexView) {
    sys::sceGuEnable(GuState::Texture2D);
    match view.psm {
        spec::psm::PSM_T8 => {
            // CLUT8: upload the 256 x u32 ABGR palette (32 blocks of 8
            // entries), then sample the 8-bit index plane. The core
            // guarantees palette is Some exactly when psm == PSM_T8.
            if let Some(pal) = view.palette {
                sys::sceGuClutMode(ClutPixelFormat::Psm8888, 0, 0xff, 0);
                sys::sceGuClutLoad(32, pal.as_ptr() as *const c_void);
            }
            sys::sceGuTexMode(TexturePixelFormat::PsmT8, 0, 0, 0);
        }
        spec::psm::PSM_4444 => sys::sceGuTexMode(TexturePixelFormat::Psm4444, 0, 0, 0),
        _ => sys::sceGuTexMode(TexturePixelFormat::Psm8888, 0, 0, 0),
    }
    sys::sceGuTexImage(
        MipmapLevel::None,
        view.w as i32,
        view.h as i32,
        view.w as i32,
        view.pixels.as_ptr() as *const c_void,
    );
    // REAL-GE QUIRK: sceGuTexImage does NOT invalidate the hardware texture
    // cache. Binds that only change the buffer pointer (same size + format —
    // e.g. several small same-dimension icons drawn back to back) sample
    // stale cache lines on hardware and render blank/garbage; every emulator
    // backend refetches per bind and hides it. Flush on every bind — a few
    // binds per frame, negligible against the 8 KB cache refill.
    sys::sceGuTexFlush();
    sys::sceGuTexFunc(TextureEffect::Modulate, TextureColorComponent::Rgba);
    // NEAREST remains the golden-parity default: it matches the wasm software
    // rasterizer (core/src/raster.rs) that the byte-exact goldens are defined
    // against — keeping PSP consistent with the reference — AND it avoids
    // bilinear bleed across sprite-atlas cell edges, where adjacent texels
    // belong to a DIFFERENT animation frame. LINEAR is opt-in per texture
    // (spec::img::FLAG_LINEAR) for the deep-zoom tiles, which magnify one
    // texel far past 1:1 and want smoothing, not cell fidelity.
    if view.linear {
        sys::sceGuTexFilter(TextureFilter::Linear, TextureFilter::Linear);
    } else {
        sys::sceGuTexFilter(TextureFilter::Nearest, TextureFilter::Nearest);
    }
}

unsafe fn apply_font_texture(tex: &FontTexture) {
    sys::sceGuEnable(GuState::Texture2D);
    sys::sceGuTexMode(TexturePixelFormat::Psm4444, 0, 0, 0);
    sys::sceGuTexImage(
        MipmapLevel::None,
        tex.tex_w as i32,
        tex.tex_h as i32,
        tex.tex_w as i32,
        tex.pixels.as_ptr() as *const c_void,
    );
    // Same real-GE cache quirk as apply_texture: multiple font atlases with
    // equal dimensions would alias without a flush.
    sys::sceGuTexFlush();
    sys::sceGuTexFunc(TextureEffect::Modulate, TextureColorComponent::Rgba);
    // PSP production atlases are density 1, preserving the byte-exact NEAREST
    // path. If a higher-density atlas is loaded, the source coverage is
    // downsampled into its logical destination instead of selecting one sample.
    if tex.raster_density == 1 {
        sys::sceGuTexFilter(TextureFilter::Nearest, TextureFilter::Nearest);
    } else {
        sys::sceGuTexFilter(TextureFilter::Linear, TextureFilter::Linear);
    }
}

#[inline]
fn glyph_alpha(color: u32, coverage: u8) -> u8 {
    if coverage == 0 {
        return 0;
    }
    let base = (color >> 24) & 0xff;
    let alpha = (base * coverage as u32 + 127) / 255;
    // Quantize to 16 levels so antialiased text stays smooth enough while
    // keeping PSP sprite batches bounded.
    (((alpha + 8) / 17) * 17).min(255) as u8
}

#[inline]
fn with_alpha(color: u32, alpha: u8) -> u32 {
    (color & 0x00ff_ffff) | ((alpha as u32) << 24)
}

/// Count horizontal logical-pixel coverage runs in one glyph. Atlas v3 may
/// store multiple raster samples per logical pixel; `logical_coverage`
/// averages the full density×density block before alpha quantization.
fn count_glyph_runs(atlas: &Atlas, gid: u16, color: u32) -> usize {
    let mut runs = 0usize;
    for y in 0..atlas.cell_h {
        let mut cur = 0u8;
        for x in 0..atlas.cell_w {
            let a = glyph_alpha(color, atlas.logical_coverage(gid, x, y));
            if a != 0 && a != cur {
                runs += 1;
            }
            cur = a;
        }
    }
    runs
}

/// Render one frame's DrawList into the open display list.
pub unsafe fn render(ui: &Ui, words: &[u32]) {
    // Frame clear: uncovered framebuffer regions must not show stale VRAM.
    sys::sceGuClearColor(0xff00_0000);
    sys::sceGuClear(ClearBuffer::COLOR_BUFFER_BIT);
    render_over(ui, words);
}

/// Render the DrawList WITHOUT clearing — the overlay-pass variant for game
/// runtimes compositing the 2D UI over an already-drawn 3D frame (the sceGu
/// analogue of pocket-ui-wgpu's `LoadOp::Load` mode).
pub unsafe fn render_over(ui: &Ui, words: &[u32]) {
    // Pass state: alpha blending on for everything (opacity, coverage text
    // cells with alpha colors, texture alpha).
    sys::sceGuEnable(GuState::Blend);
    sys::sceGuBlendFunc(BlendOp::Add, BlendFactor::SrcAlpha, BlendFactor::OneMinusSrcAlpha, 0, 0);
    sys::sceGuDisable(GuState::Texture2D);

    // Scissor stack: the core emits rects already intersected with every
    // enclosing scissor, so SET on push and restore the previous on pop.
    let mut scissors: Vec<(i32, i32, i32, i32)> = Vec::new();

    let n = words.len();
    let mut i = 0usize;
    while i < n {
        match words[i] {
            // The `i + N <= n` guards make truncated tails fall through to the
            // default `break` arm instead of spinning forever with count = 0.
            spec::draw_op::RECT if i + 4 <= n => {
                // Batch consecutive RECTs into ONE sprite draw.
                let mut end = i;
                while end + 4 <= n && words[end] == spec::draw_op::RECT {
                    end += 4;
                }
                let count = (end - i) / 4;
                let bytes = count * 2 * core::mem::size_of::<VertC>();
                let verts = pool_alloc(bytes) as *mut VertC;
                for k in 0..count {
                    let o = i + k * 4;
                    let (x, y) = xy(words[o + 1]);
                    let (w, h) = wh(words[o + 2]);
                    let color = words[o + 3];
                    *verts.add(k * 2) = VertC { color, x, y, z: 0, _pad: 0 };
                    *verts.add(k * 2 + 1) = VertC {
                        color,
                        x: (x as i32 + w) as i16,
                        y: (y as i32 + h) as i16,
                        z: 0,
                        _pad: 0,
                    };
                }
                flush(GuPrimitive::Sprites, VTYPE_C, (count * 2) as i32, verts as *const c_void, bytes);
                i = end;
            }
            spec::draw_op::GRAD_RECT if i + 6 <= n => {
                let (x, y) = xy(words[i + 1]);
                let (w, h) = wh(words[i + 2]);
                let from = words[i + 3];
                let to = words[i + 4];
                let dir = words[i + 5];
                let (x0, y0, x1, y1) = (x, y, (x as i32 + w) as i16, (y as i32 + h) as i16);
                // Corner colors per GradDir (spec ENUMS.GradDir ordinals).
                let (tl, tr, bl, br) = match dir {
                    d if d == spec::GradDir::ToTop as u32 => (to, to, from, from),
                    d if d == spec::GradDir::ToLeft as u32 => (to, from, to, from),
                    d if d == spec::GradDir::ToRight as u32 => (from, to, from, to),
                    _ => (from, from, to, to), // ToBottom
                };
                let bytes = 4 * core::mem::size_of::<VertC>();
                let verts = pool_alloc(bytes) as *mut VertC;
                *verts.add(0) = VertC { color: tl, x: x0, y: y0, z: 0, _pad: 0 };
                *verts.add(1) = VertC { color: tr, x: x1, y: y0, z: 0, _pad: 0 };
                *verts.add(2) = VertC { color: bl, x: x0, y: y1, z: 0, _pad: 0 };
                *verts.add(3) = VertC { color: br, x: x1, y: y1, z: 0, _pad: 0 };
                flush(GuPrimitive::TriangleStrip, VTYPE_C, 4, verts as *const c_void, bytes);
                i += 6;
            }
            spec::draw_op::TRI if i + 7 <= n => {
                // Batch consecutive TRIs (7 words each) into ONE draw.
                let mut end = i;
                while end + 7 <= n && words[end] == spec::draw_op::TRI {
                    end += 7;
                }
                let count = (end - i) / 7;
                let bytes = count * 3 * core::mem::size_of::<VertC>();
                let verts = pool_alloc(bytes) as *mut VertC;
                for k in 0..count {
                    let o = i + k * 7;
                    for c in 0..3usize {
                        let (x, y) = xy(words[o + 1 + c]);
                        *verts.add(k * 3 + c) =
                            VertC { color: words[o + 4 + c], x, y, z: 0, _pad: 0 };
                    }
                }
                flush(GuPrimitive::Triangles, VTYPE_C, (count * 3) as i32, verts as *const c_void, bytes);
                i = end;
            }
            spec::draw_op::GLYPH_RUN if i + 3 <= n => {
                let w1 = words[i + 1];
                let slot = (w1 & 0xff) as u8;
                let count = (w1 >> 16) as usize;
                let color = words[i + 2];
                let body = i + 3;
                let next = body + count * 2;
                if next > n {
                    break; // truncated list — bail
                }
                if let Some(atlas) = ui.font_atlas(slot) {
                    if let Some(tex) = font_texture(atlas) {
                        apply_font_texture(tex);
                        let bytes = count * 2 * core::mem::size_of::<VertTC>();
                        let verts = pool_alloc(bytes) as *mut VertTC;
                        let mut vi = 0usize;
                        for g in 0..count {
                            let (gx, gy) = xy(words[body + g * 2]);
                            let gid = (words[body + g * 2 + 1] & 0xffff) as u16;
                            if gid >= atlas.glyph_count {
                                continue;
                            }
                            let sx = (gid as u32 % tex.cols) * tex.coverage_w;
                            let sy = (gid as u32 / tex.cols) * tex.coverage_h;
                            *verts.add(vi) = VertTC {
                                u: sx as i16,
                                v: sy as i16,
                                color,
                                x: gx,
                                y: gy,
                                z: 0,
                                _pad: 0,
                            };
                            *verts.add(vi + 1) = VertTC {
                                u: (sx + tex.coverage_w) as i16,
                                v: (sy + tex.coverage_h) as i16,
                                color,
                                x: (gx as i32 + tex.logical_w as i32) as i16,
                                y: (gy as i32 + tex.logical_h as i32) as i16,
                                z: 0,
                                _pad: 0,
                            };
                            vi += 2;
                        }
                        if vi > 0 {
                            flush(
                                GuPrimitive::Sprites,
                                VTYPE_TC,
                                vi as i32,
                                verts as *const c_void,
                                vi * core::mem::size_of::<VertTC>(),
                            );
                        }
                        sys::sceGuDisable(GuState::Texture2D);
                        i = next;
                        continue;
                    }
                    // Scan each glyph coverage cell into horizontal alpha
                    // runs, batched as sprite pairs in ONE draw.
                    let (cw, ch) = (atlas.cell_w as usize, atlas.cell_h as usize);
                    // Pass 1: exact vertex count for the bump alloc.
                    let mut rects = 0usize;
                    for g in 0..count {
                        let gid = (words[body + g * 2 + 1] & 0xffff) as u16;
                        if gid < atlas.glyph_count {
                            rects += count_glyph_runs(atlas, gid, color);
                        }
                    }
                    if rects > 0 {
                        let bytes = rects * 2 * core::mem::size_of::<VertC>();
                        let verts = pool_alloc(bytes) as *mut VertC;
                        let mut vi = 0usize;
                        // Pass 2: emit the runs.
                        for g in 0..count {
                            let (gx, gy) = xy(words[body + g * 2]);
                            let gid = (words[body + g * 2 + 1] & 0xffff) as u16;
                            if gid >= atlas.glyph_count {
                                continue;
                            }
                            for y in 0..ch {
                                let mut x = 0usize;
                                while x < cw {
                                    let a = glyph_alpha(
                                        color,
                                        atlas.logical_coverage(gid, x as u32, y as u32),
                                    );
                                    if a == 0 {
                                        x += 1;
                                        continue;
                                    }
                                    let start = x;
                                    while x < cw
                                        && glyph_alpha(
                                            color,
                                            atlas.logical_coverage(gid, x as u32, y as u32),
                                        ) == a
                                    {
                                        x += 1;
                                    }
                                    let rx = gx as i32 + start as i32;
                                    let ry = gy as i32 + y as i32;
                                    let run_color = with_alpha(color, a);
                                    *verts.add(vi) = VertC {
                                        color: run_color,
                                        x: rx as i16,
                                        y: ry as i16,
                                        z: 0,
                                        _pad: 0,
                                    };
                                    *verts.add(vi + 1) = VertC {
                                        color: run_color,
                                        x: (rx + (x - start) as i32) as i16,
                                        y: (ry + 1) as i16,
                                        z: 0,
                                        _pad: 0,
                                    };
                                    vi += 2;
                                }
                            }
                        }
                        flush(GuPrimitive::Sprites, VTYPE_C, vi as i32, verts as *const c_void, bytes);
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
                let color = words[i + 8];
                let _ = (x, y, w, u0, v0, u1, v1, color, h);
                // Batch every following TEX_QUAD with the SAME texture into
                // one Sprites draw (rounded-corner discs emit 4 in a row per
                // box; per-quad bind + texture-disable churn cost ~5 ms of GE
                // tail on real hardware).
                let mut end = i;
                while end + 9 <= n
                    && words[end] == spec::draw_op::TEX_QUAD
                    && words[end + 1] == handle as u32
                {
                    end += 9;
                }
                let count = (end - i) / 9;
                if let Some(view) = ui.texture(handle) {
                    apply_texture(&view);
                    let (tw, th) = (view.w, view.h);
                    // TRANSFORM_2D UVs are TEXELS (see module docs): scale the
                    // normalized DrawList UVs by the texture dimensions.
                    let bytes = count * 2 * core::mem::size_of::<VertTC>();
                    let verts = pool_alloc(bytes) as *mut VertTC;
                    for k in 0..count {
                        let o = i + k * 9;
                        let (qx, qy) = xy(words[o + 2]);
                        let (qw, qh) = wh(words[o + 3]);
                        let qu0 = f32::from_bits(words[o + 4]);
                        let qv0 = f32::from_bits(words[o + 5]);
                        let qu1 = f32::from_bits(words[o + 6]);
                        let qv1 = f32::from_bits(words[o + 7]);
                        let qcolor = words[o + 8];
                        *verts.add(k * 2) = VertTC {
                            u: (qu0 * tw as f32) as i16,
                            v: (qv0 * th as f32) as i16,
                            color: qcolor,
                            x: qx,
                            y: qy,
                            z: 0,
                            _pad: 0,
                        };
                        *verts.add(k * 2 + 1) = VertTC {
                            u: (qu1 * tw as f32) as i16,
                            v: (qv1 * th as f32) as i16,
                            color: qcolor,
                            x: (qx as i32 + qw) as i16,
                            y: (qy as i32 + qh) as i16,
                            z: 0,
                            _pad: 0,
                        };
                    }
                    flush(
                        GuPrimitive::Sprites,
                        VTYPE_TC,
                        (count * 2) as i32,
                        verts as *const c_void,
                        bytes,
                    );
                    sys::sceGuDisable(GuState::Texture2D);
                }
                i = end;
            }
            spec::draw_op::TEX_TRI if i + 12 <= n => {
                let handle = words[i + 1] as i32;
                let mut end = i;
                while end + 12 <= n
                    && words[end] == spec::draw_op::TEX_TRI
                    && words[end + 1] == handle as u32
                {
                    end += 12;
                }
                let count = (end - i) / 12;
                if let Some(view) = ui.texture(handle) {
                    apply_texture(&view);
                    let (tw, th) = (view.w, view.h);
                    let bytes = count * 3 * core::mem::size_of::<VertTC>();
                    let verts = pool_alloc(bytes) as *mut VertTC;
                    for t in 0..count {
                        let o = i + t * 12;
                        let modulate = words[o + 11];
                        for k in 0..3usize {
                            let (x, y) = xy(words[o + 2 + k * 3]);
                            let u = f32::from_bits(words[o + 3 + k * 3]);
                            let v = f32::from_bits(words[o + 4 + k * 3]);
                            *verts.add(t * 3 + k) = VertTC {
                                u: (u * tw as f32) as i16,
                                v: (v * th as f32) as i16,
                                color: modulate,
                                x,
                                y,
                                z: 0,
                                _pad: 0,
                            };
                        }
                    }
                    flush(
                        GuPrimitive::Triangles,
                        VTYPE_TC,
                        (count * 3) as i32,
                        verts as *const c_void,
                        bytes,
                    );
                    sys::sceGuDisable(GuState::Texture2D);
                }
                i = end;
            }
            spec::draw_op::SCISSOR if i + 3 <= n => {
                let (x, y) = xy(words[i + 1]);
                let (w, h) = wh(words[i + 2]);
                // rust-psp's wrapper names the last two parameters `w`/`h`,
                // but forwards them as the absolute scissor end coordinates.
                let x1 = x as i32 + w;
                let y1 = y as i32 + h;
                scissors.push((x as i32, y as i32, x1, y1));
                sys::sceGuScissor(x as i32, y as i32, x1, y1);
                i += 3;
            }
            spec::draw_op::SCISSOR_POP => {
                scissors.pop();
                match scissors.last() {
                    Some(&(x, y, w, h)) => sys::sceGuScissor(x, y, w, h),
                    None => sys::sceGuScissor(0, 0, SCREEN_WIDTH as i32, SCREEN_HEIGHT as i32),
                }
                i += 1;
            }
            spec::draw_op::SCENE_QUAD if i + 4 <= n => {
                // Host-composited 3D backdrop: ge3d renders the bound scene3d
                // scene into the rect (viewport+scissor scoped, depth-only
                // clear) and returns 2D-clean except viewport/scissor —
                // re-apply the scissor stack here.
                let (x, y) = xy(words[i + 1]);
                let (w, h) = wh(words[i + 2]);
                crate::ge3d::composite(words[i + 3] as i32, x as i32, y as i32, w, h);
                match scissors.last() {
                    Some(&(sx, sy, sx1, sy1)) => sys::sceGuScissor(sx, sy, sx1, sy1),
                    None => sys::sceGuScissor(0, 0, SCREEN_WIDTH as i32, SCREEN_HEIGHT as i32),
                }
                i += 4;
            }
            _ => break, // unknown/truncated op: stop rather than desync
        }
    }

    // Pass-boundary state reset (sticky GE state).
    sys::sceGuDisable(GuState::Blend);
    sys::sceGuDisable(GuState::Texture2D);
    sys::sceGuScissor(0, 0, SCREEN_WIDTH as i32, SCREEN_HEIGHT as i32);
}
