/* HTTP Client core (`globalThis.net`, contracts/spec/net.ts v2).
 *
 * One pnet_http_req per handle: dial → send request → parse response head →
 * decode body into a bounded receive queue → `end`. Redirects run inside the
 * core with a fresh dial per hop and a policy re-check; every timeout is a
 * deadline on the host monotonic clock. Events (`headers`, `readable`,
 * `end`, `error`) go to the net queue and reach the guest only after
 * begin_tick(); body bytes cross only through pnet_http_read_into.
 */
#include <stdio.h>

#include "pnet_internal.h"

typedef enum req_state {
  RQ_DIALING = 0,
  RQ_SENDING,     /* request written / being flushed, waiting for the head */
  RQ_BODY,        /* head delivered, decoding body */
  RQ_ENDED,       /* terminal event pushed; kept until the queue is drained */
} req_state;

typedef struct pnet_http_req {
  struct pnet_http_req *next;
  int handle;
  uint8_t state;
  bool cancelled;
  bool terminal;      /* terminal event pushed */
  bool head_pushed;
  bool head_only;     /* HEAD or a status without a body */
  bool dirty;         /* new queued bytes since the last tick */
  bool redirected;
  bool live_counted;
  pnet_url url;
  char *method;
  size_t method_len;
  pnet_sb user_headers;   /* "name: value\r\n" lines */
  uint8_t *body;
  size_t body_len;
  bool body_dropped;
  uint8_t redirect_mode;  /* 0 follow, 1 manual, 2 error */
  uint32_t redirects_left;
  uint32_t connect_ms, headers_ms, idle_ms;
  uint64_t started_at;
  uint64_t total_deadline;
  uint64_t phase_deadline;
  size_t queue_bytes;
  size_t max_body_bytes;
  size_t body_total;
  bool insecure_tls;
  pnet_dial dial;
  pnet_conn conn;
  uint8_t *rx;
  size_t rx_len;
  size_t rx_cap;
  pnet_h1_body decoder;
  pnet_bq rxq;
  size_t visible_bytes;
} pnet_http_req;

static const char *const REDIRECT_MODES[] = {"follow", "manual", "error"};

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

static void req_free(pnet_runtime *rt, pnet_http_req *r) {
  pnet_dial_cancel(rt, &r->dial);
  pnet_conn_close(rt, &r->conn);
  pnet_url_free(rt, &r->url);
  if (r->method) pnet_free(rt, r->method, r->method_len + 1);
  pnet_sb_free(rt, &r->user_headers);
  if (r->body) pnet_free(rt, r->body, r->body_len);
  if (r->rx) pnet_free(rt, r->rx, r->rx_cap);
  pnet_bq_free(rt, &r->rxq);
  pnet_free(rt, r, sizeof *r);
}

static void req_unlink(pnet_runtime *rt, pnet_http_req *r) {
  pnet_http_req **pp = &rt->http_reqs;
  while (*pp && *pp != r) pp = &(*pp)->next;
  if (*pp) *pp = r->next;
  if (r->live_counted && rt->http_live > 0) rt->http_live--;
  r->live_counted = false;
  req_free(rt, r);
}

static pnet_http_req *req_find(pnet_runtime *rt, int handle) {
  for (pnet_http_req *r = rt->http_reqs; r; r = r->next)
    if (r->handle == handle) return r;
  return NULL;
}

/** Terminal failure: one error event, transport released. */
static void req_fail(pnet_runtime *rt, pnet_http_req *r, const char *code, const char *message, int cause) {
  if (r->terminal) return;
  r->terminal = true;
  r->state = RQ_ENDED;
  pnet_dial_cancel(rt, &r->dial);
  pnet_conn_close(rt, &r->conn);
  pnet_bq_free(rt, &r->rxq);
  r->visible_bytes = 0;
  r->dirty = false;
  char cause_text[16] = {0};
  if (cause) snprintf(cause_text, sizeof cause_text, "io:%d", cause);
  pnet_push_error_event(rt, &rt->http_queue, "h", r->handle, code, message, cause ? cause_text : NULL);
  if (r->live_counted && rt->http_live > 0) rt->http_live--;
  r->live_counted = false;
}

/** Message end: `end` event; the queue stays readable until drained. */
static void req_end(pnet_runtime *rt, pnet_http_req *r) {
  if (r->terminal) return;
  r->terminal = true;
  r->state = RQ_ENDED;
  pnet_conn_close(rt, &r->conn);
  size_t len = 0;
  char *json = pnet_event_json(rt, "end", "h", r->handle, NULL, 0, &len);
  pnet_queue_push(rt, &rt->http_queue, r->handle, true, 0, json, len);
  if (r->live_counted && rt->http_live > 0) rt->http_live--;
  r->live_counted = false;
}

static bool req_is_retirable(const pnet_http_req *r) {
  return r->state == RQ_ENDED && r->rxq.bytes == 0;
}

typedef struct sink_ctx {
  pnet_runtime *rt;
  pnet_http_req *r;
  bool failed;
  const char *fail_code;
} sink_ctx;

static bool sink_into_queue(void *vctx, const uint8_t *data, size_t len) {
  sink_ctx *ctx = vctx;
  pnet_http_req *r = ctx->r;
  if (r->body_total + len > r->max_body_bytes) {
    ctx->failed = true;
    ctx->fail_code = PNET_ERROR_RESPONSE_TOO_LARGE;
    return false;
  }
  if (!pnet_bq_push(ctx->rt, &r->rxq, data, len, ctx->rt->cfg.io_chunk_bytes)) {
    ctx->failed = true;
    ctx->fail_code = PNET_ERROR_RESOURCE_LIMIT;
    return false;
  }
  r->body_total += len;
  r->dirty = true;
  return true;
}

