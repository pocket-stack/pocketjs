// playset/math/matrix4.ts — Three.js-compatible math subset for
// @pocketjs/playset. API mirrors three@0.161 (MIT © three.js authors);
// reimplemented from the standard formulas, not copied.

import { Vector3 } from "./vector3.ts";
import type { Quaternion } from "./quaternion.ts";

/**
 * A 4x4 matrix stored column-major in `elements` (like three.js and OpenGL).
 * `set()` takes arguments in row-major order for readability, exactly as
 * three does. Mutating methods return `this` so calls chain.
 *
 * Deliberately lean: only the operations the GameBlocks portable core uses
 * (basis construction consumed by `Quaternion#setFromRotationMatrix`) plus
 * trivially cheap standard companions. No compose/decompose/invert — the
 * inventory shows no usage.
 */
export class Matrix4 {
  readonly isMatrix4: true = true;

  elements: number[];

  constructor() {
    // prettier-ignore
    this.elements = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ];
  }

  /** Arguments are row-major; storage is column-major (three convention). */
  set(
    n11: number, n12: number, n13: number, n14: number,
    n21: number, n22: number, n23: number, n24: number,
    n31: number, n32: number, n33: number, n34: number,
    n41: number, n42: number, n43: number, n44: number,
  ): this {
    const te = this.elements;
    te[0] = n11; te[4] = n12; te[8] = n13; te[12] = n14;
    te[1] = n21; te[5] = n22; te[9] = n23; te[13] = n24;
    te[2] = n31; te[6] = n32; te[10] = n33; te[14] = n34;
    te[3] = n41; te[7] = n42; te[11] = n43; te[15] = n44;
    return this;
  }

  identity(): this {
    return this.set(
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    );
  }

  clone(): Matrix4 {
    return new Matrix4().copy(this);
  }

  copy(m: Matrix4): this {
    const te = this.elements;
    const me = m.elements;
    for (let i = 0; i < 16; i++) te[i] = me[i]!;
    return this;
  }

  /** Sets the upper-3x3 columns to the given basis axes (rest = identity). */
  makeBasis(xAxis: Vector3, yAxis: Vector3, zAxis: Vector3): this {
    return this.set(
      xAxis.x, yAxis.x, zAxis.x, 0,
      xAxis.y, yAxis.y, zAxis.y, 0,
      xAxis.z, yAxis.z, zAxis.z, 0,
      0, 0, 0, 1,
    );
  }

  /** Reads the upper-3x3 columns back out into the given vectors. */
  extractBasis(xAxis: Vector3, yAxis: Vector3, zAxis: Vector3): this {
    xAxis.setFromMatrixColumn(this, 0);
    yAxis.setFromMatrixColumn(this, 1);
    zAxis.setFromMatrixColumn(this, 2);
    return this;
  }

  /** Pure rotation matrix from unit quaternion `q` (translation = 0). */
  makeRotationFromQuaternion(q: Quaternion): this {
    const x = q.x, y = q.y, z = q.z, w = q.w;

    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;

    return this.set(
      1 - (yy + zz), xy - wz, xz + wy, 0,
      xy + wz, 1 - (xx + zz), yz - wx, 0,
      xz - wy, yz + wx, 1 - (xx + yy), 0,
      0, 0, 0, 1,
    );
  }

  /**
   * Rotation-only look-at (three semantics): local -Z ends up pointing from
   * `eye` toward `target`, with `up` as the vertical hint. Degenerate inputs
   * (eye === target, up parallel to view) are nudged exactly like three.
   */
  lookAt(eye: Vector3, target: Vector3, up: Vector3): this {
    const te = this.elements;

    _z.subVectors(eye, target);
    if (_z.lengthSq() === 0) {
      // eye and target are in the same position
      _z.z = 1;
    }
    _z.normalize();

    _x.crossVectors(up, _z);
    if (_x.lengthSq() === 0) {
      // up and z are parallel
      if (Math.abs(up.z) === 1) {
        _z.x += 0.0001;
      } else {
        _z.z += 0.0001;
      }
      _z.normalize();
      _x.crossVectors(up, _z);
    }
    _x.normalize();

    _y.crossVectors(_z, _x);

    te[0] = _x.x; te[4] = _y.x; te[8] = _z.x;
    te[1] = _x.y; te[5] = _y.y; te[9] = _z.y;
    te[2] = _x.z; te[6] = _y.z; te[10] = _z.z;
    return this;
  }

  equals(m: Matrix4): boolean {
    const te = this.elements;
    const me = m.elements;
    for (let i = 0; i < 16; i++) {
      if (te[i] !== me[i]) return false;
    }
    return true;
  }
}

// Module-level scratch temporaries (three's own pattern) — lookAt is
// allocation-free per call.
const _x = /*@__PURE__*/ new Vector3();
const _y = /*@__PURE__*/ new Vector3();
const _z = /*@__PURE__*/ new Vector3();
