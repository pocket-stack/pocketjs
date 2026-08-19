/* Internal definitions shared by the network core sources. Not installed. */
#ifndef PNET_INTERNAL_H
#define PNET_INTERNAL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "pocketjs/net/driver.h"
#include "pocketjs/net/platform.h"
#include "pocketjs/net/runtime.h"
#include "pocketjs/net/spec.h"

/* ------------------------------------------------------------------------ */
/* Allocation                                                                */
/* ------------------------------------------------------------------------ */

void *pnet_alloc(pnet_runtime *rt, size_t size);
void *pnet_zalloc(pnet_runtime *rt, size_t size);
void pnet_free(pnet_runtime *rt, void *ptr, size_t size);
char *pnet_strdup_n(pnet_runtime *rt, const char *s, size_t len);
static inline void pnet_free_str(pnet_runtime *rt, char *s) {
  if (s) pnet_free(rt, s, strlen(s) + 1);
}
void pnet_logf(pnet_runtime *rt, pnet_log_level level, const char *fmt, ...);

/* ------------------------------------------------------------------------ */
/* String builder                                                            */
/* ------------------------------------------------------------------------ */

typedef struct pnet_sb {
  char *data;
  size_t len;
  size_t cap;
  bool failed;
} pnet_sb;

void pnet_sb_init(pnet_sb *sb);
void pnet_sb_free(pnet_runtime *rt, pnet_sb *sb);
bool pnet_sb_reserve(pnet_runtime *rt, pnet_sb *sb, size_t extra);
void pnet_sb_append(pnet_runtime *rt, pnet_sb *sb, const void *data, size_t len);
void pnet_sb_puts(pnet_runtime *rt, pnet_sb *sb, const char *s);
void pnet_sb_putc(pnet_runtime *rt, pnet_sb *sb, char c);
void pnet_sb_printf(pnet_runtime *rt, pnet_sb *sb, const char *fmt, ...);
/** Append a JSON string literal (with quotes), escaping as needed. Invalid
 * UTF-8 bytes are replaced by U+FFFD so the batch is always valid JSON. */
void pnet_sb_json_string(pnet_runtime *rt, pnet_sb *sb, const char *s, size_t len);
/** Reset length to zero, keeping the buffer. */
static inline void pnet_sb_clear(pnet_sb *sb) {
  sb->len = 0;
  sb->failed = false;
  if (sb->data) sb->data[0] = 0;
}
/** NUL-terminated view (always valid, "" when empty). */
const char *pnet_sb_cstr(pnet_sb *sb);

/* ------------------------------------------------------------------------ */
/* Byte queue (segment list)                                                 */
/* ------------------------------------------------------------------------ */

typedef struct pnet_seg {
  struct pnet_seg *next;
  size_t cap;
  size_t len;
  size_t off;
  uint8_t data[1];
} pnet_seg;

typedef struct pnet_bq {
  pnet_seg *head;
  pnet_seg *tail;
  size_t bytes;
} pnet_bq;

void pnet_bq_init(pnet_bq *q);
void pnet_bq_free(pnet_runtime *rt, pnet_bq *q);
/** Append bytes (allocates segments of `seg_bytes` or larger). false on OOM. */
bool pnet_bq_push(pnet_runtime *rt, pnet_bq *q, const void *data, size_t len, size_t seg_bytes);
/** Copy out and consume up to `len` bytes; returns the count. */
size_t pnet_bq_read(pnet_runtime *rt, pnet_bq *q, uint8_t *dst, size_t len);
/** Peek at the head contiguous span (for write() calls); 0 when empty. */
size_t pnet_bq_peek(pnet_bq *q, const uint8_t **ptr);
/** Consume `n` bytes from the head. */
void pnet_bq_consume(pnet_runtime *rt, pnet_bq *q, size_t n);
static inline size_t pnet_bq_bytes(const pnet_bq *q) { return q->bytes; }

/* ------------------------------------------------------------------------ */
/* Codecs and small helpers                                                  */
/* ------------------------------------------------------------------------ */

