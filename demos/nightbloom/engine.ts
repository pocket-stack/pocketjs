// demos/nightbloom/engine.ts — the night engine: a vertical danmaku battle
// folded over the virtual clock. No JSX here; app.tsx is a thin renderer
// over these signals, which keeps the whole game host-agnostic and
// sim-testable — the tidelight architecture, applied to a bullet-hell.
//
// The player pilots one plant form at the bottom of the field, switches
// forms mid-fight (CIRCLE / L / R), holds CROSS to fire and SQUARE to focus,
// and answers the descending horde's patterns with per-form spell cards.
//
// Determinism contract (DETERMINISM.md):
//   - the world advances in MICRO-TICKS on the core's fixed 1/60 s grid: a
//     battle frame runs its FULL ticksPerFrame() batch (or none, for pause),
//     with the batch aligned so the tick count at virtual time t is exactly
//     (t - tStart) * 60 at every simulationHz — the 2 Hz world is a strict
//     subsample of the 60 Hz world, gameplay included;
//   - edge-detected input is applied on the FIRST tick of its host frame's
//     batch: a press at second P lands on battle tick (P - tStart) * 60 + 1
//     at every valid hz, which keeps input-driven runs subsample-exact;
//   - held input (movement, fire, focus) reads the raw held mask per tick:
//     a HOLD's level track goes true at the same battle tick at every rate,
//     so hold-driven tapes subsample exactly (one-frame pulses of held verbs
//     are not rate-portable; tapes steer with holds, as tidelight's cadence
//     rules already demand);
//   - pattern math uses a QUANTIZED sine table (1/8192 steps), because raw
//     Math.sin is not bit-specified across JS engines and a danmaku spiral
//     must replay byte-exactly on every host;
//   - randomness is one seeded xorshift32 stream drawn only inside ticks —
//     spawn slots are as replayable as everything else;
//   - float fx drift by battle-tick age; toasts expire through after() on
//     the virtual clock, epoch-guarded; the phase omen arrives through the
//     effect shell (backend.ts);
//   - sound is an OUTPUT: the engine pokes a host sound sink (sfx.ts) and
//     reads nothing back — hosts without WebAudio never install one, and
//     the simulation is byte-identical either way.

import { createSignal, type Accessor } from "solid-js";
import { after, ticksPerFrame } from "@pocketjs/framework/clock";
import { runEffect } from "@pocketjs/framework/effects";
import { BTN } from "@pocketjs/framework/input";
import {
  BANANA,
  BOSS,
  BOSS_AT,
  BOSS_PHASE_BOUNTY,
  CATNIP_GRAZE_MULT,
  CATNIP_GRAZE_R,
  FIELD,
  FOCUS_RATE,
  FOES,
  GRAZE_GLOW,
  GRAZE_R,
  HIT_R,
  HURT_INVULN,
  MIDBOSS,
  MIDBOSS_AT,
  MOTE_GLOW,
  NIGHT_SEED,
  PHASES,
  PLANT_ORDER,
  PLANTS,
  PLAYER_INSET,
  PLAYER_SPAWN,
  POC_Y,
  SAKURA_HEAL,
  SWITCH_COOLDOWN,
  TPS,
  UTA_HASTE,
  WAVES,
  WILT_WINDOW,
  type BossDef,
  type FoeId,
  type PhaseId,
  type PlantId,
  type SfxKind,
} from "./data.ts";

export type Outcome = "title" | "battle" | "dawn" | "eternal";

/** Poke the host's sound sink, if any (sfx.ts installs one where WebAudio
 *  exists). Pure OUTPUT: reads nothing back, so the sim is byte-identical
 *  with or without audio. */
function sfx(kind: SfxKind): void {
  const sink = (globalThis as Record<string, unknown>).__nightbloomSfx as ((k: SfxKind) => void) | undefined;
  if (sink) sink(kind);
}

// ---------------------------------------------------------------------------
// Quantized trig — bit-identical on every JS engine
// ---------------------------------------------------------------------------

/** 64-step sine table quantized to 1/8192: far coarser than any engine's
 *  last-ulp sin() divergence, so the values are cross-engine constants. */
const SIN: number[] = Array.from({ length: 64 }, (_, i) => Math.round(Math.sin((i / 64) * Math.PI * 2) * 8192) / 8192);
const sinA = (a: number): number => SIN[((a % 64) + 64) % 64];
const cosA = (a: number): number => SIN[(((a + 16) % 64) + 64) % 64];
/** Angle index pointing straight down (+y). 0 = +x, quarter turn = 16. */
const A_DOWN = 16;

// ---------------------------------------------------------------------------
// Reactive cells — a signal dressed as a readable-callable with .set()
// ---------------------------------------------------------------------------

export interface Cell<T> {
  (): T;
  set: (v: T) => void;
}

