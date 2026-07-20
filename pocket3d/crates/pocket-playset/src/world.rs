//! The World: one assembled driving-game sim, and the composite `step` that
//! runs a whole turn — plan, batch-resolve, commit, race, visuals, camera —
//! without crossing the guest boundary once.
//!
//! Assembly is declarative and happens at boot (the guest calls the `ps.*`
//! ops); after that the guest's per-frame contribution is a button mask in
//! and a 15-float HUD mirror out. Visual poses never become JS: `step` writes
//! them straight into the shared [`Store`].
//!
//! The step order is the rally composition's order, verbatim
//! (demos/rally/game.ts): every car plans → the batch resolver resolves them
//! together → every car commits → race progress → visual sync → camera. That
//! ordering IS the semantics (actors resolve against each other from frame
//! start positions), so it is not an implementation detail to tidy later.

use alloc::vec::Vec;
use glam::{Quat, Vec3};
use pocket_scene3d::Store;

use crate::behavior::{
    CameraRig, DriverInput, PathNavigator, RacePlay, WaypointDriver, WaypointTracker,
};
use crate::collision::CollisionWorld;
use crate::math::{self, Frame};
use crate::resolver::BatchResolver;
use crate::terrain::Terrain;
use crate::vehicle::{ArcadeCar, CarCommit, CarInput, CarIntent, CarModel, CarTuning};

/// Floats in the HUD mirror (`ps.readHud`):
/// `[state, laps, speed, nextCheckpoint, gates, rivalLeads,
///   px,py,pz, fx,fy,fz, rx,ry,rz]`.
pub const HUD_FLOATS: usize = 15;

/// scene3d pose stride: `[id, px, py, pz, qx, qy, qz, qw, sx, sy, sz]`.
const POSE_STRIDE: usize = 11;

/// The AI brain attached to a car (absent ⇒ the car takes the button mask).
struct Brain {
    tracker: WaypointTracker,
    navigator: PathNavigator,
    driver: WaypointDriver,
}

/// Which scene3d nodes this car drives, plus the wheel/pivot LOCAL offsets.
///
/// `write_poses` always writes position, so rotating a wheel means rewriting
/// its parent-local translation too. The guest set those offsets when it built
/// the visual, and never moves them again — so the sim snapshots them from the
/// store on the first step (lazily: binding may happen before the guest's
/// first flush) and reuses them forever after.
#[derive(Default)]
struct CarVisual {
    group: i32,
    wheels: Vec<i32>,
    pivots: Vec<i32>,
    wheel_offsets: Vec<Vec3>,
    pivot_offsets: Vec<Vec3>,
    offsets_captured: bool,
}

struct Car {
    motion: ArcadeCar,
    model: CarModel,
    visual: CarVisual,
    /// Index into the batch resolver's actor list (usize::MAX = unregistered).
    actor: usize,
    brain: Option<Brain>,
    /// Player index inside the race play (usize::MAX = not racing).
    racer: usize,
    speed: f32,
}

pub struct World {
    scene: i32,
    terrain: Terrain,
    collision: CollisionWorld,
    resolver: BatchResolver,
    cars: Vec<Car>,
    race: Option<RacePlay>,
    camera: Option<(usize, CameraRig)>,
    /// This frame's player control input (decoded from the button mask).
    buttons: CarInput,
    /// Scratch, reused every step — the sim allocates nothing per frame.
    intents: Vec<CarIntent>,
    pose_buf: Vec<f32>,
    gates_passed: f32,
}

impl World {
    pub fn new(scene: i32) -> Self {
        Self {
            scene,
            terrain: Terrain::None,
            collision: CollisionWorld::new(),
            resolver: BatchResolver::new(),
            cars: Vec::new(),
            race: None,
            camera: None,
            buttons: CarInput::IDLE,
            intents: Vec::new(),
            pose_buf: Vec::new(),
            gates_passed: 0.0,
        }
    }

    // -- assembly ------------------------------------------------------------

    pub fn set_terrain(&mut self, terrain: Terrain) {
        self.terrain = terrain;
    }

