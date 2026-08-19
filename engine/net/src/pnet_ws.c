/* WebSocket Client core (`globalThis.ws`, contracts/spec/ws.ts v2).
 *
 * One pnet_ws_sock per handle: dial → HTTP/1.1 upgrade handshake → RFC 6455
 * framing (client frames masked, server frames must not be), fragment
 * reassembly, control frames (pings answered natively), bounded receive and
 * send queues with drain, close handshake with a deadline, terminate.
 * Events (`open`, `message`, `ping`, `pong`, `drain`, `error`, `close`) go
 * to the ws queue; binary payloads cross only through pnet_ws_receive_into.
 */
#include <stdio.h>

#include "pnet_internal.h"

#define WS_GUID "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

typedef enum ws_state {
  WS_DIALING = 0,
  WS_HANDSHAKE,
  WS_OPEN,
  WS_CLOSING,     /* close frame sent, waiting for the peer's or the deadline */
  WS_CLOSED,      /* terminal event pushed */
} ws_state;

typedef enum frame_state {
  FR_HEAD = 0,    /* collecting the 2..14 header bytes */
  FR_PAYLOAD,
} frame_state;

typedef struct ws_message {
  struct ws_message *next;
  size_t len;
  uint8_t *data;
} ws_message;

typedef struct pnet_ws_sock {
  struct pnet_ws_sock *next;
  int handle;
  uint8_t state;
  bool terminal;
  bool live_counted;
  pnet_url url;
  pnet_sb request_head;
  char key_b64[32];
  char *protocols;          /* comma-joined request list, or NULL */
  char *selected_protocol;
  uint32_t connect_ms, close_ms;
  uint64_t deadline;
  size_t max_message_bytes, receive_queue_bytes, send_queue_bytes;
  uint32_t receive_queue_messages;
  pnet_dial dial;
  pnet_conn conn;
  /* handshake head / frame input */
  uint8_t *rx;
  size_t rx_len;
  size_t rx_cap;
  /* frame parser */
  uint8_t frame_state;
  uint8_t hdr[14];
  size_t hdr_len;
  size_t hdr_need;
  uint64_t payload_len;
  uint64_t payload_got;
  bool fin;
  uint8_t opcode;
  /* message assembly */
  uint8_t *msg;
  size_t msg_len;
  size_t msg_cap;
  uint8_t msg_opcode;
  bool in_message;
  pnet_utf8_state utf8;
  uint8_t ctl[PWS_CONTROL_PAYLOAD_MAX];
  size_t ctl_len;
  /* receive accounting */
  ws_message *binary_head;
  ws_message *binary_tail;
  size_t queued_bytes;      /* undelivered message bytes (text until the next tick, binary until dequeued) */
  uint32_t queued_msgs;
  size_t text_bytes_pending; /* text bytes counted in queued_bytes, released at freeze */
  uint32_t text_msgs_pending;
  /* send accounting */
  bool drain_armed;
  /* close */
  bool close_sent;
  bool close_received;
  bool local_close;
  int close_code;
  char close_reason[124];
  size_t close_reason_len;
  const char *pending_error;   /* error code to report before close, or NULL */
  const char *pending_error_msg;
} pnet_ws_sock;

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

static void ws_free_messages(pnet_runtime *rt, pnet_ws_sock *s) {
  ws_message *m = s->binary_head;
  while (m) {
    ws_message *n = m->next;
    pnet_free(rt, m->data, m->len ? m->len : 1);
    pnet_free(rt, m, sizeof *m);
    m = n;
  }
  s->binary_head = s->binary_tail = NULL;
}

static void ws_free(pnet_runtime *rt, pnet_ws_sock *s) {
  pnet_dial_cancel(rt, &s->dial);
  pnet_conn_close(rt, &s->conn);
  pnet_url_free(rt, &s->url);
  pnet_sb_free(rt, &s->request_head);
  if (s->protocols) pnet_free_str(rt, s->protocols);
  if (s->selected_protocol) pnet_free_str(rt, s->selected_protocol);
  if (s->rx) pnet_free(rt, s->rx, s->rx_cap);
  if (s->msg) pnet_free(rt, s->msg, s->msg_cap);
  ws_free_messages(rt, s);
  pnet_free(rt, s, sizeof *s);
}

static void ws_unlink(pnet_runtime *rt, pnet_ws_sock *s) {
  pnet_ws_sock **pp = &rt->ws_socks;
  while (*pp && *pp != s) pp = &(*pp)->next;
  if (*pp) *pp = s->next;
  if (s->live_counted && rt->ws_live > 0) rt->ws_live--;
  s->live_counted = false;
  ws_free(rt, s);
}

static pnet_ws_sock *ws_find(pnet_runtime *rt, int handle) {
  for (pnet_ws_sock *s = rt->ws_socks; s; s = s->next)
    if (s->handle == handle) return s;
  return NULL;
}

static void ws_push(pnet_runtime *rt, pnet_ws_sock *s, const char *t, const char *tail, size_t tail_len, bool terminal,
                    size_t weight) {
  size_t len = 0;
  char *json = pnet_event_json(rt, t, "h", s->handle, tail, tail_len, &len);
  pnet_queue_push(rt, &rt->ws_queue, s->handle, terminal, weight, json, len);
}

/** Pre-open failure: terminal `error`. */
static void ws_fail(pnet_runtime *rt, pnet_ws_sock *s, const char *code, const char *message, int status) {
  if (s->terminal) return;
  s->terminal = true;
  s->state = WS_CLOSED;
  pnet_dial_cancel(rt, &s->dial);
  pnet_conn_close(rt, &s->conn);
  pnet_sb sb;
  pnet_sb_init(&sb);
  pnet_sb_puts(rt, &sb, ",\"code\":");
  pnet_sb_json_string(rt, &sb, code, strlen(code));
  pnet_sb_puts(rt, &sb, ",\"message\":");
  pnet_sb_json_string(rt, &sb, message, strlen(message));
  if (status > 0) pnet_sb_printf(rt, &sb, ",\"status\":%d", status);
  if (!sb.failed) ws_push(rt, s, "error", sb.data, sb.len, true, 0);
  pnet_sb_free(rt, &sb);
  if (s->live_counted && rt->ws_live > 0) rt->ws_live--;
  s->live_counted = false;
}

