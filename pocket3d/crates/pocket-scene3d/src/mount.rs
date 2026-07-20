//! The `scene3d` surface: one [`Store`] + the Scene3dOps contract
//! (playset/scene3d/ops.ts) mounted into a guest as `globalThis.s3`.
//!
//! Mirrors pocket-ui-wgpu's `UiSurface::mount` shape: every op is a native
//! function over a shared Rc<RefCell<Store>>; batched writes take typed
//! arrays and read only `count` entries. The host reads the store back
//! through [`Scene3dSurface::with_store`] to render, and drains
//! bind/unbind events each frame to forward PROP.scene3d into the ui core.

use std::cell::RefCell;
use std::rc::Rc;

use anyhow::Result;
use pocket_mod::Guest;
use pocket_mod::qjs::function::Rest;
use pocket_mod::qjs::{Function, TypedArray, Value};

use crate::store::{PoolKind, Store};

/// The `s3` surface. Clone-cheap handle; single-threaded like the guest.
#[derive(Clone, Default)]
pub struct Scene3dSurface {
    inner: Rc<RefCell<Store>>,
}

/// Decode a Float32Array argument into an owned Vec (alignment-safe: the
/// QuickJS buffer may sit at any byte offset). Detached arrays read empty.
fn f32s(arr: &TypedArray<'_, f32>) -> Vec<f32> {
    arr.as_bytes().map(bytemuck::pod_collect_to_vec).unwrap_or_default()
}

/// Decode a Uint32Array argument (see [`f32s`]).
fn u32s(arr: &TypedArray<'_, u32>) -> Vec<u32> {
    arr.as_bytes().map(bytemuck::pod_collect_to_vec).unwrap_or_default()
}

/// u32 payloads (colors, flags) arrive as JS numbers that may exceed i32
/// range (`>>> 0` on the guest side); route through f64 -> i64 -> u32.
fn as_u32(v: f64) -> u32 {
    v as i64 as u32
}

impl Scene3dSurface {
    pub fn new() -> Scene3dSurface {
        Scene3dSurface { inner: Rc::new(RefCell::new(Store::new())) }
    }

    /// Borrow the store (the renderer walks scenes/nodes/pools through this).
    pub fn with_store<R>(&self, f: impl FnOnce(&mut Store) -> R) -> R {
        f(&mut self.inner.borrow_mut())
    }

    /// Current (ui node id, scene handle) viewport bindings.
    pub fn bindings(&self) -> Vec<(i32, i32)> {
        self.inner.borrow().bindings()
    }

    /// Drain bind/unbind events since the last call: (ui node id, scene
    /// handle or 0). The host writes each as PROP.scene3d on the ui core.
    pub fn drain_binding_events(&self) -> Vec<(i32, i32)> {
        self.inner.borrow_mut().drain_binding_events()
    }

