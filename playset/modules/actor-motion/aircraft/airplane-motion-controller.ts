// playset/modules/actor-motion/aircraft/airplane-motion-controller.ts —
// arcade airplane flight model: throttle→speed lag, pitch steering, bank-roll
// turning, timed boost.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/actor-motion/aircraft/AirplaneMotionController.js.
// Verbatim semantics.

import { Vector3 } from "../../../math/index.ts";
import { clamp, smoothToward } from "../../math/scalar-utils.ts";
import { toVec3 } from "../../math/vector3-utils.ts";
import { DEFAULT_WORLD_BASIS, type WorldBasis, type VecLike } from "../../math/world-basis.ts";

export interface AirplaneMotionControllerOptions {
  throttleRate?: number;
  minSpeed?: number;
  maxSpeed?: number;
  speedLag?: number;
  boostSpeedLag?: number;
  pitchRate?: number;
  maxBankRoll?: number;
  bankRollLag?: number;
  bankTurnRate?: number;
  bankTurnRollReference?: number;
  boostDuration?: number;
  boostMultiplier?: number;
  basis?: WorldBasis;
}

export interface AirplanePlanMovementInput {
  left?: number;
  right?: number;
  up?: number;
  down?: number;
  throttle?: number;
  boost?: boolean;
  deltaSeconds?: number;
  commit?: boolean;
}

export interface AirplaneIntent {
  position: Vector3;
  startPosition: Vector3;
  desiredDelta: Vector3;
  deltaSeconds: number;
  speed: number;
  pitch: number;
  roll: number;
  yaw: number;
}

export interface AirplaneCommitResult {
  position: Vector3;
  yaw: number;
  pitch: number;
  roll: number;
  bodyFrame: {
    forward: Vector3;
    right: Vector3;
    up: Vector3;
  };
}

export class AirplaneMotionController {
  cfg: {
    throttleRate: number;
    minSpeed: number;
    maxSpeed: number;
    speedLag: number;
    boostSpeedLag: number;
    pitchRate: number;
    maxBankRoll: number;
    bankRollLag: number;
    bankTurnRate: number;
    bankTurnRollReference: number;
    boostDuration: number;
    boostMultiplier: number;
  };
  basis: WorldBasis;

  speed: number;
  pitch: number;
  roll: number;
  yaw: number;
  position: Vector3;

  throttle: number;
  isBoosting: boolean;
  boostRemainingSeconds: number;
  boostPressed: boolean;

  constructor({
    throttleRate = 0.42,
    minSpeed = 82,
    maxSpeed = 246,
    speedLag = 0.56,
    boostSpeedLag = 0.26,
    pitchRate = 1.18,
    maxBankRoll = 1.1868, // 68 deg
    bankRollLag = 0.21,
    bankTurnRate = 0.42,
    bankTurnRollReference = 0.9774, // 56 deg
    boostDuration = 1.7,
    boostMultiplier = 1.28,
    basis = DEFAULT_WORLD_BASIS,
  }: AirplaneMotionControllerOptions) {
    this.cfg = {
      throttleRate,
      minSpeed,
      maxSpeed,
      speedLag,
      boostSpeedLag,
      pitchRate,
      maxBankRoll,
      bankRollLag,
      bankTurnRate,
      bankTurnRollReference,
      boostDuration,
      boostMultiplier,
    };
    this.basis = basis;

    this.speed = this.cfg.minSpeed;
    this.pitch = 0;
    this.roll = 0;
    this.yaw = 0;
    this.position = new Vector3();

    this.throttle = 0;
    this.isBoosting = false;
    this.boostRemainingSeconds = 0;
    this.boostPressed = false;
  }

  setState(
    speed?: number | null,
    throttle?: number | null,
    pitch?: number | null,
    roll?: number | null,
    yaw?: number | null,
    position: VecLike | null = null,
    isBoosting: boolean | null = null,
    boostRemainingSeconds: number | null = null,
    boostDuration: number | null = null,
  ): void {
    if (position) {
      this.position.copy(toVec3(position, this.position));
    }
    if (typeof speed === "number") this.speed = speed;
    if (typeof throttle === "number") {
      this.throttle = clamp(throttle, 0, 1);
    }
    if (typeof pitch === "number") this.pitch = pitch;
    if (typeof roll === "number") this.roll = roll;
    if (typeof yaw === "number") this.yaw = yaw;
    if (typeof isBoosting === "boolean") this.isBoosting = isBoosting;
    if (typeof boostRemainingSeconds === "number") this.boostRemainingSeconds = boostRemainingSeconds;
    if (typeof boostDuration === "number") this.cfg.boostDuration = boostDuration;
  }

