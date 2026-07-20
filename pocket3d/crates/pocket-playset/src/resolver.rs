//! Frame-batched kinematic resolution: actors register a collider once, queue
//! a movement intent per frame, and get grounded/blocked outcomes resolved
//! together against the deterministic [`CollisionWorld`].
//!
//! Ported from playset/modules/actor-motion/kinematic-batch-resolver.ts, which
//! is itself a reengineered port of GameBlocks (github.com/xt4d/GameBlocks,
//! MIT © 2026 Weihao Cheng) — modules/actor-motion/KinematicBatchResolver.js.
//! The TS module REMAINS the reference implementation; this file exists only
//! because QuickJS on a real PSP cannot afford it (see the crate docs). Every
//! semantic here is the TS semantic, in f32.
//!
//! WHY BATCHED AT ALL: resolving actors one at a time makes the outcome depend
//! on who moved first. The mode this core implements resolves everyone from
//! their frame-START positions, so two cars trading paint get the same answer
//! whichever one the loop reaches first — the ordering that remains is only
//! the push-out chain order, which is pinned to registration order below.
//!
//! DELIBERATE NARROWING (v1), all of it load-bearing to keep the hot path
//! small — anything a game needs beyond this stays on the TS path:
//!
//! * Actor-collision mode: the TS has three (`ignoreActors`, `startPositions`,
//!   `sequential`) plus a per-actor override. This implements ONLY
//!   `startPositions` — the TS default, and the only mode any playset game
//!   selects. There is no mode field, so there is no per-frame branch on it.
//! * Collider shape: cuboid only (what rally's cars use), reduced through the
//!   TS `capsuleDims` cuboid branch: `radius = max(|halfRight|, |halfForward|)`
//!   and `halfHeight = |halfUp|`. Capsule/ball actors would just be a
//!   different constructor; the resolve path downstream is identical.
//! * `climb` / `snap` / `groundedProbeDistance` arrive in TS through a
//!   `controllerOptions` bag (autostep.maxHeight → climb, snapToGround → snap).
//!   Rally leaves all three at 0, so they are plain per-actor fields defaulting
//!   to 0 with one setter ([`BatchResolver::set_controller`]) instead of an
//!   options struct.
//! * `physicsBodyOffset` is gone. It is the gameplay-anchor → collider-center
//!   offset; no playset game sets it, and at zero the TS add-on-sync /
//!   subtract-on-result pair collapses to the identity. Body position IS the
//!   gameplay position here.
//! * `colliderOptions` (friction/restitution/groups) was already inert in the
//!   TS v1 core, so it is simply absent.
//!
//! ZERO ALLOCATION PER FRAME: the TS keeps results in a `Map<Actor, Result>`;
//! actors here are dense indices, so results live in a `Vec<MoveResult>`
//! parallel to the actor list — no map, no hashing, no per-frame growth. The
//! queue and the deferred-commit list are cleared, never freed.

use alloc::vec::Vec;
use glam::Vec3;

use crate::collision::{CapsuleOpts, CollisionWorld};
use crate::math::{self, fmath, EPS};
use crate::terrain::Terrain;

/// The outcome of one queued move — the TS `KinematicMoveResult` minus
/// `desiredDelta`/`startPosition`, which the caller already owns (it queued
/// them) and which nothing downstream reads back.
#[derive(Clone, Copy, Default, Debug)]
pub struct MoveResult {
    /// Where the actor ended up after world + actor resolution.
    pub position: Vec3,
    /// `corrected_delta / dt` — what the mover ACTUALLY achieved, which is what
    /// a motion controller must integrate against after being blocked.
    pub velocity: Vec3,
    pub corrected_delta: Vec3,
    pub grounded: bool,
    /// True when anything clipped this move — a world wall or another actor.
    pub blocked: bool,
    pub collisions: u32,
}

