// tests/ranger-input.test.ts — M1 input acceptance (§3.4).
//
// Contract: bun test tests/ranger-input.test.ts
// - press-release-press across two advancing steps yields pressed both
//   times (edge latch, not plain OR), with pendingForTest() == 0 after
//   each consume;
// - one swfConsume() snapshot per step is shared identically by the
//   frame-script / event / game consumers; a second consume in the same
//   step yields pressed == 0 (single-consume rule, §3.3-3a).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BTN } from "../contracts/spec/spec.ts";
import {
  hostPoll,
  pendingForTest,
  resetInputForTest,
  swfConsume,
  type SwfInput,
} from "../apps/ranger/sim/input.ts";
import {
  advanceSwfStep,
  createSwfStepState,
  hostTick,
  type StepHandlers,
  type StepPhase,
} from "../apps/ranger/sim/step.ts";
import { createScheduler } from "../apps/ranger/sim/scheduler.ts";
import { EXECUTION_ORDER } from "../apps/ranger/scope.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const C = BTN.CROSS;
const ORDER = EXECUTION_ORDER.order;

function stubHandlers(seen: Partial<Record<StepPhase, SwfInput[]>>): StepHandlers {
  const handlers = {} as StepHandlers;
  for (const phase of ORDER) {
    handlers[phase] = (input: SwfInput) => {
      (seen[phase] ??= []).push(input);
    };
  }
  return handlers;
}

describe("ranger host-rate edge latch (§3.4-4)", () => {
  test("press-release-press across two advances yields pressed both times", () => {
    resetInputForTest();
    const st = createSwfStepState(createScheduler());
    const seen: Partial<Record<StepPhase, SwfInput[]>> = {};
    const handlers = stubHandlers(seen);

    // Scheduler pattern [0,0,1,0,1]: advances land on host ticks 2 and 4.
    const polls = [0, C, C, 0, C];
    const advanced: number[] = [];
    for (let tick = 0; tick < polls.length; tick++) {
      hostTick(st, polls[tick]);
      if (advanceSwfStep(st, handlers) === 1) {
        advanced.push(tick);
        expect(pendingForTest()).toBe(0);
      }
    }
    expect(advanced).toEqual([2, 4]);

    const first = seen["e-finalize"]![0];
    const second = seen["e-finalize"]![1];
    expect(first.pressed).toBe(C);
    expect(first.held).toBe(C);
    // The tick-3 release was tracked: tick-4 is a NEW press, not a holdover.
    expect(second.pressed).toBe(C);
    expect(second.held).toBe(C);
    expect(st.consumes).toBe(2);
    expect(st.steps).toBe(2);
  });

  test("held alone with no edge yields pressed == 0", () => {
    resetInputForTest();
    const st = createSwfStepState(createScheduler());
    const seen: Partial<Record<StepPhase, SwfInput[]>> = {};
    const handlers = stubHandlers(seen);
    // Press on tick 0 (no advance), then hold through the tick-2 advance.
    const polls = [C, C, C, C, C];
    for (let tick = 0; tick < polls.length; tick++) {
      hostTick(st, polls[tick]);
      advanceSwfStep(st, handlers);
    }
    expect(seen["e-finalize"]!.length).toBe(2);
    expect(seen["e-finalize"]![0].pressed).toBe(C);
    expect(seen["e-finalize"]![0].held).toBe(C);
    // Still held at the second advance, but no new edge: pressed is 0.
    expect(seen["e-finalize"]![1].pressed).toBe(0);
    expect(seen["e-finalize"]![1].held).toBe(C);
  });
});

describe("ranger single-consume step rule (§3.3-3a, §3.4-5)", () => {
  test("same snapshot reaches frame-script/event/game consumers, once", () => {
    resetInputForTest();
    const st = createSwfStepState(createScheduler());
    const seen: Partial<Record<StepPhase, SwfInput[]>> = {};
    const handlers = stubHandlers(seen);
    // Ticks 0..2: press C, advance once on tick 2.
    for (const buttons of [0, C, C]) {
      hostTick(st, buttons);
      advanceSwfStep(st, handlers);
    }
    expect(st.steps).toBe(1);
    expect(st.consumes).toBe(1);
    // Every phase ran exactly once, with the identical snapshot object.
    const first = seen[ORDER[0]]![0];
    for (const phase of ORDER) {
      expect(seen[phase]!.length).toBe(1);
      expect(seen[phase]![0]).toBe(first);
      expect(seen[phase]![0].pressed).toBe(C);
      expect(seen[phase]![0].held).toBe(C);
    }
    expect(st.lastInput).toBe(first);
  });

  test("a second consume in the same step yields pressed == 0", () => {
    resetInputForTest();
    hostPoll(C);
    const first = swfConsume();
    expect(first.pressed).toBe(C);
    expect(pendingForTest()).toBe(0);
    // The latch was cleared by the single head-of-step consume.
    const again = swfConsume();
    expect(again.pressed).toBe(0);
    expect(again.held).toBe(C);
  });

  test("non-advancing ticks never consume (latch survives)", () => {
    resetInputForTest();
    const st = createSwfStepState(createScheduler());
    const seen: Partial<Record<StepPhase, SwfInput[]>> = {};
    const handlers = stubHandlers(seen);
    hostTick(st, C);
    expect(advanceSwfStep(st, handlers)).toBe(0);
    expect(st.consumes).toBe(0);
    expect(pendingForTest()).toBe(C);
    hostTick(st, C);
    expect(advanceSwfStep(st, handlers)).toBe(0);
    expect(pendingForTest()).toBe(C);
  });

  test("step dispatch follows the shared M0 EXECUTION_ORDER, uncopied", () => {
    expect([...ORDER]).toEqual([
      "b-display",
      "d-clip-enterframe",
      "c-frame-scripts",
      "e-finalize",
    ]);
    resetInputForTest();
    const st = createSwfStepState(createScheduler());
    const order: StepPhase[] = [];
    const handlers = {} as StepHandlers;
    for (const phase of ORDER) {
      handlers[phase] = () => {
        order.push(phase);
      };
    }
    for (const buttons of [0, 0, C]) {
      hostTick(st, buttons);
      advanceSwfStep(st, handlers);
    }
    expect(order).toEqual([...ORDER]);
  });
});

describe("ranger sim runtime bans (§3.5)", () => {
  test("sim sources use no Math.random/Date.now/performance.now/setTimeout", () => {
    const banned = ["Math.random", "Date.now", "performance.now", "setTimeout"];
    for (const rel of [
      "apps/ranger/sim/fixed.ts",
      "apps/ranger/sim/scheduler.ts",
      "apps/ranger/sim/rng.ts",
      "apps/ranger/sim/input.ts",
      "apps/ranger/sim/step.ts",
    ]) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      for (const b of banned) {
        expect(src.includes(b)).toBe(false);
      }
    }
  });
});
