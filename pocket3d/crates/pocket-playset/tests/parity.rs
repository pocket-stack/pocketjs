//! TRAJECTORY PARITY: does the native f32 core actually drive like the TS
//! reference over a long run?
//!
//! The TS modules under `playset/modules/` are THE reference implementation
//! (playset/sim/ops.ts) and byte-exact goldens pin them. This crate is their
//! native f32 twin, and f32-vs-f64 means the two are trajectory-equivalent and
//! NEVER bit-equivalent — so no byte-exact golden can pin this side. What can,
//! and what this file is, is a BOUNDED-DIVERGENCE test: assemble the rally
//! world exactly as `demos/rally/game.ts` assembles it through the `ps.*` ops,
//! replay the same 600-frame button tape, and assert that the two cars stay on
//! the same drive.
//!
//! THE FIXTURE. `tests/fixtures/rally-parity.json` is a golden written by
//!
//!     bun playset/test/gen-parity-fixture.ts
//!
//! from the repo root (`--check` verifies it is current without rewriting it).
//! The generator boots demos/rally/game.ts twice: once with a recording `ps`
//! installed, which captures the assembly op stream verbatim (terrain grid,
//! all 528 colliders, both tunings and spawns, the rival's brain, the race,
//! the camera rig), and once with no `ps` at all, which runs the TS core and
//! samples its trajectory. So the assembly below is not a hand-copy of the
//! demo's constants that can rot — it is the demo's own op payloads.
//!
//! WHEN IT FAILS, LOOK AT THE NUMBERS FIRST:
//!
//!     PARITY_DUMP=1 cargo test -p pocket-playset --test parity -- --nocapture
//!
//! prints every sampled frame's divergence, decomposed. A porting bug does not
//! look like a bound being slightly exceeded at the end; it looks like one
//! channel departing early and never coming back.

#![cfg(feature = "std")]

use glam::Vec3;
use pocket_playset::behavior::{
    pose_offset, CameraRig, CameraRigCfg, PathNavigator, RacePlay, WaypointDriver, WaypointTracker,
};
use pocket_playset::terrain::{Heightfield, Terrain};
use pocket_playset::vehicle::CarTuning;
use pocket_playset::world::{World, HUD_FLOATS};
use pocket_playset::{collider_kind, COLLIDER_FLAG_SOLID, COLLIDER_FLAG_WALKABLE, COLLIDER_STRIDE};
use pocket_scene3d::Store;
use pocketjs_core::spec::btn;
use serde_json::Value;

// ===========================================================================
// the bounds, and what each one is watching for
// ===========================================================================
//
// HOW THE DIVERGENCE ACTUALLY BEHAVES, measured over the 600-frame tape (these
// are the numbers `PARITY_DUMP=1` prints today):
//
//     along-track  (phase)        max 0.1372 u    at frame 340
//     cross-track  (racing line)  max 0.0483 u    at frame 330
//     vertical                    max 0.0428 u    at frame 100
//     heading                     max 1.768 deg   at frame 125
//     speed                       max 0.0610 u/s  at frame 125 (v = 11.7)
//     rival planar                max 0.0918 u    at frame 590
//     checkpoints                 7 vs 7; one sample (485) caught a gate in
//                                 flight, reconverged by 490
//
// THE KEY OBSERVATION, and the reason planar error is split in two: almost all
// of it is PHASE. The native car is ~0.137 u further along the same line — 9 ms
// of travel at 14.5 u/s — because f32 rounds the first few frames' velocity
// integration slightly differently. Its deviation FROM that line, which is the
// thing that actually means "driving differently", stays under 0.05 u for the
// whole run and does not grow.
//
// Lumping the two together would force a bound loose enough to swallow the
// phase, and a bound that loose is exactly the one a real bug slips through.
// So along-track gets a growing bound (it is a genuine random walk in the
// integration) and cross-track gets a tight flat one (it is not: both cars are
// steered back onto the same road every frame).
//
// The heading and vertical errors are phase too, and their magnitudes confirm
// that arithmetically rather than by hand-waving: at the ~176 deg/s yaw rate
// this car reaches mid-corner, 9 ms of phase IS 1.6 degrees, which is what
// frame 125 measures; and 0.137 u of phase across terrain of this roughness is
// a few centimetres of height, which is what frame 100 measures. Nothing in
// the table above is unexplained.
//
// Every bound below sits 3-6x above its measurement. That is not timidity:
// both cores are bit-deterministic (the Rust side routes every transcendental
// through `libm` precisely so it cannot vary by host — see terrain.rs), so
// these numbers do not wobble between runs, and the headroom exists only to
// absorb legitimate refactors. Meanwhile the bug classes named below are all
// 10x to 1000x over, never 2x: a sign error in a steering term is a car in the
// trees within a second, not a car 30 cm off.

