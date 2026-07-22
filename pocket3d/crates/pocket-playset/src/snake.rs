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
//! frame spiked to ~750ms and the demo averaged 45ms/frame (a slideshow). The
//! board is integers; here the search is a BFS over a 256-cell array reusing
//! World-held scratch (no per-search heap allocation, no string keys) and
//! costs microseconds.
//!
//! EXACT, NOT APPROXIMATE. Unlike the driving cores this is integer logic, so
//! it matches the TS reference cell-for-cell, tick-for-tick. The only floats
//! are the seeded item spawn (a free-cell pick) and the cosmetic idle bob,
//! neither of which the game state branches on. The parity test asserts
//! equality against a golden captured from demos/snake/game.ts itself
//! (playset/test/gen-snake-parity.ts), not a bound.
//!
//! TWO PLACES STATE COULD DIVERGE, AND WHY NEITHER DOES:
//!
//!  1. THE APPLE PICK. TS does `freeCells[Math.floor(prng.random() * n)]`,
//!     where `prng.random()` is Mulberry32 (seed 1337) as an f64 in [0,1). We
//!     evolve the u32 state with bit-identical wrapping arithmetic (`Math.imul`
//!     is `wrapping_mul`; `x >>> k` is a logical u32 shift; the `t + imul(...)`
//!     sum wraps `ToInt32`, which is two's-complement `wrapping_add` on the
//!     same bit patterns). For the index we do NOT touch a float: with `r` the
//!     raw u32 numerator (`random() == r / 2^32`), the exact real value
//!     `random() * n` is `r*n / 2^32`, and `r*n < 2^40` is representable in f64
//!     to the bit, so `Math.floor(random()*n) == (r*n) >> 32` in integer math.
//!     `pick_index` computes exactly that — provably the same cell TS picks,
//!     with no f32/f64 rounding in the loop. (`prng_exact` cross-checks it.)
//!
//!  2. THE RIVAL'S SCORE ARGMAX. Scored in f32 here, f64 in TS. But every score
//!     is `flood*2 - (dist*3 | 256) + {0,3.5} + {0,0.5}` — a multiple of 0.5
//!     with |value| < 2^13, which is bit-exact in BOTH f32 and f64. So the
//!     argmax (strict `>`, first-wins in up/right/down/left order) is identical.
//!
//! The free-cell enumeration order (forward outer, right inner) and the
//! blocking/collision/referee orders are ported verbatim; get those and the
//! two floats above right, and the whole game is exact.

use alloc::vec::Vec;
use core::f32::consts::PI;
use glam::{Quat, Vec3};
use pocket_scene3d::Store;

use crate::btn;
use crate::math::{self, fmath};

/// HUD mirror floats: `[status, score, rivalScore, bestScore, playerLength]`.
/// status: 0 = running, 1 = gameover.
pub const HUD_FLOATS: usize = 5;

/// Which snake a bind/config op addresses.
pub const ROLE_PLAYER: i32 = 0;
pub const ROLE_RIVAL: i32 = 1;

/// scene3d pose stride: `[id, px, py, pz, qx, qy, qz, qw, sx, sy, sz]`.
const POSE_STRIDE: usize = 11;

/// Virtual ms per fixed step — the idle-animation clock (`nowMs` in game.ts).
const STEP_MS: f32 = 1000.0 / 60.0;

/// Cardinal direction vectors, indexed like game.ts DIRECTION_NAMES /
/// snake-motion-controller CARDINAL_DIRECTIONS: 0 up, 1 right, 2 down, 3 left.
const DIR_UP: usize = 0;
const DIR_RIGHT: usize = 1;
const DIR_DOWN: usize = 2;
const DIR_LEFT: usize = 3;
const DIR_VEC: [Cell; 4] = [
    Cell { right: 0, forward: 1 },  // up
    Cell { right: 1, forward: 0 },  // right
    Cell { right: 0, forward: -1 }, // down
    Cell { right: -1, forward: 0 }, // left
];

/// Head yaw per travel direction (game.ts HEAD_YAW): basis forward is −z, eyes
/// at +z. Indexed 0 up, 1 right, 2 down, 3 left.
const HEAD_YAW: [f32; 4] = [PI, -PI * 0.5, 0.0, PI * 0.5];

/// A grid coordinate on the right/forward board.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
struct Cell {
    right: i32,
    forward: i32,
}

/// One apple (item) on the board — the reference keeps at most one at a time.
#[derive(Clone, Copy)]
struct Apple {
    cell: Cell,
    growth: i32,
}

/// Why a snake died, tracked only to mirror the demo's probe.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum DeathReason {
    Wall,
    SelfBody,
    Snake,
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

// ---------------------------------------------------------------------------
// Mulberry32 — the seeded item PRNG, bit-identical to RandomGenerator
// (playset/modules/math/random-utils.ts). See the module header for why the
// state evolution and the index pick both match TS to the bit.
// ---------------------------------------------------------------------------

struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    /// The raw u32 numerator `r` with `random() == r / 2^32` — TS's
    /// `((t ^ (t >>> 14)) >>> 0)` before the divide.
    fn next_u32(&mut self) -> u32 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let mut t = (self.state ^ (self.state >> 15)).wrapping_mul(1 | self.state);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t));
        t ^ (t >> 14)
    }

    /// `Math.floor(prng.random() * n)`, in integer math so no float rounding
    /// can pick a different cell than TS. `r*n < 2^40` keeps this exact.
    fn pick_index(&mut self, n: usize) -> usize {
        let r = self.next_u32() as u64;
        ((r * n as u64) >> 32) as usize
    }
}

// ---------------------------------------------------------------------------
// Grid scratch — the hot code. Flood fill / shortest-path over a 256-cell
// board, reusing World-held buffers so the brain allocates NOTHING per tick.
//
// The brain only ever consumes a flood COUNT and a path LENGTH / existence,
// and all three are invariant over search order (a shortest path's length is
// unique, a region's size is unique). So we compute them with plain BFS rather
// than replicating A*'s open-list tie-breaking — same answers, no per-search
// binary heap. `blocked` is set once per candidate direction; `start` (and the
// path `goal`) are exempt inline, matching GridPathPlanner's
// allowStartOccupied / allowGoalOccupied.
// ---------------------------------------------------------------------------

struct GridScratch {
    cols: i32,
    rows: i32,
    blocked: Vec<bool>,
    visited: Vec<bool>,
    dist: Vec<u32>,
    queue: Vec<i32>,
}

impl GridScratch {
    fn new() -> Self {
        Self {
            cols: 0,
            rows: 0,
            blocked: Vec::new(),
            visited: Vec::new(),
            dist: Vec::new(),
            queue: Vec::new(),
        }
    }