/** Post-open termination: optional `error` then terminal `close`. */
static void ws_closed(pnet_runtime *rt, pnet_ws_sock *s, int code, const char *reason, size_t reason_len, bool clean,
                      bool local) {
  if (s->terminal) return;
  s->terminal = true;
  s->state = WS_CLOSED;
  pnet_conn_close(rt, &s->conn);
  if (s->pending_error) {
    pnet_sb eb;
    pnet_sb_init(&eb);
    pnet_sb_puts(rt, &eb, ",\"code\":");
    pnet_sb_json_string(rt, &eb, s->pending_error, strlen(s->pending_error));
    pnet_sb_puts(rt, &eb, ",\"message\":");
    const char *msg = s->pending_error_msg ? s->pending_error_msg : "";
    pnet_sb_json_string(rt, &eb, msg, strlen(msg));
    if (!eb.failed) ws_push(rt, s, "error", eb.data, eb.len, false, 0);
    pnet_sb_free(rt, &eb);
    s->pending_error = NULL;
  }
  pnet_sb sb;
  pnet_sb_init(&sb);
  pnet_sb_printf(rt, &sb, ",\"code\":%d,\"reason\":", code);
  pnet_sb_json_string(rt, &sb, reason ? reason : "", reason_len);
  pnet_sb_printf(rt, &sb, ",\"clean\":%s,\"local\":%s", clean ? "true" : "false", local ? "true" : "false");
  if (!sb.failed) ws_push(rt, s, "close", sb.data, sb.len, true, 0);
  pnet_sb_free(rt, &sb);
  if (s->live_counted && rt->ws_live > 0) rt->ws_live--;
  s->live_counted = false;
}

/* --- frame writer -------------------------------------------------------- */

static bool ws_write_frame(pnet_runtime *rt, pnet_ws_sock *s, uint8_t opcode, const uint8_t *payload, size_t len) {
  uint8_t head[14];
  size_t hl = 0;
  head[hl++] = (uint8_t)(0x80 | (opcode & 0x0f));
  if (len < 126) head[hl++] = (uint8_t)(0x80 | len);
  else if (len <= 0xffff) {
    head[hl++] = 0x80 | 126;
    head[hl++] = (uint8_t)(len >> 8);
    head[hl++] = (uint8_t)len;
  } else {
    head[hl++] = 0x80 | 127;
    for (int i = 7; i >= 0; i--) head[hl++] = (uint8_t)((uint64_t)len >> (8 * i));
  }
  uint8_t mask[4];
  rt->platform.random(rt->platform.ctx, mask, 4);
  memcpy(head + hl, mask, 4);
  hl += 4;
  if (!pnet_conn_write(rt, &s->conn, head, hl)) return false;
  /* Mask in bounded chunks. */
  uint8_t chunk[512];
  for (size_t off = 0; off < len; off += sizeof chunk) {
    size_t n = len - off < sizeof chunk ? len - off : sizeof chunk;
    for (size_t i = 0; i < n; i++) chunk[i] = payload[off + i] ^ mask[(off + i) & 3];
    if (!pnet_conn_write(rt, &s->conn, chunk, n)) return false;
  }
  return true;
}

static void ws_send_close_frame(pnet_runtime *rt, pnet_ws_sock *s, int code, const char *reason, size_t reason_len) {
  if (s->close_sent) return;
  s->close_sent = true;
  uint8_t payload[125];
  size_t len = 0;
  if (code > 0) {
    payload[len++] = (uint8_t)(code >> 8);
    payload[len++] = (uint8_t)code;
    if (reason_len > 123) reason_len = 123;
    memcpy(payload + len, reason, reason_len);
    len += reason_len;
  }
  ws_write_frame(rt, s, 8, payload, len);
  pnet_conn_shutdown_write(rt, &s->conn);
}

/** Local protocol/limit close: send Close(code), report error later. */
static void ws_protocol_close(pnet_runtime *rt, pnet_ws_sock *s, int code, const char *error_code, const char *message) {
  if (s->state != WS_OPEN && s->state != WS_CLOSING) return;
  if (s->pending_error) return; /* the first violation wins */
  s->pending_error = error_code;
  s->pending_error_msg = message;
  s->local_close = true;
  s->close_code = code;
  s->close_reason_len = 0;
  ws_send_close_frame(rt, s, code, "", 0);
  s->state = WS_CLOSING;
  s->deadline = rt->now + s->close_ms;
}

/* --- receive queue -------------------------------------------------------- */

static bool ws_enqueue_binary(pnet_runtime *rt, pnet_ws_sock *s, uint8_t *data, size_t len) {
  ws_message *m = pnet_alloc(rt, sizeof *m);
  if (!m) return false;
  m->next = NULL;
  m->len = len;
  m->data = data;
  if (s->binary_tail) s->binary_tail->next = m;
  else s->binary_head = m;
  s->binary_tail = m;
  return true;
}

static void ws_update_read_interest(pnet_runtime *rt, pnet_ws_sock *s) {
  bool full = s->queued_bytes >= s->receive_queue_bytes || s->queued_msgs >= s->receive_queue_messages;
  s->conn.read_wanted = !full;
  pnet_conn_update_interest(rt, &s->conn);
}

/** A complete data message arrived (`s->msg`). */
static bool ws_deliver_message(pnet_runtime *rt, pnet_ws_sock *s) {
  size_t len = s->msg_len;
  if (s->queued_bytes + len > s->receive_queue_bytes || s->queued_msgs + 1 > s->receive_queue_messages) {
    ws_protocol_close(rt, s, 1013, PNET_ERROR_RESOURCE_LIMIT, "receive queue full");
    return false;
  }
  if (s->msg_opcode == 1) {
    pnet_sb sb;
    pnet_sb_init(&sb);
    pnet_sb_puts(rt, &sb, ",\"kind\":\"text\",\"text\":");
    pnet_sb_json_string(rt, &sb, (const char *)s->msg, len);
    if (sb.failed) {
      pnet_sb_free(rt, &sb);
      return false;
    }
    ws_push(rt, s, "message", sb.data, sb.len, false, len);
    pnet_sb_free(rt, &sb);
    s->text_bytes_pending += len;
    s->text_msgs_pending++;
  } else {
    uint8_t *data = pnet_alloc(rt, len ? len : 1);
    if (!data) return false;
    memcpy(data, s->msg, len);
    if (!ws_enqueue_binary(rt, s, data, len)) {
      pnet_free(rt, data, len ? len : 1);
      return false;
    }
    char tail[48];
    int n = snprintf(tail, sizeof tail, ",\"kind\":\"binary\",\"bytes\":%zu", len);
    ws_push(rt, s, "message", tail, (size_t)n, false, len);
  }
  s->queued_bytes += len;
  s->queued_msgs++;
  s->msg_len = 0;
  s->in_message = false;
  ws_update_read_interest(rt, s);
  return true;
}

static void ws_push_control_event(pnet_runtime *rt, pnet_ws_sock *s, const char *t, const uint8_t *payload, size_t len) {
  char b64[176];
  pnet_base64_encode(payload, len, b64, sizeof b64);
  pnet_sb sb;
  pnet_sb_init(&sb);
  pnet_sb_printf(rt, &sb, ",\"payload\":{\"%s\":\"%s\"}", PWS_BLOB_KEY, b64);
  if (!sb.failed) ws_push(rt, s, t, sb.data, sb.len, false, len);
  pnet_sb_free(rt, &sb);
}

