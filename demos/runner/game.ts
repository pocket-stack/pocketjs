// demos/runner/game.ts — "Pocket Runner": a 3-lane winter endless runner,
// composed from playset modules over the scene3d surface.
//
// Behavior reference: the GameBlocks endless-runner demo at
// https://gb-endless-runner.vercel.app/ (src/main.js and its imports).
// LICENSING NOTE: the GameBlocks LIBRARY modules are MIT and are used here
// through their playset ports; the demo's game-specific glue carries NO
// license, so it was treated as a DESIGN REFERENCE ONLY — gameplay constants
// (lane offsets, speeds, spawn cadences, scoring rules, entity dimensions,
// colors, camera framing) were extracted as behavioral facts, and this file's
// code was written fresh against the playset vocabulary. No code structure,
// comments, or statements were copied from the reference.
//
// Everything here is deterministic fixed-step state (DETERMINISM.md): the
// only inputs are the per-step button mask and FIXED_DT — no wall clock, no
// Math.random (one seeded RandomGenerator drives every spawn decision, and a
// second fixed-seed stream places the snowfall). The composition:
//
//   direct lane-lerp glue        the reference's observed movement model is a
//                                damped lane slide + ballistic jump — a full
//                                character controller would change the feel,
//                                so the glue integrates it directly
//   fixed entity pools           obstacles / coins / boosts / trees stream
//                                toward the player with zero per-frame
//                                allocation (free-list reuse, spawn skipped
//                                if a pool is momentarily exhausted)
//   AABB collision in glue       the reference used plain bounds intersects
//   scene.spritePool             560-flake snowfall billboard pool
//   PositionFollowCameraRig      fixed-azimuth chase camera on the player
//   createBlobShadow             contact shadow (scene3d has no shadow maps)
//
// A debug probe rides on globalThis.__runnerProbe so the headless E2E
// (playset/test/runner-sim.test.ts) can assert score/collision/restart
// progress without scraping HUD pixels.

import { BTN } from "@pocketjs/framework/input";
import { Euler, Vector3 } from "../../playset/math/index.ts";
import { MAT, Scene3D, type SceneNode, type SpritePool } from "../../playset/scene3d/client.ts";
import type { GameInput } from "../../playset/loop.ts";
import { RandomGenerator } from "../../playset/modules/math/random-utils.ts";
import { clamp, smoothingAlpha } from "../../playset/modules/math/scalar-utils.ts";
import { rgbToAbgr } from "../../playset/modules/world/color-utils.ts";
import { createBlobShadow, updateBlobShadow } from "../../playset/modules/world/blob-shadow.ts";
import { PositionFollowCameraRig } from "../../playset/modules/camera/position-follow-camera-rig.ts";

// ---------------------------------------------------------------------------
// Behavior spec (facts extracted from the reference demo)
// ---------------------------------------------------------------------------

/** Lane center offsets, left to right (world +X = right). */
export const LANES: readonly number[] = [-3.2, 0, 3.2];
export const TRACK_HALF_WIDTH = 5.6;

const PLAYER_WIDTH = 1.05;
const PLAYER_BASE_HEIGHT = 1.7;
const PLAYER_SLIDE_HEIGHT = 0.9;
const PLAYER_DEPTH = 0.9;

const JUMP_VELOCITY = 11.5;
const GRAVITY = 28;
const SLIDE_DURATION = 0.72;
const SLIDE_SQUASH = 0.55;
/** Exponential lane-slide rate (three MathUtils.damp lambda) + snap window. */
const LANE_DAMP_LAMBDA = 18;
const LANE_SNAP_EPSILON = 0.03;
/** Run-cycle clock rate and grounded bob amplitude. */
const BOB_RATE = 12;
const BOB_AMPLITUDE = 0.035;

const BASE_SPEED = 11;
const SPEED_RAMP_PER_SECOND = 0.19;
const BOOST_MULTIPLIER = 1.45;
const BOOST_DURATION = 3.5;

const SCORE_PER_UNIT = 8;
const COIN_SCORE = 75;
const BOOST_SCORE = 250;

/** Obstacle sets keep spawning to +145 ahead; pruning trails 18 behind. */
const SPAWN_AHEAD = 145;
const SCENERY_AHEAD = 160;
const PRUNE_BEHIND = 18;
const FIRST_SPAWN_FORWARD = 26;
const FIRST_SCENERY_FORWARD = 10;
const SPAWN_GAP_MIN = 7.5;
const SPAWN_GAP_MAX = 13.5;
const SCENERY_GAP_MIN = 7;
const SCENERY_GAP_MAX = 13;
/** Above this speed a set may block a second lane (p = 0.52). */
const SECOND_OBSTACLE_SPEED = 15;

const WORLD_SEED = 20260617;
const SNOW_SEED = 777;

export type ObstacleKind = "block" | "barrier" | "lowBeam";

interface ObstacleSpec {
  /** Full AABB extents (right × up × forward) and base height above ground. */
  width: number;
  height: number;
  depth: number;
  base: number;
}

