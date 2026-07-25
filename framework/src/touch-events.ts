// Touch events: browser-aligned dispatch over the native mirror tree.
//
// Pipeline (see docs/prd-touch-events.md in the ESP32 port repo):
//   hardware interrupt -> host sample task -> ring buffer -> ONE packed u32
//   event stream per frame -> this module -> W3C Touch Events subset.
//
// Key properties, by design:
//   - SAMPLE-LEVEL dispatch: every drained sample is its own event, so a
//     sub-frame down+up can never be lost (the old per-frame snapshot model
//     in touch.ts lost exactly these).
//   - ONE hit test per gesture, at touchstart (spec op 27). move/end walk
//     the implicit-capture table instead — active dragging costs no FFI.
//   - W3C implicit target capture (§5.2): the node hit at touchstart owns
//     the whole sequence, even when the contact slides off it.
//   - Bubble phase only, with stopPropagation. No capture phase, no passive
//     listeners — both are additive later; see the PRD grill answers.
//   - Zero touch = zero cost: no drained events -> no FFI, no allocation.
//   - Deterministic: events carry hardware sample times as RELATIVE dticks;
//     timeStamp is reconstructed from the virtual clock, so input tapes
//     replay byte-identically at every simulationHz.

import { virtualNow } from "./clock.ts";
import { getOps } from "./host.ts";
import type { NodeMirror } from "./native-tree.ts";

// ---- wire format (host -> framework), one u32 per event ----------------------
//
//   bits [1:0]   phase: 0=start, 1=move, 2=end, 3=cancel
//   bits [11:2]  x (logical px, 10-bit, 0..1023)
//   bits [21:12] y (logical px, 10-bit, 0..1023)
//   bits [27:22] dticks: ms since this contact's previous event, clamped at 63
//   bits [31:28] contact identifier (0..15)
//
// Single-touch controllers (ESP32-S3's CST9217) always report identifier 0,
// which makes per-contact dticks identical to a shared timeline — fully
// backward compatible with a host that predates the id field.

export const enum TouchPhase {
  Start = 0,
  Move = 1,
  End = 2,
  Cancel = 3,
}

export interface TouchSample {
  phase: TouchPhase;
  x: number;
  y: number;
  /** Milliseconds since this contact's previous sample (clamped to 63). */
  dticks: number;
  /** Contact identifier (0..15); 0 on single-touch hardware. */
  id: number;
}

export function decodeTouchSample(packed: number): TouchSample {
  return {
    phase: (packed & 0x3) as TouchPhase,
    x: (packed >>> 2) & 0x3ff,
    y: (packed >>> 12) & 0x3ff,
    dticks: (packed >>> 22) & 0x3f,
    id: (packed >>> 28) & 0xf,
  };
}

/** Test/capture helper matching the wire format. */
export function __packTouchSample(
  phase: TouchPhase,
  x: number,
  y: number,
  dticks = 0,
  id = 0,
): number {
  return (
    (((id & 0xf) << 28) |
      ((Math.min(dticks, 63) & 0x3f) << 22) |
      ((y & 0x3ff) << 12) |
      ((x & 0x3ff) << 2) |
      (phase & 0x3)) >>>
    0
  );
}

// ---- event object (W3C Touch Events subset) -----------------------------------

export interface PocketTouch {
  /** Stable for the contact's lifetime; 0 on single-touch hardware. */
  readonly identifier: number;
  /** Logical viewport coordinates. */
  readonly clientX: number;
  readonly clientY: number;
  /** No windowing on PocketJS targets: aliased to clientX/Y. */
  readonly screenX: number;
  readonly screenY: number;
  /** Implicit capture target (the node hit at touchstart). */
  readonly target: NodeMirror;
}

export type TouchEventType = "touchstart" | "touchmove" | "touchend" | "touchcancel";
export type TouchHandler = (ev: PocketTouchEvent) => void;

export interface PocketTouchEvent {
  readonly type: TouchEventType;
  /** Contacts still active at dispatch time (W3C §5.3). */
  readonly touches: readonly PocketTouch[];
  /** Active contacts whose target equals currentTarget, per bubble step. */
  readonly targetTouches: readonly PocketTouch[];
  /** Contacts that changed in this event. */
  readonly changedTouches: readonly PocketTouch[];
  /** ms of virtual time at the SAMPLE moment (hardware capture time). */
  readonly timeStamp: number;
  /** The implicit-capture target; constant through the bubble walk. */
  readonly target: NodeMirror;
  /** The node currently being invoked; walks target -> ... -> root. */
  readonly currentTarget: NodeMirror | null;
  readonly altKey: false;
  readonly ctrlKey: false;
  readonly metaKey: false;
  readonly shiftKey: false;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  /** Internal: set by stopPropagation; read by the bubble loop. */
  readonly __stopped: boolean;
}

