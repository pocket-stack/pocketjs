// playset/modules/actor-motion/ground-vehicle/drifting-plugin.ts — drift
// state machine for the dynamic car: slip/steer/handbrake demand blend, rear
// wheel friction fade, steering assist and yaw-rate assist.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/actor-motion/ground-vehicle/DriftingPlugin.js. Verbatim
// semantics; typed structurally so it plugs into both the motion controller
// (planMovement/commitMovement) and the kinematic batch resolver's rigid-body
// shim (applyDynamicCarControls/yaw assist).

import type { Vector3 } from "../../../math/index.ts";
import { clamp, lerp, smoothToward } from "../../math/scalar-utils.ts";
import { DEFAULT_WORLD_BASIS, type WorldBasis } from "../../math/world-basis.ts";

const EPS = 1e-6;
const DRIFT_EFFECT_KEY = "vehicleDrifting";

export interface DriftBodyFrameLike {
  forward: Vector3;
  right: Vector3;
  up: Vector3;
}

export interface DriftControllerLike {
  velocity: Vector3;
  bodyFrame: DriftBodyFrameLike;
  steer: number;
  inputSteer: number;
  handbrake: boolean;
}

export interface DriftWheelLike {
  name?: string;
  steerable?: boolean;
  drive?: boolean;
  handbrake?: boolean;
  frictionSlip: number;
  sideFrictionStiffness: number;
}

export interface DriftWheelControlLike {
  index: number;
  wheel: DriftWheelLike;
  steering: number;
  engineForce: number;
  brakeForce: number;
  handbrakeForce: number;
  brake: number;
  frictionSlip: number;
  sideFrictionStiffness: number;
}

export interface DriftRigidBodyLike {
  angvel(): { x: number; y: number; z: number };
  setAngvel(value: { x: number; y: number; z: number }, wakeUp?: boolean): void;
}

export interface DriftActorLike {
  rigidBody: DriftRigidBodyLike;
}

export interface DriftDescriptor {
  amount: number;
  side: number;
  yawAssist: number;
  maxYawRate: number;
  steeringAssist: number;
  rearSideFrictionScale: number;
  frontSideFrictionScale: number;
  rearFrictionSlipScale: number;
  frontFrictionSlipScale: number;
  handbrakeBrakeScale: number;
  rearWheelIndices?: number[];
  rearWheelNames?: string[];
}

export interface DriftEffectState {
  driftAmount: number;
  driftSide: number;
  drift: DriftDescriptor | null;
}

export interface DriftingPluginOptions {
  speedForFullDrift?: number;
  steerForFullDrift?: number;
  slipAngleFull?: number;
  steeringDrift?: number;
  handbrakeDrift?: number;
  enterLag?: number;
  exitLag?: number;
  steeringAssist?: number;
  yawAssist?: number;
  maxYawRate?: number;
  speedForFullYaw?: number;
  rearSideFrictionScale?: number;
  frontSideFrictionScale?: number;
  rearFrictionSlipScale?: number;
  frontFrictionSlipScale?: number;
  handbrakeBrakeScale?: number;
}

function localVelocity(
  velocity: Vector3,
  bodyFrame: DriftBodyFrameLike,
): { forward: number; right: number; speed: number } {
  const tangent = velocity.clone().projectOnPlane(bodyFrame.up);

  return {
    forward: tangent.dot(bodyFrame.forward),
    right: tangent.dot(bodyFrame.right),
    speed: tangent.length(),
  };
}

function driftWheelMatch(wheel: DriftWheelLike, drift: DriftDescriptor, index: number): boolean {
  if (Array.isArray(drift.rearWheelIndices)) return drift.rearWheelIndices.includes(index);
  if (Array.isArray(drift.rearWheelNames)) return drift.rearWheelNames.includes(wheel.name ?? "");
  return Boolean(wheel.handbrake || (wheel.drive && !wheel.steerable) || /rear/i.test(wheel.name ?? ""));
}

function stateFromDrift(drift: DriftDescriptor | null = null): Record<string, DriftEffectState> {
  const amount = drift ? clamp(drift.amount, 0, 1) : 0;
  const side = drift ? Math.sign(drift.side) : 0;
  return {
    [DRIFT_EFFECT_KEY]: {
      driftAmount: amount,
      driftSide: side,
      drift,
    },
  };
}

