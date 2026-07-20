//! The deterministic collision core, ported from
//! `playset/modules/physics/collision-world.ts`.
//!
//! ATTRIBUTION: unlike most of this crate, the TS source has no GameBlocks
//! counterpart — it is playset-native, written to replace the injected Rapier
//! `world` the ported environments and batch resolvers expect. So this file
//! ports playset, not GameBlocks, and the TS module stays the reference
//! implementation (the graceful-absence path a host without `ps` runs).
//!
//! SCOPE is the TS scope, deliberately v1: static cuboid / y-cylinder / ball
//! colliders, a terrain heightfield as the ground authority, planar capsule
//! push-out with wall sliding and ground snapping, and raycasts for aiming.
//! Dynamic bodies, wedge trimeshes and stacked-shape climbing are not here
//! because they are not there.
//!
//! DETERMINISM is load-bearing and it is structural: colliders resolve in
//! insertion (handle) order, there is no wall clock and no RNG, and the
//! broadphase below is a pure iteration filter — it only ever skips shapes
//! that provably cannot interact, so a gathered pass equals a full scan.
//!
//! DEVIATIONS from the TS, all deliberate:
//!
//!   * f32, not f64 (the crate-wide precision contract in [`crate::math`]).
//!     The TS `EPS = 1e-9` is below f32's relative precision at world scale,
//!     so every tolerance uses the crate's planar [`EPS`] (1e-6) instead. The
//!     affected comparisons are all degenerate-case guards (zero-length
//!     separation, ray parallel to a slab, exact surface contact); at 1e-6
//!     world units — micrometres — they pick the same branch as the TS for
//!     any input a game produces.
//!   * The terrain is passed in per call rather than owned, because the
//!     [`World`](crate::World) owns both and Rust would rather not have two
//!     owners. `Terrain::None` means "no terrain sampler" — same as the TS
//!     `terrain === null`, so raycasts skip the terrain march entirely there
//!     instead of hitting an implied plane at height 0.
//!   * `add_cuboid` takes a yaw directly instead of a quaternion. The TS
//!     `quatToPlanarYaw` drops any tilt anyway (v1 is yaw-only), and the
//!     batched `collidersAdd` payload already carries yaw (see
//!     [`COLLIDER_STRIDE`](crate::COLLIDER_STRIDE)) — so the conversion lives
//!     on the guest side of the boundary, where the quaternion already is.
//!   * `remove()` is not ported: the mount only ever appends a batch and
//!     [`clear`](CollisionWorld::clear)s. Adding it back means also fixing up
//!     the grid cells, which is why it is not speculative work.
//!   * `tag` is not ported. Handles are the identity; the guest owns the
//!     handle → entity map (it cannot hold a native pointer anyway).
//!
//! ALLOCATION: `add_*` allocates (grid cells); the per-step queries do not.
//! `resolve_capsule` / `ground_height_at` take `&mut self` precisely so the
//! gathered candidate list can live in a scratch buffer that reaches its
//! steady-state capacity in the first few frames and then never grows again.
//! (`sort_unstable` is in-place pdqsort — the stable `sort` would allocate.)

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use glam::Vec3;

use crate::math::{clamp, fmath, forward_of, from_basis, right_of, up_of, EPS};
use crate::terrain::Terrain;

/// Capsule mover parameters (the TS `CapsuleOptions`, with the optionals
/// resolved: the caller passes what the TS `??` defaults would have picked —
/// see [`CapsuleOpts::DEFAULT_CLIMB`] / [`CapsuleOpts::DEFAULT_SNAP`]).
#[derive(Clone, Copy, Debug)]
pub struct CapsuleOpts {
    pub radius: f32,
    /// Capsule half height (feet sit at `position - half_height` along up).
    pub half_height: f32,
    /// Max ground rise the mover steps onto instead of being blocked.
    pub climb: f32,
    /// Snap-down distance when airborne-but-near-ground (0 disables).
    pub snap: f32,
}

impl CapsuleOpts {
    /// The TS `opts.climb ?? 0.55`.
    pub const DEFAULT_CLIMB: f32 = 0.55;
    /// The TS `opts.snap ?? 0.3`.
    pub const DEFAULT_SNAP: f32 = 0.3;
}

#[derive(Clone, Copy, Debug)]
pub struct CapsuleResult {
    pub position: Vec3,
    pub grounded: bool,
    /// True when a solid collider clipped the planar motion this resolve.
    pub hit_wall: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RaycastHit {
    pub distance: f32,
    pub point: Vec3,
    /// The collider that was hit, or 0 for the terrain (which has no handle).
    pub handle: u32,
}

// ---------------------------------------------------------------------------
// Broadphase
// ---------------------------------------------------------------------------
//
// A uniform planar grid over (right, forward). Shapes register in every cell
// their circumscribed circle touches; a query gathers the cells under the
// point plus the world's largest shape reach, dedupes with a visit stamp, and
// sorts by handle so resolution keeps the exact full-scan insertion order.
//
// The map is a BTreeMap: no_std has no HashMap, and ordered iteration is one
// less thing that can quietly become nondeterministic.

const GRID_CELL: f32 = 8.0;
/// Cell indices are biased into `0..=65535` so the key packs into a u64 the
/// same way the TS packs into a f64 (`(cr + OFF) * 65536 + (cf + OFF)`).
const GRID_OFF: i32 = 32768;

/// Cells per axis a gather may walk before it gives up and scans everything.
/// This is a loop bound, not a heuristic: a world with an enormous shape (or
/// enormous coordinates) would otherwise walk billions of empty cells. The
/// full scan is the reference behaviour, so falling back to it cannot change
/// a result — a superset of candidates is always safe, since every consumer
/// re-tests each candidate exactly.
const MAX_SPAN: i64 = 64;

/// A shape spanning more than this many cells per axis is left out of the
/// grid entirely and only ever reached through the full-scan fallback. That
/// is sound because such a shape raises `max_reach` above its own reach, and
/// a gather's span is at least the shape's span minus one cell — so every
/// gather in a world containing it exceeds [`MAX_SPAN`] and full-scans.
const MAX_INSERT_SPAN: i64 = MAX_SPAN + 2;

#[inline]
fn cell_of(v: f32) -> i32 {
    let c = fmath::floor(v / GRID_CELL);
    // `as i32` saturates and maps NaN to 0, so garbage coordinates are inert
    // rather than UB. Clamping is monotone, so it can only merge cells (false
    // positives), never separate a query from a shape it overlaps.
    let lo = -(GRID_OFF as f32);
    let hi = (GRID_OFF - 1) as f32;
    let c = if c < lo {
        lo
    } else if c > hi {
        hi
    } else {
        c
    };
    c as i32
}

#[inline]
fn cell_key(cr: i32, cf: i32) -> u64 {
    (((cr + GRID_OFF) as u64) << 16) | ((cf + GRID_OFF) as u64)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Cuboid,
    Cylinder,
    Ball,
}

/// One static collider, cached in basis space (right/up/forward components)
/// exactly like the TS `Shape` — the whole core works in basis scalars and
/// only re-assembles a `Vec3` when it hands a result back.
#[derive(Clone, Copy)]
struct Shape {
    handle: u32,
    kind: Kind,
    solid: bool,
    walkable: bool,
    right: f32,
    up: f32,
    forward: f32,
    // cuboid
    h_right: f32,
    h_up: f32,
    h_forward: f32,
    /// Planar rotation about up, pre-resolved into its sin/cos. The TS calls
    /// `Math.cos(-s.yaw)` on every push-out and every ray; caching is the same
    /// number computed once, and on the PSP a `sinf` is not free.
    yaw_sin: f32,
    yaw_cos: f32,
    // cylinder / ball
    radius: f32,
    half_height: f32,
    /// Circumscribed planar radius (yaw-independent broadphase bound).
    reach: f32,
}

impl Shape {
    /// Half of the shape's vertical extent — the one place cuboids and
    /// round shapes read a different field.
    #[inline]
    fn half_up(&self) -> f32 {
        if matches!(self.kind, Kind::Cuboid) {
            self.h_up
        } else {
            self.half_height
        }
    }

