//! Tile streamer: keeps a ring of tiles resident around the car, loading at
//! most one tile per frame — from the memory stick via async sceIo when the
//! pack is a file, or by borrowing the embedded pack (with a simulated
//! latency so the load choreography stays visible and deterministic).
//!
//! Load order is nearest-ring-first with a bias toward tiles ahead of the
//! car, so driving into fresh blocks streams the skyline in before it
//! matters. Newly ready tiles ride a rise-from-the-ground animation
//! (`rise()`), which is what makes streaming legible on screen.

use alloc::vec::Vec;
use core::ffi::c_void;

use psp::sys::{self, IoWhence, SceUid};

use crate::pack::{self, AlignedBuf, PackInfo, TileDir};

/// Chebyshev tile radius kept resident (and loaded on demand).
pub const KEEP: i32 = 5;
/// Radius beyond which resident tiles are dropped (hysteresis vs KEEP).
pub const EVICT: i32 = 6;
/// Frames of the rise-from-ground animation.
pub const RISE_FRAMES: u32 = 30;
/// Simulated load latency for the embedded-pack source, in frames.
const EMBED_LATENCY: u32 = 5;

pub enum Source {
    Embedded(&'static [u8]),
    File(SceUid),
}

enum TileData {
    Owned(AlignedBuf),
    Borrowed(&'static [u8]),
}

impl TileData {
    fn bytes(&self) -> &[u8] {
        match self {
            TileData::Owned(b) => b.as_slice(),
            TileData::Borrowed(s) => s,
        }
    }
}

enum TileState {
    Vacant,
    Loading,
    Ready { data: TileData, born: u32 },
}

struct InFlight {
    idx: usize,
    buf: AlignedBuf,
}

pub struct Streamer {
    pub info: PackInfo,
    meta: &'static [u8],
    source: Source,
    states: Vec<TileState>,
    inflight: Option<InFlight>,
    embed_pending: Option<(usize, u32)>,
    pub loads: u32,
    pub resident: u32,
}

impl Streamer {
    pub fn new(info: PackInfo, meta: &'static [u8], source: Source) -> Self {
        let mut states = Vec::new();
        states.resize_with(info.nx * info.nz, || TileState::Vacant);
        Self {
            info,
            meta,
            source,
            states,
            inflight: None,
            embed_pending: None,
            loads: 0,
            resident: 0,
        }
    }

    pub fn dir(&self, idx: usize) -> TileDir {
        pack::tile_dir(self.meta, &self.info, idx)
    }

    pub fn route_len(&self) -> usize {
        self.info.route_count
    }

    pub fn route(&self, i: usize) -> pack::RoutePt {
        pack::route_pt(self.meta, &self.info, i)
    }

    /// Tile grid coordinates for a world position.
    pub fn tile_of(&self, x: f32, z: f32) -> (i32, i32) {
        (
            libm::floorf((x - self.info.origin_x) / self.info.tile_size) as i32,
            libm::floorf((z - self.info.origin_z) / self.info.tile_size) as i32,
        )
    }

    /// Geometry views for a ready tile, plus its rise factor (0..1).
    pub fn ready(&self, idx: usize, frame: u32) -> Option<(&[u8], &[u8], &[u8], f32)> {
        match &self.states[idx] {
            TileState::Ready { data, born } => {
                let d = self.dir(idx);
                let (v, i, l) = pack::tile_views(&d, data.bytes());
                Some((v, i, l, rise(*born, frame)))
            }
            _ => None,
        }
    }

