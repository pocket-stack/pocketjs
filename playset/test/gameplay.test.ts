// playset/test/gameplay.test.ts — gameplay referees and fire control:
// AimResolver, CombatPlay, FlightPlay, RaceCheckpointLapPlay, SnakePlay,
// WaveSpawnDirector, ProjectileWeaponSystem, ProjectileManager.

import { describe, expect, test } from "bun:test";
import { Quaternion, Vector3 } from "../math/index.ts";
import { RandomGenerator } from "../modules/math/random-utils.ts";
import { Clock } from "../modules/math/time-utils.ts";
import { toVec3 } from "../modules/math/vector3-utils.ts";
import { CollisionWorld } from "../modules/physics/collision-world.ts";
import { AimResolver } from "../modules/gameplay/aim-resolver.ts";
import { CombatPlay, COMBAT_PLAY_EVENTS, COMBAT_STATES } from "../modules/gameplay/combat-play.ts";
import { FlightPlay, FLIGHT_PLAY_EVENTS, type CrashHeightFn } from "../modules/gameplay/flight-play.ts";
import {
  RACE_CHECKPOINT_LAP_EVENTS,
  RACE_STATES,
  RaceCheckpointLapPlay,
} from "../modules/gameplay/race-checkpoint-lap-play.ts";
import { SNAKE_DEATH_REASONS, SNAKE_PLAY_EVENTS, SnakePlay } from "../modules/gameplay/snake-play.ts";
import { WaveSpawnDirector } from "../modules/gameplay/wave-spawn-director.ts";
import {
  ProjectileManager,
  type ProjectileLike,
  type ProjectileSpawnConfig,
  type ProjectileTargetLike,
  type ProjectileVisualLike,
} from "../modules/gameplay/combat/projectile-manager.ts";
import {
  MISSILE_LOCK_STATUS,
  ProjectileWeaponSystem,
  WEAPON_AIM_MODES,
  WEAPON_DECISIONS,
  WEAPON_TYPES,
  type WeaponBodyFrame,
} from "../modules/gameplay/combat/projectile-weapon-system.ts";

// ---------------------------------------------------------------------------
// AimResolver
// ---------------------------------------------------------------------------

/** Camera3D-shaped test double (same rayFromNdc math as scene3d/client.ts). */
function makeCamera(
  position: Vector3,
  quaternion = new Quaternion(),
  fovY = (60 * Math.PI) / 180,
  aspect = 480 / 272,
) {
  return {
    position,
    rayFromNdc(ndcX: number, ndcY: number, target = new Vector3()): Vector3 {
      const halfTan = Math.tan(fovY / 2);
      return target
        .set(ndcX * halfTan * aspect, ndcY * halfTan, -1)
        .applyQuaternion(quaternion)
        .normalize();
    },
  };
}

