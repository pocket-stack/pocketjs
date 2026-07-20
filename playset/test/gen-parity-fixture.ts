// playset/test/gen-parity-fixture.ts — writes the rally TRAJECTORY-PARITY
// golden that pins the native sim core against the TS reference.
//
// REGENERATE WITH:
//
//     bun playset/test/gen-parity-fixture.ts
//
// from the repo root. It rewrites
// pocket3d/crates/pocket-playset/tests/fixtures/rally-parity.json in place and
// is idempotent: same inputs, byte-identical output, no timestamps, no paths,
// no wall clock. `--check` re-generates in memory and exits non-zero if the
// committed file differs, which is how CI (or you) can tell the golden has
// gone stale. Consumed by pocket3d/crates/pocket-playset/tests/parity.rs.
//
// WHY IT EXISTS. The TS modules under playset/modules/ are THE reference
// implementation (playset/sim/ops.ts) and byte-exact goldens pin them. The
// native f32 port in pocket3d/crates/pocket-playset is trajectory-equivalent,
// not bit-equivalent, so nothing byte-exact can pin it — and until this
// fixture existed, nothing pinned it at all. A sign error in the steering, a
// swapped right/forward axis, a dropped drag term: all of them would have
// shipped green.
//
// HOW IT STAYS HONEST. The generator boots demos/rally/game.ts TWICE, from the
// same entry point the game itself uses, so the fixture cannot drift from the
// demo:
//
//   pass A   with a RECORDING `ps` installed on globalThis. detectSim() finds
//            it, createRallyGame() takes the native path, and every assembly
//            op — terrain grid, all 528 colliders, both tunings, both spawns,
//            the rival's brain, the race, the camera rig — lands in the op
//            log verbatim. That log IS the fixture's assembly section, so the
//            Rust side builds from exactly what the mount would have fed it.
//            The recorder never steps: it only watches the world get built.
//
//   pass B   with no `ps` at all — the graceful-absence path, which is what
//            the JS host already does. createRallyGame() takes the TS core,
//            replays the scripted button tape, and its per-frame state is
//            sampled into the trace.
//
// Both passes build through buildWorld(), whose only entropy is a
// RandomGenerator seeded with 42, so the two worlds are identical; the
// generator asserts that (checkpoint positions and spawn poses recorded in
// pass A are re-checked against pass B) rather than assuming it.
//
// The trace is subsampled — every SAMPLE_EVERY-th frame — because the point is
// bounded divergence over a long run, not a per-frame diff, and 120 samples
// keep the golden reviewable.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BTN, FIXED_DT } from "../../spec/spec.ts";
import { scriptToMasks, type ScriptEvent } from "../../host-sim/sim.ts";
// Imported statically, and that is safe on purpose: nothing in game.ts reads
// `globalThis.ps` at module scope — detectSim() runs inside createRallyGame() —
// so one import serves both the recording pass and the reference pass.
import { createRallyGame, type RallyProbe } from "../../demos/rally/game.ts";

const ROOT = join(import.meta.dir, "..", "..");
const OUT = join(ROOT, "pocket3d/crates/pocket-playset/tests/fixtures/rally-parity.json");

// ---------------------------------------------------------------------------
// the tape
// ---------------------------------------------------------------------------

/** Virtual seconds of driving. 600 frames at 60 Hz. */
const SECONDS = 10;
const HZ = 60;
/** Trace one frame in five: 120 samples is plenty to see drift GROW. */
const SAMPLE_EVERY = 5;

