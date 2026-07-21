//! Static batching has to be INVISIBLE: the merged draws must paint the same
//! scene the per-node walk painted, only far fewer times.
//!
//! Why a synthetic scene and not a demo screenshot: the number this feature
//! exists for was measured on a real PSP against rally's barrier fence — 380
//! to 470 draws looking down the circuit, 72 parked facing open ground — and
//! that is a property of the WALK, not of any one frame of any one game. So
//! the scene here is that fence stripped to what makes it expensive: ~270
//! posts and ~270 rails sharing one geom and one material each, laid around a
//! circuit, viewed along the longest run of them.
//!
//! Pixels are compared, not hashed: merging transforms vertices on the CPU
//! that the GPU would otherwise transform per draw, so the two paths agree to
//! float rounding rather than bit-for-bit. A visible regression (a missing
//! post, a double-drawn rail, a lost tint) moves thousands of pixels by a lot;
//! rounding moves a handful by one step.
#![cfg(feature = "std")]

use std::f32::consts::{PI, TAU};

use glam::Quat;
use pocket3d::gpu::{Gpu, OffscreenTarget};
use pocket_scene3d::{SceneRect, SceneRenderer, Store};

const W: u32 = 480;
const H: u32 = 272;
/// rally's barrier: one post every couple of units around the whole circuit.
const POSTS: usize = 270;
const RADIUS: f32 = 50.0;

/// The fence, plus the ids the guest would hand to `freeze`.
fn build_scene() -> (Store, i32, Vec<i32>) {
    let mut store = Store::new();
    let scene = store.scene_create();
    store.sky(scene, 0xff_6a4a2a, 0xff_d9c8b0);
    store.sun(scene, -0.4, -0.8, -0.45, 0xff_ffffff);
    store.ambient(scene, 0xff_8899aa, 0xff_443322);
    store.fog(scene, 0xff_d9c8b0, 40.0, 160.0);

    let ground_g = store.geom_plane(400.0, 400.0);
    let ground_m = store.material_create(0xff_3a6a3a, 0);
    let ground = store.node_create(scene, 0);
    store.mesh_set(ground, ground_g, ground_m);

    let post_g = store.geom_cylinder(0.08, 0.08, 1.2, 8);
    let rail_g = store.geom_box(0.7, 0.08, 0.06);
    let post_m = store.material_create(0xff_dddddd, 0);
    let rail_m = store.material_create(0xff_2222dd, 0);
    // Everything hangs off one group, as the ported environment factories
    // build it — so the batcher and the walk both have to get world
    // transforms right through a parent.
    let group = store.node_create(scene, 0);

    let mut scenery = Vec::with_capacity(POSTS * 2);
    for i in 0..POSTS {
        let a = i as f32 / POSTS as f32 * TAU;
        let (sa, ca) = a.sin_cos();
        let post = store.node_create(scene, group);
        store.node_set_pose(post, RADIUS * ca, 0.6, RADIUS * sa, 0.0, 0.0, 0.0, 1.0);
        store.mesh_set(post, post_g, post_m);
        scenery.push(post);

        // Rail spanning to the next post: midpoint, turned along the chord.
        let b = (i + 1) as f32 / POSTS as f32 * TAU;
        let (sb, cb) = b.sin_cos();
        let (mx, mz) = ((ca + cb) * 0.5 * RADIUS, (sa + sb) * 0.5 * RADIUS);
        let q = Quat::from_rotation_y(-(a + b) * 0.5 + PI * 0.5);
        let rail = store.node_create(scene, group);
        store.node_set_pose(rail, mx, 1.0, mz, q.x, q.y, q.z, q.w);
        store.mesh_set(rail, rail_g, rail_m);
        scenery.push(rail);
    }

    // Stand on the circuit looking along the tangent — the camera direction
    // that put 380-470 draws in frustum on hardware.
    let q = Quat::from_rotation_y(PI);
    store.camera(
        scene,
        RADIUS - 1.5,
        1.6,
        0.0,
        q.x,
        q.y,
        q.z,
        q.w,
        PI / 3.0,
        0.1,
        400.0,
    );
    (store, scene, scenery)
}

fn render(
    gpu: &Gpu,
    renderer: &mut SceneRenderer,
    target: &OffscreenTarget,
    store: &mut Store,
    scene: i32,
) -> Vec<u8> {
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    let drew = renderer.render(
        gpu,
        &mut encoder,
        &target.view,
        (W, H),
        store,
        scene,
        SceneRect { x: 0.0, y: 0.0, w: W as f32, h: H as f32 },
        wgpu::LoadOp::Clear(wgpu::Color::BLACK),
    );
    assert!(drew, "the scene must render");
    gpu.queue.submit([encoder.finish()]);
    target.read_rgba(gpu).expect("readback")
}

/// (pixels differing by more than one 8-bit step, largest channel difference).
fn compare(a: &[u8], b: &[u8]) -> (usize, u8) {
    let mut moved = 0usize;
    let mut worst = 0u8;
    for (px_a, px_b) in a.chunks_exact(4).zip(b.chunks_exact(4)) {
        let d = px_a.iter().zip(px_b).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0);
        worst = worst.max(d);
        if d > 1 {
            moved += 1;
        }
    }
    (moved, worst)
}

#[test]
fn merged_scenery_paints_the_same_frame_in_far_fewer_draws() {
    let Ok(gpu) = Gpu::new_headless() else {
        eprintln!("no wgpu adapter — skipping");
        return;
    };
    let target = OffscreenTarget::new(&gpu, W, H);
    let mut renderer = SceneRenderer::new(&gpu, pocket3d::gpu::OFFSCREEN_FORMAT);
    let (mut store, scene, scenery) = build_scene();

    let before = render(&gpu, &mut renderer, &target, &mut store, scene);
    let n_before = renderer.last_draws();
    assert_eq!(renderer.last_batch_draws(), 0, "nothing is frozen yet");

    store.freeze_nodes(&scenery);
    let after = render(&gpu, &mut renderer, &target, &mut store, scene);
    let (n_after, batched) = (renderer.last_draws(), renderer.last_batch_draws());

    let (moved, worst) = compare(&before, &after);
    println!(
        "fence: {} nodes -> {n_before} draws unbatched, {n_after} batched ({batched} of them \
         merged); {moved}/{} pixels moved, worst channel delta {worst}",
        scenery.len() + 1,
        (W * H) as usize,
    );

    assert!(batched > 0, "the fence must merge into batches");
    assert!(
        n_after * 4 < n_before,
        "batching must cut submissions by more than 4x: {n_before} -> {n_after}"
    );
    // Rounding-level agreement only (module docs): a real regression is orders
    // of magnitude past this.
    assert!(worst <= 2, "batched frame differs by {worst} per channel, not rounding");
    assert!(
        moved * 1000 < (W * H) as usize,
        "{moved} pixels moved — that is a rendering change, not float rounding"
    );

    // `ensure_static_batches` is per frame and must be idempotent: a second
    // pass rebuilds nothing, retires nothing, and draws the same list.
    let again = render(&gpu, &mut renderer, &target, &mut store, scene);
    assert_eq!(renderer.last_draws(), n_after);
    assert_eq!(again, after, "a second frame of a settled scene is identical");
}
