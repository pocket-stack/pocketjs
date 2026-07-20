//! Retained scene3d state — the native mirror of playset/scene3d/sim.ts.
//!
//! The store owns everything the op stream builds: scenes (env + camera),
//! the node transform hierarchy, tessellated geometries, materials, and
//! sprite/beam pools. Semantics follow the sim host exactly (the normative
//! reference where ops.ts is silent): handle ids are monotonically
//! increasing positive integers PER KIND and never reused, ops on
//! dead/unknown handles are silent no-ops, creation ops that would need a
//! dead owner return 0, and geom/material creation always succeeds.
//!
//! One deliberate difference from sim.ts (which stores geometry params
//! verbatim): geometries are tessellated to CPU meshes AT CREATION — the
//! renderer uploads them once and the params are never needed again.

use alloc::collections::BTreeMap;
use alloc::vec;
use alloc::vec::Vec;

use glam::{Mat4, Quat, Vec3};

/// Scalar float shims: std intrinsics on the desktop build (byte-identical
/// to the pre-no_std crate), libm on no_std (PSP).
mod fmath {
    #[cfg(feature = "std")]
    #[inline]
    pub fn sqrt(x: f32) -> f32 {
        x.sqrt()
    }
    #[cfg(feature = "std")]
    #[inline]
    pub fn sin_cos(x: f32) -> (f32, f32) {
        x.sin_cos()
    }
    #[cfg(feature = "std")]
    #[inline]
    pub fn round(x: f32) -> f32 {
        x.round()
    }
    #[cfg(feature = "std")]
    #[inline]
    pub fn floor64(x: f64) -> f64 {
        x.floor()
    }

    #[cfg(not(feature = "std"))]
    #[inline]
    pub fn sqrt(x: f32) -> f32 {
        libm::sqrtf(x)
    }
    #[cfg(not(feature = "std"))]
    #[inline]
    pub fn sin_cos(x: f32) -> (f32, f32) {
        libm::sincosf(x)
    }
    #[cfg(not(feature = "std"))]
    #[inline]
    pub fn round(x: f32) -> f32 {
        libm::roundf(x)
    }
    #[cfg(not(feature = "std"))]
    #[inline]
    pub fn floor64(x: f64) -> f64 {
        libm::floor(x)
    }
}

/// writePoses stride (ops.ts POSE_STRIDE): [id, p3, q4, s3].
pub const POSE_STRIDE: usize = 11;
/// writeSprites stride (floats): [x, y, z, size].
pub const SPRITE_STRIDE: usize = 4;
/// writeBeams stride (floats): [ax,ay,az, bx,by,bz, width].
pub const BEAM_STRIDE: usize = 7;

/// Material flag bits (ops.ts MAT).
pub mod mat_flags {
    pub const VERTEX_COLORS: u32 = 1 << 0;
    pub const UNLIT: u32 = 1 << 1;
    pub const ADDITIVE: u32 = 1 << 2;
    pub const TRANSPARENT: u32 = 1 << 3;
    pub const DOUBLE_SIDED: u32 = 1 << 4;
}

/// A tessellated geometry: unit CPU mesh, uploaded by the renderer on first
/// use (geom ids are never reused, so the upload cache never invalidates).
pub struct CpuMesh {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    /// Per-vertex RGB (linear 0..1 floats as given); None = all white.
    pub colors: Option<Vec<[f32; 3]>>,
    pub indices: Vec<u32>,
}

pub struct Node {
    pub id: i32,
    pub scene: i32,
    /// Parent node id; 0 = scene root.
    pub parent: i32,
    /// Child ids in insertion order.
    pub children: Vec<i32>,
    pub p: Vec3,
    pub q: Quat,
    pub s: Vec3,
    pub visible: bool,
    /// 0 = bare group. May dangle after geomFree — the node draws nothing.
    pub geom: i32,
    pub mat: i32,
    /// u32 ABGR; 0xffffffff = no tint.
    pub tint: u32,
}

