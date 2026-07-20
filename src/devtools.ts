// Pocket DevTools runtime shim (DEVTOOLS.md). Compiled into every bundle;
// when no transport is present the per-frame cost is one branch + one ring
// write (the always-on flight recorder). Framework-agnostic: shared by the
// Solid and Vue Vapor variants (no solid-js imports here — the <Named>
// wrapper lives in components.ts).
//
// The shim wraps the composed frame handler (index.ts render()):
//   poll transport -> flush outbox -> (paused ? maybe step : record + frame)
// Hosts keep calling globalThis.frame while paused, so commands (resume/
// step/inspect/eval) stay live inside a frozen world — the core side of the
// freeze is ui.debugPause (spec op 21).

import { ANALOG_CENTER } from "../spec/spec.ts";
import type { HostOps } from "./host.ts";
import { rootMirror, setTreeMutationHook, type NodeMirror } from "./native-tree.ts";

export interface DevtoolsTransport {
  /** Ship one JSON line to the panel(s). */
  send(line: string): void;
  /** Next inbound chunk (may batch several newline-separated lines). */
  recv(): string | null | undefined;
  /** Poll cadence in frames (PSP mailbox IO is a few USB round trips). */
  everyFrames?: number;
}

/** Input tape: the complete session input, RLE-encoded (DEVTOOLS.md §4). */
export interface Tape {
  v: 1;
  app?: string;
  /** Total frames represented by `masks`. */
  frames: number;
  /** [buttonMask, runLength] pairs, in order. */
  masks: [number, number][];
  /** [packedAnalog, runLength] pairs (spec ANALOG_CENTER packing), same total
   *  frame count as `masks`. Omitted when the whole session held center —
   *  pre-analog tapes stay byte-identical and replay as center. */
  analog?: [number, number][];
  /** Absolute frame index of masks[0] (0 unless the ring wrapped). */
  startFrame?: number;
}

/** Flight-recorder capacity: 10 min at 60 fps ≈ 72 KB of u16 masks. */
const TAPE_CAP = 36000;
const TREE_THROTTLE = 30; // min frames between tree snapshots
const STATS_EVERY = 30;

interface DevtoolsState {
  ops: HostOps | null;
  transport: DevtoolsTransport | null;
  app: string | undefined;
  frame: number; // frames actually executed (== core frame counter)
  // tape ring (masks + packed analog share indices/start/len)
  tape: Uint16Array;
  tapeAnalog: Uint16Array;
  tapeStart: number; // ring index of the oldest frame
  tapeLen: number;
  tapeFirstFrame: number; // absolute frame index of the oldest entry
  // replay
  replayMasks: Uint16Array | null;
  replayAnalog: Uint16Array | null;
  replayAt: number;
  // pause
  paused: boolean;
  stepQueued: number;
  // inspect
  inspectReportId: number | null; // report rect on the next wrapper call
  inspectAskedAt: number; // hostCalls stamp, for the never-painted timeout
  // tree
  treeDirty: boolean;
  treeSentAt: number;
  saidHello: boolean;
  /** Wrapper invocations — advances even while paused (poll cadence must
   *  not freeze with the world, or resume could never arrive on PSP). */
  hostCalls: number;
}

const state: DevtoolsState = {
  ops: null,
  transport: null,
  app: undefined,
  frame: 0,
  tape: new Uint16Array(TAPE_CAP),
  tapeAnalog: new Uint16Array(TAPE_CAP),
  tapeStart: 0,
  tapeLen: 0,
  tapeFirstFrame: 0,
  replayMasks: null,
  replayAnalog: null,
  replayAt: 0,
  paused: false,
  stepQueued: 0,
  inspectReportId: null,
  inspectAskedAt: 0,
  treeDirty: true,
  treeSentAt: -TREE_THROTTLE,
  saidHello: false,
  hostCalls: 0,
};

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

