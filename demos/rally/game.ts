// demos/rally/game.ts — the rally sim: a closed checkpoint circuit composed
// entirely from playset modules, on either of two interchangeable cores.
//
// TWO PATHS, ONE GAME. The scene, the environment and the car visuals are
// built the same way regardless; only the per-step sim differs:
//
//   TS core (always available)   the playset modules, f64, ~160k interpreter
//                               ops per step. THE REFERENCE IMPLEMENTATION:
//                               the deterministic goldens pin this path.
//   native core (`ps` present)   pocket-playset, f32, the same blocks in Rust.
//                               A whole step — plan, resolve, commit, race,
//                               visuals, camera — costs one op call, and the
//                               chassis/wheel poses never become JS values.
//
// WHY: measured on a real PSP, QuickJS runs at ~1.7µs/op, so 60 Hz affords
// ~8k ops. The TS step needs twenty times that. On hosts with `ps` the game
// runs at frame rate; everywhere else it runs exactly as it always has.
// Graceful absence is the same contract `s3` follows (playset/sim/ops.ts).
//
// The two cores are trajectory-equivalent, not bit-equivalent (f32 vs f64), so
// they are NOT interchangeable inside one golden — see playset/sim/ops.ts.
//
// Everything here is deterministic fixed-step state (DETERMINISM.md): the only
// inputs are the per-step button mask and FIXED_DT — no wall clock, no
// Math.random (one seeded RandomGenerator drives the environment's prop
// placement). The composition under test:
//
//   RoadTerrainSampler + RaceTrackEnvironment  road-flattened terrain, gates,
//                                              barrier fences → colliders
//   ArcadeCarMotionController ×2               player (buttons) + AI rival
//   KinematicBatchResolver                     both cars vs barriers/props and
//                                              each other (planar push-out)
//   WaypointProgressTracker → AgentPathNavigator → WaypointDriver
//                                              the rival's driving brain
//   RaceCheckpointLapPlay                      2-lap race state + standings
//   CarVisualFactory + CarModelController      chassis pose, wheel spin/steer
//   PoseFollowCameraRig                        chase camera on the player
//
// A tiny debug probe rides on globalThis.__rallyProbe so the headless E2E
// (playset/test/rally-sim.test.ts) can assert progress without scraping HUD
// pixels. Both paths keep it fed.

import { BTN } from "@pocketjs/framework/input";
import { Euler, Vector3 } from "../../playset/math/index.ts";
import { Scene3D } from "../../playset/scene3d/client.ts";
import type { GameInput } from "../../playset/loop.ts";
import { ColliderSink } from "../../playset/sim/collider-sink.ts";
import { detectSim, HUD, HUD_FLOATS, type SimOps } from "../../playset/sim/ops.ts";
import { RandomGenerator } from "../../playset/modules/math/random-utils.ts";
import { CollisionWorld } from "../../playset/modules/physics/collision-world.ts";
import { rgbToAbgr } from "../../playset/modules/world/color-utils.ts";
import type { PlanarPoint } from "../../playset/modules/world/environment/planar-utils.ts";
import { RaceTrackEnvironment } from "../../playset/modules/world/environment/race-track-environment.ts";
import type { TerrainGrid } from "../../playset/modules/world/environment/terrain-mesh-factory.ts";
import {
  createCarVisual,
  type CarVisual,
} from "../../playset/modules/world/object/factory/car-visual-factory.ts";
import {
  ArcadeCarMotionController,
  type ArcadeCarCommitResult,
  type ArcadeCarIntent,
} from "../../playset/modules/actor-motion/ground-vehicle/arcade-car-motion-controller.ts";
import { CarModelController } from "../../playset/modules/actor-motion/ground-vehicle/car-model-controller.ts";
import {
  KinematicBatchResolver,
  type KinematicActor,
} from "../../playset/modules/actor-motion/kinematic-batch-resolver.ts";
import { WaypointProgressTracker } from "../../playset/modules/behavior/waypoint-progress-tracker.ts";
import { WaypointDriver } from "../../playset/modules/behavior/waypoint-driver.ts";
import { AgentPathNavigator } from "../../playset/modules/behavior/agent-path-navigator.ts";
import {
  RACE_CHECKPOINT_LAP_EVENTS,
  RACE_STATES,
  RaceCheckpointLapPlay,
} from "../../playset/modules/gameplay/race-checkpoint-lap-play.ts";
import { PoseFollowCameraRig } from "../../playset/modules/camera/pose-follow-camera-rig.ts";

