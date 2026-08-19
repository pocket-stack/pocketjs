// Deterministic virtual-clock HTTP Client module (`globalThis.net`, spec v2)
// for conformance tests. It never uses ambient host networking: routes are
// fixtures, response heads and body chunks become visible only after
// tick(), and bytes cross through `readInto` exactly like a native transport
// crossing a tick boundary. Inject via bootWorld's extraGlobals: `{ net:
// host.ns }`, the way a device host mounts the namespace beside `ui`.

import {
  NET_DEFAULT_AGGREGATE_BYTES,
  NET_DEFAULT_QUEUE_BYTES,
  NET_DEFAULT_TIMEOUT_MS,
  NET_ERROR,
  NET_MAX_AGGREGATE_BYTES,
  NET_MAX_EVENTS_PER_TICK,
  NET_MAX_HEADER_BYTES,
  NET_MAX_HEADERS,
  NET_MAX_INFLIGHT,
  NET_MAX_QUEUE_BYTES,
  NET_MAX_REDIRECTS,
  NET_MAX_REQUEST_BYTES,
  NET_MAX_TICK_BYTES,
  NET_MAX_TIMEOUT_MS,
  NET_METHODS_FORBIDDEN,
  NET_SPEC_MAJOR,
  NET_SPEC_MINOR,
  NET_TLS_MIN_VERSION,
  type NetLimits,
  type NetStartMeta,
} from "../../contracts/spec/net.ts";
import {
  networkPolicyAllowsConnect,
  parseNetworkPolicyJson,
  type ResolvedNetworkPolicy,
} from "../../contracts/spec/network-policy.ts";
import { stringToUtf8 } from "../../framework/src/bytes.ts";
import type { NetOps } from "../../framework/src/net/http.ts";
import { URL } from "../../framework/src/net/url.ts";

/** Host options shared by the sim network modules. */
export interface SimHostOptions {
  /** The Build Plan's ResolvedNetworkPolicy (object or canonical JSON). When
   * set, the sim enforces it exactly like a native core — connect rule and
   * insecureTransport before any route lookup, listen rule before bind,
   * the redirect target again — so the policy conformance vectors run on
   * this host too. Without it the fixture routes act as the allowlist. */
  readonly policy?: ResolvedNetworkPolicy | string;
}

export function simPolicy(options: SimHostOptions | undefined): ResolvedNetworkPolicy | null {
  const policy = options?.policy;
  if (policy === undefined) return null;
  return typeof policy === "string" ? parseNetworkPolicyJson(policy) : policy;
}

/** Endpoint tuple of an absolute http(s)/ws(s) URL for the policy matcher. */
export function simEndpoint(url: string): { protocol: string; host: string; port: number } | null {
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.slice(0, -1);
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    const port = parsed.port ? Number(parsed.port) : protocol === "http" || protocol === "ws" ? 80 : 443;
    return { protocol, host, port };
  } catch {
    return null;
  }
}

export interface SimNetRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly meta: NetStartMeta;
}

export interface SimNetResponse {
  readonly status?: number;
  /** Final URL (defaults to the request URL). */
  readonly url?: string;
  readonly redirected?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  /** Body as one value or as chunks that become visible one per `chunkTicks`. */
  readonly body?: string | Uint8Array | readonly (string | Uint8Array)[];
  /** Announce a Content-Length (default: total body bytes; null = unknown). */
  readonly length?: number | null;
  /** Virtual ticks after start before the head is visible. Default 1. */
  readonly delayTicks?: number;
  /** Virtual ticks between body chunks. Default 0 (all with the head). */
  readonly chunkTicks?: number;
  /** Fail instead of answering; `afterHeaders` fails the body stream. */
  readonly error?: { readonly code: string; readonly message: string; readonly afterHeaders?: boolean };
}

export type SimNetRoute = SimNetResponse | ((request: SimNetRequest) => SimNetResponse);

interface Pending {
  readonly handle: number;
  readonly request: SimNetRequest;
  readonly response: SimNetResponse;
  readonly queueBytes: number;
  readonly maxBodyBytes: number;
  headTick: number;
  headSent: boolean;
  chunks: Uint8Array[];
  nextChunkTick: number;
  /** Bytes visible to readInto (already announced). */
  visible: Uint8Array[];
  visibleBytes: number;
  totalDelivered: number;
  ended: boolean;
  endSent: boolean;
  cancelled: boolean;
  terminal: boolean;
}

export interface SimNetHost {
  readonly ns: NetOps;
  /** Advance one virtual tick: the sim's `begin_tick`. */
  tick(): void;
  readonly log: string[];
  readonly pollCalls: () => number;
  /** Live handles (for leak assertions). */
  readonly live: () => number;
}

