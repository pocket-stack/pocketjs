//! The rival's driving brain, the race state machine, and the chase camera —
//! five hot GameBlocks blocks as native f32 Rust.
//!
//! Ported from the TS modules, which REMAIN the reference implementation
//! (lib.rs: a host without `ps` runs the TS composition and the byte-exact
//! goldens pin that path):
//!
//!   - playset/modules/behavior/waypoint-progress-tracker.ts  → [`WaypointTracker`]
//!   - playset/modules/behavior/agent-path-navigator.ts       → [`PathNavigator`]
//!   - playset/modules/behavior/waypoint-driver.ts            → [`WaypointDriver`]
//!   - playset/modules/gameplay/race-checkpoint-lap-play.ts   → [`RacePlay`]
//!   - playset/modules/camera/pose-follow-camera-rig.ts       → [`CameraRig`]
//!     (with playset/modules/camera/base-camera-rig.ts, its smoothing base)
//!
//! all of which are themselves ports of GameBlocks
//! (github.com/xt4d/GameBlocks, MIT © 2026 Weihao Cheng).
//!
//! EVENTS BECOME COUNTS. The TS blocks emit event objects — `checkpoint.passed`,
//! `lap.completed`, `player.finished`, `race.finished` — and allocate an array
//! of them every step. The only consumer that has ever existed is the rally
//! HUD (demos/rally/game.ts), which folds them into two integers: a running
//! `checkpointsPassed` tally and the player's current lap. So [`RacePlay::step`]
//! returns the number of checkpoint passes and nothing else, and the state the
//! HUD actually reads back (laps, next checkpoint) is polled through
//! [`RacePlay::player`] instead. That is the whole reason this API allocates
//! nothing per step; if a future guest needs a real event feed, it belongs in a
//! ring buffer the guest drains, not in a per-step `Vec`.
//!
//! DETERMINISM: no wall clock, no RNG, no hashing — players and waypoints are
//! plain `Vec`s walked in insertion order, so standings tie-breaks and
//! iteration are stable across hosts (DETERMINISM.md).
//!
//! ALLOCATION: every `Vec` here is filled at assembly time (`new`,
//! `push_checkpoint`, `add_player`); no `step` on this page allocates.

use alloc::vec::Vec;
use glam::{Quat, Vec3};

use crate::math::{
    self, clamp, forward_of, from_basis, planar_distance, right_of, up_of, Frame, EPS,
};

/// `Math.acos`. [`crate::math::fmath`] has no `acos` — nothing else in the port
/// needed one — and `libm` is already this crate's single transcendental
/// source, so routing through it directly keeps desktop and PSP agreeing for
/// exactly the reason `fmath` exists.
#[inline]
fn acos(x: f32) -> f32 {
    libm::acosf(x)
}

/// `Math.sign(value || 1)` — the idiom both the tracker and the driver use to
/// turn a planar cross product into a turn direction. JS treats `0` (and `-0`)
/// as falsy, so a dead-straight crossing resolves to `+1`, never `0`.
#[inline]
fn sign_or_positive(v: f32) -> f32 {
    if v < 0.0 {
        -1.0
    } else {
        1.0
    }
}

/// Planar (right/forward) squared distance — the nearest-waypoint and
/// reach tests never need the root.
#[inline]
fn planar_distance_sq(a: Vec3, b: Vec3) -> f32 {
    let dr = right_of(a) - right_of(b);
    let df = forward_of(a) - forward_of(b);
    dr * dr + df * df
}

/// A unit planar direction plus the length it was normalized from.
#[derive(Clone, Copy)]
struct PlanarDir {
    right: f32,
    forward: f32,
    len: f32,
}

/// `normalizePlanar` (tracker) / the tail of `directionToTarget` (driver):
/// below EPS the direction collapses to zero and callers bail out.
#[inline]
fn normalize_planar(d_right: f32, d_forward: f32) -> PlanarDir {
    let len = math::fmath::sqrt(d_right * d_right + d_forward * d_forward);
    if len < EPS {
        return PlanarDir {
            right: 0.0,
            forward: 0.0,
            len: 0.0,
        };
    }
    PlanarDir {
        right: d_right / len,
        forward: d_forward / len,
        len,
    }
}

/// `planarDelta(from, to)` — the unit planar direction from `from` to `to`.
#[inline]
fn planar_delta(from: Vec3, to: Vec3) -> PlanarDir {
    normalize_planar(right_of(to) - right_of(from), forward_of(to) - forward_of(from))
}

// ===========================================================================
// waypoint-progress-tracker.ts — where am I on the route, and how sharp is
// the corner I am aiming at
// ===========================================================================

/// What the tracker hands the rest of the brain each step.
///
/// DELIBERATE NARROWING vs `WaypointProgress`: the TS struct also carries
/// `currentIndex`, `distanceToCurrent`, `cornerSign` and `waypointCount`.
/// The rally composition consumes exactly two of its fields — the waypoint
/// (fed to the navigator and the driver) and the corner magnitude (the
/// driver's slowdown term). `distanceToCurrent` is recomputed by the
/// navigator anyway, and `cornerSign` only ever fed `steerBias`, which rally
/// leaves at 0. The dropped fields are cheap to restore if a guest needs them.
#[derive(Clone, Copy, Debug)]
pub struct TrackerProgress {
    /// `None` only when the route is empty (the TS `step` returns `null`).
    pub waypoint: Option<Vec3>,
    /// Turn angle at the current waypoint, radians in `[0, π]`.
    pub corner_magnitude: f32,
}

/// Advances along a waypoint route once inside `reach_distance`.
pub struct WaypointTracker {
    waypoints: Vec<Vec3>,
    reach_distance: f32,
    closed: bool,
    index: usize,
    /// False until the first `step` (or a `reset`) has picked a starting
    /// waypoint; the first uninitialized step snaps to the nearest one.
    initialized: bool,
}

