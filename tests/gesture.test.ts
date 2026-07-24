// Gesture layer unit tests: drive __setTouches + __runGestures directly
// (the tests/touch.test.ts pattern) — no host, no renderer. Region-based
// ownership through hitTest is exercised at the renderer/sim level; these
// tests use rect regions and whole-screen recognizers.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  attachGesture,
  pushTouchBlock,
  resetGestures,
  __runGestures,
  type GestureContact,
} from "../framework/src/gesture.ts";
import { __packTouch, __resetTouches, __setTouches } from "../framework/src/touch.ts";
import { resetClock, __advanceClock } from "../framework/src/clock.ts";

type Contact = [id: number, x: number, y: number];

/** One frame: advance the clock, latch contacts, run the pump. */
function pump(contacts: readonly Contact[]): void {
  __advanceClock();
  __setTouches(contacts.map(([id, x, y]) => __packTouch(id, x, y)));
  __runGestures();
}

function withHz(hz: number): void {
  (globalThis as { __simHz?: number }).__simHz = hz;
  resetClock();
}

beforeEach(() => {
  delete (globalThis as { __simHz?: number }).__simHz;
  resetClock();
  resetGestures();
  __resetTouches();
});

afterEach(() => {
  resetGestures();
  __resetTouches();
});

describe("contact lifecycle", () => {
  test("down/move/up edges with delta and history bookkeeping", () => {
    const log: string[] = [];
    attachGesture({
      onDown: (c) => log.push(`down ${c.id} ${c.x},${c.y}`),
      onMove: (c) => log.push(`move ${c.dx},${c.dy} f${c.fdx},${c.fdy}`),
      onUp: (c) => log.push(`up ${c.x},${c.y} frames=${c.frames}`),
    });
    pump([[1, 100, 50]]);
    pump([[1, 103, 50]]);
    pump([[1, 103, 50]]); // hold frame: no move edge
    pump([[1, 110, 60]]);
    pump([]);
    expect(log).toEqual([
      "down 1 100,50",
      "move 3,0 f3,0",
      "move 10,10 f7,10",
      "up 110,60 frames=3",
    ]);
  });

  test("id reuse after a release starts a fresh contact", () => {
    const downs: number[] = [];
    attachGesture({ onDown: (c) => downs.push(c.startX) });
    pump([[1, 10, 10]]);
    pump([]);
    pump([[1, 200, 10]]);
    expect(downs).toEqual([10, 200]);
  });

  test("tracks cap at the 8-contact pool without dropping existing ones", () => {
    let downs = 0;
    attachGesture({ onDown: () => downs++ });
    pump(Array.from({ length: 12 }, (_, i) => [i, i, i] as Contact));
    expect(downs).toBe(8);
  });
});

describe("tap", () => {
  test("fires within slop; movement beyond slop kills it", () => {
    const taps: number[] = [];
    attachGesture({ onTap: (c) => taps.push(c.id) });
    // 8 px total travel = still a tap (slop is exclusive).
    pump([[1, 100, 100]]);
    pump([[1, 108, 100]]);
    pump([]);
    // 9 px kills it.
    pump([[2, 100, 100]]);
    pump([[2, 109, 100]]);
    pump([]);
    expect(taps).toEqual([1]);
  });

  test("single-fires on the last-registered owner", () => {
    const fired: string[] = [];
    attachGesture({ onTap: () => fired.push("first") });
    attachGesture({ onTap: () => fired.push("second") });
    pump([[1, 50, 50]]);
    pump([]);
    expect(fired).toEqual(["second"]);
  });
});

describe("velocity", () => {
  test("is exact: 4 px/frame at 60 Hz reads 240 px/s", () => {
    const seen: Array<{ vx: number; vy: number }> = [];
    attachGesture({ onMove: (c) => seen.push({ vx: c.vx, vy: c.vy }) });
    pump([[1, 100, 100]]);
    pump([[1, 104, 100]]);
    pump([[1, 108, 100]]);
    pump([[1, 112, 100]]); // k = 3 window is full
    expect(seen[seen.length - 1]).toEqual({ vx: 240, vy: 0 });
  });

  test("scales with simulationHz (px per VIRTUAL second)", () => {
    withHz(30);
    const seen: number[] = [];
    attachGesture({ onMove: (c) => seen.push(c.vy) });
    pump([[1, 100, 100]]);
    pump([[1, 100, 110]]);
    pump([[1, 100, 120]]);
    pump([[1, 100, 130]]);
    // 30 px over 3 frames of 1/30 s each = 300 px/s.
    expect(seen[seen.length - 1]).toBe(300);
  });

  test("release velocity reaches onPanEnd", () => {
    const ends: number[] = [];
    attachGesture({ axis: "y", onPanEnd: (c) => ends.push(c.vy) });
    pump([[1, 100, 100]]);
    pump([[1, 100, 110]]);
    pump([[1, 100, 120]]);
    pump([[1, 100, 130]]);
    pump([]);
    expect(ends).toEqual([600]);
  });
});