export const LAP_COUNT = 2;
export const PLAYER_ID = "player";
export const RIVAL_ID = "rival";

/** A rounded 10-point circuit (planar right/forward, ~100×110 units). */
export const TRACK_POINTS: readonly PlanarPoint[] = [
  { right: -30, forward: -46 },
  { right: 0, forward: -54 },
  { right: 30, forward: -46 },
  { right: 46, forward: -18 },
  { right: 46, forward: 18 },
  { right: 30, forward: 46 },
  { right: 0, forward: 54 },
  { right: -30, forward: 46 },
  { right: -46, forward: 18 },
  { right: -46, forward: -18 },
];

/** Planar bounds for the HUD minimap (track extent + barrier margin). */
export const TRACK_BOUNDS = Object.freeze({
  minRight: -62,
  maxRight: 62,
  minForward: -62,
  maxForward: 62,
});

const CAR_RIDE_HEIGHT = 0.38; // ArcadeCarMotionController default rideHeight
const WHEEL_RADIUS = 0.35;

/** GameBlocks' defaults are scaled for ~500-unit tracks; this circuit is
 *  ~100 units across, so both cars run a gentler, more agile tune (top speed
 *  throttleAccel/engineBrake ≈ 14.5 u/s, short wheelbase). */
const CAR_TUNING = {
  maxForwardSpeed: 22,
  maxReverseSpeed: 10,
  throttleAccel: 16,
  reverseAccel: 10,
  engineBrake: 1.1,
  steerAngleMax: 0.6,
  wheelBase: 2.6,
  rideHeight: CAR_RIDE_HEIGHT,
} as const;

/** ArcadeCarMotionController defaults for the fields CAR_TUNING omits. */
const STEER_LAG = 0.09;
const BOOST_MULTIPLIER = 1.35;

const RIVAL_BRAIN = {
  reachDistance: 6,
  closed: 1,
  maxSpeed: 14,
  arriveRadius: 10,
  targetSpeed: 14,
  minSpeed: 5,
  cornerSlowdown: 8,
} as const;

const CAMERA_RIG = {
  cameraOffset: { forward: -7.5, up: 3.4, right: 0 },
  lookAtOffset: { forward: 5, up: 1.1, right: 0 },
  speedCameraOffset: { forward: -0.03, up: 0.01, right: 0 },
  positionLag: 0.16,
  lookLag: 0.1,
} as const;

const CAR_HALF_EXTENTS = { x: 0.9, y: CAR_RIDE_HEIGHT, z: 1.5 } as const;

export interface RallyProbe {
  /** scene3d handle of the game's one scene (0 in pure-mirror mode). */
  sceneId: number;
  /** Chassis group node ids — the test reads their serialized poses. */
  playerNodeId: number;
  rivalNodeId: number;
  steps: number;
  /** Total checkpoint.passed events across both cars. */
  checkpointsPassed: number;
  playerCheckpoints: number;
  playerLaps: number;
  raceState: string;
  playerPosition: { x: number; y: number; z: number };
  /** Player tangent speed, UNROUNDED (the HUD's `speed` is rounded for stable
   *  text). The trajectory-parity fixture generator reads it from here —
   *  comparing two cores through a `Math.round` would hide a 3% drift. */
  playerSpeed: number;
}

export interface RallyHudState {
  raceState: string;
  /** Player display lap (1-based, clamped to LAP_COUNT). */
  lap: number;
  /** Player tangent speed, rounded for stable HUD text. */
  speed: number;
  /** Standings labels, leader first. */
  standings: string[];
  nextCheckpointIndex: number;
  playerPosition: { x: number; y: number; z: number };
  playerForward: { x: number; y: number; z: number };
  rivalPosition: { x: number; y: number; z: number };
  /** RIVAL_ID when the rival leads (minimap leader ring), else null. */
  leaderId: string | null;
  checkpointsPassed: number;
}