describe("AimResolver", () => {
  const resolver = new AimResolver({ maxDistance: 100 });
  const camera = makeCamera(new Vector3(0, 0, 0));
  const drone = { position: { x: 0, y: 0, z: -10 }, radius: 2, tag: "drone" };

  test("getAimDirection: center crosshair looks straight down -z", () => {
    expect(resolver.getAimDirection(camera).toArray()).toEqual([0, 0, -1]);
    const off = resolver.getAimDirection(camera, { x: 0.5, y: 0 });
    expect(off.x).toBeGreaterThan(0);
    expect(off.z).toBeLessThan(0);
    expect(off.length()).toBeCloseTo(1, 12);
  });

  test("center crosshair hits a sphere target dead-on", () => {
    const aim = resolver.getAimFromCamera({
      camera,
      launchPosition: { x: 0, y: 0, z: 0 },
      targets: [drone],
    });
    expect(aim.hasHit).toBe(true);
    expect(aim.aimDirection.toArray()).toEqual([0, 0, -1]);
    // sphere front surface: |center| 10 minus radius 2
    expect(aim.hit!.distance).toBeCloseTo(8, 12);
    expect(aim.hitPosition.x).toBeCloseTo(0, 12);
    expect(aim.hitPosition.y).toBeCloseTo(0, 12);
    expect(aim.hitPosition.z).toBeCloseTo(-8, 12);
    expect(aim.hit!.tag).toBe("drone");
    expect(aim.target).toBe(drone);
    expect(aim.aimRayDistance).toBe(100); // launch sits on the aim origin
    expect(aim.launchDistanceToHit).toBeCloseTo(8, 12);
    expect(aim.shootingDirection.z).toBeCloseTo(-1, 12);
  });

  test("offset launch: shooting direction converges on the crosshair hit", () => {
    const aim = resolver.getAimFromCamera({
      camera,
      launchPosition: { x: 2, y: 0, z: 0 },
      targets: [drone],
    });
    const len = Math.sqrt(68); // |(0,0,-8) - (2,0,0)|
    expect(aim.aimRayDistance).toBe(102); // 100 + |aimOrigin -> launch|
    expect(aim.launchDistanceToHit).toBeCloseTo(len, 12);
    expect(aim.shootingDirection.x).toBeCloseTo(-2 / len, 12);
    expect(aim.shootingDirection.y).toBeCloseTo(0, 12);
    expect(aim.shootingDirection.z).toBeCloseTo(-8 / len, 12);
    const reached = aim.launchPosition.clone().addScaledVector(aim.shootingDirection, aim.launchDistanceToHit);
    expect(reached.distanceTo(aim.hitPosition)).toBeCloseTo(0, 12);
  });

  test("no hit: virtual point at aimRayDistance along the ray", () => {
    const aim = resolver.getAimFromCamera({ camera, launchPosition: { x: 0, y: 0, z: 0 } });
    expect(aim.hasHit).toBe(false);
    expect(aim.hit).toBe(null);
    expect(aim.target).toBe(null);
    expect(aim.hitPosition.z).toBeCloseTo(-100, 12);
    expect(aim.shootingDirection.toArray()).toEqual([0, 0, -1]);
  });

  test("launch on the hit point: epsilon fallback to aimDirection", () => {
    const aim = resolver.getAimFromAimRay({
      aimOrigin: { x: 0, y: 0, z: 0 },
      aimDirection: { x: 0, y: 0, z: -1 },
      launchPosition: { x: 0, y: 0, z: -8 }, // exactly the sphere hit point
      targets: [drone],
    });
    expect(aim.launchDistanceToHit).toBeCloseTo(0, 12);
    expect(aim.shootingDirection.toArray()).toEqual([0, 0, -1]);
  });

  test("nearest wins across sources: CollisionWorld box beats farther sphere", () => {
    const world = new CollisionWorld();
    world.addCuboid({
      position: { x: 0, y: 0, z: -5 },
      halfExtents: { x: 1, y: 1, z: 1 },
      tag: "crate",
    });
    const farDrone = { position: { x: 0, y: 0, z: -20 }, radius: 1, tag: "far-drone" };
    const aim = resolver.getAimFromAimRay({
      aimOrigin: { x: 0, y: 0, z: 0 },
      aimDirection: { x: 0, y: 0, z: -1 },
      launchPosition: { x: 0, y: 0, z: 0 },
      world,
      targets: [farDrone],
    });
    expect(aim.hasHit).toBe(true);
    expect(aim.hit!.distance).toBeCloseTo(4, 12); // box near face
    expect(aim.hitPosition.z).toBeCloseTo(-4, 12);
    expect(aim.hit!.tag).toBe("crate");
    expect(aim.target).toBe("crate");

    // and the reverse: a nearer sphere target beats the box
    const nearDrone = { position: { x: 0, y: 0, z: -2 }, radius: 0.5, tag: "near-drone" };
    const aim2 = resolver.getAimFromAimRay({
      aimOrigin: { x: 0, y: 0, z: 0 },
      aimDirection: { x: 0, y: 0, z: -1 },
      launchPosition: { x: 0, y: 0, z: 0 },
      world,
      targets: [nearDrone],
    });
    expect(aim2.hit!.distance).toBeCloseTo(1.5, 12);
    expect(aim2.target).toBe(nearDrone);
  });

  test("zero aim direction throws TypeError", () => {
    expect(() =>
      resolver.getAimFromAimRay({
        aimOrigin: { x: 0, y: 0, z: 0 },
        aimDirection: { x: 0, y: 0, z: 0 },
        launchPosition: { x: 0, y: 0, z: 0 },
      }),
    ).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// CombatPlay
// ---------------------------------------------------------------------------

describe("CombatPlay", () => {
  test("armor absorption, kill + finish events drain in order, reset", () => {
    const play = new CombatPlay({ maxHealth: 100, maxArmor: 100, armorAbsorption: 0.6 });
    play.addPlayer({ playerId: "p1", teamId: "red" });
    play.addPlayer({ playerId: "p2", teamId: "blue", armor: 30 });

    play.damage({ playerId: "p2", amount: 50 }); // ignored before start
    expect(play.getPlayer("p2").health).toBe(100);

    play.startGame();
    expect(play.getCombatState()).toBe(COMBAT_STATES.STARTED);

    play.damage({ playerId: "p2", amount: 50, sourceId: "p1" });
    const p2 = play.getPlayer("p2");
    expect(p2.armor).toBe(0); // min(30, 50 * 0.6) fully consumed
    expect(p2.health).toBe(80); // 50 - 30 absorbed
    expect(play.step()).toEqual([]); // both teams alive, nothing queued

    play.damage({ playerId: "p2", amount: 200, sourceId: "p1", bypassArmor: true });
    expect(play.getPlayer("p2").alive).toBe(false);

    const events = play.step();
    expect(events).toEqual([
      { type: COMBAT_PLAY_EVENTS.PLAYER_KILLED, playerId: "p2", sourceId: "p1" },
      { type: COMBAT_PLAY_EVENTS.COMBAT_FINISHED, winnerTeamId: "red" },
    ]);
    expect(play.winnerTeamId).toBe("red");
    expect(play.getCombatState()).toBe(COMBAT_STATES.FINISHED);
    expect(play.step()).toEqual([]); // drained

    play.reset();
    expect(play.getCombatState()).toBe(COMBAT_STATES.WAITING);
    expect(play.winnerTeamId).toBe(null);
    const p2r = play.getPlayer("p2");
    expect(p2r.health).toBe(100);
    expect(p2r.armor).toBe(0);
    expect(p2r.alive).toBe(true);
  });

  test("heal and addArmor cap at maxima", () => {
    const play = new CombatPlay({ maxHealth: 100, maxArmor: 100, armorAbsorption: 0.6 });
    play.addPlayer({ playerId: "p1", teamId: "red" });
    play.startGame();
    play.damage({ playerId: "p1", amount: 10 });
    expect(play.getPlayer("p1").health).toBe(90);
    play.heal({ playerId: "p1", amount: 50 });
    expect(play.getPlayer("p1").health).toBe(100);
    play.addArmor({ playerId: "p1", amount: 150 });
    expect(play.getPlayer("p1").armor).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// FlightPlay
// ---------------------------------------------------------------------------

describe("FlightPlay", () => {
  const crashHeightAt: CrashHeightFn = (right, forward) => 2 + 0.5 * right - 0.25 * forward;

  test("crashes on terrain contact against the analytic height field", () => {
    const flight = new FlightPlay({ crashHeightAt });
    flight.addPlayer({ playerId: "ace", position: { x: 2, y: 10, z: -4 } });
    flight.startGame();

    // planar (right 2, forward 4) -> crash height 2 + 1 - 1 = 2; y=10 clears it
    expect(flight.step()).toEqual([]);

    flight.movePlayer("ace", { x: 2, y: 1.5, z: -4 });
    expect(flight.step()).toEqual([
      {
        type: FLIGHT_PLAY_EVENTS.PLAYER_HIT_GROUND,
        playerId: "ace",
        position: { x: 2, y: 1.5, z: -4 },
        height: 1.5,
        crashHeight: 2,
      },
    ]);
    expect(flight.getPlayer("ace").finished).toBe(true);
    expect(flight.step()).toEqual([]); // finished players are skipped
  });

  test("exact contact (height == crashHeight) crashes", () => {
    const flight = new FlightPlay({ crashHeightAt });
    flight.addPlayer({ playerId: "b", position: { x: 0, y: 2, z: 0 } }); // crash height 2 at origin
    const events = flight.step();
    expect(events).toHaveLength(1);
    expect(events[0].height).toBe(2);
    expect(events[0].crashHeight).toBe(2);
  });

  test("requires crashHeightAt", () => {
    expect(() => new FlightPlay({ crashHeightAt: undefined as unknown as CrashHeightFn })).toThrow(
      "FlightPlay requires crashHeightAt",
    );
  });
});

// ---------------------------------------------------------------------------
// RaceCheckpointLapPlay
// ---------------------------------------------------------------------------

describe("RaceCheckpointLapPlay", () => {
  const checkpoints = [
    { id: "a", position: { x: 0, y: 0, z: 0 }, radius: 2 },
    { id: "b", position: { x: 10, y: 0, z: 0 }, radius: 2 },
  ];

  test("countdown gates checkpoints; full laps produce finish + standings", () => {
    const race = new RaceCheckpointLapPlay({ checkpoints, lapCount: 2, startingDelaySeconds: 1 });
    race.addPlayer({ playerId: "p1", position: { x: 0, y: 0, z: 0 } }); // parked inside cp a
    race.addPlayer({ playerId: "p2", position: { x: 50, y: 0, z: 0 } });
    race.startGame();
    expect(race.raceState).toBe(RACE_STATES.STARTING);

    // countdown still running: no checkpoint despite standing in it
    expect(race.step(0.4)).toEqual([]);
    expect(race.raceState).toBe(RACE_STATES.STARTING);

    // countdown expires mid-step; the leftover delta starts the race
    const startEvents = race.step(0.6);
    expect(startEvents.map((e) => e.type)).toEqual([
      RACE_CHECKPOINT_LAP_EVENTS.RACE_STARTED,
      RACE_CHECKPOINT_LAP_EVENTS.CHECKPOINT_PASSED,
    ]);
    expect(race.elapsedSeconds).toBe(0); // whole delta consumed by countdown

    race.updatePlayer("p1", { x: 10, y: 0, z: 0 });
    let events = race.step(1);
    expect(events).toEqual([
      {
        type: RACE_CHECKPOINT_LAP_EVENTS.CHECKPOINT_PASSED,
        playerId: "p1",
        checkpointId: "b",
        checkpointIndex: 1,
        lap: 1,
      },
      { type: RACE_CHECKPOINT_LAP_EVENTS.LAP_COMPLETED, playerId: "p1", lap: 1, remainingLaps: 1 },
    ]);

    race.updatePlayer("p1", { x: 0, y: 0, z: 0 });
    events = race.step(1);
    expect(events).toEqual([
      {
        type: RACE_CHECKPOINT_LAP_EVENTS.CHECKPOINT_PASSED,
        playerId: "p1",
        checkpointId: "a",
        checkpointIndex: 0,
        lap: 2,
      },
    ]);
    expect(race.getStandings().map((p) => p.playerId)).toEqual(["p1", "p2"]);

    race.updatePlayer("p1", { x: 10, y: 0, z: 0 });
    events = race.step(1);
    expect(events.map((e) => e.type)).toEqual([
      RACE_CHECKPOINT_LAP_EVENTS.CHECKPOINT_PASSED,
      RACE_CHECKPOINT_LAP_EVENTS.LAP_COMPLETED,
      RACE_CHECKPOINT_LAP_EVENTS.PLAYER_FINISHED,
    ]);
    expect(events[2]).toEqual({
      type: RACE_CHECKPOINT_LAP_EVENTS.PLAYER_FINISHED,
      playerId: "p1",
      finishOrder: 1,
      finishTimeSeconds: 3,
    });
    expect(race.raceState).toBe(RACE_STATES.STARTED); // p2 still racing
    expect(race.getStandings()[0].finished).toBe(true);

    // walk p2 through both laps; the last pass ends the race
    race.updatePlayer("p2", { x: 0, y: 0, z: 0 });
    race.step(1);
    race.updatePlayer("p2", { x: 10, y: 0, z: 0 });
    race.step(1);
    race.updatePlayer("p2", { x: 0, y: 0, z: 0 });
    race.step(1);
    race.updatePlayer("p2", { x: 10, y: 0, z: 0 });
    events = race.step(1);
    expect(events.map((e) => e.type)).toEqual([
      RACE_CHECKPOINT_LAP_EVENTS.CHECKPOINT_PASSED,
      RACE_CHECKPOINT_LAP_EVENTS.LAP_COMPLETED,
      RACE_CHECKPOINT_LAP_EVENTS.PLAYER_FINISHED,
      RACE_CHECKPOINT_LAP_EVENTS.RACE_FINISHED,
    ]);
    expect(events[3]).toEqual({ type: RACE_CHECKPOINT_LAP_EVENTS.RACE_FINISHED, elapsedSeconds: 7 });
    expect(race.raceState).toBe(RACE_STATES.FINISHED);
    expect(race.getStandings().map((p) => p.finishOrder)).toEqual([1, 2]);
    expect(race.snapshot().standings.map((p) => p.playerId)).toEqual(["p1", "p2"]);
  });

  test("no starting delay: RACE_STARTED queues immediately", () => {
    const race = new RaceCheckpointLapPlay({ checkpoints, lapCount: 1 });
    race.addPlayer({ playerId: "q", position: { x: 50, y: 0, z: 0 } });
    race.startGame();
    expect(race.raceState).toBe(RACE_STATES.STARTED);
    expect(race.step(1).map((e) => e.type)).toEqual([RACE_CHECKPOINT_LAP_EVENTS.RACE_STARTED]);
    expect(race.elapsedSeconds).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SnakePlay
// ---------------------------------------------------------------------------

describe("SnakePlay", () => {
  const makePlay = () => new SnakePlay({ minRight: 0, maxRight: 9, minForward: 0, maxForward: 9 });

  test("wall collision kills, dead snakes are skipped afterwards", () => {
    const snake = makePlay();
    snake.addPlayer({
      playerId: "s1",
      segments: [
        { right: 3, forward: 3 },
        { right: 2, forward: 3 },
      ],
    });
    expect(snake.step()).toEqual([]);

    snake.movePlayer({
      playerId: "s1",
      segments: [
        { right: -1, forward: 3 },
        { right: 0, forward: 3 },
      ],
    });
    expect(snake.step()).toEqual([
      {
        type: SNAKE_PLAY_EVENTS.PLAYER_DIED,
        playerId: "s1",
        reason: SNAKE_DEATH_REASONS.WALL,
        cell: { right: -1, forward: 3 },
      },
    ]);
    expect(snake.getPlayerState("s1").alive).toBe(false);
    expect(snake.step()).toEqual([]);
  });

  test("self collision", () => {
    const snake = makePlay();
    snake.addPlayer({
      playerId: "s1",
      segments: [
        { right: 2, forward: 2 },
        { right: 3, forward: 2 },
        { right: 3, forward: 3 },
        { right: 2, forward: 3 },
        { right: 2, forward: 2 }, // tail loops back onto the head
      ],
    });
    expect(snake.step()).toEqual([
      {
        type: SNAKE_PLAY_EVENTS.PLAYER_DIED,
        playerId: "s1",
        reason: SNAKE_DEATH_REASONS.SELF,
        cell: { right: 2, forward: 2 },
      },
    ]);
  });

  test("snake-vs-snake collision reports the snake that was hit", () => {
    const snake = makePlay();
    snake.addPlayer({
      playerId: "a",
      segments: [
        { right: 5, forward: 5 },
        { right: 5, forward: 6 },
      ],
    });
    snake.addPlayer({
      playerId: "b",
      segments: [
        { right: 5, forward: 6 }, // head lands on a's tail
        { right: 6, forward: 6 },
      ],
    });
    expect(snake.step()).toEqual([
      {
        type: SNAKE_PLAY_EVENTS.PLAYER_DIED,
        playerId: "b",
        reason: SNAKE_DEATH_REASONS.SNAKE,
        cell: { right: 5, forward: 6 },
        hitPlayerId: "a",
      },
    ]);
    expect(snake.getPlayerState("a").alive).toBe(true);
  });

  test("item pickup consumes the item and reports growth", () => {
    const snake = makePlay();
    snake.addPlayer({ playerId: "s1", segments: [{ right: 4, forward: 4 }] });
    snake.addItem({ cell: { right: 4, forward: 4 }, growth: 2 });
    expect(() => snake.addItem({ cell: { right: 4, forward: 4 } })).toThrow("item already exists");
    expect(snake.step()).toEqual([
      {
        type: SNAKE_PLAY_EVENTS.ITEM_PICKED_UP,
        playerId: "s1",
        cell: { right: 4, forward: 4 },
        growBy: 2,
      },
    ]);
    expect(snake.getItemState()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WaveSpawnDirector
// ---------------------------------------------------------------------------

describe("WaveSpawnDirector", () => {
  const makeDirector = (seed: number) =>
    new WaveSpawnDirector({
      baseWaveSize: 2,
      growthPerWave: 2,
      maxWaveSize: 10,
      unlockRules: [
        { waveNumber: 2, type: "BRUTE" }, // out of order on purpose: ctor sorts
        { waveNumber: 1, type: "GRUNT" },
      ],
      typeWeights: { GRUNT: 1, BRUTE: (waveNumber) => waveNumber },
      prng: new RandomGenerator(seed),
    });

  test("wave sizes escalate and clamp; unlock rules gate types", () => {
    const dir = makeDirector(11);
    expect(dir.getWaveSize(1)).toBe(2);
    expect(dir.getWaveSize(2)).toBe(4);
    expect(dir.getWaveSize(3)).toBe(6);
    expect(dir.getWaveSize(20)).toBe(10); // clamped at maxWaveSize
    expect(dir.getAvailableTypes(1)).toEqual(["GRUNT"]);
    expect(dir.getAvailableTypes(2)).toEqual(["GRUNT", "BRUTE"]);

    const step1 = dir.step({ activeUnits: 0 });
    expect(step1.spawns).toHaveLength(2);
    expect(step1.spawns.every((s) => s.type === "GRUNT")).toBe(true); // wave 1: only GRUNT
    expect(step1.spawns.map((s) => s.spawnIndex)).toEqual([0, 1]);

    // spawned but still alive: wave stays open, nothing more to plan
    expect(dir.step({ activeUnits: 2 }).spawns).toEqual([]);
    expect(dir.snapshot().waveNumber).toBe(1);
    expect(dir.snapshot().inProgress).toBe(true);

    // field cleared: wave 1 completes, wave 2 auto-starts with 4 spawns
    const step3 = dir.step({ activeUnits: 0 });
    expect(step3.spawns).toHaveLength(4);
    expect(step3.spawns.every((s) => s.waveNumber === 2 && s.spawnCount === 4)).toBe(true);
    expect(step3.spawns.every((s) => s.type === "GRUNT" || s.type === "BRUTE")).toBe(true);
    expect(dir.snapshot()).toEqual({
      waveNumber: 2,
      inProgress: true,
      unitsToSpawn: 4,
      unitsSpawned: 4,
      pending: 0,
      activeUnits: 0,
      lastSpawnedType: step3.spawns[3].type,
    });
  });

  test("maxSpawnsPerStep guards the per-step spawn budget", () => {
    const dir = new WaveSpawnDirector({
      baseWaveSize: 10,
      maxSpawnsPerStep: 3,
      prng: new RandomGenerator(1),
    });
    expect(dir.step({ activeUnits: 0 }).spawns).toHaveLength(3);
    expect(dir.step({ activeUnits: 0 }).spawns).toHaveLength(3);
    expect(dir.snapshot().unitsSpawned).toBe(6);
  });

  test("determinism golden: two fresh instances replay identically", () => {
    const script = [0, 0, 3, 1, 0, 0, 2, 0, 0, 0];
    const run = (seed: number): string => {
      const dir = makeDirector(seed);
      const log: unknown[] = [];
      for (const activeUnits of script) {
        const { spawns } = dir.step({ activeUnits });
        log.push({ spawns, snapshot: dir.snapshot() });
      }
      return JSON.stringify(log);
    };
    expect(run(7)).toBe(run(7));
  });
});

// ---------------------------------------------------------------------------
// ProjectileWeaponSystem
// ---------------------------------------------------------------------------

const bodyFrame = (): WeaponBodyFrame => ({
  right: new Vector3(1, 0, 0),
  up: new Vector3(0, 1, 0),
  forward: new Vector3(0, 0, -1),
});

const ORIGIN = { x: 0, y: 0, z: 0 };

describe("ProjectileWeaponSystem", () => {
  test("gun lifecycle: fire, cooldown, overheat, recovery, empty warning", () => {
    const clock = new Clock({ manual: true, nowMs: 0 });
    const sys = new ProjectileWeaponSystem({
      aimMode: WEAPON_AIM_MODES.BORESIGHT,
      gunHeatPerShot: 0.5,
      gunOverheatThreshold: 1.0,
      gunCoolRatePerSecond: 0.2,
      gunRecoveredThreshold: 0.3,
      clock,
    });
    sys.updateWeaponConfig(WEAPON_TYPES.GUN, {
      ammo: 3,
      maxAmmo: 3,
      fireRate: 0.1,
      speed: 50,
      launchOffset: { forward: 1 },
    });
    const fire = () => sys.requestFire({ shooterPosition: ORIGIN, shooterBodyFrame: bodyFrame() })!;

    // t=0: first shot flies boresight from the muzzle offset
    const d1 = fire();
    if (d1.type !== WEAPON_DECISIONS.FIRE_GUN) throw new Error(`expected fire-gun, got ${d1.type}`);
    expect(d1.position.toArray()).toEqual([0, 0, -1]);
    expect(d1.direction.toArray()).toEqual([0, 0, -1]);
    expect(d1.speed).toBe(50);
    expect(d1.overheated).toBe(false);
    expect(sys.gunHeat).toBeCloseTo(0.5, 12);

    // same instant: cooldown block
    expect(fire()).toMatchObject({ type: WEAPON_DECISIONS.BLOCKED, message: "Weapon cooldown" });

    // t=0.2: second shot pushes heat to the overheat threshold
    clock.advanceMs(200);
    const d2 = fire();
    if (d2.type !== WEAPON_DECISIONS.FIRE_GUN) throw new Error(`expected fire-gun, got ${d2.type}`);
    expect(d2.overheated).toBe(true);
    expect(sys.isGunOverheated).toBe(true);

    clock.advanceMs(200);
    expect(fire()).toMatchObject({ type: WEAPON_DECISIONS.BLOCKED, message: "Weapon overheated" });

    // cool 3.6s: heat 1.0 - 0.72 = 0.28 < recovered threshold 0.3
    sys.step({ shooterPosition: ORIGIN, shooterBodyFrame: bodyFrame(), deltaSeconds: 3.6 });
    expect(sys.gunHeat).toBeCloseTo(0.28, 12);
    expect(sys.isGunOverheated).toBe(false);

    // last round
    const d3 = fire();
    expect(d3.type).toBe(WEAPON_DECISIONS.FIRE_GUN);
    expect(sys.weapons.get(WEAPON_TYPES.GUN)!.ammo).toBe(0);

    // empty: warning only outside the warning cooldown window
    clock.setMs(1000); // 1s - 0s <= 2s window since construction
    expect(fire()).toMatchObject({ type: WEAPON_DECISIONS.BLOCKED, message: "Weapon empty" });
    clock.setMs(3000);
    expect(fire()).toEqual({ type: WEAPON_DECISIONS.EMPTY_WARNING, weaponId: WEAPON_TYPES.GUN });
    expect(sys.emptyWarningTimers[WEAPON_TYPES.GUN]).toBe(1);
    clock.setMs(4000);
    expect(fire()).toMatchObject({ type: WEAPON_DECISIONS.BLOCKED, message: "Weapon empty" });
  });

  test("missile lock-on: acquisition, LOCKING to LOCKED, fire, lock loss", () => {
    const clock = new Clock({ manual: true, nowMs: 0 });
    const sys = new ProjectileWeaponSystem({
      aimMode: WEAPON_AIM_MODES.BORESIGHT,
      lockRequiredSeconds: 1,
      clock,
    });
    sys.updateWeaponConfig(WEAPON_TYPES.MISSILE, { ammo: 2, maxAmmo: 2, fireRate: 1, speed: 30 });
    sys.selectWeapon(WEAPON_TYPES.MISSILE);

    const onAxis = { position: { x: 0, y: 0, z: -100 } };
    const behind = { position: { x: 0, y: 0, z: 100 } }; // dot -1, filtered
    const offAxis = { position: { x: 100, y: 0, z: -100 } }; // dot ~0.707 < 0.94
    const stepArgs = (deltaSeconds: number) => ({
      shooterPosition: ORIGIN,
      shooterBodyFrame: bodyFrame(),
      targets: [behind, offAxis, onAxis],
      deltaSeconds,
    });

    expect(sys.requestFire({ shooterPosition: ORIGIN, shooterBodyFrame: bodyFrame() })).toMatchObject({
      type: WEAPON_DECISIONS.BLOCKED,
      message: "Missile needs lock",
    });

    sys.step(stepArgs(0.5)); // acquisition frame: lockTime starts at 0
    expect(sys.lockStatus).toBe(MISSILE_LOCK_STATUS.LOCKING);
    expect(sys.lockingTarget).toBe(onAxis);
    sys.step(stepArgs(0.5)); // 0.5s < 1s
    expect(sys.lockStatus).toBe(MISSILE_LOCK_STATUS.LOCKING);
    sys.step(stepArgs(0.5)); // 1.0s >= 1s
    expect(sys.lockStatus).toBe(MISSILE_LOCK_STATUS.LOCKED);
    expect(sys.target).toBe(onAxis);

    const d = sys.requestFire({ shooterPosition: ORIGIN, shooterBodyFrame: bodyFrame() })!;
    if (d.type !== WEAPON_DECISIONS.FIRE_MISSILE) throw new Error(`expected fire-missile, got ${d.type}`);
    expect(d.target).toBe(onAxis);
    expect(d.speed).toBe(30);
    expect(sys.weapons.get(WEAPON_TYPES.MISSILE)!.ammo).toBe(1);

    // target gone: lock resets
    sys.step({ ...stepArgs(0.5), targets: [] });
    expect(sys.lockStatus).toBe(MISSILE_LOCK_STATUS.NONE);
    expect(sys.target).toBe(null);
  });

  test("crosshair mode: fire direction points from muzzle to aimPosition", () => {
    const clock = new Clock({ manual: true, nowMs: 0 });
    const sys = new ProjectileWeaponSystem({ aimMode: WEAPON_AIM_MODES.CROSSHAIR, clock });
    sys.updateWeaponConfig(WEAPON_TYPES.GUN, {
      ammo: 1,
      maxAmmo: 1,
      fireRate: 0.05,
      speed: 10,
      launchOffset: { forward: 1 },
    });

    expect(() => sys.requestFire({ shooterPosition: ORIGIN, shooterBodyFrame: bodyFrame() })).toThrow(TypeError);

    const d = sys.requestFire({
      shooterPosition: ORIGIN,
      shooterBodyFrame: bodyFrame(),
      aimPosition: { x: 3, y: 0, z: -1 },
    })!;
    if (d.type !== WEAPON_DECISIONS.FIRE_GUN) throw new Error(`expected fire-gun, got ${d.type}`);
    expect(d.position.toArray()).toEqual([0, 0, -1]); // muzzle 1 forward
    expect(d.direction.toArray()).toEqual([1, 0, 0]); // toward aimPosition from muzzle
  });

  test("getLaunchPosition applies body-frame offsets", () => {
    const sys = new ProjectileWeaponSystem({ clock: new Clock({ manual: true }) });
    sys.updateWeaponConfig(WEAPON_TYPES.GUN, {
      ammo: 1,
      maxAmmo: 1,
      fireRate: 1,
      launchOffset: { right: 0.5, up: -0.2, forward: 1 },
    });
    const p = sys.getLaunchPosition({ x: 1, y: 2, z: 3 }, bodyFrame()) as Vector3;
    expect(p.x).toBeCloseTo(1.5, 12);
    expect(p.y).toBeCloseTo(1.8, 12);
    expect(p.z).toBeCloseTo(2, 12);
  });
});

// ---------------------------------------------------------------------------
// ProjectileManager
// ---------------------------------------------------------------------------

interface FakeProjectile extends ProjectileLike {
  disposed: boolean;
  position: Vector3;
}

/** Minimal ProjectileObject-shaped double: linear motion + sphere hit test. */
function linearFake(config: ProjectileSpawnConfig): FakeProjectile {
  const position = toVec3(config.position);
  const velocity = toVec3(config.direction).normalize().multiplyScalar(config.speed);
  let age = 0;
  return {
    active: true,
    disposed: false,
    position,
    step(targets: ProjectileTargetLike[], deltaSeconds: number) {
      age += deltaSeconds;
      position.addScaledVector(velocity, deltaSeconds);
      let hitted: ProjectileTargetLike | null = null;
      for (const target of targets) {
        if (target.destroyed) continue;
        if (position.distanceTo(toVec3(target.position)) <= config.hitRadius) {
          hitted = target;
          break;
        }
      }
      if (hitted) this.active = false;
      if (this.active && age >= config.lifetimeSeconds) this.active = false;
      return { position, target: null, hittedTarget: hitted };
    },
    dispose() {
      this.disposed = true;
    },
  };
}

describe("ProjectileManager", () => {
  test("spawn requires a visual with group", () => {
    const manager = new ProjectileManager({ createProjectile: linearFake });
    expect(() =>
      manager.spawnProjectile({
        visual: {} as ProjectileVisualLike,
        position: ORIGIN,
        direction: { x: 0, y: 0, z: -1 },
        speed: 1,
        lifetimeSeconds: 1,
        hitRadius: 0.5,
      }),
    ).toThrow("projectile visual with group is required");
  });

  test("steps projectiles, reports hits with metadata, reaps inactive ones", () => {
    const manager = new ProjectileManager({ createProjectile: linearFake });
    const bullet = manager.spawnProjectile({
      visual: { group: {} },
      metadata: { shooter: "p1" },
      position: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: -1 },
      speed: 10,
      lifetimeSeconds: 5,
      hitRadius: 0.5,
    }) as FakeProjectile;
    const drifter = manager.spawnProjectile({
      visual: { group: {} },
      position: { x: 100, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      speed: 1,
      lifetimeSeconds: 0.2,
      hitRadius: 0.5,
    }) as FakeProjectile;
    const targetObj = { position: { x: 0, y: 0, z: -2 } };

    // 0.1s: bullet reaches z=-1, no contact yet
    expect(manager.step([targetObj], 0.1)).toEqual([]);
    expect(bullet.position.z).toBeCloseTo(-1, 12);
    expect(manager.projectiles).toHaveLength(2);

    // 0.1s more: bullet touches the target; drifter expires by lifetime
    const events = manager.step([targetObj], 0.1);
    expect(events).toHaveLength(1);
    expect(events[0].projectile).toBe(bullet);
    expect(events[0].hittedTarget).toBe(targetObj);
    expect(events[0].metadata).toEqual({ shooter: "p1" });
    expect(manager.projectiles).toHaveLength(0);
    expect(bullet.disposed).toBe(true);
    expect(drifter.disposed).toBe(true);

    // no metadata -> null in the hit event
    manager.spawnProjectile({
      visual: { group: {} },
      position: { x: 0, y: 0, z: -1.6 },
      direction: { x: 0, y: 0, z: -1 },
      speed: 1,
      lifetimeSeconds: 5,
      hitRadius: 0.5,
    });
    const events2 = manager.step([targetObj], 0.1);
    expect(events2).toHaveLength(1);
    expect(events2[0].metadata).toBe(null);
  });

  test("clear disposes everything and empties the pool", () => {
    const manager = new ProjectileManager({ createProjectile: linearFake });
    const p = manager.spawnProjectile({
      visual: { group: {} },
      metadata: "m",
      position: ORIGIN,
      direction: { x: 1, y: 0, z: 0 },
      speed: 1,
      lifetimeSeconds: 10,
      hitRadius: 0.1,
    }) as FakeProjectile;
    manager.clear();
    expect(p.disposed).toBe(true);
    expect(manager.projectiles).toEqual([]);
    expect(manager.projectileMetadata.size).toBe(0);
  });
});
