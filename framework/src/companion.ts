// framework/src/companion.ts — the Solid flavour of the companion SDK.
//
//   const mac = createCompanion({ app: "vault" });
//   const page = createQuery<Rows>(mac, () => ["doc.rows", { id: doc(), from: first(), count: 40 }]);
//   const files = createChannel<FileList>(mac, "vault.files", []);
//   await mac.call("doc.edit", { id, row, col, insert: "x" });
//
// A query is a resource keyed by its (method, params) tuple: the request goes
// out when the key changes, the reply lands on a later frame's pump, and a
// reply for a key the app has moved past is dropped. There is no way to
// read a result synchronously because there is no synchronous IO — the
// signal is undefined until the tick the reply arrives. The core with the
// link, request table and reconnect rules is companion-core.ts.

import { createComputed, createSignal, onCleanup, type Accessor } from "solid-js";
import {
  createCompanionCore,
  type CompanionCore,
  type CompanionCoreOptions,
  type CompanionOps,
  type CompanionStatus,
} from "./companion-core.ts";

export type { CompanionCore, CompanionOps, CompanionStatus } from "./companion-core.ts";
export {
  COMPANION_LINE_BYTES,
  COMPANION_MAX_PENDING,
  COMPANION_PROTO,
  COMPANION_REPLY_BYTES,
} from "../../contracts/spec/companion.ts";

export class CompanionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanionError";
  }
}

export interface CompanionOptions {
  readonly app: string;
  readonly device?: string;
  readonly ops?: CompanionOps | null;
}

export interface Companion {
  readonly app: string;
  readonly status: Accessor<CompanionStatus>;
  /** The companion's name once linked, "" before. */
  readonly name: Accessor<string>;
  /** One request → one Promise, settled during a later frame's pump. */
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** A request whose reply the app does not need. Errors reach onError. */
  send(method: string, params?: unknown): void;
  /** Subscribe a handler to a topic; the companion pushes events while at
   *  least one handler is attached. Returns the unsubscribe. */
  on<T = unknown>(topic: string, handler: (data: T) => void): () => void;
  /** Errors from send() and dropped replies, for a status line. */
  onError(handler: (message: string) => void): () => void;
  readonly core: CompanionCore;
  dispose(): void;
}

export function createCompanion(options: CompanionOptions): Companion {
  const [status, setStatus] = createSignal<CompanionStatus>("searching");
  const [name, setName] = createSignal("");
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const errorHandlers = new Set<(message: string) => void>();
  const coreOptions: CompanionCoreOptions = {
    app: options.app,
    onStatus: (next, companionName) => {
      setStatus(next);
      setName(companionName);
    },
    onEvent: (topic, data) => {
      const set = handlers.get(topic);
      if (!set) return;
      for (const handler of [...set]) handler(data);
    },
  };
  if (options.device !== undefined) (coreOptions as { device?: string }).device = options.device;
  if (options.ops !== undefined) (coreOptions as { ops?: CompanionOps | null }).ops = options.ops;
  const core = createCompanionCore(coreOptions);
  setStatus(core.status());

  const report = (message: string): void => {
    for (const handler of [...errorHandlers]) handler(message);
  };

  const companion: Companion = {
    app: options.app,
    status,
    name,
    core,
    call<T>(method: string, params?: unknown): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        try {
          core.request(method, params, (body) => {
            if ("ok" in body) resolve(body.ok as T);
            else reject(new CompanionError(body.err));
          });
        } catch (error) {
          reject(error instanceof Error ? error : new CompanionError(String(error)));
        }
      });
    },
    send(method, params) {
      try {
        core.request(method, params, (body) => {
          if ("err" in body) report(`${method}: ${body.err}`);
        });
      } catch (error) {
        report(error instanceof Error ? error.message : String(error));
      }
    },
    on<T>(topic: string, handler: (data: T) => void) {
      let set = handlers.get(topic);
      if (!set) {
        set = new Set();
        handlers.set(topic, set);
      }
      const entry = handler as (data: unknown) => void;
      set.add(entry);
      const unsubscribe = core.subscribe(topic);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        set!.delete(entry);
        if (set!.size === 0) handlers.delete(topic);
        unsubscribe();
      };
    },
    onError(handler) {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
    dispose() {
      core.dispose();
      handlers.clear();
      errorHandlers.clear();
    },
  };
  onCleanup(() => companion.dispose());
  return companion;
}

// ── Queries ────────────────────────────────────────────────────────────────

/** A query key: the method and its params. null = nothing to ask. */
export type QueryKey = readonly [method: string, params?: unknown] | null;

export interface QueryOptions {
  /** Keep the previous result while a new key is in flight (default). With
   *  false the accessor reads undefined until the reply for the new key
   *  arrives. */
  readonly keep?: boolean;
}

export interface Query<T> extends Accessor<T | undefined> {
  readonly loading: Accessor<boolean>;
  readonly error: Accessor<string | null>;
  /** Ask again with the current key. */
  refetch(): void;
}

/**
 * A resource over a companion method. The key is tracked: when it changes,
 * the in-flight request is cancelled and a new one issued; the reply lands
 * on the frame it arrives. Superseded replies never reach the signal.
 */
export function createQuery<T>(
  companion: Companion,
  key: () => QueryKey,
  options: QueryOptions = {},
): Query<T> {
  const keep = options.keep ?? true;
  const [data, setData] = createSignal<T | undefined>(undefined);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let inflight = -1;
  let current: QueryKey = null;
  let serialized = "";

  const issue = (next: QueryKey): void => {
    if (inflight >= 0) {
      companion.core.cancel(inflight);
      inflight = -1;
    }
    current = next;
    if (next === null) {
      setLoading(false);
      if (!keep) setData(undefined);
      return;
    }
    setLoading(true);
    setError(null);
    if (!keep) setData(undefined);
    let id = -1;
    try {
      id = companion.core.request(next[0], next[1], (body) => {
        if (id !== inflight) return;
        inflight = -1;
        setLoading(false);
        if ("ok" in body) {
          setError(null);
          setData(() => body.ok as T);
        } else {
          setError(body.err);
        }
      });
    } catch (failure) {
      setLoading(false);
      setError(failure instanceof Error ? failure.message : String(failure));
      return;
    }
    inflight = id;
  };

  createComputed(() => {
    const next = key();
    const text = next === null ? "" : JSON.stringify(next);
    if (text === serialized) return;
    serialized = text;
    issue(next);
  });

  onCleanup(() => {
    if (inflight >= 0) companion.core.cancel(inflight);
    inflight = -1;
  });

  const query = (() => data()) as Query<T>;
  (query as { loading: Accessor<boolean> }).loading = loading;
  (query as { error: Accessor<string | null> }).error = error;
  (query as { refetch: () => void }).refetch = () => issue(current);
  return query;
}

// ── Channels ───────────────────────────────────────────────────────────────

/**
 * A signal fed by a companion topic. Subscribes for the owner's lifetime;
 * each event either replaces the value or, with `reduce`, folds into it.
 */
export function createChannel<T, E = T>(
  companion: Companion,
  topic: string,
  initial: T,
  reduce?: (previous: T, event: E) => T,
): Accessor<T> {
  const [value, setValue] = createSignal<T>(initial);
  const unsubscribe = companion.on<E>(topic, (event) => {
    setValue((previous) => (reduce ? reduce(previous, event) : (event as unknown as T)));
  });
  onCleanup(unsubscribe);
  return value;
}