    /// The TS `planarInside`: is the planar point within the shape's
    /// footprint, inflated by `inflate`?
    #[inline]
    fn planar_inside(&self, right: f32, forward: f32, inflate: f32) -> bool {
        if matches!(self.kind, Kind::Cuboid) {
            let (lr, lf) = self.to_local(right, forward);
            return fmath::abs(lr) <= self.h_right + inflate
                && fmath::abs(lf) <= self.h_forward + inflate;
        }
        let dr = right - self.right;
        let df = forward - self.forward;
        let rad = self.radius + inflate;
        dr * dr + df * df <= rad * rad
    }

    /// World planar point → box-local planar point (the TS `toBoxLocal`).
    /// `+yaw` turns forward toward `-right` (right-hand rule about up), so
    /// this is the rotation by `-yaw`.
    #[inline]
    fn to_local(&self, right: f32, forward: f32) -> (f32, f32) {
        let dr = right - self.right;
        let df = forward - self.forward;
        let (c, sn) = (self.yaw_cos, -self.yaw_sin);
        (c * dr + sn * df, -sn * dr + c * df)
    }

    /// Box-local planar point → world (the TS `fromBoxLocal`).
    #[inline]
    fn from_local(&self, lr: f32, lf: f32) -> (f32, f32) {
        let (c, sn) = (self.yaw_cos, self.yaw_sin);
        (
            self.right + c * lr + sn * lf,
            self.forward - sn * lr + c * lf,
        )
    }
}

pub struct CollisionWorld {
    shapes: Vec<Shape>,
    /// Last gather that visited `shapes[i]` — O(1) dedupe with no allocation.
    /// Kept parallel to `shapes` instead of inside `Shape` so a gather can
    /// stamp while the shapes themselves stay immutably borrowable.
    stamps: Vec<u32>,
    grid: BTreeMap<u64, Vec<u32>>,
    next_handle: u32,
    max_reach: f32,
    gather_stamp: u32,
    /// Indices into `shapes`, in ascending (= handle = insertion) order.
    /// Reused across gathers, never exposed.
    candidates: Vec<u32>,
    /// Escape hatch for the parity tests: makes every gather return every
    /// shape, i.e. the full-scan reference the broadphase must equal.
    pub(crate) full_scan: bool,
}

impl Default for CollisionWorld {
    fn default() -> Self {
        Self::new()
    }
}

impl CollisionWorld {
    pub fn new() -> Self {
        Self {
            shapes: Vec::new(),
            stamps: Vec::new(),
            grid: BTreeMap::new(),
            next_handle: 1,
            max_reach: 0.0,
            gather_stamp: 0,
            candidates: Vec::new(),
            full_scan: false,
        }
    }

    // -- assembly ------------------------------------------------------------

    /// Yaw-only box. `yaw` is what the TS derives from `desc.quaternion` via
    /// `quatToPlanarYaw` (tilt dropped); pass 0 for an axis-aligned box.
    pub fn add_cuboid(
        &mut self,
        position: Vec3,
        half_extents: Vec3,
        yaw: f32,
        solid: bool,
        walkable: bool,
    ) -> u32 {
        let mut s = self.base_shape(Kind::Cuboid, position, solid, walkable);
        s.h_right = fmath::abs(right_of(half_extents));
        s.h_up = fmath::abs(up_of(half_extents));
        s.h_forward = fmath::abs(forward_of(half_extents));
        s.yaw_sin = fmath::sin(yaw);
        s.yaw_cos = fmath::cos(yaw);
        s.reach = fmath::sqrt(s.h_right * s.h_right + s.h_forward * s.h_forward);
        self.insert(s)
    }

    pub fn add_cylinder(
        &mut self,
        position: Vec3,
        radius: f32,
        half_height: f32,
        solid: bool,
        walkable: bool,
    ) -> u32 {
        let mut s = self.base_shape(Kind::Cylinder, position, solid, walkable);
        s.radius = radius;
        s.half_height = half_height;
        s.reach = radius;
        self.insert(s)
    }

    pub fn add_ball(&mut self, position: Vec3, radius: f32, solid: bool, walkable: bool) -> u32 {
        let mut s = self.base_shape(Kind::Ball, position, solid, walkable);
        s.radius = radius;
        // A ball's vertical half extent is its radius (TS sets halfHeight too).
        s.half_height = radius;
        s.reach = radius;
        self.insert(s)
    }

    /// Drop every collider. Handles are NOT recycled — like the TS, the
    /// counter keeps climbing, so a handle a guest is still holding can never
    /// silently start naming a different shape.
    pub fn clear(&mut self) {
        self.shapes.clear();
        self.stamps.clear();
        self.grid.clear();
        self.max_reach = 0.0;
    }

    pub fn collider_count(&self) -> usize {
        self.shapes.len()
    }

    fn base_shape(&mut self, kind: Kind, position: Vec3, solid: bool, walkable: bool) -> Shape {
        let handle = self.next_handle;
        self.next_handle += 1;
        Shape {
            handle,
            kind,
            solid,
            walkable,
            right: right_of(position),
            up: up_of(position),
            forward: forward_of(position),
            h_right: 0.0,
            h_up: 0.0,
            h_forward: 0.0,
            yaw_sin: 0.0,
            yaw_cos: 1.0,
            radius: 0.0,
            half_height: 0.0,
            reach: 0.0,
        }
    }