    /// Mutate the installed road terrain, if that is what this world has.
    /// Road segments arrive in their own batched op after `terrainRoad`, so
    /// the mount needs a way back in without rebuilding the sampler.
    pub fn with_road_terrain(&mut self, f: impl FnOnce(&mut crate::terrain::RoadTerrain)) {
        if let Terrain::Road(road) = &mut self.terrain {
            f(road);
        }
    }

    pub fn collision_mut(&mut self) -> &mut CollisionWorld {
        &mut self.collision
    }

    pub fn car_create(&mut self, tuning: CarTuning) -> i32 {
        self.cars.push(Car {
            motion: ArcadeCar::new(tuning),
            // Rebuilt with the real rig by `car_bind_visual`; a car that is
            // never bound simply has no wheels to drive.
            model: CarModel::new(0.35, 0, 0),
            visual: CarVisual::default(),
            actor: usize::MAX,
            brain: None,
            racer: usize::MAX,
            speed: 0.0,
        });
        self.cars.len() as i32
    }

    fn car_slot(&self, car: i32) -> Option<usize> {
        if car <= 0 || car as usize > self.cars.len() {
            return None;
        }
        Some(car as usize - 1)
    }

    pub fn car_reset(&mut self, car: i32, position: Vec3, yaw: f32) {
        let Some(i) = self.car_slot(car) else { return };
        self.cars[i].motion.reset(position, yaw);
    }

    pub fn car_bind_visual(
        &mut self,
        car: i32,
        group: i32,
        wheels: &[i32],
        pivots: &[i32],
        wheel_radius: f32,
    ) {
        let Some(i) = self.car_slot(car) else { return };
        let c = &mut self.cars[i];
        c.visual.group = group;
        c.visual.wheels.clear();
        c.visual.wheels.extend_from_slice(wheels);
        c.visual.pivots.clear();
        c.visual.pivots.extend_from_slice(pivots);
        c.visual.offsets_captured = false;
        c.model = CarModel::new(wheel_radius, wheels.len(), pivots.len());
    }

    /// Register the car with the batch resolver (cuboid collider half extents).
    pub fn car_actor(&mut self, car: i32, half: Vec3) {
        let Some(i) = self.car_slot(car) else { return };
        let position = self.cars[i].motion.position;
        self.cars[i].actor = self.resolver.create_actor(position, half);
    }

    /// Attach the waypoint driving brain; without it the car is player-driven.
    pub fn car_brain(
        &mut self,
        car: i32,
        tracker: WaypointTracker,
        navigator: PathNavigator,
        driver: WaypointDriver,
    ) {
        let Some(i) = self.car_slot(car) else { return };
        self.cars[i].brain = Some(Brain {
            tracker,
            navigator,
            driver,
        });
    }

    /// Register every car built so far as a racer and start the race.
    pub fn race_init(&mut self, race: RacePlay) {
        let mut race = race;
        for car in &mut self.cars {
            car.racer = race.add_player(car.motion.position);
        }
        race.start();
        self.race = Some(race);
    }

    pub fn camera_rig(&mut self, car: i32, rig: CameraRig) {
        let Some(i) = self.car_slot(car) else { return };
        self.camera = Some((i, rig));
    }

    /// Decode the frame's button mask into player control input. Kept separate
    /// from `step` so the spec BTN bit layout stays in the mount.
    pub fn set_buttons(&mut self, left: bool, right: bool, throttle: bool, reverse: bool) {
        self.buttons = CarInput {
            left: if left { 1.0 } else { 0.0 },
            right: if right { 1.0 } else { 0.0 },
            throttle: if throttle { 1.0 } else { 0.0 },
            reverse: if reverse { 1.0 } else { 0.0 },
            boost: false,
        };
    }

    // -- the composite turn ---------------------------------------------------