/* --- frame parser ---------------------------------------------------------- */

static bool valid_close_code(int code) {
  if (code >= 3000 && code <= 4999) return true;
  switch (code) {
    case 1000: case 1001: case 1002: case 1003: case 1007: case 1008: case 1009: case 1010: case 1011:
      return true;
    default:
      return false;
  }
}

/** Handle one complete frame whose payload is in `payload`. */
static void ws_on_frame(pnet_runtime *rt, pnet_ws_sock *s, uint8_t opcode, bool fin, const uint8_t *payload, size_t len) {
  /* After our Close frame only control frames matter (RFC 6455 §7.1.1). */
  if (s->close_sent && opcode < 0x8) return;
  switch (opcode) {
    case 0x8: { /* close */
      int code = 1005;
      const char *reason = "";
      size_t reason_len = 0;
      if (len == 1) {
        ws_protocol_close(rt, s, 1002, PNET_ERROR_WEBSOCKET_PROTOCOL_ERROR, "invalid close payload");
        return;
      }
      if (len >= 2) {
        code = (payload[0] << 8) | payload[1];
        if (!valid_close_code(code)) {
          ws_protocol_close(rt, s, 1002, PNET_ERROR_WEBSOCKET_PROTOCOL_ERROR, "invalid close code");
          return;
        }
        reason = (const char *)payload + 2;
        reason_len = len - 2;
        if (!pnet_utf8_valid((const uint8_t *)reason, reason_len)) {
          ws_protocol_close(rt, s, 1007, PNET_ERROR_WEBSOCKET_PROTOCOL_ERROR, "invalid close reason");
          return;
        }
      }
      s->close_received = true;
      if (s->close_sent) {
        /* Our close was answered: clean handshake. */
        ws_closed(rt, s, s->local_close ? s->close_code : code, s->local_close ? s->close_reason : reason,
                  s->local_close ? s->close_reason_len : reason_len, true, s->local_close);
        return;
      }
      /* Peer-initiated: echo and finish. */
      ws_send_close_frame(rt, s, code == 1005 ? 0 : code, "", 0);
      s->state = WS_CLOSING;
      ws_closed(rt, s, code, reason, reason_len, true, false);
      return;
    }
    case 0x9: /* ping */
      if (s->state == WS_OPEN) ws_write_frame(rt, s, 0xA, payload, len);
      ws_push_control_event(rt, s, "ping", payload, len);
      return;
    case 0xA: /* pong */
      ws_push_control_event(rt, s, "pong", payload, len);
      return;
    case 0x0:
    case 0x1:
    case 0x2: {
      if (opcode == 0 && !s->in_message) {
        ws_protocol_close(rt, s, 1002, PNET_ERROR_WEBSOCKET_PROTOCOL_ERROR, "continuation without a message");
        return;
      }
      if (opcode != 0 && s->in_message) {
        ws_protocol_close(rt, s, 1002, PNET_ERROR_WEBSOCKET_PROTOCOL_ERROR, "new message inside a fragmented one");
        return;
      }
      if (opcode != 0) {
        s->in_message = true;
        s->msg_opcode = opcode;
        s->msg_len = 0;
        pnet_utf8_state_init(&s->utf8);
      }
      if (s->msg_len + len > s->max_message_bytes) {
        ws_protocol_close(rt, s, 1009, PNET_ERROR_MESSAGE_TOO_LARGE, "message exceeds maxMessageBytes");
        return;
      }
      if (s->msg_opcode == 1 && !pnet_utf8_feed(&s->utf8, payload, len)) {
        ws_protocol_close(rt, s, 1007, PNET_ERROR_WEBSOCKET_PROTOCOL_ERROR, "invalid UTF-8 in text message");
        return;
      }
      if (len > 0) {
        if (s->msg_cap < s->msg_len + len) {
          size_t cap = s->msg_cap ? s->msg_cap : 1024;
          while (cap < s->msg_len + len) cap *= 2;
          if (cap > s->max_message_bytes) cap = s->max_message_bytes;
          uint8_t *next = pnet_alloc(rt, cap);
          if (!next) {
            ws_protocol_close(rt, s, 1013, PNET_ERROR_RESOURCE_LIMIT, "out of memory");
            return;
          }
          if (s->msg) {
            memcpy(next, s->msg, s->msg_len);
            pnet_free(rt, s->msg, s->msg_cap);
          }
          s->msg = next;
          s->msg_cap = cap;
        }
        memcpy(s->msg + s->msg_len, payload, len);
        s->msg_len += len;
      }
      if (fin) {
        if (s->msg_opcode == 1 && !pnet_utf8_complete(&s->utf8)) {
          ws_protocol_close(rt, s, 1007, PNET_ERROR_WEBSOCKET_PROTOCOL_ERROR, "truncated UTF-8 in text message");
          return;
        }
        ws_deliver_message(rt, s);
      }
      return;
    }
    default:
      ws_protocol_close(rt, s, 1002, PNET_ERROR_WEBSOCKET_PROTOCOL_ERROR, "reserved opcode");
      return;
  }
}

/** Feed inbound bytes through the frame parser. Returns false when the socket
 * left the OPEN/CLOSING states. */
