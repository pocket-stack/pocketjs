// playset/modules/actor-motion/kinematic-batch-resolver.ts — frame-batched
// kinematic character resolution: actors register capsule-ish colliders,
// queue movement intents, and get grounded/blocked outcomes resolved through
// the deterministic CollisionWorld.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/actor-motion/KinematicBatchResolver.js. REENGINEERED:
// Rapier's KinematicCharacterController is replaced by
// CollisionWorld.resolveCapsule (planar wall slide + climb step-up + ground
// snap), so the `rapier` constructor argument is gone and options arrive as a
// single bag. Actor-vs-actor collision is a planar circle push-out (radius =
// capsule radius) resolved in registration order for determinism; all three
// KINEMATIC_ACTOR_COLLISION_MODES keep their original semantics. Collider
// friction/restitution/group options are accepted but inert (no dynamic
// bodies in the v1 core); the native Rust physics block is the planned
// upgrade path.

import { Vector3 } from "../../math/index.ts";
import { toVec3, VECTOR_EPS } from "../math/vector3-utils.ts";
import { DEFAULT_WORLD_BASIS, type WorldBasis, type VecLike } from "../math/world-basis.ts";
import type { CollisionWorld } from "../physics/collision-world.ts";

export const KINEMATIC_ACTOR_COLLISION_MODES = Object.freeze({
  // Resolve against static world only; queued actors do not block each other.
  ignoreActors: "ignoreActors",
  // Resolve all actors from their frame-start positions; movement order does not matter.
  startPositions: "startPositions",
  // Resolve actors one at a time; earlier moves can block later moves.
  sequential: "sequential",
} as const);

export type KinematicActorCollisionMode =
  (typeof KINEMATIC_ACTOR_COLLISION_MODES)[keyof typeof KINEMATIC_ACTOR_COLLISION_MODES];

const DEFAULT_ACTOR_COLLISION_MODE = KINEMATIC_ACTOR_COLLISION_MODES.startPositions;

export type KinematicColliderShape =
  | { type: "capsule"; halfHeight: number; radius: number }
  | { type: "cuboid" | "box"; halfX: number; halfY: number; halfZ: number }
  | { type: "ball" | "sphere"; radius: number };

/** Accepted for API compatibility; inert in the kinematic v1 core. */
export interface KinematicColliderOptions {
  friction?: number;
  restitution?: number;
  collisionGroups?: number;
  solverGroups?: number;
  sensor?: boolean;
}

export interface KinematicControllerOptions {
  offset?: number;
  up?: VecLike;
  /** autostep.maxHeight maps onto CollisionWorld's `climb`. */
  autostep?: {
    enabled?: boolean;
    maxHeight?: number;
    minWidth?: number;
    includeDynamicBodies?: boolean;
  };
  /** Positive number maps onto CollisionWorld's `snap`. */
  snapToGround?: number | null;
  maxSlopeClimbAngle?: number;
  minSlopeSlideAngle?: number;
  applyImpulses?: boolean;
  characterMass?: number;
  slide?: boolean;
  normalNudgeFactor?: number;
}

export interface KinematicActorOptions {
  position?: VecLike | null;
  bodyOffset?: VecLike | null;
  actorCollisionMode?: KinematicActorCollisionMode | null;
  groundedProbeDistance?: number;
  colliderShape: KinematicColliderShape;
  colliderOptions?: KinematicColliderOptions;
  controllerOptions?: KinematicControllerOptions;
  basis?: WorldBasis;
}

export interface KinematicActor {
  /** Body (collider-center) position — gameplay position + physicsBodyOffset. */
  bodyPosition: Vector3;
  physicsBodyOffset: Vector3;
  basis: WorldBasis;
  up: Vector3;
  groundedProbeDistance: number;
  actorCollisionMode: KinematicActorCollisionMode | null;
  radius: number;
  halfHeight: number;
  climb: number;
  snap: number;
}

export interface KinematicMoveResult {
  position: Vector3;
  velocity: Vector3;
  correctedDelta: Vector3;
  grounded: boolean;
  blocked: boolean;
  collisions: number;
  desiredDelta: Vector3;
  startPosition: Vector3;
}

interface QueuedMove {
  actor: KinematicActor;
  startPosition: Vector3;
  desiredDelta: Vector3;
  deltaSeconds: number | undefined;
}

