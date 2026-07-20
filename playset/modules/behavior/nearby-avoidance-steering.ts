// playset/modules/behavior/nearby-avoidance-steering.ts — planar steering
// away from nearby agents while preserving intended travel direction.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/behavior/NearbyAvoidanceSteering.js. Verbatim semantics.

import { Vector3 } from "../../math/index.ts";
import { toVec3 } from "../math/vector3-utils.ts";
import { DEFAULT_WORLD_BASIS, type VecLike, type WorldBasis } from "../math/world-basis.ts";

const EPS = 1e-6;

/** A neighbor is either a positioned entity or a bare position. */
export type NeighborLike = { position?: VecLike | null } | VecLike | null | undefined;

export interface NearbyAvoidanceSteeringOptions {
  neighborDistance?: number;
  separationWeight?: number;
  sideStepWeight?: number;
  maxSteering?: number;
  blockerDot?: number;
  basis?: WorldBasis;
}

export interface AvoidanceStepInput {
  selfPosition: VecLike;
  neighbors?: readonly NeighborLike[];
  desiredDirection?: VecLike | null;
  preferredDirection?: number;
  self?: unknown;
}

export interface AvoidanceResult {
  steering: Vector3;
  blockers: number;
  blocked: boolean;
}

export class NearbyAvoidanceSteering {
  neighborDistance: number;
  separationWeight: number;
  sideStepWeight: number;
  maxSteering: number;
  blockerDot: number;
  basis: WorldBasis;
  private _toNeighbor: Vector3;
  private _side: Vector3;
  private _away: Vector3;
  private _desired: Vector3;

  constructor({
    neighborDistance = 2.5,
    separationWeight = 1.2,
    sideStepWeight = 0.8,
    maxSteering = 2.5,
    blockerDot = 0.75,
    basis = DEFAULT_WORLD_BASIS,
  }: NearbyAvoidanceSteeringOptions) {
    this.neighborDistance = neighborDistance;
    this.separationWeight = separationWeight;
    this.sideStepWeight = sideStepWeight;
    this.maxSteering = maxSteering;
    this.blockerDot = blockerDot;
    this.basis = basis;
    this._toNeighbor = new Vector3();
    this._side = new Vector3();
    this._away = new Vector3();
    this._desired = new Vector3();
  }

  step({
    selfPosition,
    neighbors = [],
    desiredDirection = null,
    preferredDirection = 1,
    self = null,
  }: AvoidanceStepInput): AvoidanceResult {
    const steering = new Vector3(0, 0, 0);
    const resolvedSelfPosition = toVec3(selfPosition);

    this._desired.copy(toVec3(desiredDirection));
    this.basis.flatten(this._desired);
    if (this._desired.lengthSq() > EPS * EPS) this._desired.normalize();

    let blockers = 0;
    const maxDistance = Math.max(EPS, this.neighborDistance);

    for (const other of neighbors) {
      if (other === self) continue;

      const otherPos =
        ((other as { position?: VecLike | null } | null | undefined)?.position ?? other) as
          | VecLike
          | null
          | undefined;
      if (!otherPos) continue;

      // subVectors only reads x/y/z, so bare positions work (as in the original).
      this._toNeighbor.subVectors(resolvedSelfPosition, otherPos as Vector3);
      this.basis.flatten(this._toNeighbor);
      const distance = this._toNeighbor.length();
      if (distance <= EPS || distance > maxDistance) continue;

      const push = 1 - distance / maxDistance;
      const invDistance = 1 / Math.max(EPS, distance);

      this._away.copy(this._toNeighbor).multiplyScalar(invDistance * push * this.separationWeight);
      steering.add(this._away);

      this.basis
        .sideVector(this._toNeighbor, preferredDirection, this._side)
        .multiplyScalar(invDistance);
      if (this._side.lengthSq() > EPS * EPS) {
        this._side.normalize().multiplyScalar(push * this.sideStepWeight);
        steering.add(this._side);
      }

      if (this._desired.lengthSq() > EPS * EPS) {
        const desiredDot = Math.abs(this._toNeighbor.multiplyScalar(invDistance).dot(this._desired));
        if (desiredDot > this.blockerDot) blockers += 1;
      }
    }

    if (steering.lengthSq() > this.maxSteering * this.maxSteering) {
      steering.setLength(this.maxSteering);
    }

    return {
      steering,
      blockers,
      blocked: blockers > 0,
    };
  }
}
