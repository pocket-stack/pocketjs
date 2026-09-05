// tests/ranger-sim.test.ts — OO Ranger battle slice under the deterministic sim.
//
// Boots the real ranger bundle + pak, walks to the enemy duo, attacks, and
// asserts the fight actually progresses (score moves, both sides survive the
// script) and repeats byte-identical.
import { describe, expect, test } from "bun:test";
import { runScenario, treeHasText } from "../hosts/sim/sim.ts";
import { BTN } from "../contracts/spec/spec.ts";

const SCRIPT = [
  { at: 1.0, press: BTN.START }, //   title -> fight
  { at: 1.5, hold: BTN.RIGHT }, //    walk to the duo
  { at: 3.0, hold: 0 },
  { at: 3.2, press: BTN.CROSS }, //   punch x3 (combo chain)
  { at: 3.6, press: BTN.CROSS },
  { at: 4.0, press: BTN.CROSS },
  { at: 4.6, press: BTN.CIRCLE }, //  kick
  { at: 5.2, press: BTN.SQUARE }, //  heavy
  { at: 6.0, hold: BTN.LEFT }, //     retreat
  { at: 7.0, hold: 0 },
];

const scenario = (hz: number) => ({ app: "ranger", hz, seconds: 9, script: SCRIPT });

const run = await runScenario(scenario(60));

function scoreOf(tree: unknown): number {
  const m = JSON.stringify(tree).match(/SCORE (\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

describe("ranger battle slice", () => {
  test("boots through title into the fight HUD", async () => {
    expect(treeHasText(run.tree, "SCORE ")).toBe(true);
  });

  test("walk + attacks progress the fight (score moves, no crash)", async () => {
    expect(scoreOf(run.tree)).toBeGreaterThan(0);
    expect(treeHasText(run.tree, "GAME OVER")).toBe(false);
  });

  test("deterministic: repeat run is hash-identical", async () => {
    const again = await runScenario(scenario(60));
    expect(again.hashes).toEqual(run.hashes);
  }, 60000);
});
