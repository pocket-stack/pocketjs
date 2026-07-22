//! pocket-playset — the playset sim cores, native.
//!
//! WHY THIS CRATE EXISTS (measured, not assumed): on a real PSP, QuickJS runs
//! at roughly 1.7µs per interpreter op (333 MHz MIPS, soft-float f64), so a
//! 60 Hz frame affords ~8k ops. A GameBlocks composition — collision resolve,
//! motion, terrain sampling, AI search, referee, camera, dozens of visual pose
//! writes — costs 100k+ ops per step in TS. Twenty times over budget is not a
//! tuning problem; it is the interpreter. The same work in native Rust is a
//! few hundred microseconds. Measured on hardware: rally's step went 268ms to
//! 1.7ms; snake's AI grid tick went from a ~750ms spike to microseconds.
//!
//! WHAT IT IS: the hot GameBlocks blocks, ported from the TS modules under
//! `playset/modules/` with the same semantics, plus one composite `step` per
//! game that runs a whole turn without crossing the guest boundary. A sim owns
//! scene3d node handles and writes poses STRAIGHT INTO the shared
//! [`pocket_scene3d::Store`] — the pose batch never becomes JS.
//!
//! WHAT IT IS NOT: a replacement for the TS modules. Those stay the reference
//! implementation and the graceful-absence path (a host without `ps` runs the
//! TS composition, exactly like a host without `s3` runs pure-mirror). The
//! guest picks at boot; the deterministic goldens keep running against TS.
//!
//! HOW IT SCALES: [`GameWorld`] is an enum over game kinds, and `step` /
//! `read_hud` / destroy are generic over it. Adding a game is a new variant
//! plus a module here plus a handful of assembly ops in the mounts — the
//! framework (the store, batching, freeze, pose writing, the registry, the
//! dual-path pattern) is shared, and only the irreducibly game-specific sim
//! logic is new. Assembly ops ARE per-game because assembly is per-game (a
//! car and a snake grid share no vocabulary); everything after boot is not.
//!
//! PRECISION: the driving cores are f32, trajectory-equivalent to the f64 TS
//! reference (parity is bounded divergence). The grid cores (snake) are
//! integer logic and can be exact; only their seeded item spawn and their
//! cosmetic idle animation touch floats.
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
pub mod snake;
pub mod terrain;
pub mod vehicle;
pub mod world;

#[cfg(feature = "std")]
pub mod mount;

use alloc::vec::Vec;
use pocket_scene3d::Store;

pub use world::HUD_FLOATS;

/// spec BTN bits (core/src/spec.rs). Mirrored here so a `GameWorld` can decode
/// its own controls without pocket-playset depending on pocketjs-core; the
/// values are a stable part of the wire contract.
pub mod btn {
    pub const SELECT: u32 = 0x0001;
    pub const START: u32 = 0x0008;
    pub const UP: u32 = 0x0010;
    pub const RIGHT: u32 = 0x0020;
    pub const DOWN: u32 = 0x0040;
    pub const LEFT: u32 = 0x0080;
    pub const TRIANGLE: u32 = 0x1000;
    pub const CIRCLE: u32 = 0x2000;
    pub const CROSS: u32 = 0x4000;
    pub const SQUARE: u32 = 0x8000;
}

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

/// One assembled game, whichever kind. The registry holds these; `step` and
/// `read_hud` dispatch on the variant. Game-specific assembly reaches the
/// inner world through the typed accessors on [`Sim`].
pub enum GameWorld {
    Rally(world::World),
    Snake(snake::World),
}

impl GameWorld {
    /// One fixed simulation step; poses (and, for rally, the camera) land in
    /// `store`. Each variant decodes the raw button mask itself — a car reads
    /// steer/throttle/reverse, a snake reads the d-pad and restart.
    pub fn step(&mut self, store: &mut Store, dt: f32, buttons: u32) {
        match self {
            GameWorld::Rally(w) => {
                w.set_buttons(
                    buttons & btn::LEFT != 0,
                    buttons & btn::RIGHT != 0,
                    buttons & btn::CROSS != 0,
                    buttons & btn::SQUARE != 0,
                );
                w.step(store, dt);
            }
            GameWorld::Snake(w) => w.step(store, dt, buttons),
        }
    }

    /// Fill the guest's HUD mirror, as many floats as the game defines and the
    /// buffer holds. The guest allocates the count its own game uses.
    pub fn read_hud(&self, out: &mut [f32]) {
        match self {
            GameWorld::Rally(w) => w.read_hud(out),
            GameWorld::Snake(w) => w.read_hud(out),
        }
    }
}

/// Worlds are handle-addressed exactly like scene3d scenes: ids start at 1,
/// are never reused, and unknown ids are silently inert (ops are intent, not
/// calls — a stale handle must never panic a guest).
pub struct Sim {
    worlds: Vec<Option<GameWorld>>,
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

    /// Create a driving world (rally). Kept named `world_create` — the op it
    /// backs is rally's committed `ps.worldCreate`.
    pub fn world_create(&mut self, scene: i32) -> i32 {
        self.push(GameWorld::Rally(world::World::new(scene)))
    }

    pub fn snake_create(&mut self, scene: i32) -> i32 {
        self.push(GameWorld::Snake(snake::World::new(scene)))
    }

    fn push(&mut self, world: GameWorld) -> i32 {
        self.worlds.push(Some(world));
        self.worlds.len() as i32
    }

    pub fn destroy(&mut self, id: i32) {
        if let Some(slot) = self.slot(id) {
            self.worlds[slot] = None;
        }
    }

    /// The rally world at `id`, if that handle is a rally world.
    pub fn rally(&mut self, id: i32) -> Option<&mut world::World> {
        match self.get(id)? {
            GameWorld::Rally(w) => Some(w),
            _ => None,
        }
    }

    /// The snake world at `id`, if that handle is a snake world.
    pub fn snake(&mut self, id: i32) -> Option<&mut snake::World> {
        match self.get(id)? {
            GameWorld::Snake(w) => Some(w),
            _ => None,
        }
    }

    pub fn step(&mut self, id: i32, store: &mut Store, dt: f32, buttons: u32) {
        if let Some(w) = self.get(id) {
            w.step(store, dt, buttons);
        }
    }

    pub fn read_hud(&mut self, id: i32, out: &mut [f32]) {
        if let Some(w) = self.get(id) {
            w.read_hud(out);
        }
    }

    fn get(&mut self, id: i32) -> Option<&mut GameWorld> {
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
