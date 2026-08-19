/* HTTP Server core (`globalThis.httpd`, contracts/spec/httpd.ts v2).
 *
 * The core owns listeners, accepted connections, request parsing, response
 * encoding, keep-alive and every limit; the guest sees a server handle and
 * request ids only. Pipelining is disabled: the next request on a connection
 * is parsed only after the previous response completed. Events (`listening`,
 * `request`, `readable`, `end`, `drain`, `aborted`, `error`, `closed`) go to
 * the httpd queue and reach the guest at begin_tick(); request bodies cross
 * only through pnet_httpd_read_into; response bytes enter through
 * respond/write/endBody and are written by the network task.
 */
#include <stdio.h>

#include "pnet_internal.h"

typedef enum server_state {
  SV_BINDING = 0,
  SV_LISTENING,
  SV_STOPPING,
  SV_CLOSED,
} server_state;

typedef enum conn_phase {
  CP_HEAD = 0,     /* reading the request head */
  CP_REQUEST,      /* request delivered: body streaming and/or response pending */
  CP_DRAIN,        /* response complete, draining the unread request body */
  CP_CLOSING,      /* flush then close */
} conn_phase;

typedef struct pnet_httpd_conn {
  struct pnet_httpd_conn *next;
  struct pnet_httpd_server *server;
  pnet_conn conn;
  uint8_t phase;
  int req;                 /* current request id, 0 when none */
  bool req_delivered;
  bool req_terminal;       /* aborted or completed */
  bool head_method;        /* HEAD: discard the response body */
  bool keep_alive;
  bool close_after;        /* close once the response is flushed */
  bool responded;
  bool response_complete;
  bool response_chunked;
  int64_t response_remaining; /* known-length streamed responses */
  bool drain_armed;
  uint8_t *rx;
  size_t rx_len;
  size_t rx_cap;
  pnet_h1_body decoder;
  bool body_end_pushed;
  pnet_bq rxq;
  size_t visible_bytes;
  bool dirty;
  size_t body_total;
  uint64_t deadline;
  uint8_t deadline_kind;   /* 0 header, 1 body idle, 2 handler, 3 keep-alive, 4 close */
} pnet_httpd_conn;

typedef struct pnet_httpd_server {
  struct pnet_httpd_server *next;
  int handle;
  uint8_t state;
  bool graceful;
  uint64_t stop_deadline;
  pnet_sock listener;
  pnet_addr bind_addr;
  pnet_addr bound;
  int backlog;
  bool accepting;
  uint32_t max_connections, max_inflight;
  size_t max_header_bytes, max_body_bytes, request_queue_bytes, send_queue_bytes;
  uint32_t header_ms, body_idle_ms, handler_ms, keep_alive_ms, close_ms;
  pnet_httpd_conn *conns;
  uint32_t conn_count;
  uint32_t inflight;
  bool live_counted;
} pnet_httpd_server;

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

static const char *reason_phrase(int status) {
  switch (status) {
    case 100: return "Continue";
    case 200: return "OK";
    case 201: return "Created";
    case 202: return "Accepted";
    case 204: return "No Content";
    case 206: return "Partial Content";
    case 301: return "Moved Permanently";
    case 302: return "Found";
    case 303: return "See Other";
    case 304: return "Not Modified";
    case 307: return "Temporary Redirect";
    case 308: return "Permanent Redirect";
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 408: return "Request Timeout";
    case 409: return "Conflict";
    case 413: return "Content Too Large";
    case 414: return "URI Too Long";
    case 415: return "Unsupported Media Type";
    case 429: return "Too Many Requests";
    case 431: return "Request Header Fields Too Large";
    case 500: return "Internal Server Error";
    case 501: return "Not Implemented";
    case 502: return "Bad Gateway";
    case 503: return "Service Unavailable";
    case 504: return "Gateway Timeout";
    default: return "";
  }
}

static void conn_free(pnet_runtime *rt, pnet_httpd_conn *c) {
  pnet_conn_close(rt, &c->conn);
  if (c->rx) pnet_free(rt, c->rx, c->rx_cap);
  pnet_bq_free(rt, &c->rxq);
  pnet_free(rt, c, sizeof *c);
}

static void server_unlink_conn(pnet_runtime *rt, pnet_httpd_conn *c) {
  pnet_httpd_server *s = c->server;
  pnet_httpd_conn **pp = &s->conns;
  while (*pp && *pp != c) pp = &(*pp)->next;
  if (*pp) *pp = c->next;
  if (s->conn_count > 0) s->conn_count--;
  conn_free(rt, c);
}

static pnet_httpd_server *server_find(pnet_runtime *rt, int handle) {
  for (pnet_httpd_server *s = rt->httpd_servers; s; s = s->next)
    if (s->handle == handle) return s;
  return NULL;
}

static pnet_httpd_conn *req_find(pnet_runtime *rt, int req, pnet_httpd_server **out_server) {
  if (req <= 0) return NULL;
  for (pnet_httpd_server *s = rt->httpd_servers; s; s = s->next) {
    for (pnet_httpd_conn *c = s->conns; c; c = c->next) {
      if (c->req == req && c->req_delivered && !c->req_terminal) {
        if (out_server) *out_server = s;
        return c;
      }
    }
  }
  return NULL;
}

static void push_req_event(pnet_runtime *rt, const char *t, int req, const char *tail, size_t tail_len, bool terminal,
                           size_t weight) {
  size_t len = 0;
  char *json = pnet_event_json(rt, t, "req", req, tail, tail_len, &len);
  pnet_queue_push(rt, &rt->httpd_queue, req, terminal, weight, json, len);
}

/* Server-level events share the httpd queue with request events; the queue
 * orders readable insertions by its numeric key, so server keys are negated
 * to keep them apart from request ids. */
static void push_server_event(pnet_runtime *rt, const char *t, int handle, const char *tail, size_t tail_len,
                              bool terminal) {
  size_t len = 0;
  char *json = pnet_event_json(rt, t, "h", handle, tail, tail_len, &len);
  pnet_queue_push(rt, &rt->httpd_queue, -handle, terminal, 0, json, len);
}

static void push_server_error(pnet_runtime *rt, int handle, const char *code, const char *message, const char *cause) {
  pnet_sb sb;
  pnet_sb_init(&sb);
  pnet_sb_puts(rt, &sb, ",\"code\":");
  pnet_sb_json_string(rt, &sb, code, strlen(code));
  pnet_sb_puts(rt, &sb, ",\"message\":");
  pnet_sb_json_string(rt, &sb, message, strlen(message));
  if (cause) {
    pnet_sb_puts(rt, &sb, ",\"causeCode\":");
    pnet_sb_json_string(rt, &sb, cause, strlen(cause));
  }
  if (!sb.failed) push_server_event(rt, "error", handle, sb.data, sb.len, false);
  pnet_sb_free(rt, &sb);
}

/** Terminate the current request with `aborted{code}` (no response will be
 * sent by the app any more). */