bool pnet_utf8_valid(const uint8_t *s, size_t len);
/** Incremental UTF-8 validator state (for fragmented WebSocket text). */
typedef struct pnet_utf8_state {
  uint32_t need;   /* continuation bytes still expected */
  uint32_t cp;     /* code point accumulator */
  uint32_t lower;  /* minimum code point for the sequence (overlong check) */
} pnet_utf8_state;
void pnet_utf8_state_init(pnet_utf8_state *st);
bool pnet_utf8_feed(pnet_utf8_state *st, const uint8_t *s, size_t len);
static inline bool pnet_utf8_complete(const pnet_utf8_state *st) { return st->need == 0; }

size_t pnet_base64_encode(const uint8_t *in, size_t len, char *out, size_t cap);
void pnet_sha1(const uint8_t *data, size_t len, uint8_t out[20]);

bool pnet_is_token(const char *s, size_t len);
bool pnet_ieq_n(const char *a, size_t alen, const char *b);   /* case-insensitive equals a C string */
void pnet_lower(char *s, size_t len);
bool pnet_parse_u64(const char *s, size_t len, uint64_t *out);
bool pnet_parse_ipv4(const char *s, size_t len, uint8_t out[4]);
bool pnet_parse_ipv6(const char *s, size_t len, uint8_t out[16]);
/** Parse "1.2.3.4" or "[::1]"/"::1" into an address; false if not a literal. */
bool pnet_parse_ip_literal(const char *s, size_t len, pnet_addr *out);
/** Format an address (without port) into `out` (>= 46 bytes). */
void pnet_format_addr(const pnet_addr *addr, char *out, size_t cap);
/** Loopback / link-local / private / multicast / unspecified classification. */
bool pnet_hostname_valid(const char *s, size_t len);
/** Shared HTTP status semantics (spec.h): membership, RFC 9112 bodyless
 * framing (1xx/204/304), Fetch null-body statuses. */
bool pnet_status_in(int status, const int *list, size_t count);
bool pnet_status_is_bodyless(int status);
bool pnet_status_is_null_body(int status);
/** Redirect plan for `status`: false = not a followed redirect; true with
 * *to_get = the method becomes GET (body dropped) per the spec table. */
bool pnet_http_redirect_plan(int status, const char *method, size_t method_len, bool *to_get);
bool pnet_addr_is_public(const pnet_addr *addr);
bool pnet_addr_is_multicast(const pnet_addr *addr);

/* ------------------------------------------------------------------------ */
/* JSON reader                                                               */
/* ------------------------------------------------------------------------ */

typedef enum pnet_jtype {
  PNET_J_NULL,
  PNET_J_BOOL,
  PNET_J_NUMBER,
  PNET_J_STRING,
  PNET_J_ARRAY,
  PNET_J_OBJECT,
} pnet_jtype;

typedef struct pnet_jnode {
  uint8_t type;
  bool truthy;        /* for bool */
  const char *raw;    /* string body (without quotes, still escaped) / number text / key;
                         for objects and arrays the whole source span `{…}` / `[…]` */
  size_t raw_len;
  int first_child;    /* array element / object member (member = key node with one child) */
  int next;           /* next sibling */
} pnet_jnode;

typedef struct pnet_jdoc {
  pnet_jnode *nodes;
  int count;
  int cap;
} pnet_jdoc;

/** Parse `text` into `nodes` (caller-provided, `cap` entries). Returns the
 * root index or -1. Objects: children are KEY nodes (type STRING) whose
 * first_child is the value. */
int pnet_json_parse(pnet_jdoc *doc, pnet_jnode *nodes, int cap, const char *text, size_t len);
/** Object member value by key, or -1. */
int pnet_json_get(const pnet_jdoc *doc, int object, const char *key);
/** Unescape a STRING node into out (NUL-terminated); false if it does not fit
 * or the escape sequence is invalid. */
