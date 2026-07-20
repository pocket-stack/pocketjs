// playset/test/actor-motion.test.ts — actor-motion controllers: character
// locomotion (base + world-target/cardinal/heading-relative/mouse-look),
// six-axis vehicle, object model poser, plate tilt, and grid snake.

import { describe, expect, test } from "bun:test";
import { Quaternion, Vector3 } from "../math/index.ts";
import { DEFAULT_WORLD_BASIS } from "../modules/math/world-basis.ts";
import {
  BaseCharacterMotionController,
  type CharacterMovementIntent,
  type CharacterMotionState,
  type ResolvedCharacterMovement,
} from "../modules/actor-motion/character/base-character-motion-controller.ts";
import { WorldTargetCharacterMotionController } from "../modules/actor-motion/character/world-target-character-motion-controller.ts";
import { WorldCardinalCharacterMotionController } from "../modules/actor-motion/character/world-cardinal-character-motion-controller.ts";
import { HeadingRelativeCharacterMotionController } from "../modules/actor-motion/character/heading-relative-character-motion-controller.ts";
import { MouseLookCharacterMotionController } from "../modules/actor-motion/character/mouse-look-character-motion-controller.ts";
import {
  GeneralVehicleMotionController,
  type VehicleMotionState,
} from "../modules/actor-motion/general-vehicle-motion-controller.ts";
import { GeneralObjectModelController } from "../modules/actor-motion/general-object-model-controller.ts";
import { PlateTiltController } from "../modules/actor-motion/plate-tilt-controller.ts";
import { SnakeMotionController, stepSnakeCell } from "../modules/actor-motion/snake-motion-controller.ts";

const DT = 1 / 60;

// Stub resolver: pass the intent through, but clamp to flat ground at up=0
// (the shape KinematicBatchResolver hands back for one actor).
function flatGroundResolve(intent: CharacterMovementIntent): ResolvedCharacterMovement {
  const position = intent.position.clone();
  let grounded = intent.grounded;
  if (position.y <= 0) {
    position.y = 0;
    grounded = true;
  }
  return {
    position,
    velocity: intent.velocity,
    correctedDelta: position.clone().sub(intent.startPosition),
    grounded,
  };
}

describe("BaseCharacterMotionController", () => {
  test("walks at walkSpeed on flat ground through a stub resolver", () => {
    const ctrl = new BaseCharacterMotionController({});
    const q = Math.exp(-DT / ctrl.cfg.accelerationLag); // per-step smoothing remainder
    const dir = new Vector3(0, 0, -1);

    let state: CharacterMotionState | null = null;
    const n = 300;
    for (let i = 0; i < n; i++) {
      const intent = ctrl._prepareLocomotion({
        moveDirection: dir,
        sprint: false,
        crouch: false,
        jump: false,
        deltaSeconds: DT,
      });
      state = ctrl.commitMovement(intent, flatGroundResolve(intent));
      if (i === 0) {
        // First step: v = walkSpeed * (1 - e^(-dt/lag)) toward -z.
        expect(state.velocity.z).toBeCloseTo(-6 * (1 - q), 12);
        expect(state.position.z).toBeCloseTo(-6 * (1 - q) * DT, 12);
      }
    }

    // Converged to walkSpeed; closed form for the distance covered.
    expect(state!.velocity.z).toBeCloseTo(-6, 10);
    expect(state!.velocity.x).toBeCloseTo(0, 12);
    expect(state!.velocity.y).toBeCloseTo(0, 12);
    expect(state!.grounded).toBe(true);
    const expectedZ = -6 * DT * (n - (q * (1 - q ** n)) / (1 - q));
    expect(state!.position.z).toBeCloseTo(expectedZ, 8);
  });

  test("sprint and crouch retarget the planar speed", () => {
    const sprinter = new BaseCharacterMotionController({});
    const croucher = new BaseCharacterMotionController({});
    for (let i = 0; i < 300; i++) {
      for (const [ctrl, sprint, crouch] of [
        [sprinter, true, false],
        [croucher, false, true],
      ] as const) {
        const intent = ctrl._prepareLocomotion({
          moveDirection: new Vector3(1, 0, 0),
          sprint,
          crouch,
          jump: false,
          deltaSeconds: DT,
        });
        ctrl.commitMovement(intent, flatGroundResolve(intent));
      }
    }
    expect(sprinter.velocity.x).toBeCloseTo(9, 10);
    expect(croucher.velocity.x).toBeCloseTo(3.2, 10);
  });

  test("jump arc: apex at step 51 with exact ballistic height, clean landing", () => {
    const ctrl = new BaseCharacterMotionController({});
    const still = new Vector3();
    // After the jump step k (1-based): vy_k = 8.5 - 9.81*k*dt,
    // y_k = dt * (8.5*k - 9.81*dt*k*(k+1)/2).
    const yAt = (k: number) => DT * (8.5 * k - (9.81 * DT * k * (k + 1)) / 2);

    let maxY = -Infinity;
    let maxStep = 0;
    let landedAt = 0;
    for (let k = 1; k <= 200; k++) {
      const intent = ctrl._prepareLocomotion({
        moveDirection: still,
        sprint: false,
        crouch: false,
        jump: k === 1,
        deltaSeconds: DT,
      });
      const state = ctrl.commitMovement(intent, flatGroundResolve(intent));
      if (state.position.y > maxY) {
        maxY = state.position.y;
        maxStep = k;
      }
      if (k === 1) expect(state.velocity.y).toBeCloseTo(8.5 - 9.81 * DT, 12);
      if (k === 51) expect(state.position.y).toBeCloseTo(yAt(51), 10);
      if (k > 1 && state.grounded) {
        landedAt = k;
        break;
      }
    }

    expect(maxStep).toBe(51); // 8.5 / (9.81/60) = 51.99 → last rising step
    expect(maxY).toBeCloseTo(yAt(51), 10);
    expect(landedAt).toBe(103); // y first dips below 0 at step 103
    expect(ctrl.position.y).toBe(0);
    expect(ctrl.velocity.y).toBe(0); // landing flattens downward velocity
    expect(ctrl.grounded).toBe(true);
  });

  test("setState clamps pitch and derives yaw from forward", () => {
    const ctrl = new BaseCharacterMotionController({});
    ctrl.setState({ position: { x: 1, y: 2, z: 3 }, pitch: 9, forward: { x: 1, y: 0, z: 0 } });
    expect(ctrl.position.toArray()).toEqual([1, 2, 3]);
    expect(ctrl.pitch).toBe(1.45);
    expect(ctrl.yaw).toBeCloseTo(-Math.PI / 2, 12); // +x forward
  });
});

