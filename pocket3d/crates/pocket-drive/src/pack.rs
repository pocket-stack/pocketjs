//! `.pdrv` city pack: header + tile directory + route, then per-tile
//! payloads of GE-ready geometry. All offsets 16-aligned, little-endian
//! (cooked by `cooker/cook.ts`; this reader and that writer must agree).
//!
//! Tile payload layout: `[tri verts][pad16][u16 indices][pad16][line verts]`.
//! Vertex = `{color: u32 ABGR, x,y,z: i16, pad: u16}` (12 B), tile-local,
//! riding the GE's 16-bit ÷32768 normalization (undone in the model matrix).

use alloc::alloc::{alloc, dealloc, Layout};
use core::slice;

pub const VERT_SIZE: usize = 12;
pub const DIR_ENTRY: usize = 32;
pub const ROUTE_ENTRY: usize = 16;
pub const HEADER: usize = 48;

#[derive(Clone, Copy, Debug)]
pub struct PackInfo {
    pub tile_size: f32,
    pub origin_x: f32,
    pub origin_z: f32,
    pub nx: usize,
    pub nz: usize,
    pub dir_off: usize,
    pub route_off: usize,
    pub route_count: usize,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct TileDir {
    pub off: usize,
    pub vcount: usize,
    pub icount: usize,
    pub lcount: usize,
    pub min: [i16; 3],
    pub max: [i16; 3],
}

#[derive(Clone, Copy, Debug)]
pub struct RoutePt {
    pub x: f32,
    pub z: f32,
    pub s: f32,
    pub speed: f32,
}

fn u32le(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
fn f32le(b: &[u8], o: usize) -> f32 {
    f32::from_bits(u32le(b, o))
}
fn i16le(b: &[u8], o: usize) -> i16 {
    i16::from_le_bytes([b[o], b[o + 1]])
}

pub fn parse_header(b: &[u8]) -> Result<PackInfo, &'static str> {
    if b.len() < HEADER || &b[0..4] != b"PDRV" {
        return Err("bad pack magic");
    }
    if u32le(b, 4) != 1 {
        return Err("bad pack version");
    }
    Ok(PackInfo {
        tile_size: f32le(b, 12),
        origin_x: f32le(b, 16),
        origin_z: f32le(b, 20),
        nx: u32le(b, 24) as usize,
        nz: u32le(b, 28) as usize,
        dir_off: u32le(b, 32) as usize,
        route_off: u32le(b, 36) as usize,
        route_count: u32le(b, 40) as usize,
    })
}

/// Meta prefix length (header + directory + route) — what a file source
/// must read up front.
pub fn meta_len(info: &PackInfo) -> usize {
    info.route_off + info.route_count * ROUTE_ENTRY
}

pub fn tile_dir(meta: &[u8], info: &PackInfo, idx: usize) -> TileDir {
    let o = info.dir_off + idx * DIR_ENTRY;
    TileDir {
        off: u32le(meta, o) as usize,
        vcount: u32le(meta, o + 4) as usize,
        icount: u32le(meta, o + 8) as usize,
        lcount: u32le(meta, o + 12) as usize,
        min: [i16le(meta, o + 16), i16le(meta, o + 18), i16le(meta, o + 20)],
        max: [i16le(meta, o + 22), i16le(meta, o + 24), i16le(meta, o + 26)],
    }
}

pub fn route_pt(meta: &[u8], info: &PackInfo, idx: usize) -> RoutePt {
    let o = info.route_off + idx * ROUTE_ENTRY;
    RoutePt {
        x: f32le(meta, o),
        z: f32le(meta, o + 4),
        s: f32le(meta, o + 8),
        speed: f32le(meta, o + 12),
    }
}

const fn align16(n: usize) -> usize {
    (n + 15) & !15
}

/// Byte length of one tile's payload.
pub fn tile_len(d: &TileDir) -> usize {
    align16(d.vcount * VERT_SIZE) + align16(d.icount * 2) + align16(d.lcount * VERT_SIZE)
}

/// Views into a loaded tile payload: (tri verts, indices, line verts).
pub fn tile_views<'a>(d: &TileDir, data: &'a [u8]) -> (&'a [u8], &'a [u8], &'a [u8]) {
    let v_end = d.vcount * VERT_SIZE;
    let i_off = align16(v_end);
    let i_end = i_off + d.icount * 2;
    let l_off = align16(i_end);
    let l_end = l_off + d.lcount * VERT_SIZE;
    (&data[0..v_end], &data[i_off..i_end], &data[l_off..l_end])
}

/// 16-aligned heap buffer the GE can read in place (after writeback).
pub struct AlignedBuf {
    ptr: *mut u8,
    len: usize,
}

impl AlignedBuf {
    pub fn new(len: usize) -> Self {
        let layout = Layout::from_size_align(len.max(16), 16).unwrap();
        let ptr = unsafe { alloc(layout) };
        assert!(!ptr.is_null(), "pack buffer alloc failed");
        Self { ptr, len }
    }
    pub fn as_slice(&self) -> &[u8] {
        unsafe { slice::from_raw_parts(self.ptr, self.len) }
    }
    pub fn as_mut_ptr(&mut self) -> *mut u8 {
        self.ptr
    }
}

impl Drop for AlignedBuf {
    fn drop(&mut self) {
        let layout = Layout::from_size_align(self.len.max(16), 16).unwrap();
        unsafe { dealloc(self.ptr, layout) };
    }
}

// The GE never writes; single-threaded EBOOT.
unsafe impl Send for AlignedBuf {}
