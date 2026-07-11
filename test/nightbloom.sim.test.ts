// test/nightbloom.sim.test.ts — NIGHTBLOOM under the deterministic sim host.
//
// tidelight proved the architecture on a branching STORY; this one proves it
// on a vertical DANMAKU SHOOTER: free 8-way movement, held-trigger autofire,
// form-switching, homing shots, graze, a midboss and a three-card final boss
// whose spirals come off a quantized sine table — all simulated in fixed
// 1/60 s micro-ticks (ticksPerFrame() per host frame).
//
// Two tapes:
//   THE MARKSMAN — a full clear (~183 s): the catnip opens the night alone,
//                  its first ascension wakes the sakura, the midboss's fall
//                  rouses the gorilla, and the rotation walks all three
//                  through the pilot seat to break the diva's last card.
//   THE SLEEPER  — nobody home (~40 s): the lone catnip dies with no form
//                  awake to switch to, and the night ends on the spot.
//
// Claims, same as the cafe/tidelight suites but on gameplay:
//   IDENTITY     same tape -> byte-identical pixel trace
//   CHAOS        wall-clock sleeps + GC between frames change nothing
//   SUBSAMPLING  the 4 Hz and 2 Hz worlds are strict subsamples of 60 Hz —
//                the low-rate player dodges the SAME spiral
//   AUGURY       phase omens ride the effect shell; the dusk omen lands at
//                exactly 1.0 s at every rate (battle tick 1 runs inside the
//                START press frame), and later phase boundaries quantize to
//                the frame that contains their tick: (at + 1) - 1/hz
//   THE NIGHT    the runs actually happened: dawn with the exact score /
//                graze / kill / bloom ledger, eternal night for the sleeper
//                (tree probes), and the content tables are closed
//
// Tape discipline (cadence rules from the tidelight suite):
//   - event times sit on the 0.5 s grid; same-button presses >= 1 s apart;
//   - movement/fire ride hold events (level-triggered): a hold's mask goes
//     true at the same battle tick at every rate. One-frame PULSES of held
//     verbs are not rate-portable, so only holds steer the ship.

import { describe, expect, test } from "bun:test";
import { runScenario, treeHasText, type Trace } from "../host-sim/sim.ts";
import { BTN } from "../spec/spec.ts";
import { validateContent } from "../demos/nightbloom/data.ts";

const MARKSMAN_SECONDS = 190; // dawn settles at ~184.1 s
const SLEEPER_SECONDS = 60; // the lone catnip falls at ~40 s

// THE MARKSMAN — sweep-dodge and rotate. The switch presses no-op while a
// form is still locked, then pick each newcomer up as the night wakes it;
// over the night every form flies.
const MARKSMAN = (() => {
  const T: { at: number; press?: number; hold?: number }[] = [{ at: 1.0, press: BTN.START }];
  // fire is held from 1.5 s to the end; 1.5 s sweep legs dodge aimed streams
  let dir: number = BTN.LEFT;
  for (let t = 1.5; t < 186; t += 1.5) {
    T.push({ at: t, hold: BTN.CROSS | dir });
    dir = dir === BTN.LEFT ? BTN.RIGHT : BTN.LEFT;
  }
  // dusk: the catnip hunts alone
  T.push({ at: 21.0, press: BTN.TRIANGLE }); // NINE LIVES
  T.push({ at: 40.0, press: BTN.TRIANGLE }); // NINE LIVES
  // from midnight: 9 s cycles — lantern seat, STONEHEART (heal + shield),
  // strike window under the shield, opportunistic spell, next form up
  for (let t = 44; t <= 170; t += 9) {
    T.push({ at: t, press: BTN.RTRIGGER });
    T.push({ at: t + 1.5, press: BTN.TRIANGLE });
    T.push({ at: t + 2.5, press: BTN.LTRIGGER });
    T.push({ at: t + 3.5, press: BTN.TRIANGLE });
    T.push({ at: t + 6, press: BTN.RTRIGGER });
  }
  // petal clears for the diva's dense cards
  for (const t of [139.0, 157.0]) {
    T.push({ at: t, press: BTN.RTRIGGER });
    T.push({ at: t + 1.5, press: BTN.TRIANGLE }); // PETALFALL
    T.push({ at: t + 3.0, press: BTN.LTRIGGER });
  }
  return T.sort((a, b) => a.at - b.at);
})();

const SLEEPER = [{ at: 1.0, press: BTN.START }];

const marksman = (hz: number) => ({ app: "nightbloom-main", hz, seconds: MARKSMAN_SECONDS, script: MARKSMAN });
const sleeper = (hz: number) => ({ app: "nightbloom-main", hz, seconds: SLEEPER_SECONDS, script: SLEEPER });

const m60: Trace = await runScenario(marksman(60));
const m4: Trace = await runScenario(marksman(4));
const m2: Trace = await runScenario(marksman(2));
const s60: Trace = await runScenario(sleeper(60));
const s2: Trace = await runScenario(sleeper(2));

describe("nightbloom: content data", () => {
  test("the tables are closed: art, stats, waves, phases, spell cards", () => {
    expect(validateContent()).toEqual([]);
  });
});

