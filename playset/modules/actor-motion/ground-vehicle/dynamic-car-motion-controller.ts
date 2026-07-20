// playset/modules/actor-motion/ground-vehicle/dynamic-car-motion-controller.ts —
// input shaper for the dynamic car: smooths steer/throttle/reverse/brake into
// a per-frame intent, runs plugins (drifting etc.), and mirrors resolved
// physics state back onto itself.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/actor-motion/ground-vehicle/DynamicCarMotionController.js.
// Verbatim semantics.

import { Quaternion, Vector3 } from "../../../math/index.ts";
import { clamp, smoothToward } from "../../math/scalar-utils.ts";
import { toVec3 } from "../../math/vector3-utils.ts";
import { DEFAULT_WORLD_BASIS, type WorldBasis, type VecLike } from "../../math/world-basis.ts";

export interface DynamicCarBodyFrame {
  forward: Vector3;
  right: Vector3;
  up: Vector3;
}

export interface DynamicCarWheelState {
  index: number;
  name?: string;
  steering: number;
  rotation: number;
  suspensionLength: number;
  inContact: boolean;
}

export interface DynamicCarResolvedState {
  position: Vector3;
  rotation: Quaternion;
  velocity: Vector3;
  angularVelocity: Vector3;
  speed: number;
  horizontalSpeed: number;
  vehicleSpeed: number;
  grounded: boolean;
  bodyFrame: DynamicCarBodyFrame;
  wheels: DynamicCarWheelState[];
  extensionState: Record<string, unknown>;
}

export interface DynamicCarIntent {
  deltaSeconds: number;
  steeringAngle: number;
  throttle: number;
  reverse: number;
  brake: number;
  handbrake: boolean;
  boost: boolean;
  effects?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DynamicCarPluginResult {
  intent?: { effects?: Record<string, unknown>; [key: string]: unknown };
  state?: object;
}

export interface DynamicCarPlugin {
  reset?(frame: {
    controller: DynamicCarMotionController;
    position: VecLike;
    yaw: number;
    basis: WorldBasis;
  }): DynamicCarPluginResult | null | void;
  planMovement?(frame: {
    controller: DynamicCarMotionController;
    intent: DynamicCarIntent;
    deltaSeconds: number;
    basis: WorldBasis;
  }): DynamicCarPluginResult | null | void;
  commitMovement?(frame: {
    controller: DynamicCarMotionController;
    resolved: DynamicCarResolvedState;
    basis: WorldBasis;
  }): DynamicCarPluginResult | null | void;
}

export interface DynamicCarMotionControllerOptions {
  steerLag?: number;
  throttleLag?: number;
  reverseLag?: number;
  brakeLag?: number;
  releaseLag?: number;
  maxSteeringAngle?: number;
  plugins?: DynamicCarPlugin[];
  basis?: WorldBasis;
}

export interface DynamicCarPlanMovementInput {
  left?: number;
  right?: number;
  throttle?: number;
  reverse?: number;
  brake?: number;
  handbrake?: boolean;
  boost?: boolean;
  deltaSeconds?: number;
}

function quatFromYaw(yaw = 0, basis: WorldBasis = DEFAULT_WORLD_BASIS): Quaternion {
  return new Quaternion().setFromAxisAngle(basis.upVector(), yaw);
}

function basisFromRotation(rotation: Quaternion, basis: WorldBasis = DEFAULT_WORLD_BASIS): DynamicCarBodyFrame {
  const worldBasis = basis;
  return {
    forward: worldBasis.forwardVector().applyQuaternion(rotation).normalize(),
    right: worldBasis.rightVector().applyQuaternion(rotation).normalize(),
    up: worldBasis.upVector().applyQuaternion(rotation).normalize(),
  };
}

function mergePluginResult(
  controller: DynamicCarMotionController,
  intent: DynamicCarIntent | null,
  result: DynamicCarPluginResult | null | void,
): void {
  if (!result || typeof result !== "object") return;

  const pluginIntent = result.intent;
  if (intent && pluginIntent) {
    if (pluginIntent.effects) {
      intent.effects = Object.assign(intent.effects ?? {}, pluginIntent.effects);
    }

    for (const key of Object.keys(pluginIntent)) {
      if (key !== "effects") intent[key] = pluginIntent[key];
    }
  }

  if (result.state) Object.assign(controller as unknown as Record<string, unknown>, result.state);
}

function callPlugin(
  plugin: DynamicCarPlugin,
  hook: keyof DynamicCarPlugin,
  frame: unknown,
): DynamicCarPluginResult | null | void {
  const fn = plugin[hook];
  if (typeof fn === "function") {
    return fn.call(plugin, frame as never);
  }
  return null;
}

export class DynamicCarMotionController {
  cfg: {
    steerLag: number;
    throttleLag: number;
    reverseLag: number;
    brakeLag: number;
    releaseLag: number;
    maxSteeringAngle: number;
  };
  basis: WorldBasis;
  plugins: DynamicCarPlugin[];

  position!: Vector3;
  rotation!: Quaternion;
  velocity!: Vector3;
  angularVelocity!: Vector3;
  speed!: number;
  horizontalSpeed!: number;
  vehicleSpeed!: number;
  grounded!: boolean;
  bodyFrame!: DynamicCarBodyFrame;
  wheels!: DynamicCarWheelState[];

