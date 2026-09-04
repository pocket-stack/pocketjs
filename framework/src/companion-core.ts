// framework/src/companion-core.ts — the framework-neutral half of the
// companion SDK: one link to a companion process over the svc mailbox
// (spec ops 30–32), a request table, chunk reassembly, topic subscriptions,
// and the per-frame pump. The Solid shim (companion.ts) turns this into
// signals, queries and channels; a Vue Vapor shim would bind the same core
// to refs. Protocol shapes: contracts/spec/companion.ts.
//
// What this module guarantees, and how:
//
//   - The guest never waits on a peripheral. svcOpen is a non-blocking
//     probe, svcPoll returns whatever complete lines the host already
//     holds, svcSend appends to a native buffer. There is no other call.
//   - Per-frame work is bounded. pump() makes exactly one svcPoll (at most
//     SVC_POLL_BUF bytes of lines), parses those lines, and delivers the
//     replies they complete. A reply reassembled from chunks is capped at
//     COMPANION_REPLY_BYTES before it is parsed.
//   - Reconnects are the module's problem. When the link comes up the pump
//     re-sends the hello, every pending request and every subscription, in
//     that order; a reply to a request that was cancelled or superseded
//     is dropped by id. Requests are idempotent by contract, so the app
//     never fences with generation counters.

import {
  COMPANION_MAX_PENDING,
  COMPANION_PROTO,
  COMPANION_REPLY_BYTES,
  parseLines,
  utf8Length,
  type CompanionGuestHello,
  type CompanionHostLine,
  type CompanionReplyBody,
} from "../../contracts/spec/companion.ts";
import { getOps } from "./host.ts";
import { registerServicePump } from "./services.ts";

/** The three svc ops the link needs, in the host's own spelling. */
export interface CompanionOps {
  svcOpen(app: string): boolean;
  svcPoll(): string | undefined;
  svcSend(line: string): void;
}

/** absent: this host has no svc mailbox at all. searching: the transport
 *  is looking for (or reconnecting to) a companion. linked: the companion
 *  answered the hello. */
export type CompanionStatus = "absent" | "searching" | "linked";

export type ReplyHandler = (body: CompanionReplyBody) => void;

export interface CompanionCoreOptions {
  /** The companion id — one of the manifest's `app.companions`, and the
   *  string the host matches against beacons. */
  readonly app: string;
  /** Sent in the hello so a companion can adapt payloads to the target. */
  readonly device?: string;
  /** Explicit ops (tests, sims). Default: the host's svc trio; null when
   *  the host lacks it. */
  readonly ops?: CompanionOps | null;
  /** Register pump() on the service pump set (default). Tests that step
   *  frames by hand pass false and call pump() themselves. */
  readonly autoPump?: boolean;
  onStatus?(status: CompanionStatus, name: string): void;
  onEvent?(topic: string, data: unknown): void;
}

export interface CompanionCore {
  readonly app: string;
  status(): CompanionStatus;
  /** The companion's advertised name; "" until linked. */
  name(): string;
  /** Issue a request. The handler runs at most once, during a later pump,
   *  unless the request is cancelled first. Throws past
   *  COMPANION_MAX_PENDING. */
  request(method: string, params: unknown, onReply: ReplyHandler): number;
  /** Forget a request; its reply, if one still arrives, is dropped. */
  cancel(id: number): void;
  /** Ref-counted topic subscription; returns the matching unsubscribe. */
  subscribe(topic: string): () => void;
  pendingCount(): number;
  /** One frame of link work. Registered automatically unless autoPump is
   *  false. */
  pump(): void;
  dispose(): void;
}

interface Pending {
  readonly method: string;
  readonly params: unknown;
  readonly onReply: ReplyHandler;
}

interface PartialReply {
  readonly n: number;
  readonly parts: (string | undefined)[];
  got: number;
  bytes: number;
}

let sessionCounter = 0;

/** A per-boot session number: fresh for every guest start, never reused
 *  within one. Hot pushes restart the guest, so a companion can tell a new
 *  guest from a reconnecting one. */
function nextSession(): number {
  sessionCounter += 1;
  return ((Math.floor(Math.random() * 0x7fff) << 16) | (sessionCounter & 0xffff)) >>> 0;
}

/** The host's svc ops, or null when this host has no mailbox. */
export function hostCompanionOps(): CompanionOps | null {
  let ops: Record<string, unknown> | null = null;
  try {
    ops = getOps() as unknown as Record<string, unknown>;
  } catch {
    ops = (globalThis as { ui?: Record<string, unknown> }).ui ?? null;
  }
  if (!ops) return null;
  const { svcOpen, svcPoll, svcSend } = ops as Partial<CompanionOps>;
  if (typeof svcOpen !== "function" || typeof svcPoll !== "function" || typeof svcSend !== "function") {
    return null;
  }
  return {
    svcOpen: (app) => svcOpen.call(ops, app),
    svcPoll: () => svcPoll.call(ops),
    svcSend: (line) => svcSend.call(ops, line),
  };
}

