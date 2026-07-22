//! The `sim` surface: one [`Sim`] + the SimOps contract (playset/sim/ops.ts)
//! mounted into a desktop guest as `globalThis.ps`.
//!
//! This is the DESKTOP twin of native/src/playset.rs. Same op names, same
//! argument order, same defaults, same silent-on-unknown-handle discipline —
//! only the binding mechanism differs (rquickjs here, the QuickJS C API
//! there), because one guest bundle has to run on both hosts unchanged. When
//! you change anything in this file, change its twin in the same commit; the
//! contract file is the arbiter of who is wrong.
//!
//! Mirrors pocket-scene3d's [`Scene3dSurface::mount`] shape: every op is a
//! native function over a shared `Rc<RefCell<_>>`, batched payloads arrive as
//! typed arrays and are copied out before returning to JS, and the surface
//! handle is clone-cheap because the guest realm is single-threaded.
//!
//! THE POINT of this mount is what does NOT cross it. `step` runs a whole
//! simulation turn natively and writes the resulting chassis/wheel poses
//! straight into the [`Store`] this host already owns — the ~20 pose writes
//! per frame never become JS values. The guest's entire per-frame traffic is
//! one `step` call and one 15-float `readHud` copy-out.

use std::cell::RefCell;
use std::rc::Rc;

use anyhow::Result;
use glam::Vec3;
use pocket_mod::Guest;
use pocket_mod::qjs::{Function, TypedArray};
use pocket_scene3d::Scene3dSurface;

use crate::behavior::{
    pose_offset, CameraRig, CameraRigCfg, PathNavigator, RacePlay, WaypointDriver, WaypointTracker,
};
use crate::terrain::{Heightfield, RoadTerrain, Terrain};
use crate::vehicle::CarTuning;
use crate::{
    collider_kind, Sim, COLLIDER_FLAG_SOLID, COLLIDER_FLAG_WALKABLE, COLLIDER_STRIDE, HUD_FLOATS,
};

/// The `ps` surface.
///
/// It holds the sim AND a clone of the host's [`Scene3dSurface`]. That second
/// handle is the whole reason the composite `step` can exist: the sim writes
/// poses and the camera into the SAME store the renderer walks, so the pose
/// batch never round-trips through JS. The PSP twin reaches the store through
/// `crate::scene3d::store()` (one static per process); here the store already
/// has a clone-cheap owner, so we borrow it the way pocket-scene3d already
/// hands it out — [`Scene3dSurface::with_store`] — instead of inventing a
/// second sharing mechanism. The two `RefCell`s are disjoint, so `step` can
/// hold both borrows at once.
#[derive(Clone)]
pub struct SimSurface {
    inner: Rc<RefCell<Sim>>,
    scene3d: Scene3dSurface,
}

/// Decode a typed-array argument into an owned Vec (alignment-safe: the
/// QuickJS buffer may sit at any byte offset). Detached arrays read empty.
/// The PSP twin's `arg_pods` does the same copy-out for the same reason —
/// nothing here ever retains a guest buffer past the call.
fn pods<T: bytemuck::Pod>(arr: &TypedArray<'_, T>) -> Vec<T> {
    arr.as_bytes().map(bytemuck::pod_collect_to_vec).unwrap_or_default()
}

/// u32 payloads (button masks, collider flags) arrive as JS numbers that may
/// exceed i32 range (`>>> 0` on the guest side); route through f64 -> i64.
fn as_u32(v: f64) -> u32 {
    v as i64 as u32
}

/// Read a config float, or `fallback` when the block is short — assembly ops
/// stay forward-compatible with guests built against an older contract.
/// Verbatim from the PSP twin's `cfg`; the fallbacks below must match it
/// value-for-value or the two hosts drift on a short block.
fn cfg(block: &[f32], i: usize, fallback: f32) -> f32 {
    block.get(i).copied().unwrap_or(fallback)
}

impl SimSurface {
    /// Build the surface over the host's scene3d store. Call with the same
    /// [`Scene3dSurface`] the host mounts as `s3` and renders from — a sim
    /// bound to a different store would write poses nobody draws.
    pub fn new(scene3d: &Scene3dSurface) -> SimSurface {
        SimSurface {
            inner: Rc::new(RefCell::new(Sim::new())),
            scene3d: scene3d.clone(),
        }
    }