/* ------------------------------------------------------------------------ */
/* Request head                                                              */
/* ------------------------------------------------------------------------ */

static bool build_request(pnet_runtime *rt, pnet_http_req *r) {
  pnet_sb sb;
  pnet_sb_init(&sb);
  pnet_sb_append(rt, &sb, r->method, r->method_len);
  pnet_sb_putc(rt, &sb, ' ');
  pnet_sb_append(rt, &sb, r->url.path, r->url.path_len);
  pnet_sb_puts(rt, &sb, " HTTP/1.1\r\nHost: ");
  if (r->url.host_is_ipv6) pnet_sb_putc(rt, &sb, '[');
  pnet_sb_puts(rt, &sb, r->url.host);
  if (r->url.host_is_ipv6) pnet_sb_putc(rt, &sb, ']');
  if (r->url.port_explicit) pnet_sb_printf(rt, &sb, ":%u", (unsigned)r->url.port);
  pnet_sb_puts(rt, &sb, "\r\n");
  pnet_sb_append(rt, &sb, r->user_headers.data ? r->user_headers.data : "", r->user_headers.len);
  bool get_like = pnet_ieq_n(r->method, r->method_len, "GET") || pnet_ieq_n(r->method, r->method_len, "HEAD");
  if (r->body_len > 0 && !r->body_dropped) {
    pnet_sb_printf(rt, &sb, "Content-Length: %zu\r\n", r->body_len);
  } else if (!get_like && !pnet_ieq_n(r->method, r->method_len, "OPTIONS") && !pnet_ieq_n(r->method, r->method_len, "DELETE")) {
    pnet_sb_puts(rt, &sb, "Content-Length: 0\r\n");
  }
  pnet_sb_puts(rt, &sb, "Connection: close\r\n\r\n");
  bool ok = !sb.failed && pnet_conn_write(rt, &r->conn, sb.data, sb.len);
  if (ok && r->body_len > 0 && !r->body_dropped) ok = pnet_conn_write(rt, &r->conn, r->body, r->body_len);
  pnet_sb_free(rt, &sb);
  return ok;
}

/* ------------------------------------------------------------------------ */
/* Response head processing                                                  */
/* ------------------------------------------------------------------------ */

static bool push_headers_event(pnet_runtime *rt, pnet_http_req *r, const pnet_h1_head *head, int64_t length) {
  pnet_sb sb;
  pnet_sb_init(&sb);
  pnet_sb_printf(rt, &sb, ",\"status\":%d,\"url\":", head->status);
  pnet_sb tmp;
  pnet_sb_init(&tmp);
  pnet_url_write(rt, &tmp, &r->url);
  pnet_sb_json_string(rt, &sb, pnet_sb_cstr(&tmp), tmp.len);
  pnet_sb_free(rt, &tmp);
  pnet_sb_puts(rt, &sb, ",\"headers\":{");
  /* Combine repeated names with ", " (Set-Cookie included: the SDK splits it
   * back out with getSetCookie() only for values it can separate; keep the
   * wire order otherwise). */
  bool first = true;
  for (size_t i = 0; i < head->field_count; i++) {
    const pnet_h1_field *f = &head->fields[i];
    bool seen = false;
    for (size_t k = 0; k < i; k++) {
      if (head->fields[k].name_len == f->name_len && memcmp(head->fields[k].name, f->name, f->name_len) == 0) {
        seen = true;
        break;
      }
    }
    if (seen) continue;
    if (!first) pnet_sb_putc(rt, &sb, ',');
    first = false;
    pnet_sb_json_string(rt, &sb, f->name, f->name_len);
    pnet_sb_putc(rt, &sb, ':');
    bool set_cookie = f->name_len == 10 && memcmp(f->name, "set-cookie", 10) == 0;
    if (set_cookie) {
      /* Set-Cookie values never combine: deliver them as an array. */
      pnet_sb_putc(rt, &sb, '[');
      bool firstv = true;
      for (size_t k = i; k < head->field_count; k++) {
        const pnet_h1_field *g = &head->fields[k];
        if (g->name_len != f->name_len || memcmp(g->name, f->name, f->name_len) != 0) continue;
        if (!firstv) pnet_sb_putc(rt, &sb, ',');
        firstv = false;
        pnet_sb_json_string(rt, &sb, g->value, g->value_len);
      }
      pnet_sb_putc(rt, &sb, ']');
      continue;
    }
    /* Gather every value with this name. */
    pnet_sb value;
    pnet_sb_init(&value);
    bool firstv = true;
    for (size_t k = i; k < head->field_count; k++) {
      const pnet_h1_field *g = &head->fields[k];
      if (g->name_len != f->name_len || memcmp(g->name, f->name, f->name_len) != 0) continue;
      if (!firstv) pnet_sb_puts(rt, &value, ", ");
      firstv = false;
      pnet_sb_append(rt, &value, g->value, g->value_len);
    }
    pnet_sb_json_string(rt, &sb, pnet_sb_cstr(&value), value.len);
    pnet_sb_free(rt, &value);
  }
  pnet_sb_puts(rt, &sb, "},\"redirected\":");
  pnet_sb_puts(rt, &sb, r->redirected ? "true" : "false");
  if (length >= 0) pnet_sb_printf(rt, &sb, ",\"length\":%lld", (long long)length);
  size_t len = 0;
  char *json = sb.failed ? NULL : pnet_event_json(rt, "headers", "h", r->handle, sb.data, sb.len, &len);
  size_t weight = sb.len;
  pnet_sb_free(rt, &sb);
  if (!json) return false;
  return pnet_queue_push(rt, &rt->http_queue, r->handle, false, weight, json, len);
}

