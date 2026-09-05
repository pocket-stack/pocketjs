// OO Ranger battle slice — playable reimplementation of the SWF's
// playmode-1 battle on PocketJS (Solid guest + baked sprite sheets).
//
// Faithful where cheap, simplified where noted:
//   - poses/flip-book model matches the original driver: the game HOLDS
//     single parent frames (gotoAndStop) while nested variant clips loop.
//     Variant PNGs are exact FFDec renders; matrices come from the XFL.
//   - damage numbers are the playmode-1 yarare() table (flat, no juggle).
//   - enemy AI is simplified (approach/attack/hurt/die).
//   - no audio (the SF2000 host has no audio module yet), no SP costs,
//     English UI strings (no Korean baked font yet).
// Controls: D-pad move, UP jump, DOWN guard, CROSS/CIRCLE/SQUARE attacks,
// TRIANGLE special, START start/restart.

import { createSignal, For, Show } from "solid-js";
import { Image, Sprite, Text, View } from "@pocketjs/framework/solid/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { prop as hotProp, text as hotText } from "@pocketjs/framework/hot";
import type { NodeMirror } from "@pocketjs/framework/renderer";
import animData from "./anim.json";
import { SHEET_NAMES } from "./sheets";

const S = 0.5; // game 600x330 -> device px
const OX = 10;
const OY = 40;
const GX = (x: number) => x * S + OX;
const GY = (y: number) => y * S + OY;
const GROUND = GY(300); // 190
const ARENA_L = GX(50); // 35
const ARENA_R = GX(550); // 285
const STEP = 2; // sprite advance: 1 cell per 2 ticks (all sheets)

interface VFrame { sheet: string; cell: number; ox: number; oy: number; w: number; h: number }
interface Variant { ax: number; ay: number; frames: VFrame[] }
interface Sheet { cellW: number; cellH: number; cols: number; rows: number; frames: number }
interface PLayer { v: string; a: number; d: number; tx: number; ty: number }
const VARIANTS = (animData as { variants: Record<string, Variant> }).variants;
const SHEETS = (animData as { sheets: Record<string, Sheet> }).sheets;
const FIGHTERS = (animData as unknown as {
  fighters: Record<string, { labels: [number, string][]; frames: PLayer[][] }>;
}).fighters;

// Pose map: 1-based parent frames (from _root controller gotoAndStop targets).
const POSE = {
  idle: 1, walk: 6, rise: 11, fall: 16, guard: 26, hurt: 31,
  atk1: 36, atk2: 37, atk3: 38, air: 41, sp46: 46, low47: 47,
  shot48: 48, air13: 51, sp52: 52,
} as const;

// playmode-1 damage table (yarare): akf -> {power, knockback px/tick}
const DMG: Record<number, { p: number; ex: number }> = {
  1: { p: 14, ex: -6 }, 2: { p: 12, ex: -9 }, 3: { p: 20, ex: -14 },
  6: { p: 15, ex: -14 }, 11: { p: 7, ex: -2 }, 12: { p: 29, ex: -6 },
  13: { p: 13, ex: -3 }, 14: { p: 30, ex: -4 },
};

interface LayerState {
  node?: NodeMirror;
  variant: string;
  sheet: string;
  /** guest loop clock: fixed at bind, drives global variant frame + looping */
  t0: number;
  /** core clock: reset on every atlas (re)bind so the core cell continues */
  placeTick: number;
  setSprite: (s: string) => void;
  setW: (w: number) => void;
  setH: (h: number) => void;
}

interface Fighter {
  kind: "player1" | "enemy1";
  layers: LayerState[];
  pose: number; // 1-based parent frame
  x: number; // feet, device px
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  hp: number;
  maxHp: number;
  state: string;
  stateT: number;
  atkId: number;
  hitDone: boolean;
  atkCd: number;
  dead: boolean;
  deadT: number;
}

