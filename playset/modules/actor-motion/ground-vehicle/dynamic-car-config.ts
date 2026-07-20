// playset/modules/actor-motion/ground-vehicle/dynamic-car-config.ts — the
// dynamic car's tuning table: chassis mass/extents, damping, drive forces and
// per-wheel suspension/friction specs, expressed in basis space and resolved
// to world-axis vectors.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/actor-motion/ground-vehicle/DynamicCarRapierConfig.js.
// Verbatim semantics and numbers; only the FILE name drops "rapier" (the
// exported function keeps its original name so call sites port unchanged) —
// the config now feeds the kinematic dynamic-car-batch-resolver.

import { DEFAULT_WORLD_BASIS, type WorldBasis } from "../../math/world-basis.ts";

const AXIS_INDEX = Object.freeze({ x: 0, y: 1, z: 2 });

export interface BasisComponentsLike {
  right?: number;
  up?: number;
  forward?: number;
}

export interface XYZ {
  x: number;
  y: number;
  z: number;
}

interface WheelScalars {
  radius: number;
  suspensionRestLength: number;
  maxSuspensionTravel: number;
  suspensionStiffness: number;
  suspensionCompression: number;
  suspensionRelaxation: number;
  maxSuspensionForce: number;
  frictionSlip: number;
  sideFrictionStiffness: number;
  steerable: boolean;
  drive: boolean;
  brake: boolean;
  handbrake: boolean;
  steeringScale: number;
  engineScale: number;
  brakeScale: number;
  handbrakeScale: number;
}

export interface DynamicCarWheelSpec extends Partial<WheelScalars> {
  name?: string;
  offset?: BasisComponentsLike;
  connection?: XYZ;
  position?: XYZ;
}

export interface DynamicCarWheel extends WheelScalars {
  name?: string;
  direction: XYZ;
  axle: XYZ;
  connection: XYZ;
  position?: XYZ;
}

export interface DynamicCarChassisConfig {
  mass: number;
  friction: number;
  restitution: number;
  halfExtents: XYZ;
  colliderOffset: XYZ;
  centerOfMass: XYZ;
}

export interface DynamicCarDampingConfig {
  linear: number;
  angular: number;
}

export interface DynamicCarSolverConfig {
  additionalSolverIterations: number;
  ccdEnabled: boolean;
  canSleep: boolean;
}

export interface DynamicCarDriveConfig {
  maxEngineForce: number;
  maxReverseForce: number;
  maxBrakeForce: number;
  maxHandbrakeForce: number;
  boostMultiplier: number;
}

export interface DynamicCarAxesConfig {
  forwardSign: number;
  forwardAxis: number;
  upAxis: number;
}

export interface DynamicCarConfig {
  chassis: DynamicCarChassisConfig;
  damping: DynamicCarDampingConfig;
  solver: DynamicCarSolverConfig;
  drive: DynamicCarDriveConfig;
  axes: DynamicCarAxesConfig;
  wheelDefaults: WheelScalars & { direction: XYZ; axle: XYZ };
  wheels: DynamicCarWheel[];
}

export interface DynamicCarConfigOptions {
  chassis?: Partial<Omit<DynamicCarChassisConfig, "halfExtents" | "colliderOffset" | "centerOfMass">> & {
    halfExtents?: BasisComponentsLike;
    colliderOffset?: BasisComponentsLike;
    centerOfMass?: BasisComponentsLike;
  };
  wheelDefaults?: Partial<WheelScalars> & { direction?: XYZ; axle?: XYZ };
  wheelLayout?: { halfRight?: number; up?: number; halfForward?: number };
  wheels?: DynamicCarWheelSpec[];
  engineForwardSign?: number;
  wheelDirection?: BasisComponentsLike;
  wheelAxle?: BasisComponentsLike;
  damping?: Partial<DynamicCarDampingConfig>;
  solver?: Partial<DynamicCarSolverConfig>;
  drive?: Partial<DynamicCarDriveConfig>;
  axes?: Partial<DynamicCarAxesConfig>;
}