// ---- handler registry (native-tree setProperty dispatch target) ----------------

const PHASE_TO_TYPE: Record<TouchPhase, TouchEventType> = {
  [TouchPhase.Start]: "touchstart",
  [TouchPhase.Move]: "touchmove",
  [TouchPhase.End]: "touchend",
  [TouchPhase.Cancel]: "touchcancel",
};

const PROP_TO_PHASE: Record<string, TouchPhase> = {
  onTouchstart: TouchPhase.Start,
  "on:touchstart": TouchPhase.Start,
  onTouchmove: TouchPhase.Move,
  "on:touchmove": TouchPhase.Move,
  onTouchend: TouchPhase.End,
  "on:touchend": TouchPhase.End,
  onTouchcancel: TouchPhase.Cancel,
  "on:touchcancel": TouchPhase.Cancel,
};

/** Mirror-side handler slots, indexed by TouchPhase. */
type HandlerSlots = (TouchHandler | undefined)[];

const slots = new WeakMap<NodeMirror, HandlerSlots>();

/** Returns the TouchPhase for a touch prop name, or -1 for non-touch props. */
export function touchPhaseForProp(name: string): TouchPhase | -1 {
  const phase = PROP_TO_PHASE[name];
  return phase === undefined ? -1 : (phase as TouchPhase);
}

export function registerTouchHandler(
  node: NodeMirror,
  phase: TouchPhase,
  fn: TouchHandler | undefined | null,
): void {
  let s = slots.get(node);
  if (!s) {
    s = [undefined, undefined, undefined, undefined];
    slots.set(node, s);
  }
  s[phase] = fn ?? undefined;
}

function handlerFor(node: NodeMirror, phase: TouchPhase): TouchHandler | undefined {
  return slots.get(node)?.[phase];
}

// ---- dispatch state --------------------------------------------------------------

interface ActiveContact extends PocketTouch {
  /** Current position (mutated by move samples; target stays fixed). */
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
}

/** Active contacts keyed by identifier: one entry per simultaneous touch
 *  point. Single-touch hardware only ever uses key 0. */
const active = new Map<number, ActiveContact>();

/** The mirror subtree root for hit resolution (app + overlay layers), set
 *  by render() alongside setInputRoot. Null falls back to input.ts's root. */
let hitRootProvider: (() => NodeMirror | null) | null = null;

/** render() injects the hit root getter (index*.ts knows app+overlay). */
export function setTouchHitRootProvider(fn: (() => NodeMirror | null) | null): void {
  hitRootProvider = fn;
}

/** Tests / unmount: drop all touch state without touching host ops. */
export function resetTouchEvents(): void {
  active.clear();
}

// findMirror walks the mirror tree by native id. Duplicated from input.ts's
// private helper deliberately: input.ts's copy resolves the FOCUS root,
// this one resolves the HIT root, and neither should import the other's
// wiring at module scope.
function findMirror(node: NodeMirror | null, id: number): NodeMirror | null {
  if (!node || id === 0) return null;
  if (node.id === id) return node;
  const kids = node.children;
  if (!Array.isArray(kids)) return null;
  for (let i = 0; i < kids.length; i++) {
    const found = findMirror(kids[i], id);
    if (found) return found;
  }
  return null;
}

// ---- per-sample dispatch -----------------------------------------------------------