export interface RallyGame {
  scene: Scene3D;
  /** Static checkpoint centers for the minimap. */
  checkpoints: { x: number; y: number; z: number }[];
  /** Which core is running — "ts" or the native host label. */
  core: string;
  /** One fixed 1/60 s simulation step (createGameLoop's `step`). */
  step(dt: number, input: GameInput): void;
  /**
   * The HUD snapshot for this instant.
   *
   * BORROWED, NOT OWNED: both cores refill and return the SAME object (and the
   * same nested vectors and standings array) on every call. Read what you need
   * and copy it out before the next call — demos/rally/app.tsx drains it into
   * signals on the spot. The old version handed back six fresh objects ten
   * times a second, which on the PSP made this the guest's allocation hot spot
   * and put QuickJS's collector inside the HUD window.
   */
  hudState(): RallyHudState;
}

/** Refill a borrowed hudState() vector slot. */
function setVec(into: { x: number; y: number; z: number }, x: number, y: number, z: number): void {
  into.x = x;
  into.y = y;
  into.z = z;
}

/** The reusable RallyHudState both cores hand out (see RallyGame.hudState). */
function createHudSnapshot(): RallyHudState {
  return {
    raceState: RACE_STATES.STARTED,
    lap: 1,
    speed: 0,
    standings: ["YOU", "RIVAL"],
    nextCheckpointIndex: 0,
    playerPosition: { x: 0, y: 0, z: 0 },
    playerForward: { x: 0, y: 0, z: 0 },
    rivalPosition: { x: 0, y: 0, z: 0 },
    leaderId: null,
    checkpointsPassed: 0,
  };
}

interface RallyCar {
  motion: ArcadeCarMotionController;
  actor: KinematicActor;
  visual: CarVisual;
  model: CarModelController;
  /** Euler mirrors the CarModelController writes; step() folds them into
   *  the SceneNode quaternions (scene3d nodes carry no Euler rotation). */
  wheelMirrors: { rotation: { x: number; y: number } }[];
  pivotMirrors: { rotation: { x: number; y: number } }[];
  speed: number;
}

function vec(v: Vector3): { x: number; y: number; z: number } {
  return { x: v.x, y: v.y, z: v.z };
}

// ---------------------------------------------------------------------------
// shared build: scene, environment, car visuals, spawn poses
// ---------------------------------------------------------------------------

interface BuiltWorld {
  scene: Scene3D;
  env: ReturnType<RaceTrackEnvironment["create"]>;
  playerVisual: CarVisual;
  rivalVisual: CarVisual;
  playerSpawn: { position: Vector3; yaw: number };
  rivalSpawn: { position: Vector3; yaw: number };
  /** Colliders recorded during the build (used by the native path). */
  sink: ColliderSink;
  /** Live TS collision world (used by the TS path). */
  world: CollisionWorld;
  /** The drawn terrain's height grid (used by the native path). */
  grid: TerrainGrid | null;
}

function buildWorld(): BuiltWorld {
  const scene = new Scene3D();
  const world = new CollisionWorld();
  const sink = new ColliderSink();

  // The height grid the terrain MESH is tessellated from. The native sim
  // samples exactly this rather than re-deriving heights, so the car drives on
  // the surface that is actually drawn (playset/sim/ops.ts terrainHeightfield).
  let grid: TerrainGrid | null = null;

  const env = new RaceTrackEnvironment({
    scene,
    trackPlanarPoints: [...TRACK_POINTS],
    naturalEnvironmentConfig: {
      onTerrainGrid: (g) => {
        grid = g;
      },
      terrainSize: 150,
      terrainSegments: 48,
      // Six-by-six ground patches: on a host that frustum-culls, this one mesh
      // went from 4,608 always-drawn triangles to only the patches actually in
      // view. Measured on real PSP — it was 72% of everything still reaching
      // the GE after the props were being culled.
      terrainTiles: 6,
      treeCount: 18,
      rockCount: 6,
      grassBladeCount: 24,
      renderOrder: 0,
      prng: new RandomGenerator(42),
    },
  }).create();

  // Colliders are recorded ONCE and replayed into whichever core runs: the
  // sink first (it is a pure recorder), then the TS world. Both see the same
  // insertion order, which is the determinism anchor on either path.
  env.createColliders(sink.asWorld());
  env.createColliders(world);

  scene.sun(new Vector3(-0.45, -1, -0.35), rgbToAbgr(0xfff1d6));
  scene.ambient(rgbToAbgr(0x9db8d6), rgbToAbgr(0x55624a));
  scene.sky(rgbToAbgr(0x6fa8e4), rgbToAbgr(0xd9e8f2));
  scene.fog(rgbToAbgr(0xcfe0ee), 70, 190);
  scene.camera.zfar = 400;

  // Everything built so far is settled scenery (terrain, trees, gates,
  // fences); the per-frame pose differ drops it after one flush. The cars are
  // created AFTER this line precisely so they stay dynamic.
  scene.markStatic();

  const playerVisual = createCarVisual(scene, { paintColor: 0xc75238, cabinColor: 0xf4f7ff });
  const rivalVisual = createCarVisual(scene, { paintColor: 0x3878c7, cabinColor: 0xe8f0ff });
  const playerSpawn = env.spawnPose(0, true, 12, 2.4, CAR_RIDE_HEIGHT);
  const rivalSpawn = env.spawnPose(0, true, 17, -2.4, CAR_RIDE_HEIGHT);
  playerVisual.group.position.copy(playerSpawn.position);
  rivalVisual.group.position.copy(rivalSpawn.position);

  return { scene, env, playerVisual, rivalVisual, playerSpawn, rivalSpawn, sink, world, grid };
}

