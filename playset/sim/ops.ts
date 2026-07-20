// playset/sim/ops.ts — THE normative contract for the `sim` surface
// (`globalThis.ps`), the native counterpart of the TS playset modules.
//
// WHY IT EXISTS (measured, not assumed): on a real PSP, QuickJS runs at
// roughly 1.7µs per interpreter op (333 MHz MIPS, soft-float f64), so a 60 Hz
// frame affords about 8,000 ops. The rally composition — collision resolve,
// two arcade cars, road-terrain sampling, waypoint AI, race state, chase
// camera, ~20 visual pose writes — costs ~160,000 ops per step in TS. That is
// not a tuning gap; it is the interpreter. The same work in native f32 costs
// a few hundred microseconds.
//
// THE SHAPE: assembly is declarative and happens once at boot — the guest
// describes the world (terrain, colliders, cars, brains, race, camera) and
// hands over the scene3d node handles the sim should drive. After that the
// per-frame conversation is two ops: `step(world, dt, buttons)` and
// `readHud(world, out)`. Chassis and wheel poses NEVER become JS; the sim
// writes them straight into the scene3d store it shares with the renderer.
//
// GRACEFUL ABSENCE — the same contract `s3` follows: a host without `ps` is
// not an error. `detectSim()` returns null and the guest runs the TS module
// composition instead (demos/rally/game.ts keeps both paths). The TS modules
// remain the reference implementation and the deterministic goldens keep
// running against them.
//
// PRECISION: the native sim is f32 (the PSP FPU is single-precision; f64
// there is soft-float), the TS reference is f64. The two paths are
// TRAJECTORY-equivalent, not bit-equivalent — same handling, same lap times,
// divergent low bits. Byte-exact goldens therefore pin the TS path only; the
// native path is pinned by bounded-divergence parity tests in the crate.
//
// ORDERING: `step` runs the composition in exactly the order
// demos/rally/game.ts uses — every car plans, the batch resolver resolves
// them together, every car commits, race progress, visual sync, camera. That
// ordering IS the semantics (actors resolve against each other from frame
// start positions), not an implementation detail.

/** Bit 0 of a collider's `flags` word: participates in push-out. */
export const COLLIDER_SOLID = 1;
/** Bit 1: contributes its top face to the ground height. */
export const COLLIDER_WALKABLE = 2;

export const COLLIDER_KIND = Object.freeze({
  /** halfExtents = (a, b, c), `yaw` rotates it about the up axis. */
  cuboid: 0,
  /** radius = a, halfHeight = b. */
  cylinder: 1,
  /** radius = a. */
  ball: 2,
});

/** Floats per collider in `collidersAdd`: `[x, y, z, a, b, c, yaw, flags]`. */
export const COLLIDER_STRIDE = 8;

/** Floats in the `readHud` mirror. */
export const HUD_FLOATS = 15;

/** Field offsets into the `readHud` buffer. */
export const HUD = Object.freeze({
  /** 0 = waiting, 1 = started, 2 = finished. */
  state: 0,
  /** Laps the player has COMPLETED (the HUD adds 1 to display). */
  laps: 1,
  /** Player tangent speed. */
  speed: 2,
  nextCheckpoint: 3,
  /** Total checkpoint passes across all cars, since boot. */
  gates: 4,
  /** 1 when the AI car leads the standings. */
  rivalLeads: 5,
  playerX: 6,
  playerY: 7,
  playerZ: 8,
  playerForwardX: 9,
  playerForwardY: 10,
  playerForwardZ: 11,
  rivalX: 12,
  rivalY: 13,
  rivalZ: 14,
});

/** `terrainRoad` config floats, in order. */
export interface RoadTerrainConfig {
  seed: number;
  roadHalfWidth: number;
  roadHeight: number;
  roadFlatnessAtHalfWidth: number;
  largeWaveScale: number;
  largeWaveAmp: number;
  midNoiseScale: number;
  midNoiseAmp: number;
  normalStep: number;
}

/** `carCreate` tuning floats, in order (ArcadeCarMotionController options). */
export interface CarTuningConfig {
  maxForwardSpeed: number;
  maxReverseSpeed: number;
  throttleAccel: number;
  reverseAccel: number;
  engineBrake: number;
  steerLag: number;
  steerAngleMax: number;
  wheelBase: number;
  rideHeight: number;
  boostMultiplier: number;
}