static void req_abort(pnet_runtime *rt, pnet_httpd_conn *c, const char *code) {
  if (!c->req_delivered || c->req_terminal) return;
  c->req_terminal = true;
  if (c->server->inflight > 0) c->server->inflight--;
  pnet_bq_free(rt, &c->rxq);
  c->visible_bytes = 0;
  c->dirty = false;
  char tail[64];
  int n = snprintf(tail, sizeof tail, ",\"code\":\"%s\"", code);
  push_req_event(rt, "aborted", c->req, tail, (size_t)n, true, 0);
}

/** Queue a canned response and close after flushing. */
static void conn_reject(pnet_runtime *rt, pnet_httpd_conn *c, int status) {
  char head[160];
  int n = snprintf(head, sizeof head, "HTTP/1.1 %d %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", status,
                   reason_phrase(status));
  pnet_conn_write(rt, &c->conn, head, (size_t)n);
  c->close_after = true;
  c->phase = CP_CLOSING;
  c->conn.read_wanted = false;
  pnet_conn_update_interest(rt, &c->conn);
  c->deadline = rt->now + c->server->close_ms;
  c->deadline_kind = 4;
}

static void conn_start_head(pnet_runtime *rt, pnet_httpd_conn *c) {
  c->phase = CP_HEAD;
  c->req = 0;
  c->req_delivered = false;
  c->req_terminal = false;
  c->head_method = false;
  c->responded = false;
  c->response_complete = false;
  c->response_chunked = false;
  c->response_remaining = -1;
  c->drain_armed = false;
  c->body_end_pushed = false;
  c->body_total = 0;
  c->visible_bytes = 0;
  c->dirty = false;
  pnet_bq_free(rt, &c->rxq);
  c->conn.read_wanted = true;
  pnet_conn_update_interest(rt, &c->conn);
  /* A keep-alive connection waits keepAliveMs for the next head; a fresh
   * connection gets headerMs. */
  c->deadline = rt->now + (c->keep_alive ? c->server->keep_alive_ms : c->server->header_ms);
  c->deadline_kind = c->keep_alive ? 3 : 0;
}

/* ------------------------------------------------------------------------ */
/* Request head processing                                                   */
/* ------------------------------------------------------------------------ */

typedef struct body_sink_ctx {
  pnet_runtime *rt;
  pnet_httpd_conn *c;
  bool too_large;
  bool oom;
} body_sink_ctx;

static bool request_body_sink(void *vctx, const uint8_t *data, size_t len) {
  body_sink_ctx *ctx = vctx;
  pnet_httpd_conn *c = ctx->c;
  if (c->req_terminal) return true; /* discard after abort */
  if (c->body_total + len > c->server->max_body_bytes) {
    ctx->too_large = true;
    return false;
  }
  if (c->phase == CP_DRAIN) {
    c->body_total += len; /* discard the drained bytes */
    return true;
  }
  if (!pnet_bq_push(ctx->rt, &c->rxq, data, len, ctx->rt->cfg.io_chunk_bytes)) {
    ctx->oom = true;
    return false;
  }
  c->body_total += len;
  c->dirty = true;
  return true;
}

static void body_finished(pnet_runtime *rt, pnet_httpd_conn *c) {
  if (c->body_end_pushed) return;
  c->body_end_pushed = true;
  /* `end` is a queue barrier: the tick boundary inserts the request's
   * `readable` ahead of it so the guest sees the last bytes before EOF. */
  if (c->req_delivered && !c->req_terminal) push_req_event(rt, "end", c->req, NULL, 0, true, 0);
}

static bool deliver_request(pnet_runtime *rt, pnet_httpd_conn *c, const pnet_h1_head *head, bool secure) {
  pnet_httpd_server *s = c->server;
  pnet_sb sb;
  pnet_sb_init(&sb);
  pnet_sb_printf(rt, &sb, ",\"req\":%d,\"method\":", c->req);
  pnet_sb_json_string(rt, &sb, head->method, head->method_len);
  pnet_sb_puts(rt, &sb, ",\"target\":");
  pnet_sb_json_string(rt, &sb, head->target, head->target_len);
  pnet_sb_puts(rt, &sb, ",\"headers\":{");
  bool first = true;
  for (size_t i = 0; i < head->field_count; i++) {
    const pnet_h1_field *f = &head->fields[i];
    bool seen = false;
    for (size_t k = 0; k < i; k++)
      if (head->fields[k].name_len == f->name_len && memcmp(head->fields[k].name, f->name, f->name_len) == 0) seen = true;
    if (seen) continue;
    if (!first) pnet_sb_putc(rt, &sb, ',');
    first = false;
    pnet_sb_json_string(rt, &sb, f->name, f->name_len);
    pnet_sb_putc(rt, &sb, ':');
    bool cookie = f->name_len == 6 && memcmp(f->name, "cookie", 6) == 0;
    pnet_sb value;
    pnet_sb_init(&value);
    bool firstv = true;
    for (size_t k = i; k < head->field_count; k++) {
      const pnet_h1_field *g = &head->fields[k];
      if (g->name_len != f->name_len || memcmp(g->name, f->name, f->name_len) != 0) continue;
      if (!firstv) pnet_sb_puts(rt, &value, cookie ? "; " : ", ");
      firstv = false;
      pnet_sb_append(rt, &value, g->value, g->value_len);
    }
    pnet_sb_json_string(rt, &sb, pnet_sb_cstr(&value), value.len);
    pnet_sb_free(rt, &value);
  }
  char addr[48];
  pnet_format_addr(&c->conn.remote, addr, sizeof addr);
  pnet_sb_printf(rt, &sb, "},\"remote\":{\"address\":\"%s\",\"port\":%u}", addr, (unsigned)c->conn.remote.port);
  if (head->content_length >= 0) pnet_sb_printf(rt, &sb, ",\"length\":%lld", (long long)head->content_length);
  pnet_sb_puts(rt, &sb, secure ? ",\"secure\":true" : ",\"secure\":false");
  size_t len = 0;
  size_t weight = sb.len;
  char *json = sb.failed ? NULL : pnet_event_json(rt, "request", "h", s->handle, sb.data, sb.len, &len);
  pnet_sb_free(rt, &sb);
  if (!json) return false;
  return pnet_queue_push(rt, &rt->httpd_queue, c->req, false, weight, json, len);
}