const DEFAULT_DYNAMIC_VEHICLE_LAYOUT = Object.freeze({
  engineForwardSign: -1,
  chassis: Object.freeze({
    halfExtents: Object.freeze({ right: 0.85, up: 0.35, forward: 1.5 }),
    colliderOffset: Object.freeze({ right: 0, up: 0.42, forward: 0 }),
    centerOfMass: Object.freeze({ right: 0, up: 0.18, forward: 0 }),
  }),
  wheelLayout: Object.freeze({
    halfRight: 0.84,
    up: 0.42,
    halfForward: 1.07,
  }),
  wheelDirection: Object.freeze({ right: 0, up: -1, forward: 0 }),
  wheelAxle: Object.freeze({ right: -1, up: 0, forward: 0 }),
});

const DEFAULT_DYNAMIC_VEHICLE_SCALARS = Object.freeze({
  chassis: Object.freeze({
    mass: 1250,
    friction: 0.7,
    restitution: 0.08,
  }),
  damping: Object.freeze({
    linear: 0.08,
    angular: 0.7,
  }),
  solver: Object.freeze({
    additionalSolverIterations: 8,
    ccdEnabled: true,
    canSleep: false,
  }),
  drive: Object.freeze({
    maxEngineForce: 4400,
    maxReverseForce: 2200,
    maxBrakeForce: 95,
    maxHandbrakeForce: 140,
    boostMultiplier: 1.35,
  }),
  wheelDefaults: Object.freeze({
    radius: 0.35,
    suspensionRestLength: 0.36,
    maxSuspensionTravel: 0.42,
    suspensionStiffness: 30,
    suspensionCompression: 4.4,
    suspensionRelaxation: 5.2,
    maxSuspensionForce: 7000,
    frictionSlip: 4.2,
    sideFrictionStiffness: 1,
    steerable: false,
    drive: false,
    brake: false,
    handbrake: false,
    steeringScale: 1,
    engineScale: 1,
    brakeScale: 1,
    handbrakeScale: 1,
  }),
});

function mergeBasisComponents(
  base: Required<BasisComponentsLike>,
  override: BasisComponentsLike = {},
): Required<BasisComponentsLike> {
  return {
    right: override.right ?? base.right,
    up: override.up ?? base.up,
    forward: override.forward ?? base.forward,
  };
}

function basisObject(components: Required<BasisComponentsLike>, basis: WorldBasis = DEFAULT_WORLD_BASIS): XYZ {
  const worldBasis = basis;
  const vector = worldBasis.fromBasisComponents(components.right, components.up, components.forward);
  return { x: vector.x, y: vector.y, z: vector.z };
}

function basisHalfExtents(components: Required<BasisComponentsLike>, basis: WorldBasis = DEFAULT_WORLD_BASIS): XYZ {
  const vector = basisObject(components, basis);
  return {
    x: Math.abs(vector.x),
    y: Math.abs(vector.y),
    z: Math.abs(vector.z),
  };
}

function defaultWheelSpecs(layout: { halfRight: number; up: number; halfForward: number }): DynamicCarWheelSpec[] {
  return [
    {
      name: "frontLeft",
      offset: { right: -layout.halfRight, up: layout.up, forward: layout.halfForward },
      steerable: true,
      drive: false,
      brake: true,
      handbrake: false,
    },
    {
      name: "frontRight",
      offset: { right: layout.halfRight, up: layout.up, forward: layout.halfForward },
      steerable: true,
      drive: false,
      brake: true,
      handbrake: false,
    },
    {
      name: "rearLeft",
      offset: { right: -layout.halfRight, up: layout.up, forward: -layout.halfForward },
      steerable: false,
      drive: true,
      brake: true,
      handbrake: true,
    },
    {
      name: "rearRight",
      offset: { right: layout.halfRight, up: layout.up, forward: -layout.halfForward },
      steerable: false,
      drive: true,
      brake: true,
      handbrake: true,
    },
  ];
}

