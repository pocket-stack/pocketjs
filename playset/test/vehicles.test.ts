// playset/test/vehicles.test.ts — the vehicle/aircraft motion stack: airplane
// flight model + model controller, arcade car, dynamic-car config/controller/
// resolver (kinematic reengineering), drifting plugin, kinematic batch
// resolver modes, and a 120-step determinism golden.

import { describe, expect, test } from "bun:test";
import { Vector3 } from "../math/vector3.ts";
import { Quaternion } from "../math/quaternion.ts";
import { CollisionWorld } from "../modules/physics/collision-world.ts";
import { DEFAULT_WORLD_BASIS } from "../modules/math/world-basis.ts";
import {
  AirplaneMotionController,
  type AirplaneIntent,
  type AirplaneCommitResult,
} from "../modules/actor-motion/aircraft/airplane-motion-controller.ts";
import { AirplaneModelController } from "../modules/actor-motion/aircraft/airplane-model-controller.ts";
import {
  ArcadeCarMotionController,
  type ArcadeCarCommitResult,
} from "../modules/actor-motion/ground-vehicle/arcade-car-motion-controller.ts";
import { CarModelController } from "../modules/actor-motion/ground-vehicle/car-model-controller.ts";
import { createDynamicCarConfigForBasis } from "../modules/actor-motion/ground-vehicle/dynamic-car-config.ts";
import { DynamicCarMotionController } from "../modules/actor-motion/ground-vehicle/dynamic-car-motion-controller.ts";
import {
  DynamicCarBatchResolver,
  type DynamicCarActor,
} from "../modules/actor-motion/ground-vehicle/dynamic-car-batch-resolver.ts";
import {
  DriftingPlugin,
  VEHICLE_DRIFTING_EFFECT_KEY,
  type DriftEffectState,
} from "../modules/actor-motion/ground-vehicle/drifting-plugin.ts";
import {
  KinematicBatchResolver,
  KINEMATIC_ACTOR_COLLISION_MODES,
} from "../modules/actor-motion/kinematic-batch-resolver.ts";

const DT = 1 / 60;

function flatWorld(): CollisionWorld {
  const world = new CollisionWorld();
  world.setTerrain({ heightAt: () => 0 });
  return world;
}

describe("AirplaneMotionController", () => {
  test("throttle ramps and speed lags toward cruise", () => {
    const plane = new AirplaneMotionController({});
    expect(plane.speed).toBe(82);
    const intent = plane.planMovement({ throttle: 1, deltaSeconds: 0.1 }) as AirplaneIntent;
    expect(plane.throttle).toBeCloseTo(0.042, 12); // 0.42 * 0.1
    const cruise = 82 + 0.042 * (246 - 82);
    const alpha = 1 - Math.exp(-0.1 / 0.56);
    expect(intent.speed).toBeCloseTo(82 + (cruise - 82) * alpha, 12);
  });

  test("pitch integrates the up input", () => {
    const plane = new AirplaneMotionController({});
    const intent = plane.planMovement({ up: 1, deltaSeconds: 0.1 }) as AirplaneIntent;
    expect(intent.pitch).toBeCloseTo(1 * 1.18 * 0.1, 12);
    expect(intent.speed).toBeCloseTo(82, 12); // throttle untouched, cruise = minSpeed
  });

  test("left input banks (negative roll) and yaws counter-clockwise", () => {
    const plane = new AirplaneMotionController({});
    const intent = plane.planMovement({ left: 1, deltaSeconds: 0.1 }) as AirplaneIntent;
    const rollAlpha = 1 - Math.exp(-0.1 / 0.21);
    const expectedRoll = -1.1868 * rollAlpha;
    expect(intent.roll).toBeCloseTo(expectedRoll, 12);
    const bankTurnAxis = Math.min(1, Math.max(-1, -expectedRoll / 0.9774));
    expect(intent.yaw).toBeCloseTo(bankTurnAxis * 0.42 * 0.1, 12);
    expect(intent.yaw).toBeGreaterThan(0);
  });

  test("commit integrates forward along the yaw/pitch frame", () => {
    const plane = new AirplaneMotionController({});
    const res = plane.planMovement({ deltaSeconds: 0.1, commit: true }) as AirplaneCommitResult;
    expect(res.position.x).toBeCloseTo(0, 12);
    expect(res.position.y).toBeCloseTo(0, 12);
    expect(res.position.z).toBeCloseTo(-8.2, 12); // 82 m/s * 0.1s along -z
    expect(res.bodyFrame.forward.z).toBeCloseTo(-1, 12);
  });

  test("boost triggers once, times out, and pulls speed toward max*multiplier", () => {
    const plane = new AirplaneMotionController({});
    const first = plane.planMovement({ boost: true, deltaSeconds: 0.1 }) as AirplaneIntent;
    expect(plane.isBoosting).toBe(true);
    expect(plane.boostRemainingSeconds).toBeCloseTo(1.7, 12);
    const target = 246 * 1.28;
    const alpha = 1 - Math.exp(-0.1 / 0.26);
    expect(first.speed).toBeCloseTo(82 + (target - 82) * alpha, 12);

    plane.planMovement({ boost: true, deltaSeconds: 0.1, commit: true });
    expect(plane.boostRemainingSeconds).toBeCloseTo(1.6, 12); // held, not retriggered
  });
});

