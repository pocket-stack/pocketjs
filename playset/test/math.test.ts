// playset/test/math.test.ts — semantics of the three@0.161-compatible math
// subset in playset/math/. Every method in the GameBlocks usage inventory is
// asserted with hand-computed or property-based expectations, plus chained
// sequences replicated from real GameBlocks call sites.

import { describe, expect, test } from "bun:test";
import {
  Color,
  ColorManagement,
  Euler,
  LinearToSRGB,
  MathUtils,
  Matrix4,
  Quaternion,
  SRGBToLinear,
  Vector3,
} from "../math/index.ts";

const SQRT1_2 = Math.SQRT1_2;

function expectVec3(v: Vector3, x: number, y: number, z: number, digits = 10) {
  expect(v.x).toBeCloseTo(x, digits);
  expect(v.y).toBeCloseTo(y, digits);
  expect(v.z).toBeCloseTo(z, digits);
}

function expectQuat(q: Quaternion, x: number, y: number, z: number, w: number, digits = 10) {
  expect(q.x).toBeCloseTo(x, digits);
  expect(q.y).toBeCloseTo(y, digits);
  expect(q.z).toBeCloseTo(z, digits);
  expect(q.w).toBeCloseTo(w, digits);
}

/** |q1 · q2| ≈ 1 ⇔ same rotation (quaternion double cover). */
function expectSameRotation(a: Quaternion, b: Quaternion, digits = 10) {
  expect(Math.abs(a.dot(b))).toBeCloseTo(1, digits);
}