export function createCompanionCore(options: CompanionCoreOptions): CompanionCore {
  const app = options.app;
  const ops = options.ops === undefined ? hostCompanionOps() : options.ops;
  const session = nextSession();
  const pending = new Map<number, Pending>();
  const partials = new Map<number, PartialReply>();
  const topics = new Map<string, number>();
  let nextId = 0;
  let up = false;
  let status: CompanionStatus = ops ? "searching" : "absent";
  let name = "";
  let disposed = false;

  const setStatus = (next: CompanionStatus): void => {
    if (next === status) return;
    status = next;
    options.onStatus?.(status, name);
  };

  const send = (line: unknown): void => {
    ops!.svcSend(JSON.stringify(line));
  };

  const sendHello = (): void => {
    const hello: CompanionGuestHello = { t: "hello", proto: COMPANION_PROTO, session };
    send(options.device === undefined ? hello : { ...hello, device: options.device });
  };

  const deliver = (id: number, body: CompanionReplyBody): void => {
    const entry = pending.get(id);
    if (!entry) return; // cancelled or superseded: dropped by id
    pending.delete(id);
    partials.delete(id);
    entry.onReply(body);
  };

  const dispatch = (line: CompanionHostLine): void => {
    if ("r" in line) {
      if ("i" in line) {
        if (!pending.has(line.r)) return;
        let partial = partials.get(line.r);
        if (!partial || partial.n !== line.n) {
          partial = { n: line.n, parts: new Array<string | undefined>(line.n), got: 0, bytes: 0 };
          partials.set(line.r, partial);
        }
        if (line.i < 0 || line.i >= partial.n || partial.parts[line.i] !== undefined) return;
        partial.bytes += utf8Length(line.s);
        if (partial.bytes > COMPANION_REPLY_BYTES) {
          deliver(line.r, { err: `companion: reply exceeds ${COMPANION_REPLY_BYTES} bytes` });
          return;
        }
        partial.parts[line.i] = line.s;
        partial.got += 1;
        if (partial.got < partial.n) return;
        let body: CompanionReplyBody;
        try {
          body = JSON.parse(partial.parts.join("")) as CompanionReplyBody;
        } catch {
          body = { err: "companion: malformed chunked reply" };
        }
        deliver(line.r, body);
        return;
      }
      deliver(line.r, "ok" in line ? { ok: line.ok } : { err: String(line.err) });
      return;
    }
    if ("e" in line) {
      if (topics.has(line.e)) options.onEvent?.(line.e, line.d);
      return;
    }
    if ("t" in line && line.t === "hello") {
      name = typeof line.name === "string" ? line.name : "";
      setStatus("linked");
    }
  };

  const pump = (): void => {
    if (disposed || !ops) return;
    const open = ops.svcOpen(app);
    if (!open) {
      if (up) {
        up = false;
        partials.clear(); // a torn reply never completes across connections
      }
      setStatus("searching");
      return;
    }
    if (!up) {
      up = true;
      sendHello();
      for (const [id, entry] of pending) send({ q: id, m: entry.method, p: entry.params });
      for (const topic of topics.keys()) send({ s: topic, on: 1 });
    }
    const batch = ops.svcPoll();
    if (batch === undefined || batch === "") return;
    for (const line of parseLines<CompanionHostLine>(batch)) dispatch(line);
  };

  const unregister = options.autoPump === false ? null : registerServicePump(pump);

  return {
    app,
    status: () => status,
    name: () => name,
    request(method, params, onReply) {
      if (disposed) throw new Error("companion: link disposed");
      if (pending.size >= COMPANION_MAX_PENDING) {
        throw new Error(`companion: ${COMPANION_MAX_PENDING} requests already pending`);
      }
      nextId += 1;
      const id = nextId;
      pending.set(id, { method, params, onReply });
      if (up) send({ q: id, m: method, p: params });
      return id;
    },
    cancel(id) {
      if (!pending.delete(id)) return;
      partials.delete(id);
      if (up) send({ c: id });
    },
    subscribe(topic) {
      const count = topics.get(topic) ?? 0;
      topics.set(topic, count + 1);
      if (count === 0 && up) send({ s: topic, on: 1 });
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const left = (topics.get(topic) ?? 1) - 1;
        if (left > 0) {
          topics.set(topic, left);
          return;
        }
        topics.delete(topic);
        if (up && !disposed) send({ s: topic, on: 0 });
      };
    },
    pendingCount: () => pending.size,
    pump,
    dispose() {
      if (disposed) return;
      disposed = true;
      unregister?.();
      pending.clear();
      partials.clear();
      topics.clear();
    },
  };
}
