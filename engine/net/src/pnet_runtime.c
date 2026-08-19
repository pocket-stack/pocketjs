/* Shared Async Runtime: creation, policy, tick queues, connection and dialer
 * helpers, service dispatch and the tick boundary. Protocol behaviour lives
 * in pnet_http_client.c, pnet_http_server.c and pnet_ws.c. */
#include <stdio.h>

#include "pnet_internal.h"

/* ------------------------------------------------------------------------ */
/* Config                                                                    */
/* ------------------------------------------------------------------------ */

void pnet_runtime_config_defaults(pnet_runtime_config *cfg) {
  memset(cfg, 0, sizeof *cfg);
  cfg->max_heap_bytes = 0;
  cfg->http_max_inflight = PNET_MAX_INFLIGHT;
  cfg->http_max_request_bytes = PNET_MAX_REQUEST_BYTES;
  cfg->http_default_queue_bytes = PNET_DEFAULT_QUEUE_BYTES;
  cfg->http_max_queue_bytes = PNET_MAX_QUEUE_BYTES;
  cfg->http_default_aggregate_bytes = PNET_DEFAULT_AGGREGATE_BYTES;
  cfg->http_max_aggregate_bytes = PNET_MAX_AGGREGATE_BYTES;
  cfg->http_max_events_per_tick = PNET_MAX_EVENTS_PER_TICK;
  cfg->http_max_tick_bytes = PNET_MAX_TICK_BYTES;
  cfg->http_max_headers = PNET_MAX_HEADERS;
  cfg->http_max_header_bytes = PNET_MAX_HEADER_BYTES;
  cfg->http_default_timeout_ms = PNET_DEFAULT_TIMEOUT_MS;
  cfg->http_max_timeout_ms = PNET_MAX_TIMEOUT_MS;
  cfg->http_max_redirects = PNET_MAX_REDIRECTS;
  cfg->ws_max_sockets = PWS_MAX_SOCKETS;
  cfg->ws_max_message_bytes = PWS_MAX_MESSAGE_BYTES;
  cfg->ws_max_receive_queue_bytes = PWS_MAX_RECEIVE_QUEUE_BYTES;
  cfg->ws_max_receive_queue_messages = PWS_MAX_RECEIVE_QUEUE_MESSAGES;
  cfg->ws_max_send_queue_bytes = PWS_MAX_SEND_QUEUE_BYTES;
  cfg->ws_send_high_water_bytes = PWS_SEND_HIGH_WATER_BYTES;
  cfg->ws_send_low_water_bytes = PWS_SEND_LOW_WATER_BYTES;
  cfg->ws_max_events_per_tick = PWS_MAX_EVENTS_PER_TICK;
  cfg->ws_max_tick_bytes = PWS_MAX_TICK_BYTES;
  cfg->ws_default_connect_ms = PWS_DEFAULT_CONNECT_MS;
  cfg->ws_max_connect_ms = PWS_MAX_CONNECT_MS;
  cfg->ws_default_close_ms = PWS_DEFAULT_CLOSE_MS;
  cfg->httpd_max_servers = PHTTPD_MAX_SERVERS;
  cfg->httpd_max_connections = PHTTPD_MAX_CONNECTIONS;
  cfg->httpd_max_inflight = PHTTPD_MAX_INFLIGHT;
  cfg->httpd_max_header_bytes = PHTTPD_MAX_HEADER_BYTES;
  cfg->httpd_max_headers = PHTTPD_MAX_HEADERS;
  cfg->httpd_max_target_bytes = PHTTPD_MAX_TARGET_BYTES;
  cfg->httpd_default_request_queue_bytes = PHTTPD_DEFAULT_REQUEST_QUEUE_BYTES;
  cfg->httpd_max_request_queue_bytes = PHTTPD_MAX_REQUEST_QUEUE_BYTES;
  cfg->httpd_max_send_queue_bytes = PHTTPD_MAX_SEND_QUEUE_BYTES;
  cfg->httpd_send_high_water_bytes = PHTTPD_SEND_HIGH_WATER_BYTES;
  cfg->httpd_send_low_water_bytes = PHTTPD_SEND_LOW_WATER_BYTES;
  cfg->httpd_max_events_per_tick = PHTTPD_MAX_EVENTS_PER_TICK;
  cfg->httpd_max_tick_bytes = PHTTPD_MAX_TICK_BYTES;
  cfg->io_chunk_bytes = 2048;
  cfg->development_build = false;
}

#define CLAMP_U32(field, ceiling) \
  do { if (cfg->field == 0 || cfg->field > (ceiling)) cfg->field = (ceiling); } while (0)
#define CLAMP_SZ(field, ceiling) \
  do { if (cfg->field == 0 || cfg->field > (ceiling)) cfg->field = (ceiling); } while (0)