function toBytes(value: string | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value.slice() : stringToUtf8(value);
}

export const SIM_NET_LIMITS: NetLimits = Object.freeze({
  specMajor: NET_SPEC_MAJOR,
  specMinor: NET_SPEC_MINOR,
  maxInflight: NET_MAX_INFLIGHT,
  maxTlsInflight: 0,
  maxRequestBytes: NET_MAX_REQUEST_BYTES,
  defaultQueueBytes: NET_DEFAULT_QUEUE_BYTES,
  maxQueueBytes: NET_MAX_QUEUE_BYTES,
  defaultAggregateBytes: NET_DEFAULT_AGGREGATE_BYTES,
  maxAggregateBytes: NET_MAX_AGGREGATE_BYTES,
  maxEventsPerTick: NET_MAX_EVENTS_PER_TICK,
  maxTickBytes: NET_MAX_TICK_BYTES,
  maxHeaders: NET_MAX_HEADERS,
  maxHeaderBytes: NET_MAX_HEADER_BYTES,
  defaultTimeoutMs: NET_DEFAULT_TIMEOUT_MS,
  maxTimeoutMs: NET_MAX_TIMEOUT_MS,
  maxRedirects: NET_MAX_REDIRECTS,
  tlsMinVersion: NET_TLS_MIN_VERSION,
  features: [],
});