    fn insert(&mut self, s: Shape) -> u32 {
        let index = self.shapes.len() as u32;
        self.shapes.push(s);
        self.stamps.push(0);
        if s.reach > self.max_reach {
            self.max_reach = s.reach;
        }

        let c0r = cell_of(s.right - s.reach);
        let c1r = cell_of(s.right + s.reach);
        let c0f = cell_of(s.forward - s.reach);
        let c1f = cell_of(s.forward + s.reach);
        // Oversized shapes stay out of the grid; see MAX_INSERT_SPAN.
        if (c1r - c0r) as i64 + 1 > MAX_INSERT_SPAN || (c1f - c0f) as i64 + 1 > MAX_INSERT_SPAN {
            return s.handle;
        }
        for cr in c0r..=c1r {
            for cf in c0f..=c1f {
                self.grid.entry(cell_key(cr, cf)).or_default().push(index);
            }
        }
        s.handle
    }

    // -- broadphase ------------------------------------------------------------

    /// Fill `self.candidates` with the shapes whose circumscribed circle could
    /// reach within `radius` of the planar point, in insertion (handle) order.
    ///
    /// Conservative by construction: a shape excluded here is further than
    /// `radius + max_reach` away and therefore further than `radius + its own
    /// reach`, so it provably cannot touch the query. Every consumer re-tests
    /// its candidates exactly, which is why the fallbacks below (which return
    /// a superset) are free to be as blunt as they like.
    fn gather(&mut self, right: f32, forward: f32, radius: f32) {
        self.candidates.clear();
        if self.shapes.is_empty() {
            return;
        }
        let reach = radius + self.max_reach;
        let c0r = cell_of(right - reach);
        let c1r = cell_of(right + reach);
        let c0f = cell_of(forward - reach);
        let c1f = cell_of(forward + reach);
        if self.full_scan
            || (c1r - c0r) as i64 + 1 > MAX_SPAN
            || (c1f - c0f) as i64 + 1 > MAX_SPAN
        {
            // Already in handle order — no sort needed.
            self.candidates.extend(0..self.shapes.len() as u32);
            return;
        }

        // u32 stamps wrap where the TS f64 counter never would; rolling over
        // to 0 would alias with a never-visited shape, so reset on the wrap.
        self.gather_stamp = self.gather_stamp.wrapping_add(1);
        if self.gather_stamp == 0 {
            for stamp in self.stamps.iter_mut() {
                *stamp = 0;
            }
            self.gather_stamp = 1;
        }
        let stamp = self.gather_stamp;

        for cr in c0r..=c1r {
            for cf in c0f..=c1f {
                let Some(cell) = self.grid.get(&cell_key(cr, cf)) else {
                    continue;
                };
                for &index in cell.iter() {
                    let slot = &mut self.stamps[index as usize];
                    if *slot == stamp {
                        continue;
                    }
                    *slot = stamp;
                    self.candidates.push(index);
                }
            }
        }
        // Insertion order IS the resolution semantics; cell walk order is not.
        self.candidates.sort_unstable();
    }

    // -- queries ---------------------------------------------------------------

    /// Ground authority: terrain height plus any walkable top underfoot.
    ///
    /// The batch resolvers call this five times per actor per step (position
    /// plus four finite-difference probes for the surface normal), so it is
    /// the hottest query in the crate.
    pub fn ground_height_at(&mut self, terrain: &Terrain, right: f32, forward: f32) -> f32 {
        let mut h = terrain.height_at(right, forward);
        self.gather(right, forward, EPS);
        for k in 0..self.candidates.len() {
            let s = self.shapes[self.candidates[k] as usize];
            if !s.walkable {
                continue;
            }
            if !s.planar_inside(right, forward, 0.0) {
                continue;
            }
            let top = s.up + s.half_up();
            if top > h {
                h = top;
            }
        }
        h
    }

    /// Move a capsule toward `desired`: solid shapes push the planar motion
    /// out (slide, insertion order), then the mover grounds on
    /// [`ground_height_at`](Self::ground_height_at) with `climb` step-up and
    /// `snap` snap-down semantics.
    ///
    /// `current` is unread — exactly as in the TS. Resolution is positional,
    /// not swept: the desired position carries the motion, and push-out only
    /// ever asks "where is the capsule now, and what is it inside of". The
    /// parameter stays in the signature because the callers (and the TS
    /// resolvers they are ported from) pass it, and a swept v2 will want it.
    pub fn resolve_capsule(
        &mut self,
        terrain: &Terrain,
        current: Vec3,
        desired: Vec3,
        opts: CapsuleOpts,
    ) -> CapsuleResult {
        let _ = current;
        let radius = opts.radius;
        let feet_offset = opts.half_height;

        let mut right = right_of(desired);
        let mut forward = forward_of(desired);
        let mut up = up_of(desired);
        let mut hit_wall = false;

        // Planar push-out vs solids whose vertical span overlaps the capsule.
        // Gathered once up front around the desired position: the 2x margins
        // cover push-out chains relocating the capsule mid-loop. (The scratch
        // is free again by the time the ground pass below re-gathers.)
        //
        // `up` is untouched by this pass, so the capsule's vertical span is
        // loop-invariant and hoisted out of it.
        let feet = up - feet_offset;
        let head = up + feet_offset;
        self.gather(right, forward, radius * 2.0 + self.max_reach + 1.0);
        for k in 0..self.candidates.len() {
            let s = self.shapes[self.candidates[k] as usize];
            if !s.solid {
                continue;
            }
            let half_up = s.half_up();
            let s_bottom = s.up - half_up;
            let s_top = s.up + half_up;
            if head <= s_bottom + EPS || feet >= s_top - EPS {
                continue;
            }
            // Walkable shapes we can step onto don't wall us when the rise fits.
            if s.walkable && s_top - feet <= opts.climb {
                continue;
            }

            if matches!(s.kind, Kind::Cuboid) {
                if let Some((pr, pf)) = push_out_of_box(&s, right, forward, radius) {
                    right = pr;
                    forward = pf;
                    hit_wall = true;
                }
            } else {
                let dr = right - s.right;
                let df = forward - s.forward;
                let min_dist = s.radius + radius;
                let dist_sq = dr * dr + df * df;
                if dist_sq < min_dist * min_dist {
                    let dist = fmath::sqrt(dist_sq);
                    // Dead-centre overlap has no separation direction; the TS
                    // picks +right, and picking the same thing keeps the two
                    // paths from diverging on a degenerate spawn.
                    let (nr, nf) = if dist > EPS {
                        (dr / dist, df / dist)
                    } else {
                        (1.0, 0.0)
                    };
                    right = s.right + nr * min_dist;
                    forward = s.forward + nf * min_dist;
                    hit_wall = true;
                }
            }
        }

        // Ground pass.
        let ground = self.ground_height_at(terrain, right, forward);
        let feet = up - feet_offset;
        let mut grounded = false;
        if feet <= ground + EPS {
            up = ground + feet_offset;
            grounded = true;
        } else if opts.snap > 0.0 && feet - ground <= opts.snap {
            up = ground + feet_offset;
            grounded = true;
        }

        CapsuleResult {
            position: from_basis(right, up, forward),
            grounded,
            hit_wall,
        }
    }