/// One registered collider. `body_position` is the resolver's own copy of
/// where the actor is; it is re-synced from the caller's frame-start position
/// at the top of every [`BatchResolver::resolve`], so a motion controller that
/// teleports its actor needs no explicit sync call.
struct Actor {
    body_position: Vec3,
    radius: f32,
    half_height: f32,
    /// Max ground rise the mover steps onto instead of being walled.
    climb: f32,
    /// Snap-down distance when airborne but near ground (0 disables).
    snap: f32,
    /// Extra grounded-probe reach used only when the resolve says airborne.
    grounded_probe_distance: f32,
}

#[derive(Clone, Copy)]
struct QueuedMove {
    actor: usize,
    start_position: Vec3,
    desired_delta: Vec3,
    dt: f32,
}

pub struct BatchResolver {
    /// Registration order IS the determinism anchor (the TS iterates an
    /// insertion-ordered `Set`); never reorder or compact this.
    actors: Vec<Actor>,
    /// Parallel to `actors`: the last `resolve`'s outcome per actor, zeroed
    /// for actors that did not move.
    results: Vec<MoveResult>,
    queued: Vec<QueuedMove>,
    /// Deferred kinematic translations — bodies only move after every actor
    /// has resolved, which is what makes the mode order-independent.
    commits: Vec<(usize, Vec3)>,
}

impl Default for BatchResolver {
    fn default() -> Self {
        Self::new()
    }
}

impl BatchResolver {
    pub fn new() -> Self {
        Self {
            actors: Vec::new(),
            results: Vec::new(),
            queued: Vec::new(),
            commits: Vec::new(),
        }
    }

    /// Register a cuboid collider (the shape rally's cars use) and return its
    /// index — the handle for every other call here, and the actor's rank in
    /// the deterministic push-out order.
    ///
    /// `half_extents` is reduced to capsule dims exactly like the TS
    /// `capsuleDims` cuboid branch: the planar radius is the LARGER of the two
    /// planar half-extents (a circumscribing circle — a kinematic mover never
    /// tunnels, it only ever pushes out a little early on the narrow axis).
    pub fn create_actor(&mut self, position: Vec3, half_extents: Vec3) -> usize {
        let h_right = fmath::abs(math::right_of(half_extents));
        let h_up = fmath::abs(math::up_of(half_extents));
        let h_forward = fmath::abs(math::forward_of(half_extents));
        // `Math.max` by hand: f32::max is a std intrinsic and this crate is
        // no_std on the PSP side.
        let radius = if h_right > h_forward {
            h_right
        } else {
            h_forward
        };
        self.actors.push(Actor {
            body_position: position,
            radius,
            half_height: h_up,
            climb: 0.0,
            snap: 0.0,
            grounded_probe_distance: 0.0,
        });
        self.results.push(MoveResult::default());
        self.actors.len() - 1
    }

    pub fn actor_count(&self) -> usize {
        self.actors.len()
    }

    /// The TS `controllerOptions` trio, flattened (see the header narrowing).
    /// Unknown handles are inert — ops are intent, not calls.
    pub fn set_controller(&mut self, actor: usize, climb: f32, snap: f32, grounded_probe: f32) {
        let Some(a) = self.actors.get_mut(actor) else {
            return;
        };
        a.climb = climb;
        a.snap = snap;
        a.grounded_probe_distance = grounded_probe;
    }

    /// Drop last frame's queue and results. Capacity is kept: after the first
    /// frame this allocates nothing, ever.
    pub fn begin_frame(&mut self) {
        self.queued.clear();
        self.commits.clear();
        for r in &mut self.results {
            *r = MoveResult::default();
        }
    }

    /// Queue `actor`'s intent for this frame. `start_position` is where the
    /// actor believes it is at frame start (the resolver syncs to it), and
    /// `desired_delta` is the unclipped motion the controller planned.
    ///
    /// Queueing the same actor twice is legal and the last one wins, matching
    /// the TS commit loop. An unknown handle is ignored rather than fatal (the
    /// TS throws; a guest-facing native core must never panic on a stale id).
    pub fn queue_move(&mut self, actor: usize, start_position: Vec3, desired_delta: Vec3, dt: f32) {
        if actor >= self.actors.len() {
            return;
        }
        self.queued.push(QueuedMove {
            actor,
            start_position,
            desired_delta,
            dt,
        });
    }

