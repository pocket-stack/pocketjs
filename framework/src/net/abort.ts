import { NetworkError } from "./index.ts";

export interface AbortEvent {
  readonly type: "abort";
  readonly target: AbortSignal;
  readonly currentTarget: AbortSignal;
}

export type AbortListener = (event: AbortEvent) => void;
type AbortAlgorithm = () => void;

const ABORT_SIGNAL_TOKEN = Symbol("pocketjs.net.AbortSignal");

interface AbortState {
  aborted: boolean;
  reason: unknown;
  readonly listeners: Set<AbortListener>;
  readonly algorithms: Set<AbortAlgorithm>;
}

const abortStates = new WeakMap<AbortSignal, AbortState>();

function abortState(signal: AbortSignal): AbortState {
  const state = abortStates.get(signal);
  if (!state) throw new TypeError("Illegal invocation");
  return state;
}

function abortSignal(signal: AbortSignal, reason: unknown): void {
  const state = abortState(signal);
  if (state.aborted) return;
  state.aborted = true;
  state.reason = reason;

  // Snapshot and clear before running application code. A throwing public
  // listener cannot prevent native cancellation or strand later listeners.
  const algorithms = [...state.algorithms];
  const listeners = [...state.listeners];
  state.algorithms.clear();
  state.listeners.clear();
  for (const algorithm of algorithms) {
    try {
      algorithm();
    } catch {
      // Internal abort algorithms are best-effort cleanup and must not block
      // the remaining algorithms.
    }
  }

  const event = Object.freeze({
    type: "abort" as const,
    target: signal,
    currentTarget: signal,
  });
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // EventTarget reports listener exceptions without making abort() throw.
    }
  }
}

/** Abort signal supplied by PocketJS rather than an ambient browser global. */
export class AbortSignal {
  constructor(token?: symbol) {
    if (token !== ABORT_SIGNAL_TOKEN) {
      throw new TypeError("Illegal constructor");
    }
    abortStates.set(this, {
      aborted: false,
      reason: undefined,
      listeners: new Set(),
      algorithms: new Set(),
    });
  }

  get aborted(): boolean {
    return abortState(this).aborted;
  }

  get reason(): unknown {
    return abortState(this).reason;
  }

  addEventListener(type: "abort", listener: AbortListener): void {
    if (type === "abort") abortState(this).listeners.add(listener);
  }

  removeEventListener(type: "abort", listener: AbortListener): void {
    if (type === "abort") abortState(this).listeners.delete(listener);
  }

  throwIfAborted(): void {
    const state = abortState(this);
    if (state.aborted) throw state.reason;
  }
}

export class AbortController {
  readonly signal = new AbortSignal(ABORT_SIGNAL_TOKEN);

  abort(reason?: unknown): void {
    abortSignal(this.signal, reason ?? new NetworkError("The operation was aborted", {
      category: "runtime",
      code: "aborted",
      operation: "abort",
    }));
  }
}

export function abortSignalAborted(signal: AbortSignal): boolean {
  return abortState(signal).aborted;
}

export function abortSignalReason(signal: AbortSignal): unknown {
  return abortState(signal).reason;
}

export function addAbortAlgorithm(
  signal: AbortSignal,
  algorithm: AbortAlgorithm,
): () => void {
  const state = abortState(signal);
  if (state.aborted) {
    algorithm();
    return () => {};
  }
  state.algorithms.add(algorithm);
  return () => state.algorithms.delete(algorithm);
}

export function createDependentAbortSignal(source?: AbortSignal): {
  readonly signal: AbortSignal;
  readonly detach: () => void;
} {
  const controller = new AbortController();
  if (!source) return { signal: controller.signal, detach: () => {} };
  if (abortSignalAborted(source)) {
    controller.abort(abortSignalReason(source));
    return { signal: controller.signal, detach: () => {} };
  }
  const detach = addAbortAlgorithm(source, () => {
    controller.abort(abortSignalReason(source));
  });
  return { signal: controller.signal, detach };
}