static void on_request_head(pnet_runtime *rt, pnet_httpd_conn *c, pnet_h1_head *head) {
  pnet_httpd_server *s = c->server;
  if (!pnet_h1_validate_framing(head)) {
    conn_reject(rt, c, 400);
    return;
  }
  /* Host header is mandatory in HTTP/1.1. */
  if (head->minor_version == 1 && !pnet_h1_find(head, "host")) {
    conn_reject(rt, c, 400);
    return;
  }
  if (head->has_upgrade) {
    /* No upgrade support in this role: answer plainly and let the client
     * fall back (RFC 9110 §7.8 permits ignoring Upgrade). */
  }
  if (s->inflight >= s->max_inflight || s->state != SV_LISTENING) {
    conn_reject(rt, c, 503);
    return;
  }
  /* Body framing */
  pnet_h1_body_mode mode = PNET_H1_BODY_NONE;
  uint64_t length = 0;
  if (head->chunked) mode = PNET_H1_BODY_CHUNKED;
  else if (head->content_length > 0) {
    mode = PNET_H1_BODY_LENGTH;
    length = (uint64_t)head->content_length;
    if (length > s->max_body_bytes) {
      conn_reject(rt, c, 413);
      return;
    }
  }
  c->keep_alive = head->minor_version == 1 ? !head->connection_close : head->connection_keep_alive;
  c->head_method = pnet_ieq_n(head->method, head->method_len, "HEAD");
  c->req = rt->httpd_next_req++;
  if (rt->httpd_next_req <= 0) rt->httpd_next_req = 1;
  if (!deliver_request(rt, c, head, false)) {
    conn_reject(rt, c, 503);
    return;
  }
  c->req_delivered = true;
  s->inflight++;
  c->phase = CP_REQUEST;
  pnet_h1_body_init(&c->decoder, mode, length);
  if (head->expect_continue && mode != PNET_H1_BODY_NONE) {
    static const char cont[] = "HTTP/1.1 100 Continue\r\n\r\n";
    pnet_conn_write(rt, &c->conn, cont, sizeof cont - 1);
  }
  c->deadline = rt->now + s->handler_ms;
  c->deadline_kind = 2;
  /* Bytes after the head belong to the body. */
  size_t rest = c->rx_len - head->head_len;
  if (rest > 0) {
    if (mode == PNET_H1_BODY_NONE) {
      /* Pipelined bytes: pipelining is disabled; keep them for the next head
       * only after this response completes. */
      memmove(c->rx, c->rx + head->head_len, rest);
      c->rx_len = rest;
    } else {
      body_sink_ctx ctx = {rt, c, false, false};
      size_t used = pnet_h1_body_feed(&c->decoder, c->rx + head->head_len, rest, request_body_sink, &ctx);
      if (ctx.too_large) {
        req_abort(rt, c, PNET_ERROR_RESPONSE_TOO_LARGE);
        conn_reject(rt, c, 413);
        return;
      }
      if (ctx.oom) {
        req_abort(rt, c, PNET_ERROR_RESOURCE_LIMIT);
        conn_reject(rt, c, 503);
        return;
      }
      if (c->decoder.error) {
        req_abort(rt, c, PNET_ERROR_CLOSED);
        conn_reject(rt, c, 400);
        return;
      }
      size_t leftover = rest - used;
      memmove(c->rx, c->rx + head->head_len + used, leftover);
      c->rx_len = leftover;
    }
  } else {
    c->rx_len = 0;
  }
  if (c->decoder.done) body_finished(rt, c);
}

/* ------------------------------------------------------------------------ */
/* Response completion / keep-alive                                          */
/* ------------------------------------------------------------------------ */

static void response_finished(pnet_runtime *rt, pnet_httpd_conn *c) {
  c->response_complete = true;
  c->req_terminal = true;
  if (c->server->inflight > 0) c->server->inflight--;
  pnet_bq_free(rt, &c->rxq);
  c->visible_bytes = 0;
  c->dirty = false;
  if (!c->keep_alive || c->close_after || c->server->state != SV_LISTENING) {
    c->close_after = true;
    c->phase = CP_CLOSING;
    c->conn.read_wanted = false;
    pnet_conn_update_interest(rt, &c->conn);
    c->deadline = rt->now + c->server->close_ms;
    c->deadline_kind = 4;
    return;
  }
  if (c->decoder.done) {
    conn_start_head(rt, c);
    return;
  }
  /* Unread request body remains on the wire: drain a bounded amount before
   * reusing the connection, else close. */
  if (c->decoder.mode == PNET_H1_BODY_LENGTH && c->decoder.remaining > c->server->request_queue_bytes) {
    c->close_after = true;
    c->phase = CP_CLOSING;
    c->conn.read_wanted = false;
    pnet_conn_update_interest(rt, &c->conn);
    c->deadline = rt->now + c->server->close_ms;
    c->deadline_kind = 4;
    return;
  }
  c->phase = CP_DRAIN;
  c->conn.read_wanted = true;
  pnet_conn_update_interest(rt, &c->conn);
  c->deadline = rt->now + c->server->body_idle_ms;
  c->deadline_kind = 1;
}

/* ------------------------------------------------------------------------ */
/* Service                                                                   */
/* ------------------------------------------------------------------------ */

static void conn_read_head(pnet_runtime *rt, pnet_httpd_conn *c) {
  pnet_httpd_server *s = c->server;
  size_t max_head = s->max_header_bytes + rt->cfg.httpd_max_target_bytes + 64;
  for (;;) {
    /* Parse whatever we already have first (leftover from a previous request). */
    if (c->rx_len > 0) {
      pnet_h1_head head;
      int rc = pnet_h1_parse_head(c->rx, c->rx_len, true, s->max_header_bytes, rt->cfg.httpd_max_headers,
                                  rt->cfg.httpd_max_target_bytes, &head);
      if (rc == PNET_H1_OK) {
        on_request_head(rt, c, &head);
        return;
      }
      if (rc == PNET_H1_TOO_LARGE || rc == PNET_H1_TOO_MANY_FIELDS) { conn_reject(rt, c, 431); return; }
      if (rc == PNET_H1_TARGET_TOO_LONG) { conn_reject(rt, c, 414); return; }
      if (rc == PNET_H1_ERROR) { conn_reject(rt, c, 400); return; }
    }
    if (c->rx_len >= max_head) {
      conn_reject(rt, c, 431);
      return;
    }
    if (c->rx_cap < c->rx_len + 512) {
      size_t cap = c->rx_cap ? c->rx_cap * 2 : 1024;
      if (cap > max_head + 16) cap = max_head + 16;
      uint8_t *next = pnet_alloc(rt, cap);
      if (!next) { conn_reject(rt, c, 503); return; }
      if (c->rx) { memcpy(next, c->rx, c->rx_len); pnet_free(rt, c->rx, c->rx_cap); }
      c->rx = next;
      c->rx_cap = cap;
    }
    size_t want = c->rx_cap - c->rx_len;
    if (want > max_head - c->rx_len) want = max_head - c->rx_len;
    int n = pnet_conn_read(rt, &c->conn, c->rx + c->rx_len, want);
    if (n == PNET_IO_AGAIN) return;
    if (n <= 0) {
      /* EOF or error before a complete head: drop the connection silently. */
      c->phase = CP_CLOSING;
      c->close_after = true;
      c->deadline = rt->now;
      return;
    }
    c->rx_len += (size_t)n;
    /* An idle keep-alive connection that starts sending switches to the
     * header deadline. */
    if (c->deadline_kind == 3) {
      c->deadline = rt->now + s->header_ms;
      c->deadline_kind = 0;
    }
  }
}

