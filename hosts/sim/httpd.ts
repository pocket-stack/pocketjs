// Deterministic virtual-clock HTTP Server module (`globalThis.httpd`, spec v2)
// for conformance tests. No socket is opened: a test injects requests with
// `host.inject(...)`, the listener/request events become visible at the next
// tick(), and everything the app answers through respond/write/endBody lands
// on the injected request record. Inject via bootWorld's extraGlobals:
// `{ httpd: host.ns }`.

import {
  HTTPD_DEFAULT_BODY_IDLE_MS,
  HTTPD_DEFAULT_CLOSE_MS,
  HTTPD_DEFAULT_HANDLER_MS,
  HTTPD_DEFAULT_HEADER_MS,
  HTTPD_DEFAULT_KEEP_ALIVE_MS,
  HTTPD_DEFAULT_REQUEST_QUEUE_BYTES,
  HTTPD_MAX_CONNECTIONS,
  HTTPD_MAX_EVENTS_PER_TICK,
  HTTPD_MAX_HEADERS,
  HTTPD_MAX_HEADER_BYTES,
  HTTPD_MAX_INFLIGHT,
  HTTPD_MAX_REQUEST_QUEUE_BYTES,
  HTTPD_MAX_SEND_QUEUE_BYTES,
  HTTPD_MAX_SERVERS,
  HTTPD_MAX_TARGET_BYTES,
  HTTPD_MAX_TICK_BYTES,
  HTTPD_MAX_TIMEOUT_MS,
  HTTPD_SEND_ACCEPTED,
  HTTPD_SEND_BACKPRESSURE,
  HTTPD_SEND_HIGH_WATER_BYTES,
  HTTPD_SEND_INVALID,
  HTTPD_SEND_INVALID_REQUEST,
  HTTPD_SEND_LOW_WATER_BYTES,
  HTTPD_SPEC_MAJOR,
  HTTPD_SPEC_MINOR,
  type HttpdLimits,
  type HttpdListenMeta,
  type HttpdRespondMeta,
} from "../../contracts/spec/httpd.ts";
import { NET_ERROR, NET_TLS_MIN_VERSION } from "../../contracts/spec/net.ts";
import { networkPolicyAllowsListen } from "../../contracts/spec/network-policy.ts";
import { stringToUtf8 } from "../../framework/src/bytes.ts";
import type { HttpdOps } from "../../framework/src/net/http.ts";
import { simPolicy, type SimHostOptions } from "./net.ts";

export interface SimInjectOptions {
  method?: string;
  target?: string;
  headers?: Readonly<Record<string, string>>;
  body?: string | Uint8Array | readonly (string | Uint8Array)[];
  /** Ticks between body chunks (default 0: all with the request). */
  chunkTicks?: number;
  remote?: { address: string; port: number };
  /** Announce a Content-Length (default: total body bytes; null = chunked). */
  length?: number | null;
}

export interface SimInjectedRequest {
  readonly req: number;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  contentLength: number | undefined;
  readonly chunks: Uint8Array[];
  responded: boolean;
  /** true once respond(end=true) or endBody landed. */
  complete: boolean;
  aborted: string | null;
  /** Concatenated response body. */
  body(): Uint8Array;
  text(): string;
  /** Simulate the peer disconnecting; the app sees aborted{closed}. */
  disconnect(): void;
}

interface Server {
  handle: number;
  meta: HttpdListenMeta;
  listeningTick: number;
  listening: boolean;
  stopping: boolean;
  closeTick: number;
  terminal: boolean;
}

interface Pending {
  server: Server;
  record: SimInjectedRequest & { visible: Uint8Array[]; visibleBytes: number; chunks_in: Uint8Array[]; nextChunkTick: number; delivered: boolean; deliverTick: number; ended: boolean; drainArmed: boolean; disconnectRequested: boolean; terminal: boolean; options: SimInjectOptions; queued: number };
}

export interface SimHttpdHost {
  readonly ns: HttpdOps;
  tick(): void;
  /** Queue a request for the server bound to `port` (or the only server). */
  inject(options?: SimInjectOptions, port?: number): SimInjectedRequest;
  readonly log: string[];
  readonly live: () => number;
  /** Bytes the sim send queue accepts per respond/write before -2. */
  sendQueueBytes: number;
}