/** Apply redirect policy; returns true when a new hop was started (or the
 * request failed). false = treat as a normal response. */
static bool maybe_redirect(pnet_runtime *rt, pnet_http_req *r, const pnet_h1_head *head) {
  int st = head->status;
  bool to_get = false;
  if (!pnet_http_redirect_plan(st, r->method, r->method_len, &to_get)) return false;
  const pnet_h1_field *loc = pnet_h1_find(head, "location");
  if (!loc) return false;
  if (r->redirect_mode == 1) return false; /* manual: deliver as-is */
  if (r->redirect_mode == 2) {
    req_fail(rt, r, PNET_ERROR_REDIRECT, "redirect refused by policy", 0);
    return true;
  }
  if (r->redirects_left == 0) {
    req_fail(rt, r, PNET_ERROR_REDIRECT, "too many redirects", 0);
    return true;
  }
  pnet_url next;
  if (!pnet_url_resolve(rt, &r->url, loc->value, loc->value_len, &next)) {
    req_fail(rt, r, PNET_ERROR_REDIRECT, "invalid Location", 0);
    return true;
  }
  pnet_proto proto = pnet_proto_from_scheme(next.scheme);
  if (proto != PNET_PROTO_HTTP && proto != PNET_PROTO_HTTPS) {
    pnet_url_free(rt, &next);
    req_fail(rt, r, PNET_ERROR_REDIRECT, "redirect to a non-HTTP scheme", 0);
    return true;
  }
  if (proto == PNET_PROTO_HTTPS && !rt->has_features_tls) {
    pnet_url_free(rt, &next);
    req_fail(rt, r, PNET_ERROR_UNSUPPORTED, "redirect to https without network.http.client.tls", 0);
    return true;
  }
  if (!pnet_policy_allows_connect(&rt->policy, proto, next.host, next.port)) {
    pnet_url_free(rt, &next);
    req_fail(rt, r, PNET_ERROR_PERMISSION_DENIED, "redirect target is not an allowed endpoint", 0);
    return true;
  }
  /* Method / body rewriting on redirect (pnet_http_redirect_plan). */
  if (to_get) {
    pnet_free(rt, r->method, r->method_len + 1);
    r->method = pnet_strdup_n(rt, "GET", 3);
    r->method_len = 3;
    if (!r->method) {
      pnet_url_free(rt, &next);
      req_fail(rt, r, PNET_ERROR_RESOURCE_LIMIT, "out of memory", 0);
      return true;
    }
    if (r->body) {
      pnet_free(rt, r->body, r->body_len);
      r->body = NULL;
    }
    r->body_len = 0;
    r->body_dropped = true;
  }
  /* Header stripping: cross-origin drops credentials; GET conversion drops
   * content headers. Rebuild the user header block line by line. */
  bool cross_origin = !pnet_url_same_origin(&r->url, &next);
  if (cross_origin || to_get) {
    pnet_sb kept;
    pnet_sb_init(&kept);
    const char *lines = r->user_headers.data ? r->user_headers.data : "";
    size_t total = r->user_headers.len;
    size_t i = 0;
    while (i < total) {
      size_t j = i;
      while (j + 1 < total && !(lines[j] == '\r' && lines[j + 1] == '\n')) j++;
      size_t line_len = (j + 1 < total) ? j - i : total - i;
      const char *line = lines + i;
      const char *colon = memchr(line, ':', line_len);
      size_t nl = colon ? (size_t)(colon - line) : line_len;
      bool drop = false;
      if (cross_origin && (pnet_ieq_n(line, nl, "authorization") || pnet_ieq_n(line, nl, "proxy-authorization") ||
                           pnet_ieq_n(line, nl, "cookie")))
        drop = true;
      if (to_get && (pnet_ieq_n(line, nl, "content-type") || pnet_ieq_n(line, nl, "content-encoding") ||
                     pnet_ieq_n(line, nl, "content-language") || pnet_ieq_n(line, nl, "content-location")))
        drop = true;
      if (!drop) pnet_sb_append(rt, &kept, line, line_len + 2 <= total - i ? line_len + 2 : line_len);
      i = j + 2;
    }
    pnet_sb_free(rt, &r->user_headers);
    r->user_headers = kept;
  }
  pnet_url_free(rt, &r->url);
  r->url = next;
  r->redirects_left--;
  r->redirected = true;
  /* Fresh transport for the next hop. */
  pnet_conn_close(rt, &r->conn);
  pnet_conn_init(&r->conn);
  r->rx_len = 0;
  r->insecure_tls = r->insecure_tls; /* TLS policy carries over across the hop */
  r->state = RQ_DIALING;
  r->phase_deadline = rt->now + r->connect_ms;
  bool secure = strcmp(r->url.scheme, "https") == 0;
  if (!pnet_dial_start(rt, &r->dial, &r->conn, r->url.host, r->url.port, secure, r->url.host, !r->insecure_tls)) {
    req_fail(rt, r, r->dial.error_code ? r->dial.error_code : PNET_ERROR_CONNECT,
             r->dial.error_message ? r->dial.error_message : "redirect connect failed", r->dial.cause);
  }
  return true;
}