/**
 * Install the shim for this mount. Called by render() after the host is
 * up. Transport resolution order: an injected `globalThis.
 * __pocketDevtoolsTransport` (browser host, tests, scripts/tape.ts), else
 * the PSP mailbox bindings on the ui namespace (native/src/dbg.rs).
 */
export function initDevtools(ops: HostOps): void {
  // QuickJS (Solid path) ships no console at all — app code calling
  // console.log must never throw, transport or not. The bridge upgrades
  // these to channel mirrors when one attaches.
  const g = globalThis as unknown as { console?: Record<string, (...a: unknown[]) => void> };
  if (!g.console) g.console = { log() {}, warn() {}, error() {} };
  state.ops = ops;
  state.frame = 0;
  state.tapeStart = 0;
  state.tapeLen = 0;
  state.tapeFirstFrame = 0;
  state.replayMasks = null;
  state.replayAnalog = null;
  state.paused = false;
  state.stepQueued = 0;
  state.inspectReportId = null;
  state.inspectAskedAt = 0;
  state.treeDirty = true;
  state.treeSentAt = -TREE_THROTTLE;
  state.saidHello = false;
  state.hostCalls = 0;
  state.app = (globalThis as { __pocketApp?: string }).__pocketApp;

  const injected = (globalThis as { __pocketDevtoolsTransport?: DevtoolsTransport })
    .__pocketDevtoolsTransport;
  if (injected) {
    state.transport = injected;
  } else if (ops.__dbgActive?.() && ops.__dbgPoll && ops.__dbgSend) {
    state.transport = {
      send: (l) => ops.__dbgSend!(l),
      recv: () => ops.__dbgPoll!(),
      everyFrames: 10,
    };
  } else {
    state.transport = null;
  }

  if (state.transport) {
    setTreeMutationHook(() => {
      state.treeDirty = true;
    });
    bridgeConsole();
  } else {
    setTreeMutationHook(null);
  }

  // Manual/eval access (also the REPL's own handle into the shim).
  (globalThis as Record<string, unknown>).__pocketDevtools = api;
}

/** Wrap the composed frame handler (render()'s input+hooks+sweep closure). */
export function wrapFrameHandler(
  h: (buttons: number, analog: number, touches?: readonly number[]) => void,
): (buttons: number, analog?: number, touches?: readonly number[]) => void {
  return (buttons: number, analogArg?: number, touchArg?: readonly number[]) => {
    state.hostCalls++;
    if (state.transport) {
      pollTransport();
      flushInspectReport();
    }
    let mask = buttons;
    let analog = analogArg === undefined ? ANALOG_CENTER : analogArg & 0xffff;
    let touch = touchArg;
    if (state.replayMasks) {
      if (state.replayAt < state.replayMasks.length) {
        mask = state.replayMasks[state.replayAt];
        analog = state.replayAnalog ? state.replayAnalog[state.replayAt] : ANALOG_CENTER;
        // A replay that predates touch input must not leak live hardware state
        // into the deterministic tape.
        touch = undefined;
        state.replayAt++;
      } else {
        state.replayMasks = null; // tape exhausted: back to live input
        state.replayAnalog = null;
        send({ t: "replayDone", frame: state.frame });
      }
    }
    if (state.paused) {
      if (state.stepQueued <= 0) return; // frozen (core froze via debugPause)
      state.stepQueued--;
      state.ops?.debugStep?.(); // arm exactly one core tick
    }
    recordMask(mask, analog);
    state.frame++;
    try {
      h(mask, analog, touch);
    } catch (e) {
      send({
        t: "error",
        frame: state.frame,
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
      throw e;
    }
    if (state.transport) afterFrame();
  };
}

// ---------------------------------------------------------------------------
// tape
// ---------------------------------------------------------------------------

function recordMask(mask: number, analog: number): void {
  if (state.tapeLen < TAPE_CAP) {
    const at = (state.tapeStart + state.tapeLen) % TAPE_CAP;
    state.tape[at] = mask;
    state.tapeAnalog[at] = analog;
    state.tapeLen++;
  } else {
    state.tape[state.tapeStart] = mask;
    state.tapeAnalog[state.tapeStart] = analog;
    state.tapeStart = (state.tapeStart + 1) % TAPE_CAP;
    state.tapeFirstFrame++;
  }
}

function rlePairs(ring: Uint16Array): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < state.tapeLen; i++) {
    const v = ring[(state.tapeStart + i) % TAPE_CAP];
    const last = out[out.length - 1];
    if (last && last[0] === v) last[1]++;
    else out.push([v, 1]);
  }
  return out;
}