export const SIM_HTTPD_LIMITS: HttpdLimits = Object.freeze({
  specMajor: HTTPD_SPEC_MAJOR,
  specMinor: HTTPD_SPEC_MINOR,
  maxServers: HTTPD_MAX_SERVERS,
  maxConnections: HTTPD_MAX_CONNECTIONS,
  maxInflight: HTTPD_MAX_INFLIGHT,
  maxTlsInflight: 0,
  maxHeaders: HTTPD_MAX_HEADERS,
  maxHeaderBytes: HTTPD_MAX_HEADER_BYTES,
  maxTargetBytes: HTTPD_MAX_TARGET_BYTES,
  defaultRequestQueueBytes: HTTPD_DEFAULT_REQUEST_QUEUE_BYTES,
  maxRequestQueueBytes: HTTPD_MAX_REQUEST_QUEUE_BYTES,
  maxSendQueueBytes: HTTPD_MAX_SEND_QUEUE_BYTES,
  sendHighWaterBytes: HTTPD_SEND_HIGH_WATER_BYTES,
  sendLowWaterBytes: HTTPD_SEND_LOW_WATER_BYTES,
  maxEventsPerTick: HTTPD_MAX_EVENTS_PER_TICK,
  maxTickBytes: HTTPD_MAX_TICK_BYTES,
  defaultHeaderMs: HTTPD_DEFAULT_HEADER_MS,
  defaultBodyIdleMs: HTTPD_DEFAULT_BODY_IDLE_MS,
  defaultHandlerMs: HTTPD_DEFAULT_HANDLER_MS,
  defaultKeepAliveMs: HTTPD_DEFAULT_KEEP_ALIVE_MS,
  defaultCloseMs: HTTPD_DEFAULT_CLOSE_MS,
  maxTimeoutMs: HTTPD_MAX_TIMEOUT_MS,
  tlsMinVersion: NET_TLS_MIN_VERSION,
  features: [],
});

function toBytes(value: string | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value.slice() : stringToUtf8(value);
}