    /// Borrow the sim (hosts don't need this — the sim is guest-driven — but
    /// tools and tests do, and it mirrors `Scene3dSurface::with_store`).
    pub fn with_sim<R>(&self, f: impl FnOnce(&mut Sim) -> R) -> R {
        f(&mut self.inner.borrow_mut())
    }

    /// Mount `globalThis.ps` into `guest`. Call before evaluating the bundle,
    /// alongside the `ui` and `s3` mounts. A host that skips this is not
    /// broken: `detectSim()` returns null and the guest runs the TS module
    /// composition instead (graceful absence, same as `s3`).
    pub fn mount(&self, guest: &Guest) -> Result<()> {
        guest.mount("ps", |ctx, ns| {
            macro_rules! op {
                ($name:literal, $f:expr) => {
                    ns.set($name, Function::new(ctx.clone(), $f)?)?;
                };
            }

            // -- worlds ------------------------------------------------------
            let s = self.inner.clone();
            op!("worldCreate", move |scene: i32| s.borrow_mut().world_create(scene));

            let s = self.inner.clone();
            op!("worldDestroy", move |world: i32| s.borrow_mut().destroy(world));

            // -- terrain -----------------------------------------------------
            // The PREFERRED terrain op: it samples the exact height grid the
            // visible mesh was tessellated from, so physics and pixels agree.
            // The procedural samplers below hash through `sin`, which does not
            // agree between the guest's f64 mesh build and this f32 core.
            let s = self.inner.clone();
            op!(
                "terrainHeightfield",
                move |world: i32, size: f64, side: i32, heights: TypedArray<f32>| {
                    let heights = pods(&heights);
                    let side = side.max(0) as usize;
                    if let Some(w) = s.borrow_mut().rally(world) {
                        w.set_terrain(Terrain::Grid(Heightfield::new(size as f32, side, &heights)));
                    }
                }
            );

            let s = self.inner.clone();
            op!("terrainRoad", move |world: i32, config: TypedArray<f32>| {
                let c = pods(&config);
                if let Some(w) = s.borrow_mut().rally(world) {
                    let mut road = RoadTerrain::new();
                    road.seed = cfg(&c, 0, 2026.0);
                    road.road_half_width = cfg(&c, 1, 6.0);
                    road.road_height = cfg(&c, 2, 0.0);
                    road.road_flatness_at_half_width = cfg(&c, 3, 0.8);
                    road.large_wave_scale = cfg(&c, 4, 0.05);
                    road.large_wave_amp = cfg(&c, 5, 1.45);
                    road.mid_noise_scale = cfg(&c, 6, 0.12);
                    road.mid_noise_amp = cfg(&c, 7, 1.15);
                    road.normal_step = cfg(&c, 8, 0.2);
                    w.set_terrain(Terrain::Road(road));
                }
            });

            // Segments arrive in their own batch after `terrainRoad`, so this
            // mutates the installed sampler rather than rebuilding it.
            let s = self.inner.clone();
            op!(
                "terrainRoadSegments",
                move |world: i32, segments: TypedArray<f32>, count: i32| {
                    let segs = pods(&segments);
                    let count = (count.max(0) as usize).min(segs.len() / 4);
                    if let Some(w) = s.borrow_mut().rally(world) {
                        w.with_road_terrain(|road| {
                            for i in 0..count {
                                let s = &segs[i * 4..i * 4 + 4];
                                road.push_segment(s[0], s[1], s[2], s[3]);
                            }
                        });
                    }
                }
            );

            // -- static colliders ---------------------------------------------
            let s = self.inner.clone();
            op!(
                "collidersAdd",
                move |world: i32, kinds: TypedArray<u32>, data: TypedArray<f32>, count: i32| {
                    let kinds = pods(&kinds);
                    let data = pods(&data);
                    let count = (count.max(0) as usize)
                        .min(kinds.len())
                        .min(data.len() / COLLIDER_STRIDE);
                    if let Some(w) = s.borrow_mut().rally(world) {
                        let world = w.collision_mut();
                        for i in 0..count {
                            let d = &data[i * COLLIDER_STRIDE..(i + 1) * COLLIDER_STRIDE];
                            let position = Vec3::new(d[0], d[1], d[2]);
                            let flags = d[7] as i64 as u32;
                            let solid = flags & COLLIDER_FLAG_SOLID != 0;
                            let walkable = flags & COLLIDER_FLAG_WALKABLE != 0;
                            match kinds[i] {
                                collider_kind::CYLINDER => {
                                    world.add_cylinder(position, d[3], d[4], solid, walkable);
                                }
                                collider_kind::BALL => {
                                    world.add_ball(position, d[3], solid, walkable);
                                }
                                _ => {
                                    world.add_cuboid(
                                        position,
                                        Vec3::new(d[3], d[4], d[5]),
                                        d[6],
                                        solid,
                                        walkable,
                                    );
                                }
                            }
                        }
                    }
                }
            );

            // -- cars ----------------------------------------------------------
            let s = self.inner.clone();
            op!("carCreate", move |world: i32, tuning: TypedArray<f32>| {
                let t = pods(&tuning);
                let d = CarTuning::default();
                let tuning = CarTuning {
                    max_forward_speed: cfg(&t, 0, d.max_forward_speed),
                    max_reverse_speed: cfg(&t, 1, d.max_reverse_speed),
                    throttle_accel: cfg(&t, 2, d.throttle_accel),
                    reverse_accel: cfg(&t, 3, d.reverse_accel),
                    engine_brake: cfg(&t, 4, d.engine_brake),
                    steer_lag: cfg(&t, 5, d.steer_lag),
                    steer_angle_max: cfg(&t, 6, d.steer_angle_max),
                    wheel_base: cfg(&t, 7, d.wheel_base),
                    ride_height: cfg(&t, 8, d.ride_height),
                    boost_multiplier: cfg(&t, 9, d.boost_multiplier),
                };
                match s.borrow_mut().rally(world) {
                    Some(w) => w.car_create(tuning),
                    None => 0,
                }
            });

            let s = self.inner.clone();
            op!(
                "carReset",
                move |world: i32, car: i32, x: f64, y: f64, z: f64, yaw: f64| {
                    let p = Vec3::new(x as f32, y as f32, z as f32);
                    if let Some(w) = s.borrow_mut().rally(world) {
                        w.car_reset(car, p, yaw as f32);
                    }
                }
            );

            let s = self.inner.clone();
            op!(
                "carBindVisual",
                move |world: i32,
                      car: i32,
                      group: i32,
                      wheels: TypedArray<i32>,
                      pivots: TypedArray<i32>,
                      wheel_radius: f64,
                      local_offsets: TypedArray<f32>| {
                    let wheels = pods(&wheels);
                    let pivots = pods(&pivots);
                    // [wheel xyz…][pivot xyz…] — see ops.ts for why these
                    // travel with the bind instead of being read back out of
                    // the store.
                    let offsets = pods(&local_offsets);
                    let take = |from: usize, n: usize| -> Vec<Vec3> {
                        (0..n)
                            .map(|i| {
                                let o = (from + i) * 3;
                                if o + 2 < offsets.len() {
                                    Vec3::new(offsets[o], offsets[o + 1], offsets[o + 2])
                                } else {
                                    Vec3::ZERO
                                }
                            })
                            .collect()
                    };
                    let wheel_offsets = take(0, wheels.len());
                    let pivot_offsets = take(wheels.len(), pivots.len());
                    if let Some(w) = s.borrow_mut().rally(world) {
                        w.car_bind_visual(
                            car,
                            group,
                            &wheels,
                            &pivots,
                            wheel_radius as f32,
                            &wheel_offsets,
                            &pivot_offsets,
                        );
                    }
                }
            );

            let s = self.inner.clone();
            op!(
                "carActor",
                move |world: i32, car: i32, hx: f64, hy: f64, hz: f64| {
                    let half = Vec3::new(hx as f32, hy as f32, hz as f32);
                    if let Some(w) = s.borrow_mut().rally(world) {
                        w.car_actor(car, half);
                    }
                }
            );

            let s = self.inner.clone();
            op!(
                "carBrain",
                move |world: i32,
                      car: i32,
                      waypoints: TypedArray<f32>,
                      count: i32,
                      config: TypedArray<f32>| {
                    let pts = pods(&waypoints);
                    let count = (count.max(0) as usize).min(pts.len() / 3);
                    let c = pods(&config);
                    let mut waypoints: Vec<Vec3> = Vec::with_capacity(count);
                    for i in 0..count {
                        waypoints.push(Vec3::new(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]));
                    }
                    if let Some(w) = s.borrow_mut().rally(world) {
                        let mut tracker =
                            WaypointTracker::new(&waypoints, cfg(&c, 0, 6.0), cfg(&c, 1, 1.0) != 0.0);
                        // Start on gate 0, like the TS path's explicit
                        // `tracker.reset(0)`. Without it the first step snaps
                        // to whichever gate is nearest the spawn — which is
                        // not always the one ahead.
                        tracker.reset(0);
                        let navigator = PathNavigator::new(cfg(&c, 2, 14.0), cfg(&c, 3, 10.0));
                        let driver =
                            WaypointDriver::new(cfg(&c, 4, 14.0), cfg(&c, 5, 5.0), cfg(&c, 6, 8.0));
                        w.car_brain(car, tracker, navigator, driver);
                    }
                }
            );

            // -- race ----------------------------------------------------------
            let s = self.inner.clone();
            op!(
                "raceInit",
                move |world: i32, checkpoints: TypedArray<f32>, count: i32, lap_count: i32| {
                    let cps = pods(&checkpoints);
                    let count = (count.max(0) as usize).min(cps.len() / 4);
                    let laps = lap_count.max(1) as u32;
                    if let Some(w) = s.borrow_mut().rally(world) {
                        let mut race = RacePlay::new(laps);
                        for i in 0..count {
                            let c = &cps[i * 4..i * 4 + 4];
                            race.push_checkpoint(Vec3::new(c[0], c[1], c[2]), c[3]);
                        }
                        w.race_init(race);
                    }
                }
            );

            // -- camera ---------------------------------------------------------
            let s = self.inner.clone();
            op!("cameraRig", move |world: i32, car: i32, config: TypedArray<f32>| {
                let c = pods(&config);
                if let Some(w) = s.borrow_mut().rally(world) {
                    w.camera_rig(
                        car,
                        CameraRig::new(CameraRigCfg {
                            // The config floats arrive as BASIS components
                            // (right, up, forward); `pose_offset` is the
                            // from_basis encoding the rig expects. Passing a
                            // raw Vec3 here puts the chase camera in FRONT of
                            // the car (forward is -Z).
                            camera_offset: pose_offset(
                                cfg(&c, 0, 0.0),
                                cfg(&c, 1, 3.4),
                                cfg(&c, 2, -7.5),
                            ),
                            look_at_offset: pose_offset(
                                cfg(&c, 3, 0.0),
                                cfg(&c, 4, 1.1),
                                cfg(&c, 5, 5.0),
                            ),
                            speed_camera_offset: pose_offset(
                                cfg(&c, 6, 0.0),
                                cfg(&c, 7, 0.0),
                                cfg(&c, 8, 0.0),
                            ),
                            position_lag: cfg(&c, 9, 0.16),
                            look_lag: cfg(&c, 10, 0.1),
                        }),
                    );
                }
            });

            // -- snake assembly (ops.ts snake* ops) ------------------------------
            let s = self.inner.clone();
            op!("snakeCreate", move |scene: i32| s.borrow_mut().snake_create(scene));

            let s = self.inner.clone();
            op!("snakeConfig", move |world: i32, config: TypedArray<f32>| {
                let c = pods(&config);
                if let Some(w) = s.borrow_mut().snake(world) {
                    w.configure(
                        cfg(&c, 0, 16.0) as i32,
                        cfg(&c, 1, 16.0) as i32,
                        cfg(&c, 2, 1.0),
                        Vec3::new(cfg(&c, 3, 0.0), cfg(&c, 4, 0.0), cfg(&c, 5, 0.0)),
                        cfg(&c, 6, 150.0),
                        cfg(&c, 7, 70.0),
                        cfg(&c, 8, 4.0),
                        cfg(&c, 9, 4.0) as i32,
                        cfg(&c, 10, 64.0) as i32,
                        cfg(&c, 11, 1337.0) as i64 as u32,
                    );
                }
            });

            let s = self.inner.clone();
            op!(
                "snakeAddSnake",
                move |world: i32, sr: i32, sf: i32, dr: i32, df: i32, rival: i32| -> i32 {
                    match s.borrow_mut().snake(world) {
                        Some(w) => w.add_snake(sr, sf, dr, df, rival != 0) as i32,
                        None => 0,
                    }
                }
            );

            let s = self.inner.clone();
            op!(
                "snakeBrain",
                move |world: i32, snake: i32, space: f64, apple: f64, tail: f64, straight: f64| {
                    if let Some(w) = s.borrow_mut().snake(world) {
                        w.set_brain(snake as usize, space as f32, apple as f32, tail as f32, straight as f32);
                    }
                }
            );

            let s = self.inner.clone();
            op!("snakeBindVisual", move |world: i32, snake: i32, ids: TypedArray<i32>| {
                let ids = pods(&ids);
                if let Some(w) = s.borrow_mut().snake(world) {
                    w.bind_snake_visual(snake as usize, &ids);
                }
            });

            let s = self.inner.clone();
            op!("snakeBindApple", move |world: i32, node: i32| {
                if let Some(w) = s.borrow_mut().snake(world) {
                    w.bind_apple_visual(node);
                }
            });

            // -- the per-frame pair ----------------------------------------------
            // `step` holds BOTH borrows — the sim and the scene3d store — for
            // the length of one turn. They are separate RefCells (the store's
            // owner is the host's Scene3dSurface), so this is not reentrancy:
            // nothing inside the native step calls back into the guest.
            let s = self.inner.clone();
            let scene3d = self.scene3d.clone();
            op!("step", move |world: i32, dt: f64, buttons: f64| {
                let buttons = as_u32(buttons);
                // Generic over the game kind: GameWorld decodes the mask itself
                // (a car reads steer/throttle, a snake reads the d-pad), so the
                // mount just forwards it — the PSP twin does the same.
                scene3d.with_store(|store| {
                    s.borrow_mut().step(world, store, dt as f32, buttons);
                });
            });

            let s = self.inner.clone();
            op!("readHud", move |world: i32, out: TypedArray<f32>| {
                // Writes THROUGH the guest's Float32Array — the one place this
                // surface hands data back, and the only reason the guest needs
                // a per-frame call at all. `as_raw` yields the typed array's
                // own view (byte offset already applied) and returns None on a
                // detached buffer; the pointer is used and dropped inside this
                // call, never retained.
                let Some(raw) = out.as_raw() else { return };
                // HUD width is per-game; write min(buffer, widest). A snake
                // buffer of 5 floats gets 5, a rally buffer of 15 gets 15.
                let count = (raw.len / 4).min(HUD_FLOATS);
                if count == 0 {
                    return;
                }
                let mut scratch = [0f32; HUD_FLOATS];
                s.borrow_mut().read_hud(world, &mut scratch[..count]);
                // SAFETY: `raw` is QuickJS's live buffer for `out`, at least
                // `count` f32s long; a byte copy needs no alignment.
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        scratch.as_ptr() as *const u8,
                        raw.ptr.as_ptr(),
                        count * 4,
                    );
                }
            });