function exportTape(): Tape {
  const tape: Tape = {
    v: 1,
    app: state.app,
    frames: state.tapeLen,
    masks: rlePairs(state.tape),
    startFrame: state.tapeFirstFrame,
  };
  // An all-center session omits the analog track entirely, keeping tapes from
  // stickless hosts (and every pre-analog golden) byte-identical.
  const analog = rlePairs(state.tapeAnalog);
  if (analog.length > 1 || (analog.length === 1 && analog[0][0] !== ANALOG_CENTER)) {
    tape.analog = analog;
  }
  return tape;
}

/** Expand RLE [value, run] pairs into one value per frame. */
function expandPairs(pairs: [number, number][], fill: number, total: number): Uint16Array {
  const out = new Uint16Array(total).fill(fill);
  let at = 0;
  for (const [v, n] of pairs) {
    out.fill(v, at, Math.min(at + n, total));
    at += n;
  }
  return out;
}

/** Expand a tape's RLE mask list into one mask per frame. */
export function expandTape(tape: Tape): Uint16Array {
  let total = 0;
  for (const [, n] of tape.masks) total += n;
  return expandPairs(tape.masks, 0, total);
}

/** Expand a tape's analog track (center-filled when absent). */
export function expandTapeAnalog(tape: Tape): Uint16Array {
  let total = 0;
  for (const [, n] of tape.masks) total += n;
  return expandPairs(tape.analog ?? [], ANALOG_CENTER, total);
}

// ---------------------------------------------------------------------------
// protocol
// ---------------------------------------------------------------------------

function send(msg: unknown): void {
  try {
    state.transport?.send(JSON.stringify(msg));
  } catch {
    // never let a debug channel failure take the app down
  }
}

function pollTransport(): void {
  const t = state.transport!;
  const every = t.everyFrames ?? 1;
  if (every > 1 && state.hostCalls % every !== 0) return;
  if (!state.saidHello) {
    state.saidHello = true;
    send({ t: "hello", app: state.app, host: hostKind(), frame: state.frame });
  }
  // Drain everything pending; each chunk may batch several lines.
  for (let guard = 0; guard < 64; guard++) {
    const chunk = t.recv();
    if (!chunk) break;
    for (const line of chunk.split("\n")) {
      if (line.trim()) handleMessage(line);
    }
  }
}