bool pnet_json_string(const pnet_jdoc *doc, int node, char *out, size_t cap, size_t *out_len);
/** Allocate an unescaped copy of a STRING node. */
char *pnet_json_string_dup(pnet_runtime *rt, const pnet_jdoc *doc, int node, size_t *out_len);
/** Number as int64 (integers only); false if not integral. */
bool pnet_json_i64(const pnet_jdoc *doc, int node, int64_t *out);
static inline pnet_jtype pnet_json_type(const pnet_jdoc *doc, int node) {
  return node < 0 ? PNET_J_NULL : (pnet_jtype)doc->nodes[node].type;
}
/** Iterate members: returns key node index; value = nodes[key].first_child. */
static inline int pnet_json_first(const pnet_jdoc *doc, int container) {
  return container < 0 ? -1 : doc->nodes[container].first_child;
}
static inline int pnet_json_next(const pnet_jdoc *doc, int node) {
  return node < 0 ? -1 : doc->nodes[node].next;
}
bool pnet_json_key_is(const pnet_jdoc *doc, int key, const char *name);

/* ------------------------------------------------------------------------ */
/* URL                                                                       */
/* ------------------------------------------------------------------------ */

typedef struct pnet_url {
  char scheme[8];      /* lowercase: http, https, ws, wss */
  char *host;          /* lowercase hostname or IP literal without brackets */
  bool host_is_ipv6;
  uint16_t port;       /* effective port */
  bool port_explicit;
  char *path;          /* "/path?query" (request-target); at least "/" */
  size_t path_len;
} pnet_url;

/** Parse an absolute http(s)/ws(s) URL. Returns false on syntax error. Fields
 * are allocated from the runtime; free with pnet_url_free. */
bool pnet_url_parse(pnet_runtime *rt, const char *text, size_t len, pnet_url *out);
/** Resolve `location` (absolute or relative) against `base`; a new URL. */
bool pnet_url_resolve(pnet_runtime *rt, const pnet_url *base, const char *location, size_t len, pnet_url *out);
void pnet_url_free(pnet_runtime *rt, pnet_url *url);
/** Serialize "scheme://host[:port]path" into sb. */
void pnet_url_write(pnet_runtime *rt, pnet_sb *sb, const pnet_url *url);
/** Same scheme+host+port. */
bool pnet_url_same_origin(const pnet_url *a, const pnet_url *b);
static inline bool pnet_url_is_tls(const pnet_url *u) {
  return strcmp(u->scheme, "https") == 0 || strcmp(u->scheme, "wss") == 0;
}
static inline uint16_t pnet_url_default_port(const char *scheme) {
  return (strcmp(scheme, "https") == 0 || strcmp(scheme, "wss") == 0) ? 443 : 80;
}

/* ------------------------------------------------------------------------ */
/* Policy                                                                    */
/* ------------------------------------------------------------------------ */

typedef enum pnet_proto {
  PNET_PROTO_HTTP = 0,
  PNET_PROTO_HTTPS,
  PNET_PROTO_WS,
  PNET_PROTO_WSS,
  PNET_PROTO_COUNT,
} pnet_proto;

typedef struct pnet_rule {
  uint8_t proto;
  char *host;          /* normalized DNS name (may start with "*." ) or IP literal text */
  pnet_addr ip;        /* valid when is_ip */
  bool is_ip;
  bool wildcard;
  bool ephemeral;      /* listen only */
  uint16_t port_min;
  uint16_t port_max;
} pnet_rule;

typedef struct pnet_policy {
  pnet_rule *connect;
  size_t connect_count;
  pnet_rule *listen;
  size_t listen_count;
  char **credentials;
  size_t credential_count;
  bool insecure_transport;
  bool local_network;
  bool allow_invalid_tls_for_development;
} pnet_policy;

bool pnet_policy_parse(pnet_runtime *rt, pnet_policy *policy, const char *json);
void pnet_policy_free(pnet_runtime *rt, pnet_policy *policy);
/** Endpoint tuple check (before DNS). */
bool pnet_policy_allows_connect(const pnet_policy *p, pnet_proto proto, const char *host, uint16_t port);
/** Per-address check after DNS. */
bool pnet_policy_allows_address(const pnet_policy *p, const pnet_addr *addr);
bool pnet_policy_allows_listen(const pnet_policy *p, pnet_proto proto, const pnet_addr *addr, uint16_t port);
bool pnet_policy_has_credential(const pnet_policy *p, const char *id);
pnet_proto pnet_proto_from_scheme(const char *scheme);
bool pnet_proto_is_plaintext(pnet_proto proto);