// The journey, in virtual seconds. Times sit on the 0.1 s grid, so every event
// lands on an exact frame. Throttle from 0.5 s and held the whole way, steering
// pulses through the circuit's first three corners with counter-steer out of
// each, and a brake tap at 6.9 s (the only thing that exercises the motion
// controller's reverse/brake branch).
//
// IT IS A CLEAN LAP, AND THAT IS THE POINT. The tape was tuned (offline, by
// greedy search over the TS core) so the player never takes a hard barrier
// hit: peak deceleration over the whole run is 15.7 u/s², which is cornering
// scrub, an order of magnitude below a push-out impact.
//
// Why that matters more than the extra coverage a crash would buy: a hard
// collision is a BIFURCATION, not a divergence. The two cores reach the
// barrier with sub-millimetre different positions, so they penetrate by
// different amounts on different frames, get different correction vectors, and
// leave the wall on genuinely different lines. Measured on the earlier tape
// (which did crash, at ~4.3 s), divergence went from 0.03 u to 1.13 u and the
// checkpoint counts came apart by five frames — through no porting bug at all.
// Bounds wide enough to absorb that are wide enough to hide a real one, so the
// tape stays out of the walls and the bounds stay tight.
//
// The resolver is still exercised on every one of the 600 frames: both cars
// are registered actors resolving against each other and against the gathered
// barrier/prop colliders, and the ground clamp runs each step. What the tape
// deliberately skips is only the deep-penetration push-out.
const SCRIPT: ScriptEvent[] = [
  { at: 0.5, hold: BTN.CROSS },
  { at: 1.1, hold: BTN.CROSS | BTN.LEFT },
  { at: 1.5, hold: BTN.CROSS },
  { at: 3.7, hold: BTN.CROSS | BTN.LEFT },
  { at: 3.9, hold: BTN.CROSS | BTN.RIGHT },
  { at: 4.1, hold: BTN.CROSS },
  { at: 4.5, hold: BTN.CROSS | BTN.LEFT },
  { at: 4.7, hold: BTN.CROSS | BTN.RIGHT },
  { at: 4.9, hold: BTN.CROSS | BTN.LEFT },
  { at: 5.1, hold: BTN.CROSS | BTN.RIGHT },
  { at: 5.3, hold: BTN.CROSS },
  { at: 5.5, hold: BTN.CROSS | BTN.LEFT },
  { at: 5.7, hold: BTN.CROSS | BTN.RIGHT },
  { at: 5.9, hold: BTN.CROSS | BTN.LEFT },
  { at: 6.1, hold: BTN.CROSS },
  { at: 6.5, hold: BTN.CROSS | BTN.LEFT },
  { at: 6.7, hold: BTN.CROSS },
  { at: 6.9, hold: BTN.CROSS | BTN.SQUARE },
  { at: 7.1, hold: BTN.CROSS },
  { at: 8.3, hold: BTN.CROSS | BTN.LEFT },
  { at: 8.5, hold: BTN.CROSS },
];

// ---------------------------------------------------------------------------
// pass A — record the assembly op stream
// ---------------------------------------------------------------------------

type OpCall = [name: string, args: unknown[]];

/** Every `ps.*` call createRallyGame() makes while assembling the world. */
function recordAssembly(): OpCall[] {
  const calls: OpCall[] = [];
  let nextCar = 0;
  // A Proxy rather than a literal: it answers to whatever the contract grows
  // next, so a new assembly op shows up in the log instead of throwing here.
  (globalThis as Record<string, unknown>).ps = new Proxy(
    {},
    {
      get(_t, name: string) {
        if (name === "__host") return "recorder";
        return (...args: unknown[]) => {
          calls.push([name, args]);
          // detectSim() only needs worldCreate to be a function; these two
          // returns are the handles the rest of the assembly threads through.
          if (name === "worldCreate") return 1;
          if (name === "carCreate") return ++nextCar;
          return undefined;
        };
      },
    },
  );
  try {
    const game = createRallyGame();
    if (game.core !== "recorder") {
      throw new Error(`gen-parity-fixture: pass A took the ${game.core} path, expected the recorder`);
    }
  } finally {
    delete (globalThis as Record<string, unknown>).ps;
  }
  return calls;
}

function one(calls: OpCall[], name: string): unknown[] {
  const hits = calls.filter((c) => c[0] === name);
  if (hits.length !== 1) {
    throw new Error(`gen-parity-fixture: expected exactly one ${name} op, saw ${hits.length}`);
  }
  return hits[0][1];
}

function all(calls: OpCall[], name: string): unknown[][] {
  return calls.filter((c) => c[0] === name).map((c) => c[1]);
}

// ---------------------------------------------------------------------------
// number formatting
// ---------------------------------------------------------------------------

/** Shortest decimal that round-trips to the SAME f32 — every assembly payload
 *  crossed the op boundary as a Float32Array, so this is lossless, and it
 *  keeps 6,600 floats from costing 17 characters each. */
function f32(v: number): string {
  const f = Math.fround(v);
  if (!Number.isFinite(f)) throw new Error(`gen-parity-fixture: non-finite payload float ${v}`);
  if (Number.isInteger(f) && Math.abs(f) < 1e15) return String(f);
  for (let p = 1; p <= 9; p++) {
    const s = Number(f.toPrecision(p));
    if (Math.fround(s) === f) return String(s);
  }
  return String(f);
}

/** Reference-trace values are f64 and stay f64; a micron of rounding is six
 *  orders of magnitude below the tightest bound parity.rs asserts. */
function f64(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`gen-parity-fixture: non-finite trace float ${v}`);
  const r = Math.round(v * 1e6) / 1e6;
  return String(Object.is(r, -0) ? 0 : r);
}

/** A JSON array of pre-formatted numbers, wrapped so the golden stays
 *  greppable in a diff instead of being one 30 kB line. */