describe("Vector3", () => {
  test("constructor defaults and explicit components", () => {
    expectVec3(new Vector3(), 0, 0, 0);
    expectVec3(new Vector3(1, 2, 3), 1, 2, 3);
    expect(new Vector3().isVector3).toBe(true);
  });

  test("plain x/y/z fields support dynamic axis indexing (WorldBasis pattern)", () => {
    const v = new Vector3();
    const axis: "x" | "y" | "z" = "z";
    v[axis] = -1; // WorldBasis: target[this.forwardAxis.axis] = sign
    expectVec3(v, 0, 0, -1);
    expect(v[axis]).toBe(-1);
  });

  test("set / setScalar / setX / setY / setZ return this and chain", () => {
    const v = new Vector3();
    expect(v.set(1, 2, 3)).toBe(v);
    expectVec3(v, 1, 2, 3);
    v.setScalar(7);
    expectVec3(v, 7, 7, 7);
    v.setX(1).setY(2).setZ(3);
    expectVec3(v, 1, 2, 3);
  });

  test("copy / clone", () => {
    const a = new Vector3(1, 2, 3);
    const b = new Vector3().copy(a);
    expectVec3(b, 1, 2, 3);
    const c = a.clone();
    expect(c).not.toBe(a);
    expectVec3(c, 1, 2, 3);
    c.x = 99;
    expect(a.x).toBe(1); // clone is independent
  });

  test("add / addVectors / sub / subVectors / addScaledVector", () => {
    expectVec3(new Vector3(1, 2, 3).add(new Vector3(4, 5, 6)), 5, 7, 9);
    expectVec3(new Vector3().addVectors(new Vector3(1, 1, 1), new Vector3(2, 3, 4)), 3, 4, 5);
    expectVec3(new Vector3(5, 7, 9).sub(new Vector3(4, 5, 6)), 1, 2, 3);
    expectVec3(new Vector3().subVectors(new Vector3(5, 7, 9), new Vector3(4, 5, 6)), 1, 2, 3);
    expectVec3(new Vector3(1, 2, 3).addScaledVector(new Vector3(10, 20, 30), 0.5), 6, 12, 18);
  });

  test("multiply / multiplyScalar / divide / divideScalar / negate", () => {
    expectVec3(new Vector3(1, 2, 3).multiply(new Vector3(2, 3, 4)), 2, 6, 12);
    expectVec3(new Vector3(1, 2, 3).multiplyScalar(-2), -2, -4, -6);
    expectVec3(new Vector3(4, 9, 16).divide(new Vector3(2, 3, 4)), 2, 3, 4);
    expectVec3(new Vector3(2, 4, 6).divideScalar(2), 1, 2, 3);
    expectVec3(new Vector3(1, -2, 3).negate(), -1, 2, -3);
  });

  test("dot / length / lengthSq / distanceTo / distanceToSquared", () => {
    expect(new Vector3(1, 2, 3).dot(new Vector3(4, -5, 6))).toBe(12);
    expect(new Vector3(3, 4, 0).length()).toBe(5);
    expect(new Vector3(1, 2, 3).lengthSq()).toBe(14);
    expect(new Vector3(1, 2, 3).distanceTo(new Vector3(1, 2, 8))).toBe(5);
    expect(new Vector3(1, 2, 3).distanceToSquared(new Vector3(2, 4, 5))).toBe(9);
  });

  test("normalize; zero vector stays (0,0,0) like three", () => {
    expectVec3(new Vector3(0, 3, 4).normalize(), 0, 0.6, 0.8);
    expectVec3(new Vector3(0, 0, 0).normalize(), 0, 0, 0);
    expect(new Vector3(0, 0, 0).normalize().length()).toBe(0);
  });

  test("setLength; zero vector stays zero", () => {
    expectVec3(new Vector3(0, 3, 4).setLength(10), 0, 6, 8);
    expectVec3(new Vector3().setLength(10), 0, 0, 0);
  });

  test("lerp / lerpVectors endpoints and midpoint", () => {
    const a = new Vector3(0, 10, -4);
    const b = new Vector3(8, 20, 4);
    expectVec3(a.clone().lerp(b, 0), 0, 10, -4);
    expectVec3(a.clone().lerp(b, 1), 8, 20, 4);
    expectVec3(a.clone().lerp(b, 0.5), 4, 15, 0);
    expectVec3(new Vector3().lerpVectors(a, b, 0.25), 2, 12.5, -2);
  });

  test("cross / crossVectors right-handed basis identities", () => {
    expectVec3(new Vector3().crossVectors(new Vector3(1, 0, 0), new Vector3(0, 1, 0)), 0, 0, 1);
    expectVec3(new Vector3().crossVectors(new Vector3(0, 1, 0), new Vector3(0, 0, 1)), 1, 0, 0);
    expectVec3(new Vector3(1, 0, 0).cross(new Vector3(0, 0, -1)), 0, 1, 0);
    expectVec3(new Vector3(2, 3, 4).cross(new Vector3(2, 3, 4)), 0, 0, 0);
  });

  test("projectOnVector; zero target vector gives (0,0,0)", () => {
    expectVec3(new Vector3(3, 4, 0).projectOnVector(new Vector3(10, 0, 0)), 3, 0, 0);
    expectVec3(new Vector3(3, 4, 5).projectOnVector(new Vector3()), 0, 0, 0);
  });

  test("projectOnPlane removes the normal component; zero normal is a no-op", () => {
    expectVec3(new Vector3(3, 4, 5).projectOnPlane(new Vector3(0, 1, 0)), 3, 0, 5);
    // Non-axis-aligned normal: result must be perpendicular to the normal.
    const n = new Vector3(1, 2, 2).normalize();
    const v = new Vector3(5, -3, 1).projectOnPlane(n);
    expect(v.dot(n)).toBeCloseTo(0, 12);
    expectVec3(new Vector3(3, 4, 5).projectOnPlane(new Vector3()), 3, 4, 5);
  });

  test("applyQuaternion rotates basis vectors (90° about each axis)", () => {
    const qz = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    expectVec3(new Vector3(1, 0, 0).applyQuaternion(qz), 0, 1, 0);
    const qx = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    expectVec3(new Vector3(0, 1, 0).applyQuaternion(qx), 0, 0, 1);
    const qy = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    expectVec3(new Vector3(0, 0, 1).applyQuaternion(qy), 1, 0, 0);
    // Identity leaves the vector untouched.
    expectVec3(new Vector3(1, 2, 3).applyQuaternion(new Quaternion()), 1, 2, 3);
  });

  test("applyAxisAngle matches applyQuaternion(setFromAxisAngle)", () => {
    const axis = new Vector3(1, 1, 1).normalize();
    const a = new Vector3(1, 2, 3).applyAxisAngle(axis, 0.7);
    const b = new Vector3(1, 2, 3).applyQuaternion(
      new Quaternion().setFromAxisAngle(axis, 0.7),
    );
    expectVec3(a, b.x, b.y, b.z, 12);
    // Rotation preserves length.
    expect(a.length()).toBeCloseTo(Math.sqrt(14), 12);
  });

  test("applyEuler matches applyQuaternion(setFromEuler)", () => {
    const e = new Euler(0.3, -0.2, 0.5, "XYZ");
    const a = new Vector3(1, 2, 3).applyEuler(e);
    const b = new Vector3(1, 2, 3).applyQuaternion(new Quaternion().setFromEuler(e));
    expectVec3(a, b.x, b.y, b.z, 12);
  });

  test("applyMatrix4 rotates and applies the perspective divide", () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    const m = new Matrix4().makeRotationFromQuaternion(q);
    expectVec3(new Vector3(1, 0, 0).applyMatrix4(m), 0, 1, 0);
    // w row scales by 1/2.
    const half = new Matrix4().set(
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 2,
    );
    expectVec3(new Vector3(4, 6, 8).applyMatrix4(half), 2, 3, 4);
  });

  test("angleTo; zero vector yields PI/2 like three", () => {
    expect(new Vector3(1, 0, 0).angleTo(new Vector3(0, 1, 0))).toBeCloseTo(Math.PI / 2, 12);
    expect(new Vector3(1, 0, 0).angleTo(new Vector3(-2, 0, 0))).toBeCloseTo(Math.PI, 12);
    expect(new Vector3().angleTo(new Vector3(1, 0, 0))).toBeCloseTo(Math.PI / 2, 12);
  });

  test("setFromMatrixColumn / setFromMatrixPosition", () => {
    const m = new Matrix4().makeBasis(
      new Vector3(1, 2, 3),
      new Vector3(4, 5, 6),
      new Vector3(7, 8, 9),
    );
    expectVec3(new Vector3().setFromMatrixColumn(m, 0), 1, 2, 3);
    expectVec3(new Vector3().setFromMatrixColumn(m, 1), 4, 5, 6);
    expectVec3(new Vector3().setFromMatrixColumn(m, 2), 7, 8, 9);
    const t = new Matrix4().set(
      1, 0, 0, 10,
      0, 1, 0, 20,
      0, 0, 1, 30,
      0, 0, 0, 1,
    );
    expectVec3(new Vector3().setFromMatrixPosition(t), 10, 20, 30);
  });

  test("fromBufferAttribute reads indexed components (RockVisualFactory pattern)", () => {
    const data = [1, 2, 3, 4, 5, 6];
    const attribute = {
      getX: (i: number) => data[i * 3]!,
      getY: (i: number) => data[i * 3 + 1]!,
      getZ: (i: number) => data[i * 3 + 2]!,
    };
    expectVec3(new Vector3().fromBufferAttribute(attribute, 1), 4, 5, 6);
  });

  test("equals / fromArray / toArray", () => {
    expect(new Vector3(1, 2, 3).equals(new Vector3(1, 2, 3))).toBe(true);
    expect(new Vector3(1, 2, 3).equals(new Vector3(1, 2, 4))).toBe(false);
    expectVec3(new Vector3().fromArray([9, 8, 7, 6], 1), 8, 7, 6);
    expect(new Vector3(1, 2, 3).toArray()).toEqual([1, 2, 3]);
    const out = [0, 0, 0, 0, 0];
    new Vector3(1, 2, 3).toArray(out, 2);
    expect(out).toEqual([0, 0, 1, 2, 3]);
  });
});