#[derive(Clone, Copy)]
pub struct Material {
    pub color: u32,
    pub flags: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PoolKind {
    Sprite,
    Beam,
}

pub struct Pool {
    pub scene: i32,
    pub kind: PoolKind,
    pub capacity: usize,
    pub mat: i32,
    /// Flat live entries (SPRITE_STRIDE or BEAM_STRIDE floats each),
    /// REPLACED per write; one u32 ABGR per entry in `colors`.
    pub live: Vec<f32>,
    pub colors: Vec<u32>,
    pub count: usize,
    pub dropped_writes: u64,
}

#[derive(Clone, Copy)]
pub struct CameraState {
    pub p: Vec3,
    pub q: Quat,
    pub fov_y: f32,
    pub znear: f32,
    pub zfar: f32,
}

/// Per-scene environment. Options are None until the guest sets them —
/// unset means the effect is simply absent (no sun, no fog, no sky pass).
pub struct Env {
    pub sun: Option<(Vec3, u32)>,
    /// (sky tint from above, ground tint from below).
    pub ambient: Option<(u32, u32)>,
    /// (color, near, far); None = disabled (fog() with far <= near clears).
    pub fog: Option<(u32, f32, f32)>,
    /// (zenith, horizon).
    pub sky: Option<(u32, u32)>,
    pub camera: CameraState,
}

impl Default for Env {
    fn default() -> Env {
        Env {
            sun: None,
            ambient: None,
            fog: None,
            sky: None,
            // ops.ts conventions: camera at (0,0,10) looking down -Z,
            // 60 deg vertical FOV (sim.ts defaultEnv).
            camera: CameraState {
                p: Vec3::new(0.0, 0.0, 10.0),
                q: Quat::IDENTITY,
                fov_y: core::f32::consts::PI / 3.0,
                znear: 0.1,
                zfar: 1000.0,
            },
        }
    }
}

pub struct Scene {
    pub id: i32,
    /// Root-level child node ids in creation order.
    pub root: Vec<i32>,
    /// Pool ids owned by this scene, in creation order.
    pub pools: Vec<i32>,
    pub env: Env,
}

/// The whole retained surface state. Node/pool ids are host-global
/// (nodeDestroy/writePoses/poolFree carry no scene), so flat registries
/// dispatch; each scene keeps its root list and pool list for iteration.
#[derive(Default)]
pub struct Store {
    scenes: BTreeMap<i32, Scene>,
    nodes: BTreeMap<i32, Node>,
    pools: BTreeMap<i32, Pool>,
    geoms: BTreeMap<i32, CpuMesh>,
    materials: BTreeMap<i32, Material>,
    /// ui node id -> scene handle (bindViewport bookkeeping).
    viewports: BTreeMap<i32, i32>,
    /// (ui node id, scene-or-0) in call order — the host drains these into
    /// PROP.scene3d writes on the ui core each frame.
    binding_events: Vec<(i32, i32)>,
    next_scene: i32,
    next_node: i32,
    next_geom: i32,
    next_mat: i32,
    next_pool: i32,
}

impl Store {
    pub fn new() -> Store {
        Store {
            next_scene: 1,
            next_node: 1,
            next_geom: 1,
            next_mat: 1,
            next_pool: 1,
            ..Default::default()
        }
    }

    // ---- host-side accessors (renderer / uihost) --------------------------

    pub fn scene(&self, id: i32) -> Option<&Scene> {
        self.scenes.get(&id)
    }

    pub fn node(&self, id: i32) -> Option<&Node> {
        self.nodes.get(&id)
    }

    pub fn geom(&self, id: i32) -> Option<&CpuMesh> {
        self.geoms.get(&id)
    }

    pub fn material(&self, id: i32) -> Option<Material> {
        self.materials.get(&id).copied()
    }

    pub fn pool(&self, id: i32) -> Option<&Pool> {
        self.pools.get(&id)
    }

    /// Current (ui node -> scene) bindings, ui-node order unspecified.
    pub fn bindings(&self) -> Vec<(i32, i32)> {
        self.viewports.iter().map(|(&ui, &sc)| (ui, sc)).collect()
    }

    /// Drain the bind/unbind event queue (call once per frame; the host
    /// forwards each as a PROP.scene3d write on the ui core).
    pub fn drain_binding_events(&mut self) -> Vec<(i32, i32)> {
        core::mem::take(&mut self.binding_events)
    }