describe("AirplaneModelController", () => {
  test("writes pose onto the model and drives jet flames", () => {
    const plane = { position: new Vector3(), quaternion: new Quaternion() };
    const flameFrames: unknown[] = [];
    const controller = new AirplaneModelController(plane, [
      { step: (frame) => flameFrames.push(frame) },
    ]);

    controller.step({
      position: { x: 1, y: 2, z: 3 },
      yaw: Math.PI / 2,
      pitch: 0,
      roll: 0,
      throttle: 0.5,
      isBoosting: true,
      elapsedTimeSeconds: 1.5,
    });

    expect(plane.position.toArray()).toEqual([1, 2, 3]);
    const forward = new Vector3(0, 0, -1).applyQuaternion(plane.quaternion);
    expect(forward.x).toBeCloseTo(-1, 12); // yaw +90deg turns -z onto -x
    expect(flameFrames[0]).toEqual({
      throttle: 0.5,
      isBoosting: true,
      timeSeconds: 1.5,
      deltaSeconds: DT,
    });

    controller.reset();
    expect(plane.position.toArray()).toEqual([0, 0, 0]);
  });
});

describe("ArcadeCarMotionController", () => {
  test("single throttle step: exact accel, ride height, velocity", () => {
    const car = new ArcadeCarMotionController({});
    const res = car.planMovement({ throttle: 1, commit: true }) as ArcadeCarCommitResult;
    const v1 = 40 / 60; // throttleAccel * dt from standstill
    expect(res.velocity.z).toBeCloseTo(-v1, 12);
    expect(res.speed).toBeCloseTo(v1, 12);
    expect(res.position.z).toBeCloseTo(-v1 / 60, 12);
    expect(res.position.y).toBeCloseTo(0.38, 12); // terrain 0 + rideHeight
  });

  test("120 steps of full throttle match the discrete drag curve", () => {
    const car = new ArcadeCarMotionController({});
    let res: ArcadeCarCommitResult | null = null;
    for (let i = 0; i < 120; i += 1) {
      res = car.planMovement({ throttle: 1, commit: true }) as ArcadeCarCommitResult;
    }
    // v_{n+1} = v_n + (40 - v_n)/60  =>  v_N = 40 (1 - (59/60)^N)
    expect(res!.speed).toBeCloseTo(40 * (1 - (59 / 60) ** 120), 8);
  });

  test("steering left turns counter-clockwise and curves toward -x", () => {
    const car = new ArcadeCarMotionController({});
    let res: ArcadeCarCommitResult | null = null;
    for (let i = 0; i < 90; i += 1) {
      res = car.planMovement({ throttle: 1, left: 1, commit: true }) as ArcadeCarCommitResult;
    }
    expect(res!.yaw).toBeGreaterThan(0.1);
    expect(res!.position.x).toBeLessThan(-0.1);
    expect(res!.steeringAngle).toBeGreaterThan(0.5); // steer saturated near 0.56
  });

  test("terrain following: height + rideHeight, sampler normal adopted", () => {
    const terrain = {
      sample: (_r: number, f: number) => ({
        height: 0.1 * f,
        normal: DEFAULT_WORLD_BASIS.surfaceNormalFromSlopes(0, 0.1),
      }),
    };
    const car = new ArcadeCarMotionController({});
    let res: ArcadeCarCommitResult | null = null;
    for (let i = 0; i < 30; i += 1) {
      res = car.planMovement({ throttle: 1, terrain, commit: true }) as ArcadeCarCommitResult;
    }
    const forward = -res!.position.z;
    expect(forward).toBeGreaterThan(0.05);
    expect(res!.position.y).toBeCloseTo(0.1 * forward + 0.38, 12);
    expect(res!.surfaceNormal.z).toBeGreaterThan(0.05); // tilted against the climb
    expect(res!.bodyFrame.up.dot(res!.surfaceNormal)).toBeCloseTo(1, 12);
  });
});