static void conn_read_body(pnet_runtime *rt, pnet_httpd_conn *c) {
  pnet_httpd_server *s = c->server;
  uint8_t scratch[2048];
  for (int rounds = 0; rounds < 8; rounds++) {
    if (c->decoder.done || c->decoder.error) return;
    if (c->phase == CP_REQUEST) {
      size_t room = s->request_queue_bytes > c->rxq.bytes ? s->request_queue_bytes - c->rxq.bytes : 0;
      if (room == 0) {
        c->conn.read_wanted = false;
        pnet_conn_update_interest(rt, &c->conn);
        return;
      }
    }
    c->conn.read_wanted = true;
    /* Leftover bytes from the head buffer are consumed first. */
    const uint8_t *src;
    size_t src_len;
    bool from_rx = c->rx_len > 0;
    if (from_rx) {
      src = c->rx;
      src_len = c->rx_len;
    } else {
      int n = pnet_conn_read(rt, &c->conn, scratch, sizeof scratch);
      if (n == PNET_IO_AGAIN) {
        pnet_conn_update_interest(rt, &c->conn);
        return;
      }
      if (n == PNET_IO_EOF || n < 0) {
        if (c->decoder.mode == PNET_H1_BODY_CLOSE) {
          body_finished(rt, c);
        } else {
          req_abort(rt, c, PNET_ERROR_CLOSED);
          c->phase = CP_CLOSING;
          c->close_after = true;
          c->deadline = rt->now;
        }
        return;
      }
      src = scratch;
      src_len = (size_t)n;
      if (c->deadline_kind == 1) c->deadline = rt->now + s->body_idle_ms;
    }
    body_sink_ctx ctx = {rt, c, false, false};
    size_t used = pnet_h1_body_feed(&c->decoder, src, src_len, request_body_sink, &ctx);
    if (from_rx) {
      memmove(c->rx, c->rx + used, c->rx_len - used);
      c->rx_len -= used;
    } else if (used < src_len) {
      /* Bytes past the message end (pipelining) are kept for the next head. */
      size_t extra = src_len - used;
      if (c->rx_cap < extra) {
        uint8_t *next = pnet_alloc(rt, extra + 512);
        if (!next) { conn_reject(rt, c, 503); return; }
        if (c->rx) pnet_free(rt, c->rx, c->rx_cap);
        c->rx = next;
        c->rx_cap = extra + 512;
      }
      memcpy(c->rx, src + used, extra);
      c->rx_len = extra;
    }
    if (ctx.too_large) {
      req_abort(rt, c, PNET_ERROR_RESPONSE_TOO_LARGE);
      conn_reject(rt, c, 413);
      return;
    }
    if (ctx.oom) {
      req_abort(rt, c, PNET_ERROR_RESOURCE_LIMIT);
      conn_reject(rt, c, 503);
      return;
    }
    if (c->decoder.error) {
      req_abort(rt, c, PNET_ERROR_CLOSED);
      conn_reject(rt, c, 400);
      return;
    }
    if (c->decoder.done) {
      body_finished(rt, c);
      if (c->phase == CP_DRAIN) conn_start_head(rt, c);
      return;
    }
    if (from_rx && c->rx_len == 0) continue;
  }
}

/** While a delivered request waits for its response (body already read),
 * keep watching the socket so a peer disconnect aborts the request; bytes
 * that arrive are the next (pipelined) request and are held for later. */
static void conn_watch_peer(pnet_runtime *rt, pnet_httpd_conn *c) {
  pnet_httpd_server *s = c->server;
  size_t max_head = s->max_header_bytes + rt->cfg.httpd_max_target_bytes + 64;
  c->conn.read_wanted = c->rx_len < max_head;
  pnet_conn_update_interest(rt, &c->conn);
  if (!c->conn.read_wanted) return;
  if (c->rx_cap < c->rx_len + 256) {
    size_t cap = c->rx_cap ? c->rx_cap * 2 : 1024;
    if (cap > max_head + 16) cap = max_head + 16;
    uint8_t *next = pnet_alloc(rt, cap);
    if (!next) return;
    if (c->rx) { memcpy(next, c->rx, c->rx_len); pnet_free(rt, c->rx, c->rx_cap); }
    c->rx = next;
    c->rx_cap = cap;
  }
  int n = pnet_conn_read(rt, &c->conn, c->rx + c->rx_len, c->rx_cap - c->rx_len);
  if (n == PNET_IO_AGAIN) return;
  if (n <= 0) {
    if (c->req_delivered && !c->req_terminal) req_abort(rt, c, PNET_ERROR_CLOSED);
    c->phase = CP_CLOSING;
    c->close_after = true;
    c->deadline = 0;
    return;
  }
  c->rx_len += (size_t)n;
}

static void conn_service(pnet_runtime *rt, pnet_httpd_conn *c) {
  pnet_httpd_server *s = c->server;
  /* Flush pending output first. */
  if (!pnet_conn_flush(rt, &c->conn)) {
    if (c->req_delivered && !c->req_terminal) req_abort(rt, c, PNET_ERROR_CLOSED);
    c->phase = CP_CLOSING;
    c->close_after = true;
    c->deadline = rt->now;
  }
  if (c->drain_armed && c->conn.tx.bytes < rt->cfg.httpd_send_low_water_bytes && c->req_delivered && !c->req_terminal) {
    c->drain_armed = false;
    push_req_event(rt, "drain", c->req, NULL, 0, false, 0);
  }
  /* Deadlines */
  if (c->deadline && rt->now >= c->deadline) {
    switch (c->deadline_kind) {
      case 0: /* header */
      case 3: /* keep-alive idle */
        c->phase = CP_CLOSING;
        c->close_after = true;
        c->deadline = 0;
        break;
      case 1: /* body idle */
        if (c->req_delivered && !c->req_terminal) req_abort(rt, c, PNET_ERROR_TIMEOUT);
        c->phase = CP_CLOSING;
        c->close_after = true;
        c->deadline = 0;
        break;
      case 2: /* handler */
        if (!c->responded) {
          req_abort(rt, c, PNET_ERROR_TIMEOUT);
          conn_reject(rt, c, 503);
        } else {
          c->deadline = 0;
        }
        break;
      case 4: /* close flush */
        c->deadline = 0;
        break;
      default:
        c->deadline = 0;
    }
  }
  switch (c->phase) {
    case CP_HEAD:
      conn_read_head(rt, c);
      break;
    case CP_REQUEST:
      if (c->responded && c->response_complete) {
        /* handled by response_finished */
      } else if (!c->decoder.done && !c->decoder.error) {
        conn_read_body(rt, c);
      } else {
        conn_watch_peer(rt, c);
      }
      break;
    case CP_DRAIN:
      conn_read_body(rt, c);
      break;
    default:
      break;
  }
  if (c->phase == CP_CLOSING && (c->conn.tx.bytes == 0 || c->conn.tx_error || c->deadline == 0)) {
    server_unlink_conn(rt, c);
    return;
  }
  (void)s;
}

