// playset/test/behavior.test.ts — behavior modules: avoidance steering,
// grid path planning (blocked cells + wrapping), path navigation intent,
// waypoint progress/driving, and the combat state machine with a seeded prng.

import { describe, expect, test } from "bun:test";
import { Vector3 } from "../math/index.ts";
import { RandomGenerator } from "../modules/math/random-utils.ts";
import { NearbyAvoidanceSteering } from "../modules/behavior/nearby-avoidance-steering.ts";
import {
  GridPathPlanner,
  gridCellKey,
  normalizeBlockedCells,
  type GridCell,
  type GridNavigation,
} from "../modules/behavior/grid-path-planner.ts";
import { AgentPathNavigator } from "../modules/behavior/agent-path-navigator.ts";
import { WaypointProgressTracker } from "../modules/behavior/waypoint-progress-tracker.ts";
import { WaypointDriver } from "../modules/behavior/waypoint-driver.ts";
import {
  CombatBehaviorDirector,
  ENEMY_BEHAVIOR_STATES,
} from "../modules/behavior/combat-behavior-director.ts";

const close = (v: number, e: number, digits = 10) => expect(v).toBeCloseTo(e, digits);
const round9 = (n: number) => Math.round(n * 1e9) / 1e9;

describe("NearbyAvoidanceSteering", () => {
  test("clear surroundings produce zero steering (travel preserved)", () => {
    const steering = new NearbyAvoidanceSteering({});
    const result = steering.step({
      selfPosition: { x: 0, y: 0, z: 0 },
      neighbors: [{ position: { x: 0, y: 0, z: -10 } }], // outside neighborDistance
      desiredDirection: { x: 0, y: 0, z: -1 },
    });
    expect(result.steering.toArray()).toEqual([0, 0, 0]);
    expect(result.blockers).toBe(0);
    expect(result.blocked).toBe(false);
  });

  test("deflects away from a neighbor dead ahead and flags it as a blocker", () => {
    const steering = new NearbyAvoidanceSteering({});
    const result = steering.step({
      selfPosition: { x: 0, y: 0, z: 0 },
      neighbors: [{ position: { x: 0, y: 0, z: -1 } }], // 1 unit ahead (-z)
      desiredDirection: { x: 0, y: 0, z: -1 },
    });
    // push = 1 - 1/2.5 = 0.6; away = +z * 0.6*1.2; side = -x * 0.6*0.8
    close(result.steering.z, 0.72);
    close(result.steering.x, -0.48);
    close(result.steering.y, 0);
    // steering opposes the desired direction -> deflection away from the blocker
    expect(result.steering.dot(new Vector3(0, 0, -1))).toBeLessThan(0);
    expect(result.blockers).toBe(1);
    expect(result.blocked).toBe(true);
  });

  test("preferredDirection flips the side-step; self is excluded; clamp holds", () => {
    const steering = new NearbyAvoidanceSteering({});
    const rightBias = steering.step({
      selfPosition: { x: 0, y: 0, z: 0 },
      neighbors: [{ position: { x: 0, y: 0, z: -1 } }],
      preferredDirection: -1,
    });
    close(rightBias.steering.x, 0.48);

    const self = { position: { x: 0, y: 0, z: 0 } };
    const ignoreSelf = steering.step({
      selfPosition: self.position,
      neighbors: [self],
      self,
    });
    expect(ignoreSelf.steering.toArray()).toEqual([0, 0, 0]);

    const crowded = steering.step({
      selfPosition: { x: 0, y: 0, z: 0 },
      neighbors: [
        { position: { x: 0.01, y: 0, z: -0.01 } },
        { position: { x: -0.01, y: 0, z: -0.01 } },
        { position: { x: 0, y: 0, z: -0.02 } },
      ],
    });
    expect(crowded.steering.length()).toBeLessThanOrEqual(2.5 + 1e-12);
  });
});

const NAV: GridNavigation = {
  vectors: {
    forward: { right: 0, forward: 1 },
    right: { right: 1, forward: 0 },
    back: { right: 0, forward: -1 },
    left: { right: -1, forward: 0 },
  },
  neighborOrder: ["forward", "right", "back", "left"],
};

function isAdjacentStep(a: GridCell, b: GridCell, planner: GridPathPlanner): boolean {
  return planner.getNeighbors(a).some((n) => gridCellKey(n.cell) === gridCellKey(b));
}