    /// Mount `globalThis.s3` into `guest`. Call before evaluating the bundle.
    pub fn mount(&self, guest: &Guest) -> Result<()> {
        guest.mount("s3", |ctx, ns| {
            macro_rules! op {
                ($name:literal, $f:expr) => {
                    ns.set($name, Function::new(ctx.clone(), $f)?)?;
                };
            }

            // -- scenes ------------------------------------------------------
            let s = self.inner.clone();
            op!("sceneCreate", move || s.borrow_mut().scene_create());

            let s = self.inner.clone();
            op!("sceneDestroy", move |scene: i32| s.borrow_mut().scene_destroy(scene));

            // -- node tree ---------------------------------------------------
            let s = self.inner.clone();
            op!("nodeCreate", move |scene: i32, parent: i32| {
                s.borrow_mut().node_create(scene, parent)
            });

            let s = self.inner.clone();
            op!("nodeDestroy", move |id: i32| s.borrow_mut().node_destroy(id));

            let s = self.inner.clone();
            op!("nodeSetParent", move |id: i32, parent: i32| {
                s.borrow_mut().node_set_parent(id, parent)
            });

            let s = self.inner.clone();
            op!("nodeSetVisible", move |id: i32, on: i32| {
                s.borrow_mut().node_set_visible(id, on != 0)
            });

            // rquickjs tuple params cap at 7; the 7 floats ride as Rest.
            let s = self.inner.clone();
            op!("nodeSetPose", move |id: i32, rest: Rest<f64>| {
                let a = |i: usize| rest.0.get(i).copied().unwrap_or(0.0) as f32;
                s.borrow_mut().node_set_pose(id, a(0), a(1), a(2), a(3), a(4), a(5), a(6))
            });

            let s = self.inner.clone();
            op!("nodeSetScale", move |id: i32, sx: f64, sy: f64, sz: f64| {
                s.borrow_mut().node_set_scale(id, sx as f32, sy as f32, sz as f32)
            });

            let s = self.inner.clone();
            op!("writePoses", move |buf: TypedArray<f32>, count: i32| {
                s.borrow_mut().write_poses(&f32s(&buf), count.max(0) as usize)
            });

            // -- geometry ----------------------------------------------------
            let s = self.inner.clone();
            op!("geomBox", move |hx: f64, hy: f64, hz: f64| {
                s.borrow_mut().geom_box(hx as f32, hy as f32, hz as f32)
            });

            let s = self.inner.clone();
            op!("geomSphere", move |radius: f64, segments: i32| {
                s.borrow_mut().geom_sphere(radius as f32, segments)
            });

            let s = self.inner.clone();
            op!("geomCylinder", move |rt: f64, rb: f64, h: f64, segments: i32| {
                s.borrow_mut().geom_cylinder(rt as f32, rb as f32, h as f32, segments)
            });

            let s = self.inner.clone();
            op!("geomCone", move |radius: f64, height: f64, segments: i32| {
                s.borrow_mut().geom_cone(radius as f32, height as f32, segments)
            });

            let s = self.inner.clone();
            op!("geomPlane", move |w: f64, d: f64| s.borrow_mut().geom_plane(w as f32, d as f32));

            let s = self.inner.clone();
            op!("geomTorus", move |radius: f64, tube: f64, segments: i32, tube_segments: i32| {
                s.borrow_mut().geom_torus(radius as f32, tube as f32, segments, tube_segments)
            });

            // `colors` is Float32Array | null — take a raw Value and probe.
            let s = self.inner.clone();
            op!(
                "geomMesh",
                move |positions: TypedArray<f32>, indices: TypedArray<u32>, colors: Value| {
                    let colors = TypedArray::<f32>::from_value(colors).ok().map(|c| f32s(&c));
                    s.borrow_mut().geom_mesh(&f32s(&positions), &u32s(&indices), colors.as_deref())
                }
            );

            let s = self.inner.clone();
            op!(
                "geomHeightfield",
                move |w: f64, d: f64, cols: i32, rows: i32, heights: TypedArray<f32>, colors: Value| {
                    let colors = TypedArray::<f32>::from_value(colors).ok().map(|c| f32s(&c));
                    s.borrow_mut().geom_heightfield(
                        w as f32,
                        d as f32,
                        cols,
                        rows,
                        &f32s(&heights),
                        colors.as_deref(),
                    )
                }
            );

            let s = self.inner.clone();
            op!("geomFree", move |id: i32| s.borrow_mut().geom_free(id));

            // -- materials ---------------------------------------------------
            let s = self.inner.clone();
            op!("material", move |color: f64, flags: f64| {
                s.borrow_mut().material_create(as_u32(color), as_u32(flags))
            });

            let s = self.inner.clone();
            op!("materialSetColor", move |id: i32, color: f64| {
                s.borrow_mut().material_set_color(id, as_u32(color))
            });

            let s = self.inner.clone();
            op!("materialFree", move |id: i32| s.borrow_mut().material_free(id));

            // -- mesh attachment ---------------------------------------------
            let s = self.inner.clone();
            op!("meshSet", move |node: i32, geom: i32, mat: i32| {
                s.borrow_mut().mesh_set(node, geom, mat)
            });

            let s = self.inner.clone();
            op!("nodeSetTint", move |node: i32, color: f64| {
                s.borrow_mut().node_set_tint(node, as_u32(color))
            });

            // -- environment -------------------------------------------------
            let s = self.inner.clone();
            op!("sun", move |scene: i32, dx: f64, dy: f64, dz: f64, color: f64| {
                s.borrow_mut().sun(scene, dx as f32, dy as f32, dz as f32, as_u32(color))
            });

            let s = self.inner.clone();
            op!("ambient", move |scene: i32, sky: f64, ground: f64| {
                s.borrow_mut().ambient(scene, as_u32(sky), as_u32(ground))
            });

            let s = self.inner.clone();
            op!("fog", move |scene: i32, color: f64, near: f64, far: f64| {
                s.borrow_mut().fog(scene, as_u32(color), near as f32, far as f32)
            });

            let s = self.inner.clone();
            op!("sky", move |scene: i32, zenith: f64, horizon: f64| {
                s.borrow_mut().sky(scene, as_u32(zenith), as_u32(horizon))
            });

            // -- camera ------------------------------------------------------
            // (scene, p3, q4, fovY, znear, zfar) — 10 floats ride as Rest.
            let s = self.inner.clone();
            op!("camera", move |scene: i32, rest: Rest<f64>| {
                let a = |i: usize| rest.0.get(i).copied().unwrap_or(0.0) as f32;
                s.borrow_mut().camera(
                    scene,
                    a(0), a(1), a(2),
                    a(3), a(4), a(5), a(6),
                    a(7), a(8), a(9),
                )
            });

            // -- pooled billboards & ribbons -----------------------------------
            let s = self.inner.clone();
            op!("spritePool", move |scene: i32, capacity: f64, mat: i32| {
                s.borrow_mut().pool_create(scene, capacity, mat, PoolKind::Sprite)
            });

            let s = self.inner.clone();
            op!(
                "writeSprites",
                move |pool: i32, buf: TypedArray<f32>, colors: TypedArray<u32>, count: f64| {
                    s.borrow_mut().pool_write(pool, PoolKind::Sprite, &f32s(&buf), &u32s(&colors), count)
                }
            );

            let s = self.inner.clone();
            op!("beamPool", move |scene: i32, capacity: f64, mat: i32| {
                s.borrow_mut().pool_create(scene, capacity, mat, PoolKind::Beam)
            });

            let s = self.inner.clone();
            op!(
                "writeBeams",
                move |pool: i32, buf: TypedArray<f32>, colors: TypedArray<u32>, count: f64| {
                    s.borrow_mut().pool_write(pool, PoolKind::Beam, &f32s(&buf), &u32s(&colors), count)
                }
            );

            let s = self.inner.clone();
            op!("poolFree", move |pool: i32| s.borrow_mut().pool_free(pool));

            // -- viewport binding ----------------------------------------------
            let s = self.inner.clone();
            op!("bindViewport", move |ui_node: i32, scene: i32| {
                s.borrow_mut().bind_viewport(ui_node, scene)
            });

            // Honest host label (ops.ts __host; native hosts omit __serialize).
            ns.set("__host", "desktop")?;

            Ok(())
        })
    }
}