  inputSteer!: number;
  steer!: number;
  steeringAngle!: number;
  throttle!: number;
  reverse!: number;
  brake!: number;
  handbrake!: boolean;
  boost!: boolean;

  constructor({
    steerLag = 0.09,
    throttleLag = 0.06,
    reverseLag = 0.06,
    brakeLag = 0.04,
    releaseLag = 0.04,
    maxSteeringAngle = 0.56,
    plugins = [],
    basis = DEFAULT_WORLD_BASIS,
  }: DynamicCarMotionControllerOptions) {
    this.cfg = {
      steerLag,
      throttleLag,
      reverseLag,
      brakeLag,
      releaseLag,
      maxSteeringAngle: maxSteeringAngle,
    };

    this.basis = basis;
    this.plugins = [];

    for (const plugin of plugins) this.use(plugin);

    this.initControls();
    this.initMotion(new Vector3(), 0);
    this.runPluginHook("reset", {
      controller: this,
      position: this.position,
      yaw: 0,
      basis: this.basis,
    });
  }

  use(plugin: DynamicCarPlugin): this {
    this.plugins.push(plugin);
    return this;
  }

  reset(position: VecLike = { x: 0, y: 0, z: 0 }, yaw = 0): void {
    this.initControls();
    this.initMotion(position, yaw);
    this.runPluginHook("reset", {
      controller: this,
      position,
      yaw,
      basis: this.basis,
    });
  }

  // left/right: 0..1 steers toward the local left/right directions.
  // throttle/reverse: 0..1 applies forward/reverse drive pressure.
  // brake: 0..1 applies brake pressure.
  // handbrake/boost: true triggers discrete action flags.
  planMovement({
    left = 0,
    right = 0,
    throttle = 0,
    reverse = 0,
    brake = 0,
    handbrake = false,
    boost = false,
    deltaSeconds = 1 / 60,
  }: DynamicCarPlanMovementInput): DynamicCarIntent {
    const input = {
      steer:
        this.basis.controlSignal("counterClockWise", left) + this.basis.controlSignal("clockWise", right),
      throttle: clamp(throttle, 0, 1),
      reverse: clamp(reverse, 0, 1),
      brake: clamp(brake, 0, 1),
      handbrake: Boolean(handbrake),
      boost: Boolean(boost),
    };

    this.inputSteer = input.steer;
    this.steer = smoothToward(this.steer, input.steer, this.cfg.steerLag, deltaSeconds);
    this.steeringAngle = this.steer * this.cfg.maxSteeringAngle;
    this.throttle = smoothToward(
      this.throttle,
      input.throttle,
      input.throttle > this.throttle ? this.cfg.throttleLag : this.cfg.releaseLag,
      deltaSeconds,
    );
    this.reverse = smoothToward(
      this.reverse,
      input.reverse,
      input.reverse > this.reverse ? this.cfg.reverseLag : this.cfg.releaseLag,
      deltaSeconds,
    );
    this.brake = smoothToward(
      this.brake,
      input.brake,
      input.brake > this.brake ? this.cfg.brakeLag : this.cfg.releaseLag,
      deltaSeconds,
    );
    this.handbrake = input.handbrake;
    this.boost = input.boost;

    const intent: DynamicCarIntent = {
      deltaSeconds,
      steeringAngle: this.steeringAngle,
      throttle: this.throttle,
      reverse: this.reverse,
      brake: this.brake,
      handbrake: this.handbrake,
      boost: this.boost,
    };

    this.runPluginHook(
      "planMovement",
      {
        controller: this,
        intent,
        deltaSeconds,
        basis: this.basis,
      },
      intent,
    );

    return intent;
  }

  commitMovement(resolved: DynamicCarResolvedState | null = null): void {
    if (resolved) {
      this.position = resolved.position;
      this.rotation = resolved.rotation;
      this.velocity = resolved.velocity;
      this.angularVelocity = resolved.angularVelocity;
      this.speed = resolved.speed;
      this.horizontalSpeed = resolved.horizontalSpeed;
      this.vehicleSpeed = resolved.vehicleSpeed;
      this.grounded = resolved.grounded;
      this.bodyFrame = resolved.bodyFrame;
      this.wheels = resolved.wheels;
      this.runPluginHook("commitMovement", {
        controller: this,
        resolved,
        basis: this.basis,
      });
    }
  }

  initMotion(position: VecLike, yaw: number): void {
    this.position = toVec3(position);
    this.rotation = quatFromYaw(yaw, this.basis);
    this.velocity = new Vector3();
    this.angularVelocity = new Vector3();
    this.speed = 0;
    this.horizontalSpeed = 0;
    this.vehicleSpeed = 0;
    this.grounded = false;
    this.bodyFrame = basisFromRotation(this.rotation, this.basis);
    this.wheels = [];
  }

  initControls(): void {
    this.inputSteer = 0;
    this.steer = 0;
    this.steeringAngle = 0;
    this.throttle = 0;
    this.reverse = 0;
    this.brake = 0;
    this.handbrake = false;
    this.boost = false;
  }

  runPluginHook(hook: keyof DynamicCarPlugin, frame: unknown, intent: DynamicCarIntent | null = null): void {
    for (const plugin of this.plugins) {
      mergePluginResult(this, intent, callPlugin(plugin, hook, frame));
    }
  }
}