/// CROSS-TRACK drift: how far the native car sits from the reference's racing
/// line, perpendicular to the reference's own heading. Flat, because it does
/// not accumulate — the tape steers both cars down the same road.
///
/// This is the strongest assertion in the file. CATCHES: a sign error or
/// swapped axis anywhere in the steer/resolve chain — vehicle.rs's yaw
/// integration, resolver.rs's push-out direction, collision.rs's penetration
/// normal, terrain.rs's `(right, forward)` argument order, math.rs's
/// `from_basis` forward-axis negation. Each of those puts the car on the wrong
/// side of the road inside one corner, which is metres, not centimetres. The
/// car is 1.8 u wide; 0.25 u is still the same tyre tracks.
const MAX_CROSS_TRACK: f64 = 0.25;

/// ALONG-TRACK drift: how far ahead of (or behind) the reference the native
/// car is, along the reference's heading. It grows, so the bound does too.
///
/// CATCHES: anything that changes the speed *curve* rather than the line — a
/// dropped engine-brake term, a mis-scaled `throttle_accel`, a clamp applied
/// before instead of after the integration. Those produce a phase error that
/// keeps growing linearly and blows through this within a second or two; f32
/// rounding produces one that plateaus, which is what the measurement does
/// (0.121 u by frame 235, 0.137 u at frame 340, back to 0.103 u at frame 600).
///
/// The floor is what it is because the plateau is reached EARLY — the binding
/// measurement is frame 235, not frame 600 — so a floor small enough to look
/// impressive would leave the first four seconds with no headroom at all.
const ALONG_FLOOR: f64 = 0.12;
const ALONG_SLOPE_PER_SEC: f64 = 0.06;

/// Vertical drift. Flat: height is a bilinear lookup into the shipped grid
/// plus a ride height, with no integration to accumulate error, so all that
/// reaches it is the along-track phase sampled on a bumpy surface.
///
/// CATCHES: a transposed heightfield (row/col swap), an off-by-one in the
/// bilinear cell index, a wrong grid step (`size / side` instead of
/// `size / (side - 1)`), a dropped ride-height term. Every one of those is
/// tens of centimetres on this terrain — the grid's cell is 3.1 u wide and the
/// field swings +/- 2.6 u — and a transpose is metres.
const MAX_VERTICAL: f64 = 0.20;

/// Angle between the two body-frame forward vectors, in degrees, in full 3D.
/// Full 3D and not planar yaw on purpose: a body frame that lost its
/// terrain-normal tilt, or gained a mirrored one, is exactly the bug a planar
/// comparison waves through.
///
/// CATCHES: a sign error in `steer_angle_max` / `steer_lag`, the wrong
/// rotation sense in the yaw integration, a left-handed body frame, the classic
/// euler-axis-order mistake in `quat_from_euler_xyz`. A mirrored steer is 30+
/// degrees out before the first corner ends and 180 out by the end of it.
const MAX_HEADING_DEG: f64 = 5.0;