describe("CarModelController", () => {
  test("wheel spin and steering yaw with and without pivots", () => {
    const model = { position: new Vector3(), quaternion: new Quaternion() };
    const wheels = [0, 1, 2, 3].map(() => ({ rotation: { x: 0, y: 0 } }));
    const pivots = [{ rotation: { x: 0, y: 0 } }, { rotation: { x: 0, y: 0 } }];
    const controller = new CarModelController({
      vehicleModel: model,
      wheels,
      wheelPivots: pivots,
      wheelRadius: 0.35,
    });

    controller.step({
      position: new Vector3(1, 2, 3),
      bodyFrame: {
        right: new Vector3(1, 0, 0),
        up: new Vector3(0, 1, 0),
        forward: new Vector3(0, 0, -1),
      },
      velocity: new Vector3(0, 0, -5),
      steeringAngle: 0.3,
    });

    expect(model.position.toArray()).toEqual([1, 2, 3]);
    const spin = (5 * DT) / 0.35;
    expect(wheels[0]!.rotation.x).toBeCloseTo(spin, 12);
    expect(wheels[3]!.rotation.x).toBeCloseTo(spin, 12);
    expect(pivots[0]!.rotation.y).toBeCloseTo(0.3, 12); // steer via pivot
    expect(wheels[0]!.rotation.y).toBe(0); // pivot owns the yaw
    expect(wheels[2]!.rotation.y).toBe(0); // rear wheels never steer

    // Identity body frame -> identity chassis quaternion.
    expect(Math.abs(model.quaternion.w)).toBeCloseTo(1, 12);

    controller.reset(new Vector3());
    expect(controller.wheelSpin).toBe(0);
    expect(wheels[0]!.rotation.x).toBe(0);
  });
});

describe("createDynamicCarConfigForBasis", () => {
  test("defaults resolve to world-axis vectors", () => {
    const config = createDynamicCarConfigForBasis();
    expect(config.chassis.mass).toBe(1250);
    expect(config.chassis.halfExtents).toEqual({ x: 0.85, y: 0.35, z: 1.5 });
    expect(config.chassis.colliderOffset.y).toBeCloseTo(0.42, 12);
    expect(config.axes).toEqual({ forwardSign: -1, forwardAxis: 2, upAxis: 1 });
    expect(config.drive.maxEngineForce).toBe(4400);
    // basisObject signs can yield -0 on zeroed axes; compare numerically.
    expect(config.wheelDefaults.direction.x + 0).toBe(0);
    expect(config.wheelDefaults.direction.y).toBe(-1);
    expect(config.wheelDefaults.direction.z + 0).toBe(0);
    expect(config.wheelDefaults.axle.x).toBe(-1);
    expect(config.wheelDefaults.axle.y + 0).toBe(0);
    expect(config.wheelDefaults.axle.z + 0).toBe(0);

    expect(config.wheels.map((w) => w.name)).toEqual([
      "frontLeft",
      "frontRight",
      "rearLeft",
      "rearRight",
    ]);
    const frontLeft = config.wheels[0]!;
    expect(frontLeft.connection.x).toBeCloseTo(-0.84, 12);
    expect(frontLeft.connection.y).toBeCloseTo(0.42, 12);
    expect(frontLeft.connection.z).toBeCloseTo(-1.07, 12);
    expect(frontLeft.steerable).toBe(true);
    expect(frontLeft.drive).toBe(false);
    const rearLeft = config.wheels[2]!;
    expect(rearLeft.drive).toBe(true);
    expect(rearLeft.handbrake).toBe(true);
    expect(rearLeft.radius).toBe(0.35);
  });

  test("overrides merge without clobbering siblings", () => {
    const config = createDynamicCarConfigForBasis({
      drive: { maxEngineForce: 9000 },
      chassis: { mass: 800, halfExtents: { right: 1 } },
      wheels: [{ name: "solo", offset: { right: 0, up: 0.4, forward: 0 }, drive: true }],
    });
    expect(config.drive.maxEngineForce).toBe(9000);
    expect(config.drive.maxBrakeForce).toBe(95);
    expect(config.chassis.mass).toBe(800);
    expect(config.chassis.halfExtents.x).toBeCloseTo(1, 12);
    expect(config.chassis.halfExtents.y).toBeCloseTo(0.35, 12);
    expect(config.wheels).toHaveLength(1);
    expect(config.wheels[0]!.connection.y).toBeCloseTo(0.4, 12);
    expect(config.wheels[0]!.drive).toBe(true);

    expect(() => createDynamicCarConfigForBasis({ wheels: [{ name: "bad" }] })).toThrow(
      "wheel offset or connection is required",
    );
  });
});