function makeProbe(built: BuiltWorld): RallyProbe {
  const probe: RallyProbe = {
    sceneId: built.scene.__scene,
    playerNodeId: built.playerVisual.group.__id,
    rivalNodeId: built.rivalVisual.group.__id,
    steps: 0,
    checkpointsPassed: 0,
    playerCheckpoints: 0,
    playerLaps: 0,
    raceState: RACE_STATES.STARTED,
    playerPosition: vec(built.playerSpawn.position),
    playerSpeed: 0,
  };
  (globalThis as Record<string, unknown>).__rallyProbe = probe;
  return probe;
}

export function createRallyGame(): RallyGame {
  const built = buildWorld();
  const sim = detectSim();
  return sim ? createNativeRally(built, sim) : createTsRally(built);
}

// ---------------------------------------------------------------------------
// native core — pocket-playset behind `ps`
// ---------------------------------------------------------------------------

function createNativeRally(built: BuiltWorld, ps: SimOps): RallyGame {
  const { scene, env, playerVisual, rivalVisual, sink, grid } = built;
  const probe = makeProbe(built);
  const world = ps.worldCreate(scene.__scene);

  // Terrain: hand over the grid the mesh was built from. Re-deriving the
  // procedural heights natively would put the car on a DIFFERENT surface than
  // the one on screen — the samplers hash through `sin`, which is not the same
  // function in f32 as in f64 (playset/sim/ops.ts terrainHeightfield).
  if (grid) {
    ps.terrainHeightfield(world, grid.size, grid.side, grid.heights);
  }

  ps.collidersAdd(world, sink.toKinds(), sink.toData(), sink.count);

  const tuning = Float32Array.of(
    CAR_TUNING.maxForwardSpeed,
    CAR_TUNING.maxReverseSpeed,
    CAR_TUNING.throttleAccel,
    CAR_TUNING.reverseAccel,
    CAR_TUNING.engineBrake,
    STEER_LAG,
    CAR_TUNING.steerAngleMax,
    CAR_TUNING.wheelBase,
    CAR_TUNING.rideHeight,
    BOOST_MULTIPLIER,
  );

  function addCar(visual: CarVisual, spawn: { position: Vector3; yaw: number }): number {
    const car = ps.carCreate(world, tuning);
    ps.carReset(world, car, spawn.position.x, spawn.position.y, spawn.position.z, spawn.yaw);
    ps.carBindVisual(
      world,
      car,
      visual.group.__id,
      Int32Array.from(visual.wheels, (n) => n.__id),
      Int32Array.from(visual.wheelPivots, (n) => n.__id),
      WHEEL_RADIUS,
    );
    ps.carActor(world, car, CAR_HALF_EXTENTS.x, CAR_HALF_EXTENTS.y, CAR_HALF_EXTENTS.z);
    return car;
  }

  // Player first: `readHud` reports the first brainless car as the player and
  // the first brained one as the rival.
  const playerCar = addCar(playerVisual, built.playerSpawn);
  const rivalCar = addCar(rivalVisual, built.rivalSpawn);

  const waypoints: number[] = [];
  for (const c of env.checkpoints) waypoints.push(c.position.x, c.position.y, c.position.z);
  ps.carBrain(
    world,
    rivalCar,
    Float32Array.from(waypoints),
    env.checkpoints.length,
    Float32Array.of(
      RIVAL_BRAIN.reachDistance,
      RIVAL_BRAIN.closed,
      RIVAL_BRAIN.maxSpeed,
      RIVAL_BRAIN.arriveRadius,
      RIVAL_BRAIN.targetSpeed,
      RIVAL_BRAIN.minSpeed,
      RIVAL_BRAIN.cornerSlowdown,
    ),
  );

  const gates: number[] = [];
  for (const c of env.checkpoints) {
    gates.push(c.position.x, c.position.y, c.position.z, c.radius);
  }
  ps.raceInit(world, Float32Array.from(gates), env.checkpoints.length, LAP_COUNT);

  ps.cameraRig(
    world,
    playerCar,
    Float32Array.of(
      CAMERA_RIG.cameraOffset.right,
      CAMERA_RIG.cameraOffset.up,
      CAMERA_RIG.cameraOffset.forward,
      CAMERA_RIG.lookAtOffset.right,
      CAMERA_RIG.lookAtOffset.up,
      CAMERA_RIG.lookAtOffset.forward,
      CAMERA_RIG.speedCameraOffset.right,
      CAMERA_RIG.speedCameraOffset.up,
      CAMERA_RIG.speedCameraOffset.forward,
      CAMERA_RIG.positionLag,
      CAMERA_RIG.lookLag,
    ),
  );

  // Ownership handover: from here the SIM writes the car chassis and wheel
  // poses straight into the scene3d store, so the guest will never touch
  // those mirrors again. Marking them static says exactly that, and drops
  // them from the per-frame flush walk — after the initial poses land (which
  // is also where the sim reads the wheels' parent-local offsets from), the
  // guest's flush has nothing left to diff at all.
  scene.markStatic();

  // One reused mirror buffer — the guest's whole per-frame read.
  const hud = new Float32Array(HUD_FLOATS);
  const STATES = [RACE_STATES.WAITING, RACE_STATES.STARTED, RACE_STATES.FINISHED];

  function step(dt: number, input: GameInput): void {
    ps.step(world, dt, input.buttons);
    probe.steps += 1;
  }

  // Refilled in place, never reallocated — the borrowed-snapshot contract on
  // RallyGame.hudState. The probe keeps its own vector for the same reason the
  // snapshot does: nobody here should be minting objects at 10 Hz.
  const snapshot = createHudSnapshot();
  const probePosition = { x: 0, y: 0, z: 0 };
  probe.playerPosition = probePosition;

  function hudState(): RallyHudState {
    ps.readHud(world, hud);
    const laps = hud[HUD.laps];
    const rivalLeads = hud[HUD.rivalLeads] !== 0;
    probe.checkpointsPassed = hud[HUD.gates];
    probe.playerLaps = laps;
    probe.raceState = STATES[hud[HUD.state]] ?? RACE_STATES.STARTED;
    setVec(probePosition, hud[HUD.playerX], hud[HUD.playerY], hud[HUD.playerZ]);
    probe.playerSpeed = hud[HUD.speed];

    snapshot.raceState = probe.raceState;
    snapshot.lap = Math.min(laps + 1, LAP_COUNT);
    snapshot.speed = Math.round(hud[HUD.speed]);
    snapshot.standings[0] = rivalLeads ? "RIVAL" : "YOU";
    snapshot.standings[1] = rivalLeads ? "YOU" : "RIVAL";
    snapshot.nextCheckpointIndex = hud[HUD.nextCheckpoint];
    setVec(snapshot.playerPosition, hud[HUD.playerX], hud[HUD.playerY], hud[HUD.playerZ]);
    setVec(
      snapshot.playerForward,
      hud[HUD.playerForwardX],
      hud[HUD.playerForwardY],
      hud[HUD.playerForwardZ],
    );
    setVec(snapshot.rivalPosition, hud[HUD.rivalX], hud[HUD.rivalY], hud[HUD.rivalZ]);
    snapshot.leaderId = rivalLeads ? RIVAL_ID : null;
    snapshot.checkpointsPassed = probe.checkpointsPassed;
    return snapshot;
  }

  return {
    scene,
    checkpoints: env.checkpoints.map((c) => vec(c.position)),
    core: ps.__host ?? "native",
    step,
    hudState,
  };
}