/// Tangent speed. Absolute term because the tape starts from rest, where a
/// purely relative bound is meaningless; relative term because at 14.5 u/s an
/// absolute-only bound would have to be uselessly loose.
///
/// CATCHES: a dropped drag term, a wrong throttle ease-off
/// (`nav.desired_speed / max_speed`), a `max_forward_speed` clamp on the wrong
/// quantity, a brake blended in with the wrong weight. Each of those moves the
/// speed curve by whole units per second — 20x this bound at cruise.
const SPEED_ABS: f64 = 0.12;
const SPEED_REL: f64 = 0.015;

/// The AI rival, planar and undecomposed (the trace carries its position but
/// not its heading, and its own steering would make an along/cross split
/// meaningless anyway). It is a genuinely different measurement from the
/// player's: no button tape holds it on course, only the brain reacting to its
/// own slightly different position — so this is the closed-loop check on the
/// whole behaviour stack.
///
/// CATCHES: the tracker advancing on the wrong index or at the wrong reach
/// distance, corner magnitude with the wrong sign, the navigator's arrive
/// radius inverted, the driver steering at a waypoint the tracker already
/// retired. All of those send the AI car off the circuit within a couple of
/// seconds, which is tens of units.
///
/// FLAT, unlike the player's along-track bound, and for a reason worth
/// stating: the rival is a closed-loop controller steering at fixed waypoints,
/// so its error is corrected rather than integrated. The measurement agrees —
/// it climbs to ~0.08 u within two seconds and then just oscillates there for
/// the remaining eight (0.0786 at frame 155, 0.0918 at frame 590). A growing
/// bound would be modelling something that is not happening.
const MAX_RIVAL_PLANAR: f64 = 0.35;

/// Checkpoint passes are integers from a radius test, so they are the one
/// channel with no float tolerance to spend — but they are also a CUMULATIVE
/// counter read on a 5-frame sampling grid, and 9 ms of phase can put a gate
/// crossing on either side of a sample boundary. So: never more than one gate
/// in flight, and dead equal at the end of the run (asserted separately, below
/// the report).
///
/// That pair is what makes this strong. A porting bug in the race module — an
/// inverted radius comparison, a lap wrap off by one, a player index that
/// never advances — does not produce a one-sample blip that heals; it produces
/// a difference that persists to the final frame, where the tolerance is zero.
const MAX_GATES_IN_FLIGHT: i64 = 1;

// Trace row layout — keep in sync with `traceLayout` in the fixture.
const T_FRAME: usize = 0;
const T_PX: usize = 1;
const T_PY: usize = 2;
const T_PZ: usize = 3;
const T_FX: usize = 4;
const T_FY: usize = 5;
const T_FZ: usize = 6;
const T_SPEED: usize = 7;
const T_GATES: usize = 8;
const T_RX: usize = 9;
/// Traced for completeness, not asserted: the player already pins the terrain
/// sampler and the rival's height adds no independent information.
#[allow(dead_code)]
const T_RY: usize = 10;
const T_RZ: usize = 11;

// HUD mirror offsets (playset/sim/ops.ts `HUD`).
const H_SPEED: usize = 2;
const H_GATES: usize = 4;
const H_PX: usize = 6;
const H_FX: usize = 9;
const H_RX: usize = 12;

// ===========================================================================
// fixture decoding
// ===========================================================================

const FIXTURE: &str = include_str!("fixtures/rally-parity.json");

fn arr(v: &Value, key: &str) -> Vec<f64> {
    v.get(key)
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("parity fixture: missing array `{key}`"))
        .iter()
        .map(|x| x.as_f64().expect("parity fixture: non-numeric array entry"))
        .collect()
}

fn num(v: &Value, key: &str) -> f64 {
    v.get(key)
        .and_then(Value::as_f64)
        .unwrap_or_else(|| panic!("parity fixture: missing number `{key}`"))
}