  // left/right: 0..1 steers toward the local left/right directions.
  // up/down: 0..1 steers toward the local up/down directions.
  // throttle: -1..1 adjusts cruise throttle.
  // boost: true triggers boost.
  planMovement({
    left = 0,
    right = 0,
    up = 0,
    down = 0,
    throttle = 0,
    boost = false,
    deltaSeconds = 1 / 60,
    commit = false,
  }: AirplanePlanMovementInput): AirplaneIntent | AirplaneCommitResult {
    const startPosition = this.position.clone();
    const leftRight =
      this.basis.controlSignal("counterClockWise", left) + this.basis.controlSignal("clockWise", right);
    const upDown =
      this.basis.controlSignal("counterClockWise", up) + this.basis.controlSignal("clockWise", down);

    if (throttle > 0) {
      this.throttle = Math.min(1, this.throttle + this.cfg.throttleRate * deltaSeconds);
    } else if (throttle < 0) {
      this.throttle = Math.max(0, this.throttle - this.cfg.throttleRate * deltaSeconds);
    }

    const boostHeld = Boolean(boost);

    this._stepBoost(boostHeld, deltaSeconds);
    const nextSpeed = this.predictSpeed(deltaSeconds);
    const nextAttitude = this.predictAttitude(leftRight, upDown, nextSpeed, deltaSeconds);

    const nextPosition = this.predictPosition(
      this.position,
      nextSpeed * deltaSeconds,
      nextAttitude.yaw,
      nextAttitude.pitch,
    );

    const intent: AirplaneIntent = {
      position: nextPosition.clone(),
      startPosition,
      desiredDelta: nextPosition.clone().sub(startPosition),
      deltaSeconds: deltaSeconds,
      speed: nextSpeed,
      pitch: nextAttitude.pitch,
      roll: nextAttitude.roll,
      yaw: nextAttitude.yaw,
    };

    if (commit) return this.commitMovement(intent);
    return intent;
  }

  commitMovement(intent: AirplaneIntent, resolved: { position: VecLike } | null = null): AirplaneCommitResult {
    const position = toVec3(resolved ? resolved.position : intent.position);
    this.position.copy(position);
    this.speed = intent.speed;
    this.pitch = intent.pitch;
    this.roll = intent.roll;
    this.yaw = intent.yaw;

    const frame = this.basis.yawPitchRollFrame(this.yaw, this.pitch, this.roll);
    return {
      position: this.position.clone(),
      yaw: this.yaw,
      pitch: this.pitch,
      roll: this.roll,
      bodyFrame: {
        forward: frame.forward.clone(),
        right: frame.right.clone(),
        up: frame.up.clone(),
      },
    };
  }

  _stepBoost(boostHeld: boolean, deltaSeconds: number): void {
    if (this.boostRemainingSeconds > 0) {
      this.boostRemainingSeconds -= deltaSeconds;
      if (this.boostRemainingSeconds <= 0) {
        this.boostRemainingSeconds = 0;
        this.isBoosting = false;
      }
    }

    if (boostHeld) {
      if (!this.boostPressed && !this.isBoosting) {
        this.isBoosting = true;
        this.boostRemainingSeconds = this.cfg.boostDuration;
      }
      this.boostPressed = true;
    } else {
      this.boostPressed = false;
    }
  }

  predictSpeed(deltaSeconds: number): number {
    const cruiseSpeed = this.cfg.minSpeed + this.throttle * (this.cfg.maxSpeed - this.cfg.minSpeed);
    const targetSpeed = this.isBoosting ? this.cfg.maxSpeed * this.cfg.boostMultiplier : cruiseSpeed;
    return smoothToward(
      this.speed,
      targetSpeed,
      this.isBoosting ? this.cfg.boostSpeedLag : this.cfg.speedLag,
      deltaSeconds,
    );
  }

  predictAttitude(
    leftRight: number,
    upDown: number,
    speed: number,
    deltaSeconds: number,
  ): { pitch: number; roll: number; yaw: number } {
    const controlEffectiveness = speed > this.cfg.minSpeed ? 1 : speed / this.cfg.minSpeed;
    const localPitch = upDown * this.cfg.pitchRate * deltaSeconds * controlEffectiveness;
    const maxBankRoll = Math.abs(this.cfg.maxBankRoll);
    // the turn direction and roll-bank direction have opposite signs.
    const targetRoll = -leftRight * maxBankRoll;
    const currentRoll = clamp(this.roll, -maxBankRoll, maxBankRoll);
    const pitch = this.pitch + localPitch;
    const roll = smoothToward(currentRoll, targetRoll, this.cfg.bankRollLag, deltaSeconds);

    const bankTurnReference = Math.max(1e-6, Math.abs(this.cfg.bankTurnRollReference));
    // Convert the roll-bank direction back to turn direction.
    const bankTurnAxis = clamp(-roll / bankTurnReference, -1, 1);
    const bankTurnYaw = bankTurnAxis * this.cfg.bankTurnRate * deltaSeconds * controlEffectiveness;
    const yaw = this.yaw + bankTurnYaw;

    return { pitch, roll, yaw };
  }

  predictPosition(
    position: VecLike = this.position,
    distance = 0,
    yaw: number = this.yaw,
    pitch: number = this.pitch,
  ): Vector3 {
    const startPosition = toVec3(position, this.position);
    const forward = this.basis.yawPitchRollFrame(yaw, pitch).forward;
    return startPosition.addScaledVector(forward, distance);
  }

  reset(position: VecLike = { x: 0, y: 0, z: 0 }): void {
    this.speed = this.cfg.minSpeed;
    this.throttle = 0;
    this.pitch = 0;
    this.roll = 0;
    this.yaw = 0;
    this.position.set(position.x ?? 0, position.y ?? 0, position.z ?? 0);
    this.isBoosting = false;
    this.boostRemainingSeconds = 0;
    this.boostPressed = false;
  }
}
