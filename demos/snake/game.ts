// demos/snake/game.ts — "Pocket Snake": a grid-snake arena duel (player vs.
// one AI rival) composed entirely from playset modules.
//
// Reference: the GameBlocks demo "Snake Clash" (https://gb-snake-clash.vercel.app/).
// The library modules it builds on are the MIT-licensed playset ports used
// below (SnakeMotionController, SnakePlay, GridPathPlanner, BoardEnvironment,
// PositionFollowCameraRig, RandomGenerator). The behavior spec — grid
// dimensions, tick cadence, growth/score rules, AI scoring weights, palette,
// geometry sizes, and camera framing — is derived from the gb-snake-clash
// demo sources; the glue itself is a fresh implementation written for
// Pocket's deterministic fixed-step machine.
//
// Everything here is deterministic fixed-step state (DETERMINISM.md): the
// only inputs are the per-step button mask and FIXED_DT — no wall clock, no
// Math.random (one seeded RandomGenerator drives item spawns). The grid
// advances every N sim steps, N derived from the reference cadence
// (150 ms base → 9 steps at 60 Hz, speeding up 4 ms per point to a 70 ms
// floor → 4 steps). The composition under test:
//
//   BoardEnvironment                    16×16 board plane + grid + lighting,
//                                       cellToWorldPoint for all placement
//   SnakeMotionController ×2            segment queues + pending growth
//                                       (cardinal mode: reversals impossible)
//   SnakePlay (fresh per grid tick)     wall/self/snake-vs-snake collisions
//                                       + item pickups → events
//   GridPathPlanner                     the rival brain's flood fills and
//                                       A* routes to the nearest apple
//   PositionFollowCameraRig             one fixed tilted pose framing the board
//
// A debug probe rides on globalThis.__snakeProbe so the headless E2E
// (playset/test/snake-sim.test.ts) can assert pickups/deaths without
// scraping HUD pixels.

import { BTN } from "@pocketjs/framework/input";
import { Euler } from "../../playset/math/index.ts";
import { Scene3D, type SceneNode } from "../../playset/scene3d/client.ts";
import type { GameInput } from "../../playset/loop.ts";
import { RandomGenerator } from "../../playset/modules/math/random-utils.ts";
import { rgbToAbgr } from "../../playset/modules/world/color-utils.ts";
import { BoardEnvironment } from "../../playset/modules/world/environment/board-environment.ts";
import { PositionFollowCameraRig } from "../../playset/modules/camera/position-follow-camera-rig.ts";
import {
  SnakeMotionController,
  type SnakeCell,
} from "../../playset/modules/actor-motion/snake-motion-controller.ts";
import {
  SNAKE_PLAY_EVENTS,
  SnakePlay,
  type SnakeDeathReason,
} from "../../playset/modules/gameplay/snake-play.ts";
import {
  GridPathPlanner,
  gridCellKey,
  type GridNavigation,
} from "../../playset/modules/behavior/grid-path-planner.ts";

// ---------------------------------------------------------------------------
// Behavior spec (numbers observed from the reference demo)
// ---------------------------------------------------------------------------

export const COLUMNS = 16;
export const ROWS = 16;
const CELL_SIZE = 1;
const INITIAL_LENGTH = 4;

/** Reference cadence: 150 ms/tick base, −4 ms per player point, 70 ms floor.
 *  Folded onto the fixed step as whole sim-step counts (60 steps = 1 s). */
const BASE_TICK_MS = 150;
const MIN_TICK_MS = 70;
const SPEEDUP_MS_PER_POINT = 4;
const STEP_MS = 1000 / 60;

const PLAYER_START: SnakeCell = { right: 3, forward: 8 }; // floor(rows/2)
const RIVAL_START: SnakeCell = { right: COLUMNS - 4, forward: 3 };

/** Segment-node pool size per snake — growth beyond this still plays out in
 *  the sim; only the visual chain clamps (no per-growth allocation ever). */
const MAX_SEGMENTS = 64;

// Palette (reference CSS/material colors).
const PLAYER_BODY = 0xd72638;
const PLAYER_HEAD = 0xf04f5d;
const RIVAL_BODY = 0x2687c9;
const RIVAL_HEAD = 0x6fd0ff;
const EYE_COLOR = 0xfff5f6;
const APPLE_BODY = 0x35b34a;
const APPLE_LEAF = 0x7ce084;
const APPLE_STEM = 0x6f431f;
const RIM_COLOR = 0x364a5a;
const BOARD_GROUND = 0x23303c;
const BOARD_GRID = 0x507893;
const BACKGROUND = 0x1b242c;

