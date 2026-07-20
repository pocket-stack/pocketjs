// playset/modules/actor-motion/ground-vehicle/dynamic-car-batch-resolver.ts —
// frame-batched dynamic car resolution: actors carry a full wheel/chassis
// config, queue control intents, and get position/rotation/velocity/wheel
// states back each frame.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/actor-motion/ground-vehicle/DynamicCarBatchResolver.js.
// REENGINEERED: this is a kinematic approximation of the Rapier
// raycast-vehicle; the native Rust physics block is the planned upgrade path.
// Instead of suspension rays + wheel friction solved by a rigid-body engine,
// the car integrates deterministically on the CollisionWorld:
//   - longitudinal accel/brake curves derived from the config module's
//     engine/brake forces, chassis mass and linear damping (wheel brake
//     values act as per-reference-step friction impulses, the
//     Bullet/Rapier raycast-vehicle convention);
//   - speed-dependent steering via a grip-clamped bicycle model
//     (frictionSlip x sideFrictionStiffness bounds lateral acceleration);
//   - lateral slip state so DriftingPlugin's slip detection and yaw-rate
//     assist (through the actor's rigid-body shim) stay functional;
//   - terrain following via world.groundHeightAt with a suspension-lag
//     settle, ballistic airborne phase, and body pitch/roll from
//     finite-difference terrain normal sampling;
//   - planar wall push-out via world.resolveCapsule (circle footprint =
//     the chassis' largest planar half extent).
// The public API and per-actor result shape match the original exactly (the
// `rapier` constructor option is gone; `applyGravityToWorld` only reports the
// configured gravity since the collision core has no gravity field).

import { Matrix4, Quaternion, Vector3 } from "../../../math/index.ts";
import { clamp, smoothToward, smoothingAlpha } from "../../math/scalar-utils.ts";
import { VECTOR_EPS } from "../../math/vector3-utils.ts";
import { DEFAULT_WORLD_BASIS, type WorldBasis, type AxisName, type VecLike } from "../../math/world-basis.ts";
import type { CollisionWorld } from "../../physics/collision-world.ts";
import {
  createDynamicCarConfigForBasis,
  type DynamicCarConfig,
  type DynamicCarConfigOptions,
  type DynamicCarWheel,
} from "./dynamic-car-config.ts";
import type {
  DynamicCarResolvedState,
  DynamicCarWheelState,
  DynamicCarBodyFrame,
} from "./dynamic-car-motion-controller.ts";

/** Wheel brake values are impulses per reference step (Bullet convention). */
const BRAKE_IMPULSE_HZ = 60;
/** Lateral slip decay rate per unit of sideFrictionStiffness. */
const LATERAL_GRIP_RATE = 8;
/** Suspension settle lag = SUSPENSION_LAG_SCALE / suspensionStiffness. */
const SUSPENSION_LAG_SCALE = 3;
/** Airborne bodies relax their surface normal back to world up with this lag. */
const AIRBORNE_NORMAL_LAG = 0.25;

export interface DynamicCarControlsIntent {
  deltaSeconds?: number;
  steeringAngle?: number;
  throttle?: number;
  reverse?: number;
  brake?: number;
  handbrake?: boolean;
  boost?: boolean;
  effects?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DynamicCarWheelControl {
  index: number;
  wheel: DynamicCarWheel;
  steering: number;
  engineForce: number;
  brakeForce: number;
  handbrakeForce: number;
  brake: number;
  frictionSlip: number;
  sideFrictionStiffness: number;
}

export interface DynamicCarEffect {
  applyDynamicCarControls(frame: {
    resolver: DynamicCarBatchResolver;
    actor: DynamicCarActor;
    controls: DynamicCarControlsIntent;
    wheelControls: DynamicCarWheelControl[];
    deltaSeconds: number;
    state: Record<string, unknown>;
    basis: WorldBasis;
  }): void;
}

interface DynamicCarSim {
  planarRight: number;
  planarForward: number;
  up: number;
  yaw: number;
  forwardSpeed: number;
  lateralSpeed: number;
  verticalSpeed: number;
  /** Last step's steering-derived yaw rate (splits plugin assist off angvel). */
  steerYawRate: number;
  angularVelocity: Vector3;
  grounded: boolean;
  normal: Vector3;
  rotation: Quaternion;
  wheelRotations: number[];
  wheelSteerings: number[];
}

/** Rapier-compatible rigid-body surface over the kinematic sim state. */
export class DynamicCarRigidBody {
  private readonly sim: DynamicCarSim;
  private readonly basis: WorldBasis;

