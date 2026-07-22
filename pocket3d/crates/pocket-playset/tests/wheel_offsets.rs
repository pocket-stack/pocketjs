//! Wheel and steering-pivot nodes must keep their parent-local offsets.
//!
//! Reported from hardware: the front wheels stopped visibly swinging when the
//! car turns. The steering rotation was still being written — what went wrong
//! is WHERE. `write_car_visual` has to rewrite each wheel's translation
//! alongside its rotation (scene3d's `write_poses` always writes position), and
//! it used to read those translations back out of the store on its first step.
//!
//! The guest's loop calls `step` BEFORE `render`, and `render` is where
//! `Scene3D.flush()` pushes the freshly-built visual to the store — so on frame
//! 0 the sim read identity poses and pinned every wheel to the chassis origin,
//! where they are hidden inside the body. A car visual puts the offset on the
//! PIVOT (the wheel node itself sits at the pivot's origin), so all four wheels
//! collapsed into one invisible point and the steering swing went with them.

use glam::Vec3;
use pocket_playset::vehicle::CarTuning;
use pocket_playset::Sim;
use pocket_scene3d::Store;

/// The rally car's real wheel placement (car-visual-factory.ts).
const PIVOTS: [Vec3; 4] = [
    Vec3::new(-0.82, 0.35, -1.2),
    Vec3::new(0.82, 0.35, -1.2),
    Vec3::new(-0.82, 0.35, 1.25),
    Vec3::new(0.82, 0.35, 1.25),
];

#[test]
fn wheels_keep_their_local_offsets_when_the_sim_drives_them() {
    let mut store = Store::new();
    let scene = store.scene_create();

    // Build the visual the way the factory does: pivots carry the offset, the
    // spin node hangs off the pivot at its origin.
    let group = store.node_create(scene, 0);
    let mut pivots = [0i32; 4];
    let mut wheels = [0i32; 4];
    for i in 0..4 {
        pivots[i] = store.node_create(scene, group);
        wheels[i] = store.node_create(scene, pivots[i]);
    }

    let mut sim = Sim::new();
    let world_id = sim.world_create(scene);
    let world = sim.rally(world_id).expect("rally world");
    let car = world.car_create(CarTuning::default());
    world.car_reset(car, Vec3::ZERO, 0.0);
    world.car_bind_visual(car, group, &wheels, &pivots, 0.35, &[Vec3::ZERO; 4], &PIVOTS);

    // The sim steps BEFORE the guest's first flush — exactly the order the
    // game loop uses, and the order that used to lose the offsets.
    world.step(&mut store, 1.0 / 60.0);

    for (i, expected) in PIVOTS.iter().enumerate() {
        let got = store.node(pivots[i]).expect("pivot node").p;
        assert!(
            (got - *expected).length() < 1e-5,
            "pivot {i} should stay at its local offset {expected:?}, got {got:?}"
        );
    }
    for (i, id) in wheels.iter().enumerate() {
        let got = store.node(*id).expect("wheel node").p;
        assert!(
            got.length() < 1e-5,
            "wheel {i} rides at its pivot's origin, got {got:?}"
        );
    }
}

#[test]
fn steering_rotates_the_front_pivots_and_leaves_the_rear_ones_alone() {
    let mut store = Store::new();
    let scene = store.scene_create();
    let group = store.node_create(scene, 0);
    let mut pivots = [0i32; 4];
    let mut wheels = [0i32; 4];
    for i in 0..4 {
        pivots[i] = store.node_create(scene, group);
        wheels[i] = store.node_create(scene, pivots[i]);
    }

    let mut sim = Sim::new();
    let world_id = sim.world_create(scene);
    let world = sim.rally(world_id).expect("rally world");
    let car = world.car_create(CarTuning::default());
    world.car_reset(car, Vec3::ZERO, 0.0);
    world.car_bind_visual(car, group, &wheels, &pivots, 0.35, &[Vec3::ZERO; 4], &PIVOTS);

    // Roll forward under throttle first: the bicycle model only yaws while
    // moving, but the steering angle itself is speed-independent.
    for _ in 0..30 {
        world.set_buttons(false, false, true, false);
        world.step(&mut store, 1.0 / 60.0);
    }
    for _ in 0..30 {
        world.set_buttons(true, false, true, false); // hold left
        world.step(&mut store, 1.0 / 60.0);
    }

    let front = store.node(pivots[0]).expect("front pivot").q;
    let rear = store.node(pivots[2]).expect("rear pivot").q;
    assert!(
        front.angle_between(glam::Quat::IDENTITY) > 0.05,
        "a steering pivot should be visibly turned while holding left, got {front:?}"
    );
    assert!(
        rear.angle_between(glam::Quat::IDENTITY) < 1e-5,
        "rear pivots do not steer, got {rear:?}"
    );
}