/** `carBrain` config floats, in order. */
export interface BrainConfig {
  /** WaypointProgressTracker.reachDistance. */
  reachDistance: number;
  /** 1 = closed loop (a circuit), 0 = open path. */
  closed: number;
  /** AgentPathNavigator.maxSpeed / arriveRadius. */
  maxSpeed: number;
  arriveRadius: number;
  /** WaypointDriver.targetSpeed / minSpeed / cornerSlowdown. */
  targetSpeed: number;
  minSpeed: number;
  cornerSlowdown: number;
}

/**
 * `cameraRig` config floats: three offsets in BASIS components
 * `(right, up, forward)`, then the two lags.
 */
export interface CameraRigConfig {
  cameraRight: number;
  cameraUp: number;
  cameraForward: number;
  lookRight: number;
  lookUp: number;
  lookForward: number;
  speedRight: number;
  speedUp: number;
  speedForward: number;
  positionLag: number;
  lookLag: number;
}

/**
 * The write-only op surface a `ps` host installs. Handles (worlds, cars) are
 * positive ints; 0 means "absent" and every op is inert on an unknown handle
 * — ops are intent, and a stale handle must never throw into a guest frame.
 */
export interface SimOps {
  /** Create a sim bound to a scene3d scene (its poses land in that scene). */
  worldCreate(scene: number): number;
  worldDestroy(world: number): void;

  /**
   * Install the EXACT height grid the visible terrain mesh was tessellated
   * from (`createTerrainMesh`'s `onGrid`), sampled bilinearly.
   *
   * PREFER THIS over `terrainRoad` whenever a mesh is on screen. The
   * procedural samplers hash through `sin`, which is a different function in
   * f32 than in f64, so a native core that re-derived heights would put the
   * car on a surface that is not the one being drawn — floating over some
   * ground, sunk into other. Sampling the drawn grid makes physics and pixels
   * read the same data, and a bilinear lookup is cheaper besides.
   *
   * `heights` is row-major `side * side`, row = forward, col = right, over a
   * `size`-wide square centred on the origin. Off-grid queries hold the edge.
   */
  terrainHeightfield(world: number, size: number, side: number, heights: Float32Array): void;

  /** Install the road-flattened procedural terrain (RoadTerrainSampler). */
  terrainRoad(world: number, config: Float32Array): void;
  /** Append road centreline segments: `[startR, startF, endR, endF]` each. */
  terrainRoadSegments(world: number, segments: Float32Array, count: number): void;

  /** Batch-add static colliders; `kinds` holds one COLLIDER_KIND per entry. */
  collidersAdd(world: number, kinds: Uint32Array, data: Float32Array, count: number): void;

  /** Create an arcade car; returns its handle. */
  carCreate(world: number, tuning: Float32Array): number;
  carReset(world: number, car: number, x: number, y: number, z: number, yaw: number): void;
  /**
   * Hand the sim the scene3d nodes it should drive.
   *
   * `localOffsets` carries the parent-local translation of every wheel node
   * followed by every pivot node (3 floats each). They have to travel WITH the
   * binding rather than be read back from the store: the game loop steps before
   * it renders, so on frame 0 the sim runs before the guest's first `flush` and
   * the store still holds identity poses. A sim that snapshotted them there
   * pinned all four wheels to the chassis origin — hidden inside the body,
   * taking the visible steering swing with them.
   */
  carBindVisual(
    world: number,
    car: number,
    group: number,
    wheels: Int32Array,
    pivots: Int32Array,
    wheelRadius: number,
    localOffsets: Float32Array,
  ): void;
  /** Register the car with the batch resolver (cuboid half extents). */
  carActor(world: number, car: number, hx: number, hy: number, hz: number): void;
  /** Attach the waypoint brain. A car WITHOUT one is driven by `buttons`. */
  carBrain(world: number, car: number, waypoints: Float32Array, count: number, config: Float32Array): void;

  /** Checkpoints as `[x, y, z, radius]` each; starts the race. */
  raceInit(world: number, checkpoints: Float32Array, count: number, lapCount: number): void;

  /** Attach the chase camera to a car; it drives the scene's camera. */
  cameraRig(world: number, car: number, config: Float32Array): void;

  /** One fixed simulation step. `buttons` is the spec BTN mask. */
  step(world: number, dt: number, buttons: number): void;

  /** Fill `out` (>= HUD_FLOATS) with the guest-visible mirror. */
  readHud(world: number, out: Float32Array): void;

  /** Honest host label: "psp" | "wgpu" (never present on the TS path). */
  readonly __host?: string;
}

/** The installed sim host, or null when this host has no `ps` surface. */
export function detectSim(): SimOps | null {
  const ops = (globalThis as { ps?: SimOps }).ps;
  return ops && typeof ops.worldCreate === "function" ? ops : null;
}
