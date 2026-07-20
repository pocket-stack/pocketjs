// playset/modules/gameplay/aim-resolver.ts — crosshair-to-world aim
// resolution: turns a camera ray (or an explicit aim ray) into hit point,
// launch position, and shooting direction.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/gameplay/AimResolver.js.
//
// DELIBERATE API DEVIATION — playset has no scene raycasting (the
// presentation surface is write-only), so picking runs against gameplay
// colliders instead of THREE.Raycaster over Object3D lists:
//   - `camera` is anything with `position` + `rayFromNdc(ndcX, ndcY)`
//     (scene3d's Camera3D fits structurally; this module does not import
//     scene3d). `rayFromNdc` replaces Raycaster.setFromCamera.
//   - `objects: Object3D[]` + `recursive` are replaced by two pick sources:
//     `world?: CollisionWorld` (collider raycast) and `targets?: Array<{
//     position, radius, tag? }>` (analytic ray-vs-sphere, front surface,
//     matching CollisionWorld's sphere test). The NEAREST hit across BOTH
//     sources wins — same nearest-intersection pick as the original, with
//     the original's near=0 / far=maxDistance+|aimOrigin→launch| window.
//   - The result keeps the original shape and field names (aimOrigin,
//     aimDirection, launchPosition, hitPosition, shootingDirection, hasHit,
//     maxDistance, aimRayDistance, launchDistanceToHit), with `hit` now
//     `{ distance, point, tag } | null` and `targetObject` renamed `target`:
//     the matched targets[] entry, or the hit collider's tag — the original's
//     parent-walk over Object3D ancestors has no collider equivalent.
// The virtual-point fallback (no hit → point at aimRayDistance along the aim
// ray) and the launch≈hit epsilon fallback (shootingDirection = aimDirection
// when |launch→hit| ≤ 1e-6) are preserved verbatim.

import { Vector3 } from "../../math/index.ts";
import { toVec3 } from "../math/vector3-utils.ts";
import { DEFAULT_WORLD_BASIS, type VecLike, type WorldBasis } from "../math/world-basis.ts";
import type { CollisionWorld } from "../physics/collision-world.ts";

const EPS = 1e-6;
const CENTER_NDC: Readonly<{ x: number; y: number }> = Object.freeze({ x: 0, y: 0 });

/** Structural camera contract (scene3d Camera3D satisfies it). */
export interface AimCamera {
  position: VecLike;
  rayFromNdc(ndcX: number, ndcY: number, target?: Vector3): Vector3;
}

export interface AimTarget {
  position: VecLike;
  radius: number;
  tag?: unknown;
}

export interface AimHit {
  distance: number;
  point: Vector3;
  tag: unknown;
}

export interface AimResult {
  aimOrigin: Vector3;
  aimDirection: Vector3;
  launchPosition: Vector3;
  hitPosition: Vector3;
  shootingDirection: Vector3;
  hasHit: boolean;
  hit: AimHit | null;
  /** The matched targets[] entry, or the hit collider's tag (null if none). */
  target: unknown;
  maxDistance: number;
  aimRayDistance: number;
  launchDistanceToHit: number;
}

export interface AimResolverOptions {
  maxDistance?: number;
  basis?: WorldBasis;
}

export interface AimFromCameraOptions {
  camera: AimCamera;
  crosshairNdc?: { x: number; y: number };
  launchPosition: VecLike;
  world?: CollisionWorld | null;
  targets?: AimTarget[];
  maxDistance?: number;
}

export interface AimFromAimRayOptions {
  aimOrigin: VecLike;
  aimDirection: VecLike;
  launchPosition: VecLike;
  world?: CollisionWorld | null;
  targets?: AimTarget[];
  maxDistance?: number;
}

/** Front-surface ray-vs-sphere (same convention as CollisionWorld). */
function raySphereDistance(origin: Vector3, direction: Vector3, target: AimTarget, far: number): number | null {
  const center = toVec3(target.position);
  const oc = origin.clone().sub(center);
  const b = oc.dot(direction);
  const c = oc.lengthSq() - target.radius * target.radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 && t <= far ? t : null;
}