  constructor(sim: DynamicCarSim, basis: WorldBasis) {
    this.sim = sim;
    this.basis = basis;
  }

  translation(): { x: number; y: number; z: number } {
    const v = this.basis.fromBasisComponents(this.sim.planarRight, this.sim.up, this.sim.planarForward);
    return { x: v.x, y: v.y, z: v.z };
  }

  rotation(): { x: number; y: number; z: number; w: number } {
    const q = this.sim.rotation;
    return { x: q.x, y: q.y, z: q.z, w: q.w };
  }

  linvel(): { x: number; y: number; z: number } {
    const v = worldVelocity(this.sim, this.basis);
    return { x: v.x, y: v.y, z: v.z };
  }

  angvel(): { x: number; y: number; z: number } {
    const v = this.sim.angularVelocity;
    return { x: v.x, y: v.y, z: v.z };
  }

  setTranslation(value: VecLike, _wakeUp?: boolean): void {
    this.sim.planarRight = this.basis.rightComponent(value);
    this.sim.up = this.basis.upComponent(value);
    this.sim.planarForward = this.basis.forwardComponent(value);
  }

  setRotation(value: { x: number; y: number; z: number; w: number }, _wakeUp?: boolean): void {
    this.sim.rotation.set(value.x, value.y, value.z, value.w);
    this.sim.yaw = this.basis.forwardToYaw(
      this.basis.forwardVector().applyQuaternion(this.sim.rotation),
    );
  }

  setLinvel(value: VecLike, _wakeUp?: boolean): void {
    const sim = this.sim;
    const right = this.basis.rightComponent(value);
    const forward = this.basis.forwardComponent(value);
    const sinYaw = Math.sin(sim.yaw);
    const cosYaw = Math.cos(sim.yaw);
    sim.forwardSpeed = -sinYaw * right + cosYaw * forward;
    sim.lateralSpeed = cosYaw * right + sinYaw * forward;
    sim.verticalSpeed = this.basis.upComponent(value);
  }

