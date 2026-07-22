//! QuickJS bindings: the `globalThis.ps` namespace — the PSP side of the
//! SimOps contract (playset/sim/ops.ts). The sim state is the SAME
//! [`pocket_playset::Sim`] the desktop host runs (built here with
//! `default-features = false`: no_std + alloc), so sim semantics cannot drift
//! between hosts.
//!
//! Registration mirrors scene3d.rs's `s3` pattern: JS_NewCFunction2 +
//! JS_SetPropertyStr onto one object installed on the global, one static sim,
//! one JS thread. Assembly payloads (colliders, waypoints, checkpoints,
//! config blocks) arrive as typed arrays and are copied out before returning
//! to JS.
//!
//! THE POINT of this mount is what does NOT cross it. `step` runs a whole
//! simulation turn natively and writes the resulting chassis/wheel poses
//! straight into the scene3d [`Store`] this host already owns — the ~20 pose
//! writes per frame (and the 550-node flush diff behind them) never become
//! JS values. The guest's per-frame traffic is one `step` call and one
//! 15-float `readHud` copy-out.

use alloc::vec::Vec;

use libquickjs_sys::*;
use pocket_playset::behavior::{
    pose_offset, CameraRig, CameraRigCfg, PathNavigator, RacePlay, WaypointDriver, WaypointTracker,
};
use pocket_playset::terrain::{Heightfield, RoadTerrain, Terrain};
use pocket_playset::vehicle::CarTuning;
use pocket_playset::{collider_kind, Sim, COLLIDER_FLAG_SOLID, COLLIDER_FLAG_WALKABLE, COLLIDER_STRIDE, HUD_FLOATS};

use glam::Vec3;

use crate::ffi::{add_fn, arg_f64, arg_i32, buffer_bytes};

/// Boot-op breadcrumbs. The assembly ops run inside JS_Eval, where the only
/// visible symptom of a wedge is "eval never returned" — so each one leaves a
/// mark in the same host0: trace file main.rs writes. Off unless the build
/// carries POCKETJS_TRACE=1.
unsafe fn ps_trace(msg: &str) {
    if env!("POCKETJS_TRACE") != "1" {
        return;
    }
    let fd = psp::sys::sceIoOpen(
        b"host0:/PocketJS-trace.txt\0".as_ptr(),
        psp::sys::IoOpenFlags::WR_ONLY | psp::sys::IoOpenFlags::CREAT | psp::sys::IoOpenFlags::APPEND,
        0o777,
    );
    if fd.0 >= 0 {
        psp::sys::sceIoWrite(fd, b"[ps] ".as_ptr() as *const core::ffi::c_void, 5);
        psp::sys::sceIoWrite(fd, msg.as_ptr() as *const core::ffi::c_void, msg.len());
        psp::sys::sceIoWrite(fd, b"\n".as_ptr() as *const core::ffi::c_void, 1);
        psp::sys::sceIoClose(fd);
    }
}

static mut SIM: Option<Sim> = None;

/// The single sim registry. Lazily created (apps without `ps` never touch it).
pub unsafe fn sim() -> &'static mut Sim {
    if SIM.is_none() {
        SIM = Some(Sim::new());
    }
    SIM.as_mut().unwrap()
}

// ---------------------------------------------------------------------------
// arg helpers (scene3d.rs parity: typed arrays are copied out, never retained)
// ---------------------------------------------------------------------------