    /// Resolve every queued move together, TS `startPositions` mode:
    /// 1. all queued actors sync to their frame-start positions,
    /// 2. each resolves against the static world and the OTHER actors' start
    ///    positions (so nobody gets an advantage from moving first),
    /// 3. bodies commit only after every resolution — deferred kinematic
    ///    translation, exactly as the original Rapier version did.
    pub fn resolve(&mut self, world: &mut CollisionWorld, terrain: &Terrain) {
        for r in &mut self.results {
            *r = MoveResult::default();
        }
        self.commits.clear();
        if self.queued.is_empty() {
            return;
        }

        for i in 0..self.queued.len() {
            let m = self.queued[i];
            self.actors[m.actor].body_position = m.start_position;
        }

        for i in 0..self.queued.len() {
            let m = self.queued[i];
            let result = self.resolve_move(&m, world, terrain);
            self.results[m.actor] = result;
            self.commits.push((m.actor, result.position));
        }

        for i in 0..self.commits.len() {
            let (actor, position) = self.commits[i];
            self.actors[actor].body_position = position;
        }
    }

    /// The result for `actor` from the last [`resolve`](Self::resolve) — zeroed
    /// if it did not move (the TS returns `null`; a zeroed struct is the
    /// no-alloc equivalent and every field reads as "went nowhere, hit
    /// nothing").
    pub fn result(&self, actor: usize) -> MoveResult {
        self.results.get(actor).copied().unwrap_or_default()
    }

    /// One actor's resolution: world capsule pass, then a planar circle
    /// push-out against every other actor, then a re-ground.
    ///
    /// `&self` on purpose — resolving must not observe any of this frame's
    /// other outcomes, which is precisely what makes the batch order-free.
    fn resolve_move(
        &self,
        m: &QueuedMove,
        world: &mut CollisionWorld,
        terrain: &Terrain,
    ) -> MoveResult {
        let actor = &self.actors[m.actor];
        let current = actor.body_position;
        let desired = current + m.desired_delta;

        let resolved = world.resolve_capsule(
            terrain,
            current,
            desired,
            CapsuleOpts {
                radius: actor.radius,
                half_height: actor.half_height,
                climb: actor.climb,
                snap: actor.snap,
            },
        );

        let mut collisions: u32 = if resolved.hit_wall { 1 } else { 0 };
        let mut grounded = resolved.grounded;
        let mut right = math::right_of(resolved.position);
        let mut up = math::up_of(resolved.position);
        let mut forward = math::forward_of(resolved.position);

        // Planar circle push-out vs the other actors, in registration order.
        // Chained: each push-out moves (right, forward) for the next test, so
        // a mover squeezed between two others ends up outside the LAST one it
        // overlapped — same as the TS, and the reason iteration order is part
        // of the contract rather than an implementation detail.
        for (i, other) in self.actors.iter().enumerate() {
            if i == m.actor {
                continue;
            }
            let o_right = math::right_of(other.body_position);
            let o_up = math::up_of(other.body_position);
            let o_forward = math::forward_of(other.body_position);

            // Vertical spans must overlap: an actor on a bridge above another
            // is not touching it.
            let feet = up - actor.half_height;
            let head = up + actor.half_height;
            let o_bottom = o_up - other.half_height;
            let o_top = o_up + other.half_height;
            if head <= o_bottom + EPS || feet >= o_top - EPS {
                continue;
            }

            let d_right = right - o_right;
            let d_forward = forward - o_forward;
            let min_dist = actor.radius + other.radius;
            let dist_sq = d_right * d_right + d_forward * d_forward;
            if dist_sq >= min_dist * min_dist {
                continue;
            }

            let dist = fmath::sqrt(dist_sq);
            // Exactly co-located actors have no separating direction; the TS
            // picks +right so the outcome stays defined and deterministic.
            let (n_right, n_forward) = if dist > EPS {
                (d_right / dist, d_forward / dist)
            } else {
                (1.0, 0.0)
            };
            right = o_right + n_right * min_dist;
            forward = o_forward + n_forward * min_dist;
            collisions += 1;
        }

        // Re-ground after the push-out: it moved us planarly, so the ground
        // under our feet may have changed. Same climb/snap semantics as the
        // world pass. (Runs unconditionally, like the TS — a push-out of zero
        // re-derives the same height.)
        let ground = world.ground_height_at(terrain, right, forward);
        let feet = up - actor.half_height;
        if feet <= ground + EPS {
            up = ground + actor.half_height;
            grounded = true;
        } else if actor.snap > 0.0 && feet - ground <= actor.snap {
            up = ground + actor.half_height;
            grounded = true;
        }

        let next = math::from_basis(right, up, forward);
        let corrected_delta = next - current;
        // `* (1/dt)` not `/ dt`, mirroring the TS `multiplyScalar(1 / dt)` so
        // the two paths round identically where f32 and f64 agree at all.
        let velocity = if m.dt > EPS {
            corrected_delta * (1.0 / m.dt)
        } else {
            Vec3::ZERO
        };

        if !grounded {
            grounded = self.query_grounded(actor, world, terrain, right, up, forward);
        }

        MoveResult {
            position: next,
            velocity,
            corrected_delta,
            grounded,
            blocked: collisions > 0,
            collisions,
        }
    }

