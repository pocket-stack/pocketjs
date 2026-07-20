// playset/test/foundation.test.ts — the modules everything else stands on:
// WorldBasis, Vector3Utils, RandomGenerator, ScalarUtils, Clock.

import { describe, expect, test } from "bun:test";
import { virtualNow } from "@pocketjs/framework/clock";
import { Vector3 } from "../math/vector3.ts";
import {
  DEFAULT_WORLD_BASIS,
  WorldBasis,
  createWorldBasis,
} from "../modules/math/world-basis.ts";
import { toPlanarUnitVec3, toUnitVec3, toVec3 } from "../modules/math/vector3-utils.ts";
import { DEFAULT_PRNG, RandomGenerator } from "../modules/math/random-utils.ts";
import { clamp, smoothToward, smoothingAlpha } from "../modules/math/scalar-utils.ts";
import { Clock } from "../modules/math/time-utils.ts";

const close = (v: number, e: number) => expect(v).toBeCloseTo(e, 12);

describe("WorldBasis (default: right=+x, up=+y, forward=-z)", () => {
  test("axis vectors", () => {
    expect(DEFAULT_WORLD_BASIS.rightVector().toArray()).toEqual([1, 0, 0]);
    expect(DEFAULT_WORLD_BASIS.upVector().toArray()).toEqual([0, 1, 0]);
    expect(DEFAULT_WORLD_BASIS.forwardVector().toArray()).toEqual([0, 0, -1]);
    // multiplyScalar(-1) yields -0 on the zero axes (three does too) — normalize
    expect(DEFAULT_WORLD_BASIS.downVector().toArray().map((n) => n + 0)).toEqual([0, -1, 0]);
  });

  test("component reads apply the axis sign", () => {
    const v = { x: 3, y: 5, z: -7 };
    expect(DEFAULT_WORLD_BASIS.rightComponent(v)).toBe(3);
    expect(DEFAULT_WORLD_BASIS.upComponent(v)).toBe(5);
    expect(DEFAULT_WORLD_BASIS.forwardComponent(v)).toBe(7); // -z forward
  });

  test("height helpers mutate only the up axis", () => {
    const v = new Vector3(1, 2, 3);
    DEFAULT_WORLD_BASIS.setHeight(v, 9);
    expect(v.toArray()).toEqual([1, 9, 3]);
    DEFAULT_WORLD_BASIS.addHeight(v, -4);
    expect(v.toArray()).toEqual([1, 5, 3]);
    DEFAULT_WORLD_BASIS.flatten(v);
    expect(v.toArray()).toEqual([1, 0, 3]);
  });

  test("yawPitchRollFrame: yaw sweeps CCW from above", () => {
    const f0 = DEFAULT_WORLD_BASIS.yawPitchRollFrame(0, 0, 0);
    close(f0.forward.z, -1);
    close(f0.right.x, 1);
    close(f0.up.y, 1);
    const f90 = DEFAULT_WORLD_BASIS.yawPitchRollFrame(Math.PI / 2, 0, 0);
    close(f90.forward.x, -1);
    close(f90.right.z, -1);
    // frame stays orthonormal under roll
    const fr = DEFAULT_WORLD_BASIS.yawPitchRollFrame(0.7, 0.3, 0.5);
    close(fr.right.dot(fr.forward), 0);
    close(fr.right.dot(fr.up), 0);
    close(fr.up.length(), 1);
    close(fr.back.dot(fr.forward), -1);
  });

  test("forwardToYaw round-trips yawPitchRollFrame", () => {
    for (const yaw of [0, 0.5, -1.2, Math.PI / 2, 3]) {
      const frame = DEFAULT_WORLD_BASIS.yawPitchRollFrame(yaw, 0, 0);
      const wrapped = Math.atan2(Math.sin(yaw), Math.cos(yaw));
      close(DEFAULT_WORLD_BASIS.forwardToYaw(frame.forward), wrapped);
    }
  });

  test("canonical quaternions: identity for objects, plane lies flat", () => {
    const q = DEFAULT_WORLD_BASIS.threeObjectCanonicalToBasisQuaternion();
    close(Math.abs(q.w), 1);
    const plane = DEFAULT_WORLD_BASIS.threePlaneCanonicalToBasisQuaternion();
    // plane-local +Z (its normal) must land on world up
    const n = new Vector3(0, 0, 1).applyQuaternion(plane);
    close(n.x, 0);
    close(n.y, 1);
    close(n.z, 0);
  });

  test("surfaceNormalFromSlopes tilts against the slope", () => {
    const n = DEFAULT_WORLD_BASIS.surfaceNormalFromSlopes(1, 0);
    expect(n.y).toBeGreaterThan(0);
    close(n.length(), 1);
    close(DEFAULT_WORLD_BASIS.rightComponent(n), -n.y); // -slope * scale
  });

  test("alternate basis (z-up) validates and maps", () => {
    const zUp = createWorldBasis({ right: "+x", up: "+z", forward: "+y" });
    expect(zUp.upVector().toArray()).toEqual([0, 0, 1]);
    expect(zUp.forwardComponent({ x: 0, y: 4, z: 0 })).toBe(4);
    expect(() => new WorldBasis({ right: "+x", up: "+y", forward: "+x" })).toThrow();
    expect(() => new WorldBasis({ right: "+x", up: "-y", forward: "-z" })).toThrow(); // left-handed
  });

  test("controlSignal maps directions and coerces signals", () => {
    expect(DEFAULT_WORLD_BASIS.controlSignal("left", true)).toBe(-1);
    expect(DEFAULT_WORLD_BASIS.controlSignal("clockWise", 0.5)).toBe(-0.5);
    expect(DEFAULT_WORLD_BASIS.controlSignal("forward", null)).toBe(0);
  });
});