describe("GridPathPlanner", () => {
  test("cell keys and blocked-cell normalization", () => {
    expect(gridCellKey({ right: 2.9, forward: -1.2 })).toBe("2:-2");
    const keys = normalizeBlockedCells([{ right: 1, forward: 1 }, "3:4", null]);
    expect(keys.has("1:1")).toBe(true);
    expect(keys.has("3:4")).toBe(true);
    expect(keys.size).toBe(2);
  });

  test("routes around blocked cells on a bounded board", () => {
    const planner = new GridPathPlanner({ navigation: NAV, columns: 5, rows: 5, wrap: false });
    const blocked = [0, 1, 2, 3].map((forward) => ({ right: 2, forward })); // wall, gap at forward 4
    const path = planner.findPath({ right: 0, forward: 0 }, { right: 4, forward: 0 }, blocked);
    expect(path).not.toBeNull();
    expect(path![0]).toEqual({ right: 0, forward: 0 });
    expect(path![path!.length - 1]).toEqual({ right: 4, forward: 0 });
    expect(path!.length).toBe(13); // 4 across + 2*4 detour over the gap
    const blockedKeys = normalizeBlockedCells(blocked);
    for (const cell of path!) expect(blockedKeys.has(gridCellKey(cell))).toBe(false);
    for (let i = 1; i < path!.length; i += 1) {
      expect(isAdjacentStep(path![i - 1], path![i], planner)).toBe(true);
    }
  });

  test("fully walled board is unreachable without wrap, trivial with wrap", () => {
    const planner = new GridPathPlanner({ navigation: NAV, columns: 5, rows: 5, wrap: false });
    const wall = [0, 1, 2, 3, 4].map((forward) => ({ right: 2, forward }));
    expect(planner.findPath({ right: 0, forward: 0 }, { right: 4, forward: 0 }, wall)).toBeNull();

    planner.setBoard(5, 5, true);
    const wrapped = planner.findPath({ right: 0, forward: 0 }, { right: 4, forward: 0 }, wall);
    expect(wrapped).toEqual([
      { right: 0, forward: 0 },
      { right: 4, forward: 0 },
    ]); // one left step across the seam
    expect(planner.heuristic({ right: 0, forward: 0 }, { right: 4, forward: 0 })).toBe(1);
  });

  test("neighbors respect edges; floodFill counts reachable cells", () => {
    const bounded = new GridPathPlanner({ navigation: NAV, columns: 3, rows: 3, wrap: false });
    expect(bounded.getNeighbors({ right: 0, forward: 0 }).length).toBe(2);
    const wrapping = new GridPathPlanner({ navigation: NAV, columns: 3, rows: 3, wrap: true });
    expect(wrapping.getNeighbors({ right: 0, forward: 0 }).length).toBe(4);

    const fill = bounded.floodFill({ right: 0, forward: 0 }, [{ right: 1, forward: 1 }]);
    expect(fill.count).toBe(8); // 3x3 minus the blocked center
    const blockedStart = bounded.floodFill({ right: 1, forward: 1 }, [{ right: 1, forward: 1 }], false);
    expect(blockedStart.count).toBe(0);
  });
});

describe("AgentPathNavigator", () => {
  test("produces planar direction, distance, and full speed outside arrive radius", () => {
    const navigator = new AgentPathNavigator({});
    const intent = navigator.step({
      position: { x: 0, y: 0, z: 0 },
      waypoint: { x: 3, y: 9, z: -4 }, // vertical offset must be flattened out
    });
    close(intent.distance, 5);
    close(intent.direction.x, 0.6);
    close(intent.direction.y, 0);
    close(intent.direction.z, -0.8);
    close(intent.desiredSpeed, 3.5);
    expect(navigator.last).toBe(intent);
  });

  test("arrival slowdown scales speed inside the radius; minSpeed floors it", () => {
    const navigator = new AgentPathNavigator({});
    const slow = navigator.step({ position: { x: 0, y: 0, z: 0 }, waypoint: { x: 0.5, y: 0, z: 0 } });
    close(slow.desiredSpeed, 3.5 * (0.5 / 1.25));

    const floored = new AgentPathNavigator({ minSpeed: 2 });
    const intent = floored.step({ position: { x: 0, y: 0, z: 0 }, waypoint: { x: 0.5, y: 0, z: 0 } });
    close(intent.desiredSpeed, 2);
  });

  test("disabled movement or degenerate targets yield neutral intent", () => {
    const navigator = new AgentPathNavigator({});
    const disabled = navigator.step({
      position: { x: 0, y: 0, z: 0 },
      waypoint: { x: 5, y: 0, z: 0 },
      movementEnabled: false,
    });
    expect(disabled.desiredSpeed).toBe(0);
    expect(disabled.direction.toArray()).toEqual([0, 0, 0]);
    expect(disabled.waypoint!.toArray()).toEqual([5, 0, 0]);

    const overhead = navigator.step({ position: { x: 0, y: 0, z: 0 }, waypoint: { x: 0, y: 50, z: 0 } });
    expect(overhead.desiredSpeed).toBe(0);
    expect(overhead.distance).toBe(0);
  });
});

