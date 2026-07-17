// static/rpg/battle.ts — a whole turn-based battle system with zero runtime
// support: plain generator helpers that the Pocket Static compiler inlines
// and specializes per encounter (macro expansion + static unrolling). Menus
// are CHOICEs, HP are vars, damage is the deterministic story RNG — so the
// same fight plays out identically on GBA, GB, NES and the reference VM.
//
// Battle vars: v.bt_foe / v.bt_me. Result: f[cfg.winFlag].

import type { Flags, Ops, Vars } from "./dsl.ts";

export interface BattleMove {
  /** Choice-list index (list order must match). */
  i: number;
  label: string;
  /** Base damage + rnd(bonus) extra (bonus 0 = fixed). */
  dmg: number;
  bonus: number;
  /** Self-heal applied before damage. */
  heal: number;
  /** Required flag ("" = always available); missing -> fizzle text. */
  gate: string;
  fizzle: string;
  /** Line shown when the move lands. */
  quip: string;
}

export interface BattleCfg {
  foe: string;
  foeHp: number;
  myName: string;
  myHp: number;
  /** Foe counterattack: dmg + rnd(bonus). */
  foeDmg: number;
  foeBonus: number;
  foeQuip: string;
  winFlag: string;
  moves: BattleMove[];
  labels: string[];
}

function* applyMove(s: Ops, v: Vars, m: BattleMove) {
  if (m.heal > 0) {
    v.bt_me += m.heal;
    yield* s.sfx("heal");
  }
  if (m.bonus > 0) {
    v.bt_dmg = m.dmg + (yield* s.rnd(m.bonus));
  } else {
    v.bt_dmg = m.dmg;
  }
  v.bt_foe -= v.bt_dmg;
  yield* s.sfx("damage");
  yield* s.say(`${m.quip} (${v.bt_dmg} dmg.)`);
}

export function* battle(s: Ops, v: Vars, f: Flags, cfg: BattleCfg) {
  v.bt_foe = cfg.foeHp;
  v.bt_me = cfg.myHp;
  yield* s.say(`${cfg.foe} stands firm. RESOLVE ${cfg.foeHp}. Your ${cfg.myName}: ${cfg.myHp}.`);
  while (v.bt_foe > 0 && v.bt_me > 0) {
    const move = yield* s.choose(cfg.labels);
    for (const m of cfg.moves) {
      if (move === m.i) {
        if (m.gate !== "") {
          if (f[m.gate]) {
            yield* applyMove(s, v, m);
          } else {
            yield* s.sfx("deny");
            yield* s.say(m.fizzle);
          }
        } else {
          yield* applyMove(s, v, m);
        }
      }
    }
    if (v.bt_foe > 0) {
      v.bt_dmg = cfg.foeDmg + (yield* s.rnd(cfg.foeBonus));
      v.bt_me -= v.bt_dmg;
      yield* s.sfx("damage");
      yield* s.say(`${cfg.foeQuip} (${v.bt_dmg} dmg.)`);
      if (v.bt_me > 0) {
        yield* s.say(`${cfg.foe}: ${v.bt_foe}. ${cfg.myName}: ${v.bt_me}.`);
      }
    }
  }
  if (v.bt_me > 0) {
    f[cfg.winFlag] = true;
    yield* s.sfx("fanfare");
  } else {
    f[cfg.winFlag] = false;
  }
}