    /// The TS `_queryGrounded`: a last-chance tolerance probe for actors that
    /// resolved airborne. Zero probe distance (every playset game) short-
    /// circuits before touching the world.
    fn query_grounded(
        &self,
        actor: &Actor,
        world: &mut CollisionWorld,
        terrain: &Terrain,
        right: f32,
        up: f32,
        forward: f32,
    ) -> bool {
        let probe = actor.grounded_probe_distance;
        if probe <= 0.0 {
            return false;
        }
        let feet = up - actor.half_height;
        feet - world.ground_height_at(terrain, right, forward) <= probe
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// High enough that the flat default ground (height 0) never touches the
    /// capsule, so these tests isolate the actor-vs-actor path.
    const AIR: f32 = 10.0;

    fn boxy(half: f32) -> Vec3 {
        Vec3::splat(half)
    }

    fn empty_world() -> (CollisionWorld, Terrain) {
        (CollisionWorld::new(), Terrain::None)
    }

    #[test]
    fn free_actor_moves_exactly_its_desired_delta() {
        let (mut world, terrain) = empty_world();
        let mut r = BatchResolver::new();
        let a = r.create_actor(Vec3::new(0.0, AIR, 0.0), boxy(1.0));

        let delta = Vec3::new(1.25, 0.0, -2.5);
        r.begin_frame();
        r.queue_move(a, Vec3::new(0.0, AIR, 0.0), delta, 1.0 / 60.0);
        r.resolve(&mut world, &terrain);

        let res = r.result(a);
        assert_eq!(res.position, Vec3::new(1.25, AIR, -2.5));
        assert_eq!(res.corrected_delta, delta);
        assert!(!res.blocked);
        assert_eq!(res.collisions, 0);
    }

    #[test]
    fn actors_that_did_not_move_report_a_zeroed_result() {
        let (mut world, terrain) = empty_world();
        let mut r = BatchResolver::new();
        let a = r.create_actor(Vec3::new(0.0, AIR, 0.0), boxy(1.0));
        let b = r.create_actor(Vec3::new(20.0, AIR, 0.0), boxy(1.0));
        assert_eq!(r.actor_count(), 2);

        r.begin_frame();
        r.queue_move(a, Vec3::new(0.0, AIR, 0.0), Vec3::X, 1.0 / 60.0);
        r.resolve(&mut world, &terrain);

        let idle = r.result(b);
        assert_eq!(idle.position, Vec3::ZERO);
        assert_eq!(idle.collisions, 0);
        assert!(!idle.blocked);
        // Unknown handles are inert, not fatal.
        assert_eq!(r.result(99).position, Vec3::ZERO);
    }

    /// A registered-but-idle actor is a wall as far as the mover is concerned:
    /// it blocks, it counts, and it reports `blocked`.
    ///
    /// (World-collider walls — `hit_wall` out of `resolve_capsule` — are
    /// covered by the collision crate's own tests and the rally parity tape;
    /// this file's job is the actor pass.)
    #[test]
    fn a_wall_blocks_and_reports_blocked() {
        let (mut world, terrain) = empty_world();
        let mut r = BatchResolver::new();
        let mover = r.create_actor(Vec3::new(0.0, AIR, 0.0), boxy(1.0));
        let _wall = r.create_actor(Vec3::new(3.0, AIR, 0.0), boxy(1.0));

        r.begin_frame();
        r.queue_move(
            mover,
            Vec3::new(0.0, AIR, 0.0),
            Vec3::new(2.5, 0.0, 0.0),
            1.0 / 60.0,
        );
        r.resolve(&mut world, &terrain);

        let res = r.result(mover);
        assert!(res.blocked);
        assert_eq!(res.collisions, 1);
        // Pushed back to touching distance instead of the desired 2.5.
        assert_eq!(res.position.x, 1.0);
        assert!(res.corrected_delta.x < 2.5);
    }

    #[test]
    fn two_actors_pushed_together_separate_to_exactly_the_sum_of_radii() {
        let (mut world, terrain) = empty_world();
        let mut r = BatchResolver::new();
        // radius = max(|right|, |forward|) per capsuleDims: 0.5 and 1.5.
        let mover = r.create_actor(Vec3::new(0.0, AIR, 0.0), Vec3::new(0.5, 1.0, 0.25));
        let _other = r.create_actor(Vec3::new(4.0, AIR, 0.0), Vec3::new(1.5, 1.0, 0.75));

        r.begin_frame();
        r.queue_move(
            mover,
            Vec3::new(0.0, AIR, 0.0),
            Vec3::new(3.5, 0.0, 0.0),
            1.0 / 60.0,
        );
        r.resolve(&mut world, &terrain);

        let res = r.result(mover);
        assert_eq!(res.collisions, 1);
        // Exactly r1 + r2 = 2.0 apart, not merely "not overlapping".
        assert_eq!(4.0 - res.position.x, 2.0);
        assert_eq!(res.position.z, 0.0);
    }

    #[test]
    fn push_out_is_order_deterministic() {
        // Three overlapping actors, everyone moving: the answer must be a pure
        // function of registration order, repeatable bit for bit.
        fn run() -> [Vec3; 3] {
            let (mut world, terrain) = empty_world();
            let mut r = BatchResolver::new();
            let starts = [
                Vec3::new(0.0, AIR, 0.0),
                Vec3::new(1.2, AIR, 0.3),
                Vec3::new(2.1, AIR, -0.4),
            ];
            let ids = [
                r.create_actor(starts[0], boxy(1.0)),
                r.create_actor(starts[1], boxy(1.0)),
                r.create_actor(starts[2], boxy(1.0)),
            ];
            r.begin_frame();
            for (i, &id) in ids.iter().enumerate() {
                r.queue_move(id, starts[i], Vec3::new(0.1, 0.0, -0.05), 1.0 / 60.0);
            }
            r.resolve(&mut world, &terrain);
            [
                r.result(ids[0]).position,
                r.result(ids[1]).position,
                r.result(ids[2]).position,
            ]
        }

        let first = run();
        for _ in 0..8 {
            assert_eq!(run(), first);
        }
        // And the batch actually did something (guards a vacuous pass).
        assert_ne!(first[0], Vec3::new(0.1, AIR, -0.05));
    }

    #[test]
    fn resolving_is_independent_of_queue_order() {
        // The whole point of startPositions mode: same actors, reversed queue,
        // identical outcomes.
        let starts = [Vec3::new(0.0, AIR, 0.0), Vec3::new(1.4, AIR, 0.0)];
        let deltas = [Vec3::new(0.6, 0.0, 0.0), Vec3::new(-0.6, 0.0, 0.0)];

        fn run(starts: &[Vec3; 2], deltas: &[Vec3; 2], reversed: bool) -> [Vec3; 2] {
            let (mut world, terrain) = empty_world();
            let mut r = BatchResolver::new();
            let a = r.create_actor(starts[0], boxy(1.0));
            let b = r.create_actor(starts[1], boxy(1.0));
            r.begin_frame();
            let order = if reversed { [1usize, 0] } else { [0usize, 1] };
            for &i in &order {
                let id = if i == 0 { a } else { b };
                r.queue_move(id, starts[i], deltas[i], 1.0 / 60.0);
            }
            r.resolve(&mut world, &terrain);
            [r.result(a).position, r.result(b).position]
        }

        assert_eq!(run(&starts, &deltas, false), run(&starts, &deltas, true));
    }

    #[test]
    fn vertical_separation_means_no_actor_collision() {
        let (mut world, terrain) = empty_world();
        let mut r = BatchResolver::new();
        let mover = r.create_actor(Vec3::new(0.0, AIR, 0.0), boxy(1.0));
        // Same planar spot, ten units up: spans do not overlap.
        let _above = r.create_actor(Vec3::new(0.5, AIR + 10.0, 0.0), boxy(1.0));

        r.begin_frame();
        r.queue_move(
            mover,
            Vec3::new(0.0, AIR, 0.0),
            Vec3::new(0.5, 0.0, 0.0),
            1.0 / 60.0,
        );
        r.resolve(&mut world, &terrain);

        let res = r.result(mover);
        assert_eq!(res.collisions, 0);
        assert!(!res.blocked);
        assert_eq!(res.position, Vec3::new(0.5, AIR, 0.0));
    }

    #[test]
    fn velocity_is_corrected_delta_over_dt() {
        let (mut world, terrain) = empty_world();
        let mut r = BatchResolver::new();
        let mover = r.create_actor(Vec3::new(0.0, AIR, 0.0), boxy(1.0));
        let _wall = r.create_actor(Vec3::new(3.0, AIR, 0.0), boxy(1.0));

        let dt = 1.0 / 60.0;
        r.begin_frame();
        r.queue_move(
            mover,
            Vec3::new(0.0, AIR, 0.0),
            Vec3::new(2.5, 0.0, 0.0),
            dt,
        );
        r.resolve(&mut world, &terrain);

        let res = r.result(mover);
        // Blocked movers report the velocity they ACHIEVED, not the one they wanted.
        let expected = res.corrected_delta * (1.0 / dt);
        assert!((res.velocity - expected).length() < 1e-4);
        assert!(res.velocity.x < 2.5 / dt);

        // dt at (or below) epsilon is "no time passed": velocity is zero, not NaN.
        r.begin_frame();
        r.queue_move(
            mover,
            Vec3::new(0.0, AIR, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
            0.0,
        );
        r.resolve(&mut world, &terrain);
        assert_eq!(r.result(mover).velocity, Vec3::ZERO);
    }

    #[test]
    fn bodies_commit_only_after_every_actor_resolved() {
        // Actor 0 resolves first and moves far; actor 1 must still be tested
        // against actor 0's START position, so it passes through untouched.
        let (mut world, terrain) = empty_world();
        let mut r = BatchResolver::new();
        let a = r.create_actor(Vec3::new(0.0, AIR, 0.0), boxy(1.0));
        let b = r.create_actor(Vec3::new(10.0, AIR, 0.0), boxy(1.0));

        r.begin_frame();
        r.queue_move(
            a,
            Vec3::new(0.0, AIR, 0.0),
            Vec3::new(8.0, 0.0, 0.0),
            1.0 / 60.0,
        );
        r.queue_move(
            b,
            Vec3::new(10.0, AIR, 0.0),
            Vec3::new(-1.0, 0.0, 0.0),
            1.0 / 60.0,
        );
        r.resolve(&mut world, &terrain);

        assert_eq!(r.result(a).position.x, 8.0);
        assert_eq!(r.result(b).position.x, 9.0);
        assert_eq!(r.result(b).collisions, 0);

        // Next frame the committed positions DO see each other (8.0 vs 9.0,
        // one unit apart, minimum two) — proof the commit actually happened.
        r.begin_frame();
        r.queue_move(b, Vec3::new(9.0, AIR, 0.0), Vec3::ZERO, 1.0 / 60.0);
        r.resolve(&mut world, &terrain);
        assert_eq!(r.result(b).collisions, 1);
        assert_eq!(r.result(b).position.x, 10.0);
    }
}