    /// Nearest hit along a ray. Solid and non-solid shapes both report (a
    /// non-solid collider is exactly "a thing you can only shoot at"); the
    /// terrain is ray-marched at fixed 0.5-unit steps then bisected.
    ///
    /// Full scan on purpose: the grid indexes planar footprints, which buys a
    /// long ray nothing, and rays are a UI-rate query (aiming), not a
    /// per-actor-per-step one. `&mut self` is for signature symmetry with the
    /// other queries and for the DDA march this will grow if that changes.
    pub fn raycast(
        &mut self,
        terrain: &Terrain,
        origin: Vec3,
        direction: Vec3,
        max_distance: f32,
    ) -> Option<RaycastHit> {
        let o = P3 {
            r: right_of(origin),
            u: up_of(origin),
            f: forward_of(origin),
        };
        let dir = P3 {
            r: right_of(direction),
            u: up_of(direction),
            f: forward_of(direction),
        };
        let d_len = fmath::sqrt(dir.r * dir.r + dir.u * dir.u + dir.f * dir.f);
        // The TS guard is `!(maxDistance > 0)`, which also rejects NaN — a
        // degenerate ray must answer "no hit", never "hit at NaN".
        if d_len <= EPS || max_distance.is_nan() || max_distance <= 0.0 {
            return None;
        }
        let d = P3 {
            r: dir.r / d_len,
            u: dir.u / d_len,
            f: dir.f / d_len,
        };

        // (distance, handle); handle 0 is the terrain. Ties keep the earlier
        // shape — strict `<`, insertion order, same as the TS.
        let mut best: Option<(f32, u32)> = None;
        for s in self.shapes.iter() {
            let t = match s.kind {
                Kind::Cuboid => ray_vs_box(o, d, s, max_distance),
                Kind::Ball => ray_vs_sphere(o, d, s.right, s.up, s.forward, s.radius, max_distance),
                Kind::Cylinder => ray_vs_cylinder(o, d, s, max_distance),
            };
            if let Some(t) = t {
                if best.is_none_or(|(bt, _)| t < bt) {
                    best = Some((t, s.handle));
                }
            }
        }

        // Terrain march. `Terrain::None` is the TS `terrain === null`: no
        // sampler, no march — NOT a flat plane at height 0.
        if !matches!(terrain, Terrain::None) {
            let limit = best.map_or(max_distance, |(t, _)| t);
            if let Some(t) = ray_vs_terrain(o, d, |r, f| terrain.height_at(r, f), limit) {
                if best.is_none_or(|(bt, _)| t < bt) {
                    best = Some((t, 0));
                }
            }
        }

        let (t, handle) = best?;
        Some(RaycastHit {
            distance: t,
            point: from_basis(o.r + d.r * t, o.u + d.u * t, o.f + d.f * t),
            handle,
        })
    }
}

// ---------------------------------------------------------------------------
// Shape math (planar, basis space)
// ---------------------------------------------------------------------------

/// A point or direction in basis components (right / up / forward).
#[derive(Clone, Copy)]
struct P3 {
    r: f32,
    u: f32,
    f: f32,
}

#[inline]
fn min_f(a: f32, b: f32) -> f32 {
    if a < b {
        a
    } else {
        b
    }
}

#[inline]
fn max_f(a: f32, b: f32) -> f32 {
    if a > b {
        a
    } else {
        b
    }
}

/// The TS `pushOutOfBox`: nearest exit for a circle of `radius` overlapping a
/// yawed box footprint. `None` when the circle is clear of the box.
fn push_out_of_box(s: &Shape, right: f32, forward: f32, radius: f32) -> Option<(f32, f32)> {
    let (lr, lf) = s.to_local(right, forward);
    // Closest point on the box in local planar space.
    let cr = clamp(lr, -s.h_right, s.h_right);
    let cf = clamp(lf, -s.h_forward, s.h_forward);
    let dr = lr - cr;
    let df = lf - cf;
    let dist_sq = dr * dr + df * df;
    if dist_sq >= radius * radius {
        return None;
    }
    let (out_lr, out_lf) = if dist_sq > EPS * EPS {
        // Outside the box face: push along the separation direction.
        let dist = fmath::sqrt(dist_sq);
        (cr + (dr / dist) * radius, cf + (df / dist) * radius)
    } else {
        // Centre inside the box: exit through the nearest face.
        let exit_r = s.h_right + radius - fmath::abs(lr);
        let exit_f = s.h_forward + radius - fmath::abs(lf);
        let sign = |v: f32| if v >= 0.0 { 1.0 } else { -1.0 };
        if exit_r <= exit_f {
            (sign(lr) * (s.h_right + radius), lf)
        } else {
            (lr, sign(lf) * (s.h_forward + radius))
        }
    };
    Some(s.from_local(out_lr, out_lf))
}

/// Nearest forward intersection with a sphere. A ray starting inside reports
/// nothing (the near root is behind it) — the TS behaviour, kept.
fn ray_vs_sphere(o: P3, d: P3, cr: f32, cu: f32, cf: f32, radius: f32, max_t: f32) -> Option<f32> {
    let or = o.r - cr;
    let ou = o.u - cu;
    let of = o.f - cf;
    let b = or * d.r + ou * d.u + of * d.f;
    let c = or * or + ou * ou + of * of - radius * radius;
    let disc = b * b - c;
    if disc < 0.0 {
        return None;
    }
    let t = -b - fmath::sqrt(disc);
    if t >= 0.0 && t <= max_t {
        Some(t)
    } else {
        None
    }
}

/// Infinite y-cylinder intersection clipped to the shape's vertical span,
/// plus both caps; nearest of the two wins.
fn ray_vs_cylinder(o: P3, d: P3, s: &Shape, max_t: f32) -> Option<f32> {
    let or = o.r - s.right;
    let of = o.f - s.forward;
    let a = d.r * d.r + d.f * d.f;
    let mut t_side: Option<f32> = None;
    if a > EPS {
        let b = or * d.r + of * d.f;
        let c = or * or + of * of - s.radius * s.radius;
        let disc = b * b - a * c;
        if disc >= 0.0 {
            let t = (-b - fmath::sqrt(disc)) / a;
            if t >= 0.0 && t <= max_t {
                let u = o.u + d.u * t;
                if fmath::abs(u - s.up) <= s.half_height {
                    t_side = Some(t);
                }
            }
        }
    }
    let mut t_cap: Option<f32> = None;
    if fmath::abs(d.u) > EPS {
        for cap_u in [s.up + s.half_height, s.up - s.half_height] {
            let t = (cap_u - o.u) / d.u;
            if t < 0.0 || t > max_t {
                continue;
            }
            let rr = o.r + d.r * t - s.right;
            let ff = o.f + d.f * t - s.forward;
            if rr * rr + ff * ff <= s.radius * s.radius && t_cap.is_none_or(|best| t < best) {
                t_cap = Some(t);
            }
        }
    }
    match (t_side, t_cap) {
        (None, cap) => cap,
        (side, None) => side,
        (Some(side), Some(cap)) => Some(min_f(side, cap)),
    }
}

/// Slab test in box-local space (the up axis is unrotated, v1 being yaw-only).
fn ray_vs_box(o: P3, d: P3, s: &Shape, max_t: f32) -> Option<f32> {
    let (c, sn) = (s.yaw_cos, -s.yaw_sin);
    let dr = o.r - s.right;
    let df = o.f - s.forward;
    let olr = c * dr + sn * df;
    let olf = -sn * dr + c * df;
    let dlr = c * d.r + sn * d.f;
    let dlf = -sn * d.r + c * d.f;
    let ou = o.u - s.up;

    let mut t_min = 0.0f32;
    let mut t_max = max_t;
    for (oc, dc, h) in [
        (olr, dlr, s.h_right),
        (ou, d.u, s.h_up),
        (olf, dlf, s.h_forward),
    ] {
        if fmath::abs(dc) < EPS {
            if fmath::abs(oc) > h {
                return None;
            }
            continue;
        }
        let t1 = (-h - oc) / dc;
        let t2 = (h - oc) / dc;
        let (t1, t2) = if t1 > t2 { (t2, t1) } else { (t1, t2) };
        t_min = max_f(t_min, t1);
        t_max = min_f(t_max, t2);
        if t_min > t_max {
            return None;
        }
    }
    Some(t_min)
}

/// Fixed-step march then bisection — deterministic where a root-finder would
/// not be, and cheap enough at 0.5 units that a 30-unit aim ray is 60 samples.
///
/// Generic over the height sampler rather than taking `&Terrain` so the march
/// can be tested directly against an analytic surface (and so `Terrain::None`
/// never reaches it — see [`CollisionWorld::raycast`]).
fn ray_vs_terrain<F>(o: P3, d: P3, height: F, max_t: f32) -> Option<f32>
where
    F: Fn(f32, f32) -> f32,
{
    const STEP: f32 = 0.5;
    let mut prev_t = 0.0f32;
    let above0 = o.u - height(o.r, o.f);
    if above0 <= 0.0 {
        // Already at or under the surface: an immediate hit, distance 0.
        return Some(0.0);
    }
    // STEP is a power of two, so this accumulation is exact in f32 well past
    // any ray length a game asks for — no drift between hosts.
    let mut t = STEP;
    while t <= max_t + EPS {
        let tt = min_f(t, max_t);
        let above = o.u + d.u * tt - height(o.r + d.r * tt, o.f + d.f * tt);
        if above <= 0.0 {
            // Bisect the crossing for a stable hit point.
            let mut lo = prev_t;
            let mut hi = tt;
            for _ in 0..16 {
                let mid = (lo + hi) * 0.5;
                let a = o.u + d.u * mid - height(o.r + d.r * mid, o.f + d.f * mid);
                if a > 0.0 {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            return Some(hi);
        }
        prev_t = tt;
        if tt >= max_t {
            break;
        }
        t += STEP;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The TS test capsule, with the `??` defaults spelled out.
    const CAPSULE: CapsuleOpts = CapsuleOpts {
        radius: 0.4,
        half_height: 0.9,
        climb: CapsuleOpts::DEFAULT_CLIMB,
        snap: CapsuleOpts::DEFAULT_SNAP,
    };

    /// f32 tolerance. The TS tests assert to 12 decimals on f64; the same
    /// quantities in f32 carry ~7 significant digits, so 1e-5 at world scale
    /// is "exactly what the algebra says" without pretending otherwise.
    fn close(a: f32, b: f32) {
        assert!(fmath::abs(a - b) < 1e-5, "expected {b}, got {a}");
    }

    fn no_terrain() -> Terrain {
        Terrain::None
    }

    fn v(x: f32, y: f32, z: f32) -> Vec3 {
        Vec3::new(x, y, z)
    }

    // -- push-out ------------------------------------------------------------

    #[test]
    fn wall_blocks_forward_motion_and_slides_laterally() {
        let mut w = CollisionWorld::new();
        // Wall across the forward axis: spans forward 4.5..5.5, up 0..2.
        w.add_cuboid(v(0.0, 1.0, -5.0), v(5.0, 1.0, 0.5), 0.0, true, false);

        let head_on = w.resolve_capsule(&no_terrain(), v(0.0, 0.9, 0.0), v(0.0, 0.9, -4.3), CAPSULE);
        assert!(head_on.hit_wall);
        // Pushed back to the wall face minus the radius: forward 4.5 - 0.4.
        close(head_on.position.z, -4.1);
        close(head_on.position.x, 0.0);
        assert!(head_on.grounded);

        // Diagonal move: forward clipped, lateral component preserved (slide).
        let slide = w.resolve_capsule(&no_terrain(), v(0.0, 0.9, 0.0), v(1.0, 0.9, -4.3), CAPSULE);
        assert!(slide.hit_wall);
        close(slide.position.x, 1.0);
        close(slide.position.z, -4.1);
    }

    #[test]
    fn motion_clear_of_the_wall_is_untouched() {
        let mut w = CollisionWorld::new();
        w.add_cuboid(v(0.0, 1.0, -5.0), v(5.0, 1.0, 0.5), 0.0, true, false);
        let res = w.resolve_capsule(&no_terrain(), v(0.0, 0.9, 0.0), v(0.0, 0.9, -3.0), CAPSULE);
        assert!(!res.hit_wall);
        close(res.position.z, -3.0);
    }

    #[test]
    fn yawed_cuboid_pushes_out_along_the_rotated_face_normal() {
        let mut w = CollisionWorld::new();
        // Thin wall (h_forward 0.2) yawed 45 degrees at the origin.
        let yaw = core::f32::consts::FRAC_PI_4;
        w.add_cuboid(v(0.0, 1.0, 0.0), v(1.0, 1.0, 0.2), yaw, true, false);

        // A point at box-local (lr = 0, lf = 0.35): 0.15 inside the 0.4 margin.
        let p = 0.35 * core::f32::consts::FRAC_1_SQRT_2;
        let res = w.resolve_capsule(&no_terrain(), v(3.0, 0.9, -3.0), v(p, 0.9, -p), CAPSULE);
        assert!(res.hit_wall);
        // Pushed to local lf = 0.2 + 0.4 along the rotated (1,1)/sqrt(2) normal.
        let q = 0.6 * core::f32::consts::FRAC_1_SQRT_2;
        close(res.position.x, q);
        close(res.position.z, -q);
    }

    #[test]
    fn cylinder_pushes_the_capsule_out_radially() {
        let mut w = CollisionWorld::new();
        w.add_cylinder(v(0.0, 1.0, 0.0), 1.0, 1.0, true, false);
        let res = w.resolve_capsule(&no_terrain(), v(3.0, 0.9, 0.0), v(0.5, 0.9, 0.0), CAPSULE);
        assert!(res.hit_wall);
        close(res.position.x, 1.4); // cylinder radius 1 + capsule 0.4
        close(res.position.z, 0.0);
        assert!(res.grounded);
    }

    #[test]
    fn ball_pushes_the_capsule_out_radially() {
        let mut w = CollisionWorld::new();
        w.add_ball(v(0.0, 0.5, 0.0), 1.0, true, false);
        let res = w.resolve_capsule(&no_terrain(), v(0.0, 0.9, 3.0), v(0.0, 0.9, -0.5), CAPSULE);
        assert!(res.hit_wall);
        close(res.position.z, -1.4);
        close(res.position.x, 0.0);
    }

    #[test]
    fn dead_centre_overlap_exits_along_plus_right() {
        // Degenerate spawn: no separation direction exists, so the TS picks
        // (1, 0) and so do we — the branch that must not diverge silently.
        let mut w = CollisionWorld::new();
        w.add_cylinder(v(0.0, 1.0, 0.0), 1.0, 1.0, true, false);
        let res = w.resolve_capsule(&no_terrain(), v(0.0, 0.9, 0.0), v(0.0, 0.9, 0.0), CAPSULE);
        assert!(res.hit_wall);
        close(res.position.x, 1.4);
        close(res.position.z, 0.0);
    }

    // -- climb / snap ---------------------------------------------------------

    #[test]
    fn steps_up_onto_a_walkable_box_within_climb() {
        let mut w = CollisionWorld::new();
        w.add_cuboid(v(0.0, 0.2, -3.0), v(1.0, 0.2, 1.0), 0.0, true, true);
        // Box top 0.4 <= climb 0.55: not a wall, and the feet land on top.
        let res = w.resolve_capsule(&no_terrain(), v(0.0, 0.9, 0.0), v(0.0, 0.9, -3.0), CAPSULE);
        assert!(!res.hit_wall);
        assert!(res.grounded);
        close(res.position.y, 0.4 + CAPSULE.half_height);
    }

    #[test]
    fn walkable_box_taller_than_climb_walls_the_mover() {
        let mut w = CollisionWorld::new();
        w.add_cuboid(v(0.0, 0.4, -3.0), v(1.0, 0.4, 1.0), 0.0, true, true);
        // Box top 0.8 > climb 0.55: pushed back out through the near face.
        let res = w.resolve_capsule(&no_terrain(), v(0.0, 0.9, 0.0), v(0.0, 0.9, -2.2), CAPSULE);
        assert!(res.hit_wall);
        close(res.position.z, -1.6); // near face at forward 2, minus 1 + 0.4
        close(res.position.y, 0.9); // still standing on the terrain
    }

    #[test]
    fn snap_down_within_snap_distance_airborne_beyond_it() {
        let mut w = CollisionWorld::new();
        // Feet 0.2 above the ground, snap 0.3: snapped down and grounded.
        let near = w.resolve_capsule(&no_terrain(), v(0.0, 1.1, 0.0), v(0.0, 1.1, 0.0), CAPSULE);
        assert!(near.grounded);
        close(near.position.y, 0.9);

        // Feet 0.5 above: beyond snap, stays airborne and keeps its height.
        let far = w.resolve_capsule(&no_terrain(), v(0.0, 1.4, 0.0), v(0.0, 1.4, 0.0), CAPSULE);
        assert!(!far.grounded);
        close(far.position.y, 1.4);

        // snap = 0 disables snapping entirely.
        let off = w.resolve_capsule(
            &no_terrain(),
            v(0.0, 1.1, 0.0),
            v(0.0, 1.1, 0.0),
            CapsuleOpts { snap: 0.0, ..CAPSULE },
        );
        assert!(!off.grounded);
        close(off.position.y, 1.1);
    }

    // -- ground authority ------------------------------------------------------

    #[test]
    fn ground_height_takes_walkable_tops_and_ignores_solids() {
        let mut w = CollisionWorld::new();
        let t = no_terrain();
        w.add_cuboid(v(0.0, 0.5, -3.0), v(1.0, 0.5, 1.0), 0.0, true, true);
        // Solid but not walkable: contributes nothing to the ground.
        w.add_cuboid(v(5.0, 2.0, -3.0), v(1.0, 2.0, 1.0), 0.0, true, false);

        close(w.ground_height_at(&t, 0.0, 3.0), 1.0); // box top
        close(w.ground_height_at(&t, 0.5, 2.5), 1.0); // still inside the box
        close(w.ground_height_at(&t, 0.0, 30.0), 0.0); // terrain only
        close(w.ground_height_at(&t, 5.0, 3.0), 0.0); // solid box ignored
    }

    #[test]
    fn collider_count_and_clear() {
        let mut w = CollisionWorld::new();
        let a = w.add_ball(v(0.0, 0.0, 0.0), 1.0, true, false);
        let b = w.add_ball(v(4.0, 0.0, 0.0), 1.0, true, false);
        assert_eq!((a, b), (1, 2));
        assert_eq!(w.collider_count(), 2);
        w.clear();
        assert_eq!(w.collider_count(), 0);
        // Handles keep climbing across a clear (see CollisionWorld::clear).
        assert_eq!(w.add_ball(v(0.0, 0.0, 0.0), 1.0, true, false), 3);
        // ...and the grid was rebuilt from empty, so the stale shapes are gone.
        let res = w.resolve_capsule(&no_terrain(), v(4.0, 0.9, 0.0), v(4.0, 0.9, 0.0), CAPSULE);
        assert!(!res.hit_wall);
    }

    // -- raycasts --------------------------------------------------------------

    #[test]
    fn raycast_hits_a_sphere_at_the_hand_computed_distance() {
        let mut w = CollisionWorld::new();
        let handle = w.add_ball(v(0.0, 0.0, -5.0), 1.0, true, false);
        let hit = w
            .raycast(&no_terrain(), v(0.0, 0.0, 0.0), v(0.0, 0.0, -1.0), 100.0)
            .expect("ray should hit the ball");
        close(hit.distance, 4.0);
        close(hit.point.z, -4.0);
        assert_eq!(hit.handle, handle);
    }

    #[test]
    fn raycast_hits_cylinder_sides_and_caps() {
        let mut w = CollisionWorld::new();
        w.add_cylinder(v(0.0, 1.0, -5.0), 0.5, 1.0, true, false);

        let side = w
            .raycast(&no_terrain(), v(0.0, 1.0, 0.0), v(0.0, 0.0, -1.0), 100.0)
            .expect("side hit");
        close(side.distance, 4.5);

        let cap = w
            .raycast(&no_terrain(), v(0.0, 5.0, -5.0), v(0.0, -1.0, 0.0), 100.0)
            .expect("cap hit");
        close(cap.distance, 3.0); // top cap at y = 2
    }

    #[test]
    fn raycast_hits_axis_aligned_and_yawed_boxes() {
        let mut w = CollisionWorld::new();
        w.add_cuboid(v(0.0, 1.0, -5.0), v(1.0, 1.0, 1.0), 0.0, true, false);
        let straight = w
            .raycast(&no_terrain(), v(0.0, 1.0, 0.0), v(0.0, 0.0, -1.0), 100.0)
            .expect("box hit");
        close(straight.distance, 4.0);

        let mut yawed = CollisionWorld::new();
        yawed.add_cuboid(
            v(0.0, 0.0, -5.0),
            v(1.0, 1.0, 1.0),
            core::f32::consts::FRAC_PI_4,
            true,
            false,
        );
        // A 45-degree unit cube presents its corner: first hit at 5 - sqrt(2).
        let corner = yawed
            .raycast(&no_terrain(), v(0.0, 0.0, 0.0), v(0.0, 0.0, -1.0), 100.0)
            .expect("corner hit");
        assert!(fmath::abs(corner.distance - (5.0 - core::f32::consts::SQRT_2)) < 1e-4);
    }

    #[test]
    fn raycast_misses_on_wrong_direction_and_short_max_distance() {
        let mut w = CollisionWorld::new();
        w.add_ball(v(0.0, 0.0, -5.0), 1.0, true, false);

        assert!(w
            .raycast(&no_terrain(), v(0.0, 0.1, 0.0), v(0.0, 1.0, 0.0), 50.0)
            .is_none());

        // Ball hit at 5 - sqrt(0.75); a shorter max distance is a miss.
        let long = w
            .raycast(&no_terrain(), v(0.0, 0.5, 0.0), v(0.0, 0.0, -1.0), 100.0)
            .expect("ball hit");
        close(long.distance, 5.0 - fmath::sqrt(0.75));
        assert!(w
            .raycast(&no_terrain(), v(0.0, 0.5, 0.0), v(0.0, 0.0, -1.0), 3.0)
            .is_none());

        // A zero-length direction is not a ray.
        assert!(w
            .raycast(&no_terrain(), v(0.0, 0.5, 0.0), Vec3::ZERO, 100.0)
            .is_none());
    }

    #[test]
    fn terrain_march_finds_the_crossing_within_bisection_tolerance() {
        // The TS raycast-vs-terrain case, exercised on the march directly:
        // Terrain::None means "no sampler", so the World path cannot express
        // a flat plane at height 0 (that is what the deviation note is about).
        let o = P3 {
            r: 0.0,
            u: 4.0,
            f: 0.0,
        };
        let inv = core::f32::consts::FRAC_1_SQRT_2;
        let d = P3 {
            r: 0.0,
            u: -inv,
            f: inv,
        };
        let t = ray_vs_terrain(o, d, |_, _| 0.0, 100.0).expect("terrain hit");
        // Crossing at t = 4*sqrt(2); the bisection tolerance is 0.5 / 2^16.
        assert!(fmath::abs(t - 4.0 * core::f32::consts::SQRT_2) < 1e-3);

        // A sloped surface the march has to walk before it crosses.
        let slope = |_r: f32, f: f32| 0.25 * f;
        let t2 = ray_vs_terrain(o, d, slope, 100.0).expect("slope hit");
        // 4 - t/sqrt(2) = 0.25 * t/sqrt(2)  =>  t = 4*sqrt(2)/1.25.
        assert!(fmath::abs(t2 - 4.0 * core::f32::consts::SQRT_2 / 1.25) < 1e-3);

        // Starting under the surface is an immediate hit.
        assert_eq!(ray_vs_terrain(o, d, |_, _| 10.0, 100.0), Some(0.0));
        // Climbing away from it never crosses.
        let up_ray = P3 {
            r: 0.0,
            u: 1.0,
            f: 0.0,
        };
        assert_eq!(ray_vs_terrain(o, up_ray, |_, _| 0.0, 100.0), None);
        // Neither does a crossing that lies beyond max_distance.
        assert_eq!(ray_vs_terrain(o, d, |_, _| 0.0, 3.0), None);
    }

    #[test]
    fn raycast_skips_the_terrain_when_there_is_no_sampler() {
        let mut w = CollisionWorld::new();
        // Aimed down at where a height-0 plane would be: no sampler, no hit.
        assert!(w
            .raycast(&no_terrain(), v(0.0, 4.0, 0.0), v(0.0, -1.0, 0.0), 100.0)
            .is_none());
    }

    // -- broadphase parity ------------------------------------------------------

    /// The determinism harness: a fixed LCG, so "random" is a spelling of
    /// "arbitrary but identical on every host".
    struct Lcg(u32);

    impl Lcg {
        fn next(&mut self) -> f32 {
            self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
            (self.0 >> 8) as f32 / 16777216.0
        }

        fn range(&mut self, lo: f32, hi: f32) -> f32 {
            lo + (hi - lo) * self.next()
        }
    }

    /// ~400 colliders on a jittered lattice, deliberately sparse enough that
    /// the broadphase result is PROVABLY the full-scan result:
    ///
    ///   lattice cell 8, jitter ±2  =>  centres are >= 4 apart;
    ///   max shape reach 1.5 + capsule radius 0.4 = 1.9 touch distance,
    ///   and two shapes both within 1.9 of one point would be < 3.8 apart.
    ///
    /// So at most one shape ever pushes the capsule, there are no push-out
    /// chains, and every shape that can touch `desired` is inside the gather
    /// margin. That makes the assertion below a real proof obligation on the
    /// grid rather than a coincidence of the sample.
    fn build_scatter(full_scan: bool) -> CollisionWorld {
        let mut w = CollisionWorld::new();
        w.full_scan = full_scan;
        let mut rng = Lcg(0x5eed_1234);
        for gr in -10..10 {
            for gf in -10..10 {
                let right = gr as f32 * 8.0 + rng.range(-2.0, 2.0);
                let forward = gf as f32 * 8.0 + rng.range(-2.0, 2.0);
                let up = rng.range(0.1, 1.2);
                let solid = rng.next() > 0.15;
                let walkable = rng.next() > 0.6;
                match (rng.next() * 3.0) as u32 {
                    0 => {
                        // Half extents <= 1.0 => reach <= sqrt(2) < 1.5.
                        let hr = rng.range(0.3, 1.0);
                        let hf = rng.range(0.3, 1.0);
                        let hu = rng.range(0.2, 1.0);
                        let yaw = rng.range(-3.14, 3.14);
                        w.add_cuboid(
                            from_basis(right, up, forward),
                            from_basis(hr, hu, hf),
                            yaw,
                            solid,
                            walkable,
                        );
                    }
                    1 => {
                        w.add_cylinder(
                            from_basis(right, up, forward),
                            rng.range(0.2, 1.5),
                            rng.range(0.3, 1.5),
                            solid,
                            walkable,
                        );
                    }
                    _ => {
                        w.add_ball(
                            from_basis(right, up, forward),
                            rng.range(0.2, 1.5),
                            solid,
                            walkable,
                        );
                    }
                }
            }
        }
        w
    }

    #[test]
    fn broadphase_equals_a_full_scan() {
        let mut grid = build_scatter(false);
        let mut scan = build_scatter(true);
        assert_eq!(grid.collider_count(), 400);
        let t = no_terrain();

        // Ground authority over a dense probe sweep.
        let mut probes = 0;
        for i in -40..40 {
            for j in -40..40 {
                let r = i as f32 * 2.0 + 0.37;
                let f = j as f32 * 2.0 - 0.61;
                assert_eq!(
                    grid.ground_height_at(&t, r, f).to_bits(),
                    scan.ground_height_at(&t, r, f).to_bits(),
                    "ground height diverged at ({r}, {f})"
                );
                probes += 1;
            }
        }
        assert_eq!(probes, 6400);

        // Capsule resolution, both as isolated probes and as a chained walk
        // (the walk is what a mover actually does, frame after frame).
        let mut rng = Lcg(0xa11c_e001);
        for _ in 0..2000 {
            let cur = from_basis(rng.range(-80.0, 80.0), 0.9, rng.range(-80.0, 80.0));
            let des = cur + from_basis(rng.range(-1.5, 1.5), 0.0, rng.range(-1.5, 1.5));
            let a = grid.resolve_capsule(&t, cur, des, CAPSULE);
            let b = scan.resolve_capsule(&t, cur, des, CAPSULE);
            assert_eq!(a.position.to_array(), b.position.to_array());
            assert_eq!((a.grounded, a.hit_wall), (b.grounded, b.hit_wall));
        }

        // 300 steps of ~0.45 keeps the walk inside the scattered field.
        let mut pa = from_basis(-70.0, 0.9, -78.0);
        let mut pb = pa;
        for i in 0..300 {
            let step = from_basis(fmath::sin(i as f32 * 0.31) * 0.5, 0.0, 0.45);
            let a = grid.resolve_capsule(&t, pa, pa + step, CAPSULE);
            let b = scan.resolve_capsule(&t, pb, pb + step, CAPSULE);
            assert_eq!(a.position.to_array(), b.position.to_array(), "step {i}");
            assert_eq!((a.grounded, a.hit_wall), (b.grounded, b.hit_wall));
            pa = a.position;
            pb = b.position;
        }
    }

    #[test]
    fn two_worlds_built_identically_resolve_identically() {
        // The TS determinism test: same construction, same answers, bit for
        // bit — no iteration order or float-accumulation slop hiding anywhere.
        let mut a = build_scatter(false);
        let mut b = build_scatter(false);
        let t = no_terrain();
        let mut pa = from_basis(0.0, 0.9, 0.0);
        let mut pb = pa;
        for _ in 0..200 {
            let step = from_basis(0.2, 0.0, 0.35);
            let ra = a.resolve_capsule(&t, pa, pa + step, CAPSULE);
            let rb = b.resolve_capsule(&t, pb, pb + step, CAPSULE);
            assert_eq!(ra.position.to_array(), rb.position.to_array());
            pa = ra.position;
            pb = rb.position;
        }
        for dir in [
            from_basis(0.0, -0.2, 1.0),
            from_basis(1.0, -0.1, 1.0),
            from_basis(-1.0, 0.0, 1.0),
        ] {
            let ha = a.raycast(&t, from_basis(0.0, 2.0, -2.0), dir, 30.0);
            let hb = b.raycast(&t, from_basis(0.0, 2.0, -2.0), dir, 30.0);
            assert_eq!(ha, hb);
        }
    }

    #[test]
    fn oversized_shapes_still_resolve() {
        // A shape too big for the grid is left out of it on purpose; every
        // gather in its world must then fall back to the full scan, so it had
        // better still push. (MAX_INSERT_SPAN / MAX_SPAN, in one assertion.)
        let mut w = CollisionWorld::new();
        w.add_cuboid(
            from_basis(0.0, 1.0, 0.0),
            from_basis(2000.0, 1.0, 2000.0),
            0.0,
            true,
            true,
        );
        assert!(w.grid.is_empty(), "an oversized shape must skip the grid");
        // Its walkable top at 2 is still the ground authority everywhere, and
        // still carries a mover whose feet are already up there.
        let t = no_terrain();
        close(w.ground_height_at(&t, 12.0, -34.0), 2.0);
        let res = w.resolve_capsule(
            &t,
            from_basis(0.0, 3.0, 0.0),
            from_basis(0.0, 3.0, 1.0),
            CAPSULE,
        );
        assert!(!res.hit_wall);
        close(res.position.y, 2.9); // top 2 + half height 0.9
        assert!(res.grounded);
    }
}