describe("nightbloom: determinism", () => {
  test("same tape, same night: repeat runs are hash-identical", async () => {
    const again = await runScenario(marksman(60));
    expect(again.hashes).toEqual(m60.hashes);
    expect(again.effects).toEqual(m60.effects);
  }, 60_000);

  test("chaos cannot reach the garden: sleeps + garbage + GC change nothing", async () => {
    // 760 chaos frames sleep up to 6 ms each — give the wall clock room
    const chaos = await runScenario(marksman(4), { maxSleepMs: 6, gcEvery: 32 });
    expect(chaos.hashes).toEqual(m4.hashes);
    expect(chaos.effects).toEqual(m4.effects);
  }, 60_000);

  test("the low-rate worlds are strict subsamples of the 60 Hz world", () => {
    for (const t of [m4, m2]) {
      const k = 60 / t.hz;
      for (let m = 0; m < t.frames; m++) {
        expect(t.hashes[m]).toBe(m60.hashes[k * (m + 1) - 1]);
      }
    }
  });

  test("the sleeper's night subsamples too — losing is just as deterministic", () => {
    const k = 60 / s2.hz;
    for (let m = 0; m < s2.frames; m++) {
      expect(s2.hashes[m]).toBe(s60.hashes[k * (m + 1) - 1]);
    }
  });

  test("the settled outcome screens are byte-equal across rates", () => {
    expect(Buffer.from(m4.finalFrame).equals(Buffer.from(m60.finalFrame))).toBe(true);
    expect(Buffer.from(m2.finalFrame).equals(Buffer.from(m60.finalFrame))).toBe(true);
    expect(Buffer.from(s2.finalFrame).equals(Buffer.from(s60.finalFrame))).toBe(true);
  });
});

describe("nightbloom: the augury rides the effect shell", () => {
  test("three omens, delivered exactly one virtual second after they are asked", () => {
    for (const t of [m60, m4, m2]) {
      const cmds = t.effects.filter((e) => e.t === "command" && e.kind === "augury");
      const dels = t.effects.filter((e) => e.t === "delivery" && e.kind === "augury");
      expect(cmds.length).toBe(3);
      expect(dels.length).toBe(3);
      for (let i = 0; i < 3; i++) {
        expect(dels[i].frame - cmds[i].frame).toBe(t.hz); // 1.0 virtual second
      }
    }
  });

  test("the omens are emitted on the tick grid, quantized per rate as designed", () => {
    // Dusk is asked on battle tick 1, which runs INSIDE the START press frame
    // (the first batch ticks immediately), so its command lands at exactly
    // 1.0 s at every rate. Midnight (tick 56*60) and witching (tick 104*60)
    // run on the last tick of their batch, i.e. during the frame that ENDS at
    // 57 s / 105 s — the command is logged at the frame's start: 57 - 1/hz
    // and 105 - 1/hz. The world itself subsamples exactly (the hash tests
    // above); this pins how tick-grid events quantize onto each host's grid.
    for (const t of [m60, m4, m2]) {
      const secs = t.effects.filter((e) => e.t === "command" && e.kind === "augury").map((e) => e.frame / t.hz);
      expect(secs[0]).toBeCloseTo(1.0, 10);
      expect(secs[1]).toBeCloseTo(57 - 1 / t.hz, 10);
      expect(secs[2]).toBeCloseTo(105 - 1 / t.hz, 10);
    }
  });
});

describe("nightbloom: the night actually happened", () => {
  test("the marksman breaks the diva's last card, and the ledger is exact", () => {
    for (const t of [m60, m2]) {
      expect(treeHasText(t.tree, "DAWN BREAKS")).toBe(true);
      expect(treeHasText(t.tree, "THE DIVA FALLS SILENT")).toBe(true);
      // Act one: the score takes the stage (settled by the final frame).
      expect(treeHasText(t.tree, "8575")).toBe(true);
      expect(treeHasText(t.tree, "GRAZE: 92")).toBe(true);
      expect(treeHasText(t.tree, "FOES FELLED: 33")).toBe(true);
      // The whole roster woke and every form survived to see the sun.
      expect(treeHasText(t.tree, "GREATEST BLOOM: STAGE 3")).toBe(true);
      expect(treeHasText(t.tree, "SURVIVING FORMS: 3 OF 3 AWAKENED")).toBe(true);
      // Act two: ONE medal, stamped on and congratulating the wrong thing.
      expect(treeHasText(t.tree, "MERCY MEDAL")).toBe(true);
      expect(treeHasText(t.tree, "2 FOES STROLLED OFF UNHARMED")).toBe(true);
    }
  });

  test("the sleeper's lone catnip falls with nobody to switch to", () => {
    for (const t of [s60, s2]) {
      expect(treeHasText(t.tree, "ETERNAL NIGHT")).toBe(true);
      expect(treeHasText(t.tree, "THE GARDEN FALLS DARK")).toBe(true);
      expect(treeHasText(t.tree, "FOES FELLED: 0")).toBe(true);
      expect(treeHasText(t.tree, "SURVIVING FORMS: 0 OF 1 AWAKENED")).toBe(true);
      expect(treeHasText(t.tree, "GREATEST BLOOM: STAGE 1")).toBe(true);
    }
  });
});
