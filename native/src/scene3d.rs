//! QuickJS bindings: the `globalThis.s3` namespace — the PSP side of the
//! Scene3dOps contract (playset/scene3d/ops.ts). The retained state is the
//! SAME [`pocket_scene3d::Store`] the desktop uihost core uses (built here
//! with `default-features = false`: no_std + alloc, store only), so op
//! semantics cannot drift between hosts.
//!
//! Registration mirrors ffi.rs's `ui` pattern: JS_NewCFunction2 +
//! JS_SetPropertyStr onto one object installed on the global, one static
//! store, one JS thread. Batched writes (writePoses/writeSprites/writeBeams)
//! and geometry buffers arrive as typed arrays and are copied out before
//! returning to JS (alignment-safe; the desktop mount copies too); colors
//! and flags ride as f64 and convert through i64 (guest-side `>>> 0` may
//! exceed i32 range).
//!
//! Geometries are tessellated by the store at creation; ge3d bakes the GE
//! vertex/index buffers immediately after (ids are never reused, so the
//! baked registry never invalidates).

use alloc::vec::Vec;

use libquickjs_sys::*;
use pocket_scene3d::{PoolKind, Store};
use pocketjs_core::{spec, Ui};

use crate::ffi::{add_fn, arg_f64, arg_i32, buffer_bytes};

static mut STORE: Option<Store> = None;

/// The single scene3d store. Lazily created (plain-ui apps never touch it).
pub unsafe fn store() -> &'static mut Store {
    if STORE.is_none() {
        STORE = Some(Store::new());
    }
    STORE.as_mut().unwrap()
}

/// Forward queued bindViewport events into the ui core as PROP.scene3d
/// writes (spec op semantics: the core then emits SCENE_QUAD at the node's
/// laid-out rect). Call once per frame BEFORE ui.tick() — uihost's
/// apply_scene_bindings, ported.
pub unsafe fn apply_bindings(ui: &mut Ui) {
    for (node, scene) in store().drain_binding_events() {
        ui.set_prop(node, spec::prop::SCENE3D, scene as f64);
    }
}

// ---------------------------------------------------------------------------
// arg helpers
// ---------------------------------------------------------------------------