impl WaypointTracker {
    /// `waypoints` are copied once, here — assembly time. The TS constructor
    /// filters out points with non-finite planar components; a `Vec3` that got
    /// this far came through the mount's typed-array decode, so the filter has
    /// nothing left to reject and is dropped.
    pub fn new(waypoints: &[Vec3], reach_distance: f32, closed: bool) -> Self {
        let mut route = Vec::with_capacity(waypoints.len());
        route.extend_from_slice(waypoints);
        Self {
            waypoints: route,
            reach_distance,
            closed,
            index: 0,
            initialized: false,
        }
    }

    /// `reset(startIndex)`. An empty route stays uninitialized, matching
    /// `this.initialized = count > 0`.
    pub fn reset(&mut self, index: usize) {
        let count = self.waypoints.len();
        self.index = if count > 0 { index % count } else { 0 };
        self.initialized = count > 0;
    }

    pub fn step(&mut self, position: Vec3) -> TrackerProgress {
        let count = self.waypoints.len();
        if count == 0 {
            return TrackerProgress {
                waypoint: None,
                corner_magnitude: 0.0,
            };
        }

        let mut index = if self.initialized {
            self.index
        } else {
            self.nearest_global(position)
        };
        self.initialized = true;

        // Reached it? Take the next one. Once per step — the TS never chains
        // advances, so a car parked on a dense stretch of route still walks it
        // one waypoint per frame.
        let distance = planar_distance(position, self.waypoints[index]);
        if distance <= self.reach_distance && (self.closed || index < count - 1) {
            index = resolve_step_index(index, 1, count, self.closed);
        }
        self.index = index;

        TrackerProgress {
            waypoint: Some(self.waypoints[index]),
            corner_magnitude: self.corner_magnitude(index),
        }
    }

    /// The index the tracker is currently aiming at (diagnostics/tests).
    pub fn index(&self) -> usize {
        self.index
    }

    fn nearest_global(&self, position: Vec3) -> usize {
        let mut best = 0usize;
        let mut best_sq = f32::INFINITY;
        for (i, w) in self.waypoints.iter().enumerate() {
            let d = planar_distance_sq(position, *w);
            // Strictly-less keeps the FIRST of equal candidates, like the TS.
            if d < best_sq {
                best_sq = d;
                best = i;
            }
        }
        best
    }

    /// `cornerProfile`, magnitude only (see [`TrackerProgress`]): the angle
    /// between the incoming and outgoing legs at `index`.
    fn corner_magnitude(&self, index: usize) -> f32 {
        let count = self.waypoints.len();
        if count < 3 {
            return 0.0;
        }
        let prev = resolve_step_index(index, -1, count, self.closed);
        let next = resolve_step_index(index, 1, count, self.closed);
        // On an open path the endpoints clamp onto themselves — no corner.
        if !self.closed && (prev == index || next == index) {
            return 0.0;
        }

        let in_dir = planar_delta(self.waypoints[prev], self.waypoints[index]);
        let out_dir = planar_delta(self.waypoints[index], self.waypoints[next]);
        if in_dir.len < EPS || out_dir.len < EPS {
            return 0.0;
        }
        let dot = clamp(
            in_dir.right * out_dir.right + in_dir.forward * out_dir.forward,
            -1.0,
            1.0,
        );
        acos(dot)
    }
}

/// `resolveStepIndex` — wrap on a closed circuit, clamp on an open path.
#[inline]
fn resolve_step_index(index: usize, step: isize, count: usize, closed: bool) -> usize {
    if count == 0 {
        return 0;
    }
    let c = count as isize;
    let i = index as isize + step;
    if closed {
        // Literally the TS `((index % len) + len) % len`.
        (((i % c) + c) % c) as usize
    } else {
        i.clamp(0, c - 1) as usize
    }
}

// ===========================================================================
// agent-path-navigator.ts — how fast should the agent WANT to go
// ===========================================================================

/// DELIBERATE NARROWING vs `NavigationIntent`: the TS intent also carries the
/// waypoint (the caller already has it), the unit direction, and the distance.
/// rally uses exactly one field — `desiredSpeed`, as the throttle ease-off
/// ratio (`nav.desiredSpeed / navigator.maxSpeed`, see `World::plan_input`) —
/// because the waypoint DRIVER, not the navigator, owns steering here. The
/// direction/distance are one subtraction away for a future consumer.
#[derive(Clone, Copy, Debug)]
pub struct NavOutput {
    pub desired_speed: f32,
}

/// Arrival slowdown: full speed far out, easing to zero on the waypoint.
pub struct PathNavigator {
    /// Public because the throttle ease-off ratio is computed against it in
    /// `World::plan_input`, exactly as rally does with `navigator.maxSpeed`.
    pub max_speed: f32,
    pub arrive_radius: f32,
}

impl PathNavigator {
    /// `minSpeed` is fixed at the TS default of 0 — the only knob rally (and
    /// the `carBrain` op contract, playset/sim/ops.ts `BrainConfig`) exposes
    /// are `maxSpeed` and `arriveRadius`. With `minSpeed = 0` the TS lower
    /// clamp `max(0, min(minSpeed, speedLimit))` is identically 0.
    pub fn new(max_speed: f32, arrive_radius: f32) -> Self {
        Self {
            max_speed,
            arrive_radius,
        }
    }

    /// `&self`: the TS keeps a `last` intent purely for inspection, so this
    /// step is pure. `movementEnabled` is always true in rally — a disabled
    /// navigator is spelled by not calling it.
    pub fn step(&self, position: Vec3, waypoint: Option<Vec3>) -> NavOutput {
        let Some(target) = waypoint else {
            return NavOutput { desired_speed: 0.0 };
        };
        // `toTarget = target - position` flattened to the ground plane, then
        // `.length()` — i.e. the planar distance.
        let distance = planar_distance(target, position);
        if distance <= EPS {
            return NavOutput { desired_speed: 0.0 };
        }
        let speed_limit = if self.max_speed > 0.0 {
            self.max_speed
        } else {
            0.0
        };
        let arrival_scale = if self.arrive_radius > EPS {
            clamp(distance / self.arrive_radius, 0.0, 1.0)
        } else {
            1.0
        };
        NavOutput {
            desired_speed: clamp(speed_limit * arrival_scale, 0.0, speed_limit),
        }
    }
}

