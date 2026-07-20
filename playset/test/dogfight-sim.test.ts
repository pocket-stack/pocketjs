// playset/test/dogfight-sim.test.ts — the dogfight demo (demos/dogfight/) end
// to end under the deterministic sim host: the full playset flight+combat
// composition (analytic terrain + airplane motion + wave director + weapon
// system + projectile manager + flight/combat referees + chase camera +
// FlightHud/radar) boots headlessly, replays a scripted sortie, and pins its
// golden traces three ways:
//
//   1. IDENTITY     two fresh boots at 60 Hz produce byte-identical per-frame
//                   framebuffer hashes (HUD included) AND byte-identical
//                   scene3d __serialize snapshots at frames 0/450/900 — and
//                   the sortie really happened (the jet moved, bandits
//                   spawned, a missile locked and fired, a hit landed).
//   2. SUBSAMPLING  a 30 Hz boot of the same virtual-seconds script is a
//                   strict subsample: pixels_30[m] == pixels_60[2(m+1)-1].
//   3. DEGRADATION  booting WITHOUT a scene3d host must not throw — the sim
//                   runs pure-mirror, and the HUD alone is still a
//                   deterministic pixel trace across two fresh boots.
//
// A fourth boot replays a scripted terrain dive and asserts the FlightPlay
// crash referee fires (probe.crashes) and downs the jet.
//
// The scene3d sim host is injected as `globalThis.s3` BEFORE bundle eval via
// bootWorld's extraGlobals; because the bundle evals in this same process,
// the test keeps the sim reference and serializes scenes directly. Progress
// is asserted through the demo's globalThis.__dogfightProbe debug hook.

import { describe, expect, test } from "bun:test";
import { bootWorld, fnv1a, scriptToMasks, type ScriptEvent } from "../../host-sim/sim.ts";
import { BTN } from "../../spec/spec.ts";
import { createScene3dSim } from "../scene3d/sim.ts";
import type { DogfightProbe } from "../../demos/dogfight/game.ts";

// The sortie, in virtual seconds. Times sit on the 0.1 s grid — a multiple
// of 1/30 s, so every event lands on an exact frame at both tested rates
// (60 and 30 Hz). Hand-tuned against the seeded wave-1 spawn geometry: a
// climb pulse, a hard right bank onto bandit 1's head-on approach, a
// missile lock (LOCKING → LOCKED → FOX TWO, the homing hit lands ~t=6.3),
// guns through the merge, then a boosted re-engagement turn with a second
// lock attempt and a parting gun burst.
const COMBAT_SCRIPT: ScriptEvent[] = [
  { at: 0.5, hold: BTN.UP },
  { at: 0.9, hold: 0 },
  { at: 1.3, hold: BTN.DOWN },
  { at: 1.7, hold: 0 },
  { at: 2.0, hold: BTN.RIGHT },
  { at: 3.9, hold: 0 },
  { at: 4.1, hold: BTN.SQUARE },
  { at: 6.5, hold: BTN.CROSS },
  { at: 8.5, hold: BTN.RIGHT | BTN.RTRIGGER },
  { at: 11.3, hold: 0 },
  { at: 11.5, hold: BTN.SQUARE },
  { at: 14.0, hold: BTN.CROSS },
];
const COMBAT_SECONDS = 15;
const SNAP_FRAMES = [0, 450, 900];

// Full throttle, then a sustained pitch-down into the valley floor: the
// FlightPlay referee must call the impact (~t=8.6 at 60 Hz).
const DIVE_SCRIPT: ScriptEvent[] = [
  { at: 0.5, hold: BTN.TRIANGLE },
  { at: 1.0, hold: BTN.TRIANGLE | BTN.DOWN },
  { at: 1.6, hold: BTN.TRIANGLE },
];
const DIVE_SECONDS = 10;

interface DogfightRun {
  hz: number;
  hashes: string[];
  /** frame index (frames completed) → scene3d __serialize of the game scene. */
  snaps: Map<number, string>;
  probe: DogfightProbe;
  /** Raw RGBA of the last frame (HUD ink check). */
  finalFrame: Uint8Array;
}

function readProbe(): DogfightProbe {
  const probe = (globalThis as { __dogfightProbe?: DogfightProbe }).__dogfightProbe;
  if (!probe) throw new Error("dogfight-sim: bundle did not install globalThis.__dogfightProbe");
  return probe;
}

