// playset/modules/math/world-basis.ts — the single source of truth for
// gameplay-space coordinates: how right/up/forward map onto world axes, and
// every basis-aware helper (planar math, heading, control signs, frames).
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/math/WorldBasis.js. Verbatim semantics. The default basis
// (right=+X, up=+Y, forward=−Z) matches both Three.js convention and
// pocket3d's camera space, so ported motion math needs no re-derivation.

import { Matrix4 } from "../../math/matrix4.ts";
import { Quaternion } from "../../math/quaternion.ts";
import { Vector3 } from "../../math/vector3.ts";

export type AxisName = "x" | "y" | "z";

export interface AxisDescriptor {
  axis: AxisName;
  sign: 1 | -1;
}

/** Loose axis spec: "+x" / "-z" strings or a descriptor object. */
export type AxisSpec = string | { axis: string; sign?: number | string };

export interface WorldBasisConfig {
  right: AxisSpec;
  up: AxisSpec;
  forward: AxisSpec;
}

/** Any object with world components — Vector3, poses, plain literals. */
export interface VecLike {
  x?: number;
  y?: number;
  z?: number;
}

/** A mutable xyz target (Vector3, or anything shaped like one). */
export interface MutableVec {
  x: number;
  y: number;
  z: number;
}

export interface PlanarPair {
  right: number;
  forward: number;
}

export interface BasisComponents {
  right: number;
  up: number;
  forward: number;
}

export interface BasisFrame {
  right: Vector3;
  up: Vector3;
  forward: Vector3;
  back: Vector3;
}

export type ControlDirection =
  | "left"
  | "right"
  | "up"
  | "down"
  | "forward"
  | "backward"
  | "counterClockWise"
  | "clockWise";

const AXES: readonly AxisName[] = ["x", "y", "z"];
const AXIS_EPS = 1e-9;

const DEFAULT_AXES: WorldBasisConfig = Object.freeze({
  right: Object.freeze({ axis: "x", sign: 1 }),
  up: Object.freeze({ axis: "y", sign: 1 }),
  forward: Object.freeze({ axis: "z", sign: -1 }),
});