            // Honest host label (ops.ts __host). "wgpu" here, "psp" on the PSP
            // twin — the guest uses it for diagnostics only, never to branch.
            ns.set("__host", "wgpu")?;

            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every op name in the SimOps interface (playset/sim/ops.ts), in
    /// contract order. A guest calling one this host forgot would blow up
    /// mid-frame, so pin the surface shape rather than trusting review.
    const CONTRACT_OPS: &[&str] = &[
        "worldCreate",
        "worldDestroy",
        "terrainHeightfield",
        "terrainRoad",
        "terrainRoadSegments",
        "collidersAdd",
        "carCreate",
        "carReset",
        "carBindVisual",
        "carActor",
        "carBrain",
        "raceInit",
        "cameraRig",
        "snakeCreate",
        "snakeConfig",
        "snakeAddSnake",
        "snakeBrain",
        "snakeBindVisual",
        "snakeBindApple",
        "step",
        "readHud",
    ];

    fn mounted() -> Guest {
        let guest = Guest::new().unwrap();
        let scene3d = Scene3dSurface::new();
        scene3d.mount(&guest).unwrap();
        SimSurface::new(&scene3d).mount(&guest).unwrap();
        guest
    }

    #[test]
    fn mounts_every_contract_op_and_the_host_label() {
        let guest = mounted();
        let probe = format!(
            "globalThis.missing = {:?}.filter((n) => typeof ps[n] !== 'function').join(',');
             globalThis.host = ps.__host;
             globalThis.detected = typeof ps.worldCreate === 'function';",
            CONTRACT_OPS
        );
        guest.eval("probe", &probe).unwrap();
        let missing: String = guest.with(|ctx| ctx.globals().get("missing").unwrap());
        assert_eq!(missing, "", "ps is missing contract ops");
        let host: String = guest.with(|ctx| ctx.globals().get("host").unwrap());
        assert_eq!(host, "wgpu");
        // detectSim()'s exact test.
        let detected: bool = guest.with(|ctx| ctx.globals().get("detected").unwrap());
        assert!(detected);
    }

