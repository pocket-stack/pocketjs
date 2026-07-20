// playset/modules/world/environment/world-bounds-collider-factory.ts — four
// static wall colliders fencing a rectangular playable area.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/environment/WorldBoundsColliderFactory.js.
// Deliberate changes: the injected Rapier `world`+`rapier` pair becomes a
// CollisionWorld, each wall is one addCuboid (solid), and the return value
// is the collider handles instead of {body, collider} pairs. friction and
// restitution are accepted for API compatibility but have no CollisionWorld
// analog.

import {
  DEFAULT_WORLD_BASIS,
  type WorldBasis,
} from "../../math/world-basis.ts";
import type { CollisionWorld, ColliderHandle } from "../../physics/collision-world.ts";

export interface CreateWorldBoundsCollidersOptions {
  world: CollisionWorld;
  minRight?: number;
  maxRight?: number;
  minForward?: number;
  maxForward?: number;
  wallThickness?: number;
  wallHeight?: number;
  centerUp?: number;
  /** Accepted for API compatibility; ignored (see header). */
  friction?: number;
  /** Accepted for API compatibility; ignored (see header). */
  restitution?: number;
  basis?: WorldBasis;
}

export function createWorldBoundsColliders({
  world,
  minRight = -88,
  maxRight = 88,
  minForward = -88,
  maxForward = 88,
  wallThickness = 1.6,
  wallHeight = 16,
  centerUp = 0,
  friction = 1,
  restitution = 0,
  basis = DEFAULT_WORLD_BASIS,
}: CreateWorldBoundsCollidersOptions): ColliderHandle[] {
  void friction;
  void restitution;
  if (!world) {
    throw new Error("World bounds collider factory requires a CollisionWorld");
  }
  if (!(maxRight > minRight) || !(maxForward > minForward)) {
    throw new Error("createWorldBoundsColliders: min bounds must be smaller than max bounds");
  }

  const worldBasis = basis;
  const rotation = worldBasis.threeObjectCanonicalToBasisQuaternion();
  const spanRight = maxRight - minRight;
  const spanForward = maxForward - minForward;
  const centerRight = (minRight + maxRight) * 0.5;
  const centerForward = (minForward + maxForward) * 0.5;

  const walls = [
    {
      right: minRight - wallThickness * 0.5,
      forward: centerForward,
      spanRight: wallThickness,
      spanForward: spanForward + wallThickness,
    },
    {
      right: maxRight + wallThickness * 0.5,
      forward: centerForward,
      spanRight: wallThickness,
      spanForward: spanForward + wallThickness,
    },
    {
      right: centerRight,
      forward: minForward - wallThickness * 0.5,
      spanRight: spanRight + wallThickness,
      spanForward: wallThickness,
    },
    {
      right: centerRight,
      forward: maxForward + wallThickness * 0.5,
      spanRight: spanRight + wallThickness,
      spanForward: wallThickness,
    },
  ];

  return walls.map((wall) => {
    const position = worldBasis.fromBasisComponents(wall.right, centerUp, wall.forward);
    const halfExtents = worldBasis.fromBasisComponents(
      wall.spanRight * 0.5,
      wallHeight * 0.5,
      wall.spanForward * 0.5,
    );
    return world.addCuboid({
      position,
      halfExtents,
      quaternion: rotation,
      solid: true,
    });
  });
}
