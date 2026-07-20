//! pocket-playset — the playset sim cores, native.
//!
//! WHY THIS CRATE EXISTS (measured, not assumed): on a real PSP, QuickJS runs
//! at roughly 1.7µs per interpreter op (333 MHz MIPS, soft-float f64), so a
//! 60 Hz frame affords ~8k ops. The rally composition — collision resolve,
//! two arcade cars, road-terrain sampling, waypoint AI, race state, chase
//! camera, ~20 visual pose writes — costs ~160k ops per step in TS. Twenty
//! times over budget is not a tuning problem; it is the interpreter. The same
//! work in native f32 is a few hundred microseconds.
//!
//! WHAT IT IS: the hot GameBlocks blocks, ported from the TS modules under
//! `playset/modules/` with the same semantics, plus one composite `step` that
//! runs a whole driving-game turn without crossing the guest boundary. The
//! sim owns scene3d node handles and writes poses STRAIGHT INTO the shared
//! [`pocket_scene3d::Store`] — the 550-node pose batch never becomes JS.
//!
//! WHAT IT IS NOT: a replacement for the TS modules. Those stay the reference
//! implementation and the graceful-absence path (a host without `ps` runs the
//! TS composition, exactly like a host without `s3` runs pure-mirror). The
//! guest picks at boot; the deterministic goldens keep running against TS.
//!
//! PRECISION CONTRACT: everything here is f32 (see [`math`]) while the TS
//! reference is f64, so the two paths are trajectory-equivalent, NOT
//! bit-equivalent. Parity is asserted as bounded divergence over a scripted
//! input tape (tests/parity.rs), not as byte equality.
//!
//! Feature layout mirrors pocket-scene3d: `std` (default) adds the rquickjs
//! guest mount for the desktop host; with default features off the crate is
//! no_std + alloc and the PSP host mounts it through the QuickJS C API.

#![cfg_attr(not(feature = "std"), no_std)]
#![allow(static_mut_refs)]

extern crate alloc;

pub mod behavior;
pub mod collision;
pub mod math;
pub mod resolver;
pub mod terrain;
pub mod vehicle;
pub mod world;

#[cfg(feature = "std")]
pub mod mount;

use alloc::vec::Vec;

pub use world::{World, HUD_FLOATS};

/// Collider kinds in the batched `collidersAdd` payload.
pub mod collider_kind {
    pub const CUBOID: u32 = 0;
    pub const CYLINDER: u32 = 1;
    pub const BALL: u32 = 2;
}

/// Per-collider float stride in the batched `collidersAdd` payload:
/// `[x, y, z, a, b, c, yaw, flags]` where (a, b, c) is halfExtents for a
/// cuboid, (radius, halfHeight, _) for a cylinder, (radius, _, _) for a ball,
/// and `flags` is bit 0 = solid, bit 1 = walkable.
pub const COLLIDER_STRIDE: usize = 8;
pub const COLLIDER_FLAG_SOLID: u32 = 1;
pub const COLLIDER_FLAG_WALKABLE: u32 = 2;

/// Worlds are handle-addressed exactly like scene3d scenes: ids start at 1,
/// are never reused, and unknown ids are silently inert (ops are intent, not
/// calls — a stale handle must never panic a guest).
pub struct Sim {
    worlds: Vec<Option<World>>,
}

impl Default for Sim {
    fn default() -> Self {
        Self::new()
    }
}

impl Sim {
    pub fn new() -> Self {
        Self { worlds: Vec::new() }
    }

    pub fn world_create(&mut self, scene: i32) -> i32 {
        self.worlds.push(Some(World::new(scene)));
        self.worlds.len() as i32
    }

    pub fn world_destroy(&mut self, id: i32) {
        if let Some(slot) = self.slot(id) {
            self.worlds[slot] = None;
        }
    }

    pub fn world(&mut self, id: i32) -> Option<&mut World> {
        let slot = self.slot(id)?;
        self.worlds[slot].as_mut()
    }

    fn slot(&self, id: i32) -> Option<usize> {
        if id <= 0 || id as usize > self.worlds.len() {
            return None;
        }
        Some(id as usize - 1)
    }
}