static bool ws_feed(pnet_runtime *rt, pnet_ws_sock *s, const uint8_t *in, size_t len) {
  size_t i = 0;
  while (i < len && (s->state == WS_OPEN || s->state == WS_CLOSING) && !s->terminal) {
    if (s->frame_state == FR_HEAD) {
      s->hdr[s->hdr_len++] = in[i++];
      if (s->hdr_len == 2) {
        uint8_t b0 = s->hdr[0], b1 = s->hdr[1];
        if (b0 & 0x70) {
          ws_protocol_close(rt, s, 1002, PNET_ERROR_WEBSOCKET_PROTOCOL_ERROR, "reserved bits set");
          return false;
        }
        if (b1 & 0x80) {
          ws_protocol_close(rt, s, 1002, PNET_ERROR_WEBSOCKET_PROTOCOL_ERROR, "masked server frame");
          return false;
        }
        s->fin = (b0 & 0x80) != 0;
        s->opcode = b0 & 0x0f;
        uint8_t l7 = b1 & 0x7f;
        if (s->opcode >= 0x8) {
          if (!s->fin || l7 > 125) {
            ws_protocol_close(rt, s, 1002, PNET_ERROR_WEBSOCKET_PROTOCOL_ERROR, "invalid control frame");
            return false;
          }
        }
        if (l7 < 126) {
          s->payload_len = l7;
          s->hdr_need = 2;
        } else if (l7 == 126) {
          s->hdr_need = 4;
        } else {
          s->hdr_need = 10;
        }
      }
      if (s->hdr_len >= 2 && s->hdr_len == s->hdr_need) {
        if (s->hdr_need == 4) s->payload_len = ((uint64_t)s->hdr[2] << 8) | s->hdr[3];
        else if (s->hdr_need == 10) {
          uint64_t v = 0;
          for (int k = 2; k < 10; k++) v = (v << 8) | s->hdr[k];
          if (v >> 63) {
            ws_protocol_close(rt, s, 1002, PNET_ERROR_WEBSOCKET_PROTOCOL_ERROR, "invalid payload length");
            return false;
          }
          s->payload_len = v;
        }
        if (s->opcode < 0x8 && s->payload_len > s->max_message_bytes) {
          ws_protocol_close(rt, s, 1009, PNET_ERROR_MESSAGE_TOO_LARGE, "frame exceeds maxMessageBytes");
          return false;
        }
        s->payload_got = 0;
        s->ctl_len = 0;
        s->frame_state = FR_PAYLOAD;
        if (s->payload_len == 0) {
          ws_on_frame(rt, s, s->opcode, s->fin, s->ctl, 0);
          s->frame_state = FR_HEAD;
          s->hdr_len = 0;
        }
      }
      continue;
    }
    /* payload */
    size_t remaining = (size_t)(s->payload_len - s->payload_got);
    size_t n = len - i < remaining ? len - i : remaining;
    if (s->opcode >= 0x8) {
      memcpy(s->ctl + s->ctl_len, in + i, n);
      s->ctl_len += n;
      s->payload_got += n;
      i += n;
      if (s->payload_got == s->payload_len) {
        ws_on_frame(rt, s, s->opcode, true, s->ctl, s->ctl_len);
        s->frame_state = FR_HEAD;
        s->hdr_len = 0;
      }
      continue;
    }
    /* Data frame payload: append to the message assembly directly (final
     * validation happens per chunk; `fin` is applied on the last byte). */
    bool last = s->payload_got + n == s->payload_len;
    ws_on_frame(rt, s, s->payload_got == 0 ? s->opcode : 0, last && s->fin, in + i, n);
    if (!last && s->payload_got == 0 && s->opcode != 0) {
      /* subsequent chunks of this frame continue the message */
    }
    s->payload_got += n;
    i += n;
    if (last) {
      s->frame_state = FR_HEAD;
      s->hdr_len = 0;
    }
  }
  return s->state == WS_OPEN || s->state == WS_CLOSING;
}

/* ------------------------------------------------------------------------ */
/* Handshake                                                                 */
/* ------------------------------------------------------------------------ */

static bool ws_build_request(pnet_runtime *rt, pnet_ws_sock *s, const char *user_headers, size_t user_len) {
  uint8_t key[16];
  rt->platform.random(rt->platform.ctx, key, sizeof key);
  pnet_base64_encode(key, sizeof key, s->key_b64, sizeof s->key_b64);
  pnet_sb *sb = &s->request_head;
  pnet_sb_puts(rt, sb, "GET ");
  pnet_sb_append(rt, sb, s->url.path, s->url.path_len);
  pnet_sb_puts(rt, sb, " HTTP/1.1\r\nHost: ");
  if (s->url.host_is_ipv6) pnet_sb_putc(rt, sb, '[');
  pnet_sb_puts(rt, sb, s->url.host);
  if (s->url.host_is_ipv6) pnet_sb_putc(rt, sb, ']');
  if (s->url.port_explicit) pnet_sb_printf(rt, sb, ":%u", (unsigned)s->url.port);
  pnet_sb_puts(rt, sb, "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ");
  pnet_sb_puts(rt, sb, s->key_b64);
  pnet_sb_puts(rt, sb, "\r\nSec-WebSocket-Version: 13\r\n");
  if (s->protocols) {
    pnet_sb_puts(rt, sb, "Sec-WebSocket-Protocol: ");
    pnet_sb_puts(rt, sb, s->protocols);
    pnet_sb_puts(rt, sb, "\r\n");
  }
  if (user_len) pnet_sb_append(rt, sb, user_headers, user_len);
  pnet_sb_puts(rt, sb, "\r\n");
  return !sb->failed;
}

static bool protocol_requested(const pnet_ws_sock *s, const char *value, size_t len) {
  if (!s->protocols) return false;
  const char *p = s->protocols;
  while (*p) {
    const char *end = strchr(p, ',');
    size_t n = end ? (size_t)(end - p) : strlen(p);
    while (n > 0 && p[0] == ' ') { p++; n--; }
    if (n == len && memcmp(p, value, len) == 0) return true;
    if (!end) break;
    p = end + 1;
  }
  return false;
}