describe("WorldTargetCharacterMotionController", () => {
  test("turns to the move target instantly (turnLag 0) and stops in stopRadius", () => {
    const ctrl = new WorldTargetCharacterMotionController({});
    const moveTarget = { x: 10, y: 0, z: 0 };

    const first = ctrl.planMovement({ moveTarget, commit: true }) as CharacterMotionState;
    expect(first.yaw).toBeCloseTo(-Math.PI / 2, 12);

    for (let i = 0; i < 299; i++) ctrl.planMovement({ moveTarget, commit: true });
    const planarDistance = Math.sqrt(DEFAULT_WORLD_BASIS.distanceSqPlanar(moveTarget, ctrl.position));
    expect(ctrl.position.x).toBeGreaterThan(9.5);
    expect(planarDistance).toBeLessThanOrEqual(0.5);
    expect(ctrl.velocity.length()).toBeLessThan(0.01);
  });

  test("faceTarget turns without moving", () => {
    const ctrl = new WorldTargetCharacterMotionController({});
    const state = ctrl.planMovement({ faceTarget: { x: -5, y: 0, z: 0 }, commit: true }) as CharacterMotionState;
    expect(state.yaw).toBeCloseTo(Math.PI / 2, 12);
    expect(state.position.length()).toBe(0);
  });
});

describe("WorldCardinalCharacterMotionController", () => {
  test("moves along world axes regardless of yaw", () => {
    const ctrl = new WorldCardinalCharacterMotionController({});
    ctrl.setState({ yaw: 1.0 });
    const q = Math.exp(-DT / ctrl.cfg.accelerationLag);
    const state = ctrl.planMovement({ right: 1, commit: true }) as CharacterMotionState;
    expect(state.velocity.x).toBeCloseTo(6 * (1 - q), 12);
    expect(state.velocity.z).toBeCloseTo(0, 12);
  });

  test("rotateCCW integrates turnRate", () => {
    const ctrl = new WorldCardinalCharacterMotionController({});
    for (let i = 0; i < 30; i++) ctrl.planMovement({ rotateCCW: 1, commit: true });
    expect(ctrl.yaw).toBeCloseTo(30 * 2.8 * DT, 10); // 1.4
  });
});

