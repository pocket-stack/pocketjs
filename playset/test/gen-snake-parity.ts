// playset/test/gen-snake-parity.ts — the SNAKE exactness golden that pins the
// native integer sim core (pocket3d/crates/pocket-playset/src/snake.rs) against
// the TS reference (demos/snake/game.ts).
//
// RUN WITH:
//
//     bun playset/test/gen-snake-parity.ts
//
// from the repo root. It prints a Rust `const` block (the scripted button tape
// as run-length masks, plus one row per grid tick: apple cell + scores +
// lengths + head cells) that is pasted verbatim into the `#[cfg(test)]` module
// of snake.rs. Regenerate and re-paste whenever the demo or the tape changes;
// the block is deterministic (no wall clock, no paths).
//
// WHY A REPLICA, AND WHY IT IS STILL HONEST. demos/snake/game.ts keeps `apples`
// and the rival brain as closure-locals — createSnakeGame() exposes scores and
// head CELLS through __snakeProbe, but not the apple cell we most want to pin.
// So this generator re-runs the exact same composition (the SAME imported
// playset modules — SnakeMotionController, SnakePlay, GridPathPlanner,
// RandomGenerator — and the brain/tick/spawn logic copied verbatim from
// game.ts), which lets it read `apples` directly. It is NOT trusted on faith:
// it boots createSnakeGame() alongside on the identical mask tape and asserts,
// after every one of the 600 steps, that the replica's observable state equals
// game.ts's live __snakeProbe (status, scores, best, lengths, both head cells,
// item counts, deaths, restarts, ticks). If the demo's brain ever drifts, this
// throws — so the apples the replica dumps ARE the demo's apples.
//
// Unlike the rally fixture (f32 vs f64 → BOUNDED divergence), snake is integer
// logic: the native core must match the reference cell-for-cell, tick-for-tick.
// The only non-integer input is the seeded apple pick, and it is done in a way
// that is bit-identical across engines (see snake.rs's PRNG note).

import { BTN, FIXED_DT } from "../../spec/spec.ts";
import { scriptToMasks, type ScriptEvent } from "../../host-sim/sim.ts";
import { RandomGenerator } from "../modules/math/random-utils.ts";
import {
  SnakeMotionController,
  type SnakeCell,
} from "../modules/actor-motion/snake-motion-controller.ts";
import { SNAKE_PLAY_EVENTS, SnakePlay } from "../modules/gameplay/snake-play.ts";
import {
  GridPathPlanner,
  gridCellKey,
  type GridNavigation,
} from "../modules/behavior/grid-path-planner.ts";
import { createSnakeGame, type SnakeProbe } from "../../demos/snake/game.ts";

// ---------------------------------------------------------------------------
// Behavior spec — copied verbatim from demos/snake/game.ts
// ---------------------------------------------------------------------------

const COLUMNS = 16;
const ROWS = 16;
const INITIAL_LENGTH = 4;
const BASE_TICK_MS = 150;
const MIN_TICK_MS = 70;
const SPEEDUP_MS_PER_POINT = 4;
const STEP_MS = 1000 / 60;
const PLAYER_START: SnakeCell = { right: 3, forward: 8 };
const RIVAL_START: SnakeCell = { right: COLUMNS - 4, forward: 3 };

type DirectionName = "up" | "right" | "down" | "left";
const DIRECTION_NAMES: readonly DirectionName[] = ["up", "right", "down", "left"];
const DIRECTION_VECTORS: Readonly<Record<DirectionName, SnakeCell>> = {
  up: { right: 0, forward: 1 },
  right: { right: 1, forward: 0 },
  down: { right: 0, forward: -1 },
  left: { right: -1, forward: 0 },
};
const OPPOSITE: Readonly<Record<DirectionName, DirectionName>> = {
  up: "down",
  right: "left",
  down: "up",
  left: "right",
};

function directionName(vector: SnakeCell): DirectionName {
  if (vector.right < 0) return "left";
  if (vector.right > 0) return "right";
  if (vector.forward > 0) return "up";
  return "down";
}

function moveFlags(direction: DirectionName) {
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

interface BrainWeights {
  spaceWeight: number;
  appleDistanceWeight: number;
  tailReachBonus: number;
  straightBias: number;
}
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
  if (next.right < 0 || next.right >= COLUMNS || next.forward < 0 || next.forward >= ROWS) return null;
  return next;
}

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
// The replica game (game.ts minus the visuals), instrumented for the fixture
// ---------------------------------------------------------------------------

interface AppleState extends SnakeCell {
  growth: number;
}

type DeathReason = "wall" | "self" | "snake" | null;

interface Observable {
  status: "running" | "gameover";
  score: number;
  rivalScore: number;
  bestScore: number;
  playerLength: number;
  playerHead: SnakeCell;
  rivalLength: number;
  rivalHead: SnakeCell;
  itemsEaten: number;
  playerItems: number;
  rivalItems: number;
  playerDeaths: number;
  rivalDeaths: number;
  lastPlayerDeathReason: DeathReason;
  restarts: number;
  gridTicks: number;
  steps: number;
}