static void server_accept(pnet_runtime *rt, pnet_httpd_server *s) {
  if (s->state != SV_LISTENING) return;
  for (int i = 0; i < 4; i++) {
    if (s->conn_count >= s->max_connections) {
      if (s->accepting) {
        s->accepting = false;
        rt->driver.interest(rt->driver_ctx, s->listener, 0);
      }
      return;
    }
    if (!s->accepting) {
      s->accepting = true;
      rt->driver.interest(rt->driver_ctx, s->listener, PNET_INTEREST_READ);
    }
    pnet_addr peer;
    int err = 0;
    pnet_sock ns = rt->driver.accept(rt->driver_ctx, s->listener, &peer, &err);
    if (ns == PNET_SOCK_INVALID) return;
    pnet_httpd_conn *c = pnet_zalloc(rt, sizeof *c);
    if (!c) {
      rt->driver.close(rt->driver_ctx, ns);
      return;
    }
    c->server = s;
    pnet_conn_init(&c->conn);
    pnet_bq_init(&c->rxq);
    pnet_conn_adopt(rt, &c->conn, ns, &peer);
    c->next = s->conns;
    s->conns = c;
    s->conn_count++;
    conn_start_head(rt, c);
  }
}

static void server_close(pnet_runtime *rt, pnet_httpd_server *s) {
  if (s->state == SV_CLOSED) return;
  s->state = SV_CLOSED;
  if (s->listener != PNET_SOCK_INVALID) {
    rt->driver.close(rt->driver_ctx, s->listener);
    s->listener = PNET_SOCK_INVALID;
  }
  while (s->conns) {
    pnet_httpd_conn *c = s->conns;
    if (c->req_delivered && !c->req_terminal) req_abort(rt, c, PNET_ERROR_CLOSED);
    server_unlink_conn(rt, c);
  }
  push_server_event(rt, "closed", s->handle, NULL, 0, true);
  if (s->live_counted && rt->httpd_live > 0) rt->httpd_live--;
  s->live_counted = false;
}

static void server_service(pnet_runtime *rt, pnet_httpd_server *s) {
  if (s->state == SV_BINDING) {
    int err = 0;
    pnet_addr bound;
    pnet_sock l = rt->driver.listen(rt->driver_ctx, &s->bind_addr, s->backlog, &bound, &err);
    if (l == PNET_SOCK_INVALID) {
      const char *code = pnet_io_error_code(err);
      char cause[16];
      snprintf(cause, sizeof cause, "io:%d", err);
      push_server_error(rt, s->handle, code, "bind failed", cause);
      s->state = SV_CLOSED;
      if (s->live_counted && rt->httpd_live > 0) rt->httpd_live--;
      s->live_counted = false;
      return;
    }
    s->listener = l;
    s->bound = bound;
    s->state = SV_LISTENING;
    s->accepting = true;
    rt->driver.interest(rt->driver_ctx, l, PNET_INTEREST_READ);
    char addr[48];
    pnet_format_addr(&bound, addr, sizeof addr);
    char tail[96];
    int n = snprintf(tail, sizeof tail, ",\"address\":\"%s\",\"port\":%u", addr, (unsigned)bound.port);
    push_server_event(rt, "listening", s->handle, tail, (size_t)n, false);
  }
  if (s->state == SV_LISTENING) server_accept(rt, s);
  pnet_httpd_conn *c = s->conns;
  while (c) {
    pnet_httpd_conn *next = c->next;
    conn_service(rt, c);
    c = next;
  }
  if (s->state == SV_STOPPING) {
    bool inflight_left = false;
    for (pnet_httpd_conn *k = s->conns; k; k = k->next) {
      if (k->req_delivered && !k->req_terminal) inflight_left = true;
      else if (k->phase == CP_HEAD) {
        /* idle: close now */
        k->phase = CP_CLOSING;
        k->close_after = true;
        k->deadline = 0;
      }
    }
    if (!s->graceful || !inflight_left || rt->now >= s->stop_deadline) server_close(rt, s);
    else {
      /* close idle connections eagerly */
      pnet_httpd_conn *k = s->conns;
      while (k) {
        pnet_httpd_conn *nk = k->next;
        if (k->phase == CP_CLOSING) server_unlink_conn(rt, k);
        k = nk;
      }
    }
  }
}

void pnet_httpd_service(pnet_runtime *rt) {
  pnet_httpd_server *s = rt->httpd_servers;
  while (s) {
    pnet_httpd_server *next = s->next;
    server_service(rt, s);
    s = next;
  }
  /* Retire closed servers. */
  pnet_httpd_server **pp = &rt->httpd_servers;
  while (*pp) {
    pnet_httpd_server *cur = *pp;
    if (cur->state == SV_CLOSED && cur->conns == NULL) {
      *pp = cur->next;
      pnet_free(rt, cur, sizeof *cur);
      continue;
    }
    pp = &cur->next;
  }
}

uint64_t pnet_httpd_next_deadline(pnet_runtime *rt) {
  uint64_t d = 0;
  for (pnet_httpd_server *s = rt->httpd_servers; s; s = s->next) {
    if (s->state == SV_STOPPING) d = pnet_min_deadline(d, s->stop_deadline);
    for (pnet_httpd_conn *c = s->conns; c; c = c->next)
      if (c->deadline) d = pnet_min_deadline(d, c->deadline);
  }
  return d;
}

bool pnet_httpd_has_output(pnet_runtime *rt) {
  for (pnet_httpd_server *s = rt->httpd_servers; s; s = s->next)
    for (pnet_httpd_conn *c = s->conns; c; c = c->next)
      if (c->conn.state == PNET_CONN_OPEN && c->conn.tx.bytes > 0) return true;
  return false;
}

void pnet_httpd_freeze(pnet_runtime *rt) {
  for (pnet_httpd_server *s = rt->httpd_servers; s; s = s->next) {
    for (pnet_httpd_conn *c = s->conns; c; c = c->next) {
      if (c->dirty && c->req_delivered && !c->req_terminal) {
        c->dirty = false;
        c->visible_bytes = c->rxq.bytes;
        pnet_queue_push_readable(rt, &rt->httpd_queue, c->req, "req", c->visible_bytes);
      }
    }
  }
}

void pnet_httpd_quiesce(pnet_runtime *rt) {
  for (pnet_httpd_server *s = rt->httpd_servers; s; s = s->next) {
    if (s->state == SV_BINDING) {
      s->state = SV_CLOSED;
      push_server_error(rt, s->handle, PNET_ERROR_CLOSED, "runtime closing", NULL);
    } else if (s->state != SV_CLOSED) {
      server_close(rt, s);
    }
  }
}