static void ws_on_handshake_head(pnet_runtime *rt, pnet_ws_sock *s, pnet_h1_head *head) {
  if (head->status != 101) {
    char msg[64];
    snprintf(msg, sizeof msg, "handshake answered %d", head->status);
    ws_fail(rt, s, PNET_ERROR_WEBSOCKET_HANDSHAKE_FAILED, msg, head->status);
    return;
  }
  const pnet_h1_field *up = pnet_h1_find(head, "upgrade");
  if (!up || !pnet_ieq_n(up->value, up->value_len, "websocket")) {
    ws_fail(rt, s, PNET_ERROR_WEBSOCKET_HANDSHAKE_FAILED, "missing Upgrade: websocket", 101);
    return;
  }
  const pnet_h1_field *conn = pnet_h1_find(head, "connection");
  bool has_upgrade_token = false;
  if (conn) {
    const char *v = conn->value;
    size_t l = conn->value_len;
    size_t i = 0;
    while (i <= l) {
      size_t j = i;
      while (j < l && v[j] != ',') j++;
      size_t a = i, b = j;
      while (a < b && (v[a] == ' ' || v[a] == '\t')) a++;
      while (b > a && (v[b - 1] == ' ' || v[b - 1] == '\t')) b--;
      if (pnet_ieq_n(v + a, b - a, "upgrade")) has_upgrade_token = true;
      if (j >= l) break;
      i = j + 1;
    }
  }
  if (!has_upgrade_token) {
    ws_fail(rt, s, PNET_ERROR_WEBSOCKET_HANDSHAKE_FAILED, "missing Connection: Upgrade", 101);
    return;
  }
  const pnet_h1_field *accept = pnet_h1_find(head, "sec-websocket-accept");
  char concat[96];
  snprintf(concat, sizeof concat, "%s%s", s->key_b64, WS_GUID);
  uint8_t digest[20];
  pnet_sha1((const uint8_t *)concat, strlen(concat), digest);
  char expected[32];
  pnet_base64_encode(digest, 20, expected, sizeof expected);
  if (!accept || accept->value_len != strlen(expected) || memcmp(accept->value, expected, accept->value_len) != 0) {
    ws_fail(rt, s, PNET_ERROR_WEBSOCKET_HANDSHAKE_FAILED, "Sec-WebSocket-Accept mismatch", 101);
    return;
  }
  if (pnet_h1_find(head, "sec-websocket-extensions")) {
    ws_fail(rt, s, PNET_ERROR_WEBSOCKET_HANDSHAKE_FAILED, "unrequested extension", 101);
    return;
  }
  const pnet_h1_field *proto = pnet_h1_find(head, "sec-websocket-protocol");
  if (proto) {
    if (!protocol_requested(s, proto->value, proto->value_len)) {
      ws_fail(rt, s, PNET_ERROR_WEBSOCKET_HANDSHAKE_FAILED, "unrequested subprotocol", 101);
      return;
    }
    s->selected_protocol = pnet_strdup_n(rt, proto->value, proto->value_len);
  }
  /* Open. */
  s->state = WS_OPEN;
  s->deadline = 0;
  s->frame_state = FR_HEAD;
  s->hdr_len = 0;
  pnet_sb sb;
  pnet_sb_init(&sb);
  pnet_sb_puts(rt, &sb, ",\"protocol\":");
  const char *sel = s->selected_protocol ? s->selected_protocol : "";
  pnet_sb_json_string(rt, &sb, sel, strlen(sel));
  if (!sb.failed) ws_push(rt, s, "open", sb.data, sb.len, false, 0);
  pnet_sb_free(rt, &sb);
  /* Bytes after the head are frames. */
  size_t rest = s->rx_len - head->head_len;
  if (rest > 0) {
    uint8_t *tmp = pnet_alloc(rt, rest);
    if (tmp) {
      memcpy(tmp, s->rx + head->head_len, rest);
      s->rx_len = 0;
      ws_feed(rt, s, tmp, rest);
      pnet_free(rt, tmp, rest);
    }
  }
  s->rx_len = 0;
  ws_update_read_interest(rt, s);
}

/* ------------------------------------------------------------------------ */
/* Service                                                                   */
/* ------------------------------------------------------------------------ */

static void ws_service_one(pnet_runtime *rt, pnet_ws_sock *s) {
  if (s->state == WS_CLOSED) return;
  if (s->state == WS_DIALING || s->state == WS_HANDSHAKE) {
    if (rt->now >= s->deadline) {
      ws_fail(rt, s, PNET_ERROR_TIMEOUT, "connect timeout", 0);
      return;
    }
  }
  if (s->state == WS_DIALING) {
    int st = pnet_dial_step(rt, &s->dial, &s->conn);
    if (st == PNET_DIAL_FAILED) {
      ws_fail(rt, s, s->dial.error_code ? s->dial.error_code : PNET_ERROR_CONNECT, "connect failed", 0);
      return;
    }
    if (st != PNET_DIAL_OPEN) return;
    if (!pnet_conn_write(rt, &s->conn, s->request_head.data, s->request_head.len)) {
      ws_fail(rt, s, PNET_ERROR_RESOURCE_LIMIT, "out of memory", 0);
      return;
    }
    pnet_sb_free(rt, &s->request_head);
    s->state = WS_HANDSHAKE;
  }
  if (!pnet_conn_flush(rt, &s->conn)) {
    if (s->state == WS_HANDSHAKE) ws_fail(rt, s, PNET_ERROR_CLOSED, "connection lost during handshake", 0);
    else {
      s->pending_error = PNET_ERROR_CLOSED;
      s->pending_error_msg = "connection lost";
      ws_closed(rt, s, 1006, "", 0, false, s->local_close);
    }
    return;
  }
  if (s->drain_armed && s->conn.tx.bytes < rt->cfg.ws_send_low_water_bytes && s->state == WS_OPEN) {
    s->drain_armed = false;
    ws_push(rt, s, "drain", NULL, 0, false, 0);
  }
  uint8_t scratch[2048];
  if (s->state == WS_HANDSHAKE) {
    size_t max_head = rt->cfg.http_max_header_bytes + 512;
    if (s->rx_len >= max_head) {
      ws_fail(rt, s, PNET_ERROR_WEBSOCKET_HANDSHAKE_FAILED, "handshake response too large", 0);
      return;
    }
    if (s->rx_cap < s->rx_len + 512) {
      size_t cap = s->rx_cap ? s->rx_cap * 2 : 1024;
      if (cap > max_head + 16) cap = max_head + 16;
      uint8_t *next = pnet_alloc(rt, cap);
      if (!next) { ws_fail(rt, s, PNET_ERROR_RESOURCE_LIMIT, "out of memory", 0); return; }
      if (s->rx) { memcpy(next, s->rx, s->rx_len); pnet_free(rt, s->rx, s->rx_cap); }
      s->rx = next;
      s->rx_cap = cap;
    }
    int n = pnet_conn_read(rt, &s->conn, s->rx + s->rx_len, s->rx_cap - s->rx_len);
    if (n == PNET_IO_AGAIN) return;
    if (n <= 0) {
      ws_fail(rt, s, PNET_ERROR_CLOSED, "connection closed during handshake", 0);
      return;
    }
    s->rx_len += (size_t)n;
    pnet_h1_head head;
    int rc = pnet_h1_parse_head(s->rx, s->rx_len, false, rt->cfg.http_max_header_bytes, PWS_MAX_HANDSHAKE_HEADERS, 2048, &head);
    if (rc == PNET_H1_INCOMPLETE) return;
    if (rc != PNET_H1_OK) {
      ws_fail(rt, s, PNET_ERROR_WEBSOCKET_HANDSHAKE_FAILED, "malformed handshake response", 0);
      return;
    }
    ws_on_handshake_head(rt, s, &head);
    return;
  }
  if (s->state == WS_OPEN || s->state == WS_CLOSING) {
    if (s->state == WS_CLOSING && s->deadline && rt->now >= s->deadline) {
      /* The peer never answered our close: report as an unclean local close. */
      ws_closed(rt, s, s->close_code ? s->close_code : 1006, s->close_reason, s->close_reason_len, false, true);
      return;
    }
    for (int rounds = 0; rounds < 8; rounds++) {
      if (!s->conn.read_wanted) return;
      int n = pnet_conn_read(rt, &s->conn, scratch, sizeof scratch);
      if (n == PNET_IO_AGAIN) return;
      if (n <= 0) {
        if (s->close_sent && s->close_received) return;
        if (s->state == WS_CLOSING && s->close_sent) {
          /* Peer closed the transport after our Close frame without answering. */
          ws_closed(rt, s, s->close_code ? s->close_code : 1006, s->close_reason, s->close_reason_len, false, s->local_close);
          return;
        }
        s->pending_error = PNET_ERROR_CLOSED;
        s->pending_error_msg = "connection lost";
        ws_closed(rt, s, 1006, "", 0, false, false);
        return;
      }
      if (!ws_feed(rt, s, scratch, (size_t)n)) return;
      if (s->terminal) return;
    }
  }
}