describe("Quaternion", () => {
  test("constructor defaults to identity; set/copy/clone", () => {
    expectQuat(new Quaternion(), 0, 0, 0, 1);
    expect(new Quaternion().isQuaternion).toBe(true);
    const q = new Quaternion().set(1, 2, 3, 4);
    expectQuat(q, 1, 2, 3, 4);
    expectQuat(new Quaternion().copy(q), 1, 2, 3, 4);
    const c = q.clone();
    expect(c).not.toBe(q);
    expectQuat(c, 1, 2, 3, 4);
  });

  test("identity resets after arbitrary rotation (model.quaternion.identity() pattern)", () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 1.3);
    q.identity();
    expectQuat(q, 0, 0, 0, 1);
    expectVec3(new Vector3(1, 2, 3).applyQuaternion(q), 1, 2, 3);
  });

  test("setFromAxisAngle hand-computed half-angle components", () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    expectQuat(q, 0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4), 12);
  });

  test("multiply applies the argument's rotation first (three order)", () => {
    const yaw90 = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const pitch90 = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    // (yaw90 * pitch90) v  ==  yaw90 (pitch90 v)
    const composed = yaw90.clone().multiply(pitch90);
    const v = new Vector3(0, 1, 0);
    // pitch90 first: (0,1,0) -> (0,0,1); then yaw90: (0,0,1) -> (1,0,0)
    expectVec3(v.clone().applyQuaternion(composed), 1, 0, 0);
    const stepwise = v.clone().applyQuaternion(pitch90).applyQuaternion(yaw90);
    expectVec3(stepwise, 1, 0, 0);
  });

  test("premultiply(q) equals q * this (NaturalEnvironment prop pattern)", () => {
    const a = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.6);
    const b = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -0.4);
    const viaPre = a.clone().premultiply(b);
    const viaMul = new Quaternion().multiplyQuaternions(b, a);
    expectSameRotation(viaPre, viaMul, 12);
    expectQuat(viaPre, viaMul.x, viaMul.y, viaMul.z, viaMul.w, 12);
  });

  test("normalize; zero quaternion becomes identity", () => {
    const q = new Quaternion(0, 0, 3, 4).normalize();
    expectQuat(q, 0, 0, 0.6, 0.8, 12);
    expectQuat(new Quaternion(0, 0, 0, 0).normalize(), 0, 0, 0, 1);
  });

  test("invert / conjugate undo a rotation (unit quaternion)", () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 2, -1).normalize(), 0.9);
    const v = new Vector3(3, -1, 2);
    const roundTrip = v.clone().applyQuaternion(q).applyQuaternion(q.clone().invert());
    expectVec3(roundTrip, 3, -1, 2, 12);
    expectQuat(new Quaternion(1, 2, 3, 4).conjugate(), -1, -2, -3, 4);
  });

  test("dot / length / lengthSq / angleTo", () => {
    expect(new Quaternion(1, 2, 3, 4).dot(new Quaternion(5, 6, 7, 8))).toBe(70);
    expect(new Quaternion(0, 0, 3, 4).length()).toBe(5);
    expect(new Quaternion(1, 2, 3, 4).lengthSq()).toBe(30);
    const a = new Quaternion();
    const b = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.8);
    expect(a.angleTo(b)).toBeCloseTo(0.8, 10);
  });

  test("setFromRotationMatrix inverts makeRotationFromQuaternion (all four trace branches)", () => {
    const cases = [
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.3), // trace > 0
      new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI), // m11 branch
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI), // m22 branch
      new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI), // m33 branch
      new Quaternion().setFromAxisAngle(new Vector3(1, 1, 1).normalize(), 2.5),
    ];
    for (const q of cases) {
      const m = new Matrix4().makeRotationFromQuaternion(q);
      const out = new Quaternion().setFromRotationMatrix(m);
      expectSameRotation(out, q, 10);
      // Same action on a probe vector.
      const probe = new Vector3(0.4, -1.2, 2.2);
      const a = probe.clone().applyQuaternion(q);
      const b = probe.clone().applyQuaternion(out);
      expectVec3(a, b.x, b.y, b.z, 10);
    }
  });

  test("setFromUnitVectors: aligned, perpendicular, and both antiparallel branches", () => {
    // Identical vectors -> identity.
    const same = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(0, 1, 0));
    expectQuat(same, 0, 0, 0, 1, 12);
    // Perpendicular (ProjectileVisualFactory: cone +Y onto direction).
    const dir = new Vector3(0.6, 0, 0.8);
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir);
    expectVec3(new Vector3(0, 1, 0).applyQuaternion(q), 0.6, 0, 0.8, 12);
    // Antiparallel, |x| <= |z| branch: (0,1,0) -> (0,-1,0) rotates about z.
    const flipY = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(0, -1, 0));
    expectQuat(flipY, 0, 0, 1, 0, 12);
    expectVec3(new Vector3(0, 1, 0).applyQuaternion(flipY), 0, -1, 0, 12);
    // Antiparallel, |x| > |z| branch: (1,0,0) -> (-1,0,0) rotates about y.
    const flipX = new Quaternion().setFromUnitVectors(new Vector3(1, 0, 0), new Vector3(-1, 0, 0));
    expectQuat(flipX, 0, 1, 0, 0, 12);
    expectVec3(new Vector3(1, 0, 0).applyQuaternion(flipX), -1, 0, 0, 12);
  });

  test("slerp endpoints, midpoint, and shortest-arc negation", () => {
    const start = new Quaternion();
    const end = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    expectQuat(start.clone().slerp(end, 0), 0, 0, 0, 1);
    expectQuat(start.clone().slerp(end, 1), end.x, end.y, end.z, end.w);
    // Midpoint = 45° about z.
    const mid = start.clone().slerp(end, 0.5);
    const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 4);
    expectQuat(mid, expected.x, expected.y, expected.z, expected.w, 12);
    // -end is the same rotation; slerp must take the short way round.
    const endNeg = new Quaternion(-end.x, -end.y, -end.z, -end.w);
    const mid2 = start.clone().slerp(endNeg, 0.5);
    expectVec3(new Vector3(1, 0, 0).applyQuaternion(mid2), SQRT1_2, SQRT1_2, 0, 12);
    // Nearly-identical rotations fall back to nlerp and stay unit length.
    const tiny = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 1e-9);
    expect(start.clone().slerp(tiny, 0.5).length()).toBeCloseTo(1, 12);
  });

  test("slerpQuaternions writes the interpolation of its arguments", () => {
    const a = new Quaternion();
    const b = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 1.0);
    const out = new Quaternion().slerpQuaternions(a, b, 0.5);
    const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.5);
    expectQuat(out, expected.x, expected.y, expected.z, expected.w, 12);
  });

  test("equals / fromArray / toArray", () => {
    expect(new Quaternion(1, 2, 3, 4).equals(new Quaternion(1, 2, 3, 4))).toBe(true);
    expect(new Quaternion(1, 2, 3, 4).equals(new Quaternion(1, 2, 3, 5))).toBe(false);
    expectQuat(new Quaternion().fromArray([9, 1, 2, 3, 4], 1), 1, 2, 3, 4);
    expect(new Quaternion(1, 2, 3, 4).toArray()).toEqual([1, 2, 3, 4]);
  });
});