    /// World transform of a node (walks up to the scene root). Test/debug
    /// helper — the renderer computes transforms top-down in one pass.
    pub fn world_transform(&self, id: i32) -> Option<Mat4> {
        let mut chain = Vec::new();
        let mut cur = self.nodes.get(&id)?;
        loop {
            chain.push(Mat4::from_scale_rotation_translation(cur.s, cur.q, cur.p));
            if cur.parent == 0 {
                break;
            }
            cur = self.nodes.get(&cur.parent)?;
        }
        let mut m = Mat4::IDENTITY;
        for local in chain.iter().rev() {
            m *= *local;
        }
        Some(m)
    }

    // ---- scenes ------------------------------------------------------------

    pub fn scene_create(&mut self) -> i32 {
        let id = self.next_scene;
        self.next_scene += 1;
        self.scenes.insert(
            id,
            Scene { id, root: Vec::new(), pools: Vec::new(), env: Env::default() },
        );
        id
    }

    pub fn scene_destroy(&mut self, scene: i32) {
        let Some(sc) = self.scenes.remove(&scene) else { return };
        // Reap every node in the scene (the per-scene set is implicit in
        // node.scene; walk from the roots).
        let mut stack = sc.root;
        while let Some(id) = stack.pop() {
            if let Some(node) = self.nodes.remove(&id) {
                stack.extend(node.children);
            }
        }
        for pid in sc.pools {
            self.pools.remove(&pid);
        }
        let dead: Vec<i32> = self
            .viewports
            .iter()
            .filter(|&(_, &s)| s == scene)
            .map(|(&ui, _)| ui)
            .collect();
        for ui in dead {
            self.viewports.remove(&ui);
            self.binding_events.push((ui, 0));
        }
    }

    // ---- node tree -----------------------------------------------------------

    pub fn node_create(&mut self, scene: i32, parent_or_0: i32) -> i32 {
        if !self.scenes.contains_key(&scene) {
            return 0;
        }
        if parent_or_0 != 0 {
            match self.nodes.get(&parent_or_0) {
                Some(p) if p.scene == scene => {}
                _ => return 0, // dead/foreign parent: no orphan is minted
            }
        }
        let id = self.next_node;
        self.next_node += 1;
        self.nodes.insert(
            id,
            Node {
                id,
                scene,
                parent: parent_or_0,
                children: Vec::new(),
                p: Vec3::ZERO,
                q: Quat::IDENTITY,
                s: Vec3::ONE,
                visible: true,
                geom: 0,
                mat: 0,
                tint: 0xffff_ffff,
            },
        );
        if parent_or_0 != 0 {
            self.nodes.get_mut(&parent_or_0).unwrap().children.push(id);
        } else {
            self.scenes.get_mut(&scene).unwrap().root.push(id);
        }
        id
    }

    /// Remove `id` from its sibling list (parent's children or scene root).
    fn unlink(&mut self, id: i32) {
        let Some(node) = self.nodes.get(&id) else { return };
        let (parent, scene) = (node.parent, node.scene);
        let list = if parent != 0 {
            self.nodes.get_mut(&parent).map(|p| &mut p.children)
        } else {
            self.scenes.get_mut(&scene).map(|s| &mut s.root)
        };
        if let Some(list) = list
            && let Some(i) = list.iter().position(|&c| c == id)
        {
            list.remove(i);
        }
    }

    pub fn node_destroy(&mut self, id: i32) {
        if !self.nodes.contains_key(&id) {
            return;
        }
        self.unlink(id);
        let mut stack = vec![id];
        while let Some(nid) = stack.pop() {
            if let Some(node) = self.nodes.remove(&nid) {
                stack.extend(node.children);
            }
        }
    }

    pub fn node_set_parent(&mut self, id: i32, parent_or_0: i32) {
        let Some(node) = self.nodes.get(&id) else { return };
        if node.parent == parent_or_0 {
            return;
        }
        let scene = node.scene;
        if !self.scenes.contains_key(&scene) {
            return;
        }
        if parent_or_0 != 0 {
            match self.nodes.get(&parent_or_0) {
                Some(p) if p.scene == scene => {}
                _ => return, // no cross-scene adoption
            }
            // Cycle guard: adopting under self or a descendant is a no-op.
            let mut a = parent_or_0;
            loop {
                if a == id {
                    return;
                }
                match self.nodes.get(&a) {
                    Some(n) if n.parent != 0 => a = n.parent,
                    _ => break,
                }
            }
        }
        self.unlink(id);
        self.nodes.get_mut(&id).unwrap().parent = parent_or_0;
        if parent_or_0 != 0 {
            self.nodes.get_mut(&parent_or_0).unwrap().children.push(id);
        } else {
            self.scenes.get_mut(&scene).unwrap().root.push(id);
        }
    }