export type DirectionName = "up" | "right" | "down" | "left";

const DIRECTION_NAMES: readonly DirectionName[] = ["up", "right", "down", "left"];

const DIRECTION_VECTORS: Readonly<Record<DirectionName, SnakeCell>> = Object.freeze({
  up: Object.freeze({ right: 0, forward: 1 }),
  right: Object.freeze({ right: 1, forward: 0 }),
  down: Object.freeze({ right: 0, forward: -1 }),
  left: Object.freeze({ right: -1, forward: 0 }),
});

const OPPOSITE: Readonly<Record<DirectionName, DirectionName>> = Object.freeze({
  up: "down",
  right: "left",
  down: "up",
  left: "right",
});

/** Head yaw per travel direction (basis forward is −z; eyes sit at +z). */
const HEAD_YAW: Readonly<Record<DirectionName, number>> = Object.freeze({
  up: Math.PI,
  down: 0,
  left: Math.PI * 0.5,
  right: -Math.PI * 0.5,
});

function directionName(vector: SnakeCell): DirectionName {
  if (vector.right < 0) return "left";
  if (vector.right > 0) return "right";
  if (vector.forward > 0) return "up";
  return "down";
}

/** Cardinal-mode move flags for an absolute direction (d-pad semantics). */
function moveFlags(direction: DirectionName): {
  left: boolean;
  right: boolean;
  forward: boolean;
  backward: boolean;
} {
  return {
    left: direction === "left",
    right: direction === "right",
    forward: direction === "up",
    backward: direction === "down",
  };
}

function tickSteps(score: number): number {
  const ms = Math.max(MIN_TICK_MS, BASE_TICK_MS - score * SPEEDUP_MS_PER_POINT);
  return Math.max(1, Math.round(ms / STEP_MS));
}

// ---------------------------------------------------------------------------
// The rival brain — one grid decision per tick over GridPathPlanner
// ---------------------------------------------------------------------------
//
// Observed reference behavior: consider the three non-reversal directions,
// discard off-board / occupied moves, then score each candidate by
//   reachable space (flood fill)        × spaceWeight
//   − A* distance to the nearest apple  × appleDistanceWeight
//     (unreachable apple costs the whole board: columns × rows)
//   + tailReachBonus when its own tail stays reachable
//   + straightBias when the candidate keeps the current heading
// picking the highest score (ties resolve in up/right/down/left order).

interface BrainWeights {
  spaceWeight: number;
  appleDistanceWeight: number;
  tailReachBonus: number;
  straightBias: number;
}

/** Rival tuning observed in the reference demo. */
const RIVAL_WEIGHTS: BrainWeights = {
  spaceWeight: 2,
  appleDistanceWeight: 3,
  tailReachBonus: 3.5,
  straightBias: 0.5,
};

interface BrainSenses {
  segments: SnakeCell[];
  direction: DirectionName;
  pendingGrowth: number;
  opponentSegments: SnakeCell[];
  apples: SnakeCell[];
}

const GRID_NAVIGATION: GridNavigation = {
  vectors: DIRECTION_VECTORS,
  neighborOrder: DIRECTION_NAMES,
};

function stepInBounds(cell: SnakeCell, direction: DirectionName): SnakeCell | null {
  const vector = DIRECTION_VECTORS[direction];
  const next = { right: cell.right + vector.right, forward: cell.forward + vector.forward };
  if (next.right < 0 || next.right >= COLUMNS || next.forward < 0 || next.forward >= ROWS) {
    return null;
  }
  return next;
}

/** Cells of a snake body that block movement this tick: everything but the
 *  tail cell, because the tail vacates unless the snake is mid-growth. */
function blockingKeys(segments: SnakeCell[], pendingGrowth: number, into: Set<string>): Set<string> {
  const stop = pendingGrowth > 0 ? segments.length : segments.length - 1;
  for (let i = 0; i < stop; i += 1) into.add(gridCellKey(segments[i]));
  return into;
}

class SnakeBrain {
  private readonly planner: GridPathPlanner;

  constructor(private readonly weights: BrainWeights) {
    this.planner = new GridPathPlanner({
      navigation: GRID_NAVIGATION,
      columns: COLUMNS,
      rows: ROWS,
      wrap: false,
    });
  }