  setAngvel(value: VecLike, _wakeUp?: boolean): void {
    this.sim.angularVelocity.set(value.x ?? 0, value.y ?? 0, value.z ?? 0);
  }
}

export interface DynamicCarActor {
  config: DynamicCarConfig;
  wheels: DynamicCarWheel[];
  rigidBody: DynamicCarRigidBody;
  effects: DynamicCarEffect[];
  extensionState: Record<string, unknown>;
  wheelControls: DynamicCarWheelControl[];
  sim: DynamicCarSim;
  capsuleRadius: number;
  capsuleHalfHeight: number;
  rideHeight: number;
  wheelBase: number;
  track: number;
  climb: number;
  suspensionLag: number;
  maxSuspensionTravel: number;
}

export interface DynamicCarActorOptions {
  vehicleConfigOptions?: DynamicCarConfigOptions;
  position?: VecLike;
  yaw?: number;
  velocity?: VecLike;
  angularVelocity?: VecLike;
  effects?: DynamicCarEffect[];
}

function gravityObject(magnitude: number, basis: WorldBasis = DEFAULT_WORLD_BASIS): { x: number; y: number; z: number } {
  const gravity = basis.downVector().multiplyScalar(magnitude);
  return { x: gravity.x, y: gravity.y, z: gravity.z };
}

function worldVelocity(sim: DynamicCarSim, basis: WorldBasis, target = new Vector3()): Vector3 {
  const sinYaw = Math.sin(sim.yaw);
  const cosYaw = Math.cos(sim.yaw);
  const right = -sinYaw * sim.forwardSpeed + cosYaw * sim.lateralSpeed;
  const forward = cosYaw * sim.forwardSpeed + sinYaw * sim.lateralSpeed;
  return basis.fromBasisComponents(right, sim.verticalSpeed, forward, target);
}

function orientationFrame(yaw: number, surfaceNormal: Vector3, basis: WorldBasis): DynamicCarBodyFrame {
  const up = surfaceNormal.clone().normalize();
  const forward = basis.yawPitchRollFrame(yaw).forward.projectOnPlane(up).normalize();
  const right = new Vector3().crossVectors(forward, up).normalize();
  forward.crossVectors(up, right).normalize();
  return { right, up, forward };
}

function quaternionFromFrame(frame: DynamicCarBodyFrame, basis: WorldBasis, target: Quaternion): Quaternion {
  // Column for world axis a is the body image of that axis: ±frame vector,
  // matching the basis' right/up/forward assignment.
  const columns: Record<AxisName, Vector3> = {
    x: new Vector3(),
    y: new Vector3(),
    z: new Vector3(),
  };
  columns[basis.rightAxis.axis].copy(frame.right).multiplyScalar(basis.rightAxis.sign);
  columns[basis.upAxis.axis].copy(frame.up).multiplyScalar(basis.upAxis.sign);
  columns[basis.forwardAxis.axis].copy(frame.forward).multiplyScalar(basis.forwardAxis.sign);
  return target.setFromRotationMatrix(new Matrix4().makeBasis(columns.x, columns.y, columns.z));
}

export class DynamicCarBatchResolver {
  world: CollisionWorld;
  basis: WorldBasis;
  gravityMagnitude: number;
  worldConfig: {
    basis: WorldBasis;
    minDeltaSeconds: number;
    gravity: { x: number; y: number; z: number };
  };
  actors: Set<DynamicCarActor>;
  queuedMoves: Map<DynamicCarActor, DynamicCarControlsIntent | null>;
  results: Map<DynamicCarActor, DynamicCarResolvedState>;
  effects: DynamicCarEffect[];

  constructor({
    world,
    minDeltaSeconds = 1 / 240,
    gravityMagnitude = 9.81,
    effects = [],
    basis = DEFAULT_WORLD_BASIS,
  }: {
    world: CollisionWorld;
    minDeltaSeconds?: number;
    gravityMagnitude?: number;
    effects?: DynamicCarEffect[];
    basis?: WorldBasis;
  }) {
    if (!world) {
      throw new Error("DynamicCarBatchResolver: world is required");
    }

    this.world = world;
    this.basis = basis;
    this.gravityMagnitude = gravityMagnitude;
    this.worldConfig = {
      basis: this.basis,
      minDeltaSeconds,
      gravity: gravityObject(gravityMagnitude, this.basis),
    };

    this.actors = new Set();
    this.queuedMoves = new Map();
    this.results = new Map();
    this.effects = [];
    for (const effect of effects) this.useEffect(effect);
  }

  /** The collision core has no gravity field; reports the configured vector. */
  applyGravityToWorld(): { x: number; y: number; z: number } {
    return this.worldConfig.gravity;
  }

  useEffect(effect: DynamicCarEffect): this {
    this.effects.push(effect);
    for (const actor of this.actors) actor.effects.push(effect);
    return this;
  }