describe("WaypointProgressTracker", () => {
  const ROUTE = [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 10, y: 0, z: -10 },
  ];

  test("advances when within reach distance, wrapping on closed routes", () => {
    const tracker = new WaypointProgressTracker({ waypoints: ROUTE, reachDistance: 4 });
    // Nearest is index 0 (1 away, within reach) -> immediately advances to 1.
    let progress = tracker.step({ x: 1, y: 0, z: 0 })!;
    expect(progress.currentIndex).toBe(1);
    close(progress.distanceToCurrent, 9);
    expect(progress.waypointCount).toBe(3);

    // Approach waypoint 1 -> advances to 2.
    progress = tracker.step({ x: 8, y: 0, z: 0 })!;
    expect(progress.currentIndex).toBe(2);
    close(progress.distanceToCurrent, Math.sqrt(2 * 2 + 10 * 10));

    // Reaching the last waypoint wraps back to 0 on a closed route.
    progress = tracker.step({ x: 10, y: 0, z: -9 })!;
    expect(progress.currentIndex).toBe(0);
  });

  test("open routes stop at the final waypoint", () => {
    const tracker = new WaypointProgressTracker({ waypoints: ROUTE, reachDistance: 4, closed: false });
    tracker.reset(2);
    const progress = tracker.step({ x: 10, y: 0, z: -10 })!;
    expect(progress.currentIndex).toBe(2); // within reach but no next waypoint
    expect(progress.distanceToCurrent).toBe(0);
  });

  test("corner profile reports turn direction and magnitude", () => {
    // forward leg then a right turn: sign -1, 90 degrees.
    const tracker = new WaypointProgressTracker({
      waypoints: [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: -10 },
        { x: 10, y: 0, z: -10 },
      ],
      reachDistance: 1,
    });
    tracker.reset(1);
    const progress = tracker.step({ x: 0, y: 0, z: 5 })!;
    expect(progress.currentIndex).toBe(1);
    expect(progress.cornerSign).toBe(-1);
    close(progress.cornerMagnitude, Math.PI / 2);
  });

  test("setWaypoints filters non-planar points; snapshot mirrors state", () => {
    const tracker = new WaypointProgressTracker({
      waypoints: [{ x: 0, y: 0, z: 0 }, { x: Number.NaN, y: 0, z: 1 }, { x: 5, y: 0, z: 0 }],
    });
    expect(tracker.waypoints.length).toBe(2);
    expect(tracker.step(null)).toBeNull();
    const snap = tracker.snapshot();
    expect(snap.waypointCount).toBe(2);
    expect(snap.initialized).toBe(false);
    expect(snap.last).toBeNull();
  });
});