describe("pan", () => {
  test("claims the contact and cancels sibling owners", () => {
    const log: string[] = [];
    attachGesture({
      onDown: () => log.push("tap:down"),
      onCancel: () => log.push("tap:cancel"),
      onTap: () => log.push("tap:tap"),
    });
    attachGesture({
      axis: "y",
      onPanStart: (c) => log.push(`pan:start ${c.dy}`),
      onPanMove: (c) => log.push(`pan:move ${c.fdy}`),
      onPanEnd: () => log.push("pan:end"),
      onDown: () => log.push("pan:down"),
    });
    pump([[1, 100, 100]]);
    pump([[1, 100, 107]]); // dy 7 > panSlop 6 → pan claims
    pump([[1, 100, 117]]);
    pump([]);
    expect(log).toEqual([
      "pan:down",
      "tap:down",
      "pan:start 7",
      "tap:cancel", // losers cancel at claim time, before further pan events
      "pan:move 7",
      "pan:move 10",
      "pan:end",
    ]);
  });

  test("axis lock rejects cross-axis movement without claiming", () => {
    const log: string[] = [];
    attachGesture({
      axis: "y",
      onPanStart: () => log.push("pan:start"),
      onCancel: () => log.push("pan:cancel"),
    });
    attachGesture({ axis: "x", onPanStart: () => log.push("hpan:start") });
    pump([[1, 100, 100]]);
    pump([[1, 110, 101]]); // dominant axis is x
    expect(log).toEqual(["hpan:start", "pan:cancel"]);
  });

  test("onPanMove fires on hold frames so finger-follow sees every frame", () => {
    let moves = 0;
    attachGesture({ axis: "y", onPanMove: () => moves++ });
    pump([[1, 100, 100]]);
    pump([[1, 100, 110]]);
    pump([[1, 100, 110]]);
    pump([[1, 100, 110]]);
    expect(moves).toBe(3);
  });
});

describe("long-press", () => {
  test("fires at the virtual-frame deadline and claims", () => {
    const log: string[] = [];
    attachGesture({ onCancel: () => log.push("tap:cancel"), onTap: () => log.push("tap:tap") });
    attachGesture({ onLongPress: () => log.push("lp"), longPressSeconds: 0.1 });
    pump([[1, 100, 100]]);
    for (let i = 0; i < 5; i++) pump([[1, 100, 100]]); // frames 1..5
    expect(log).toEqual([]);
    pump([[1, 100, 100]]); // frame 6 = round(0.1 * 60)
    expect(log).toEqual(["lp", "tap:cancel"]);
    pump([]);
    expect(log).toEqual(["lp", "tap:cancel"]); // no tap after a long-press
  });

  test("deadline follows simulationHz", () => {
    withHz(30);
    let fired = 0;
    attachGesture({ onLongPress: () => fired++, longPressSeconds: 0.1 });
    pump([[1, 100, 100]]);
    pump([[1, 100, 100]]);
    pump([[1, 100, 100]]);
    expect(fired).toBe(0);
    pump([[1, 100, 100]]); // frame 3 = round(0.1 * 30)... deadline 3, frames counter hits 3 here
    expect(fired).toBe(1);
  });

  test("movement beyond slop disarms it", () => {
    let fired = 0;
    attachGesture({ onLongPress: () => fired++, longPressSeconds: 0.05 });
    pump([[1, 100, 100]]);
    pump([[1, 120, 100]]);
    for (let i = 0; i < 10; i++) pump([[1, 120, 100]]);
    expect(fired).toBe(0);
  });
});

describe("regions", () => {
  test("rect region gates ownership", () => {
    const inside: number[] = [];
    attachGesture({
      region: { rect: () => ({ x: 0, y: 100, w: 480, h: 100 }) },
      onDown: (c) => inside.push(c.y),
    });
    pump([[1, 50, 150]]);
    pump([]);
    pump([[2, 50, 50]]); // above the rect
    expect(inside).toEqual([150]);
  });
});

describe("pushTouchBlock", () => {
  test("cancels in-flight contacts and suppresses new downs; exempt recognizers keep working", () => {
    const log: string[] = [];
    attachGesture({
      onDown: () => log.push("app:down"),
      onCancel: () => log.push("app:cancel"),
      onMove: () => log.push("app:move"),
    });
    attachGesture({
      allowWhenBlocked: true,
      onDown: () => log.push("osk:down"),
      onMove: () => log.push("osk:move"),
    });
    pump([[1, 100, 100]]);
    const pop = pushTouchBlock();
    expect(log).toEqual(["osk:down", "app:down", "app:cancel"]);
    pump([[1, 100, 120]]); // held contact still tracked for the exempt owner
    pump([[2, 50, 50]]); // new down while blocked
    expect(log).toEqual(["osk:down", "app:down", "app:cancel", "osk:move", "osk:down"]);
    pop();
    pump([]);
    pump([[3, 10, 10]]);
    expect(log[log.length - 2]).toBe("osk:down");
    expect(log[log.length - 1]).toBe("app:down");
  });
});

describe("handles", () => {
  test("dispose cancels in-flight contacts and unregisters", () => {
    const log: string[] = [];
    const h = attachGesture({
      onDown: () => log.push("down"),
      onCancel: () => log.push("cancel"),
    });
    pump([[1, 100, 100]]);
    h.dispose();
    expect(log).toEqual(["down", "cancel"]);
    pump([[2, 50, 50]]);
    expect(log).toEqual(["down", "cancel"]);
  });

  test("panning reflects an in-flight pan", () => {
    const h = attachGesture({ axis: "y", onPanMove: () => {} });
    expect(h.panning).toBe(false);
    pump([[1, 100, 100]]);
    pump([[1, 100, 120]]);
    expect(h.panning).toBe(true);
    pump([]);
    expect(h.panning).toBe(false);
  });

  test("cancelled contact delivers a final GestureContact view", () => {
    const cancelled: GestureContact[] = [];
    const h = attachGesture({ onCancel: (c) => cancelled.push(c) });
    pump([[1, 100, 100]]);
    pump([[1, 105, 100]]);
    h.cancel();
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].dx).toBe(5);
  });
});