export function createSimHttpdHost(options: SimHostOptions = {}): SimHttpdHost {
  const policy = simPolicy(options);
  const servers = new Map<number, Server>();
  const requests = new Map<number, Pending>();
  const events: object[] = [];
  const log: string[] = [];
  let nextHandle = 1;
  let nextReq = 1;
  let nextEphemeral = 40000;
  let now = 0;
  let lastError = "";

  const refuse = (code: string, message: string): number => {
    lastError = `${code}: ${message}`;
    return -1;
  };

  const host: SimHttpdHost = {
    sendQueueBytes: HTTPD_MAX_SEND_QUEUE_BYTES,
    ns: {
      listen(metaJson) {
        let meta: HttpdListenMeta;
        try {
          meta = JSON.parse(metaJson) as HttpdListenMeta;
        } catch {
          return refuse(NET_ERROR.invalidRequest, "malformed listen metadata");
        }
        if (typeof meta.address !== "string" || !Number.isInteger(meta.port)) {
          return refuse(NET_ERROR.invalidRequest, "address/port required");
        }
        if (meta.tls) return refuse(NET_ERROR.unsupported, "tls not provided");
        if (policy && !networkPolicyAllowsListen(policy, meta.tls ? "https" : "http", meta.address, meta.port)) {
          return refuse(NET_ERROR.permissionDenied, "address/port is not an allowed listen rule");
        }
        if (servers.size >= HTTPD_MAX_SERVERS) return refuse(NET_ERROR.resourceLimit, "too many servers");
        for (const s of servers.values()) {
          if (s.meta.port === meta.port && meta.port !== 0 && !s.terminal) {
            // Bind conflicts surface asynchronously like a native bind().
          }
        }
        const handle = nextHandle++;
        servers.set(handle, { handle, meta, listeningTick: now + 1, listening: false, stopping: false, closeTick: 0, terminal: false });
        log.push(`listen ${handle} ${meta.address}:${meta.port}`);
        return handle;
      },
      stop(handle, graceful, timeoutMs) {
        const s = servers.get(handle);
        if (!s || s.terminal || s.stopping) return -1;
        s.stopping = true;
        s.closeTick = now + 1;
        log.push(`stop ${handle} ${graceful} ${timeoutMs}`);
        return 0;
      },
      respond(req, metaJson, body) {
        const p = requests.get(req);
        if (!p || p.record.responded || p.record.terminal) return HTTPD_SEND_INVALID_REQUEST;
        let meta: HttpdRespondMeta;
        try {
          meta = JSON.parse(metaJson) as HttpdRespondMeta;
        } catch {
          return HTTPD_SEND_INVALID;
        }
        if (!Number.isInteger(meta.status) || meta.status < 200 || meta.status > 599) return HTTPD_SEND_INVALID;
        const bytes = body ? new Uint8Array(body.slice(0)) : new Uint8Array(0);
        const end = meta.end !== false;
        if (end && p.record.queued + bytes.length > host.sendQueueBytes) {
          p.record.drainArmed = true;
          return HTTPD_SEND_BACKPRESSURE;
        }
        p.record.queued += bytes.length;
        if (meta.contentLength !== undefined && end && meta.contentLength !== bytes.length) return HTTPD_SEND_INVALID;
        p.record.responded = true;
        p.record.status = meta.status;
        p.record.statusText = meta.statusText ?? "";
        p.record.headers = { ...(meta.headers ?? {}) };
        p.record.contentLength = meta.contentLength;
        if (bytes.length) p.record.chunks.push(bytes);
        if (end) {
          p.record.complete = true;
          finish(p);
        }
        log.push(`respond ${req} ${meta.status} end=${end} ${bytes.length}`);
        return HTTPD_SEND_ACCEPTED;
      },
      write(req, chunk) {
        const p = requests.get(req);
        if (!p || !p.record.responded || p.record.complete || p.record.terminal) return HTTPD_SEND_INVALID_REQUEST;
        const bytes = new Uint8Array(chunk.slice(0));
        if (bytes.length > HTTPD_MAX_SEND_QUEUE_BYTES) return HTTPD_SEND_INVALID;
        if (p.record.queued + bytes.length > host.sendQueueBytes) {
          p.record.drainArmed = true;
          return HTTPD_SEND_BACKPRESSURE;
        }
        p.record.queued += bytes.length;
        p.record.chunks.push(bytes);
        log.push(`write ${req} ${bytes.length}`);
        return HTTPD_SEND_ACCEPTED;
      },
      endBody(req) {
        const p = requests.get(req);
        if (!p || !p.record.responded || p.record.complete || p.record.terminal) return -1;
        p.record.complete = true;
        finish(p);
        log.push(`endBody ${req}`);
        return 0;
      },
      readInto(req, into, offset, length) {
        const p = requests.get(req);
        if (!p || !p.record.delivered) return -1;
        const dest = new Uint8Array(into, offset, length);
        let copied = 0;
        while (p.record.visible.length && copied < dest.length) {
          const head = p.record.visible[0];
          const n = Math.min(head.length, dest.length - copied);
          dest.set(head.subarray(0, n), copied);
          copied += n;
          if (n === head.length) p.record.visible.shift();
          else p.record.visible[0] = head.subarray(n);
        }
        p.record.visibleBytes -= copied;
        return copied;
      },
      abort(req) {
        const p = requests.get(req);
        if (!p || p.record.terminal) return;
        p.record.aborted = NET_ERROR.cancelled;
        log.push(`abort ${req}`);
      },
      poll() {
        return events.length ? JSON.stringify(events.splice(0)) : undefined;
      },
      lastError() {
        return lastError;
      },
      limits() {
        return JSON.stringify(SIM_HTTPD_LIMITS);
      },
    },
    tick,
    inject,
    log,
    live: () => requests.size,
  };

  function finish(p: Pending): void {
    p.record.terminal = true;
    requests.delete(p.record.req);
  }

  function inject(options: SimInjectOptions = {}, port?: number): SimInjectedRequest {
    let server: Server | undefined;
    for (const s of servers.values()) {
      if (s.terminal) continue;
      if (port === undefined || s.meta.port === port) {
        server = s;
        break;
      }
    }
    if (!server) throw new Error("sim httpd: no server to inject into");
    const req = nextReq++;
    const rawBody = options.body ?? "";
    const chunksIn = Array.isArray(rawBody)
      ? (rawBody as readonly (string | Uint8Array)[]).map(toBytes)
      : [toBytes(rawBody as string | Uint8Array)].filter((c) => c.length > 0);
    const record = {
      req,
      status: 0,
      statusText: "",
      headers: {} as Record<string, string>,
      contentLength: undefined as number | undefined,
      chunks: [] as Uint8Array[],
      responded: false,
      complete: false,
      aborted: null as string | null,
      visible: [] as Uint8Array[],
      visibleBytes: 0,
      chunks_in: chunksIn,
      nextChunkTick: now + 1,
      delivered: false,
      deliverTick: now + 1,
      ended: false,
      drainArmed: false,
      disconnectRequested: false,
      terminal: false,
      options,
      queued: 0,
      body(): Uint8Array {
        const total = record.chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const c of record.chunks) {
          out.set(c, o);
          o += c.length;
        }
        return out;
      },
      text(): string {
        return new TextDecoder().decode(record.body());
      },
      disconnect(): void {
        record.disconnectRequested = true;
      },
    };
    requests.set(req, { server, record });
    return record;
  }

  function tick(): void {
    now++;
    for (const s of [...servers.values()]) {
      if (s.terminal) continue;
      if (!s.listening && now >= s.listeningTick) {
        s.listening = true;
        const port = s.meta.port === 0 ? nextEphemeral++ : s.meta.port;
        s.meta.port = port;
        events.push({ t: "listening", h: s.handle, address: s.meta.address, port });
      }
      if (s.stopping && now >= s.closeTick) {
        s.terminal = true;
        servers.delete(s.handle);
        for (const p of [...requests.values()]) {
          if (p.server === s && !p.record.terminal) {
            p.record.aborted = NET_ERROR.closed;
            finish(p);
            events.push({ t: "aborted", req: p.record.req, code: NET_ERROR.closed });
          }
        }
        events.push({ t: "closed", h: s.handle });
      }
    }
    for (const p of [...requests.values()]) {
      const r = p.record;
      if (r.terminal) continue;
      if (r.aborted) {
        const code = r.aborted;
        finish(p);
        events.push({ t: "aborted", req: r.req, code });
        continue;
      }
      if (r.disconnectRequested) {
        r.aborted = NET_ERROR.closed;
        finish(p);
        events.push({ t: "aborted", req: r.req, code: NET_ERROR.closed });
        continue;
      }
      if (!p.server.listening) continue;
      if (!r.delivered) {
        if (now < r.deliverTick) continue;
        r.delivered = true;
        const total = r.chunks_in.reduce((n, c) => n + c.length, 0);
        const headers: Record<string, string> = { host: `${p.server.meta.address}:${p.server.meta.port}`, ...(r.options.headers ?? {}) };
        const ev: Record<string, unknown> = {
          t: "request",
          h: p.server.handle,
          req: r.req,
          method: r.options.method ?? "GET",
          target: r.options.target ?? "/",
          headers,
          remote: r.options.remote ?? { address: "127.0.0.1", port: 50000 + r.req },
          secure: false,
        };
        if (r.options.length !== null) {
          ev.length = r.options.length ?? total;
          if (headers["content-length"] === undefined && (ev.length as number) > 0) headers["content-length"] = String(ev.length);
        } else headers["transfer-encoding"] = "chunked";
        events.push(ev);
      }
      let announced = false;
      while (r.chunks_in.length && now >= r.nextChunkTick) {
        const next = r.chunks_in.shift()!;
        r.visible.push(next);
        r.visibleBytes += next.length;
        announced = true;
        r.nextChunkTick = now + (r.options.chunkTicks ?? 0);
        if ((r.options.chunkTicks ?? 0) > 0) break;
      }
      if (announced) events.push({ t: "readable", req: r.req, avail: r.visibleBytes });
      if (r.chunks_in.length === 0 && !r.ended) {
        r.ended = true;
        events.push({ t: "end", req: r.req });
      }
      // The network task wrote the queued bytes out during this tick.
      r.queued = 0;
      if (r.drainArmed) {
        r.drainArmed = false;
        events.push({ t: "drain", req: r.req });
      }
    }
  }

  return host;
}