/// `[x, y, z]` starting at `i`.
fn vec3(v: &[f64], i: usize) -> Vec3 {
    Vec3::new(v[i] as f32, v[i + 1] as f32, v[i + 2] as f32)
}

/// Expand the run-length button tape: `[firstFrame, mask]`, held until the
/// next run. The fixture stores it that way because 600 masks are a dozen runs
/// and a run list is something a human can read in a diff.
fn expand_masks(runs: &[Value], frames: usize) -> Vec<u32> {
    let mut masks = vec![0u32; frames];
    for (i, run) in runs.iter().enumerate() {
        let r = run.as_array().expect("parity fixture: mask run is not an array");
        let start = r[0].as_u64().expect("parity fixture: bad run start") as usize;
        let mask = r[1].as_u64().expect("parity fixture: bad run mask") as u32;
        let end = runs
            .get(i + 1)
            .map(|n| n.as_array().unwrap()[0].as_u64().unwrap() as usize)
            .unwrap_or(frames);
        for m in masks.iter_mut().take(end.min(frames)).skip(start) {
            *m = mask;
        }
    }
    masks
}

// ===========================================================================
// assembly — the same order demos/rally/game.ts uses through the ops
// ===========================================================================

/// Build the rally world from the recorded op payloads, op for op.
///
/// The ORDER is the demo's and it is load-bearing: terrain, colliders, then
/// per car create → reset → bind visual → register actor, then the rival's
/// brain, then `race_init` (which enrols every car built so far, so both cars
/// must already exist), then the camera. `car_actor` snapshots the car's
/// position, so resetting after it would register the actor at the origin.
fn assemble(fixture: &Value, store: &mut Store) -> World {
    let scene = store.scene_create();
    let mut world = World::new(scene);

    // -- terrain: the EXACT grid the visible mesh was tessellated from --------
    // Not the procedural sampler: it hashes through `sin`, which is a different
    // function in f32 than in f64, so a re-derived surface would not be the one
    // on screen (playset/sim/ops.ts `terrainHeightfield`).
    let terrain = fixture.get("terrain").expect("parity fixture: no terrain");
    let heights: Vec<f32> = arr(terrain, "heights").iter().map(|h| *h as f32).collect();
    let side = num(terrain, "side") as usize;
    assert_eq!(
        heights.len(),
        side * side,
        "parity fixture: height grid is not side*side"
    );
    world.set_terrain(Terrain::Grid(Heightfield::new(
        num(terrain, "size") as f32,
        side,
        &heights,
    )));

    // -- static colliders -----------------------------------------------------
    let colliders = fixture.get("colliders").expect("parity fixture: no colliders");
    let kinds = arr(colliders, "kinds");
    let data = arr(colliders, "data");
    let count = num(colliders, "count") as usize;
    assert_eq!(kinds.len(), count, "parity fixture: collider kind/count mismatch");
    assert_eq!(
        data.len(),
        count * COLLIDER_STRIDE,
        "parity fixture: collider stride drift"
    );
    {
        let cw = world.collision_mut();
        for i in 0..count {
            let d = &data[i * COLLIDER_STRIDE..(i + 1) * COLLIDER_STRIDE];
            let p = vec3(d, 0);
            let flags = d[7] as u32;
            let solid = flags & COLLIDER_FLAG_SOLID != 0;
            let walkable = flags & COLLIDER_FLAG_WALKABLE != 0;
            match kinds[i] as u32 {
                collider_kind::CYLINDER => {
                    cw.add_cylinder(p, d[3] as f32, d[4] as f32, solid, walkable);
                }
                collider_kind::BALL => {
                    cw.add_ball(p, d[3] as f32, solid, walkable);
                }
                _ => {
                    cw.add_cuboid(
                        p,
                        Vec3::new(d[3] as f32, d[4] as f32, d[5] as f32),
                        d[6] as f32,
                        solid,
                        walkable,
                    );
                }
            }
        }
    }

    // -- cars ------------------------------------------------------------------
    let cars = fixture
        .get("cars")
        .and_then(Value::as_array)
        .expect("parity fixture: no cars");
    let mut brains: Vec<(i32, &Value)> = Vec::new();
    for spec in cars {
        let t = arr(spec, "tuning");
        let car = world.car_create(CarTuning {
            max_forward_speed: t[0] as f32,
            max_reverse_speed: t[1] as f32,
            throttle_accel: t[2] as f32,
            reverse_accel: t[3] as f32,
            engine_brake: t[4] as f32,
            steer_lag: t[5] as f32,
            steer_angle_max: t[6] as f32,
            wheel_base: t[7] as f32,
            ride_height: t[8] as f32,
            boost_multiplier: t[9] as f32,
        });
        let spawn = arr(spec, "spawn");
        world.car_reset(car, vec3(&spawn, 0), spawn[3] as f32);

        // Bind a real four-wheel visual rig. Nothing in the trace depends on
        // wheel poses — the model controller is presentation-only — but the
        // demo binds one, and a sim that panicked or perturbed its own state
        // while writing nine poses a frame is a bug this test should see.
        let group = store.node_create(scene, 0);
        let wheels: Vec<i32> = (0..4).map(|_| store.node_create(scene, group)).collect();
        let pivots: Vec<i32> = (0..4).map(|_| store.node_create(scene, group)).collect();
        world.car_bind_visual(car, group, &wheels, &pivots, 0.35);

        let half = arr(spec, "actorHalf");
        world.car_actor(car, vec3(&half, 0));

        if !spec["brain"].is_null() {
            brains.push((car, &spec["brain"]));
        }
    }

    // -- the rival's driving brain ----------------------------------------------
    for (car, brain) in brains {
        let pts = arr(brain, "waypoints");
        let n = num(brain, "count") as usize;
        let waypoints: Vec<Vec3> = (0..n).map(|i| vec3(&pts, i * 3)).collect();
        let c = arr(brain, "config");
        let mut tracker = WaypointTracker::new(&waypoints, c[0] as f32, c[1] != 0.0);
        // The TS path's explicit `tracker.reset(0)`. Without it the first step
        // snaps to whichever gate is nearest the spawn, which is not always the
        // one ahead — the mount does the same thing for the same reason.
        tracker.reset(0);
        world.car_brain(
            car,
            tracker,
            PathNavigator::new(c[2] as f32, c[3] as f32),
            WaypointDriver::new(c[4] as f32, c[5] as f32, c[6] as f32),
        );
    }

    // -- race --------------------------------------------------------------------
    let race_cfg = fixture.get("race").expect("parity fixture: no race");
    let gates = arr(race_cfg, "checkpoints");
    let mut race = RacePlay::new(num(race_cfg, "lapCount") as u32);
    for i in 0..num(race_cfg, "count") as usize {
        race.push_checkpoint(vec3(&gates, i * 4), gates[i * 4 + 3] as f32);
    }
    world.race_init(race);

    // -- chase camera --------------------------------------------------------------
    let cam = fixture.get("camera").expect("parity fixture: no camera");
    let c = arr(cam, "config");
    world.camera_rig(
        num(cam, "car") as i32,
        CameraRig::new(CameraRigCfg {
            // BASIS components (right, up, forward) through `pose_offset`,
            // never a raw Vec3: forward is -Z, so a raw vector would put the
            // chase camera in FRONT of the car.
            camera_offset: pose_offset(c[0] as f32, c[1] as f32, c[2] as f32),
            look_at_offset: pose_offset(c[3] as f32, c[4] as f32, c[5] as f32),
            speed_camera_offset: pose_offset(c[6] as f32, c[7] as f32, c[8] as f32),
            position_lag: c[9] as f32,
            look_lag: c[10] as f32,
        }),
    );

    world
}