// ===========================================================================
// waypoint-driver.ts — pose + waypoint + corner ⇒ which buttons the AI holds
// ===========================================================================

pub struct DriverInput {
    pub position: Vec3,
    pub yaw: f32,
    pub speed: f32,
    /// `None` ⇒ nothing to drive at: neutral controls (brake on).
    pub waypoint: Option<Vec3>,
    pub corner_magnitude: f32,
    /// The race gate. False before the lights and after the finish, and the
    /// car coasts to a stop on the brake — same as rally passing
    /// `raceStarted: race.raceState === RACE_STATES.STARTED`.
    pub race_started: bool,
    pub dt: f32,
}

/// The button state the brain holds this frame. `Default` is all-off, which is
/// NOT the same as the TS `neutralControls()` (that one holds the brake).
#[derive(Clone, Copy, Default, Debug)]
pub struct DriverControls {
    pub left: bool,
    pub right: bool,
    pub throttle: bool,
    pub reverse: bool,
    pub brake: bool,
    pub boost: bool,
}

impl DriverControls {
    /// `neutralControls()` — hands off the wheel and stands on the brake.
    const NEUTRAL: DriverControls = DriverControls {
        left: false,
        right: false,
        throttle: false,
        reverse: false,
        brake: true,
        boost: false,
    };
}

/// The AI driver: a proportional steer term, a corner-aware speed target, and
/// a stuck timer that backs out of walls.
///
/// The three constructor arguments are the three the `carBrain` op carries
/// (playset/sim/ops.ts `BrainConfig`); everything else stays on the TS
/// defaults but is left public so a future op can widen the config without
/// reshaping this type. `steer_bias` has no field at all: it is a per-step TS
/// input that rally never sets, so it is folded in as a constant 0.
pub struct WaypointDriver {
    pub target_speed: f32,
    pub min_speed: f32,
    pub corner_slowdown: f32,
    pub steer_gain: f32,
    pub steer_deadzone: f32,
    pub brake_yaw_threshold: f32,
    pub accelerate_speed_error: f32,
    pub brake_speed_error: f32,
    pub stuck_speed: f32,
    pub stuck_yaw_threshold: f32,
    /// Milliseconds, like the TS — the timers are authored in ms and the
    /// conversion (`dt * 1000`) is where the TS does it, so tuning transfers.
    pub stuck_time_ms: f32,
    pub reverse_time_ms: f32,
    stuck_ms: f32,
    reverse_remaining_ms: f32,
}

impl WaypointDriver {
    pub fn new(target_speed: f32, min_speed: f32, corner_slowdown: f32) -> Self {
        Self {
            target_speed,
            min_speed,
            corner_slowdown,
            steer_gain: 2.4,
            steer_deadzone: 0.12,
            brake_yaw_threshold: 0.88,
            accelerate_speed_error: 0.4,
            brake_speed_error: -0.9,
            stuck_speed: 0.35,
            stuck_yaw_threshold: 1.35,
            stuck_time_ms: 900.0,
            reverse_time_ms: 420.0,
            stuck_ms: 0.0,
            reverse_remaining_ms: 0.0,
        }
    }

    pub fn reset(&mut self) {
        self.stuck_ms = 0.0;
        self.reverse_remaining_ms = 0.0;
    }

    /// DELIBERATE NARROWING vs `WaypointDriverResult`: the TS result also
    /// reports `desiredSpeed`, `yawError`, `speedError` and `steerIntent` for
    /// tuning overlays. Nothing in the rally composition reads them — the
    /// throttle ease-off comes from the NAVIGATOR — so the native step returns
    /// controls only.
    pub fn step(&mut self, input: DriverInput) -> DriverControls {
        let dt_ms = if input.dt > 0.0 { input.dt * 1000.0 } else { 0.0 };

        if !input.race_started {
            return DriverControls::NEUTRAL;
        }
        let Some(waypoint) = input.waypoint else {
            return DriverControls::NEUTRAL;
        };

        let forward = heading_of(input.yaw);
        let to_target = planar_delta(input.position, waypoint);
        if to_target.len < EPS {
            return DriverControls::NEUTRAL;
        }

        let yaw_error = signed_yaw_error(forward, to_target);
        // Positive yaw error ⇒ the target is off to the RIGHT (see the sign
        // convention of `signed_yaw_error`), so a positive intent presses right.
        let steer_intent = clamp(yaw_error * self.steer_gain, -1.0, 1.0);

        let corner_penalty = input.corner_magnitude * self.corner_slowdown;
        let desired_speed = clamp(
            self.target_speed - corner_penalty,
            self.min_speed,
            self.target_speed,
        );
        let speed_error = desired_speed - input.speed;

        // Stuck = crawling while pointed badly wrong. The counter bleeds off
        // at 2x when unstuck, so a single bad frame never triggers recovery.
        let stuck = input.speed <= self.stuck_speed
            && math::fmath::abs(yaw_error) >= self.stuck_yaw_threshold;
        if stuck {
            self.stuck_ms += dt_ms;
            if self.stuck_ms >= self.stuck_time_ms {
                self.reverse_remaining_ms = self.reverse_time_ms;
                self.stuck_ms = 0.0;
            }
        } else {
            self.stuck_ms = if self.stuck_ms - dt_ms * 2.0 > 0.0 {
                self.stuck_ms - dt_ms * 2.0
            } else {
                0.0
            };
        }

        if self.reverse_remaining_ms > 0.0 {
            self.reverse_remaining_ms =
                if self.reverse_remaining_ms - dt_ms > 0.0 {
                    self.reverse_remaining_ms - dt_ms
                } else {
                    0.0
                };
            // NOTE the inverted steering: reversing out of a wall, holding the
            // wheel the "wrong" way is what swings the nose back on course.
            // Verbatim from the TS — do not "fix" it.
            return DriverControls {
                left: steer_intent > self.steer_deadzone,
                right: steer_intent < -self.steer_deadzone,
                throttle: false,
                reverse: true,
                brake: false,
                boost: false,
            };
        }

        let brake_for_turn = math::fmath::abs(yaw_error) >= self.brake_yaw_threshold
            && input.speed > desired_speed * 0.7;
        let brake = brake_for_turn || speed_error <= self.brake_speed_error;
        let throttle = speed_error >= self.accelerate_speed_error && !brake;

        DriverControls {
            left: steer_intent < -self.steer_deadzone,
            right: steer_intent > self.steer_deadzone,
            throttle,
            reverse: false,
            brake,
            // Boost only on a straight: any real steering cancels it.
            boost: throttle && math::fmath::abs(steer_intent) < 0.15,
        }
    }
}

