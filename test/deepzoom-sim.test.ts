// test/deepzoom-sim.test.ts — the deep-zoom pipeline under the deterministic
// sim host (DETERMINISM.md), driving the figma viewer end to end: baked
// TILESET pak entries -> src/tiles.ts fallback (PackBits decode + PSM_T8
// upload) -> generation-tagged texture streaming/freeing -> the DeepZoom
// per-tick integrator -> the wasm CLUT8 + bilinear rasterizer.
//
// The journey holds the right trigger (zoom in past two mip switches), then
// pans left on the analog nub to the Paper Kit cover, then releases into the
// momentum glide. Events sit on the 1 s grid so they land on exact frames at
// every tested hz.

import { describe, expect, test } from "bun:test";
import { runScenario, type Trace } from "../host-sim/sim.ts";
import { BTN } from "../spec/spec.ts";

const JOURNEY = [
  { at: 1, hold: BTN.RTRIGGER }, // zoom in for 2 s (~8% -> ~100%)
  { at: 3, hold: 0 },
  { at: 3, analog: 0x0080 }, // nub full left toward the cover
  { at: 6, analog: 0x8080 }, // release -> momentum glide, then settle
];
const SECONDS = 8;

const scenario = (hz: number) => ({ app: "figma-main", hz, seconds: SECONDS, script: JOURNEY });

const t60: Trace = await runScenario(scenario(60));

describe("deep-zoom determinism", () => {
  test("repeat runs are hash-identical", async () => {
    const again = await runScenario(scenario(60));
    expect(again.hashes).toEqual(t60.hashes);
  });

  test("chaos (sleeps + garbage + GC) changes nothing", async () => {
    const chaos = await runScenario(scenario(60), { maxSleepMs: 3, gcEvery: 40 });
    expect(chaos.hashes).toEqual(t60.hashes);
  }, 30000);

  test("the settled view is byte-equal across simulation rates", async () => {
    // The DeepZoom integrator runs once per 1/60 s tick regardless of the
    // frame rate, so a low-hz world lands on the same center/zoom and, once
    // the tile streamer catches up, the same pixels.
    for (const hz of [15, 5]) {
      const low = await runScenario(scenario(hz));
      expect(Buffer.compare(Buffer.from(low.finalFrame), Buffer.from(t60.finalFrame))).toBe(0);
    }
  }, 30000);

  test("the journey actually went somewhere (zoomed + panned)", () => {
    // First frame (fit view) and settled frame must differ, and the settled
    // frame must not be a blank canvas: count non-background pixels.
    expect(t60.hashes[0]).not.toEqual(t60.hashes[t60.hashes.length - 1]);
    let ink = 0;
    const fb = t60.finalFrame;
    for (let i = 0; i < fb.length; i += 4) {
      // Paper-kit pages are light; the HUD bar is dark — count either as ink
      // relative to flat mid-gray nothingness.
      if (Math.abs(fb[i] - 204) > 24) ink++;
    }
    expect(ink).toBeGreaterThan(5000);
  });
});