/* ------------------------------------------------------------------------ */
/* HTTP/1.1 wire                                                             */
/* ------------------------------------------------------------------------ */

#define PNET_H1_MAX_FIELDS 64

typedef struct pnet_h1_field {
  char *name;      /* lowercased in place */
  size_t name_len;
  char *value;
  size_t value_len;
} pnet_h1_field;

typedef struct pnet_h1_head {
  bool request;
  /* request */
  char *method;
  size_t method_len;
  char *target;
  size_t target_len;
  /* response */
  int status;
  char *reason;
  size_t reason_len;
  /* both */
  int minor_version;   /* 0 or 1 */
  pnet_h1_field fields[PNET_H1_MAX_FIELDS];
  size_t field_count;
  int64_t content_length;  /* -1 = absent */
  bool chunked;
  bool connection_close;
  bool connection_keep_alive;
  bool has_upgrade;
  bool expect_continue;
  size_t head_len;        /* bytes consumed by the head incl. CRLFCRLF */
} pnet_h1_head;

enum {
  PNET_H1_OK = 0,
  PNET_H1_INCOMPLETE = 1,
  PNET_H1_ERROR = -1,        /* malformed / framing violation */
  PNET_H1_TOO_LARGE = -2,    /* header block over the limit */
  PNET_H1_TARGET_TOO_LONG = -3,
  PNET_H1_TOO_MANY_FIELDS = -4,
};

/** Parse a head in place from buf[0..len). On PNET_H1_OK, `out` points into
 * buf (names lowercased, values trimmed). max_head_bytes bounds the search
 * for CRLFCRLF; the caller stops feeding when len exceeds it. */
int pnet_h1_parse_head(uint8_t *buf, size_t len, bool request, size_t max_head_bytes,
                       size_t max_fields, size_t max_target_bytes, pnet_h1_head *out);
const pnet_h1_field *pnet_h1_find(const pnet_h1_head *head, const char *name);
/** Framing validation of the parsed field set (TE/CL rules). false = reject. */
bool pnet_h1_validate_framing(pnet_h1_head *head);

typedef enum pnet_h1_body_mode {
  PNET_H1_BODY_NONE = 0,
  PNET_H1_BODY_LENGTH,
  PNET_H1_BODY_CHUNKED,
  PNET_H1_BODY_CLOSE,
} pnet_h1_body_mode;

typedef struct pnet_h1_body {
  uint8_t mode;
  uint8_t chunk_state;
  bool done;
  bool error;
  uint64_t remaining;      /* LENGTH: bytes left; CHUNKED: bytes left in chunk */
  size_t line_len;
  char line[512];          /* chunk-size line / trailer line accumulator */
  size_t trailer_bytes;
  size_t trailer_fields;
} pnet_h1_body;

void pnet_h1_body_init(pnet_h1_body *b, pnet_h1_body_mode mode, uint64_t length);
/** Feed input; body bytes are reported through `sink` (may be called several
 * times). Returns bytes consumed from `in` (may stop early when done). Sets
 * b->done at message end, b->error on framing violation. `sink` returns
 * false to stop (backpressure); the caller re-feeds later. */
size_t pnet_h1_body_feed(pnet_h1_body *b, const uint8_t *in, size_t len,
                         bool (*sink)(void *ctx, const uint8_t *data, size_t len), void *ctx);
/** Field names that may not appear in a trailer (protocol error). */
bool pnet_h1_trailer_field_forbidden(const char *name, size_t len);

/* ------------------------------------------------------------------------ */
/* Events / tick queue                                                       */
/* ------------------------------------------------------------------------ */