/// `resolveForward(yaw)` — the planar heading of the yaw frame. Routed through
/// [`math::yaw_frame`] rather than open-coded `(-sin, cos)` so the driver and
/// the vehicle controller can never drift apart on the sign convention.
#[inline]
fn heading_of(yaw: f32) -> PlanarDir {
    let f = math::yaw_frame(yaw).forward;
    normalize_planar(right_of(f), forward_of(f))
}

/// `signedYawError` — the angle from `forward` to `desired`, positive when the
/// desired heading lies to the RIGHT of the current one.
#[inline]
fn signed_yaw_error(forward: PlanarDir, desired: PlanarDir) -> f32 {
    let dot = clamp(
        forward.right * desired.right + forward.forward * desired.forward,
        -1.0,
        1.0,
    );
    let right_turn_cross = forward.forward * desired.right - forward.right * desired.forward;
    acos(dot) * sign_or_positive(right_turn_cross)
}

// ===========================================================================
// race-checkpoint-lap-play.ts — checkpoints, laps, standings, finish order
// ===========================================================================

/// The per-player state the HUD polls (see the module header: the TS
/// `lap.completed` / `player.finished` events reduce to these two counters).
#[derive(Clone, Copy, Debug, Default)]
pub struct RacePlayer {
    pub completed_laps: u32,
    pub next_checkpoint: u32,
}

#[derive(Clone, Copy)]
struct Checkpoint {
    position: Vec3,
    radius_sq: f32,
}

#[derive(Clone, Copy)]
struct PlayerState {
    position: Vec3,
    completed_laps: u32,
    next_checkpoint: u32,
    finished: bool,
    /// 1-based, 0 = not finished (the TS `finishOrder: number | null`).
    finish_order: u32,
}

/// The four TS `RACE_STATES`, minus the countdown.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Waiting,
    Started,
    Finished,
}

/// Checkpoint-lap race state: countdown-free, allocation-free, insertion-ordered.
pub struct RacePlay {
    checkpoints: Vec<Checkpoint>,
    lap_count: u32,
    players: Vec<PlayerState>,
    state: State,
    elapsed_seconds: f32,
    finish_counter: u32,
}

impl RacePlay {
    /// DEVIATION: the TS `startingDelaySeconds` (and with it the `STARTING`
    /// state) is not ported. rally leaves it at 0, the `raceInit` op carries no
    /// field for it, and a native countdown would be a second clock to keep
    /// deterministic for no guest that asks. A guest that wants lights can hold
    /// off calling [`start`](Self::start) — which is exactly what `STARTING`
    /// did to the sim anyway.
    pub fn new(lap_count: u32) -> Self {
        Self {
            checkpoints: Vec::new(),
            lap_count,
            players: Vec::new(),
            state: State::Waiting,
            elapsed_seconds: 0.0,
            finish_counter: 0,
        }
    }

    /// Assembly time only; checkpoints are visited in push order, which IS the
    /// lap order (`checkpointPerLap` is just how many there are).
    pub fn push_checkpoint(&mut self, position: Vec3, radius: f32) {
        self.checkpoints.push(Checkpoint {
            position,
            radius_sq: radius * radius,
        });
    }

    /// Returns the player index — the native stand-in for the TS `playerId`
    /// string key. Ids exist in the TS so a `Map` can be keyed and standings
    /// tie-broken by `localeCompare`; here the index is the identity AND the
    /// tie-break, which is both cheaper and more obviously deterministic.
    ///
    /// The TS throws when the race has already started; ops are intent, so
    /// this is inert instead (an out-of-range index is harmless everywhere).
    pub fn add_player(&mut self, position: Vec3) -> usize {
        if self.state != State::Waiting {
            return usize::MAX;
        }
        self.players.push(PlayerState {
            position,
            completed_laps: 0,
            next_checkpoint: 0,
            finished: false,
            finish_order: 0,
        });
        self.players.len() - 1
    }

    /// `startGame()` without the countdown branch. Inert unless waiting with
    /// at least one player (the TS throws in both cases).
    pub fn start(&mut self) {
        if self.state != State::Waiting || self.players.is_empty() {
            return;
        }
        self.reset_progress();
        self.state = State::Started;
    }

    pub fn is_started(&self) -> bool {
        self.state == State::Started
    }

    /// The HUD's `state` float (playset/sim/ops.ts `HUD.state`):
    /// **0 = waiting, 1 = started, 2 = finished**.
    ///
    /// The TS `RACE_STATES` order is WAITING, STARTING, STARTED, FINISHED;
    /// dropping the unreachable STARTING (see [`new`](Self::new)) leaves the
    /// remaining three in their TS order, which is what the guest contract
    /// pins. A restored countdown would report 0 with the waiting state — it
    /// is "not racing yet" from the HUD's point of view.
    pub fn state_code(&self) -> f32 {
        match self.state {
            State::Waiting => 0.0,
            State::Started => 1.0,
            State::Finished => 2.0,
        }
    }

    pub fn update_player(&mut self, player: usize, position: Vec3) {
        if let Some(p) = self.players.get_mut(player) {
            p.position = position;
        }
    }