function numArray(values: ArrayLike<number>, fmt: (v: number) => string, indent: string, perLine: number): string {
  const out: string[] = [];
  for (let i = 0; i < values.length; i += perLine) {
    const row: string[] = [];
    for (let j = i; j < Math.min(i + perLine, values.length); j++) row.push(fmt(values[j]));
    out.push(indent + "  " + row.join(", "));
  }
  return out.length === 0 ? "[]" : "[\n" + out.join(",\n") + "\n" + indent + "]";
}

// ---------------------------------------------------------------------------
// build the fixture
// ---------------------------------------------------------------------------

function build(): string {
  const calls = recordAssembly();

  // -- assembly, straight out of the op log -------------------------------
  const [, terrainSize, terrainSide, heights] = one(calls, "terrainHeightfield") as [
    number,
    number,
    number,
    Float32Array,
  ];
  const [, colliderKinds, colliderData, colliderCount] = one(calls, "collidersAdd") as [
    number,
    Uint32Array,
    Float32Array,
    number,
  ];
  const tunings = all(calls, "carCreate").map((a) => a[1] as Float32Array);
  const resets = all(calls, "carReset").map((a) => a.slice(2) as number[]);
  const actors = all(calls, "carActor").map((a) => a.slice(2) as number[]);
  const brains = all(calls, "carBrain").map((a) => ({
    car: a[1] as number,
    waypoints: a[2] as Float32Array,
    count: a[3] as number,
    config: a[4] as Float32Array,
  }));
  const [, gates, gateCount, lapCount] = one(calls, "raceInit") as [
    number,
    Float32Array,
    number,
    number,
  ];
  const [, cameraCar, cameraConfig] = one(calls, "cameraRig") as [number, number, Float32Array];

  if (tunings.length !== 2 || resets.length !== 2 || actors.length !== 2) {
    throw new Error("gen-parity-fixture: rally is a two-car composition; the op log disagrees");
  }
  if (brains.length !== 1 || brains[0].car !== 2) {
    throw new Error("gen-parity-fixture: expected exactly one brain, on car 2 (the rival)");
  }

  // -- pass B: the TS reference trajectory ---------------------------------
  const frames = SECONDS * HZ;
  const { masks } = scriptToMasks(SCRIPT, HZ, frames);
  const game = createRallyGame();
  if (game.core !== "ts") {
    throw new Error(`gen-parity-fixture: pass B took the ${game.core} path, expected "ts"`);
  }

  // The two passes must have built the SAME world — otherwise the trace below
  // describes a track the Rust side is not driving on. Check it, don't assume
  // it: the shared build is seeded (RandomGenerator(42)) but that is a
  // property of demos/rally/game.ts, not of this file.
  if (game.checkpoints.length !== gateCount) {
    throw new Error("gen-parity-fixture: checkpoint count differs between the two boots");
  }
  game.checkpoints.forEach((c, i) => {
    for (const [k, v] of [["x", c.x], ["y", c.y], ["z", c.z]] as const) {
      if (Math.fround(v) !== gates[i * 4 + "xyz".indexOf(k)]) {
        throw new Error(`gen-parity-fixture: checkpoint ${i}.${k} differs between the two boots`);
      }
    }
  });

  const probe = (globalThis as { __rallyProbe?: RallyProbe }).__rallyProbe;
  if (!probe) throw new Error("gen-parity-fixture: rally did not install globalThis.__rallyProbe");

  // Trace row layout — keep in sync with TRACE_* in parity.rs.
  const trace: number[][] = [];
  const sample = (frame: number): void => {
    const hud = game.hudState();
    trace.push([
      frame,
      probe.playerPosition.x,
      probe.playerPosition.y,
      probe.playerPosition.z,
      hud.playerForward.x,
      hud.playerForward.y,
      hud.playerForward.z,
      probe.playerSpeed,
      probe.checkpointsPassed,
      hud.rivalPosition.x,
      hud.rivalPosition.y,
      hud.rivalPosition.z,
    ]);
  };

  for (let f = 0; f < frames; f++) {
    game.step(FIXED_DT, { buttons: masks[f], analogX: 0, analogY: 0 });
    if ((f + 1) % SAMPLE_EVERY === 0) sample(f + 1);
  }

  if (probe.steps !== frames) {
    throw new Error(`gen-parity-fixture: probe counted ${probe.steps} steps, expected ${frames}`);
  }
  if (probe.checkpointsPassed < 1) {
    throw new Error("gen-parity-fixture: the tape passed no checkpoints — it is not a journey");
  }

  // -- run-length the button tape -----------------------------------------
  // 600 masks compress to a dozen runs, and a run list is what a human can
  // actually read: "throttle from frame 30, +left from 114".
  const runs: number[][] = [];
  for (let f = 0; f < frames; f++) {
    if (f === 0 || masks[f] !== masks[f - 1]) runs.push([f, masks[f]]);
  }

  // -- emit ----------------------------------------------------------------
  const car = (i: number): string => {
    const brain = brains.find((b) => b.car === i + 1);
    const lines = [
      `      "tuning": ${numArray(tunings[i], f32, "      ", 10)},`,
      `      "spawn": [${resets[i].map(f32).join(", ")}],`,
      `      "actorHalf": [${actors[i].map(f32).join(", ")}],`,
    ];
    if (brain) {
      lines.push(
        `      "brain": {`,
        `        "count": ${brain.count},`,
        `        "config": [${Array.from(brain.config).map(f32).join(", ")}],`,
        `        "waypoints": ${numArray(brain.waypoints, f32, "        ", 6)}`,
        `      }`,
      );
    } else {
      lines.push(`      "brain": null`);
    }
    return "    {\n" + lines.join("\n") + "\n    }";
  };

  return `{
  "$comment": [
    "GOLDEN — do not hand-edit. Regenerate with: bun playset/test/gen-parity-fixture.ts",
    "Rally trajectory-parity fixture: the assembly the ps.* ops carry (recorded",
    "verbatim from demos/rally/game.ts's native path) plus the TS reference",
    "core's trajectory over the same scripted button tape. Consumed by",
    "pocket3d/crates/pocket-playset/tests/parity.rs, which assembles the same",
    "world natively and asserts BOUNDED divergence — the two cores are f32 vs",
    "f64, trajectory-equivalent and never bit-equivalent (playset/sim/ops.ts)."
  ],
  "version": 1,
  "generator": "playset/test/gen-parity-fixture.ts",
  "reference": "demos/rally/game.ts createTsRally (playset/modules/, f64)",
  "hz": ${HZ},
  "dt": ${FIXED_DT},
  "frames": ${frames},
  "sampleEvery": ${SAMPLE_EVERY},

  "$script": "virtual-seconds tape; expanded by host-sim/sim.ts scriptToMasks",
  "script": [
${SCRIPT.map((e) => `    { "at": ${e.at}, "hold": ${e.hold} }`).join(",\n")}
  ],
  "$masks": "run-length spec BTN masks: [firstFrame, mask], held until the next run",
  "masks": [
${runs.map((r) => `    [${r[0]}, ${r[1]}]`).join(",\n")}
  ],

  "$terrain": "ps.terrainHeightfield: row-major side*side over a size-wide square centred on the origin, row = forward, col = right",
  "terrain": {
    "size": ${f32(terrainSize)},
    "side": ${terrainSide},
    "heights": ${numArray(heights, f32, "    ", 12)}
  },

  "$colliders": "ps.collidersAdd: kinds[i] in {0 cuboid, 1 cylinder, 2 ball}; data stride 8 = [x, y, z, a, b, c, yaw, flags], flags bit0 solid, bit1 walkable",
  "colliders": {
    "count": ${colliderCount},
    "kinds": ${numArray(colliderKinds, (v) => String(v), "    ", 40)},
    "data": ${numArray(colliderData, f32, "    ", 8)}
  },

  "$cars": "ps.carCreate/carReset/carActor/carBrain, in assembly order; car 1 is the player (no brain, driven by the mask), car 2 the rival. tuning = CarTuningConfig, spawn = [x, y, z, yaw], actorHalf = resolver cuboid half extents",
  "cars": [
${[0, 1].map(car).join(",\n")}
  ],

  "$race": "ps.raceInit: checkpoints stride 4 = [x, y, z, radius]",
  "race": {
    "lapCount": ${lapCount},
    "count": ${gateCount},
    "checkpoints": ${numArray(gates, f32, "    ", 8)}
  },

  "$camera": "ps.cameraRig: CameraRigConfig floats, offsets in BASIS components (right, up, forward)",
  "camera": {
    "car": ${cameraCar},
    "config": [${Array.from(cameraConfig).map(f32).join(", ")}]
  },

  "$trace": "the TS reference core, sampled every sampleEvery-th frame",
  "traceLayout": ["frame", "px", "py", "pz", "fx", "fy", "fz", "speed", "gates", "rx", "ry", "rz"],
  "trace": [
${trace.map((r) => `    [${r.map(f64).join(", ")}]`).join(",\n")}
  ]
}
`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const text = build();
const check = process.argv.includes("--check");
if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== text) {
    console.error(`gen-parity-fixture: ${OUT} is STALE — rerun \`bun playset/test/gen-parity-fixture.ts\``);
    process.exit(1);
  }
  console.log(`gen-parity-fixture: ${OUT} is up to date`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`gen-parity-fixture: wrote ${OUT} (${(text.length / 1024).toFixed(1)} kB)`);
}