describe("HeadingRelativeCharacterMotionController", () => {
  test("turnRight yaws clockwise and forward follows the new heading", () => {
    const ctrl = new HeadingRelativeCharacterMotionController({});
    const q = Math.exp(-DT / ctrl.cfg.accelerationLag);
    const state = ctrl.planMovement({ forward: 1, turnRight: 1, commit: true }) as CharacterMotionState;
    const yaw1 = -2.8 * DT;
    expect(state.yaw).toBeCloseTo(yaw1, 12);
    expect(state.velocity.x).toBeCloseTo(6 * (1 - q) * -Math.sin(yaw1), 12);
    expect(state.velocity.z).toBeCloseTo(6 * (1 - q) * -Math.cos(yaw1), 12);
  });

  test("diagonal input is normalized to walkSpeed", () => {
    const ctrl = new HeadingRelativeCharacterMotionController({});
    for (let i = 0; i < 300; i++) ctrl.planMovement({ forward: 1, strafeRight: 1, commit: true });
    expect(DEFAULT_WORLD_BASIS.planarLength(ctrl.velocity)).toBeCloseTo(6, 8);
  });
});

describe("MouseLookCharacterMotionController", () => {
  test("yaw/pitch accumulate mouse deltas with default sensitivities", () => {
    const ctrl = new MouseLookCharacterMotionController({});
    ctrl.planMovement({ mouseDeltaX: 100, mouseDeltaY: 50, commit: true });
    expect(ctrl.yaw).toBeCloseTo(-0.22, 12); // clockWise sign -1
    expect(ctrl.pitch).toBeCloseTo(-0.09, 12);
    ctrl.planMovement({ mouseDeltaX: 100, mouseDeltaY: 50, commit: true });
    expect(ctrl.yaw).toBeCloseTo(-0.44, 12);
    expect(ctrl.pitch).toBeCloseTo(-0.18, 12);
  });

  test("pitch clamps at pitchMin/pitchMax, yaw does not wrap", () => {
    const ctrl = new MouseLookCharacterMotionController({});
    ctrl.planMovement({ mouseDeltaY: -10000, commit: true });
    expect(ctrl.pitch).toBe(1.45);
    ctrl.planMovement({ mouseDeltaY: -10000, commit: true });
    expect(ctrl.pitch).toBe(1.45);
    ctrl.planMovement({ mouseDeltaY: 10000, commit: true });
    expect(ctrl.pitch).toBe(-1.45);

    const yawBefore = ctrl.yaw;
    ctrl.planMovement({ mouseDeltaX: -10000, commit: true });
    expect(ctrl.yaw).toBeCloseTo(yawBefore + 10000 * 0.0022, 9);
    expect(ctrl.yaw).toBeGreaterThan(Math.PI);
  });
});

describe("GeneralVehicleMotionController", () => {
  test("first step: local thrust scaled 1/sqrt(3), then damping", () => {
    const vehicle = new GeneralVehicleMotionController({});
    const fm = (24 * DT) / Math.sqrt(3);
    const d = Math.exp(-0.8 * DT);
    const state = vehicle.planMovement({ forward: 1, right: 1, up: 1, commit: true }) as VehicleMotionState;
    expect(state.velocity.x).toBeCloseTo(fm * d, 12);
    expect(state.velocity.y).toBeCloseTo(fm * d, 12);
    expect(state.velocity.z).toBeCloseTo(-fm * d, 12);
    expect(state.position.x).toBeCloseTo(fm * d * DT, 12);
    // No speed yet on the first plan → steering had no effect.
    expect(vehicle.pathYaw).toBe(0);
    expect(vehicle.pathPitch).toBe(0);
  });

  test("six-axis plan → commit keeps the body frame orthonormal under steer/rotate/bank", () => {
    const vehicle = new GeneralVehicleMotionController({
      maxForwardBackwardBank: 0.4,
      maxLeftRightBank: 0.5,
    });
    let state: VehicleMotionState | null = null;
    for (let i = 0; i < 60; i++) {
      state = vehicle.planMovement({
        forward: 1,
        right: 0.3,
        up: 0.2,
        steerRight: 0.8,
        steerUp: 0.4,
        rotateLeft: 0.3,
        commit: true,
      }) as VehicleMotionState;
    }

    const { forward, right, up } = state!.bodyFrame;
    expect(forward.length()).toBeCloseTo(1, 12);
    expect(right.length()).toBeCloseTo(1, 12);
    expect(up.length()).toBeCloseTo(1, 12);
    expect(forward.dot(right)).toBeCloseTo(0, 12);
    expect(forward.dot(up)).toBeCloseTo(0, 12);
    expect(right.dot(up)).toBeCloseTo(0, 12);

    expect(vehicle.relativeBodyYaw).toBeCloseTo(0.3 * 2.8 * 60 * DT, 9); // 0.84
    expect(vehicle.pathYaw).toBeLessThan(0); // steerRight → clockwise
    // Bank targets: fb source = clamp(-1 + 0.4) = -0.6 → -0.24;
    // lr source = clamp(0.3 + 0.8) = 1 → 0.5. Both nearly converged after 1s.
    expect(vehicle.forwardBackwardBank).toBeCloseTo(-0.24, 3);
    expect(vehicle.leftRightBank).toBeCloseTo(0.5, 3);
  });

  test("reset zeroes banks and reports the body frame", () => {
    const vehicle = new GeneralVehicleMotionController({ maxLeftRightBank: 0.5 });
    for (let i = 0; i < 30; i++) vehicle.planMovement({ right: 1, commit: true });
    expect(vehicle.leftRightBank).not.toBe(0);
    const state = vehicle.reset({ position: new Vector3(1, 2, 3), velocity: new Vector3(), pathYaw: 0.5 });
    expect(vehicle.leftRightBank).toBe(0);
    expect(state.position.toArray()).toEqual([1, 2, 3]);
    expect(state.bodyFrame.forward.x).toBeCloseTo(-Math.sin(0.5), 12);
    expect(state.bodyFrame.forward.z).toBeCloseTo(-Math.cos(0.5), 12);
  });
});

