#![cfg_attr(not(feature = "std"), no_std)]

//! pocket-scene3d — the `scene3d` surface on the native desktop base.
//!
//! The 3D sibling of pocket-ui-wgpu (RUNTIMES.md): it owns the retained
//! scene state built by the closed `s3.*` op vocabulary
//! (playset/scene3d/ops.ts — the normative contract; playset/scene3d/sim.ts
//! — the reference semantics), mounts the ops into a [`pocket_mod::Guest`]
//! as `globalThis.s3`, and renders any scene into a rect of any wgpu color
//! target — the backdrop layer under a PocketJS ui HUD (SCENE_QUAD
//! compositing, see examples/uihost).
//!
//! Built with `default-features = false` the crate is no_std+alloc and
//! exposes only [`Store`] — the PSP host (native/) mounts it over the
//! QuickJS C API and renders through its own sceGu backend.

extern crate alloc;

#[cfg(feature = "std")]
mod mount;
#[cfg(feature = "std")]
mod renderer;
mod store;

#[cfg(feature = "std")]
pub use mount::Scene3dSurface;
#[cfg(feature = "std")]
pub use renderer::{SceneRect, SceneRenderer};
pub use store::{
    BEAM_STRIDE, CameraState, CpuMesh, Env, Material, Node, Pool, PoolKind, POSE_STRIDE,
    SPRITE_STRIDE, Scene, Store, mat_flags,
};

#[cfg(test)]
mod tests {
    use super::store::*;
    use glam::{Quat, Vec3};

    #[test]
    fn id_lifecycle_never_reuses() {
        let mut s = Store::new();
        let sc = s.scene_create();
        assert_eq!(sc, 1);
        let n1 = s.node_create(sc, 0);
        let n2 = s.node_create(sc, 0);
        assert_eq!((n1, n2), (1, 2));
        s.node_destroy(n1);
        let n3 = s.node_create(sc, 0);
        assert_eq!(n3, 3, "destroyed ids are never reused");
        // Dead-handle ops are silent no-ops.
        s.node_set_visible(n1, false);
        s.node_set_pose(n1, 1.0, 2.0, 3.0, 0.0, 0.0, 0.0, 1.0);
        // Creation under a dead parent mints no orphan.
        assert_eq!(s.node_create(sc, n1), 0);
        // Creation under a dead scene returns 0.
        s.scene_destroy(sc);
        assert_eq!(s.node_create(sc, 0), 0);
        let sc2 = s.scene_create();
        assert_eq!(sc2, 2, "scene ids are monotonic too");
    }

    #[test]
    fn destroy_reaps_whole_subtree() {
        let mut s = Store::new();
        let sc = s.scene_create();
        let a = s.node_create(sc, 0);
        let b = s.node_create(sc, a);
        let c = s.node_create(sc, b);
        let d = s.node_create(sc, 0);
        s.node_destroy(a);
        assert!(s.node(a).is_none());
        assert!(s.node(b).is_none());
        assert!(s.node(c).is_none());
        assert!(s.node(d).is_some());
        assert_eq!(s.scene(sc).unwrap().root, vec![d]);
    }

    #[test]
    fn reparent_guards_cycles_and_cross_scene() {
        let mut s = Store::new();
        let sc = s.scene_create();
        let sc2 = s.scene_create();
        let a = s.node_create(sc, 0);
        let b = s.node_create(sc, a);
        let foreign = s.node_create(sc2, 0);
        // Under self / descendant: silent no-op.
        s.node_set_parent(a, a);
        s.node_set_parent(a, b);
        assert_eq!(s.node(a).unwrap().parent, 0);
        // Cross-scene: silent no-op.
        s.node_set_parent(b, foreign);
        assert_eq!(s.node(b).unwrap().parent, a);
        // Legit adoption keeps the LOCAL pose and moves the link.
        let c = s.node_create(sc, 0);
        s.node_set_parent(c, a);
        assert_eq!(s.node(c).unwrap().parent, a);
        assert_eq!(s.node(a).unwrap().children, vec![b, c]);
        assert_eq!(s.scene(sc).unwrap().root, vec![a]);
    }