/** Handle a complete response head. Returns false when the request reached a
 * terminal state (failed or redirected) and the caller must stop. */
static bool on_head(pnet_runtime *rt, pnet_http_req *r, pnet_h1_head *head) {
  if (!pnet_h1_validate_framing(head)) {
    req_fail(rt, r, PNET_ERROR_PROTOCOL, "invalid response framing", 0);
    return false;
  }
  if (head->status >= 100 && head->status < 200) {
    /* Interim response: skip it and keep parsing (101 cannot happen: we never
     * request an upgrade; treat it as a protocol error). */
    if (head->status == 101) {
      req_fail(rt, r, PNET_ERROR_PROTOCOL, "unexpected 101 response", 0);
      return false;
    }
    size_t rest = r->rx_len - head->head_len;
    memmove(r->rx, r->rx + head->head_len, rest);
    r->rx_len = rest;
    return true; /* caller re-parses */
  }
  if (maybe_redirect(rt, r, head)) return false;
  /* Body framing (RFC 9112 §6.3). */
  bool head_only = pnet_ieq_n(r->method, r->method_len, "HEAD") || pnet_status_is_bodyless(head->status);
  int64_t length = -1;
  pnet_h1_body_mode mode;
  if (head_only) mode = PNET_H1_BODY_NONE;
  else if (head->chunked) mode = PNET_H1_BODY_CHUNKED;
  else if (head->content_length >= 0) {
    mode = PNET_H1_BODY_LENGTH;
    length = head->content_length;
  } else mode = PNET_H1_BODY_CLOSE;
  if (head_only && head->content_length >= 0) length = head->content_length;
  if (mode == PNET_H1_BODY_LENGTH && (uint64_t)length > r->max_body_bytes) {
    req_fail(rt, r, PNET_ERROR_RESPONSE_TOO_LARGE, "response exceeds maxBodyBytes", 0);
    return false;
  }
  if (!push_headers_event(rt, r, head, length)) {
    req_fail(rt, r, PNET_ERROR_RESOURCE_LIMIT, "out of memory", 0);
    return false;
  }
  r->head_pushed = true;
  r->head_only = head_only;
  pnet_h1_body_init(&r->decoder, mode, (uint64_t)(length < 0 ? 0 : length));
  r->state = RQ_BODY;
  r->phase_deadline = rt->now + r->idle_ms;
  /* Feed the bytes that followed the head. */
  size_t rest = r->rx_len - head->head_len;
  if (rest > 0 && !r->decoder.done) {
    sink_ctx ctx = {rt, r, false, NULL};
    size_t consumed = pnet_h1_body_feed(&r->decoder, r->rx + head->head_len, rest, sink_into_queue, &ctx);
    (void)consumed;
    if (ctx.failed) {
      req_fail(rt, r, ctx.fail_code, "response body limit", 0);
      return false;
    }
    if (r->decoder.error) {
      req_fail(rt, r, PNET_ERROR_PROTOCOL, "invalid chunked body", 0);
      return false;
    }
  }
  r->rx_len = 0;
  if (r->decoder.done) req_end(rt, r);
  return r->state == RQ_BODY;
}

/* ------------------------------------------------------------------------ */
/* Service                                                                   */
/* ------------------------------------------------------------------------ */

