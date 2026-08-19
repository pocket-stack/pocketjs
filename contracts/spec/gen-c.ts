// Deterministic codegen: contracts/spec/{net,ws,httpd}.ts ->
// engine/net/include/pocketjs/net/spec.h — the C mirror of the network
// module boundaries consumed by the portable C core (engine/net) and every C
// host that mounts `globalThis.net` / `ws` / `httpd`.
//
// Run from PocketJS/:  bun contracts/spec/gen-c.ts   (or `bun run gen`)
//
// tests/contract.ts imports generateC() and byte-compares its output against
// the committed header, so the generated file can never drift from the spec.
// Keep this generator deterministic (insertion order only, no dates/env).

import {
  HTTPD_DEFAULT_BODY_IDLE_MS,
  HTTPD_DEFAULT_CLOSE_MS,
  HTTPD_DEFAULT_HANDLER_MS,
  HTTPD_DEFAULT_HEADER_MS,
  HTTPD_DEFAULT_KEEP_ALIVE_MS,
  HTTPD_DEFAULT_REQUEST_QUEUE_BYTES,
  HTTPD_EVENT,
  HTTPD_MAX_BACKLOG,
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
  HTTPD_OP,
  HTTPD_SEND_ACCEPTED,
  HTTPD_SEND_BACKPRESSURE,
  HTTPD_SEND_HIGH_WATER_BYTES,
  HTTPD_SEND_INVALID,
  HTTPD_SEND_INVALID_REQUEST,
  HTTPD_SEND_LOW_WATER_BYTES,
  HTTPD_SPEC_MAJOR,
  HTTPD_SPEC_MINOR,
} from "./httpd.ts";
import {
  HTTP_BODYLESS_STATUS,
  HTTP_CORE_OWNED_REQUEST_HEADERS,
  HTTP_NULL_BODY_STATUS,
  HTTP_REDIRECT_ANY_TO_GET_STATUS,
  HTTP_REDIRECT_POST_TO_GET_STATUS,
  HTTP_REDIRECT_STATUS,
  NET_DEFAULT_AGGREGATE_BYTES,
  NET_DEFAULT_QUEUE_BYTES,
  NET_DEFAULT_TIMEOUT_MS,
  NET_ERROR,
  NET_EVENT,
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
  NET_OP,
  NET_SPEC_MAJOR,
  NET_SPEC_MINOR,
  NET_TLS_MIN_VERSION,
} from "./net.ts";
import {
  WS_BLOB_KEY,
  WS_CONTROL_PAYLOAD_MAX,
  WS_DEFAULT_CLOSE_MS,
  WS_DEFAULT_CONNECT_MS,
  WS_EVENT,
  WS_FORBIDDEN_HEADERS,
  WS_MAX_CONNECT_MS,
  WS_MAX_EVENTS_PER_TICK,
  WS_MAX_HANDSHAKE_HEADERS,
  WS_MAX_HANDSHAKE_HEADER_BYTES,
  WS_MAX_MESSAGE_BYTES,
  WS_MAX_RECEIVE_QUEUE_BYTES,
  WS_MAX_RECEIVE_QUEUE_MESSAGES,
  WS_MAX_SEND_QUEUE_BYTES,
  WS_MAX_SOCKETS,
  WS_MAX_TICK_BYTES,
  WS_OP,
  WS_OPCODE,
  WS_SEND_ACCEPTED,
  WS_SEND_ACCEPTED_HIGH_WATER,
  WS_SEND_BACKPRESSURE,
  WS_SEND_CLOSED,
  WS_SEND_HIGH_WATER_BYTES,
  WS_SEND_INVALID,
  WS_SEND_LOW_WATER_BYTES,
  WS_SPEC_MAJOR,
  WS_SPEC_MINOR,
} from "./ws.ts";

/** camelCase -> SCREAMING_SNAKE_CASE. */
function screaming(name: string): string {
  return name.replace(/([A-Z])/g, "_$1").toUpperCase();
}

function cstr(s: string): string {
  return JSON.stringify(s);
}

