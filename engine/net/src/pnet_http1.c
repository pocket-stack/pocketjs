/* HTTP/1.1 message syntax (RFC 9112) with a strict framing profile:
 * TE+CL rejected, only a single
 * `chunked`, a single Content-Length, no obs-fold, bounded head, chunked
 * trailers parsed and validated then discarded. Shared by the client and the
 * server cores. */
#include "pnet_internal.h"

static bool is_ows(char c) { return c == ' ' || c == '\t'; }

static bool valid_field_value(const char *v, size_t len) {
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)v[i];
    if (c == '\t') continue;
    if (c < 0x20 || c == 0x7f) return false;
  }
  return true;
}

const pnet_h1_field *pnet_h1_find(const pnet_h1_head *head, const char *name) {
  size_t nl = strlen(name);
  for (size_t i = 0; i < head->field_count; i++) {
    if (head->fields[i].name_len == nl && memcmp(head->fields[i].name, name, nl) == 0) return &head->fields[i];
  }
  return NULL;
}

/** Iterate comma-separated tokens in a field value; calls fn for each
 * trimmed token. */
static void for_each_token(const char *v, size_t len, void (*fn)(void *ctx, const char *tok, size_t n), void *ctx) {
  size_t i = 0;
  while (i <= len) {
    size_t j = i;
    while (j < len && v[j] != ',') j++;
    size_t a = i, b = j;
    while (a < b && is_ows(v[a])) a++;
    while (b > a && is_ows(v[b - 1])) b--;
    if (b > a) fn(ctx, v + a, b - a);
    if (j >= len) break;
    i = j + 1;
  }
}

typedef struct conn_scan {
  bool close;
  bool keep_alive;
  bool upgrade;
} conn_scan;

static void scan_connection(void *ctx, const char *tok, size_t n) {
  conn_scan *s = ctx;
  if (pnet_ieq_n(tok, n, "close")) s->close = true;
  else if (pnet_ieq_n(tok, n, "keep-alive")) s->keep_alive = true;
  else if (pnet_ieq_n(tok, n, "upgrade")) s->upgrade = true;
}

typedef struct te_scan {
  int chunked_count;
  int other_count;
} te_scan;

static void scan_te(void *ctx, const char *tok, size_t n) {
  te_scan *s = ctx;
  if (pnet_ieq_n(tok, n, "chunked")) s->chunked_count++;
  else s->other_count++;
}

