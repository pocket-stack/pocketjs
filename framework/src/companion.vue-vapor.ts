// framework/src/companion.vue-vapor.ts — the Vue Vapor flavour of the
// companion SDK. The link, request table, chunk reassembly and reconnect
// rules live in companion-core.ts (framework-neutral); this shim binds them
// to shallow refs and the current effect scope, with the same accessor-style
// API as the Solid shim so an app's store reads identically under either
// framework:
//
//   const mac = createCompanion({ app: "vault" });
//   const page = createQuery<Rows>(mac, () => ["doc.rows", { id: doc.value, from: first.value, count: 40 }]);
//   const files = createChannel<FileList>(mac, "vault.files", []);
//   mac.status()            // "searching" | "linked" | "absent"
//   page(); page.loading()  // undefined until the reply lands

import { onScopeDispose, shallowRef, watch } from "vue";
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
  readonly status: () => CompanionStatus;
  readonly name: () => string;
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  send(method: string, params?: unknown): void;
  on<T = unknown>(topic: string, handler: (data: T) => void): () => void;
  onError(handler: (message: string) => void): () => void;
  readonly core: CompanionCore;
  dispose(): void;
}

export function createCompanion(options: CompanionOptions): Companion {
  const status = shallowRef<CompanionStatus>("searching");
  const name = shallowRef("");
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const errorHandlers = new Set<(message: string) => void>();
  const coreOptions: CompanionCoreOptions = {
    app: options.app,
    onStatus: (next, companionName) => {
      status.value = next;
      name.value = companionName;
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
  status.value = core.status();

  const report = (message: string): void => {
    for (const handler of [...errorHandlers]) handler(message);
  };

  const companion: Companion = {
    app: options.app,
    status: () => status.value,
    name: () => name.value,
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
  onScopeDispose(() => companion.dispose(), true);
  return companion;
}

// ── Queries ────────────────────────────────────────────────────────────────

export type QueryKey = readonly [method: string, params?: unknown] | null;

export interface QueryOptions {
  /** Keep the previous result while a new key is in flight (default). */
  readonly keep?: boolean;
}

export interface Query<T> {
  (): T | undefined;
  readonly loading: () => boolean;
  readonly error: () => string | null;
  refetch(): void;
}

/**
 * A resource over a companion method, keyed by `[method, params]`. The key
 * is watched synchronously: when it changes the in-flight request is
 * cancelled and a new one issued; a reply for a superseded key never
 * reaches the ref.
 */
export function createQuery<T>(companion: Companion, key: () => QueryKey, options: QueryOptions = {}): Query<T> {
  const keep = options.keep ?? true;
  const data = shallowRef<T | undefined>(undefined);
  const loading = shallowRef(false);
  const error = shallowRef<string | null>(null);
  let inflight = -1;
  let current: QueryKey = null;

  const issue = (next: QueryKey): void => {
    if (inflight >= 0) {
      companion.core.cancel(inflight);
      inflight = -1;
    }
    current = next;
    if (next === null) {
      loading.value = false;
      if (!keep) data.value = undefined;
      return;
    }
    loading.value = true;
    error.value = null;
    if (!keep) data.value = undefined;
    let id = -1;
    try {
      id = companion.core.request(next[0], next[1], (body) => {
        if (id !== inflight) return;
        inflight = -1;
        loading.value = false;
        if ("ok" in body) {
          error.value = null;
          data.value = body.ok as T;
        } else {
          error.value = body.err;
        }
      });
    } catch (failure) {
      loading.value = false;
      error.value = failure instanceof Error ? failure.message : String(failure);
      return;
    }
    inflight = id;
  };

  const stop = watch(
    () => {
      const next = key();
      return next === null ? "" : JSON.stringify(next);
    },
    () => issue(key()),
    { immediate: true, flush: "sync" },
  );
  onScopeDispose(() => {
    stop();
    if (inflight >= 0) companion.core.cancel(inflight);
    inflight = -1;
  }, true);

  const query = (() => data.value) as Query<T>;
  (query as { loading: () => boolean }).loading = () => loading.value;
  (query as { error: () => string | null }).error = () => error.value;
  (query as { refetch: () => void }).refetch = () => issue(current);
  return query;
}

// ── Channels ───────────────────────────────────────────────────────────────

/** A ref-backed accessor fed by a companion topic for the scope's lifetime. */
export function createChannel<T, E = T>(
  companion: Companion,
  topic: string,
  initial: T,
  reduce?: (previous: T, event: E) => T,
): () => T {
  const value = shallowRef<T>(initial);
  const unsubscribe = companion.on<E>(topic, (event) => {
    value.value = reduce ? reduce(value.value, event) : (event as unknown as T);
  });
  onScopeDispose(unsubscribe, true);
  return () => value.value;
}