function basisWheelSpec(wheel: DynamicCarWheelSpec, basis: WorldBasis = DEFAULT_WORLD_BASIS): DynamicCarWheelSpec {
  const { offset, connection, ...wheelConfig } = wheel;
  if (!offset && !connection) {
    throw new Error("createDynamicCarConfigForBasis: wheel offset or connection is required");
  }
  return {
    ...wheelConfig,
    connection:
      connection ?? basisObject(mergeBasisComponents({ right: 0, up: 0, forward: 0 }, offset), basis),
  };
}

function makeWheel(spec: DynamicCarWheelSpec, defaults: WheelScalars & { direction: XYZ; axle: XYZ }): DynamicCarWheel {
  const wheel = { ...defaults, ...spec };
  return {
    ...wheel,
    connection: (wheel.connection ?? wheel.position) as XYZ,
  };
}

export function createDynamicCarConfigForBasis(
  options: DynamicCarConfigOptions = {},
  basis: WorldBasis = DEFAULT_WORLD_BASIS,
): DynamicCarConfig {
  const worldBasis = basis;
  const chassisOptions = options.chassis ?? {};
  const chassisLayout = DEFAULT_DYNAMIC_VEHICLE_LAYOUT.chassis;
  const {
    halfExtents = chassisLayout.halfExtents,
    colliderOffset = chassisLayout.colliderOffset,
    centerOfMass = chassisLayout.centerOfMass,
    ...chassisScalars
  } = chassisOptions;
  const wheelDefaultOptions = options.wheelDefaults ?? {};
  const { direction, axle, ...wheelDefaultScalars } = wheelDefaultOptions;
  const wheelLayout = {
    ...DEFAULT_DYNAMIC_VEHICLE_LAYOUT.wheelLayout,
    ...options.wheelLayout,
  };
  const wheels = options.wheels ?? defaultWheelSpecs(wheelLayout);
  const engineForwardSign =
    options.engineForwardSign ?? options.axes?.forwardSign ?? DEFAULT_DYNAMIC_VEHICLE_LAYOUT.engineForwardSign;
  const wheelDefaults = {
    ...DEFAULT_DYNAMIC_VEHICLE_SCALARS.wheelDefaults,
    ...wheelDefaultScalars,
    direction:
      direction ??
      basisObject(
        mergeBasisComponents(DEFAULT_DYNAMIC_VEHICLE_LAYOUT.wheelDirection, options.wheelDirection),
        worldBasis,
      ),
    axle:
      axle ??
      basisObject(mergeBasisComponents(DEFAULT_DYNAMIC_VEHICLE_LAYOUT.wheelAxle, options.wheelAxle), worldBasis),
  };

  return {
    chassis: {
      ...DEFAULT_DYNAMIC_VEHICLE_SCALARS.chassis,
      ...chassisScalars,
      halfExtents: basisHalfExtents(mergeBasisComponents(chassisLayout.halfExtents, halfExtents), worldBasis),
      colliderOffset: basisObject(mergeBasisComponents(chassisLayout.colliderOffset, colliderOffset), worldBasis),
      centerOfMass: basisObject(mergeBasisComponents(chassisLayout.centerOfMass, centerOfMass), worldBasis),
    },
    damping: { ...DEFAULT_DYNAMIC_VEHICLE_SCALARS.damping, ...options.damping },
    solver: { ...DEFAULT_DYNAMIC_VEHICLE_SCALARS.solver, ...options.solver },
    drive: { ...DEFAULT_DYNAMIC_VEHICLE_SCALARS.drive, ...options.drive },
    axes: {
      forwardSign: engineForwardSign,
      forwardAxis: options.axes?.forwardAxis ?? AXIS_INDEX[worldBasis.forwardAxis.axis],
      upAxis: options.axes?.upAxis ?? AXIS_INDEX[worldBasis.upAxis.axis],
    },
    wheelDefaults,
    wheels: wheels.map((wheel) => makeWheel(basisWheelSpec(wheel, worldBasis), wheelDefaults)),
  };
}