    /// Advance the state machine and return how many checkpoints were passed
    /// this step (at most one per player — see the module header on why this
    /// is a count and not an event list).
    pub fn step(&mut self, dt: f32) -> u32 {
        if self.state != State::Started {
            return 0;
        }
        self.elapsed_seconds += dt;

        let mut passed = 0u32;
        for i in 0..self.players.len() {
            passed += self.step_player(i);
        }
        self.finish_race_if_complete();
        passed
    }

    /// Out-of-range players report a zeroed state rather than panicking: a car
    /// created after `raceInit` carries `usize::MAX` and still reads its HUD.
    pub fn player(&self, player: usize) -> RacePlayer {
        self.players
            .get(player)
            .map_or(RacePlayer::default(), |p| RacePlayer {
                completed_laps: p.completed_laps,
                next_checkpoint: p.next_checkpoint,
            })
    }

    /// First place in the standings.
    ///
    /// `getStandings()` sorts everyone; the only consumer (`HUD.rivalLeads`)
    /// asks who is first, so this is a single pass under the same ordering:
    /// finishers first by finish order, then most laps, then furthest through
    /// the current lap. The TS final tie-break is `playerId.localeCompare`;
    /// here equal-progress players tie-break by insertion order, which for
    /// rally's `["player", "rival"]` picks the same car.
    pub fn leader(&self) -> usize {
        let mut best = 0usize;
        for i in 1..self.players.len() {
            if leads(&self.players[i], &self.players[best]) {
                best = i;
            }
        }
        best
    }

    /// Race time in seconds, accumulated from the `step` dt (the TS
    /// `elapsedSeconds`, which backed the unexported `finishTimeSeconds`).
    pub fn elapsed_seconds(&self) -> f32 {
        self.elapsed_seconds
    }

    fn reset_progress(&mut self) {
        self.elapsed_seconds = 0.0;
        self.finish_counter = 0;
        for p in &mut self.players {
            p.completed_laps = 0;
            p.next_checkpoint = 0;
            p.finished = false;
            p.finish_order = 0;
        }
    }

    /// `_stepPlayer` — one checkpoint per player per step, max.
    fn step_player(&mut self, i: usize) -> u32 {
        let per_lap = self.checkpoints.len() as u32;
        if per_lap == 0 {
            return 0;
        }
        let p = &mut self.players[i];
        if p.finished {
            return 0;
        }
        let cp = self.checkpoints[p.next_checkpoint as usize];
        // Sphere test in FULL 3D, like the TS — a gate you fly over does not
        // count, which is why the checkpoint radii are authored generously.
        if p.position.distance_squared(cp.position) > cp.radius_sq {
            return 0;
        }

        p.next_checkpoint += 1;
        if p.next_checkpoint < per_lap {
            return 1;
        }

        p.next_checkpoint = 0;
        p.completed_laps += 1;
        if p.completed_laps < self.lap_count {
            return 1;
        }

        self.finish_counter += 1;
        p.finished = true;
        p.finish_order = self.finish_counter;
        1
    }

    fn finish_race_if_complete(&mut self) {
        if self.state != State::Started || self.players.is_empty() {
            return;
        }
        if self.players.iter().any(|p| !p.finished) {
            return;
        }
        self.state = State::Finished;
    }
}

/// The `getStandings()` comparator, reduced to "does `a` outrank `b`". Ties
/// return false so the earlier-inserted player keeps the place.
fn leads(a: &PlayerState, b: &PlayerState) -> bool {
    if a.finished && b.finished {
        return a.finish_order < b.finish_order;
    }
    if a.finished {
        return true;
    }
    if b.finished {
        return false;
    }
    if a.completed_laps != b.completed_laps {
        return a.completed_laps > b.completed_laps;
    }
    a.next_checkpoint > b.next_checkpoint
}

// ===========================================================================
// pose-follow-camera-rig.ts — the chase camera
// ===========================================================================

/// Pack a pose-relative offset for [`CameraRigCfg`]. The TS rigs take
/// `{forward, up, right}` objects; the native cfg carries the same three
/// scalars in one `Vec3`, encoded with [`math::from_basis`] — so rally's
/// `cameraOffset: { forward: -7.5, up: 3.4, right: 0 }` is
/// `pose_offset(0.0, 3.4, -7.5)`.
///
/// ALWAYS build the cfg offsets with this (or `math::from_basis` directly):
/// the encoding is NOT `Vec3::new(right, up, forward)` — the forward component
/// lands on the negated axis, because that is what the world basis says the
/// forward axis is.
#[inline]
pub fn pose_offset(right: f32, up: f32, forward: f32) -> Vec3 {
    from_basis(right, up, forward)
}

pub struct CameraRigCfg {
    /// Where the eye sits relative to the target's pose. See [`pose_offset`].
    pub camera_offset: Vec3,
    /// Where the eye looks relative to the target's pose. See [`pose_offset`].
    pub look_at_offset: Vec3,
    /// Added to `camera_offset` scaled by speed — the pull-back that makes
    /// speed legible. See [`pose_offset`].
    pub speed_camera_offset: Vec3,
    /// Seconds of exponential lag; 0 pins the eye to the target rigidly.
    pub position_lag: f32,
    pub look_lag: f32,
}

/// A third-person chase camera that follows a pose, not just a point: the
/// offsets ride the target's frame, so the view swings with the car.
///
/// DEVIATIONS from `PoseFollowCameraRig`, all of them "rally never used it":
/// - `speedLookAtOffset` is dropped (rally leaves it zero; `speedCameraOffset`
///   alone is what sells the speed).
/// - `heightVectorSource` / `lookHeightVectorSource` are fixed at the default
///   `frameUp` — the offsets ride the BODY's up, which is what banks the view
///   on a cambered road. `basisUp` would be a second cfg flag for no caller.
/// - `rotationMode` is fixed at the default `lookAt`; the `frame` mode's
///   smoothed `forward`/`up` state (and `frameLag`) is dead code under it,
///   since `setLookAtPose` recomputes both from position and look-at anyway.
/// - `snapToTarget` is not a step input; the FIRST step still snaps, exactly
///   as the TS does via `initialized` (see [`step`](Self::step)).
pub struct CameraRig {
    cfg: CameraRigCfg,
    position: Vec3,
    look_at: Vec3,
    /// False until the first step has landed a pose — the TS `BaseCameraRig`
    /// flag that makes the first frame snap instead of easing in from the
    /// origin.
    initialized: bool,
}

