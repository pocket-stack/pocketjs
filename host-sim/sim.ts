// host-sim/sim.ts — the deterministic simulation host (DETERMINISM.md).
//
// A PocketJS host with no screen, no vblank, and no wall clock: it boots a
// built app bundle against the wasm core (the SAME HostOps binding the
// browser host and test/golden.ts use), then drives virtual frames as fast
// as the CPU allows. The clock policy is explicit: `hz` virtual frames per
// virtual second, each one JS frame() transaction plus 60/hz core ticks —
// so ms-based animations cover the same virtual time at every rate, and a
// low-rate world is a strict subsampling of the 60 Hz world's trajectory.
//
// Input is a SCRIPT in virtual seconds (`{ at, press }`), not frame counts,
// so one user journey drives every simulation rate. The run product is a
// TRACE: a per-frame framebuffer hash, every effect command/delivery with
// its frame index, and the raw final framebuffer. Two runs of the same
// scenario must produce byte-identical traces — that is the whole point —
// and callers can prove it cheaply by comparing `trace.hashes`.
//
//   import { runScenario } from "../host-sim/sim.ts";
//   const trace = await runScenario({ app: "cafe-main", hz: 4, seconds: 6,
//     script: [{ at: 1, press: BTN.DOWN }, { at: 1.5, press: BTN.CIRCLE }] });
//
// `chaos` inserts real wall-clock sleeps, garbage churn, and forced GC
// between frames. It exists so tests can PROVE the wall clock is not an
// input: a chaos trace must equal a clean trace, byte for byte.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createWasmUi } from "../host-web/wasm-ops.js";
import { normalizeHz, TICKS_PER_SECOND } from "../src/clock.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url))); // PocketJS/
const DIST = join(ROOT, "dist/");
const WASM_PATH = join(ROOT, "host-web/pocketjs.wasm");

export interface ScriptEvent {
  /** Virtual seconds since boot. Lands on frame round(at * hz) — keep script
   *  times on the 0.5 s grid and they align exactly at every valid hz. */
  at: number;
  /** BTN mask held for exactly that one virtual frame (a press pulse). */
  press?: number;
  /** BTN mask held from this frame until the next event that carries `hold`
   *  (level-triggered — for trigger-zoom style inputs; 0 releases). */
  hold?: number;
  /** Packed analog nub value ((x << 8) | y, 128 = center) held from this
   *  frame until the next event that carries `analog` (level-triggered —
   *  a one-frame nub pulse cannot pan anything). spec ANALOG_CENTER releases. */
  analog?: number;
}

export interface Scenario {
  /** Built bundle name under dist/ (e.g. "cafe-main"). */
  app: string;
  /** Virtual frames per second; must divide 60. Default 60. */
  hz?: number;
  /** Journey length in virtual seconds. */
  seconds: number;
  script?: ScriptEvent[];
}

export interface ChaosOptions {
  /** Max wall-clock sleep injected between frames (ms). */
  maxSleepMs?: number;
  /** Force a GC every N frames (0 = never). */
  gcEvery?: number;
}

export interface EffectEvent {
  t: "command" | "delivery";
  frame: number;
  id: number;
  kind: string;
}

export interface Trace {
  app: string;
  hz: number;
  frames: number;
  /** FNV-1a of the RGBA framebuffer after every virtual frame. */
  hashes: string[];
  effects: EffectEvent[];
  /** Raw RGBA of the final frame (for cross-hz byte comparison / PNGs). */
  finalFrame: Uint8Array;
  /** Component tree JSON after the final frame (DevTools getTree). */
  tree: unknown;
}

/** FNV-1a 32-bit over the RGBA framebuffer (same as scripts/tape.ts). */
export function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Expand a virtual-seconds script into per-frame masks + analog values. */
export function scriptToMasks(
  script: ScriptEvent[],
  hz: number,
  frames: number,
): { masks: number[]; analogs: number[] } {
  const ANALOG_CENTER = 0x8080; // spec.ts (kept literal — this module stays host-side)
  const masks = new Array<number>(frames).fill(0);
  const analogs = new Array<number>(frames).fill(ANALOG_CENTER);
  const holds: { f: number; v: number }[] = [];
  const nubs: { f: number; v: number }[] = [];
  for (const ev of script) {
    const f = Math.round(ev.at * hz);
    if (f < 0 || f >= frames) {
      throw new Error(`sim: script event at ${ev.at}s -> frame ${f} is outside 0..${frames - 1}`);
    }
    if (ev.press !== undefined) masks[f] |= ev.press;
    if (ev.hold !== undefined) holds.push({ f, v: ev.hold });
    if (ev.analog !== undefined) nubs.push({ f, v: ev.analog & 0xffff });
  }
  // Level-triggered tracks: each event holds its value until the next one.
  holds.sort((a, b) => a.f - b.f);
  nubs.sort((a, b) => a.f - b.f);
  for (let i = 0; i < holds.length; i++) {
    const end = i + 1 < holds.length ? holds[i + 1].f : frames;
    for (let f = holds[i].f; f < end; f++) masks[f] |= holds[i].v;
  }
  for (let i = 0; i < nubs.length; i++) {
    const end = i + 1 < nubs.length ? nubs[i + 1].f : frames;
    for (let f = nubs[i].f; f < end; f++) analogs[f] = nubs[i].v;
  }
  return { masks, analogs };
}

function ensureBuilt(path: string, cmd: string[]): void {
  if (existsSync(path)) return;
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0 || !existsSync(path)) {
    throw new Error(`sim: failed to produce ${path}`);
  }
}

let wasmBytes: ArrayBuffer | null = null;