export class AimResolver {
  basis: WorldBasis;
  maxDistance: number;

  constructor({ maxDistance = 1000, basis = DEFAULT_WORLD_BASIS }: AimResolverOptions) {
    this.basis = basis;
    this.maxDistance = maxDistance;
  }

  getAimDirection(camera: AimCamera, crosshairNdc: { x: number; y: number } = CENTER_NDC): Vector3 {
    return camera.rayFromNdc(crosshairNdc.x, crosshairNdc.y).normalize();
  }

  getAimFromCamera({
    camera,
    crosshairNdc = CENTER_NDC,
    launchPosition,
    world = null,
    targets = [],
    maxDistance = this.maxDistance,
  }: AimFromCameraOptions): AimResult {
    return this._resolveAim({
      aimOrigin: toVec3(camera.position),
      aimDirection: camera.rayFromNdc(crosshairNdc.x, crosshairNdc.y).normalize(),
      launchPosition,
      world,
      targets,
      maxDistance,
    });
  }

  getAimFromAimRay({
    aimOrigin,
    aimDirection,
    launchPosition,
    world = null,
    targets = [],
    maxDistance = this.maxDistance,
  }: AimFromAimRayOptions): AimResult {
    return this._resolveAim({
      aimOrigin: toVec3(aimOrigin),
      aimDirection: this._normalizeAimDirection(aimDirection),
      launchPosition,
      world,
      targets,
      maxDistance,
    });
  }

  private _resolveAim({
    aimOrigin,
    aimDirection,
    launchPosition,
    world,
    targets,
    maxDistance,
  }: {
    aimOrigin: Vector3;
    aimDirection: Vector3;
    launchPosition: VecLike;
    world: CollisionWorld | null;
    targets: AimTarget[];
    maxDistance: number;
  }): AimResult {
    const launch = toVec3(launchPosition);
    const aimRayDistance = maxDistance + aimOrigin.distanceTo(launch);
    const intersect = this._intersectAimRay(aimOrigin, aimDirection, world, targets, aimRayDistance);
    const hit = intersect ? intersect.hit : null;

    const hitPosition = hit
      ? hit.point.clone()
      : aimOrigin.clone().addScaledVector(aimDirection, aimRayDistance);

    const launchToHit = hitPosition.clone().sub(launch);
    const launchDistanceToHit = launchToHit.length();
    const shootingDirection =
      launchDistanceToHit > EPS ? launchToHit.multiplyScalar(1 / launchDistanceToHit) : aimDirection.clone();

    return {
      aimOrigin: aimOrigin,
      aimDirection: aimDirection,
      launchPosition: launch,
      hitPosition,
      shootingDirection,
      hasHit: Boolean(hit),
      hit,
      target: intersect ? intersect.target : null,
      maxDistance,
      aimRayDistance,
      launchDistanceToHit,
    };
  }

  private _normalizeAimDirection(aimDirection: VecLike): Vector3 {
    const direction = toVec3(aimDirection);
    if (direction.lengthSq() <= EPS * EPS) {
      throw new TypeError("AimResolver: aimDirection must be non-zero");
    }
    return direction.normalize();
  }

  private _intersectAimRay(
    origin: Vector3,
    direction: Vector3,
    world: CollisionWorld | null,
    targets: AimTarget[],
    far: number,
  ): { hit: AimHit; target: unknown } | null {
    let best: { hit: AimHit; target: unknown } | null = null;

    if (world) {
      const worldHit = world.raycast(origin, direction, far);
      if (worldHit) {
        best = {
          hit: { distance: worldHit.distance, point: worldHit.point, tag: worldHit.tag },
          target: worldHit.tag,
        };
      }
    }

    for (const target of targets) {
      const t = raySphereDistance(origin, direction, target, far);
      if (t === null) continue;
      if (best !== null && t >= best.hit.distance) continue;
      best = {
        hit: {
          distance: t,
          point: origin.clone().addScaledVector(direction, t),
          tag: target.tag ?? null,
        },
        target,
      };
    }

    return best;
  }
}