function capsuleDims(
  shape: KinematicColliderShape,
  basis: WorldBasis,
): { radius: number; halfHeight: number } {
  if (shape.type === "capsule") {
    // Rapier capsule half-height excludes the caps; the resolve capsule's
    // half height is the full vertical half-extent.
    return { radius: shape.radius, halfHeight: shape.halfHeight + shape.radius };
  }
  if (shape.type === "cuboid" || shape.type === "box") {
    const half = { x: shape.halfX, y: shape.halfY, z: shape.halfZ };
    const hUp = Math.abs(basis.upComponent(half));
    const hRight = Math.abs(basis.rightComponent(half));
    const hForward = Math.abs(basis.forwardComponent(half));
    return { radius: Math.max(hRight, hForward), halfHeight: hUp };
  }
  if (shape.type === "ball" || shape.type === "sphere") {
    return { radius: shape.radius, halfHeight: shape.radius };
  }
  throw new Error(
    `KinematicBatchResolver: unsupported shape type "${(shape as { type: string }).type}"`,
  );
}

export class KinematicBatchResolver {
  world: CollisionWorld;
  actorCollisionMode: KinematicActorCollisionMode;
  basis: WorldBasis;
  minDeltaSeconds: number;
  worldConfig: { basis: WorldBasis; minDeltaSeconds: number };
  actors: Set<KinematicActor>;
  queuedMoves: QueuedMove[];
  results: Map<KinematicActor, KinematicMoveResult>;

  constructor(
    world: CollisionWorld,
    {
      minDeltaSeconds = 1 / 240,
      actorCollisionMode = DEFAULT_ACTOR_COLLISION_MODE,
      basis = DEFAULT_WORLD_BASIS,
    }: {
      minDeltaSeconds?: number;
      actorCollisionMode?: KinematicActorCollisionMode;
      basis?: WorldBasis;
    } = {},
  ) {
    if (!world) {
      throw new Error("KinematicBatchResolver: world is required");
    }

    this.world = world;
    this.actorCollisionMode = actorCollisionMode;
    this.basis = basis;
    this.minDeltaSeconds = minDeltaSeconds;
    this.worldConfig = {
      basis: this.basis,
      minDeltaSeconds: this.minDeltaSeconds,
    };

    this.actors = new Set();
    this.queuedMoves = [];
    this.results = new Map();
  }

  setActorCollisionMode(mode: KinematicActorCollisionMode): void {
    this.actorCollisionMode = mode;
  }

  createActor({
    position = null,
    bodyOffset = null,
    actorCollisionMode = null,
    groundedProbeDistance = 0,
    colliderShape,
    colliderOptions = {},
    controllerOptions = {},
    basis = this.basis,
  }: KinematicActorOptions): KinematicActor {
    void colliderOptions; // accepted for API compatibility; inert in v1
    const gameplayPosition = toVec3(position);
    const physicsBodyOffset = toVec3(bodyOffset);
    // Public actor position is the gameplay anchor; the body position is
    // offset to the collider center.
    const bodyPosition = gameplayPosition.clone().add(physicsBodyOffset);

    const basisUp = basis.upVector();
    const dims = capsuleDims(colliderShape, basis);
    const autostep = controllerOptions.autostep;
    const climb = autostep?.enabled ? (autostep.maxHeight ?? 0) : 0;
    const snapToGround = controllerOptions.snapToGround;
    const snap = typeof snapToGround === "number" && snapToGround > 0 ? snapToGround : 0;

    const actor: KinematicActor = {
      bodyPosition,
      physicsBodyOffset,
      basis,
      up: toVec3(controllerOptions.up ?? basisUp, basisUp),
      groundedProbeDistance,
      actorCollisionMode,
      radius: dims.radius,
      halfHeight: dims.halfHeight,
      climb,
      snap,
    };

    this.actors.add(actor);

    return actor;
  }

  beginFrame(): void {
    this.queuedMoves.length = 0;
    this.results.clear();
  }

  syncActor(actor: KinematicActor | null | undefined, position: VecLike | null | undefined): void {
    if (!actor || !position) return;
    const bodyPosition = toVec3(position).add(actor.physicsBodyOffset);
    actor.bodyPosition.copy(bodyPosition);
  }

  queueMove(
    actor: KinematicActor,
    movement: { startPosition?: VecLike | null; desiredDelta?: VecLike | null; deltaSeconds?: number } = {},
  ): void {
    if (!actor || !this.actors.has(actor)) {
      throw new Error("KinematicBatchResolver: unknown actor handle");
    }

    this.queuedMoves.push({
      actor,
      startPosition: toVec3(movement.startPosition),
      desiredDelta: toVec3(movement.desiredDelta),
      deltaSeconds: movement.deltaSeconds,
    });
  }