export class DriftingPlugin {
  id: string;
  cfg: {
    speedForFullDrift: number;
    steerForFullDrift: number;
    slipAngleFull: number;
    steeringDrift: number;
    handbrakeDrift: number;
    enterLag: number;
    exitLag: number;
    steeringAssist: number;
    yawAssist: number;
    maxYawRate: number;
    speedForFullYaw: number;
    wheels: {
      rearSideFrictionScale: number;
      frontSideFrictionScale: number;
      rearFrictionSlipScale: number;
      frontFrictionSlipScale: number;
      handbrakeBrakeScale: number;
    };
  };
  driftAmount!: number;
  driftSide!: number;
  forwardSpeed!: number;
  rightSpeed!: number;

  constructor({
    speedForFullDrift = 8,
    steerForFullDrift = 0.18,
    slipAngleFull = 0.58,
    steeringDrift = 0.35,
    handbrakeDrift = 1,
    enterLag = 0.08,
    exitLag = 0.2,
    steeringAssist = 0.18,
    yawAssist = 5.2,
    maxYawRate = 2.8,
    speedForFullYaw = 24,
    rearSideFrictionScale = 0.3,
    frontSideFrictionScale = 1.0,
    rearFrictionSlipScale = 1.0,
    frontFrictionSlipScale = 1.0,
    handbrakeBrakeScale = 0.0,
  }: DriftingPluginOptions) {
    this.id = "vehicle-drifting";
    this.cfg = {
      speedForFullDrift,
      steerForFullDrift,
      slipAngleFull,
      steeringDrift,
      handbrakeDrift,
      enterLag,
      exitLag,
      steeringAssist,
      yawAssist,
      maxYawRate,
      speedForFullYaw,
      wheels: {
        rearSideFrictionScale,
        frontSideFrictionScale,
        rearFrictionSlipScale,
        frontFrictionSlipScale,
        handbrakeBrakeScale,
      },
    };
    this.reset();
  }

  reset(): { state: DriftEffectState } {
    this.driftAmount = 0;
    this.driftSide = 0;
    this.forwardSpeed = 0;
    this.rightSpeed = 0;
    return {
      state: {
        driftAmount: this.driftAmount,
        driftSide: this.driftSide,
        drift: null,
      },
    };
  }

  planMovement({ controller, deltaSeconds }: { controller: DriftControllerLike; deltaSeconds: number }): {
    intent: { effects: Record<string, DriftDescriptor> };
    state: DriftEffectState;
  } {
    const velocity = localVelocity(controller.velocity, controller.bodyFrame);
    const speedAbs = velocity.speed;
    const steerAbs = Math.abs(controller.steer);
    const slipAngle = Math.atan2(Math.abs(velocity.right), Math.max(1, Math.abs(velocity.forward)));
    const slipDrift = clamp(slipAngle / Math.max(EPS, this.cfg.slipAngleFull), 0, 1);
    const speedDrift = clamp(speedAbs / Math.max(EPS, this.cfg.speedForFullDrift), 0, 1);
    const steerDrift = clamp(steerAbs / Math.max(EPS, this.cfg.steerForFullDrift), 0, 1);
    const steeringDemand = speedDrift * steerDrift * this.cfg.steeringDrift;
    const handbrakeDemand = controller.handbrake ? speedDrift * this.cfg.handbrakeDrift : 0;
    const driftTarget = clamp(Math.max(slipDrift, steeringDemand, handbrakeDemand), 0, 1);
    const driftAmount = smoothToward(
      this.driftAmount,
      driftTarget,
      driftTarget > this.driftAmount ? this.cfg.enterLag : this.cfg.exitLag,
      deltaSeconds,
    );
    const sideSource =
      Math.abs(controller.inputSteer) > EPS
        ? controller.inputSteer
        : Math.abs(controller.steer) > EPS
          ? controller.steer
          : velocity.right;
    const driftSide = driftAmount > EPS ? Math.sign(sideSource || this.driftSide) : 0;
    const speedScale = clamp(speedAbs / Math.max(EPS, this.cfg.speedForFullYaw), 0, 1.35);
    const drift: DriftDescriptor = {
      amount: driftAmount,
      side: driftSide,
      yawAssist: driftSide * this.cfg.yawAssist * speedScale,
      maxYawRate: this.cfg.maxYawRate,
      steeringAssist: this.cfg.steeringAssist,
      ...this.cfg.wheels,
    };

    this.driftAmount = driftAmount;
    this.driftSide = driftSide;
    this.forwardSpeed = velocity.forward;
    this.rightSpeed = velocity.right;

    return {
      intent: {
        effects: {
          [DRIFT_EFFECT_KEY]: drift,
        },
      },
      state: {
        driftAmount,
        driftSide,
        drift,
      },
    };
  }