// ---------------------------------------------------------------------------
// TS core — the playset modules (the reference implementation)
// ---------------------------------------------------------------------------

function createTsRally(built: BuiltWorld): RallyGame {
  const { scene, env, world } = built;
  const probe = makeProbe(built);
  const resolver = new KinematicBatchResolver(world);

  function buildCar(visual: CarVisual, spawn: { position: Vector3; yaw: number }): RallyCar {
    const motion = new ArcadeCarMotionController({ ...CAR_TUNING });
    motion.reset(spawn.position, spawn.yaw);
    const wheelMirrors = visual.wheels.map(() => ({ rotation: { x: 0, y: 0 } }));
    const pivotMirrors = visual.wheelPivots.map(() => ({ rotation: { x: 0, y: 0 } }));
    return {
      motion,
      visual,
      model: new CarModelController({
        vehicleModel: visual.group,
        wheels: wheelMirrors,
        wheelPivots: pivotMirrors,
        wheelRadius: WHEEL_RADIUS,
      }),
      actor: resolver.createActor({
        position: spawn.position,
        colliderShape: {
          type: "cuboid",
          halfX: CAR_HALF_EXTENTS.x,
          halfY: CAR_HALF_EXTENTS.y,
          halfZ: CAR_HALF_EXTENTS.z,
        },
      }),
      wheelMirrors,
      pivotMirrors,
      speed: 0,
    };
  }

  const player = buildCar(built.playerVisual, built.playerSpawn);
  const rival = buildCar(built.rivalVisual, built.rivalSpawn);

  // -- race state ----------------------------------------------------------------
  const race = new RaceCheckpointLapPlay({
    checkpoints: env.checkpoints.map((c) => ({
      id: c.id,
      position: vec(c.position),
      radius: c.radius,
    })),
    lapCount: LAP_COUNT,
  });
  race.addPlayer({ playerId: PLAYER_ID, position: vec(player.motion.position) });
  race.addPlayer({ playerId: RIVAL_ID, position: vec(rival.motion.position) });
  race.startGame();

  // -- the rival's driving brain ---------------------------------------------------
  const tracker = new WaypointProgressTracker({
    waypoints: env.checkpoints.map((c) => c.position),
    reachDistance: RIVAL_BRAIN.reachDistance,
    closed: true,
  });
  tracker.reset(0);
  const driver = new WaypointDriver({
    targetSpeed: RIVAL_BRAIN.targetSpeed,
    minSpeed: RIVAL_BRAIN.minSpeed,
    cornerSlowdown: RIVAL_BRAIN.cornerSlowdown,
  });
  const navigator = new AgentPathNavigator({
    maxSpeed: RIVAL_BRAIN.maxSpeed,
    arriveRadius: RIVAL_BRAIN.arriveRadius,
  });

  // -- chase camera -------------------------------------------------------------------
  const cameraRig = new PoseFollowCameraRig({ ...CAMERA_RIG });

  // -- fixed step ------------------------------------------------------------------------------
  const eulerScratch = new Euler();

  function syncCarVisual(car: RallyCar, res: ArcadeCarCommitResult, dt: number): void {
    car.model.step({
      position: res.position,
      bodyFrame: res.bodyFrame,
      velocity: res.velocity,
      steeringAngle: res.steeringAngle,
      deltaSeconds: dt,
    });
    for (let i = 0; i < car.visual.wheels.length; i += 1) {
      const wheel = car.wheelMirrors[i].rotation;
      car.visual.wheels[i].quaternion.setFromEuler(eulerScratch.set(wheel.x, wheel.y, 0));
      car.visual.wheelPivots[i].quaternion.setFromEuler(
        eulerScratch.set(0, car.pivotMirrors[i].rotation.y, 0),
      );
    }
  }

  function step(dt: number, input: GameInput): void {
    // Player intent straight from the button mask.
    const b = input.buttons;
    const playerIntent = player.motion.planMovement({
      left: b & BTN.LEFT ? 1 : 0,
      right: b & BTN.RIGHT ? 1 : 0,
      throttle: b & BTN.CROSS ? 1 : 0,
      reverse: b & BTN.SQUARE ? 1 : 0,
      deltaSeconds: dt,
      terrain: env.terrainSampler,
    }) as ArcadeCarIntent;

    // Rival intent: waypoint progress → arrival slowdown → driver controls.
    const progress = tracker.step(rival.motion.position);
    const waypoint = progress ? progress.currentWaypoint : null;
    const nav = navigator.step({ position: rival.motion.position, waypoint });
    const controls = driver.step({
      position: rival.motion.position,
      yaw: rival.motion.yaw,
      speed: rival.speed,
      waypoint,
      cornerMagnitude: progress ? progress.cornerMagnitude : 0,
      raceStarted: race.raceState === RACE_STATES.STARTED,
      deltaSeconds: dt,
    });
    const easeOff = navigator.maxSpeed > 0 ? nav.desiredSpeed / navigator.maxSpeed : 1;
    const rivalIntent = rival.motion.planMovement({
      left: controls.left ? 1 : 0,
      right: controls.right ? 1 : 0,
      throttle: controls.throttle ? Math.max(0.4, easeOff) : 0,
      reverse: controls.reverse ? 1 : controls.brake ? 0.55 : 0,
      boost: controls.boost,
      deltaSeconds: dt,
      terrain: env.terrainSampler,
    }) as ArcadeCarIntent;

    // Both cars resolve against the barriers/props and each other.
    resolver.beginFrame();
    resolver.queueMove(player.actor, playerIntent);
    resolver.queueMove(rival.actor, rivalIntent);
    const results = resolver.resolveQueuedMoves(dt);
    const playerRes = player.motion.commitMovement(
      playerIntent,
      results.get(player.actor)!,
      env.terrainSampler,
    );
    const rivalRes = rival.motion.commitMovement(
      rivalIntent,
      results.get(rival.actor)!,
      env.terrainSampler,
    );
    player.speed = playerRes.speed;
    rival.speed = rivalRes.speed;

    // Race progress + events.
    race.updatePlayer(PLAYER_ID, vec(playerRes.position));
    race.updatePlayer(RIVAL_ID, vec(rivalRes.position));
    for (const ev of race.step(dt)) {
      if (ev.type === RACE_CHECKPOINT_LAP_EVENTS.CHECKPOINT_PASSED) {
        probe.checkpointsPassed += 1;
        if (ev.playerId === PLAYER_ID) probe.playerCheckpoints += 1;
      } else if (ev.type === RACE_CHECKPOINT_LAP_EVENTS.LAP_COMPLETED && ev.playerId === PLAYER_ID) {
        probe.playerLaps = ev.lap;
      }
    }

    // Presentation state (guest-side mirrors; render() flushes once a frame).
    syncCarVisual(player, playerRes, dt);
    syncCarVisual(rival, rivalRes, dt);
    cameraRig.step({
      targetPosition: playerRes.position,
      targetFrame: playerRes.bodyFrame,
      targetSpeed: playerRes.speed,
      deltaSeconds: dt,
      camera: scene.camera,
    });

    probe.steps += 1;
    probe.raceState = race.raceState;
    probe.playerPosition = vec(playerRes.position);
    probe.playerSpeed = playerRes.speed;
  }

  // Same borrowed-snapshot contract as the native core (RallyGame.hudState).
  const snapshot = createHudSnapshot();

  function hudState(): RallyHudState {
    const standings = race.getStandings();
    const playerState = race.getPlayer(PLAYER_ID);
    const playerPosition = player.motion.position;
    const playerForward = player.motion.bodyFrame.forward;
    const rivalPosition = rival.motion.position;

    snapshot.raceState = race.raceState;
    snapshot.lap = Math.min(playerState.completedLaps + 1, LAP_COUNT);
    snapshot.speed = Math.round(player.speed);
    snapshot.standings.length = standings.length;
    for (let i = 0; i < standings.length; i += 1) {
      snapshot.standings[i] = standings[i].playerId === PLAYER_ID ? "YOU" : "RIVAL";
    }
    snapshot.nextCheckpointIndex = playerState.nextCheckpointIndex;
    setVec(snapshot.playerPosition, playerPosition.x, playerPosition.y, playerPosition.z);
    setVec(snapshot.playerForward, playerForward.x, playerForward.y, playerForward.z);
    setVec(snapshot.rivalPosition, rivalPosition.x, rivalPosition.y, rivalPosition.z);
    snapshot.leaderId =
      standings.length > 0 && standings[0].playerId === RIVAL_ID ? RIVAL_ID : null;
    snapshot.checkpointsPassed = probe.checkpointsPassed;
    return snapshot;
  }

  return {
    scene,
    checkpoints: env.checkpoints.map((c) => vec(c.position)),
    core: "ts",
    step,
    hudState,
  };
}