const OBSTACLE_SPECS: Record<ObstacleKind, ObstacleSpec> = {
  block: { width: 1.35, height: 1.55, depth: 1.1, base: 0 },
  barrier: { width: 1.55, height: 0.85, depth: 1.0, base: 0 },
  lowBeam: { width: 1.75, height: 0.55, depth: 1.05, base: 1.18 },
};

const COLLECTIBLE_SIZE = 0.9;
const COIN_BASE = 0.75;
const BOOST_BASE = 0.72;

const SNOWFLAKE_COUNT = 560;

// Palette (reference colors, 0xRRGGBB).
const C = {
  sky: 0xdff6ff,
  snow: 0xf4fbff,
  snowBlue: 0xd7effa,
  road: 0x26384e,
  roadPanel: 0x3c5369,
  laneWhite: 0xffffff,
  laneGlow: 0xfff3a6,
  shoulderRed: 0xd92c3a,
  rail: 0xb9f4ff,
  suit: 0xd92c3a,
  suitDark: 0x0f7f5f,
  skin: 0xffcf8a,
  visor: 0x10243d,
  trim: 0xf6f7eb,
  gold: 0xffd166,
  coinGold: 0xffd447,
  shadowDark: 0x121a2a,
  beamGreen: 0x138a66,
  trunk: 0x7f5539,
  treeA: 0x0d6b49,
  treeB: 0x11835f,
  treeC: 0x1f9f6a,
} as const;

// Pool capacities: the live window is (SPAWN_AHEAD + PRUNE_BEHIND) = 163
// units at a mean set spacing of 10.5 — comfortably inside these caps; if a
// worst-case RNG streak ever exhausts a pool the spawn is skipped (still
// deterministic: same seed, same skips).
const POOL_BLOCK = 32;
const POOL_BARRIER = 32;
const POOL_LOWBEAM = 20;
const POOL_COIN = 80;
const POOL_BOOST = 12;
const POOL_TREE = 32;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type RunnerStatus = "ready" | "running" | "gameOver";

export interface RunnerProbe {
  /** scene3d handle of the game's one scene (0 in pure-mirror mode). */
  sceneId: number;
  /** Player rig root node id — the test reads its serialized pose. */
  playerNodeId: number;
  steps: number;
  status: RunnerStatus;
  score: number;
  coins: number;
  boosts: number;
  /** Total forward distance of the CURRENT run (units). */
  distance: number;
  laneIndex: number;
  /** Obstacle hits across all runs this boot. */
  collisions: number;
  /** Completed runs (each collision ends one). */
  gameOvers: number;
  /** Runs started (1 after the first START, 2 after one restart, ...). */
  runsStarted: number;
  playerPosition: { x: number; y: number; z: number };
  /** Nearest active obstacles ahead (sorted by forward), for test scripting. */
  upcoming: { kind: ObstacleKind; laneIndex: number; forward: number }[];
}

export interface RunnerHudState {
  status: RunnerStatus;
  score: number;
  coins: number;
  distance: number;
  speed: number;
  boostActive: boolean;
  /** Score of the run that just ended (game-over card). */
  finalScore: number;
}

export interface RunnerGame {
  scene: Scene3D;
  /** One fixed 1/60 s simulation step (createGameLoop's `step`). */
  step(dt: number, input: GameInput): void;
  /** Fresh HUD snapshot (call from the loop's `render`). */
  hudState(): RunnerHudState;
}

// ---------------------------------------------------------------------------
// Internal state shapes
// ---------------------------------------------------------------------------

interface ObstacleSlot {
  active: boolean;
  kind: ObstacleKind;
  laneIndex: number;
  forward: number;
  group: SceneNode;
}

interface CollectibleSlot {
  active: boolean;
  /** Still collectible (false once picked up; kept until pruned). */
  live: boolean;
  boost: boolean;
  laneIndex: number;
  forward: number;
  phase: number;
  group: SceneNode;
}

interface TreeSlot {
  active: boolean;
  forward: number;
  group: SceneNode;
}

interface PlayerState {
  laneIndex: number;
  targetLaneIndex: number;
  laneRight: number;
  forward: number;
  height: number;
  verticalVelocity: number;
  grounded: boolean;
  slideTimer: number;
  bobTime: number;
}

interface AabbLike {
  laneRight: number;
  base: number;
  height: number;
  width: number;
  depth: number;
  forward: number;
}

/** Plain AABB overlap in (right, up, forward) space — the glue's collision. */
function aabbOverlap(a: AabbLike, b: AabbLike): boolean {
  return (
    Math.abs(a.laneRight - b.laneRight) * 2 <= a.width + b.width &&
    a.base <= b.base + b.height &&
    b.base <= a.base + a.height &&
    Math.abs(a.forward - b.forward) * 2 <= a.depth + b.depth
  );
}

