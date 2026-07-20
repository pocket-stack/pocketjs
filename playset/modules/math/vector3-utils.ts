// playset/modules/math/vector3-utils.ts — safe Vector3 coercion helpers.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/math/Vector3Utils.js. Verbatim semantics.

import { Vector3 } from "../../math/vector3.ts";
import { DEFAULT_WORLD_BASIS, type VecLike, type WorldBasis } from "./world-basis.ts";

export const VECTOR_EPS = 1e-6;

export function toVec3(
  value: VecLike | null | undefined,
  fallback: VecLike = { x: 0, y: 0, z: 0 },
): Vector3 {
  return new Vector3(
    value?.x ?? fallback.x ?? 0,
    value?.y ?? fallback.y ?? 0,
    value?.z ?? fallback.z ?? 0,
  );
}

export function toUnitVec3(
  value: VecLike | null | undefined,
  fallback: VecLike = { x: 0, y: 1, z: 0 },
): Vector3 {
  const vector = toVec3(value, fallback);
  if (vector.lengthSq() <= VECTOR_EPS * VECTOR_EPS) {
    const fallbackVector = toVec3(fallback);
    if (fallbackVector.lengthSq() <= VECTOR_EPS * VECTOR_EPS) {
      return new Vector3();
    }
    return fallbackVector.normalize();
  }
  return vector.normalize();
}

export function toPlanarUnitVec3(
  value: VecLike | null | undefined,
  fallback: VecLike = { x: 0, y: 0, z: -1 },
  basis: WorldBasis = DEFAULT_WORLD_BASIS,
): Vector3 {
  const worldBasis = basis;
  const vector = toVec3(value, fallback);
  worldBasis.flatten(vector);
  if (vector.lengthSq() > VECTOR_EPS * VECTOR_EPS) {
    return vector.normalize();
  }

  const fallbackVector = toVec3(fallback);
  worldBasis.flatten(fallbackVector);
  if (fallbackVector.lengthSq() <= VECTOR_EPS * VECTOR_EPS) {
    return new Vector3();
  }
  return fallbackVector.normalize();
}