static void req_service_io(pnet_runtime *rt, pnet_http_req *r) {
  if (!pnet_conn_flush(rt, &r->conn)) {
    req_fail(rt, r, PNET_ERROR_CLOSED, "connection lost while sending", r->conn.last_error);
    return;
  }
  uint8_t scratch[2048];
  for (int rounds = 0; rounds < 8; rounds++) {
    if (r->state == RQ_SENDING) {
      /* Head phase: accumulate into rx up to the header limit. */
      size_t max_head = rt->cfg.http_max_header_bytes + 512;
      if (r->rx_len >= max_head) {
        req_fail(rt, r, PNET_ERROR_PROTOCOL, "response head too large", 0);
        return;
      }
      size_t want = sizeof scratch;
      if (want > max_head - r->rx_len) want = max_head - r->rx_len;
      int n = pnet_conn_read(rt, &r->conn, scratch, want);
      if (n == PNET_IO_AGAIN) return;
      if (n == PNET_IO_EOF) {
        req_fail(rt, r, PNET_ERROR_CLOSED, "connection closed before response head", 0);
        return;
      }
      if (n < 0) {
        req_fail(rt, r, PNET_ERROR_CLOSED, "read failed", n);
        return;
      }
      if (r->rx_len + (size_t)n > r->rx_cap) {
        size_t cap = r->rx_cap ? r->rx_cap : 1024;
        while (cap < r->rx_len + (size_t)n) cap *= 2;
        if (cap > max_head + 16) cap = max_head + 16;
        uint8_t *next = pnet_alloc(rt, cap);
        if (!next) {
          req_fail(rt, r, PNET_ERROR_RESOURCE_LIMIT, "out of memory", 0);
          return;
        }
        if (r->rx) {
          memcpy(next, r->rx, r->rx_len);
          pnet_free(rt, r->rx, r->rx_cap);
        }
        r->rx = next;
        r->rx_cap = cap;
      }
      memcpy(r->rx + r->rx_len, scratch, (size_t)n);
      r->rx_len += (size_t)n;
      for (;;) {
        pnet_h1_head head;
        int rc = pnet_h1_parse_head(r->rx, r->rx_len, false, rt->cfg.http_max_header_bytes, rt->cfg.http_max_headers,
                                    rt->cfg.httpd_max_target_bytes, &head);
        if (rc == PNET_H1_INCOMPLETE) break;
        if (rc != PNET_H1_OK) {
          req_fail(rt, r, PNET_ERROR_PROTOCOL, rc == PNET_H1_TOO_LARGE ? "response head too large" : "malformed response head", 0);
          return;
        }
        int before = r->state;
        bool cont = on_head(rt, r, &head);
        if (!cont) return;
        if (r->state == RQ_BODY || before != RQ_SENDING) break;
        /* interim response consumed; loop to parse the next head */
      }
      continue;
    }
    if (r->state == RQ_BODY) {
      size_t room = r->queue_bytes > r->rxq.bytes ? r->queue_bytes - r->rxq.bytes : 0;
      if (room == 0) {
        r->conn.read_wanted = false;
        pnet_conn_update_interest(rt, &r->conn);
        return;
      }
      r->conn.read_wanted = true;
      size_t want = sizeof scratch < room ? sizeof scratch : room;
      int n = pnet_conn_read(rt, &r->conn, scratch, want);
      if (n == PNET_IO_AGAIN) {
        pnet_conn_update_interest(rt, &r->conn);
        return;
      }
      if (n == PNET_IO_EOF) {
        if (r->decoder.mode == PNET_H1_BODY_CLOSE) {
          req_end(rt, r);
        } else {
          req_fail(rt, r, PNET_ERROR_CLOSED, "connection closed before the body ended", 0);
        }
        return;
      }
      if (n < 0) {
        req_fail(rt, r, PNET_ERROR_CLOSED, "read failed", n);
        return;
      }
      r->phase_deadline = rt->now + r->idle_ms;
      sink_ctx ctx = {rt, r, false, NULL};
      pnet_h1_body_feed(&r->decoder, scratch, (size_t)n, sink_into_queue, &ctx);
      if (ctx.failed) {
        req_fail(rt, r, ctx.fail_code, "response body limit", 0);
        return;
      }
      if (r->decoder.error) {
        req_fail(rt, r, PNET_ERROR_PROTOCOL, "invalid chunked body", 0);
        return;
      }
      if (r->decoder.done) {
        req_end(rt, r);
        return;
      }
      continue;
    }
    return;
  }
}

static void req_service(pnet_runtime *rt, pnet_http_req *r) {
  if (r->state == RQ_ENDED) return;
  if (rt->now >= r->total_deadline) {
    req_fail(rt, r, PNET_ERROR_TIMEOUT, "total timeout", 0);
    return;
  }
  if (r->state == RQ_DIALING) {
    if (rt->now >= r->phase_deadline) {
      req_fail(rt, r, PNET_ERROR_TIMEOUT, "connect timeout", 0);
      return;
    }
    int st = pnet_dial_step(rt, &r->dial, &r->conn);
    if (st == PNET_DIAL_FAILED) {
      req_fail(rt, r, r->dial.error_code ? r->dial.error_code : PNET_ERROR_CONNECT, "connect failed", r->dial.cause);
      return;
    }
    if (st != PNET_DIAL_OPEN) return;
    if (!build_request(rt, r)) {
      req_fail(rt, r, PNET_ERROR_RESOURCE_LIMIT, "out of memory", 0);
      return;
    }
    r->state = RQ_SENDING;
    r->phase_deadline = rt->now + r->headers_ms;
  }
  if (r->state == RQ_SENDING && rt->now >= r->phase_deadline) {
    req_fail(rt, r, PNET_ERROR_TIMEOUT, "response headers timeout", 0);
    return;
  }
  if (r->state == RQ_BODY && rt->now >= r->phase_deadline) {
    req_fail(rt, r, PNET_ERROR_TIMEOUT, "body idle timeout", 0);
    return;
  }
  req_service_io(rt, r);
}

void pnet_http_service(pnet_runtime *rt) {
  pnet_http_req *r = rt->http_reqs;
  while (r) {
    pnet_http_req *next = r->next;
    req_service(rt, r);
    if (req_is_retirable(r) && !r->dirty) req_unlink(rt, r);
    r = next;
  }
}

uint64_t pnet_http_next_deadline(pnet_runtime *rt) {
  uint64_t d = 0;
  for (pnet_http_req *r = rt->http_reqs; r; r = r->next) {
    if (r->state == RQ_ENDED) continue;
    d = pnet_min_deadline(d, r->total_deadline);
    d = pnet_min_deadline(d, r->phase_deadline);
  }
  return d;
}

bool pnet_http_has_output(pnet_runtime *rt) {
  for (pnet_http_req *r = rt->http_reqs; r; r = r->next)
    if (r->conn.state == PNET_CONN_OPEN && r->conn.tx.bytes > 0) return true;
  return false;
}

void pnet_http_freeze(pnet_runtime *rt) {
  for (pnet_http_req *r = rt->http_reqs; r; r = r->next) {
    if (r->dirty && r->head_pushed) {
      r->dirty = false;
      r->visible_bytes = r->rxq.bytes;
      pnet_queue_push_readable(rt, &rt->http_queue, r->handle, "h", r->visible_bytes);
    }
  }
}

void pnet_http_quiesce(pnet_runtime *rt) {
  for (pnet_http_req *r = rt->http_reqs; r; r = r->next) {
    if (!r->terminal) req_fail(rt, r, PNET_ERROR_CANCELLED, "runtime closing", 0);
  }
}

