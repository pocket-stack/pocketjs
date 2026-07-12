//! `pocket3d-vita` — a Pocket3D backend that composes inside a vita2d frame.
//!
//! The backend deliberately does not own `vita2d_start_drawing`,
//! `vita2d_end_drawing`, or buffer swaps. It CPU-transforms and clips 3D
//! triangles to Vita's physical 960x544 viewport, painter-sorts them, and uses
//! vita2d's built-in color/texture shaders. A caller can therefore render 3D,
//! call [`end_3d`], and immediately submit a PocketJS HUD before ending the
//! same vita2d scene.
//!
//! The compatibility-oriented frame shape mirrors `pocket3d-gu`:
//! ```text
//! vita2d_start_drawing()
//!   pool.reset()
//!   pocket3d_vita::begin_3d(&camera)
//!   sky::draw(&mut pool, &camera, &sky)
//!   world.draw(&mut pool, &camera)
//!   mesh::draw_color_tris(&mut pool, actors, model)
//!   pocket3d_vita::end_3d()
//!   // PocketJS vita2d HUD submissions
//! vita2d_end_drawing()
//! ```
//!
//! vita2d's stock textured shader has no depth test and one uniform tint per
//! draw. This backend consequently uses clipped-triangle painter ordering and
//! averages baked vertex light colors per textured triangle. It is intended as
//! the dependency-free Vita bring-up backend; a future raw-GXM backend can
//! preserve the public API while adding a hardware depth buffer and per-vertex
//! texture modulation.

use core::cell::UnsafeCell;

use glam::Mat4;

pub mod camera;
pub mod mesh;
pub mod pool;
pub mod sky;
pub mod texture;
pub mod world;

pub use camera::Camera3d;
pub use pool::FramePool;
pub use world::WorldRenderer;

pub const SCREEN_WIDTH: f32 = 960.0;
pub const SCREEN_HEIGHT: f32 = 544.0;

struct PassState {
    view_proj: [f32; 16],
    pool: *mut FramePool,
    layer: i16,
    active: bool,
}

struct GlobalPass(UnsafeCell<PassState>);

// Vita applications render on one main thread. The unsafe public pass API
// makes that constraint explicit and matches sceGu's stateful API.
unsafe impl Sync for GlobalPass {}

static PASS: GlobalPass = GlobalPass(UnsafeCell::new(PassState {
    view_proj: [
        1.0, 0.0, 0.0, 0.0, // x
        0.0, 1.0, 0.0, 0.0, // y
        0.0, 0.0, 1.0, 0.0, // z
        0.0, 0.0, 0.0, 1.0, // w
    ],
    pool: core::ptr::null_mut(),
    layer: 0,
    active: false,
}));

#[inline]
unsafe fn pass() -> &'static mut PassState {
    &mut *PASS.0.get()
}

/// Begin recording a CPU-projected 3D pass inside the caller's open vita2d
/// scene. Only one pass and one [`FramePool`] may be active at a time.
///
/// # Safety
///
/// Call only on the render thread, after `vita2d_start_drawing`, and balance
/// every successful call with [`end_3d`] before ending the vita2d scene.
pub unsafe fn begin_3d(camera: &Camera3d) {
    let state = pass();
    assert!(!state.active, "pocket3d-vita 3D pass already active");
    state.view_proj = camera.view_proj().to_cols_array();
    state.pool = core::ptr::null_mut();
    state.layer = 0;
    state.active = true;
}

/// Painter-submit all recorded triangles and return vita2d state to the HUD.
///
/// `FramePool` must not be moved or dropped between its first draw call and
/// this function; the stateful API retains its address for compatibility with
/// `pocket3d-gu::end_3d()`.
///
/// # Safety
///
/// Call on the same render thread as [`begin_3d`], while its vita2d scene and
/// the pass's `FramePool` are still alive.
pub unsafe fn end_3d() {
    let state = pass();
    assert!(state.active, "pocket3d-vita 3D pass is not active");
    let pool = state.pool;
    state.pool = core::ptr::null_mut();
    state.layer = 0;
    state.active = false;
    if !pool.is_null() {
        (*pool).flush();
    }
}

/// CPU map data does not require a Vita dcache writeback: textures are copied
/// to vita2d-owned GPU memory and vertices to vita2d's mapped frame pool. Kept
/// for source compatibility with the PSP backend.
///
/// # Safety
///
/// This function performs no operation and has no additional safety contract.
pub unsafe fn writeback(_data: &[u8]) {}

pub(crate) unsafe fn activate_pool(pool: &mut FramePool) -> (Mat4, i16) {
    let state = pass();
    assert!(state.active, "call begin_3d before recording geometry");
    let pointer = pool as *mut FramePool;
    if state.pool.is_null() {
        state.pool = pointer;
    } else {
        assert_eq!(state.pool, pointer, "one FramePool is allowed per 3D pass");
    }
    (Mat4::from_cols_array(&state.view_proj), state.layer)
}

pub(crate) unsafe fn advance_layer() {
    let state = pass();
    assert!(state.active, "call begin_3d before changing depth layers");
    state.layer = state.layer.saturating_add(1);
}
