// playset/modules/behavior/waypoint-driver.ts — converts waypoint, vehicle
// pose, speed, and corner profile into AI car controls (throttle, reverse,
// brake, steering, boost) with stuck detection and reverse recovery.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/behavior/WaypointDriver.js. Verbatim semantics.

import { clamp } from "../math/scalar-utils.ts";
import { DEFAULT_WORLD_BASIS, type VecLike, type WorldBasis } from "../math/world-basis.ts";

const EPS = 1e-6;

interface PlanarDirection {
  right: number;
  forward: number;
}

export interface WaypointDriverControls {
  throttle: boolean;
  reverse: boolean;
  left: boolean;
  right: boolean;
  brake: boolean;
  boost: boolean;
}

export interface WaypointDriverResult extends WaypointDriverControls {
  desiredSpeed: number;
  yawError: number;
  speedError: number;
  steerIntent: number;
}

export interface WaypointDriverOptions {
  targetSpeed?: number;
  minSpeed?: number;
  cornerSlowdown?: number;
  steerGain?: number;
  steerDeadzone?: number;
  brakeYawThreshold?: number;
  accelerateSpeedError?: number;
  brakeSpeedError?: number;
  stuckSpeed?: number;
  stuckYawThreshold?: number;
  stuckTimeMs?: number;
  reverseTimeMs?: number;
  basis?: WorldBasis;
}

export interface WaypointDriverStepInput {
  position?: VecLike | null;
  yaw?: number;
  speed?: number;
  waypoint?: VecLike | null;
  cornerMagnitude?: number;
  steerBias?: number;
  raceStarted?: boolean;
  deltaSeconds?: number;
}

function resolveForward(yaw: number, basis: WorldBasis): PlanarDirection {
  const forward = basis.yawPitchRollFrame(yaw).forward;
  const planar = basis.toPlanar(forward);
  const len = Math.hypot(planar.right, planar.forward);
  if (len > EPS) {
    return { right: planar.right / len, forward: planar.forward / len };
  }
  return { right: 0, forward: 0 };
}

function directionToTarget(
  from: VecLike,
  target: VecLike,
  basis: WorldBasis = DEFAULT_WORLD_BASIS,
): PlanarDirection & { len: number } {
  const delta = basis.planarDelta(target, from);
  const dRight = delta.right;
  const dForward = delta.forward;
  const len = Math.hypot(dRight, dForward);
  if (len < EPS) return { right: 0, forward: 0, len: 0 };
  return { right: dRight / len, forward: dForward / len, len };
}

function signedYawError(forward: PlanarDirection, desired: PlanarDirection): number {
  const dot = clamp(forward.right * desired.right + forward.forward * desired.forward, -1, 1);
  const rightTurnCross = forward.forward * desired.right - forward.right * desired.forward;
  const angle = Math.acos(dot);
  return angle * Math.sign(rightTurnCross || 1);
}

function neutralControls(): WaypointDriverControls {
  return {
    throttle: false,
    reverse: false,
    left: false,
    right: false,
    brake: true,
    boost: false,
  };
}

export class WaypointDriver {
  targetSpeed: number;
  minSpeed: number;
  cornerSlowdown: number;
  steerGain: number;
  steerDeadzone: number;
  brakeYawThreshold: number;
  accelerateSpeedError: number;
  brakeSpeedError: number;
  stuckSpeed: number;
  stuckYawThreshold: number;
  stuckTimeMs: number;
  reverseTimeMs: number;
  basis: WorldBasis;
  stuckMs: number;
  reverseRemainingMs: number;
  last: WaypointDriverResult | null;