static bool ws_retirable(const pnet_ws_sock *s) {
  return s->terminal && s->binary_head == NULL;
}

void pnet_ws_service(pnet_runtime *rt) {
  pnet_ws_sock *s = rt->ws_socks;
  while (s) {
    pnet_ws_sock *next = s->next;
    ws_service_one(rt, s);
    if (ws_retirable(s)) ws_unlink(rt, s);
    s = next;
  }
}

uint64_t pnet_ws_next_deadline(pnet_runtime *rt) {
  uint64_t d = 0;
  for (pnet_ws_sock *s = rt->ws_socks; s; s = s->next)
    if (!s->terminal && s->deadline) d = pnet_min_deadline(d, s->deadline);
  return d;
}

bool pnet_ws_has_output(pnet_runtime *rt) {
  for (pnet_ws_sock *s = rt->ws_socks; s; s = s->next)
    if (s->conn.state == PNET_CONN_OPEN && s->conn.tx.bytes > 0) return true;
  return false;
}

void pnet_ws_freeze(pnet_runtime *rt) {
  /* Text messages become visible now: release their receive-queue share. */
  for (pnet_ws_sock *s = rt->ws_socks; s; s = s->next) {
    if (s->text_msgs_pending) {
      s->queued_bytes = s->queued_bytes >= s->text_bytes_pending ? s->queued_bytes - s->text_bytes_pending : 0;
      s->queued_msgs = s->queued_msgs >= s->text_msgs_pending ? s->queued_msgs - s->text_msgs_pending : 0;
      s->text_bytes_pending = 0;
      s->text_msgs_pending = 0;
      if (s->state == WS_OPEN) ws_update_read_interest(rt, s);
    }
  }
}

void pnet_ws_quiesce(pnet_runtime *rt) {
  for (pnet_ws_sock *s = rt->ws_socks; s; s = s->next) {
    if (s->terminal) continue;
    if (s->state == WS_OPEN || s->state == WS_CLOSING) {
      s->local_close = true;
      ws_closed(rt, s, 1001, "going away", 10, false, true);
    } else {
      ws_fail(rt, s, PNET_ERROR_CANCELLED, "runtime closing", 0);
    }
  }
}

void pnet_ws_init(pnet_runtime *rt) {
  pnet_sb sb;
  pnet_sb_init(&sb);
  const pnet_runtime_config *c = &rt->cfg;
  pnet_sb_printf(rt, &sb,
                 "{\"specMajor\":%d,\"specMinor\":%d,\"maxSockets\":%u,\"maxTlsInflight\":0,\"maxMessageBytes\":%zu,"
                 "\"maxReceiveQueueBytes\":%zu,\"maxReceiveQueueMessages\":%u,\"maxSendQueueBytes\":%zu,"
                 "\"sendHighWaterBytes\":%zu,\"sendLowWaterBytes\":%zu,\"maxHandshakeHeaders\":%d,"
                 "\"maxHandshakeHeaderBytes\":%zu,\"maxEventsPerTick\":%u,\"maxTickBytes\":%zu,\"defaultConnectMs\":%u,"
                 "\"maxConnectMs\":%u,\"defaultCloseMs\":%u,\"tlsMinVersion\":\"%s\",\"features\":[]}",
                 PWS_SPEC_MAJOR, PWS_SPEC_MINOR, c->ws_max_sockets, c->ws_max_message_bytes, c->ws_max_receive_queue_bytes,
                 c->ws_max_receive_queue_messages, c->ws_max_send_queue_bytes, c->ws_send_high_water_bytes,
                 c->ws_send_low_water_bytes, PWS_MAX_HANDSHAKE_HEADERS, c->http_max_header_bytes, c->ws_max_events_per_tick,
                 c->ws_max_tick_bytes, c->ws_default_connect_ms, c->ws_max_connect_ms, c->ws_default_close_ms,
                 PNET_TLS_MIN_VERSION);
  rt->ws_limits_json = sb.failed ? NULL : pnet_strdup_n(rt, sb.data, sb.len);
  pnet_sb_free(rt, &sb);
}

void pnet_ws_shutdown(pnet_runtime *rt) {
  while (rt->ws_socks) {
    pnet_ws_sock *s = rt->ws_socks;
    rt->ws_socks = s->next;
    ws_free(rt, s);
  }
  if (rt->ws_limits_json) pnet_free_str(rt, rt->ws_limits_json);
  rt->ws_limits_json = NULL;
  rt->ws_live = 0;
}

/* ------------------------------------------------------------------------ */
/* Guest ops                                                                 */
/* ------------------------------------------------------------------------ */

static int refuse(pnet_runtime *rt, const char *code, const char *message) {
  pnet_set_last_error(rt, &rt->ws_last_error, code, message);
  return -1;
}

