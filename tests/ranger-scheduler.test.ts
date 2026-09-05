// tests/ranger-scheduler.test.ts — M1 scheduler acceptance (§3.2).
//
// Contract: bun test tests/ranger-scheduler.test.ts
// (a) first ten steps are [0,0,1,0,1,0,0,1,0,1],
// (b) every 5 host ticks advance exactly 2 SWF frames,
// (c) 120 host ticks advance exactly 48. Zero drift, integer only.
import { describe, expect, test } from "bun:test";
import { createScheduler, schedulerStep } from "../apps/ranger/sim/scheduler.ts";

describe("ranger swf scheduler (§3.2)", () => {
  test("first ten steps are [0,0,1,0,1,0,0,1,0,1]", () => {
    const s = createScheduler();
    const got: number[] = [];
    for (let i = 0; i < 10; i++) got.push(schedulerStep(s));
    expect(got).toEqual([0, 0, 1, 0, 1, 0, 0, 1, 0, 1]);
  });

  test("5 ticks advance exactly 2 frames (every window)", () => {
    const s = createScheduler();
    for (let w = 0; w < 24; w++) {
      let n = 0;
      for (let i = 0; i < 5; i++) n += schedulerStep(s);
      expect(n).toBe(2);
    }
  });

  test("120 ticks advance exactly 48 frames", () => {
    const s = createScheduler();
    let n = 0;
    for (let i = 0; i < 120; i++) {
      const step = schedulerStep(s);
      expect(step === 0 || step === 1).toBe(true);
      n += step;
      expect(s.acc).toBeGreaterThanOrEqual(0);
      expect(s.acc).toBeLessThan(60);
    }
    expect(n).toBe(48);
    expect(s.swfFrame).toBe(48);
  });

  test("accumulator trace matches the contract", () => {
    const s = createScheduler();
    const accs: number[] = [s.acc];
    for (let i = 0; i < 5; i++) {
      schedulerStep(s);
      accs.push(s.acc);
    }
    // 0→24→48→12(advance)→36→0(advance)→…
    expect(accs).toEqual([0, 24, 48, 12, 36, 0]);
  });
});
