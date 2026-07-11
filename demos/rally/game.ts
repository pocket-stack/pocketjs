// demos/rally/game.ts — the pure rally sim: a closed checkpoint circuit
// composed entirely from playset modules.
//
// Everything here is deterministic fixed-step state (DETERMINISM.md): the
// only inputs are the per-step button mask and FIXED_DT — no wall clock, no
// Math.random (one seeded RandomGenerator drives the environment's prop
// placement). The composition under test:
//
//   RoadTerrainSampler + RaceTrackEnvironment  road-flattened terrain, gates,
//                                              barrier fences → CollisionWorld
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
// pixels.

import { BTN } from "@pocketjs/framework/input";
import { Euler, Vector3 } from "../../playset/math/index.ts";
import { Scene3D } from "../../playset/scene3d/client.ts";
import type { GameInput } from "../../playset/loop.ts";
import { RandomGenerator } from "../../playset/modules/math/random-utils.ts";
import { CollisionWorld } from "../../playset/modules/physics/collision-world.ts";
import { rgbToAbgr } from "../../playset/modules/world/color-utils.ts";
import type { PlanarPoint } from "../../playset/modules/world/environment/planar-utils.ts";
import { RaceTrackEnvironment } from "../../playset/modules/world/environment/race-track-environment.ts";
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
  /** One fixed 1/60 s simulation step (createGameLoop's `step`). */
  step(dt: number, input: GameInput): void;
  /** Fresh HUD snapshot (call from the loop's `render`). */
  hudState(): RallyHudState;
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

export function createRallyGame(): RallyGame {
  const scene = new Scene3D();
  const world = new CollisionWorld();

  // -- world: road-flattened terrain, gates, barriers, props ------------------
  const env = new RaceTrackEnvironment({
    scene,
    trackPlanarPoints: [...TRACK_POINTS],
    naturalEnvironmentConfig: {
      terrainSize: 150,
      terrainSegments: 48,
      treeCount: 18,
      rockCount: 6,
      grassBladeCount: 24,
      renderOrder: 0,
      prng: new RandomGenerator(42),
    },
  }).create();
  env.createColliders(world);

  scene.sun(new Vector3(-0.45, -1, -0.35), rgbToAbgr(0xfff1d6));
  scene.ambient(rgbToAbgr(0x9db8d6), rgbToAbgr(0x55624a));
  scene.sky(rgbToAbgr(0x6fa8e4), rgbToAbgr(0xd9e8f2));
  scene.fog(rgbToAbgr(0xcfe0ee), 70, 190);
  scene.camera.zfar = 400;

  // -- cars --------------------------------------------------------------------
  const resolver = new KinematicBatchResolver(world);

  function buildCar(paint: number, cabin: number, spawnDistance: number, lateral: number): RallyCar {
    const spawn = env.spawnPose(0, true, spawnDistance, lateral, CAR_RIDE_HEIGHT);
    const visual = createCarVisual(scene, { paintColor: paint, cabinColor: cabin });
    const motion = new ArcadeCarMotionController({ ...CAR_TUNING });
    motion.reset(spawn.position, spawn.yaw);
    visual.group.position.copy(motion.position);
    const wheelMirrors = visual.wheels.map(() => ({ rotation: { x: 0, y: 0 } }));
    const pivotMirrors = visual.wheelPivots.map(() => ({ rotation: { x: 0, y: 0 } }));
    return {
      motion,
      visual,
      model: new CarModelController({
        vehicleModel: visual.group,
        wheels: wheelMirrors,
        wheelPivots: pivotMirrors,
        wheelRadius: 0.35,
      }),
      actor: resolver.createActor({
        position: spawn.position,
        colliderShape: { type: "cuboid", halfX: 0.9, halfY: CAR_RIDE_HEIGHT, halfZ: 1.5 },
      }),
      wheelMirrors,
      pivotMirrors,
      speed: 0,
    };
  }

  const player = buildCar(0xc75238, 0xf4f7ff, 12, 2.4);
  const rival = buildCar(0x3878c7, 0xe8f0ff, 17, -2.4);

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
    reachDistance: 6,
    closed: true,
  });
  tracker.reset(0);
  const driver = new WaypointDriver({ targetSpeed: 14, minSpeed: 5, cornerSlowdown: 8 });
  const navigator = new AgentPathNavigator({ maxSpeed: 14, arriveRadius: 10 });

  // -- chase camera -------------------------------------------------------------------
  const cameraRig = new PoseFollowCameraRig({
    cameraOffset: { forward: -7.5, up: 3.4, right: 0 },
    lookAtOffset: { forward: 5, up: 1.1, right: 0 },
    speedCameraOffset: { forward: -0.03, up: 0.01, right: 0 },
    positionLag: 0.16,
    lookLag: 0.1,
  });

  // -- probe ------------------------------------------------------------------------------
  const probe: RallyProbe = {
    sceneId: scene.__scene,
    playerNodeId: player.visual.group.__id,
    rivalNodeId: rival.visual.group.__id,
    steps: 0,
    checkpointsPassed: 0,
    playerCheckpoints: 0,
    playerLaps: 0,
    raceState: race.raceState,
    playerPosition: vec(player.motion.position),
  };
  (globalThis as Record<string, unknown>).__rallyProbe = probe;

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
  }

  function hudState(): RallyHudState {
    const standings = race.getStandings();
    const playerState = race.getPlayer(PLAYER_ID);
    return {
      raceState: race.raceState,
      lap: Math.min(playerState.completedLaps + 1, LAP_COUNT),
      speed: Math.round(player.speed),
      standings: standings.map((s) => (s.playerId === PLAYER_ID ? "YOU" : "RIVAL")),
      nextCheckpointIndex: playerState.nextCheckpointIndex,
      playerPosition: vec(player.motion.position),
      playerForward: vec(player.motion.bodyFrame.forward),
      rivalPosition: vec(rival.motion.position),
      leaderId: standings.length > 0 && standings[0].playerId === RIVAL_ID ? RIVAL_ID : null,
      checkpointsPassed: probe.checkpointsPassed,
    };
  }

  return {
    scene,
    checkpoints: env.checkpoints.map((c) => vec(c.position)),
    step,
    hudState,
  };
}