describe("DynamicCarMotionController", () => {
  test("input smoothing produces the exponential-lag numbers", () => {
    const controller = new DynamicCarMotionController({});
    const intent = controller.planMovement({ left: 1, throttle: 1, deltaSeconds: 0.1 });
    const steer = 1 - Math.exp(-0.1 / 0.09);
    expect(controller.inputSteer).toBe(1);
    expect(controller.steer).toBeCloseTo(steer, 12);
    expect(intent.steeringAngle).toBeCloseTo(steer * 0.56, 12);
    expect(intent.throttle).toBeCloseTo(1 - Math.exp(-0.1 / 0.06), 12);

    const release = controller.planMovement({ deltaSeconds: 0.1 });
    expect(release.throttle).toBeCloseTo((1 - Math.exp(-0.1 / 0.06)) * Math.exp(-0.1 / 0.04), 12);
  });

  test("commitMovement mirrors the resolved state", () => {
    const world = flatWorld();
    const resolver = new DynamicCarBatchResolver({ world });
    const actor = resolver.createActor({ position: { x: 0, y: 0.29, z: 0 } });
    const controller = new DynamicCarMotionController({});

    resolver.beginFrame();
    resolver.queueMove(actor, controller.planMovement({ throttle: 1, deltaSeconds: DT }));
    const resolved = resolver.resolveQueuedMoves(DT).get(actor)!;
    controller.commitMovement(resolved);

    expect(controller.position).toBe(resolved.position);
    expect(controller.grounded).toBe(resolved.grounded);
    expect(controller.wheels).toBe(resolved.wheels);
    expect(controller.vehicleSpeed).toBe(resolved.vehicleSpeed);
  });
});

