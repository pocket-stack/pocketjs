// playset/modules/behavior/waypoint-progress-tracker.ts — advances along a
// waypoint route once within reach distance and reports the current waypoint,
// distance, and corner profile.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/behavior/WaypointProgressTracker.js. Verbatim semantics.

import { clamp } from "../math/scalar-utils.ts";
import { DEFAULT_WORLD_BASIS, type VecLike, type WorldBasis } from "../math/world-basis.ts";

const EPS = 1e-6;

export interface PlainWaypoint {
  x?: number;
  y?: number;
  z?: number;
}

export interface WaypointProgress {
  currentIndex: number;
  currentWaypoint: PlainWaypoint;
  distanceToCurrent: number;
  cornerSign: number;
  cornerMagnitude: number;
  waypointCount: number;
}

export interface WaypointProgressTrackerOptions {
  waypoints?: readonly VecLike[];
  reachDistance?: number;
  closed?: boolean;
  basis?: WorldBasis;
}

function wrapIndex(index: number, len: number): number {
  if (len <= 0) return 0;
  return ((index % len) + len) % len;
}

function distanceSqPlanar(a: VecLike, b: VecLike, basis: WorldBasis): number {
  return basis.distanceSqPlanar(a, b);
}

function normalizePlanar(dRight: number, dForward: number): { right: number; forward: number; len: number } {
  const len = Math.hypot(dRight, dForward);
  if (len < EPS) return { right: 0, forward: 0, len: 0 };
  return { right: dRight / len, forward: dForward / len, len };
}

function planarDelta(from: VecLike, to: VecLike, basis: WorldBasis): { right: number; forward: number; len: number } {
  const fromPlanar = basis.toPlanar(from);
  const toPlanar = basis.toPlanar(to);
  const dRight = toPlanar.right - fromPlanar.right;
  const dForward = toPlanar.forward - fromPlanar.forward;
  return normalizePlanar(dRight, dForward);
}

function asPlainWaypoint(point: VecLike): PlainWaypoint {
  return {
    x: point.x,
    y: point.y,
    z: point.z,
  };
}

function resolveStepIndex(index: number, step: number, count: number, closed: boolean): number {
  if (closed) return wrapIndex(index + step, count);
  return clamp(index + step, 0, count - 1);
}

function cornerProfile(
  waypoints: readonly PlainWaypoint[],
  index: number,
  closed: boolean,
  basis: WorldBasis,
): { sign: number; magnitude: number } {
  const count = waypoints.length;
  if (count < 3) {
    return { sign: 0, magnitude: 0 };
  }

  const prevIndex = resolveStepIndex(index, -1, count, closed);
  const nextIndex = resolveStepIndex(index, 1, count, closed);
  if (!closed && (prevIndex === index || nextIndex === index)) {
    return { sign: 0, magnitude: 0 };
  }

  const prev = waypoints[prevIndex];
  const curr = waypoints[index];
  const next = waypoints[nextIndex];

  const inDir = planarDelta(prev, curr, basis);
  const outDir = planarDelta(curr, next, basis);
  if (inDir.len < EPS || outDir.len < EPS) {
    return { sign: 0, magnitude: 0 };
  }

  const planarCross = inDir.right * outDir.forward - inDir.forward * outDir.right;
  const dot = clamp(inDir.right * outDir.right + inDir.forward * outDir.forward, -1, 1);
  return {
    sign: Math.sign(planarCross || 1),
    magnitude: Math.acos(dot),
  };
}

export class WaypointProgressTracker {
  reachDistance: number;
  closed: boolean;
  basis: WorldBasis;
  waypoints: PlainWaypoint[];
  currentIndex: number;
  initialized: boolean;
  last: WaypointProgress | null;

  constructor({
    waypoints = [],
    reachDistance = 4,
    closed = true,
    basis = DEFAULT_WORLD_BASIS,
  }: WaypointProgressTrackerOptions) {
    this.reachDistance = reachDistance;
    this.closed = closed !== false;
    this.basis = basis;

    this.waypoints = [];
    this.currentIndex = 0;
    this.initialized = false;
    this.last = null;

    this.setWaypoints(waypoints);
  }

  setWaypoints(waypoints: readonly VecLike[] = []): void {
    this.waypoints = Array.isArray(waypoints)
      ? waypoints
          .filter((p) => this.basis.hasWorldPlanarComponents(p))
          .map((p) => asPlainWaypoint(p))
      : [];

    this.currentIndex = 0;
    this.initialized = false;
    this.last = null;
  }

  reset(startIndex = 0): void {
    const count = this.waypoints.length;
    this.currentIndex = count > 0 ? wrapIndex(startIndex, count) : 0;
    this.initialized = count > 0;
    this.last = null;
  }

  private _findNearestGlobal(position: VecLike): number {
    let bestIndex = 0;
    let bestDistSq = Infinity;

    for (let i = 0; i < this.waypoints.length; i += 1) {
      const distSq = distanceSqPlanar(position, this.waypoints[i], this.basis);
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestIndex = i;
      }
    }

    return bestIndex;
  }

  private _advance(index: number, step: number): number {
    return resolveStepIndex(index, step, this.waypoints.length, this.closed);
  }

  step(position: VecLike | null | undefined): WaypointProgress | null {
    const count = this.waypoints.length;
    if (count === 0 || !position) {
      this.last = null;
      return null;
    }

    let currentIndex = this.initialized ? this.currentIndex : this._findNearestGlobal(position);
    this.initialized = true;

    let distanceToCurrent = Math.sqrt(
      distanceSqPlanar(position, this.waypoints[currentIndex], this.basis),
    );
    if (distanceToCurrent <= this.reachDistance && (this.closed || currentIndex < count - 1)) {
      currentIndex = this._advance(currentIndex, 1);
      distanceToCurrent = Math.sqrt(
        distanceSqPlanar(position, this.waypoints[currentIndex], this.basis),
      );
    }

    this.currentIndex = currentIndex;

    const corner = cornerProfile(this.waypoints, currentIndex, this.closed, this.basis);

    this.last = {
      currentIndex,
      currentWaypoint: this.waypoints[currentIndex],
      distanceToCurrent,
      cornerSign: corner.sign,
      cornerMagnitude: corner.magnitude,
      waypointCount: count,
    };

    return { ...this.last };
  }

  snapshot(): {
    currentIndex: number;
    initialized: boolean;
    waypointCount: number;
    last: WaypointProgress | null;
  } {
    return {
      currentIndex: this.currentIndex,
      initialized: this.initialized,
      waypointCount: this.waypoints.length,
      last: this.last ? { ...this.last } : null,
    };
  }
}
