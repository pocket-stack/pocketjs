/* PocketJS network core — runtime and module ops.
 *
 * One `pnet_runtime` holds the Shared Async Runtime (handle tables, timers,
 * per-module event queues, tick budgets, the immutable policy) and the three
 * protocol cores behind the spec-pinned namespaces:
 *
 *   net    HTTP Client   contracts/spec/net.ts    pnet_http_*
 *   httpd  HTTP Server   contracts/spec/httpd.ts  pnet_httpd_*
 *   ws     WebSocket     contracts/spec/ws.ts     pnet_ws_*
 *
 * Two call sites (both serialized by the host, see platform.h):
 *
 *   network side   pnet_runtime_service() after the reactor wakes,
 *                  pnet_runtime_next_deadline_ms() for its timeout,
 *                  pnet_runtime_resolve_done() from the resolver;
 *   guest side     pnet_runtime_begin_tick() right before `frame()`,
 *                  then the module ops the guest binding forwards
 *                  (start/poll/readInto/... — synchronous, no I/O).
 *
 * Nothing here calls back into the guest. Completions become visible only at
 * begin_tick(); poll() returns the visible batch as JSON; payload bytes cross
 * only through the *_read_into / *_receive_into copies.
 */
#ifndef POCKETJS_NET_RUNTIME_H
#define POCKETJS_NET_RUNTIME_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "pocketjs/net/driver.h"
#include "pocketjs/net/platform.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct pnet_runtime pnet_runtime;

/** Host-tightened limits. Zero keeps the spec ceiling
 * (engine/net/include/pocketjs/net/spec.h); values above the ceiling are
 * clamped to it. */
typedef struct pnet_runtime_config {
  /** Total bytes the core may hold (queues, parser buffers, event JSON). */
  size_t max_heap_bytes;
  /* --- net --- */
  uint32_t http_max_inflight;
  size_t http_max_request_bytes;
  size_t http_default_queue_bytes;
  size_t http_max_queue_bytes;
  size_t http_default_aggregate_bytes;
  size_t http_max_aggregate_bytes;
  uint32_t http_max_events_per_tick;
  size_t http_max_tick_bytes;
  uint32_t http_max_headers;
  size_t http_max_header_bytes;
  uint32_t http_default_timeout_ms;
  uint32_t http_max_timeout_ms;
  uint32_t http_max_redirects;
  /* --- ws --- */
  uint32_t ws_max_sockets;
  size_t ws_max_message_bytes;
  size_t ws_max_receive_queue_bytes;
  uint32_t ws_max_receive_queue_messages;
  size_t ws_max_send_queue_bytes;
  size_t ws_send_high_water_bytes;
  size_t ws_send_low_water_bytes;
  uint32_t ws_max_events_per_tick;
  size_t ws_max_tick_bytes;
  uint32_t ws_default_connect_ms;
  uint32_t ws_max_connect_ms;
  uint32_t ws_default_close_ms;
  /* --- httpd --- */
  uint32_t httpd_max_servers;
  uint32_t httpd_max_connections;
  uint32_t httpd_max_inflight;
  size_t httpd_max_header_bytes;
  uint32_t httpd_max_headers;
  size_t httpd_max_target_bytes;
  size_t httpd_default_request_queue_bytes;
  size_t httpd_max_request_queue_bytes;
  size_t httpd_max_send_queue_bytes;
  size_t httpd_send_high_water_bytes;
  size_t httpd_send_low_water_bytes;
  uint32_t httpd_max_events_per_tick;
  size_t httpd_max_tick_bytes;
  /** Bytes read from a socket per read() call (also the segment size). */
  size_t io_chunk_bytes;
  /** Development build flag: enables `tls.verification = "development-insecure"`
   * when the policy also allows it. Never set in production. */
  bool development_build;
} pnet_runtime_config;

/** Fill `cfg` with the spec ceilings. */
void pnet_runtime_config_defaults(pnet_runtime_config *cfg);

/** Create a runtime. `policy_json` is the immutable Build Plan projection:
 *   { "connect": [{"protocol":"http","host":"example.com","port":80}],
 *     "listen":  [{"protocol":"http","address":"0.0.0.0","port":8080}],
 *     "credentials": [], "insecureTransport": true, "localNetwork": true,
 *     "allowInvalidTlsForDevelopment": false }
 * Returns NULL on invalid input or allocation failure. */
pnet_runtime *pnet_runtime_create(const pnet_platform *platform,
                                  const pnet_driver_ops *driver, void *driver_ctx,
                                  const pnet_runtime_config *config,
                                  const char *policy_json);

/** Same, with a TlsProvider. When `tls` is non-NULL the host advertises the
 * "tls" feature for the HTTP and WebSocket client roles, https:/wss: URLs
 * are accepted, and every handshake runs under the core's connect deadline. */
pnet_runtime *pnet_runtime_create_tls(const pnet_platform *platform,
                                      const pnet_driver_ops *driver, void *driver_ctx,
                                      const pnet_tls_ops *tls, void *tls_ctx,
                                      const pnet_runtime_config *config,
                                      const char *policy_json);
void pnet_runtime_destroy(pnet_runtime *rt);

/* ------------------------------------------------------------------------ */
/* Network side                                                              */
/* ------------------------------------------------------------------------ */