    /// One-time (boot) sizing — never called per step.
    fn resize(&mut self, cols: i32, rows: i32) {
        self.cols = cols.max(0);
        self.rows = rows.max(0);
        let n = (self.cols * self.rows) as usize;
        self.blocked.clear();
        self.blocked.resize(n, false);
        self.visited.clear();
        self.visited.resize(n, false);
        self.dist.clear();
        self.dist.resize(n, 0);
        self.queue.clear();
        self.queue.reserve(n);
    }

    #[inline]
    fn idx(&self, c: Cell) -> usize {
        (c.forward * self.cols + c.right) as usize
    }

    #[inline]
    fn in_bounds(&self, c: Cell) -> bool {
        c.right >= 0 && c.right < self.cols && c.forward >= 0 && c.forward < self.rows
    }

    fn clear_blocked(&mut self) {
        let n = (self.cols * self.rows) as usize;
        for b in &mut self.blocked[..n] {
            *b = false;
        }
    }

    #[inline]
    fn mark(&mut self, c: Cell) {
        if self.in_bounds(c) {
            let i = self.idx(c);
            self.blocked[i] = true;
        }
    }

    /// Reachable-cell count from `start` (start exempt), avoiding `blocked` —
    /// GridPathPlanner.floodFill's `.count` with wrap=false, limit=∞.
    fn flood_count(&mut self, start: Cell) -> u32 {
        let n = (self.cols * self.rows) as usize;
        for v in &mut self.visited[..n] {
            *v = false;
        }
        self.queue.clear();
        let si = self.idx(start);
        self.visited[si] = true;
        self.queue.push(si as i32);
        let mut count = 0u32;
        let mut h = 0usize;
        while h < self.queue.len() {
            let ci = self.queue[h] as usize;
            h += 1;
            count += 1;
            let cr = (ci as i32) % self.cols;
            let cf = (ci as i32) / self.cols;
            for v in DIR_VEC {
                let nr = cr + v.right;
                let nf = cf + v.forward;
                if nr < 0 || nr >= self.cols || nf < 0 || nf >= self.rows {
                    continue;
                }
                let ni = (nf * self.cols + nr) as usize;
                if self.visited[ni] || self.blocked[ni] {
                    continue;
                }
                self.visited[ni] = true;
                self.queue.push(ni as i32);
            }
        }
        count
    }

    /// Shortest step distance `start → goal` (both exempt), avoiding `blocked`,
    /// or None if unreachable — equal to GridPathPlanner.findPath's
    /// `path.length - 1` (and its null) for the quantities the brain reads.
    fn bfs_dist(&mut self, start: Cell, goal: Cell) -> Option<u32> {
        if start == goal {
            return Some(0);
        }
        let n = (self.cols * self.rows) as usize;
        for v in &mut self.visited[..n] {
            *v = false;
        }
        self.queue.clear();
        let si = self.idx(start);
        let gi = self.idx(goal);
        self.visited[si] = true;
        self.dist[si] = 0;
        self.queue.push(si as i32);
        let mut h = 0usize;
        while h < self.queue.len() {
            let ci = self.queue[h] as usize;
            h += 1;
            let cd = self.dist[ci];
            let cr = (ci as i32) % self.cols;
            let cf = (ci as i32) / self.cols;
            for v in DIR_VEC {
                let nr = cr + v.right;
                let nf = cf + v.forward;
                if nr < 0 || nr >= self.cols || nf < 0 || nf >= self.rows {
                    continue;
                }
                let ni = (nf * self.cols + nr) as usize;
                if self.visited[ni] {
                    continue;
                }
                if self.blocked[ni] && ni != gi {
                    continue;
                }
                if ni == gi {
                    return Some(cd + 1);
                }
                self.visited[ni] = true;
                self.dist[ni] = cd + 1;
                self.queue.push(ni as i32);
            }
        }
        None
    }

    /// Free cells right now (blocked == occupied here), enumerated forward
    /// outer, right inner — the order spawnAppleIfNeeded builds `freeCells`.
    fn count_free(&self) -> usize {
        let mut n = 0;
        for f in 0..self.rows {
            for r in 0..self.cols {
                if !self.blocked[(f * self.cols + r) as usize] {
                    n += 1;
                }
            }
        }
        n
    }

    /// The k-th free cell in that same enumeration order.
    fn nth_free(&self, k: usize) -> Option<Cell> {
        let mut seen = 0;
        for f in 0..self.rows {
            for r in 0..self.cols {
                if self.blocked[(f * self.cols + r) as usize] {
                    continue;
                }
                if seen == k {
                    return Some(Cell { right: r, forward: f });
                }
                seen += 1;
            }
        }
        None
    }
}

// ---------------------------------------------------------------------------
// One snake — the motion controller (snake-motion-controller.ts, cardinal
// mode) plus its brain weights and pooled visual nodes.
// ---------------------------------------------------------------------------

struct Snake {
    segments: Vec<Cell>,
    direction: Cell,
    pending_growth: i32,
    is_rival: bool,
    // reset() restores these (game.ts never changes a snake's spawn).
    initial_length: i32,
    initial_direction: Cell,
    start_cell: Cell,
    // rival brain weights (RIVAL_WEIGHTS); unused on the player.
    w_space: f32,
    w_apple: f32,
    w_tail: f32,
    w_straight: f32,
    // pooled segment nodes ([0] is the head) and how many are shown.
    nodes: Vec<i32>,
    shown: usize,
}

/// createDefaultSegments: head at `start`, body extending backward (−dir).
fn create_default_segments(len: i32, dir: Cell, start: Cell) -> Vec<Cell> {
    let len = len.max(2);
    let mut segments = Vec::with_capacity(len as usize + 4);
    segments.push(start);
    let rev = Cell { right: -dir.right, forward: -dir.forward };
    let mut cursor = start;
    for _ in 1..len {
        cursor = Cell { right: cursor.right + rev.right, forward: cursor.forward + rev.forward };
        segments.push(cursor);
    }
    segments
}

impl Snake {
    fn reset(&mut self) {
        self.direction = self.initial_direction;
        self.segments =
            create_default_segments(self.initial_length, self.initial_direction, self.start_cell);
        self.pending_growth = 0;
    }

    fn grow(&mut self, amount: i32) {
        self.pending_growth += amount.max(0);
    }