typedef struct pnet_event {
  struct pnet_event *next;
  uint64_t seq;
  int handle;          /* h or req */
  bool terminal;       /* barrier: a frozen `readable` for the handle is inserted before it */
  bool readable;       /* a frozen `readable` announcement */
  size_t weight;       /* bytes charged to the tick budget */
  char *json;
  size_t json_len;
} pnet_event;

typedef struct pnet_queue {
  pnet_event *pending_head;
  pnet_event *pending_tail;
  size_t pending_count;
  pnet_event *visible_head;
  pnet_event *visible_tail;
  size_t visible_count;
  pnet_sb poll_buf;
  /** A batch is rendered in poll_buf and not yet consumed (two-phase poll);
   * rendered_count = the visible events it covers. */
  bool rendered;
  size_t rendered_count;
  /** Logged once per out-of-memory episode. */
  bool starved;
  uint32_t max_events;
  size_t max_bytes;
} pnet_queue;

void pnet_queue_init(pnet_queue *q, uint32_t max_events, size_t max_bytes);
void pnet_queue_free(pnet_runtime *rt, pnet_queue *q);
/** Take ownership of `json` (allocated with pnet_alloc, len+1 bytes). */
bool pnet_queue_push(pnet_runtime *rt, pnet_queue *q, int handle, bool terminal, size_t weight,
                     char *json, size_t json_len);
/** Push a `readable` for `handle` ahead of its terminal event (or at the
 * end); called from begin_tick. */
bool pnet_queue_push_readable(pnet_runtime *rt, pnet_queue *q, int handle, const char *field,
                              size_t avail);
/** Move pending events into the visible set under the budget. */
void pnet_queue_freeze(pnet_runtime *rt, pnet_queue *q);
/** Render the visible set into the queue's buffer WITHOUT consuming it (NULL
 * when empty or when the batch cannot be allocated right now — the events
 * stay visible and the next render retries). Calling it again before
 * consume returns the same batch. */
const char *pnet_queue_render(pnet_runtime *rt, pnet_queue *q, size_t *len);
/** Consume the rendered batch: dequeue and free exactly the events it
 * carries. No-op without a rendered batch. */
void pnet_queue_consume(pnet_runtime *rt, pnet_queue *q);
/** render + consume: the single-call poll. The text stays valid until the
 * next render. Transactional: an allocation failure consumes nothing. */
const char *pnet_queue_poll(pnet_runtime *rt, pnet_queue *q, size_t *len);
/** Drop every event of a handle (guest cancel of a terminal-less handle). */
void pnet_queue_drop_handle(pnet_runtime *rt, pnet_queue *q, int handle);

/** Build an event JSON object: `fmt` is appended after `{"t":"<t>","h":<h>` /
 * `"req":<r>`; the caller supplies the remaining `,"k":v` pairs and this
 * closes the object. Returns an allocated string (or NULL). */
char *pnet_event_json(pnet_runtime *rt, const char *t, const char *id_key, int id, const char *tail,
                      size_t tail_len, size_t *out_len);
/** Convenience: `{"t":"error","h":n,"code":"...","message":"..."[,"causeCode":"..."]}`. */
bool pnet_push_error_event(pnet_runtime *rt, pnet_queue *q, const char *id_key, int id, const char *code,
                           const char *message, const char *cause);

/* ------------------------------------------------------------------------ */
/* Connection                                                                */
/* ------------------------------------------------------------------------ */

typedef enum pnet_conn_state {
  PNET_CONN_IDLE = 0,
  PNET_CONN_CONNECTING,
  PNET_CONN_OPEN,
  PNET_CONN_CLOSED,
} pnet_conn_state;

typedef enum pnet_tls_phase {
  PNET_TLS_NONE = 0,     /* plaintext connection */
  PNET_TLS_HANDSHAKE,    /* TLS handshake in progress */
  PNET_TLS_UP,           /* TLS session established */
  PNET_TLS_ERROR,        /* handshake failed (failure captured) */
} pnet_tls_phase;

