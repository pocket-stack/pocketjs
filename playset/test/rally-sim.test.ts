// playset/test/rally-sim.test.ts — the rally demo (demos/rally/) end to end
// under the deterministic sim host: the full playset composition (race track
// environment + collision world + arcade cars + waypoint AI + lap play +
// chase camera + HUD/minimap) boots headlessly, replays a scripted journey,
// and pins its golden traces three ways:
//
//   1. IDENTITY     two fresh boots at 60 Hz produce byte-identical per-frame
//                   framebuffer hashes (HUD included) AND byte-identical
//                   scene3d __serialize snapshots at frames 0/300/600 — and
//                   the journey really happened (car moved, gates passed).
//   2. SUBSAMPLING  a 30 Hz boot of the same virtual-seconds script is a
//                   strict subsample: pixels_30[m] == pixels_60[2(m+1)-1].
//   3. DEGRADATION  booting WITHOUT a scene3d host must not throw — the sim
//                   runs pure-mirror, and the HUD alone is still a
//                   deterministic pixel trace across two fresh boots.
//
// The scene3d sim host is injected as `globalThis.s3` BEFORE bundle eval via
// bootWorld's extraGlobals; because the bundle evals in this same process,
// the test keeps the sim reference and serializes scenes directly. Progress
// is asserted through the demo's globalThis.__rallyProbe debug hook.

import { describe, expect, test } from "bun:test";
import { bootWorld, fnv1a, scriptToMasks, type ScriptEvent } from "../../host-sim/sim.ts";
import { BTN } from "../../spec/spec.ts";
import { createScene3dSim } from "../scene3d/sim.ts";
import type { RallyProbe } from "../../demos/rally/game.ts";

// The journey, in virtual seconds. Times sit on the 0.1 s grid — a multiple
// of 1/30 s, so every event lands on an exact frame at both tested rates
// (60 and 30 Hz). One level-triggered hold track: throttle all the way
// through, with corner steering pulses, a correction tap the other way, and
// a brake tap layered onto the mask. Hand-tuned so the scripted player
// clears the first two gates and keeps rolling (the AI drives itself).
const SCRIPT: ScriptEvent[] = [
  { at: 0.5, hold: BTN.CROSS },
  { at: 1.9, hold: BTN.CROSS | BTN.LEFT },
  { at: 2.3, hold: BTN.CROSS },
  { at: 4.1, hold: BTN.CROSS | BTN.LEFT },
  { at: 4.3, hold: BTN.CROSS },
  { at: 5.9, hold: BTN.CROSS | BTN.LEFT },
  { at: 6.2, hold: BTN.CROSS },
  { at: 7.8, hold: BTN.CROSS | BTN.LEFT },
  { at: 8.1, hold: BTN.CROSS },
  { at: 8.6, hold: BTN.CROSS | BTN.RIGHT },
  { at: 8.8, hold: BTN.CROSS },
  { at: 9.4, hold: BTN.CROSS | BTN.SQUARE },
  { at: 9.7, hold: BTN.CROSS },
];
const SECONDS = 10;
const SNAP_FRAMES = [0, 300, 600];

interface RallyRun {
  hz: number;
  hashes: string[];
  /** frame index (frames completed) → scene3d __serialize of the game scene. */
  snaps: Map<number, string>;
  probe: RallyProbe;
  /** Raw RGBA of the last frame (HUD ink check). */
  finalFrame: Uint8Array;
}

function readProbe(): RallyProbe {
  const probe = (globalThis as { __rallyProbe?: RallyProbe }).__rallyProbe;
  if (!probe) throw new Error("rally-sim: bundle did not install globalThis.__rallyProbe");
  return probe;
}

/** Boot a fresh world (fresh scene3d sim when `withS3`) and replay SCRIPT. */
async function runRally(hz: number, withS3: boolean, snapFrames: number[] = []): Promise<RallyRun> {
  const sim = withS3 ? createScene3dSim() : null;
  // `s3: undefined` matters on the degraded runs: it clears any s3 a previous
  // boot in this same process installed.
  const world = await bootWorld("rally-main", hz, { s3: sim?.ops, __rallyProbe: undefined });
  const frames = SECONDS * hz;
  const { masks, analogs } = scriptToMasks(SCRIPT, hz, frames);
  const wanted = new Set(snapFrames);
  const snaps = new Map<number, string>();
  const snap = (frame: number): void => {
    if (sim && wanted.has(frame)) snaps.set(frame, sim.ops.__serialize!(readProbe().sceneId));
  };
  snap(0);
  const hashes: string[] = [];
  for (let f = 0; f < frames; f++) {
    world.frame(masks[f], analogs[f]);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
    hashes.push(fnv1a(world.render()));
    snap(f + 1);
  }
  return { hz, hashes, snaps, probe: readProbe(), finalFrame: world.render().slice() };
}