    /// SnakeMotionController.move in cardinal mode: turn only perpendicular to
    /// the current heading (reversals are structurally impossible), then step —
    /// dropping the tail unless mid-growth. `dir` is an absolute direction and
    /// `move_flags` maps it exactly as game.ts's moveFlags does.
    fn move_to(&mut self, dir: usize) {
        let (left, right, forward, backward) =
            (dir == DIR_LEFT, dir == DIR_RIGHT, dir == DIR_UP, dir == DIR_DOWN);
        let mut direction = self.direction;
        if direction.forward != 0 {
            if left && !right {
                direction = DIR_VEC[DIR_LEFT];
            } else if right && !left {
                direction = DIR_VEC[DIR_RIGHT];
            }
        } else if direction.right != 0 {
            if forward && !backward {
                direction = DIR_VEC[DIR_UP];
            } else if backward && !forward {
                direction = DIR_VEC[DIR_DOWN];
            }
        }
        let head = self.segments[0];
        let next_head =
            Cell { right: head.right + direction.right, forward: head.forward + direction.forward };
        if self.pending_growth > 0 {
            self.segments.insert(0, next_head);
            self.pending_growth -= 1;
        } else {
            self.segments.pop(); // tail vacates
            self.segments.insert(0, next_head);
        }
        self.direction = direction;
    }
}

// ---------------------------------------------------------------------------
// direction helpers (game.ts directionName / OPPOSITE) + heuristic
// ---------------------------------------------------------------------------

#[inline]
fn direction_name(v: Cell) -> usize {
    if v.right < 0 {
        DIR_LEFT
    } else if v.right > 0 {
        DIR_RIGHT
    } else if v.forward > 0 {
        DIR_UP
    } else {
        DIR_DOWN
    }
}

#[inline]
fn opposite(dir: usize) -> usize {
    (dir + 2) % 4
}

/// GridPathPlanner.heuristic with wrap=false — Manhattan distance.
#[inline]
fn heuristic(a: Cell, b: Cell) -> i32 {
    (a.right - b.right).abs() + (a.forward - b.forward).abs()
}

/// blockingKeys membership test for `cell`: opponent's whole body plus own
/// body minus the tail (which vacates unless mid-growth).
fn blocking_contains(cell: Cell, segments: &[Cell], pending: i32, opponent: &[Cell]) -> bool {
    if opponent.contains(&cell) {
        return true;
    }
    let stop = if pending > 0 { segments.len() } else { segments.len().saturating_sub(1) };
    segments[..stop].contains(&cell)
}

// ---------------------------------------------------------------------------
// The rival brain — one grid decision per tick (game.ts SnakeBrain).
// Free functions over explicit slices + scratch, so the World can hand out
// disjoint field borrows without fighting the borrow checker.
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn brain_choose(
    grid: &mut GridScratch,
    scratch_next: &mut Vec<Cell>,
    segments: &[Cell],
    direction: Cell,
    pending: i32,
    opponent: &[Cell],
    apples: &[Apple],
    w_space: f32,
    w_apple: f32,
    w_tail: f32,
    w_straight: f32,
) -> usize {
    let head = segments[0];
    let target = nearest_apple(head, apples);
    let cur_dir = direction_name(direction);

    let mut best: Option<usize> = None;
    let mut best_score = f32::NEG_INFINITY;
    for dir in 0..4usize {
        if dir == opposite(cur_dir) {
            continue;
        }
        let score = score_move(
            grid,
            scratch_next,
            dir,
            segments,
            pending,
            opponent,
            target,
            cur_dir,
            w_space,
            w_apple,
            w_tail,
            w_straight,
        );
        // `null || score <= best` → replace only on a strictly greater score;
        // ties keep the earlier (up/right/down/left) direction.
        match score {
            Some(s) if s > best_score => {
                best = Some(dir);
                best_score = s;
            }
            _ => {}
        }
    }
    best.unwrap_or(cur_dir)
}

/// The apple with the smallest Manhattan distance (first on a tie, matching
/// `>=`); None when the board is bare.
fn nearest_apple(head: Cell, apples: &[Apple]) -> Option<Cell> {
    let mut nearest = None;
    let mut nd = i32::MAX;
    for a in apples {
        let dist = heuristic(head, a.cell);
        if dist >= nd {
            continue;
        }
        nearest = Some(a.cell);
        nd = dist;
    }
    nearest
}

#[allow(clippy::too_many_arguments)]
fn score_move(
    grid: &mut GridScratch,
    scratch_next: &mut Vec<Cell>,
    dir: usize,
    segments: &[Cell],
    pending: i32,
    opponent: &[Cell],
    target: Option<Cell>,
    cur_dir: usize,
    w_space: f32,
    w_apple: f32,
    w_tail: f32,
    w_straight: f32,
) -> Option<f32> {
    let head = segments[0];
    let v = DIR_VEC[dir];
    let next_head = Cell { right: head.right + v.right, forward: head.forward + v.forward };
    // stepInBounds: off-board is not a move.
    if !grid.in_bounds(next_head) {
        return None;
    }
    // blockedNow: would this step run into a body that is still there?
    if blocking_contains(next_head, segments, pending, opponent) {
        return None;
    }

    // Simulate the move: nextSegments = [nextHead, ...segments], tail dropped
    // unless mid-growth (game.ts scoreMove).
    scratch_next.clear();
    scratch_next.push(next_head);
    scratch_next.extend_from_slice(segments);
    if pending <= 0 {
        scratch_next.pop();
    }
    let growth_after = if pending > 0 { pending - 1 } else { 0 };

    // blockedNext = opponent ∪ (nextSegments minus its tail unless growing).
    grid.clear_blocked();
    for c in opponent {
        grid.mark(*c);
    }
    let stop = if growth_after > 0 { scratch_next.len() } else { scratch_next.len() - 1 };
    for &c in &scratch_next[..stop] {
        grid.mark(c);
    }

    let flood = grid.flood_count(next_head) as f32;

    // Unreachable apple costs the whole board; reachable costs max(0, len-1) *
    // weight, and A* len-1 == the BFS distance.
    let apple_cost = match target.and_then(|t| grid.bfs_dist(next_head, t)) {
        Some(dist) => dist as f32 * w_apple,
        None => (grid.cols * grid.rows) as f32,
    };

    let tail = *scratch_next.last().unwrap_or(&next_head);
    let tail_reachable = grid.bfs_dist(next_head, tail).is_some();

    let score = flood * w_space - apple_cost
        + if tail_reachable { w_tail } else { 0.0 }
        + if dir == cur_dir { w_straight } else { 0.0 };
    Some(score)
}

// ---------------------------------------------------------------------------
// The World
// ---------------------------------------------------------------------------

pub struct World {
    /// The scene this world was created for. Snake writes poses by node id, not
    /// scene-scoped (unlike rally's camera), so the sim never reads this — but
    /// the handle rides along for parity with `world::World` and the mounts.
    #[allow(dead_code)]
    scene: i32,
    config: Config,
    snakes: Vec<Snake>,
    apples: Vec<Apple>,
    apple_node: i32,
    apple_shown: bool,

    status_gameover: bool,
    score: i32,
    rival_score: i32,
    best_score: i32,
    pending_direction: Option<usize>,
    steps_until_tick: i32,
    previous_buttons: u32,
    step_count: u32,
    booted: bool,

