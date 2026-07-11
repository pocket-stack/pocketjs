// playset/test/runner-sim.test.ts — the endless-runner demo (demos/runner/)
// end to end under the deterministic sim host: the full composition (lane
// runner + pooled obstacle/collectible streaming + AABB collision + snowfall
// sprite pool + chase camera + HUD) boots headlessly, replays a scripted
// 15-second journey, and pins its golden traces three ways:
//
//   1. IDENTITY     two fresh boots at 60 Hz produce byte-identical per-frame
//                   framebuffer hashes (HUD included) AND byte-identical
//                   scene3d __serialize snapshots at frames 0/450/900 — and
//                   the journey really happened (score grew, an obstacle was
//                   hit, the run restarted).
//   2. SUBSAMPLING  a 30 Hz boot of the same virtual-seconds script is a
//                   strict subsample: pixels_30[m] == pixels_60[2(m+1)-1].
//   3. DEGRADATION  booting WITHOUT a scene3d host must not throw — the sim
//                   runs pure-mirror, and the HUD alone is still a
//                   deterministic pixel trace across two fresh boots.
//
// The scene3d sim host is injected as `globalThis.s3` BEFORE bundle eval via
// bootWorld's extraGlobals; because the bundle evals in this same process,
// the test keeps the sim reference and serializes scenes directly. Progress
// is asserted through the demo's globalThis.__runnerProbe debug hook.

import { describe, expect, test } from "bun:test";
import { bootWorld, fnv1a, scriptToMasks, type ScriptEvent } from "../../host-sim/sim.ts";
import { BTN } from "../../spec/spec.ts";
import { createScene3dSim } from "../scene3d/sim.ts";
import type { RunnerProbe } from "../../demos/runner/game.ts";

// The journey, in virtual seconds. Times sit on the 0.1 s grid — a multiple
// of 1/30 s, so every event lands on an exact frame at both tested rates
// (60 and 30 Hz), and 0.1 s hold pulses read identically at both rates
// (edge-triggered actions fire once either way). Hand-tuned against the
// seeded world (seed 20260617): run 1 jumps the lane-1 barrier at forward 35,
// detours to lane 2 and back, slides under the lane-1 low beam at forward 58,
// collects coins and two boost stars, then runs into the lane-1 barrier near
// forward 95 (~t 8.1). Runs 2 and 3 restart the SAME world (reset reseeds the
// spawn stream); run 2 goes straight into the barrier at forward 35 (~t 12.6),
// run 3 is still alive when the tape ends.
const SCRIPT: ScriptEvent[] = [
  { at: 0.5, hold: BTN.CROSS }, // start run 1
  { at: 0.6, hold: 0 },
  { at: 3.4, hold: BTN.CROSS }, // jump the lane-1 barrier @35
  { at: 3.5, hold: 0 },
  { at: 4.0, hold: BTN.RIGHT }, // lane detour out...
  { at: 4.1, hold: 0 },
  { at: 4.7, hold: BTN.LEFT }, // ...and back
  { at: 4.8, hold: 0 },
  { at: 5.4, hold: BTN.DOWN }, // slide under the lane-1 low beam @58
  { at: 5.5, hold: 0 },
  { at: 9.5, hold: BTN.CROSS }, // restart after crash #1
  { at: 9.6, hold: 0 },
  { at: 13.5, hold: BTN.CROSS }, // restart after crash #2
  { at: 13.6, hold: 0 },
];
const SECONDS = 15;
const SNAP_FRAMES = [0, 450, 900];
/** 60 Hz frame right before crash #1 (t = 8.0 s) — peak of run 1's scoring. */
const PEAK_STEP = 480;

interface RunnerRun {
  hz: number;
  hashes: string[];
  /** frame index (frames completed) → scene3d __serialize of the game scene. */
  snaps: Map<number, string>;
  probe: RunnerProbe;
  /** probe.score sampled at sim step PEAK_STEP (same step at every hz). */
  peakScore: number;
  /** Raw RGBA of the last frame (HUD ink check). */
  finalFrame: Uint8Array;
}

function readProbe(): RunnerProbe {
  const probe = (globalThis as { __runnerProbe?: RunnerProbe }).__runnerProbe;
  if (!probe) throw new Error("runner-sim: bundle did not install globalThis.__runnerProbe");
  return probe;
}

/** Boot a fresh world (fresh scene3d sim when `withS3`) and replay SCRIPT. */
async function runRunner(hz: number, withS3: boolean, snapFrames: number[] = []): Promise<RunnerRun> {
  const sim = withS3 ? createScene3dSim() : null;
  // `s3: undefined` matters on the degraded runs: it clears any s3 a previous
  // boot in this same process installed.
  const world = await bootWorld("runner-main", hz, { s3: sim?.ops, __runnerProbe: undefined });
  const frames = SECONDS * hz;
  const { masks, analogs } = scriptToMasks(SCRIPT, hz, frames);
  const wanted = new Set(snapFrames);
  const snaps = new Map<number, string>();
  const snap = (frame: number): void => {
    if (sim && wanted.has(frame)) snaps.set(frame, sim.ops.__serialize!(readProbe().sceneId));
  };
  snap(0);
  const hashes: string[] = [];
  let peakScore = -1;
  for (let f = 0; f < frames; f++) {
    world.frame(masks[f], analogs[f]);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
    hashes.push(fnv1a(world.render()));
    snap(f + 1);
    if (readProbe().steps === PEAK_STEP) peakScore = readProbe().score;
  }
  return { hz, hashes, snaps, probe: readProbe(), peakScore, finalFrame: world.render().slice() };
}