    /// One fixed simulation step; poses and the camera land in `store`.
    pub fn step(&mut self, store: &mut Store, dt: f32) {
        let race_started = self.race.as_ref().is_some_and(|r| r.is_started());

        // 1. plan — every car produces an intent from its own control source.
        self.resolver.begin_frame();
        self.intents.clear();
        for i in 0..self.cars.len() {
            let input = self.plan_input(i, dt, race_started);
            let intent = self.cars[i].motion.plan(input, dt, &self.terrain);
            let actor = self.cars[i].actor;
            if actor != usize::MAX {
                self.resolver
                    .queue_move(actor, intent.start_position, intent.desired_delta, dt);
            }
            self.intents.push(intent);
        }

        // 2. resolve every queued move together (actor-vs-actor from frame
        //    start positions — the mode rally uses).
        self.resolver.resolve(&mut self.collision, &self.terrain);

        // 3. commit, then race progress, visuals and camera off the results.
        for i in 0..self.cars.len() {
            let intent = self.intents[i];
            let actor = self.cars[i].actor;
            let commit = match (actor != usize::MAX).then(|| self.resolver.result(actor)) {
                Some(r) => self.cars[i]
                    .motion
                    .commit(&intent, r.position, r.velocity, &self.terrain),
                None => {
                    self.cars[i]
                        .motion
                        .commit(&intent, intent.position, intent.velocity, &self.terrain)
                }
            };
            self.cars[i].speed = commit.speed;

            let racer = self.cars[i].racer;
            if racer != usize::MAX {
                if let Some(race) = self.race.as_mut() {
                    race.update_player(racer, commit.position);
                }
            }

            self.cars[i].model.step(&commit, dt);
            self.write_car_visual(store, i, &commit);

            if let Some((cam_car, rig)) = self.camera.as_mut() {
                if *cam_car == i {
                    let (eye, rot) = rig.step(commit.position, commit.body_frame, commit.speed, dt);
                    write_camera(store, self.scene, eye, rot);
                }
            }
        }

        if let Some(race) = self.race.as_mut() {
            self.gates_passed += race.step(dt) as f32;
        }
    }

    /// Control source for car `i`: the brain if it has one, else the buttons.
    fn plan_input(&mut self, i: usize, dt: f32, race_started: bool) -> CarInput {
        let (position, yaw, speed) = {
            let c = &self.cars[i];
            (c.motion.position, c.motion.yaw, c.speed)
        };
        let buttons = self.buttons;
        let Some(brain) = self.cars[i].brain.as_mut() else {
            return buttons;
        };
        let progress = brain.tracker.step(position);
        let nav = brain.navigator.step(position, progress.waypoint);
        let controls = brain.driver.step(DriverInput {
            position,
            yaw,
            speed,
            waypoint: progress.waypoint,
            corner_magnitude: progress.corner_magnitude,
            race_started,
            dt,
        });
        let ease_off = if brain.navigator.max_speed > 0.0 {
            nav.desired_speed / brain.navigator.max_speed
        } else {
            1.0
        };
        CarInput {
            left: if controls.left { 1.0 } else { 0.0 },
            right: if controls.right { 1.0 } else { 0.0 },
            throttle: if controls.throttle {
                if ease_off > 0.4 {
                    ease_off
                } else {
                    0.4
                }
            } else {
                0.0
            },
            reverse: if controls.reverse {
                1.0
            } else if controls.brake {
                0.55
            } else {
                0.0
            },
            boost: controls.boost,
        }
    }

    /// Chassis pose + wheel spin/steer straight into the scene3d store as one
    /// batched `write_poses` — the same op the TS `Scene3D.flush` emits.
    fn write_car_visual(&mut self, store: &mut Store, i: usize, commit: &CarCommit) {
        if self.cars[i].visual.group == 0 {
            return;
        }
        self.capture_offsets(store, i);
        let car = &self.cars[i];
        let buf = &mut self.pose_buf;
        buf.clear();
        push_pose(
            buf,
            car.visual.group,
            commit.position,
            commit.body_frame.to_quat(),
        );
        for ((id, offset), mirror) in car
            .visual
            .wheels
            .iter()
            .zip(car.visual.wheel_offsets.iter())
            .zip(car.model.wheels.iter())
        {
            push_pose(
                buf,
                *id,
                *offset,
                math::quat_from_euler_xyz(mirror.rot_x, mirror.rot_y, 0.0),
            );
        }
        for ((id, offset), rot_y) in car
            .visual
            .pivots
            .iter()
            .zip(car.visual.pivot_offsets.iter())
            .zip(car.model.pivots.iter())
        {
            push_pose(buf, *id, *offset, math::quat_from_euler_xyz(0.0, *rot_y, 0.0));
        }
        let count = buf.len() / POSE_STRIDE;
        store.write_poses(buf, count);
    }

