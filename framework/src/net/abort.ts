// AbortController / AbortSignal for the network modules. QuickJS ships no
// DOM; the module provides its own pair with the DOM shape apps expect
// (`aborted`, `reason`, `throwIfAborted()`, `addEventListener("abort")`,
// `onabort`) so `fetch({ signal })` and `connect(...)` work on every host.
// The listeners run synchronously inside `abort()`, in registration order.

type AbortListener = (event: { type: "abort"; target: AbortSignal }) => void;

export class AbortSignal {
  private _aborted = false;
  private _reason: unknown = undefined;
  private readonly listeners = new Set<AbortListener>();
  onabort: AbortListener | null = null;

  get aborted(): boolean {
    return this._aborted;
  }

  get reason(): unknown {
    return this._reason;
  }

  throwIfAborted(): void {
    if (this._aborted) throw this._reason;
  }

  addEventListener(type: "abort", listener: AbortListener): void {
    if (type !== "abort") return;
    this.listeners.add(listener);
  }

  removeEventListener(type: "abort", listener: AbortListener): void {
    if (type !== "abort") return;
    this.listeners.delete(listener);
  }

  /** @internal */
  __abort(reason: unknown): void {
    if (this._aborted) return;
    this._aborted = true;
    this._reason = reason === undefined ? new AbortError() : reason;
    const event = { type: "abort" as const, target: this };
    if (this.onabort) this.onabort(event);
    for (const listener of [...this.listeners]) listener(event);
    this.listeners.clear();
  }

  static abort(reason?: unknown): AbortSignal {
    const signal = new AbortSignal();
    signal.__abort(reason);
    return signal;
  }
}

/** The default abort reason, DOMException-shaped. */
export class AbortError extends Error {
  readonly code = 20;
  constructor(message = "The operation was aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export class AbortController {
  readonly signal = new AbortSignal();

  abort(reason?: unknown): void {
    this.signal.__abort(reason);
  }
}

/** Accept a module signal or a host-native one (browser adapters) by shape. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: "abort", listener: (event?: unknown) => void): void;
  removeEventListener?(type: "abort", listener: (event?: unknown) => void): void;
}

export function isAbortSignalLike(value: unknown): value is AbortSignalLike {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as AbortSignalLike).aborted === "boolean" &&
    typeof (value as AbortSignalLike).addEventListener === "function"
  );
}