function handleMessage(line: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const ops = state.ops;
  switch (msg.t) {
    case "inspect": {
      const id = typeof msg.id === "number" ? msg.id : 0;
      ops?.debugInspect?.(id);
      // Rect is captured by the NEXT draw; report on the following frame.
      state.inspectReportId = id || null;
      state.inspectAskedAt = state.hostCalls;
      if (!id) send({ t: "inspect", id: 0, rect: null });
      break;
    }
    case "pause":
      state.paused = true;
      state.stepQueued = 0;
      ops?.debugPause?.(true);
      sendStats();
      break;
    case "resume":
      state.paused = false;
      ops?.debugPause?.(false);
      sendStats();
      break;
    case "step":
      state.stepQueued += typeof msg.n === "number" && msg.n > 0 ? msg.n : 1;
      break;
    case "getTree":
      sendTree();
      break;
    case "eval": {
      let ok = true;
      let value: string;
      try {
        // Indirect eval: app global scope, between frames (world quiescent).
        value = fmt((0, eval)(String(msg.code)));
      } catch (e) {
        ok = false;
        value = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
      send({ t: "evalResult", id: msg.id, ok, value });
      break;
    }
    case "dumpTape":
      send({ t: "tape", tape: exportTape() });
      break;
    case "devStats": {
      // Device diagnostic counters + build identity (OP.debugStats). The
      // PSPLINK bridge sends this on every hello to verify the embedded
      // bundle hash against local dist/; panels can poll it for underrun/
      // presented/torn counters. Hosts without the op reply data: null so
      // the round trip still completes. (Distinct from the periodic
      // {t:"stats"} shim push — that one is JS-side frame/node/tape state.)
      let data: unknown = null;
      const raw = ops?.debugStats?.();
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          data = null;
        }
      }
      send({ t: "devStats", frame: state.frame, data });
      break;
    }
    case "screenshot": {
      // PSP path only — the browser host intercepts this message itself
      // (canvas.toDataURL) and it never reaches the shim there. The native
      // side dumps raw VRAM next to the mailbox; the desktop bridge turns
      // it into the {t:"screenshot", data} PNG the panel expects.
      if (ops?.__dbgShot?.()) {
        send({ t: "screenshotRaw", file: "shot.raw", w: 480, h: 272, stride: 512, frame: state.frame });
      } else {
        send({ t: "log", level: "warn", args: ["screenshot: not supported on this host"] });
      }
      break;
    }
    case "replay": {
      // Shim-level replay: feed the tape's masks from NOW. For byte-exact
      // sessions replay from boot (the browser host intercepts this message
      // and reloads; scripts/tape.ts drives fresh instances).
      const tape = msg.tape as Tape | undefined;
      if (tape && Array.isArray(tape.masks)) {
        state.replayMasks = expandTape(tape);
        state.replayAnalog = tape.analog ? expandTapeAnalog(tape) : null;
        state.replayAt = 0;
      }
      break;
    }
    default:
      break; // unknown (e.g. host-level seek): ignore
  }
}

function afterFrame(): void {
  if (state.treeDirty && state.frame - state.treeSentAt >= TREE_THROTTLE) {
    sendTree();
  }
  if (state.frame % STATS_EVERY === 0) sendStats();
}

function flushInspectReport(): void {
  const id = state.inspectReportId;
  if (id == null) return;
  const ops = state.ops;
  if (!ops?.debugRectXY || !ops.debugRectWH) {
    state.inspectReportId = null;
    return;
  }
  const xy = ops.debugRectXY();
  if (xy === -1) {
    // Not painted yet — keep waiting, but a node that never paints
    // (display:none / detached) reports null instead of hanging.
    if (state.hostCalls - state.inspectAskedAt > 60) {
      state.inspectReportId = null;
      send({ t: "inspect", id, rect: null });
    }
    return;
  }
  const wh = ops.debugRectWH();
  state.inspectReportId = null;
  send({
    t: "inspect",
    id,
    rect: [(xy << 16) >> 16, xy >> 16, wh & 0xffff, (wh >> 16) & 0xffff],
  });
}

function sendStats(): void {
  send({
    t: "stats",
    frame: state.frame,
    nodes: countNodes(rootMirror),
    tapeLen: state.tapeLen,
    paused: state.paused,
  });
}

function sendTree(): void {
  state.treeDirty = false;
  state.treeSentAt = state.frame;
  send({ t: "tree", frame: state.frame, root: serializeNode(rootMirror) });
}

// ---------------------------------------------------------------------------
// tree snapshot
// ---------------------------------------------------------------------------

interface TreeNodeJson {
  i: number;
  t: string;
  n?: string;
  c?: string;
  x?: string;
  k?: TreeNodeJson[];
}

