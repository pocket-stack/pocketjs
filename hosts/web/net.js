// Browser dev host for the PocketJS HTTP Client module (`globalThis.net`,
// contracts/spec/net.ts v2). Browser fetch is the physical transport; this
// adapter supplies the spec-shaped ops, the bounded receive queue and the
// tick batching without exposing browser globals as the guest API.
//
// Delivery contract: fetch
// callbacks only ever append to `completed`; `beginFrame()` (the host's tick
// boundary) freezes each handle's readable watermark and moves the facts into
// `visible`; `poll()` reads `visible` alone. Bytes read from the response
// stream stay in a per-handle queue until the guest copies them out with
// `readInto`; the reader stops pulling while the queue is at capacity.
//
// Browser profile deviations: credentials "omit", cache "no-store",
// redirect "manual" — a redirect the browser hides ends the request with
// `unsupported`; TLS is the browser's, so "tls" is advertised.

import {
  HTTP_NULL_BODY_STATUS,
  NET_DEFAULT_AGGREGATE_BYTES,
  NET_DEFAULT_QUEUE_BYTES,
  NET_DEFAULT_TIMEOUT_MS,
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
} from "./net-spec.js";

// The spec ceilings, as this host's effective limits (it tightens none of
// them; the generated net-spec.js is the single source, never literals here).
const SPEC_MAJOR = NET_SPEC_MAJOR;
const SPEC_MINOR = NET_SPEC_MINOR;
const MAX_INFLIGHT = NET_MAX_INFLIGHT;
const MAX_REQUEST_BYTES = NET_MAX_REQUEST_BYTES;
const DEFAULT_QUEUE_BYTES = NET_DEFAULT_QUEUE_BYTES;
const MAX_QUEUE_BYTES = NET_MAX_QUEUE_BYTES;
const DEFAULT_AGGREGATE_BYTES = NET_DEFAULT_AGGREGATE_BYTES;
const MAX_AGGREGATE_BYTES = NET_MAX_AGGREGATE_BYTES;
const MAX_EVENTS_PER_TICK = NET_MAX_EVENTS_PER_TICK;
const MAX_TICK_BYTES = NET_MAX_TICK_BYTES;
const MAX_HEADERS = NET_MAX_HEADERS;
const MAX_HEADER_BYTES = NET_MAX_HEADER_BYTES;
const DEFAULT_TIMEOUT_MS = NET_DEFAULT_TIMEOUT_MS;
const MAX_TIMEOUT_MS = NET_MAX_TIMEOUT_MS;
const MAX_REDIRECTS = NET_MAX_REDIRECTS;
const FORBIDDEN_METHODS = new Set(NET_METHODS_FORBIDDEN);
const NULL_BODY_STATUS = new Set(HTTP_NULL_BODY_STATUS);

const LIMITS = Object.freeze({
  specMajor: SPEC_MAJOR,
  specMinor: SPEC_MINOR,
  maxInflight: MAX_INFLIGHT,
  maxTlsInflight: MAX_INFLIGHT,
  maxRequestBytes: MAX_REQUEST_BYTES,
  defaultQueueBytes: DEFAULT_QUEUE_BYTES,
  maxQueueBytes: MAX_QUEUE_BYTES,
  defaultAggregateBytes: DEFAULT_AGGREGATE_BYTES,
  maxAggregateBytes: MAX_AGGREGATE_BYTES,
  maxEventsPerTick: MAX_EVENTS_PER_TICK,
  maxTickBytes: MAX_TICK_BYTES,
  maxHeaders: MAX_HEADERS,
  maxHeaderBytes: MAX_HEADER_BYTES,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  maxTimeoutMs: MAX_TIMEOUT_MS,
  maxRedirects: MAX_REDIRECTS,
  tlsMinVersion: NET_TLS_MIN_VERSION,
  features: ["tls"],
});

function headerBytes(headers) {
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const [name, value] of Object.entries(headers)) {
    bytes += name.length + encoder.encode(value).byteLength + 4;
  }
  return bytes;
}

function validHeaders(headers) {
  const entries = Object.entries(headers);
  return entries.length <= MAX_HEADERS &&
    headerBytes(headers) <= MAX_HEADER_BYTES &&
    entries.every(([name, value]) =>
      typeof value === "string" &&
      /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) &&
      !/[\r\n]/.test(value),
    );
}

function timeoutValue(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) return null;
  return value;
}