export interface SimWorld {
  /** One host frame: buttons bitmask, analog byte, packed touch contacts
   *  (src/touch.ts __packTouch format) — exactly the native frame() shape. */
  frame: (buttons: number, analog?: number, touches?: readonly number[]) => void;
  tick: () => void;
  render: () => Uint8Array;
  ticksPerFrame: number;
  hz: number;
  effects: EffectEvent[];
  getTree: () => unknown;
}

/**
 * Boot a fresh world: fresh wasm core, fresh bundle eval, host globals
 * (ui/__pak/__simHz/effect trace/DevTools transport) installed before eval —
 * the identical boot the browser host performs, minus the screen.
 * `extraGlobals` land before eval too (e.g. a __pocketEffectDriver override —
 * scripts/flake-lab.ts injects a wall-clock driver this way).
 */
export async function bootWorld(
  app: string,
  hz: number,
  extraGlobals?: Record<string, unknown>,
  mutateOps?: (ops: Record<string, unknown>) => void,
): Promise<SimWorld> {
  ensureBuilt(WASM_PATH, [process.execPath, "scripts/wasm.ts"]);
  ensureBuilt(DIST + app + ".js", [process.execPath, "scripts/build.ts", app]);
  if (!wasmBytes) wasmBytes = await Bun.file(WASM_PATH).arrayBuffer();
  const wasm = await createWasmUi(wasmBytes);
  const g = globalThis as Record<string, unknown>;
  const effects: EffectEvent[] = [];
  const inbox: string[] = [];
  const outbox: string[] = [];
  g.ui = wasm.ops;
  // Host-flavored op extensions (the launcher runner adds appTable/appLaunch/
  // appShot here) — installed before eval like every other contract slot.
  mutateOps?.(wasm.ops as unknown as Record<string, unknown>);
  g.__pak = existsSync(DIST + app + ".pak")
    ? await Bun.file(DIST + app + ".pak").arrayBuffer()
    : undefined;
  g.frame = undefined;
  g.__pocketApp = app;
  g.__simHz = hz;
  g.__pocketEffectTrace = (e: EffectEvent) => effects.push(e);
  g.__pocketEffectDriver = undefined; // no host override unless extraGlobals injects one
  g.__pocketDevtoolsTransport = {
    send: (line: string) => outbox.push(line),
    recv: () => (inbox.length ? inbox.shift() : null),
  };
  if (extraGlobals) Object.assign(g, extraGlobals);
  const src = await Bun.file(DIST + app + ".js").text();
  (0, eval)(src);
  const frame = g.frame as
    | ((buttons: number, analog?: number, touches?: readonly number[]) => void)
    | undefined;
  if (typeof frame !== "function") {
    throw new Error("sim: bundle did not install globalThis.frame (entry must call render()/mount())");
  }
  return {
    frame,
    tick: wasm.tick,
    render: () => wasm.render(),
    ticksPerFrame: TICKS_PER_SECOND / hz,
    hz,
    effects,
    // Tree probe: ask the DevTools shim, flush with one extra frame (the
    // shim polls its transport at frame start). The probe frame advances the
    // world — call it only when the run is over.
    getTree: () => {
      outbox.length = 0;
      inbox.push(JSON.stringify({ t: "getTree" }));
      frame(0);
      for (let t = 0; t < TICKS_PER_SECOND / hz; t++) wasm.tick();
      for (const line of outbox) {
        const msg = JSON.parse(line) as { t: string; root?: unknown };
        if (msg.t === "tree") return msg.root;
      }
      return null;
    },
  };
}

/** Run one scenario to completion and return its trace. */
export async function runScenario(scenario: Scenario, chaos?: ChaosOptions): Promise<Trace> {
  const hz = normalizeHz(scenario.hz ?? TICKS_PER_SECOND);
  if (hz !== (scenario.hz ?? TICKS_PER_SECOND)) {
    throw new Error(`sim: hz=${scenario.hz} does not divide ${TICKS_PER_SECOND}`);
  }
  const frames = Math.round(scenario.seconds * hz);
  const { masks, analogs } = scriptToMasks(scenario.script ?? [], hz, frames);
  const world = await bootWorld(scenario.app, hz);
  const hashes: string[] = [];
  let garbage: unknown[] = [];
  for (let f = 0; f < frames; f++) {
    if (chaos) {
      // Real nondeterminism, injected on purpose: variable wall-clock delay,
      // allocation pressure, forced GC. None of it may reach the trace.
      await new Promise((r) => setTimeout(r, Math.random() * (chaos.maxSleepMs ?? 5)));
      garbage.push(new Array(1024).fill(f));
      if (garbage.length > 64) garbage = [];
      if (chaos.gcEvery && f % chaos.gcEvery === chaos.gcEvery - 1) Bun.gc(true);
    }
    world.frame(masks[f], analogs[f]); // one virtual-frame transaction (JS side)
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick(); // core catch-up
    hashes.push(fnv1a(world.render()));
  }
  const finalFrame = world.render().slice();
  const tree = world.getTree();
  return { app: scenario.app, hz, frames, hashes, effects: world.effects.slice(), finalFrame, tree };
}

/** Depth-first search of a DevTools tree (TreeNodeJson: text = `x`, children
 *  = `k`) for a text node containing `text` — the sim's selector query. */
export function treeHasText(tree: unknown, text: string): boolean {
  if (tree == null) return false;
  const node = tree as { x?: unknown; k?: unknown[] };
  if (typeof node.x === "string" && node.x.includes(text)) return true;
  return Array.isArray(node.k) && node.k.some((c) => treeHasText(c, text));
}
