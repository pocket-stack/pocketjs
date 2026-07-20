// playset/test/snake-sim.test.ts — the snake demo (demos/snake/) end to end
// under the deterministic sim host: the full playset composition (board
// environment + snake motion + snake play referee + grid-path-planner rival
// brain + fixed camera + HUD) boots headlessly, replays a scripted journey,
// and pins its golden traces three ways:
//
//   1. IDENTITY     two fresh boots at 60 Hz produce byte-identical per-frame
//                   framebuffer hashes (HUD included) AND byte-identical
//                   scene3d __serialize snapshots at frames 0/450/900 — and
//                   the journey really happened (apples eaten, the scripted
//                   wall run killed the player, restart re-armed the run).
//   2. SUBSAMPLING  a 30 Hz boot of the same virtual-seconds script is a
//                   strict subsample: pixels_30[m] == pixels_60[2(m+1)-1].
//   3. DEGRADATION  booting WITHOUT a scene3d host must not throw — the sim
//                   runs pure-mirror, and the HUD alone is still a
//                   deterministic pixel trace across two fresh boots.
//
// The scene3d sim host is injected as `globalThis.s3` BEFORE bundle eval via
// bootWorld's extraGlobals; because the bundle evals in this same process,
// the test keeps the sim reference and serializes scenes directly. Progress
// is asserted through the demo's globalThis.__snakeProbe debug hook.

import { describe, expect, test } from "bun:test";
import { bootWorld, fnv1a, scriptToMasks, type ScriptEvent } from "../../host-sim/sim.ts";
import { BTN } from "../../spec/spec.ts";
import { createScene3dSim } from "../scene3d/sim.ts";
import type { SnakeProbe } from "../../demos/snake/game.ts";

// The journey, in virtual seconds. Times sit on the 0.1 s grid — a multiple
// of 1/30 s, so every event lands on an exact frame at both tested rates
// (60 and 30 Hz). Two acts, hand-tuned around the rival's (deterministic)
// hunting routes — the grid advances every 0.15 s at score 0:
//   1. turn pulses walk the player around a counterclockwise loop, then a
//      held DOWN at 4.0 s runs it into the bottom wall (the rival sweeps the
//      upper board at that moment) — the scripted wall death at ~4.95 s;
//   2. a CROSS pulse on the game-over card restarts the run, and a second
//      set of turn pulses loops the fresh snake past the respawned rival,
//      ending the trace alive at 15 s.
const SCRIPT: ScriptEvent[] = [
  { at: 0.6, press: BTN.UP },
  { at: 1.5, press: BTN.LEFT },
  { at: 2.1, press: BTN.DOWN },
  { at: 3.3, press: BTN.RIGHT },
  { at: 4.0, hold: BTN.DOWN },
  { at: 5.6, hold: 0 },
  { at: 6.0, press: BTN.CROSS },
  { at: 7.4, press: BTN.UP },
  { at: 8.3, press: BTN.LEFT },
  { at: 9.4, press: BTN.DOWN },
  { at: 10.6, press: BTN.RIGHT },
  { at: 11.6, press: BTN.UP },
  { at: 12.5, press: BTN.LEFT },
  { at: 14.3, press: BTN.DOWN },
];
const SECONDS = 15;
const SNAP_FRAMES = [0, 450, 900];

interface SnakeRun {
  hz: number;
  hashes: string[];
  /** frame index (frames completed) → scene3d __serialize of the game scene. */
  snaps: Map<number, string>;
  probe: SnakeProbe;
  /** Raw RGBA of the last frame (HUD ink check). */
  finalFrame: Uint8Array;
}

function readProbe(): SnakeProbe {
  const probe = (globalThis as { __snakeProbe?: SnakeProbe }).__snakeProbe;
  if (!probe) throw new Error("snake-sim: bundle did not install globalThis.__snakeProbe");
  return probe;
}

/** Boot a fresh world (fresh scene3d sim when `withS3`) and replay SCRIPT. */
async function runSnake(hz: number, withS3: boolean, snapFrames: number[] = []): Promise<SnakeRun> {
  const sim = withS3 ? createScene3dSim() : null;
  // `s3: undefined` matters on the degraded runs: it clears any s3 a previous
  // boot in this same process installed.
  const world = await bootWorld("snake-main", hz, { s3: sim?.ops, __snakeProbe: undefined });
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
  if (!node) throw new Error(`snake-sim: node ${nodeId} missing from serialized scene`);
  return node.p;
}

// One shared set of reference runs; tests compare against them.
const runA = await runSnake(60, true, SNAP_FRAMES);
const runB = await runSnake(60, true, SNAP_FRAMES);
const run30 = await runSnake(30, true);
const bare1 = await runSnake(60, false);
const bare2 = await runSnake(60, false);

describe("snake: identity across fresh boots", () => {
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

  test("the journey happened: apples eaten, wall death fired, run restarted", () => {
    // Player head pose at frame 450 differs from frame 0 (never-flushed
    // identity pose at boot; a real board cell + bob after 7.5 s of play).
    const before = nodePose(runA.snaps.get(0)!, runA.probe.playerHeadNodeId);
    const mid = nodePose(runA.snaps.get(450)!, runA.probe.playerHeadNodeId);
    expect(mid).not.toEqual(before);

    // The probe agrees across boots and shows the scripted journey.
    expect(runA.probe.steps).toBe(900);
    expect(runA.probe.gridTicks).toBeGreaterThanOrEqual(90);
    // Items were eaten (the rival brain hunts apples on its own).
    expect(runA.probe.itemsEaten).toBeGreaterThanOrEqual(1);
    expect(runA.probe.rivalItems).toBeGreaterThanOrEqual(1);
    // The scripted wall run killed the player exactly once...
    expect(runA.probe.playerDeaths).toBe(1);
    expect(runA.probe.lastPlayerDeathReason).toBe("wall");
    // ...and the CROSS pulse after the game-over card restarted the run.
    expect(runA.probe.restarts).toBe(1);
    expect(runA.probe.status).toBe("running");
    expect(runB.probe).toEqual(runA.probe);
  });
});

describe("snake: hz-invariance", () => {
  test("30 Hz is a strict subsample of the 60 Hz trajectory", () => {
    // Subsampling theorem: pixels_hz[m] == pixels_60[(60/hz)(m+1)-1].
    expect(run30.hashes).toHaveLength(450);
    const k = 60 / run30.hz;
    for (let m = 0; m < run30.hashes.length; m++) {
      expect(run30.hashes[m]).toBe(runA.hashes[k * (m + 1) - 1]);
    }
    // Same sim trajectory too, not just the same pixels.
    expect(run30.probe.steps).toBe(900);
    expect(run30.probe.playerHead).toEqual(runA.probe.playerHead);
    expect(run30.probe.itemsEaten).toBe(runA.probe.itemsEaten);
    expect(run30.probe.playerDeaths).toBe(runA.probe.playerDeaths);
  });
});

describe("snake: graceful degradation without a scene3d host", () => {
  test("boots and runs pure-mirror; the HUD still renders deterministically", () => {
    expect(bare1.hashes).toHaveLength(900);
    expect(bare2.hashes).toEqual(bare1.hashes);
    // The HUD is alive (scores tick, the game-over card comes and goes), so
    // the pixel trace is not a single frozen frame...
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
    expect(bare1.probe.itemsEaten).toBe(runA.probe.itemsEaten);
    expect(bare1.probe.playerDeaths).toBe(runA.probe.playerDeaths);
    expect(bare1.probe.playerHead).toEqual(runA.probe.playerHead);
  });
});
