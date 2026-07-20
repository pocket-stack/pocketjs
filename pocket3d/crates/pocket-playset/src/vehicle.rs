//! The ground vehicle: kinematic arcade car (bicycle-model steering,
//! throttle/drag speed curve, terrain-following ride height, surface-aligned
//! body frame) and the model mirror that turns a commit into wheel spin and
//! steer angles.
//!
//! Ported from the TS reference implementations, which stay authoritative:
//!   - playset/modules/actor-motion/ground-vehicle/arcade-car-motion-controller.ts
//!   - playset/modules/actor-motion/ground-vehicle/car-model-controller.ts
//!
//! Which are themselves ports of GameBlocks (github.com/xt4d/GameBlocks,
//! MIT © 2026 Weihao Cheng) — modules/actor-motion/ground-vehicle/
//! {ArcadeCarMotionController,CarModelController}.js. Verbatim semantics.
//!
//! WHY NATIVE: measured on a real PSP, QuickJS costs ~1.7µs per interpreter
//! op; two cars planning + committing per frame is a five-figure op bill on
//! its own. The math here is a few hundred flops. Nothing about the model
//! changed in the port — only the arithmetic width (f32, see [`crate::math`])
//! and the allocation discipline (none per step).
//!
//! THE PLAN/COMMIT SPLIT IS LOAD-BEARING: `plan` produces an intent WITHOUT
//! touching pose state (except the smoothed steer, exactly like the TS
//! controller mutates `this.steer` inside `planMovement`), the batch resolver
//! settles every actor's intent against the world and each other, and only
//! then does `commit` write the car's authoritative state. Do not collapse
//! them: the resolver's actor-vs-actor pass depends on every car having
//! planned from frame-start positions first.

use alloc::vec::Vec;
use glam::Vec3;

use crate::math::{
    self, clamp, fmath, forward_of, project_on_plane, right_of, smooth_toward, Frame, EPS, UP,
};
use crate::terrain::Terrain;

// ---------------------------------------------------------------------------
// tuning
// ---------------------------------------------------------------------------

/// `ArcadeCarMotionControllerOptions`, flattened. The TS `basis` option is
/// absent by design: the native core hard-codes DEFAULT_WORLD_BASIS (see the
/// narrowing note at the top of [`crate::math`]).
#[derive(Clone, Copy, Debug)]
pub struct CarTuning {
    pub max_forward_speed: f32,
    pub max_reverse_speed: f32,
    pub throttle_accel: f32,
    pub reverse_accel: f32,
    pub engine_brake: f32,
    pub steer_lag: f32,
    pub steer_angle_max: f32,
    pub wheel_base: f32,
    pub ride_height: f32,
    pub boost_multiplier: f32,
}

impl Default for CarTuning {
    /// The TS constructor's destructuring defaults, verbatim.
    ///
    /// Top speed is not `maxForwardSpeed`; it is where the speed curve stops
    /// climbing: `0 = throttleAccel - engineBrake * speed`, so
    /// `speed = throttleAccel / engineBrake` (40 u/s with these numbers, well
    /// under the 54 u/s clamp). `maxForwardSpeed` is the safety rail, not the
    /// design target — rally re-tunes all of this (demos/rally/game.ts).
    fn default() -> Self {
        Self {
            max_forward_speed: 54.0,
            max_reverse_speed: 18.0,
            throttle_accel: 40.0,
            reverse_accel: 16.0,
            engine_brake: 1.0,
            steer_lag: 0.09,
            steer_angle_max: 0.56,
            wheel_base: 5.6,
            ride_height: 0.38,
            boost_multiplier: 1.35,
        }
    }
}

/// One frame of driving control. `left`/`right`/`throttle`/`reverse` are 0..1
/// analogue signals (the AI driver feeds fractional throttle), `boost` scales
/// throttle acceleration.
#[derive(Clone, Copy, Debug)]
pub struct CarInput {
    pub left: f32,
    pub right: f32,
    pub throttle: f32,
    pub reverse: f32,
    pub boost: bool,
}

impl CarInput {
    pub const IDLE: CarInput = CarInput {
        left: 0.0,
        right: 0.0,
        throttle: 0.0,
        reverse: 0.0,
        boost: false,
    };
}

impl Default for CarInput {
    fn default() -> Self {
        Self::IDLE
    }
}

