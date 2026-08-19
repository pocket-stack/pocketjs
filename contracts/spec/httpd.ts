// PocketJS httpd spec v2 — the boundary of the HTTP Server module
// (`globalThis.httpd`).
//
// The public SDK is `serve()` in `@pocketjs/framework/net/http`. This file
// fixes the guest ↔ core boundary underneath it. HTTP Server is its own
// module (spec, core, capability `network.http.server` / `.tls`, namespace);
// it shares the native HTTP/1.1 parser, transport/TLS/queue substrate, policy
// input and error vocabulary (contracts/spec/net.ts NET_ERROR) with the HTTP
// Client. The guest sees a server handle and request ids, never connections:
// keep-alive, the pipelining ban, `Expect: 100-continue` and HEAD body
// discard are core rules.
//
// Frame contract: identical to net — completions become visible at
// `begin_tick()`, `poll()` runs once per tick, `respond`/`write` only place
// bytes in the connection's bounded send queue and the network task writes
// them out as soon as `frame()` returns.
//
// If you change ANY value here: run `bun run gen` and commit the regenerated
// engine/core/src/spec.rs and engine/net/include/pocketjs/net/spec.h.

export const HTTPD_SPEC_MAJOR = 2;
export const HTTPD_SPEC_MINOR = 0;

// ---------------------------------------------------------------------------
// Ops (guest -> core, all synchronous; codes append-only)
// ---------------------------------------------------------------------------
//
//   listen(metaJson) -> handle | -1
//      Static validation only (capability, (protocol, address, port) listen
//      rule, insecureTransport, credential id, limits, server count).
//      bind/listen happen on the network task: `listening` on success,
//      terminal `error` on failure.
//   stop(handle, graceful, timeoutMs) -> 0 | -1
//      Stop accepting and close idle connections; graceful waits for
//      inflight requests until timeoutMs, then forces the rest. Terminal
//      `closed{h}` follows; forced requests each get `aborted{code:"closed"}`.
//   respond(req, metaJson, body:ArrayBuffer|null) -> 0 | -1 | -2 | -3
//      Send the response head; with meta.end=true (default) the body
//      completes the response, else `write`/`endBody` stream it. -1 unknown/
//      answered/aborted req; -2 body does not fit the send queue (nothing
//      accepted, `drain` armed — use end=false + write); -3 invalid meta.
//   write(req, chunk:ArrayBuffer) -> 0 | -1 | -2 | -3
//      Append a body chunk after respond(end=false); accepted whole or not
//      at all. -2 queue full (`drain` armed); -3 chunk > maxSendQueueBytes.
//   endBody(req) -> 0 | -1
//      Finish a streamed response (writes the terminating chunk); the req id
//      is invalid afterwards.
//   readInto(req, into:ArrayBuffer, offset, length) -> bytes | -1
//      Read request-body bytes visible at the tick boundary; same semantics
//      as net.readInto. EOF is `end{req}`.
//   abort(req)
//      Give the request up: the core closes the connection (or ends the body
//      if a response started); next tick delivers `aborted{req,
//      code:"cancelled"}`. No-op on a terminal req.
//   poll() -> string | undefined
//   lastError() -> string
//   limits() -> string

export const HTTPD_OP = {
  listen: 1,
  stop: 2,
  respond: 3,
  write: 4,
  endBody: 5,
  readInto: 6,
  abort: 7,
  poll: 8,
  lastError: 9,
  limits: 10,
} as const;

/** `respond`/`write` return values. */
export const HTTPD_SEND_ACCEPTED = 0;
export const HTTPD_SEND_INVALID_REQUEST = -1;
export const HTTPD_SEND_BACKPRESSURE = -2;
export const HTTPD_SEND_INVALID = -3;

// ---------------------------------------------------------------------------
// Events (core -> guest, one JSON array per tick, sequence order)
// ---------------------------------------------------------------------------
//
//   {"t":"listening","h":n,"address":"192.168.1.20","port":8080}
//   {"t":"closed","h":n}
//   {"t":"error","h":n,"code":"address_in_use","message":"…","causeCode":"…"}
//   {"t":"request","h":n,"req":r,"method":"GET","target":"/a?b=1","headers":{…},
//    "remote":{"address":"…","port":51234},"length":12,"secure":false}
//   {"t":"readable","req":r,"avail":12}
//   {"t":"end","req":r}
//   {"t":"drain","req":r}
//   {"t":"aborted","req":r,"code":"closed"}
//
// Per server: `error` (before listening, terminal) or
// `listening → request* → [error →] closed`. Per req the terminal is either
// the application completing the response (respond end=true / endBody) or
// exactly one `aborted{code}` with code closed | timeout | response_too_large
// | cancelled. `request` is delivered only when an inflight slot and the
// per-tick event budget allow it.

