// Network Guest Binding — the SDK-internal layer between the public modules
// and the spec-pinned namespaces (`globalThis.net` / `ws` / `httpd`). It
// finds a namespace, checks the spec major version once, drains one `poll`
// batch per tick from the framework service pump while a module has live
// handles, and hands each event to the module. Nothing here is public API.
//
// Delivery order: the host runs
// `begin_tick` before `frame()`; inside `frame()` the service pump calls a
// module's `poll` exactly once; the module updates JS state, calls handlers
// and settles Promises synchronously; Promise reactions run in the same
// tick's job drain.

import { NET_ERROR } from "../../../contracts/spec/net.ts";
import { registerServicePump } from "../services.ts";
import { NetworkError, type NetworkProtocol } from "./errors.ts";

export interface NamespaceOps {
  poll(): string | undefined;
  lastError(): string;
  limits(): string;
}

export type EventRecord = Record<string, unknown> & { t: string };

export interface ModuleBinding<Ops extends NamespaceOps> {
  readonly name: string;
  readonly protocol: NetworkProtocol;
  /** The mounted ops, or null when the host did not mount the namespace. */
  ops(): Ops | null;
  /** The mounted ops or a rejected-promise-style NetworkError. */
  require(operation: string): Ops;
  /** Parsed `limits()` snapshot (cached after the first read). */
  limits(): Record<string, unknown>;
  /** Register/unregister interest in per-tick delivery. */
  retain(): void;
  release(): void;
  /** Number of live handles (for tests and diagnostics). */
  live(): number;
  /** Runs one poll and dispatches (exposed for deterministic tests). */
  pump(): void;
}

export interface BindingSpec<Ops extends NamespaceOps> {
  name: string;
  protocol: NetworkProtocol;
  specMajor: number;
  requiredOps: readonly (keyof Ops & string)[];
  dispatch(event: EventRecord, ops: Ops): void;
  /** Called when a poll batch is malformed; the module must fail its handles. */
  onProtocolFailure(ops: Ops, error: NetworkError): void;
}

export function createBinding<Ops extends NamespaceOps>(spec: BindingSpec<Ops>): ModuleBinding<Ops> {
  let cachedOps: Ops | null = null;
  let cachedLimits: Record<string, unknown> | null = null;
  let liveCount = 0;
  let stopPump: (() => void) | null = null;

  function lookup(): Ops | null {
    const ns = (globalThis as Record<string, unknown>)[spec.name];
    if (!ns || typeof ns !== "object") return null;
    for (const op of spec.requiredOps) {
      if (typeof (ns as Record<string, unknown>)[op] !== "function") return null;
    }
    return ns as Ops;
  }

  function ops(): Ops | null {
    const found = lookup();
    if (found && found !== cachedOps) {
      // A different namespace object (host remounted): forget the snapshot.
      cachedOps = found;
      cachedLimits = null;
    } else if (!found) {
      cachedOps = null;
      cachedLimits = null;
    }
    return found;
  }

  function limits(): Record<string, unknown> {
    if (cachedLimits) return cachedLimits;
    const found = ops();
    if (!found) {
      throw new NetworkError(NET_ERROR.unavailable, `${spec.name}: host did not mount the module`, {
        operation: "limits",
        protocol: spec.protocol,
      });
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(found.limits());
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object") {
      throw new NetworkError(NET_ERROR.protocol, `${spec.name}: malformed limits()`, {
        operation: "limits",
        protocol: spec.protocol,
      });
    }
    const record = parsed as Record<string, unknown>;
    if (record.specMajor !== spec.specMajor) {
      throw new NetworkError(
        NET_ERROR.unsupported,
        `${spec.name}: host speaks spec ${String(record.specMajor)}, SDK requires ${spec.specMajor}`,
        { operation: "limits", protocol: spec.protocol },
      );
    }
    cachedLimits = Object.freeze(record);
    return cachedLimits;
  }

  function require(operation: string): Ops {
    const found = ops();
    if (!found) {
      throw new NetworkError(NET_ERROR.unavailable, `${spec.name}: host did not mount the module`, {
        operation,
        protocol: spec.protocol,
      });
    }
    limits(); // spec version check on first use
    return found;
  }

  function pump(): void {
    if (liveCount === 0) return;
    const found = cachedOps ?? ops();
    if (!found) return;
    const batch = found.poll();
    if (batch === undefined) return;
    let events: unknown = null;
    try {
      events = JSON.parse(batch);
    } catch {
      events = null;
    }
    if (!Array.isArray(events)) {
      spec.onProtocolFailure(
        found,
        new NetworkError(NET_ERROR.protocol, `${spec.name}: malformed event batch`, {
          operation: "poll",
          protocol: spec.protocol,
        }),
      );
      return;
    }
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const record = event as EventRecord;
      if (typeof record.t !== "string") continue;
      spec.dispatch(record, found);
    }
  }

  function retain(): void {
    liveCount++;
    if (!stopPump) stopPump = registerServicePump(pump);
  }

  function release(): void {
    if (liveCount > 0) liveCount--;
    if (liveCount === 0 && stopPump) {
      stopPump();
      stopPump = null;
    }
  }

  return {
    name: spec.name,
    protocol: spec.protocol,
    ops,
    require,
    limits,
    retain,
    release,
    live: () => liveCount,
    pump,
  };
}

/** Integer option validation shared by the modules. */
export function integerOption(
  value: unknown,
  label: string,
  min: number,
  max: number,
  operation: string,
  protocol: NetworkProtocol,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new NetworkError(NET_ERROR.invalidRequest, `${label} must be an integer from ${min} through ${max}`, {
      operation,
      protocol,
    });
  }
  return value;
}

/** Read `name` from a limits snapshot as a positive integer, else fallback. */
export function limitNumber(limits: Record<string, unknown>, name: string, fallback: number): number {
  const v = limits[name];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}
