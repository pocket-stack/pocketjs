// Versioned per-frame input extensions.
//
// The first four frame() arguments are the stable legacy tracks (buttons,
// analog, touches, touch hit facts). Everything added after those tracks
// travels in this single append-only payload as frame() argument 5. Keeping
// the payload versioned prevents a new input family from silently claiming an
// old positional argument, and lets DevTools record/replay it as one unit.

export const FRAME_INPUT_VERSION = 1 as const;

export const POINTER_EVENT = {
  MOVE: 0,
  DOWN: 1,
  UP: 2,
  LEAVE: 3,
  CANCEL: 4,
} as const;

export const POINTER_MODIFIER = {
  SHIFT: 1,
} as const;

export type PointerEventCode = (typeof POINTER_EVENT)[keyof typeof POINTER_EVENT];

/**
 * Compact native wire event.
 *
 * Position events are `[kind, x, y, button?, modifiers?]`; boundary events
 * are `[LEAVE]` or `[CANCEL]`. Coordinates are ordinary finite JS numbers,
 * deliberately not bit-packed, so a 4096x4096 logical viewport is exact.
 * Button 0 is the primary button. DOWN/UP are edges, not sampled levels, so
 * both may occur in one host tick without losing a fast click.
 */
export type PointerWireEvent = readonly [
  kind: PointerEventCode,
  x?: number,
  y?: number,
  button?: number,
  modifiers?: number,
];

export interface FrameInputV1 {
  readonly v: typeof FRAME_INPUT_VERSION;
  readonly pointer?: readonly PointerWireEvent[];
}

export type FrameInput = FrameInputV1;

type PointerPositionEvent<T extends "move" | "down" | "up"> = Readonly<{
  type: T;
  x: number;
  y: number;
  button: number;
  shift: boolean;
}>;

export type PointerEvent =
  | PointerPositionEvent<"move">
  | PointerPositionEvent<"down">
  | PointerPositionEvent<"up">
  | Readonly<{ type: "leave" }>
  | Readonly<{ type: "cancel" }>;

const EMPTY: readonly PointerEvent[] = Object.freeze([]);
let pointerSnapshot: readonly PointerEvent[] = EMPTY;

function decodePointer(events: readonly PointerWireEvent[] | undefined): readonly PointerEvent[] {
  if (!events || events.length === 0) return EMPTY;
  const out: PointerEvent[] = [];
  for (const raw of events.slice(0, 32)) {
    if (!Array.isArray(raw)) continue;
    const kind = raw[0];
    if (kind === POINTER_EVENT.LEAVE || kind === POINTER_EVENT.CANCEL) {
      out.push(Object.freeze({ type: kind === POINTER_EVENT.LEAVE ? "leave" : "cancel" }));
      continue;
    }
    if (kind !== POINTER_EVENT.MOVE && kind !== POINTER_EVENT.DOWN && kind !== POINTER_EVENT.UP) {
      continue;
    }
    const x = raw[1];
    const y = raw[2];
    if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
      continue;
    }
    out.push(
      Object.freeze({
        type: kind === POINTER_EVENT.MOVE ? "move" : kind === POINTER_EVENT.DOWN ? "down" : "up",
        x,
        y,
        button: Number.isInteger(raw[3]) ? Math.max(0, raw[3]!) : 0,
        shift: ((raw[4] ?? 0) & POINTER_MODIFIER.SHIFT) !== 0,
      }),
    );
  }
  return out.length === 0 ? EMPTY : Object.freeze(out);
}

/** Latch frame() argument 5 before lifecycle callbacks run. */
export function __setFrameInput(input: FrameInput | undefined): void {
  pointerSnapshot = input?.v === FRAME_INPUT_VERSION ? decodePointer(input.pointer) : EMPTY;
}

export function __resetFrameInput(): void {
  pointerSnapshot = EMPTY;
}

/** Ordered real-pointer events delivered during the current host tick. */
export function pointerEvents(): readonly PointerEvent[] {
  return pointerSnapshot;
}

/**
 * Defensive, bounded copy for the flight recorder. Unknown versions are not
 * guessed: a newer host must first teach this runtime how to preserve them.
 */
export function cloneFrameInput(input: FrameInput | undefined): FrameInput | undefined {
  if (!input || input.v !== FRAME_INPUT_VERSION || !input.pointer?.length) return undefined;
  const pointer: PointerWireEvent[] = [];
  for (const raw of input.pointer.slice(0, 32)) {
    if (!Array.isArray(raw)) continue;
    const kind = raw[0];
    if (kind === POINTER_EVENT.LEAVE || kind === POINTER_EVENT.CANCEL) {
      pointer.push([kind]);
      continue;
    }
    if (kind !== POINTER_EVENT.MOVE && kind !== POINTER_EVENT.DOWN && kind !== POINTER_EVENT.UP) {
      continue;
    }
    const x = raw[1];
    const y = raw[2];
    if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
      continue;
    }
    pointer.push([kind, x, y, Number.isInteger(raw[3]) ? Math.max(0, raw[3]!) : 0, raw[4] ?? 0]);
  }
  return pointer.length > 0 ? { v: FRAME_INPUT_VERSION, pointer } : undefined;
}