describe("Vector3Utils", () => {
  test("toVec3 coerces partials with fallback", () => {
    expect(toVec3({ x: 1 }).toArray()).toEqual([1, 0, 0]);
    expect(toVec3(null, { x: 2, y: 3, z: 4 }).toArray()).toEqual([2, 3, 4]);
  });
  test("toUnitVec3 normalizes, falls back on degenerate input", () => {
    close(toUnitVec3({ x: 3, y: 0, z: 4 }).length(), 1);
    expect(toUnitVec3({ x: 0, y: 0, z: 0 }).toArray()).toEqual([0, 1, 0]);
    expect(toUnitVec3(null, { x: 0, y: 0, z: 0 }).toArray()).toEqual([0, 0, 0]);
  });
  test("toPlanarUnitVec3 flattens before normalizing", () => {
    const v = toPlanarUnitVec3({ x: 0, y: 5, z: -1 });
    expect(v.y).toBe(0);
    close(v.z, -1);
    // vertical-only input falls back to planar default (-z forward)
    expect(toPlanarUnitVec3({ x: 0, y: 9, z: 0 }).toArray()).toEqual([0, 0, -1]);
  });
});

describe("RandomGenerator (Mulberry32)", () => {
  test("seed 42 anchor values match the GameBlocks stream exactly", () => {
    const prng = new RandomGenerator(42);
    close(prng.random(), 0.6011037519201636);
    close(prng.random(), 0.44829055899754167);
    close(prng.random(), 0.8524657934904099);
    close(prng.random(), 0.6697340414393693);
  });
  test("reseed reproduces; helpers stay in range", () => {
    const a = new RandomGenerator(7);
    const b = new RandomGenerator(7);
    for (let i = 0; i < 100; i++) expect(a.random()).toBe(b.random());
    a.seed(7);
    expect(a.random()).toBe(new RandomGenerator(7).random());
    const c = new RandomGenerator(1);
    for (let i = 0; i < 200; i++) {
      const v = c.randint(2, 5);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(5);
      expect(c.randrange(10) % 1).toBe(0);
      expect(["a", "b"]).toContain(c.choice(["a", "b"]));
    }
    expect(DEFAULT_PRNG).toBeInstanceOf(RandomGenerator);
  });
});

describe("ScalarUtils / Clock", () => {
  test("smoothing is dt-stable and converges", () => {
    expect(smoothingAlpha(0, 1)).toBe(1);
    close(smoothingAlpha(0.5, 0), 0);
    // two half-steps == one full step (the whole point of exp smoothing)
    const one = smoothToward(0, 10, 0.2, 0.1);
    const half = smoothToward(smoothToward(0, 10, 0.2, 0.05), 10, 0.2, 0.05);
    close(one, half);
    expect(clamp(5, 0, 3)).toBe(3);
  });
  test("manual clock advances by hand; virtual path never touches Date.now", () => {
    const clock = new Clock().useManual(1000);
    expect(clock.now()).toBe(1000);
    clock.advanceMs(500);
    expect(clock.nowSeconds()).toBe(1.5);
    // non-manual mode reads the virtual clock, not wall time. Other test
    // files in the same process may have advanced the shared frame counter,
    // so assert against virtualNow() rather than a literal 0.
    const virtual = new Clock();
    expect(virtual.now()).toBe(virtualNow() * 1000);
    expect(Math.abs(virtual.now() - Date.now())).toBeGreaterThan(1e9);
  });
});