  createActor({
    vehicleConfigOptions = {},
    position = { x: 0, y: 0, z: 0 },
    yaw = 0,
    velocity = { x: 0, y: 0, z: 0 },
    angularVelocity = { x: 0, y: 0, z: 0 },
    effects = [],
  }: DynamicCarActorOptions = {}): DynamicCarActor {
    const config = createDynamicCarConfigForBasis(vehicleConfigOptions, this.basis);
    const { chassis, wheels } = config;
    const b = this.basis;

    const hRight = Math.abs(b.rightComponent(chassis.halfExtents));
    const hUp = Math.abs(b.upComponent(chassis.halfExtents));
    const hForward = Math.abs(b.forwardComponent(chassis.halfExtents));

    let rideHeightSum = 0;
    let stiffnessSum = 0;
    let travelSum = 0;
    let climb = 0;
    let minForward = Infinity;
    let maxForward = -Infinity;
    let minRight = Infinity;
    let maxRight = -Infinity;
    for (const wheel of wheels) {
      rideHeightSum += wheel.radius + wheel.suspensionRestLength - b.upComponent(wheel.connection);
      stiffnessSum += wheel.suspensionStiffness;
      travelSum += wheel.maxSuspensionTravel;
      climb = Math.max(climb, wheel.radius);
      const wf = b.forwardComponent(wheel.connection);
      const wr = b.rightComponent(wheel.connection);
      minForward = Math.min(minForward, wf);
      maxForward = Math.max(maxForward, wf);
      minRight = Math.min(minRight, wr);
      maxRight = Math.max(maxRight, wr);
    }
    const wheelCount = Math.max(1, wheels.length);

    const sim: DynamicCarSim = {
      planarRight: b.rightComponent(position),
      planarForward: b.forwardComponent(position),
      up: b.upComponent(position),
      yaw,
      forwardSpeed: 0,
      lateralSpeed: 0,
      verticalSpeed: 0,
      steerYawRate: 0,
      angularVelocity: new Vector3(),
      grounded: false,
      normal: b.upVector(),
      rotation: new Quaternion().setFromAxisAngle(b.upVector(), yaw),
      wheelRotations: wheels.map(() => 0),
      wheelSteerings: wheels.map(() => 0),
    };

    const rigidBody = new DynamicCarRigidBody(sim, b);

    const actor: DynamicCarActor = {
      config,
      wheels,
      rigidBody,
      effects: [...this.effects, ...effects],
      extensionState: {},
      wheelControls: [],
      sim,
      capsuleRadius: Math.max(0.05, hRight, hForward),
      capsuleHalfHeight: Math.max(0.05, hUp),
      rideHeight: rideHeightSum / wheelCount,
      wheelBase: Math.max(0.1, maxForward - minForward),
      track: Math.max(0.1, maxRight - minRight),
      climb,
      suspensionLag: SUSPENSION_LAG_SCALE / Math.max(VECTOR_EPS, stiffnessSum / wheelCount),
      maxSuspensionTravel: travelSum / wheelCount,
    };

    rigidBody.setLinvel(velocity);
    rigidBody.setAngvel(angularVelocity);

    this._applyControls(actor, {});
    this.actors.add(actor);
    return actor;
  }

  beginFrame(): void {
    this.queuedMoves.clear();
    this.results.clear();
  }

  queueMove(actor: DynamicCarActor, movement: DynamicCarControlsIntent | null = null): void {
    this._requireActor(actor);
    this.queuedMoves.set(actor, movement);
  }

  resetState(
    actor: DynamicCarActor,
    position: VecLike = { x: 0, y: 0, z: 0 },
    yaw = 0,
  ): DynamicCarResolvedState {
    this._requireActor(actor);
    actor.rigidBody.setTranslation(position, true);
    actor.rigidBody.setRotation(
      new Quaternion().setFromAxisAngle(this.basis.upVector(), yaw),
      true,
    );
    actor.rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    actor.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    actor.sim.steerYawRate = 0;
    actor.sim.grounded = false;
    actor.sim.normal.copy(this.basis.upVector());
    actor.extensionState = {};
    this._applyControls(actor, {});
    const resolved = this.getResult(actor) as DynamicCarResolvedState;
    this.results.set(actor, resolved);
    return resolved;
  }