void pnet_http_init(pnet_runtime *rt) {
  pnet_sb sb;
  pnet_sb_init(&sb);
  const pnet_runtime_config *c = &rt->cfg;
  pnet_sb_printf(rt, &sb,
                 "{\"specMajor\":%d,\"specMinor\":%d,\"maxInflight\":%u,\"maxTlsInflight\":%u,"
                 "\"maxRequestBytes\":%zu,\"defaultQueueBytes\":%zu,\"maxQueueBytes\":%zu,"
                 "\"defaultAggregateBytes\":%zu,\"maxAggregateBytes\":%zu,\"maxEventsPerTick\":%u,"
                 "\"maxTickBytes\":%zu,\"maxHeaders\":%u,\"maxHeaderBytes\":%zu,\"defaultTimeoutMs\":%u,"
                 "\"maxTimeoutMs\":%u,\"maxRedirects\":%u,\"tlsMinVersion\":\"%s\",\"features\":[%s]}",
                 PNET_SPEC_MAJOR, PNET_SPEC_MINOR, c->http_max_inflight, rt->has_features_tls ? c->http_max_inflight : 0,
                 c->http_max_request_bytes, c->http_default_queue_bytes, c->http_max_queue_bytes,
                 c->http_default_aggregate_bytes, c->http_max_aggregate_bytes, c->http_max_events_per_tick,
                 c->http_max_tick_bytes, c->http_max_headers, c->http_max_header_bytes, c->http_default_timeout_ms,
                 c->http_max_timeout_ms, c->http_max_redirects, PNET_TLS_MIN_VERSION, rt->has_features_tls ? "\"tls\"" : "");
  rt->http_limits_json = sb.failed ? NULL : pnet_strdup_n(rt, sb.data, sb.len);
  pnet_sb_free(rt, &sb);
}

void pnet_http_shutdown(pnet_runtime *rt) {
  while (rt->http_reqs) {
    pnet_http_req *r = rt->http_reqs;
    rt->http_reqs = r->next;
    req_free(rt, r);
  }
  if (rt->http_limits_json) pnet_free_str(rt, rt->http_limits_json);
  rt->http_limits_json = NULL;
  rt->http_live = 0;
}

/* ------------------------------------------------------------------------ */
/* Guest ops                                                                 */
/* ------------------------------------------------------------------------ */

static int refuse(pnet_runtime *rt, const char *code, const char *message) {
  pnet_set_last_error(rt, &rt->http_last_error, code, message);
  return -1;
}

static bool read_timeout(pnet_runtime *rt, const pnet_jdoc *doc, int obj, const char *key, uint32_t fallback, uint32_t *out) {
  int node = pnet_json_get(doc, obj, key);
  if (node < 0) {
    *out = fallback;
    return true;
  }
  int64_t v;
  if (!pnet_json_i64(doc, node, &v) || v < 1 || v > (int64_t)rt->cfg.http_max_timeout_ms) return false;
  *out = (uint32_t)v;
  return true;
}