static void clamp_config(pnet_runtime_config *cfg) {
  CLAMP_U32(http_max_inflight, PNET_MAX_INFLIGHT);
  CLAMP_SZ(http_max_request_bytes, PNET_MAX_REQUEST_BYTES);
  CLAMP_SZ(http_max_queue_bytes, PNET_MAX_QUEUE_BYTES);
  CLAMP_SZ(http_default_queue_bytes, cfg->http_max_queue_bytes);
  CLAMP_SZ(http_max_aggregate_bytes, PNET_MAX_AGGREGATE_BYTES);
  CLAMP_SZ(http_default_aggregate_bytes, cfg->http_max_aggregate_bytes);
  CLAMP_U32(http_max_events_per_tick, PNET_MAX_EVENTS_PER_TICK);
  CLAMP_SZ(http_max_tick_bytes, PNET_MAX_TICK_BYTES);
  CLAMP_U32(http_max_headers, PNET_MAX_HEADERS);
  CLAMP_SZ(http_max_header_bytes, PNET_MAX_HEADER_BYTES);
  CLAMP_U32(http_max_timeout_ms, PNET_MAX_TIMEOUT_MS);
  CLAMP_U32(http_default_timeout_ms, cfg->http_max_timeout_ms);
  CLAMP_U32(http_max_redirects, PNET_MAX_REDIRECTS);
  CLAMP_U32(ws_max_sockets, PWS_MAX_SOCKETS);
  CLAMP_SZ(ws_max_message_bytes, PWS_MAX_MESSAGE_BYTES);
  CLAMP_SZ(ws_max_receive_queue_bytes, PWS_MAX_RECEIVE_QUEUE_BYTES);
  CLAMP_U32(ws_max_receive_queue_messages, PWS_MAX_RECEIVE_QUEUE_MESSAGES);
  CLAMP_SZ(ws_max_send_queue_bytes, PWS_MAX_SEND_QUEUE_BYTES);
  CLAMP_SZ(ws_send_high_water_bytes, cfg->ws_max_send_queue_bytes);
  CLAMP_SZ(ws_send_low_water_bytes, cfg->ws_send_high_water_bytes);
  CLAMP_U32(ws_max_events_per_tick, PWS_MAX_EVENTS_PER_TICK);
  CLAMP_SZ(ws_max_tick_bytes, PWS_MAX_TICK_BYTES);
  CLAMP_U32(ws_max_connect_ms, PWS_MAX_CONNECT_MS);
  CLAMP_U32(ws_default_connect_ms, cfg->ws_max_connect_ms);
  CLAMP_U32(ws_default_close_ms, cfg->ws_max_connect_ms);
  CLAMP_U32(httpd_max_servers, PHTTPD_MAX_SERVERS);
  CLAMP_U32(httpd_max_connections, PHTTPD_MAX_CONNECTIONS);
  CLAMP_U32(httpd_max_inflight, PHTTPD_MAX_INFLIGHT);
  CLAMP_SZ(httpd_max_header_bytes, PHTTPD_MAX_HEADER_BYTES);
  CLAMP_U32(httpd_max_headers, PHTTPD_MAX_HEADERS);
  CLAMP_SZ(httpd_max_target_bytes, PHTTPD_MAX_TARGET_BYTES);
  CLAMP_SZ(httpd_max_request_queue_bytes, PHTTPD_MAX_REQUEST_QUEUE_BYTES);
  CLAMP_SZ(httpd_default_request_queue_bytes, cfg->httpd_max_request_queue_bytes);
  CLAMP_SZ(httpd_max_send_queue_bytes, PHTTPD_MAX_SEND_QUEUE_BYTES);
  CLAMP_SZ(httpd_send_high_water_bytes, cfg->httpd_max_send_queue_bytes);
  CLAMP_SZ(httpd_send_low_water_bytes, cfg->httpd_send_high_water_bytes);
  CLAMP_U32(httpd_max_events_per_tick, PHTTPD_MAX_EVENTS_PER_TICK);
  CLAMP_SZ(httpd_max_tick_bytes, PHTTPD_MAX_TICK_BYTES);
  if (cfg->io_chunk_bytes < 256) cfg->io_chunk_bytes = 256;
  if (cfg->io_chunk_bytes > 65536) cfg->io_chunk_bytes = 65536;
}

/* ------------------------------------------------------------------------ */
/* Runtime lifecycle                                                         */
/* ------------------------------------------------------------------------ */

uint64_t pnet_now(pnet_runtime *rt) {
  return rt->platform.now_ms(rt->platform.ctx);
}

const char *pnet_io_error_code(int io_err) {
  switch (io_err) {
    case PNET_IO_REFUSED:
    case PNET_IO_TIMEOUT:
      return PNET_ERROR_CONNECT;
    case PNET_IO_ADDRINUSE:
      return PNET_ERROR_ADDRESS_IN_USE;
    case PNET_IO_NOMEM:
      return PNET_ERROR_RESOURCE_LIMIT;
    case PNET_IO_CLOSED:
    case PNET_IO_EOF:
      return PNET_ERROR_CLOSED;
    default:
      return PNET_ERROR_OTHER;
  }
}

void pnet_set_last_error(pnet_runtime *rt, pnet_sb *sb, const char *code, const char *message) {
  pnet_sb_clear(sb);
  pnet_sb_puts(rt, sb, code);
  pnet_sb_puts(rt, sb, ": ");
  pnet_sb_puts(rt, sb, message);
}

pnet_runtime *pnet_runtime_create(const pnet_platform *platform, const pnet_driver_ops *driver, void *driver_ctx,
                                  const pnet_runtime_config *config, const char *policy_json) {
  return pnet_runtime_create_tls(platform, driver, driver_ctx, NULL, NULL, config, policy_json);
}

