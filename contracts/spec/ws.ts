// PocketJS ws spec v2 — the boundary of the WebSocket Client module
// (`globalThis.ws`).
//
// The public SDK is `@pocketjs/framework/net/websocket` (`connect`). This file
// fixes the guest ↔ core boundary underneath it. WebSocket is its own module:
// its own spec, core, capability (`network.websocket.client` / `.tls`) and
// namespace, mounted only by hosts that ship it. It shares the transport/TLS/
// queue substrate, the policy input, the frame contract and the error
// vocabulary (contracts/spec/net.ts NET_ERROR) with the HTTP modules.
//
// Frame contract: identical to net — completions become visible at
// `begin_tick()`, `poll()` runs once per tick from the framework service pump,
// handlers run synchronously inside that pump and return void, Promise
// reactions run in the same tick's job drain. The core answers pings itself
// (RFC 6455 §5.5.3) and never sends keepalive pings on its own.
//
// If you change ANY value here: run `bun run gen` and commit the regenerated
// engine/core/src/spec.rs and engine/net/include/pocketjs/net/spec.h.

export const WS_SPEC_MAJOR = 2;
export const WS_SPEC_MINOR = 0;

// ---------------------------------------------------------------------------
// Ops (guest -> core, all synchronous; codes append-only)
// ---------------------------------------------------------------------------
//
//   connect(metaJson) -> handle | -1
//      Static validation only (`ws:`/`wss:` scheme + capability, endpoint
//      rule, insecureTransport, header syntax + forbidden headers, protocol
//      tokens, limits, socket count). DNS/filtering/TCP/TLS/handshake happen
//      asynchronously: success arrives as `open`, failure as `error`.
//   send(handle, opcode, payload:string|ArrayBuffer|null) -> status
//      opcode uses the RFC 6455 values: 1 text, 2 binary, 9 ping, 10 pong.
//      The payload is snapshotted into the bounded send queue inside the
//      call; a message is accepted whole or not at all. Returns
//      WS_SEND_ACCEPTED (0), WS_SEND_ACCEPTED_HIGH_WATER (1),
//      WS_SEND_CLOSED (-1), WS_SEND_BACKPRESSURE (-2, `drain` armed),
//      WS_SEND_INVALID (-3: over maxMessageBytes, control payload > 125,
//      bad opcode).
//   receiveInto(handle, into:ArrayBuffer, offset, length) -> bytes | -1
//      Dequeue the head BINARY message into into[offset..]. `length` must be
//      >= the message's `bytes`, else -1 and nothing is dequeued.
//   close(handle, code?, reason?) -> 0 | -1 | -3
//      Start the close handshake after the accepted messages; the terminal
//      `close` event follows once the peer answers or closeMs elapses. code
//      is omitted, 1000 or 3000–4999; reason is UTF-8 <= 123 bytes (else -3).
//      -1 when not open or already closing.
//   terminate(handle)
//      Abort the transport without a Close frame; next tick delivers
//      `close{code:1006, clean:false, local:true}` (or `error{cancelled}` if
//      the handshake never completed). No-op on a terminal handle.
//   bufferedAmount(handle) -> bytes | -1
//      Payload bytes accepted by the core and not yet handed to transport.
//   poll() -> string | undefined
//   lastError() -> string
//   limits() -> string

export const WS_OP = {
  connect: 1,
  send: 2,
  receiveInto: 3,
  close: 4,
  terminate: 5,
  bufferedAmount: 6,
  poll: 7,
  lastError: 8,
  limits: 9,
} as const;

/** `send` return values. */
export const WS_SEND_ACCEPTED = 0;
export const WS_SEND_ACCEPTED_HIGH_WATER = 1;
export const WS_SEND_CLOSED = -1;
export const WS_SEND_BACKPRESSURE = -2;
export const WS_SEND_INVALID = -3;

/** RFC 6455 opcodes accepted by `send`. */
export const WS_OPCODE = {
  text: 1,
  binary: 2,
  ping: 9,
  pong: 10,
} as const;

