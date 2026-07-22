//! Snake: the grid-snake arena duel (player vs one AI rival), native.
//!
//! Ported from the TS composition in demos/snake/game.ts and the modules it
//! builds on (snake-motion-controller, snake-play, grid-path-planner). Same
//! semantics — grid dimensions, tick cadence, growth/score rules, the rival's
//! flood-fill + A* scoring, item spawn order.
//!
//! WHY NATIVE (measured, real PSP): the rival decides once per grid tick by
//! running, for each of three candidate directions, a flood fill and two A*
//! searches over the 16×16 board — in TS, with string-keyed Sets, that tick
//! frame spiked to ~750ms. The board is integers; in Rust the search is a BFS
//! over a 256-cell array and costs microseconds.
//!
//! EXACT, NOT APPROXIMATE. Unlike the driving cores this is integer logic, so
//! it matches the TS reference exactly — the only floats are the seeded item
//! spawn (a free-cell pick) and the cosmetic idle bob, neither of which the
//! game state branches on. The parity test asserts equality, not a bound.
//!
//! This file is currently a CONTRACT STUB: the public API the enum
//! ([`crate::GameWorld`]) and the mounts call, with inert bodies, so the crate
//! compiles while the sim logic is filled in.

use alloc::vec::Vec;
use glam::Vec3;
use pocket_scene3d::Store;

/// HUD mirror floats: `[status, score, rivalScore, bestScore, playerLength]`.
/// status: 0 = running, 1 = gameover.
pub const HUD_FLOATS: usize = 5;

/// Which snake a bind/config op addresses.
pub const ROLE_PLAYER: i32 = 0;
pub const ROLE_RIVAL: i32 = 1;

pub struct World {
    scene: i32,
    _config: Config,
}

#[derive(Clone, Copy, Default)]
struct Config {
    columns: i32,
    rows: i32,
    cell_size: f32,
    origin: Vec3,
    base_tick_ms: f32,
    min_tick_ms: f32,
    speedup_ms_per_point: f32,
    initial_length: i32,
    max_segments: i32,
    prng_seed: u32,
}

impl World {
    pub fn new(scene: i32) -> Self {
        Self {
            scene,
            _config: Config::default(),
        }
    }

    /// Board + cadence + spawn config, from the demo's constants.
    /// `origin` and `cell_size` reproduce `board.cellToWorldPoint`:
    /// `world(cell, up) = origin + vec3(right*cell_size, up, -forward*cell_size)`.
    #[allow(clippy::too_many_arguments)]
    pub fn configure(
        &mut self,
        columns: i32,
        rows: i32,
        cell_size: f32,
        origin: Vec3,
        base_tick_ms: f32,
        min_tick_ms: f32,
        speedup_ms_per_point: f32,
        initial_length: i32,
        max_segments: i32,
        prng_seed: u32,
    ) {
        self._config = Config {
            columns,
            rows,
            cell_size,
            origin,
            base_tick_ms,
            min_tick_ms,
            speedup_ms_per_point,
            initial_length,
            max_segments,
            prng_seed,
        };
    }

    /// Add a snake at a start cell heading a cardinal direction. `is_rival`
    /// gives it the AI brain; the other snake takes the button mask.
    pub fn add_snake(
        &mut self,
        _start_right: i32,
        _start_forward: i32,
        _dir_right: i32,
        _dir_forward: i32,
        _is_rival: bool,
    ) -> usize {
        0
    }

    /// The rival's scoring weights (space, apple distance, tail reach, straight
    /// bias), from RIVAL_WEIGHTS.
    pub fn set_brain(&mut self, _snake: usize, _space: f32, _apple_dist: f32, _tail: f32, _straight: f32) {}

    /// Hand over a snake's pooled segment nodes (head at index 0). The sim
    /// toggles their visibility and writes their poses.
    pub fn bind_snake_visual(&mut self, _snake: usize, _node_ids: &[i32]) {}

    /// Hand over the apple node (shown/hidden and posed by the sim).
    pub fn bind_apple_visual(&mut self, _node_id: i32) {}

    pub fn step(&mut self, _store: &mut Store, _dt: f32, _buttons: u32) {
        let _ = self.scene;
    }

    pub fn read_hud(&self, out: &mut [f32]) {
        for v in out.iter_mut().take(HUD_FLOATS) {
            *v = 0.0;
        }
    }
}

// The real sim lands here; the assembly config a mount ships is one flat float
// block (`snakeConfig`) plus per-snake `snakeAddSnake` / `snakeBindVisual`.
#[allow(dead_code)]
fn _keep_vec_in_scope(_: Vec<i32>) {}
