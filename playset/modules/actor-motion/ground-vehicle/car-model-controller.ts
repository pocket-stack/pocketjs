// playset/modules/actor-motion/ground-vehicle/car-model-controller.ts — maps
// resolved car state onto scene models: chassis pose, wheel spin from forward
// speed, steering yaw on the steered wheels/pivots.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/actor-motion/ground-vehicle/CarModelController.js.
// Verbatim semantics; models are typed structurally instead of three.js
// Object3D (position/quaternion for the chassis, mutable Euler-like rotation
// for wheels and pivots).

import { Matrix4, Vector3, type Quaternion } from "../../../math/index.ts";

const EPS = 1e-6;

export interface CarModelLike {
  position: Vector3;
  quaternion: Quaternion;
}

export interface WheelNodeLike {
  rotation: { x: number; y: number };
}

export interface CarBodyFrameLike {
  right: Vector3;
  up: Vector3;
  forward: Vector3;
}

export interface CarModelControllerOptions {
  vehicleModel?: CarModelLike | null;
  wheels?: WheelNodeLike[];
  wheelPivots?: (WheelNodeLike | null | undefined)[];
  wheelRadius?: number;
  steerWheelIndices?: number[];
}

export interface CarModelStepInput {
  position: Vector3;
  bodyFrame?: CarBodyFrameLike | null;
  velocity?: Vector3 | null;
  /** Rapier3D local yaw angle around up (+Y). */
  steeringAngle: number;
  deltaSeconds?: number;
}

export class CarModelController {
  vehicleModel: CarModelLike | null;
  wheels: WheelNodeLike[];
  wheelPivots: (WheelNodeLike | null | undefined)[];
  wheelRadius: number;
  steerWheelIndices: Set<number>;
  wheelSpin: number;
  modelMatrix: Matrix4;
  forwardVelocity: Vector3;
  modelBack: Vector3;

  constructor({
    vehicleModel = null,
    wheels = [],
    wheelPivots = [],
    wheelRadius = 0.35,
    steerWheelIndices = [0, 1],
  }: CarModelControllerOptions) {
    this.vehicleModel = vehicleModel;
    this.wheels = wheels;
    this.wheelPivots = wheelPivots;

    this.wheelRadius = wheelRadius;
    this.steerWheelIndices = new Set(steerWheelIndices);

    this.wheelSpin = 0;
    this.modelMatrix = new Matrix4();
    this.forwardVelocity = new Vector3();
    this.modelBack = new Vector3();
  }

  reset(position: Vector3): CarModelLike | null {
    this.wheelSpin = 0;

    if (this.vehicleModel) {
      this.vehicleModel.position.copy(position);
      this.vehicleModel.quaternion.identity();
    }

    for (let i = 0; i < this.wheels.length; i += 1) {
      const wheel = this.wheels[i];
      const pivot = this.wheelPivots[i];

      if (wheel) {
        wheel.rotation.x = 0;
        wheel.rotation.y = 0;
      }
      if (pivot) pivot.rotation.y = 0;
    }

    return this.vehicleModel;
  }

  step({
    position,
    bodyFrame,
    velocity,
    steeringAngle,
    deltaSeconds = 1 / 60,
  }: CarModelStepInput): CarModelLike | null {
    this.updateChassis(position, bodyFrame ?? null);
    this.updateWheels(bodyFrame ?? null, velocity ?? null, steeringAngle, deltaSeconds);

    return this.vehicleModel;
  }

  updateChassis(position: Vector3, bodyFrame: CarBodyFrameLike | null): void {
    if (!this.vehicleModel) return;

    this.vehicleModel.position.copy(position);

    if (bodyFrame?.right && bodyFrame?.up && bodyFrame?.forward) {
      // Matrix4.makeBasis asks where local +Z points; since vehicle meshes face
      // local -Z, local +Z points to the backward direction.
      this.modelBack.copy(bodyFrame.forward).multiplyScalar(-1);
      this.modelMatrix.makeBasis(bodyFrame.right, bodyFrame.up, this.modelBack);
      this.vehicleModel.quaternion.setFromRotationMatrix(this.modelMatrix);
    }
  }

  updateWheels(
    bodyFrame: CarBodyFrameLike | null,
    velocity: Vector3 | null,
    steeringAngle: number, // Rapier3D local yaw angle around up (+Y)
    deltaSeconds: number,
  ): void {
    const radius = Math.max(EPS, Math.abs(this.wheelRadius));
    this.wheelSpin += (this.getForwardSpeed(velocity, bodyFrame) * deltaSeconds) / radius;
    const localYaw = steeringAngle;

    for (let i = 0; i < this.wheels.length; i += 1) {
      const wheel = this.wheels[i];
      const pivot = this.wheelPivots[i];
      const wheelYaw = this.steerWheelIndices.has(i) ? localYaw : 0;

      wheel.rotation.x = this.wheelSpin;

      if (pivot) {
        pivot.rotation.y = wheelYaw;
        wheel.rotation.y = 0;
      } else {
        wheel.rotation.y = wheelYaw;
      }
    }
  }

  getForwardSpeed(velocity: Vector3 | null = null, bodyFrame: CarBodyFrameLike | null = null): number {
    if (!velocity || !bodyFrame?.forward) return 0;
    return this.forwardVelocity.copy(velocity).dot(bodyFrame.forward);
  }
}