function cell<T>(v: T): Cell<T> {
  const [get, set] = createSignal<T>(v);
  const f = (() => get()) as Cell<T>;
  f.set = (nv: T) => void set(() => nv);
  return f;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface PlantState {
  kind: PlantId;
  stage: Cell<number>;
  hp: Cell<number>;
  glow: Cell<number>;
  /** 0..1 — spell readiness for the HUD arc. */
  spellReady: Cell<number>;
  spellCdTicks: number;
  /** Locked forms show as ? on the roster until the night wakes them. */
  unlocked: Cell<boolean>;
  /** Battle tick the form woke on (-1 = from the start) — drives the
   *  roster card's rainbow reveal sweep. */
  unlockedAt: Cell<number>;
}

export interface FoeInst {
  id: number;
  kind: FoeId;
  stage: number;
  x: Cell<number>;
  y: Cell<number>;
  hp: Cell<number>;
  /** wisp/uta hover altitude; usagi weave direction lives in vx. */
  hoverY: number;
  vx: number;
  fireCd: number;
  slowUntil: number;
  /** Hover ticks left before a wisp/uta drifts on down. */
  station: number;
}

export interface BossInst {
  def: BossDef;
  /** True for the midboss (waves resume after it breaks). */
  mid: boolean;
  phase: Cell<number>;
  hp: Cell<number>;
  x: Cell<number>;
  y: Cell<number>;
  timeoutTicks: number;
  fireCd: number;
  fireCd2: number;
  /** Spiral angle cursor (table index units). */
  spiral: number;
  born: number;
}

export type EnemyShotKind = "pink" | "cyan" | "amber" | "mochi";

export interface EnemyShot {
  id: number;
  kind: EnemyShotKind;
  x: Cell<number>;
  y: Cell<number>;
  vx: number;
  vy: number;
  dmg: number;
  grazed: boolean;
}

export type PlayerShotKind = "orb" | "petal" | "banana";

export interface PlayerShot {
  id: number;
  kind: PlayerShotKind;
  x: Cell<number>;
  y: Cell<number>;
  vx: number;
  vy: number;
  dmg: number;
  /** True damage ignores armor (petals, spells). */
  pierce: boolean;
  /** How many more bodies a bolt may pass through. */
  through: number;
  homing: boolean;
  /** Banana boomerang: true once it has turned and is flying home. */
  ret: boolean;
  /** Banana boomerang: ticks until it may damage again (it never despawns
   *  on a hit — it cuts through). */
  hitCd: number;
  /** Roster index that fired it — glow is credited to the worker. */
  owner: number;
}

export interface MoteInst {
  id: number;
  x: Cell<number>;
  y: Cell<number>;
}

export interface FloatFx {
  id: number;
  x: number;
  y: number;
  text: string;
  tone: "lumen" | "hurt" | "ward" | "evolve";
  born: number;
}

/** Float fx live this many ticks (0.9 s), pruned by the tick itself. */
export const FX_LIFE = 54;

export interface Toast {
  id: number;
  text: string;
}

export interface Nightbloom {
  outcome: Accessor<Outcome>;
  paused: Accessor<boolean>;
  /** 0 = closed, 1 = the pilot's manual, 2 = forms & foes. */
  codexPage: Accessor<number>;
  phase: Accessor<PhaseId>;
  augury: Accessor<string>;
  second: Accessor<number>;
  waveIdx: Accessor<number>;
  score: Accessor<number>;
  graze: Accessor<number>;
  kills: Accessor<number>;
  bestStage: Accessor<number>;
  /** The roast ledger: what the dawn medals tease you about. */
  escaped: Accessor<number>;
  hitsTaken: Accessor<number>;
  motesMissed: Accessor<number>;
  cardTimeouts: Accessor<number>;
  px: Accessor<number>;
  py: Accessor<number>;
  focus: Accessor<boolean>;
  invuln: Accessor<boolean>;
  activeIdx: Accessor<number>;
  roster: PlantState[];
  active: () => PlantState;
  /** -1 | 0 | 1 — the strafe direction, for the avatar's lean. */
  lastDx: Accessor<number>;
  /** 1 faces right (the art's rest pose), -1 mirrors left. */
  facing: Accessor<number>;
  /** The pilot is dead and the last-breath switch window is open. */
  wilting: Accessor<boolean>;
  wiltSeconds: Accessor<number>;
  foes: Accessor<FoeInst[]>;
  boss: Accessor<BossInst | null>;
  bossCard: Accessor<string>;
  bossCardSeconds: Accessor<number>;
  /** Battle tick of the last boss entry/metamorphosis, for the flash ring. */
  bossFlash: Accessor<number>;
  /** Ticks since the outcome settled — the end screens' own clock. */
  endTick: Accessor<number>;
  enemyShots: Accessor<EnemyShot[]>;
  playerShots: Accessor<PlayerShot[]>;
  motes: Accessor<MoteInst[]>;
  fxs: Accessor<FloatFx[]>;
  /** The battle tick, for age-deriving float fx drift and star parallax. */
  fxTick: Accessor<number>;
  toasts: Accessor<Toast[]>;
  frame: (buttons: number) => void;
  start: () => void;
  toTitle: () => void;
}

// Enemy contact/bullet damage by foe stage (bosses use the stage-3 value).
const BULLET_DMG = [9, 11, 13];
const RAM_DMG = 20;
/** Bullet cap — spawns beyond this are skipped, deterministically. */
const MAX_ENEMY_SHOTS = 72;
/** Hovering foes (wisp, uta) stay on station this long, then drift on. */
const STATION_TICKS = 8 * TPS;
/** The world scrolls on beneath everyone: even a hovering foe sinks with it,
 *  so an unkilled monster always leaves the field eventually. */
const WORLD_DRIFT = 10 / TPS;
const MAX_PLAYER_SHOTS = 40;
const MAX_MOTES = 24;

const SWITCH_TICKS = Math.round(SWITCH_COOLDOWN * TPS);
const HURT_TICKS = Math.round(HURT_INVULN * TPS);
/** Dawn sequence beats (in end-screen ticks): the score gets the stage
 *  first, then the medal slams on and lands. */
export const STAMP_AT = 120;
export const STAMP_IMPACT = 132;

export function createNightbloom(): Nightbloom {
  const outcome = cell<Outcome>("title");
  const paused = cell(false);
  const codexPage = cell(0);
  const phase = cell<PhaseId>("dusk");
  const augury = cell("");
  const second = cell(0);
  const waveIdx = cell(0);
  const score = cell(0);
  const graze = cell(0);
  const kills = cell(0);
  const bestStage = cell(1);
  const px = cell(PLAYER_SPAWN.x);
  const py = cell(PLAYER_SPAWN.y);
  const focus = cell(false);
  const invulnOn = cell(false);
  const activeIdx = cell(0);
  const foes = cell<FoeInst[]>([]);
  const boss = cell<BossInst | null>(null);
  const bossCard = cell("");
  const bossCardSeconds = cell(0);
  const enemyShots = cell<EnemyShot[]>([]);
  const playerShots = cell<PlayerShot[]>([]);
  const motes = cell<MoteInst[]>([]);
  const fxs = cell<FloatFx[]>([]);
  const toasts = cell<Toast[]>([]);
  const fxTick = cell(0);
  const bossFlash = cell(-1);
  const endTick = cell(0);

  const roster: PlantState[] = PLANT_ORDER.map((kind, i) => ({
    kind,
    stage: cell(1),
    hp: cell(PLANTS[kind].hp[0]),
    glow: cell(0),
    spellReady: cell(1),
    spellCdTicks: 0,
    unlocked: cell(i === 0), // only the catnip answers at dusk
    unlockedAt: cell(-1),
  }));

  let tick = 0;
  let prevButtons = 0;
  let rng = NIGHT_SEED >>> 0;
  let idSeq = 0;
  let epoch = 0;
  let nextWave = 0;
  let nextPhase = 0;
  let fireCd = 0;
  let switchCd = 0;
  let invulnTicks = 0;
  let midbossDone = false;
  let bossDone = false;
  let wallTicks = 0;
  let wiltTicks = 0;
  let rescues = 0;
  const escaped = cell(0);
  const hitsTaken = cell(0);
  const motesMissed = cell(0);
  const cardTimeouts = cell(0);
  const wilting = cell(false);
  const wiltSeconds = cell(0);
  const lastDx = cell(0);
  const facing = cell(1);

  // -- deterministic helpers ------------------------------------------------

  function rnd(n: number): number {
    rng ^= (rng << 13) >>> 0;
    rng = rng >>> 0;
    rng ^= rng >>> 17;
    rng ^= (rng << 5) >>> 0;
    rng = rng >>> 0;
    return rng % n;
  }

  function toast(text: string): void {
    const t: Toast = { id: ++idSeq, text };
    toasts.set([...toasts(), t]);
    const at = epoch;
    after(2.5, () => {
      if (at === epoch) toasts.set(toasts().filter((x) => x.id !== t.id));
    });
  }

  function fx(x: number, y: number, text: string, tone: FloatFx["tone"]): void {
    fxs.set([...fxs(), { id: ++idSeq, x, y, text, tone, born: tick }]);
  }

  const active = (): PlantState => roster[activeIdx()];
  const alive = (p: PlantState): boolean => p.hp() > 0;
  const ready = (p: PlantState): boolean => alive(p) && p.unlocked();

  function unlock(kind: PlantId, line: string): void {
    const p = roster.find((r) => r.kind === kind);
    if (!p || p.unlocked()) return;
    p.unlocked.set(true);
    p.unlockedAt.set(tick);
    toast(line);
    sfx("unlock");
  }
  const plantMaxHp = (p: PlantState): number => PLANTS[p.kind].hp[p.stage() - 1];

  // -- state churn -----------------------------------------------------------

  function reset(): void {
    epoch++;
    tick = 0;
    rng = NIGHT_SEED >>> 0;
    nextWave = 0;
    nextPhase = 0;
    fireCd = 0;
    switchCd = 0;
    invulnTicks = 0;
    midbossDone = false;
    bossDone = false;
    wallTicks = 0;
    phase.set("dusk");
    augury.set("");
    second.set(0);
    waveIdx.set(0);
    score.set(0);
    graze.set(0);
    kills.set(0);
    bestStage.set(1);
    px.set(PLAYER_SPAWN.x);
    py.set(PLAYER_SPAWN.y);
    focus.set(false);
    invulnOn.set(false);
    activeIdx.set(0);
    foes.set([]);
    boss.set(null);
    bossCard.set("");
    bossCardSeconds.set(0);
    enemyShots.set([]);
    playerShots.set([]);
    motes.set([]);
    fxs.set([]);
    toasts.set([]);
    fxTick.set(0);
    bossFlash.set(-1);
    endTick.set(0);
    wiltTicks = 0;
    rescues = 0;
    escaped.set(0);
    hitsTaken.set(0);
    motesMissed.set(0);
    cardTimeouts.set(0);
    wilting.set(false);
    wiltSeconds.set(0);
    lastDx.set(0);
    facing.set(1);
    roster.forEach((p, i) => {
      p.stage.set(1);
      p.hp.set(PLANTS[p.kind].hp[0]);
      p.glow.set(0);
      p.spellReady.set(1);
      p.spellCdTicks = 0;
      p.unlocked.set(i === 0);
      p.unlockedAt.set(-1);
    });
  }

  function start(): void {
    reset();
    outcome.set("battle");
  }

  function toTitle(): void {
    reset();
    outcome.set("title");
  }

  // -- evolution --------------------------------------------------------------

  function grantGlow(p: PlantState, amount: number): void {
    const def = PLANTS[p.kind];
    p.glow.set(p.glow() + amount);
    const s = p.stage();
    if (s < 3 && p.glow() >= def.evolveAt[s - 1]) {
      const frac = alive(p) ? p.hp() / plantMaxHp(p) : 0;
      p.stage.set(s + 1);
      if (alive(p)) p.hp.set(Math.max(1, Math.round(frac * plantMaxHp(p))));
      if (p.stage() > bestStage()) bestStage.set(p.stage());
      toast(`${def.name} ASCENDS: ${def.stageNames[p.stage() - 1]}`);
      fx(px(), py() - 14, "UP!", "evolve");
      sfx("evolve");
      if (p.stage() >= 2) unlock("sakura", "THE SAPLING WAKES -- SAKURA JOINS THE ROSTER");
    }
  }

  // -- spawning ---------------------------------------------------------------

  function spawnFoe(kind: FoeId, stage: number): void {
    const def = FOES[kind];
    const slot = FIELD.x0 + 26 + rnd(FIELD.w - 52);
    foes.set([
      ...foes(),
      {
        id: ++idSeq,
        kind,
        stage,
        x: cell(slot),
        y: cell(FIELD.y0 - 14),
        hp: cell(def.hp[stage - 1]),
        hoverY: FIELD.y0 + 30 + rnd(74),
        vx: rnd(2) === 0 ? 1 : -1,
        fireCd: Math.round(def.firePeriod[stage - 1] * TPS * 0.6),
        slowUntil: 0,
        station: STATION_TICKS,
      },
    ]);
  }

  function spawnBoss(def: BossDef, mid: boolean): void {
    boss.set({
      def,
      mid,
      phase: cell(0),
      hp: cell(def.phases[0].hp),
      x: cell(FIELD.x0 + FIELD.w / 2),
      y: cell(FIELD.y0 + 46),
      timeoutTicks: def.phases[0].timeout * TPS,
      fireCd: TPS,
      fireCd2: 2 * TPS,
      spiral: 0,
      born: tick,
    });
    bossCard.set(def.phases[0].card);
    bossCardSeconds.set(def.phases[0].timeout);
    bossFlash.set(tick);
    sfx(def.voice);
    toast(mid ? `${def.name} BARS THE WAY` : `${def.name} TAKES THE STAGE`);
  }

  function enemyFire(x: number, y: number, vx: number, vy: number, kind: EnemyShotKind, dmg: number): void {
    if (enemyShots().length >= MAX_ENEMY_SHOTS) return;
    enemyShots.set([...enemyShots(), { id: ++idSeq, kind, x: cell(x), y: cell(y), vx, vy, dmg, grazed: false }]);
  }

  function aimedAt(x: number, y: number, speed: number): { vx: number; vy: number } {
    const dx = px() - x;
    const dy = py() - y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    return { vx: (dx / len) * speed, vy: (dy / len) * speed };
  }

  function dropMotes(x: number, y: number, count: number): void {
    for (let i = 0; i < count; i++) {
      if (motes().length >= MAX_MOTES) return;
      motes.set([...motes(), { id: ++idSeq, x: cell(x + rnd(17) - 8), y: cell(y + rnd(9) - 4) }]);
    }
  }

  // -- damage ------------------------------------------------------------------

  /** Sakura's kindness: every damaging petal heals the most wounded waking
   *  form (self included) — the healer hits soft but keeps the roster alive. */
  function sakuraMend(owner: number): void {
    if (roster[owner]?.kind !== "sakura") return;
    let target: PlantState | null = null;
    let worst = 1;
    for (const r of roster) {
      if (!r.unlocked() || r.hp() <= 0) continue;
      const frac = r.hp() / PLANTS[r.kind].hp[r.stage() - 1];
      if (frac < worst) {
        worst = frac;
        target = r;
      }
    }
    if (!target) return;
    target.hp.set(Math.min(PLANTS[target.kind].hp[target.stage() - 1], target.hp() + SAKURA_HEAL));
    sfx("heal");
  }

  function hitFoe(f: FoeInst, dmg: number, pierce: boolean, owner: number): void {
    if (!foes().some((x) => x.id === f.id)) return;
    const def = FOES[f.kind];
    const eff = pierce ? dmg : Math.max(1, dmg - def.armor[f.stage - 1]);
    f.hp.set(f.hp() - eff);
    sfx("hit");
    sakuraMend(owner);
    const p = roster[owner];
    if (p) grantGlow(p, eff);
    if (f.hp() <= 0) {
      kills.set(kills() + 1);
      score.set(score() + 100);
      dropMotes(f.x(), f.y(), def.bounty[f.stage - 1]);
      foes.set(foes().filter((x) => x.id !== f.id));
      sfx("kill");
    }
  }

  function hitBoss(b: BossInst, dmg: number, owner: number): void {
    if (boss() !== b) return;
    b.hp.set(b.hp() - dmg);
    sfx("hit");
    sakuraMend(owner);
    const p = roster[owner];
    if (p) grantGlow(p, dmg);
    if (b.hp() <= 0) advanceBoss(b, true);
  }

  function advanceBoss(b: BossInst, broken: boolean): void {
    const idx = b.phase();
    if (broken) {
      score.set(score() + 1000);
      toast(`SPELL CARD BROKEN: ${b.def.phases[idx].card}`);
    } else {
      toast(`THE CARD TIMES OUT: ${b.def.phases[idx].card}`);
      cardTimeouts.set(cardTimeouts() + 1);
    }
    dropMotes(b.x(), b.y(), BOSS_PHASE_BOUNTY);
    enemyShots.set([]); // the break clears the sky
    sfx("bossbreak");
    if (idx + 1 < b.def.phases.length) {
      b.phase.set(idx + 1);
      b.hp.set(b.def.phases[idx + 1].hp);
      b.timeoutTicks = b.def.phases[idx + 1].timeout * TPS;
      b.spiral = 0;
      bossCard.set(b.def.phases[idx + 1].card);
      bossCardSeconds.set(b.def.phases[idx + 1].timeout);
      bossFlash.set(tick); // the metamorphosis
      sfx(b.def.voice);
    } else {
      boss.set(null);
      bossCard.set("");
      if (b.mid) {
        midbossDone = true;
        if (broken) kills.set(kills() + 1);
        unlock("primrose", "THE MOUNTAIN ANSWERS -- MOON PRIMROSE JOINS");
      } else {
        bossDone = true;
        if (broken) kills.set(kills() + 1);
        outcome.set("dawn");
        sfx("dawn");
      }
    }
  }

  function hurtPlayer(dmg: number): void {
    if (invulnTicks > 0 || wilting()) return;
    const p = active();
    const def = PLANTS[p.kind];
    const eff = Math.max(1, dmg - def.armor[p.stage() - 1]);
    p.hp.set(p.hp() - eff);
    hitsTaken.set(hitsTaken() + 1);
    invulnTicks = HURT_TICKS;
    fx(px(), py() - 12, `-${eff}`, "hurt");
    sfx("hurt");
    if (p.hp() <= 0) {
      p.hp.set(0);
      toast(`${def.name} WILTS`);
      sfx("wilt");
      // No pilot switches itself: if no waking form is left to switch to,
      // the night ends here. Otherwise the last breath opens — switch in
      // time or lose the run.
      const rescuable = roster.some((r, i) => i !== activeIdx() && ready(r));
      if (!rescuable) {
        outcome.set("eternal");
        sfx("eternal");
        return;
      }
      wiltTicks = Math.round(WILT_WINDOW * TPS);
      wilting.set(true);
      wiltSeconds.set(WILT_WINDOW);
      toast("SWITCH -- NOW");
    }
  }

  // -- player actions ------------------------------------------------------------

  function switchTo(delta: number): void {
    if (switchCd > 0) return;
    const n = roster.length;
    let idx = activeIdx();
    for (let i = 0; i < n; i++) {
      idx = (idx + delta + n) % n;
      if (ready(roster[idx])) break;
    }
    if (idx === activeIdx() || !ready(roster[idx])) return;
    activeIdx.set(idx);
    switchCd = SWITCH_TICKS;
    if (wilting()) {
      // the last-breath rescue
      wilting.set(false);
      wiltTicks = 0;
      rescues++;
      invulnTicks = HURT_TICKS;
    }
    toast(`NOW PILOTING: ${PLANTS[roster[idx].kind].name}`);
    sfx("switch");
  }

  function fireVolley(): void {
    const p = active();
    const def = PLANTS[p.kind];
    const s = p.stage() - 1;
    if (playerShots().length >= MAX_PLAYER_SHOTS) return;
    const shots = playerShots();
    const add: PlayerShot[] = [];
    const owner = activeIdx();
    const streams = def.streams[s];
    if (p.kind === "catnip") {
      for (let i = 0; i < streams; i++) {
        add.push({
          id: ++idSeq, kind: "orb", x: cell(px() + (i - (streams - 1) / 2) * 10), y: cell(py() - 10),
          vx: 0, vy: -170, dmg: def.dmg[s], pierce: false, through: 0, homing: true, ret: false, hitCd: 0, owner,
        });
      }
    } else if (p.kind === "sakura") {
      for (let i = 0; i < streams; i++) {
        const a = -16 + (i - (streams - 1) / 2) * 2; // fan around straight up
        add.push({
          id: ++idSeq, kind: "petal", x: cell(px()), y: cell(py() - 10),
          vx: cosA(a) * 150, vy: sinA(a) * 150, dmg: def.dmg[s], pierce: true, through: 0, homing: false, ret: false, hitCd: 0, owner,
        });
      }
    } else {
      // the gorilla: banana boomerangs — at most BANANA.max aloft, and a
      // throw only leaves a hand that holds one
      const aloft = shots.filter((sh) => sh.kind === "banana").length;
      if (aloft >= BANANA.max) {
        fireCd = 6; // hands empty — look again shortly
        return;
      }
      add.push({
        id: ++idSeq, kind: "banana", x: cell(px()), y: cell(py() - 12),
        vx: 0, vy: -BANANA.throwVy[s], dmg: def.dmg[s], pierce: false, through: 0,
        homing: false, ret: false, hitCd: 0, owner,
      });
    }
    playerShots.set([...shots, ...add]);
    fireCd = Math.round(def.period[s] * TPS);
    sfx("shoot");
  }

  function castSpell(): void {
    const p = active();
    if (p.spellCdTicks > 0 || wilting()) return;
    const def = PLANTS[p.kind];
    const owner = activeIdx();
    if (p.kind === "catnip") {
      const add: PlayerShot[] = [];
      for (let i = 0; i < 9; i++) {
        add.push({
          id: ++idSeq, kind: "orb", x: cell(px()), y: cell(py() - 8),
          vx: cosA(-32 + i * 7) * 120, vy: sinA(-32 + i * 7) * 120 - 60,
          dmg: 24, pierce: true, through: 0, homing: true, ret: false, hitCd: 0, owner,
        });
      }
      playerShots.set([...playerShots(), ...add]);
      enemyShots.set(enemyShots().filter((sh) => {
        const dx = sh.x() - px();
        const dy = sh.y() - py();
        return dx * dx + dy * dy > 70 * 70;
      }));
    } else if (p.kind === "sakura") {
      for (const f of [...foes()]) {
        hitFoe(f, 18, true, owner);
        f.slowUntil = tick + 2 * TPS;
      }
      const b = boss();
      if (b) hitBoss(b, 18, owner);
      enemyShots.set([]);
    } else {
      for (const r of roster) if (ready(r)) grantGlow(r, 100);
    }
    toast(`SPELL CARD: ${def.spell.name}`);
    sfx("spell");
    p.spellCdTicks = def.spell.cooldown * TPS;
  }

  // -- ticks -------------------------------------------------------------------

  function tickWavesAndBosses(): void {
    while (nextPhase < PHASES.length && tick >= PHASES[nextPhase].at * TPS) {
      const p = PHASES[nextPhase];
      phase.set(p.id);
      if (nextPhase > 0) toast(`THE NIGHT DEEPENS: ${p.name}`);
      const at = epoch;
      runEffect<{ omen: string }>("augury", { phase: p.id }, (res) => {
        if (at === epoch) augury.set(res.omen);
      });
      nextPhase++;
    }
    while (nextWave < WAVES.length && tick >= WAVES[nextWave].at * TPS) {
      const stage = PHASES[Math.max(0, nextPhase - 1)].foeStage;
      for (const kind of WAVES[nextWave].spawn) spawnFoe(kind, stage);
      waveIdx.set(nextWave + 1);
      nextWave++;
    }
    if (!midbossDone && !boss() && tick >= MIDBOSS_AT * TPS) spawnBoss(MIDBOSS, true);
    if (midbossDone && !bossDone && !boss() && tick >= BOSS_AT * TPS) spawnBoss(BOSS, false);
  }

  // Held verbs (movement, fire, focus) read the RAW held mask: a hold
  // event's level track goes true at the same battle tick at every rate, so
  // hold-driven tapes subsample exactly. (A one-frame PULSE of these buttons
  // is NOT rate-portable — it holds for a whole batch at low rates — which
  // is why the tape discipline steers the ship with holds only.)
  function tickPlayer(held: number): void {
    const p = active();
    const def = PLANTS[p.kind];
    const focusing = Boolean(held & BTN.SQUARE);
    focus.set(focusing);
    const speed = (def.speed / TPS) * (focusing ? FOCUS_RATE : 1);
    let dx = 0;
    let dy = 0;
    if (held & BTN.LEFT) dx -= 1;
    if (held & BTN.RIGHT) dx += 1;
    if (held & BTN.UP) dy -= 1;
    if (held & BTN.DOWN) dy += 1;
    if (dx !== 0 && dy !== 0) {
      dx *= 0.7071;
      dy *= 0.7071;
    }
    lastDx.set(Math.sign(dx));
    if (dx !== 0) facing.set(dx < 0 ? -1 : 1); // mirror into the strafe, keep it after
    px.set(Math.max(FIELD.x0 + PLAYER_INSET, Math.min(FIELD.x0 + FIELD.w - PLAYER_INSET, px() + dx * speed)));
    py.set(Math.max(FIELD.y0 + PLAYER_INSET, Math.min(FIELD.y0 + FIELD.h - PLAYER_INSET, py() + dy * speed)));

    if (wilting()) {
      wiltTicks--;
      wiltSeconds.set(Math.max(0, Math.ceil(wiltTicks / TPS)));
      if (wiltTicks <= 0) {
        outcome.set("eternal");
        sfx("eternal");
        return;
      }
    }
    if (fireCd > 0) fireCd--;
    if (held & BTN.CROSS && fireCd <= 0 && !wilting()) fireVolley();

    if (switchCd > 0) switchCd--;
    if (invulnTicks > 0) invulnTicks--;
    invulnOn.set(invulnTicks > 0);

    for (const r of roster) {
      if (r.spellCdTicks > 0) r.spellCdTicks--;
      r.spellReady.set(1 - r.spellCdTicks / (PLANTS[r.kind].spell.cooldown * TPS));
    }
  }

  function tickFoes(): void {
    const hasUta = foes().some((f) => f.kind === "uta");
    for (const f of [...foes()]) {
      if (!foes().some((x) => x.id === f.id)) continue;
      const def = FOES[f.kind];
      const s = f.stage - 1;
      const slowed = tick < f.slowUntil;
      const rate = slowed ? 0.6 : 1;
      const spd = (def.speed[s] / TPS) * rate;
      if (f.kind === "usagi") {
        f.x.set(f.x() + f.vx * spd);
        f.y.set(f.y() + spd * 0.35);
        if (f.x() < FIELD.x0 + 14) f.vx = 1;
        if (f.x() > FIELD.x0 + FIELD.w - 14) f.vx = -1;
      } else if (f.kind === "wisp" || f.kind === "uta") {
        if (f.y() < f.hoverY) {
          f.y.set(f.y() + spd);
        } else if (f.station > 0) {
          f.station--;
          f.x.set(f.x() + f.vx * spd * 0.5);
          f.y.set(f.y() + WORLD_DRIFT); // the view slides forward regardless
        } else {
          f.y.set(f.y() + spd * 1.4); // the song moves on
        }
        if (f.x() < FIELD.x0 + 14) f.vx = 1;
        if (f.x() > FIELD.x0 + FIELD.w - 14) f.vx = -1;
      } else {
        f.y.set(f.y() + spd);
      }
      if (f.y() > FIELD.y0 + FIELD.h + 18) {
        foes.set(foes().filter((x) => x.id !== f.id)); // it drifts past the garden
        escaped.set(escaped() + 1);
        continue;
      }
      // fire
      f.fireCd -= hasUta && f.kind !== "uta" ? 1 / UTA_HASTE : 1;
      if (f.fireCd <= 0 && f.y() > FIELD.y0 + 6) {
        f.fireCd = Math.round(def.firePeriod[s] * TPS * (slowed ? 1.6 : 1));
        const dmg = BULLET_DMG[s];
        const shotSpeed = def.shotSpeed[s];
        if (f.kind === "wisp") {
          const n = f.stage;
          for (let i = 0; i < n; i++) {
            const v = aimedAt(f.x(), f.y(), shotSpeed);
            const a = (i - (n - 1) / 2) * 3;
            enemyFire(
              f.x(), f.y() + 8,
              v.vx * cosA(a) - v.vy * sinA(a),
              v.vx * sinA(a) + v.vy * cosA(a),
              "cyan", dmg,
            );
          }
        } else if (f.kind === "kasa") {
          const n = 3 + f.stage * 2;
          for (let i = 0; i < n; i++) {
            const a = A_DOWN + (i - (n - 1) / 2) * 4;
            enemyFire(f.x(), f.y() + 8, cosA(a) * shotSpeed, sinA(a) * shotSpeed, "amber", dmg);
          }
        } else if (f.kind === "usagi") {
          const v = aimedAt(f.x(), f.y(), shotSpeed);
          enemyFire(f.x(), f.y() + 8, v.vx, v.vy, "mochi", dmg);
        } else {
          const n = 6 + f.stage * 2;
          for (let i = 0; i < n; i++) {
            const a = Math.round((i * 64) / n) + ((tick >> 4) % 64);
            enemyFire(f.x(), f.y(), cosA(a) * shotSpeed, sinA(a) * shotSpeed, "pink", dmg);
          }
        }
      }
    }
  }

  function tickBoss(): void {
    const b = boss();
    if (!b) return;
    const idx = b.phase();
    // sway on the quantized sine
    b.x.set(FIELD.x0 + FIELD.w / 2 + sinA(Math.floor((tick - b.born) / 24) % 64) * (FIELD.w * 0.26));
    if (b.y() < FIELD.y0 + 46) b.y.set(b.y() + 0.8);
    b.timeoutTicks--;
    bossCardSeconds.set(Math.max(0, Math.ceil(b.timeoutTicks / TPS)));
    if (b.timeoutTicks <= 0) {
      advanceBoss(b, false);
      return;
    }
    const speed = b.mid ? 66 : 62 + idx * 8;
    const dmg = BULLET_DMG[2];
    b.fireCd--;
    b.fireCd2--;
    if (b.mid) {
      // UMBRELLA SIGN: alternating spreads + a slow ring
      if (b.fireCd <= 0) {
        b.fireCd = Math.round(1.1 * TPS);
        for (let i = 0; i < 9; i++) {
          const a = A_DOWN + (i - 4) * 3;
          enemyFire(b.x(), b.y() + 12, cosA(a) * speed, sinA(a) * speed, "amber", dmg);
        }
      }
      if (b.fireCd2 <= 0) {
        b.fireCd2 = Math.round(2.6 * TPS);
        for (let i = 0; i < 12; i++) {
          const a = Math.round((i * 64) / 12) + ((tick >> 5) % 64);
          enemyFire(b.x(), b.y(), cosA(a) * 46, sinA(a) * 46, "pink", dmg);
        }
      }
      return;
    }
    if (idx === 0) {
      // NIGHT SONG: rotating rings + aimed triples
      if (b.fireCd <= 0) {
        b.fireCd = Math.round(1.1 * TPS);
        b.spiral += 3;
        for (let i = 0; i < 14; i++) {
          const a = Math.round((i * 64) / 14) + b.spiral;
          enemyFire(b.x(), b.y(), cosA(a) * speed, sinA(a) * speed, "pink", dmg);
        }
      }
      if (b.fireCd2 <= 0) {
        b.fireCd2 = Math.round(1.7 * TPS);
        for (let i = -1; i <= 1; i++) {
          const v = aimedAt(b.x(), b.y(), speed + 16);
          enemyFire(
            b.x(), b.y() + 10,
            v.vx * cosA(i * 3) - v.vy * sinA(i * 3),
            v.vx * sinA(i * 3) + v.vy * cosA(i * 3),
            "cyan", dmg,
          );
        }
      }
    } else if (idx === 1) {
      // MOONFALL CANTATA: a spiral stream + aimed mochi pairs
      if (b.fireCd <= 0) {
        b.fireCd = 6;
        b.spiral += 5;
        enemyFire(b.x(), b.y(), cosA(b.spiral) * speed, sinA(b.spiral) * speed, "pink", dmg);
        enemyFire(b.x(), b.y(), cosA(b.spiral + 32) * speed, sinA(b.spiral + 32) * speed, "pink", dmg);
      }
      if (b.fireCd2 <= 0) {
        b.fireCd2 = Math.round(1.6 * TPS);
        const v = aimedAt(b.x(), b.y(), speed + 30);
        enemyFire(b.x() - 10, b.y() + 8, v.vx, v.vy, "mochi", dmg);
        enemyFire(b.x() + 10, b.y() + 8, v.vx, v.vy, "mochi", dmg);
      }
    } else {
      // THE ETERNAL NIGHT: twin counter-spirals + slow rings
      if (b.fireCd <= 0) {
        b.fireCd = 5;
        b.spiral += 3;
        enemyFire(b.x(), b.y(), cosA(b.spiral) * 52, sinA(b.spiral) * 52, "pink", dmg);
        enemyFire(b.x(), b.y(), cosA(-b.spiral) * 52, sinA(-b.spiral) * 52, "cyan", dmg);
      }
      if (b.fireCd2 <= 0) {
        b.fireCd2 = Math.round(3.5 * TPS);
        for (let i = 0; i < 18; i++) {
          const a = Math.round((i * 64) / 18) + ((tick >> 5) % 64);
          enemyFire(b.x(), b.y(), cosA(a) * 42, sinA(a) * 42, "amber", dmg);
        }
      }
    }
  }

  function tickShots(): void {
    // player shots
    for (const sh of [...playerShots()]) {
      if (sh.kind === "banana") {
        // out, turn, home, and into the hand
        if (!sh.ret) {
          sh.vy += BANANA.decel / TPS;
          if (sh.vy >= 0) sh.ret = true;
        } else {
          const dx = px() - sh.x();
          const dy = py() - sh.y();
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          sh.vx = (dx / len) * BANANA.back;
          sh.vy = (dy / len) * BANANA.back;
        }
        sh.x.set(sh.x() + sh.vx / TPS);
        sh.y.set(sh.y() + sh.vy / TPS);
        if (sh.hitCd > 0) sh.hitCd--;
        if (sh.hitCd <= 0) {
          let struck = false;
          for (const f of [...foes()]) {
            const fdx = f.x() - sh.x();
            const fdy = f.y() - sh.y();
            if (fdx * fdx + fdy * fdy <= 13 * 13) {
              hitFoe(f, sh.dmg, sh.pierce, sh.owner);
              struck = true;
              break; // one body per touch; it keeps flying
            }
          }
          if (!struck) {
            const b = boss();
            if (b) {
              const br = b.def.phases[b.phase()].size * 0.4;
              const bdx = b.x() - sh.x();
              const bdy = b.y() - sh.y();
              if (bdx * bdx + bdy * bdy <= br * br) {
                hitBoss(b, sh.dmg, sh.owner);
                struck = true;
              }
            }
          }
          if (struck) sh.hitCd = BANANA.hitCd;
        }
        if (sh.ret) {
          const cdx = px() - sh.x();
          const cdy = py() - sh.y();
          if (cdx * cdx + cdy * cdy <= BANANA.catchR * BANANA.catchR) {
            playerShots.set(playerShots().filter((x) => x.id !== sh.id));
            sfx("mote"); // back in the hand
          }
        }
        continue; // a boomerang ignores the walls and the one-hit despawn
      }
      if (sh.homing) {
        // steer toward the nearest target (quantized lerp, then renormalize)
        let tx = 0;
        let ty = 0;
        let best = Infinity;
        for (const f of foes()) {
          const dx = f.x() - sh.x();
          const dy = f.y() - sh.y();
          const d = dx * dx + dy * dy;
          if (d < best) {
            best = d;
            tx = f.x();
            ty = f.y();
          }
        }
        const b = boss();
        if (b) {
          const dx = b.x() - sh.x();
          const dy = b.y() - sh.y();
          const d = dx * dx + dy * dy;
          if (d < best) {
            best = d;
            tx = b.x();
            ty = b.y();
          }
        }
        if (best < Infinity) {
          const cur = Math.sqrt(sh.vx * sh.vx + sh.vy * sh.vy) || 1;
          const dx = tx - sh.x();
          const dy = ty - sh.y();
          const dl = Math.sqrt(dx * dx + dy * dy) || 1;
          const nvx = sh.vx * 0.88 + (dx / dl) * cur * 0.12;
          const nvy = sh.vy * 0.88 + (dy / dl) * cur * 0.12;
          const nl = Math.sqrt(nvx * nvx + nvy * nvy) || 1;
          sh.vx = (nvx / nl) * cur;
          sh.vy = (nvy / nl) * cur;
        }
      }
      sh.x.set(sh.x() + sh.vx / TPS);
      sh.y.set(sh.y() + sh.vy / TPS);
      if (
        sh.y() < FIELD.y0 - 16 || sh.y() > FIELD.y0 + FIELD.h + 16 ||
        sh.x() < FIELD.x0 - 16 || sh.x() > FIELD.x0 + FIELD.w + 16
      ) {
        playerShots.set(playerShots().filter((x) => x.id !== sh.id));
        continue;
      }
      // hit foes
      let spent = false;
      for (const f of [...foes()]) {
        const dx = f.x() - sh.x();
        const dy = f.y() - sh.y();
        if (dx * dx + dy * dy <= 13 * 13) {
          hitFoe(f, sh.dmg, sh.pierce, sh.owner);
          if (sh.through > 0) {
            sh.through--;
          } else {
            spent = true;
            break;
          }
        }
      }
      if (!spent) {
        const b = boss();
        if (b) {
          const br = b.def.phases[b.phase()].size * 0.4;
          const dx = b.x() - sh.x();
          const dy = b.y() - sh.y();
          if (dx * dx + dy * dy <= br * br) {
            hitBoss(b, sh.dmg, sh.owner);
            spent = true;
          }
        }
      }
      if (spent) playerShots.set(playerShots().filter((x) => x.id !== sh.id));
    }

    // enemy shots
    for (const sh of [...enemyShots()]) {
      sh.x.set(sh.x() + sh.vx / TPS);
      sh.y.set(sh.y() + sh.vy / TPS);
      if (
        sh.y() > FIELD.y0 + FIELD.h + 12 || sh.y() < FIELD.y0 - 12 ||
        sh.x() < FIELD.x0 - 12 || sh.x() > FIELD.x0 + FIELD.w + 12
      ) {
        enemyShots.set(enemyShots().filter((x) => x.id !== sh.id));
        continue;
      }
      const dx = sh.x() - px();
      const dy = sh.y() - py();
      const d2 = dx * dx + dy * dy;
      const hitR = HIT_R + 3;
      if (d2 <= hitR * hitR) {
        enemyShots.set(enemyShots().filter((x) => x.id !== sh.id));
        hurtPlayer(sh.dmg);
      } else {
        const gr = active().kind === "catnip" ? CATNIP_GRAZE_R : GRAZE_R;
        if (!sh.grazed && d2 <= gr * gr && invulnTicks <= 0) {
          sh.grazed = true;
          graze.set(graze() + 1);
          score.set(score() + 10);
          grantGlow(active(), GRAZE_GLOW * (active().kind === "catnip" ? CATNIP_GRAZE_MULT : 1));
          sfx("graze");
        }
      }
    }

    // body rams
    for (const f of foes()) {
      const dx = f.x() - px();
      const dy = f.y() - py();
      if (dx * dx + dy * dy <= 14 * 14) hurtPlayer(RAM_DMG);
    }

    // motes
    for (const m of [...motes()]) {
      if (py() < POC_Y || Math.abs(m.x() - px()) + Math.abs(m.y() - py()) < 34) {
        // magnet: above the PoC line, or close by
        const dx = px() - m.x();
        const dy = py() - m.y();
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        m.x.set(m.x() + (dx / len) * (220 / TPS));
        m.y.set(m.y() + (dy / len) * (220 / TPS));
      } else {
        m.y.set(m.y() + 44 / TPS);
      }
      if (m.y() > FIELD.y0 + FIELD.h + 10) {
        motes.set(motes().filter((x) => x.id !== m.id));
        motesMissed.set(motesMissed() + 1);
        continue;
      }
      const dx = m.x() - px();
      const dy = m.y() - py();
      if (dx * dx + dy * dy <= 12 * 12) {
        motes.set(motes().filter((x) => x.id !== m.id));
        const p = active();
        const worth = p.kind === "primrose" ? MOTE_GLOW * 2 : MOTE_GLOW;
        grantGlow(p, worth);
        score.set(score() + 5);
        sfx("mote");
      }
    }
  }

  function stepTick(pressed: number, held: number): void {
    if (pressed) {
      if (pressed & BTN.CIRCLE || pressed & BTN.RTRIGGER) switchTo(1);
      if (pressed & BTN.LTRIGGER) switchTo(-1);
      if (pressed & BTN.TRIANGLE) castSpell();
    }
    tick++;
    second.set(Math.floor(tick / TPS));
    fxTick.set(tick);
    if (fxs().length > 0) {
      const cutoff = tick - FX_LIFE;
      if (fxs().some((f) => f.born <= cutoff)) fxs.set(fxs().filter((f) => f.born > cutoff));
    }
    tickWavesAndBosses();
    tickPlayer(held);
    tickFoes();
    tickBoss();
    tickShots();
  }

  // Frame-boundary rule (the subsampling contract): a battle frame either
  // runs its FULL ticksPerFrame() batch or none of it — see the header.
  function frame(buttons: number): void {
    const pressed = buttons & ~prevButtons;
    prevButtons = buttons;

    const o = outcome();
    let started = false;
    if (o === "title") {
      if (!(pressed & BTN.START)) return;
      start();
      started = true; // fall through: the first batch ticks this same frame
    } else if (o === "dawn" || o === "eternal") {
      // The outcome screens keep their own clock as (wall ticks - the tick
      // the outcome settled on). Both terms are rate-aligned, so the medal
      // stamp lands at the same virtual moment at every simulationHz.
      wallTicks += ticksPerFrame();
      const prev = endTick();
      endTick.set(Math.max(0, wallTicks - tick));
      if (o === "dawn" && prev < STAMP_IMPACT && endTick() >= STAMP_IMPACT) sfx("stamp");
      if (pressed & BTN.START) toTitle();
      return;
    }
    if (!started && pressed & BTN.START) paused.set(!paused());
    if (paused()) return;
    if (pressed & BTN.SELECT) codexPage.set((codexPage() + 1) % 3);
    if (codexPage() > 0) return;

    const k = ticksPerFrame();
    wallTicks += k;
    for (let i = 0; i < k; i++) {
      if (outcome() !== "battle") break;
      stepTick(i === 0 ? pressed : 0, buttons);
    }
    // If the night ended inside this batch, the end clock starts NOW: the
    // wall keeps moving through the frame the outcome settled in, so the
    // stamp timeline is subsample-exact at every rate.
    if (outcome() === "dawn" || outcome() === "eternal") {
      endTick.set(Math.max(0, wallTicks - tick));
    }
  }

  // The lab seam (same spirit as __tidelight): read-only accessors so the sim
  // can assert on the battle without parsing the component tree.
  (globalThis as Record<string, unknown>).__nightbloom = {
    outcome,
    second,
    score,
    graze,
    kills,
    phase,
    waveIdx,
    bestStage,
    activeKind: () => active().kind,
    activeHp: () => active().hp(),
    rosterAlive: () => roster.filter(alive).length,
    rosterReady: () => roster.filter(ready).length,
    unlockedCount: () => roster.filter((r) => r.unlocked()).length,
    wilting: () => wilting(),
    rescues: () => rescues,
    escaped: () => escaped(),
    hitsTaken: () => hitsTaken(),
    motesMissed: () => motesMissed(),
    cardTimeouts: () => cardTimeouts(),
    rosterGlow: () => roster.map((r) => ({ kind: r.kind, stage: r.stage(), hp: r.hp(), glow: Math.round(r.glow()) })),
    foesAlive: () => foes().length,
    bulletCount: () => enemyShots().length,
    bossInfo: () => {
      const b = boss();
      return b ? { name: b.def.name, phase: b.phase(), hp: b.hp() } : null;
    },
    playerPos: () => ({ x: Math.round(px()), y: Math.round(py()) }),
  };

  return {
    outcome,
    paused,
    codexPage,
    phase,
    augury,
    second,
    waveIdx,
    score,
    graze,
    kills,
    bestStage,
    escaped,
    hitsTaken,
    motesMissed,
    cardTimeouts,
    px,
    py,
    focus,
    invuln: invulnOn,
    activeIdx,
    roster,
    active,
    lastDx,
    facing,
    wilting,
    wiltSeconds,
    foes,
    boss,
    bossCard,
    bossCardSeconds,
    bossFlash,
    endTick,
    enemyShots,
    playerShots,
    motes,
    fxs,
    fxTick,
    toasts,
    frame,
    start,
    toTitle,
  };
}
