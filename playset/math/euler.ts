// playset/math/euler.ts — Three.js-compatible math subset for
// @pocketjs/playset. API mirrors three@0.161 (MIT © three.js authors);
// reimplemented from the standard formulas, not copied.

import { clamp } from "./math-utils.ts";
import { Matrix4 } from "./matrix4.ts";
import { Quaternion } from "./quaternion.ts";

export type EulerOrder = "XYZ" | "YXZ" | "ZXY" | "ZYX" | "YZX" | "XZY";

/**
 * Intrinsic Tait-Bryan angles in radians, applied in `order` (three
 * convention; default 'XYZ'). Mutating methods return `this`.
 */
export class Euler {
  static DEFAULT_ORDER: EulerOrder = "XYZ";

  readonly isEuler: true = true;

  x: number;
  y: number;
  z: number;
  order: EulerOrder;

  constructor(x = 0, y = 0, z = 0, order: EulerOrder = Euler.DEFAULT_ORDER) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.order = order;
  }

  set(x: number, y: number, z: number, order: EulerOrder = this.order): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.order = order;
    return this;
  }

  clone(): Euler {
    return new Euler(this.x, this.y, this.z, this.order);
  }

  copy(euler: Euler): this {
    this.x = euler.x;
    this.y = euler.y;
    this.z = euler.z;
    this.order = euler.order;
    return this;
  }

  /**
   * Extracts euler angles from `m`, whose upper-3x3 is assumed to be a pure
   * (unscaled) rotation matrix. Standard per-order extraction with the same
   * gimbal-lock fallbacks as three.
   */
  setFromRotationMatrix(m: Matrix4, order: EulerOrder = this.order): this {
    const te = m.elements;
    const m11 = te[0]!, m12 = te[4]!, m13 = te[8]!;
    const m21 = te[1]!, m22 = te[5]!, m23 = te[9]!;
    const m31 = te[2]!, m32 = te[6]!, m33 = te[10]!;

    switch (order) {
      case "XYZ":
        this.y = Math.asin(clamp(m13, -1, 1));
        if (Math.abs(m13) < 0.9999999) {
          this.x = Math.atan2(-m23, m33);
          this.z = Math.atan2(-m12, m11);
        } else {
          this.x = Math.atan2(m32, m22);
          this.z = 0;
        }
        break;
      case "YXZ":
        this.x = Math.asin(-clamp(m23, -1, 1));
        if (Math.abs(m23) < 0.9999999) {
          this.y = Math.atan2(m13, m33);
          this.z = Math.atan2(m21, m22);
        } else {
          this.y = Math.atan2(-m31, m11);
          this.z = 0;
        }
        break;
      case "ZXY":
        this.x = Math.asin(clamp(m32, -1, 1));
        if (Math.abs(m32) < 0.9999999) {
          this.y = Math.atan2(-m31, m33);
          this.z = Math.atan2(-m12, m22);
        } else {
          this.y = 0;
          this.z = Math.atan2(m21, m11);
        }
        break;
      case "ZYX":
        this.y = Math.asin(-clamp(m31, -1, 1));
        if (Math.abs(m31) < 0.9999999) {
          this.x = Math.atan2(m32, m33);
          this.z = Math.atan2(m21, m11);
        } else {
          this.x = 0;
          this.z = Math.atan2(-m12, m22);
        }
        break;
      case "YZX":
        this.z = Math.asin(clamp(m21, -1, 1));
        if (Math.abs(m21) < 0.9999999) {
          this.x = Math.atan2(-m23, m22);
          this.y = Math.atan2(-m31, m11);
        } else {
          this.x = 0;
          this.y = Math.atan2(m13, m33);
        }
        break;
      case "XZY":
        this.z = Math.asin(-clamp(m12, -1, 1));
        if (Math.abs(m12) < 0.9999999) {
          this.x = Math.atan2(m32, m22);
          this.y = Math.atan2(m13, m11);
        } else {
          this.x = Math.atan2(-m23, m33);
          this.y = 0;
        }
        break;
    }

    this.order = order;
    return this;
  }

  setFromQuaternion(q: Quaternion, order: EulerOrder = this.order): this {
    _matrix.makeRotationFromQuaternion(q);
    return this.setFromRotationMatrix(_matrix, order);
  }

  /** Re-expresses the same rotation in a different order (may introduce gimbal lock). */
  reorder(newOrder: EulerOrder): this {
    _quaternion.setFromEuler(this);
    return this.setFromQuaternion(_quaternion, newOrder);
  }

  equals(euler: Euler): boolean {
    return (
      euler.x === this.x &&
      euler.y === this.y &&
      euler.z === this.z &&
      euler.order === this.order
    );
  }
}

// Module-level scratch temporaries (three's own pattern).
const _matrix = /*@__PURE__*/ new Matrix4();
const _quaternion = /*@__PURE__*/ new Quaternion();