describe("Matrix4", () => {
  test("constructor is identity, column-major storage, row-major set()", () => {
    expect(new Matrix4().elements).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const m = new Matrix4().set(
      11, 12, 13, 14,
      21, 22, 23, 24,
      31, 32, 33, 34,
      41, 42, 43, 44,
    );
    // Column 0 is the first column of the row-major arguments.
    expect(m.elements.slice(0, 4)).toEqual([11, 21, 31, 41]);
    expect(m.elements[4]).toBe(12); // m12 lives at elements[4]
    expect(m.elements[12]).toBe(14); // translation x at elements[12]
  });

  test("identity / copy / clone / equals", () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.4);
    const m = new Matrix4().makeRotationFromQuaternion(q);
    const c = m.clone();
    expect(c).not.toBe(m);
    expect(c.equals(m)).toBe(true);
    expect(new Matrix4().copy(m).equals(m)).toBe(true);
    expect(m.identity().equals(new Matrix4())).toBe(true);
  });

  test("makeBasis stores the axes as columns; extractBasis reads them back", () => {
    const x = new Vector3(0, 0, -1);
    const y = new Vector3(0, 1, 0);
    const z = new Vector3(1, 0, 0);
    const m = new Matrix4().makeBasis(x, y, z);
    expect(m.elements.slice(0, 3)).toEqual([0, 0, -1]);
    expect(m.elements.slice(4, 7)).toEqual([0, 1, 0]);
    expect(m.elements.slice(8, 11)).toEqual([1, 0, 0]);
    expect(m.elements[15]).toBe(1);
    const ox = new Vector3();
    const oy = new Vector3();
    const oz = new Vector3();
    m.extractBasis(ox, oy, oz);
    expectVec3(ox, 0, 0, -1);
    expectVec3(oy, 0, 1, 0);
    expectVec3(oz, 1, 0, 0);
  });

  test("makeRotationFromQuaternion columns are the rotated basis vectors", () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 1.1);
    const m = new Matrix4().makeRotationFromQuaternion(q);
    const col = new Vector3();
    for (const [i, unit] of [
      [0, new Vector3(1, 0, 0)],
      [1, new Vector3(0, 1, 0)],
      [2, new Vector3(0, 0, 1)],
    ] as const) {
      col.setFromMatrixColumn(m, i);
      const rotated = unit.clone().applyQuaternion(q);
      expectVec3(col, rotated.x, rotated.y, rotated.z, 12);
    }
  });

  test("lookAt: straight down -z is identity; matches manual basis construction", () => {
    const identity = new Matrix4().lookAt(
      new Vector3(0, 0, 0),
      new Vector3(0, 0, -1),
      new Vector3(0, 1, 0),
    );
    expect(identity.equals(new Matrix4())).toBe(true);
    // Looking along +x from (1,2,3): forward = (1,0,0).
    const m = new Matrix4().lookAt(new Vector3(1, 2, 3), new Vector3(4, 2, 3), new Vector3(0, 1, 0));
    const q = new Quaternion().setFromRotationMatrix(m);
    expectVec3(new Vector3(0, 0, -1).applyQuaternion(q), 1, 0, 0, 10);
    // Degenerate: eye === target does not produce NaNs.
    const d = new Matrix4().lookAt(new Vector3(1, 1, 1), new Vector3(1, 1, 1), new Vector3(0, 1, 0));
    expect(d.elements.every((n) => Number.isFinite(n))).toBe(true);
  });
});

describe("Euler", () => {
  test("constructor defaults, set with order, clone/copy/equals", () => {
    const e = new Euler();
    expect([e.x, e.y, e.z]).toEqual([0, 0, 0]);
    expect(e.order).toBe("XYZ");
    expect(Euler.DEFAULT_ORDER).toBe("XYZ");
    e.set(1, 2, 3, "YXZ");
    expect([e.x, e.y, e.z, e.order]).toEqual([1, 2, 3, "YXZ"]);
    e.set(4, 5, 6); // order preserved when omitted
    expect(e.order).toBe("YXZ");
    const c = e.clone();
    expect(c.equals(e)).toBe(true);
    expect(new Euler().copy(e).equals(e)).toBe(true);
    expect(new Euler(4, 5, 6, "XYZ").equals(e)).toBe(false); // order differs
  });

  test("quaternion round trip preserves angles for every order", () => {
    const orders = ["XYZ", "YXZ", "ZXY", "ZYX", "YZX", "XZY"] as const;
    for (const order of orders) {
      const e = new Euler(0.1, 0.2, 0.3, order);
      const q = new Quaternion().setFromEuler(e);
      const back = new Euler().setFromQuaternion(q, order);
      expect(back.x).toBeCloseTo(0.1, 10);
      expect(back.y).toBeCloseTo(0.2, 10);
      expect(back.z).toBeCloseTo(0.3, 10);
      expectSameRotation(new Quaternion().setFromEuler(back), q, 10);
    }
  });

  test("single-axis eulers match axis-angle quaternions ('XYZ')", () => {
    const qx = new Quaternion().setFromEuler(new Euler(0.7, 0, 0, "XYZ"));
    const ax = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.7);
    expectQuat(qx, ax.x, ax.y, ax.z, ax.w, 12);
    const qy = new Quaternion().setFromEuler(new Euler(0, -1.1, 0, "XYZ"));
    const ay = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -1.1);
    expectQuat(qy, ay.x, ay.y, ay.z, ay.w, 12);
  });

  test("setFromRotationMatrix gimbal-lock fallback (y = ±90°, XYZ)", () => {
    const q = new Quaternion().setFromEuler(new Euler(0.4, Math.PI / 2, 0.2, "XYZ"));
    const e = new Euler().setFromQuaternion(q, "XYZ");
    // Angles may differ from the input at the singularity (z forced to 0),
    // but must encode the same rotation.
    expect(e.z).toBe(0);
    expectSameRotation(new Quaternion().setFromEuler(e), q, 8);
  });

  test("reorder keeps the rotation while changing the order tag", () => {
    const e = new Euler(0.3, 0.4, 0.5, "XYZ");
    const q = new Quaternion().setFromEuler(e);
    e.reorder("ZYX");
    expect(e.order).toBe("ZYX");
    expectSameRotation(new Quaternion().setFromEuler(e), q, 10);
  });
});