// ===========================================================================
// divergence bookkeeping
// ===========================================================================

/// The worst divergence seen over the whole replay, and where.
#[derive(Clone, Copy)]
struct Worst {
    value: f64,
    frame: usize,
    /// The bound in force at that frame — some bounds grow with time, so
    /// "worst" has to mean "closest to failing", not "largest number".
    limit: f64,
}

impl Default for Worst {
    fn default() -> Self {
        // An infinite starting limit makes the first `see` win unconditionally
        // without a special case.
        Worst {
            value: 0.0,
            frame: 0,
            limit: f64::INFINITY,
        }
    }
}

impl Worst {
    fn see(&mut self, value: f64, limit: f64, frame: usize) {
        if value / limit >= self.value / self.limit {
            *self = Worst { value, frame, limit };
        }
    }

    fn report(&self, name: &str, unit: &str) {
        println!(
            "  {name:<13} max {:>9.5}{unit}  at frame {:<4} bound {:>8.5}{unit}  ({:.0}% of headroom)",
            self.value,
            self.frame,
            self.limit,
            100.0 * self.value / self.limit,
        );
    }

    fn check(&self, name: &str, unit: &str) {
        assert!(
            self.value <= self.limit,
            "{name} diverged past its bound: {value:.5}{unit} at frame {frame}, \
             bound {limit:.5}{unit}.\n\
             This is a TRAJECTORY-PARITY failure, not float noise. Read the doc comment on that \
             bound in tests/parity.rs for the bug classes it watches, then rerun with \
             `PARITY_DUMP=1 ... -- --nocapture`: a porting bug departs early on ONE channel and \
             never comes back, while a legitimately retuned demo drifts on all of them together \
             (in which case regenerate the fixture).",
            value = self.value,
            frame = self.frame,
            limit = self.limit,
        );
    }
}

