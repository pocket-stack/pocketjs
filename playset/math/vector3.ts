// playset/math/vector3.ts — Three.js-compatible math subset for
// @pocketjs/playset. API mirrors three@0.161 (MIT © three.js authors);
// reimplemented from the standard formulas, not copied.

import { clamp } from "./math-utils.ts";
import { Quaternion } from "./quaternion.ts";
import type { Euler } from "./euler.ts";
import type { Matrix4 } from "./matrix4.ts";

/**
 * Structural stand-in for three's BufferAttribute in
 * `Vector3#fromBufferAttribute` — anything exposing per-index component
 * getters works (including a real three BufferAttribute).
 */
export interface BufferAttributeLike {
  getX(index: number): number;
  getY(index: number): number;
  getZ(index: number): number;
}

/**
 * A 3-component vector with plain `x`/`y`/`z` fields (GameBlocks indexes them
 * dynamically as `v[axis]`). Mutating methods return `this` so calls chain
 * exactly like three.js.
 */
export class Vector3 {
  readonly isVector3: true = true;

  x: number;
  y: number;
  z: number;

  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  setScalar(scalar: number): this {
    this.x = scalar;
    this.y = scalar;
    this.z = scalar;
    return this;
  }

  setX(x: number): this {
    this.x = x;
    return this;
  }

  setY(y: number): this {
    this.y = y;
    return this;
  }

  setZ(z: number): this {
    this.z = z;
    return this;
  }

  clone(): Vector3 {
    return new Vector3(this.x, this.y, this.z);
  }