pnet_runtime *pnet_runtime_create_tls(const pnet_platform *platform, const pnet_driver_ops *driver, void *driver_ctx,
                                      const pnet_tls_ops *tls, void *tls_ctx, const pnet_runtime_config *config,
                                      const char *policy_json) {
  if (!platform || !platform->alloc || !platform->free || !platform->now_ms || !platform->random || !driver) return NULL;
  pnet_runtime *rt = platform->alloc(platform->ctx, sizeof *rt);
  if (!rt) return NULL;
  memset(rt, 0, sizeof *rt);
  rt->platform = *platform;
  rt->driver = *driver;
  rt->driver_ctx = driver_ctx;
  rt->tls = tls;
  rt->tls_ctx = tls_ctx;
  rt->has_features_tls = tls != NULL;
  if (config) rt->cfg = *config;
  else pnet_runtime_config_defaults(&rt->cfg);
  clamp_config(&rt->cfg);
  rt->heap_bytes = sizeof *rt;
  rt->heap_high_water = rt->heap_bytes;
  rt->next_resolve_id = 1;
  rt->http_next_handle = 1;
  rt->ws_next_handle = 1;
  rt->httpd_next_handle = 1;
  rt->httpd_next_req = 1;
  pnet_sb_init(&rt->http_last_error);
  pnet_sb_init(&rt->ws_last_error);
  pnet_sb_init(&rt->httpd_last_error);
  pnet_queue_init(&rt->http_queue, rt->cfg.http_max_events_per_tick, rt->cfg.http_max_tick_bytes);
  pnet_queue_init(&rt->ws_queue, rt->cfg.ws_max_events_per_tick, rt->cfg.ws_max_tick_bytes);
  pnet_queue_init(&rt->httpd_queue, rt->cfg.httpd_max_events_per_tick, rt->cfg.httpd_max_tick_bytes);
  if (!pnet_policy_parse(rt, &rt->policy, policy_json)) {
    pnet_logf(rt, PNET_LOG_ERROR, "pnet: invalid policy JSON");
    platform->free(platform->ctx, rt, sizeof *rt);
    return NULL;
  }
  pnet_http_init(rt);
  pnet_ws_init(rt);
  pnet_httpd_init(rt);
  rt->now = pnet_now(rt);
  return rt;
}

void pnet_runtime_destroy(pnet_runtime *rt) {
  if (!rt) return;
  pnet_http_shutdown(rt);
  pnet_ws_shutdown(rt);
  pnet_httpd_shutdown(rt);
  pnet_queue_free(rt, &rt->http_queue);
  pnet_queue_free(rt, &rt->ws_queue);
  pnet_queue_free(rt, &rt->httpd_queue);
  pnet_sb_free(rt, &rt->http_last_error);
  pnet_sb_free(rt, &rt->ws_last_error);
  pnet_sb_free(rt, &rt->httpd_last_error);
  pnet_policy_free(rt, &rt->policy);
  for (int i = 0; i < PNET_RESOLVE_SLOTS; i++) {
    if (rt->resolves[i].req_id && rt->driver.resolve_cancel) rt->driver.resolve_cancel(rt->driver_ctx, rt->resolves[i].req_id);
  }
  pnet_platform p = rt->platform;
  p.free(p.ctx, rt, sizeof *rt);
}

void pnet_runtime_service(pnet_runtime *rt) {
  rt->now = pnet_now(rt);
  pnet_http_service(rt);
  pnet_ws_service(rt);
  pnet_httpd_service(rt);
}

uint64_t pnet_runtime_next_deadline_ms(pnet_runtime *rt) {
  uint64_t d = pnet_http_next_deadline(rt);
  d = pnet_min_deadline(d, pnet_ws_next_deadline(rt));
  d = pnet_min_deadline(d, pnet_httpd_next_deadline(rt));
  return d;
}

bool pnet_runtime_has_pending_output(pnet_runtime *rt) {
  return pnet_http_has_output(rt) || pnet_ws_has_output(rt) || pnet_httpd_has_output(rt);
}

void pnet_runtime_quiesce(pnet_runtime *rt) {
  rt->quiesced = true;
  pnet_http_quiesce(rt);
  pnet_ws_quiesce(rt);
  pnet_httpd_quiesce(rt);
}

void pnet_runtime_begin_tick(pnet_runtime *rt) {
  rt->now = pnet_now(rt);
  pnet_http_freeze(rt);
  pnet_ws_freeze(rt);
  pnet_httpd_freeze(rt);
  pnet_queue_freeze(rt, &rt->http_queue);
  pnet_queue_freeze(rt, &rt->ws_queue);
  pnet_queue_freeze(rt, &rt->httpd_queue);
}

size_t pnet_runtime_heap_bytes(pnet_runtime *rt) {
  return rt->heap_bytes;
}

bool pnet_runtime_has_live_handles(pnet_runtime *rt) {
  return rt->http_live > 0 || rt->ws_live > 0 || rt->httpd_live > 0;
}

/* ------------------------------------------------------------------------ */
/* Resolver slots                                                            */
/* ------------------------------------------------------------------------ */

static uint32_t resolve_register(pnet_runtime *rt, pnet_dial *dial) {
  for (int i = 0; i < PNET_RESOLVE_SLOTS; i++) {
    if (rt->resolves[i].req_id == 0) {
      uint32_t id = rt->next_resolve_id++;
      if (rt->next_resolve_id == 0) rt->next_resolve_id = 1;
      rt->resolves[i].req_id = id;
      rt->resolves[i].dial = dial;
      return id;
    }
  }
  return 0;
}