// ===========================================================================
// the replay
// ===========================================================================

#[test]
fn native_core_drives_like_the_ts_reference() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("parity fixture: not valid JSON");
    assert_eq!(num(&fixture, "version"), 1.0, "parity fixture: unknown version");

    let frames = num(&fixture, "frames") as usize;
    let dt = num(&fixture, "dt") as f32;
    let hz = num(&fixture, "hz");
    let masks = expand_masks(
        fixture["masks"].as_array().expect("parity fixture: no masks"),
        frames,
    );
    let trace: Vec<Vec<f64>> = fixture["trace"]
        .as_array()
        .expect("parity fixture: no trace")
        .iter()
        .map(|row| {
            row.as_array()
                .expect("parity fixture: trace row is not an array")
                .iter()
                .map(|v| v.as_f64().expect("parity fixture: non-numeric trace value"))
                .collect()
        })
        .collect();
    assert!(
        trace.len() > 50,
        "parity fixture: {} samples is too few to show drift",
        trace.len()
    );

    let dump = std::env::var_os("PARITY_DUMP").is_some();

    let mut store = Store::new();
    let mut world = assemble(&fixture, &mut store);

    let mut hud = [0f32; HUD_FLOATS];
    let mut sample = 0usize;

    let mut worst_cross = Worst::default();
    let mut worst_along = Worst::default();
    let mut worst_vertical = Worst::default();
    let mut worst_heading = Worst::default();
    let mut worst_speed = Worst::default();
    let mut worst_rival = Worst::default();
    let mut worst_gates = Worst::default();
    let mut gates_in_flight = 0usize;
    let mut travelled = 0.0f64;

    for f in 0..frames {
        let m = masks[f];
        // The same four bits the desktop mount and its PSP twin decode, from
        // the same spec BTN mask. Everything else in the mask is the guest's.
        world.set_buttons(
            m & btn::LEFT != 0,
            m & btn::RIGHT != 0,
            m & btn::CROSS != 0,
            m & btn::SQUARE != 0,
        );
        world.step(&mut store, dt);

        if sample >= trace.len() || trace[sample][T_FRAME] as usize != f + 1 {
            continue;
        }
        let row = &trace[sample];
        sample += 1;

        world.read_hud(&mut hud);
        let seconds = (f + 1) as f64 / hz;

        // -- the player's position, decomposed against the reference heading --
        // `u` is the reference's planar forward; the error resolves into a
        // component ALONG it (phase: same line, different point on it) and one
        // ACROSS it (a genuinely different line). See the header for why that
        // split is the whole point.
        let (px, py, pz) = (hud[H_PX] as f64, hud[H_PX + 1] as f64, hud[H_PX + 2] as f64);
        let (ex, ez) = (px - row[T_PX], pz - row[T_PZ]);
        let flen = (row[T_FX] * row[T_FX] + row[T_FZ] * row[T_FZ]).sqrt().max(1e-9);
        let (ux, uz) = (row[T_FX] / flen, row[T_FZ] / flen);
        let along = ex * ux + ez * uz;
        let cross = ex * uz - ez * ux;

        worst_cross.see(cross.abs(), MAX_CROSS_TRACK, f + 1);
        worst_along.see(along.abs(), ALONG_FLOOR + ALONG_SLOPE_PER_SEC * seconds, f + 1);

        let vertical = (py - row[T_PY]).abs();
        worst_vertical.see(vertical, MAX_VERTICAL, f + 1);

        // -- heading, as the full 3D angle between forward vectors -------------
        let a = [hud[H_FX] as f64, hud[H_FX + 1] as f64, hud[H_FX + 2] as f64];
        let b = [row[T_FX], row[T_FY], row[T_FZ]];
        let dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).clamp(-1.0, 1.0);
        let heading = dot.acos().to_degrees();
        worst_heading.see(heading, MAX_HEADING_DEG, f + 1);

        // -- speed ---------------------------------------------------------------
        let speed = hud[H_SPEED] as f64;
        let speed_err = (speed - row[T_SPEED]).abs();
        worst_speed.see(speed_err, SPEED_ABS + SPEED_REL * row[T_SPEED].abs(), f + 1);

        // -- the AI car ------------------------------------------------------------
        let (rx, rz) = (hud[H_RX] as f64, hud[H_RX + 2] as f64);
        let rival = ((rx - row[T_RX]).powi(2) + (rz - row[T_RZ]).powi(2)).sqrt();
        worst_rival.see(rival, MAX_RIVAL_PLANAR, f + 1);

        // -- the discrete channel ----------------------------------------------------
        let gate_delta = (hud[H_GATES] as i64 - row[T_GATES] as i64).abs();
        if gate_delta != 0 {
            gates_in_flight += 1;
        }
        worst_gates.see(gate_delta as f64, MAX_GATES_IN_FLIGHT as f64, f + 1);

        travelled =
            travelled.max(((px - trace[0][T_PX]).powi(2) + (pz - trace[0][T_PZ]).powi(2)).sqrt());

        if dump {
            println!(
                "f{:<4} along {along:+.5} cross {cross:+.5} vert {vertical:.5} \
                 head {heading:.4} spd {speed_err:.4} (n {speed:.3} r {:.3}) \
                 rival {rival:.5} gates {} {}",
                f + 1,
                row[T_SPEED],
                hud[H_GATES],
                row[T_GATES],
            );
        }
    }

    assert_eq!(
        sample,
        trace.len(),
        "not every trace sample was compared — `frames` and the trace disagree"
    );

    println!(
        "rally trajectory parity — native f32 vs TS f64, {frames} frames, {} samples:",
        trace.len()
    );
    worst_along.report("along-track", " u");
    worst_cross.report("cross-track", " u");
    worst_vertical.report("vertical", " u");
    worst_heading.report("heading", " deg");
    worst_speed.report("speed", " u/s");
    worst_rival.report("rival planar", " u");
    println!(
        "  gates         native {} / reference {} at the finish; {gates_in_flight} sample(s) \
         caught one in flight",
        hud[H_GATES],
        trace[trace.len() - 1][T_GATES],
    );

    worst_cross.check("player cross-track position", " u");
    worst_along.check("player along-track position", " u");
    worst_vertical.check("player vertical position", " u");
    worst_heading.check("player heading", " deg");
    worst_speed.check("player speed", " u/s");
    worst_rival.check("rival planar position", " u");
    worst_gates.check("checkpoint count (gates in flight)", " gates");

    // Zero tolerance at the finish line: whatever happened frame to frame, the
    // two cores have to have scored the same race.
    let final_gates = trace[trace.len() - 1][T_GATES];
    assert_eq!(
        hud[H_GATES] as i64, final_gates as i64,
        "the two cores finished the tape with different checkpoint totals \
         (native {}, reference {final_gates}). A gate difference that never heals is a race or \
         collision-radius port bug, not phase",
        hud[H_GATES],
    );
    assert!(
        final_gates >= 5.0,
        "the tape only scored {final_gates} checkpoints — it no longer exercises the race module"
    );

    // Last: the journey has to have HAPPENED, or every bound above is satisfied
    // vacuously by a car that never left the grid. Both cores drive ~120 u.
    //
    // It runs AFTER the divergence checks on purpose. Several porting bugs
    // (measured: a flipped steer sign, a dropped engine-brake term, a swapped
    // right/forward in the height lookup) park the native car against a
    // barrier in the first two seconds, and when they do, the divergence
    // report above says which channel broke — this assertion only says the car
    // stopped.
    assert!(
        travelled > 20.0,
        "the native replay barely moved ({travelled:.2} u) while the reference drove a lap. \
         Either the port drives into something in the first seconds, or the assembly above \
         built the wrong world"
    );
}