interface TickRow {
  step: number;
  apple: SnakeCell | null;
  score: number;
  rivalScore: number;
  playerLength: number;
  rivalLength: number;
  playerHead: SnakeCell;
  rivalHead: SnakeCell;
}

function runReplica(masks: number[]): { obs: Observable[]; ticks: TickRow[] } {
  const prng = new RandomGenerator(1337);
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

  let status: "running" | "gameover" = "running";
  let score = 0;
  let rivalScore = 0;
  let bestScore = 0;
  let apples: AppleState[] = [];
  let pendingDirection: DirectionName | null = null;
  let stepsUntilTick = tickSteps(0);
  let previousButtons = 0;

  // probe-equivalent counters
  let steps = 0;
  let gridTicks = 0;
  let itemsEaten = 0;
  let playerItems = 0;
  let rivalItems = 0;
  let playerDeaths = 0;
  let rivalDeaths = 0;
  let lastPlayerDeathReason: DeathReason = null;
  let restarts = 0;

  const ticks: TickRow[] = [];

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

  function respawnRival(): void {
    rivalMotion.reset({});
    rivalDeaths += 1;
  }

  function gridTick(): void {
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
          playerItems += 1;
        } else {
          rivalScore += points;
          rivalMotion.grow(points);
          rivalItems += 1;
        }
        itemsEaten += 1;
      } else if (event.playerId === "player") {
        status = "gameover";
        bestScore = Math.max(bestScore, score);
        playerDeaths += 1;
        lastPlayerDeathReason = event.reason;
      } else {
        rivalDied = true;
      }
    }
    if (rivalDied && status === "running") respawnRival();

    spawnAppleIfNeeded();
    gridTicks += 1;

    ticks.push({
      step: steps, // step index of the step that fired this tick (pre-increment)
      apple: apples[0] ? { right: apples[0].right, forward: apples[0].forward } : null,
      score,
      rivalScore,
      playerLength: playerMotion.length,
      rivalLength: rivalMotion.length,
      playerHead: playerMotion.head ?? { ...PLAYER_START },
      rivalHead: rivalMotion.head ?? { ...RIVAL_START },
    });
  }

  // Initial apple, exactly like game.ts's boot-time spawnAppleIfNeeded().
  spawnAppleIfNeeded();

  const obs: Observable[] = [];
  for (const buttons of masks) {
    const pressed = buttons & ~previousButtons;
    previousButtons = buttons;

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
      restarts += 1;
    }

    steps += 1;
    obs.push({
      status,
      score,
      rivalScore,
      bestScore,
      playerLength: playerMotion.length,
      playerHead: playerMotion.head ?? { ...PLAYER_START },
      rivalLength: rivalMotion.length,
      rivalHead: rivalMotion.head ?? { ...RIVAL_START },
      itemsEaten,
      playerItems,
      rivalItems,
      playerDeaths,
      rivalDeaths,
      lastPlayerDeathReason,
      restarts,
      gridTicks,
      steps,
    });
  }
  return { obs, ticks };
}

// ---------------------------------------------------------------------------
// The tape and the fidelity gate
// ---------------------------------------------------------------------------

const SECONDS = 10;
const HZ = 60;
// A death + restart + post-restart play, well inside 10 s: turn pulses walk the
// player around, a held DOWN from 4.0 s runs it into the bottom wall, a CROSS
// pulse on the game-over card restarts the run, then more turns.
const SCRIPT: ScriptEvent[] = [
  { at: 0.6, press: BTN.UP },
  { at: 1.5, press: BTN.LEFT },
  { at: 2.1, press: BTN.DOWN },
  { at: 3.3, press: BTN.RIGHT },
  { at: 4.0, hold: BTN.DOWN },
  { at: 5.6, hold: 0 },
  { at: 6.0, press: BTN.CROSS },
  { at: 7.4, press: BTN.UP },
  { at: 8.3, press: BTN.LEFT },
  { at: 9.4, press: BTN.DOWN },
];

const frames = SECONDS * HZ;
const { masks } = scriptToMasks(SCRIPT, HZ, frames);

// -- pass A: the live demo, sampled through its probe -------------------------
const game = createSnakeGame();
const probeSnaps: SnakeProbe[] = [];
for (let f = 0; f < frames; f++) {
  game.step(FIXED_DT, { buttons: masks[f], analogX: 0, analogY: 0 });
  const p = (globalThis as { __snakeProbe?: SnakeProbe }).__snakeProbe;
  if (!p) throw new Error("gen-snake-parity: game.ts did not install globalThis.__snakeProbe");
  probeSnaps.push({ ...p, playerHead: { ...p.playerHead }, rivalHead: { ...p.rivalHead } });
}

// -- pass B: the replica (reads apples), gated against pass A -----------------
const { obs, ticks } = runReplica(masks);