  resolveQueuedMoves(deltaSeconds = 1 / 60): Map<DynamicCarActor, DynamicCarResolvedState> {
    const minDeltaSeconds = this.worldConfig.minDeltaSeconds;

    for (const actor of this.actors) {
      const intent = this.queuedMoves.get(actor) ?? {};
      const stepDt = Math.max(minDeltaSeconds, intent.deltaSeconds ?? deltaSeconds);
      this._applyControls(actor, intent, stepDt);
      if (deltaSeconds > 0) this._integrateActor(actor, stepDt);
    }

    this.results.clear();
    for (const actor of this.actors) {
      this.results.set(actor, this.getResult(actor) as DynamicCarResolvedState);
    }
    return this.results;
  }

  getResult(actor: DynamicCarActor): DynamicCarResolvedState | null {
    if (!this.actors.has(actor)) return null;

    const sim = actor.sim;
    const b = this.basis;
    const position = b.fromBasisComponents(sim.planarRight, sim.up, sim.planarForward);
    const rotation = sim.rotation.clone();
    const velocity = worldVelocity(sim, b);
    const angularVelocity = sim.angularVelocity.clone();
    const bodyFrame: DynamicCarBodyFrame = {
      forward: b.forwardVector().applyQuaternion(rotation).normalize(),
      right: b.rightVector().applyQuaternion(rotation).normalize(),
      up: b.upVector().applyQuaternion(rotation).normalize(),
    };
    const wheels: DynamicCarWheelState[] = actor.wheels.map((wheel, index) => ({
      index,
      name: wheel.name,
      steering: sim.wheelSteerings[index] ?? 0,
      rotation: sim.wheelRotations[index] ?? 0,
      suspensionLength: wheel.suspensionRestLength,
      inContact: sim.grounded,
    }));

    return {
      position,
      rotation,
      velocity,
      angularVelocity,
      speed: velocity.length(),
      horizontalSpeed: b.planarLength(velocity),
      vehicleSpeed: sim.forwardSpeed,
      grounded: wheels.some((wheel) => wheel.inContact),
      bodyFrame,
      wheels,
      extensionState: { ...actor.extensionState },
    };
  }

  disposeActor(actor: DynamicCarActor): boolean {
    if (!this.actors.has(actor)) return false;
    this.actors.delete(actor);
    this.queuedMoves.delete(actor);
    this.results.delete(actor);
    return true;
  }

  dispose(): void {
    for (const actor of Array.from(this.actors)) this.disposeActor(actor);
  }

  _applyControls(actor: DynamicCarActor, controls: DynamicCarControlsIntent = {}, deltaSeconds = 0): void {
    const { drive, axes } = actor.config;
    const steeringAngle = controls.steeringAngle ?? 0;
    const throttle = clamp(controls.throttle ?? 0, 0, 1);
    const reverse = clamp(controls.reverse ?? 0, 0, 1);
    const brake = clamp(controls.brake ?? 0, 0, 1);
    const handbrake = Boolean(controls.handbrake);
    const boost = Boolean(controls.boost);
    const engineForce =
      (throttle * drive.maxEngineForce * (boost ? drive.boostMultiplier : 1) -
        reverse * drive.maxReverseForce) *
      axes.forwardSign;
    const brakeForce = brake * drive.maxBrakeForce;
    const handbrakeForce = handbrake ? drive.maxHandbrakeForce : 0;

    const wheelControls: DynamicCarWheelControl[] = actor.wheels.map((wheel, index) => {
      const wheelBrakeForce = wheel.brake ? brakeForce * wheel.brakeScale : 0;
      const wheelHandbrakeForce = wheel.handbrake ? handbrakeForce * wheel.handbrakeScale : 0;
      return {
        index,
        wheel,
        steering: wheel.steerable ? steeringAngle * wheel.steeringScale : 0,
        engineForce: wheel.drive ? engineForce * wheel.engineScale : 0,
        brakeForce: wheelBrakeForce,
        handbrakeForce: wheelHandbrakeForce,
        brake: wheelBrakeForce + wheelHandbrakeForce,
        frictionSlip: wheel.frictionSlip,
        sideFrictionStiffness: wheel.sideFrictionStiffness,
      };
    });

    for (const effect of actor.effects) {
      effect.applyDynamicCarControls({
        resolver: this,
        actor,
        controls,
        wheelControls,
        deltaSeconds: Math.max(0, deltaSeconds),
        state: actor.extensionState,
        basis: this.basis,
      });
    }

    for (const control of wheelControls) {
      control.frictionSlip = Math.max(0, control.frictionSlip);
      control.sideFrictionStiffness = Math.max(0, control.sideFrictionStiffness);
      actor.sim.wheelSteerings[control.index] = control.steering;
    }
    actor.wheelControls = wheelControls;
  }