    /// One streaming step: poll the async read, kick the next best load,
    /// evict far tiles. Call once per frame, before recording the display
    /// list (the previous list is synced by then, so drops are GE-safe).
    pub fn update(&mut self, car_x: f32, car_z: f32, ahead_x: f32, ahead_z: f32, frame: u32) {
        self.poll(frame);

        let (ctx, ctz) = self.tile_of(car_x, car_z);

        // Evict outside the hysteresis ring.
        for tz in 0..self.info.nz as i32 {
            for tx in 0..self.info.nx as i32 {
                let ring = (tx - ctx).abs().max((tz - ctz).abs());
                if ring <= EVICT {
                    continue;
                }
                let idx = (tz * self.info.nx as i32 + tx) as usize;
                if matches!(self.states[idx], TileState::Ready { .. }) {
                    self.states[idx] = TileState::Vacant;
                    self.resident -= 1;
                }
            }
        }

        // One load in flight at a time.
        if self.inflight.is_some() || self.embed_pending.is_some() {
            return;
        }

        // Best vacant tile in the KEEP ring: nearest first, ahead of the
        // car breaking ties (ahead_* is a unit heading vector).
        let mut best: Option<(f32, usize)> = None;
        for dz in -KEEP..=KEEP {
            for dx in -KEEP..=KEEP {
                let (tx, tz) = (ctx + dx, ctz + dz);
                if tx < 0 || tz < 0 || tx >= self.info.nx as i32 || tz >= self.info.nz as i32 {
                    continue;
                }
                let idx = (tz * self.info.nx as i32 + tx) as usize;
                if !matches!(self.states[idx], TileState::Vacant) {
                    continue;
                }
                let d = self.dir(idx);
                if d.off == 0 {
                    continue; // empty tile: nothing to load
                }
                let cx = self.info.origin_x + (tx as f32 + 0.5) * self.info.tile_size;
                let cz = self.info.origin_z + (tz as f32 + 0.5) * self.info.tile_size;
                let rx = cx - car_x;
                let rz = cz - car_z;
                let dist = libm::sqrtf(rx * rx + rz * rz);
                let behind = if rx * ahead_x + rz * ahead_z < 0.0 { 1.35 } else { 1.0 };
                let score = dist * behind;
                if best.map_or(true, |(s, _)| score < s) {
                    best = Some((score, idx));
                }
            }
        }
        let Some((_, idx)) = best else { return };
        self.kick(idx);
    }

    fn kick(&mut self, idx: usize) {
        let d = self.dir(idx);
        match &self.source {
            Source::Embedded(_) => {
                self.states[idx] = TileState::Loading;
                self.embed_pending = Some((idx, EMBED_LATENCY));
            }
            Source::File(fd) => {
                let len = pack::tile_len(&d);
                let mut buf = AlignedBuf::new(len);
                unsafe {
                    sys::sceIoLseek32(*fd, d.off as i32, IoWhence::Set);
                    sys::sceIoReadAsync(*fd, buf.as_mut_ptr() as *mut c_void, len as u32);
                }
                self.states[idx] = TileState::Loading;
                self.inflight = Some(InFlight { idx, buf });
            }
        }
    }

    fn poll(&mut self, frame: u32) {
        if let Some((idx, ticks)) = self.embed_pending {
            if ticks > 0 {
                self.embed_pending = Some((idx, ticks - 1));
            } else {
                let Source::Embedded(pack_bytes) = self.source else {
                    unreachable!()
                };
                let d = self.dir(idx);
                let data = &pack_bytes[d.off..d.off + pack::tile_len(&d)];
                self.states[idx] = TileState::Ready {
                    data: TileData::Borrowed(data),
                    born: frame,
                };
                self.embed_pending = None;
                self.loads += 1;
                self.resident += 1;
            }
            return;
        }
        if self.inflight.is_none() {
            return;
        }
        let Source::File(fd) = self.source else { return };
        let mut res: i64 = 0;
        let rc = unsafe { sys::sceIoPollAsync(fd, &mut res) };
        if rc == 1 {
            return; // still busy
        }
        let fl = self.inflight.take().unwrap();
        let d = self.dir(fl.idx);
        if rc < 0 || (res as usize) < pack::tile_len(&d) {
            // Read failed: leave the tile vacant; it will be retried.
            self.states[fl.idx] = TileState::Vacant;
            return;
        }
        unsafe { pocket3d_gu::writeback(fl.buf.as_slice()) };
        self.states[fl.idx] = TileState::Ready {
            data: TileData::Owned(fl.buf),
            born: frame,
        };
        self.loads += 1;
        self.resident += 1;
    }
}

/// Rise-from-the-ground factor: 0 at birth, easing out to 1.
pub fn rise(born: u32, frame: u32) -> f32 {
    let t = frame.saturating_sub(born) as f32 / RISE_FRAMES as f32;
    if t >= 1.0 {
        return 1.0;
    }
    let inv = 1.0 - t;
    1.0 - inv * inv * inv
}