export function generateC(): string {
  const L: string[] = [];
  const put = (s: string) => L.push(s);

  put("/* GENERATED — do not edit; run `bun contracts/spec/gen-c.ts`. */");
  put("/* C mirror of contracts/spec/{net,ws,httpd}.ts: the guest boundaries of the");
  put(" * network modules (`globalThis.net` / `ws` / `httpd`). Every value here is a");
  put(" * portable ceiling or a wire-visible constant; a host's limits() may only");
  put(" * tighten the ceilings. tests/contract.ts byte-compares this file. */");
  put("#ifndef POCKETJS_NET_SPEC_H");
  put("#define POCKETJS_NET_SPEC_H");
  put("");

  // --- net -------------------------------------------------------------------
  put("/* --- net: HTTP Client (`globalThis.net`) --- */");
  put(`#define PNET_SPEC_MAJOR ${NET_SPEC_MAJOR}`);
  put(`#define PNET_SPEC_MINOR ${NET_SPEC_MINOR}`);
  for (const [name, v] of Object.entries(NET_OP)) {
    put(`#define PNET_OP_${screaming(name)} ${v}`);
  }
  put(`#define PNET_MAX_INFLIGHT ${NET_MAX_INFLIGHT}`);
  put(`#define PNET_MAX_REQUEST_BYTES ${NET_MAX_REQUEST_BYTES}`);
  put(`#define PNET_DEFAULT_QUEUE_BYTES ${NET_DEFAULT_QUEUE_BYTES}`);
  put(`#define PNET_MAX_QUEUE_BYTES ${NET_MAX_QUEUE_BYTES}`);
  put(`#define PNET_DEFAULT_AGGREGATE_BYTES ${NET_DEFAULT_AGGREGATE_BYTES}`);
  put(`#define PNET_MAX_AGGREGATE_BYTES ${NET_MAX_AGGREGATE_BYTES}`);
  put(`#define PNET_MAX_EVENTS_PER_TICK ${NET_MAX_EVENTS_PER_TICK}`);
  put(`#define PNET_MAX_TICK_BYTES ${NET_MAX_TICK_BYTES}`);
  put(`#define PNET_MAX_HEADERS ${NET_MAX_HEADERS}`);
  put(`#define PNET_MAX_HEADER_BYTES ${NET_MAX_HEADER_BYTES}`);
  put(`#define PNET_DEFAULT_TIMEOUT_MS ${NET_DEFAULT_TIMEOUT_MS}`);
  put(`#define PNET_MAX_TIMEOUT_MS ${NET_MAX_TIMEOUT_MS}`);
  put(`#define PNET_MAX_REDIRECTS ${NET_MAX_REDIRECTS}`);
  put(`#define PNET_TLS_MIN_VERSION ${cstr(NET_TLS_MIN_VERSION)}`);
  put(`#define PNET_METHODS_FORBIDDEN_COUNT ${NET_METHODS_FORBIDDEN.length}`);
  put(
    `#define PNET_METHODS_FORBIDDEN { ${NET_METHODS_FORBIDDEN.map(cstr).join(", ")} }`,
  );
  put("/* HTTP semantics shared by client, server and SDK (see net.ts). */");
  put(`#define PNET_HTTP_CORE_OWNED_REQUEST_HEADERS_COUNT ${HTTP_CORE_OWNED_REQUEST_HEADERS.length}`);
  put(`#define PNET_HTTP_CORE_OWNED_REQUEST_HEADERS { ${HTTP_CORE_OWNED_REQUEST_HEADERS.map(cstr).join(", ")} }`);
  put(`#define PNET_HTTP_BODYLESS_STATUS_COUNT ${HTTP_BODYLESS_STATUS.length}`);
  put(`#define PNET_HTTP_BODYLESS_STATUS { ${HTTP_BODYLESS_STATUS.join(", ")} }`);
  put(`#define PNET_HTTP_NULL_BODY_STATUS_COUNT ${HTTP_NULL_BODY_STATUS.length}`);
  put(`#define PNET_HTTP_NULL_BODY_STATUS { ${HTTP_NULL_BODY_STATUS.join(", ")} }`);
  put(`#define PNET_HTTP_REDIRECT_STATUS_COUNT ${HTTP_REDIRECT_STATUS.length}`);
  put(`#define PNET_HTTP_REDIRECT_STATUS { ${HTTP_REDIRECT_STATUS.join(", ")} }`);
  put(`#define PNET_HTTP_REDIRECT_POST_TO_GET_STATUS_COUNT ${HTTP_REDIRECT_POST_TO_GET_STATUS.length}`);
  put(`#define PNET_HTTP_REDIRECT_POST_TO_GET_STATUS { ${HTTP_REDIRECT_POST_TO_GET_STATUS.join(", ")} }`);
  put(`#define PNET_HTTP_REDIRECT_ANY_TO_GET_STATUS_COUNT ${HTTP_REDIRECT_ANY_TO_GET_STATUS.length}`);
  put(`#define PNET_HTTP_REDIRECT_ANY_TO_GET_STATUS { ${HTTP_REDIRECT_ANY_TO_GET_STATUS.join(", ")} }`);
  for (const [name, v] of Object.entries(NET_EVENT)) {
    put(`#define PNET_EVENT_${screaming(name)} ${cstr(v)}`);
  }
  put("/* Error vocabulary shared by net, ws and httpd. */");
  for (const [name, v] of Object.entries(NET_ERROR)) {
    put(`#define PNET_ERROR_${screaming(name)} ${cstr(v)}`);
  }
  put("");

  // --- ws --------------------------------------------------------------------
  put("/* --- ws: WebSocket Client (`globalThis.ws`) --- */");
  put(`#define PWS_SPEC_MAJOR ${WS_SPEC_MAJOR}`);
  put(`#define PWS_SPEC_MINOR ${WS_SPEC_MINOR}`);
  for (const [name, v] of Object.entries(WS_OP)) {
    put(`#define PWS_OP_${screaming(name)} ${v}`);
  }
  put(`#define PWS_SEND_ACCEPTED ${WS_SEND_ACCEPTED}`);
  put(`#define PWS_SEND_ACCEPTED_HIGH_WATER ${WS_SEND_ACCEPTED_HIGH_WATER}`);
  put(`#define PWS_SEND_CLOSED (${WS_SEND_CLOSED})`);
  put(`#define PWS_SEND_BACKPRESSURE (${WS_SEND_BACKPRESSURE})`);
  put(`#define PWS_SEND_INVALID (${WS_SEND_INVALID})`);
  for (const [name, v] of Object.entries(WS_OPCODE)) {
    put(`#define PWS_OPCODE_${screaming(name)} ${v}`);
  }
  for (const [name, v] of Object.entries(WS_EVENT)) {
    put(`#define PWS_EVENT_${screaming(name)} ${cstr(v)}`);
  }
  put(`#define PWS_BLOB_KEY ${cstr(WS_BLOB_KEY)}`);
  put(`#define PWS_FORBIDDEN_HEADERS_COUNT ${WS_FORBIDDEN_HEADERS.length}`);
  put(`#define PWS_FORBIDDEN_HEADERS { ${WS_FORBIDDEN_HEADERS.map(cstr).join(", ")} }`);
  put(`#define PWS_MAX_SOCKETS ${WS_MAX_SOCKETS}`);
  put(`#define PWS_MAX_MESSAGE_BYTES ${WS_MAX_MESSAGE_BYTES}`);
  put(`#define PWS_MAX_RECEIVE_QUEUE_BYTES ${WS_MAX_RECEIVE_QUEUE_BYTES}`);
  put(`#define PWS_MAX_RECEIVE_QUEUE_MESSAGES ${WS_MAX_RECEIVE_QUEUE_MESSAGES}`);
  put(`#define PWS_MAX_SEND_QUEUE_BYTES ${WS_MAX_SEND_QUEUE_BYTES}`);
  put(`#define PWS_SEND_HIGH_WATER_BYTES ${WS_SEND_HIGH_WATER_BYTES}`);
  put(`#define PWS_SEND_LOW_WATER_BYTES ${WS_SEND_LOW_WATER_BYTES}`);
  put(`#define PWS_MAX_HANDSHAKE_HEADERS ${WS_MAX_HANDSHAKE_HEADERS}`);
  put(`#define PWS_MAX_HANDSHAKE_HEADER_BYTES ${WS_MAX_HANDSHAKE_HEADER_BYTES}`);
  put(`#define PWS_MAX_EVENTS_PER_TICK ${WS_MAX_EVENTS_PER_TICK}`);
  put(`#define PWS_MAX_TICK_BYTES ${WS_MAX_TICK_BYTES}`);
  put(`#define PWS_DEFAULT_CONNECT_MS ${WS_DEFAULT_CONNECT_MS}`);
  put(`#define PWS_MAX_CONNECT_MS ${WS_MAX_CONNECT_MS}`);
  put(`#define PWS_DEFAULT_CLOSE_MS ${WS_DEFAULT_CLOSE_MS}`);
  put(`#define PWS_CONTROL_PAYLOAD_MAX ${WS_CONTROL_PAYLOAD_MAX}`);
  put("");

  // --- httpd -----------------------------------------------------------------
  put("/* --- httpd: HTTP Server (`globalThis.httpd`) --- */");
  put(`#define PHTTPD_SPEC_MAJOR ${HTTPD_SPEC_MAJOR}`);
  put(`#define PHTTPD_SPEC_MINOR ${HTTPD_SPEC_MINOR}`);
  for (const [name, v] of Object.entries(HTTPD_OP)) {
    put(`#define PHTTPD_OP_${screaming(name)} ${v}`);
  }
  put(`#define PHTTPD_SEND_ACCEPTED ${HTTPD_SEND_ACCEPTED}`);
  put(`#define PHTTPD_SEND_INVALID_REQUEST (${HTTPD_SEND_INVALID_REQUEST})`);
  put(`#define PHTTPD_SEND_BACKPRESSURE (${HTTPD_SEND_BACKPRESSURE})`);
  put(`#define PHTTPD_SEND_INVALID (${HTTPD_SEND_INVALID})`);
  for (const [name, v] of Object.entries(HTTPD_EVENT)) {
    put(`#define PHTTPD_EVENT_${screaming(name)} ${cstr(v)}`);
  }
  put(`#define PHTTPD_MAX_SERVERS ${HTTPD_MAX_SERVERS}`);
  put(`#define PHTTPD_MAX_CONNECTIONS ${HTTPD_MAX_CONNECTIONS}`);
  put(`#define PHTTPD_MAX_INFLIGHT ${HTTPD_MAX_INFLIGHT}`);
  put(`#define PHTTPD_MAX_BACKLOG ${HTTPD_MAX_BACKLOG}`);
  put(`#define PHTTPD_MAX_HEADERS ${HTTPD_MAX_HEADERS}`);
  put(`#define PHTTPD_MAX_HEADER_BYTES ${HTTPD_MAX_HEADER_BYTES}`);
  put(`#define PHTTPD_MAX_TARGET_BYTES ${HTTPD_MAX_TARGET_BYTES}`);
  put(`#define PHTTPD_DEFAULT_REQUEST_QUEUE_BYTES ${HTTPD_DEFAULT_REQUEST_QUEUE_BYTES}`);
  put(`#define PHTTPD_MAX_REQUEST_QUEUE_BYTES ${HTTPD_MAX_REQUEST_QUEUE_BYTES}`);
  put(`#define PHTTPD_MAX_SEND_QUEUE_BYTES ${HTTPD_MAX_SEND_QUEUE_BYTES}`);
  put(`#define PHTTPD_SEND_HIGH_WATER_BYTES ${HTTPD_SEND_HIGH_WATER_BYTES}`);
  put(`#define PHTTPD_SEND_LOW_WATER_BYTES ${HTTPD_SEND_LOW_WATER_BYTES}`);
  put(`#define PHTTPD_MAX_EVENTS_PER_TICK ${HTTPD_MAX_EVENTS_PER_TICK}`);
  put(`#define PHTTPD_MAX_TICK_BYTES ${HTTPD_MAX_TICK_BYTES}`);
  put(`#define PHTTPD_DEFAULT_HEADER_MS ${HTTPD_DEFAULT_HEADER_MS}`);
  put(`#define PHTTPD_DEFAULT_BODY_IDLE_MS ${HTTPD_DEFAULT_BODY_IDLE_MS}`);
  put(`#define PHTTPD_DEFAULT_HANDLER_MS ${HTTPD_DEFAULT_HANDLER_MS}`);
  put(`#define PHTTPD_DEFAULT_KEEP_ALIVE_MS ${HTTPD_DEFAULT_KEEP_ALIVE_MS}`);
  put(`#define PHTTPD_DEFAULT_CLOSE_MS ${HTTPD_DEFAULT_CLOSE_MS}`);
  put(`#define PHTTPD_MAX_TIMEOUT_MS ${HTTPD_MAX_TIMEOUT_MS}`);
  put("");
  put("#endif /* POCKETJS_NET_SPEC_H */");

  return L.join("\n") + "\n";
}

if (import.meta.main) {
  const out = new URL("../../engine/net/include/pocketjs/net/spec.h", import.meta.url).pathname;
  await Bun.write(out, generateC());
  console.log(`wrote ${out}`);
}