// ---------------------------------------------------------------------------
// Events (core -> guest, one JSON array per tick, sequence order)
// ---------------------------------------------------------------------------
//
//   {"t":"open","h":n,"protocol":"telemetry.v1"}
//   {"t":"message","h":n,"kind":"text","text":"…"}
//   {"t":"message","h":n,"kind":"binary","bytes":1234}      -> receiveInto
//   {"t":"ping","h":n,"payload":{"$b":"base64"}}            (already answered)
//   {"t":"pong","h":n,"payload":{"$b":"base64"}}
//   {"t":"drain","h":n}
//   {"t":"error","h":n,"code":"…","message":"…","causeCode":"…","status":403}
//   {"t":"close","h":n,"code":1000,"reason":"","clean":true,"local":false}
//
// Per handle: `error` (before open, terminal) or
// `open → (message | ping | pong | drain)* → [error →] close`; nothing
// follows `close`. Fragmented messages are reassembled natively; oversized
// inbound messages close with 1009, an unqueueable message with 1013,
// protocol violations with 1002, invalid UTF-8 with 1007 — all reported as
// `error{…} → close`.

export const WS_EVENT = {
  open: "open",
  message: "message",
  ping: "ping",
  pong: "pong",
  drain: "drain",
  error: "error",
  close: "close",
} as const;

/** Marker key for a bytes payload inside event JSON (db/fs blob spelling). */
export const WS_BLOB_KEY = "$b";

// ---------------------------------------------------------------------------
// Data contract
// ---------------------------------------------------------------------------

export interface WsConnectMeta {
  url: string;
  protocols?: readonly string[];
  headers?: Record<string, string>;
  timeouts?: { connectMs?: number; closeMs?: number };
  limits?: {
    maxMessageBytes?: number;
    receiveQueueBytes?: number;
    receiveQueueMessages?: number;
    sendQueueBytes?: number;
  };
  tls?: { verification?: "full" | "development-insecure" };
}

export interface WsLimits {
  specMajor: number;
  specMinor: number;
  maxSockets: number;
  maxTlsInflight: number;
  maxMessageBytes: number;
  maxReceiveQueueBytes: number;
  maxReceiveQueueMessages: number;
  maxSendQueueBytes: number;
  sendHighWaterBytes: number;
  sendLowWaterBytes: number;
  maxHandshakeHeaders: number;
  maxHandshakeHeaderBytes: number;
  maxEventsPerTick: number;
  maxTickBytes: number;
  defaultConnectMs: number;
  maxConnectMs: number;
  defaultCloseMs: number;
  tlsMinVersion: string;
  features: readonly string[];
}

/** Request headers the guest may not set; the core owns them. */
export const WS_FORBIDDEN_HEADERS = [
  "host",
  "connection",
  "upgrade",
  "content-length",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
  "sec-websocket-accept",
] as const;

// ---------------------------------------------------------------------------
// Portable limits (ceilings; hosts only tighten)
// ---------------------------------------------------------------------------

/** Sockets alive at once, including handshaking and closing ones. */
export const WS_MAX_SOCKETS = 8;
/** One message, inbound or outbound; fragment reassembly is bounded by it. */
export const WS_MAX_MESSAGE_BYTES = 1024 * 1024;
/** Reassembled, undelivered inbound messages per socket. */
export const WS_MAX_RECEIVE_QUEUE_BYTES = 1024 * 1024;
export const WS_MAX_RECEIVE_QUEUE_MESSAGES = 64;
/** Accepted, unsent outbound payload per socket. */
export const WS_MAX_SEND_QUEUE_BYTES = 1024 * 1024;
/** `send` returns 1 above the high mark; `drain` fires below the low mark. */
export const WS_SEND_HIGH_WATER_BYTES = 256 * 1024;
export const WS_SEND_LOW_WATER_BYTES = 64 * 1024;
export const WS_MAX_HANDSHAKE_HEADERS = 64;
export const WS_MAX_HANDSHAKE_HEADER_BYTES = 16 * 1024;
export const WS_MAX_EVENTS_PER_TICK = 128;
export const WS_MAX_TICK_BYTES = 256 * 1024;
export const WS_DEFAULT_CONNECT_MS = 30_000;
export const WS_MAX_CONNECT_MS = 120_000;
export const WS_DEFAULT_CLOSE_MS = 5_000;
/** RFC 6455 control-frame payload ceiling. */
export const WS_CONTROL_PAYLOAD_MAX = 125;
