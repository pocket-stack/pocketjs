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

use crate::batch::{self, BatchKey, MAX_BATCH_VERTS, MAX_GEOM_VERTS, StaticBatch};

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
    /// Set by `freeze_nodes`: the guest promised this world transform is
    /// final, so the batcher may bake it into merged geometry (batch.rs).
    /// Store-owned bookkeeping — read it, don't write it.
    pub frozen: bool,
    /// Set by `ensure_static_batches` when a merged batch already draws this
    /// node, so the renderer's per-node walk must skip it. Store-owned; read
    /// it through `Store::node_batched` (this field IS that O(1) answer).
    pub batched: bool,
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

/// One scene's static-batch generation (see batch.rs for the why).
///
/// Kept out of `Scene` on purpose: this is derived state the host rebuilds,
/// not part of the op-stream scene the guest describes.
#[derive(Default)]
struct SceneBatches {
    batches: Vec<StaticBatch>,
    /// The geom ids `batches` own. Freed wholesale on the next rebuild —
    /// without this, re-freezing a scene leaks a merged copy every time.
    geoms: Vec<i32>,
    /// Node ids currently covered by `batches`, so a rebuild can clear their
    /// `batched` flags without walking the whole scene.
    members: Vec<i32>,
    /// Something changed that could alter membership; rebuild on next ensure.
    dirty: bool,
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
    /// Static-batch generation per scene; an entry exists only once something
    /// in that scene has been frozen.
    batches: BTreeMap<i32, SceneBatches>,
    /// True while ANY scene's batches are stale. `ensure_static_batches` runs
    /// every frame from the renderers, so its early-out has to be one bool
    /// load, not a map lookup.
    batches_dirty: bool,
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
        // Merged geoms die with the scene that owns them.
        if let Some(b) = self.batches.remove(&scene) {
            for g in b.geoms {
                self.geoms.remove(&g);
            }
        }
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
                frozen: false,
                batched: false,
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
        let Some(scene) = self.nodes.get(&id).map(|n| n.scene) else { return };
        // A batch that merged this node would keep drawing it after the
        // destroy, so the scene's batches stop being trustworthy here.
        self.invalidate_batches(scene);
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
        // Reparenting moves the whole subtree's world transforms, which is
        // exactly what a baked batch assumed would never happen.
        self.invalidate_batches(scene);
        self.unlink(id);
        self.nodes.get_mut(&id).unwrap().parent = parent_or_0;
        if parent_or_0 != 0 {
            self.nodes.get_mut(&parent_or_0).unwrap().children.push(id);
        } else {
            self.scenes.get_mut(&scene).unwrap().root.push(id);
        }
    }

    pub fn node_set_visible(&mut self, id: i32, on: bool) {
        let Some(node) = self.nodes.get_mut(&id) else { return };
        if node.visible == on {
            return;
        }
        node.visible = on;
        let scene = node.scene;
        // THE INVALIDATION RULE (see `invalidate_batches`): any visibility
        // toggle rebuilds the whole scene's batches. A batched node inside a
        // subtree that just went invisible would otherwise keep drawing —
        // hiding a subtree is one bit that can silently un-hide 30 merged
        // fence posts, and no cheaper rule survives that.
        self.invalidate_batches(scene);
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

    // ---- static geometry batching (see batch.rs for the whole rationale) ----

    /// Freeze nodes: the guest promises these world transforms are final, so
    /// the host may bake them into merged geometry.
    ///
    /// A frozen node must never move again — moving it afterwards changes
    /// nothing on screen once it has been merged. Freezing is per node id and
    /// does NOT descend into children: the guest sends every id it means (one
    /// batched op for a 550-node environment, ops.ts `freeze`).
    pub fn freeze_nodes(&mut self, ids: &[i32]) {
        let mut touched = false;
        for &id in ids {
            let Some(node) = self.nodes.get_mut(&id) else { continue }; // dead handle: no-op
            if node.frozen {
                continue; // idempotent — a re-freeze must not force a rebuild
            }
            node.frozen = true;
            let scene = node.scene;
            // Minting the entry here is what arms invalidation for this scene:
            // scenes that never freeze anything never pay for any of this.
            self.batches.entry(scene).or_default().dirty = true;
            touched = true;
        }
        if touched {
            self.batches_dirty = true;
        }
    }

    /// Rebuild `scene`'s static batches if freezing (or any invalidating op)
    /// changed something since the last call. Renderers call this every frame:
    /// when nothing changed it is one bool load and no allocation.
    pub fn ensure_static_batches(&mut self, scene: i32) {
        if !self.batches_dirty {
            return;
        }
        match self.batches.get(&scene) {
            Some(b) if b.dirty => {}
            _ => return, // never frozen, or already current
        }
        self.rebuild_static_batches(scene);
    }

    /// The merged draws for `scene`: world-space geometry, identity model
    /// matrix, bounding sphere for the renderer's existing frustum test.
    pub fn static_batches(&self, scene: i32) -> &[StaticBatch] {
        const NONE: &[StaticBatch] = &[];
        self.batches.get(&scene).map_or(NONE, |b| &b.batches)
    }

    /// True when the renderer's per-node walk must SKIP this node because a
    /// batch already draws it. One map lookup, no scan — the walk calls it for
    /// every node of every frame.
    pub fn node_batched(&self, id: i32) -> bool {
        self.nodes.get(&id).is_some_and(|n| n.batched)
    }

    /// THE INVALIDATION RULE. Anything that can change what a batch would
    /// contain — freeze, visibility toggle, destroy, reparent, meshSet, tint,
    /// geomFree — marks the node's scene stale, and the next
    /// `ensure_static_batches` rebuilds that scene from scratch. Coarse on
    /// purpose: these are setup/teardown ops, while the per-frame op is
    /// `write_poses`, which deliberately does NOT invalidate — freeze already
    /// promised those transforms are final, so a pose write on a frozen node
    /// is a broken promise, not a rebuild trigger.
    ///
    /// Scenes with no frozen nodes have no entry and are skipped entirely.
    fn invalidate_batches(&mut self, scene: i32) {
        if let Some(b) = self.batches.get_mut(&scene) {
            b.dirty = true;
            self.batches_dirty = true;
        }
    }

    fn rebuild_static_batches(&mut self, scene: i32) {
        // -- retire the previous generation ---------------------------------
        // Freeing the old merged geoms here is what keeps repeated freezing
        // from leaking a full copy of the scenery every rebuild.
        let Some(entry) = self.batches.get_mut(&scene) else { return };
        let old_geoms = core::mem::take(&mut entry.geoms);
        let old_members = core::mem::take(&mut entry.members);
        entry.batches = Vec::new();
        entry.dirty = false;
        for g in old_geoms {
            self.geoms.remove(&g);
        }
        for id in old_members {
            if let Some(n) = self.nodes.get_mut(&id) {
                n.batched = false;
            }
        }

        // -- collect candidates, top-down, exactly like the renderer walks ---
        // Hidden subtrees are pruned here rather than tested per node, so
        // "eligible" already means "the whole ancestor chain is visible".
        let mut groups: BTreeMap<BatchKey, Vec<(i32, Mat4, i32)>> = BTreeMap::new();
        if let Some(sc) = self.scenes.get(&scene) {
            let mut stack: Vec<(i32, Mat4)> =
                sc.root.iter().rev().map(|&id| (id, Mat4::IDENTITY)).collect();
            while let Some((id, parent_world)) = stack.pop() {
                let Some(node) = self.nodes.get(&id) else { continue };
                if !node.visible {
                    continue;
                }
                let world =
                    parent_world * Mat4::from_scale_rotation_translation(node.s, node.q, node.p);
                for &c in node.children.iter().rev() {
                    stack.push((c, world));
                }
                if !node.frozen || node.geom == 0 || node.mat == 0 {
                    continue;
                }
                let Some(mesh) = self.geoms.get(&node.geom) else { continue }; // dangling
                if mesh.indices.is_empty() || mesh.positions.len() > MAX_GEOM_VERTS {
                    continue; // draws nothing, or too big to be worth copying
                }
                // Keyed on the node's WORLD position: the cell a post stands
                // in, not the cell its parent group's origin sits in.
                // CAVEAT (batch.rs): the world matrix bakes into the vertices
                // including its scale, and merged normals are just rotated +
                // renormalized — exact for the rotation/uniform scale scenery
                // uses, slightly off for a non-uniformly scaled frozen node.
                let key = BatchKey::new(node.mat, node.tint, world.w_axis.truncate());
                groups.entry(key).or_default().push((id, world, node.geom));
            }
        }

        // -- merge, in sorted key order so the result is reproducible --------
        let mut batches: Vec<StaticBatch> = Vec::new();
        let mut geoms: Vec<i32> = Vec::new();
        let mut members: Vec<i32> = Vec::new();
        let mut used = 0usize;
        for (key, group) in groups {
            if group.len() < 2 {
                continue; // one member saves no draw call and still costs a copy
            }
            // Members may come from DIFFERENT meshes (see BatchKey), so the
            // size of the merge is the sum over members, not one mesh times
            // the count.
            let verts: usize = group
                .iter()
                .map(|&(_, _, g)| self.geoms.get(&g).map_or(0, |m| m.positions.len()))
                .sum();
            let index_count: usize = group
                .iter()
                .map(|&(_, _, g)| self.geoms.get(&g).map_or(0, |m| m.indices.len()))
                .sum();
            if verts == 0 {
                continue;
            }
            if used + verts > MAX_BATCH_VERTS {
                // Stop rather than skip-and-continue: the batch set is then a
                // prefix of one stable order, which is much easier to reason
                // about (and to test) than a packing that depends on which
                // groups happened to fit.
                break;
            }
            let mut positions = Vec::with_capacity(verts);
            let mut normals = Vec::with_capacity(verts);
            let mut colors = Vec::with_capacity(verts);
            let mut indices = Vec::with_capacity(index_count);
            for &(_, world, geom_id) in &group {
                let Some(src) = self.geoms.get(&geom_id) else { continue };
                batch::append_transformed(
                    &mut positions,
                    &mut normals,
                    &mut colors,
                    &mut indices,
                    world,
                    &src.positions,
                    &src.normals,
                    src.colors.as_deref(),
                    &src.indices,
                );
            }
            used += verts;
            let (bound_center, bound_radius) = batch::bounds_of(&positions);
            // A regular geom id: every host bakes/uploads it through the same
            // path as any other mesh, and ids are never reused, so their
            // upload caches stay valid.
            let geom = self.add_geom(CpuMesh {
                positions,
                normals,
                colors: Some(colors),
                indices,
            });
            batches.push(StaticBatch { geom, mat: key.mat, tint: key.tint, bound_center, bound_radius });
            geoms.push(geom);
            members.extend(group.iter().map(|&(id, _, _)| id));
        }
        for &id in &members {
            if let Some(n) = self.nodes.get_mut(&id) {
                n.batched = true;
            }
        }
        let entry = self.batches.entry(scene).or_default();
        entry.batches = batches;
        entry.geoms = geoms;
        entry.members = members;
        entry.dirty = false;
        // Other scenes may still be waiting; only clear the global flag when
        // none of them is.
        self.batches_dirty = self.batches.values().any(|b| b.dirty);
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
        // A merged batch holds a COPY, so freeing the source would not stop it
        // drawing. Geom ids carry no scene, so every batched scene rebuilds;
        // geomFree is a teardown-time op, not a per-frame one.
        for b in self.batches.values_mut() {
            b.dirty = true;
        }
        self.batches_dirty |= !self.batches.is_empty();
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
        let Some(node) = self.nodes.get_mut(&node_id) else { return };
        // Ids are stored verbatim (no liveness check): geomFree semantics
        // say a dangling reference draws nothing, it is not an error.
        node.geom = geom_id;
        node.mat = if geom_id == 0 { 0 } else { mat_id }; // geom 0 clears
        let scene = node.scene;
        // geom/mat/tint ARE the batch key: changing them changes grouping.
        self.invalidate_batches(scene);
    }

    pub fn node_set_tint(&mut self, node_id: i32, color: u32) {
        let Some(node) = self.nodes.get_mut(&node_id) else { return };
        if node.tint == color {
            return;
        }
        node.tint = color;
        let scene = node.scene;
        self.invalidate_batches(scene);
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

// ---------------------------------------------------------------------------
// Static batching tests. In-module (not lib.rs) so they can read the private
// geom registry directly — "does re-freezing leak geoms" is only checkable
// from in here.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod batch_tests {
    use super::*;
    use crate::batch::CELL;

    /// A frozen-scenery node: box at (x, y, z), no rotation.
    fn scenery(s: &mut Store, scene: i32, geom: i32, mat: i32, x: f32, y: f32, z: f32) -> i32 {
        let n = s.node_create(scene, 0);
        s.node_set_pose(n, x, y, z, 0.0, 0.0, 0.0, 1.0);
        s.mesh_set(n, geom, mat);
        n
    }

    fn tri_count(s: &Store, geom: i32) -> usize {
        s.geom(geom).map_or(0, |m| m.indices.len() / 3)
    }

    #[test]
    fn grouping_splits_by_material_and_by_cell() {
        let mut s = Store::new();
        let sc = s.scene_create();
        let g = s.geom_box(0.5, 0.5, 0.5);
        let red = s.material_create(0xff0000ff, 0);
        let blue = s.material_create(0xffff0000, 0);
        // Same cell, two materials; then the same material a cell away.
        let a1 = scenery(&mut s, sc, g, red, 0.0, 0.0, 0.0);
        let a2 = scenery(&mut s, sc, g, red, 2.5, 0.0, 0.0);
        let b1 = scenery(&mut s, sc, g, blue, 5.0, 0.0, 0.0);
        let b2 = scenery(&mut s, sc, g, blue, 7.5, 0.0, 0.0);
        let c1 = scenery(&mut s, sc, g, red, CELL * 1.5, 0.0, 0.0);
        let c2 = scenery(&mut s, sc, g, red, CELL * 1.5 + 2.5, 0.0, 0.0);
        s.freeze_nodes(&[a1, a2, b1, b2, c1, c2]);
        s.ensure_static_batches(sc);
        let batches = s.static_batches(sc);
        assert_eq!(batches.len(), 3, "material split x cell split");
        let mats: Vec<i32> = batches.iter().map(|b| b.mat).collect();
        assert_eq!(mats.iter().filter(|&&m| m == red).count(), 2);
        assert_eq!(mats.iter().filter(|&&m| m == blue).count(), 1);
        // A tint difference splits too — it is part of the draw state.
        s.node_set_tint(a2, 0xff00_ff00);
        s.ensure_static_batches(sc);
        assert_eq!(s.static_batches(sc).len(), 2, "a1/a2 no longer share a key");
        assert!(!s.node_batched(a1) && !s.node_batched(a2));
    }

    #[test]
    fn merged_triangle_count_is_the_sum_of_the_members() {
        let mut s = Store::new();
        let sc = s.scene_create();
        let g = s.geom_box(0.5, 0.5, 0.5);
        let m = s.material_create(0xffffffff, 0);
        let ids: Vec<i32> = (0..5)
            .map(|i| scenery(&mut s, sc, g, m, i as f32 * 2.0, 0.0, 0.0))
            .collect();
        s.freeze_nodes(&ids);
        s.ensure_static_batches(sc);
        let batches = s.static_batches(sc);
        assert_eq!(batches.len(), 1);
        assert_eq!(tri_count(&s, batches[0].geom), 5 * tri_count(&s, g));
        let merged = s.geom(batches[0].geom).unwrap();
        assert_eq!(merged.positions.len(), 5 * s.geom(g).unwrap().positions.len());
        assert_eq!(merged.positions.len(), merged.normals.len());
        // A merged mesh always carries a colour stream (white where the source
        // had none) — one vertex format for the whole buffer.
        assert_eq!(merged.colors.as_ref().unwrap().len(), merged.positions.len());
        assert!(merged.indices.iter().all(|&i| (i as usize) < merged.positions.len()));
    }

    #[test]
    fn merged_vertices_land_in_world_space() {
        let mut s = Store::new();
        let sc = s.scene_create();
        let g = s.geom_box(1.0, 1.0, 1.0);
        let m = s.material_create(0xffffffff, 0);
        // boxx's first vertex is the +X face corner (u,v) = (-1,-1) = [1,-1,1].
        assert_eq!(s.geom(g).unwrap().positions[0], [1.0, -1.0, 1.0]);
        let verts = s.geom(g).unwrap().positions.len();

        let a = scenery(&mut s, sc, g, m, 5.0, 0.0, 7.0);
        // Second member under a parent rotated +90 deg about Y at (10, 0, 0):
        // the batch must bake the FULL ancestor chain, not the local pose.
        let parent = s.node_create(sc, 0);
        let q = glam::Quat::from_rotation_y(core::f32::consts::FRAC_PI_2);
        s.node_set_pose(parent, 10.0, 0.0, 0.0, q.x, q.y, q.z, q.w);
        let b = s.node_create(sc, parent);
        s.mesh_set(b, g, m);
        s.freeze_nodes(&[a, b]);
        s.ensure_static_batches(sc);

        let batch = s.static_batches(sc)[0];
        let merged = s.geom(batch.geom).unwrap();
        // Member a: pure translation.
        let p0 = Vec3::from_array(merged.positions[0]);
        assert!((p0 - Vec3::new(6.0, -1.0, 8.0)).length() < 1e-5, "got {p0}");
        // Member b: +90 deg about Y sends (1,-1,1) to (1,-1,-1), then +10 X.
        let p1 = Vec3::from_array(merged.positions[verts]);
        assert!((p1 - Vec3::new(11.0, -1.0, -1.0)).length() < 1e-5, "got {p1}");
        // Normals are rotated too (+X face of member b now faces -Z).
        let n1 = Vec3::from_array(merged.normals[verts]);
        assert!((n1 - Vec3::new(0.0, 0.0, -1.0)).length() < 1e-5, "got {n1}");
        // The bound encloses both members and is world-space, not local.
        for p in &merged.positions {
            assert!((Vec3::from_array(*p) - batch.bound_center).length() <= batch.bound_radius + 1e-4);
        }
    }

    #[test]
    fn singletons_and_unfrozen_nodes_stay_unbatched() {
        let mut s = Store::new();
        let sc = s.scene_create();
        let g = s.geom_box(0.5, 0.5, 0.5);
        let m = s.material_create(0xffffffff, 0);
        let lonely = scenery(&mut s, sc, g, m, 0.0, 0.0, 0.0);
        let far = scenery(&mut s, sc, g, m, CELL * 4.0, 0.0, 0.0);
        let pair_a = scenery(&mut s, sc, g, m, CELL * 8.0, 0.0, 0.0);
        let pair_b = scenery(&mut s, sc, g, m, CELL * 8.0 + 1.0, 0.0, 0.0);
        let moving = scenery(&mut s, sc, g, m, CELL * 8.0 + 2.0, 0.0, 0.0); // never frozen
        let bare = s.node_create(sc, 0); // group: no geom/mat
        s.freeze_nodes(&[lonely, far, pair_a, pair_b, bare]);
        s.ensure_static_batches(sc);
        assert_eq!(s.static_batches(sc).len(), 1, "only the pair is worth merging");
        assert!(s.node_batched(pair_a) && s.node_batched(pair_b));
        for id in [lonely, far, moving, bare] {
            assert!(!s.node_batched(id), "node {id} must still be walked per-node");
        }
        // An invisible member drops out; two left standing means no batch.
        s.node_set_visible(pair_a, false);
        s.ensure_static_batches(sc);
        assert!(s.static_batches(sc).is_empty());
        assert!(!s.node_batched(pair_b));
    }

    #[test]
    fn hidden_ancestor_removes_the_whole_subtree_from_batches() {
        let mut s = Store::new();
        let sc = s.scene_create();
        let g = s.geom_box(0.5, 0.5, 0.5);
        let m = s.material_create(0xffffffff, 0);
        let group = s.node_create(sc, 0);
        let mut kids = Vec::new();
        for i in 0..4 {
            let n = s.node_create(sc, group);
            s.node_set_pose(n, i as f32, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0);
            s.mesh_set(n, g, m);
            kids.push(n);
        }
        s.freeze_nodes(&kids);
        s.ensure_static_batches(sc);
        assert_eq!(s.static_batches(sc).len(), 1);
        // THE RULE: hiding an ancestor invalidates the scene, so the merged
        // draw disappears with the subtree instead of outliving it.
        s.node_set_visible(group, false);
        s.ensure_static_batches(sc);
        assert!(s.static_batches(sc).is_empty(), "a hidden subtree must not keep drawing");
        assert!(kids.iter().all(|&k| !s.node_batched(k)));
        s.node_set_visible(group, true);
        s.ensure_static_batches(sc);
        assert_eq!(s.static_batches(sc).len(), 1, "and it comes back");
    }

    #[test]
    fn oversized_geometry_is_left_alone() {
        let mut s = Store::new();
        let sc = s.scene_create();
        let m = s.material_create(0xffffffff, 0);
        // 65 x 33 = 2145 verts: way past MAX_GEOM_VERTS, so copying it to save
        // one draw is a bad trade.
        let big = s.geom_sphere(1.0, 64);
        assert!(s.geom(big).unwrap().positions.len() > MAX_GEOM_VERTS);
        // 31 x 16 = 496 verts: under the cap, merges.
        let small = s.geom_sphere(1.0, 30);
        assert!(s.geom(small).unwrap().positions.len() <= MAX_GEOM_VERTS);
        let b1 = scenery(&mut s, sc, big, m, 0.0, 0.0, 0.0);
        let b2 = scenery(&mut s, sc, big, m, 3.0, 0.0, 0.0);
        let s1 = scenery(&mut s, sc, small, m, 6.0, 0.0, 0.0);
        let s2 = scenery(&mut s, sc, small, m, 9.0, 0.0, 0.0);
        s.freeze_nodes(&[b1, b2, s1, s2]);
        s.ensure_static_batches(sc);
        assert_eq!(s.static_batches(sc).len(), 1);
        assert!(!s.node_batched(b1) && !s.node_batched(b2));
        assert!(s.node_batched(s1) && s.node_batched(s2));
    }

    #[test]
    fn per_scene_vertex_ceiling_is_honoured() {
        let mut s = Store::new();
        let sc = s.scene_create();
        let m = s.material_create(0xffffffff, 0);
        let g = s.geom_sphere(1.0, 30); // 496 verts each
        let per = s.geom(g).unwrap().positions.len();
        let n = 80; // 39_680 verts per cell — one fits under 60k, two do not
        assert!(per * n <= MAX_BATCH_VERTS && per * n * 2 > MAX_BATCH_VERTS);
        let mut near = Vec::new();
        let mut far = Vec::new();
        for i in 0..n {
            near.push(scenery(&mut s, sc, g, m, i as f32 * 0.1, 0.0, 0.0));
            far.push(scenery(&mut s, sc, g, m, CELL * 1.5 + i as f32 * 0.1, 0.0, 0.0));
        }
        s.freeze_nodes(&near);
        s.freeze_nodes(&far);
        s.ensure_static_batches(sc);
        let batches = s.static_batches(sc);
        assert_eq!(batches.len(), 1, "the ceiling stops batching, it does not truncate a batch");
        let merged: usize = batches.iter().map(|b| s.geom(b.geom).unwrap().positions.len()).sum();
        assert!(merged <= MAX_BATCH_VERTS, "{merged} verts merged");
        // Deterministic: the surviving batch is the lower cell (sorted key
        // order), and the rejected nodes are simply still drawn per node.
        assert!(near.iter().all(|&id| s.node_batched(id)));
        assert!(far.iter().all(|&id| !s.node_batched(id)));
    }

    #[test]
    fn rebuilding_is_stable_and_frees_the_previous_generation() {
        let mut s = Store::new();
        let sc = s.scene_create();
        let g = s.geom_box(0.5, 0.5, 0.5);
        let m = s.material_create(0xffffffff, 0);
        let ids: Vec<i32> = (0..12)
            .map(|i| scenery(&mut s, sc, g, m, i as f32 * 4.0, 0.0, 0.0))
            .collect();
        s.freeze_nodes(&ids);
        s.ensure_static_batches(sc);
        let first: Vec<i32> = s.static_batches(sc).iter().map(|b| b.geom).collect();
        let geoms_after_first = s.geoms.len();
        assert!(first.len() >= 2, "12 posts over 44 units span several cells");

        // Idempotent: nothing changed, so nothing is rebuilt or allocated.
        s.ensure_static_batches(sc);
        s.ensure_static_batches(sc);
        let again: Vec<i32> = s.static_batches(sc).iter().map(|b| b.geom).collect();
        assert_eq!(first, again, "no change ⇒ the same geom ids, not new copies");
        assert_eq!(s.geoms.len(), geoms_after_first);

        // Forced rebuilds mint new ids (ids are never reused) but must not
        // grow the registry: the previous generation is freed.
        for round in 0..5 {
            s.node_set_visible(ids[0], round % 2 == 0);
            s.node_set_visible(ids[0], true);
            s.freeze_nodes(&ids); // already frozen: a no-op, not a rebuild
            s.ensure_static_batches(sc);
            assert_eq!(s.geoms.len(), geoms_after_first, "leaked a batch generation");
            assert_eq!(s.static_batches(sc).len(), first.len(), "same grouping every time");
        }
        let latest: Vec<i32> = s.static_batches(sc).iter().map(|b| b.geom).collect();
        assert!(latest.iter().all(|id| !first.contains(id)), "geom ids are never reused");
        assert!(first.iter().all(|id| s.geom(*id).is_none()), "old merged geoms are gone");

        // node_batched agrees with what the batches actually contain: every
        // batched node's geometry is inside some batch, tri counts add up.
        let batched: usize = ids.iter().filter(|&&id| s.node_batched(id)).count();
        let merged_tris: usize = s.static_batches(sc).iter().map(|b| tri_count(&s, b.geom)).sum();
        assert_eq!(merged_tris, batched * tri_count(&s, g));

        // Destroying the scene takes the merged geoms with it.
        s.scene_destroy(sc);
        assert!(s.static_batches(sc).is_empty());
        assert!(latest.iter().all(|id| s.geom(*id).is_none()));
    }

    #[test]
    fn a_rally_sized_fence_collapses_into_a_handful_of_draws() {
        // rally's barrier: ~270 posts + ~270 rails around a ~100-unit circuit.
        // This is the scene the 6-7x draw-count swing was measured on.
        let mut s = Store::new();
        let sc = s.scene_create();
        let post_g = s.geom_box(0.08, 0.5, 0.08);
        let rail_g = s.geom_box(0.1, 0.12, 1.2);
        let post_m = s.material_create(0xffcccccc, 0);
        let rail_m = s.material_create(0xff2222dd, 0);
        let mut ids = Vec::new();
        for i in 0..270 {
            let t = core::f32::consts::TAU * i as f32 / 270.0;
            let (st, ct) = (libm::sinf(t), libm::cosf(t));
            let (x, z) = (ct * 50.0, st * 50.0);
            ids.push(scenery(&mut s, sc, post_g, post_m, x, 0.5, z));
            ids.push(scenery(&mut s, sc, rail_g, rail_m, x, 0.9, z));
        }
        assert_eq!(ids.len(), 540);
        s.freeze_nodes(&ids);
        s.ensure_static_batches(sc);
        let batches = s.static_batches(sc);
        let unbatched = ids.iter().filter(|&&id| !s.node_batched(id)).count();
        let draws = batches.len() + unbatched;
        std::println!(
            "rally fence: 540 nodes -> {} batches + {} unbatched = {} draws",
            batches.len(),
            unbatched,
            draws
        );
        assert!(draws < 60, "540 scenery draws must collapse by ~an order of magnitude, got {draws}");
        // Still SPATIAL: no batch may span the whole circuit, or the frustum
        // test could never reject one (the terrain-heightfield trap).
        for b in batches {
            assert!(b.bound_radius < 40.0, "batch bound {} is map-sized", b.bound_radius);
        }
        // Every merged triangle is accounted for.
        let merged: usize = batches.iter().map(|b| tri_count(&s, b.geom)).sum();
        let per_node: usize = tri_count(&s, post_g);
        assert_eq!(merged, (540 - unbatched) * per_node);
    }
}