int pnet_http_start(pnet_runtime *rt, const char *meta_json, const uint8_t *body, size_t body_len) {
  if (rt->quiesced) return refuse(rt, PNET_ERROR_CLOSED, "runtime is closing");
  if (rt->http_live >= rt->cfg.http_max_inflight) return refuse(rt, PNET_ERROR_RESOURCE_LIMIT, "too many requests in flight");
  if (body_len > rt->cfg.http_max_request_bytes) return refuse(rt, PNET_ERROR_RESOURCE_LIMIT, "request body too large");
  if (!meta_json) return refuse(rt, PNET_ERROR_INVALID_REQUEST, "missing metadata");
  size_t meta_len = strlen(meta_json);
  int cap = 320;
  pnet_jnode *nodes = pnet_alloc(rt, (size_t)cap * sizeof(pnet_jnode));
  if (!nodes) return refuse(rt, PNET_ERROR_RESOURCE_LIMIT, "out of memory");
  pnet_jdoc doc;
  int root = pnet_json_parse(&doc, nodes, cap, meta_json, meta_len);
  int result = -1;
  pnet_http_req *r = NULL;
  char buf[520];
  size_t blen;
  if (root < 0 || pnet_json_type(&doc, root) != PNET_J_OBJECT) {
    refuse(rt, PNET_ERROR_INVALID_REQUEST, "malformed request metadata");
    goto out;
  }
  r = pnet_zalloc(rt, sizeof *r);
  if (!r) {
    refuse(rt, PNET_ERROR_RESOURCE_LIMIT, "out of memory");
    goto out;
  }
  pnet_conn_init(&r->conn);
  pnet_bq_init(&r->rxq);
  pnet_sb_init(&r->user_headers);
  /* url */
  {
    int node = pnet_json_get(&doc, root, "url");
    char *url = pnet_json_string_dup(rt, &doc, node, &blen);
    if (!url) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "url required"); goto out; }
    bool ok = pnet_url_parse(rt, url, blen, &r->url);
    pnet_free_str(rt, url);
    if (!ok) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid url"); goto out; }
    pnet_proto proto = pnet_proto_from_scheme(r->url.scheme);
    if (proto != PNET_PROTO_HTTP && proto != PNET_PROTO_HTTPS) {
      refuse(rt, PNET_ERROR_INVALID_REQUEST, "url must be http: or https:");
      goto out;
    }
    if (proto == PNET_PROTO_HTTPS && !rt->has_features_tls) {
      refuse(rt, PNET_ERROR_UNSUPPORTED, "this host does not provide network.http.client.tls");
      goto out;
    }
    if (pnet_proto_is_plaintext(proto) && !rt->policy.insecure_transport) {
      refuse(rt, PNET_ERROR_PERMISSION_DENIED, "insecureTransport is not enabled");
      goto out;
    }
    if (!pnet_policy_allows_connect(&rt->policy, proto, r->url.host, r->url.port)) {
      refuse(rt, PNET_ERROR_PERMISSION_DENIED, "endpoint is not an allowed connect rule");
      goto out;
    }
  }
  /* method */
  {
    int node = pnet_json_get(&doc, root, "method");
    if (!pnet_json_string(&doc, node, buf, sizeof buf, &blen) || !pnet_is_token(buf, blen)) {
      refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid method");
      goto out;
    }
    static const char *const forbidden[] = PNET_METHODS_FORBIDDEN;
    for (size_t i = 0; i < PNET_METHODS_FORBIDDEN_COUNT; i++) {
      if (pnet_ieq_n(buf, blen, forbidden[i])) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "method not allowed"); goto out; }
    }
    r->method = pnet_strdup_n(rt, buf, blen);
    r->method_len = blen;
    if (!r->method) { refuse(rt, PNET_ERROR_RESOURCE_LIMIT, "out of memory"); goto out; }
    if ((pnet_ieq_n(buf, blen, "GET") || pnet_ieq_n(buf, blen, "HEAD")) && body_len > 0) {
      refuse(rt, PNET_ERROR_INVALID_REQUEST, "GET/HEAD cannot carry a body");
      goto out;
    }
  }
  /* headers */
  {
    int node = pnet_json_get(&doc, root, "headers");
    uint32_t count = 0;
    size_t bytes = 0;
    if (node >= 0) {
      if (pnet_json_type(&doc, node) != PNET_J_OBJECT) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "headers must be an object"); goto out; }
      for (int k = pnet_json_first(&doc, node); k >= 0; k = pnet_json_next(&doc, k)) {
        char name[128];
        size_t nlen;
        if (!pnet_json_string(&doc, k, name, sizeof name, &nlen) || !pnet_is_token(name, nlen)) {
          refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid header name");
          goto out;
        }
        pnet_lower(name, nlen);
        static const char *const owned[] = PNET_HTTP_CORE_OWNED_REQUEST_HEADERS;
        bool skip = false;
        for (size_t i = 0; i < PNET_HTTP_CORE_OWNED_REQUEST_HEADERS_COUNT; i++)
          if (strcmp(name, owned[i]) == 0) skip = true;
        int vnode = doc.nodes[k].first_child;
        size_t vlen;
        char *value = pnet_json_string_dup(rt, &doc, vnode, &vlen);
        if (!value) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid header value"); goto out; }
        bool bad = false;
        for (size_t i = 0; i < vlen; i++) {
          unsigned char c = (unsigned char)value[i];
          if ((c < 0x20 && c != '\t') || c == 0x7f) bad = true;
        }
        if (bad) { pnet_free_str(rt, value); refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid header value"); goto out; }
        if (!skip) {
          count++;
          bytes += nlen + vlen + 4;
          if (count > rt->cfg.http_max_headers || bytes > rt->cfg.http_max_header_bytes) {
            pnet_free_str(rt, value);
            refuse(rt, PNET_ERROR_RESOURCE_LIMIT, "request headers exceed limits");
            goto out;
          }
          pnet_sb_append(rt, &r->user_headers, name, nlen);
          pnet_sb_puts(rt, &r->user_headers, ": ");
          pnet_sb_append(rt, &r->user_headers, value, vlen);
          pnet_sb_puts(rt, &r->user_headers, "\r\n");
        }
        pnet_free_str(rt, value);
      }
      if (r->user_headers.failed) { refuse(rt, PNET_ERROR_RESOURCE_LIMIT, "out of memory"); goto out; }
    }
  }
  /* queueBytes / maxBodyBytes */
  {
    int64_t v;
    int node = pnet_json_get(&doc, root, "queueBytes");
    r->queue_bytes = rt->cfg.http_default_queue_bytes;
    if (node >= 0) {
      if (!pnet_json_i64(&doc, node, &v) || v < 1 || (uint64_t)v > rt->cfg.http_max_queue_bytes) {
        refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid queueBytes");
        goto out;
      }
      r->queue_bytes = (size_t)v;
    }
    node = pnet_json_get(&doc, root, "maxBodyBytes");
    r->max_body_bytes = SIZE_MAX;
    if (node >= 0) {
      if (!pnet_json_i64(&doc, node, &v) || v < 0) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid maxBodyBytes"); goto out; }
      r->max_body_bytes = (size_t)v;
    }
  }
  /* timeouts */
  {
    int t = pnet_json_get(&doc, root, "timeouts");
    uint32_t total_ms;
    if (t >= 0 && pnet_json_type(&doc, t) != PNET_J_OBJECT) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid timeouts"); goto out; }
    if (!read_timeout(rt, &doc, t, "connectMs", rt->cfg.http_default_timeout_ms, &r->connect_ms) ||
        !read_timeout(rt, &doc, t, "headersMs", rt->cfg.http_default_timeout_ms, &r->headers_ms) ||
        !read_timeout(rt, &doc, t, "idleMs", rt->cfg.http_default_timeout_ms, &r->idle_ms) ||
        !read_timeout(rt, &doc, t, "totalMs", rt->cfg.http_max_timeout_ms, &total_ms)) {
      refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid timeouts");
      goto out;
    }
    r->started_at = pnet_now(rt);
    rt->now = r->started_at;
    r->total_deadline = r->started_at + total_ms;
    r->phase_deadline = r->started_at + r->connect_ms;
  }
  /* redirect */
  {
    int node = pnet_json_get(&doc, root, "redirect");
    r->redirect_mode = 0;
    if (node >= 0) {
      if (!pnet_json_string(&doc, node, buf, sizeof buf, &blen)) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid redirect"); goto out; }
      bool found = false;
      for (int i = 0; i < 3; i++)
        if (strcmp(buf, REDIRECT_MODES[i]) == 0) { r->redirect_mode = (uint8_t)i; found = true; }
      if (!found) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid redirect"); goto out; }
    }
    int64_t v;
    node = pnet_json_get(&doc, root, "maxRedirects");
    r->redirects_left = rt->cfg.http_max_redirects;
    if (node >= 0) {
      if (!pnet_json_i64(&doc, node, &v) || v < 0 || v > (int64_t)rt->cfg.http_max_redirects) {
        refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid maxRedirects");
        goto out;
      }
      r->redirects_left = (uint32_t)v;
    }
  }
  /* tls */
  {
    int tls = pnet_json_get(&doc, root, "tls");
    if (tls >= 0) {
      int v = pnet_json_get(&doc, tls, "verification");
      if (v >= 0) {
        if (!pnet_json_string(&doc, v, buf, sizeof buf, &blen)) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid tls.verification"); goto out; }
        if (strcmp(buf, "development-insecure") == 0) {
          if (!rt->cfg.development_build || !rt->policy.allow_invalid_tls_for_development) {
            refuse(rt, PNET_ERROR_UNSUPPORTED, "development-insecure TLS is not enabled");
            goto out;
          }
          r->insecure_tls = true;
        } else if (strcmp(buf, "full") != 0) {
          refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid tls.verification");
          goto out;
        }
      }
    }
  }
  /* body copy */
  if (body_len > 0) {
    r->body = pnet_alloc(rt, body_len);
    if (!r->body) { refuse(rt, PNET_ERROR_RESOURCE_LIMIT, "out of memory"); goto out; }
    memcpy(r->body, body, body_len);
    r->body_len = body_len;
  }
  /* Handle + dial */
  r->handle = rt->http_next_handle++;
  if (rt->http_next_handle <= 0) rt->http_next_handle = 1;
  r->state = RQ_DIALING;
  r->live_counted = true;
  rt->http_live++;
  r->next = rt->http_reqs;
  rt->http_reqs = r;
  result = r->handle;
  {
    bool secure = strcmp(r->url.scheme, "https") == 0;
    if (!pnet_dial_start(rt, &r->dial, &r->conn, r->url.host, r->url.port, secure, r->url.host, !r->insecure_tls)) {
      /* Asynchronous failure: the terminal error arrives with the next tick. */
      req_fail(rt, r, r->dial.error_code ? r->dial.error_code : PNET_ERROR_CONNECT,
               r->dial.error_message ? r->dial.error_message : "connect failed", r->dial.cause);
    }
  }
  r = NULL;