function serializeNode(node: NodeMirror): TreeNodeJson {
  const out: TreeNodeJson = { i: node.id, t: node.domTag ?? String(node.type) };
  if (node.debugName) out.n = node.debugName;
  const cls = node.domAttrs?.class;
  if (typeof cls === "string" && cls) out.c = cls;
  if (node.text) out.x = node.text.length > 80 ? node.text.slice(0, 79) + "…" : node.text;
  const kids: TreeNodeJson[] = [];
  for (const child of node.children) {
    if (child.domNodeType === 8) continue; // comment anchors: invisible noise
    kids.push(serializeNode(child));
  }
  if (kids.length) out.k = kids;
  return out;
}

function countNodes(node: NodeMirror): number {
  let n = 1;
  for (const child of node.children) n += countNodes(child);
  return n;
}

// ---------------------------------------------------------------------------
// console bridge + eval formatting
// ---------------------------------------------------------------------------

function bridgeConsole(): void {
  const g = globalThis as unknown as { console?: Record<string, (...a: unknown[]) => void> };
  // On QuickJS (Solid path) there is NO global console at all — the prelude
  // stub only ships with the Vue Vapor entry. With a transport attached the
  // channel IS the console, so create one from scratch.
  if (!g.console) g.console = {};
  const c = g.console;
  if ((c as { __pocketBridged?: boolean }).__pocketBridged) return;
  (c as { __pocketBridged?: boolean }).__pocketBridged = true;
  for (const level of ["log", "warn", "error"] as const) {
    const original = c[level];
    c[level] = (...args: unknown[]) => {
      send({ t: "log", level, args: args.map((a) => fmt(a)) });
      // On PSP the original is prelude.ts's no-op stub; elsewhere keep the
      // native console working too.
      original?.apply(c, args);
    };
  }
}

/** Depth/size-capped repr for eval results and console args. */
export function fmt(v: unknown, depth = 0): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string") {
    const s = v as string;
    return depth === 0 ? clip(s) : JSON.stringify(clip(s));
  }
  if (t === "number" || t === "boolean" || t === "bigint") return String(v);
  if (t === "function") {
    const name = (v as { name?: string }).name;
    return name ? `[function ${name}]` : "[function]";
  }
  if (depth >= 3) return Array.isArray(v) ? "[…]" : "{…}";
  if (Array.isArray(v)) {
    const items = v.slice(0, 20).map((x) => fmt(x, depth + 1));
    if (v.length > 20) items.push(`… ${v.length - 20} more`);
    return `[${items.join(", ")}]`;
  }
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  const entries = Object.entries(v as Record<string, unknown>).slice(0, 20);
  const body = entries.map(([k, x]) => `${k}: ${fmt(x, depth + 1)}`).join(", ");
  return `{${body}}`;
}

function clip(s: string): string {
  return s.length > 200 ? s.slice(0, 199) + "…" : s;
}

function hostKind(): string {
  const ops = state.ops as (HostOps & { __textures?: unknown }) | null;
  // Native hosts may self-identify (pocket-ui-wgpu sets "desktop"); the
  // PSP host predates the field and falls through to the tables check.
  if (typeof ops?.__host === "string") return ops.__host;
  if (ops?.__textures !== undefined) return "psp";
  if (typeof (globalThis as { document?: unknown }).document !== "undefined") return "web";
  return "headless";
}

// ---------------------------------------------------------------------------
// manual API (globalThis.__pocketDevtools — also reachable from the REPL)
// ---------------------------------------------------------------------------

const api = {
  /** Current frame index (frames actually executed). */
  get frame(): number {
    return state.frame;
  },
  /** Export the flight recorder as a Tape (always recording, every host). */
  dumpTape: (): Tape => exportTape(),
  /** Replay a tape's masks starting now (see DEVTOOLS.md on from-boot). */
  replay: (tape: Tape): void => {
    state.replayMasks = expandTape(tape);
    state.replayAnalog = tape.analog ? expandTapeAnalog(tape) : null;
    state.replayAt = 0;
  },
};