describe("Color", () => {
  test("defaults to white; hex primaries survive color management exactly", () => {
    const white = new Color();
    expect([white.r, white.g, white.b]).toEqual([1, 1, 1]);
    const red = new Color(0xff0000);
    expect([red.r, red.g, red.b]).toEqual([1, 0, 0]);
  });

  test("setHex converts sRGB → working (Linear-sRGB) like three@0.161", () => {
    const c = new Color(0x808080);
    const expected = SRGBToLinear(128 / 255);
    expect(c.r).toBeCloseTo(expected, 12);
    expect(c.g).toBeCloseTo(expected, 12);
    expect(c.b).toBeCloseTo(expected, 12);
    // Known reference point: sRGB 0.50196... → linear ≈ 0.2158605.
    expect(c.r).toBeCloseTo(0.2158605, 6);
  });

  test("getHex / getHexString round-trip through the working space", () => {
    expect(new Color(0x8fa55f).getHex()).toBe(0x8fa55f);
    expect(new Color(0x8fa55f).getHexString()).toBe("8fa55f");
    expect(new Color(0x639b4f).getHexString()).toBe("639b4f");
    expect(new Color(0x000012).getHexString()).toBe("000012"); // zero padding
  });

  test("ColorManagement.enabled = false gives raw sRGB components (three escape hatch)", () => {
    ColorManagement.enabled = false;
    try {
      const c = new Color(0x808080);
      expect(c.r).toBe(128 / 255);
      expect(c.getHex()).toBe(0x808080);
    } finally {
      ColorManagement.enabled = true;
    }
  });

  test("SRGBToLinear / LinearToSRGB are inverse on both curve segments", () => {
    // Precision 4: three uses the same 0.41666 approximation of 1/2.4, so the
    // round trip is only accurate to ~1e-5 — matching three exactly.
    for (const v of [0, 0.001, 0.02, 0.04045, 0.2, 0.5, 0.9, 1]) {
      expect(LinearToSRGB(SRGBToLinear(v))).toBeCloseTo(v, 4);
    }
    expect(SRGBToLinear(0.02)).toBeCloseTo(0.02 / 12.92, 10); // linear segment
  });

  test("set accepts Color, number, string, and r,g,b (WeaponEffectsSystem pattern)", () => {
    const base = new Color(0.1, 0.2, 0.3); // setRGB path, working space, no conversion
    expect([base.r, base.g, base.b]).toEqual([0.1, 0.2, 0.3]);
    const c = new Color();
    c.set(base);
    expect(c.equals(base)).toBe(true);
    c.set(0xff0000);
    expect(c.r).toBe(1);
    c.set("#8fa55f");
    expect(c.getHexString()).toBe("8fa55f");
    c.set(0.4, 0.5, 0.6);
    expect([c.r, c.g, c.b]).toEqual([0.4, 0.5, 0.6]);
  });

  test("setStyle parses hex shorthand, rgb() and hsl() strings", () => {
    expect(new Color().setStyle("#f00").getHexString()).toBe("ff0000");
    expect(new Color().setStyle("rgb(255, 0, 0)").getHexString()).toBe("ff0000");
    expect(new Color().setStyle("rgb(100%, 50%, 0%)").getHexString()).toBe("ff8000");
    // hsl(120, 50%, 50%) → sRGB (0.25, 0.75, 0.25) → #40bf40
    expect(new Color().setStyle("hsl(120, 50%, 50%)").getHexString()).toBe("40bf40");
    expect(new Color().setStyle("rgba(0, 255, 0, 0.5)").getHexString()).toBe("00ff00");
  });

  test("setHSL/getHSL operate in the working space; hand-computed lightness offset", () => {
    // (0.2, 0.4, 0.6) has h=7/12, s=0.5, l=0.4.
    const c = new Color(0.2, 0.4, 0.6);
    const hsl = c.getHSL({ h: 0, s: 0, l: 0 });
    expect(hsl.h).toBeCloseTo(7 / 12, 12);
    expect(hsl.s).toBeCloseTo(0.5, 12);
    expect(hsl.l).toBeCloseTo(0.4, 12);
    // offsetHSL(0, 0, 0.1): l 0.4 → 0.5 gives exactly (0.25, 0.5, 0.75).
    c.offsetHSL(0, 0, 0.1);
    expect(c.r).toBeCloseTo(0.25, 12);
    expect(c.g).toBeCloseTo(0.5, 12);
    expect(c.b).toBeCloseTo(0.75, 12);
    // offsetHSL(0,0,0) is an identity within fp error (TerrainSampler tinting).
    const t = new Color(0x8fa55f);
    const before = { r: t.r, g: t.g, b: t.b };
    t.offsetHSL(0, 0, 0);
    expect(t.r).toBeCloseTo(before.r, 10);
    expect(t.g).toBeCloseTo(before.g, 10);
    expect(t.b).toBeCloseTo(before.b, 10);
  });

  test("setHSL clamps s/l and wraps hue; s=0 is achromatic", () => {
    const grey = new Color().setHSL(0.3, 0, 0.5);
    expect([grey.r, grey.g, grey.b]).toEqual([0.5, 0.5, 0.5]);
    const wrapped = new Color().setHSL(1.25, 0.5, 0.5);
    const direct = new Color().setHSL(0.25, 0.5, 0.5);
    expect(wrapped.equals(direct)).toBe(true);
    const clamped = new Color().setHSL(0, 2, -1);
    expect([clamped.r, clamped.g, clamped.b]).toEqual([0, 0, 0]); // l clamped to 0
  });

  test("lerp endpoints and midpoint (JetFlame boost blend)", () => {
    const cNormal = new Color(0.8, 0.4, 0.2);
    const cBoost = new Color(0.2, 0.2, 1.0);
    const out = new Color();
    expect(out.copy(cNormal).lerp(cBoost, 0).equals(cNormal)).toBe(true);
    // t=1 is exact only up to fp error (three's lerp is `r += (c.r - r) * t`).
    out.copy(cNormal).lerp(cBoost, 1);
    expect(out.r).toBeCloseTo(cBoost.r, 12);
    expect(out.g).toBeCloseTo(cBoost.g, 12);
    expect(out.b).toBeCloseTo(cBoost.b, 12);
    out.copy(cNormal).lerp(cBoost, 0.5);
    expect(out.r).toBeCloseTo(0.5, 12);
    expect(out.g).toBeCloseTo(0.3, 12);
    expect(out.b).toBeCloseTo(0.6, 12);
    const lc = new Color().lerpColors(cNormal, cBoost, 0.25);
    expect(lc.r).toBeCloseTo(0.65, 12);
  });

  test("multiplyScalar / clone / copy / setScalar / getRGB (PickupVisualFactory emissive)", () => {
    const base = new Color(0.5, 0.4, 0.3);
    const emissive = base.clone().multiplyScalar(0.2);
    expect(emissive.r).toBeCloseTo(0.1, 12);
    expect(emissive.g).toBeCloseTo(0.08, 12);
    expect(emissive.b).toBeCloseTo(0.06, 12);
    expect(base.r).toBe(0.5); // clone leaves the original alone
    expect(new Color().setScalar(0.25).equals(new Color(0.25, 0.25, 0.25))).toBe(true);
    const rgb = new Color(0.1, 0.2, 0.3).getRGB({ r: 0, g: 0, b: 0 });
    expect([rgb.r, rgb.g, rgb.b]).toEqual([0.1, 0.2, 0.3]);
  });
});