#[inline]
unsafe fn arg_f32(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> f32 {
    arg_f64(ctx, argc, argv, i) as f32
}

#[inline]
unsafe fn arg_u32(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> u32 {
    arg_f64(ctx, argc, argv, i) as i64 as u32
}

unsafe fn arg_pods<T: Copy>(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> Vec<T> {
    if (i as i32) >= argc {
        return Vec::new();
    }
    let Some((p, len)) = buffer_bytes(ctx, *argv.offset(i)) else {
        return Vec::new();
    };
    let n = len / core::mem::size_of::<T>();
    let mut out: Vec<T> = Vec::with_capacity(n);
    core::ptr::copy_nonoverlapping(p, out.as_mut_ptr() as *mut u8, n * core::mem::size_of::<T>());
    out.set_len(n);
    out
}

/// Read a config float, or `fallback` when the block is short — assembly ops
/// stay forward-compatible with guests built against an older contract.
#[inline]
fn cfg(block: &[f32], i: usize, fallback: f32) -> f32 {
    block.get(i).copied().unwrap_or(fallback)
}

// ---------------------------------------------------------------------------
// ops
// ---------------------------------------------------------------------------

macro_rules! js_op {
    ($name:ident, |$ctx:ident, $argc:ident, $argv:ident| $body:expr) => {
        unsafe extern "C" fn $name(
            $ctx: *mut JSContext,
            _this: JSValue,
            $argc: i32,
            $argv: *mut JSValue,
        ) -> JSValue {
            $body
        }
    };
}

js_op!(js_world_create, |ctx, argc, argv| {
    ps_trace("worldCreate");
    JS_NewInt32(ctx, sim().world_create(arg_i32(ctx, argc, argv, 0)))
});
js_op!(js_world_destroy, |ctx, argc, argv| {
    sim().destroy(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
});

js_op!(js_terrain_heightfield, |ctx, argc, argv| {
    ps_trace("terrainHeightfield");
    let size = arg_f32(ctx, argc, argv, 1);
    let side = arg_i32(ctx, argc, argv, 2).max(0) as usize;
    let heights = arg_pods::<f32>(ctx, argc, argv, 3);
    if let Some(w) = sim().rally(arg_i32(ctx, argc, argv, 0)) {
        w.set_terrain(Terrain::Grid(Heightfield::new(size, side, &heights)));
    }
    JS_UNDEFINED
});

js_op!(js_terrain_road, |ctx, argc, argv| {
    ps_trace("terrainRoad");
    let c = arg_pods::<f32>(ctx, argc, argv, 1);
    if let Some(w) = sim().rally(arg_i32(ctx, argc, argv, 0)) {
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
    JS_UNDEFINED
});

js_op!(js_terrain_road_segments, |ctx, argc, argv| {
    ps_trace("terrainRoadSegments");
    let segs = arg_pods::<f32>(ctx, argc, argv, 1);
    let count = (arg_i32(ctx, argc, argv, 2).max(0) as usize).min(segs.len() / 4);
    if let Some(w) = sim().rally(arg_i32(ctx, argc, argv, 0)) {
        w.with_road_terrain(|road| {
            for i in 0..count {
                let s = &segs[i * 4..i * 4 + 4];
                road.push_segment(s[0], s[1], s[2], s[3]);
            }
        });
    }
    JS_UNDEFINED
});

js_op!(js_colliders_add, |ctx, argc, argv| {
    ps_trace("collidersAdd");
    let kinds = arg_pods::<u32>(ctx, argc, argv, 1);
    let data = arg_pods::<f32>(ctx, argc, argv, 2);
    let count = (arg_i32(ctx, argc, argv, 3).max(0) as usize)
        .min(kinds.len())
        .min(data.len() / COLLIDER_STRIDE);
    if let Some(w) = sim().rally(arg_i32(ctx, argc, argv, 0)) {
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
                    world.add_cuboid(position, Vec3::new(d[3], d[4], d[5]), d[6], solid, walkable);
                }
            }
        }
    }
    JS_UNDEFINED
});

js_op!(js_car_create, |ctx, argc, argv| {
    ps_trace("carCreate");
    let t = arg_pods::<f32>(ctx, argc, argv, 1);
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
    let id = match sim().rally(arg_i32(ctx, argc, argv, 0)) {
        Some(w) => w.car_create(tuning),
        None => 0,
    };
    JS_NewInt32(ctx, id)
});

js_op!(js_car_reset, |ctx, argc, argv| {
    ps_trace("carReset");
    let car = arg_i32(ctx, argc, argv, 1);
    let p = Vec3::new(
        arg_f32(ctx, argc, argv, 2),
        arg_f32(ctx, argc, argv, 3),
        arg_f32(ctx, argc, argv, 4),
    );
    let yaw = arg_f32(ctx, argc, argv, 5);
    if let Some(w) = sim().rally(arg_i32(ctx, argc, argv, 0)) {
        w.car_reset(car, p, yaw);
    }
    JS_UNDEFINED
});

js_op!(js_car_bind_visual, |ctx, argc, argv| {
    ps_trace("carBindVisual");
    let car = arg_i32(ctx, argc, argv, 1);
    let group = arg_i32(ctx, argc, argv, 2);
    let wheels = arg_pods::<i32>(ctx, argc, argv, 3);
    let pivots = arg_pods::<i32>(ctx, argc, argv, 4);
    let radius = arg_f32(ctx, argc, argv, 5);
    // [wheel xyz…][pivot xyz…] — see ops.ts for why these travel with the bind
    // instead of being read back out of the store.
    let offsets = arg_pods::<f32>(ctx, argc, argv, 6);
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
    if let Some(w) = sim().rally(arg_i32(ctx, argc, argv, 0)) {
        w.car_bind_visual(
            car,
            group,
            &wheels,
            &pivots,
            radius,
            &wheel_offsets,
            &pivot_offsets,
        );
    }
    JS_UNDEFINED
});

js_op!(js_car_actor, |ctx, argc, argv| {
    ps_trace("carActor");
    let car = arg_i32(ctx, argc, argv, 1);
    let half = Vec3::new(
        arg_f32(ctx, argc, argv, 2),
        arg_f32(ctx, argc, argv, 3),
        arg_f32(ctx, argc, argv, 4),
    );
    if let Some(w) = sim().rally(arg_i32(ctx, argc, argv, 0)) {
        w.car_actor(car, half);
    }
    JS_UNDEFINED
});

js_op!(js_car_brain, |ctx, argc, argv| {
    ps_trace("carBrain");
    let car = arg_i32(ctx, argc, argv, 1);
    let pts = arg_pods::<f32>(ctx, argc, argv, 2);
    let count = (arg_i32(ctx, argc, argv, 3).max(0) as usize).min(pts.len() / 3);
    let c = arg_pods::<f32>(ctx, argc, argv, 4);
    let mut waypoints: Vec<Vec3> = Vec::with_capacity(count);
    for i in 0..count {
        waypoints.push(Vec3::new(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]));
    }
    if let Some(w) = sim().rally(arg_i32(ctx, argc, argv, 0)) {
        let mut tracker = WaypointTracker::new(&waypoints, cfg(&c, 0, 6.0), cfg(&c, 1, 1.0) != 0.0);
        // Start on gate 0, like the TS path's explicit `tracker.reset(0)`.
        // Without it the first step snaps to whichever gate is nearest the
        // spawn — which is not always the one ahead.
        tracker.reset(0);
        let navigator = PathNavigator::new(cfg(&c, 2, 14.0), cfg(&c, 3, 10.0));
        let driver = WaypointDriver::new(cfg(&c, 4, 14.0), cfg(&c, 5, 5.0), cfg(&c, 6, 8.0));
        w.car_brain(car, tracker, navigator, driver);
    }
    JS_UNDEFINED
});

js_op!(js_race_init, |ctx, argc, argv| {
    ps_trace("raceInit");
    let cps = arg_pods::<f32>(ctx, argc, argv, 1);
    let count = (arg_i32(ctx, argc, argv, 2).max(0) as usize).min(cps.len() / 4);
    let laps = arg_i32(ctx, argc, argv, 3).max(1) as u32;
    if let Some(w) = sim().rally(arg_i32(ctx, argc, argv, 0)) {
        let mut race = RacePlay::new(laps);
        for i in 0..count {
            let c = &cps[i * 4..i * 4 + 4];
            race.push_checkpoint(Vec3::new(c[0], c[1], c[2]), c[3]);
        }
        w.race_init(race);
    }
    JS_UNDEFINED
});

js_op!(js_camera_rig, |ctx, argc, argv| {
    ps_trace("cameraRig");
    let car = arg_i32(ctx, argc, argv, 1);
    let c = arg_pods::<f32>(ctx, argc, argv, 2);
    if let Some(w) = sim().rally(arg_i32(ctx, argc, argv, 0)) {
        w.camera_rig(
            car,
            CameraRig::new(CameraRigCfg {
                // The config floats arrive as BASIS components (right, up,
                // forward); `pose_offset` is the from_basis encoding the rig
                // expects. Passing a raw Vec3 here puts the chase camera in
                // FRONT of the car (forward is -Z).
                camera_offset: pose_offset(cfg(&c, 0, 0.0), cfg(&c, 1, 3.4), cfg(&c, 2, -7.5)),
                look_at_offset: pose_offset(cfg(&c, 3, 0.0), cfg(&c, 4, 1.1), cfg(&c, 5, 5.0)),
                speed_camera_offset: pose_offset(cfg(&c, 6, 0.0), cfg(&c, 7, 0.0), cfg(&c, 8, 0.0)),
                position_lag: cfg(&c, 9, 0.16),
                look_lag: cfg(&c, 10, 0.1),
            }),
        );
    }
    JS_UNDEFINED
});

// ---------------------------------------------------------------------------
// snake assembly (playset/sim/ops.ts snake* ops)
// ---------------------------------------------------------------------------

js_op!(js_snake_create, |ctx, argc, argv| JS_NewInt32(
    ctx,
    sim().snake_create(arg_i32(ctx, argc, argv, 0)),
));

js_op!(js_snake_config, |ctx, argc, argv| {
    // [columns, rows, cellSize, ox, oy, oz, baseTickMs, minTickMs,
    //  speedupMsPerPoint, initialLength, maxSegments, prngSeed]
    let c = arg_pods::<f32>(ctx, argc, argv, 1);
    if let Some(w) = sim().snake(arg_i32(ctx, argc, argv, 0)) {
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
    JS_UNDEFINED
});

js_op!(js_snake_add, |ctx, argc, argv| {
    let idx = match sim().snake(arg_i32(ctx, argc, argv, 0)) {
        Some(w) => w.add_snake(
            arg_i32(ctx, argc, argv, 1),
            arg_i32(ctx, argc, argv, 2),
            arg_i32(ctx, argc, argv, 3),
            arg_i32(ctx, argc, argv, 4),
            arg_i32(ctx, argc, argv, 5) != 0,
        ) as i32,
        None => 0,
    };
    JS_NewInt32(ctx, idx)
});

js_op!(js_snake_brain, |ctx, argc, argv| {
    let snake = arg_i32(ctx, argc, argv, 1) as usize;
    if let Some(w) = sim().snake(arg_i32(ctx, argc, argv, 0)) {
        w.set_brain(
            snake,
            arg_f32(ctx, argc, argv, 2),
            arg_f32(ctx, argc, argv, 3),
            arg_f32(ctx, argc, argv, 4),
            arg_f32(ctx, argc, argv, 5),
        );
    }
    JS_UNDEFINED
});

js_op!(js_snake_bind_visual, |ctx, argc, argv| {
    let snake = arg_i32(ctx, argc, argv, 1) as usize;
    let ids = arg_pods::<i32>(ctx, argc, argv, 2);
    if let Some(w) = sim().snake(arg_i32(ctx, argc, argv, 0)) {
        w.bind_snake_visual(snake, &ids);
    }
    JS_UNDEFINED
});

js_op!(js_snake_bind_apple, |ctx, argc, argv| {
    let node = arg_i32(ctx, argc, argv, 1);
    if let Some(w) = sim().snake(arg_i32(ctx, argc, argv, 0)) {
        w.bind_apple_visual(node);
    }
    JS_UNDEFINED
});

js_op!(js_step,  |ctx, argc, argv| {
    let dt = arg_f32(ctx, argc, argv, 1);
    let buttons = arg_u32(ctx, argc, argv, 2);
    let store = crate::scene3d::store();
    // Generic: GameWorld decodes the mask itself (a car reads steer/throttle,
    // a snake reads the d-pad), so the mount just forwards it.
    sim().step(arg_i32(ctx, argc, argv, 0), store, dt, buttons);
    JS_UNDEFINED
});

js_op!(js_read_hud, |ctx, argc, argv| {
    // Writes THROUGH the guest's Float32Array — the one place this surface
    // hands data back, and the only reason the guest needs a per-frame call
    // at all. QuickJS owns the buffer; we never retain the pointer.
    // HUD width is per-game now; write as many floats as both the world defines
    // and the guest buffer holds. HUD_FLOATS is the widest (rally); a snake
    // buffer of 5 floats gets 5.
    if argc > 1 {
        if let Some((p, len)) = buffer_bytes(ctx, *argv.offset(1)) {
            let count = (len / 4).min(HUD_FLOATS);
            if count > 0 {
                let mut scratch = [0f32; HUD_FLOATS];
                sim().read_hud(arg_i32(ctx, argc, argv, 0), &mut scratch[..count]);
                core::ptr::copy_nonoverlapping(
                    scratch.as_ptr() as *const u8,
                    p as *mut u8,
                    count * 4,
                );
            }
        }
    }
    JS_UNDEFINED
});

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

/// Install `globalThis.ps` (the full SimOps surface). Call before the bundle
/// evals, alongside ffi::register's `ui` and scene3d::register's `s3`.
pub unsafe fn register(ctx: *mut JSContext, global: JSValue) {
    let ps = JS_NewObject(ctx);

    add_fn(ctx, ps, b"worldCreate\0", js_world_create, 1);
    add_fn(ctx, ps, b"worldDestroy\0", js_world_destroy, 1);
    add_fn(ctx, ps, b"terrainHeightfield\0", js_terrain_heightfield, 4);
    add_fn(ctx, ps, b"terrainRoad\0", js_terrain_road, 2);
    add_fn(ctx, ps, b"terrainRoadSegments\0", js_terrain_road_segments, 3);
    add_fn(ctx, ps, b"collidersAdd\0", js_colliders_add, 4);
    add_fn(ctx, ps, b"carCreate\0", js_car_create, 2);
    add_fn(ctx, ps, b"carReset\0", js_car_reset, 6);
    add_fn(ctx, ps, b"carBindVisual\0", js_car_bind_visual, 7);
    add_fn(ctx, ps, b"carActor\0", js_car_actor, 5);
    add_fn(ctx, ps, b"carBrain\0", js_car_brain, 5);
    add_fn(ctx, ps, b"raceInit\0", js_race_init, 4);
    add_fn(ctx, ps, b"cameraRig\0", js_camera_rig, 3);
    add_fn(ctx, ps, b"step\0", js_step, 3);
    add_fn(ctx, ps, b"snakeCreate\0", js_snake_create, 1);
    add_fn(ctx, ps, b"snakeConfig\0", js_snake_config, 2);
    add_fn(ctx, ps, b"snakeAddSnake\0", js_snake_add, 6);
    add_fn(ctx, ps, b"snakeBrain\0", js_snake_brain, 6);
    add_fn(ctx, ps, b"snakeBindVisual\0", js_snake_bind_visual, 3);
    add_fn(ctx, ps, b"snakeBindApple\0", js_snake_bind_apple, 2);
    add_fn(ctx, ps, b"readHud\0", js_read_hud, 2);

    // Honest host label (ops.ts __host).
    let host = JS_NewStringLen(ctx, b"psp".as_ptr(), 3);
    JS_SetPropertyStr(ctx, ps, b"__host\0".as_ptr() as *const _, host);

    // JS_SetPropertyStr consumes ownership of ps.
    JS_SetPropertyStr(ctx, global, b"ps\0".as_ptr() as *const _, ps);
}

// libquickjs-sys omits JS_NewStringLen; the linked QuickJS C library provides
// it (same local-extern pattern as ffi.rs / scene3d.rs).
extern "C" {
    fn JS_NewStringLen(ctx: *mut JSContext, str1: *const u8, len1: usize) -> JSValue;
}
