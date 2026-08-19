// PocketJS net spec v2 — the boundary of the HTTP Client module (`globalThis.net`).
//
// The public SDK is `@pocketjs/framework/net/http` (`fetch`, `Headers`,
// `Request`, `Response`, `BodyStream`). This file fixes the guest ↔ core
// boundary underneath it: numeric op codes, event names, the JSON data
// contract, portable limits and the shared error vocabulary.
//
// The four parts of the boundary:
//
//   ops            guest -> core intent (numeric codes below, append-only)
//   events         core -> guest facts (one JSON batch per tick, sequence order)
//   data contract  request metadata JSON + borrowed request body + copied
//                  response bytes (`readInto`)
//   frame contract transport never enters QuickJS; completions become visible
//                  only at a host tick boundary (`begin_tick`), the framework
//                  service pump calls `poll` exactly once per frame, and
//                  Promise reactions run in that guest turn's job drain
//
// Ownership:
//   start() BORROWS the request ArrayBuffer for the synchronous call; the host
//   copies it before returning. readInto() BORROWS a destination ArrayBuffer
//   and copies bytes that became visible at the last tick boundary into it,
//   releasing the corresponding native queue space.
//
// Host obligations:
//   - `begin_tick()` before every `frame()`: swap transport completions into
//     the visible set and freeze each handle's `readable` watermark;
//   - no network task or callback ever calls QuickJS;
//   - TLS (when the host advertises the "tls" feature): system trust store,
//     SNI = authorized hostname, DNS-ID hostname verification, TLS 1.2
//     minimum, renegotiation and 0-RTT off, trusted wall clock or
//     `tls_clock_untrusted`, never a plaintext fallback.
//
// If you change ANY value here: run `bun run gen` (contracts/spec/gen-rust.ts,
// contracts/spec/gen-c.ts), commit the regenerated engine/core/src/spec.rs and
// engine/net/include/pocketjs/net/spec.h (tests/contract.ts byte-compares).

// ---------------------------------------------------------------------------
// Spec version — the host reports it from `limits()` (specMajor/specMinor);
// the SDK refuses a major mismatch with `unsupported`.
// ---------------------------------------------------------------------------

export const NET_SPEC_MAJOR = 2;
export const NET_SPEC_MINOR = 0;

// ---------------------------------------------------------------------------
// Net ops (the `net.*` native contract; codes append-only, 2 is retired)
// ---------------------------------------------------------------------------
//
// Signatures (authoritative; hosts marshal them however they like):
//   start(metaJson:string, body:ArrayBuffer|null) -> handle | -1
//      metaJson: see NetStartMeta below. Static validation only (URL, method,
//      header syntax, scheme/capability, endpoint rule, insecureTransport,
//      limits, inflight); the body is copied before the call returns. Read
//      lastError() on -1. Checks that need DNS fail asynchronously with an
//      `error` event.
//   cancel(handle)
//      Best-effort transport close plus core cleanup; the handle's terminal
//      `error{code:"cancelled"}` arrives with the next tick's batch. No-op on
//      a handle that already reached its terminal event.
//   poll() -> string | undefined
//      The whole event batch visible at this tick as one JSON array, ordered
//      by sequence. The SDK calls it exactly once per tick and only while at
//      least one handle is live.
//   lastError() -> string
//      Portable `code: message` for the most recent synchronous refusal.
//   readInto(handle, into:ArrayBuffer, offset, length) -> bytes | -1
//      Copy up to `length` visible unread body bytes into into[offset..] and
//      release that queue space. 0 = no visible bytes right now (wait for the
//      next `readable`); EOF is signalled by the `end` event; -1 = unknown or
//      terminal handle.
//   limits() -> string
//      Read-only JSON with this host's effective limits and features (see
//      NetLimits below).
//   write(handle, chunk:ArrayBuffer) -> accepted | -1     (phase 2, reserved)
//   endBody(handle)                                        (phase 2, reserved)

export const NET_OP = {
  start: 1,
  /** v1 `take` — retired code, never reused. */
  take: 2,
  cancel: 3,
  poll: 4,
  lastError: 5,
  readInto: 6,
  limits: 7,
  write: 8,
  endBody: 9,
} as const;