void pnet_httpd_init(pnet_runtime *rt) {
  pnet_sb sb;
  pnet_sb_init(&sb);
  const pnet_runtime_config *c = &rt->cfg;
  pnet_sb_printf(rt, &sb,
                 "{\"specMajor\":%d,\"specMinor\":%d,\"maxServers\":%u,\"maxConnections\":%u,\"maxInflight\":%u,"
                 "\"maxTlsInflight\":0,\"maxHeaders\":%u,\"maxHeaderBytes\":%zu,\"maxTargetBytes\":%zu,"
                 "\"defaultRequestQueueBytes\":%zu,\"maxRequestQueueBytes\":%zu,\"maxSendQueueBytes\":%zu,"
                 "\"sendHighWaterBytes\":%zu,\"sendLowWaterBytes\":%zu,\"maxEventsPerTick\":%u,\"maxTickBytes\":%zu,"
                 "\"defaultHeaderMs\":%u,\"defaultBodyIdleMs\":%u,\"defaultHandlerMs\":%u,\"defaultKeepAliveMs\":%u,"
                 "\"defaultCloseMs\":%u,\"maxTimeoutMs\":%u,\"tlsMinVersion\":\"%s\",\"features\":[]}",
                 PHTTPD_SPEC_MAJOR, PHTTPD_SPEC_MINOR, c->httpd_max_servers, c->httpd_max_connections, c->httpd_max_inflight,
                 c->httpd_max_headers, c->httpd_max_header_bytes, c->httpd_max_target_bytes,
                 c->httpd_default_request_queue_bytes, c->httpd_max_request_queue_bytes, c->httpd_max_send_queue_bytes,
                 c->httpd_send_high_water_bytes, c->httpd_send_low_water_bytes, c->httpd_max_events_per_tick,
                 c->httpd_max_tick_bytes, PHTTPD_DEFAULT_HEADER_MS, PHTTPD_DEFAULT_BODY_IDLE_MS, PHTTPD_DEFAULT_HANDLER_MS,
                 PHTTPD_DEFAULT_KEEP_ALIVE_MS, PHTTPD_DEFAULT_CLOSE_MS, PHTTPD_MAX_TIMEOUT_MS, PNET_TLS_MIN_VERSION);
  rt->httpd_limits_json = sb.failed ? NULL : pnet_strdup_n(rt, sb.data, sb.len);
  pnet_sb_free(rt, &sb);
}

void pnet_httpd_shutdown(pnet_runtime *rt) {
  while (rt->httpd_servers) {
    pnet_httpd_server *s = rt->httpd_servers;
    rt->httpd_servers = s->next;
    if (s->listener != PNET_SOCK_INVALID) rt->driver.close(rt->driver_ctx, s->listener);
    while (s->conns) {
      pnet_httpd_conn *c = s->conns;
      s->conns = c->next;
      conn_free(rt, c);
    }
    pnet_free(rt, s, sizeof *s);
  }
  if (rt->httpd_limits_json) pnet_free_str(rt, rt->httpd_limits_json);
  rt->httpd_limits_json = NULL;
  rt->httpd_live = 0;
}

/* ------------------------------------------------------------------------ */
/* Guest ops                                                                 */
/* ------------------------------------------------------------------------ */

static int refuse(pnet_runtime *rt, const char *code, const char *message) {
  pnet_set_last_error(rt, &rt->httpd_last_error, code, message);
  return -1;
}

static bool read_limit(const pnet_jdoc *doc, int obj, const char *key, size_t fallback, size_t max, size_t *out) {
  int node = pnet_json_get(doc, obj, key);
  if (node < 0) {
    *out = fallback;
    return true;
  }
  int64_t v;
  if (!pnet_json_i64(doc, node, &v) || v < 1 || (uint64_t)v > max) return false;
  *out = (size_t)v;
  return true;
}

static bool read_ms(const pnet_jdoc *doc, int obj, const char *key, uint32_t fallback, uint32_t *out) {
  int node = pnet_json_get(doc, obj, key);
  if (node < 0) {
    *out = fallback;
    return true;
  }
  int64_t v;
  if (!pnet_json_i64(doc, node, &v) || v < 1 || v > PHTTPD_MAX_TIMEOUT_MS) return false;
  *out = (uint32_t)v;
  return true;
}

int pnet_httpd_listen(pnet_runtime *rt, const char *meta_json) {
  if (rt->quiesced) return refuse(rt, PNET_ERROR_CLOSED, "runtime is closing");
  if (rt->httpd_live >= rt->cfg.httpd_max_servers) return refuse(rt, PNET_ERROR_RESOURCE_LIMIT, "too many servers");
  if (!meta_json) return refuse(rt, PNET_ERROR_INVALID_REQUEST, "missing metadata");
  int cap = 128;
  pnet_jnode *nodes = pnet_alloc(rt, (size_t)cap * sizeof(pnet_jnode));
  if (!nodes) return refuse(rt, PNET_ERROR_RESOURCE_LIMIT, "out of memory");
  pnet_jdoc doc;
  int root = pnet_json_parse(&doc, nodes, cap, meta_json, strlen(meta_json));
  int result = -1;
  pnet_httpd_server *s = NULL;
  char buf[128];
  size_t blen;
  int64_t v;
  if (root < 0 || pnet_json_type(&doc, root) != PNET_J_OBJECT) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "malformed listen metadata"); goto out; }
  s = pnet_zalloc(rt, sizeof *s);
  if (!s) { refuse(rt, PNET_ERROR_RESOURCE_LIMIT, "out of memory"); goto out; }
  s->listener = PNET_SOCK_INVALID;
  if (!pnet_json_string(&doc, pnet_json_get(&doc, root, "address"), buf, sizeof buf, &blen) ||
      !pnet_parse_ip_literal(buf, blen, &s->bind_addr)) {
    refuse(rt, PNET_ERROR_INVALID_REQUEST, "address must be an IP literal");
    goto out;
  }
  if (!pnet_json_i64(&doc, pnet_json_get(&doc, root, "port"), &v) || v < 0 || v > 65535) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid port"); goto out; }
  s->bind_addr.port = (uint16_t)v;
  if (pnet_json_get(&doc, root, "tls") >= 0) { refuse(rt, PNET_ERROR_UNSUPPORTED, "this host does not provide network.http.server.tls"); goto out; }
  if (!rt->policy.insecure_transport) { refuse(rt, PNET_ERROR_PERMISSION_DENIED, "insecureTransport is not enabled"); goto out; }
  if (!pnet_policy_allows_listen(&rt->policy, PNET_PROTO_HTTP, &s->bind_addr, s->bind_addr.port)) {
    refuse(rt, PNET_ERROR_PERMISSION_DENIED, "address/port is not an allowed listen rule");
    goto out;
  }
  s->backlog = 4;
  {
    int node = pnet_json_get(&doc, root, "backlog");
    if (node >= 0) {
      if (!pnet_json_i64(&doc, node, &v) || v < 1 || v > PHTTPD_MAX_BACKLOG) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid backlog"); goto out; }
      s->backlog = (int)v;
    }
  }
  {
    int lim = pnet_json_get(&doc, root, "limits");
    if (lim >= 0 && pnet_json_type(&doc, lim) != PNET_J_OBJECT) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid limits"); goto out; }
    size_t tmp;
    if (!read_limit(&doc, lim, "maxConnections", rt->cfg.httpd_max_connections, rt->cfg.httpd_max_connections, &tmp)) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid limits.maxConnections"); goto out; }
    s->max_connections = (uint32_t)tmp;
    if (!read_limit(&doc, lim, "maxInflight", rt->cfg.httpd_max_inflight, rt->cfg.httpd_max_inflight, &tmp)) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid limits.maxInflight"); goto out; }
    s->max_inflight = (uint32_t)tmp;
    if (!read_limit(&doc, lim, "maxHeaderBytes", rt->cfg.httpd_max_header_bytes, rt->cfg.httpd_max_header_bytes, &s->max_header_bytes)) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid limits.maxHeaderBytes"); goto out; }
    if (!read_limit(&doc, lim, "requestQueueBytes", rt->cfg.httpd_default_request_queue_bytes, rt->cfg.httpd_max_request_queue_bytes, &s->request_queue_bytes)) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid limits.requestQueueBytes"); goto out; }
    if (!read_limit(&doc, lim, "sendQueueBytes", rt->cfg.httpd_max_send_queue_bytes, rt->cfg.httpd_max_send_queue_bytes, &s->send_queue_bytes)) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid limits.sendQueueBytes"); goto out; }
    int mb = pnet_json_get(&doc, lim, "maxBodyBytes");
    s->max_body_bytes = SIZE_MAX;
    if (mb >= 0) {
      if (!pnet_json_i64(&doc, mb, &v) || v < 0) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid limits.maxBodyBytes"); goto out; }
      s->max_body_bytes = (size_t)v;
    }
  }
  {
    int t = pnet_json_get(&doc, root, "timeouts");
    if (t >= 0 && pnet_json_type(&doc, t) != PNET_J_OBJECT) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid timeouts"); goto out; }
    if (!read_ms(&doc, t, "headerMs", PHTTPD_DEFAULT_HEADER_MS, &s->header_ms) ||
        !read_ms(&doc, t, "bodyIdleMs", PHTTPD_DEFAULT_BODY_IDLE_MS, &s->body_idle_ms) ||
        !read_ms(&doc, t, "handlerMs", PHTTPD_DEFAULT_HANDLER_MS, &s->handler_ms) ||
        !read_ms(&doc, t, "keepAliveMs", PHTTPD_DEFAULT_KEEP_ALIVE_MS, &s->keep_alive_ms) ||
        !read_ms(&doc, t, "closeMs", PHTTPD_DEFAULT_CLOSE_MS, &s->close_ms)) {
      refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid timeouts");
      goto out;
    }
  }
  s->handle = rt->httpd_next_handle++;
  if (rt->httpd_next_handle <= 0) rt->httpd_next_handle = 1;
  s->state = SV_BINDING;
  s->live_counted = true;
  rt->httpd_live++;
  s->next = rt->httpd_servers;
  rt->httpd_servers = s;
  result = s->handle;
  s = NULL;