#[inline]
unsafe fn arg_f32(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> f32 {
    arg_f64(ctx, argc, argv, i) as f32
}

/// u32 payloads (colors, flags) arrive as JS numbers that may exceed i32
/// range (`>>> 0` guest-side); route through f64 -> i64 -> u32 (desktop
/// mount.rs as_u32 parity).
#[inline]
unsafe fn arg_u32(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> u32 {
    arg_f64(ctx, argc, argv, i) as i64 as u32
}

/// Copy a typed-array/ArrayBuffer arg out as f32s (byte copy, so any view
/// alignment is fine). Missing/non-buffer args decode empty.
unsafe fn arg_f32s(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> Vec<f32> {
    arg_pods(ctx, argc, argv, i)
}

/// Copy a typed-array/ArrayBuffer arg out as u32s.
unsafe fn arg_u32s(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> Vec<u32> {
    arg_pods(ctx, argc, argv, i)
}

unsafe fn arg_pods<T: Copy + Default>(
    ctx: *mut JSContext,
    argc: i32,
    argv: *mut JSValue,
    i: isize,
) -> Vec<T> {
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

/// Copy an Int32Array arg out (node id batches).
unsafe fn arg_i32s(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> Vec<i32> {
    arg_pods(ctx, argc, argv, i)
}

/// `Float32Array | null` (geomMesh/geomHeightfield colors).
unsafe fn arg_f32s_opt(
    ctx: *mut JSContext,
    argc: i32,
    argv: *mut JSValue,
    i: isize,
) -> Option<Vec<f32>> {
    if (i as i32) >= argc {
        return None;
    }
    let v = *argv.offset(i);
    if JS_IsNull(v) || JS_IsUndefined(v) {
        return None;
    }
    buffer_bytes(ctx, v).map(|(p, len)| {
        let n = len / 4;
        let mut out: Vec<f32> = Vec::with_capacity(n);
        core::ptr::copy_nonoverlapping(p, out.as_mut_ptr() as *mut u8, n * 4);
        out.set_len(n);
        out
    })
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

js_op!(js_scene_create, |ctx, _argc, _argv| JS_NewInt32(ctx, store().scene_create()));
js_op!(js_scene_destroy, |ctx, argc, argv| {
    store().scene_destroy(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
});

js_op!(js_node_create, |ctx, argc, argv| JS_NewInt32(
    ctx,
    store().node_create(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1)),
));
js_op!(js_node_destroy, |ctx, argc, argv| {
    store().node_destroy(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
});
js_op!(js_node_set_parent, |ctx, argc, argv| {
    store().node_set_parent(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1));
    JS_UNDEFINED
});
js_op!(js_node_set_visible, |ctx, argc, argv| {
    store().node_set_visible(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1) != 0);
    JS_UNDEFINED
});
js_op!(js_node_set_pose, |ctx, argc, argv| {
    store().node_set_pose(
        arg_i32(ctx, argc, argv, 0),
        arg_f32(ctx, argc, argv, 1),
        arg_f32(ctx, argc, argv, 2),
        arg_f32(ctx, argc, argv, 3),
        arg_f32(ctx, argc, argv, 4),
        arg_f32(ctx, argc, argv, 5),
        arg_f32(ctx, argc, argv, 6),
        arg_f32(ctx, argc, argv, 7),
    );
    JS_UNDEFINED
});
js_op!(js_node_set_scale, |ctx, argc, argv| {
    store().node_set_scale(
        arg_i32(ctx, argc, argv, 0),
        arg_f32(ctx, argc, argv, 1),
        arg_f32(ctx, argc, argv, 2),
        arg_f32(ctx, argc, argv, 3),
    );
    JS_UNDEFINED
});
js_op!(js_write_poses, |ctx, argc, argv| {
    let buf = arg_f32s(ctx, argc, argv, 0);
    let count = arg_i32(ctx, argc, argv, 1).max(0) as usize;
    store().write_poses(&buf, count);
    JS_UNDEFINED
});

js_op!(js_geom_box, |ctx, argc, argv| bake(
    ctx,
    store().geom_box(
        arg_f32(ctx, argc, argv, 0),
        arg_f32(ctx, argc, argv, 1),
        arg_f32(ctx, argc, argv, 2),
    ),
));
js_op!(js_geom_sphere, |ctx, argc, argv| bake(
    ctx,
    store().geom_sphere(arg_f32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1)),
));
js_op!(js_geom_cylinder, |ctx, argc, argv| bake(
    ctx,
    store().geom_cylinder(
        arg_f32(ctx, argc, argv, 0),
        arg_f32(ctx, argc, argv, 1),
        arg_f32(ctx, argc, argv, 2),
        arg_i32(ctx, argc, argv, 3),
    ),
));
js_op!(js_geom_cone, |ctx, argc, argv| bake(
    ctx,
    store().geom_cone(
        arg_f32(ctx, argc, argv, 0),
        arg_f32(ctx, argc, argv, 1),
        arg_i32(ctx, argc, argv, 2),
    ),
));
js_op!(js_geom_plane, |ctx, argc, argv| bake(
    ctx,
    store().geom_plane(arg_f32(ctx, argc, argv, 0), arg_f32(ctx, argc, argv, 1)),
));
js_op!(js_geom_torus, |ctx, argc, argv| bake(
    ctx,
    store().geom_torus(
        arg_f32(ctx, argc, argv, 0),
        arg_f32(ctx, argc, argv, 1),
        arg_i32(ctx, argc, argv, 2),
        arg_i32(ctx, argc, argv, 3),
    ),
));
js_op!(js_geom_mesh, |ctx, argc, argv| {
    let positions = arg_f32s(ctx, argc, argv, 0);
    let indices = arg_u32s(ctx, argc, argv, 1);
    let colors = arg_f32s_opt(ctx, argc, argv, 2);
    bake(ctx, store().geom_mesh(&positions, &indices, colors.as_deref()))
});
js_op!(js_geom_heightfield, |ctx, argc, argv| {
    let heights = arg_f32s(ctx, argc, argv, 4);
    let colors = arg_f32s_opt(ctx, argc, argv, 5);
    bake(
        ctx,
        store().geom_heightfield(
            arg_f32(ctx, argc, argv, 0),
            arg_f32(ctx, argc, argv, 1),
            arg_i32(ctx, argc, argv, 2),
            arg_i32(ctx, argc, argv, 3),
            &heights,
            colors.as_deref(),
        ),
    )
});
js_op!(js_geom_free, |ctx, argc, argv| {
    let id = arg_i32(ctx, argc, argv, 0);
    store().geom_free(id);
    crate::ge3d::free_geom(id);
    JS_UNDEFINED
});

/// Bake the GE buffers for a freshly created geom, then return its handle.
unsafe fn bake(ctx: *mut JSContext, id: i32) -> JSValue {
    crate::ge3d::bake_geom(id, store());
    JS_NewInt32(ctx, id)
}

js_op!(js_material, |ctx, argc, argv| JS_NewInt32(
    ctx,
    store().material_create(arg_u32(ctx, argc, argv, 0), arg_u32(ctx, argc, argv, 1)),
));
js_op!(js_material_set_color, |ctx, argc, argv| {
    store().material_set_color(arg_i32(ctx, argc, argv, 0), arg_u32(ctx, argc, argv, 1));
    JS_UNDEFINED
});
js_op!(js_material_free, |ctx, argc, argv| {
    store().material_free(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
});

js_op!(js_mesh_set, |ctx, argc, argv| {
    store().mesh_set(
        arg_i32(ctx, argc, argv, 0),
        arg_i32(ctx, argc, argv, 1),
        arg_i32(ctx, argc, argv, 2),
    );
    JS_UNDEFINED
});
js_op!(js_node_set_tint, |ctx, argc, argv| {
    store().node_set_tint(arg_i32(ctx, argc, argv, 0), arg_u32(ctx, argc, argv, 1));
    JS_UNDEFINED
});

// Freeze a batch of nodes: a promise their transforms are final, which lets
// the store merge them into shared geometry (batch.rs). Batched on purpose —
// a 550-node environment declares itself in one op, not 550.
js_op!(js_freeze, |ctx, argc, argv| {
    let ids = arg_i32s(ctx, argc, argv, 0);
    let count = (arg_i32(ctx, argc, argv, 1).max(0) as usize).min(ids.len());
    store().freeze_nodes(&ids[..count]);
    JS_UNDEFINED
});

js_op!(js_sun, |ctx, argc, argv| {
    store().sun(
        arg_i32(ctx, argc, argv, 0),
        arg_f32(ctx, argc, argv, 1),
        arg_f32(ctx, argc, argv, 2),
        arg_f32(ctx, argc, argv, 3),
        arg_u32(ctx, argc, argv, 4),
    );
    JS_UNDEFINED
});
js_op!(js_ambient, |ctx, argc, argv| {
    store().ambient(
        arg_i32(ctx, argc, argv, 0),
        arg_u32(ctx, argc, argv, 1),
        arg_u32(ctx, argc, argv, 2),
    );
    JS_UNDEFINED
});
js_op!(js_fog, |ctx, argc, argv| {
    store().fog(
        arg_i32(ctx, argc, argv, 0),
        arg_u32(ctx, argc, argv, 1),
        arg_f32(ctx, argc, argv, 2),
        arg_f32(ctx, argc, argv, 3),
    );
    JS_UNDEFINED
});
js_op!(js_sky, |ctx, argc, argv| {
    store().sky(
        arg_i32(ctx, argc, argv, 0),
        arg_u32(ctx, argc, argv, 1),
        arg_u32(ctx, argc, argv, 2),
    );
    JS_UNDEFINED
});

js_op!(js_camera, |ctx, argc, argv| {
    store().camera(
        arg_i32(ctx, argc, argv, 0),
        arg_f32(ctx, argc, argv, 1),
        arg_f32(ctx, argc, argv, 2),
        arg_f32(ctx, argc, argv, 3),
        arg_f32(ctx, argc, argv, 4),
        arg_f32(ctx, argc, argv, 5),
        arg_f32(ctx, argc, argv, 6),
        arg_f32(ctx, argc, argv, 7),
        arg_f32(ctx, argc, argv, 8),
        arg_f32(ctx, argc, argv, 9),
        arg_f32(ctx, argc, argv, 10),
    );
    JS_UNDEFINED
});

js_op!(js_sprite_pool, |ctx, argc, argv| JS_NewInt32(
    ctx,
    store().pool_create(
        arg_i32(ctx, argc, argv, 0),
        arg_f64(ctx, argc, argv, 1),
        arg_i32(ctx, argc, argv, 2),
        PoolKind::Sprite,
    ),
));
js_op!(js_beam_pool, |ctx, argc, argv| JS_NewInt32(
    ctx,
    store().pool_create(
        arg_i32(ctx, argc, argv, 0),
        arg_f64(ctx, argc, argv, 1),
        arg_i32(ctx, argc, argv, 2),
        PoolKind::Beam,
    ),
));
js_op!(js_write_sprites, |ctx, argc, argv| {
    pool_write(ctx, argc, argv, PoolKind::Sprite)
});
js_op!(js_write_beams, |ctx, argc, argv| {
    pool_write(ctx, argc, argv, PoolKind::Beam)
});
js_op!(js_pool_free, |ctx, argc, argv| {
    store().pool_free(arg_i32(ctx, argc, argv, 0));
    JS_UNDEFINED
});

/// Shared body of writeSprites/writeBeams: (pool, f32 buf, u32 colors, count).
unsafe fn pool_write(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, kind: PoolKind) -> JSValue {
    let pool = arg_i32(ctx, argc, argv, 0);
    let buf = arg_f32s(ctx, argc, argv, 1);
    let colors = arg_u32s(ctx, argc, argv, 2);
    let count = arg_f64(ctx, argc, argv, 3);
    store().pool_write(pool, kind, &buf, &colors, count);
    JS_UNDEFINED
}

js_op!(js_bind_viewport, |ctx, argc, argv| {
    store().bind_viewport(arg_i32(ctx, argc, argv, 0), arg_i32(ctx, argc, argv, 1));
    JS_UNDEFINED
});

// µs wall clock for on-hardware JS-side profiling (read by the perf probe's
// __jsPerf line, main.rs). Deliberately NOT in the Scene3dOps contract
// (ops.ts) — a debug affordance like ui's devtools ops, never a sim input.
js_op!(js_hw_now, |ctx, _argc, _argv| JS_NewFloat64(
    ctx,
    psp::sys::sceKernelGetSystemTimeWide() as f64,
));

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

/// Install `globalThis.s3` (the full Scene3dOps surface). Call before the
/// bundle evals, alongside ffi::register's `ui`.
pub unsafe fn register(ctx: *mut JSContext, global: JSValue) {
    let s3 = JS_NewObject(ctx);

    add_fn(ctx, s3, b"sceneCreate\0", js_scene_create, 0);
    add_fn(ctx, s3, b"sceneDestroy\0", js_scene_destroy, 1);
    add_fn(ctx, s3, b"nodeCreate\0", js_node_create, 2);
    add_fn(ctx, s3, b"nodeDestroy\0", js_node_destroy, 1);
    add_fn(ctx, s3, b"nodeSetParent\0", js_node_set_parent, 2);
    add_fn(ctx, s3, b"nodeSetVisible\0", js_node_set_visible, 2);
    add_fn(ctx, s3, b"nodeSetPose\0", js_node_set_pose, 8);
    add_fn(ctx, s3, b"nodeSetScale\0", js_node_set_scale, 4);
    add_fn(ctx, s3, b"writePoses\0", js_write_poses, 2);
    add_fn(ctx, s3, b"geomBox\0", js_geom_box, 3);
    add_fn(ctx, s3, b"geomSphere\0", js_geom_sphere, 2);
    add_fn(ctx, s3, b"geomCylinder\0", js_geom_cylinder, 4);
    add_fn(ctx, s3, b"geomCone\0", js_geom_cone, 3);
    add_fn(ctx, s3, b"geomPlane\0", js_geom_plane, 2);
    add_fn(ctx, s3, b"geomTorus\0", js_geom_torus, 4);
    add_fn(ctx, s3, b"geomMesh\0", js_geom_mesh, 3);
    add_fn(ctx, s3, b"geomHeightfield\0", js_geom_heightfield, 6);
    add_fn(ctx, s3, b"geomFree\0", js_geom_free, 1);
    add_fn(ctx, s3, b"material\0", js_material, 2);
    add_fn(ctx, s3, b"materialSetColor\0", js_material_set_color, 2);
    add_fn(ctx, s3, b"materialFree\0", js_material_free, 1);
    add_fn(ctx, s3, b"meshSet\0", js_mesh_set, 3);
    add_fn(ctx, s3, b"nodeSetTint\0", js_node_set_tint, 2);
    add_fn(ctx, s3, b"freeze\0", js_freeze, 2);
    add_fn(ctx, s3, b"sun\0", js_sun, 5);
    add_fn(ctx, s3, b"ambient\0", js_ambient, 3);
    add_fn(ctx, s3, b"fog\0", js_fog, 4);
    add_fn(ctx, s3, b"sky\0", js_sky, 3);
    add_fn(ctx, s3, b"camera\0", js_camera, 11);
    add_fn(ctx, s3, b"spritePool\0", js_sprite_pool, 3);
    add_fn(ctx, s3, b"writeSprites\0", js_write_sprites, 4);
    add_fn(ctx, s3, b"beamPool\0", js_beam_pool, 3);
    add_fn(ctx, s3, b"writeBeams\0", js_write_beams, 4);
    add_fn(ctx, s3, b"poolFree\0", js_pool_free, 1);
    add_fn(ctx, s3, b"bindViewport\0", js_bind_viewport, 2);
    add_fn(ctx, s3, b"__hwNow\0", js_hw_now, 0);

    // Honest host label (ops.ts __host; native hosts omit __serialize).
    let host = JS_NewStringLen(ctx, b"psp".as_ptr(), 3);
    JS_SetPropertyStr(ctx, s3, b"__host\0".as_ptr() as *const _, host);

    // JS_SetPropertyStr consumes ownership of s3.
    JS_SetPropertyStr(ctx, global, b"s3\0".as_ptr() as *const _, s3);
}

// libquickjs-sys omits JS_NewStringLen; the linked QuickJS C library provides
// it (same local-extern pattern as ffi.rs).
extern "C" {
    fn JS_NewStringLen(ctx: *mut JSContext, str1: *const u8, len1: usize) -> JSValue;
}