// ---------------------------------------------------------------------------
// Events (core -> guest facts; all events for a tick in one JSON array)
// ---------------------------------------------------------------------------
//
//   {"t":"headers","h":n,"status":200,"url":"http://…","headers":{…},"redirected":false,"length":5}
//   {"t":"readable","h":n,"avail":1234}
//   {"t":"end","h":n}
//   {"t":"error","h":n,"code":"timeout","message":"…","causeCode":"…"}
//   {"t":"drain","h":n}                                   (phase 2)
//
// Per handle the sequence is `headers → readable* → end` or `… → error`;
// nothing follows `error`. `readable.avail` is the total visible unread byte
// count at the tick boundary and is sent at most once per handle per tick.
// `end` may arrive while visible bytes remain unread; the SDK drains them
// first. HTTP 4xx/5xx are successful exchanges; HEAD/204/304 produce
// `headers` + `end`.

export const NET_EVENT = {
  headers: "headers",
  readable: "readable",
  end: "end",
  error: "error",
  drain: "drain",
} as const;

// ---------------------------------------------------------------------------
// Data contract
// ---------------------------------------------------------------------------

/** `start` metadata. `queueBytes` is the native receive-queue capacity
 * (backpressure window); `maxBodyBytes` is an optional total cap. Timeouts
 * use the host monotonic clock: `connectMs` covers DNS + TCP + TLS,
 * `headersMs` request-sent → response headers, `idleMs` body inactivity,
 * `totalMs` the whole exchange. */
export interface NetStartMeta {
  url: string;
  method: string;
  headers: Record<string, string>;
  queueBytes?: number;
  maxBodyBytes?: number;
  timeouts?: { connectMs?: number; headersMs?: number; idleMs?: number; totalMs?: number };
  redirect?: "follow" | "manual" | "error";
  maxRedirects?: number;
  tls?: { verification?: "full" | "development-insecure" };
}

/** `limits()` payload. Spec constants are portable ceilings; hosts only
 * tighten, and this reports the tightened values. */
export interface NetLimits {
  specMajor: number;
  specMinor: number;
  maxInflight: number;
  maxTlsInflight: number;
  maxRequestBytes: number;
  defaultQueueBytes: number;
  maxQueueBytes: number;
  defaultAggregateBytes: number;
  maxAggregateBytes: number;
  maxEventsPerTick: number;
  maxTickBytes: number;
  maxHeaders: number;
  maxHeaderBytes: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxRedirects: number;
  tlsMinVersion: string;
  features: readonly string[];
}

// ---------------------------------------------------------------------------
// Portable limits (ceilings; a host's limits() may be smaller, never larger)
// ---------------------------------------------------------------------------

/** Concurrent live handles per runtime. */
export const NET_MAX_INFLIGHT = 8;
/** Request bodies are copied out of the guest during start(). */
export const NET_MAX_REQUEST_BYTES = 256 * 1024;
/** Per-handle native receive queue (backpressure window). */
export const NET_DEFAULT_QUEUE_BYTES = 32 * 1024;
export const NET_MAX_QUEUE_BYTES = 256 * 1024;
/** SDK aggregate helpers (`text()`/`json()`/`arrayBuffer()`): total bytes
 * before the SDK cancels the handle with `response_too_large`. */
export const NET_DEFAULT_AGGREGATE_BYTES = 1024 * 1024;
export const NET_MAX_AGGREGATE_BYTES = 8 * 1024 * 1024;
/** Visible-set budget per tick: events and newly visible bytes across all
 * handles. Excess stays queued natively and follows in sequence order. */
export const NET_MAX_EVENTS_PER_TICK = 128;
export const NET_MAX_TICK_BYTES = 256 * 1024;

export const NET_MAX_HEADERS = 64;
export const NET_MAX_HEADER_BYTES = 16 * 1024;
export const NET_DEFAULT_TIMEOUT_MS = 30_000;
export const NET_MAX_TIMEOUT_MS = 120_000;
/** Default and maximum redirect hops; applications can only lower it. */
export const NET_MAX_REDIRECTS = 5;
export const NET_TLS_MIN_VERSION = "1.2";

// ---------------------------------------------------------------------------
// HTTP semantics shared by every implementation (SDK, sim, browser host, C
// core, Rust core). These are the wire-visible rules that used to live as
// folklore in each layer; contracts/spec/vectors/http-semantics.json pins
// them and every implementation runs the same vectors.
// ---------------------------------------------------------------------------