describe("KinematicBatchResolver", () => {
  const CAPSULE = { type: "capsule", halfHeight: 0.5, radius: 0.4 } as const;

  test("wall block: corrected delta, velocity, grounded", () => {
    const world = flatWorld();
    world.addCuboid({ position: { x: 0, y: 1, z: -5 }, halfExtents: { x: 5, y: 1, z: 0.5 } });
    const resolver = new KinematicBatchResolver(world);
    const actor = resolver.createActor({ position: { x: 0, y: 0.9, z: 0 }, colliderShape: CAPSULE });

    resolver.beginFrame();
    resolver.queueMove(actor, {
      startPosition: { x: 0, y: 0.9, z: 0 },
      desiredDelta: { x: 1, y: 0, z: -4.3 },
      deltaSeconds: 0.1,
    });
    const result = resolver.resolveQueuedMoves(0.1).get(actor)!;

    expect(result.blocked).toBe(true);
    expect(result.collisions).toBe(1);
    expect(result.grounded).toBe(true);
    expect(result.position.x).toBeCloseTo(1, 12);
    expect(result.position.z).toBeCloseTo(-4.1, 12); // wall face 4.5 - radius
    expect(result.correctedDelta.z).toBeCloseTo(-4.1, 12);
    expect(result.velocity.z).toBeCloseTo(-41, 12); // correctedDelta / 0.1s
    expect(resolver.getResult(actor)).toBe(result);
  });

  test("bodyOffset keeps the public position at the gameplay anchor", () => {
    const resolver = new KinematicBatchResolver(flatWorld());
    const actor = resolver.createActor({
      position: { x: 0, y: 0, z: 0 },
      bodyOffset: { x: 0, y: 0.9, z: 0 },
      colliderShape: CAPSULE,
    });
    resolver.beginFrame();
    resolver.queueMove(actor, {
      startPosition: { x: 0, y: 0, z: 0 },
      desiredDelta: { x: 0, y: 0, z: -1 },
      deltaSeconds: DT,
    });
    const result = resolver.resolveQueuedMoves(DT).get(actor)!;
    expect(result.position.y).toBeCloseTo(0, 12); // anchor, not collider center
    expect(result.position.z).toBeCloseTo(-1, 12);
    expect(result.grounded).toBe(true);
  });

  test("autostep maps to climb: steps up with it, walled without", () => {
    const world = flatWorld();
    world.addCuboid({
      position: { x: 0, y: 0.2, z: -3 },
      halfExtents: { x: 5, y: 0.2, z: 1 },
      walkable: true,
    });
    const resolver = new KinematicBatchResolver(world);
    const stepper = resolver.createActor({
      position: { x: -3, y: 0.9, z: 0 },
      colliderShape: CAPSULE,
      controllerOptions: { autostep: { enabled: true, maxHeight: 0.55 }, snapToGround: 0.3 },
    });
    const bumper = resolver.createActor({ position: { x: 3, y: 0.9, z: 0 }, colliderShape: CAPSULE });

    resolver.beginFrame();
    resolver.queueMove(stepper, {
      startPosition: { x: -3, y: 0.9, z: 0 },
      desiredDelta: { x: 0, y: 0, z: -2.2 },
      deltaSeconds: DT,
    });
    resolver.queueMove(bumper, {
      startPosition: { x: 3, y: 0.9, z: 0 },
      desiredDelta: { x: 0, y: 0, z: -2.2 },
      deltaSeconds: DT,
    });
    const results = resolver.resolveQueuedMoves(DT);

    const up = results.get(stepper)!;
    expect(up.blocked).toBe(false);
    expect(up.position.y).toBeCloseTo(1.3, 12); // on top of the 0.4 box
    expect(up.grounded).toBe(true);

    const blocked = results.get(bumper)!;
    expect(blocked.blocked).toBe(true);
    expect(blocked.position.z).toBeCloseTo(-1.6, 12); // near face 2 - 0.4
    expect(blocked.position.y).toBeCloseTo(0.9, 12);
  });

  test("actor collision modes: ignoreActors / startPositions / sequential", () => {
    const setup = () => {
      const resolver = new KinematicBatchResolver(flatWorld());
      const a = resolver.createActor({ position: { x: 0, y: 0.9, z: 0 }, colliderShape: CAPSULE });
      const b = resolver.createActor({ position: { x: 1, y: 0.9, z: 0 }, colliderShape: CAPSULE });
      return { resolver, a, b };
    };
    const moveOf = (x: number) => ({
      startPosition: { x, y: 0.9, z: 0 },
      desiredDelta: { x: 0.6, y: 0, z: 0 },
      deltaSeconds: DT,
    });

    // ignoreActors: A passes straight through B's circle.
    {
      const { resolver, a } = setup();
      resolver.beginFrame();
      resolver.queueMove(a, moveOf(0));
      const res = resolver
        .resolveQueuedMoves(DT, KINEMATIC_ACTOR_COLLISION_MODES.ignoreActors)
        .get(a)!;
      expect(res.blocked).toBe(false);
      expect(res.position.x).toBeCloseTo(0.6, 12);
    }

    // startPositions (default): both resolve against frame-start positions.
    {
      const { resolver, a, b } = setup();
      resolver.beginFrame();
      resolver.queueMove(a, moveOf(0));
      resolver.queueMove(b, moveOf(1));
      const results = resolver.resolveQueuedMoves(DT);
      // A's desired 0.6 is 0.4 from B's start 1: pushed out to 1 - 0.8.
      expect(results.get(a)!.position.x).toBeCloseTo(0.2, 12);
      expect(results.get(a)!.blocked).toBe(true);
      // B's desired 1.6 is 1.6 from A's start 0: free.
      expect(results.get(b)!.position.x).toBeCloseTo(1.6, 12);
      expect(results.get(b)!.blocked).toBe(false);
    }

    // sequential: queue order decides who blocks whom.
    {
      const { resolver, a, b } = setup();
      resolver.beginFrame();
      resolver.queueMove(b, moveOf(1)); // B vacates first...
      resolver.queueMove(a, moveOf(0));
      const results = resolver.resolveQueuedMoves(DT, KINEMATIC_ACTOR_COLLISION_MODES.sequential);
      expect(results.get(b)!.position.x).toBeCloseTo(1.6, 12);
      expect(results.get(a)!.position.x).toBeCloseTo(0.6, 12); // ...so A is free
      expect(results.get(a)!.blocked).toBe(false);
    }
    {
      const { resolver, a, b } = setup();
      resolver.beginFrame();
      resolver.queueMove(a, moveOf(0)); // A moves while B still sits at 1
      resolver.queueMove(b, moveOf(1));
      const results = resolver.resolveQueuedMoves(DT, KINEMATIC_ACTOR_COLLISION_MODES.sequential);
      expect(results.get(a)!.position.x).toBeCloseTo(0.2, 12);
      expect(results.get(a)!.blocked).toBe(true);
      expect(results.get(b)!.position.x).toBeCloseTo(1.6, 12);
    }
  });

  test("queueMove rejects unknown actors", () => {
    const resolver = new KinematicBatchResolver(flatWorld());
    const other = new KinematicBatchResolver(flatWorld());
    const stranger = other.createActor({ position: { x: 0, y: 0.9, z: 0 }, colliderShape: CAPSULE });
    expect(() => resolver.queueMove(stranger, {})).toThrow("unknown actor handle");
  });
});