interface Fx { x: number; y: number; t0: number; placeTick: number; node?: NodeMirror; on: boolean }
interface Shot { x: number; y: number; vx: number; alive: boolean; placeTick: number; node?: NodeMirror; on: boolean }

function variantFrames(v: string): VFrame[] {
  return VARIANTS[v].frames;
}

const DBG = { bg: true, player: true, enemies: false, hud: true, fx: true };

export default function Battle() {
  // Every cooked sheet must resolve to baked metadata; keeps the SHEETS
  // import (and its string literals for the build collector) live.
  for (const s of SHEET_NAMES) {
    if (!SHEETS[s]) throw new Error(`ranger: missing baked sheet ${s}`);
  }
  let tick = 0;
  let prevMask = 0;
  const [phase, setPhase] = createSignal<"title" | "fight" | "clear" | "over">("title");
  const [score, setScore] = createSignal(0);
  const [combo, setCombo] = createSignal(0);
  const [banner, setBanner] = createSignal("");
  const [phpW, setPhpW] = createSignal(120);
  const [ehpW, setEhpW] = createSignal<[number, number]>([120, 120]);
  let comboT = 0;
  let hitstop = 0;

  function mkLayers(n: number, setSprite: ((s: string) => void)[], setW: ((w: number) => void)[], setH: ((h: number) => void)[]): LayerState[] {
    return Array.from({ length: n }, (_, i) => ({
      variant: "", sheet: "", t0: 0, placeTick: 0,
      setSprite: setSprite[i], setW: setW[i], setH: setH[i],
    }));
  }
  /** global variant-frame index on the guest loop clock (loops forever) */
  function globalCell(v: string, t0: number): number {
    const total = variantFrames(v).length;
    return Math.floor((tick - t0) / STEP) % total;
  }

  // layer signals (created per fighter below via helper component state)
  interface LayerSig { spr: () => string; setSpr: (s: string) => void; w: () => number; setW: (w: number) => void; h: () => number; setH: (h: number) => void }
  const layerSig = (init = "v347p0.png"): LayerSig => {
    const [spr, setSpr] = createSignal(init);
    const [w, setW] = createSignal(35);
    const [h, setH] = createSignal(45);
    return { spr, setSpr, w, setW, h, setH };
  };
  const pSig = [layerSig("v347p0.png")];
  const eSig: LayerSig[][] = [[layerSig("v1152.png"), layerSig("v1152.png"), layerSig("v1152.png")], [layerSig("v1152.png"), layerSig("v1152.png"), layerSig("v1152.png")]];
  const fxSig = Array.from({ length: 6 }, () => {
    const [on, setOn] = createSignal(false);
    const [spr, setSpr] = createSignal("v370p0.png");
    return { on, setOn, spr, setSpr };
  });
  const shotSig = Array.from({ length: 4 }, () => {
    const [on, setOn] = createSignal(false);
    return { on, setOn };
  });

  const player: Fighter = {
    kind: "player1",
    layers: mkLayers(1, [pSig[0].setSpr], [pSig[0].setW], [pSig[0].setH]),
    pose: POSE.idle, x: GX(120), y: GROUND, vx: 0, vy: 0, facing: 1,
    hp: 100, maxHp: 100, state: "idle", stateT: 0,
    atkId: 0, hitDone: false, atkCd: 0, dead: false, deadT: 0,
  };
  const enemies: Fighter[] = [0, 1].map((i) => ({
    kind: "enemy1",
    layers: mkLayers(3, eSig[i].map((s) => s.setSpr), eSig[i].map((s) => s.setW), eSig[i].map((s) => s.setH)),
    pose: POSE.idle, x: GX(420 + i * 60), y: GROUND, vx: 0, vy: 0, facing: -1,
    hp: 100, maxHp: 100, state: "idle", stateT: 0,
    atkId: 0, hitDone: false, atkCd: 80 + i * 40, dead: false, deadT: 0,
  }));
  const fxs: Fx[] = Array.from({ length: 6 }, () => ({ x: 0, y: 0, t0: 0, placeTick: 0, on: false }));
  const shots: Shot[] = Array.from({ length: 4 }, () => ({ x: 0, y: 0, vx: 0, alive: false, placeTick: 0, on: false }));

  // ---- pose / layer plumbing -------------------------------------------
  function poseLayers(f: Fighter, pose: number): PLayer[] {
    return FIGHTERS[f.kind].frames[pose - 1] ?? [];
  }
  function sheetFor(v: string, globalIdx: number): { sheet: string; sheetStart: number } {
    let acc = 0;
    const seen: string[] = [];
    for (const fr of variantFrames(v)) {
      if (!seen.includes(fr.sheet)) seen.push(fr.sheet);
    }
    // frames[] is ordered; find which sheet holds globalIdx by counting
    const counts = new Map<string, number>();
    for (const fr of variantFrames(v)) counts.set(fr.sheet, (counts.get(fr.sheet) ?? 0) + 1);
    acc = 0;
    for (const sh of seen) {
      const n = counts.get(sh)!;
      if (globalIdx < acc + n) return { sheet: sh, sheetStart: acc };
      acc += n;
    }
    return { sheet: seen[0], sheetStart: 0 };
  }
  function bindPose(f: Fighter, pose: number) {
    f.pose = pose;
    const layers = poseLayers(f, pose);
    for (let i = 0; i < f.layers.length; i++) {
      const L = f.layers[i];
      const pl = layers[i];
      if (!pl) {
        if (L.variant !== "") {
          L.variant = "";
          L.setW(0);
          L.setH(0);
        }
        continue;
      }
      if (L.variant !== pl.v) {
        L.variant = pl.v;
        L.t0 = tick;
        L.placeTick = tick;
        const first = variantFrames(pl.v)[0];
        L.sheet = first.sheet;
        const meta = SHEETS[first.sheet];
        L.setSprite(first.sheet);
        L.setW(meta.cellW);
        L.setH(meta.cellH);
      }
    }
  }
  // keep multi-sheet variants on the right atlas as the global cell advances;
  // single-sheet variants never rebind (the core loops them by itself)
  function syncSheets(f: Fighter) {
    for (const L of f.layers) {
      if (L.variant === "") continue;
      const g = globalCell(L.variant, L.t0);
      const { sheet, sheetStart } = sheetFor(L.variant, g);
      if (sheet !== L.sheet) {
        L.sheet = sheet;
        L.placeTick = tick - (g - sheetStart) * STEP;
        const meta = SHEETS[sheet];
        L.setSprite(sheet);
        L.setW(meta.cellW);
        L.setH(meta.cellH);
      }
    }
  }
  // body reference = the largest visible layer (enemy layer 0 is a tiny strip)
  function bodyBox(f: Fighter): { x: number; y: number; w: number; h: number } {
    let best = { x: f.x - 10, y: f.y - 40, w: 20, h: 40 };
    let bestArea = 0;
    const layers = poseLayers(f, f.pose);
    for (let i = 0; i < f.layers.length; i++) {
      const L = f.layers[i];
      if (!L.node || L.variant === "") continue;
      const V = VARIANTS[L.variant];
      const fr = V.frames[globalCell(L.variant, L.t0)];
      const pl = layers[i] ?? { tx: 0, ty: 0 };
      const cx = f.x + pl.tx * S - V.ax;
      const cy = f.y + pl.ty * S - V.ay;
      const ix = fr.w * 0.15;
      const box = { x: cx + fr.ox + ix, y: cy + fr.oy, w: fr.w - ix * 2, h: fr.h };
      if (box.w * box.h > bestArea) {
        bestArea = box.w * box.h;
        best = box;
      }
    }
    return best;
  }
  function drawFighter(f: Fighter) {
    syncSheets(f);
    for (let i = 0; i < f.layers.length; i++) {
      const L = f.layers[i];
      if (!L.node || L.variant === "") continue;
      const V = VARIANTS[L.variant];
      const pl = poseLayers(f, f.pose)[i] ?? { tx: 0, ty: 0 };
      const meta = SHEETS[L.sheet];
      const dx = f.x + pl.tx * S - V.ax;
      const dy = f.y + pl.ty * S - V.ay;
      const ox = f.facing < 0 ? dx + meta.cellW : dx;
      hotProp(L.node, "translateX", Math.round(ox));
      hotProp(L.node, "translateY", Math.round(dy));
      hotProp(L.node, "scaleX", f.facing);
    }
  }

  // ---- combat ------------------------------------------------------------
  function spawnFx(x: number, y: number) {
    const i = fxSig.findIndex((s) => !s.on());
    if (i < 0) return;
    const fx = fxs[i];
    fx.x = x;
    fx.y = y;
    fx.t0 = tick;
    fx.placeTick = tick;
    fxSig[i].setSpr(variantFrames("370")[0].sheet);
    fxSig[i].setOn(true);
  }
  function updateFx() {
    fxs.forEach((fx, i) => {
      if (!fx.node || !fxSig[i].on()) return;
      const V = VARIANTS["370"];
      const g = Math.floor((tick - fx.t0) / STEP);
      if (g < 0 || g >= V.frames.length) {
        fxSig[i].setOn(false);
        return;
      }
      const fr = V.frames[g];
      if (fxSig[i].spr() !== fr.sheet) {
        fxSig[i].setSpr(fr.sheet);
        const start = V.frames.findIndex((q) => q.sheet === fr.sheet);
        fx.placeTick = tick - (g - start) * STEP;
      }
      hotProp(fx.node, "translateX", Math.round(fx.x - (fr.ox + fr.w / 2)));
      hotProp(fx.node, "translateY", Math.round(fx.y - (fr.oy + fr.h / 2)));
    });
  }
  function fireTobi(x: number, y: number, dir: 1 | -1) {
    const s = shots.find((t) => !t.alive);
    if (!s) return;
    s.x = x;
    s.y = y;
    s.vx = dir * 3;
    s.alive = true;
    s.placeTick = tick;
    shotSig[shots.indexOf(s)].setOn(true);
  }
  function updateShots() {
    shots.forEach((s, i) => {
      if (!s.alive || !s.node) return;
      s.x += s.vx;
      s.y += 0.15;
      let dead = s.x < 0 || s.x > 320;
      if (!dead) {
        for (const e of enemies) {
          if (e.dead) continue;
          const b = bodyBox(e);
          if (s.x > b.x && s.x < b.x + b.w && s.y > b.y && s.y < b.y + b.h) {
            hurtEnemy(e, 10, Math.sign(s.vx));
            dead = true;
            break;
          }
        }
      }
      if (tick - s.placeTick > 90) dead = true;
      if (dead) {
        s.alive = false;
        shotSig[i].setOn(false);
        return;
      }
      const V = VARIANTS["185"];
      const fr = V.frames[Math.floor((tick - s.placeTick) / STEP) % V.frames.length];
      hotProp(s.node, "translateX", Math.round(s.x - (fr.ox + fr.w / 2)));
      hotProp(s.node, "translateY", Math.round(s.y - (fr.oy + fr.h / 2)));
    });
  }
  function hurtEnemy(e: Fighter, p: number, dir: number) {
    if (e.dead) return;
    e.hp -= p;
    setCombo((c) => c + 1);
    comboT = 0;
    setScore((s) => s + p);
    const b = bodyBox(e);
    spawnFx(b.x + b.w / 2, b.y + b.h / 2);
    hitstop = 3;
    setEhpW([enemies[0].hp / 100, enemies[1].hp / 100]);
    if (e.hp <= 0) {
      e.hp = 0;
      e.dead = true;
      e.deadT = 0;
      bindPose(e, POSE.hurt);
    } else {
      e.state = "hurt";
      e.stateT = 0;
      e.vx = dir * 1.2;
      bindPose(e, POSE.hurt);
    }
  }
  function hurtPlayer(p: number, dir: number) {
    if (player.dead) return;
    if (player.state === "guard") {
      player.hp -= Math.max(1, Math.round(p / 5));
      setPhpW(player.hp / 100);
      const b = bodyBox(player);
      spawnFx(b.x + b.w / 2, b.y + b.h / 2);
      return;
    }
    player.hp -= p;
    setCombo(0);
    setPhpW(Math.max(0, player.hp / 100));
    const b = bodyBox(player);
    spawnFx(b.x + b.w / 2, b.y + b.h / 2);
    hitstop = 3;
    if (player.hp <= 0) {
      player.hp = 0;
      player.dead = true;
      player.deadT = 0;
      bindPose(player, POSE.hurt);
    } else {
      player.state = "hurt";
      player.stateT = 0;
      player.vx = dir * 1.2;
      bindPose(player, POSE.hurt);
    }
  }
  function attackBox(f: Fighter, reach: number): { x: number; y: number; w: number; h: number } {
    const b = bodyBox(f);
    if (f.facing > 0) return { x: b.x + b.w * 0.5, y: b.y, w: reach, h: b.h };
    return { x: b.x + b.w * 0.5 - reach, y: b.y, w: reach, h: b.h };
  }
  function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  const ATK_POSE: Record<number, number> = {
    1: POSE.atk1, 2: POSE.atk2, 3: POSE.atk3, 6: POSE.air,
    11: POSE.sp46, 12: POSE.low47, 13: POSE.air13, 14: POSE.sp52,
  };
  function startAttack(f: Fighter, akf: number) {
    f.atkId = akf;
    f.hitDone = false;
    f.state = "attack";
    f.stateT = 0;
    bindPose(f, ATK_POSE[akf] ?? POSE.atk1);
    if (akf === 100) {
      const b = bodyBox(f);
      fireTobi(f.facing > 0 ? b.x + b.w : b.x, b.y + b.h * 0.4, f.facing);
    }
  }
  function attackLen(f: Fighter): number {
    const layers = poseLayers(f, f.pose);
    if (!layers.length) return 20;
    return variantFrames(layers[0].v).length * STEP;
  }

  function tickPlayer(mask: number, edge: number) {
    const p = player;
    if (p.dead) {
      p.deadT++;
      return;
    }
    p.stateT++;
    if (p.atkCd > 0) p.atkCd--;
    const grounded = p.y >= GROUND;
    if (!grounded || p.vy !== 0) {
      p.vy += 0.16;
      p.y += p.vy;
      if (p.y >= GROUND) {
        p.y = GROUND;
        p.vy = 0;
        if (p.state === "jump") {
          p.state = "idle";
          bindPose(p, POSE.idle);
        }
      } else if (p.state === "jump") {
        bindPose(p, p.vy < 0 ? POSE.rise : POSE.fall);
      }
    }
    if (p.state === "hurt") {
      p.x += p.vx;
      p.vx *= 0.9;
      p.x = Math.max(ARENA_L, Math.min(ARENA_R, p.x));
      if (p.stateT > 22) {
        p.state = "idle";
        bindPose(p, POSE.idle);
      }
      return;
    }
    if (p.state === "attack") {
      const len = attackLen(p);
      const dmg = DMG[p.atkId] ?? DMG[1];
      if (!p.hitDone && p.stateT >= 4 && p.stateT <= 12 && p.atkId !== 100) {
        const ab = attackBox(p, 30);
        for (const e of enemies) {
          if (e.dead) continue;
          if (overlaps(ab, bodyBox(e))) {
            p.hitDone = true;
            hurtEnemy(e, dmg.p, p.facing);
            break;
          }
        }
      }
      if (p.stateT >= len) {
        p.state = grounded ? "idle" : "jump";
        p.atkId = 0;
        bindPose(p, grounded ? POSE.idle : POSE.rise);
      }
      return;
    }
    if (mask & BTN.DOWN) {
      if (p.state !== "guard") {
        p.state = "guard";
        bindPose(p, POSE.guard);
      }
      return;
    }
    let mv = 0;
    if (mask & BTN.LEFT) mv -= 1;
    if (mask & BTN.RIGHT) mv += 1;
    if (mv !== 0) {
      p.facing = mv > 0 ? 1 : -1;
      let nx = p.x + mv * 1.8;
      // don't walk through a living enemy: stop at engage range instead of
      // overshooting past it (matches the enemy AI's own 46px stand-off).
      const ENGAGE_PAD = 20;
      for (const e of enemies) {
        if (e.dead) continue;
        if (mv > 0) {
          const limit = e.x - ENGAGE_PAD;
          if (p.x <= limit && nx > limit) nx = limit;
        } else {
          const limit = e.x + ENGAGE_PAD;
          if (p.x >= limit && nx < limit) nx = limit;
        }
      }
      p.x = Math.max(ARENA_L, Math.min(ARENA_R, nx));
      if (grounded && p.state !== "walk") {
        p.state = "walk";
        bindPose(p, POSE.walk);
      }
    } else if (grounded && p.state !== "idle") {
      p.state = "idle";
      bindPose(p, POSE.idle);
    }
    if (edge & BTN.UP && grounded) {
      p.vy = -4;
      p.y += p.vy;
      p.state = "jump";
      bindPose(p, POSE.rise);
      return;
    }
    const punch = (akf: number) => {
      startAttack(p, akf);
      p.atkCd = 14;
    };
    if (edge & BTN.CROSS) {
      if (!grounded) {
        if (p.atkCd <= 0) punch(6);
      } else if (p.state === "attack" && (p.atkId === 1 || p.atkId === 2) && p.stateT > 6 && p.stateT < 16) {
        punch(p.atkId + 1); // combo chain bypasses the cooldown
      } else if (p.state !== "attack" && p.atkCd <= 0) punch(1);
    } else if (edge & BTN.CIRCLE) {
      if (p.atkCd <= 0 && p.state !== "attack") {
        if (!grounded) punch(6);
        else punch(2);
      }
    } else if (edge & BTN.SQUARE) {
      if (p.atkCd <= 0 && p.state !== "attack") punch(3);
    } else if (edge & BTN.TRIANGLE) {
      if (p.atkCd <= 0 && p.state !== "attack") {
        if (!grounded) punch(13);
        else punch(11);
      }
    }
  }

  function tickEnemy(e: Fighter) {
    if (e.dead) {
      e.deadT++;
      e.y += 0.5;
      if (e.deadT === 40) {
        // hide: zero-size the nodes (atlases stay valid)
        for (const L of e.layers) {
          L.variant = "";
          L.setW(0);
          L.setH(0);
        }
      }
      return;
    }
    e.stateT++;
    if (e.atkCd > 0) e.atkCd--;
    if (e.state === "hurt") {
      e.x += e.vx;
      e.vx *= 0.9;
      e.x = Math.max(ARENA_L, Math.min(ARENA_R, e.x));
      if (e.stateT > 22) {
        e.state = "idle";
        bindPose(e, POSE.idle);
      }
      return;
    }
    if (e.state === "attack") {
      if (!e.hitDone && e.stateT >= 3 && e.stateT <= 8) {
        const ab = attackBox(e, 26);
        if (!player.dead && overlaps(ab, bodyBox(player))) {
          e.hitDone = true;
          hurtPlayer(8, e.facing);
        }
      }
      if (e.stateT >= 24) {
        e.state = "idle";
        e.atkCd = 100;
        bindPose(e, POSE.idle);
      }
      return;
    }
    const dx = player.x - e.x;
    e.facing = dx >= 0 ? 1 : -1;
    if (player.dead) {
      if (e.state !== "idle") {
        e.state = "idle";
        bindPose(e, POSE.idle);
      }
      return;
    }
    if (Math.abs(dx) > 46) {
      e.x = Math.max(ARENA_L, Math.min(ARENA_R, e.x + Math.sign(dx) * 1.1));
      if (e.state !== "walk") {
        e.state = "walk";
        bindPose(e, POSE.walk);
      }
    } else {
      if (e.state !== "idle") {
        e.state = "idle";
        bindPose(e, POSE.idle);
      }
      if (e.atkCd <= 0) {
        e.state = "attack";
        e.stateT = 0;
        e.atkId = 1;
        e.hitDone = false;
        bindPose(e, POSE.atk1);
      }
    }
  }

  function reset() {
    tick = 0;
    comboT = 0;
    hitstop = 0;
    setScore(0);
    setCombo(0);
    setBanner("");
    setPhpW(1);
    setEhpW([1, 1]);
    Object.assign(player, {
      x: GX(120), y: GROUND, vx: 0, vy: 0, facing: 1 as const,
      hp: 100, state: "idle", stateT: 0, atkId: 0, hitDone: false,
      atkCd: 0, dead: false, deadT: 0,
    });
    bindPose(player, POSE.idle);
    enemies.forEach((e, i) => {
      Object.assign(e, {
        x: GX(420 + i * 60), y: GROUND, vx: 0, vy: 0, facing: -1 as const,
        hp: 100, state: "idle", stateT: 0, atkId: 0, hitDone: false,
        atkCd: 80 + i * 40, dead: false, deadT: 0,
      });
      bindPose(e, POSE.idle);
    });
    fxs.forEach((fx, i) => {
      fx.t0 = 0;
      fx.placeTick = 0;
      fxSig[i].setOn(false);
    });
    shots.forEach((s, i) => {
      s.alive = false;
      shotSig[i].setOn(false);
    });
  }

  function tickAll(mask: number) {
    const edge = mask & ~prevMask;
    prevMask = mask;
    tick++;
    if (phase() === "title") {
      if (edge & BTN.START) {
        setPhase("fight");
        reset();
      }
      return;
    }
    if (phase() === "clear" || phase() === "over") {
      if (edge & BTN.START) {
        setPhase("fight");
        reset();
      }
      return;
    }
    if (hitstop > 0) {
      hitstop--;
      drawAll();
      return;
    }
    comboT++;
    if (combo() > 0 && comboT > 50) {
      setScore((s) => s + combo() * combo() * 10);
      setCombo(0);
    }
    tickPlayer(mask, edge);
    for (const e of enemies) tickEnemy(e);
    updateFx();
    updateShots();
    if (enemies.every((e) => e.dead)) {
      setPhase("clear");
      setBanner("CLEAR!");
    } else if (player.dead && player.deadT > 90) {
      setPhase("over");
      setBanner("GAME OVER");
    }
    drawAll();
  }

  let scoreNode: NodeMirror | undefined;
  let comboNode: NodeMirror | undefined;
  let bannerNode: NodeMirror | undefined;
  function drawAll() {
    drawFighter(player);
    for (const e of enemies) {
      if (!e.dead || e.deadT < 40) drawFighter(e);
    }
    setPhpW(Math.max(0, player.hp / player.maxHp));
    setEhpW([Math.max(0, enemies[0].hp / 100), Math.max(0, enemies[1].hp / 100)]);
    hotText(scoreNode, `SCORE ${score()}`);
    if (combo() > 1) hotText(comboNode, `${combo()} HITS!`);
    if (banner() !== "") hotText(bannerNode, banner());
  }

  onFrame((buttons: number) => tickAll(buttons));

  const BAR_W = 100;
  return (
    <View class="w-full h-full flex-col bg-black" style={{ width: 320, height: 240 }}>
      <Show when={phase() === "title"}>
        <View class="flex-col items-center justify-center" style={{ width: 320, height: 240 }}>
          <Text class="text-2xl text-red-600 font-bold">OO RANGER</Text>
          <Text class="text-sm text-white">SF2000 battle slice</Text>
          <Text class="text-sm text-amber-600">PRESS START</Text>
        </View>
      </Show>
      <Show when={phase() !== "title"}>
        {DBG.bg && <Image class="absolute" src="bg.png" style={{ insetL: 0, insetT: 110, width: 320, height: 80 }} />}
        {DBG.player && (
        <For each={[0]}>
          {() => (
            <Sprite
              class="absolute"
              sprite="v347p0.png"
              debugName="player"
              nodeRef={(n) => (player.layers[0].node = n as NodeMirror)}
              style={{ insetL: 53, insetT: 145, width: 64, height: 64 }}
            />
          )}
        </For>
        )}
        {DBG.enemies && (
        <For each={enemies}>
          {(e, ei) => (
            <For each={[0, 1, 2]}>
              {(li: number) => (
                <Sprite
                  class="absolute"
                  sprite={eSig[ei()][li].spr()}
                  debugName="enemy"
                  nodeRef={(n) => (e.layers[li].node = n as NodeMirror)}
                  style={{ insetL: 0, insetT: 0, width: eSig[ei()][li].w(), height: eSig[ei()][li].h() }}
                />
              )}
            </For>
          )}
        </For>
        )}
        <For each={fxSig}>
          {(sig, i) => (
            <Show when={sig.on()}>
              <Sprite
                class="absolute"
                sprite={sig.spr()}
                debugName="fx"
                nodeRef={(n) => (fxs[i()].node = n as NodeMirror)}
                style={{ insetL: 0, insetT: 0, width: 128, height: 128 }}
              />
            </Show>
          )}
        </For>
        <For each={shotSig}>
          {(sig, i) => (
            <Show when={sig.on()}>
              <Sprite
                class="absolute"
                sprite="v185.png"
                debugName="shot"
                nodeRef={(n) => (shots[i()].node = n as NodeMirror)}
                style={{ insetL: 0, insetT: 0, width: 128, height: 64 }}
              />
            </Show>
          )}
        </For>
        <Image class="absolute" src="p_hpb.png" style={{ insetL: 8, insetT: 6, width: 128, height: 32 }} />
        <View class="absolute bg-black" style={{ insetL: 14, insetT: 42, width: BAR_W, height: 6 }} />
        <View class="absolute bg-red-600" style={{ insetL: 14, insetT: 42, width: Math.round(BAR_W * phpW()), height: 6 }} />
        <Image class="absolute" src="e_hpb.png" style={{ insetL: 184, insetT: 6, width: 128, height: 32 }} />
        <View class="absolute bg-black" style={{ insetL: 190, insetT: 42, width: BAR_W, height: 6 }} />
        <View class="absolute bg-red-600" style={{ insetL: 190, insetT: 42, width: Math.round(BAR_W * ehpW()[0]), height: 6 }} />
        <View class="absolute bg-black" style={{ insetL: 190, insetT: 52, width: BAR_W, height: 6 }} />
        <View class="absolute bg-amber-600" style={{ insetL: 190, insetT: 52, width: Math.round(BAR_W * ehpW()[1]), height: 6 }} />
        <Text
          class="absolute text-sm text-white font-bold"
          style={{ insetL: 8, insetT: 70 }}
          nodeRef={(n) => (scoreNode = n as NodeMirror)}
        >
          SCORE 0
        </Text>
        <Show when={combo() > 1}>
          <Text
            class="absolute text-base text-amber-600 font-bold"
            style={{ insetL: 130, insetT: 70 }}
            nodeRef={(n) => (comboNode = n as NodeMirror)}
          >
            2 HITS!
          </Text>
        </Show>
        <Show when={banner() !== ""}>
          <View class="flex-col items-center justify-center" style={{ width: 320, height: 240 }}>
            <Text
              class="text-2xl text-white font-bold"
              nodeRef={(n) => (bannerNode = n as NodeMirror)}
            >
              ...
            </Text>
            <Text class="text-sm text-slate-300">PRESS START</Text>
          </View>
        </Show>
      </Show>
    </View>
  );
}