    /// Handles start at 1 and unknown ones are inert — ops are intent, and a
    /// stale handle must never throw into a guest frame.
    #[test]
    fn handles_start_at_one_and_stale_ones_are_inert() {
        let guest = mounted();
        guest
            .eval(
                "probe",
                "globalThis.w = ps.worldCreate(1);
                 ps.worldDestroy(9999);
                 ps.terrainRoad(9999, new Float32Array(9));
                 ps.terrainHeightfield(9999, 64, 4, new Float32Array(16));
                 ps.carReset(9999, 1, 0, 0, 0, 0);
                 globalThis.orphan = ps.carCreate(9999, new Float32Array(0));
                 ps.step(9999, 1 / 60, 0);",
            )
            .unwrap();
        let w: i32 = guest.with(|ctx| ctx.globals().get("w").unwrap());
        assert_eq!(w, 1);
        let orphan: i32 = guest.with(|ctx| ctx.globals().get("orphan").unwrap());
        assert_eq!(orphan, 0, "carCreate on an unknown world yields the null handle");
    }

    /// `readHud` writes through the guest's buffer, filling as many floats as
    /// both the world defines and the buffer holds, and never past its end.
    /// HUD width is per-game now (rally 15, snake 5), so a buffer shorter than
    /// the widest is FILLED to its own length, not left alone — only past its
    /// end is off-limits.
    #[test]
    fn read_hud_writes_through_up_to_the_buffer_length() {
        let guest = mounted();
        guest
            .eval(
                "probe",
                "const w = ps.worldCreate(1);
                 const out = new Float32Array(15).fill(7);
                 ps.readHud(w, out);
                 globalThis.filled = Array.from(out).join(',');
                 // A 5-float buffer (a snake-width HUD) is filled to 5; the
                 // guard is the sentinel past its end, not the whole write.
                 const shorter = new Float32Array(6).fill(7);
                 shorter[5] = 9;
                 ps.readHud(w, shorter.subarray(0, 5));
                 globalThis.partial = Array.from(shorter).join(',');",
            )
            .unwrap();
        let filled: String = guest.with(|ctx| ctx.globals().get("filled").unwrap());
        // A carless world reads zero everywhere except the player forward
        // vector, which World::read_hud defaults to -Z (index 11).
        assert_eq!(filled, "0,0,0,0,0,0,0,0,0,0,0,-1,0,0,0");
        let partial: String = guest.with(|ctx| ctx.globals().get("partial").unwrap());
        // First 5 written (all zero for a carless world), the 6th sentinel
        // untouched — the write stopped at the buffer length.
        assert_eq!(partial, "0,0,0,0,0,9", "fills to the buffer length, no further");
    }
}