out:
  if (s) pnet_free(rt, s, sizeof *s);
  pnet_free(rt, nodes, (size_t)cap * sizeof(pnet_jnode));
  return result;
}

int pnet_httpd_stop(pnet_runtime *rt, int handle, bool graceful, uint32_t timeout_ms) {
  pnet_httpd_server *s = server_find(rt, handle);
  if (!s || s->state == SV_STOPPING || s->state == SV_CLOSED) return -1;
  if (s->state == SV_BINDING) {
    /* Never listened: close immediately at the next service pass. */
    s->state = SV_STOPPING;
    s->graceful = false;
    s->stop_deadline = pnet_now(rt);
    return 0;
  }
  s->state = SV_STOPPING;
  s->graceful = graceful;
  s->stop_deadline = pnet_now(rt) + (timeout_ms ? timeout_ms : s->close_ms);
  s->accepting = false;
  if (s->listener != PNET_SOCK_INVALID) {
    rt->driver.close(rt->driver_ctx, s->listener);
    s->listener = PNET_SOCK_INVALID;
  }
  return 0;
}

static bool header_owned(const char *name, size_t len) {
  static const char *const owned[] = {"connection", "content-length", "transfer-encoding", "keep-alive", "upgrade",
                                      "trailer", "te"};
  for (size_t i = 0; i < sizeof owned / sizeof owned[0]; i++)
    if (pnet_ieq_n(name, len, owned[i])) return true;
  return false;
}