typedef struct pnet_conn {
  pnet_sock sock;
  uint8_t state;
  bool read_wanted;      /* protocol wants to read (queue not full) */
  bool eof;              /* peer finished writing */
  bool write_shutdown;   /* shutdown requested; performed once tx drains */
  bool shutdown_done;
  bool tx_error;
  int last_error;        /* PNET_IO_* */
  unsigned interest;
  pnet_bq tx;
  pnet_addr remote;
  /* TLS (client). `tls` is the runtime's provider or NULL. */
  const pnet_tls_ops *tls;
  void *tls_ctx;
  uint8_t tls_phase;
  bool secure;
  pnet_tls_failure tls_failure;
  char server_name[256];
  bool tls_verify;
} pnet_conn;

void pnet_conn_init(pnet_conn *c);
/** Arm this connection for TLS: once the plain socket connects, a handshake
 * runs before the connection reports open. `server_name` is SNI + DNS-ID. */
void pnet_conn_set_tls(pnet_conn *c, const pnet_tls_ops *tls, void *tls_ctx, const char *server_name, bool verify);
/** Drive the TLS handshake after the plain connect completed: 0 pending,
 * 1 established, <0 failed (c->tls_failure set). */
int pnet_conn_tls_step(pnet_runtime *rt, pnet_conn *c);
/** Start a non-blocking connect; false when the driver refused. */
bool pnet_conn_connect(pnet_runtime *rt, pnet_conn *c, const pnet_addr *addr, int *err);
/** Adopt an accepted socket. */
void pnet_conn_adopt(pnet_runtime *rt, pnet_conn *c, pnet_sock s, const pnet_addr *peer);
/** Poll connect completion: 0 pending, 1 open, <0 error. */
int pnet_conn_connect_status(pnet_runtime *rt, pnet_conn *c);
/** Queue outbound bytes. */
bool pnet_conn_write(pnet_runtime *rt, pnet_conn *c, const void *data, size_t len);
/** Push queued bytes to the driver; returns false on transport error. */
bool pnet_conn_flush(pnet_runtime *rt, pnet_conn *c);
/** Read available bytes into buf: > 0, PNET_IO_AGAIN, PNET_IO_EOF, or error. */
int pnet_conn_read(pnet_runtime *rt, pnet_conn *c, uint8_t *buf, size_t len);
void pnet_conn_update_interest(pnet_runtime *rt, pnet_conn *c);
void pnet_conn_shutdown_write(pnet_runtime *rt, pnet_conn *c);
void pnet_conn_close(pnet_runtime *rt, pnet_conn *c);
static inline bool pnet_conn_is_open(const pnet_conn *c) { return c->state == PNET_CONN_OPEN; }
static inline size_t pnet_conn_tx_bytes(const pnet_conn *c) { return c->tx.bytes; }

/* ------------------------------------------------------------------------ */
/* Dialer: resolve + candidate connect with policy                           */
/* ------------------------------------------------------------------------ */

#define PNET_DIAL_MAX_CANDIDATES 8

typedef enum pnet_dial_state {
  PNET_DIAL_IDLE = 0,
  PNET_DIAL_RESOLVING,
  PNET_DIAL_CONNECTING,
  PNET_DIAL_OPEN,
  PNET_DIAL_FAILED,
} pnet_dial_state;

typedef struct pnet_dial {
  uint8_t state;
  uint32_t resolve_req;
  pnet_addr candidates[PNET_DIAL_MAX_CANDIDATES];
  size_t candidate_count;
  size_t next_candidate;
  uint16_t port;
  const char *error_code;    /* stable code on failure */
  const char *error_message; /* set for TLS/clock failures */
  int cause;                 /* PNET_IO_* */
  bool filtered_all;         /* every address rejected by policy */
  bool secure;               /* run a TLS handshake before reporting open */
  bool tls_up;               /* handshake completed */
} pnet_dial;

/** Begin: literal IPs skip the resolver. false = synchronous failure
 * (error_code set). When `secure`, the connection is armed for TLS with
 * `server_name` (SNI/DNS-ID) and the handshake runs before PNET_DIAL_OPEN. */
bool pnet_dial_start(pnet_runtime *rt, pnet_dial *d, pnet_conn *c, const char *host, uint16_t port,
                     bool secure, const char *server_name, bool verify);