    /// Snapshot the wheel/pivot parent-local translations once (see CarVisual).
    fn capture_offsets(&mut self, store: &Store, i: usize) {
        let v = &mut self.cars[i].visual;
        if v.offsets_captured {
            return;
        }
        v.offsets_captured = true;
        v.wheel_offsets.clear();
        for id in &v.wheels {
            v.wheel_offsets
                .push(store.node(*id).map_or(Vec3::ZERO, |n| n.p));
        }
        v.pivot_offsets.clear();
        for id in &v.pivots {
            v.pivot_offsets
                .push(store.node(*id).map_or(Vec3::ZERO, |n| n.p));
        }
    }

    // -- the guest mirror ------------------------------------------------------

    /// Fill the HUD mirror. "Player" is the first car without a brain;
    /// "rival" the first car with one.
    pub fn read_hud(&self, out: &mut [f32]) {
        if out.len() < HUD_FLOATS {
            return;
        }
        let player = self.cars.iter().position(|c| c.brain.is_none());
        let rival = self.cars.iter().position(|c| c.brain.is_some());
        let (state, laps, next_cp, rival_leads) = match (&self.race, player) {
            (Some(race), Some(p)) => {
                let ps = race.player(self.cars[p].racer);
                let leads = rival.is_some_and(|r| race.leader() == self.cars[r].racer);
                (
                    race.state_code(),
                    ps.completed_laps as f32,
                    ps.next_checkpoint as f32,
                    if leads { 1.0 } else { 0.0 },
                )
            }
            _ => (0.0, 0.0, 0.0, 0.0),
        };
        let pos = player.map_or(Vec3::ZERO, |p| self.cars[p].motion.position);
        let fwd = player.map_or(Vec3::NEG_Z, |p| self.cars[p].motion.body_frame.forward);
        let rpos = rival.map_or(Vec3::ZERO, |r| self.cars[r].motion.position);
        out[0] = state;
        out[1] = laps;
        out[2] = player.map_or(0.0, |p| self.cars[p].speed);
        out[3] = next_cp;
        out[4] = self.gates_passed;
        out[5] = rival_leads;
        out[6] = pos.x;
        out[7] = pos.y;
        out[8] = pos.z;
        out[9] = fwd.x;
        out[10] = fwd.y;
        out[11] = fwd.z;
        out[12] = rpos.x;
        out[13] = rpos.y;
        out[14] = rpos.z;
    }
}

fn push_pose(buf: &mut Vec<f32>, id: i32, p: Vec3, q: Quat) {
    buf.extend_from_slice(&[
        id as f32, p.x, p.y, p.z, q.x, q.y, q.z, q.w, 1.0, 1.0, 1.0,
    ]);
}

/// Move the camera, preserving whatever lens the guest configured.
fn write_camera(store: &mut Store, scene: i32, eye: Vec3, rot: Quat) {
    let Some(sc) = store.scene(scene) else { return };
    let (fov_y, znear, zfar) = {
        let c = &sc.env.camera;
        (c.fov_y, c.znear, c.zfar)
    };
    store.camera(
        scene, eye.x, eye.y, eye.z, rot.x, rot.y, rot.z, rot.w, fov_y, znear, zfar,
    );
}

/// Re-exported for the mount: the identity frame a fresh car reports.
pub const IDENTITY_FRAME: Frame = Frame::IDENTITY;