out:
  if (r) req_free(rt, r);
  pnet_free(rt, nodes, (size_t)cap * sizeof(pnet_jnode));
  return result;
}

void pnet_http_cancel(pnet_runtime *rt, int handle) {
  pnet_http_req *r = req_find(rt, handle);
  if (!r) return;
  if (r->terminal) {
    /* Ended with unread bytes: release them, no further event. */
    if (req_is_retirable(r) || r->state == RQ_ENDED) req_unlink(rt, r);
    return;
  }
  r->cancelled = true;
  req_fail(rt, r, PNET_ERROR_CANCELLED, "cancelled", 0);
}

int pnet_http_read_into(pnet_runtime *rt, int handle, uint8_t *dst, size_t len) {
  pnet_http_req *r = req_find(rt, handle);
  if (!r || !r->head_pushed) return -1;
  if (r->terminal && r->rxq.bytes == 0) return -1;
  size_t want = len < r->visible_bytes ? len : r->visible_bytes;
  size_t got = pnet_bq_read(rt, &r->rxq, dst, want);
  r->visible_bytes -= got;
  if (r->state == RQ_BODY && !r->conn.read_wanted && r->rxq.bytes < r->queue_bytes) {
    r->conn.read_wanted = true;
    pnet_conn_update_interest(rt, &r->conn);
  }
  if (req_is_retirable(r) && !r->dirty) req_unlink(rt, r);
  return (int)got;
}

const char *pnet_http_poll(pnet_runtime *rt, size_t *len) {
  return pnet_queue_poll(rt, &rt->http_queue, len);
}

const char *pnet_http_poll_render(pnet_runtime *rt, size_t *len) {
  return pnet_queue_render(rt, &rt->http_queue, len);
}

void pnet_http_poll_consume(pnet_runtime *rt) {
  pnet_queue_consume(rt, &rt->http_queue);
}

const char *pnet_http_last_error(pnet_runtime *rt) {
  return pnet_sb_cstr(&rt->http_last_error);
}

const char *pnet_http_limits(pnet_runtime *rt) {
  return rt->http_limits_json ? rt->http_limits_json : "{}";
}