/** Methods that are never client-app operations: RFC 9110 CONNECT and TRACE,
 * plus TRACK (the legacy Microsoft TRACE alias, refused for the same
 * cross-site-tracing reason). Matching is case-insensitive; any other RFC
 * 9110 token is accepted verbatim. */
export const NET_METHODS_FORBIDDEN = ["CONNECT", "TRACE", "TRACK"] as const;

/** Request headers the core owns (framing, connection control, upgrade).
 * The SDK refuses them on a Request; a core strips them if they arrive. */
export const HTTP_CORE_OWNED_REQUEST_HEADERS = [
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "trailer",
  "te",
  "upgrade",
  "keep-alive",
  "expect",
  "proxy-connection",
] as const;

/** Response statuses whose message never has a body regardless of the
 * framing headers (RFC 9112 §6.3 rule 1); every 1xx status and the response
 * to a HEAD request are bodyless the same way. A client parses these as
 * head-only and reports `length` from Content-Length when present. */
export const HTTP_BODYLESS_STATUS = [204, 304] as const;

/** Statuses a Response may not carry content for: the Fetch "null body
 * status" set (101, 103, 204, 205, 304). The SDK Response refuses a body
 * init, a server refuses to emit content, a client surfaces a null body. */
export const HTTP_NULL_BODY_STATUS = [101, 103, 204, 205, 304] as const;

/** Redirect statuses a client follows under `redirect: "follow"`; any other
 * 3xx is an ordinary response. */
export const HTTP_REDIRECT_STATUS = [301, 302, 303, 307, 308] as const;
/** On these statuses a POST becomes a GET and the body is dropped (RFC 9110
 * §15.4.2-3 common practice); other methods are kept. */
export const HTTP_REDIRECT_POST_TO_GET_STATUS = [301, 302] as const;
/** On these statuses any method except HEAD becomes a GET without a body. */
export const HTTP_REDIRECT_ANY_TO_GET_STATUS = [303] as const;

// ---------------------------------------------------------------------------
// Errors — the vocabulary shared by net, ws and httpd. A core
// maps platform/library failures into these codes before crossing the
// boundary; the raw code may travel in `causeCode`.
// ---------------------------------------------------------------------------

export const NET_ERROR = {
  // synchronous refusal / runtime
  invalidRequest: "invalid_request",
  invalidState: "invalid_state",
  unsupported: "unsupported",
  permissionDenied: "permission_denied",
  busy: "busy",
  resourceLimit: "resource_limit",
  // resolver / transport
  dns: "dns",
  connect: "connect",
  addressInUse: "address_in_use",
  closed: "closed",
  timeout: "timeout",
  // tls
  tlsCertificateInvalid: "tls_certificate_invalid",
  tlsHostnameMismatch: "tls_hostname_mismatch",
  tlsHandshakeFailed: "tls_handshake_failed",
  tlsClockUntrusted: "tls_clock_untrusted",
  // http
  redirect: "redirect",
  responseTooLarge: "response_too_large",
  protocol: "protocol",
  // websocket
  websocketHandshakeFailed: "websocket_handshake_failed",
  websocketProtocolError: "websocket_protocol_error",
  messageTooLarge: "message_too_large",
  // other
  cancelled: "cancelled",
  other: "other",
  /** SDK-only: the namespace is not mounted on this host. */
  unavailable: "unavailable",
} as const;

export type NetErrorCode = (typeof NET_ERROR)[keyof typeof NET_ERROR];

/** `NetworkError.category` is derived from the code, never sent by a host. */
export function netErrorCategory(
  code: string,
): "runtime" | "resolver" | "transport" | "tls" | "protocol" {
  switch (code) {
    case NET_ERROR.dns:
      return "resolver";
    case NET_ERROR.connect:
    case NET_ERROR.addressInUse:
      return "transport";
    case NET_ERROR.tlsCertificateInvalid:
    case NET_ERROR.tlsHostnameMismatch:
    case NET_ERROR.tlsHandshakeFailed:
    case NET_ERROR.tlsClockUntrusted:
      return "tls";
    case NET_ERROR.redirect:
    case NET_ERROR.responseTooLarge:
    case NET_ERROR.protocol:
    case NET_ERROR.websocketHandshakeFailed:
    case NET_ERROR.websocketProtocolError:
    case NET_ERROR.messageTooLarge:
      return "protocol";
    default:
      return "runtime";
  }
}