int pnet_h1_parse_head(uint8_t *buf, size_t len, bool request, size_t max_head_bytes, size_t max_fields,
                       size_t max_target_bytes, pnet_h1_head *out) {
  /* Locate the end of the head. */
  size_t limit = len < max_head_bytes + 4 ? len : max_head_bytes + 4;
  size_t end = 0;
  bool found = false;
  for (size_t i = 0; i + 3 < limit; i++) {
    if (buf[i] == '\r' && buf[i + 1] == '\n' && buf[i + 2] == '\r' && buf[i + 3] == '\n') {
      end = i + 4;
      found = true;
      break;
    }
  }
  if (!found) return len > max_head_bytes ? PNET_H1_TOO_LARGE : PNET_H1_INCOMPLETE;
  if (end - 4 > max_head_bytes) return PNET_H1_TOO_LARGE;
  memset(out, 0, sizeof *out);
  out->request = request;
  out->content_length = -1;
  out->head_len = end;
  char *s = (char *)buf;
  size_t pos = 0;
  /* Start line */
  size_t eol = pos;
  while (eol + 1 < end && !(s[eol] == '\r' && s[eol + 1] == '\n')) eol++;
  if (request) {
    size_t sp1 = pos;
    while (sp1 < eol && s[sp1] != ' ') sp1++;
    if (sp1 == pos || sp1 >= eol) return PNET_H1_ERROR;
    size_t sp2 = sp1 + 1;
    while (sp2 < eol && s[sp2] != ' ') sp2++;
    if (sp2 >= eol || sp2 == sp1 + 1) return PNET_H1_ERROR;
    if (!pnet_is_token(s + pos, sp1 - pos)) return PNET_H1_ERROR;
    out->method = s + pos;
    out->method_len = sp1 - pos;
    out->target = s + sp1 + 1;
    out->target_len = sp2 - sp1 - 1;
    if (out->target_len > max_target_bytes) return PNET_H1_TARGET_TOO_LONG;
    for (size_t i = 0; i < out->target_len; i++) {
      unsigned char c = (unsigned char)out->target[i];
      if (c <= 0x20 || c == 0x7f) return PNET_H1_ERROR;
    }
    const char *ver = s + sp2 + 1;
    size_t vlen = eol - sp2 - 1;
    if (vlen != 8 || memcmp(ver, "HTTP/1.", 7) != 0 || (ver[7] != '0' && ver[7] != '1')) return PNET_H1_ERROR;
    out->minor_version = ver[7] - '0';
  } else {
    if (eol - pos < 12 || memcmp(s + pos, "HTTP/1.", 7) != 0 || (s[pos + 7] != '0' && s[pos + 7] != '1') || s[pos + 8] != ' ')
      return PNET_H1_ERROR;
    out->minor_version = s[pos + 7] - '0';
    const char *st = s + pos + 9;
    if (st[0] < '0' || st[0] > '9' || st[1] < '0' || st[1] > '9' || st[2] < '0' || st[2] > '9') return PNET_H1_ERROR;
    out->status = (st[0] - '0') * 100 + (st[1] - '0') * 10 + (st[2] - '0');
    if (out->status < 100) return PNET_H1_ERROR;
    size_t after = pos + 12;
    if (after < eol) {
      if (s[after] != ' ') return PNET_H1_ERROR;
      out->reason = s + after + 1;
      out->reason_len = eol - after - 1;
      if (!valid_field_value(out->reason, out->reason_len)) return PNET_H1_ERROR;
    } else if (after != eol) {
      return PNET_H1_ERROR;
    }
  }
  pos = eol + 2;
  /* Fields */
  int cl_count = 0;
  bool te_present = false;
  te_scan te = {0, 0};
  conn_scan cs = {false, false, false};
  while (pos < end - 2) {
    eol = pos;
    while (eol + 1 < end && !(s[eol] == '\r' && s[eol + 1] == '\n')) eol++;
    if (eol == pos) break; /* empty line: end of head */
    if (is_ows(s[pos])) return PNET_H1_ERROR; /* obs-fold */
    size_t colon = pos;
    while (colon < eol && s[colon] != ':') colon++;
    if (colon >= eol || colon == pos) return PNET_H1_ERROR;
    if (!pnet_is_token(s + pos, colon - pos)) return PNET_H1_ERROR;
    if (out->field_count >= max_fields || out->field_count >= PNET_H1_MAX_FIELDS) return PNET_H1_TOO_MANY_FIELDS;
    size_t va = colon + 1;
    size_t vb = eol;
    while (va < vb && is_ows(s[va])) va++;
    while (vb > va && is_ows(s[vb - 1])) vb--;
    if (!valid_field_value(s + va, vb - va)) return PNET_H1_ERROR;
    pnet_h1_field *f = &out->fields[out->field_count++];
    f->name = s + pos;
    f->name_len = colon - pos;
    pnet_lower(f->name, f->name_len);
    f->value = s + va;
    f->value_len = vb - va;
    /* NUL-terminate name/value in place (over the ':'/CR) for C callers:
     * the ':' after the name and the CR after the value are ours. */
    f->name[f->name_len] = 0;
    f->value[f->value_len] = 0;
    /* Framing fields */
    if (f->name_len == 14 && memcmp(f->name, "content-length", 14) == 0) {
      cl_count++;
      if (memchr(f->value, ',', f->value_len)) return PNET_H1_ERROR;
      uint64_t v;
      if (!pnet_parse_u64(f->value, f->value_len, &v) || v > (uint64_t)INT64_MAX) return PNET_H1_ERROR;
      out->content_length = (int64_t)v;
    } else if (f->name_len == 17 && memcmp(f->name, "transfer-encoding", 17) == 0) {
      te_present = true;
      for_each_token(f->value, f->value_len, scan_te, &te);
    } else if (f->name_len == 10 && memcmp(f->name, "connection", 10) == 0) {
      for_each_token(f->value, f->value_len, scan_connection, &cs);
    } else if (f->name_len == 7 && memcmp(f->name, "upgrade", 7) == 0) {
      out->has_upgrade = true;
    } else if (f->name_len == 6 && memcmp(f->name, "expect", 6) == 0) {
      if (pnet_ieq_n(f->value, f->value_len, "100-continue")) out->expect_continue = true;
      else return PNET_H1_ERROR;
    }
    pos = eol + 2;
  }
  if (cl_count > 1) return PNET_H1_ERROR;
  if (te_present) {
    if (te.chunked_count != 1 || te.other_count != 0) return PNET_H1_ERROR;
    if (cl_count > 0) return PNET_H1_ERROR;
    if (out->minor_version == 0) return PNET_H1_ERROR;
    out->chunked = true;
  }
  out->connection_close = cs.close;
  out->connection_keep_alive = cs.keep_alive;
  if (cs.upgrade) out->has_upgrade = true;
  return PNET_H1_OK;
}