/** Advance (call from service or after resolve_done). Returns the state. */
int pnet_dial_step(pnet_runtime *rt, pnet_dial *d, pnet_conn *c);
void pnet_dial_resolved(pnet_runtime *rt, pnet_dial *d, const pnet_addr *addrs, size_t count, int err);
void pnet_dial_cancel(pnet_runtime *rt, pnet_dial *d);

/* ------------------------------------------------------------------------ */
/* Runtime                                                                   */
/* ------------------------------------------------------------------------ */

typedef struct pnet_resolve_slot {
  uint32_t req_id;
  pnet_dial *dial;
} pnet_resolve_slot;

#define PNET_RESOLVE_SLOTS 16

struct pnet_http_req;
struct pnet_ws_sock;
struct pnet_httpd_server;

struct pnet_runtime {
  pnet_platform platform;
  pnet_driver_ops driver;
  void *driver_ctx;
  const pnet_tls_ops *tls;
  void *tls_ctx;
  pnet_runtime_config cfg;
  pnet_policy policy;
  size_t heap_bytes;
  size_t heap_high_water;
  uint64_t seq;
  uint64_t now;                 /* cached at service()/begin_tick() */
  bool quiesced;
  bool has_features_tls;
  uint32_t next_resolve_id;
  pnet_resolve_slot resolves[PNET_RESOLVE_SLOTS];

  /* net */
  pnet_queue http_queue;
  struct pnet_http_req *http_reqs;   /* linked list */
  uint32_t http_live;
  int http_next_handle;
  pnet_sb http_last_error;
  char *http_limits_json;

  /* ws */
  pnet_queue ws_queue;
  struct pnet_ws_sock *ws_socks;
  uint32_t ws_live;
  int ws_next_handle;
  pnet_sb ws_last_error;
  char *ws_limits_json;

  /* httpd */
  pnet_queue httpd_queue;
  struct pnet_httpd_server *httpd_servers;
  uint32_t httpd_live;
  int httpd_next_handle;
  int httpd_next_req;
  pnet_sb httpd_last_error;
  char *httpd_limits_json;
};

uint64_t pnet_now(pnet_runtime *rt);
static inline const pnet_driver_ops *pnet_drv(pnet_runtime *rt) { return &rt->driver; }
/** Set `<code>: <message>` for a module's lastError. */
void pnet_set_last_error(pnet_runtime *rt, pnet_sb *sb, const char *code, const char *message);
const char *pnet_io_error_code(int io_err);

/* Module hooks used by the runtime */
void pnet_http_init(pnet_runtime *rt);
void pnet_http_shutdown(pnet_runtime *rt);
void pnet_http_service(pnet_runtime *rt);
void pnet_http_freeze(pnet_runtime *rt);
uint64_t pnet_http_next_deadline(pnet_runtime *rt);
bool pnet_http_has_output(pnet_runtime *rt);
void pnet_http_quiesce(pnet_runtime *rt);

void pnet_ws_init(pnet_runtime *rt);
void pnet_ws_shutdown(pnet_runtime *rt);
void pnet_ws_service(pnet_runtime *rt);
void pnet_ws_freeze(pnet_runtime *rt);
uint64_t pnet_ws_next_deadline(pnet_runtime *rt);
bool pnet_ws_has_output(pnet_runtime *rt);
void pnet_ws_quiesce(pnet_runtime *rt);

void pnet_httpd_init(pnet_runtime *rt);
void pnet_httpd_shutdown(pnet_runtime *rt);
void pnet_httpd_service(pnet_runtime *rt);
void pnet_httpd_freeze(pnet_runtime *rt);
uint64_t pnet_httpd_next_deadline(pnet_runtime *rt);
bool pnet_httpd_has_output(pnet_runtime *rt);
void pnet_httpd_quiesce(pnet_runtime *rt);

/* Deadline helper */
static inline uint64_t pnet_min_deadline(uint64_t a, uint64_t b) {
  if (a == 0) return b;
  if (b == 0) return a;
  return a < b ? a : b;
}

#endif /* PNET_INTERNAL_H */
