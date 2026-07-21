// playset/sim/collider-sink.ts — records the colliders an environment builds
// into the batched payload `SimOps.collidersAdd` wants.
//
// The ported environments (`RaceTrackEnvironment`, `NaturalEnvironment`, …)
// populate physics by calling `world.addCuboid/addCylinder/addBall` and
// `world.setTerrain` on a `CollisionWorld`. On the native path there is no TS
// CollisionWorld to populate — the colliders live in the Rust core — but the
// environments must keep working UNCHANGED, because they are the shared
// GameBlocks ports and the TS path still uses them.
//
// So this is a recorder wearing the CollisionWorld's clothes: it accepts the
// same calls, hands back the same ascending handles, and accumulates two flat
// arrays the mount ships across in one op. The environment never learns which
// path it is on.

import type { VecLike } from "../modules/math/world-basis.ts";
import type {
  BallDesc,
  ColliderHandle,
  CollisionWorld,
  CuboidDesc,
  CylinderDesc,
  TerrainLike,
} from "../modules/physics/collision-world.ts";
import { COLLIDER_KIND, COLLIDER_SOLID, COLLIDER_STRIDE, COLLIDER_WALKABLE } from "./ops.ts";

/** VecLike components are optional; a missing axis is 0, as CollisionWorld reads them. */
function num(v: number | undefined): number {
  return v ?? 0;
}

/** Yaw-only planar heading of a quaternion, matching CollisionWorld v1. */
function planarYaw(q: { x: number; y: number; z: number; w: number } | undefined): number {
  if (!q) return 0;
  // Rotate the basis forward axis (0, 0, -1) and read its heading. Expanded
  // by hand: the sim is the only consumer and a Vector3 round-trip here would
  // pull the whole math package into the boot path for one number.
  const fx = 2 * (q.x * q.z + q.w * q.y) * -1;
  const fz = (1 - 2 * (q.x * q.x + q.y * q.y)) * -1;
  const right = fx;
  const forward = -fz;
  if (right * right + forward * forward <= 1e-12) return 0;
  return Math.atan2(-right, forward);
}

export class ColliderSink {
  readonly kinds: number[] = [];
  readonly data: number[] = [];
  /** The terrain sampler the environment installed (config source for `ps`). */
  terrain: TerrainLike | null = null;
  private nextHandle = 1;

  get count(): number {
    return this.kinds.length;
  }

  setTerrain(sampler: TerrainLike | null): void {
    this.terrain = sampler;
  }

  addCuboid(desc: CuboidDesc): ColliderHandle {
    const h = desc.halfExtents;
    return this.push(
      COLLIDER_KIND.cuboid,
      desc.position,
      [Math.abs(num(h.x)), Math.abs(num(h.y)), Math.abs(num(h.z))],
      planarYaw(desc.quaternion),
      desc,
    );
  }

  addCylinder(desc: CylinderDesc): ColliderHandle {
    return this.push(COLLIDER_KIND.cylinder, desc.position, [desc.radius, desc.halfHeight, 0], 0, desc);
  }

  addBall(desc: BallDesc): ColliderHandle {
    return this.push(COLLIDER_KIND.ball, desc.position, [desc.radius, 0, 0], 0, desc);
  }

  /** Handles are accepted back but nothing removes colliders on this path. */
  remove(): void {}

  clear(): void {
    this.kinds.length = 0;
    this.data.length = 0;
    this.nextHandle = 1;
  }

  toKinds(): Uint32Array {
    return Uint32Array.from(this.kinds);
  }

  toData(): Float32Array {
    return Float32Array.from(this.data);
  }

  /** Structural cast: environments type their argument as CollisionWorld. */
  asWorld(): CollisionWorld {
    return this as unknown as CollisionWorld;
  }

  private push(
    kind: number,
    position: VecLike,
    dims: [number, number, number],
    yaw: number,
    opts: { solid?: boolean; walkable?: boolean },
  ): ColliderHandle {
    let flags = 0;
    if (opts.solid ?? true) flags |= COLLIDER_SOLID;
    if (opts.walkable ?? false) flags |= COLLIDER_WALKABLE;
    this.kinds.push(kind);
    this.data.push(
      num(position.x),
      num(position.y),
      num(position.z),
      dims[0],
      dims[1],
      dims[2],
      yaw,
      flags,
    );
    if (this.data.length !== this.kinds.length * COLLIDER_STRIDE) {
      throw new Error("ColliderSink: collider stride drift");
    }
    return this.nextHandle++;
  }
}