bool pnet_h1_validate_framing(pnet_h1_head *head) {
  if (head->chunked && head->content_length >= 0) return false;
  return true;
}

/* ------------------------------------------------------------------------ */
/* Body decoding                                                             */
/* ------------------------------------------------------------------------ */

enum {
  CH_SIZE = 0,   /* reading chunk-size line */
  CH_DATA,       /* reading chunk data */
  CH_DATA_CRLF,  /* expecting CRLF after chunk data */
  CH_TRAILER,    /* reading trailer lines */
  CH_DONE,
};

#define PNET_H1_MAX_TRAILER_BYTES 4096
#define PNET_H1_MAX_TRAILER_FIELDS 32

void pnet_h1_body_init(pnet_h1_body *b, pnet_h1_body_mode mode, uint64_t length) {
  memset(b, 0, sizeof *b);
  b->mode = (uint8_t)mode;
  b->remaining = mode == PNET_H1_BODY_LENGTH ? length : 0;
  b->chunk_state = CH_SIZE;
  if (mode == PNET_H1_BODY_NONE || (mode == PNET_H1_BODY_LENGTH && length == 0)) b->done = true;
}

bool pnet_h1_trailer_field_forbidden(const char *name, size_t len) {
  static const char *const forbidden[] = {
      "content-length", "transfer-encoding", "host", "connection", "trailer", "upgrade", "authorization",
      "proxy-authorization", "content-encoding", "content-type", "content-range", "te", "keep-alive",
      "cache-control", "expect", "max-forwards", "pragma", "range", "www-authenticate", "proxy-authenticate",
      "set-cookie", "cookie", "age", "expires", "date", "location", "retry-after", "vary", "warning",
  };
  for (size_t i = 0; i < sizeof forbidden / sizeof forbidden[0]; i++) {
    if (pnet_ieq_n(name, len, forbidden[i])) return true;
  }
  return false;
}

/** Validate a complete trailer line (without CRLF). */
static bool valid_trailer_line(pnet_h1_body *b, const char *line, size_t len) {
  if (len == 0) return true;
  if (is_ows(line[0])) return false;
  const char *colon = memchr(line, ':', len);
  if (!colon || colon == line) return false;
  size_t nlen = (size_t)(colon - line);
  if (!pnet_is_token(line, nlen)) return false;
  if (pnet_h1_trailer_field_forbidden(line, nlen)) return false;
  if (!valid_field_value(colon + 1, len - nlen - 1)) return false;
  b->trailer_fields++;
  if (b->trailer_fields > PNET_H1_MAX_TRAILER_FIELDS) return false;
  return true;
}

