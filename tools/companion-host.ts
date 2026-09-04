// tools/companion-host.ts — the companion side of the COMPANION protocol,
// with no sockets in it. A host owns the methods a guest may call and the
// topics it may subscribe to; a transport (tools/companion-serve.ts for
// PKNT over TCP, hosts/sim/companion.ts for tests) attaches one session per
// connected guest and shuttles lines. Protocol shapes and the limits that
// replies are held to: contracts/spec/companion.ts.
//
// A product's daemon is a createCompanionHost() call with its methods, plus
// serveCompanion() to put it on the network:
//
//   const host = createCompanionHost({
//     app: "vault",
//     methods: {
//       "doc.rows": ({ id, from, count }) => index.rows(id, from, count),
//     },
//   });
//   await serveCompanion(host);
//
// Runs under Bun and Node alike — a daemon that needs node-pty runs under
// Node, one that wants bun:sqlite runs under Bun; this file does not care.

import {
  COMPANION_PROTO,
  encodeEventLine,
  encodeReplyLines,
  type CompanionGuestHello,
  type CompanionGuestLine,
  type CompanionHostHello,
} from "../contracts/spec/companion.ts";

export interface CompanionContext {
  readonly session: CompanionSession;
  /** Aborted when the guest cancels the request — long work should stop. */
  readonly signal: AbortSignal;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CompanionMethod = (params: any, context: CompanionContext) => unknown;

/** What a transport gives a session: a way to hand one line to the guest. */
export interface CompanionPeer {
  send(line: string): void;
  /** For logs; an address, a device name. */
  readonly label?: string;
}

export interface CompanionSession {
  readonly id: number;
  readonly peer: CompanionPeer;
  /** The guest's hello once received. */
  readonly hello: CompanionGuestHello | null;
  readonly topics: ReadonlySet<string>;
  readonly closed: boolean;
  /** One line from the guest (a ctrl frame's payload). */
  receive(line: string): void;
  /** Newline-separated lines from the guest. */
  receiveBatch(text: string): void;
  /** Push an event to this guest if it subscribed to the topic. */
  push(topic: string, data: unknown): void;
  close(): void;
}

export interface CompanionHostOptions {
  /** The companion id guests pass to svcOpen and beacons carry. */
  readonly app: string;
  /** Advertised in the hello and the beacon (default: the machine name). */
  readonly name?: string;
  readonly methods: Readonly<Record<string, CompanionMethod>>;
  onHello?(session: CompanionSession, hello: CompanionGuestHello): void;
  onSubscribe?(session: CompanionSession, topic: string, on: boolean): void;
  onClose?(session: CompanionSession): void;
  log?(line: string): void;
}

export interface CompanionHost {
  readonly app: string;
  readonly name: string;
  attach(peer: CompanionPeer): CompanionSession;
  sessions(): readonly CompanionSession[];
  /** Push an event to every session subscribed to the topic. */
  publish(topic: string, data: unknown): void;
}

const isPromise = (value: unknown): value is Promise<unknown> =>
  typeof value === "object" && value !== null && typeof (value as Promise<unknown>).then === "function";

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createCompanionHost(options: CompanionHostOptions): CompanionHost {
  const name = options.name ?? "companion";
  const sessions = new Set<CompanionSession>();
  const log = options.log ?? (() => {});
  let nextSessionId = 0;

  const attach = (peer: CompanionPeer): CompanionSession => {
    nextSessionId += 1;
    const id = nextSessionId;
    const topics = new Set<string>();
    const inflight = new Map<number, AbortController>();
    let hello: CompanionGuestHello | null = null;
    let closed = false;

    const sendLines = (lines: readonly string[]): void => {
      if (closed) return;
      for (const line of lines) peer.send(line);
    };

    const reply = (requestId: number, body: { ok: unknown } | { err: string }): void => {
      let lines: string[];
      try {
        lines = encodeReplyLines(requestId, body);
      } catch (error) {
        lines = encodeReplyLines(requestId, { err: errorText(error) });
      }
      sendLines(lines);
    };

    const handleRequest = (requestId: number, method: string, params: unknown): void => {
      const fn = options.methods[method];
      if (!fn) {
        reply(requestId, { err: `unknown method "${method}"` });
        return;
      }
      const controller = new AbortController();
      inflight.set(requestId, controller);
      const finish = (body: { ok: unknown } | { err: string }): void => {
        if (!inflight.delete(requestId)) return; // cancelled meanwhile
        reply(requestId, body);
      };
      let result: unknown;
      try {
        result = fn(params, { session, signal: controller.signal });
      } catch (error) {
        finish({ err: errorText(error) });
        return;
      }
      if (isPromise(result)) {
        result.then(
          (value) => finish({ ok: value === undefined ? null : value }),
          (error) => finish({ err: errorText(error) }),
        );
        return;
      }
      finish({ ok: result === undefined ? null : result });
    };

    const session: CompanionSession = {
      id,
      peer,
      get hello() {
        return hello;
      },
      topics,
      get closed() {
        return closed;
      },
      receive(line) {
        if (closed) return;
        let parsed: CompanionGuestLine;
        try {
          parsed = JSON.parse(line) as CompanionGuestLine;
        } catch {
          log(`companion[${peer.label ?? id}]: dropped a malformed line`);
          return;
        }
        if (typeof parsed !== "object" || parsed === null) return;
        if ("q" in parsed && typeof parsed.q === "number" && typeof parsed.m === "string") {
          handleRequest(parsed.q, parsed.m, parsed.p);
          return;
        }
        if ("c" in parsed && typeof parsed.c === "number") {
          const controller = inflight.get(parsed.c);
          if (controller) {
            inflight.delete(parsed.c);
            controller.abort();
          }
          return;
        }
        if ("s" in parsed && typeof parsed.s === "string") {
          const on = parsed.on === 1;
          if (on) topics.add(parsed.s);
          else topics.delete(parsed.s);
          options.onSubscribe?.(session, parsed.s, on);
          return;
        }
        if ("t" in parsed && parsed.t === "hello") {
          hello = parsed;
          // A fresh hello on a live connection is a restarted guest: what
          // it asked for before is gone with it.
          for (const controller of inflight.values()) controller.abort();
          inflight.clear();
          topics.clear();
          const answer: CompanionHostHello = { t: "hello", proto: COMPANION_PROTO, name };
          sendLines([JSON.stringify(answer)]);
          if (parsed.proto !== COMPANION_PROTO) {
            log(`companion[${peer.label ?? id}]: guest speaks proto ${parsed.proto}, this host ${COMPANION_PROTO}`);
          }
          options.onHello?.(session, parsed);
        }
      },
      receiveBatch(text) {
        let start = 0;
        while (start < text.length) {
          let end = text.indexOf("\n", start);
          if (end < 0) end = text.length;
          if (end > start) session.receive(text.slice(start, end));
          start = end + 1;
        }
      },
      push(topic, data) {
        if (closed || !topics.has(topic)) return;
        try {
          sendLines([encodeEventLine(topic, data)]);
        } catch (error) {
          log(`companion[${peer.label ?? id}]: ${errorText(error)}`);
        }
      },
      close() {
        if (closed) return;
        closed = true;
        for (const controller of inflight.values()) controller.abort();
        inflight.clear();
        sessions.delete(session);
        options.onClose?.(session);
      },
    };
    sessions.add(session);
    return session;
  };

  return {
    app: options.app,
    name,
    attach,
    sessions: () => [...sessions],
    publish(topic, data) {
      for (const session of sessions) session.push(topic, data);
    },
  };
}