/// What the car WANTS to do this frame — the resolver's input.
///
/// The TS `ArcadeCarIntent` also carries `deltaSeconds`; here dt is passed to
/// `commit`'s callers explicitly (the world steps every car with one dt), so
/// carrying it per-intent would just be a float nobody reads.
#[derive(Clone, Copy, Debug)]
pub struct CarIntent {
    pub position: Vec3,
    pub start_position: Vec3,
    pub desired_delta: Vec3,
    pub velocity: Vec3,
    pub yaw: f32,
    pub steering_angle: f32,
}

/// What the car DID — authoritative state after resolution, and the currency
/// every downstream block (visuals, camera, race, model mirror) reads.
///
/// Deviations from the TS `ArcadeCarCommitResult`: `steering` (the raw
/// smoothed steer) and `collisions` are dropped. Nothing in the rally
/// composition reads either; `steer` is still a public field on [`ArcadeCar`]
/// and the collision count is the resolver's to report.
#[derive(Clone, Copy, Debug)]
pub struct CarCommit {
    pub position: Vec3,
    pub velocity: Vec3,
    /// Tangent speed: the surface-plane length of the velocity, i.e. what the
    /// HUD calls speed. Unsigned — reversing still reads positive.
    pub speed: f32,
    pub yaw: f32,
    pub steering_angle: f32,
    pub surface_normal: Vec3,
    pub body_frame: Frame,
}

// ---------------------------------------------------------------------------
// the motion controller
// ---------------------------------------------------------------------------

/// `ArcadeCarMotionController`. Kinematic, not dynamic: there is no mass, no
/// tyre model and no lateral slip — steering rotates the heading and the car
/// drives exactly where it points. That IS the arcade feel, not a shortcut.
pub struct ArcadeCar {
    pub cfg: CarTuning,
    pub position: Vec3,
    pub velocity: Vec3,
    pub yaw: f32,
    /// The lag-smoothed steer signal in −1..1, persisted across frames.
    pub steer: f32,
    /// `steer * steerAngleMax` from the last plan — the front wheels' angle.
    pub steering_angle: f32,
    pub surface_normal: Vec3,
    pub body_frame: Frame,
}

impl ArcadeCar {
    pub fn new(cfg: CarTuning) -> Self {
        Self {
            cfg,
            position: Vec3::ZERO,
            velocity: Vec3::ZERO,
            yaw: 0.0,
            steer: 0.0,
            steering_angle: 0.0,
            surface_normal: UP,
            body_frame: math::orientation_frame(0.0, UP),
        }
    }

    /// TS `reset`: pose and heading are placed, everything dynamic is zeroed.
    /// Note the surface normal resets to world up rather than to the terrain
    /// under `position` — the TS does the same, and the first commit fixes it.
    pub fn reset(&mut self, position: Vec3, yaw: f32) {
        self.position = position;
        self.velocity = Vec3::ZERO;
        self.surface_normal = UP;
        self.yaw = yaw;
        self.steer = 0.0;
        self.steering_angle = 0.0;
        self.body_frame = math::orientation_frame(yaw, self.surface_normal);
    }

