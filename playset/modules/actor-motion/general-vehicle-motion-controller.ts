// playset/modules/actor-motion/general-vehicle-motion-controller.ts —
// six-axis vehicle motion (hover/space/drone style): local-frame thrust with
// damping and speed cap, path yaw/pitch steering, body yaw, and banking.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/actor-motion/GeneralVehicleMotionController.js.
// Verbatim semantics.

import { Vector3 } from "../../math/index.ts";
import { clamp, smoothToward } from "../math/scalar-utils.ts";
import { DEFAULT_WORLD_BASIS, type WorldBasis } from "../math/world-basis.ts";

export interface GeneralVehicleMotionControllerOptions {
  acceleration?: number;
  maxSpeed?: number;
  damping?: number;
  brakeDamping?: number;
  steerYawRate?: number;
  steerPitchRate?: number;
  rotateYawRate?: number;
  instantMotion?: boolean;
  maxForwardBackwardBank?: number;
  maxLeftRightBank?: number;
  bankLag?: number;
  shiftBankWeight?: number;
  steerBankWeight?: number;
  basis?: WorldBasis;
}

export interface VehicleMotionConfig {
  acceleration: number;
  maxSpeed: number;
  damping: number;
  brakeDamping: number;
  steerYawRate: number;
  steerPitchRate: number;
  rotateYawRate: number;
  instantMotion: boolean;
  maxForwardBackwardBank: number;
  maxLeftRightBank: number;
  bankLag: number;
  shiftBankWeight: number;
  steerBankWeight: number;
}

export interface VehiclePlanOptions {
  forward?: number;
  backward?: number;
  left?: number;
  right?: number;
  up?: number;
  down?: number;
  steerLeft?: number;
  steerRight?: number;
  steerUp?: number;
  steerDown?: number;
  rotateLeft?: number;
  rotateRight?: number;
  brake?: boolean;
  deltaSeconds?: number;
  commit?: boolean;
}

export interface VehicleMovementIntent {
  startPosition: Vector3;
  desiredDelta: Vector3;
  deltaSeconds: number;
  position: Vector3;
  velocity: Vector3;
  pathYaw: number;
  pathPitch: number;
  relativeBodyYaw: number;
  forwardBackwardBank: number;
  leftRightBank: number;
}

/** Resolver output for a vehicle intent — structural, so any resolver or test
 *  stub with corrected position/velocity works. */
export interface ResolvedVehicleMovement {
  position: Vector3;
  velocity: Vector3;
}

export interface VehicleBodyFrame {
  forward: Vector3;
  right: Vector3;
  up: Vector3;
}

export interface VehicleMotionState {
  position: Vector3;
  velocity: Vector3;
  bodyFrame: VehicleBodyFrame;
}

export type VehicleMotionPlanResult = VehicleMovementIntent | VehicleMotionState;

export interface VehicleResetOptions {
  position: Vector3;
  velocity: Vector3;
  pathYaw?: number;
  pathPitch?: number;
  relativeBodyYaw?: number;
}

export class GeneralVehicleMotionController {
  basis: WorldBasis;
  cfg: VehicleMotionConfig;
  position: Vector3;
  velocity: Vector3;
  pathYaw: number;
  pathPitch: number;
  relativeBodyYaw: number;
  forwardBackwardBank: number;
  leftRightBank: number;

  constructor({
    acceleration = 24,
    maxSpeed = 40,
    damping = 0.8,
    brakeDamping = 8,
    steerYawRate = 2.8,
    steerPitchRate = 2.0,
    rotateYawRate = 2.8,
    instantMotion = false,
    maxForwardBackwardBank = 0,
    maxLeftRightBank = 0,
    bankLag = 0.12,
    shiftBankWeight = 1,
    steerBankWeight = 1,
    basis = DEFAULT_WORLD_BASIS,
  }: GeneralVehicleMotionControllerOptions) {
    this.basis = basis;
    this.cfg = {
      acceleration,
      maxSpeed,
      damping,
      brakeDamping,
      steerYawRate,
      steerPitchRate,
      rotateYawRate,
      instantMotion,
      maxForwardBackwardBank: Math.max(0, maxForwardBackwardBank),
      maxLeftRightBank: Math.max(0, maxLeftRightBank),
      bankLag,
      shiftBankWeight,
      steerBankWeight,
    };

    this.position = new Vector3();
    this.velocity = new Vector3();
    this.pathYaw = 0;
    this.pathPitch = 0;
    this.relativeBodyYaw = 0;
    this.forwardBackwardBank = 0;
    this.leftRightBank = 0;
  }

  get bodyYaw(): number {
    return this.pathYaw + this.relativeBodyYaw;
  }

  get bodyPitch(): number {
    return this.pathPitch + this.forwardBackwardBank;
  }

  get bodyRoll(): number {
    return this.leftRightBank;
  }