describe("MathUtils", () => {
  test("clamp and lerp (FpsWeaponViewModel / PlantVisualFactory call sites)", () => {
    expect(MathUtils.clamp(5, 0, 1)).toBe(1);
    expect(MathUtils.clamp(-5, 0, 1)).toBe(0);
    expect(MathUtils.clamp(0.5, 0, 1)).toBe(0.5);
    expect(MathUtils.lerp(0, 10, 0.3)).toBeCloseTo(3, 12);
    expect(MathUtils.lerp(2, 4, 0)).toBe(2);
    expect(MathUtils.lerp(2, 4, 1)).toBe(4);
  });

  test("inverseLerp / mapLinear / damp", () => {
    expect(MathUtils.inverseLerp(10, 20, 15)).toBe(0.5);
    expect(MathUtils.inverseLerp(5, 5, 5)).toBe(0); // degenerate range
    expect(MathUtils.mapLinear(0.5, 0, 1, 10, 20)).toBe(15);
    expect(MathUtils.damp(0, 10, 2, 0)).toBe(0); // dt=0 keeps x
    expect(MathUtils.damp(0, 10, 1e9, 1)).toBeCloseTo(10, 6); // huge lambda converges
  });

  test("euclideanModulo / pingpong / smoothstep / smootherstep", () => {
    expect(MathUtils.euclideanModulo(-1, 4)).toBe(3);
    expect(MathUtils.euclideanModulo(5, 4)).toBe(1);
    expect(MathUtils.pingpong(1.5)).toBe(0.5);
    expect(MathUtils.pingpong(2.5, 2)).toBe(1.5);
    expect(MathUtils.smoothstep(-1, 0, 1)).toBe(0);
    expect(MathUtils.smoothstep(2, 0, 1)).toBe(1);
    expect(MathUtils.smoothstep(0.5, 0, 1)).toBe(0.5);
    expect(MathUtils.smootherstep(0.5, 0, 1)).toBe(0.5);
  });

  test("degToRad / radToDeg / DEG2RAD / RAD2DEG", () => {
    expect(MathUtils.degToRad(180)).toBeCloseTo(Math.PI, 12);
    expect(MathUtils.radToDeg(Math.PI / 2)).toBeCloseTo(90, 12);
    expect(MathUtils.DEG2RAD * 180).toBeCloseTo(Math.PI, 12);
    expect(MathUtils.RAD2DEG * Math.PI).toBeCloseTo(180, 12);
  });

  test("random helpers stay in range", () => {
    for (let i = 0; i < 20; i++) {
      const f = MathUtils.randFloat(2, 3);
      expect(f).toBeGreaterThanOrEqual(2);
      expect(f).toBeLessThanOrEqual(3);
      const s = MathUtils.randFloatSpread(4);
      expect(Math.abs(s)).toBeLessThanOrEqual(2);
      const n = MathUtils.randInt(1, 3);
      expect([1, 2, 3]).toContain(n);
    }
  });
});

// -- GameBlocks call-site cross-checks ---------------------------------------
// Chained sequences copied from the real modules, run against this library.

