// playset/modules/behavior/agent-path-navigator.ts — converts position and
// current waypoint into planar movement intent (direction, desired speed with
// arrival slowdown, distance).
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/behavior/AgentPathNavigator.js. Verbatim semantics.

import { Vector3 } from "../../math/index.ts";
import { clamp } from "../math/scalar-utils.ts";
import { toVec3 } from "../math/vector3-utils.ts";
import { DEFAULT_WORLD_BASIS, type VecLike, type WorldBasis } from "../math/world-basis.ts";

const EPS = 1e-6;

export interface NavigationIntent {
  waypoint: Vector3 | null;
  direction: Vector3;
  desiredSpeed: number;
  distance: number;
}

export interface AgentPathNavigatorOptions {
  maxSpeed?: number;
  minSpeed?: number;
  arriveRadius?: number;
  basis?: WorldBasis;
}

export interface AgentPathNavigatorStepInput {
  position?: VecLike | null;
  waypoint?: VecLike | null;
  movementEnabled?: boolean;
  maxSpeed?: number;
}

function neutralIntent({ waypoint = null }: { waypoint?: VecLike | null }): NavigationIntent {
  const target = waypoint ? toVec3(waypoint) : null;
  return {
    waypoint: target ? target.clone() : null,
    direction: new Vector3(0, 0, 0),
    desiredSpeed: 0,
    distance: 0,
  };
}

export class AgentPathNavigator {
  maxSpeed: number;
  minSpeed: number;
  arriveRadius: number;
  basis: WorldBasis;
  last: NavigationIntent | null;

  constructor({
    maxSpeed = 3.5,
    minSpeed = 0,
    arriveRadius = 1.25,
    basis = DEFAULT_WORLD_BASIS,
  }: AgentPathNavigatorOptions) {
    this.maxSpeed = maxSpeed;
    this.minSpeed = minSpeed;
    this.arriveRadius = arriveRadius;
    this.basis = basis;
    this.last = null;
  }

  reset(): void {
    this.last = null;
  }

  step({
    position = null,
    waypoint = null,
    movementEnabled = true,
    maxSpeed = this.maxSpeed,
  }: AgentPathNavigatorStepInput): NavigationIntent {
    if (movementEnabled === false || !position || !waypoint) {
      this.last = neutralIntent({ waypoint });
      return this.last;
    }

    const target = toVec3(waypoint);
    const toTarget = target.clone().sub(toVec3(position));
    this.basis.flatten(toTarget);

    const distance = toTarget.length();
    if (distance <= EPS) {
      this.last = neutralIntent({ waypoint: target });
      return this.last;
    }

    const speedLimit = Math.max(0, maxSpeed);
    const arrivalScale = this.arriveRadius > EPS ? clamp(distance / this.arriveRadius, 0, 1) : 1;
    const desiredSpeed = clamp(
      speedLimit * arrivalScale,
      Math.max(0, Math.min(this.minSpeed, speedLimit)),
      speedLimit,
    );

    this.last = {
      waypoint: target.clone(),
      direction: toTarget.multiplyScalar(1 / distance),
      desiredSpeed,
      distance,
    };

    return this.last;
  }
}