  // forward/backward: 0..1 translates along the local forward/backward directions.
  // left/right: 0..1 translates along the local left/right directions.
  // up/down: 0..1 translates along the local up/down directions.
  // steerLeft/steerRight: 0..1 steers toward the local left/right directions.
  // steerUp/steerDown: 0..1 steers toward the local up/down directions.
  // rotateLeft/rotateRight: 0..1 rotates the body toward the local left/right directions.
  planMovement({
    forward = 0,
    backward = 0,
    left = 0,
    right = 0,
    up = 0,
    down = 0,
    steerLeft = 0,
    steerRight = 0,
    steerUp = 0,
    steerDown = 0,
    rotateLeft = 0,
    rotateRight = 0,
    brake = false,
    deltaSeconds = 1 / 60,
    commit = false,
  }: VehiclePlanOptions): VehicleMotionPlanResult {
    const startPosition = this.position.clone();
    const speed = this.velocity.length();
    const steerScale = this.cfg.maxSpeed > 0 ? clamp(speed / this.cfg.maxSpeed, 0, 1) : 0;

    const steerLeftRight = this.basis.controlSignal("counterClockWise", steerLeft) + this.basis.controlSignal("clockWise", steerRight);
    const steerUpDown = this.basis.controlSignal("counterClockWise", steerUp) + this.basis.controlSignal("clockWise", steerDown);

    const pathYaw = this.pathYaw + steerLeftRight * this.cfg.steerYawRate * steerScale * deltaSeconds;
    const pathPitch = this.pathPitch + steerUpDown * this.cfg.steerPitchRate * steerScale * deltaSeconds;
    const relativeBodyYaw = this.relativeBodyYaw
      + (rotateLeft - rotateRight) * this.cfg.rotateYawRate * deltaSeconds;

    const shiftRight = this.basis.controlSignal("left", left) + this.basis.controlSignal("right", right);
    const shiftUp = this.basis.controlSignal("up", up) + this.basis.controlSignal("down", down);
    const shiftForward = this.basis.controlSignal("forward", forward) + this.basis.controlSignal("backward", backward);

    const shiftLength = Math.hypot(shiftRight, shiftUp, shiftForward);
    const shiftScale = shiftLength > 1 ? 1 / shiftLength : 1;
    const frame = this.basis.yawPitchRollFrame(pathYaw + relativeBodyYaw, pathPitch);
    const velocity = this.cfg.instantMotion ? new Vector3() : this.velocity.clone();
    const forwardBackwardBank = this._predictForwardBackwardBank(shiftForward, steerUpDown, deltaSeconds);
    const leftRightBank = this._predictLeftRightBank(shiftRight, steerLeftRight, deltaSeconds);

    if (shiftLength > 0) {
      const frameMotion = (this.cfg.instantMotion ? this.cfg.maxSpeed : this.cfg.acceleration * deltaSeconds) * shiftScale;
      velocity
        .addScaledVector(frame.right, shiftRight * frameMotion)
        .addScaledVector(frame.up, shiftUp * frameMotion)
        .addScaledVector(frame.forward, shiftForward * frameMotion);
    }

    if (!this.cfg.instantMotion) {
      velocity.multiplyScalar(Math.exp(-(brake ? this.cfg.brakeDamping : this.cfg.damping) * deltaSeconds));

      const nextSpeed = velocity.length();
      if (nextSpeed > this.cfg.maxSpeed) velocity.multiplyScalar(this.cfg.maxSpeed / nextSpeed);
    }

    const desiredDelta = velocity.clone().multiplyScalar(deltaSeconds);
    const position = startPosition.clone().add(desiredDelta);

    const intent: VehicleMovementIntent = {
      startPosition,
      desiredDelta,
      deltaSeconds,
      position,
      velocity,
      pathYaw,
      pathPitch,
      relativeBodyYaw,
      forwardBackwardBank,
      leftRightBank,
    };

    if (commit) return this.commitMovement(intent);
    return intent;
  }

  commitMovement(
    intent: VehicleMovementIntent,
    resolved: ResolvedVehicleMovement | null = null,
  ): VehicleMotionState {
    this.position.copy(resolved ? resolved.position : intent.position);
    this.velocity.copy(resolved ? resolved.velocity : intent.velocity);
    this.pathYaw = intent.pathYaw;
    this.pathPitch = intent.pathPitch;
    this.relativeBodyYaw = intent.relativeBodyYaw;
    this.forwardBackwardBank = intent.forwardBackwardBank;
    this.leftRightBank = intent.leftRightBank;
    const frame = this.basis.yawPitchRollFrame(this.bodyYaw, this.bodyPitch, this.bodyRoll);
    return {
      position: this.position.clone(),
      velocity: this.velocity.clone(),
      bodyFrame: {
        forward: frame.forward.clone(),
        right: frame.right.clone(),
        up: frame.up.clone(),
      },
    };
  }

  reset({
    position,
    velocity,
    pathYaw = 0,
    pathPitch = 0,
    relativeBodyYaw = 0,
  }: VehicleResetOptions): VehicleMotionState {
    this.position.copy(position);
    this.velocity.copy(velocity);
    this.pathYaw = pathYaw;
    this.pathPitch = pathPitch;
    this.relativeBodyYaw = relativeBodyYaw;
    this.forwardBackwardBank = 0;
    this.leftRightBank = 0;
    const frame = this.basis.yawPitchRollFrame(this.bodyYaw, this.bodyPitch, this.bodyRoll);
    return {
      position: this.position.clone(),
      velocity: this.velocity.clone(),
      bodyFrame: {
        forward: frame.forward.clone(),
        right: frame.right.clone(),
        up: frame.up.clone(),
      },
    };
  }

  _predictForwardBackwardBank(shiftForward: number, steerUpDown: number, deltaSeconds: number): number {
    const source = clamp(
      -shiftForward * this.cfg.shiftBankWeight + steerUpDown * this.cfg.steerBankWeight,
      -1,
      1,
    );
    return smoothToward(
      this.forwardBackwardBank,
      source * this.cfg.maxForwardBackwardBank,
      this.cfg.bankLag,
      deltaSeconds,
    );
  }

  _predictLeftRightBank(shiftRight: number, steerLeftRight: number, deltaSeconds: number): number {
    const source = clamp(
      shiftRight * this.cfg.shiftBankWeight - steerLeftRight * this.cfg.steerBankWeight,
      -1,
      1,
    );
    return smoothToward(
      this.leftRightBank,
      source * this.cfg.maxLeftRightBank,
      this.cfg.bankLag,
      deltaSeconds,
    );
  }
}