impl CameraRig {
    pub fn new(cfg: CameraRigCfg) -> Self {
        Self {
            cfg,
            // `BaseCameraRig`'s constructor: position at the origin, look-at
            // one unit down the basis forward. Both are overwritten by the
            // first (snapping) step; they matter only if someone reads the rig
            // before stepping it.
            position: Vec3::ZERO,
            look_at: Vec3::NEG_Z,
            initialized: false,
        }
    }

    /// Returns `(eye position, orientation)`.
    ///
    /// The TS rig mutates a camera object and leans on three.js
    /// `Object3D.lookAt`; here the look rotation is built directly. It is the
    /// same rotation: `lookAt` builds the basis `(x, y, z)` with
    /// `z = normalize(eye - target)`, `x = normalize(camera.up × z)`,
    /// `y = z × x`, and `applyToCamera` had already set `camera.up` to the
    /// rig's orthonormalized up. Substituting gives `x = right`, `y = up`,
    /// `z = -forward` — precisely [`Frame::to_quat`]'s columns. So the camera
    /// still looks down its local −Z, and the conversion reuses the same
    /// matrix→quaternion path every visual pose uses.
    pub fn step(
        &mut self,
        target_position: Vec3,
        target_frame: Frame,
        target_speed: f32,
        dt: f32,
    ) -> (Vec3, Quat) {
        let speed = if target_speed > 0.0 { target_speed } else { 0.0 };
        // `offsetForSpeed` is componentwise on the basis scalars, and the
        // encoding is linear, so it is one vector mul-add here.
        let camera_offset = self.cfg.camera_offset + self.cfg.speed_camera_offset * speed;

        let desired_position = offset_against(target_position, target_frame, camera_offset);
        let desired_look_at = offset_against(target_position, target_frame, self.cfg.look_at_offset);

        self.position = smooth_vec(
            self.position,
            desired_position,
            self.cfg.position_lag,
            dt,
            self.initialized,
        );
        self.look_at = smooth_vec(
            self.look_at,
            desired_look_at,
            self.cfg.look_lag,
            dt,
            self.initialized,
        );

        // `setLookAtPose`: re-square the view frame against the target's up.
        // The TS degeneracy guards trip at lengthSq <= 1e-12; `normalize_or`
        // trips at exactly zero. The gap is a view vector shorter than a
        // micron, where "which way is forward" is noise either way.
        let forward = math::normalize_or(self.look_at - self.position, Vec3::NEG_Z);
        let right = math::normalize_or(forward.cross(target_frame.up), Vec3::X);
        let up = math::normalize_or(right.cross(forward), math::UP);
        self.initialized = true;

        (self.position, Frame { right, up, forward }.to_quat())
    }

    /// The eye position as of the last step (diagnostics/tests).
    pub fn position(&self) -> Vec3 {
        self.position
    }
}

/// `addScaledVector(frame.forward, o.forward).addScaledVector(frame.right,
/// o.right).addScaledVector(heightVector, o.up)` — in that order, because f32
/// addition is not associative and the TS order is the one parity is measured
/// against.
#[inline]
fn offset_against(origin: Vec3, frame: Frame, offset: Vec3) -> Vec3 {
    origin
        + frame.forward * forward_of(offset)
        + frame.right * right_of(offset)
        + frame.up * up_of(offset)
}