describe("GeneralObjectModelController", () => {
  const makeModel = () => ({ position: new Vector3(), quaternion: new Quaternion() });

  test("step copies position and orients local -z along the frame forward", () => {
    const model = makeModel();
    const ctrl = new GeneralObjectModelController({ model });
    const frame = DEFAULT_WORLD_BASIS.yawPitchRollFrame(Math.PI / 2);
    ctrl.step(new Vector3(1, 2, 3), frame);
    expect(model.position.toArray()).toEqual([1, 2, 3]);
    const localForward = new Vector3(0, 0, -1).applyQuaternion(model.quaternion);
    expect(localForward.x).toBeCloseTo(-1, 12);
    expect(localForward.y).toBeCloseTo(0, 12);
    expect(localForward.z).toBeCloseTo(0, 12);
  });

  test("keepBasisUp flattens forward and keeps model up on world up", () => {
    const model = makeModel();
    const ctrl = new GeneralObjectModelController({ model, keepBasisUp: true });
    ctrl.step(null, { forward: { x: 0, y: 0.5, z: -1 } });
    const localUp = new Vector3(0, 1, 0).applyQuaternion(model.quaternion);
    expect(localUp.y).toBeCloseTo(1, 12);
    const localForward = new Vector3(0, 0, -1).applyQuaternion(model.quaternion);
    expect(localForward.z).toBeCloseTo(-1, 12); // vertical part discarded
  });

  test("reset restores identity rotation; null model is a no-op", () => {
    const model = makeModel();
    model.quaternion.set(0, 1, 0, 0);
    const ctrl = new GeneralObjectModelController({ model });
    expect(ctrl.reset(new Vector3(5, 0, 0))).toBe(model);
    expect(model.position.x).toBe(5);
    expect(model.quaternion.w).toBe(1);
    expect(new GeneralObjectModelController({}).step(new Vector3(1, 1, 1))).toBeNull();
  });
});

describe("PlateTiltController", () => {
  test("tilt smooths toward the input and slope opposes the tilt", () => {
    const plate = new PlateTiltController({});
    const alpha = 1 - Math.exp(-DT / 0.1);
    const snap = plate.move({ forward: 1 });
    expect(snap.forwardTiltRadians).toBeCloseTo(-0.13 * alpha, 12);
    expect(snap.rightTiltRadians).toBe(0);
    expect(snap.slope.forward).toBeCloseTo(alpha, 12); // downhill toward +forward
    for (let i = 0; i < 600; i++) plate.move({ forward: 1, left: 1 });
    expect(plate.forwardTiltRadians).toBeCloseTo(-0.13, 6);
    expect(plate.rightTiltRadians).toBeCloseTo(0.13, 6);
    expect(plate.slopeSignal().forward).toBeCloseTo(1, 6);
    expect(plate.slopeSignal().right).toBeCloseTo(-1, 6);
  });

  test("reset returns the snapshot for the given tilt", () => {
    const plate = new PlateTiltController({ maxTiltRadians: 0.2 });
    const snap = plate.reset(0.1, -0.05);
    expect(snap.rightTiltRadians).toBe(0.1);
    expect(snap.slope.right).toBeCloseTo(-0.5, 12);
    expect(snap.slope.forward).toBeCloseTo(0.25, 12);
  });
});