    pub fn node_set_visible(&mut self, id: i32, on: bool) {
        if let Some(node) = self.nodes.get_mut(&id) {
            node.visible = on;
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn node_set_pose(&mut self, id: i32, px: f32, py: f32, pz: f32, qx: f32, qy: f32, qz: f32, qw: f32) {
        if let Some(node) = self.nodes.get_mut(&id) {
            node.p = Vec3::new(px, py, pz);
            node.q = Quat::from_xyzw(qx, qy, qz, qw);
        }
    }

    pub fn node_set_scale(&mut self, id: i32, sx: f32, sy: f32, sz: f32) {
        if let Some(node) = self.nodes.get_mut(&id) {
            node.s = Vec3::new(sx, sy, sz);
        }
    }

    /// HOT PATH — apply `count` POSE_STRIDE entries. Ids ride as f32 (exact
    /// for ids < 2^24); unknown ids are skipped (a destroy may race a staged
    /// write inside one guest turn).
    pub fn write_poses(&mut self, buf: &[f32], count: usize) {
        let n = count.min(buf.len() / POSE_STRIDE);
        for i in 0..n {
            let b = &buf[i * POSE_STRIDE..(i + 1) * POSE_STRIDE];
            let id = fmath::round(b[0]) as i32;
            let Some(node) = self.nodes.get_mut(&id) else { continue };
            node.p = Vec3::new(b[1], b[2], b[3]);
            node.q = Quat::from_xyzw(b[4], b[5], b[6], b[7]);
            node.s = Vec3::new(b[8], b[9], b[10]);
        }
    }

    // ---- geometry (creation always succeeds; tessellated up front) -----------

    fn add_geom(&mut self, mesh: CpuMesh) -> i32 {
        let id = self.next_geom;
        self.next_geom += 1;
        self.geoms.insert(id, mesh);
        id
    }

    pub fn geom_box(&mut self, hx: f32, hy: f32, hz: f32) -> i32 {
        self.add_geom(tess::boxx(hx, hy, hz))
    }

    pub fn geom_sphere(&mut self, radius: f32, segments: i32) -> i32 {
        self.add_geom(tess::sphere(radius, segments))
    }

    pub fn geom_cylinder(&mut self, r_top: f32, r_bottom: f32, height: f32, segments: i32) -> i32 {
        self.add_geom(tess::cylinder(r_top, r_bottom, height, segments))
    }

    pub fn geom_cone(&mut self, radius: f32, height: f32, segments: i32) -> i32 {
        // three parity: ConeGeometry == CylinderGeometry(0, r, h).
        self.add_geom(tess::cylinder(0.0, radius, height, segments))
    }

    pub fn geom_plane(&mut self, w: f32, d: f32) -> i32 {
        self.add_geom(tess::plane(w, d))
    }

    pub fn geom_torus(&mut self, radius: f32, tube: f32, segments: i32, tube_segments: i32) -> i32 {
        self.add_geom(tess::torus(radius, tube, segments, tube_segments))
    }

    pub fn geom_mesh(&mut self, positions: &[f32], indices: &[u32], colors: Option<&[f32]>) -> i32 {
        self.add_geom(tess::mesh(positions, indices, colors))
    }

    pub fn geom_heightfield(
        &mut self,
        w: f32,
        d: f32,
        cols: i32,
        rows: i32,
        heights: &[f32],
        colors: Option<&[f32]>,
    ) -> i32 {
        self.add_geom(tess::heightfield(w, d, cols, rows, heights, colors))
    }

    pub fn geom_free(&mut self, id: i32) {
        self.geoms.remove(&id); // nodes still referencing it draw nothing
    }

    // ---- materials -------------------------------------------------------------

    pub fn material_create(&mut self, color: u32, flags: u32) -> i32 {
        let id = self.next_mat;
        self.next_mat += 1;
        self.materials.insert(id, Material { color, flags });
        id
    }

    pub fn material_set_color(&mut self, id: i32, color: u32) {
        if let Some(m) = self.materials.get_mut(&id) {
            m.color = color;
        }
    }

    pub fn material_free(&mut self, id: i32) {
        self.materials.remove(&id);
    }

    // ---- mesh attachment ----------------------------------------------------------

    pub fn mesh_set(&mut self, node_id: i32, geom_id: i32, mat_id: i32) {
        if let Some(node) = self.nodes.get_mut(&node_id) {
            // Ids are stored verbatim (no liveness check): geomFree semantics
            // say a dangling reference draws nothing, it is not an error.
            node.geom = geom_id;
            node.mat = if geom_id == 0 { 0 } else { mat_id }; // geom 0 clears
        }
    }

    pub fn node_set_tint(&mut self, node_id: i32, color: u32) {
        if let Some(node) = self.nodes.get_mut(&node_id) {
            node.tint = color;
        }
    }

    // ---- environment -----------------------------------------------------------------

    pub fn sun(&mut self, scene: i32, dx: f32, dy: f32, dz: f32, color: u32) {
        if let Some(sc) = self.scenes.get_mut(&scene) {
            let v = Vec3::new(dx, dy, dz);
            let dir = if v.length() > 0.0 { v / v.length() } else { Vec3::ZERO };
            sc.env.sun = Some((dir, color));
        }
    }

    pub fn ambient(&mut self, scene: i32, sky: u32, ground: u32) {
        if let Some(sc) = self.scenes.get_mut(&scene) {
            sc.env.ambient = Some((sky, ground));
        }
    }

    pub fn fog(&mut self, scene: i32, color: u32, near: f32, far: f32) {
        if let Some(sc) = self.scenes.get_mut(&scene) {
            sc.env.fog = if far <= near { None } else { Some((color, near, far)) };
        }
    }

    pub fn sky(&mut self, scene: i32, zenith: u32, horizon: u32) {
        if let Some(sc) = self.scenes.get_mut(&scene) {
            sc.env.sky = Some((zenith, horizon));
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn camera(
        &mut self,
        scene: i32,
        px: f32, py: f32, pz: f32,
        qx: f32, qy: f32, qz: f32, qw: f32,
        fov_y: f32, znear: f32, zfar: f32,
    ) {
        if let Some(sc) = self.scenes.get_mut(&scene) {
            sc.env.camera = CameraState {
                p: Vec3::new(px, py, pz),
                q: Quat::from_xyzw(qx, qy, qz, qw),
                fov_y,
                znear,
                zfar,
            };
        }
    }

    // ---- pooled billboards & ribbons ----------------------------------------------------

    pub fn pool_create(&mut self, scene: i32, capacity: f64, mat: i32, kind: PoolKind) -> i32 {
        if !self.scenes.contains_key(&scene) {
            return 0;
        }
        let id = self.next_pool;
        self.next_pool += 1;
        self.pools.insert(
            id,
            Pool {
                scene,
                kind,
                capacity: fmath::floor64(capacity.max(0.0)) as usize,
                mat,
                live: Vec::new(),
                colors: Vec::new(),
                count: 0,
                dropped_writes: 0,
            },
        );
        self.scenes.get_mut(&scene).unwrap().pools.push(id);
        id
    }

    /// Replace the pool's live set (count > capacity clamps; never reads past
    /// what the caller supplied).
    pub fn pool_write(&mut self, pool: i32, kind: PoolKind, buf: &[f32], colors: &[u32], count: f64) {
        let stride = match kind {
            PoolKind::Sprite => SPRITE_STRIDE,
            PoolKind::Beam => BEAM_STRIDE,
        };
        let Some(p) = self.pools.get_mut(&pool) else { return };
        if p.kind != kind {
            return;
        }
        let requested = fmath::floor64(count.max(0.0)) as usize;
        let present = requested.min(buf.len() / stride).min(colors.len());
        let kept = present.min(p.capacity);
        p.dropped_writes += requested.saturating_sub(p.capacity) as u64;
        p.live.clear();
        p.live.extend_from_slice(&buf[..kept * stride]);
        p.colors.clear();
        p.colors.extend_from_slice(&colors[..kept]);
        p.count = kept;
    }

    pub fn pool_free(&mut self, pool: i32) {
        let Some(p) = self.pools.remove(&pool) else { return };
        if let Some(sc) = self.scenes.get_mut(&p.scene)
            && let Some(i) = sc.pools.iter().position(|&x| x == pool)
        {
            sc.pools.remove(i);
        }
    }

    // ---- viewport binding ------------------------------------------------------------------

    pub fn bind_viewport(&mut self, ui_node: i32, scene: i32) {
        if scene == 0 {
            if self.viewports.remove(&ui_node).is_some() {
                self.binding_events.push((ui_node, 0));
            }
            return;
        }
        if !self.scenes.contains_key(&scene) {
            return; // dead/unknown scene: silent no-op
        }
        self.viewports.insert(ui_node, scene);
        self.binding_events.push((ui_node, scene));
    }
}

// ---------------------------------------------------------------------------
// Tessellation — unit CPU meshes from the ops params. Conventions: CCW
// winding seen from the outside/normal side (right-handed, +Y up).
// ---------------------------------------------------------------------------

mod tess {
    use alloc::vec;
    use alloc::vec::Vec;

    use super::{CpuMesh, fmath};

    fn seg(n: i32, min: usize) -> usize {
        (n.max(0) as usize).clamp(min, 128)
    }

    /// Axis-aligned box from HALF extents, 24 verts (per-face normals).
    pub fn boxx(hx: f32, hy: f32, hz: f32) -> CpuMesh {
        // (normal, u axis, v axis) per face; quad corners u,v in {-1, 1}.
        const FACES: [([f32; 3], [f32; 3], [f32; 3]); 6] = [
            ([1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]),
            ([-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
            ([0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, -1.0]),
            ([0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
            ([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
            ([0.0, 0.0, -1.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        ];
        let h = [hx, hy, hz];
        let mut positions = Vec::with_capacity(24);
        let mut normals = Vec::with_capacity(24);
        let mut indices = Vec::with_capacity(36);
        for (n, u, v) in FACES {
            let base = positions.len() as u32;
            for (su, sv) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
                let p = [
                    (n[0] + u[0] * su + v[0] * sv) * h[0],
                    (n[1] + u[1] * su + v[1] * sv) * h[1],
                    (n[2] + u[2] * su + v[2] * sv) * h[2],
                ];
                positions.push(p);
                normals.push(n);
            }
            // CCW seen from outside (u cross v = n).
            indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
        }
        CpuMesh { positions, normals, colors: None, indices }
    }

    /// UV sphere; `segments` around the equator, half that many rings.
    pub fn sphere(radius: f32, segments: i32) -> CpuMesh {
        let around = seg(segments, 3);
        let rings = (around / 2).max(2);
        let mut positions = Vec::new();
        let mut normals = Vec::new();
        let mut indices = Vec::new();
        for r in 0..=rings {
            let phi = core::f32::consts::PI * r as f32 / rings as f32; // 0 = +Y pole
            let (sp, cp) = fmath::sin_cos(phi);
            for a in 0..=around {
                let theta = core::f32::consts::TAU * a as f32 / around as f32;
                let (st, ct) = fmath::sin_cos(theta);
                let n = [sp * ct, cp, sp * st];
                normals.push(n);
                positions.push([n[0] * radius, n[1] * radius, n[2] * radius]);
            }
        }
        let stride = (around + 1) as u32;
        for r in 0..rings as u32 {
            for a in 0..around as u32 {
                let i0 = r * stride + a;
                let i1 = i0 + 1;
                let i2 = i0 + stride;
                let i3 = i2 + 1;
                // +Y pole at r=0: rows advance downward; theta advances +Z
                // from +X, so (down, around) needs this order for CCW-out.
                indices.extend_from_slice(&[i0, i1, i2, i1, i3, i2]);
            }
        }
        CpuMesh { positions, normals, colors: None, indices }
    }

    /// Cylinder along +Y, centered; r_top = 0 degenerates to a cone.
    pub fn cylinder(r_top: f32, r_bottom: f32, height: f32, segments: i32) -> CpuMesh {
        let around = seg(segments, 3);
        let hh = height * 0.5;
        let mut positions = Vec::new();
        let mut normals = Vec::new();
        let mut indices = Vec::new();
        // Side wall: slanted normal (renormalized straight from the slope).
        let slope = (r_bottom - r_top) / height.max(1e-6);
        for a in 0..=around {
            let theta = core::f32::consts::TAU * a as f32 / around as f32;
            let (st, ct) = fmath::sin_cos(theta);
            let n = {
                let l = fmath::sqrt(1.0 + slope * slope);
                [ct / l, slope / l, st / l]
            };
            positions.push([ct * r_top, hh, st * r_top]);
            normals.push(n);
            positions.push([ct * r_bottom, -hh, st * r_bottom]);
            normals.push(n);
        }
        for a in 0..around as u32 {
            let i0 = a * 2; // top a
            let i1 = i0 + 1; // bottom a
            let i2 = i0 + 2; // top a+1
            let i3 = i0 + 3; // bottom a+1
            // theta advances +X -> +Z; outward CCW is (top, next, bottom).
            indices.extend_from_slice(&[i0, i2, i1, i2, i3, i1]);
        }
        // Caps.
        for (r, y, ny) in [(r_top, hh, 1.0f32), (r_bottom, -hh, -1.0f32)] {
            if r <= 0.0 {
                continue;
            }
            let base = positions.len() as u32;
            positions.push([0.0, y, 0.0]);
            normals.push([0.0, ny, 0.0]);
            for a in 0..=around {
                let theta = core::f32::consts::TAU * a as f32 / around as f32;
                let (st, ct) = fmath::sin_cos(theta);
                positions.push([ct * r, y, st * r]);
                normals.push([0.0, ny, 0.0]);
            }
            for a in 0..around as u32 {
                let (i1, i2) = (base + 1 + a, base + 2 + a);
                if ny > 0.0 {
                    indices.extend_from_slice(&[base, i2, i1]); // top: CCW from +Y
                } else {
                    indices.extend_from_slice(&[base, i1, i2]); // bottom: CCW from -Y
                }
            }
        }
        CpuMesh { positions, normals, colors: None, indices }
    }

    /// Plane in XZ facing +Y, w x d, centered.
    pub fn plane(w: f32, d: f32) -> CpuMesh {
        let (hw, hd) = (w * 0.5, d * 0.5);
        CpuMesh {
            positions: vec![
                [-hw, 0.0, -hd],
                [hw, 0.0, -hd],
                [hw, 0.0, hd],
                [-hw, 0.0, hd],
            ],
            normals: vec![[0.0, 1.0, 0.0]; 4],
            colors: None,
            // CCW seen from +Y.
            indices: vec![0, 2, 1, 0, 3, 2],
        }
    }

    /// Torus in the XY plane around +Z (three TorusGeometry parity).
    pub fn torus(radius: f32, tube: f32, segments: i32, tube_segments: i32) -> CpuMesh {
        let around = seg(segments, 3);
        let tube_around = seg(tube_segments, 3);
        let mut positions = Vec::new();
        let mut normals = Vec::new();
        let mut indices = Vec::new();
        for j in 0..=around {
            let u = core::f32::consts::TAU * j as f32 / around as f32;
            let (su, cu) = fmath::sin_cos(u);
            for i in 0..=tube_around {
                let v = core::f32::consts::TAU * i as f32 / tube_around as f32;
                let (sv, cv) = fmath::sin_cos(v);
                positions.push([(radius + tube * cv) * cu, (radius + tube * cv) * su, tube * sv]);
                normals.push([cv * cu, cv * su, sv]);
            }
        }
        let stride = (tube_around + 1) as u32;
        for j in 0..around as u32 {
            for i in 0..tube_around as u32 {
                let a = j * stride + i;
                let b = (j + 1) * stride + i;
                indices.extend_from_slice(&[a, b, a + 1, b, b + 1, a + 1]);
            }
        }
        CpuMesh { positions, normals, colors: None, indices }
    }

    /// Indexed triangle mesh with smooth vertex normals computed by area-
    /// weighted face-normal accumulation.
    pub fn mesh(positions: &[f32], indices: &[u32], colors: Option<&[f32]>) -> CpuMesh {
        let vcount = positions.len() / 3;
        let pos: Vec<[f32; 3]> = (0..vcount)
            .map(|i| [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]])
            .collect();
        let idx: Vec<u32> = indices
            .chunks_exact(3)
            .filter(|t| t.iter().all(|&i| (i as usize) < vcount))
            .flatten()
            .copied()
            .collect();
        let normals = smooth_normals(&pos, &idx);
        let colors = colors.map(|c| {
            (0..vcount)
                .map(|i| {
                    [
                        c.get(i * 3).copied().unwrap_or(1.0),
                        c.get(i * 3 + 1).copied().unwrap_or(1.0),
                        c.get(i * 3 + 2).copied().unwrap_or(1.0),
                    ]
                })
                .collect()
        });
        CpuMesh { positions: pos, normals, colors, indices: idx }
    }

    /// cols x rows vertex grid over w x d in XZ, heights row-major (rows of
    /// cols). Rows advance along the playset "forward" axis, which is -Z in
    /// the default world basis (right = +X, up = +Y, forward = -Z), so the
    /// visual terrain lines up with planar (right, forward) colliders:
    /// vertex(col, row) = (-w/2 + col*dx, heights[row*cols+col], d/2 - row*dz).
    pub fn heightfield(
        w: f32,
        d: f32,
        cols: i32,
        rows: i32,
        heights: &[f32],
        colors: Option<&[f32]>,
    ) -> CpuMesh {
        let cols = cols.max(0) as usize;
        let rows = rows.max(0) as usize;
        if cols < 2 || rows < 2 || heights.len() < cols * rows {
            return CpuMesh { positions: Vec::new(), normals: Vec::new(), colors: None, indices: Vec::new() };
        }
        let dx = w / (cols - 1) as f32;
        let dz = d / (rows - 1) as f32;
        let mut positions = Vec::with_capacity(cols * rows);
        for row in 0..rows {
            for col in 0..cols {
                positions.push([
                    -w * 0.5 + col as f32 * dx,
                    heights[row * cols + col],
                    d * 0.5 - row as f32 * dz,
                ]);
            }
        }
        let mut indices = Vec::with_capacity((cols - 1) * (rows - 1) * 6);
        for row in 0..(rows - 1) as u32 {
            for col in 0..(cols - 1) as u32 {
                let a = row * cols as u32 + col;
                let b = a + 1;
                let c = a + cols as u32;
                let e = c + 1;
                // row+1 is at SMALLER z; CCW seen from +Y.
                indices.extend_from_slice(&[a, b, c, b, e, c]);
            }
        }
        let normals = smooth_normals(&positions, &indices);
        let colors = colors.map(|c| {
            (0..cols * rows)
                .map(|i| {
                    [
                        c.get(i * 3).copied().unwrap_or(1.0),
                        c.get(i * 3 + 1).copied().unwrap_or(1.0),
                        c.get(i * 3 + 2).copied().unwrap_or(1.0),
                    ]
                })
                .collect()
        });
        CpuMesh { positions, normals, colors, indices }
    }

    fn smooth_normals(positions: &[[f32; 3]], indices: &[u32]) -> Vec<[f32; 3]> {
        let mut acc = vec![[0.0f32; 3]; positions.len()];
        for t in indices.chunks_exact(3) {
            let (a, b, c) = (t[0] as usize, t[1] as usize, t[2] as usize);
            let (pa, pb, pc) = (positions[a], positions[b], positions[c]);
            let e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
            let e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
            // Unnormalized cross = area weighting.
            let n = [
                e1[1] * e2[2] - e1[2] * e2[1],
                e1[2] * e2[0] - e1[0] * e2[2],
                e1[0] * e2[1] - e1[1] * e2[0],
            ];
            for i in [a, b, c] {
                acc[i][0] += n[0];
                acc[i][1] += n[1];
                acc[i][2] += n[2];
            }
        }
        for n in &mut acc {
            let l = fmath::sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
            if l > 1e-12 {
                n[0] /= l;
                n[1] /= l;
                n[2] /= l;
            } else {
                *n = [0.0, 1.0, 0.0];
            }
        }
        acc
    }
}
