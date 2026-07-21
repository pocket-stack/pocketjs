//! Static geometry batching: many frozen nodes that share geometry, material
//! and tint become ONE pre-transformed draw per spatial cell.
//!
//! WHY (measured, real PSP): rally's barrier fence is ~270 posts plus ~270
//! rails, each a separate `sceGuDrawArray` with its own matrix and material
//! state. Once frustum culling landed, the frame became GE-bound, and the
//! submitted draw count swings 6-7x with camera direction alone — 72 draws
//! parked facing open ground, 380-470 looking down the circuit. That swing is
//! exactly what a player feels as "it stutters when I chase the other car":
//! chasing means pointing the camera down the longest run of fence.
//!
//! WHY IT LIVES HERE, not in a game: a port of a Three.js scene should not have
//! to know this exists. The information the renderer needs is one bit per node
//! — "nothing will move this again" — and the ported environment factories can
//! declare that about their own scenery, so every game built on them inherits
//! the batching without writing a line for it.
//!
//! SPATIAL, NOT GLOBAL. Merging all 270 posts into one buffer would produce a
//! draw whose bounds span the whole map, which no frustum test can ever reject
//! — the same trap the terrain heightfield fell into. Batches are therefore
//! keyed by cell as well as by material, so a merged draw stays rejectable.
//!
//! THE PROMISE. `freeze` is a contract: a frozen node's world transform is
//! baked into vertices, so moving it afterwards changes nothing on screen. The
//! weaker `markStatic` (the guest-side flush skip) deliberately does NOT imply
//! this — a sim-driven car stops being diffed by the guest but is still moved
//! every frame by the host.

use alloc::vec::Vec;
use glam::{Mat4, Vec3};

/// Cell edge for the spatial key, in world units.
///
/// rally's circuit is ~100 units across with fence posts every 2.5, so 24
/// gives roughly 5x5 occupied cells and ~30 posts per cell: draw calls fall by
/// about an order of magnitude while a cell is still small enough that looking
/// along one edge of the track rejects most of them.
pub const CELL: f32 = 24.0;

/// Geometry above this vertex count is left alone. Merging copies vertices, so
/// batching a big mesh trades a lot of memory for one saved draw call; big
/// meshes are also the ones already worth culling individually.
pub const MAX_GEOM_VERTS: usize = 512;

/// Ceiling on merged vertices per scene. PSP memory is an 8 MB budget shared
/// with everything else; past this the remaining nodes simply stay unbatched
/// (correct, just not as fast) rather than the batcher eating the arena.
pub const MAX_BATCH_VERTS: usize = 60_000;

/// One merged static draw.
///
/// `geom` is a REGULAR geom id in the store, so each host bakes or uploads it
/// through the same path it already uses for any other mesh. The vertices are
/// in world space: draw it with an identity model matrix.
#[derive(Clone, Copy, Debug)]
pub struct StaticBatch {
    pub geom: i32,
    pub mat: i32,
    pub tint: u32,
    /// World-space bounding sphere, for the renderers' existing frustum test.
    pub bound_center: Vec3,
    pub bound_radius: f32,
}

/// Group key: same draw state AND same neighbourhood.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct BatchKey {
    pub geom: i32,
    pub mat: i32,
    pub tint: u32,
    pub cell_x: i32,
    pub cell_y: i32,
    pub cell_z: i32,
}

impl BatchKey {
    pub fn new(geom: i32, mat: i32, tint: u32, world_pos: Vec3) -> Self {
        Self {
            geom,
            mat,
            tint,
            cell_x: cell_of(world_pos.x),
            cell_y: cell_of(world_pos.y),
            cell_z: cell_of(world_pos.z),
        }
    }
}

#[inline]
fn cell_of(v: f32) -> i32 {
    // floor division without std's f32::floor (this crate builds no_std).
    let q = v / CELL;
    let f = libm::floorf(q);
    f as i32
}

/// Transform a mesh's vertices into world space and append them to `out`.
///
/// Normals are rotated by the transform's linear part and renormalized, which
/// is exact for the rotation + uniform scale that scenery uses; a non-uniformly
/// scaled frozen node would get slightly wrong shading, and that is a
/// documented limitation rather than a silent one.
#[allow(clippy::too_many_arguments)] // four out-streams in, four mesh streams out
pub fn append_transformed(
    out_positions: &mut Vec<[f32; 3]>,
    out_normals: &mut Vec<[f32; 3]>,
    out_colors: &mut Vec<[f32; 3]>,
    out_indices: &mut Vec<u32>,
    world: Mat4,
    positions: &[[f32; 3]],
    normals: &[[f32; 3]],
    colors: Option<&[[f32; 3]]>,
    indices: &[u32],
) {
    let base = out_positions.len() as u32;
    for (i, p) in positions.iter().enumerate() {
        let wp = world.transform_point3(Vec3::from_array(*p));
        out_positions.push(wp.to_array());

        let n = normals.get(i).copied().unwrap_or([0.0, 1.0, 0.0]);
        let wn = world.transform_vector3(Vec3::from_array(n));
        let len_sq = wn.length_squared();
        let wn = if len_sq > 0.0 {
            wn / libm::sqrtf(len_sq)
        } else {
            Vec3::Y
        };
        out_normals.push(wn.to_array());

        // A merged mesh has one vertex stream, so a batch member without
        // per-vertex colour contributes white rather than dropping the channel
        // for everyone else.
        out_colors.push(colors.and_then(|c| c.get(i).copied()).unwrap_or([1.0, 1.0, 1.0]));
    }
    for idx in indices {
        out_indices.push(base + idx);
    }
}

/// Bounding sphere of a world-space vertex set: AABB midpoint, then the
/// farthest vertex from it. Same construction the renderers' per-geom bound
/// uses, so the frustum test behaves identically for batches and single nodes.
pub fn bounds_of(positions: &[[f32; 3]]) -> (Vec3, f32) {
    if positions.is_empty() {
        return (Vec3::ZERO, 0.0);
    }
    let mut lo = Vec3::from_array(positions[0]);
    let mut hi = lo;
    for p in positions {
        let v = Vec3::from_array(*p);
        lo = lo.min(v);
        hi = hi.max(v);
    }
    let center = (lo + hi) * 0.5;
    let mut r2 = 0.0f32;
    for p in positions {
        let d = Vec3::from_array(*p) - center;
        let d2 = d.length_squared();
        if d2 > r2 {
            r2 = d2;
        }
    }
    (center, libm::sqrtf(r2))
}