export const HTTPD_EVENT = {
  listening: "listening",
  closed: "closed",
  error: "error",
  request: "request",
  readable: "readable",
  end: "end",
  drain: "drain",
  aborted: "aborted",
} as const;

// ---------------------------------------------------------------------------
// Data contract
// ---------------------------------------------------------------------------

export interface HttpdListenMeta {
  address: string;
  /** 0 = ephemeral; must match a listen rule with port "ephemeral". */
  port: number;
  backlog?: number;
  tls?: { credential: string };
  limits?: {
    maxConnections?: number;
    maxInflight?: number;
    maxHeaderBytes?: number;
    maxBodyBytes?: number;
    requestQueueBytes?: number;
    sendQueueBytes?: number;
  };
  timeouts?: {
    headerMs?: number;
    bodyIdleMs?: number;
    handlerMs?: number;
    keepAliveMs?: number;
    closeMs?: number;
  };
}

export interface HttpdRespondMeta {
  status: number;
  /** Reason phrase; empty selects the RFC 9110 default. */
  statusText?: string;
  headers?: Record<string, string>;
  /** Known body length for a streamed response; omitted = chunked. */
  contentLength?: number;
  /** false = stream the body with write/endBody. Default true. */
  end?: boolean;
}

export interface HttpdLimits {
  specMajor: number;
  specMinor: number;
  maxServers: number;
  maxConnections: number;
  maxInflight: number;
  maxTlsInflight: number;
  maxHeaders: number;
  maxHeaderBytes: number;
  maxTargetBytes: number;
  defaultRequestQueueBytes: number;
  maxRequestQueueBytes: number;
  maxSendQueueBytes: number;
  sendHighWaterBytes: number;
  sendLowWaterBytes: number;
  maxEventsPerTick: number;
  maxTickBytes: number;
  defaultHeaderMs: number;
  defaultBodyIdleMs: number;
  defaultHandlerMs: number;
  defaultKeepAliveMs: number;
  defaultCloseMs: number;
  maxTimeoutMs: number;
  tlsMinVersion: string;
  features: readonly string[];
}

// ---------------------------------------------------------------------------
// Portable limits (ceilings; hosts only tighten)
// ---------------------------------------------------------------------------

/** Listeners alive at once. */
export const HTTPD_MAX_SERVERS = 2;
/** Per server: open connections / delivered-but-unanswered requests. */
export const HTTPD_MAX_CONNECTIONS = 16;
export const HTTPD_MAX_INFLIGHT = 8;
export const HTTPD_MAX_BACKLOG = 16;
/** Request head: header count, total header bytes, request-target bytes;
 * exceeding answers 431 / 414 and closes without delivering `request`. */
export const HTTPD_MAX_HEADERS = 64;
export const HTTPD_MAX_HEADER_BYTES = 16 * 1024;
export const HTTPD_MAX_TARGET_BYTES = 2048;
/** Per-request native receive queue (backpressure window). */
export const HTTPD_DEFAULT_REQUEST_QUEUE_BYTES = 32 * 1024;
export const HTTPD_MAX_REQUEST_QUEUE_BYTES = 256 * 1024;
/** Per-connection send queue and its `drain` thresholds. */
export const HTTPD_MAX_SEND_QUEUE_BYTES = 256 * 1024;
export const HTTPD_SEND_HIGH_WATER_BYTES = 128 * 1024;
export const HTTPD_SEND_LOW_WATER_BYTES = 32 * 1024;
export const HTTPD_MAX_EVENTS_PER_TICK = 128;
export const HTTPD_MAX_TICK_BYTES = 256 * 1024;
export const HTTPD_DEFAULT_HEADER_MS = 10_000;
export const HTTPD_DEFAULT_BODY_IDLE_MS = 30_000;
export const HTTPD_DEFAULT_HANDLER_MS = 30_000;
export const HTTPD_DEFAULT_KEEP_ALIVE_MS = 15_000;
export const HTTPD_DEFAULT_CLOSE_MS = 5_000;
export const HTTPD_MAX_TIMEOUT_MS = 120_000;