/// The fixture is a golden, so the first thing to check when parity fails is
/// whether it still describes the world the demo builds. These are the same
/// invariants the generator asserts on the TS side; asserting them again here
/// means a hand-edited or half-regenerated fixture fails loudly with a reason
/// instead of surfacing as a mysterious trajectory divergence.
#[test]
fn fixture_is_the_rally_composition() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("parity fixture: not valid JSON");
    let cars = fixture["cars"].as_array().expect("parity fixture: no cars");
    assert_eq!(cars.len(), 2, "rally is a two-car composition");
    assert!(
        cars[0]["brain"].is_null(),
        "car 1 is the player: no brain, driven by the button mask"
    );
    assert!(
        !cars[1]["brain"].is_null(),
        "car 2 is the AI rival: it must have a brain, or the behaviour stack goes untested"
    );
    assert_eq!(num(&fixture["race"], "lapCount"), 2.0);
    assert_eq!(num(&fixture["race"], "count"), 10.0, "the circuit has 10 gates");
    assert_eq!(
        arr(&fixture["camera"], "config").len(),
        11,
        "CameraRigConfig is 11 floats (playset/sim/ops.ts)"
    );
    assert_eq!(arr(&cars[0], "tuning").len(), 10, "CarTuningConfig is 10 floats");
    assert_eq!(arr(&cars[1]["brain"], "config").len(), 7, "BrainConfig is 7 floats");
    assert!(
        num(&fixture["colliders"], "count") > 100.0,
        "the race-track environment should contribute hundreds of colliders"
    );

    // The tape has to actually press things, or the whole parity test is a
    // test of two parked cars.
    let pressed: Vec<u64> = fixture["masks"]
        .as_array()
        .expect("parity fixture: no masks")
        .iter()
        .map(|r| r.as_array().unwrap()[1].as_u64().unwrap())
        .collect();
    assert!(pressed.iter().any(|m| *m != 0), "the button tape never presses anything");
    assert!(
        pressed.iter().filter(|m| **m != 0).count() >= 5,
        "the tape needs steering variety, not one held button"
    );
}