    /// TS `planMovement` (always the non-committing branch — the world always
    /// runs the resolver, so the `commit: true` shortcut has no native caller).
    ///
    /// Terrain is sampled twice, for different things: the NORMAL at the start
    /// position (to build the frame the speed and yaw integrate in) and the
    /// HEIGHT at the target position (to snap ride height). The TS
    /// `resolveTerrainSample` returns both every time; here each site asks for
    /// only what it uses, which skips two normal evaluations per car per frame
    /// — a real saving on device, and semantically identical because the
    /// unused halves were discarded anyway.
    pub fn plan(&mut self, input: CarInput, dt: f32, terrain: &Terrain) -> CarIntent {
        let start_position = self.position;

        // TS: basis.controlSignal("counterClockWise", left)
        //   + basis.controlSignal("clockWise", right).
        // WorldBasis.controlSigns is a fixed table, NOT derived from the axis
        // assignment (playset/modules/math/world-basis.ts:151) —
        // counterClockWise = +1, clockWise = −1 for every basis. So the sum is
        // `left - right`, and it is basis-independent: hard-coding it here
        // loses nothing even for a non-default basis. Both held ⇒ 0, which is
        // the same "no steer input" case as neither held (see the snap below).
        let steer_input = input.left - input.right;
        let throttle = clamp(input.throttle, 0.0, 1.0);
        let reverse = clamp(input.reverse, 0.0, 1.0);

        let start_normal = terrain.normal_at(right_of(start_position), forward_of(start_position));

        // TS: `input.steer != 0 ? smoothToward(...) : input.steer`. Releasing
        // the stick SNAPS the wheels back to centre instead of easing — the
        // lag is on turn-in only. Deliberate in GameBlocks; keep it.
        self.steer = if steer_input != 0.0 {
            smooth_toward(self.steer, steer_input, self.cfg.steer_lag, dt)
        } else {
            0.0
        };

        // Bicycle model: yaw rate is proportional to forward speed, so the car
        // cannot pivot in place — steering at a standstill does nothing.
        let start_basis = math::orientation_frame(self.yaw, start_normal);
        let current_forward_speed = tangent_forward_speed(self.velocity, &start_basis);
        let steer_angle = self.steer * self.cfg.steer_angle_max;
        let yaw_rate = (current_forward_speed * fmath::tan(steer_angle)) / self.cfg.wheel_base;
        let next_yaw = self.yaw + yaw_rate * dt;
        let motion_basis = math::orientation_frame(next_yaw, start_normal);

        let boost_scale = if input.boost {
            self.cfg.boost_multiplier
        } else {
            1.0
        };
        let drive_accel =
            throttle * self.cfg.throttle_accel * boost_scale - reverse * self.cfg.reverse_accel;
        // Linear drag ⇒ exponential approach to throttleAccel/engineBrake.
        let drag_accel = -self.cfg.engine_brake * current_forward_speed;
        let next_forward_speed = clamp(
            current_forward_speed + (drive_accel + drag_accel) * dt,
            -self.cfg.max_reverse_speed,
            self.cfg.max_forward_speed,
        );

        let desired_velocity = motion_basis.forward * next_forward_speed;
        let mut target_position = start_position + desired_velocity * dt;
        // Ride height is SET, not integrated: there is no suspension and no
        // gravity, the chassis simply rides the surface it lands on.
        let ground = terrain.height_at(right_of(target_position), forward_of(target_position));
        math::set_height(&mut target_position, ground + self.cfg.ride_height);

        CarIntent {
            position: target_position,
            start_position,
            desired_delta: target_position - start_position,
            velocity: desired_velocity,
            yaw: next_yaw,
            steering_angle: steer_angle,
        }
    }

    /// TS `commitMovement`. `resolved_*` come from the batch resolver — or
    /// from the intent itself when the car has no collider, which is exactly
    /// what the TS `resolved = null` branch does.
    pub fn commit(
        &mut self,
        intent: &CarIntent,
        resolved_position: Vec3,
        resolved_velocity: Vec3,
        terrain: &Terrain,
    ) -> CarCommit {
        // The normal is re-sampled at the RESOLVED position: a car pushed
        // sideways by a collision must sit on the ground it ended up on, not
        // the ground it aimed at.
        let surface_normal =
            terrain.normal_at(right_of(resolved_position), forward_of(resolved_position));

        self.position = resolved_position;
        self.velocity = resolved_velocity;
        self.yaw = intent.yaw;
        self.steering_angle = intent.steering_angle;
        self.surface_normal = surface_normal;
        self.body_frame = math::orientation_frame(self.yaw, self.surface_normal);

        CarCommit {
            position: self.position,
            velocity: self.velocity,
            // Planar (surface-tangent) length, so climbing a hill doesn't
            // inflate the speedo with vertical motion.
            speed: project_on_plane(self.velocity, self.body_frame.up).length(),
            yaw: self.yaw,
            steering_angle: self.steering_angle,
            surface_normal: self.surface_normal,
            body_frame: self.body_frame,
        }
    }
}

/// TS `tangentForwardSpeed`: signed speed along the body forward, with the
/// surface-normal component removed first.
#[inline]
fn tangent_forward_speed(velocity: Vec3, basis: &Frame) -> f32 {
    project_on_plane(velocity, basis.up).dot(basis.forward)
}

// ---------------------------------------------------------------------------
// the model mirror
// ---------------------------------------------------------------------------