    // internal counters, mirroring the demo's probe (tests read these).
    grid_ticks: u32,
    items_eaten: i32,
    player_items: i32,
    rival_items: i32,
    player_deaths: i32,
    rival_deaths: i32,
    restarts: i32,
    last_player_death_reason: Option<DeathReason>,

    prng: Mulberry32,
    grid: GridScratch,
    scratch_next: Vec<Cell>,
    pose_buf: Vec<f32>,
}

impl World {
    pub fn new(scene: i32) -> Self {
        Self {
            scene,
            config: Config::default(),
            snakes: Vec::new(),
            apples: Vec::new(),
            apple_node: 0,
            apple_shown: false,
            status_gameover: false,
            score: 0,
            rival_score: 0,
            best_score: 0,
            pending_direction: None,
            steps_until_tick: 1,
            previous_buttons: 0,
            step_count: 0,
            booted: false,
            grid_ticks: 0,
            items_eaten: 0,
            player_items: 0,
            rival_items: 0,
            player_deaths: 0,
            rival_deaths: 0,
            restarts: 0,
            last_player_death_reason: None,
            prng: Mulberry32::new(0),
            grid: GridScratch::new(),
            scratch_next: Vec::new(),
            pose_buf: Vec::new(),
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
        self.config = Config {
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
        // One-time (boot) allocation of every scratch buffer — the hot path
        // never allocates after this. (Read the fields back off `config` so the
        // record stays the single source of truth for the whole board.)
        self.grid.resize(self.config.columns, self.config.rows);
        self.scratch_next =
            Vec::with_capacity((self.config.columns.max(0) * self.config.rows.max(0)) as usize + 1);
        self.pose_buf = Vec::with_capacity((self.config.max_segments.max(1) as usize) * POSE_STRIDE);
        self.prng = Mulberry32::new(self.config.prng_seed);
        self.steps_until_tick = self.tick_steps(0);
    }

    /// Add a snake at a start cell heading a cardinal direction. `is_rival`
    /// gives it the AI brain; the other snake takes the button mask. Returns
    /// the snake's handle (its index), which set_brain / bind_snake_visual take.
    pub fn add_snake(
        &mut self,
        start_right: i32,
        start_forward: i32,
        dir_right: i32,
        dir_forward: i32,
        is_rival: bool,
    ) -> usize {
        let start = Cell { right: start_right, forward: start_forward };
        let dir = Cell { right: dir_right, forward: dir_forward };
        let init_len = self.config.initial_length.max(2);
        let segments = create_default_segments(init_len, dir, start);
        let idx = self.snakes.len();
        self.snakes.push(Snake {
            segments,
            direction: dir,
            pending_growth: 0,
            is_rival,
            initial_length: init_len,
            initial_direction: dir,
            start_cell: start,
            w_space: 0.0,
            w_apple: 0.0,
            w_tail: 0.0,
            w_straight: 0.0,
            nodes: Vec::new(),
            shown: 0,
        });
        idx
    }

    /// The rival's scoring weights (space, apple distance, tail reach, straight
    /// bias), from RIVAL_WEIGHTS.
    pub fn set_brain(&mut self, snake: usize, space: f32, apple_dist: f32, tail: f32, straight: f32) {
        if let Some(s) = self.snakes.get_mut(snake) {
            s.w_space = space;
            s.w_apple = apple_dist;
            s.w_tail = tail;
            s.w_straight = straight;
        }
    }

    /// Hand over a snake's pooled segment nodes (head at index 0). The sim
    /// toggles their visibility and writes their poses.
    pub fn bind_snake_visual(&mut self, snake: usize, node_ids: &[i32]) {
        if let Some(s) = self.snakes.get_mut(snake) {
            s.nodes.clear();
            s.nodes.extend_from_slice(node_ids);
            s.shown = 0;
        }
    }

    /// Hand over the apple node (shown/hidden and posed by the sim).
    pub fn bind_apple_visual(&mut self, node_id: i32) {
        self.apple_node = node_id;
        self.apple_shown = false;
    }

    pub fn step(&mut self, store: &mut Store, _dt: f32, buttons: u32) {
        // The demo spawns its first apple at boot, before step 0; we defer that
        // single PRNG draw to the first step (nothing else draws before it), so
        // the stream is identical without needing a separate "start" op.
        if !self.booted {
            self.booted = true;
            self.spawn_apple_if_needed();
        }

        let pressed = buttons & !self.previous_buttons;
        self.previous_buttons = buttons;

        if !self.status_gameover {
            if pressed & btn::UP != 0 {
                self.pending_direction = Some(DIR_UP);
            } else if pressed & btn::RIGHT != 0 {
                self.pending_direction = Some(DIR_RIGHT);
            } else if pressed & btn::DOWN != 0 {
                self.pending_direction = Some(DIR_DOWN);
            } else if pressed & btn::LEFT != 0 {
                self.pending_direction = Some(DIR_LEFT);
            }

            self.steps_until_tick -= 1;
            if self.steps_until_tick <= 0 {
                self.grid_tick();
                self.steps_until_tick = self.tick_steps(self.score);
            }
        } else if pressed & (btn::CROSS | btn::START) != 0 {
            self.reset_run();
            self.restarts += 1;
        }

        self.step_count += 1;
        let now_ms = self.step_count as f32 * STEP_MS;
        self.sync_visuals(store, now_ms);
    }

    pub fn read_hud(&self, out: &mut [f32]) {
        if out.len() < HUD_FLOATS {
            return;
        }
        out[0] = if self.status_gameover { 1.0 } else { 0.0 };
        out[1] = self.score as f32;
        out[2] = self.rival_score as f32;
        out[3] = self.best_score as f32;
        out[4] = self.player_length() as f32;
    }

    // -- the grid tick -------------------------------------------------------

    /// Cadence fold: reference 150 ms/tick, −4 ms/point, 70 ms floor, rounded
    /// onto whole 1/60 s steps (game.ts tickSteps). Every value the demo can
    /// reach is far from a half-step, so f32 rounds like Math.round.
    fn tick_steps(&self, score: i32) -> i32 {
        let raw = self.config.base_tick_ms - score as f32 * self.config.speedup_ms_per_point;
        let ms = if raw > self.config.min_tick_ms { raw } else { self.config.min_tick_ms };
        let steps = fmath::floor(ms / STEP_MS + 0.5) as i32;
        steps.max(1)
    }

    fn player_length(&self) -> usize {
        self.snakes.iter().find(|s| !s.is_rival).map_or(0, |s| s.segments.len())
    }

    fn grid_tick(&mut self) {
        let Some(player_i) = self.snakes.iter().position(|s| !s.is_rival) else {
            return;
        };
        let rival_i = self.snakes.iter().position(|s| s.is_rival);

        // The rival decides against BOTH snakes' pre-move bodies (reference
        // order: choose, then move).
        let rival_dir = rival_i.map(|ri| self.rival_choose(ri, player_i));

        let player_dir = self
            .pending_direction
            .unwrap_or_else(|| direction_name(self.snakes[player_i].direction));
        self.pending_direction = None;

        self.snakes[player_i].move_to(player_dir);
        if let (Some(ri), Some(rd)) = (rival_i, rival_dir) {
            self.snakes[ri].move_to(rd);
        }

        self.referee(player_i, rival_i);

        self.spawn_apple_if_needed();
        self.grid_ticks += 1;
    }

    /// Compute the rival's move, borrowing the World's fields disjointly so the
    /// scratch buffers and both snakes can be read at once.
    fn rival_choose(&mut self, rival_i: usize, player_i: usize) -> usize {
        let grid = &mut self.grid;
        let scratch_next = &mut self.scratch_next;
        let snakes = &self.snakes;
        let apples = &self.apples;
        let rival = &snakes[rival_i];
        let player = &snakes[player_i];
        brain_choose(
            grid,
            scratch_next,
            &rival.segments,
            rival.direction,
            rival.pending_growth,
            &player.segments,
            apples,
            rival.w_space,
            rival.w_apple,
            rival.w_tail,
            rival.w_straight,
        )
    }

    /// SnakePlay.step over the two post-move bodies: wall / self / snake-vs-
    /// snake collisions and item pickups, in reference order (player before
    /// rival; the alive set is snapshotted, so a rival still collides into a
    /// body whose owner died the same tick).
    fn referee(&mut self, player_i: usize, rival_i: Option<usize>) {
        let bounds = (0, self.config.columns - 1, 0, self.config.rows - 1);
        let order = [Some(player_i), rival_i];
        let mut rival_died = false;

        for &maybe in &order {
            let Some(si) = maybe else { continue };
            let head = self.snakes[si].segments[0];

            if head.right < bounds.0
                || head.right > bounds.1
                || head.forward < bounds.2
                || head.forward > bounds.3
            {
                self.on_death(si, DeathReason::Wall, &mut rival_died);
                continue;
            }
            if hits_self(&self.snakes[si].segments) {
                self.on_death(si, DeathReason::SelfBody, &mut rival_died);
                continue;
            }
            let other = if si == player_i { rival_i } else { Some(player_i) };
            let hit = other.is_some_and(|oi| self.snakes[oi].segments.contains(&head));
            if hit {
                self.on_death(si, DeathReason::Snake, &mut rival_died);
                continue;
            }
            if let Some(ai) = self.apples.iter().position(|a| a.cell == head) {
                let grow_by = self.apples[ai].growth;
                self.apples.remove(ai);
                let points = grow_by.max(1);
                if self.snakes[si].is_rival {
                    self.rival_score += points;
                    self.snakes[si].grow(points);
                    self.rival_items += 1;
                } else {
                    self.score += points;
                    if self.score > self.best_score {
                        self.best_score = self.score;
                    }
                    self.snakes[si].grow(points);
                    self.player_items += 1;
                }
                self.items_eaten += 1;
            }
        }

        // A rival that died respawns at its start — unless the player died the
        // same tick (game over freezes the board).
        if let Some(ri) = rival_i.filter(|_| rival_died && !self.status_gameover) {
            self.snakes[ri].reset();
            self.rival_deaths += 1;
        }
    }

    fn on_death(&mut self, si: usize, reason: DeathReason, rival_died: &mut bool) {
        if self.snakes[si].is_rival {
            *rival_died = true;
        } else {
            self.status_gameover = true;
            if self.score > self.best_score {
                self.best_score = self.score;
            }
            self.player_deaths += 1;
            self.last_player_death_reason = Some(reason);
        }
    }

    fn reset_run(&mut self) {
        for s in &mut self.snakes {
            s.reset();
        }
        self.status_gameover = false;
        self.score = 0;
        self.rival_score = 0;
        self.apples.clear();
        self.pending_direction = None;
        self.steps_until_tick = self.tick_steps(0);
        // The PRNG is NOT reseeded — the item stream continues across restarts.
        self.spawn_apple_if_needed();
    }

    /// spawnAppleIfNeeded: one apple at a time; pick the k-th free cell (free
    /// enumerated forward-outer/right-inner) with the seeded PRNG.
    fn spawn_apple_if_needed(&mut self) {
        if !self.apples.is_empty() || self.status_gameover {
            return;
        }
        self.grid.clear_blocked();
        for s in &self.snakes {
            for c in &s.segments {
                self.grid.mark(*c);
            }
        }
        let n = self.grid.count_free();
        if n == 0 {
            return;
        }
        let k = self.prng.pick_index(n);
        if let Some(cell) = self.grid.nth_free(k) {
            self.apples.push(Apple { cell, growth: 1 });
        }
    }

    // -- visuals -------------------------------------------------------------

    fn sync_visuals(&mut self, store: &mut Store, now_ms: f32) {
        for i in 0..self.snakes.len() {
            self.sync_snake_visual(store, i, now_ms);
        }
        self.sync_apple_visual(store, now_ms);
    }

    /// syncSnakeVisual: grow/shrink the visible node chain, then pose each
    /// shown segment through the board transform — head yaw quaternion + idle
    /// bob, body shrink-scale + gentler bob.
    fn sync_snake_visual(&mut self, store: &mut Store, i: usize, now_ms: f32) {
        let cfg = self.config;
        let buf = &mut self.pose_buf;
        let s = &mut self.snakes[i];
        let pool = s.nodes.len();
        let shown = s.segments.len().min(pool);
        for j in s.shown..shown {
            store.node_set_visible(s.nodes[j], true);
        }
        for j in shown..s.shown {
            store.node_set_visible(s.nodes[j], false);
        }
        s.shown = shown;
        if shown == 0 {
            return;
        }
        let yaw = HEAD_YAW[direction_name(s.direction)];
        buf.clear();
        for k in 0..shown {
            let seg = s.segments[k];
            let bob = if k == 0 {
                fmath::sin(now_ms * 0.008) * 0.035
            } else {
                fmath::sin(now_ms * 0.006 - k as f32 * 0.55) * 0.02
            };
            let up = 0.12 + bob;
            let p = cfg.origin
                + Vec3::new(
                    seg.right as f32 * cfg.cell_size,
                    up,
                    -(seg.forward as f32) * cfg.cell_size,
                );
            let (q, sc) = if k == 0 {
                (math::quat_from_euler_xyz(0.0, yaw, 0.0), Vec3::ONE)
            } else {
                let raw = 1.0 - k as f32 * 0.015;
                let shrink = if raw > 0.82 { raw } else { 0.82 };
                (Quat::IDENTITY, Vec3::new(shrink, shrink, shrink))
            };
            push_pose(buf, s.nodes[k], p, q, sc);
        }
        let count = buf.len() / POSE_STRIDE;
        store.write_poses(buf, count);
    }

    /// syncAppleVisual: toggle the apple node, then float + slowly spin it.
    fn sync_apple_visual(&mut self, store: &mut Store, now_ms: f32) {
        let has = !self.apples.is_empty();
        if self.apple_node != 0 && has != self.apple_shown {
            store.node_set_visible(self.apple_node, has);
            self.apple_shown = has;
        }
        if !has || self.apple_node == 0 {
            return;
        }
        let cfg = self.config;
        let a = self.apples[0].cell;
        let up = 0.25 + fmath::sin(now_ms * 0.005) * 0.08;
        let p = cfg.origin
            + Vec3::new(a.right as f32 * cfg.cell_size, up, -(a.forward as f32) * cfg.cell_size);
        let q = math::quat_from_euler_xyz(0.0, now_ms * 0.0012, 0.0);
        let buf = &mut self.pose_buf;
        buf.clear();
        push_pose(buf, self.apple_node, p, q, Vec3::ONE);
        store.write_poses(buf, 1);
    }
}

/// _hitsSelf: the head shares a cell with any later segment.
fn hits_self(segments: &[Cell]) -> bool {
    if segments.len() <= 1 {
        return false;
    }
    let head = segments[0];
    segments[1..].contains(&head)
}

fn push_pose(buf: &mut Vec<f32>, id: i32, p: Vec3, q: Quat, s: Vec3) {
    buf.extend_from_slice(&[id as f32, p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z]);
}

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------ setup

    /// A World configured exactly like demos/snake/game.ts createSnakeGame():
    /// 16×16 board, origin (0,0,15) = defaultBoardOrigin(rows=16, cell=1), the
    /// reference cadence, seed 1337. Player then rival, brain on the rival.
    fn demo_world() -> (Store, i32, World, usize, usize) {
        let mut store = Store::new();
        let scene = store.scene_create();
        let mut w = World::new(scene);
        w.configure(16, 16, 1.0, Vec3::new(0.0, 0.0, 15.0), 150.0, 70.0, 4.0, 4, 64, 1337);
        let player = w.add_snake(3, 8, 1, 0, false);
        let rival = w.add_snake(12, 3, -1, 0, true);
        w.set_brain(rival, 2.0, 3.0, 3.5, 0.5);
        (store, scene, w, player, rival)
    }

    // ------------------------------------------------------------- PRNG

    #[test]
    fn prng_pick_is_bit_identical_to_the_f64_floor() {
        // The whole exactness argument for the apple pick: the integer
        // multiply-shift equals Math.floor(random()*n) for the actual seeds and
        // free-cell counts the game uses (n up to 256), across a long stream.
        for &seed in &[1337u32, 42, 0, 0xDEADBEEF, 1] {
            let mut a = Mulberry32::new(seed);
            let mut b = Mulberry32::new(seed);
            for _ in 0..4096 {
                for &n in &[1usize, 2, 3, 7, 31, 100, 200, 248, 255, 256] {
                    let r = a.next_u32(); // raw numerator
                    let via_int = ((r as u64 * n as u64) >> 32) as usize;
                    let via_f64 = (r as f64 / 4294967296.0 * n as f64).floor() as usize;
                    assert_eq!(via_int, via_f64, "seed {seed} n {n} r {r}");
                }
                let _ = b.next_u32(); // keep b's stream aligned with a's cadence
            }
        }
    }

    #[test]
    fn prng_first_pick_matches_the_demos_first_apple() {
        // Boot the demo world; the deferred boot spawn draws the first apple.
        // game.ts's createSnakeGame with seed 1337 puts it at (13, 2).
        let (mut store, _scene, mut w, _p, _r) = demo_world();
        w.step(&mut store, 1.0 / 60.0, 0);
        assert_eq!(w.apples.len(), 1);
        assert_eq!(w.apples[0].cell, Cell { right: 13, forward: 2 });
    }

    // ------------------------------------------------------------- flood / A*

    #[test]
    fn flood_count_over_a_known_wall() {
        // 5×5 board, a full vertical wall at right==2 splits it into a left
        // strip (cols 0..1 = 2*5 = 10 cells) and a right region (cols 3..4).
        let mut g = GridScratch::new();
        g.resize(5, 5);
        g.clear_blocked();
        for f in 0..5 {
            g.mark(Cell { right: 2, forward: f });
        }
        // Flooding from the left strip reaches exactly its 10 cells.
        assert_eq!(g.flood_count(Cell { right: 0, forward: 0 }), 10);
        // From the right region: cols 3 and 4 over 5 rows = 10 cells.
        assert_eq!(g.flood_count(Cell { right: 4, forward: 4 }), 10);
        // With no wall the whole 25-cell board is reachable.
        g.clear_blocked();
        assert_eq!(g.flood_count(Cell { right: 2, forward: 2 }), 25);
    }

    #[test]
    fn bfs_dist_solves_a_known_maze() {
        // 5×5 with a wall at right==2 for forward 0..3, leaving a gap at
        // forward==4. Start (0,0) → goal (4,0) must detour up to row 4, across,
        // and back down: 4 up + 4 right + 4 down = 12 steps.
        let mut g = GridScratch::new();
        g.resize(5, 5);
        g.clear_blocked();
        for f in 0..4 {
            g.mark(Cell { right: 2, forward: f });
        }
        let d = g.bfs_dist(Cell { right: 0, forward: 0 }, Cell { right: 4, forward: 0 });
        assert_eq!(d, Some(12));
        // Sealing the gap makes the goal unreachable.
        g.mark(Cell { right: 2, forward: 4 });
        assert_eq!(g.bfs_dist(Cell { right: 0, forward: 0 }, Cell { right: 4, forward: 0 }), None);
        // Degenerate start==goal is distance 0.
        assert_eq!(g.bfs_dist(Cell { right: 1, forward: 1 }, Cell { right: 1, forward: 1 }), Some(0));
    }

    // ------------------------------------------------------------- brain

    #[test]
    fn brain_avoids_the_wall_and_its_own_body() {
        // Head at the right wall (15,8) heading up; the 2×2 loop body puts the
        // left move into its own neck. Only "up" is a legal, non-fatal step.
        let mut g = GridScratch::new();
        g.resize(16, 16);
        let mut scratch = Vec::new();
        let segments = [
            Cell { right: 15, forward: 8 },
            Cell { right: 14, forward: 8 },
            Cell { right: 14, forward: 7 },
            Cell { right: 15, forward: 7 },
        ];
        let dir = brain_choose(
            &mut g,
            &mut scratch,
            &segments,
            DIR_VEC[DIR_UP],
            0,
            &[],
            &[],
            2.0,
            3.0,
            3.5,
            0.5,
        );
        // Whatever it chose, the resulting head is on the board and not into a
        // blocking body cell.
        let v = DIR_VEC[dir];
        let nh = Cell { right: segments[0].right + v.right, forward: segments[0].forward + v.forward };
        assert!(g.in_bounds(nh), "brain stepped off the board (dir {dir})");
        assert!(!blocking_contains(nh, &segments, 0, &[]), "brain stepped into its body (dir {dir})");
        assert_eq!(dir, DIR_UP, "the only safe move here is up");
    }

    // ------------------------------------------------------------- referee

    #[test]
    fn referee_reports_a_wall_death() {
        // Player-only world at the right edge, heading right; force a tick.
        let mut store = Store::new();
        let scene = store.scene_create();
        let mut w = World::new(scene);
        w.configure(16, 16, 1.0, Vec3::new(0.0, 0.0, 15.0), 150.0, 70.0, 4.0, 4, 64, 1337);
        let _p = w.add_snake(15, 8, 1, 0, false);
        w.booted = true; // skip the boot apple; it is irrelevant to a wall run
        w.steps_until_tick = 1;
        w.step(&mut store, 1.0 / 60.0, 0);
        assert!(w.status_gameover);
        assert_eq!(w.player_deaths, 1);
        assert_eq!(w.last_player_death_reason, Some(DeathReason::Wall));
    }

    #[test]
    fn referee_reports_an_item_pickup() {
        // Player at (5,8) heading right, apple one cell ahead; force a tick.
        let mut store = Store::new();
        let scene = store.scene_create();
        let mut w = World::new(scene);
        w.configure(16, 16, 1.0, Vec3::new(0.0, 0.0, 15.0), 150.0, 70.0, 4.0, 4, 64, 1337);
        let _p = w.add_snake(5, 8, 1, 0, false);
        w.booted = true;
        w.apples.push(Apple { cell: Cell { right: 6, forward: 8 }, growth: 1 });
        w.steps_until_tick = 1;
        w.step(&mut store, 1.0 / 60.0, 0);
        assert_eq!(w.score, 1);
        assert_eq!(w.player_items, 1);
        assert_eq!(w.items_eaten, 1);
        assert!(!w.status_gameover);
        // The eaten apple was replaced by a freshly spawned one.
        assert_eq!(w.apples.len(), 1);
        assert_ne!(w.apples[0].cell, Cell { right: 6, forward: 8 });
    }

    // ------------------------------------------------------------- cadence

    #[test]
    fn tick_cadence_folds_like_the_reference() {
        let (_store, _scene, w, _p, _r) = demo_world();
        assert_eq!(w.tick_steps(0), 9); // 150 ms → 9 steps
        assert_eq!(w.tick_steps(5), 8); // 130 ms → 7.8 → 8
        assert_eq!(w.tick_steps(20), 4); // clamped 70 ms → 4.2 → 4
        assert_eq!(w.tick_steps(1000), 4); // stays at the floor
    }

    // ------------------------------------------------------------- visuals

    #[test]
    fn visual_sync_shows_and_poses_the_head() {
        let mut store = Store::new();
        let scene = store.scene_create();
        let mut w = World::new(scene);
        w.configure(16, 16, 1.0, Vec3::new(0.0, 0.0, 15.0), 150.0, 70.0, 4.0, 4, 64, 1337);
        let player = w.add_snake(3, 8, 1, 0, false);
        // A real 4-node pool for the player head + body.
        let mut nodes = Vec::new();
        for _ in 0..4 {
            nodes.push(store.node_create(scene, 0));
        }
        w.bind_snake_visual(player, &nodes);
        w.step(&mut store, 1.0 / 60.0, 0);
        // The four segments are now visible and posed onto their cells (x = the
        // cell's right; z = origin.z − forward). Player head sits at (3,8).
        let head = store.node(nodes[0]).unwrap();
        assert!(head.visible);
        assert!((head.p.x - 3.0).abs() < 1e-4);
        assert!((head.p.z - (15.0 - 8.0)).abs() < 1e-4);
    }

    // ------------------------------------------------------------- PARITY

    #[test]
    fn scripted_game_matches_the_ts_reference_tick_for_tick() {
        // The golden below is captured from demos/snake/game.ts itself and is
        // cross-checked, step-for-step, against the live composition before it
        // is emitted — see playset/test/gen-snake-parity.ts. It covers 7 seeded
        // apple picks across a wall death and a restart, so a wrong PRNG bit, a
        // swapped free-cell order, or a brain divergence would break it.
        //
        // ===== GENERATED by `bun playset/test/gen-snake-parity.ts` — do not hand-edit. =====
        // 10 s of the demos/snake/game.ts composition at 60 Hz (600 steps),
        // cross-checked step-for-step against the live __snakeProbe before emit.
        const PARITY_STEPS: u32 = 600;
        // Run-length button tape: [first_step, spec_btn_mask], held until the next run.
        const PARITY_MASKS: &[(u32, u32)] = &[
            (0, 0x0),
            (36, 0x10),
            (37, 0x0),
            (90, 0x80),
            (91, 0x0),
            (126, 0x40),
            (127, 0x0),
            (198, 0x20),
            (199, 0x0),
            (240, 0x40),
            (336, 0x0),
            (360, 0x4000),
            (361, 0x0),
            (444, 0x10),
            (445, 0x0),
            (498, 0x80),
            (499, 0x0),
            (564, 0x40),
            (565, 0x0),
        ];
        // One row per grid tick, in tick order.
        // [step, apple_right, apple_forward, score, rival_score, player_len, rival_len,
        //  player_head_r, player_head_f, rival_head_r, rival_head_f]; apple -1,-1 = none.
        const PARITY_TICKS: &[[i32; 11]] = &[
            [8, 13, 2, 0, 0, 4, 4, 4, 8, 12, 2],
            [17, 1, 3, 0, 1, 4, 4, 5, 8, 13, 2],
            [26, 1, 3, 0, 1, 4, 5, 6, 8, 13, 1],
            [35, 1, 3, 0, 1, 4, 5, 7, 8, 12, 1],
            [44, 1, 3, 0, 1, 4, 5, 7, 9, 11, 1],
            [53, 1, 3, 0, 1, 4, 5, 7, 10, 10, 1],
            [62, 1, 3, 0, 1, 4, 5, 7, 11, 9, 1],
            [71, 1, 3, 0, 1, 4, 5, 7, 12, 8, 1],
            [80, 1, 3, 0, 1, 4, 5, 7, 13, 7, 1],
            [89, 1, 3, 0, 1, 4, 5, 7, 14, 6, 1],
            [98, 1, 3, 0, 1, 4, 5, 6, 14, 5, 1],
            [107, 1, 3, 0, 1, 4, 5, 5, 14, 4, 1],
            [116, 1, 3, 0, 1, 4, 5, 4, 14, 3, 1],
            [125, 1, 3, 0, 1, 4, 5, 3, 14, 2, 1],
            [134, 1, 3, 0, 1, 4, 5, 3, 13, 1, 1],
            [143, 1, 3, 0, 1, 4, 5, 3, 12, 1, 2],
            [152, 15, 12, 0, 2, 4, 5, 3, 11, 1, 3],
            [161, 15, 12, 0, 2, 4, 6, 3, 10, 1, 4],
            [170, 15, 12, 0, 2, 4, 6, 3, 9, 1, 5],
            [179, 15, 12, 0, 2, 4, 6, 3, 8, 1, 6],
            [188, 15, 12, 0, 2, 4, 6, 3, 7, 1, 7],
            [197, 15, 12, 0, 2, 4, 6, 3, 6, 1, 8],
            [206, 15, 12, 0, 2, 4, 6, 4, 6, 1, 9],
            [215, 15, 12, 0, 2, 4, 6, 5, 6, 1, 10],
            [224, 15, 12, 0, 2, 4, 6, 6, 6, 1, 11],
            [233, 15, 12, 0, 2, 4, 6, 7, 6, 1, 12],
            [242, 15, 12, 0, 2, 4, 6, 7, 5, 2, 12],
            [251, 15, 12, 0, 2, 4, 6, 7, 4, 3, 12],
            [260, 15, 12, 0, 2, 4, 6, 7, 3, 4, 12],
            [269, 15, 12, 0, 2, 4, 6, 7, 2, 5, 12],
            [278, 15, 12, 0, 2, 4, 6, 7, 1, 6, 12],
            [287, 15, 12, 0, 2, 4, 6, 7, 0, 7, 12],
            [296, 15, 12, 0, 2, 4, 6, 7, -1, 8, 12],
            [369, 7, 10, 0, 0, 4, 4, 4, 8, 11, 3],
            [378, 7, 10, 0, 0, 4, 4, 5, 8, 10, 3],
            [387, 7, 10, 0, 0, 4, 4, 6, 8, 9, 3],
            [396, 7, 10, 0, 0, 4, 4, 7, 8, 8, 3],
            [405, 7, 10, 0, 0, 4, 4, 8, 8, 8, 4],
            [414, 7, 10, 0, 0, 4, 4, 9, 8, 8, 5],
            [423, 7, 10, 0, 0, 4, 4, 10, 8, 8, 6],
            [432, 7, 10, 0, 0, 4, 4, 11, 8, 8, 7],
            [441, 7, 10, 0, 0, 4, 4, 12, 8, 7, 7],
            [450, 7, 10, 0, 0, 4, 4, 12, 9, 7, 8],
            [459, 7, 10, 0, 0, 4, 4, 12, 10, 7, 9],
            [468, 10, 6, 0, 1, 4, 4, 12, 11, 7, 10],
            [477, 10, 6, 0, 1, 4, 5, 12, 12, 8, 10],
            [486, 10, 6, 0, 1, 4, 5, 12, 13, 9, 10],
            [495, 10, 6, 0, 1, 4, 5, 12, 14, 10, 10],
            [504, 10, 6, 0, 1, 4, 5, 11, 14, 10, 9],
            [513, 10, 6, 0, 1, 4, 5, 10, 14, 10, 8],
            [522, 10, 6, 0, 1, 4, 5, 9, 14, 10, 7],
            [531, 14, 5, 0, 2, 4, 5, 8, 14, 10, 6],
            [540, 14, 5, 0, 2, 4, 6, 7, 14, 10, 5],
            [549, 14, 5, 0, 2, 4, 6, 6, 14, 11, 5],
            [558, 14, 5, 0, 2, 4, 6, 5, 14, 12, 5],
            [567, 14, 5, 0, 2, 4, 6, 5, 13, 13, 5],
            [576, 7, 8, 0, 3, 4, 6, 5, 12, 14, 5],
            [585, 7, 8, 0, 3, 4, 7, 5, 11, 14, 6],
            [594, 7, 8, 0, 3, 4, 7, 5, 10, 14, 7],
        ];
        // Final observable totals after the whole tape.
        const PARITY_FINAL_SCORE: i32 = 0;
        const PARITY_FINAL_RIVAL_SCORE: i32 = 3;
        const PARITY_FINAL_BEST_SCORE: i32 = 0;
        const PARITY_FINAL_ITEMS_EATEN: i32 = 5;
        const PARITY_FINAL_PLAYER_DEATHS: i32 = 1;
        const PARITY_FINAL_RIVAL_DEATHS: i32 = 0;
        const PARITY_FINAL_RESTARTS: i32 = 1;
        const PARITY_FINAL_GRID_TICKS: i32 = 59;
        // ===== end generated block =====

        let (mut store, _scene, mut w, player, rival) = demo_world();

        // expand the run-length button tape
        let mut masks = alloc::vec![0u32; PARITY_STEPS as usize];
        for s in 0..PARITY_STEPS as usize {
            let mut m = 0u32;
            for &(f, mask) in PARITY_MASKS {
                if f as usize <= s {
                    m = mask;
                } else {
                    break;
                }
            }
            masks[s] = m;
        }

        let mut rows = PARITY_TICKS.iter();
        let mut prev_ticks = w.grid_ticks;
        for step in 0..PARITY_STEPS {
            w.step(&mut store, 1.0 / 60.0, masks[step as usize]);
            if w.grid_ticks == prev_ticks {
                continue;
            }
            prev_ticks = w.grid_ticks;
            let row = rows.next().expect("native fired more ticks than the fixture holds");

            let (ar, af) = w
                .apples
                .first()
                .map_or((-1, -1), |a| (a.cell.right, a.cell.forward));
            let ph = w.snakes[player].segments[0];
            let rh = w.snakes[rival].segments[0];
            let got = [
                step as i32,
                ar,
                af,
                w.score,
                w.rival_score,
                w.snakes[player].segments.len() as i32,
                w.snakes[rival].segments.len() as i32,
                ph.right,
                ph.forward,
                rh.right,
                rh.forward,
            ];
            assert_eq!(got, *row, "tick divergence at step {step}");
        }
        assert!(rows.next().is_none(), "fixture holds ticks the native never fired");

        // Final totals — the same observables the demo's probe carries.
        assert_eq!(w.score, PARITY_FINAL_SCORE);
        assert_eq!(w.rival_score, PARITY_FINAL_RIVAL_SCORE);
        assert_eq!(w.best_score, PARITY_FINAL_BEST_SCORE);
        assert_eq!(w.items_eaten, PARITY_FINAL_ITEMS_EATEN);
        assert_eq!(w.player_deaths, PARITY_FINAL_PLAYER_DEATHS);
        assert_eq!(w.rival_deaths, PARITY_FINAL_RIVAL_DEATHS);
        assert_eq!(w.restarts, PARITY_FINAL_RESTARTS);
        assert_eq!(w.grid_ticks as i32, PARITY_FINAL_GRID_TICKS);
    }
}