    #[test]
    fn pose_batch_applies_and_skips_unknown_ids() {
        let mut s = Store::new();
        let sc = s.scene_create();
        let a = s.node_create(sc, 0);
        let b = s.node_create(sc, 0);
        s.node_destroy(b);
        let mut buf = vec![0.0f32; 3 * POSE_STRIDE];
        // Entry 0: node a (id rides as f32, with rounding slop).
        buf[0] = a as f32 + 0.0000001;
        buf[1..11].copy_from_slice(&[1.0, 2.0, 3.0, 0.0, 0.0, 0.0, 1.0, 2.0, 2.0, 2.0]);
        // Entry 1: dead node b — skipped, no throw.
        buf[POSE_STRIDE] = b as f32;
        buf[POSE_STRIDE + 1] = 9.0;
        // Entry 2: exists in the buffer but count = 2 keeps it unread.
        buf[2 * POSE_STRIDE] = a as f32;
        buf[2 * POSE_STRIDE + 1] = 77.0;
        s.write_poses(&buf, 2);
        let n = s.node(a).unwrap();
        assert_eq!(n.p, Vec3::new(1.0, 2.0, 3.0));
        assert_eq!(n.s, Vec3::new(2.0, 2.0, 2.0));
        // count beyond the buffer is clamped.
        s.write_poses(&buf[..POSE_STRIDE], 5);
        assert_eq!(s.node(a).unwrap().p, Vec3::new(1.0, 2.0, 3.0));
    }

    #[test]
    fn pool_replace_clamps_and_counts_drops() {
        let mut s = Store::new();
        let sc = s.scene_create();
        let m = s.material_create(0xffff_ffff, mat_flags::ADDITIVE | mat_flags::UNLIT);
        let p = s.pool_create(sc, 2.0, m, PoolKind::Sprite);
        assert_eq!(p, 1);
        let buf: Vec<f32> = (0..4 * SPRITE_STRIDE).map(|i| i as f32).collect();
        let colors = vec![0x11u32, 0x22, 0x33, 0x44];
        s.pool_write(p, PoolKind::Sprite, &buf, &colors, 4.0);
        let pool = s.pool(p).unwrap();
        assert_eq!(pool.count, 2, "count > capacity clamps");
        assert_eq!(pool.dropped_writes, 2);
        assert_eq!(pool.colors, vec![0x11, 0x22]);
        // Replace, not append.
        s.pool_write(p, PoolKind::Sprite, &buf, &colors, 1.0);
        let pool = s.pool(p).unwrap();
        assert_eq!(pool.count, 1);
        assert_eq!(pool.dropped_writes, 2, "an in-capacity write drops nothing");
        // Kind mismatch and dead handles are silent.
        s.pool_write(p, PoolKind::Beam, &buf, &colors, 1.0);
        assert_eq!(s.pool(p).unwrap().count, 1);
        s.pool_free(p);
        s.pool_write(p, PoolKind::Sprite, &buf, &colors, 1.0);
        assert!(s.pool(p).is_none());
        // Dead scene: pool creation returns 0.
        assert_eq!(s.pool_create(999, 4.0, m, PoolKind::Beam), 0);
    }

    #[test]
    fn fog_disables_when_far_not_beyond_near() {
        let mut s = Store::new();
        let sc = s.scene_create();
        s.fog(sc, 0xff00ff00, 10.0, 100.0);
        assert!(s.scene(sc).unwrap().env.fog.is_some());
        s.fog(sc, 0xff00ff00, 100.0, 100.0);
        assert!(s.scene(sc).unwrap().env.fog.is_none(), "far <= near disables");
        s.fog(sc, 0xff00ff00, 100.0, 50.0);
        assert!(s.scene(sc).unwrap().env.fog.is_none());
    }

    #[test]
    fn mesh_set_clears_material_with_geom_zero() {
        let mut s = Store::new();
        let sc = s.scene_create();
        let n = s.node_create(sc, 0);
        let g = s.geom_box(1.0, 1.0, 1.0);
        let m = s.material_create(0xff0000ff, 0);
        s.mesh_set(n, g, m);
        assert_eq!((s.node(n).unwrap().geom, s.node(n).unwrap().mat), (g, m));
        s.mesh_set(n, 0, m);
        assert_eq!((s.node(n).unwrap().geom, s.node(n).unwrap().mat), (0, 0));
    }