/// One wheel's Euler mirror. The TS writes `wheel.rotation.{x,y}` on a
/// three.js-shaped node; scene3d nodes carry quaternions only, so the sim
/// keeps the Euler pair and the world folds it into a quat at pose-write time
/// (`math::quat_from_euler_xyz`) — the same two-step the rally demo does with
/// its `wheelMirrors`.
#[derive(Clone, Copy, Debug, Default)]
pub struct WheelMirror {
    /// Accumulated spin about the wheel's local X.
    pub rot_x: f32,
    /// Steer yaw, but ONLY for wheels without a pivot (see `step`).
    pub rot_y: f32,
}

/// `CarModelController`, minus the chassis half.
///
/// DELIBERATE SPLIT: the TS `updateChassis` copies the position and builds the
/// chassis quaternion from the body frame. Natively that is redundant — the
/// world already has `commit.position` and `commit.body_frame` and writes the
/// group pose itself (`Frame::to_quat` encodes the same "local +Z is backward
/// because vehicle meshes face −Z" convention as the TS `makeBasis` call). So
/// this type owns only what the world can't derive: the integrated wheel spin
/// and the per-wheel steer split.
pub struct CarModel {
    pub wheels: Vec<WheelMirror>,
    /// Steer pivots, as bare yaw angles (the TS only ever writes `.rotation.y`
    /// on a pivot). Index-aligned with `wheels`; a shorter list means the
    /// trailing wheels have no pivot, matching the TS `wheelPivots[i]`
    /// undefined check.
    pub pivots: Vec<f32>,
    pub wheel_radius: f32,
    /// TS `steerWheelIndices`, narrowed to a prefix count: the default is
    /// `[0, 1]` (the front pair) and every playset car uses it, so a Set of
    /// arbitrary indices would be allocation and indirection for nothing.
    pub steer_wheel_count: usize,
    /// Radians of spin accumulated so far; wraps only by f32 magnitude, same
    /// as the TS (which also lets it grow unbounded).
    pub wheel_spin: f32,
}

impl CarModel {
    /// Sizes both mirror lists ONCE. `step` allocates nothing, ever.
    pub fn new(wheel_radius: f32, wheel_count: usize, pivot_count: usize) -> Self {
        let mut wheels = Vec::new();
        wheels.resize(wheel_count, WheelMirror::default());
        let mut pivots = Vec::new();
        pivots.resize(pivot_count, 0.0);
        Self {
            wheels,
            pivots,
            wheel_radius,
            steer_wheel_count: 2,
            wheel_spin: 0.0,
        }
    }