  copy(v: Vector3): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  add(v: Vector3): this {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  addVectors(a: Vector3, b: Vector3): this {
    this.x = a.x + b.x;
    this.y = a.y + b.y;
    this.z = a.z + b.z;
    return this;
  }

  addScaledVector(v: Vector3, s: number): this {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }

  sub(v: Vector3): this {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  subVectors(a: Vector3, b: Vector3): this {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    this.z = a.z - b.z;
    return this;
  }

  multiply(v: Vector3): this {
    this.x *= v.x;
    this.y *= v.y;
    this.z *= v.z;
    return this;
  }

  multiplyScalar(scalar: number): this {
    this.x *= scalar;
    this.y *= scalar;
    this.z *= scalar;
    return this;
  }

  divide(v: Vector3): this {
    this.x /= v.x;
    this.y /= v.y;
    this.z /= v.z;
    return this;
  }

  divideScalar(scalar: number): this {
    return this.multiplyScalar(1 / scalar);
  }

  negate(): this {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  dot(v: Vector3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  length(): number {
    return Math.sqrt(this.lengthSq());
  }

  /** Normalizes in place; a zero vector stays (0, 0, 0), as in three. */
  normalize(): this {
    return this.divideScalar(this.length() || 1);
  }

  /** Sets this vector's magnitude to `length` (zero vector stays zero). */
  setLength(length: number): this {
    return this.normalize().multiplyScalar(length);
  }

  lerp(v: Vector3, alpha: number): this {
    this.x += (v.x - this.x) * alpha;
    this.y += (v.y - this.y) * alpha;
    this.z += (v.z - this.z) * alpha;
    return this;
  }

  lerpVectors(v1: Vector3, v2: Vector3, alpha: number): this {
    this.x = v1.x + (v2.x - v1.x) * alpha;
    this.y = v1.y + (v2.y - v1.y) * alpha;
    this.z = v1.z + (v2.z - v1.z) * alpha;
    return this;
  }

  cross(v: Vector3): this {
    return this.crossVectors(this, v);
  }

  crossVectors(a: Vector3, b: Vector3): this {
    const ax = a.x, ay = a.y, az = a.z;
    const bx = b.x, by = b.y, bz = b.z;

    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }

  /** Projects this vector onto `v` (becomes zero if `v` is zero-length). */
  projectOnVector(v: Vector3): this {
    const denominator = v.lengthSq();
    if (denominator === 0) return this.set(0, 0, 0);
    const scalar = v.dot(this) / denominator;
    return this.copy(v).multiplyScalar(scalar);
  }

  /**
   * Removes the component of this vector along `planeNormal`, projecting it
   * onto the plane through the origin with that normal. A zero-length normal
   * leaves the vector unchanged (three's behavior).
   */
  projectOnPlane(planeNormal: Vector3): this {
    _vector.copy(this).projectOnVector(planeNormal);
    return this.sub(_vector);
  }

  /** Applies rotation `q` (assumed unit length): v' = q · v · q*. */
  applyQuaternion(q: Quaternion): this {
    const vx = this.x, vy = this.y, vz = this.z;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;

    // t = 2 · cross(q.xyz, v)
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);

    // v' = v + w·t + cross(q.xyz, t)
    this.x = vx + qw * tx + qy * tz - qz * ty;
    this.y = vy + qw * ty + qz * tx - qx * tz;
    this.z = vz + qw * tz + qx * ty - qy * tx;
    return this;
  }

  /** Rotates about `axis` (assumed normalized) by `angle` radians. */
  applyAxisAngle(axis: Vector3, angle: number): this {
    return this.applyQuaternion(_quaternion.setFromAxisAngle(axis, angle));
  }

  applyEuler(euler: Euler): this {
    return this.applyQuaternion(_quaternion.setFromEuler(euler));
  }

  /** Applies `m` as a full 4x4 transform, including the perspective divide. */
  applyMatrix4(m: Matrix4): this {
    const x = this.x, y = this.y, z = this.z;
    const e = m.elements;

    const w = 1 / (e[3]! * x + e[7]! * y + e[11]! * z + e[15]!);
    this.x = (e[0]! * x + e[4]! * y + e[8]! * z + e[12]!) * w;
    this.y = (e[1]! * x + e[5]! * y + e[9]! * z + e[13]!) * w;
    this.z = (e[2]! * x + e[6]! * y + e[10]! * z + e[14]!) * w;
    return this;
  }

  distanceTo(v: Vector3): number {
    return Math.sqrt(this.distanceToSquared(v));
  }

  distanceToSquared(v: Vector3): number {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    const dz = this.z - v.z;
    return dx * dx + dy * dy + dz * dz;
  }

  /** Angle to `v` in radians; PI/2 if either vector is zero-length. */
  angleTo(v: Vector3): number {
    const denominator = Math.sqrt(this.lengthSq() * v.lengthSq());
    if (denominator === 0) return Math.PI / 2;
    const theta = this.dot(v) / denominator;
    return Math.acos(clamp(theta, -1, 1));
  }

  /** Copies matrix column `index` (0-3) of `m` into this vector. */
  setFromMatrixColumn(m: Matrix4, index: number): this {
    return this.fromArray(m.elements, index * 4);
  }

  /** Copies the translation part of `m` into this vector. */
  setFromMatrixPosition(m: Matrix4): this {
    const e = m.elements;
    this.x = e[12]!;
    this.y = e[13]!;
    this.z = e[14]!;
    return this;
  }

  fromBufferAttribute(attribute: BufferAttributeLike, index: number): this {
    this.x = attribute.getX(index);
    this.y = attribute.getY(index);
    this.z = attribute.getZ(index);
    return this;
  }

  equals(v: Vector3): boolean {
    return v.x === this.x && v.y === this.y && v.z === this.z;
  }

  fromArray(array: ArrayLike<number>, offset = 0): this {
    this.x = array[offset]!;
    this.y = array[offset + 1]!;
    this.z = array[offset + 2]!;
    return this;
  }

  toArray(array: number[] = [], offset = 0): number[] {
    array[offset] = this.x;
    array[offset + 1] = this.y;
    array[offset + 2] = this.z;
    return array;
  }
}

// Module-level scratch temporaries — mirrors three's own approach so hot
// methods never allocate.
const _vector = /*@__PURE__*/ new Vector3();
const _quaternion = /*@__PURE__*/ new Quaternion();