    #[test]
    fn heightfield_tessellation_counts_and_flat_normals_point_up() {
        let mut s = Store::new();
        let heights = vec![0.0f32; 4 * 3]; // cols=4, rows=3
        let g = s.geom_heightfield(30.0, 20.0, 4, 3, &heights, None);
        let mesh = s.geom(g).unwrap();
        assert_eq!(mesh.positions.len(), 12);
        assert_eq!(mesh.indices.len(), 3 * 2 * 6);
        for n in &mesh.normals {
            assert!((n[1] - 1.0).abs() < 1e-6, "flat field normal is +Y, got {n:?}");
        }
        // Grid spans w x d centered; rows advance along -Z (playset forward).
        assert_eq!(mesh.positions[0], [-15.0, 0.0, 10.0]);
        assert_eq!(mesh.positions[11], [15.0, 0.0, -10.0]);
        // Degenerate grids draw nothing rather than panicking.
        let g2 = s.geom_heightfield(10.0, 10.0, 1, 3, &heights, None);
        assert!(s.geom(g2).unwrap().indices.is_empty());
    }

    #[test]
    fn heightfield_slope_normals_are_sane() {
        let mut s = Store::new();
        // Height rises with +col (i.e. +X): normals must lean -X, stay +Y.
        let mut heights = vec![0.0f32; 3 * 3];
        for row in 0..3 {
            for col in 0..3 {
                heights[row * 3 + col] = col as f32;
            }
        }
        let g = s.geom_heightfield(2.0, 2.0, 3, 3, &heights, None);
        let mesh = s.geom(g).unwrap();
        for n in &mesh.normals {
            assert!(n[0] < 0.0 && n[1] > 0.0, "uphill +X ⇒ normal leans -X: {n:?}");
        }
    }

    #[test]
    fn world_transform_propagates_parent_rotation() {
        let mut s = Store::new();
        let sc = s.scene_create();
        let parent = s.node_create(sc, 0);
        let child = s.node_create(sc, parent);
        // Parent: +90 deg about Y at (10, 0, 0); child at local (0, 0, -1).
        let q = Quat::from_rotation_y(std::f32::consts::FRAC_PI_2);
        s.node_set_pose(parent, 10.0, 0.0, 0.0, q.x, q.y, q.z, q.w);
        s.node_set_pose(child, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 1.0);
        let world = s.world_transform(child).unwrap();
        let p = world.transform_point3(Vec3::ZERO);
        // Local -Z rotated +90 deg about Y lands on -X.
        assert!((p - Vec3::new(9.0, 0.0, 0.0)).length() < 1e-5, "got {p}");
    }

    #[test]
    fn scene_destroy_unbinds_viewports_and_emits_events() {
        let mut s = Store::new();
        let sc = s.scene_create();
        s.bind_viewport(7, sc);
        s.bind_viewport(9, 12345); // dead scene: silent no-op
        assert_eq!(s.drain_binding_events(), vec![(7, sc)]);
        assert_eq!(s.bindings(), vec![(7, sc)]);
        s.scene_destroy(sc);
        assert_eq!(s.drain_binding_events(), vec![(7, 0)]);
        assert!(s.bindings().is_empty());
        // Unbinding an unbound node emits nothing.
        s.bind_viewport(7, 0);
        assert!(s.drain_binding_events().is_empty());
    }

    #[test]
    fn primitive_tessellations_are_well_formed() {
        let mut s = Store::new();
        let checks = [
            s.geom_box(1.0, 2.0, 3.0),
            s.geom_sphere(1.0, 12),
            s.geom_cylinder(0.35, 0.35, 0.32, 16),
            s.geom_cone(0.5, 1.0, 8),
            s.geom_plane(4.0, 4.0),
            s.geom_torus(2.0, 0.5, 16, 8),
        ];
        for id in checks {
            let m = s.geom(id).unwrap();
            assert!(!m.indices.is_empty());
            assert_eq!(m.positions.len(), m.normals.len());
            assert!(m.indices.iter().all(|&i| (i as usize) < m.positions.len()));
            for n in &m.normals {
                let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
                assert!((l - 1.0).abs() < 1e-4, "unit normals, got len {l}");
            }
        }
        // Sun normalizes; zero-length direction stays zero.
        let sc = s.scene_create();
        s.sun(sc, 0.0, -2.0, 0.0, 0xffffffff);
        let (dir, _) = s.scene(sc).unwrap().env.sun.unwrap();
        assert_eq!(dir, Vec3::new(0.0, -1.0, 0.0));
    }
}