static void resolve_unregister(pnet_runtime *rt, uint32_t req_id) {
  for (int i = 0; i < PNET_RESOLVE_SLOTS; i++) {
    if (rt->resolves[i].req_id == req_id) {
      rt->resolves[i].req_id = 0;
      rt->resolves[i].dial = NULL;
    }
  }
}

void pnet_runtime_resolve_done(pnet_runtime *rt, uint32_t req_id, const pnet_addr *addrs, size_t count, int err) {
  for (int i = 0; i < PNET_RESOLVE_SLOTS; i++) {
    if (rt->resolves[i].req_id == req_id) {
      pnet_dial *dial = rt->resolves[i].dial;
      rt->resolves[i].req_id = 0;
      rt->resolves[i].dial = NULL;
      if (dial) pnet_dial_resolved(rt, dial, addrs, count, err);
      return;
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Events                                                                    */
/* ------------------------------------------------------------------------ */

void pnet_queue_init(pnet_queue *q, uint32_t max_events, size_t max_bytes) {
  memset(q, 0, sizeof *q);
  pnet_sb_init(&q->poll_buf);
  q->max_events = max_events;
  q->max_bytes = max_bytes;
}

static void event_free(pnet_runtime *rt, pnet_event *e) {
  if (e->json) pnet_free(rt, e->json, e->json_len + 1);
  pnet_free(rt, e, sizeof *e);
}

void pnet_queue_free(pnet_runtime *rt, pnet_queue *q) {
  pnet_event *e = q->pending_head;
  while (e) {
    pnet_event *n = e->next;
    event_free(rt, e);
    e = n;
  }
  e = q->visible_head;
  while (e) {
    pnet_event *n = e->next;
    event_free(rt, e);
    e = n;
  }
  pnet_sb_free(rt, &q->poll_buf);
  q->pending_head = q->pending_tail = NULL;
  q->visible_head = q->visible_tail = NULL;
  q->pending_count = q->visible_count = 0;
  q->rendered = false;
  q->rendered_count = 0;
}

static void pending_append(pnet_queue *q, pnet_event *e) {
  e->next = NULL;
  if (q->pending_tail) q->pending_tail->next = e;
  else q->pending_head = e;
  q->pending_tail = e;
  q->pending_count++;
}

bool pnet_queue_push(pnet_runtime *rt, pnet_queue *q, int handle, bool terminal, size_t weight, char *json,
                     size_t json_len) {
  if (!json) return false;
  pnet_event *e = pnet_alloc(rt, sizeof *e);
  if (!e) {
    pnet_free(rt, json, json_len + 1);
    return false;
  }
  e->seq = ++rt->seq;
  e->handle = handle;
  e->terminal = terminal;
  e->readable = false;
  e->weight = weight;
  e->json = json;
  e->json_len = json_len;
  pending_append(q, e);
  return true;
}

bool pnet_queue_push_readable(pnet_runtime *rt, pnet_queue *q, int handle, const char *field, size_t avail) {
  char buf[96];
  int n = snprintf(buf, sizeof buf, "{\"t\":\"readable\",\"%s\":%d,\"avail\":%zu}", field, handle, avail);
  if (n <= 0) return false;
  char *json = pnet_strdup_n(rt, buf, (size_t)n);
  if (!json) return false;
  pnet_event *e = pnet_alloc(rt, sizeof *e);
  if (!e) {
    pnet_free(rt, json, (size_t)n + 1);
    return false;
  }
  e->seq = ++rt->seq;
  e->handle = handle;
  e->terminal = false;
  e->readable = true;
  e->weight = avail;
  e->json = json;
  e->json_len = (size_t)n;
  /* Insert before the handle's terminal event when one is already pending
   * so the guest observes readable before end/error. */
  pnet_event *prev = NULL;
  for (pnet_event *cur = q->pending_head; cur; prev = cur, cur = cur->next) {
    if (cur->handle == handle && cur->terminal) {
      e->next = cur;
      if (prev) prev->next = e;
      else q->pending_head = e;
      q->pending_count++;
      /* Sequence order: give it the terminal's slot ordering by keeping the
       * list order authoritative (poll renders list order). */
      return true;
    }
  }
  pending_append(q, e);
  return true;
}

void pnet_queue_freeze(pnet_runtime *rt, pnet_queue *q) {
  (void)rt;
  size_t events = 0;
  size_t bytes = 0;
  while (q->pending_head) {
    pnet_event *e = q->pending_head;
    if (events > 0 && (events >= q->max_events || bytes + e->weight > q->max_bytes)) break;
    q->pending_head = e->next;
    if (!q->pending_head) q->pending_tail = NULL;
    q->pending_count--;
    e->next = NULL;
    if (q->visible_tail) q->visible_tail->next = e;
    else q->visible_head = e;
    q->visible_tail = e;
    q->visible_count++;
    events++;
    bytes += e->weight;
  }
}

const char *pnet_queue_render(pnet_runtime *rt, pnet_queue *q, size_t *len) {
  if (q->rendered) {
    /* A batch rendered but not yet consumed (two-phase host): hand it out
     * again unchanged; the visible set is untouched. */
    if (len) *len = q->poll_buf.len;
    return pnet_sb_cstr(&q->poll_buf);
  }
  if (!q->visible_head) {
    if (len) *len = 0;
    return NULL;
  }
  /* Transactional: size the batch — '[' + json joined by ',' + ']' — and
   * reserve it up front. Nothing is dequeued until the buffer is certain, so
   * memory pressure can delay a batch (the next poll retries) but can never
   * drop a visible event, least of all a terminal one. */
  size_t need = 2;
  size_t count = 0;
  for (pnet_event *e = q->visible_head; e; e = e->next) {
    need += e->json_len;
    count++;
  }
  need += count - 1;
  pnet_sb_clear(&q->poll_buf);
  if (q->poll_buf.cap < need + 1) {
    /* Release the undersized buffer before growing: the contents are stale
     * and keeping both halves alive is what pushes a tight heap over. */
    pnet_sb_free(rt, &q->poll_buf);
  }
  if (!pnet_sb_reserve(rt, &q->poll_buf, need)) {
    if (!q->starved) {
      q->starved = true;
      pnet_logf(rt, PNET_LOG_WARN, "pnet: poll batch of %zu bytes deferred (out of memory); events stay visible", need);
    }
    if (len) *len = 0;
    return NULL;
  }
  q->starved = false;
  pnet_sb_putc(rt, &q->poll_buf, '[');
  bool first = true;
  for (pnet_event *e = q->visible_head; e; e = e->next) {
    if (!first) pnet_sb_putc(rt, &q->poll_buf, ',');
    first = false;
    pnet_sb_append(rt, &q->poll_buf, e->json, e->json_len);
  }
  pnet_sb_putc(rt, &q->poll_buf, ']');
  /* Reserved exactly: rendering cannot have failed. */
  if (q->poll_buf.failed) {
    pnet_logf(rt, PNET_LOG_ERROR, "pnet: poll batch render failed after reservation");
    pnet_sb_clear(&q->poll_buf);
    if (len) *len = 0;
    return NULL;
  }
  q->rendered = true;
  q->rendered_count = count;
  if (len) *len = q->poll_buf.len;
  return pnet_sb_cstr(&q->poll_buf);
}

void pnet_queue_consume(pnet_runtime *rt, pnet_queue *q) {
  if (!q->rendered) return;
  /* Exactly the events the rendered batch carries; anything a later freeze
   * appended behind them stays visible for the next render. */
  while (q->rendered_count > 0 && q->visible_head) {
    pnet_event *e = q->visible_head;
    q->visible_head = e->next;
    if (!q->visible_head) q->visible_tail = NULL;
    q->visible_count--;
    q->rendered_count--;
    event_free(rt, e);
  }
  q->rendered = false;
  q->rendered_count = 0;
}

const char *pnet_queue_poll(pnet_runtime *rt, pnet_queue *q, size_t *len) {
  const char *batch = pnet_queue_render(rt, q, len);
  if (batch) pnet_queue_consume(rt, q);
  return batch; /* the rendered text stays valid until the next render */
}

void pnet_queue_drop_handle(pnet_runtime *rt, pnet_queue *q, int handle) {
  pnet_event **pp = &q->pending_head;
  pnet_event *prev = NULL;
  while (*pp) {
    pnet_event *e = *pp;
    if (e->handle == handle) {
      *pp = e->next;
      if (q->pending_tail == e) q->pending_tail = prev;
      q->pending_count--;
      event_free(rt, e);
      continue;
    }
    prev = e;
    pp = &e->next;
  }
}

char *pnet_event_json(pnet_runtime *rt, const char *t, const char *id_key, int id, const char *tail, size_t tail_len,
                      size_t *out_len) {
  pnet_sb sb;
  pnet_sb_init(&sb);
  pnet_sb_printf(rt, &sb, "{\"t\":\"%s\",\"%s\":%d", t, id_key, id);
  if (tail_len) pnet_sb_append(rt, &sb, tail, tail_len);
  pnet_sb_putc(rt, &sb, '}');
  if (sb.failed) {
    pnet_sb_free(rt, &sb);
    return NULL;
  }
  /* Hand the buffer over with exact accounting (len+1). */
  char *out = pnet_strdup_n(rt, sb.data, sb.len);
  if (out_len) *out_len = sb.len;
  pnet_sb_free(rt, &sb);
  return out;
}

bool pnet_push_error_event(pnet_runtime *rt, pnet_queue *q, const char *id_key, int id, const char *code,
                           const char *message, const char *cause) {
  pnet_sb sb;
  pnet_sb_init(&sb);
  pnet_sb_puts(rt, &sb, ",\"code\":");
  pnet_sb_json_string(rt, &sb, code, strlen(code));
  pnet_sb_puts(rt, &sb, ",\"message\":");
  pnet_sb_json_string(rt, &sb, message ? message : "", message ? strlen(message) : 0);
  if (cause) {
    pnet_sb_puts(rt, &sb, ",\"causeCode\":");
    pnet_sb_json_string(rt, &sb, cause, strlen(cause));
  }
  size_t len = 0;
  char *json = sb.failed ? NULL : pnet_event_json(rt, "error", id_key, id, sb.data, sb.len, &len);
  pnet_sb_free(rt, &sb);
  if (!json) return false;
  return pnet_queue_push(rt, q, id, true, 0, json, len);
}

/* ------------------------------------------------------------------------ */
/* Connection                                                                */
/* ------------------------------------------------------------------------ */

void pnet_conn_init(pnet_conn *c) {
  memset(c, 0, sizeof *c);
  c->sock = PNET_SOCK_INVALID;
  c->state = PNET_CONN_IDLE;
  c->read_wanted = true;
  pnet_bq_init(&c->tx);
}

bool pnet_conn_connect(pnet_runtime *rt, pnet_conn *c, const pnet_addr *addr, int *err) {
  int e = 0;
  pnet_sock s = rt->driver.connect(rt->driver_ctx, addr, &e);
  if (s == PNET_SOCK_INVALID) {
    if (err) *err = e ? e : PNET_IO_ERROR;
    return false;
  }
  c->sock = s;
  c->state = PNET_CONN_CONNECTING;
  c->remote = *addr;
  c->interest = 0;
  c->eof = false;
  c->write_shutdown = false;
  c->tx_error = false;
  pnet_conn_update_interest(rt, c);
  return true;
}

void pnet_conn_adopt(pnet_runtime *rt, pnet_conn *c, pnet_sock s, const pnet_addr *peer) {
  c->sock = s;
  c->state = PNET_CONN_OPEN;
  c->remote = *peer;
  c->interest = 0;
  pnet_conn_update_interest(rt, c);
}

int pnet_conn_connect_status(pnet_runtime *rt, pnet_conn *c) {
  if (c->state != PNET_CONN_CONNECTING) return c->state == PNET_CONN_OPEN ? 1 : PNET_IO_ERROR;
  int st = rt->driver.connect_status(rt->driver_ctx, c->sock);
  if (st == 1) {
    c->state = PNET_CONN_OPEN;
    pnet_conn_update_interest(rt, c);
  } else if (st < 0) {
    c->last_error = st;
  }
  return st;
}

bool pnet_conn_write(pnet_runtime *rt, pnet_conn *c, const void *data, size_t len) {
  if (c->state == PNET_CONN_CLOSED || c->write_shutdown) return false;
  if (!pnet_bq_push(rt, &c->tx, data, len, rt->cfg.io_chunk_bytes)) return false;
  pnet_conn_update_interest(rt, c);
  return true;
}

bool pnet_conn_flush(pnet_runtime *rt, pnet_conn *c) {
  if (c->state != PNET_CONN_OPEN) return c->state == PNET_CONN_CONNECTING;
  if (c->secure && c->tls_phase != PNET_TLS_UP) return true; /* handshake pending */
  while (c->tx.bytes > 0) {
    const uint8_t *ptr;
    size_t n = pnet_bq_peek(&c->tx, &ptr);
    if (n == 0) break;
    int w = c->secure ? c->tls->write(c->tls_ctx, c->sock, ptr, n) : rt->driver.write(rt->driver_ctx, c->sock, ptr, n);
    if (w == PNET_IO_AGAIN || w == 0) break;
    if (w < 0) {
      c->tx_error = true;
      c->last_error = w;
      pnet_conn_update_interest(rt, c);
      return false;
    }
    pnet_bq_consume(rt, &c->tx, (size_t)w);
  }
  if (c->write_shutdown && !c->shutdown_done && c->tx.bytes == 0) {
    c->shutdown_done = true;
    if (rt->driver.shutdown_write) rt->driver.shutdown_write(rt->driver_ctx, c->sock);
  }
  pnet_conn_update_interest(rt, c);
  return true;
}

int pnet_conn_read(pnet_runtime *rt, pnet_conn *c, uint8_t *buf, size_t len) {
  if (c->state != PNET_CONN_OPEN) return PNET_IO_AGAIN;
  if (c->secure && c->tls_phase != PNET_TLS_UP) return PNET_IO_AGAIN;
  if (c->eof) return PNET_IO_EOF;
  int r = c->secure ? c->tls->read(c->tls_ctx, c->sock, buf, len) : rt->driver.read(rt->driver_ctx, c->sock, buf, len);
  if (r == PNET_IO_EOF) c->eof = true;
  else if (r < 0 && r != PNET_IO_AGAIN) c->last_error = r;
  return r;
}

void pnet_conn_update_interest(pnet_runtime *rt, pnet_conn *c) {
  if (c->sock == PNET_SOCK_INVALID || c->state == PNET_CONN_CLOSED) return;
  unsigned want = 0;
  if (c->state == PNET_CONN_CONNECTING) want = PNET_INTEREST_WRITE;
  else if (c->secure && c->tls_phase == PNET_TLS_HANDSHAKE) {
    want = c->tls->interest ? c->tls->interest(c->tls_ctx, c->sock) : (PNET_INTEREST_READ | PNET_INTEREST_WRITE);
    if (want == 0) want = PNET_INTEREST_READ;
  } else {
    if (c->read_wanted && !c->eof) want |= PNET_INTEREST_READ;
    if (c->tx.bytes > 0 && !c->tx_error) want |= PNET_INTEREST_WRITE;
    /* A TLS session may hold buffered records: keep read interest so the
     * provider can flush them even when the app is momentarily satisfied. */
    if (c->secure && c->tls_phase == PNET_TLS_UP && c->read_wanted) want |= PNET_INTEREST_READ;
  }
  if (want != c->interest) {
    c->interest = want;
    rt->driver.interest(rt->driver_ctx, c->sock, want);
  }
}

void pnet_conn_shutdown_write(pnet_runtime *rt, pnet_conn *c) {
  if (c->state != PNET_CONN_OPEN || c->write_shutdown) return;
  c->write_shutdown = true;
  if (c->tx.bytes == 0) {
    c->shutdown_done = true;
    if (rt->driver.shutdown_write) rt->driver.shutdown_write(rt->driver_ctx, c->sock);
  }
}

void pnet_conn_set_tls(pnet_conn *c, const pnet_tls_ops *tls, void *tls_ctx, const char *server_name, bool verify) {
  c->tls = tls;
  c->tls_ctx = tls_ctx;
  c->secure = tls != NULL;
  c->tls_verify = verify;
  size_t n = server_name ? strlen(server_name) : 0;
  if (n >= sizeof c->server_name) n = sizeof c->server_name - 1;
  if (n) memcpy(c->server_name, server_name, n);
  c->server_name[n] = 0;
}

int pnet_conn_tls_step(pnet_runtime *rt, pnet_conn *c) {
  (void)rt;
  if (!c->secure || !c->tls) return 1;
  if (c->tls_phase == PNET_TLS_UP) return 1;
  if (c->tls_phase == PNET_TLS_ERROR) return -1;
  if (c->tls_phase == PNET_TLS_NONE) {
    pnet_tls_policy policy = {.server_name = c->server_name, .verify = c->tls_verify, .alpn = "http/1.1"};
    int rc = c->tls->start(c->tls_ctx, c->sock, &policy);
    if (rc != 0) {
      c->tls_phase = PNET_TLS_ERROR;
      c->tls_failure.code = PNET_ERROR_TLS_HANDSHAKE_FAILED;
      c->tls_failure.cause = rc;
      return -1;
    }
    c->tls_phase = PNET_TLS_HANDSHAKE;
  }
  int rc = c->tls->step(c->tls_ctx, c->sock, &c->tls_failure);
  if (rc == 1) {
    c->tls_phase = PNET_TLS_UP;
    pnet_conn_update_interest(rt, c);
    return 1;
  }
  if (rc < 0) {
    c->tls_phase = PNET_TLS_ERROR;
    if (!c->tls_failure.code) c->tls_failure.code = PNET_ERROR_TLS_HANDSHAKE_FAILED;
    return -1;
  }
  /* pending: the provider dictates interest */
  pnet_conn_update_interest(rt, c);
  return 0;
}

void pnet_conn_close(pnet_runtime *rt, pnet_conn *c) {
  /* Release the TLS session for any started handshake (up, in progress or
   * failed) so the provider's per-socket slot cannot outlive the socket and
   * collide with a reused socket id. */
  if (c->tls && c->tls_phase != PNET_TLS_NONE && c->sock != PNET_SOCK_INVALID) {
    c->tls->close(c->tls_ctx, c->sock);
  }
  c->tls_phase = PNET_TLS_NONE;
  if (c->sock != PNET_SOCK_INVALID) {
    rt->driver.close(rt->driver_ctx, c->sock);
    c->sock = PNET_SOCK_INVALID;
  }
  pnet_bq_free(rt, &c->tx);
  c->state = PNET_CONN_CLOSED;
  c->interest = 0;
}

/* ------------------------------------------------------------------------ */
/* Dialer                                                                    */
/* ------------------------------------------------------------------------ */

static void dial_try_next(pnet_runtime *rt, pnet_dial *d, pnet_conn *c) {
  while (d->next_candidate < d->candidate_count) {
    pnet_addr *addr = &d->candidates[d->next_candidate++];
    addr->port = d->port;
    if (!pnet_policy_allows_address(&rt->policy, addr)) {
      d->filtered_all = d->filtered_all && true;
      continue;
    }
    d->filtered_all = false;
    int err = 0;
    if (pnet_conn_connect(rt, c, addr, &err)) {
      d->state = PNET_DIAL_CONNECTING;
      return;
    }
    d->cause = err;
  }
  d->state = PNET_DIAL_FAILED;
  if (d->filtered_all) {
    d->error_code = PNET_ERROR_PERMISSION_DENIED;
  } else if (!d->error_code) {
    /* Every failure while establishing the transport is `connect`; the
     * driver's code (refused/reset/unreachable/no memory) rides in cause. */
    d->error_code = d->cause == PNET_IO_NOMEM ? PNET_ERROR_RESOURCE_LIMIT : PNET_ERROR_CONNECT;
  }
}

bool pnet_dial_start(pnet_runtime *rt, pnet_dial *d, pnet_conn *c, const char *host, uint16_t port, bool secure,
                     const char *server_name, bool verify) {
  memset(d, 0, sizeof *d);
  d->port = port;
  d->filtered_all = true;
  d->secure = secure;
  if (secure) {
    if (!rt->tls) {
      d->state = PNET_DIAL_FAILED;
      d->error_code = PNET_ERROR_UNSUPPORTED;
      return false;
    }
    /* Fail closed before any I/O when the wall clock is not trusted and the
     * certificate's validity must be checked. */
    if (verify && rt->platform.wall_clock_trusted && !rt->platform.wall_clock_trusted(rt->platform.ctx)) {
      d->state = PNET_DIAL_FAILED;
      d->error_code = PNET_ERROR_TLS_CLOCK_UNTRUSTED;
      d->error_message = "wall clock is not trusted for certificate validation";
      return false;
    }
    pnet_conn_set_tls(c, rt->tls, rt->tls_ctx, server_name, verify);
  }
  pnet_addr literal;
  if (pnet_parse_ip_literal(host, strlen(host), &literal)) {
    d->candidates[0] = literal;
    d->candidate_count = 1;
    dial_try_next(rt, d, c);
    return d->state != PNET_DIAL_FAILED;
  }
  size_t hl = strlen(host);
  if (hl >= 6 && strcmp(host + hl - 6, ".local") == 0) {
    d->state = PNET_DIAL_FAILED;
    d->error_code = PNET_ERROR_UNSUPPORTED;
    return false;
  }
  if (!rt->driver.resolve) {
    d->state = PNET_DIAL_FAILED;
    d->error_code = PNET_ERROR_DNS;
    return false;
  }
  uint32_t id = resolve_register(rt, d);
  if (id == 0) {
    d->state = PNET_DIAL_FAILED;
    d->error_code = PNET_ERROR_RESOURCE_LIMIT;
    return false;
  }
  d->resolve_req = id;
  d->state = PNET_DIAL_RESOLVING;
  int rc = rt->driver.resolve(rt->driver_ctx, id, host);
  if (rc < 0) {
    resolve_unregister(rt, id);
    d->resolve_req = 0;
    d->state = PNET_DIAL_FAILED;
    d->error_code = PNET_ERROR_DNS;
    d->cause = rc;
    return false;
  }
  /* The driver may have completed synchronously (state advanced). */
  if (d->state == PNET_DIAL_RESOLVING) return true;
  if (d->state == PNET_DIAL_FAILED) return false;
  /* resolved synchronously: connect attempts already started or scheduled */
  if (d->state == PNET_DIAL_IDLE) dial_try_next(rt, d, c);
  return d->state != PNET_DIAL_FAILED;
}

void pnet_dial_resolved(pnet_runtime *rt, pnet_dial *d, const pnet_addr *addrs, size_t count, int err) {
  (void)rt;
  d->resolve_req = 0;
  if (d->state != PNET_DIAL_RESOLVING) return;
  if (err != 0 || count == 0) {
    d->state = PNET_DIAL_FAILED;
    d->error_code = PNET_ERROR_DNS;
    d->cause = err;
    return;
  }
  size_t n = count < PNET_DIAL_MAX_CANDIDATES ? count : PNET_DIAL_MAX_CANDIDATES;
  memcpy(d->candidates, addrs, n * sizeof(pnet_addr));
  d->candidate_count = n;
  d->next_candidate = 0;
  /* Connect attempts start on the next step (the caller's service pass) so
   * that a synchronous resolver does not recurse into the connect path with
   * the caller's state half-initialized. */
  d->state = PNET_DIAL_IDLE;
}

int pnet_dial_step(pnet_runtime *rt, pnet_dial *d, pnet_conn *c) {
  switch (d->state) {
    case PNET_DIAL_IDLE:
      if (d->candidate_count == 0) return PNET_DIAL_IDLE;
      dial_try_next(rt, d, c);
      if (d->state != PNET_DIAL_CONNECTING) return d->state;
      /* fall through */
    case PNET_DIAL_CONNECTING: {
      if (!d->tls_up) {
        int st = pnet_conn_connect_status(rt, c);
        if (st < 0) {
          d->cause = st;
          bool was_secure = c->secure;
          const pnet_tls_ops *tls = c->tls;
          void *tls_ctx = c->tls_ctx;
          char sni[256];
          bool verify = c->tls_verify;
          memcpy(sni, c->server_name, sizeof sni);
          pnet_conn_close(rt, c);
          pnet_conn_init(c);
          if (was_secure) pnet_conn_set_tls(c, tls, tls_ctx, sni, verify);
          dial_try_next(rt, d, c);
          return d->state;
        }
        if (st != 1) return d->state; /* plain connect still pending */
        if (!d->secure) {
          d->state = PNET_DIAL_OPEN;
          return d->state;
        }
      }
      /* TLS handshake over the connected socket. */
      int hs = pnet_conn_tls_step(rt, c);
      if (hs == 1) {
        d->tls_up = true;
        d->state = PNET_DIAL_OPEN;
      } else if (hs < 0) {
        d->error_code = c->tls_failure.code ? c->tls_failure.code : PNET_ERROR_TLS_HANDSHAKE_FAILED;
        d->cause = c->tls_failure.cause;
        d->state = PNET_DIAL_FAILED;
      }
      return d->state;
    }
    default:
      return d->state;
  }
}

void pnet_dial_cancel(pnet_runtime *rt, pnet_dial *d) {
  if (d->resolve_req) {
    resolve_unregister(rt, d->resolve_req);
    if (rt->driver.resolve_cancel) rt->driver.resolve_cancel(rt->driver_ctx, d->resolve_req);
    d->resolve_req = 0;
  }
  d->state = PNET_DIAL_FAILED;
  if (!d->error_code) d->error_code = PNET_ERROR_CANCELLED;
}