export function createNetHost(nativeFetch = globalThis.fetch.bind(globalThis)) {
  let nextHandle = 1;
  let lastError = "";
  const states = new Map(); // handle -> state (until retired)
  const completed = []; // async transport facts, not guest-visible yet
  const visible = []; // facts frozen at beginFrame()

  function refuse(code, message) {
    lastError = `${code}: ${message}`;
    return -1;
  }

  function inflight() {
    let n = 0;
    for (const s of states.values()) if (!s.terminal) n++;
    return n;
  }

  function stopTimers(state) {
    for (const t of state.timers) clearTimeout(t);
    state.timers.length = 0;
  }

  /** Terminal failure: one error event, native resources released. */
  function fail(state, code, message) {
    if (state.terminal) return;
    state.terminal = true;
    stopTimers(state);
    state.controller.abort();
    state.reader?.cancel().catch(() => {});
    state.chunks.length = 0;
    state.queued = 0;
    states.delete(state.handle);
    completed.push({ t: "error", h: state.handle, code, message });
  }

  /** Terminal EOF: `end` event; unread bytes stay readable until drained. */
  function end(state) {
    if (state.terminal) return;
    state.terminal = true;
    state.ended = true;
    stopTimers(state);
    completed.push({ t: "end", h: state.handle });
    if (state.queued === 0) states.delete(state.handle);
  }

  async function run(state, meta, body) {
    let response;
    try {
      response = await nativeFetch(meta.url, {
        method: meta.method,
        headers: meta.headers,
        body: meta.method === "GET" || meta.method === "HEAD" || body.byteLength === 0 ? undefined : body,
        credentials: "omit",
        cache: "no-store",
        redirect: "manual",
        signal: state.controller.signal,
      });
    } catch (error) {
      if (!state.terminal) fail(state, state.timedOut ? "timeout" : "connect", error instanceof Error ? error.message : String(error));
      return;
    }
    if (state.terminal) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    clearTimeout(state.headersTimer);
    if (response.type === "opaqueredirect") {
      fail(state, "unsupported", "the browser hides redirect targets");
      return;
    }
    if ([301, 302, 303, 307, 308].includes(response.status) && meta.redirect === "error") {
      fail(state, "redirect", `redirect ${response.status} refused`);
      await response.body?.cancel().catch(() => {});
      return;
    }
    const headers = Object.create(null);
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    if (!validHeaders(headers)) {
      fail(state, "protocol", "response headers exceed limits");
      await response.body?.cancel().catch(() => {});
      return;
    }
    const head = {
      t: "headers",
      h: state.handle,
      status: response.status,
      url: response.url || meta.url,
      headers,
      redirected: response.redirected === true,
    };
    const lengthHeader = response.headers.get("content-length");
    if (lengthHeader !== null && /^\d+$/.test(lengthHeader)) head.length = Number(lengthHeader);
    completed.push(head);
    state.headSent = true;
    if (!response.body || meta.method === "HEAD" || NULL_BODY_STATUS.has(response.status)) {
      await response.body?.cancel().catch(() => {});
      end(state);
      return;
    }
    // A BYOB reader bounds every read to the queue's free space, so the
    // receive queue is a hard cap (queueBytes) the way a native core's is.
    // Bodies that are not byte streams (some runtimes' synthetic responses)
    // fall back to the default reader, whose chunks are sized by the
    // browser: the host then stops pulling at the cap but the chunk that
    // crossed it is held whole (at most one chunk past queueBytes).
    let reader;
    let byob = false;
    try {
      reader = response.body.getReader({ mode: "byob" });
      byob = true;
    } catch {
      reader = response.body.getReader();
    }
    state.reader = reader;
    try {
      for (;;) {
        // Backpressure: never pull past the queue capacity.
        while (state.queued >= state.queueBytes && !state.terminal) {
          await new Promise((resolve) => {
            state.wake = resolve;
          });
        }
        if (state.terminal) break;
        state.armIdle();
        const { done, value } = byob
          ? await reader.read(new Uint8Array(Math.min(state.queueBytes - state.queued, 64 * 1024)))
          : await reader.read();
        if (state.terminal) break;
        if (done) {
          end(state);
          break;
        }
        state.total += value.byteLength;
        if (state.total > state.maxBodyBytes) {
          fail(state, "response_too_large", `body exceeds ${state.maxBodyBytes} bytes`);
          break;
        }
        if (value.byteLength === 0) continue; // a BYOB read may fill nothing yet
        state.chunks.push(value);
        state.queued += value.byteLength;
        state.dirty = true; // new bytes: announce `readable` at the next tick
      }
    } catch (error) {
      if (!state.terminal) fail(state, state.timedOut ? "timeout" : "closed", error instanceof Error ? error.message : String(error));
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
  }

  const ns = {
    start(metaJson, bodyBuffer) {
      let meta;
      try {
        meta = JSON.parse(metaJson);
      } catch {
        return refuse("invalid_request", "malformed request metadata");
      }
      if (!meta || typeof meta !== "object" || (bodyBuffer !== null && !(bodyBuffer instanceof ArrayBuffer))) {
        return refuse("invalid_request", "malformed request metadata or body");
      }
      const body = bodyBuffer ? new Uint8Array(bodyBuffer).slice() : new Uint8Array(0);
      if (inflight() >= MAX_INFLIGHT) return refuse("resource_limit", `at most ${MAX_INFLIGHT} requests may be in flight`);
      if (typeof meta.url !== "string" || !/^https?:\/\/[^\s/]+(?:\/|$)/.test(meta.url)) {
        return refuse("invalid_request", "url must be absolute HTTP(S)");
      }
      if (typeof meta.method !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(meta.method) || FORBIDDEN_METHODS.has(meta.method.toUpperCase())) {
        return refuse("invalid_request", "unsupported method");
      }
      if ((meta.method === "GET" || meta.method === "HEAD") && body.byteLength) {
        return refuse("invalid_request", `${meta.method} cannot have a body`);
      }
      if (body.byteLength > MAX_REQUEST_BYTES) return refuse("resource_limit", "request body too large");
      if (!meta.headers || typeof meta.headers !== "object" || !validHeaders(meta.headers)) {
        return refuse("invalid_request", "invalid headers");
      }
      const timeouts = meta.timeouts && typeof meta.timeouts === "object" ? meta.timeouts : {};
      const connectMs = timeoutValue(timeouts.connectMs, DEFAULT_TIMEOUT_MS);
      const headersMs = timeoutValue(timeouts.headersMs, DEFAULT_TIMEOUT_MS);
      const idleMs = timeoutValue(timeouts.idleMs, DEFAULT_TIMEOUT_MS);
      const totalMs = timeoutValue(timeouts.totalMs, MAX_TIMEOUT_MS);
      if (connectMs === null || headersMs === null || idleMs === null || totalMs === null) {
        return refuse("invalid_request", "invalid timeouts");
      }
      const queueBytes = meta.queueBytes === undefined ? DEFAULT_QUEUE_BYTES : meta.queueBytes;
      if (!Number.isInteger(queueBytes) || queueBytes < 1 || queueBytes > MAX_QUEUE_BYTES) {
        return refuse("invalid_request", "invalid queueBytes");
      }
      if (meta.tls && meta.tls.verification === "development-insecure") {
        return refuse("unsupported", "the browser owns TLS verification");
      }
      const handle = nextHandle++;
      const state = {
        handle,
        controller: new AbortController(),
        timedOut: false,
        terminal: false,
        ended: false,
        headSent: false,
        queueBytes,
        maxBodyBytes: Number.isInteger(meta.maxBodyBytes) ? meta.maxBodyBytes : Number.POSITIVE_INFINITY,
        chunks: [],
        queued: 0,
        visibleBytes: 0,
        total: 0,
        dirty: false,
        wake: null,
        reader: null,
        timers: [],
        headersTimer: null,
        idleTimer: null,
        armIdle() {
          clearTimeout(this.idleTimer);
          this.idleTimer = setTimeout(() => {
            this.timedOut = true;
            fail(this, "timeout", "body idle timeout");
          }, idleMs);
          this.timers.push(this.idleTimer);
        },
      };
      state.headersTimer = setTimeout(() => {
        state.timedOut = true;
        fail(state, "timeout", "response headers timeout");
      }, Math.min(connectMs + headersMs, totalMs));
      state.timers.push(state.headersTimer);
      state.timers.push(
        setTimeout(() => {
          state.timedOut = true;
          fail(state, "timeout", "total timeout");
        }, totalMs),
      );
      states.set(handle, state);
      void run(state, meta, body);
      return handle;
    },
    cancel(handle) {
      const state = states.get(handle);
      if (!state) return;
      if (state.ended) {
        // Ended handle with unread bytes: release them, no further event.
        states.delete(handle);
        return;
      }
      fail(state, "cancelled", "cancelled");
    },
    poll() {
      return visible.length ? JSON.stringify(visible.splice(0)) : undefined;
    },
    lastError() {
      return lastError;
    },
    readInto(handle, into, offset, length) {
      const state = states.get(handle);
      if (!state || !state.headSent) return -1;
      const dest = new Uint8Array(into, offset, length);
      let copied = 0;
      const budget = Math.min(dest.byteLength, state.visibleBytes);
      while (state.chunks.length && copied < budget) {
        const head = state.chunks[0];
        const n = Math.min(head.byteLength, budget - copied);
        dest.set(head.subarray(0, n), copied);
        copied += n;
        if (n === head.byteLength) state.chunks.shift();
        else state.chunks[0] = head.subarray(n);
      }
      state.visibleBytes -= copied;
      state.queued -= copied;
      if (state.wake && state.queued < state.queueBytes) {
        const wake = state.wake;
        state.wake = null;
        wake();
      }
      if (state.ended && state.queued === 0) states.delete(handle);
      return copied;
    },
    limits() {
      return JSON.stringify(LIMITS);
    },
  };

  return {
    ns,
    beginFrame() {
      // Freeze the readable watermark of every handle with new bytes.
      for (const state of states.values()) {
        if (state.dirty && state.headSent) {
          state.dirty = false;
          state.visibleBytes = state.queued;
          completed.push({ t: "readable", h: state.handle, avail: state.visibleBytes });
        }
      }
      // `end` must follow the readable that announced the final bytes: the
      // reader loop pushed `end` before beginFrame() ran, so hoist readable
      // events ahead of their handle's `end`.
      const ends = completed.filter((e) => e.t === "end");
      const rest = completed.filter((e) => e.t !== "end");
      visible.push(...rest, ...ends);
      completed.length = 0;
    },
    reset() {
      for (const handle of [...states.keys()]) {
        const state = states.get(handle);
        if (state && !state.terminal) fail(state, "cancelled", "reset");
        states.delete(handle);
      }
      completed.length = 0;
      visible.length = 0;
    },
  };
}