function cell(a: SnakeCell): string {
  return `${a.right}:${a.forward}`;
}
for (let f = 0; f < frames; f++) {
  const p = probeSnaps[f];
  const o = obs[f];
  const mismatches: string[] = [];
  const check = (name: string, a: unknown, b: unknown): void => {
    if (a !== b) mismatches.push(`${name}: demo=${String(a)} replica=${String(b)}`);
  };
  check("status", p.status, o.status);
  check("score", p.score, o.score);
  check("rivalScore", p.rivalScore, o.rivalScore);
  check("bestScore", p.bestScore, o.bestScore);
  check("playerLength", p.playerLength, o.playerLength);
  check("rivalLength", p.rivalLength, o.rivalLength);
  check("playerHead", cell(p.playerHead), cell(o.playerHead));
  check("rivalHead", cell(p.rivalHead), cell(o.rivalHead));
  check("itemsEaten", p.itemsEaten, o.itemsEaten);
  check("playerItems", p.playerItems, o.playerItems);
  check("rivalItems", p.rivalItems, o.rivalItems);
  check("playerDeaths", p.playerDeaths, o.playerDeaths);
  check("rivalDeaths", p.rivalDeaths, o.rivalDeaths);
  check("lastPlayerDeathReason", p.lastPlayerDeathReason, o.lastPlayerDeathReason);
  check("restarts", p.restarts, o.restarts);
  check("gridTicks", p.gridTicks, o.gridTicks);
  if (mismatches.length > 0) {
    throw new Error(`gen-snake-parity: replica diverged from demos/snake/game.ts at step ${f}:\n  ${mismatches.join("\n  ")}`);
  }
}

// ---------------------------------------------------------------------------
// Emit the Rust const block
// ---------------------------------------------------------------------------

const final = obs[obs.length - 1];

// Run-length the mask tape: 600 masks compress to a handful of runs.
const runs: [number, number][] = [];
for (let f = 0; f < frames; f++) {
  if (f === 0 || masks[f] !== masks[f - 1]) runs.push([f, masks[f]]);
}

const lines: string[] = [];
lines.push("    // ===== GENERATED by `bun playset/test/gen-snake-parity.ts` — do not hand-edit. =====");
lines.push(`    // ${SECONDS} s of the demos/snake/game.ts composition at ${HZ} Hz (${frames} steps),`);
lines.push("    // cross-checked step-for-step against the live __snakeProbe before emit.");
lines.push(`    const PARITY_STEPS: u32 = ${frames};`);
lines.push("    /// Run-length button tape: [first_step, spec_btn_mask], held until the next run.");
lines.push(`    const PARITY_MASKS: &[(u32, u32)] = &[`);
lines.push(runs.map(([f, m]) => `        (${f}, 0x${(m >>> 0).toString(16)}),`).join("\n"));
lines.push("    ];");
lines.push("    /// One row per grid tick, in tick order.");
lines.push("    /// [step, apple_right, apple_forward, score, rival_score, player_len, rival_len,");
lines.push("    ///  player_head_r, player_head_f, rival_head_r, rival_head_f]; apple -1,-1 = none.");
lines.push(`    const PARITY_TICKS: &[[i32; 11]] = &[`);
lines.push(
  ticks
    .map((t) => {
      const ar = t.apple ? t.apple.right : -1;
      const af = t.apple ? t.apple.forward : -1;
      return `        [${t.step}, ${ar}, ${af}, ${t.score}, ${t.rivalScore}, ${t.playerLength}, ${t.rivalLength}, ${t.playerHead.right}, ${t.playerHead.forward}, ${t.rivalHead.right}, ${t.rivalHead.forward}],`;
    })
    .join("\n"),
);
lines.push("    ];");
lines.push("    /// Final observable totals after the whole tape.");
lines.push(`    const PARITY_FINAL_SCORE: i32 = ${final.score};`);
lines.push(`    const PARITY_FINAL_RIVAL_SCORE: i32 = ${final.rivalScore};`);
lines.push(`    const PARITY_FINAL_BEST_SCORE: i32 = ${final.bestScore};`);
lines.push(`    const PARITY_FINAL_ITEMS_EATEN: i32 = ${final.itemsEaten};`);
lines.push(`    const PARITY_FINAL_PLAYER_DEATHS: i32 = ${final.playerDeaths};`);
lines.push(`    const PARITY_FINAL_RIVAL_DEATHS: i32 = ${final.rivalDeaths};`);
lines.push(`    const PARITY_FINAL_RESTARTS: i32 = ${final.restarts};`);
lines.push(`    const PARITY_FINAL_GRID_TICKS: i32 = ${final.gridTicks};`);

const out = lines.join("\n");

console.error(
  `gen-snake-parity: OK — replica matched game.ts for all ${frames} steps; ` +
    `${ticks.length} ticks, itemsEaten=${final.itemsEaten}, playerDeaths=${final.playerDeaths}, ` +
    `rivalDeaths=${final.rivalDeaths}, restarts=${final.restarts}, ` +
    `finalScore=${final.score}, finalRivalScore=${final.rivalScore}.`,
);
console.log(out);