describe("GameBlocks call sites", () => {
  /**
   * WorldBasis.yawPitchRollFrame for the default basis (right=+x, up=+y,
   * forward=-z). fromBasisComponents(r, u, f) maps to (r, u, -f).
   */
  function yawPitchRollFrame(yaw = 0, pitch = 0, roll = 0) {
    const fromBasis = (r: number, u: number, f: number) => new Vector3(r, u, -f);
    const pitchCos = Math.cos(pitch);
    const forward = fromBasis(-Math.sin(yaw) * pitchCos, Math.sin(pitch), Math.cos(yaw) * pitchCos).normalize();
    const right = fromBasis(Math.cos(yaw), 0, Math.sin(yaw)).normalize();
    const up = new Vector3().crossVectors(right, forward).normalize();
    if (roll) {
      right.applyAxisAngle(forward, roll).normalize();
      up.applyAxisAngle(forward, roll).normalize();
    }
    return { right, up, forward, back: forward.clone().multiplyScalar(-1) };
  }

  test("WorldBasis.yawPitchRollFrame: yaw=0 gives the canonical frame", () => {
    const frame = yawPitchRollFrame(0);
    expectVec3(frame.forward, 0, 0, -1, 12);
    expectVec3(frame.right, 1, 0, 0, 12);
    expectVec3(frame.up, 0, 1, 0, 12);
    expectVec3(frame.back, 0, 0, 1, 12);
  });

  test("WorldBasis.yawPitchRollFrame: yaw=90° turns forward to -x", () => {
    const frame = yawPitchRollFrame(Math.PI / 2);
    expectVec3(frame.forward, -1, 0, 0, 12);
    expectVec3(frame.right, 0, 0, -1, 12);
    expectVec3(frame.up, 0, 1, 0, 12);
  });

  test("WorldBasis.yawPitchRollFrame: arbitrary yaw/pitch/roll stays orthonormal", () => {
    const { right, up, forward } = yawPitchRollFrame(0.7, 0.3, 0.5);
    expect(right.length()).toBeCloseTo(1, 12);
    expect(up.length()).toBeCloseTo(1, 12);
    expect(forward.length()).toBeCloseTo(1, 12);
    expect(right.dot(up)).toBeCloseTo(0, 12);
    expect(right.dot(forward)).toBeCloseTo(0, 12);
    expect(up.dot(forward)).toBeCloseTo(0, 12);
    // Right-handedness is preserved under roll: cross(up, forward) == right… in
    // this frame convention cross(right, forward) == up before roll; verify the
    // triple product stays +1.
    const triple = new Vector3().crossVectors(right, up).dot(forward);
    expect(Math.abs(triple)).toBeCloseTo(1, 12);
  });

  test("CarModelController.updateChassis: makeBasis + setFromRotationMatrix at yaw=90°", () => {
    const frame = yawPitchRollFrame(Math.PI / 2);
    const modelBack = new Vector3().copy(frame.forward).multiplyScalar(-1);
    const modelMatrix = new Matrix4().makeBasis(frame.right, frame.up, modelBack);
    const q = new Quaternion().setFromRotationMatrix(modelMatrix);
    // 90° about +y.
    expectQuat(q, 0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4), 10);
    // The mesh's canonical forward (-z) must land on the frame forward.
    expectVec3(new Vector3(0, 0, -1).applyQuaternion(q), frame.forward.x, frame.forward.y, frame.forward.z, 10);
  });

  test("WorldBasis.threeObjectCanonicalToBasisQuaternion is identity for the default basis", () => {
    const q = new Quaternion().setFromRotationMatrix(
      new Matrix4().makeBasis(
        new Vector3(1, 0, 0), // rightVector()
        new Vector3(0, 1, 0), // upVector()
        new Vector3(0, 0, -1).multiplyScalar(-1), // forwardVector().multiplyScalar(-1)
      ),
    );
    expectQuat(q, 0, 0, 0, 1, 12);
  });

  test("DynamicCarBatchResolver.bodyFrame: basis vectors through a yaw quaternion", () => {
    const yaw = Math.PI / 2;
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
    const forward = new Vector3(0, 0, -1).applyQuaternion(rotation).normalize();
    const right = new Vector3(1, 0, 0).applyQuaternion(rotation).normalize();
    const up = new Vector3(0, 1, 0).applyQuaternion(rotation).normalize();
    expectVec3(forward, -1, 0, 0, 12);
    expectVec3(right, 0, 0, -1, 12);
    expectVec3(up, 0, 1, 0, 12);
  });

  test("BaseCameraRig.setLookAtPose + frame-mode camera quaternion", () => {
    const position = new Vector3(1, 2, 3);
    const lookAt = new Vector3(4, 2, 3);
    const up = new Vector3(0, 1, 0);
    // setLookAtPose sequence:
    const forward = new Vector3().subVectors(lookAt, position).normalize();
    const right = new Vector3().crossVectors(forward, up).normalize();
    const trueUp = new Vector3().crossVectors(right, forward).normalize();
    expectVec3(forward, 1, 0, 0, 12);
    expectVec3(right, 0, 0, 1, 12);
    expectVec3(trueUp, 0, 1, 0, 12);
    // applyToCamera frame mode:
    const matrix = new Matrix4().makeBasis(right, trueUp, forward.clone().negate());
    const q = new Quaternion().setFromRotationMatrix(matrix);
    // Camera's local -z must point along forward.
    expectVec3(new Vector3(0, 0, -1).applyQuaternion(q), 1, 0, 0, 10);
    // And it agrees with Matrix4.lookAt (what camera.lookAt would produce).
    const lm = new Matrix4().lookAt(position, lookAt, up);
    const lq = new Quaternion().setFromRotationMatrix(lm);
    expectSameRotation(q, lq, 10);
  });

  test("FpsWeaponViewModel: camera-local offset + recoil euler composition", () => {
    const cameraQuaternion = new Quaternion().setFromEuler(new Euler(0.1, 0.8, 0, "YXZ"));
    const cameraPosition = new Vector3(2, 1.6, -4);
    // this._tmpPos.set(x, y, -z).applyQuaternion(camera.quaternion).add(camera.position)
    const tmpPos = new Vector3()
      .set(0.25, -0.4, -(-0.25))
      .applyQuaternion(cameraQuaternion)
      .add(cameraPosition);
    const manual = new Vector3(0.25, -0.4, 0.25).applyQuaternion(cameraQuaternion).add(cameraPosition);
    expectVec3(tmpPos, manual.x, manual.y, manual.z, 12);
    // finalQuat = qBase.copy(camera.quaternion).multiply(qOffset)
    const tmpEuler = new Euler().set(-0.05, 0.02, 0, "XYZ");
    const qOffset = new Quaternion().setFromEuler(tmpEuler);
    const finalQuat = new Quaternion().copy(cameraQuaternion).multiply(qOffset);
    // Applying finalQuat == applying qOffset first, then the camera rotation.
    const probe = new Vector3(0, 0, -1);
    const viaFinal = probe.clone().applyQuaternion(finalQuat);
    const viaSteps = probe.clone().applyQuaternion(qOffset).applyQuaternion(cameraQuaternion);
    expectVec3(viaFinal, viaSteps.x, viaSteps.y, viaSteps.z, 12);
  });

  test("GeneralVehicleMotionController: chained addScaledVector velocity integration", () => {
    const frame = yawPitchRollFrame(0.4, 0.1);
    const velocity = new Vector3(1, 0, -2);
    const frameMotion = 24 * (1 / 60);
    velocity
      .addScaledVector(frame.right, 0.5 * frameMotion)
      .addScaledVector(frame.up, 0 * frameMotion)
      .addScaledVector(frame.forward, 1 * frameMotion);
    // Same result computed without chaining.
    const expected = new Vector3(1, 0, -2)
      .add(frame.right.clone().multiplyScalar(0.5 * frameMotion))
      .add(frame.forward.clone().multiplyScalar(frameMotion));
    expectVec3(velocity, expected.x, expected.y, expected.z, 12);
    // Damping + speed clamp sequence.
    velocity.multiplyScalar(Math.exp(-0.8 * (1 / 60)));
    const maxSpeed = 1.5;
    const nextSpeed = velocity.length();
    if (nextSpeed > maxSpeed) velocity.multiplyScalar(maxSpeed / nextSpeed);
    expect(velocity.length()).toBeLessThanOrEqual(maxSpeed + 1e-12);
  });

  test("ArcadeCarMotionController.tangentForwardSpeed: projectOnPlane + dot chain", () => {
    const frame = yawPitchRollFrame(0.9);
    const velocity = new Vector3(3, 5, -1); // has an off-plane (up) component
    const tangentSpeed = velocity.clone().projectOnPlane(frame.up).dot(frame.forward);
    // Equivalent closed form: v·f - (v·u)(u·f); u ⟂ f so it's just v·f.
    expect(tangentSpeed).toBeCloseTo(velocity.dot(frame.forward), 10);
    // And the projected vector has no up component left.
    expect(velocity.clone().projectOnPlane(frame.up).dot(frame.up)).toBeCloseTo(0, 12);
  });

  test("NearbyAvoidanceSteering: subVectors/flatten/setLength steering chain", () => {
    const self = new Vector3(0, 0, 0);
    const other = new Vector3(3, 1, 4);
    const toNeighbor = new Vector3().subVectors(self, other);
    toNeighbor.y = 0; // basis.flatten
    expect(toNeighbor.length()).toBe(5);
    const invDistance = 1 / toNeighbor.length();
    const away = new Vector3().copy(toNeighbor).multiplyScalar(invDistance * 0.8 * 1.5);
    const steering = new Vector3().add(away);
    expect(steering.length()).toBeCloseTo(1.2, 12);
    steering.setLength(0.75); // maxSteering clamp
    expect(steering.length()).toBeCloseTo(0.75, 12);
    // Direction is preserved by setLength.
    expect(steering.clone().normalize().dot(away.clone().normalize())).toBeCloseTo(1, 12);
  });

  test("GeneralObjectModelController.updateObjectFrame: flattened forward, keepBasisUp", () => {
    // localForward '-z' (sign -1), objectFrame.forward pointing -x with some up tilt.
    const zAxis = new Vector3().set(-1, 0.5, 0);
    zAxis.y = 0; // basis.flatten (keepBasisUp)
    zAxis.normalize().multiplyScalar(-1);
    const yAxis = new Vector3(0, 1, 0); // basis.upVector(this.yAxis)
    const xAxis = new Vector3().crossVectors(yAxis, zAxis).normalize();
    const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(xAxis, yAxis, zAxis));
    // Mesh canonical -z must land on the flattened forward (-1, 0, 0).
    expectVec3(new Vector3(0, 0, -1).applyQuaternion(q), -1, 0, 0, 10);
    expect(q.length()).toBeCloseTo(1, 12);
  });

  test("ProjectileVisualFactory: setFromUnitVectors orients +Y geometry along a segment", () => {
    const start = new Vector3(1, 1, 1);
    const end = new Vector3(4, 5, 1);
    const delta = end.clone().sub(start);
    const midpoint = start.clone().addScaledVector(delta, 0.5);
    expectVec3(midpoint, 2.5, 3, 1, 12);
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), delta.normalize());
    const oriented = new Vector3(0, 1, 0).applyQuaternion(q);
    expectVec3(oriented, 0.6, 0.8, 0, 10);
  });

  test("TerrainSampler.colorAt: hex + offsetHSL tint stays valid and near the base", () => {
    const color = new Color(0x8fa55f);
    const noise = 0.37; // deterministic stand-in for the hash noise
    color.offsetHSL((noise - 0.5) * 0.03, (noise - 0.45) * 0.035, (noise - 0.5) * 0.05);
    for (const ch of [color.r, color.g, color.b]) {
      expect(ch).toBeGreaterThanOrEqual(0);
      expect(ch).toBeLessThanOrEqual(1);
    }
    // The tiny offsets keep the color within a couple of 8-bit steps of the base.
    const base = new Color(0x8fa55f);
    expect(Math.abs(color.getHex() - base.getHex()) % 65536).toBeLessThan(3000);
    expect(Math.abs(color.r - base.r)).toBeLessThan(0.05);
  });

  test("Vector3Utils.toUnitVec3 semantics: zero-length falls back, else normalizes", () => {
    const VECTOR_EPS = 1e-6;
    const toUnit = (v: Vector3, fallback: Vector3) => {
      if (v.lengthSq() <= VECTOR_EPS * VECTOR_EPS) {
        if (fallback.lengthSq() <= VECTOR_EPS * VECTOR_EPS) return new Vector3();
        return fallback.clone().normalize();
      }
      return v.clone().normalize();
    };
    expectVec3(toUnit(new Vector3(0, 0, 0), new Vector3(0, 1, 0)), 0, 1, 0, 12);
    expectVec3(toUnit(new Vector3(0, 0, 0), new Vector3(0, 0, 0)), 0, 0, 0, 12);
    expectVec3(toUnit(new Vector3(0, 0, -3), new Vector3(0, 1, 0)), 0, 0, -1, 12);
  });
});