  choose(senses: BrainSenses): DirectionName {
    const head = senses.segments[0];
    const target = this.nearestApple(head, senses.apples);
    const opponentKeys = new Set<string>();
    for (const cell of senses.opponentSegments) opponentKeys.add(gridCellKey(cell));

    let best: DirectionName | null = null;
    let bestScore = -Infinity;
    for (const direction of DIRECTION_NAMES) {
      if (direction === OPPOSITE[senses.direction]) continue;
      const score = this.scoreMove(direction, senses, target, opponentKeys);
      if (score === null || score <= bestScore) continue;
      best = direction;
      bestScore = score;
    }
    return best ?? senses.direction;
  }

  private nearestApple(head: SnakeCell, apples: SnakeCell[]): SnakeCell | null {
    let nearest: SnakeCell | null = null;
    let nearestDistance = Infinity;
    for (const apple of apples) {
      const distance = this.planner.heuristic(head, apple);
      if (distance >= nearestDistance) continue;
      nearest = apple;
      nearestDistance = distance;
    }
    return nearest;
  }

  private scoreMove(
    direction: DirectionName,
    senses: BrainSenses,
    target: SnakeCell | null,
    opponentKeys: ReadonlySet<string>,
  ): number | null {
    const head = senses.segments[0];
    const nextHead = stepInBounds(head, direction);
    if (!nextHead) return null;

    const blockedNow = blockingKeys(senses.segments, senses.pendingGrowth, new Set(opponentKeys));
    if (blockedNow.has(gridCellKey(nextHead))) return null;

    // Simulate the move, then judge the world the snake would wake up in.
    const nextSegments = [nextHead, ...senses.segments];
    if (senses.pendingGrowth <= 0) nextSegments.pop();
    const growthAfter = senses.pendingGrowth > 0 ? senses.pendingGrowth - 1 : 0;
    const blockedNext = blockingKeys(nextSegments, growthAfter, new Set(opponentKeys));

    const flood = this.planner.floodFill(nextHead, blockedNext, true, false);
    let appleCost = COLUMNS * ROWS;
    if (target) {
      const path = this.planner.findPath(nextHead, target, blockedNext, true, true, false);
      if (path) appleCost = Math.max(0, path.length - 1) * this.weights.appleDistanceWeight;
    }
    const tail = nextSegments[nextSegments.length - 1] ?? nextHead;
    const tailPath = this.planner.findPath(nextHead, tail, blockedNext, true, true, false);

    return (
      flood.count * this.weights.spaceWeight -
      appleCost +
      (tailPath ? this.weights.tailReachBonus : 0) +
      (direction === senses.direction ? this.weights.straightBias : 0)
    );
  }
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type SnakeGameStatus = "running" | "gameover";

export interface SnakeProbe {
  /** scene3d handle of the game's one scene (0 in pure-mirror mode). */
  sceneId: number;
  /** Player head node id — the test reads its serialized pose. */
  playerHeadNodeId: number;
  steps: number;
  gridTicks: number;
  status: SnakeGameStatus;
  score: number;
  rivalScore: number;
  bestScore: number;
  playerLength: number;
  playerHead: SnakeCell;
  rivalLength: number;
  rivalHead: SnakeCell;
  /** Item pickups this boot, both snakes (playerItems + rivalItems). */
  itemsEaten: number;
  playerItems: number;
  rivalItems: number;
  playerDeaths: number;
  rivalDeaths: number;
  lastPlayerDeathReason: SnakeDeathReason | null;
  restarts: number;
}

export interface SnakeHudState {
  status: SnakeGameStatus;
  score: number;
  rivalScore: number;
  bestScore: number;
  length: number;
}

export interface SnakeGame {
  scene: Scene3D;
  /** One fixed 1/60 s simulation step (createGameLoop's `step`). */
  step(dt: number, input: GameInput): void;
  /** Fresh HUD snapshot (call from the loop's `render`). */
  hudState(): SnakeHudState;
}

interface SnakeVisual {
  root: SceneNode;
  /** Pooled chain: [0] is the head (eyes attached), rest are body cubes. */
  nodes: SceneNode[];
  shown: number;
}

interface AppleState extends SnakeCell {
  growth: number;
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

export function createSnakeGame(): SnakeGame {
  const scene = new Scene3D();
  const prng = new RandomGenerator(1337);

  // -- world: board plane, translucent grid, rim walls, lighting ---------------
  const board = new BoardEnvironment({
    scene,
    columns: COLUMNS,
    rows: ROWS,
    cellSize: CELL_SIZE,
    backgroundScale: 1.08,
    boardUp: -0.7,
    gridUp: -0.68,
    groundColor: BOARD_GROUND,
    gridColor: BOARD_GRID,
    gridOpacity: 0.65,
    // Fixed-function lighting has no physical intensity; these are tuned so
    // ambient + sun sit inside the clamp (reference: 1.8 / 2.5 PBR).
    ambientIntensity: 0.62,
    keyLightColor: 0xfff2db,
    keyLightIntensity: 0.85,
    keyLightPosition: { right: 8, up: 18, forward: 10 },
  }).create();

  scene.sky(rgbToAbgr(BACKGROUND), rgbToAbgr(BACKGROUND));
  scene.fog(rgbToAbgr(BACKGROUND), 16, 38);
  scene.camera.fovY = (42 * Math.PI) / 180;
  scene.camera.zfar = 100;

  // Rim walls hugging the playfield (reference: 0.45 thick, 0.6 tall boxes).
  {
    const rimMaterial = scene.material(rgbToAbgr(RIM_COLOR), 0);
    const width = COLUMNS * CELL_SIZE;
    const depth = ROWS * CELL_SIZE;
    const centerRight = (COLUMNS - 1) * CELL_SIZE * 0.5;
    const centerForward = (ROWS - 1) * CELL_SIZE * 0.5;
    const alongRight = scene.box((width + 0.9) / 2, 0.3, 0.225);
    const alongForward = scene.box(0.225, 0.3, depth / 2);
    const placements: [number, number, number][] = [
      [centerRight, -0.65, 0],
      [centerRight, depth - 0.35, 0],
      [-0.65, centerForward, 1],
      [width - 0.35, centerForward, 1],
    ];
    for (const [right, forward, axis] of placements) {
      scene
        .mesh(axis === 0 ? alongRight : alongForward, rimMaterial)
        .position.copy(board.worldPoint(right, -0.4, forward));
    }
  }

  // -- snake + apple visuals (pooled; nothing allocates after boot) ------------
  const eulerScratch = new Euler();

  function buildSnakeVisual(bodyColor: number, headColor: number): SnakeVisual {
    const root = scene.node();
    const bodyGeom = scene.box(0.39, 0.31, 0.39); // reference 0.78 × 0.62 × 0.78
    const headGeom = scene.box(0.42, 0.34, 0.42); // reference 0.84 × 0.68 × 0.84
    const bodyMat = scene.material(rgbToAbgr(bodyColor), 0);
    const headMat = scene.material(rgbToAbgr(headColor), 0);
    const eyeGeom = scene.sphere(0.055, 10);
    const eyeMat = scene.material(rgbToAbgr(EYE_COLOR), 0);

    const nodes: SceneNode[] = [];
    for (let i = 0; i < MAX_SEGMENTS; i += 1) {
      const node = scene.mesh(i === 0 ? headGeom : bodyGeom, i === 0 ? headMat : bodyMat, root);
      if (i === 0) {
        scene.mesh(eyeGeom, eyeMat, node).position.set(-0.17, 0.12, 0.33);
        scene.mesh(eyeGeom, eyeMat, node).position.set(0.17, 0.12, 0.33);
      }
      node.visible = false;
      nodes.push(node);
    }
    return { root, nodes, shown: 0 };
  }

  const playerVisual = buildSnakeVisual(PLAYER_BODY, PLAYER_HEAD);
  const rivalVisual = buildSnakeVisual(RIVAL_BODY, RIVAL_HEAD);

  // One apple on the board at a time (reference invariant), so one node group.
  const apple = scene.node();
  scene.mesh(scene.sphere(0.28, 18), scene.material(rgbToAbgr(APPLE_BODY), 0), apple);
  const stem = scene.mesh(scene.cylinder(0.03, 0.04, 0.2, 10), scene.material(rgbToAbgr(APPLE_STEM), 0), apple);
  stem.position.y = 0.28;
  stem.quaternion.setFromEuler(eulerScratch.set(0, 0, -0.28));
  const leaf = scene.mesh(scene.sphere(0.12, 12), scene.material(rgbToAbgr(APPLE_LEAF), 0), apple);
  leaf.position.set(0.12, 0.34, 0.02);
  leaf.scale.set(1.45, 0.55, 1);
  leaf.quaternion.setFromEuler(eulerScratch.set(0, 0, 0.6));

  // -- fixed camera: one tilted pose framing the whole board -------------------
  new PositionFollowCameraRig({
    azimuth: 0,
    distance: 13.5,
    height: 17.5,
  }).step({ targetPosition: board.center, snapToTarget: true, camera: scene.camera });

  // -- sim state ----------------------------------------------------------------
  const playerMotion = new SnakeMotionController({
    initialLength: INITIAL_LENGTH,
    initialDirection: DIRECTION_VECTORS.right,
    startCell: PLAYER_START,
    mode: "cardinal",
  });
  const rivalMotion = new SnakeMotionController({
    initialLength: INITIAL_LENGTH,
    initialDirection: DIRECTION_VECTORS.left,
    startCell: RIVAL_START,
    mode: "cardinal",
  });
  const rivalBrain = new SnakeBrain(RIVAL_WEIGHTS);

  let status: SnakeGameStatus = "running";
  let score = 0;
  let rivalScore = 0;
  let bestScore = 0;
  let apples: AppleState[] = [];
  let pendingDirection: DirectionName | null = null;
  let stepsUntilTick = tickSteps(0);
  let previousButtons = 0;

  const probe: SnakeProbe = {
    sceneId: scene.__scene,
    playerHeadNodeId: playerVisual.nodes[0].__id,
    steps: 0,
    gridTicks: 0,
    status,
    score: 0,
    rivalScore: 0,
    bestScore: 0,
    playerLength: INITIAL_LENGTH,
    playerHead: { ...PLAYER_START },
    rivalLength: INITIAL_LENGTH,
    rivalHead: { ...RIVAL_START },
    itemsEaten: 0,
    playerItems: 0,
    rivalItems: 0,
    playerDeaths: 0,
    rivalDeaths: 0,
    lastPlayerDeathReason: null,
    restarts: 0,
  };
  (globalThis as Record<string, unknown>).__snakeProbe = probe;

  function spawnAppleIfNeeded(): void {
    if (apples.length > 0 || status === "gameover") return;
    const occupied = new Set<string>();
    for (const cell of playerMotion.segments) occupied.add(gridCellKey(cell));
    for (const cell of rivalMotion.segments) occupied.add(gridCellKey(cell));
    const freeCells: SnakeCell[] = [];
    for (let forward = 0; forward < ROWS; forward += 1) {
      for (let right = 0; right < COLUMNS; right += 1) {
        const cell = { right, forward };
        if (!occupied.has(gridCellKey(cell))) freeCells.push(cell);
      }
    }
    if (freeCells.length === 0) return;
    const pick = freeCells[Math.floor(prng.random() * freeCells.length)];
    apples.push({ ...pick, growth: 1 });
  }

  function resetRun(): void {
    playerMotion.reset({});
    rivalMotion.reset({});
    status = "running";
    score = 0;
    rivalScore = 0;
    apples = [];
    pendingDirection = null;
    stepsUntilTick = tickSteps(0);
    spawnAppleIfNeeded();
  }

  spawnAppleIfNeeded();

  function respawnRival(): void {
    rivalMotion.reset({});
    probe.rivalDeaths += 1;
  }

  function gridTick(): void {
    // The rival decides against the player's pre-move body (reference order).
    const rivalDirection = rivalBrain.choose({
      segments: rivalMotion.getSegments(),
      direction: directionName(rivalMotion.getDirection()),
      pendingGrowth: rivalMotion.pendingGrowth,
      opponentSegments: playerMotion.getSegments(),
      apples,
    });
    const playerDirection = pendingDirection ?? directionName(playerMotion.getDirection());
    pendingDirection = null;

    playerMotion.move(moveFlags(playerDirection));
    rivalMotion.move(moveFlags(rivalDirection));

    // Fresh referee over the post-move boards (SnakePlay is per-tick state).
    const play = new SnakePlay({ minRight: 0, maxRight: COLUMNS - 1, minForward: 0, maxForward: ROWS - 1 });
    play.addPlayer({ playerId: "player", segments: playerMotion.getSegments() });
    play.addPlayer({ playerId: "rival", segments: rivalMotion.getSegments() });
    for (const item of apples) play.addItem({ cell: item, growth: item.growth });

    const events = play.step();
    apples = play.getItemState().map((item) => ({ ...item.cell, growth: item.growth }));

    let rivalDied = false;
    for (const event of events) {
      if (event.type === SNAKE_PLAY_EVENTS.ITEM_PICKED_UP) {
        const points = Math.max(1, Math.floor(event.growBy));
        if (event.playerId === "player") {
          score += points;
          bestScore = Math.max(bestScore, score);
          playerMotion.grow(points);
          probe.playerItems += 1;
        } else {
          rivalScore += points;
          rivalMotion.grow(points);
          probe.rivalItems += 1;
        }
        probe.itemsEaten += 1;
      } else if (event.playerId === "player") {
        status = "gameover";
        bestScore = Math.max(bestScore, score);
        probe.playerDeaths += 1;
        probe.lastPlayerDeathReason = event.reason;
      } else {
        rivalDied = true;
      }
    }
    if (rivalDied && status === "running") respawnRival();

    spawnAppleIfNeeded();
    probe.gridTicks += 1;
  }

  // -- presentation (guest-side mirrors; render() flushes once a frame) --------
  function syncSnakeVisual(visual: SnakeVisual, motion: SnakeMotionController, nowMs: number): void {
    const segments = motion.segments;
    const shown = Math.min(segments.length, MAX_SEGMENTS);
    for (let i = visual.shown; i < shown; i += 1) visual.nodes[i].visible = true;
    for (let i = shown; i < visual.shown; i += 1) visual.nodes[i].visible = false;
    visual.shown = shown;

    const yaw = HEAD_YAW[directionName(motion.getDirection())];
    for (let i = 0; i < shown; i += 1) {
      const node = visual.nodes[i];
      // Reference idle motion: gentle bob, head slightly proud of the body.
      const bob =
        i === 0
          ? Math.sin(nowMs * 0.008) * 0.035
          : Math.sin(nowMs * 0.006 - i * 0.55) * 0.02;
      node.position.copy(board.cellToWorldPoint(segments[i], 0.12 + bob));
      if (i === 0) {
        node.quaternion.setFromEuler(eulerScratch.set(0, yaw, 0));
      } else {
        const shrink = Math.max(0.82, 1 - i * 0.015);
        node.scale.set(shrink, shrink, shrink);
      }
    }
  }

  function syncAppleVisual(nowMs: number): void {
    const item = apples[0];
    apple.visible = item !== undefined;
    if (!item) return;
    apple.position.copy(board.cellToWorldPoint(item, 0.25 + Math.sin(nowMs * 0.005) * 0.08));
    apple.quaternion.setFromEuler(eulerScratch.set(0, nowMs * 0.0012, 0));
  }

  // -- fixed step ---------------------------------------------------------------
  function step(_dt: number, input: GameInput): void {
    const pressed = input.buttons & ~previousButtons;
    previousButtons = input.buttons;

    if (status === "running") {
      if (pressed & BTN.UP) pendingDirection = "up";
      else if (pressed & BTN.RIGHT) pendingDirection = "right";
      else if (pressed & BTN.DOWN) pendingDirection = "down";
      else if (pressed & BTN.LEFT) pendingDirection = "left";

      stepsUntilTick -= 1;
      if (stepsUntilTick <= 0) {
        gridTick();
        stepsUntilTick = tickSteps(score);
      }
    } else if (pressed & (BTN.CROSS | BTN.START)) {
      resetRun();
      probe.restarts += 1;
    }

    probe.steps += 1;
    const nowMs = probe.steps * STEP_MS; // virtual time for idle animation
    syncSnakeVisual(playerVisual, playerMotion, nowMs);
    syncSnakeVisual(rivalVisual, rivalMotion, nowMs);
    syncAppleVisual(nowMs);

    probe.status = status;
    probe.score = score;
    probe.rivalScore = rivalScore;
    probe.bestScore = bestScore;
    probe.playerLength = playerMotion.length;
    probe.playerHead = playerMotion.head ?? probe.playerHead;
    probe.rivalLength = rivalMotion.length;
    probe.rivalHead = rivalMotion.head ?? probe.rivalHead;
  }

  function hudState(): SnakeHudState {
    return {
      status,
      score,
      rivalScore,
      bestScore,
      length: playerMotion.length,
    };
  }

  return { scene, step, hudState };
}