function nodePose(serialized: string, nodeId: number): number[] {
  const doc = JSON.parse(serialized) as { nodes: { id: number; p: number[] }[] };
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`rally-sim: node ${nodeId} missing from serialized scene`);
  return node.p;
}

// One shared set of reference runs; tests compare against them.
const runA = await runRally(60, true, SNAP_FRAMES);
const runB = await runRally(60, true, SNAP_FRAMES);
const run30 = await runRally(30, true);
const bare1 = await runRally(60, false);
const bare2 = await runRally(60, false);

describe("rally: identity across fresh boots", () => {
  test("framebuffer hash sequence is byte-identical (HUD included)", () => {
    expect(runA.hashes).toHaveLength(600);
    expect(runB.hashes).toEqual(runA.hashes);
  });

  test("scene3d snapshots at frames 0/300/600 are byte-identical", () => {
    for (const f of SNAP_FRAMES) {
      expect(runA.snaps.get(f)).toBeDefined();
      expect(runB.snaps.get(f)).toBe(runA.snaps.get(f)!);
    }
    // And the world is actually evolving, not frozen.
    expect(runA.snaps.get(300)).not.toBe(runA.snaps.get(0));
    expect(runA.snaps.get(600)).not.toBe(runA.snaps.get(300));
  });

  test("the journey happened: the car moved and gates were passed", () => {
    // Player chassis pose at frame 600 differs from frame 0 (never-flushed
    // identity pose at boot; a real world position after 10 s of throttle).
    const before = nodePose(runA.snaps.get(0)!, runA.probe.playerNodeId);
    const after = nodePose(runA.snaps.get(600)!, runA.probe.playerNodeId);
    expect(after).not.toEqual(before);

    // The probe agrees across boots and shows race progress.
    expect(runA.probe.steps).toBe(600);
    expect(runA.probe.checkpointsPassed).toBeGreaterThanOrEqual(1);
    expect(runA.probe.playerCheckpoints).toBeGreaterThanOrEqual(1);
    expect(runB.probe).toEqual(runA.probe);
  });
});

describe("rally: hz-invariance", () => {
  test("30 Hz is a strict subsample of the 60 Hz trajectory", () => {
    // Subsampling theorem: pixels_hz[m] == pixels_60[(60/hz)(m+1)-1].
    expect(run30.hashes).toHaveLength(300);
    const k = 60 / run30.hz;
    for (let m = 0; m < run30.hashes.length; m++) {
      expect(run30.hashes[m]).toBe(runA.hashes[k * (m + 1) - 1]);
    }
    // Same sim trajectory too, not just the same pixels.
    expect(run30.probe.steps).toBe(600);
    expect(run30.probe.playerPosition).toEqual(runA.probe.playerPosition);
    expect(run30.probe.checkpointsPassed).toBe(runA.probe.checkpointsPassed);
  });
});

describe("rally: graceful degradation without a scene3d host", () => {
  test("boots and runs pure-mirror; the HUD still renders deterministically", () => {
    expect(bare1.hashes).toHaveLength(600);
    expect(bare2.hashes).toEqual(bare1.hashes);
    // The HUD is alive (lap text, speed, minimap dots move), so the pixel
    // trace is not a single frozen frame...
    expect(new Set(bare1.hashes).size).toBeGreaterThan(1);
    // ...and it draws real ink over the viewport's #0b1420 background.
    let ink = 0;
    const fb = bare1.finalFrame;
    for (let i = 0; i < fb.length; i += 4) {
      if (Math.abs(fb[i] - 0x0b) > 24) ink++;
    }
    expect(ink).toBeGreaterThan(1000);
    // The sim underneath is the same fold: identical probe trajectory.
    expect(bare1.probe.steps).toBe(600);
    expect(bare1.probe.checkpointsPassed).toBe(runA.probe.checkpointsPassed);
    expect(bare1.probe.playerPosition).toEqual(runA.probe.playerPosition);
  });
});
