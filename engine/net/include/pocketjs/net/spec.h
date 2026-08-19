/* GENERATED — do not edit; run `bun contracts/spec/gen-c.ts`. */
/* C mirror of contracts/spec/{net,ws,httpd}.ts: the guest boundaries of the
 * network modules (`globalThis.net` / `ws` / `httpd`). Every value here is a
 * portable ceiling or a wire-visible constant; a host's limits() may only
 * tighten the ceilings. tests/contract.ts byte-compares this file. */
#ifndef POCKETJS_NET_SPEC_H
#define POCKETJS_NET_SPEC_H

/* --- net: HTTP Client (`globalThis.net`) --- */
#define PNET_SPEC_MAJOR 2
#define PNET_SPEC_MINOR 0
#define PNET_OP_START 1
#define PNET_OP_TAKE 2
#define PNET_OP_CANCEL 3
#define PNET_OP_POLL 4
#define PNET_OP_LAST_ERROR 5
#define PNET_OP_READ_INTO 6
#define PNET_OP_LIMITS 7
#define PNET_OP_WRITE 8
#define PNET_OP_END_BODY 9
#define PNET_MAX_INFLIGHT 8
#define PNET_MAX_REQUEST_BYTES 262144
#define PNET_DEFAULT_QUEUE_BYTES 32768
#define PNET_MAX_QUEUE_BYTES 262144
#define PNET_DEFAULT_AGGREGATE_BYTES 1048576
#define PNET_MAX_AGGREGATE_BYTES 8388608
#define PNET_MAX_EVENTS_PER_TICK 128
#define PNET_MAX_TICK_BYTES 262144
#define PNET_MAX_HEADERS 64
#define PNET_MAX_HEADER_BYTES 16384
#define PNET_DEFAULT_TIMEOUT_MS 30000
#define PNET_MAX_TIMEOUT_MS 120000
#define PNET_MAX_REDIRECTS 5
#define PNET_TLS_MIN_VERSION "1.2"
#define PNET_METHODS_FORBIDDEN_COUNT 3
#define PNET_METHODS_FORBIDDEN { "CONNECT", "TRACE", "TRACK" }
/* HTTP semantics shared by client, server and SDK (see net.ts). */
#define PNET_HTTP_CORE_OWNED_REQUEST_HEADERS_COUNT 10
#define PNET_HTTP_CORE_OWNED_REQUEST_HEADERS { "host", "connection", "content-length", "transfer-encoding", "trailer", "te", "upgrade", "keep-alive", "expect", "proxy-connection" }
#define PNET_HTTP_BODYLESS_STATUS_COUNT 2
#define PNET_HTTP_BODYLESS_STATUS { 204, 304 }
#define PNET_HTTP_NULL_BODY_STATUS_COUNT 5
#define PNET_HTTP_NULL_BODY_STATUS { 101, 103, 204, 205, 304 }
#define PNET_HTTP_REDIRECT_STATUS_COUNT 5
#define PNET_HTTP_REDIRECT_STATUS { 301, 302, 303, 307, 308 }
#define PNET_HTTP_REDIRECT_POST_TO_GET_STATUS_COUNT 2
#define PNET_HTTP_REDIRECT_POST_TO_GET_STATUS { 301, 302 }
#define PNET_HTTP_REDIRECT_ANY_TO_GET_STATUS_COUNT 1
#define PNET_HTTP_REDIRECT_ANY_TO_GET_STATUS { 303 }
#define PNET_EVENT_HEADERS "headers"
#define PNET_EVENT_READABLE "readable"
#define PNET_EVENT_END "end"
#define PNET_EVENT_ERROR "error"
#define PNET_EVENT_DRAIN "drain"
/* Error vocabulary shared by net, ws and httpd. */
#define PNET_ERROR_INVALID_REQUEST "invalid_request"
#define PNET_ERROR_INVALID_STATE "invalid_state"
#define PNET_ERROR_UNSUPPORTED "unsupported"
#define PNET_ERROR_PERMISSION_DENIED "permission_denied"
#define PNET_ERROR_BUSY "busy"
#define PNET_ERROR_RESOURCE_LIMIT "resource_limit"
#define PNET_ERROR_DNS "dns"
#define PNET_ERROR_CONNECT "connect"
#define PNET_ERROR_ADDRESS_IN_USE "address_in_use"
#define PNET_ERROR_CLOSED "closed"
#define PNET_ERROR_TIMEOUT "timeout"
#define PNET_ERROR_TLS_CERTIFICATE_INVALID "tls_certificate_invalid"
#define PNET_ERROR_TLS_HOSTNAME_MISMATCH "tls_hostname_mismatch"
#define PNET_ERROR_TLS_HANDSHAKE_FAILED "tls_handshake_failed"
#define PNET_ERROR_TLS_CLOCK_UNTRUSTED "tls_clock_untrusted"
#define PNET_ERROR_REDIRECT "redirect"
#define PNET_ERROR_RESPONSE_TOO_LARGE "response_too_large"
#define PNET_ERROR_PROTOCOL "protocol"
#define PNET_ERROR_WEBSOCKET_HANDSHAKE_FAILED "websocket_handshake_failed"
#define PNET_ERROR_WEBSOCKET_PROTOCOL_ERROR "websocket_protocol_error"
#define PNET_ERROR_MESSAGE_TOO_LARGE "message_too_large"
#define PNET_ERROR_CANCELLED "cancelled"
#define PNET_ERROR_OTHER "other"
#define PNET_ERROR_UNAVAILABLE "unavailable"