size_t pnet_h1_body_feed(pnet_h1_body *b, const uint8_t *in, size_t len,
                         bool (*sink)(void *ctx, const uint8_t *data, size_t len), void *ctx) {
  size_t i = 0;
  if (b->done || b->error) return 0;
  switch (b->mode) {
    case PNET_H1_BODY_LENGTH: {
      size_t n = len;
      if ((uint64_t)n > b->remaining) n = (size_t)b->remaining;
      if (n > 0 && !sink(ctx, in, n)) return 0;
      b->remaining -= n;
      if (b->remaining == 0) b->done = true;
      return n;
    }
    case PNET_H1_BODY_CLOSE:
      if (len > 0 && !sink(ctx, in, len)) return 0;
      return len;
    case PNET_H1_BODY_CHUNKED:
      break;
    default:
      b->done = true;
      return 0;
  }
  while (i < len && !b->done && !b->error) {
    switch (b->chunk_state) {
      case CH_SIZE:
      case CH_TRAILER: {
        /* Accumulate a line up to CRLF. */
        uint8_t c = in[i++];
        if (b->line_len >= sizeof b->line - 1) {
          b->error = true;
          break;
        }
        b->line[b->line_len++] = (char)c;
        if (b->line_len >= 2 && b->line[b->line_len - 2] == '\r' && b->line[b->line_len - 1] == '\n') {
          size_t llen = b->line_len - 2;
          b->line[llen] = 0;
          if (b->chunk_state == CH_SIZE) {
            /* chunk-size [;ext] */
            size_t k = 0;
            uint64_t size = 0;
            size_t digits = 0;
            while (k < llen) {
              char h = b->line[k];
              int v = (h >= '0' && h <= '9') ? h - '0' : (h >= 'a' && h <= 'f') ? h - 'a' + 10 : (h >= 'A' && h <= 'F') ? h - 'A' + 10 : -1;
              if (v < 0) break;
              if (digits >= 16) { b->error = true; break; }
              size = (size << 4) | (uint64_t)v;
              digits++;
              k++;
            }
            if (b->error) break;
            if (digits == 0) { b->error = true; break; }
            /* Only BWS then ';' extension allowed after the size. */
            size_t e = k;
            while (e < llen && is_ows(b->line[e])) e++;
            if (e < llen && b->line[e] != ';') { b->error = true; break; }
            b->line_len = 0;
            if (size == 0) {
              b->chunk_state = CH_TRAILER;
              b->trailer_bytes = 0;
              b->trailer_fields = 0;
            } else {
              b->remaining = size;
              b->chunk_state = CH_DATA;
            }
          } else {
            b->trailer_bytes += b->line_len;
            if (b->trailer_bytes > PNET_H1_MAX_TRAILER_BYTES) { b->error = true; break; }
            if (llen == 0) {
              b->chunk_state = CH_DONE;
              b->done = true;
            } else if (!valid_trailer_line(b, b->line, llen)) {
              b->error = true;
            }
            b->line_len = 0;
          }
        } else if (b->line_len >= 2 && b->line[b->line_len - 2] == '\r' && b->line[b->line_len - 1] != '\n') {
          b->error = true; /* bare CR */
        } else if (c == '\n' && !(b->line_len >= 2 && b->line[b->line_len - 2] == '\r')) {
          b->error = true; /* bare LF */
        }
        break;
      }
      case CH_DATA: {
        size_t n = len - i;
        if ((uint64_t)n > b->remaining) n = (size_t)b->remaining;
        if (n > 0 && !sink(ctx, in + i, n)) return i;
        i += n;
        b->remaining -= n;
        if (b->remaining == 0) {
          b->chunk_state = CH_DATA_CRLF;
          b->line_len = 0;
        }
        break;
      }
      case CH_DATA_CRLF: {
        uint8_t c = in[i++];
        if (b->line_len == 0) {
          if (c != '\r') { b->error = true; break; }
          b->line_len = 1;
        } else {
          if (c != '\n') { b->error = true; break; }
          b->line_len = 0;
          b->chunk_state = CH_SIZE;
        }
        break;
      }
      default:
        b->done = true;
        break;
    }
  }
  return i;
}
