// Kinetic scroller unit tests. No host, no renderer — the scroller is pure
// state + a Solid signal. The load-bearing assertions are the determinism
// ones: repeat runs are identical, and tick-integrated modes (fling/spring)
// obey the subsampling theorem — the 30 Hz trajectory IS the 60 Hz one
// sampled every other frame, including the stop tick.

import { beforeEach, describe, expect, test } from "bun:test";
import { createScroller, bindDpadScroll, type Scroller } from "../framework/src/kinetics.ts";
import { resetClock } from "../framework/src/clock.ts";
import { resetFrameHooks, runFrameHooks, __setAnalog, analogY } from "../framework/src/frame.ts";
import { BTN } from "../contracts/spec/spec.ts";

function withHz(hz: number): void {
  (globalThis as { __simHz?: number }).__simHz = hz;
  resetClock();
}

function fling(s: Scroller, v: number): void {
  s.beginDrag();
  s.endDrag(v);
}

/** Step until idle (bounded), returning the per-frame offset trace. */
function trace(s: Scroller, maxFrames = 600): number[] {
  const out: number[] = [];
  for (let i = 0; i < maxFrames && s.state() !== "idle"; i++) {
    s.step();
    out.push(s.offset());
  }
  return out;
}

beforeEach(() => {
  delete (globalThis as { __simHz?: number }).__simHz;
  resetClock();
  resetFrameHooks();
});

describe("fling", () => {
  test("decays monotonically and settles to a 1/64-px-rounded rest", () => {
    const s = createScroller({ max: () => 10_000 });
    fling(s, 600);
    const t = trace(s);
    expect(t.length).toBeGreaterThan(30);
    for (let i = 1; i < t.length; i++) {
      expect(t[i]).toBeGreaterThanOrEqual(t[i - 1]); // never reverses
      // Deltas shrink every frame — except the final one, where the settle
      // rounds to 1/64 px and may nudge the offset past the raw trajectory.
      if (i > 1 && i < t.length - 1) {
        expect(t[i] - t[i - 1]).toBeLessThanOrEqual(t[i - 1] - t[i - 2] + 1e-9);
      }
    }
    const rest = t[t.length - 1];
    expect(rest * 64).toBe(Math.round(rest * 64)); // exact 1/64 rounding
    expect(s.state()).toBe("idle");
  });

  test("is deterministic across runs", () => {
    const runOnce = (): number[] => {
      const s = createScroller({ max: () => 10_000 });
      fling(s, 587);
      return trace(s);
    };
    expect(runOnce()).toEqual(runOnce());
  });

  test("30 Hz trajectory is the 60 Hz one subsampled, same rest", () => {
    withHz(60);
    const s60 = createScroller({ max: () => 10_000 });
    fling(s60, 600);
    const t60 = trace(s60);

    withHz(30);
    const s30 = createScroller({ max: () => 10_000 });
    fling(s30, 600);
    const t30 = trace(s30);

    for (let i = 0; i < t30.length; i++) {
      const at60 = 2 * i + 1; // frame i at 30 Hz = tick 2i+2 = 60 Hz frame 2i+1
      expect(t30[i]).toBe(t60[Math.min(at60, t60.length - 1)]);
    }
    expect(t30[t30.length - 1]).toBe(t60[t60.length - 1]);
  });

  test("projectFling matches the integrated rest within the stop threshold", () => {
    const s = createScroller({ max: () => 10_000 });
    const projected = s.projectFling(600);
    fling(s, 600);
    const t = trace(s);
    // The projection is the infinite series; the integrator stops at |v|<4.
    expect(Math.abs(t[t.length - 1] - projected)).toBeLessThan(2);
  });

  test("crossing an edge hands the velocity to the spring and settles ON the edge", () => {
    const s = createScroller({ max: () => 100 });
    fling(s, 2000); // way past max=100
    const t = trace(s);
    const peak = Math.max(...t);
    expect(peak).toBeGreaterThan(100); // it overshot (rubber travel)
    expect(t[t.length - 1]).toBe(100); // and came back exactly to the edge
    expect(s.state()).toBe("idle");
  });
});