/** Run every state machine: accept, connect progress, reads, writes,
 * timers. Call after the reactor wakes (readable/writable/timeout/command). */
void pnet_runtime_service(pnet_runtime *rt);
/** Absolute monotonic deadline of the nearest timer, or 0 when none. */
uint64_t pnet_runtime_next_deadline_ms(pnet_runtime *rt);
/** True when some socket has bytes queued for writing (the host may want to
 * service() again before waiting). */
bool pnet_runtime_has_pending_output(pnet_runtime *rt);
/** Resolver completion. `err` 0 with `count` addresses, else a PNET_IO_* code. */
void pnet_runtime_resolve_done(pnet_runtime *rt, uint32_t req_id, const pnet_addr *addrs,
                               size_t count, int err);
/** Quiesce: refuse new
 * operations, cancel every live one; terminal events still arrive at
 * subsequent ticks. */
void pnet_runtime_quiesce(pnet_runtime *rt);

/* ------------------------------------------------------------------------ */
/* Guest side (owner thread)                                                 */
/* ------------------------------------------------------------------------ */

/** Tick boundary: freeze readable watermarks and move completed events into
 * the visible sets of every module. Call before every `frame()`. */
void pnet_runtime_begin_tick(pnet_runtime *rt);

/** Bytes currently held (for resource reports). */
size_t pnet_runtime_heap_bytes(pnet_runtime *rt);
/** True while any module has a live handle (the host may skip the guest
 * pump registration otherwise; the SDK does its own bookkeeping too). */
bool pnet_runtime_has_live_handles(pnet_runtime *rt);

/* --- net: HTTP Client (spec.h PNET_OP_*) --------------------------------- */

int pnet_http_start(pnet_runtime *rt, const char *meta_json, const uint8_t *body, size_t body_len);
void pnet_http_cancel(pnet_runtime *rt, int handle);
/** The visible batch as one JSON array, or NULL (nothing visible, or the
 * batch could not be allocated — then nothing is consumed and the next poll
 * retries). The string stays valid until the next poll / render / destroy.
 * Transactional: events leave the visible set only after the batch text
 * exists; resource exhaustion can delay a batch, never drop one. */
const char *pnet_http_poll(pnet_runtime *rt, size_t *len);
/** Two-phase poll for hosts that marshal the batch into a guest value:
 * `render` returns the batch without consuming it (calling it again returns
 * the same text); `consume` releases it once the guest holds a copy. A host
 * whose marshalling failed simply does not consume — the batch is rendered
 * again next tick. pnet_http_poll = render + consume. */
const char *pnet_http_poll_render(pnet_runtime *rt, size_t *len);
void pnet_http_poll_consume(pnet_runtime *rt);
const char *pnet_http_last_error(pnet_runtime *rt);
int pnet_http_read_into(pnet_runtime *rt, int handle, uint8_t *dst, size_t len);
const char *pnet_http_limits(pnet_runtime *rt);

/* --- ws: WebSocket Client (spec.h PWS_OP_*) ------------------------------ */

int pnet_ws_connect(pnet_runtime *rt, const char *meta_json);
int pnet_ws_send(pnet_runtime *rt, int handle, int opcode, const uint8_t *payload, size_t len);
int pnet_ws_receive_into(pnet_runtime *rt, int handle, uint8_t *dst, size_t len);
/** code 0 = omitted; reason NULL or UTF-8 <= 123 bytes. */
int pnet_ws_close(pnet_runtime *rt, int handle, int code, const char *reason, size_t reason_len);
void pnet_ws_terminate(pnet_runtime *rt, int handle);
int pnet_ws_buffered_amount(pnet_runtime *rt, int handle);
const char *pnet_ws_poll(pnet_runtime *rt, size_t *len);
const char *pnet_ws_poll_render(pnet_runtime *rt, size_t *len);
void pnet_ws_poll_consume(pnet_runtime *rt);
const char *pnet_ws_last_error(pnet_runtime *rt);
const char *pnet_ws_limits(pnet_runtime *rt);

/* --- httpd: HTTP Server (spec.h PHTTPD_OP_*) ----------------------------- */

int pnet_httpd_listen(pnet_runtime *rt, const char *meta_json);
int pnet_httpd_stop(pnet_runtime *rt, int handle, bool graceful, uint32_t timeout_ms);
int pnet_httpd_respond(pnet_runtime *rt, int req, const char *meta_json, const uint8_t *body, size_t body_len);
int pnet_httpd_write(pnet_runtime *rt, int req, const uint8_t *chunk, size_t len);
int pnet_httpd_end_body(pnet_runtime *rt, int req);
int pnet_httpd_read_into(pnet_runtime *rt, int req, uint8_t *dst, size_t len);
void pnet_httpd_abort(pnet_runtime *rt, int req);
const char *pnet_httpd_poll(pnet_runtime *rt, size_t *len);
const char *pnet_httpd_poll_render(pnet_runtime *rt, size_t *len);
void pnet_httpd_poll_consume(pnet_runtime *rt);
const char *pnet_httpd_last_error(pnet_runtime *rt);
const char *pnet_httpd_limits(pnet_runtime *rt);

#ifdef __cplusplus
}
#endif

#endif /* POCKETJS_NET_RUNTIME_H */