    /// TS `updateWheels`. Spin is integrated from the forward speed (rolling
    /// without slip: `dθ = v·dt / r`), so it reverses sign when the car does.
    pub fn step(&mut self, commit: &CarCommit, dt: f32) {
        let radius = if fmath::abs(self.wheel_radius) > EPS {
            fmath::abs(self.wheel_radius)
        } else {
            EPS
        };
        // TS getForwardSpeed: the raw velocity·forward, NOT the tangent speed
        // used for the HUD — the wheels care about the signed travel direction.
        let forward_speed = commit.velocity.dot(commit.body_frame.forward);
        self.wheel_spin += (forward_speed * dt) / radius;

        let local_yaw = commit.steering_angle;
        for i in 0..self.wheels.len() {
            let wheel_yaw = if i < self.steer_wheel_count {
                local_yaw
            } else {
                0.0
            };
            self.wheels[i].rot_x = self.wheel_spin;
            if i < self.pivots.len() {
                // Pivoted rig: the parent turns, the wheel only spins.
                self.pivots[i] = wheel_yaw;
                self.wheels[i].rot_y = 0.0;
            } else {
                self.wheels[i].rot_y = wheel_yaw;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DT: f32 = 1.0 / 60.0;

    fn drive(car: &mut ArcadeCar, input: CarInput, steps: usize) -> CarCommit {
        drive_on(car, input, steps, &Terrain::None)
    }

    /// Run the car with no resolver in the loop: every intent is accepted as
    /// planned, which is exactly the TS `resolved = null` commit branch.
    fn drive_on(
        car: &mut ArcadeCar,
        input: CarInput,
        steps: usize,
        terrain: &Terrain,
    ) -> CarCommit {
        let mut last = CarCommit {
            position: car.position,
            velocity: car.velocity,
            speed: 0.0,
            yaw: car.yaw,
            steering_angle: car.steering_angle,
            surface_normal: car.surface_normal,
            body_frame: car.body_frame,
        };
        for _ in 0..steps {
            let intent = car.plan(input, DT, terrain);
            last = car.commit(&intent, intent.position, intent.velocity, terrain);
        }
        last
    }

    fn throttle() -> CarInput {
        CarInput {
            throttle: 1.0,
            ..CarInput::IDLE
        }
    }

    #[test]
    fn throttle_from_rest_accelerates_along_forward() {
        let mut car = ArcadeCar::new(CarTuning::default());
        car.reset(Vec3::ZERO, 0.0);
        let commit = drive(&mut car, throttle(), 1);

        // yaw 0 ⇒ forward is −Z, and drag is zero from rest, so the first
        // step is exactly throttleAccel * dt.
        let expected = CarTuning::default().throttle_accel * DT;
        assert!((commit.speed - expected).abs() < 1e-4, "{}", commit.speed);
        assert!(commit.velocity.dot(commit.body_frame.forward) > 0.0);
        assert!(commit.position.z < 0.0, "{}", commit.position.z);
        assert!(commit.position.x.abs() < 1e-6);
    }

    #[test]
    fn top_speed_converges_to_accel_over_engine_brake() {
        // The invariant the TS constructor comment states:
        // 0 = throttleAccel - engineBrake * speed ⇒ speed = a / b.
        let cfg = CarTuning::default();
        let mut car = ArcadeCar::new(cfg);
        car.reset(Vec3::ZERO, 0.0);
        let commit = drive(&mut car, throttle(), 1200);

        let terminal = cfg.throttle_accel / cfg.engine_brake;
        assert!(terminal < cfg.max_forward_speed, "clamp must not bite");
        assert!((commit.speed - terminal).abs() < 1e-2, "{}", commit.speed);
    }

    #[test]
    fn steering_at_zero_speed_does_not_change_yaw() {
        // Bicycle model: yawRate ∝ forwardSpeed. No roll, no turn.
        let mut car = ArcadeCar::new(CarTuning::default());
        car.reset(Vec3::ZERO, 0.3);
        let commit = drive(
            &mut car,
            CarInput {
                left: 1.0,
                ..CarInput::IDLE
            },
            120,
        );
        assert_eq!(commit.yaw, 0.3);
        // ...but the wheels DO turn, and they turn left = positive yaw
        // (controlSignal counterClockWise = +1).
        assert!(commit.steering_angle > 0.0);
        assert!((commit.steering_angle - CarTuning::default().steer_angle_max).abs() < 1e-3);
    }

    #[test]
    fn steer_input_signs_are_left_minus_right() {
        let mut car = ArcadeCar::new(CarTuning::default());
        car.reset(Vec3::ZERO, 0.0);
        let right = car.plan(
            CarInput {
                right: 1.0,
                ..CarInput::IDLE
            },
            DT,
            &Terrain::None,
        );
        assert!(right.steering_angle < 0.0);
        // Both held cancel to zero input, which snaps the steer to centre.
        car.reset(Vec3::ZERO, 0.0);
        let both = car.plan(
            CarInput {
                left: 1.0,
                right: 1.0,
                ..CarInput::IDLE
            },
            DT,
            &Terrain::None,
        );
        assert_eq!(both.steering_angle, 0.0);
    }

    #[test]
    fn steering_while_rolling_turns_the_car() {
        let mut car = ArcadeCar::new(CarTuning::default());
        car.reset(Vec3::ZERO, 0.0);
        drive(&mut car, throttle(), 60);
        let commit = drive(
            &mut car,
            CarInput {
                left: 1.0,
                throttle: 1.0,
                ..CarInput::IDLE
            },
            60,
        );
        assert!(commit.yaw > 0.1, "{}", commit.yaw);
    }

    #[test]
    fn ride_height_tracks_the_terrain_surface() {
        // Ride height is SET from the sample, never integrated: a car spawned
        // 50 units up is on the ground after ONE plan, not falling toward it.
        let cfg = CarTuning::default();
        let mut car = ArcadeCar::new(cfg);
        car.reset(Vec3::new(0.0, 50.0, 0.0), 0.0);
        let intent = car.plan(throttle(), DT, &Terrain::None);
        assert_eq!(intent.position.y, cfg.ride_height);
        // ...and the snap is part of the resolver's delta, not a hidden warp.
        assert!((intent.desired_delta.y + 50.0 - cfg.ride_height).abs() < 1e-4);

        // On real (sloped) ground the chassis sits exactly rideHeight above
        // whatever is under the TARGET position, every step.
        let hills = Terrain::Natural(crate::terrain::NaturalTerrain::new());
        let lifted = CarTuning {
            ride_height: 1.25,
            ..CarTuning::default()
        };
        let mut car = ArcadeCar::new(lifted);
        car.reset(Vec3::new(30.0, 0.0, -30.0), 0.0);
        let mut climbed = false;
        for _ in 0..90 {
            let commit = drive_on(&mut car, throttle(), 1, &hills);
            let ground = hills.height_at(right_of(commit.position), forward_of(commit.position));
            assert!(
                (commit.position.y - (ground + 1.25)).abs() < 1e-4,
                "{} vs {}",
                commit.position.y,
                ground + 1.25
            );
            climbed |= fmath::abs(ground) > 0.05;
            // A sloped surface tilts the body frame off world up.
            assert!(commit.body_frame.up.dot(commit.surface_normal) > 0.999);
        }
        assert!(
            climbed,
            "the natural terrain under this run must not be flat"
        );
    }

    #[test]
    fn reverse_clamps_at_max_reverse_speed() {
        // Default tuning converges to −reverseAccel/engineBrake = −16, inside
        // the −18 rail, so tighten the rail to prove the clamp is live.
        let cfg = CarTuning {
            max_reverse_speed: 5.0,
            ..CarTuning::default()
        };
        let mut car = ArcadeCar::new(cfg);
        car.reset(Vec3::ZERO, 0.0);
        let commit = drive(
            &mut car,
            CarInput {
                reverse: 1.0,
                ..CarInput::IDLE
            },
            600,
        );
        let signed = commit.velocity.dot(commit.body_frame.forward);
        assert!((signed + 5.0).abs() < 1e-4, "{signed}");
        // `speed` is unsigned tangent speed — reversing still reads positive.
        assert!((commit.speed - 5.0).abs() < 1e-4, "{}", commit.speed);
        assert!(commit.position.z > 0.0, "reverse travels +Z at yaw 0");
    }

    #[test]
    fn wheel_spin_sign_matches_travel_direction() {
        let mut car = ArcadeCar::new(CarTuning::default());
        car.reset(Vec3::ZERO, 0.0);
        let mut model = CarModel::new(0.35, 4, 4);

        let forward = drive(&mut car, throttle(), 30);
        model.step(&forward, DT);
        let rolled = model.wheels[0].rot_x;
        assert!(rolled > 0.0, "{rolled}");
        // dθ = v·dt / r
        assert!(
            (rolled - (forward.velocity.dot(forward.body_frame.forward) * DT) / 0.35).abs() < 1e-4
        );

        car.reset(Vec3::ZERO, 0.0);
        let back = drive(
            &mut car,
            CarInput {
                reverse: 1.0,
                ..CarInput::IDLE
            },
            30,
        );
        let before = model.wheel_spin;
        model.step(&back, DT);
        assert!(model.wheel_spin < before);
    }

    #[test]
    fn steer_pivots_follow_the_steering_angle() {
        let mut car = ArcadeCar::new(CarTuning::default());
        car.reset(Vec3::ZERO, 0.0);
        let commit = drive(
            &mut car,
            CarInput {
                left: 1.0,
                throttle: 1.0,
                ..CarInput::IDLE
            },
            30,
        );
        let mut model = CarModel::new(0.35, 4, 4);
        model.step(&commit, DT);

        // Front pair steers, rear pair does not; with pivots present the
        // wheels themselves never carry yaw.
        assert_eq!(model.pivots[0], commit.steering_angle);
        assert_eq!(model.pivots[1], commit.steering_angle);
        assert_eq!(model.pivots[2], 0.0);
        assert_eq!(model.pivots[3], 0.0);
        assert!(model.wheels.iter().all(|w| w.rot_y == 0.0));

        // Pivot-less rig: the steer lands on the wheel node instead.
        let mut bare = CarModel::new(0.35, 4, 0);
        bare.step(&commit, DT);
        assert_eq!(bare.wheels[0].rot_y, commit.steering_angle);
        assert_eq!(bare.wheels[3].rot_y, 0.0);
    }
}