/// `BaseCameraRig.smoothVector`. Snapping is a separate branch from lerping
/// with alpha = 1: `a + (b - a) * 1.0` is NOT exactly `b` in f32 once the two
/// are far apart, and the first frame is exactly that case.
#[inline]
fn smooth_vec(current: Vec3, target: Vec3, lag: f32, dt: f32, initialized: bool) -> Vec3 {
    if !initialized || lag <= 0.0 {
        return target;
    }
    // One `exp` for the whole vector — `smooth_toward` per component would
    // pay for three, and this runs every frame.
    current.lerp(target, math::smoothing_alpha(lag, dt))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 40x40 square circuit, corners in counter-clockwise planar order.
    fn square_route() -> [Vec3; 4] {
        [
            from_basis(-20.0, 0.0, -20.0),
            from_basis(20.0, 0.0, -20.0),
            from_basis(20.0, 0.0, 20.0),
            from_basis(-20.0, 0.0, 20.0),
        ]
    }

    // -- waypoint-progress-tracker ------------------------------------------

    #[test]
    fn tracker_advances_on_reach_and_wraps_when_closed() {
        let route = square_route();
        let mut t = WaypointTracker::new(&route, 4.0, true);
        t.reset(0);

        // Far from waypoint 0: still aiming at it.
        let p = t.step(Vec3::ZERO);
        assert_eq!(p.waypoint, Some(route[0]));
        assert_eq!(t.index(), 0);

        // Inside the reach distance: advance one, and report the NEW waypoint.
        let p = t.step(route[0]);
        assert_eq!(p.waypoint, Some(route[1]));
        assert_eq!(t.index(), 1);

        // Walk to the last waypoint and wrap back to the start.
        t.reset(3);
        let p = t.step(route[3]);
        assert_eq!(p.waypoint, Some(route[0]));
        assert_eq!(t.index(), 0);
    }

    #[test]
    fn tracker_open_path_stops_at_the_end() {
        let route = square_route();
        let mut t = WaypointTracker::new(&route, 4.0, false);
        t.reset(3);
        let p = t.step(route[3]);
        assert_eq!(p.waypoint, Some(route[3]));
        assert_eq!(t.index(), 3);
        // Endpoint of an open path has no corner.
        assert_eq!(p.corner_magnitude, 0.0);
    }

    #[test]
    fn tracker_snaps_to_the_nearest_waypoint_when_uninitialized() {
        let route = square_route();
        let mut t = WaypointTracker::new(&route, 1.0, true);
        // Nearest to waypoint 2, and further than reach, so no advance.
        let p = t.step(from_basis(18.0, 0.0, 18.0));
        assert_eq!(p.waypoint, Some(route[2]));
    }

    #[test]
    fn tracker_reports_right_angle_corners() {
        let route = square_route();
        let mut t = WaypointTracker::new(&route, 1.0, true);
        t.reset(1);
        let p = t.step(Vec3::ZERO);
        // Square circuit ⇒ every corner turns by 90°.
        assert!((p.corner_magnitude - core::f32::consts::FRAC_PI_2).abs() < 1e-4);
    }

    #[test]
    fn tracker_without_waypoints_is_inert() {
        let mut t = WaypointTracker::new(&[], 4.0, true);
        let p = t.step(Vec3::ZERO);
        assert!(p.waypoint.is_none());
        assert_eq!(p.corner_magnitude, 0.0);
    }

    // -- agent-path-navigator ------------------------------------------------

    #[test]
    fn navigator_eases_speed_inside_the_arrive_radius() {
        let nav = PathNavigator::new(14.0, 10.0);
        let origin = Vec3::ZERO;

        // Beyond the radius: full speed.
        assert_eq!(nav.step(origin, Some(from_basis(20.0, 0.0, 0.0))).desired_speed, 14.0);
        // Halfway in: half speed.
        assert!((nav.step(origin, Some(from_basis(5.0, 0.0, 0.0))).desired_speed - 7.0).abs() < 1e-5);
        // On the waypoint: stop. Height never counts — the test point is 3
        // units up and still reads as arrived.
        assert_eq!(nav.step(origin, Some(from_basis(0.0, 3.0, 0.0))).desired_speed, 0.0);
        // No waypoint: stop.
        assert_eq!(nav.step(origin, None).desired_speed, 0.0);
    }

    // -- waypoint-driver -----------------------------------------------------

    fn driver_input(waypoint: Vec3, speed: f32, corner: f32) -> DriverInput {
        DriverInput {
            position: Vec3::ZERO,
            yaw: 0.0,
            speed,
            waypoint: Some(waypoint),
            corner_magnitude: corner,
            race_started: true,
            dt: 1.0 / 60.0,
        }
    }

    #[test]
    fn driver_steers_toward_a_waypoint_off_to_one_side() {
        let mut d = WaypointDriver::new(14.0, 5.0, 8.0);

        // yaw 0 faces planar forward; the waypoint is 90° to the right.
        let c = d.step(driver_input(from_basis(10.0, 0.0, 0.0), 0.0, 0.0));
        assert!(c.right && !c.left);
        assert!(c.throttle && !c.brake);
        assert!(!c.boost, "a full-lock turn must cancel the boost");

        // Mirror image.
        let mut d = WaypointDriver::new(14.0, 5.0, 8.0);
        let c = d.step(driver_input(from_basis(-10.0, 0.0, 0.0), 0.0, 0.0));
        assert!(c.left && !c.right);

        // Dead ahead and stationary: throttle, no steering, boost.
        let mut d = WaypointDriver::new(14.0, 5.0, 8.0);
        let c = d.step(driver_input(from_basis(0.0, 0.0, 10.0), 0.0, 0.0));
        assert!(c.throttle && !c.left && !c.right && c.boost);
    }

    #[test]
    fn driver_brakes_into_corners() {
        let mut d = WaypointDriver::new(14.0, 5.0, 8.0);
        // Corner of 1.2 rad ⇒ penalty 9.6 ⇒ desired speed clamps to min 5,
        // so arriving at 14 is 9 too fast: brake, no throttle.
        let c = d.step(driver_input(from_basis(0.0, 0.0, 10.0), 14.0, 1.2));
        assert!(c.brake && !c.throttle);

        // The same corner taken slowly is not a braking event.
        let c = d.step(driver_input(from_basis(0.0, 0.0, 10.0), 4.0, 1.2));
        assert!(!c.brake && c.throttle);
    }

    #[test]
    fn driver_holds_the_brake_before_the_lights_and_without_a_waypoint() {
        let mut d = WaypointDriver::new(14.0, 5.0, 8.0);
        let mut input = driver_input(from_basis(0.0, 0.0, 10.0), 0.0, 0.0);
        input.race_started = false;
        let c = d.step(input);
        assert!(c.brake && !c.throttle && !c.left && !c.right);

        let mut input = driver_input(Vec3::ZERO, 0.0, 0.0);
        input.waypoint = None;
        let c = d.step(input);
        assert!(c.brake && !c.throttle);
    }

    #[test]
    fn driver_reverses_out_of_a_stuck_pose() {
        let mut d = WaypointDriver::new(14.0, 5.0, 8.0);
        // Waypoint directly behind, car stopped: 180° of yaw error at 0 m/s
        // is the stuck signature. 900 ms of it triggers the recovery.
        let mut reversed = false;
        for _ in 0..60 {
            let c = d.step(driver_input(from_basis(0.0, 0.0, -10.0), 0.0, 0.0));
            if c.reverse {
                reversed = true;
                assert!(!c.throttle && !c.brake);
                break;
            }
        }
        assert!(reversed, "900 ms stuck must trigger reverse recovery");
    }

    // -- race-checkpoint-lap-play --------------------------------------------

    fn two_gate_race(lap_count: u32) -> (RacePlay, Vec3, Vec3) {
        let a = from_basis(0.0, 0.0, 10.0);
        let b = from_basis(0.0, 0.0, -10.0);
        let mut race = RacePlay::new(lap_count);
        race.push_checkpoint(a, 5.0);
        race.push_checkpoint(b, 5.0);
        (race, a, b)
    }

    #[test]
    fn race_counts_gates_completes_laps_and_finishes() {
        let (mut race, gate_a, gate_b) = two_gate_race(2);
        let p = race.add_player(Vec3::ZERO);
        assert_eq!(p, 0);
        assert_eq!(race.state_code(), 0.0);

        race.start();
        assert!(race.is_started());
        assert_eq!(race.state_code(), 1.0);

        // Parked between the gates: nothing happens.
        assert_eq!(race.step(1.0 / 60.0), 0);
        assert_eq!(race.player(p).next_checkpoint, 0);

        // Gate 0.
        race.update_player(p, gate_a);
        assert_eq!(race.step(1.0 / 60.0), 1);
        assert_eq!(race.player(p).next_checkpoint, 1);
        assert_eq!(race.player(p).completed_laps, 0);

        // Gate 1 closes lap 1 and rearms the first gate.
        race.update_player(p, gate_b);
        assert_eq!(race.step(1.0 / 60.0), 1);
        assert_eq!(race.player(p).completed_laps, 1);
        assert_eq!(race.player(p).next_checkpoint, 0);
        assert!(race.is_started());

        // Lap 2 finishes the race.
        race.update_player(p, gate_a);
        assert_eq!(race.step(1.0 / 60.0), 1);
        race.update_player(p, gate_b);
        assert_eq!(race.step(1.0 / 60.0), 1);
        assert_eq!(race.player(p).completed_laps, 2);
        assert!(!race.is_started());
        assert_eq!(race.state_code(), 2.0);

        // A finished race stops counting.
        race.update_player(p, gate_a);
        assert_eq!(race.step(1.0 / 60.0), 0);
        assert!((race.elapsed_seconds() - 5.0 / 60.0).abs() < 1e-6);
    }

    #[test]
    fn race_leader_tracks_progress_then_finish_order() {
        let (mut race, gate_a, _gate_b) = two_gate_race(2);
        let p = race.add_player(Vec3::ZERO);
        let rival = race.add_player(Vec3::ZERO);
        race.start();

        // Dead even ⇒ insertion order wins (the TS tie-breaks on player id).
        assert_eq!(race.leader(), p);

        // The rival takes a gate: more progress this lap ⇒ it leads.
        race.update_player(rival, gate_a);
        assert_eq!(race.step(1.0 / 60.0), 1);
        assert_eq!(race.leader(), rival);
    }

    #[test]
    fn race_ignores_gates_the_car_only_flew_over() {
        let (mut race, gate_a, _) = two_gate_race(1);
        let p = race.add_player(Vec3::ZERO);
        race.start();
        // 8 units above a radius-5 gate: the test is a 3D sphere, not planar.
        race.update_player(p, gate_a + Vec3::new(0.0, 8.0, 0.0));
        assert_eq!(race.step(1.0 / 60.0), 0);
    }

    // -- pose-follow-camera-rig ----------------------------------------------

    fn rally_rig() -> CameraRig {
        CameraRig::new(CameraRigCfg {
            camera_offset: pose_offset(0.0, 3.4, -7.5),
            look_at_offset: pose_offset(0.0, 1.1, 5.0),
            speed_camera_offset: pose_offset(0.0, 0.0, 0.0),
            position_lag: 0.16,
            look_lag: 0.1,
        })
    }

    #[test]
    fn camera_snaps_behind_the_target_on_the_first_step() {
        let mut rig = rally_rig();
        let (eye, _) = rig.step(Vec3::ZERO, Frame::IDENTITY, 0.0, 1.0 / 60.0);
        // forward = -Z, so 7.5 BEHIND the car is +Z; up is +Y.
        assert!((eye - Vec3::new(0.0, 3.4, 7.5)).length() < 1e-5);
    }

    #[test]
    fn camera_converges_to_the_chase_offset() {
        let mut rig = rally_rig();
        // First step snaps to the origin pose, then the target jumps away and
        // the rig has to ease all the way there.
        rig.step(Vec3::ZERO, Frame::IDENTITY, 0.0, 1.0 / 60.0);

        let target = Vec3::new(30.0, 0.0, -12.0);
        let mut eye = Vec3::ZERO;
        let mut rot = Quat::IDENTITY;
        for _ in 0..240 {
            let out = rig.step(target, Frame::IDENTITY, 0.0, 1.0 / 60.0);
            eye = out.0;
            rot = out.1;
        }
        let expected_eye = target + Vec3::new(0.0, 3.4, 7.5);
        assert!((eye - expected_eye).length() < 1e-3, "eye = {eye:?}");

        // And it really is LOOKING at the look-at point: the camera's local
        // -Z must land on the direction from the eye to the target's aim.
        let expected_look = target + Vec3::new(0.0, 1.1, -5.0);
        let want = (expected_look - expected_eye).normalize();
        let got = rot * Vec3::NEG_Z;
        assert!((got - want).length() < 1e-3, "got {got:?}, want {want:?}");
    }

    #[test]
    fn camera_offsets_ride_the_target_frame() {
        // Yawed a quarter turn: the chase offset must swing with the car, not
        // stay pinned to the world axes.
        let yaw = core::f32::consts::FRAC_PI_2;
        let frame = math::yaw_frame(yaw);
        let mut rig = rally_rig();
        let (eye, _) = rig.step(Vec3::ZERO, frame, 0.0, 1.0 / 60.0);
        let expected = frame.forward * -7.5 + frame.up * 3.4;
        assert!((eye - expected).length() < 1e-4, "eye = {eye:?}");
    }

    #[test]
    fn camera_speed_offset_pulls_back_with_speed() {
        let mut rig = CameraRig::new(CameraRigCfg {
            camera_offset: pose_offset(0.0, 3.4, -7.5),
            look_at_offset: pose_offset(0.0, 1.1, 5.0),
            speed_camera_offset: pose_offset(0.0, 0.01, -0.03),
            position_lag: 0.0,
            look_lag: 0.0,
        });
        let (eye, _) = rig.step(Vec3::ZERO, Frame::IDENTITY, 20.0, 1.0 / 60.0);
        // forward -7.5 - 0.03*20 = -8.1 ⇒ +8.1 behind; up 3.4 + 0.01*20 = 3.6.
        assert!((eye - Vec3::new(0.0, 3.6, 8.1)).length() < 1e-4, "eye = {eye:?}");
    }
}