/* --- ws: WebSocket Client (`globalThis.ws`) --- */
#define PWS_SPEC_MAJOR 2
#define PWS_SPEC_MINOR 0
#define PWS_OP_CONNECT 1
#define PWS_OP_SEND 2
#define PWS_OP_RECEIVE_INTO 3
#define PWS_OP_CLOSE 4
#define PWS_OP_TERMINATE 5
#define PWS_OP_BUFFERED_AMOUNT 6
#define PWS_OP_POLL 7
#define PWS_OP_LAST_ERROR 8
#define PWS_OP_LIMITS 9
#define PWS_SEND_ACCEPTED 0
#define PWS_SEND_ACCEPTED_HIGH_WATER 1
#define PWS_SEND_CLOSED (-1)
#define PWS_SEND_BACKPRESSURE (-2)
#define PWS_SEND_INVALID (-3)
#define PWS_OPCODE_TEXT 1
#define PWS_OPCODE_BINARY 2
#define PWS_OPCODE_PING 9
#define PWS_OPCODE_PONG 10
#define PWS_EVENT_OPEN "open"
#define PWS_EVENT_MESSAGE "message"
#define PWS_EVENT_PING "ping"
#define PWS_EVENT_PONG "pong"
#define PWS_EVENT_DRAIN "drain"
#define PWS_EVENT_ERROR "error"
#define PWS_EVENT_CLOSE "close"
#define PWS_BLOB_KEY "$b"
#define PWS_FORBIDDEN_HEADERS_COUNT 9
#define PWS_FORBIDDEN_HEADERS { "host", "connection", "upgrade", "content-length", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions", "sec-websocket-accept" }
#define PWS_MAX_SOCKETS 8
#define PWS_MAX_MESSAGE_BYTES 1048576
#define PWS_MAX_RECEIVE_QUEUE_BYTES 1048576
#define PWS_MAX_RECEIVE_QUEUE_MESSAGES 64
#define PWS_MAX_SEND_QUEUE_BYTES 1048576
#define PWS_SEND_HIGH_WATER_BYTES 262144
#define PWS_SEND_LOW_WATER_BYTES 65536
#define PWS_MAX_HANDSHAKE_HEADERS 64
#define PWS_MAX_HANDSHAKE_HEADER_BYTES 16384
#define PWS_MAX_EVENTS_PER_TICK 128
#define PWS_MAX_TICK_BYTES 262144
#define PWS_DEFAULT_CONNECT_MS 30000
#define PWS_MAX_CONNECT_MS 120000
#define PWS_DEFAULT_CLOSE_MS 5000
#define PWS_CONTROL_PAYLOAD_MAX 125

/* --- httpd: HTTP Server (`globalThis.httpd`) --- */
#define PHTTPD_SPEC_MAJOR 2
#define PHTTPD_SPEC_MINOR 0
#define PHTTPD_OP_LISTEN 1
#define PHTTPD_OP_STOP 2
#define PHTTPD_OP_RESPOND 3
#define PHTTPD_OP_WRITE 4
#define PHTTPD_OP_END_BODY 5
#define PHTTPD_OP_READ_INTO 6
#define PHTTPD_OP_ABORT 7
#define PHTTPD_OP_POLL 8
#define PHTTPD_OP_LAST_ERROR 9
#define PHTTPD_OP_LIMITS 10
#define PHTTPD_SEND_ACCEPTED 0
#define PHTTPD_SEND_INVALID_REQUEST (-1)
#define PHTTPD_SEND_BACKPRESSURE (-2)
#define PHTTPD_SEND_INVALID (-3)
#define PHTTPD_EVENT_LISTENING "listening"
#define PHTTPD_EVENT_CLOSED "closed"
#define PHTTPD_EVENT_ERROR "error"
#define PHTTPD_EVENT_REQUEST "request"
#define PHTTPD_EVENT_READABLE "readable"
#define PHTTPD_EVENT_END "end"
#define PHTTPD_EVENT_DRAIN "drain"
#define PHTTPD_EVENT_ABORTED "aborted"
#define PHTTPD_MAX_SERVERS 2
#define PHTTPD_MAX_CONNECTIONS 16
#define PHTTPD_MAX_INFLIGHT 8
#define PHTTPD_MAX_BACKLOG 16
#define PHTTPD_MAX_HEADERS 64
#define PHTTPD_MAX_HEADER_BYTES 16384
#define PHTTPD_MAX_TARGET_BYTES 2048
#define PHTTPD_DEFAULT_REQUEST_QUEUE_BYTES 32768
#define PHTTPD_MAX_REQUEST_QUEUE_BYTES 262144
#define PHTTPD_MAX_SEND_QUEUE_BYTES 262144
#define PHTTPD_SEND_HIGH_WATER_BYTES 131072
#define PHTTPD_SEND_LOW_WATER_BYTES 32768
#define PHTTPD_MAX_EVENTS_PER_TICK 128
#define PHTTPD_MAX_TICK_BYTES 262144
#define PHTTPD_DEFAULT_HEADER_MS 10000
#define PHTTPD_DEFAULT_BODY_IDLE_MS 30000
#define PHTTPD_DEFAULT_HANDLER_MS 30000
#define PHTTPD_DEFAULT_KEEP_ALIVE_MS 15000
#define PHTTPD_DEFAULT_CLOSE_MS 5000
#define PHTTPD_MAX_TIMEOUT_MS 120000

#endif /* POCKETJS_NET_SPEC_H */