  constructor({
    targetSpeed = 32,
    minSpeed = 4,
    cornerSlowdown = 16,
    steerGain = 2.4,
    steerDeadzone = 0.12,
    brakeYawThreshold = 0.88,
    accelerateSpeedError = 0.4,
    brakeSpeedError = -0.9,
    stuckSpeed = 0.35,
    stuckYawThreshold = 1.35,
    stuckTimeMs = 900,
    reverseTimeMs = 420,
    basis = DEFAULT_WORLD_BASIS,
  }: WaypointDriverOptions) {
    this.targetSpeed = targetSpeed;
    this.minSpeed = minSpeed;
    this.cornerSlowdown = cornerSlowdown;
    this.steerGain = steerGain;
    this.steerDeadzone = steerDeadzone;
    this.brakeYawThreshold = brakeYawThreshold;
    this.accelerateSpeedError = accelerateSpeedError;
    this.brakeSpeedError = brakeSpeedError;

    this.stuckSpeed = stuckSpeed;
    this.stuckYawThreshold = stuckYawThreshold;
    this.stuckTimeMs = stuckTimeMs;
    this.reverseTimeMs = reverseTimeMs;
    this.basis = basis;

    this.stuckMs = 0;
    this.reverseRemainingMs = 0;
    this.last = null;
  }

  reset(): void {
    this.stuckMs = 0;
    this.reverseRemainingMs = 0;
    this.last = null;
  }

  step({
    position = null,
    yaw = 0,
    speed = 0,
    waypoint = null,
    cornerMagnitude = 0,
    steerBias = 0,
    raceStarted = true,
    deltaSeconds = 1 / 60,
  }: WaypointDriverStepInput): WaypointDriverResult {
    const dtMs = Math.max(0, deltaSeconds * 1000);

    if (raceStarted === false || !waypoint || !position) {
      const controls = neutralControls();
      this.last = {
        ...controls,
        desiredSpeed: 0,
        yawError: 0,
        speedError: 0,
        steerIntent: 0,
      };
      return this.last;
    }

    const forward = resolveForward(yaw, this.basis);
    const toTarget = directionToTarget(position, waypoint, this.basis);

    if (toTarget.len < EPS) {
      const controls = neutralControls();
      this.last = {
        ...controls,
        desiredSpeed: 0,
        yawError: 0,
        speedError: 0,
        steerIntent: 0,
      };
      return this.last;
    }

    const yawError = signedYawError(forward, toTarget);
    const steerIntent = clamp(yawError * this.steerGain + steerBias, -1, 1);

    const cornerPenalty = cornerMagnitude * this.cornerSlowdown;
    const desiredSpeed = clamp(this.targetSpeed - cornerPenalty, this.minSpeed, this.targetSpeed);

    const speedError = desiredSpeed - speed;

    const stuck = speed <= this.stuckSpeed && Math.abs(yawError) >= this.stuckYawThreshold;
    if (stuck) {
      this.stuckMs += dtMs;
      if (this.stuckMs >= this.stuckTimeMs) {
        this.reverseRemainingMs = this.reverseTimeMs;
        this.stuckMs = 0;
      }
    } else {
      this.stuckMs = Math.max(0, this.stuckMs - dtMs * 2);
    }

    if (this.reverseRemainingMs > 0) {
      this.reverseRemainingMs = Math.max(0, this.reverseRemainingMs - dtMs);
      const controls = {
        throttle: false,
        reverse: true,
        left: steerIntent > this.steerDeadzone,
        right: steerIntent < -this.steerDeadzone,
        brake: false,
        boost: false,
      };
      this.last = {
        ...controls,
        desiredSpeed,
        yawError,
        speedError,
        steerIntent,
      };
      return this.last;
    }

    const shouldBrakeForTurn =
      Math.abs(yawError) >= this.brakeYawThreshold && speed > desiredSpeed * 0.7;
    const shouldBrakeForSpeed = speedError <= this.brakeSpeedError;

    const brake = shouldBrakeForTurn || shouldBrakeForSpeed;

    const throttleDrive = speedError >= this.accelerateSpeedError && !brake;

    const controls = {
      throttle: throttleDrive,
      reverse: false,
      left: steerIntent < -this.steerDeadzone,
      right: steerIntent > this.steerDeadzone,
      brake,
      boost: throttleDrive && Math.abs(steerIntent) < 0.15,
    };

    this.last = {
      ...controls,
      desiredSpeed,
      yawError,
      speedError,
      steerIntent,
    };

    return this.last;
  }
}