function vec(v: Vector3): { x: number; y: number; z: number } {
  return { x: v.x, y: v.y, z: v.z };
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

export function createRunnerGame(): RunnerGame {
  const scene = new Scene3D();
  const rng = new RandomGenerator(WORLD_SEED);

  // -- environment: sky, fog, lights ----------------------------------------
  scene.sky(rgbToAbgr(C.sky), rgbToAbgr(0xf6feff));
  scene.fog(rgbToAbgr(C.sky), 48, 185);
  scene.sun(new Vector3(0.42, -0.72, -0.54), rgbToAbgr(0xfff7df));
  scene.ambient(rgbToAbgr(0xffffff), rgbToAbgr(0x8eb7c7));
  scene.camera.fovY = (62 * Math.PI) / 180;
  scene.camera.znear = 0.1;
  scene.camera.zfar = 420;

  // -- materials --------------------------------------------------------------
  const m = {
    snow: scene.material(rgbToAbgr(C.snow), 0),
    snowBlue: scene.material(rgbToAbgr(C.snowBlue), 0),
    road: scene.material(rgbToAbgr(C.road), 0),
    roadPanel: scene.material(rgbToAbgr(C.roadPanel), 0),
    laneWhite: scene.material(rgbToAbgr(C.laneWhite), 0),
    laneGlow: scene.material(rgbToAbgr(C.laneGlow), MAT.unlit),
    shoulderRed: scene.material(rgbToAbgr(C.shoulderRed), 0),
    rail: scene.material(rgbToAbgr(C.rail), MAT.unlit),
    suit: scene.material(rgbToAbgr(C.suit), 0),
    suitDark: scene.material(rgbToAbgr(C.suitDark), 0),
    skin: scene.material(rgbToAbgr(C.skin), 0),
    visor: scene.material(rgbToAbgr(C.visor), MAT.unlit),
    trim: scene.material(rgbToAbgr(C.trim), 0),
    gold: scene.material(rgbToAbgr(C.gold), 0),
    goldGlow: scene.material(rgbToAbgr(C.gold), MAT.unlit),
    coinGold: scene.material(rgbToAbgr(C.coinGold), 0),
    shadowDark: scene.material(rgbToAbgr(C.shadowDark), 0),
    beamGreen: scene.material(rgbToAbgr(C.beamGreen), 0),
    trunk: scene.material(rgbToAbgr(C.trunk), 0),
    crowns: [
      scene.material(rgbToAbgr(C.treeA), 0),
      scene.material(rgbToAbgr(C.treeB), 0),
      scene.material(rgbToAbgr(C.treeC), 0),
    ],
  };

  // -- static track (one long strip; a run outlasting it has earned it) -------
  const TRACK_LENGTH = 12000;
  const trackMidZ = -(TRACK_LENGTH / 2 - 60);

  function longBox(width: number, thick: number, matId: number, x: number, yTop: number): void {
    const node = scene.mesh(scene.box(width / 2, thick / 2, TRACK_LENGTH / 2), matId);
    node.position.set(x, yTop - thick / 2, trackMidZ);
  }

  longBox(160, 0.1, m.snow, 0, -0.03); // snowfield
  longBox(TRACK_HALF_WIDTH * 2, 0.12, m.road, 0, 0.0); // roadbed
  for (const side of [-1, 1]) {
    longBox(0.5, 0.05, m.shoulderRed, side * (TRACK_HALF_WIDTH + 0.42), 0.04); // shoulders
    longBox(1.05, 0.34, m.snowBlue, side * (TRACK_HALF_WIDTH + 1.12), 0.26); // snow banks
    longBox(1.18, 0.12, m.snow, side * (TRACK_HALF_WIDTH + 1.12), 0.37); // bank caps
    longBox(0.22, 0.42, m.rail, side * TRACK_HALF_WIDTH, 0.42); // guard rails
    longBox(0.34, 0.08, m.laneGlow, side * TRACK_HALF_WIDTH, 0.5); // rail caps
    longBox(0.08, 0.035, m.laneWhite, side * 1.6, 0.043); // lane lines
  }

  // -- recycled near-field track dressing (windowed, wraps with the player) ---
  interface Recycler {
    nodes: SceneNode[];
    spacing: number;
    place(node: SceneNode, forward: number, index: number): void;
  }
  const recyclers: Recycler[] = [];

  function addRecycler(
    count: number,
    spacing: number,
    make: () => SceneNode,
    place: (node: SceneNode, forward: number, index: number) => void,
  ): void {
    const nodes: SceneNode[] = [];
    for (let i = 0; i < count; i += 1) nodes.push(make());
    recyclers.push({ nodes, spacing, place });
  }

  function stepRecyclers(playerForward: number): void {
    for (const r of recyclers) {
      const span = r.nodes.length * r.spacing;
      // Window [playerForward - 20, +span): each node owns one spacing slot.
      const first = Math.ceil((playerForward - 20) / r.spacing);
      for (let k = 0; k < r.nodes.length; k += 1) {
        const slot = first + k;
        const idx = ((slot % r.nodes.length) + r.nodes.length) % r.nodes.length;
        r.place(r.nodes[idx], slot * r.spacing, slot);
      }
      void span;
    }
  }

  // Glowing lane dashes on both lane lines (spacing 8.5, 2.4 long).
  for (const laneX of [-1.6, 1.6]) {
    addRecycler(
      26,
      8.5,
      () => scene.mesh(scene.box(0.09, 0.0225, 1.2), m.laneGlow),
      (node, forward) => node.position.set(laneX, 0.052, -(forward + 3)),
    );
  }
  // Road expansion-panel bands (spacing 14, full road width).
  addRecycler(
    16,
    14,
    () => scene.mesh(scene.box(TRACK_HALF_WIDTH - 0.5, 0.0125, 0.05), m.roadPanel),
    (node, forward) => node.position.set(0, 0.012, -(forward + 5)),
  );
  // Candy stripes on the red shoulders (spacing 10, alternating skew).
  const stripeEuler = new Euler();
  for (const side of [-1, 1]) {
    addRecycler(
      22,
      10,
      () => scene.mesh(scene.box(0.27, 0.029, 1.4), m.laneWhite),
      (node, forward, index) => {
        node.position.set(side * (TRACK_HALF_WIDTH + 0.42), 0.052, -(forward + 5));
        node.quaternion.setFromEuler(stripeEuler.set(0, index % 2 === 0 ? 0.42 : -0.42, 0));
      },
    );
  }

  // -- the runner: ~11 rigid primitives with procedural swing ------------------
  const rig = scene.node();
  const torso = scene.mesh(scene.box(0.44, 0.54, 0.28), m.suit, rig);
  torso.position.set(0, 0.8, 0);
  const head = scene.mesh(scene.sphere(0.42, 14), m.skin, rig);
  head.position.set(0, 1.55, 0);
  const visorPlate = scene.mesh(scene.box(0.29, 0.09, 0.04), m.visor, rig);
  visorPlate.position.set(0, 1.58, -0.37);
  const hat = scene.mesh(scene.cone(0.34, 0.58, 10), m.suit, rig);
  hat.position.set(0.02, 2.0, 0.02);
  const pom = scene.mesh(scene.sphere(0.1, 8), m.trim, rig);
  pom.position.set(-0.04, 2.32, 0.02);

  interface Limb {
    pivot: SceneNode;
  }
  function limb(x: number, y: number, matId: number, geomId: number, dropY: number): Limb {
    const pivot = scene.node(rig);
    pivot.position.set(x, y, 0);
    const mesh = scene.mesh(geomId, matId, pivot);
    mesh.position.set(0, dropY, 0);
    return { pivot };
  }
  const armGeom = scene.cylinder(0.09, 0.11, 0.62, 8);
  const legGeom = scene.box(0.09, 0.22, 0.1);
  const armL = limb(-0.64, 1.05, m.suitDark, armGeom, -0.31);
  const armR = limb(0.64, 1.05, m.suitDark, armGeom, -0.31);
  const legL = limb(-0.28, 0.56, m.suitDark, legGeom, -0.22);
  const legR = limb(0.28, 0.56, m.suitDark, legGeom, -0.22);
  const shoeGeom = scene.box(0.14, 0.08, 0.29);
  for (const l of [legL, legR]) {
    const shoe = scene.mesh(shoeGeom, m.shadowDark, l.pivot);
    shoe.position.set(0, -0.48, -0.05);
  }
  const playerShadow = createBlobShadow(scene, { radius: 0.55, opacity: 0.3 });

  // -- entity pools -------------------------------------------------------------
  function buildBlock(): SceneNode {
    const group = scene.node();
    const s = OBSTACLE_SPECS.block;
    const base = scene.mesh(scene.box(s.width / 2, s.height / 2, s.depth / 2), m.shoulderRed, group);
    base.position.set(0, s.height / 2, 0);
    const ribbon = scene.mesh(scene.box(0.09, (s.height * 1.03) / 2, (s.depth * 1.06) / 2), m.gold, group);
    ribbon.position.set(0, s.height / 2, 0);
    const cap = scene.mesh(scene.box((s.width * 0.98) / 2, 0.04, (s.depth * 0.94) / 2), m.snow, group);
    cap.position.set(0, s.height + 0.04, 0);
    return group;
  }

  function buildBarrier(): SceneNode {
    const group = scene.node();
    for (const x of [-0.62, 0.62]) {
      const post = scene.mesh(scene.box(0.09, 0.43, 0.14), m.visor, group);
      post.position.set(x, 0.43, 0);
    }
    const railTop = scene.mesh(scene.box(0.69, 0.09, 0.09), m.shoulderRed, group);
    railTop.position.set(0, 0.62, -0.08);
    const railLow = scene.mesh(scene.box(0.69, 0.09, 0.09), m.trim, group);
    railLow.position.set(0, 0.28, -0.08);
    return group;
  }

  function buildLowBeam(): SceneNode {
    const group = scene.node();
    const s = OBSTACLE_SPECS.lowBeam;
    const beam = scene.mesh(scene.box(s.width / 2, s.height / 2, s.depth / 2), m.beamGreen, group);
    beam.position.set(0, s.base + s.height / 2, 0);
    const strip = scene.mesh(scene.box((s.width * 0.86) / 2, 0.04, (s.depth * 1.04) / 2), m.goldGlow, group);
    strip.position.set(0, s.base + s.height / 2, 0);
    for (const x of [-0.82, 0.82]) {
      const upright = scene.mesh(scene.box(0.08, (s.base + 0.28) / 2, 0.11), m.beamGreen, group);
      upright.position.set(x, (s.base + 0.28) / 2, 0);
    }
    return group;
  }

  function buildCoin(): SceneNode {
    const group = scene.node();
    const ball = scene.mesh(scene.sphere(0.36, 12), m.coinGold, group);
    ball.position.set(0, 0, 0);
    const ribbon = scene.mesh(scene.torus(0.365, 0.03, 12, 6), m.shoulderRed, group);
    ribbon.quaternion.setFromEuler(new Euler(Math.PI / 2, 0, 0));
    return group;
  }

  function buildBoost(): SceneNode {
    const group = scene.node();
    scene.mesh(scene.sphere(0.28, 10), m.goldGlow, group);
    const ringA = scene.mesh(scene.torus(0.62, 0.025, 16, 6), m.goldGlow, group);
    ringA.quaternion.setFromEuler(new Euler(Math.PI / 2, 0, 0));
    scene.mesh(scene.torus(0.62, 0.025, 16, 6), m.goldGlow, group).quaternion.setFromEuler(
      new Euler(0, Math.PI / 2, 0),
    );
    return group;
  }

  function buildTree(crownMat: number): SceneNode {
    const group = scene.node();
    const trunk = scene.mesh(scene.cylinder(0.14, 0.24, 1.5, 8), m.trunk, group);
    trunk.position.set(0, 0.75, 0);
    const lower = scene.mesh(scene.cone(1.1, 1.6, 8), crownMat, group);
    lower.position.set(0, 1.9, 0);
    const upper = scene.mesh(scene.cone(0.7, 1.1, 8), crownMat, group);
    upper.position.set(0, 2.8, 0);
    const snowCap = scene.mesh(scene.cone(0.5, 0.4, 8), m.snow, group);
    snowCap.position.set(0, 3.3, 0);
    return group;
  }

  function makeObstaclePool(kind: ObstacleKind, count: number, build: () => SceneNode): ObstacleSlot[] {
    const slots: ObstacleSlot[] = [];
    for (let i = 0; i < count; i += 1) {
      const group = build();
      group.visible = false;
      slots.push({ active: false, kind, laneIndex: 0, forward: 0, group });
    }
    return slots;
  }

  const obstaclePools: Record<ObstacleKind, ObstacleSlot[]> = {
    block: makeObstaclePool("block", POOL_BLOCK, buildBlock),
    barrier: makeObstaclePool("barrier", POOL_BARRIER, buildBarrier),
    lowBeam: makeObstaclePool("lowBeam", POOL_LOWBEAM, buildLowBeam),
  };

  function makeCollectiblePool(boost: boolean, count: number): CollectibleSlot[] {
    const slots: CollectibleSlot[] = [];
    for (let i = 0; i < count; i += 1) {
      const group = boost ? buildBoost() : buildCoin();
      group.visible = false;
      slots.push({ active: false, live: false, boost, laneIndex: 0, forward: 0, phase: 0, group });
    }
    return slots;
  }

  const coinPool = makeCollectiblePool(false, POOL_COIN);
  const boostPool = makeCollectiblePool(true, POOL_BOOST);

  const treePool: TreeSlot[] = [];
  for (let i = 0; i < POOL_TREE; i += 1) {
    const group = buildTree(m.crowns[i % m.crowns.length]);
    group.visible = false;
    treePool.push({ active: false, forward: 0, group });
  }

  // -- snowfall -------------------------------------------------------------------
  const snowMat = scene.material(rgbToAbgr(0xffffff, 0.78), MAT.unlit | MAT.transparent);
  const snowPool: SpritePool = scene.spritePool(SNOWFLAKE_COUNT, snowMat);
  const flakeRight = new Float32Array(SNOWFLAKE_COUNT);
  const flakeUp = new Float32Array(SNOWFLAKE_COUNT);
  const flakeForward = new Float32Array(SNOWFLAKE_COUNT);
  {
    const snowRng = new RandomGenerator(SNOW_SEED);
    for (let i = 0; i < SNOWFLAKE_COUNT; i += 1) {
      flakeRight[i] = snowRng.uniform(-42, 42);
      flakeUp[i] = snowRng.uniform(4, 26);
      flakeForward[i] = snowRng.uniform(-80, 120);
      snowPool.buf[i * 4 + 3] = snowRng.uniform(0.1, 0.24);
      snowPool.colors[i] = rgbToAbgr(0xffffff, 0.78);
    }
    snowPool.count = SNOWFLAKE_COUNT;
  }

  function stepSnow(playerForward: number, dt: number): void {
    for (let i = 0; i < SNOWFLAKE_COUNT; i += 1) {
      flakeUp[i] -= (1.2 + (i % 7) * 0.12) * dt;
      flakeRight[i] += Math.sin(playerForward * 0.04 + i) * 0.012;
      if (flakeUp[i] < 1.6) flakeUp[i] = 24 + (i % 11) * 0.18;
      const o = i * 4;
      snowPool.buf[o] = flakeRight[i];
      snowPool.buf[o + 1] = flakeUp[i];
      snowPool.buf[o + 2] = -(playerForward + 28 + flakeForward[i]);
    }
    snowPool.count = SNOWFLAKE_COUNT;
  }

  // -- camera ------------------------------------------------------------------
  const cameraRig = new PositionFollowCameraRig({
    azimuth: 0,
    distance: 11,
    height: 6.4,
    lookHeight: 1.2,
    positionLag: 0.06,
    lookLag: 0.04,
  });

  // -- run state -----------------------------------------------------------------
  const player: PlayerState = {
    laneIndex: 1,
    targetLaneIndex: 1,
    laneRight: LANES[1],
    forward: 0,
    height: 0,
    verticalVelocity: 0,
    grounded: true,
    slideTimer: 0,
    bobTime: 0,
  };

  let status: RunnerStatus = "ready";
  let score = 0;
  let coins = 0;
  let boosts = 0;
  let finalScore = 0;
  let speed = BASE_SPEED;
  let effectiveSpeed = BASE_SPEED;
  let boostTimer = 0;
  let nextSpawnForward = FIRST_SPAWN_FORWARD;
  let nextSceneryForward = FIRST_SCENERY_FORWARD;
  let prevButtons = 0;
  let cameraSnapped = false;

  const probe: RunnerProbe = {
    sceneId: scene.__scene,
    playerNodeId: rig.__id,
    steps: 0,
    status,
    score: 0,
    coins: 0,
    boosts: 0,
    distance: 0,
    laneIndex: 1,
    collisions: 0,
    gameOvers: 0,
    runsStarted: 0,
    playerPosition: { x: LANES[1], y: 0, z: 0 },
    upcoming: [],
  };
  (globalThis as Record<string, unknown>).__runnerProbe = probe;

  function releaseAll(): void {
    for (const pool of [obstaclePools.block, obstaclePools.barrier, obstaclePools.lowBeam]) {
      for (const slot of pool) {
        if (!slot.active) continue;
        slot.active = false;
        slot.group.visible = false;
      }
    }
    for (const pool of [coinPool, boostPool]) {
      for (const slot of pool) {
        if (!slot.active) continue;
        slot.active = false;
        slot.live = false;
        slot.group.visible = false;
      }
    }
    for (const slot of treePool) {
      if (!slot.active) continue;
      slot.active = false;
      slot.group.visible = false;
    }
  }

  function resetRun(): void {
    releaseAll();
    rng.seed(WORLD_SEED);
    player.laneIndex = 1;
    player.targetLaneIndex = 1;
    player.laneRight = LANES[1];
    player.forward = 0;
    player.height = 0;
    player.verticalVelocity = 0;
    player.grounded = true;
    player.slideTimer = 0;
    player.bobTime = 0;
    score = 0;
    coins = 0;
    boosts = 0;
    speed = BASE_SPEED;
    effectiveSpeed = BASE_SPEED;
    boostTimer = 0;
    nextSpawnForward = FIRST_SPAWN_FORWARD;
    nextSceneryForward = FIRST_SCENERY_FORWARD;
  }

  // -- spawning ---------------------------------------------------------------
  function takeObstacle(kind: ObstacleKind, laneIndex: number, forward: number): void {
    const pool = obstaclePools[kind];
    const slot = pool.find((s) => !s.active);
    if (!slot) return; // pool exhausted — skip (deterministic)
    slot.active = true;
    slot.laneIndex = laneIndex;
    slot.forward = forward;
    slot.group.position.set(LANES[laneIndex], 0, -forward);
    slot.group.visible = true;
  }

  function takeCollectible(boost: boolean, laneIndex: number, forward: number): void {
    const pool = boost ? boostPool : coinPool;
    const slot = pool.find((s) => !s.active);
    if (!slot) return;
    slot.active = true;
    slot.live = true;
    slot.laneIndex = laneIndex;
    slot.forward = forward;
    slot.phase = rng.uniform(0, Math.PI * 2);
    const base = boost ? BOOST_BASE : COIN_BASE;
    slot.group.position.set(LANES[laneIndex], base + COLLECTIBLE_SIZE / 2, -forward);
    slot.group.visible = true;
  }

  const OBSTACLE_KINDS: readonly ObstacleKind[] = ["block", "barrier", "lowBeam"];
  const SECOND_KINDS: readonly ObstacleKind[] = ["block", "barrier"];

  function spawnSet(forward: number): void {
    const blockedLane = rng.randint(0, 2);
    takeObstacle(rng.choice(OBSTACLE_KINDS), blockedLane, forward);

    if (speed > SECOND_OBSTACLE_SPEED && rng.random() > 0.48) {
      const others = [0, 1, 2].filter((lane) => lane !== blockedLane);
      takeObstacle(rng.choice(SECOND_KINDS), rng.choice(others), forward + rng.uniform(1.6, 3.2));
    }

    const openLanes = [0, 1, 2].filter((lane) => lane !== blockedLane);
    const lane = rng.choice(openLanes);
    const isBoost = rng.random() > 0.84;
    const count = isBoost ? 1 : rng.randint(2, 5);
    for (let i = 0; i < count; i += 1) {
      takeCollectible(isBoost, lane, forward + 3 + i * 2.1);
    }
  }

  function spawnScenery(forward: number): void {
    for (const side of [-1, 1]) {
      if (rng.random() < 0.2) continue;
      const right = side * rng.uniform(8.5, 24);
      const slot = treePool.find((s) => !s.active);
      const scale = rng.uniform(0.82, 1.35);
      const jitter = rng.uniform(-2, 2);
      if (!slot) continue; // draws above keep the stream aligned
      slot.active = true;
      slot.forward = forward + jitter;
      slot.group.position.set(right, 0, -slot.forward);
      slot.group.scale.set(scale, scale, scale);
      slot.group.visible = true;
    }
  }

  function streamWorld(): void {
    while (nextSpawnForward < player.forward + SPAWN_AHEAD) {
      spawnSet(nextSpawnForward);
      nextSpawnForward += rng.uniform(SPAWN_GAP_MIN, SPAWN_GAP_MAX);
    }
    while (nextSceneryForward < player.forward + SCENERY_AHEAD) {
      spawnScenery(nextSceneryForward);
      nextSceneryForward += rng.uniform(SCENERY_GAP_MIN, SCENERY_GAP_MAX);
    }
    const minForward = player.forward - PRUNE_BEHIND;
    for (const kind of OBSTACLE_KINDS) {
      for (const slot of obstaclePools[kind]) {
        if (slot.active && slot.forward <= minForward) {
          slot.active = false;
          slot.group.visible = false;
        }
      }
    }
    for (const pool of [coinPool, boostPool]) {
      for (const slot of pool) {
        if (slot.active && (slot.forward <= minForward || !slot.live)) {
          slot.active = false;
          slot.live = false;
          slot.group.visible = false;
        }
      }
    }
    for (const slot of treePool) {
      if (slot.active && slot.forward <= minForward) {
        slot.active = false;
        slot.group.visible = false;
      }
    }
  }

  // -- collision ----------------------------------------------------------------
  const playerBox: AabbLike = {
    laneRight: 0,
    base: 0,
    height: PLAYER_BASE_HEIGHT,
    width: PLAYER_WIDTH,
    depth: PLAYER_DEPTH,
    forward: 0,
  };
  const otherBox: AabbLike = { laneRight: 0, base: 0, height: 1, width: 1, depth: 1, forward: 0 };

  function resolveCollisions(): void {
    playerBox.laneRight = player.laneRight;
    playerBox.base = player.height;
    playerBox.height = player.slideTimer > 0 ? PLAYER_SLIDE_HEIGHT : PLAYER_BASE_HEIGHT;
    playerBox.forward = player.forward;

    for (const kind of OBSTACLE_KINDS) {
      const spec = OBSTACLE_SPECS[kind];
      for (const slot of obstaclePools[kind]) {
        if (!slot.active) continue;
        otherBox.laneRight = LANES[slot.laneIndex];
        otherBox.base = spec.base;
        otherBox.height = spec.height;
        otherBox.width = spec.width;
        otherBox.depth = spec.depth;
        otherBox.forward = slot.forward;
        if (aabbOverlap(playerBox, otherBox)) {
          probe.collisions += 1;
          probe.gameOvers += 1;
          finalScore = Math.floor(score);
          status = "gameOver";
          return;
        }
      }
    }

    for (const pool of [coinPool, boostPool]) {
      for (const slot of pool) {
        if (!slot.active || !slot.live) continue;
        otherBox.laneRight = LANES[slot.laneIndex];
        otherBox.base = slot.boost ? BOOST_BASE : COIN_BASE;
        otherBox.height = COLLECTIBLE_SIZE;
        otherBox.width = COLLECTIBLE_SIZE;
        otherBox.depth = COLLECTIBLE_SIZE;
        otherBox.forward = slot.forward;
        if (!aabbOverlap(playerBox, otherBox)) continue;
        slot.live = false;
        slot.group.visible = false;
        if (slot.boost) {
          boostTimer = BOOST_DURATION;
          score += BOOST_SCORE;
          boosts += 1;
        } else {
          coins += 1;
          score += COIN_SCORE;
        }
      }
    }
  }

  // -- input ---------------------------------------------------------------------
  function pressed(buttons: number, mask: number): boolean {
    return (buttons & mask) !== 0 && (prevButtons & mask) === 0;
  }

  function handleInput(buttons: number): void {
    if (status !== "running") {
      if (pressed(buttons, BTN.CROSS) || pressed(buttons, BTN.START)) {
        if (status === "gameOver") resetRun();
        status = "running";
        probe.runsStarted += 1;
      }
      return;
    }
    if (pressed(buttons, BTN.LEFT)) {
      player.targetLaneIndex = clamp(player.targetLaneIndex - 1, 0, LANES.length - 1);
    }
    if (pressed(buttons, BTN.RIGHT)) {
      player.targetLaneIndex = clamp(player.targetLaneIndex + 1, 0, LANES.length - 1);
    }
    if (pressed(buttons, BTN.CROSS) && player.grounded && player.slideTimer <= 0) {
      player.verticalVelocity = JUMP_VELOCITY;
      player.grounded = false;
    }
    if (pressed(buttons, BTN.DOWN) && player.grounded) {
      player.slideTimer = SLIDE_DURATION;
    }
  }

  // -- per-step player integration --------------------------------------------------
  function stepPlayer(dt: number): void {
    boostTimer = Math.max(0, boostTimer - dt);
    speed += SPEED_RAMP_PER_SECOND * dt;
    effectiveSpeed = speed * (boostTimer > 0 ? BOOST_MULTIPLIER : 1);
    const forwardDelta = effectiveSpeed * dt;
    player.forward += forwardDelta;
    player.bobTime += dt * BOB_RATE;
    score += forwardDelta * SCORE_PER_UNIT;

    const targetRight = LANES[player.targetLaneIndex];
    player.laneRight += (targetRight - player.laneRight) * smoothingAlpha(1 / LANE_DAMP_LAMBDA, dt);
    if (Math.abs(player.laneRight - targetRight) < LANE_SNAP_EPSILON) {
      player.laneRight = targetRight;
      player.laneIndex = player.targetLaneIndex;
    }

    if (!player.grounded) {
      player.verticalVelocity -= GRAVITY * dt;
      player.height += player.verticalVelocity * dt;
      if (player.height <= 0) {
        player.height = 0;
        player.verticalVelocity = 0;
        player.grounded = true;
      }
    }
    if (player.slideTimer > 0) player.slideTimer = Math.max(0, player.slideTimer - dt);
  }

  // -- visual sync -------------------------------------------------------------------
  const limbEuler = new Euler();

  function syncVisuals(dt: number): void {
    const bob = player.grounded && status === "running" ? Math.sin(player.bobTime) * BOB_AMPLITUDE : 0;
    rig.position.set(player.laneRight, player.height + bob, -player.forward);
    const squash = player.slideTimer > 0 ? SLIDE_SQUASH : 1;
    rig.scale.set(1, squash, 1);

    // Procedural run cycle: opposite-phase arm/leg swing; tucked in the air.
    const running = status === "running";
    const swing = running && player.grounded ? Math.sin(player.bobTime) * 0.7 : 0;
    const airTuck = player.grounded ? 0 : 0.55;
    armL.pivot.quaternion.setFromEuler(limbEuler.set(swing - airTuck, 0, -0.15));
    armR.pivot.quaternion.setFromEuler(limbEuler.set(-swing - airTuck, 0, 0.15));
    legL.pivot.quaternion.setFromEuler(limbEuler.set(-swing + airTuck, 0, 0));
    legR.pivot.quaternion.setFromEuler(limbEuler.set(swing + airTuck, 0, 0));

    updateBlobShadow(playerShadow, 0, { x: player.laneRight, z: -player.forward });

    // Collectible idle animation: spin + gentle vertical wave.
    for (const pool of [coinPool, boostPool]) {
      for (const slot of pool) {
        if (!slot.active || !slot.live) continue;
        slot.phase += dt * 4;
        const base = (slot.boost ? BOOST_BASE : COIN_BASE) + COLLECTIBLE_SIZE / 2;
        slot.group.position.y = base + Math.sin(slot.phase) * 0.08;
        slot.group.quaternion.setFromEuler(limbEuler.set(0, slot.phase * 1.2, 0));
      }
    }

    stepRecyclers(player.forward);
    stepSnow(player.forward, dt);

    cameraRig.step({
      targetPosition: { x: player.laneRight, y: player.height, z: -player.forward },
      snapToTarget: !cameraSnapped,
      deltaSeconds: dt,
      camera: scene.camera,
    });
    cameraSnapped = true;
  }

  // -- the fixed step ------------------------------------------------------------------
  function step(dt: number, input: GameInput): void {
    handleInput(input.buttons);
    prevButtons = input.buttons;

    if (status === "running") {
      stepPlayer(dt);
      streamWorld();
      resolveCollisions();
    }

    syncVisuals(dt);

    probe.steps += 1;
    probe.status = status;
    probe.score = Math.floor(score);
    probe.coins = coins;
    probe.boosts = boosts;
    probe.distance = Math.floor(player.forward);
    probe.laneIndex = player.targetLaneIndex;
    probe.playerPosition = vec(rig.position);
    probe.upcoming.length = 0;
    for (const kind of OBSTACLE_KINDS) {
      for (const slot of obstaclePools[kind]) {
        if (!slot.active || slot.forward < player.forward - 2) continue;
        probe.upcoming.push({ kind: slot.kind, laneIndex: slot.laneIndex, forward: slot.forward });
      }
    }
    probe.upcoming.sort((a, b) => a.forward - b.forward);
    probe.upcoming.length = Math.min(probe.upcoming.length, 6);
  }

  function hudState(): RunnerHudState {
    return {
      status,
      score: Math.floor(score),
      coins,
      distance: Math.floor(player.forward),
      speed: Math.round(effectiveSpeed),
      boostActive: boostTimer > 0,
      finalScore,
    };
  }

  return { scene, step, hudState };
}