describe("tracking + rubber-band", () => {
  test("in-bounds drag is 1:1", () => {
    const s = createScroller({ max: () => 1000 });
    s.beginDrag();
    s.drag(40);
    expect(s.offset()).toBe(40);
    s.drag(-15);
    expect(s.offset()).toBe(25);
  });

  test("past the edge the iOS curve applies, capped at overscroll", () => {
    const s = createScroller({ max: () => 1000, extent: () => 272 });
    s.beginDrag();
    s.drag(-50); // 50 px past the top
    // (1 - 1/((50*0.55/272)+1))*272 = 24.9745…
    expect(s.offset()).toBeCloseTo(-24.9745, 3);
    s.drag(-10_000);
    expect(s.offset()).toBe(-48); // default overscroll cap
  });

  test("overscroll: 0 clamps hard", () => {
    const s = createScroller({ max: () => 1000, overscroll: 0 });
    s.beginDrag();
    s.drag(-50);
    expect(s.offset()).toBe(0);
  });

  test("catching mid-bounce resumes from the same displayed position", () => {
    const s = createScroller({ max: () => 1000, extent: () => 272 });
    s.beginDrag();
    s.drag(-50);
    const displayed = s.offset();
    s.endDrag(0);
    expect(s.state()).toBe("spring");
    s.beginDrag(); // catch it before it moves
    expect(s.offset()).toBe(displayed);
    s.drag(0);
    expect(s.offset()).toBeCloseTo(displayed, 9);
  });

  test("releasing out of bounds springs back to the bound exactly", () => {
    const s = createScroller({ max: () => 1000 });
    s.beginDrag();
    s.drag(-60);
    s.endDrag(0);
    const t = trace(s);
    expect(t[t.length - 1]).toBe(0);
  });

  test("slow release settles without a fling", () => {
    const s = createScroller({ max: () => 1000 });
    s.beginDrag();
    s.drag(40);
    s.endDrag(2); // under FLING_MIN_V
    expect(s.state()).toBe("idle");
    expect(s.offset()).toBe(40);
  });
});

describe("chase (im parity)", () => {
  test("covers 0.3 of the remaining distance per frame and snaps under 0.6", () => {
    const s = createScroller({ max: () => 1000 });
    s.chaseTo(100);
    s.step();
    expect(s.offset()).toBe(30);
    s.step();
    expect(s.offset()).toBe(51);
    const t = trace(s);
    expect(t[t.length - 1]).toBe(100); // exact arrival via the snap
    expect(s.state()).toBe("idle");
  });

  test("nudge moves the chase target, clamped to the range", () => {
    const s = createScroller({ max: () => 50 });
    s.nudge(30);
    s.nudge(40); // target would be 70 → clamps to 50
    const t = trace(s);
    expect(t[t.length - 1]).toBe(50);
  });

  test("isAtEnd judges the TARGET while chasing", () => {
    const s = createScroller({ max: () => 100 });
    s.chaseTo(100);
    expect(s.offset()).toBe(0); // hasn't moved yet
    expect(s.isAtEnd()).toBe(true); // but the intent is the bottom
  });
});

describe("tween + snap", () => {
  test("scrollTo lands exactly at the target after round(durMs·hz/1000) frames", () => {
    const s = createScroller({ max: () => 1000 });
    s.scrollTo(400, { durMs: 200 });
    const t = trace(s);
    expect(t.length).toBe(12); // 200 ms at 60 Hz
    expect(t[t.length - 1]).toBe(400);
  });

  test("scrollTo immediate jumps and clamps", () => {
    const s = createScroller({ max: () => 300 });
    s.scrollTo(999, { immediate: true });
    expect(s.offset()).toBe(300);
    expect(s.state()).toBe("idle");
  });

  test("snap receives the projected rest and wins over the raw fling", () => {
    const seen: number[] = [];
    const s = createScroller({
      max: () => 10_000,
      snap: (projected) => {
        seen.push(projected);
        return Math.round(projected / 100) * 100;
      },
    });
    fling(s, 600);
    expect(s.state()).toBe("tween");
    const t = trace(s);
    expect(seen).toHaveLength(1);
    expect(t[t.length - 1] % 100).toBe(0);
  });
});

describe("rebase + settle callback", () => {
  test("rebase shifts the offset and in-flight anchors", () => {
    const s = createScroller({ max: () => 10_000 });
    s.chaseTo(100);
    s.step();
    const before = s.offset();
    s.rebase(500);
    expect(s.offset()).toBe(before + 500);
    const t = trace(s);
    expect(t[t.length - 1]).toBe(600); // target rebased too
  });

  test("onSettle fires once per rest with the final offset", () => {
    const settles: number[] = [];
    const s = createScroller({ max: () => 1000, onSettle: (p) => settles.push(p) });
    s.chaseTo(80);
    trace(s);
    expect(settles).toEqual([80]);
  });
});

describe("bindDpadScroll", () => {
  test("held DOWN nudges the target 6 px per frame; UP the reverse", () => {
    const s = createScroller({ max: () => 1000 });
    bindDpadScroll(s);
    runFrameHooks(BTN.DOWN);
    runFrameHooks(BTN.DOWN);
    expect(s.state()).toBe("chase");
    const t = trace(s);
    expect(t[t.length - 1]).toBe(12);
    runFrameHooks(BTN.UP);
    expect(trace(s)[0]).toBeLessThan(12);
  });

  test("the analog nub scales by nubPx and respects the active gate", () => {
    let active = true;
    const s = createScroller({ max: () => 1000 });
    bindDpadScroll(s, { active: () => active });
    __setAnalog(((128 << 8) | 255) >>> 0); // full-down nub
    const nub = analogY();
    expect(nub).toBeGreaterThan(0.9);
    runFrameHooks(0);
    const t = trace(s);
    expect(t[t.length - 1]).toBeCloseTo(nub * 10, 9);
    active = false;
    runFrameHooks(BTN.DOWN);
    expect(s.state()).toBe("idle"); // gated: no new chase
    __setAnalog(undefined);
  });
});