describe("SnakeMotionController", () => {
  test("default body trails opposite the initial direction and advances head-first", () => {
    const snake = new SnakeMotionController({});
    expect(snake.getSegments()).toEqual([
      { right: 0, forward: 0 },
      { right: 0, forward: -1 },
      { right: 0, forward: -2 },
      { right: 0, forward: -3 },
    ]);
    const result = snake.move({});
    expect(result.direction).toEqual({ right: 0, forward: 1 });
    expect(snake.head).toEqual({ right: 0, forward: 1 });
    expect(snake.tail).toEqual({ right: 0, forward: -2 });
    expect(snake.length).toBe(4);
    expect(stepSnakeCell({ right: 1.9, forward: 2 }, { right: 1, forward: 0 })).toEqual({ right: 2, forward: 2 });
  });

  test("cardinal mode rejects reversals on the moving axis", () => {
    const snake = new SnakeMotionController({});
    // Moving +forward: backward input is ignored.
    expect(snake.move({ backward: true }).direction).toEqual({ right: 0, forward: 1 });
    // Turn left onto the right axis.
    expect(snake.move({ left: true }).direction).toEqual({ right: -1, forward: 0 });
    // Moving -right: left/right input is ignored (no reversal to +right).
    expect(snake.move({ right: true }).direction).toEqual({ right: -1, forward: 0 });
    // Perpendicular escape is allowed.
    expect(snake.move({ backward: true }).direction).toEqual({ right: 0, forward: -1 });
    // Contradictory input keeps the heading.
    expect(snake.move({ left: true, right: true }).direction).toEqual({ right: 0, forward: -1 });
  });

  test("chase mode turns relative to the heading", () => {
    const snake = new SnakeMotionController({ mode: "chase" });
    expect(snake.move({ left: true }).direction).toEqual({ right: -1, forward: 0 });
    expect(snake.move({ left: true }).direction).toEqual({ right: 0, forward: -1 });
    expect(snake.move({ right: true }).direction).toEqual({ right: -1, forward: 0 });
  });

  test("grow queues pending growth consumed one cell per move", () => {
    const snake = new SnakeMotionController({ initialLength: 2 });
    expect(snake.grow(2)).toBe(2);
    snake.move({});
    expect(snake.length).toBe(3);
    snake.move({});
    expect(snake.length).toBe(4);
    snake.move({});
    expect(snake.length).toBe(4);
    expect(snake.pendingGrowth).toBe(0);
  });

  test("reset restores explicit segments and floors cells", () => {
    const snake = new SnakeMotionController({
      segments: [{ right: 2.9, forward: 3 }, { right: 2, forward: 2 }],
      mode: "chase",
    });
    expect(snake.head).toEqual({ right: 2, forward: 3 });
    snake.reset({});
    expect(snake.length).toBe(4);
    expect(snake.head).toEqual({ right: 0, forward: 0 });
  });
});

describe("determinism golden", () => {
  test("120-step character walk reproduces exactly across fresh instances", () => {
    const run = (): string => {
      const ctrl = new WorldCardinalCharacterMotionController({});
      for (let i = 0; i < 120; i++) {
        const intent = ctrl.planMovement({
          forward: i % 3 === 0 ? 1 : 0.4,
          right: (i % 5) / 5,
          rotateCW: i % 2,
          jump: i % 40 === 10,
          sprint: i % 7 === 0,
          deltaSeconds: DT,
        }) as CharacterMovementIntent;
        ctrl.commitMovement(intent, flatGroundResolve(intent));
      }
      const r = (n: number) => Math.round(n * 1e9) / 1e9;
      return JSON.stringify({
        position: [r(ctrl.position.x), r(ctrl.position.y), r(ctrl.position.z)],
        velocity: [r(ctrl.velocity.x), r(ctrl.velocity.y), r(ctrl.velocity.z)],
        yaw: r(ctrl.yaw),
        pitch: r(ctrl.pitch),
        grounded: ctrl.grounded,
      });
    };

    const first = run();
    const second = run();
    expect(second).toBe(first);
    expect(JSON.parse(first).grounded).toBe(true); // long past the last landing
  });
});
