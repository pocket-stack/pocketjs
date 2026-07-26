// tests/clock.test.ts — unit semantics of the virtual clock + effect shell.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  __advanceClock,
  after,
  normalizeHz,
  resetClock,
  simulationHz,
  ticksPerFrame,
  virtualFrame,
  virtualNow,
} from "../framework/src/clock.ts";
import {
  __drainEffects,
  installEffectDriver,
  resetEffects,
  runEffect,
} from "../framework/src/effects.ts";

const g = globalThis as Record<string, unknown>;

describe("normalizeHz", () => {
  test("snaps to the nearest divisor of 60", () => {
    expect(normalizeHz(60)).toBe(60);
    expect(normalizeHz(2)).toBe(2);
    expect(normalizeHz(7)).toBe(6);
    expect(normalizeHz(24)).toBe(20);
    expect(normalizeHz(1000)).toBe(60);
    expect(normalizeHz(0)).toBe(60);
    expect(normalizeHz(-3)).toBe(60);
    expect(normalizeHz(Number.NaN)).toBe(60);
  });
});

describe("virtual clock", () => {
  beforeEach(() => {
    g.__simHz = 4;
    resetClock();
  });

  test("latches the host policy and derives time from the frame counter", () => {
    expect(simulationHz()).toBe(4);
    expect(ticksPerFrame()).toBe(15);
    expect(virtualFrame()).toBe(0);
    expect(virtualNow()).toBe(0);
    __advanceClock(); // frame 0
    __advanceClock(); // frame 1
    expect(virtualFrame()).toBe(1);
    expect(virtualNow()).toBe(0.25);
  });

  test("after() fires on the rounded virtual frame, in insertion order", () => {
    const fired: string[] = [];
    after(0.5, () => fired.push("a")); // frame 2 at 4 Hz
    after(0.5, () => fired.push("b")); // same frame — insertion order breaks the tie
    after(0.25, () => fired.push("c")); // frame 1
    const dispose = after(0.25, () => fired.push("dead"));
    dispose();
    __advanceClock(); // frame 0
    expect(fired).toEqual([]);
    __advanceClock(); // frame 1
    expect(fired).toEqual(["c"]);
    __advanceClock(); // frame 2
    expect(fired).toEqual(["c", "a", "b"]);
  });

  test("after() never fires on the frame it was scheduled from", () => {
    const fired: number[] = [];
    __advanceClock(); // frame 0
    after(0, () => fired.push(virtualFrame()));
    __advanceClock(); // frame 1
    expect(fired).toEqual([1]);
  });
});

describe("effect shell", () => {
  beforeEach(() => {
    g.__simHz = 60;
    delete g.__pocketEffectDriver;
    delete g.__pocketEffectTrace;
    resetClock();
    resetEffects();
  });

  test("deliveries apply at the next drain, FIFO, exactly once", () => {
    const seen: unknown[] = [];
    const delivers: ((r: unknown) => void)[] = [];
    installEffectDriver((_cmd, deliver) => delivers.push(deliver));
    runEffect("a", null, (r) => seen.push(r));
    runEffect("b", null, (r) => seen.push(r));
    delivers[1]("B");
    delivers[0]("A");
    delivers[0]("A-again"); // second deliver for one command: dropped
    expect(seen).toEqual([]);
    __drainEffects();
    expect(seen).toEqual(["B", "A"]);
    __drainEffects();
    expect(seen).toEqual(["B", "A"]);
  });

  test("a delivery produced during a drain lands on the NEXT drain", () => {
    const seen: string[] = [];
    installEffectDriver((cmd, deliver) => deliver(cmd.kind)); // synchronous driver
    runEffect<string>("first", null, (r) => {
      seen.push(r);
      runEffect<string>("second", null, (r2) => seen.push(r2));
    });
    __drainEffects();
    expect(seen).toEqual(["first"]);
    __drainEffects();
    expect(seen).toEqual(["first", "second"]);
  });

  test("a host-injected driver overrides the app driver", () => {
    const seen: string[] = [];
    installEffectDriver((_cmd, deliver) => deliver("app"));
    g.__pocketEffectDriver = (_cmd: unknown, deliver: (r: unknown) => void) => deliver("host");
    runEffect<string>("x", null, (r) => seen.push(r));
    __drainEffects();
    expect(seen).toEqual(["host"]);
  });

  test("no driver at all throws a diagnosable error", () => {
    // beforeEach cleared the host driver; shadow the app driver too.
    installEffectDriver(null as never);
    expect(() => runEffect("x", null, () => {})).toThrow(/no effect driver/);
  });

  test("the trace sink sees commands and deliveries with frame indices", () => {
    const events: unknown[] = [];
    g.__pocketEffectTrace = (e: unknown) => events.push(e);
    installEffectDriver((_cmd, deliver) => deliver(1));
    __advanceClock(); // frame 0
    runEffect("menu", null, () => {});
    __advanceClock(); // frame 1
    __drainEffects();
    expect(events).toEqual([
      { t: "command", frame: 0, id: 1, kind: "menu" },
      { t: "delivery", frame: 1, id: 1, kind: "menu" },
    ]);
  });
});