int pnet_ws_connect(pnet_runtime *rt, const char *meta_json) {
  if (rt->quiesced) return refuse(rt, PNET_ERROR_CLOSED, "runtime is closing");
  if (rt->ws_live >= rt->cfg.ws_max_sockets) return refuse(rt, PNET_ERROR_RESOURCE_LIMIT, "too many sockets");
  if (!meta_json) return refuse(rt, PNET_ERROR_INVALID_REQUEST, "missing metadata");
  int cap = 256;
  pnet_jnode *nodes = pnet_alloc(rt, (size_t)cap * sizeof(pnet_jnode));
  if (!nodes) return refuse(rt, PNET_ERROR_RESOURCE_LIMIT, "out of memory");
  pnet_jdoc doc;
  int root = pnet_json_parse(&doc, nodes, cap, meta_json, strlen(meta_json));
  int result = -1;
  pnet_ws_sock *s = NULL;
  pnet_sb user_headers;
  pnet_sb_init(&user_headers);
  char buf[520];
  size_t blen;
  int64_t v;
  if (root < 0 || pnet_json_type(&doc, root) != PNET_J_OBJECT) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "malformed connect metadata"); goto out; }
  s = pnet_zalloc(rt, sizeof *s);
  if (!s) { refuse(rt, PNET_ERROR_RESOURCE_LIMIT, "out of memory"); goto out; }
  pnet_conn_init(&s->conn);
  pnet_sb_init(&s->request_head);
  {
    char *url = pnet_json_string_dup(rt, &doc, pnet_json_get(&doc, root, "url"), &blen);
    if (!url) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "url required"); goto out; }
    bool ok = pnet_url_parse(rt, url, blen, &s->url);
    pnet_free_str(rt, url);
    if (!ok) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid url"); goto out; }
    pnet_proto proto = pnet_proto_from_scheme(s->url.scheme);
    if (proto != PNET_PROTO_WS && proto != PNET_PROTO_WSS) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "url must be ws: or wss:"); goto out; }
    if (proto == PNET_PROTO_WSS && !rt->has_features_tls) { refuse(rt, PNET_ERROR_UNSUPPORTED, "this host does not provide network.websocket.client.tls"); goto out; }
    if (pnet_proto_is_plaintext(proto) && !rt->policy.insecure_transport) { refuse(rt, PNET_ERROR_PERMISSION_DENIED, "insecureTransport is not enabled"); goto out; }
    if (!pnet_policy_allows_connect(&rt->policy, proto, s->url.host, s->url.port)) { refuse(rt, PNET_ERROR_PERMISSION_DENIED, "endpoint is not an allowed connect rule"); goto out; }
  }
  {
    int protos = pnet_json_get(&doc, root, "protocols");
    if (protos >= 0) {
      if (pnet_json_type(&doc, protos) != PNET_J_ARRAY) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "protocols must be an array"); goto out; }
      pnet_sb sb;
      pnet_sb_init(&sb);
      for (int e = pnet_json_first(&doc, protos); e >= 0; e = pnet_json_next(&doc, e)) {
        if (!pnet_json_string(&doc, e, buf, sizeof buf, &blen) || !pnet_is_token(buf, blen) || protocol_requested(s, buf, blen)) {
          pnet_sb_free(rt, &sb);
          refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid subprotocol");
          goto out;
        }
        if (sb.len) pnet_sb_puts(rt, &sb, ", ");
        pnet_sb_append(rt, &sb, buf, blen);
        /* Keep the running list visible to protocol_requested() for dup checks. */
        if (s->protocols) pnet_free_str(rt, s->protocols);
        s->protocols = pnet_strdup_n(rt, pnet_sb_cstr(&sb), sb.len);
      }
      pnet_sb_free(rt, &sb);
    }
  }
  {
    int headers = pnet_json_get(&doc, root, "headers");
    if (headers >= 0) {
      if (pnet_json_type(&doc, headers) != PNET_J_OBJECT) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "headers must be an object"); goto out; }
      static const char *const forbidden[] = PWS_FORBIDDEN_HEADERS;
      uint32_t count = 0;
      for (int k = pnet_json_first(&doc, headers); k >= 0; k = pnet_json_next(&doc, k)) {
        char name[128];
        size_t nl;
        if (!pnet_json_string(&doc, k, name, sizeof name, &nl) || !pnet_is_token(name, nl)) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid header name"); goto out; }
        pnet_lower(name, nl);
        for (size_t i = 0; i < PWS_FORBIDDEN_HEADERS_COUNT; i++)
          if (strcmp(name, forbidden[i]) == 0) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "header owned by the core"); goto out; }
        size_t vl;
        char *value = pnet_json_string_dup(rt, &doc, doc.nodes[k].first_child, &vl);
        if (!value) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid header value"); goto out; }
        bool bad = false;
        for (size_t i = 0; i < vl; i++) {
          unsigned char ch = (unsigned char)value[i];
          if ((ch < 0x20 && ch != '\t') || ch == 0x7f) bad = true;
        }
        if (bad || ++count > PWS_MAX_HANDSHAKE_HEADERS) { pnet_free_str(rt, value); refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid header"); goto out; }
        pnet_sb_append(rt, &user_headers, name, nl);
        pnet_sb_puts(rt, &user_headers, ": ");
        pnet_sb_append(rt, &user_headers, value, vl);
        pnet_sb_puts(rt, &user_headers, "\r\n");
        pnet_free_str(rt, value);
      }
      if (user_headers.len > rt->cfg.http_max_header_bytes) { refuse(rt, PNET_ERROR_RESOURCE_LIMIT, "handshake headers exceed limits"); goto out; }
    }
  }
  {
    int t = pnet_json_get(&doc, root, "timeouts");
    s->connect_ms = rt->cfg.ws_default_connect_ms;
    s->close_ms = rt->cfg.ws_default_close_ms;
    if (t >= 0) {
      if (pnet_json_type(&doc, t) != PNET_J_OBJECT) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid timeouts"); goto out; }
      int n = pnet_json_get(&doc, t, "connectMs");
      if (n >= 0) {
        if (!pnet_json_i64(&doc, n, &v) || v < 1 || v > (int64_t)rt->cfg.ws_max_connect_ms) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid timeouts.connectMs"); goto out; }
        s->connect_ms = (uint32_t)v;
      }
      n = pnet_json_get(&doc, t, "closeMs");
      if (n >= 0) {
        if (!pnet_json_i64(&doc, n, &v) || v < 1 || v > (int64_t)rt->cfg.ws_max_connect_ms) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid timeouts.closeMs"); goto out; }
        s->close_ms = (uint32_t)v;
      }
    }
  }
  {
    int lim = pnet_json_get(&doc, root, "limits");
    s->max_message_bytes = rt->cfg.ws_max_message_bytes;
    s->receive_queue_bytes = rt->cfg.ws_max_receive_queue_bytes;
    s->receive_queue_messages = rt->cfg.ws_max_receive_queue_messages;
    s->send_queue_bytes = rt->cfg.ws_max_send_queue_bytes;
    if (lim >= 0) {
      if (pnet_json_type(&doc, lim) != PNET_J_OBJECT) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid limits"); goto out; }
      struct { const char *key; size_t *out; size_t max; } fields[] = {
          {"maxMessageBytes", &s->max_message_bytes, rt->cfg.ws_max_message_bytes},
          {"receiveQueueBytes", &s->receive_queue_bytes, rt->cfg.ws_max_receive_queue_bytes},
          {"sendQueueBytes", &s->send_queue_bytes, rt->cfg.ws_max_send_queue_bytes},
      };
      for (size_t i = 0; i < 3; i++) {
        int n = pnet_json_get(&doc, lim, fields[i].key);
        if (n < 0) continue;
        if (!pnet_json_i64(&doc, n, &v) || v < 1 || (uint64_t)v > fields[i].max) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid limits"); goto out; }
        *fields[i].out = (size_t)v;
      }
      int n = pnet_json_get(&doc, lim, "receiveQueueMessages");
      if (n >= 0) {
        if (!pnet_json_i64(&doc, n, &v) || v < 1 || v > (int64_t)rt->cfg.ws_max_receive_queue_messages) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid limits.receiveQueueMessages"); goto out; }
        s->receive_queue_messages = (uint32_t)v;
      }
    }
  }
  {
    int tls = pnet_json_get(&doc, root, "tls");
    if (tls >= 0) {
      int vn = pnet_json_get(&doc, tls, "verification");
      if (vn >= 0) {
        if (!pnet_json_string(&doc, vn, buf, sizeof buf, &blen)) { refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid tls.verification"); goto out; }
        if (strcmp(buf, "development-insecure") == 0) {
          if (!rt->cfg.development_build || !rt->policy.allow_invalid_tls_for_development) { refuse(rt, PNET_ERROR_UNSUPPORTED, "development-insecure TLS is not enabled"); goto out; }
        } else if (strcmp(buf, "full") != 0) {
          refuse(rt, PNET_ERROR_INVALID_REQUEST, "invalid tls.verification");
          goto out;
        }
      }
    }
  }
  if (!ws_build_request(rt, s, user_headers.data ? user_headers.data : "", user_headers.len)) { refuse(rt, PNET_ERROR_RESOURCE_LIMIT, "out of memory"); goto out; }
  s->handle = rt->ws_next_handle++;
  if (rt->ws_next_handle <= 0) rt->ws_next_handle = 1;
  s->state = WS_DIALING;
  rt->now = pnet_now(rt);
  s->deadline = rt->now + s->connect_ms;
  s->live_counted = true;
  rt->ws_live++;
  s->next = rt->ws_socks;
  rt->ws_socks = s;
  result = s->handle;
  {
    bool secure = strcmp(s->url.scheme, "wss") == 0;
    if (!pnet_dial_start(rt, &s->dial, &s->conn, s->url.host, s->url.port, secure, s->url.host, true)) {
      ws_fail(rt, s, s->dial.error_code ? s->dial.error_code : PNET_ERROR_CONNECT,
              s->dial.error_message ? s->dial.error_message : "connect failed", 0);
    }
  }
  s = NULL;
out:
  pnet_sb_free(rt, &user_headers);
  if (s) ws_free(rt, s);
  pnet_free(rt, nodes, (size_t)cap * sizeof(pnet_jnode));
  return result;
}