export function createSimNetHost(routes: Readonly<Record<string, SimNetRoute>>, options: SimHostOptions = {}): SimNetHost {
  const policy = simPolicy(options);
  const pending = new Map<number, Pending>();
  /** Handles that sent `end` but still hold visible unread bytes. */
  const drained = new Map<number, Pending>();
  const events: object[] = [];
  const log: string[] = [];
  let nextHandle = 1;
  let now = 0;
  let lastError = "";
  let polls = 0;

  const refuse = (code: string, message: string): number => {
    lastError = `${code}: ${message}`;
    return -1;
  };

  const ns: NetOps = {
    start(metaJson, bodyBuffer) {
      let meta: NetStartMeta;
      try {
        meta = JSON.parse(metaJson) as NetStartMeta;
      } catch {
        return refuse(NET_ERROR.invalidRequest, "malformed request metadata");
      }
      if (typeof meta.url !== "string" || !/^https?:\/\//.test(meta.url)) {
        return refuse(NET_ERROR.invalidRequest, "url must be absolute http:// or https://");
      }
      if (meta.url.startsWith("https://")) return refuse(NET_ERROR.unsupported, "tls not provided");
      if (
        typeof meta.method !== "string" ||
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(meta.method) ||
        (NET_METHODS_FORBIDDEN as readonly string[]).includes(meta.method.toUpperCase())
      ) {
        return refuse(NET_ERROR.invalidRequest, "method not allowed");
      }
      if (pending.size >= NET_MAX_INFLIGHT) return refuse(NET_ERROR.resourceLimit, "too many requests in flight");
      const body = bodyBuffer ? new Uint8Array(bodyBuffer.slice(0)) : new Uint8Array(0);
      if (body.length > NET_MAX_REQUEST_BYTES) return refuse(NET_ERROR.resourceLimit, "request body too large");
      if (policy) {
        const endpoint = simEndpoint(meta.url);
        if (!endpoint || !networkPolicyAllowsConnect(policy, endpoint.protocol, endpoint.host, endpoint.port)) {
          return refuse(NET_ERROR.permissionDenied, "endpoint is not an allowed connect rule");
        }
      }
      const route = routes[meta.url];
      if (!route) return refuse(NET_ERROR.permissionDenied, `no route for ${meta.url}`);
      const request: SimNetRequest = { url: meta.url, method: meta.method, headers: meta.headers ?? {}, body, meta };
      const response = typeof route === "function" ? route(request) : route;
      const handle = nextHandle++;
      const rawBody = response.body ?? "";
      const chunks = Array.isArray(rawBody)
        ? (rawBody as readonly (string | Uint8Array)[]).map(toBytes)
        : [toBytes(rawBody as string | Uint8Array)].filter((c) => c.length > 0);
      const headTick = now + Math.max(1, response.delayTicks ?? 1);
      pending.set(handle, {
        handle,
        request,
        response,
        queueBytes: meta.queueBytes ?? NET_DEFAULT_QUEUE_BYTES,
        maxBodyBytes: meta.maxBodyBytes ?? Number.POSITIVE_INFINITY,
        headTick,
        headSent: false,
        chunks,
        nextChunkTick: headTick,
        visible: [],
        visibleBytes: 0,
        totalDelivered: 0,
        ended: false,
        endSent: false,
        cancelled: false,
        terminal: false,
      });
      log.push(`start ${handle} ${meta.method} ${meta.url} ${body.length}`);
      return handle;
    },
    cancel(handle) {
      const p = pending.get(handle);
      if (!p || p.terminal) {
        // A handle that already ended keeps unread bytes until the guest
        // releases them; cancel frees them without another event.
        if (drained.delete(handle)) log.push(`cancel ${handle}`);
        return;
      }
      p.cancelled = true;
      log.push(`cancel ${handle}`);
    },
    poll() {
      polls++;
      return events.length ? JSON.stringify(events.splice(0)) : undefined;
    },
    lastError() {
      return lastError;
    },
    readInto(handle, into, offset, length) {
      const p = pending.get(handle) ?? drained.get(handle);
      if (!p || !p.headSent) return -1;
      if (p.terminal && !drained.has(handle)) return -1;
      const dest = new Uint8Array(into, offset, length);
      let copied = 0;
      while (p.visible.length && copied < dest.length) {
        const head = p.visible[0];
        const n = Math.min(head.length, dest.length - copied);
        dest.set(head.subarray(0, n), copied);
        copied += n;
        if (n === head.length) p.visible.shift();
        else p.visible[0] = head.subarray(n);
      }
      p.visibleBytes -= copied;
      if (p.visible.length === 0) drained.delete(handle);
      return copied;
    },
    limits() {
      return JSON.stringify(SIM_NET_LIMITS);
    },
  };

  function tick(): void {
    now++;
    for (const p of [...pending.values()]) {
      if (p.terminal) continue;
      if (p.cancelled) {
        p.terminal = true;
        pending.delete(p.handle);
        events.push({ t: "error", h: p.handle, code: NET_ERROR.cancelled, message: "cancelled" });
        continue;
      }
      if (!p.headSent) {
        if (now < p.headTick) continue;
        if (p.response.error && !p.response.error.afterHeaders) {
          p.terminal = true;
          pending.delete(p.handle);
          events.push({ t: "error", h: p.handle, code: p.response.error.code, message: p.response.error.message });
          continue;
        }
        // A fixture that answers from another URL stands in for a redirect:
        // the target is re-authorized like a native core re-checks each hop.
        if (policy && p.response.url !== undefined && p.response.url !== p.request.url) {
          const endpoint = simEndpoint(p.response.url);
          if (!endpoint || !networkPolicyAllowsConnect(policy, endpoint.protocol, endpoint.host, endpoint.port)) {
            p.terminal = true;
            pending.delete(p.handle);
            events.push({ t: "error", h: p.handle, code: NET_ERROR.permissionDenied, message: "redirect target is not an allowed endpoint" });
            continue;
          }
        }
        p.headSent = true;
        const total = p.chunks.reduce((n, c) => n + c.length, 0);
        const head: Record<string, unknown> = {
          t: "headers",
          h: p.handle,
          status: p.response.status ?? 200,
          url: p.response.url ?? p.request.url,
          headers: p.response.headers ?? {},
          redirected: p.response.redirected ?? false,
        };
        if (p.response.length !== null) head.length = p.response.length ?? total;
        events.push(head);
      }
      // Body chunks: each becomes visible when its tick arrives and the
      // queue has room (queueBytes is the backpressure window).
      let announced = false;
      while (p.chunks.length && now >= p.nextChunkTick) {
        const next = p.chunks[0];
        if (p.visibleBytes + next.length > p.queueBytes && p.visibleBytes > 0) break;
        if (p.totalDelivered + next.length > p.maxBodyBytes) {
          p.terminal = true;
          pending.delete(p.handle);
          events.push({ t: "error", h: p.handle, code: NET_ERROR.responseTooLarge, message: "body exceeds maxBodyBytes" });
          break;
        }
        p.chunks.shift();
        p.visible.push(next);
        p.visibleBytes += next.length;
        p.totalDelivered += next.length;
        announced = true;
        p.nextChunkTick = now + (p.response.chunkTicks ?? 0);
        if ((p.response.chunkTicks ?? 0) > 0) break;
      }
      if (p.terminal) continue;
      if (announced) events.push({ t: "readable", h: p.handle, avail: p.visibleBytes });
      if (p.chunks.length === 0 && !p.endSent) {
        if (p.response.error?.afterHeaders) {
          p.terminal = true;
          pending.delete(p.handle);
          events.push({ t: "error", h: p.handle, code: p.response.error.code, message: p.response.error.message });
          continue;
        }
        p.endSent = true;
        p.terminal = true;
        pending.delete(p.handle);
        events.push({ t: "end", h: p.handle });
        // Visible bytes stay readable after `end`; the SDK drains them.
        if (p.visibleBytes > 0) drained.set(p.handle, p);
      }
    }
  }

  return {
    ns,
    tick,
    log,
    pollCalls: () => polls,
    live: () => pending.size,
  };
}