function makeTouchEvent(
  type: TouchEventType,
  target: NodeMirror,
  changed: PocketTouch[],
  timeStamp: number,
): PocketTouchEvent {
  let stopped = false;
  const ev: PocketTouchEvent = {
    type,
    touches: Object.freeze([...active.values()]),
    targetTouches: [], // recomputed per bubble step below
    changedTouches: Object.freeze(changed),
    timeStamp,
    target,
    currentTarget: null,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault() {
      ev.defaultPrevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
    get __stopped() {
      return stopped;
    },
  } as PocketTouchEvent;
  return ev;
}

function dispatch(phase: TouchPhase, contact: ActiveContact, timeStamp: number): void {
  const type = PHASE_TO_TYPE[phase];
  const changed: PocketTouch[] = [
    {
      identifier: contact.identifier,
      clientX: contact.clientX,
      clientY: contact.clientY,
      screenX: contact.screenX,
      screenY: contact.screenY,
      target: contact.target,
    },
  ];
  const ev = makeTouchEvent(type, contact.target, changed, timeStamp);

  let n: NodeMirror | null = contact.target;
  while (n) {
    const h = handlerFor(n, phase);
    if (h) {
      (ev as { currentTarget: NodeMirror | null }).currentTarget = n;
      (ev as { targetTouches: readonly PocketTouch[] }).targetTouches = Object.freeze(
        [...active.values()].filter((c) => c.target === n),
      );
      h(ev);
    }
    if (ev.__stopped) break;
    n = n.parent;
  }
  (ev as { currentTarget: NodeMirror | null }).currentTarget = null;
}

/** One host-drained frame of touch samples. Called once per frame from the
 *  frame handler, BEFORE the renderer sweep, with the frame's virtual end
 *  time. Samples are dispatched in arrival order; each sample's timeStamp
 *  walks backwards from frameEndMs by its own dtick. */
export function handleTouchSamples(
  packed: readonly number[] | undefined,
  _frameEndMs?: number,
): void {
  if (!packed || packed.length === 0) return;
  const frameEndMs = _frameEndMs ?? virtualNow() * 1000;

  // Precompute absolute sample times. dticks is PER CONTACT: sample i of
  // contact c happened at frameEndMs minus the sum of dticks of all later
  // samples of contact c. Walk the frame backwards keeping one running
  // offset per contact id, so interleaved contacts each reconstruct their
  // own timeline. Single-contact streams (id always 0) reduce to a shared
  // timeline — identical to the pre-id behaviour.
  const times = new Array<number>(packed.length);
  const backByContact = new Map<number, number>();
  for (let i = packed.length - 1; i >= 0; i--) {
    const id = (packed[i] >>> 28) & 0xf;
    const back = (backByContact.get(id) ?? 0) + ((packed[i] >>> 22) & 0x3f);
    backByContact.set(id, back);
    times[i] = frameEndMs - back;
  }

  for (let i = 0; i < packed.length; i++) {
    const s = decodeTouchSample(packed[i]);
    const t = times[i];
    switch (s.phase) {
      case TouchPhase.Start: {
        if (active.has(s.id)) break; // this contact is already down: host glitch
        const ops = getOps();
        const root = hitRootProvider?.() ?? null;
        let target: NodeMirror | null = null;
        // Hosts that pre-compute hitTest deliver it via __tevHit (ESP32:
        // one Rust tree walk in C, no QuickJS bridge, and no need for a
        // ui.hitTest binding at all). Otherwise use spec op 27 from JS.
        const hitArr = (globalThis as { __tevHit?: ArrayLike<number> }).__tevHit;
        if (hitArr) {
          target = findMirror(root, hitArr[i] | 0) || root;
        } else if (ops.hitTest) {
          target = findMirror(root, ops.hitTest(s.x, s.y)) || root;
        } else {
          target = root;
        }
        if (!target) break;
        const contact: ActiveContact = {
          identifier: s.id,
          clientX: s.x,
          clientY: s.y,
          screenX: s.x,
          screenY: s.y,
          target,
        };
        active.set(s.id, contact);
        dispatch(TouchPhase.Start, contact, t);
        break;
      }
      case TouchPhase.Move: {
        const contact = active.get(s.id);
        if (!contact) break; // move without a start on this host: ignore
        // W3C: no touchmove without movement (integer logical coords).
        if (contact.clientX === s.x && contact.clientY === s.y) break;
        contact.clientX = s.x;
        contact.clientY = s.y;
        contact.screenX = s.x;
        contact.screenY = s.y;
        dispatch(TouchPhase.Move, contact, t);
        break;
      }
      case TouchPhase.End:
      case TouchPhase.Cancel: {
        const contact = active.get(s.id);
        if (!contact) break;
        contact.clientX = s.x;
        contact.clientY = s.y;
        contact.screenX = s.x;
        contact.screenY = s.y;
        // W3C §5.3: at touchend, `touches` no longer contains the released
        // contact, `changedTouches` does. Remove BEFORE dispatch.
        active.delete(s.id);
        dispatch(s.phase, contact, t);
        break;
      }
    }
  }
}
