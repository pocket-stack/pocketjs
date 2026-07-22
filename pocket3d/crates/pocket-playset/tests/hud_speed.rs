//! The HUD mirror must report the player's speed.
//!
//! Written while chasing a `0 M/S` reading on the desktop host that turned out
//! not to be a bug at all — holding throttle with no steering drives this
//! closed circuit straight into the outer barrier, and the car really had
//! stopped. The test is worth keeping anyway: `read_hud` is the only channel
//! the guest sees, speed is the one field with no visual cross-check (position
//! shows up in the camera, gates in the counter), and nothing else covers it.

use glam::Vec3;
use pocket_playset::vehicle::CarTuning;
use pocket_playset::world::HUD_FLOATS;
use pocket_playset::Sim;
use pocket_scene3d::Store;

#[test]
fn hud_reports_player_speed_under_throttle() {
    let mut store = Store::new();
    let scene = store.scene_create();
    let mut sim = Sim::new();
    let world_id = sim.world_create(scene);
    let world = sim.rally(world_id).expect("rally world");

    let car = world.car_create(CarTuning {
        max_forward_speed: 22.0,
        engine_brake: 1.1,
        throttle_accel: 16.0,
        ..CarTuning::default()
    });
    world.car_reset(car, Vec3::ZERO, 0.0);
    world.car_actor(car, Vec3::new(0.9, 0.38, 1.5));

    let mut hud = [0f32; HUD_FLOATS];
    for _ in 0..120 {
        world.set_buttons(false, false, true, false); // throttle
        world.step(&mut store, 1.0 / 60.0);
    }
    world.read_hud(&mut hud);

    let travelled = world_position_z(&mut sim, world_id);
    assert!(
        travelled.abs() > 1.0,
        "the car should have moved under two seconds of throttle, got {travelled}"
    );
    assert!(
        hud[2] > 1.0,
        "HUD speed should follow the car; travelled {travelled} but HUD reported {}",
        hud[2]
    );
}

fn world_position_z(sim: &mut Sim, world_id: i32) -> f32 {
    let mut hud = [0f32; HUD_FLOATS];
    sim.rally(world_id).expect("rally world").read_hud(&mut hud);
    hud[8] // player z
}