describe("WaypointDriver", () => {
  test("steering signs point toward the waypoint (reduce heading error)", () => {
    const driver = new WaypointDriver({});
    // yaw 0 faces -z; waypoint to the world +x side -> steer right.
    const toRight = driver.step({ position: { x: 0, y: 0, z: 0 }, yaw: 0, waypoint: { x: 10, y: 0, z: 0 } });
    close(toRight.yawError, Math.PI / 2);
    expect(toRight.steerIntent).toBe(1);
    expect(toRight.right).toBe(true);
    expect(toRight.left).toBe(false);

    const toLeft = driver.step({ position: { x: 0, y: 0, z: 0 }, yaw: 0, waypoint: { x: -10, y: 0, z: 0 } });
    close(toLeft.yawError, -Math.PI / 2);
    expect(toLeft.left).toBe(true);
    expect(toLeft.right).toBe(false);
  });

  test("throttle/boost when slow and straight; brake when over speed or turning hard", () => {
    const driver = new WaypointDriver({});
    const straight = driver.step({
      position: { x: 0, y: 0, z: 0 },
      yaw: 0,
      speed: 0,
      waypoint: { x: 0, y: 0, z: -10 },
    });
    expect(straight.throttle).toBe(true);
    expect(straight.boost).toBe(true);
    expect(straight.brake).toBe(false);
    close(straight.yawError, 0);
    close(straight.desiredSpeed, 32);

    const over = driver.step({
      position: { x: 0, y: 0, z: 0 },
      yaw: 0,
      speed: 40,
      waypoint: { x: 0, y: 0, z: -10 },
    });
    expect(over.brake).toBe(true);
    expect(over.throttle).toBe(false);
    close(over.speedError, -8);

    const corner = driver.step({
      position: { x: 0, y: 0, z: 0 },
      yaw: 0,
      speed: 10,
      waypoint: { x: 0, y: 0, z: -10 },
      cornerMagnitude: Math.PI / 2,
    });
    close(corner.desiredSpeed, 32 - (Math.PI / 2) * 16);
  });

  test("stuck detection triggers a timed reverse with mirrored steering", () => {
    const driver = new WaypointDriver({});
    const input = {
      position: { x: 0, y: 0, z: 0 },
      yaw: 0,
      speed: 0,
      waypoint: { x: 0, y: 0, z: 10 }, // directly behind
      deltaSeconds: 0.3,
    };
    expect(driver.step(input).reverse).toBe(false); // 300ms stuck
    expect(driver.step(input).reverse).toBe(false); // 600ms stuck < 900ms threshold
    const third = driver.step(input); // 900ms -> reverse window (420ms) opens
    expect(third.reverse).toBe(true);
    expect(third.brake).toBe(false);
    expect(third.left).toBe(true); // steerIntent +1, mirrored while reversing
    expect(third.right).toBe(false);
    const fourth = driver.step(input); // 120ms of the window remains
    expect(fourth.reverse).toBe(true);
    const fifth = driver.step(input); // window spent -> back to stuck accrual
    expect(fifth.reverse).toBe(false);
  });

  test("neutral controls before race start or without a waypoint", () => {
    const driver = new WaypointDriver({});
    const idle = driver.step({ position: { x: 0, y: 0, z: 0 }, waypoint: { x: 1, y: 0, z: 0 }, raceStarted: false });
    expect(idle.brake).toBe(true);
    expect(idle.throttle).toBe(false);
    expect(idle.steerIntent).toBe(0);
    expect(driver.step({ position: { x: 0, y: 0, z: 0 } }).brake).toBe(true);
  });

  test("determinism golden: identical input tape reproduces the exact state trace", () => {
    const run = () => {
      const driver = new WaypointDriver({});
      const trace: string[] = [];
      for (let t = 0; t < 120; t += 1) {
        const result = driver.step({
          position: { x: Math.sin(t * 0.05), y: 0, z: 0 },
          yaw: t % 40 < 20 ? 0 : Math.PI,
          speed: t % 40 < 20 ? 0.2 : 6,
          waypoint: { x: 0, y: 0, z: t % 2 === 0 ? 10 : -10 },
          cornerMagnitude: (t % 10) * 0.1,
          deltaSeconds: 1 / 30,
        });
        trace.push(
          JSON.stringify([
            result.throttle,
            result.reverse,
            result.left,
            result.right,
            result.brake,
            round9(result.yawError),
            round9(result.steerIntent),
            round9(driver.stuckMs),
            round9(driver.reverseRemainingMs),
          ]),
        );
      }
      return trace.join("\n");
    };
    const first = run();
    expect(first.length).toBeGreaterThan(0);
    expect(run()).toBe(first);
  });
});