int pnet_httpd_respond(pnet_runtime *rt, int req, const char *meta_json, const uint8_t *body, size_t body_len) {
  pnet_httpd_conn *c = req_find(rt, req, NULL);
  if (!c || c->responded) return PHTTPD_SEND_INVALID_REQUEST;
  if (!meta_json) return PHTTPD_SEND_INVALID;
  int cap = 200;
  pnet_jnode *nodes = pnet_alloc(rt, (size_t)cap * sizeof(pnet_jnode));
  if (!nodes) return PHTTPD_SEND_INVALID;
  pnet_jdoc doc;
  int root = pnet_json_parse(&doc, nodes, cap, meta_json, strlen(meta_json));
  int result = PHTTPD_SEND_INVALID;
  pnet_sb sb;
  pnet_sb_init(&sb);
  int64_t status;
  if (root < 0 || !pnet_json_i64(&doc, pnet_json_get(&doc, root, "status"), &status) || status < 200 || status > 599) goto out;
  bool end = true;
  int endnode = pnet_json_get(&doc, root, "end");
  if (endnode >= 0) {
    if (pnet_json_type(&doc, endnode) != PNET_J_BOOL) goto out;
    end = doc.nodes[endnode].truthy;
  }
  /* A null-body status (Fetch: 101/103/204/205/304) never carries content;
   * 1xx cannot be sent through respond at all (status >= 200 above). */
  bool no_body_status = pnet_status_is_null_body((int)status);
  if (no_body_status && (body_len > 0 || !end)) goto out;
  int64_t content_length = -1;
  int cl = pnet_json_get(&doc, root, "contentLength");
  if (cl >= 0) {
    if (!pnet_json_i64(&doc, cl, &content_length) || content_length < 0) goto out;
    if (end && (uint64_t)content_length != body_len) goto out;
  }
  if (end && c->conn.tx.bytes + body_len > c->server->send_queue_bytes) {
    c->drain_armed = true;
    result = PHTTPD_SEND_BACKPRESSURE;
    goto out;
  }
  char reason[128] = {0};
  int st = pnet_json_get(&doc, root, "statusText");
  if (st >= 0) {
    size_t rl;
    if (!pnet_json_string(&doc, st, reason, sizeof reason, &rl)) goto out;
    for (size_t i = 0; i < rl; i++) {
      unsigned char ch = (unsigned char)reason[i];
      if ((ch < 0x20 && ch != '\t') || ch == 0x7f) goto out;
    }
  }
  if (!reason[0]) snprintf(reason, sizeof reason, "%s", reason_phrase((int)status));
  pnet_sb_printf(rt, &sb, "HTTP/1.1 %d %s\r\n", (int)status, reason);
  int headers = pnet_json_get(&doc, root, "headers");
  if (headers >= 0) {
    if (pnet_json_type(&doc, headers) != PNET_J_OBJECT) goto out;
    uint32_t count = 0;
    for (int k = pnet_json_first(&doc, headers); k >= 0; k = pnet_json_next(&doc, k)) {
      char name[128];
      size_t nl;
      if (!pnet_json_string(&doc, k, name, sizeof name, &nl) || !pnet_is_token(name, nl)) goto out;
      if (header_owned(name, nl)) continue;
      size_t vl;
      char *value = pnet_json_string_dup(rt, &doc, doc.nodes[k].first_child, &vl);
      if (!value) goto out;
      bool bad = false;
      for (size_t i = 0; i < vl; i++) {
        unsigned char ch = (unsigned char)value[i];
        if ((ch < 0x20 && ch != '\t') || ch == 0x7f) bad = true;
      }
      if (bad || ++count > rt->cfg.httpd_max_headers) {
        pnet_free_str(rt, value);
        goto out;
      }
      pnet_sb_append(rt, &sb, name, nl);
      pnet_sb_puts(rt, &sb, ": ");
      pnet_sb_append(rt, &sb, value, vl);
      pnet_sb_puts(rt, &sb, "\r\n");
      pnet_free_str(rt, value);
    }
  }
  bool chunked = false;
  if (end) {
    if (!no_body_status || body_len > 0) pnet_sb_printf(rt, &sb, "Content-Length: %zu\r\n", body_len);
  } else if (content_length >= 0) {
    pnet_sb_printf(rt, &sb, "Content-Length: %lld\r\n", (long long)content_length);
  } else {
    pnet_sb_puts(rt, &sb, "Transfer-Encoding: chunked\r\n");
    chunked = true;
  }
  bool keep = c->keep_alive && c->server->state == SV_LISTENING;
  pnet_sb_puts(rt, &sb, keep ? "Connection: keep-alive\r\n\r\n" : "Connection: close\r\n\r\n");
  if (sb.failed) goto out;
  if (!pnet_conn_write(rt, &c->conn, sb.data, sb.len)) goto out;
  if (body_len > 0 && !c->head_method) {
    if (!pnet_conn_write(rt, &c->conn, body, body_len)) goto out;
  }
  c->responded = true;
  c->response_chunked = chunked;
  c->response_remaining = content_length;
  if (!keep) c->close_after = true;
  c->deadline = 0;
  result = PHTTPD_SEND_ACCEPTED;
  if (end) response_finished(rt, c);
out:
  pnet_sb_free(rt, &sb);
  pnet_free(rt, nodes, (size_t)cap * sizeof(pnet_jnode));
  return result;
}

int pnet_httpd_write(pnet_runtime *rt, int req, const uint8_t *chunk, size_t len) {
  pnet_httpd_conn *c = req_find(rt, req, NULL);
  if (!c || !c->responded || c->response_complete) return PHTTPD_SEND_INVALID_REQUEST;
  if (len > c->server->send_queue_bytes) return PHTTPD_SEND_INVALID;
  if (c->response_remaining >= 0 && (int64_t)len > c->response_remaining) return PHTTPD_SEND_INVALID;
  size_t overhead = c->response_chunked ? 20 : 0;
  if (c->conn.tx.bytes + len + overhead > c->server->send_queue_bytes) {
    c->drain_armed = true;
    return PHTTPD_SEND_BACKPRESSURE;
  }
  if (len == 0) return PHTTPD_SEND_ACCEPTED;
  if (!c->head_method) {
    if (c->response_chunked) {
      char size_line[24];
      int n = snprintf(size_line, sizeof size_line, "%zx\r\n", len);
      if (!pnet_conn_write(rt, &c->conn, size_line, (size_t)n)) return PHTTPD_SEND_INVALID_REQUEST;
    }
    if (!pnet_conn_write(rt, &c->conn, chunk, len)) return PHTTPD_SEND_INVALID_REQUEST;
    if (c->response_chunked && !pnet_conn_write(rt, &c->conn, "\r\n", 2)) return PHTTPD_SEND_INVALID_REQUEST;
  }
  if (c->response_remaining >= 0) c->response_remaining -= (int64_t)len;
  return PHTTPD_SEND_ACCEPTED;
}

int pnet_httpd_end_body(pnet_runtime *rt, int req) {
  pnet_httpd_conn *c = req_find(rt, req, NULL);
  if (!c || !c->responded || c->response_complete) return -1;
  if (c->response_remaining > 0) {
    /* Short body: the framing promise cannot be kept; close the connection. */
    req_abort(rt, c, PNET_ERROR_CANCELLED);
    c->phase = CP_CLOSING;
    c->close_after = true;
    c->deadline = pnet_now(rt);
    return -1;
  }
  if (c->response_chunked && !c->head_method) pnet_conn_write(rt, &c->conn, "0\r\n\r\n", 5);
  response_finished(rt, c);
  return 0;
}

int pnet_httpd_read_into(pnet_runtime *rt, int req, uint8_t *dst, size_t len) {
  pnet_httpd_conn *c = req_find(rt, req, NULL);
  if (!c) return -1;
  size_t want = len < c->visible_bytes ? len : c->visible_bytes;
  size_t got = pnet_bq_read(rt, &c->rxq, dst, want);
  c->visible_bytes -= got;
  if (c->phase == CP_REQUEST && !c->conn.read_wanted && c->rxq.bytes < c->server->request_queue_bytes) {
    c->conn.read_wanted = true;
    pnet_conn_update_interest(rt, &c->conn);
  }
  return (int)got;
}

void pnet_httpd_abort(pnet_runtime *rt, int req) {
  pnet_httpd_conn *c = req_find(rt, req, NULL);
  if (!c) return;
  req_abort(rt, c, PNET_ERROR_CANCELLED);
  c->phase = CP_CLOSING;
  c->close_after = true;
  c->deadline = pnet_now(rt) + c->server->close_ms;
  c->deadline_kind = 4;
  c->conn.read_wanted = false;
  pnet_conn_update_interest(rt, &c->conn);
}

const char *pnet_httpd_poll(pnet_runtime *rt, size_t *len) {
  return pnet_queue_poll(rt, &rt->httpd_queue, len);
}

const char *pnet_httpd_poll_render(pnet_runtime *rt, size_t *len) {
  return pnet_queue_render(rt, &rt->httpd_queue, len);
}

void pnet_httpd_poll_consume(pnet_runtime *rt) {
  pnet_queue_consume(rt, &rt->httpd_queue);
}

const char *pnet_httpd_last_error(pnet_runtime *rt) {
  return pnet_sb_cstr(&rt->httpd_last_error);
}

const char *pnet_httpd_limits(pnet_runtime *rt) {
  return rt->httpd_limits_json ? rt->httpd_limits_json : "{}";
}