function nodePose(serialized: string, nodeId: number): number[] {
  const doc = JSON.parse(serialized) as { nodes: { id: number; p: number[] }[] };
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`runner-sim: node ${nodeId} missing from serialized scene`);
  return node.p;
}

// One shared set of reference runs; tests compare against them.
const runA = await runRunner(60, true, SNAP_FRAMES);
const runB = await runRunner(60, true, SNAP_FRAMES);
const run30 = await runRunner(30, true);
const bare1 = await runRunner(60, false);
const bare2 = await runRunner(60, false);

describe("runner: identity across fresh boots", () => {
  test("framebuffer hash sequence is byte-identical (HUD included)", () => {
    expect(runA.hashes).toHaveLength(900);
    expect(runB.hashes).toEqual(runA.hashes);
  });

  test("scene3d snapshots at frames 0/450/900 are byte-identical", () => {
    for (const f of SNAP_FRAMES) {
      expect(runA.snaps.get(f)).toBeDefined();
      expect(runB.snaps.get(f)).toBe(runA.snaps.get(f)!);
    }
    // And the world is actually evolving, not frozen.
    expect(runA.snaps.get(450)).not.toBe(runA.snaps.get(0));
    expect(runA.snaps.get(900)).not.toBe(runA.snaps.get(450));
  });

  test("the journey happened: score grew, a crash ended run 1, runs restarted", () => {
    // The runner rig moved between frames 0 and 450 (mid run 1).
    const before = nodePose(runA.snaps.get(0)!, runA.probe.playerNodeId);
    const mid = nodePose(runA.snaps.get(450)!, runA.probe.playerNodeId);
    expect(mid).not.toEqual(before);

    // Scoring: run 1 banked distance + coins + boosts before crashing.
    expect(runA.peakScore).toBeGreaterThan(1000);

    // Collision/game-over path: two crashes, three runs, alive at tape end.
    expect(runA.probe.steps).toBe(900);
    expect(runA.probe.collisions).toBe(2);
    expect(runA.probe.gameOvers).toBe(2);
    expect(runA.probe.runsStarted).toBe(3);
    expect(runA.probe.status).toBe("running");
    // Run 3 is younger than run 1's crash point but actively scoring.
    expect(runA.probe.score).toBeGreaterThan(50);
    expect(runA.probe.distance).toBeGreaterThan(10);

    // The probe agrees across boots.
    expect(runB.probe).toEqual(runA.probe);
    expect(runB.peakScore).toBe(runA.peakScore);
  });
});

describe("runner: hz-invariance", () => {
  test("30 Hz is a strict subsample of the 60 Hz trajectory", () => {
    // Subsampling theorem: pixels_hz[m] == pixels_60[(60/hz)(m+1)-1].
    expect(run30.hashes).toHaveLength(450);
    const k = 60 / run30.hz;
    for (let m = 0; m < run30.hashes.length; m++) {
      expect(run30.hashes[m]).toBe(runA.hashes[k * (m + 1) - 1]);
    }
    // Same sim trajectory too, not just the same pixels.
    expect(run30.probe.steps).toBe(900);
    expect(run30.probe.playerPosition).toEqual(runA.probe.playerPosition);
    expect(run30.probe.collisions).toBe(runA.probe.collisions);
    expect(run30.probe.score).toBe(runA.probe.score);
    expect(run30.peakScore).toBe(runA.peakScore);
  });
});

describe("runner: graceful degradation without a scene3d host", () => {
  test("boots and runs pure-mirror; the HUD still renders deterministically", () => {
    expect(bare1.hashes).toHaveLength(900);
    expect(bare2.hashes).toEqual(bare1.hashes);
    // The HUD is alive (score text, cards), so the pixel trace is not a
    // single frozen frame...
    expect(new Set(bare1.hashes).size).toBeGreaterThan(1);
    // ...and it draws real ink over the viewport's #0b1420 background (this
    // HUD's ink is dark navy for the snowy scene, so check all 3 channels).
    let ink = 0;
    const fb = bare1.finalFrame;
    for (let i = 0; i < fb.length; i += 4) {
      if (
        Math.abs(fb[i] - 0x0b) > 24 ||
        Math.abs(fb[i + 1] - 0x14) > 24 ||
        Math.abs(fb[i + 2] - 0x20) > 24
      ) {
        ink++;
      }
    }
    expect(ink).toBeGreaterThan(1000);
    // The sim underneath is the same fold: identical probe trajectory.
    expect(bare1.probe.steps).toBe(900);
    expect(bare1.probe.collisions).toBe(runA.probe.collisions);
    expect(bare1.probe.score).toBe(runA.probe.score);
    expect(bare1.probe.playerPosition).toEqual(runA.probe.playerPosition);
  });
});
