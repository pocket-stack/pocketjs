// The effect shell — how the outside world enters the world (docs/DETERMINISM.md).
//
// The frame contract makes `state[n+1] = F(state[n], input[n])` true for
// button input; this module makes it true for everything else. An app never
// awaits a promise or registers a native callback: it emits a COMMAND
// (`runEffect`) and the result comes back as a frame-boundary DELIVERY —
// queued when the driver produces it, applied at the START of the next
// virtual frame, before app hooks run. Deliveries are part of `input[n]`,
// not scheduler weather: same tape in, same trajectory out.
//
// Deliberately callback-based, not promise-based: a promise resolution is
// timed by the microtask queue — a hidden input owned by the JS scheduler,
// exactly the nondeterminism this runtime exists to exclude. The frame
// boundary is the event loop here.
//
// Drivers do the actual work. Resolution order:
//   1. `globalThis.__pocketEffectDriver` — a HOST-injected driver (sim/CI
//      replay, recorded tapes); wins so harnesses can take over any bundle.
//   2. the app-installed driver (`installEffectDriver`) — e.g. a fetch
//      bridge on the web host, or a virtual-time fake backend in demos.

import { virtualFrame } from "./clock.ts";

export interface EffectCommand {
  id: number;
  kind: string;
  payload: unknown;
  /** Virtual frame the command was issued on. */
  frame: number;
}

/**
 * `deliver` may be called at any time, from any context (a timer, a fetch
 * callback, a virtual-clock `after`) — it only ENQUEUES; the app's onResult
 * runs at the next frame boundary. Calling it twice for one command is a
 * no-op the second time.
 */
export type EffectDriver = (cmd: EffectCommand, deliver: (result: unknown) => void) => void;

interface TraceSink {
  (event: {
    t: "command" | "delivery";
    frame: number;
    id: number;
    kind: string;
  }): void;
}

let appDriver: EffectDriver | null = null;
let nextId = 1;
const pending = new Map<number, { kind: string; onResult: (result: never) => void }>();
let queue: { id: number; result: unknown }[] = [];

function hostDriver(): EffectDriver | null {
  const d = (globalThis as { __pocketEffectDriver?: unknown }).__pocketEffectDriver;
  return typeof d === "function" ? (d as EffectDriver) : null;
}

function traceSink(): TraceSink | null {
  const s = (globalThis as { __pocketEffectTrace?: unknown }).__pocketEffectTrace;
  return typeof s === "function" ? (s as TraceSink) : null;
}

/** Install the app-side driver (last install wins; host driver overrides). */
export function installEffectDriver(driver: EffectDriver): void {
  appDriver = driver;
}

/**
 * Emit a command to the effect shell. `onResult` runs at a future frame
 * boundary with whatever the driver delivered. Returns the command id.
 */
export function runEffect<T>(kind: string, payload: unknown, onResult: (result: T) => void): number {
  const driver = hostDriver() ?? appDriver;
  if (!driver) {
    throw new Error(
      `PocketJS: runEffect("${kind}") with no effect driver — ` +
        "installEffectDriver() in the app, or inject globalThis.__pocketEffectDriver from the host",
    );
  }
  const id = nextId++;
  const cmd: EffectCommand = { id, kind, payload, frame: virtualFrame() };
  pending.set(id, { kind, onResult });
  traceSink()?.({ t: "command", frame: cmd.frame, id, kind });
  let delivered = false;
  driver(cmd, (result) => {
    if (delivered) return;
    delivered = true;
    queue.push({ id, result });
  });
  return id;
}

/** Fresh queues for a fresh mount. Keeps the installed driver: demo bundles
 *  install theirs at module scope, before render() runs. */
export function resetEffects(): void {
  nextId = 1;
  pending.clear();
  queue = [];
}

/**
 * Apply queued deliveries, FIFO. Called by the frame pump after the clock
 * advances and before app hooks — deliveries are the first thing frame n's
 * transaction observes.
 */
export function __drainEffects(): void {
  if (queue.length === 0) return;
  const batch = queue;
  queue = []; // deliveries produced DURING the drain land next frame
  for (const { id, result } of batch) {
    const entry = pending.get(id);
    if (!entry) continue; // reset since issue — drop
    pending.delete(id);
    traceSink()?.({ t: "delivery", frame: virtualFrame(), id, kind: entry.kind });
    (entry.onResult as (r: unknown) => void)(result);
  }
}
