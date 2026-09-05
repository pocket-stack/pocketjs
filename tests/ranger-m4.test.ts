// tests/ranger-m4.test.ts — OO Ranger M4 acceptance: the battle completes.
//
// docs/SWF_TYPESCRIPT_REWRITE_RULES.md §10 M4 asks for four scripted routes
// that each reach a distinguishable outcome: clear (both enemies defeated),
// over (the player is defeated), guard (blocking reduces incoming damage
// enough to outlast the unguarded/passive baseline), and jump (airborne
// dodges reduce incoming damage the same way). Each route's tape is
// deterministic: replaying it must produce byte-identical framebuffer
// hashes (docs/DETERMINISM.md), so every test also reruns its scenario and
// compares hashes.
import { describe, expect, test } from "bun:test";
import { runScenario, treeHasText } from "../hosts/sim/sim.ts";
import { BTN } from "../contracts/spec/spec.ts";

// Passive baseline (no input at all beyond START): the enemy duo closes in
// and defeats the player. Calibrated at hz=60: GAME OVER is up by tick 990
// (deadT > 90 after hp hits 0 around tick 900) — well inside 20s.
const OVER_SCRIPT = [{ at: 1.0, press: BTN.START }];
const OVER_SECONDS = 20;

// Aggressive: walk into range, then spam the heaviest ground punch (SQUARE,
// 20 dmg) until both 100 hp enemies are down. Calibrated: CLEAR! is up by
// tick 620 (~11.3s absolute) — well inside 15s.
const CLEAR_SCRIPT: { at: number; press?: number; hold?: number }[] = [
  { at: 1.0, press: BTN.START },
  { at: 1.5, hold: BTN.RIGHT },
  { at: 3.0, hold: 0 },
];
for (let t = 3.2; t < 14; t += 0.6) CLEAR_SCRIPT.push({ at: t, press: BTN.SQUARE });
const CLEAR_SECONDS = 15;

// Guard: hold DOWN from just after boot and never move. Guard mitigates hit
// damage to max(1, round(p/5)) (battle.tsx hurtPlayer) — calibrated: still
// alive (php 28) at the 20s mark, well past where the passive baseline is
// already dead (over-route GAME OVER by ~17.5s).
const GUARD_SCRIPT = [
  { at: 1.0, press: BTN.START },
  { at: 1.2, hold: BTN.DOWN },
];
const GUARD_SECONDS = 20;

// Jump: re-press UP every 2 host frames so the player is airborne again the
// instant it lands, without ever holding the button (jump only triggers on
// a fresh edge while grounded). This isn't perfect evasion — the enemy's
// attack window can still catch an early ascent — but it measurably
// outlasts standing still: calibrated alive (php 28) at the 20s mark vs the
// passive baseline's GAME OVER by ~17.5s.
const JUMP_SCRIPT: { at: number; press?: number; hold?: number }[] = [
  { at: 1.0, press: BTN.START },
];
for (let f = 72; f < 1195; f += 2) JUMP_SCRIPT.push({ at: f / 60, press: BTN.UP });
const JUMP_SECONDS = 20;

async function runRoute(script: { at: number; press?: number; hold?: number }[], seconds: number) {
  return runScenario({ app: "ranger", hz: 60, seconds, script });
}

describe("ranger M4: battle completion routes", () => {
  test("clear route: defeating both enemies reaches the CLEAR banner", async () => {
    const run = await runRoute(CLEAR_SCRIPT, CLEAR_SECONDS);
    expect(treeHasText(run.tree, "CLEAR!")).toBe(true);
    expect(treeHasText(run.tree, "GAME OVER")).toBe(false);
  });

  test("clear route is deterministic (repeat run is hash-identical)", async () => {
    const a = await runRoute(CLEAR_SCRIPT, CLEAR_SECONDS);
    const b = await runRoute(CLEAR_SCRIPT, CLEAR_SECONDS);
    expect(b.hashes).toEqual(a.hashes);
  }, 60000);

  test("over route: a passive player is defeated and reaches GAME OVER", async () => {
    const run = await runRoute(OVER_SCRIPT, OVER_SECONDS);
    expect(treeHasText(run.tree, "GAME OVER")).toBe(true);
  });

  test("over route is deterministic (repeat run is hash-identical)", async () => {
    const a = await runRoute(OVER_SCRIPT, OVER_SECONDS);
    const b = await runRoute(OVER_SCRIPT, OVER_SECONDS);
    expect(b.hashes).toEqual(a.hashes);
  }, 60000);

  test("guard route: blocking outlasts the passive baseline (no GAME OVER by 20s)", async () => {
    const run = await runRoute(GUARD_SCRIPT, GUARD_SECONDS);
    expect(treeHasText(run.tree, "GAME OVER")).toBe(false);
  });

  test("guard route is deterministic (repeat run is hash-identical)", async () => {
    const a = await runRoute(GUARD_SCRIPT, GUARD_SECONDS);
    const b = await runRoute(GUARD_SCRIPT, GUARD_SECONDS);
    expect(b.hashes).toEqual(a.hashes);
  }, 60000);

  test("jump route: airborne dodges outlast the passive baseline (no GAME OVER by 20s)", async () => {
    const run = await runRoute(JUMP_SCRIPT, JUMP_SECONDS);
    expect(treeHasText(run.tree, "GAME OVER")).toBe(false);
  });

  test("jump route is deterministic (repeat run is hash-identical)", async () => {
    const a = await runRoute(JUMP_SCRIPT, JUMP_SECONDS);
    const b = await runRoute(JUMP_SCRIPT, JUMP_SECONDS);
    expect(b.hashes).toEqual(a.hashes);
  }, 60000);
});