describe("DynamicCarBatchResolver (kinematic reengineering)", () => {
  const RIDE_HEIGHT = 0.35 + 0.36 - 0.42; // wheel radius + rest length - connection up

  function settle(resolver: DynamicCarBatchResolver, actor: DynamicCarActor, steps = 120): void {
    for (let i = 0; i < steps; i += 1) {
      resolver.beginFrame();
      resolver.queueMove(actor, {});
      resolver.resolveQueuedMoves(DT);
    }
  }

  test("falls and settles at ground height on flat terrain", () => {
    const resolver = new DynamicCarBatchResolver({ world: flatWorld() });
    const actor = resolver.createActor({ position: { x: 0, y: 3, z: 0 } });

    resolver.beginFrame();
    let result = resolver.resolveQueuedMoves(DT).get(actor)!;
    expect(result.grounded).toBe(false); // still airborne on the first step

    settle(resolver, actor);
    result = resolver.getResult(actor)!;
    expect(result.grounded).toBe(true);
    expect(result.position.y).toBeCloseTo(RIDE_HEIGHT, 6);
    expect(result.speed).toBeCloseTo(0, 6);
  });

  test("accelerates forward under throttle", () => {
    const resolver = new DynamicCarBatchResolver({ world: flatWorld() });
    const actor = resolver.createActor({ position: { x: 0, y: RIDE_HEIGHT, z: 0 } });
    settle(resolver, actor, 5);

    for (let i = 0; i < 120; i += 1) {
      resolver.beginFrame();
      resolver.queueMove(actor, { throttle: 1, deltaSeconds: DT });
      resolver.resolveQueuedMoves(DT);
    }
    const result = resolver.getResult(actor)!;
    expect(result.vehicleSpeed).toBeGreaterThan(5);
    expect(result.horizontalSpeed).toBeCloseTo(result.vehicleSpeed, 3); // no slip straight-line
    expect(result.position.z).toBeLessThan(-5); // forward is -z
    expect(result.velocity.z).toBeLessThan(-5);
    expect(result.grounded).toBe(true);
  });

  test("steering curves the path; brake stops the car", () => {
    const resolver = new DynamicCarBatchResolver({ world: flatWorld() });
    const actor = resolver.createActor({ position: { x: 0, y: RIDE_HEIGHT, z: 0 } });
    settle(resolver, actor, 5);

    for (let i = 0; i < 120; i += 1) {
      resolver.beginFrame();
      resolver.queueMove(actor, { throttle: 1, steeringAngle: 0.4, deltaSeconds: DT });
      resolver.resolveQueuedMoves(DT);
    }
    const turned = resolver.getResult(actor)!;
    expect(turned.position.x).toBeLessThan(-0.5); // CCW turn drifts toward -x
    expect(turned.bodyFrame.forward.x).toBeLessThan(-0.1);
    expect(turned.wheels[0]!.steering).toBeCloseTo(0.4, 12); // steerable fronts
    expect(turned.wheels[2]!.steering).toBe(0); // rears never steer
    expect(turned.angularVelocity.y).toBeGreaterThan(0.05);

    for (let i = 0; i < 120; i += 1) {
      resolver.beginFrame();
      resolver.queueMove(actor, { brake: 1, deltaSeconds: DT });
      resolver.resolveQueuedMoves(DT);
    }
    const stopped = resolver.getResult(actor)!;
    expect(stopped.horizontalSpeed).toBeLessThan(0.05);
    expect(Math.abs(stopped.vehicleSpeed)).toBeLessThan(0.05);
  });

  test("terrain-follows a slope: ride height and pitched body frame", () => {
    const world = new CollisionWorld();
    world.setTerrain({ heightAt: (_r, f) => 0.1 * f }); // rises with forward
    const resolver = new DynamicCarBatchResolver({ world });
    const actor = resolver.createActor({ position: { x: 0, y: 1, z: -5 } });
    settle(resolver, actor, 60);

    for (let i = 0; i < 90; i += 1) {
      resolver.beginFrame();
      resolver.queueMove(actor, { throttle: 1, deltaSeconds: DT });
      resolver.resolveQueuedMoves(DT);
    }
    const result = resolver.getResult(actor)!;
    const forward = -result.position.z;
    // Suspension lag rides slightly low while the target keeps climbing.
    expect(Math.abs(result.position.y - (0.1 * forward + RIDE_HEIGHT))).toBeLessThan(0.15);
    // Finite-difference normal tilts the body: nose pitched up the slope.
    expect(result.bodyFrame.forward.y).toBeCloseTo(0.1 / Math.sqrt(1.01), 3);
    expect(result.bodyFrame.up.dot(new Vector3(0, 1, 0))).toBeGreaterThan(0.99);
  });

  test("walls clip the car's planar motion", () => {
    const world = flatWorld();
    world.addCuboid({ position: { x: 0, y: 1, z: -20 }, halfExtents: { x: 10, y: 1, z: 0.5 } });
    const resolver = new DynamicCarBatchResolver({ world });
    const actor = resolver.createActor({ position: { x: 0, y: RIDE_HEIGHT, z: 0 } });

    for (let i = 0; i < 360; i += 1) {
      resolver.beginFrame();
      resolver.queueMove(actor, { throttle: 1, boost: true, deltaSeconds: DT });
      resolver.resolveQueuedMoves(DT);
    }
    const result = resolver.getResult(actor)!;
    // Chassis footprint radius 1.5: stopped at the wall, not through it.
    expect(result.position.z).toBeGreaterThanOrEqual(-18.01);
    expect(result.position.z).toBeLessThan(-17); // but it did reach the wall
    expect(Math.abs(result.vehicleSpeed)).toBeLessThan(0.5);
  });

  test("result shape matches the original contract and drives CarModelController", () => {
    const resolver = new DynamicCarBatchResolver({ world: flatWorld() });
    const actor = resolver.createActor({ position: { x: 0, y: RIDE_HEIGHT, z: 0 } });
    settle(resolver, actor, 5);
    for (let i = 0; i < 60; i += 1) {
      resolver.beginFrame();
      resolver.queueMove(actor, { throttle: 1, steeringAngle: 0.3, deltaSeconds: DT });
      resolver.resolveQueuedMoves(DT);
    }
    const result = resolver.getResult(actor)!;

    expect(Object.keys(result).sort()).toEqual(
      [
        "angularVelocity",
        "bodyFrame",
        "extensionState",
        "grounded",
        "horizontalSpeed",
        "position",
        "rotation",
        "speed",
        "vehicleSpeed",
        "velocity",
        "wheels",
      ].sort(),
    );
    expect(result.wheels).toHaveLength(4);
    expect(Object.keys(result.wheels[0]!).sort()).toEqual(
      ["inContact", "index", "name", "rotation", "steering", "suspensionLength"].sort(),
    );
    expect(result.wheels[0]!.suspensionLength).toBeCloseTo(0.36, 12);
    expect(result.wheels[0]!.rotation).toBeGreaterThan(0); // spun up under throttle
    expect(result.rotation).toBeInstanceOf(Quaternion);

    // Drive a CarModelController against mirror scene objects.
    const model = { position: new Vector3(), quaternion: new Quaternion() };
    const wheels = [0, 1, 2, 3].map(() => ({ rotation: { x: 0, y: 0 } }));
    const pivots = [{ rotation: { x: 0, y: 0 } }, { rotation: { x: 0, y: 0 } }];
    const carModel = new CarModelController({
      vehicleModel: model,
      wheels,
      wheelPivots: pivots,
      wheelRadius: 0.35,
    });
    carModel.step({
      position: result.position,
      bodyFrame: result.bodyFrame,
      velocity: result.velocity,
      steeringAngle: result.wheels[0]!.steering,
      deltaSeconds: DT,
    });
    expect(model.position.equals(result.position)).toBe(true);
    expect(wheels[0]!.rotation.x).toBeGreaterThan(0); // wheel spin applied
    expect(pivots[0]!.rotation.y).toBeCloseTo(result.wheels[0]!.steering, 12);
    const modelForward = new Vector3(0, 0, -1).applyQuaternion(model.quaternion);
    expect(modelForward.dot(result.bodyFrame.forward)).toBeCloseTo(1, 6);
  });

  test("resetState re-anchors the actor and clears motion", () => {
    const resolver = new DynamicCarBatchResolver({ world: flatWorld() });
    const actor = resolver.createActor({ position: { x: 0, y: RIDE_HEIGHT, z: 0 } });
    settle(resolver, actor, 5);
    for (let i = 0; i < 60; i += 1) {
      resolver.beginFrame();
      resolver.queueMove(actor, { throttle: 1, deltaSeconds: DT });
      resolver.resolveQueuedMoves(DT);
    }
    const resolved = resolver.resetState(actor, { x: 5, y: 1, z: -2 }, Math.PI / 2);
    expect(resolved.position.toArray()).toEqual([5, 1, -2]);
    expect(resolved.speed).toBe(0);
    expect(resolved.bodyFrame.forward.x).toBeCloseTo(-1, 6); // yawed 90deg CCW
    expect(resolver.getResult(actor)!.vehicleSpeed).toBeCloseTo(0, 12);
  });

  test("drifting plugin engages under handbrake slip and rewrites wheel controls", () => {
    const world = flatWorld();
    const plugin = new DriftingPlugin({});
    const controller = new DynamicCarMotionController({ plugins: [plugin] });
    const resolver = new DynamicCarBatchResolver({ world, effects: [plugin] });
    const actor = resolver.createActor({ position: { x: 0, y: RIDE_HEIGHT, z: 0 } });

    const drive = (input: Parameters<DynamicCarMotionController["planMovement"]>[0]) => {
      const intent = controller.planMovement({ ...input, deltaSeconds: DT });
      resolver.beginFrame();
      resolver.queueMove(actor, intent);
      const results = resolver.resolveQueuedMoves(DT);
      controller.commitMovement(results.get(actor) ?? null);
      return results.get(actor)!;
    };

    for (let i = 0; i < 120; i += 1) drive({ throttle: 1 });
    expect(plugin.snapshot().driftAmount).toBeLessThan(0.2); // straight-line: no drift

    let result = resolver.getResult(actor)!;
    for (let i = 0; i < 60; i += 1) result = drive({ throttle: 1, left: 1, handbrake: true });

    const drift = result.extensionState[VEHICLE_DRIFTING_EFFECT_KEY] as DriftEffectState;
    expect(drift.driftAmount).toBeGreaterThan(0.5);
    expect(drift.driftSide).toBe(1); // steering left
    expect(plugin.snapshot().driftAmount).toBeCloseTo(drift.driftAmount, 12);

    // Wheel controls were rewritten: rear side friction faded, handbrake released.
    const rear = actor.wheelControls[2]!;
    expect(rear.sideFrictionStiffness).toBeLessThan(0.5); // toward 0.3 scale
    expect(rear.handbrakeForce).toBeLessThan(20); // handbrakeBrakeScale 0 fades 140
    const front = actor.wheelControls[0]!;
    expect(front.sideFrictionStiffness).toBeCloseTo(1, 6); // fronts untouched
    expect(front.steering).toBeGreaterThan(controller.steeringAngle); // steering assist

    // Yaw assist actually bends the trajectory versus a no-effect twin.
    expect(Math.abs(result.angularVelocity.y)).toBeGreaterThan(0.2);
  });

  test("120-step determinism golden: two fresh stacks agree exactly", () => {
    const run = () => {
      const world = new CollisionWorld();
      world.setTerrain({ heightAt: (r, f) => 0.4 * Math.sin(r * 0.3) + 0.3 * Math.cos(f * 0.25) });
      const plugin = new DriftingPlugin({});
      const controller = new DynamicCarMotionController({ plugins: [plugin] });
      const resolver = new DynamicCarBatchResolver({ world, effects: [plugin] });
      const actor = resolver.createActor({ position: { x: 0, y: 1, z: 0 } });

      const snapshots: unknown[] = [];
      for (let i = 0; i < 120; i += 1) {
        const intent = controller.planMovement({
          throttle: 1,
          left: i > 30 ? 1 : 0,
          right: i > 100 ? 0.5 : 0,
          handbrake: i > 60 && i < 90,
          deltaSeconds: DT,
        });
        resolver.beginFrame();
        resolver.queueMove(actor, intent);
        const results = resolver.resolveQueuedMoves(DT);
        controller.commitMovement(results.get(actor) ?? null);
        if (i % 30 === 29) {
          const r = results.get(actor)!;
          snapshots.push({
            p: r.position.toArray(),
            q: r.rotation.toArray(),
            v: r.velocity.toArray(),
            w: r.wheels.map((wheel) => [wheel.rotation, wheel.steering, wheel.inContact]),
            g: r.grounded,
            drift: plugin.snapshot(),
          });
        }
      }
      return JSON.stringify(snapshots);
    };

    expect(run()).toBe(run());
  });
});
