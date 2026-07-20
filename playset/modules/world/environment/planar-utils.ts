// playset/modules/world/environment/planar-utils.ts — planar (right/forward)
// path helpers shared by the environments: tangents, centroids, terrain
// height lookups.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/environment/PlanarUtils.js. Verbatim semantics.

import { DEFAULT_WORLD_BASIS, type WorldBasis } from "../../math/world-basis.ts";

export const PLANAR_EPS = 1e-6;

export interface PlanarPoint {
  right: number;
  forward: number;
}

/** The duck-typed sampler shape PlanarUtils accepts (heightAt or sample). */
export interface TerrainSamplerLike {
  basis?: WorldBasis;
  heightAt?(right: number, forward: number): number;
  sample?(right: number, forward: number): { height?: number } | null | undefined;
}

export function terrainBasis(terrainSampler: TerrainSamplerLike | null | undefined): WorldBasis {
  return terrainSampler?.basis ?? DEFAULT_WORLD_BASIS;
}

export function basisFromLayout(
  layout: { basis?: WorldBasis } | null | undefined,
  terrainSampler: TerrainSamplerLike | null = null,
): WorldBasis {
  return layout?.basis ?? terrainSampler?.basis ?? DEFAULT_WORLD_BASIS;
}

export function terrainHeight(
  terrainSampler: TerrainSamplerLike | null | undefined,
  planarPoint: PlanarPoint,
): number {
  if (typeof terrainSampler?.heightAt === "function") {
    return terrainSampler.heightAt(planarPoint.right, planarPoint.forward);
  }
  if (typeof terrainSampler?.sample === "function") {
    return terrainSampler.sample(planarPoint.right, planarPoint.forward)?.height ?? 0;
  }
  return 0;
}

export function normalizePlanar2D(
  right: number,
  forward: number,
  fallback: PlanarPoint = { right: 0, forward: 1 },
  epsilon = PLANAR_EPS,
): PlanarPoint {
  const length = Math.hypot(right, forward);
  if (length < epsilon) return { ...fallback };
  return { right: right / length, forward: forward / length };
}

export function planarCentroid(points: readonly PlanarPoint[]): PlanarPoint {
  let right = 0;
  let forward = 0;
  for (const point of points) {
    right += point.right;
    forward += point.forward;
  }
  return {
    right: points.length > 0 ? right / points.length : 0,
    forward: points.length > 0 ? forward / points.length : 0,
  };
}

export interface PlanarTangentOptions {
  fallback?: PlanarPoint;
  retryFromCurrent?: boolean;
  epsilon?: number;
}

export function planarTangentAt(
  points: readonly PlanarPoint[],
  index: number,
  closed: boolean,
  {
    fallback = { right: 0, forward: 1 },
    retryFromCurrent = false,
    epsilon = PLANAR_EPS,
  }: PlanarTangentOptions = {},
): PlanarPoint {
  const count = points.length;
  if (count < 2) return { ...fallback };

  const prevIndex = closed ? (index - 1 + count) % count : Math.max(0, index - 1);
  const nextIndex = closed ? (index + 1) % count : Math.min(count - 1, index + 1);
  const prev = points[prevIndex];
  const next = points[nextIndex];
  let right = next.right - prev.right;
  let forward = next.forward - prev.forward;

  if (retryFromCurrent && Math.hypot(right, forward) < epsilon) {
    right = next.right - points[index].right;
    forward = next.forward - points[index].forward;
  }

  return normalizePlanar2D(right, forward, fallback, epsilon);
}