  resolveQueuedMoves(
    deltaSeconds = 1 / 60,
    actorCollisionMode: KinematicActorCollisionMode = this.actorCollisionMode,
  ): Map<KinematicActor, KinematicMoveResult> {
    void deltaSeconds; // the original stepped the Rapier world here; nothing to step in v1
    const mode = actorCollisionMode;
    this.results.clear();

    if (mode === KINEMATIC_ACTOR_COLLISION_MODES.sequential) {
      for (const move of this.queuedMoves) {
        this.syncActor(move.actor, move.startPosition);
        this.results.set(move.actor, this._resolveMove(move, mode, true));
      }
      return this.results;
    }

    for (const move of this.queuedMoves) {
      this.syncActor(move.actor, move.startPosition);
    }

    const commits: { actor: KinematicActor; bodyPosition: Vector3 }[] = [];
    for (const move of this.queuedMoves) {
      const moveMode = move.actor.actorCollisionMode ?? mode;
      const result = this._resolveMove(move, moveMode, false);
      this.results.set(move.actor, result);
      commits.push({
        actor: move.actor,
        bodyPosition: result.position.clone().add(move.actor.physicsBodyOffset),
      });
    }
    // Bodies only "move" after all resolutions, matching the original's
    // deferred kinematic translations (last queued move per actor wins).
    for (const commit of commits) {
      commit.actor.bodyPosition.copy(commit.bodyPosition);
    }

    return this.results;
  }

  getResult(actor: KinematicActor): KinematicMoveResult | null {
    return this.results.get(actor) ?? null;
  }

  _resolveMove(
    move: QueuedMove,
    mode: KinematicActorCollisionMode,
    commitCurrentTranslation: boolean,
  ): KinematicMoveResult {
    const { actor, startPosition, desiredDelta, deltaSeconds } = move;
    const b = actor.basis;

    const desired = actor.bodyPosition.clone().add(desiredDelta);
    const resolved = this.world.resolveCapsule(actor.bodyPosition, desired, {
      radius: actor.radius,
      halfHeight: actor.halfHeight,
      climb: actor.climb,
      snap: actor.snap,
    });

    let collisions = resolved.hitWall ? 1 : 0;
    let grounded = resolved.grounded;
    let right = b.rightComponent(resolved.position);
    let up = b.upComponent(resolved.position);
    let forward = b.forwardComponent(resolved.position);

    if (mode !== KINEMATIC_ACTOR_COLLISION_MODES.ignoreActors) {
      // Planar circle push-out vs the other actors, registration order.
      for (const other of this.actors) {
        if (other === actor) continue;
        const oRight = b.rightComponent(other.bodyPosition);
        const oUp = b.upComponent(other.bodyPosition);
        const oForward = b.forwardComponent(other.bodyPosition);
        const feet = up - actor.halfHeight;
        const head = up + actor.halfHeight;
        const oBottom = oUp - other.halfHeight;
        const oTop = oUp + other.halfHeight;
        if (head <= oBottom + VECTOR_EPS || feet >= oTop - VECTOR_EPS) continue;

        const dRight = right - oRight;
        const dForward = forward - oForward;
        const minDist = actor.radius + other.radius;
        const distSq = dRight * dRight + dForward * dForward;
        if (distSq >= minDist * minDist) continue;

        const dist = Math.sqrt(distSq);
        const nRight = dist > VECTOR_EPS ? dRight / dist : 1;
        const nForward = dist > VECTOR_EPS ? dForward / dist : 0;
        right = oRight + nRight * minDist;
        forward = oForward + nForward * minDist;
        collisions += 1;
      }

      // Re-ground after any push-out (same climb/snap semantics as the world pass).
      const ground = this.world.groundHeightAt(right, forward);
      const feet = up - actor.halfHeight;
      if (feet <= ground + VECTOR_EPS) {
        up = ground + actor.halfHeight;
        grounded = true;
      } else if (actor.snap > 0 && feet - ground <= actor.snap) {
        up = ground + actor.halfHeight;
        grounded = true;
      }
    }

    const nextBodyPosition = b.fromBasisComponents(right, up, forward);
    const correctedDelta = nextBodyPosition.clone().sub(actor.bodyPosition);

    if (commitCurrentTranslation) {
      actor.bodyPosition.copy(nextBodyPosition);
    }

    const position = new Vector3(
      nextBodyPosition.x - actor.physicsBodyOffset.x,
      nextBodyPosition.y - actor.physicsBodyOffset.y,
      nextBodyPosition.z - actor.physicsBodyOffset.z,
    );
    const velocity =
      typeof deltaSeconds === "number" && deltaSeconds > VECTOR_EPS
        ? correctedDelta.clone().multiplyScalar(1 / deltaSeconds)
        : new Vector3();

    if (!grounded) grounded = this._queryGrounded(actor, right, up, forward);

    return {
      position,
      velocity,
      correctedDelta,
      grounded,
      blocked: collisions > 0,
      collisions,
      desiredDelta: desiredDelta.clone(),
      startPosition: startPosition.clone(),
    };
  }

  _queryGrounded(actor: KinematicActor, right: number, up: number, forward: number): boolean {
    const probeDistance = Math.max(0, actor.groundedProbeDistance);
    if (probeDistance <= 0) return false;
    const feet = up - actor.halfHeight;
    return feet - this.world.groundHeightAt(right, forward) <= probeDistance;
  }
}