  commitMovement({ resolved }: { resolved: { extensionState: Record<string, unknown> } }): {
    state: DriftEffectState;
  } {
    const state = resolved.extensionState[DRIFT_EFFECT_KEY] as DriftEffectState;
    const drift = state.drift;
    this.driftAmount = state.driftAmount;
    this.driftSide = state.driftSide;
    return {
      state: {
        driftAmount: this.driftAmount,
        driftSide: this.driftSide,
        drift,
      },
    };
  }

  applyDynamicCarControls({
    actor,
    controls,
    wheelControls,
    deltaSeconds,
    state,
    basis = DEFAULT_WORLD_BASIS,
  }: {
    resolver?: unknown;
    actor: DriftActorLike;
    controls: { effects?: Record<string, unknown> };
    wheelControls: DriftWheelControlLike[];
    deltaSeconds: number;
    state: Record<string, unknown>;
    basis?: WorldBasis;
  }): void {
    const drift = controls.effects?.[DRIFT_EFFECT_KEY] as DriftDescriptor | undefined;
    if (!drift) {
      const driftState = stateFromDrift(null);
      Object.assign(state, driftState);
      return;
    }

    const amount = drift.amount;

    for (const control of wheelControls) {
      const { wheel, index } = control;
      const isRear = driftWheelMatch(wheel, drift, index);
      const sideScale = isRear ? drift.rearSideFrictionScale : drift.frontSideFrictionScale;
      const slipScale = isRear ? drift.rearFrictionSlipScale : drift.frontFrictionSlipScale;
      const sideTarget = wheel.sideFrictionStiffness * sideScale;
      const slipTarget = wheel.frictionSlip * slipScale;

      control.sideFrictionStiffness = lerp(wheel.sideFrictionStiffness, sideTarget, amount);
      control.frictionSlip = lerp(wheel.frictionSlip, slipTarget, amount);
      control.steering *= 1 + amount * drift.steeringAssist;

      if (isRear) {
        control.handbrakeForce *= lerp(1, drift.handbrakeBrakeScale, amount);
        control.brake = control.brakeForce + control.handbrakeForce;
      }
    }

    this.applyYawAssist(actor, drift, deltaSeconds, basis);

    const driftState = stateFromDrift(drift);
    Object.assign(state, driftState);
  }

  applyYawAssist(
    actor: DriftActorLike,
    drift: DriftDescriptor,
    deltaSeconds: number,
    basis: WorldBasis = DEFAULT_WORLD_BASIS,
  ): void {
    const amount = clamp(drift.amount, 0, 1);
    const yawAccel = drift.yawAssist;
    if (deltaSeconds <= 0 || amount <= EPS || Math.abs(yawAccel) <= EPS) return;

    const av = actor.rigidBody.angvel();
    const up = basis.upVector();
    const currentYaw = av.x * up.x + av.y * up.y + av.z * up.z;
    const maxYawRate = Math.max(0, drift.maxYawRate);
    const requestedYawDelta = yawAccel * amount * deltaSeconds;
    let yawDelta = requestedYawDelta;
    if (maxYawRate > 0) {
      const currentAbs = Math.abs(currentYaw);
      const deltaSign = Math.sign(requestedYawDelta);
      if (currentAbs >= maxYawRate && Math.sign(currentYaw) === deltaSign) return;
      const targetYaw = currentYaw + requestedYawDelta;
      if (Math.abs(targetYaw) > maxYawRate && Math.sign(targetYaw) === deltaSign) {
        yawDelta = deltaSign * Math.max(0, maxYawRate - currentAbs);
      }
    }
    if (Math.abs(yawDelta) <= EPS) return;

    actor.rigidBody.setAngvel(
      {
        x: av.x + up.x * yawDelta,
        y: av.y + up.y * yawDelta,
        z: av.z + up.z * yawDelta,
      },
      true,
    );
  }

  snapshot(): {
    id: string;
    driftAmount: number;
    driftSide: number;
    forwardSpeed: number;
    rightSpeed: number;
  } {
    return {
      id: this.id,
      driftAmount: this.driftAmount,
      driftSide: this.driftSide,
      forwardSpeed: this.forwardSpeed,
      rightSpeed: this.rightSpeed,
    };
  }
}

export { DRIFT_EFFECT_KEY as VEHICLE_DRIFTING_EFFECT_KEY };