int pnet_ws_send(pnet_runtime *rt, int handle, int opcode, const uint8_t *payload, size_t len) {
  pnet_ws_sock *s = ws_find(rt, handle);
  if (!s || s->state != WS_OPEN || s->terminal) return PWS_SEND_CLOSED;
  if (opcode == PWS_OPCODE_PING || opcode == PWS_OPCODE_PONG) {
    if (len > PWS_CONTROL_PAYLOAD_MAX) return PWS_SEND_INVALID;
  } else if (opcode == PWS_OPCODE_TEXT || opcode == PWS_OPCODE_BINARY) {
    if (len > s->max_message_bytes) return PWS_SEND_INVALID;
    if (opcode == PWS_OPCODE_TEXT && !pnet_utf8_valid(payload, len)) return PWS_SEND_INVALID;
  } else {
    return PWS_SEND_INVALID;
  }
  size_t framed = len + 14;
  if (s->conn.tx.bytes + framed > s->send_queue_bytes) {
    s->drain_armed = true;
    return PWS_SEND_BACKPRESSURE;
  }
  if (!ws_write_frame(rt, s, (uint8_t)opcode, payload, len)) {
    s->drain_armed = true;
    return PWS_SEND_BACKPRESSURE;
  }
  if (s->conn.tx.bytes > rt->cfg.ws_send_high_water_bytes) {
    s->drain_armed = true;
    return PWS_SEND_ACCEPTED_HIGH_WATER;
  }
  return PWS_SEND_ACCEPTED;
}

int pnet_ws_receive_into(pnet_runtime *rt, int handle, uint8_t *dst, size_t len) {
  pnet_ws_sock *s = ws_find(rt, handle);
  if (!s || !s->binary_head) return -1;
  ws_message *m = s->binary_head;
  if (len < m->len) return -1;
  memcpy(dst, m->data, m->len);
  s->binary_head = m->next;
  if (!s->binary_head) s->binary_tail = NULL;
  int n = (int)m->len;
  s->queued_bytes = s->queued_bytes >= m->len ? s->queued_bytes - m->len : 0;
  if (s->queued_msgs) s->queued_msgs--;
  pnet_free(rt, m->data, m->len ? m->len : 1);
  pnet_free(rt, m, sizeof *m);
  if (s->state == WS_OPEN) ws_update_read_interest(rt, s);
  if (ws_retirable(s)) ws_unlink(rt, s);
  return n;
}

int pnet_ws_close(pnet_runtime *rt, int handle, int code, const char *reason, size_t reason_len) {
  pnet_ws_sock *s = ws_find(rt, handle);
  if (!s || s->state != WS_OPEN || s->terminal) return -1;
  if (code != 0 && code != 1000 && (code < 3000 || code > 4999)) return PWS_SEND_INVALID;
  if (reason_len > 123 || (reason_len && !pnet_utf8_valid((const uint8_t *)reason, reason_len))) return PWS_SEND_INVALID;
  s->local_close = true;
  s->close_code = code ? code : 1005;
  s->close_reason_len = reason_len;
  if (reason_len) memcpy(s->close_reason, reason, reason_len);
  ws_send_close_frame(rt, s, code, reason, reason_len);
  s->state = WS_CLOSING;
  s->deadline = pnet_now(rt) + s->close_ms;
  return 0;
}

void pnet_ws_terminate(pnet_runtime *rt, int handle) {
  pnet_ws_sock *s = ws_find(rt, handle);
  if (!s) return;
  if (s->terminal) {
    ws_unlink(rt, s);
    return;
  }
  if (s->state == WS_OPEN || s->state == WS_CLOSING) {
    ws_closed(rt, s, 1006, "", 0, false, true);
  } else {
    ws_fail(rt, s, PNET_ERROR_CANCELLED, "terminated", 0);
  }
}

int pnet_ws_buffered_amount(pnet_runtime *rt, int handle) {
  pnet_ws_sock *s = ws_find(rt, handle);
  if (!s || s->terminal) return -1;
  return (int)s->conn.tx.bytes;
}

const char *pnet_ws_poll(pnet_runtime *rt, size_t *len) {
  return pnet_queue_poll(rt, &rt->ws_queue, len);
}

const char *pnet_ws_poll_render(pnet_runtime *rt, size_t *len) {
  return pnet_queue_render(rt, &rt->ws_queue, len);
}

void pnet_ws_poll_consume(pnet_runtime *rt) {
  pnet_queue_consume(rt, &rt->ws_queue);
}

const char *pnet_ws_last_error(pnet_runtime *rt) {
  return pnet_sb_cstr(&rt->ws_last_error);
}

const char *pnet_ws_limits(pnet_runtime *rt) {
  return rt->ws_limits_json ? rt->ws_limits_json : "{}";
}