describe("CombatBehaviorDirector", () => {
  const makeDirector = (seed: number) =>
    new CombatBehaviorDirector({ prng: new RandomGenerator(seed) });

  test("idle -> chase -> attack -> dead under scripted conditions", () => {
    const director = makeDirector(7);
    const actor = { x: 0, y: 0, z: 0 };

    // Target far and unseen: stays idle.
    let command = director.step({
      actorId: "e1",
      actorPosition: actor,
      targetPosition: { x: 30, y: 0, z: 0 },
      canSeeTarget: false,
    });
    expect(command.state).toBe(ENEMY_BEHAVIOR_STATES.IDLE);

    // Seen inside chase distance: chase, with an immediate path refresh.
    command = director.step({
      actorId: "e1",
      actorPosition: actor,
      targetPosition: { x: 10, y: 0, z: 0 },
      canSeeTarget: true,
    });
    expect(command.state).toBe(ENEMY_BEHAVIOR_STATES.CHASE);
    expect(command.moveTarget).toEqual({ x: 10, y: 0, z: 0 });
    expect(command.wantsPathRefresh).toBe(true);

    // Inside attack distance: attack, but the cooldown starts armed.
    command = director.step({
      actorId: "e1",
      actorPosition: actor,
      targetPosition: { x: 1, y: 0, z: 0 },
      canSeeTarget: true,
      canAttackTarget: true,
    });
    expect(command.state).toBe(ENEMY_BEHAVIOR_STATES.ATTACK);
    expect(command.wantsAttack).toBe(false);

    // After the cooldown elapses the attack fires and re-arms.
    command = director.step({
      actorId: "e1",
      actorPosition: actor,
      targetPosition: { x: 1, y: 0, z: 0 },
      canSeeTarget: true,
      canAttackTarget: true,
      deltaMs: 1000,
    });
    expect(command.wantsAttack).toBe(true);

    // Death overrides everything.
    command = director.step({ actorId: "e1", actorAlive: false });
    expect(command.state).toBe(ENEMY_BEHAVIOR_STATES.DEAD);
    expect(command.movementStyle).toBe(ENEMY_BEHAVIOR_STATES.DEAD);
    expect(command.aimTarget).toBeNull();
  });

  test("idle waits out its timer then patrols; attack releases back to chase", () => {
    const director = makeDirector(11);
    const actor = { x: 0, y: 0, z: 0 };
    const farTarget = { x: 100, y: 0, z: 0 };

    // Burn the idle wait (max 4500ms) with unseen target: timers decrement
    // before the switch, so patrol starts within the same step.
    let command = director.step({
      actorId: "e2",
      actorPosition: actor,
      targetPosition: farTarget,
      deltaMs: 5000,
    });
    expect(command.state).toBe(ENEMY_BEHAVIOR_STATES.PATROL);
    expect(command.wantsPatrol).toBe(true);

    // With a live move path the patrol holds; without one it lapses to idle.
    command = director.step({
      actorId: "e2",
      actorPosition: actor,
      targetPosition: farTarget,
      hasMovePath: true,
    });
    expect(command.state).toBe(ENEMY_BEHAVIOR_STATES.PATROL);
    expect(command.wantsPatrol).toBe(false);

    // Force chase then step out past the attack hysteresis: back to chase.
    director.step({ actorId: "e2", actorPosition: actor, targetPosition: { x: 1, y: 0, z: 0 }, canSeeTarget: true });
    command = director.step({ actorId: "e2", actorPosition: actor, targetPosition: { x: 1, y: 0, z: 0 }, canSeeTarget: true });
    expect(command.state).toBe(ENEMY_BEHAVIOR_STATES.ATTACK);
    command = director.step({ actorId: "e2", actorPosition: actor, targetPosition: { x: 4, y: 0, z: 0 }, canSeeTarget: true });
    expect(command.state).toBe(ENEMY_BEHAVIOR_STATES.CHASE);
  });

  test("missing target keeps the agent patrolling-neutral", () => {
    const director = makeDirector(3);
    const command = director.step({ actorId: "e3", actorPosition: { x: 0, y: 0, z: 0 } });
    expect(command.wantsPatrol).toBe(true);
    expect(command.moveTarget).toBeNull();
    expect(command.movementStyle).toBe(ENEMY_BEHAVIOR_STATES.IDLE);
  });

  test("determinism golden: same seed and input tape give the same command trace", () => {
    const run = () => {
      const director = makeDirector(1234);
      const trace: string[] = [];
      for (let t = 0; t < 90; t += 1) {
        const distance = 20 - t * 0.5; // walk the target in, then hold close
        const command = director.step({
          actorId: t % 2 === 0 ? "a" : "b",
          actorPosition: { x: 0, y: 0, z: 0 },
          targetPosition: { x: Math.max(1, distance), y: 0, z: 0 },
          canSeeTarget: t > 4,
          canAttackTarget: true,
          hasMovePath: t % 3 === 0,
          deltaMs: 200,
        });
        trace.push(
          JSON.stringify([
            command.state,
            command.wantsPatrol,
            command.wantsPathRefresh,
            command.wantsAttack,
            command.lateralMove,
          ]),
        );
      }
      return trace.join("\n");
    };
    const first = run();
    expect(first).toContain("chase");
    expect(first).toContain("attack");
    expect(run()).toBe(first);
  });

  test("strafing during chase consumes the injected prng, never Math.random", () => {
    const director = makeDirector(42);
    let sawStrafe = 0;
    for (let t = 0; t < 40; t += 1) {
      const command = director.step({
        actorId: "s",
        actorPosition: { x: 0, y: 0, z: 0 },
        targetPosition: { x: 10, y: 0, z: 0 },
        canSeeTarget: true,
        deltaMs: 100,
      });
      expect(command.state).toBe(ENEMY_BEHAVIOR_STATES.CHASE);
      if (command.lateralMove !== 0) sawStrafe += 1;
      expect([-1, 0, 1]).toContain(command.lateralMove);
    }
    expect(sawStrafe).toBeGreaterThan(0); // strafeBias 0.35 over 40 seen-chase steps
  });
});