function readSignal(value: boolean | number | null | undefined): number {
  if (value === true) return 1;
  if (value === false || value == null) return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function parseAxisDescriptor(value: AxisSpec, label: string): AxisDescriptor {
  const raw =
    typeof value === "string"
      ? value
      : value?.axis
        ? `${value.sign === -1 || value.sign === "-" ? "-" : "+"}${value.axis}`
        : null;
  if (typeof raw !== "string") {
    throw new Error(`WorldBasis: ${label} must be an axis string like "+x" or "-z"`);
  }

  const trimmed = raw.trim().toLowerCase();
  const sign = trimmed.startsWith("-") ? -1 : 1;
  const axis = trimmed.replace(/^[+-]/, "") as AxisName;
  if (!AXES.includes(axis)) {
    throw new Error(`WorldBasis: invalid ${label} axis "${raw}"`);
  }
  return { axis, sign };
}

function validateAxes(right: AxisDescriptor, up: AxisDescriptor, forward: AxisDescriptor): void {
  const rawAxes = [right.axis, up.axis, forward.axis];
  if (new Set(rawAxes).size !== 3) {
    throw new Error("WorldBasis: right, up, and forward must use three distinct world axes");
  }

  const r = { x: 0, y: 0, z: 0 };
  const f = { x: 0, y: 0, z: 0 };
  r[right.axis] = right.sign;
  f[forward.axis] = forward.sign;
  const cross = {
    x: r.y * f.z - r.z * f.y,
    y: r.z * f.x - r.x * f.z,
    z: r.x * f.y - r.y * f.x,
  };
  if (cross[up.axis] * up.sign <= 0) {
    throw new Error("WorldBasis: right x forward must point along up");
  }
}

function readComponent(value: VecLike | null | undefined, axis: AxisName): number {
  return value?.[axis] ?? 0;
}

export class WorldBasis {
  readonly rightAxis: Readonly<AxisDescriptor>;
  readonly upAxis: Readonly<AxisDescriptor>;
  readonly forwardAxis: Readonly<AxisDescriptor>;
  /** Multiply a positive control delta by these to get signed movement or a
   *  right-hand-rule rotation angle. */
  readonly controlSigns: Readonly<Record<ControlDirection, number>>;

  constructor(config: WorldBasisConfig = DEFAULT_AXES) {
    const right = parseAxisDescriptor(config.right, "right");
    const up = parseAxisDescriptor(config.up, "up");
    const forward = parseAxisDescriptor(config.forward, "forward");

    validateAxes(right, up, forward);

    this.rightAxis = Object.freeze(right);
    this.upAxis = Object.freeze(up);
    this.forwardAxis = Object.freeze(forward);

    this.controlSigns = Object.freeze({
      left: -1,
      right: 1,
      up: 1,
      down: -1,
      forward: 1,
      backward: -1,
      counterClockWise: 1,
      clockWise: -1,
    });
  }

  rightVector(target: Vector3 = new Vector3()): Vector3 {
    target.set(0, 0, 0);
    target[this.rightAxis.axis] = this.rightAxis.sign;
    return target;
  }

  upVector(target: Vector3 = new Vector3()): Vector3 {
    target.set(0, 0, 0);
    target[this.upAxis.axis] = this.upAxis.sign;
    return target;
  }

  downVector(target: Vector3 = new Vector3()): Vector3 {
    return this.upVector(target).multiplyScalar(-1);
  }

  forwardVector(target: Vector3 = new Vector3()): Vector3 {
    target.set(0, 0, 0);
    target[this.forwardAxis.axis] = this.forwardAxis.sign;
    return target;
  }

  rightComponent(value: VecLike | null | undefined): number {
    return readComponent(value, this.rightAxis.axis) * this.rightAxis.sign;
  }

  upComponent(value: VecLike | null | undefined): number {
    return readComponent(value, this.upAxis.axis) * this.upAxis.sign;
  }

  forwardComponent(value: VecLike | null | undefined): number {
    return readComponent(value, this.forwardAxis.axis) * this.forwardAxis.sign;
  }

  setHeight<T extends MutableVec>(target: T, height = 0): T {
    target[this.upAxis.axis] = this.upAxis.sign * height;
    return target;
  }

  flatten<T extends MutableVec>(target: T): T {
    return this.setHeight(target, 0);
  }

  addHeight<T extends MutableVec>(target: T, delta = 0): T {
    target[this.upAxis.axis] =
      readComponent(target, this.upAxis.axis) + this.upAxis.sign * delta;
    return target;
  }

  hasWorldPlanarComponents(value: VecLike | null | undefined): boolean {
    return (
      Boolean(value) &&
      Number.isFinite(value?.[this.rightAxis.axis]) &&
      Number.isFinite(value?.[this.forwardAxis.axis])
    );
  }

  toPlanar(value: VecLike | null | undefined, out: PlanarPair = { right: 0, forward: 0 }): PlanarPair {
    out.right = this.rightComponent(value);
    out.forward = this.forwardComponent(value);
    return out;
  }

  planarDelta(
    to: VecLike | null | undefined,
    from: VecLike | null | undefined,
    out: PlanarPair = { right: 0, forward: 0 },
  ): PlanarPair {
    out.right = this.rightComponent(to) - this.rightComponent(from);
    out.forward = this.forwardComponent(to) - this.forwardComponent(from);
    return out;
  }

  fromBasisComponents(right = 0, up = 0, forward = 0, target: Vector3 = new Vector3()): Vector3 {
    target.set(0, 0, 0);
    target[this.rightAxis.axis] = this.rightAxis.sign * right;
    target[this.upAxis.axis] = this.upAxis.sign * up;
    target[this.forwardAxis.axis] = this.forwardAxis.sign * forward;
    return target;
  }

  toBasisComponents(
    value: VecLike | null | undefined,
    out: BasisComponents = { right: 0, up: 0, forward: 0 },
  ): BasisComponents {
    out.right = this.rightComponent(value);
    out.up = this.upComponent(value);
    out.forward = this.forwardComponent(value);
    return out;
  }

  controlSignal(direction: ControlDirection, signal: boolean | number | null | undefined): number {
    if (Object.prototype.hasOwnProperty.call(this.controlSigns, direction)) {
      return this.controlSigns[direction] * readSignal(signal);
    }
    throw new Error(`WorldBasis: unknown control direction "${direction as string}"`);
  }

  surfaceNormalFromSlopes(rightSlope = 0, forwardSlope = 0, target: Vector3 = new Vector3()): Vector3 {
    // For P(r, f) = r*right + h(r,f)*up + f*forward, an up-facing normal is
    // P_f x P_r = up - h_r*right - h_f*forward.
    return this.fromBasisComponents(-rightSlope, 1, -forwardSlope, target).normalize();
  }

  // Angles are radians. Using the right-hand rule, positive rotation is
  // counter-clockwise when looking from the positive end of the rotation axis
  // toward the origin.
  // yaw is positive CCW from the +up side;
  // pitch is positive CCW from the +right side;
  // roll is positive CCW from the +forward side.
  yawPitchRollFrame(yaw = 0, pitch = 0, roll = 0): BasisFrame {
    const pitchCos = Math.cos(pitch);
    const forward = this.fromBasisComponents(
      -Math.sin(yaw) * pitchCos,
      Math.sin(pitch),
      Math.cos(yaw) * pitchCos,
    ).normalize();
    const right = this.fromBasisComponents(Math.cos(yaw), 0, Math.sin(yaw)).normalize();
    const up = new Vector3().crossVectors(right, forward).normalize();

    if (roll) {
      right.applyAxisAngle(forward, roll).normalize();
      up.applyAxisAngle(forward, roll).normalize();
    }

    return {
      right,
      up,
      forward,
      back: forward.clone().multiplyScalar(-1),
    };
  }

  distanceSqPlanar(a: VecLike | null | undefined, b: VecLike | null | undefined): number {
    const dRight = this.rightComponent(a) - this.rightComponent(b);
    const dForward = this.forwardComponent(a) - this.forwardComponent(b);
    return dRight * dRight + dForward * dForward;
  }

  planarLength(value: VecLike | null | undefined): number {
    const right = this.rightComponent(value);
    const forward = this.forwardComponent(value);
    return Math.sqrt(right * right + forward * forward);
  }

  sideVector(value: VecLike | null | undefined, preferredDirection = 1, target: Vector3 = new Vector3()): Vector3 {
    const right = this.rightComponent(value);
    const forward = this.forwardComponent(value);
    return this.fromBasisComponents(forward * preferredDirection, 0, -right * preferredDirection, target);
  }

  threeObjectCanonicalToBasisQuaternion(target: Quaternion = new Quaternion()): Quaternion {
    // Upright mesh canonical: +X <-> right, +Y <-> up, -Z <-> forward
    return target.setFromRotationMatrix(
      new Matrix4().makeBasis(
        this.rightVector(),
        this.upVector(),
        this.forwardVector().multiplyScalar(-1),
      ),
    );
  }

  threePlaneCanonicalToBasisQuaternion(target: Quaternion = new Quaternion()): Quaternion {
    // PlaneGeometry canonical: +X <-> right, +Y <-> forward, +Z <-> up
    return target.setFromRotationMatrix(
      new Matrix4().makeBasis(this.rightVector(), this.forwardVector(), this.upVector()),
    );
  }

  forwardToYaw(forward: VecLike | null | undefined): number {
    const right = this.rightComponent(forward);
    const forwardComponent = this.forwardComponent(forward);
    if (right * right + forwardComponent * forwardComponent <= AXIS_EPS) return 0;
    return Math.atan2(-right, forwardComponent);
  }
}

export const DEFAULT_WORLD_BASIS: WorldBasis = Object.freeze(new WorldBasis(DEFAULT_AXES));

export function createWorldBasis(config: WorldBasisConfig = DEFAULT_AXES): WorldBasis {
  return new WorldBasis(config);
}