  _integrateActor(actor: DynamicCarActor, dt: number): void {
    const sim = actor.sim;
    const b = this.basis;
    const g = this.gravityMagnitude;
    const { chassis, damping } = actor.config;
    const controls = actor.wheelControls;
    const wheelCount = Math.max(1, controls.length);

    let engineForce = 0;
    let brakeForce = 0;
    let steerSum = 0;
    let steerCount = 0;
    let gripSum = 0;
    let sideSum = 0;
    for (const control of controls) {
      engineForce += control.engineForce;
      brakeForce += control.brake;
      if (control.wheel.steerable) {
        steerSum += control.steering;
        steerCount += 1;
      }
      gripSum += control.frictionSlip * control.sideFrictionStiffness;
      sideSum += control.sideFrictionStiffness;
    }
    const steering = steerCount > 0 ? steerSum / steerCount : 0;

    // Longitudinal: engine force -> accel, brake as per-step friction impulse.
    let forwardSpeed = sim.forwardSpeed;
    if (sim.grounded) {
      forwardSpeed += ((engineForce * actor.config.axes.forwardSign) / chassis.mass) * dt;
      const brakeDv = (brakeForce / chassis.mass) * BRAKE_IMPULSE_HZ * dt;
      if (Math.abs(forwardSpeed) <= brakeDv) forwardSpeed = 0;
      else forwardSpeed -= Math.sign(forwardSpeed) * brakeDv;
    }
    forwardSpeed *= Math.max(0, 1 - damping.linear * dt);

    // Yaw: grip-clamped bicycle model; drift assist rides on the angvel state.
    let steerYawRate = 0;
    if (sim.grounded) {
      steerYawRate = (forwardSpeed * Math.tan(steering)) / actor.wheelBase;
      if (Math.abs(forwardSpeed) > VECTOR_EPS) {
        const maxLateralAccel = (gripSum / wheelCount) * g;
        const maxYawRate = maxLateralAccel / Math.abs(forwardSpeed);
        steerYawRate = clamp(steerYawRate, -maxYawRate, maxYawRate);
      }
    }
    let assist = b.upComponent(sim.angularVelocity) - sim.steerYawRate;
    assist *= Math.exp(-damping.angular * dt);
    const yawRate = steerYawRate + assist;
    const dYaw = yawRate * dt;
    sim.yaw += dYaw;
    sim.steerYawRate = steerYawRate;

    // Lateral slip: the heading rotates under the velocity; grip pulls it back.
    let lateralSpeed = sim.lateralSpeed + forwardSpeed * Math.sin(dYaw);
    const gripRate = sim.grounded ? LATERAL_GRIP_RATE * (sideSum / wheelCount) : 0;
    if (gripRate > 0) lateralSpeed *= Math.exp(-gripRate * dt);

    // Planar integrate + wall push-out through the collision core.
    const sinYaw = Math.sin(sim.yaw);
    const cosYaw = Math.cos(sim.yaw);
    const forwardDirRight = -sinYaw;
    const forwardDirForward = cosYaw;
    const rightDirRight = cosYaw;
    const rightDirForward = sinYaw;
    const velRight = forwardDirRight * forwardSpeed + rightDirRight * lateralSpeed;
    const velForward = forwardDirForward * forwardSpeed + rightDirForward * lateralSpeed;
    const current = b.fromBasisComponents(sim.planarRight, sim.up, sim.planarForward);
    const desired = b.fromBasisComponents(
      sim.planarRight + velRight * dt,
      sim.up,
      sim.planarForward + velForward * dt,
    );
    const resolved = this.world.resolveCapsule(current, desired, {
      radius: actor.capsuleRadius,
      halfHeight: actor.capsuleHalfHeight,
      climb: actor.climb,
      snap: 0,
    });
    const nextRight = b.rightComponent(resolved.position);
    const nextForward = b.forwardComponent(resolved.position);
    if (resolved.hitWall && dt > 0) {
      const achievedRight = (nextRight - sim.planarRight) / dt;
      const achievedForward = (nextForward - sim.planarForward) / dt;
      forwardSpeed = achievedRight * forwardDirRight + achievedForward * forwardDirForward;
      lateralSpeed = achievedRight * rightDirRight + achievedForward * rightDirForward;
    }
    sim.planarRight = nextRight;
    sim.planarForward = nextForward;

    // Vertical: suspension settle when grounded, ballistic otherwise.
    const ground = this.world.groundHeightAt(sim.planarRight, sim.planarForward);
    const target = ground + actor.rideHeight;
    let verticalSpeed = sim.verticalSpeed;
    if (sim.grounded) {
      if (sim.up - target > actor.maxSuspensionTravel) {
        sim.grounded = false;
        verticalSpeed -= g * dt;
        sim.up += verticalSpeed * dt;
      } else {
        const previousUp = sim.up;
        sim.up = smoothToward(sim.up, target, actor.suspensionLag, dt);
        verticalSpeed = dt > 0 ? (sim.up - previousUp) / dt : 0;
      }
    } else {
      verticalSpeed -= g * dt;
      sim.up += verticalSpeed * dt;
      if (sim.up <= target) {
        sim.up = target;
        verticalSpeed = 0;
        sim.grounded = true;
      }
    }
    sim.verticalSpeed = verticalSpeed;

    // Surface normal: finite differences along the body axes when grounded,
    // relaxing back to world up in the air.
    if (sim.grounded) {
      const df = actor.wheelBase / 2;
      const dr = actor.track / 2;
      const hFront = this.world.groundHeightAt(
        sim.planarRight + forwardDirRight * df,
        sim.planarForward + forwardDirForward * df,
      );
      const hBack = this.world.groundHeightAt(
        sim.planarRight - forwardDirRight * df,
        sim.planarForward - forwardDirForward * df,
      );
      const hRight = this.world.groundHeightAt(
        sim.planarRight + rightDirRight * dr,
        sim.planarForward + rightDirForward * dr,
      );
      const hLeft = this.world.groundHeightAt(
        sim.planarRight - rightDirRight * dr,
        sim.planarForward - rightDirForward * dr,
      );
      const slopeForward = (hFront - hBack) / (2 * df);
      const slopeRight = (hRight - hLeft) / (2 * dr);
      const gradRight = slopeForward * forwardDirRight + slopeRight * rightDirRight;
      const gradForward = slopeForward * forwardDirForward + slopeRight * rightDirForward;
      b.surfaceNormalFromSlopes(gradRight, gradForward, sim.normal);
    } else {
      sim.normal.lerp(b.upVector(), smoothingAlpha(AIRBORNE_NORMAL_LAG, dt)).normalize();
    }

    quaternionFromFrame(orientationFrame(sim.yaw, sim.normal, b), b, sim.rotation);
    b.fromBasisComponents(0, yawRate, 0, sim.angularVelocity);

    for (let i = 0; i < actor.wheels.length; i += 1) {
      const wheel = actor.wheels[i]!;
      sim.wheelRotations[i] =
        (sim.wheelRotations[i] ?? 0) + (forwardSpeed * dt) / Math.max(VECTOR_EPS, wheel.radius);
    }

    sim.forwardSpeed = forwardSpeed;
    sim.lateralSpeed = lateralSpeed;
  }

  _requireActor(actor: DynamicCarActor): void {
    if (!this.actors.has(actor)) {
      throw new Error("DynamicCarBatchResolver: unknown actor handle");
    }
  }
}