/** Boot a fresh world (fresh scene3d sim when `withS3`) and replay a script. */
async function runDogfight(
  hz: number,
  withS3: boolean,
  script: ScriptEvent[],
  seconds: number,
  snapFrames: number[] = [],
): Promise<DogfightRun> {
  const sim = withS3 ? createScene3dSim() : null;
  // `s3: undefined` matters on the degraded runs: it clears any s3 a previous
  // boot in this same process installed.
  const world = await bootWorld("dogfight-main", hz, { s3: sim?.ops, __dogfightProbe: undefined });
  const frames = seconds * hz;
  const { masks, analogs } = scriptToMasks(script, hz, frames);
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
  if (!node) throw new Error(`dogfight-sim: node ${nodeId} missing from serialized scene`);
  return node.p;
}

// One shared set of reference runs; tests compare against them.
const runA = await runDogfight(60, true, COMBAT_SCRIPT, COMBAT_SECONDS, SNAP_FRAMES);
const runB = await runDogfight(60, true, COMBAT_SCRIPT, COMBAT_SECONDS, SNAP_FRAMES);
const run30 = await runDogfight(30, true, COMBAT_SCRIPT, COMBAT_SECONDS);
const bare1 = await runDogfight(60, false, COMBAT_SCRIPT, COMBAT_SECONDS);
const bare2 = await runDogfight(60, false, COMBAT_SCRIPT, COMBAT_SECONDS);
const dive = await runDogfight(60, false, DIVE_SCRIPT, DIVE_SECONDS);

describe("dogfight: identity across fresh boots", () => {
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

  test("the sortie happened: jet flew, bandits spawned, a hit landed", () => {
    // Player airframe pose at frame 900 differs from frame 0 (never-flushed
    // identity pose at boot; a real world position after 15 s of flight).
    const before = nodePose(runA.snaps.get(0)!, runA.probe.playerNodeId);
    const after = nodePose(runA.snaps.get(900)!, runA.probe.playerNodeId);
    expect(after).not.toEqual(before);

    // The probe agrees across boots and shows real combat progress.
    expect(runA.probe.steps).toBe(900);
    expect(runA.probe.enemiesSpawned).toBeGreaterThanOrEqual(2);
    expect(runA.probe.playerGunShots).toBeGreaterThanOrEqual(10);
    expect(runA.probe.playerMissileShots).toBeGreaterThanOrEqual(1);
    expect(runA.probe.playerHitsLanded).toBeGreaterThanOrEqual(1);
    expect(runA.probe.crashes).toBe(0);
    expect(runA.probe.playerDestroyed).toBe(false);
    expect(runB.probe).toEqual(runA.probe);
  });
});

describe("dogfight: hz-invariance", () => {
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
    expect(run30.probe.playerHitsLanded).toBe(runA.probe.playerHitsLanded);
    expect(run30.probe.score).toBe(runA.probe.score);
  });
});

describe("dogfight: graceful degradation without a scene3d host", () => {
  test("boots and runs pure-mirror; the HUD still renders deterministically", () => {
    expect(bare1.hashes).toHaveLength(900);
    expect(bare2.hashes).toEqual(bare1.hashes);
    // The HUD is alive (speed/heading readouts, pitch tape, radar contacts),
    // so the pixel trace is not a single frozen frame...
    expect(new Set(bare1.hashes).size).toBeGreaterThan(1);
    // ...and it draws real ink over the viewport's #0b1420 background.
    let ink = 0;
    const fb = bare1.finalFrame;
    for (let i = 0; i < fb.length; i += 4) {
      if (Math.abs(fb[i] - 0x0b) > 24) ink++;
    }
    expect(ink).toBeGreaterThan(1000);
    // The sim underneath is the same fold: identical probe trajectory.
    expect(bare1.probe.steps).toBe(900);
    expect(bare1.probe.playerHitsLanded).toBe(runA.probe.playerHitsLanded);
    expect(bare1.probe.playerPosition).toEqual(runA.probe.playerPosition);
  });
});

describe("dogfight: terrain crash referee", () => {
  test("a scripted dive fires the FlightPlay hit-ground path and downs the jet", () => {
    expect(dive.probe.crashes).toBe(1);
    expect(dive.probe.playerDestroyed).toBe(true);
    expect(dive.probe.playerHealth).toBe(0);
    // The airframe froze where it hit — below the spawn altitude, for sure.
    expect(dive.probe.playerPosition.y).toBeLessThan(100);
  });
});
