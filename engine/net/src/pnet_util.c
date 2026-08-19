/* Allocation accounting, string builder, byte queue, codecs and address
 * helpers for the network core. Portable C99; no OS headers. */
#include <stdarg.h>
#include <stdio.h>

#include "pnet_internal.h"

/* ------------------------------------------------------------------------ */
/* Allocation                                                                */
/* ------------------------------------------------------------------------ */

void *pnet_alloc(pnet_runtime *rt, size_t size) {
  if (size == 0) size = 1;
  if (rt->cfg.max_heap_bytes && rt->heap_bytes + size > rt->cfg.max_heap_bytes) return NULL;
  void *p = rt->platform.alloc(rt->platform.ctx, size);
  if (!p) return NULL;
  rt->heap_bytes += size;
  if (rt->heap_bytes > rt->heap_high_water) rt->heap_high_water = rt->heap_bytes;
  return p;
}

void *pnet_zalloc(pnet_runtime *rt, size_t size) {
  void *p = pnet_alloc(rt, size);
  if (p) memset(p, 0, size ? size : 1);
  return p;
}

void pnet_free(pnet_runtime *rt, void *ptr, size_t size) {
  if (!ptr) return;
  if (size == 0) size = 1;
  rt->platform.free(rt->platform.ctx, ptr, size);
  rt->heap_bytes = rt->heap_bytes >= size ? rt->heap_bytes - size : 0;
}

char *pnet_strdup_n(pnet_runtime *rt, const char *s, size_t len) {
  char *out = pnet_alloc(rt, len + 1);
  if (!out) return NULL;
  memcpy(out, s, len);
  out[len] = 0;
  return out;
}

void pnet_logf(pnet_runtime *rt, pnet_log_level level, const char *fmt, ...) {
  if (!rt->platform.log) return;
  char buf[192];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  rt->platform.log(rt->platform.ctx, level, buf);
}

/* ------------------------------------------------------------------------ */
/* String builder                                                            */
/* ------------------------------------------------------------------------ */

void pnet_sb_init(pnet_sb *sb) {
  sb->data = NULL;
  sb->len = 0;
  sb->cap = 0;
  sb->failed = false;
}

void pnet_sb_free(pnet_runtime *rt, pnet_sb *sb) {
  if (sb->data) pnet_free(rt, sb->data, sb->cap);
  pnet_sb_init(sb);
}

bool pnet_sb_reserve(pnet_runtime *rt, pnet_sb *sb, size_t extra) {
  if (sb->failed) return false;
  size_t need = sb->len + extra + 1;
  if (need <= sb->cap) return true;
  size_t cap = sb->cap ? sb->cap : 64;
  while (cap < need) cap = cap < 4096 ? cap * 2 : cap + cap / 2;
  char *next = pnet_alloc(rt, cap);
  if (!next) {
    sb->failed = true;
    return false;
  }
  if (sb->data) {
    memcpy(next, sb->data, sb->len);
    pnet_free(rt, sb->data, sb->cap);
  }
  sb->data = next;
  sb->cap = cap;
  sb->data[sb->len] = 0;
  return true;
}

void pnet_sb_append(pnet_runtime *rt, pnet_sb *sb, const void *data, size_t len) {
  if (!pnet_sb_reserve(rt, sb, len)) return;
  memcpy(sb->data + sb->len, data, len);
  sb->len += len;
  sb->data[sb->len] = 0;
}

void pnet_sb_puts(pnet_runtime *rt, pnet_sb *sb, const char *s) {
  pnet_sb_append(rt, sb, s, strlen(s));
}

void pnet_sb_putc(pnet_runtime *rt, pnet_sb *sb, char c) {
  pnet_sb_append(rt, sb, &c, 1);
}

void pnet_sb_printf(pnet_runtime *rt, pnet_sb *sb, const char *fmt, ...) {
  char buf[256];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  if (n < 0) return;
  if ((size_t)n < sizeof buf) {
    pnet_sb_append(rt, sb, buf, (size_t)n);
    return;
  }
  if (!pnet_sb_reserve(rt, sb, (size_t)n)) return;
  va_start(ap, fmt);
  vsnprintf(sb->data + sb->len, (size_t)n + 1, fmt, ap);
  va_end(ap);
  sb->len += (size_t)n;
}

static const char HEX[] = "0123456789abcdef";

void pnet_sb_json_string(pnet_runtime *rt, pnet_sb *sb, const char *s, size_t len) {
  pnet_sb_putc(rt, sb, '"');
  const uint8_t *p = (const uint8_t *)s;
  size_t i = 0;
  while (i < len) {
    uint8_t c = p[i];
    if (c == '"' || c == '\\') {
      char esc[2] = {'\\', (char)c};
      pnet_sb_append(rt, sb, esc, 2);
      i++;
    } else if (c < 0x20) {
      if (c == '\n') pnet_sb_append(rt, sb, "\\n", 2);
      else if (c == '\r') pnet_sb_append(rt, sb, "\\r", 2);
      else if (c == '\t') pnet_sb_append(rt, sb, "\\t", 2);
      else {
        char esc[6] = {'\\', 'u', '0', '0', HEX[c >> 4], HEX[c & 15]};
        pnet_sb_append(rt, sb, esc, 6);
      }
      i++;
    } else if (c < 0x80) {
      pnet_sb_putc(rt, sb, (char)c);
      i++;
    } else {
      /* Copy one UTF-8 sequence if valid, else U+FFFD. */
      size_t n = 0;
      uint32_t cp = 0;
      uint32_t lower = 0;
      if ((c & 0xe0) == 0xc0) { n = 1; cp = c & 0x1f; lower = 0x80; }
      else if ((c & 0xf0) == 0xe0) { n = 2; cp = c & 0x0f; lower = 0x800; }
      else if ((c & 0xf8) == 0xf0) { n = 3; cp = c & 0x07; lower = 0x10000; }
      bool ok = n > 0 && i + n < len + 1 && i + n <= len;
      if (ok) {
        for (size_t k = 1; k <= n; k++) {
          uint8_t cc = p[i + k];
          if ((cc & 0xc0) != 0x80) { ok = false; break; }
          cp = (cp << 6) | (cc & 0x3f);
        }
      }
      if (ok && (cp < lower || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))) ok = false;
      if (ok) {
        pnet_sb_append(rt, sb, p + i, n + 1);
        i += n + 1;
      } else {
        pnet_sb_append(rt, sb, "\xEF\xBF\xBD", 3);
        i++;
      }
    }
  }
  pnet_sb_putc(rt, sb, '"');
}

const char *pnet_sb_cstr(pnet_sb *sb) {
  return sb->data ? sb->data : "";
}

/* ------------------------------------------------------------------------ */
/* Byte queue                                                                */
/* ------------------------------------------------------------------------ */

void pnet_bq_init(pnet_bq *q) {
  q->head = q->tail = NULL;
  q->bytes = 0;
}

static void seg_free(pnet_runtime *rt, pnet_seg *s) {
  pnet_free(rt, s, sizeof(pnet_seg) + s->cap);
}

void pnet_bq_free(pnet_runtime *rt, pnet_bq *q) {
  pnet_seg *s = q->head;
  while (s) {
    pnet_seg *next = s->next;
    seg_free(rt, s);
    s = next;
  }
  pnet_bq_init(q);
}

bool pnet_bq_push(pnet_runtime *rt, pnet_bq *q, const void *data, size_t len, size_t seg_bytes) {
  const uint8_t *src = data;
  while (len > 0) {
    pnet_seg *tail = q->tail;
    if (tail && tail->off + tail->len < tail->cap) {
      size_t room = tail->cap - (tail->off + tail->len);
      size_t n = len < room ? len : room;
      memcpy(tail->data + tail->off + tail->len, src, n);
      tail->len += n;
      q->bytes += n;
      src += n;
      len -= n;
      continue;
    }
    size_t cap = seg_bytes ? seg_bytes : 1024;
    if (len > cap) cap = len;
    pnet_seg *s = pnet_alloc(rt, sizeof(pnet_seg) + cap);
    if (!s) return false;
    s->next = NULL;
    s->cap = cap;
    s->len = 0;
    s->off = 0;
    if (q->tail) q->tail->next = s;
    else q->head = s;
    q->tail = s;
  }
  return true;
}

size_t pnet_bq_read(pnet_runtime *rt, pnet_bq *q, uint8_t *dst, size_t len) {
  size_t copied = 0;
  while (copied < len && q->head) {
    pnet_seg *s = q->head;
    size_t n = s->len < len - copied ? s->len : len - copied;
    memcpy(dst + copied, s->data + s->off, n);
    copied += n;
    s->off += n;
    s->len -= n;
    q->bytes -= n;
    if (s->len == 0) {
      q->head = s->next;
      if (!q->head) q->tail = NULL;
      seg_free(rt, s);
    }
  }
  return copied;
}

size_t pnet_bq_peek(pnet_bq *q, const uint8_t **ptr) {
  if (!q->head) {
    *ptr = NULL;
    return 0;
  }
  *ptr = q->head->data + q->head->off;
  return q->head->len;
}

void pnet_bq_consume(pnet_runtime *rt, pnet_bq *q, size_t n) {
  while (n > 0 && q->head) {
    pnet_seg *s = q->head;
    size_t take = s->len < n ? s->len : n;
    s->off += take;
    s->len -= take;
    q->bytes -= take;
    n -= take;
    if (s->len == 0) {
      q->head = s->next;
      if (!q->head) q->tail = NULL;
      seg_free(rt, s);
    }
  }
}

/* ------------------------------------------------------------------------ */
/* UTF-8                                                                     */
/* ------------------------------------------------------------------------ */

void pnet_utf8_state_init(pnet_utf8_state *st) {
  st->need = 0;
  st->cp = 0;
  st->lower = 0;
}

bool pnet_utf8_feed(pnet_utf8_state *st, const uint8_t *s, size_t len) {
  for (size_t i = 0; i < len; i++) {
    uint8_t c = s[i];
    if (st->need == 0) {
      if (c < 0x80) continue;
      if ((c & 0xe0) == 0xc0) { st->need = 1; st->cp = c & 0x1f; st->lower = 0x80; }
      else if ((c & 0xf0) == 0xe0) { st->need = 2; st->cp = c & 0x0f; st->lower = 0x800; }
      else if ((c & 0xf8) == 0xf0) { st->need = 3; st->cp = c & 0x07; st->lower = 0x10000; }
      else return false;
      /* Early rejects that do not need the full sequence. */
      if (c == 0xc0 || c == 0xc1 || c > 0xf4) return false;
    } else {
      if ((c & 0xc0) != 0x80) return false;
      st->cp = (st->cp << 6) | (c & 0x3f);
      st->need--;
      if (st->need == 0) {
        if (st->cp < st->lower || st->cp > 0x10ffff || (st->cp >= 0xd800 && st->cp <= 0xdfff)) return false;
      } else if (st->need == 2 && st->lower == 0x10000) {
        /* after first continuation of a 4-byte seq: cp holds 5+6 bits */
        if (st->cp > 0x10f) return false;
        if (st->cp < 0x10) return false;
      } else if (st->need == 1 && st->lower == 0x800) {
        if (st->cp < 0x20) return false;
        if (st->cp >= 0x360 && st->cp <= 0x37f) return false; /* surrogates */
      }
    }
  }
  return true;
}

bool pnet_utf8_valid(const uint8_t *s, size_t len) {
  pnet_utf8_state st;
  pnet_utf8_state_init(&st);
  return pnet_utf8_feed(&st, s, len) && st.need == 0;
}

/* ------------------------------------------------------------------------ */
/* Base64 / SHA-1                                                            */
/* ------------------------------------------------------------------------ */

size_t pnet_base64_encode(const uint8_t *in, size_t len, char *out, size_t cap) {
  static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t need = ((len + 2) / 3) * 4;
  if (cap < need + 1) return 0;
  size_t o = 0;
  for (size_t i = 0; i < len; i += 3) {
    uint32_t a = in[i];
    uint32_t b = i + 1 < len ? in[i + 1] : 0;
    uint32_t c = i + 2 < len ? in[i + 2] : 0;
    out[o++] = T[a >> 2];
    out[o++] = T[((a & 3) << 4) | (b >> 4)];
    out[o++] = i + 1 < len ? T[((b & 15) << 2) | (c >> 6)] : '=';
    out[o++] = i + 2 < len ? T[c & 63] : '=';
  }
  out[o] = 0;
  return o;
}

static uint32_t rol(uint32_t v, int b) { return (v << b) | (v >> (32 - b)); }

void pnet_sha1(const uint8_t *data, size_t len, uint8_t out[20]) {
  uint32_t h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  uint64_t total_bits = (uint64_t)len * 8;
  uint8_t block[64];
  size_t i = 0;
  bool padded_one = false;
  bool finished = false;
  while (!finished) {
    size_t n = 0;
    if (len - i >= 64) {
      memcpy(block, data + i, 64);
      i += 64;
      n = 64;
    } else {
      size_t rem = len - i;
      memcpy(block, data + i, rem);
      i += rem;
      n = rem;
      if (!padded_one) {
        block[n++] = 0x80;
        padded_one = true;
      }
      if (n <= 56) {
        memset(block + n, 0, 56 - n);
        for (int k = 0; k < 8; k++) block[56 + k] = (uint8_t)(total_bits >> (56 - 8 * k));
        finished = true;
      } else {
        memset(block + n, 0, 64 - n);
      }
    }
    uint32_t w[80];
    for (int t = 0; t < 16; t++) {
      w[t] = ((uint32_t)block[t * 4] << 24) | ((uint32_t)block[t * 4 + 1] << 16) |
             ((uint32_t)block[t * 4 + 2] << 8) | block[t * 4 + 3];
    }
    for (int t = 16; t < 80; t++) w[t] = rol(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    uint32_t a = h0, b = h1, c = h2, d = h3, e = h4;
    for (int t = 0; t < 80; t++) {
      uint32_t f, k;
      if (t < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (t < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (t < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      uint32_t temp = rol(a, 5) + f + e + k + w[t];
      e = d;
      d = c;
      c = rol(b, 30);
      b = a;
      a = temp;
    }
    h0 += a; h1 += b; h2 += c; h3 += d; h4 += e;
  }
  uint32_t hs[5] = {h0, h1, h2, h3, h4};
  for (int k = 0; k < 5; k++) {
    out[k * 4] = (uint8_t)(hs[k] >> 24);
    out[k * 4 + 1] = (uint8_t)(hs[k] >> 16);
    out[k * 4 + 2] = (uint8_t)(hs[k] >> 8);
    out[k * 4 + 3] = (uint8_t)hs[k];
  }
}

/* ------------------------------------------------------------------------ */
/* Tokens, numbers, case                                                     */
/* ------------------------------------------------------------------------ */

bool pnet_is_token(const char *s, size_t len) {
  if (len == 0) return false;
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c <= 0x20 || c >= 0x7f) return false;
    if (strchr("()<>@,;:\\\"/[]?={}", c)) return false;
  }
  return true;
}

bool pnet_ieq_n(const char *a, size_t alen, const char *b) {
  size_t blen = strlen(b);
  if (alen != blen) return false;
  for (size_t i = 0; i < alen; i++) {
    unsigned char x = (unsigned char)a[i], y = (unsigned char)b[i];
    if (x >= 'A' && x <= 'Z') x = (unsigned char)(x + 32);
    if (y >= 'A' && y <= 'Z') y = (unsigned char)(y + 32);
    if (x != y) return false;
  }
  return true;
}

void pnet_lower(char *s, size_t len) {
  for (size_t i = 0; i < len; i++)
    if (s[i] >= 'A' && s[i] <= 'Z') s[i] = (char)(s[i] + 32);
}

bool pnet_parse_u64(const char *s, size_t len, uint64_t *out) {
  if (len == 0 || len > 19) return false;
  uint64_t v = 0;
  for (size_t i = 0; i < len; i++) {
    if (s[i] < '0' || s[i] > '9') return false;
    v = v * 10 + (uint64_t)(s[i] - '0');
  }
  *out = v;
  return true;
}

/* ------------------------------------------------------------------------ */
/* Addresses                                                                 */
/* ------------------------------------------------------------------------ */

bool pnet_parse_ipv4(const char *s, size_t len, uint8_t out[4]) {
  size_t i = 0;
  for (int part = 0; part < 4; part++) {
    if (i >= len) return false;
    uint32_t v = 0;
    size_t digits = 0;
    while (i < len && s[i] >= '0' && s[i] <= '9') {
      v = v * 10 + (uint32_t)(s[i] - '0');
      if (v > 255) return false;
      i++;
      digits++;
    }
    if (digits == 0 || digits > 3) return false;
    /* No leading zeros: "010" is octal to some resolvers and decimal to
     * others, so it is not a literal here (nor a valid hostname). */
    if (digits > 1 && s[i - digits] == '0') return false;
    out[part] = (uint8_t)v;
    if (part < 3) {
      if (i >= len || s[i] != '.') return false;
      i++;
    }
  }
  return i == len;
}

static int hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

bool pnet_parse_ipv6(const char *s, size_t len, uint8_t out[16]) {
  uint16_t groups[8];
  int count = 0;
  int gap = -1;
  size_t i = 0;
  if (len >= 2 && s[0] == ':' && s[1] == ':') {
    gap = 0;
    i = 2;
  } else if (len >= 1 && s[0] == ':') {
    return false;
  }
  while (i < len) {
    if (count >= 8) return false;
    /* embedded IPv4 tail */
    size_t j = i;
    bool dotted = false;
    while (j < len && s[j] != ':') {
      if (s[j] == '.') dotted = true;
      j++;
    }
    if (dotted) {
      uint8_t v4[4];
      if (!pnet_parse_ipv4(s + i, j - i, v4) || j != len || count > 6) return false;
      groups[count++] = (uint16_t)((v4[0] << 8) | v4[1]);
      groups[count++] = (uint16_t)((v4[2] << 8) | v4[3]);
      i = j;
      break;
    }
    if (j == i) return false;
    if (j - i > 4) return false;
    uint32_t v = 0;
    for (size_t k = i; k < j; k++) {
      int h = hexval(s[k]);
      if (h < 0) return false;
      v = (v << 4) | (uint32_t)h;
    }
    groups[count++] = (uint16_t)v;
    i = j;
    if (i < len) {
      if (s[i] != ':') return false;
      i++;
      if (i < len && s[i] == ':') {
        if (gap >= 0) return false;
        gap = count;
        i++;
        if (i == len) break;
      } else if (i == len) {
        return false;
      }
    }
  }
  if (gap < 0 && count != 8) return false;
  if (gap >= 0 && count >= 8) return false;
  memset(out, 0, 16);
  int fill = 8 - count;
  int gi = 0;
  for (int g = 0; g < 8; g++) {
    if (gap >= 0 && g >= gap && g < gap + fill) continue;
    out[g * 2] = (uint8_t)(groups[gi] >> 8);
    out[g * 2 + 1] = (uint8_t)groups[gi];
    gi++;
  }
  return true;
}

bool pnet_parse_ip_literal(const char *s, size_t len, pnet_addr *out) {
  memset(out, 0, sizeof *out);
  if (len >= 2 && s[0] == '[' && s[len - 1] == ']') {
    s++;
    len -= 2;
  }
  if (memchr(s, ':', len)) {
    if (!pnet_parse_ipv6(s, len, out->addr)) return false;
    out->family = 6;
    return true;
  }
  if (pnet_parse_ipv4(s, len, out->addr)) {
    out->family = 4;
    return true;
  }
  return false;
}

void pnet_format_addr(const pnet_addr *addr, char *out, size_t cap) {
  if (addr->family == 4) {
    snprintf(out, cap, "%u.%u.%u.%u", addr->addr[0], addr->addr[1], addr->addr[2], addr->addr[3]);
    return;
  }
  /* IPv6: longest run of zero groups compressed. */
  uint16_t g[8];
  for (int i = 0; i < 8; i++) g[i] = (uint16_t)((addr->addr[i * 2] << 8) | addr->addr[i * 2 + 1]);
  int best = -1, best_len = 0;
  for (int i = 0; i < 8;) {
    if (g[i] != 0) { i++; continue; }
    int j = i;
    while (j < 8 && g[j] == 0) j++;
    if (j - i > best_len && j - i >= 2) { best = i; best_len = j - i; }
    i = j;
  }
  size_t o = 0;
  for (int i = 0; i < 8; i++) {
    if (i == best) {
      if (o + 2 < cap) { out[o++] = ':'; if (i == 0) out[o++] = ':'; }
      i += best_len - 1;
      if (i == 7 && o < cap) out[o] = 0;
      continue;
    }
    int n = snprintf(out + o, cap > o ? cap - o : 0, "%x%s", g[i], i < 7 ? ":" : "");
    if (n > 0) o += (size_t)n;
  }
  if (o < cap) out[o] = 0;
  else out[cap - 1] = 0;
}

bool pnet_status_in(int status, const int *list, size_t count) {
  for (size_t i = 0; i < count; i++)
    if (list[i] == status) return true;
  return false;
}

bool pnet_status_is_bodyless(int status) {
  /* RFC 9112 §6.3 rule 1: 1xx, 204 and 304 carry no body whatever the
   * framing headers say (PNET_HTTP_BODYLESS_STATUS + the 1xx range). */
  if (status >= 100 && status < 200) return true;
  return pnet_status_in(status, (const int[])PNET_HTTP_BODYLESS_STATUS, PNET_HTTP_BODYLESS_STATUS_COUNT);
}

bool pnet_http_redirect_plan(int status, const char *method, size_t method_len, bool *to_get) {
  /* The shared redirect table (spec.h): which statuses a client follows and
   * how the method is rewritten — 303 turns every method but HEAD into a
   * GET without a body, 301/302 turn POST into GET, 307/308 keep both. */
  *to_get = false;
  if (!pnet_status_in(status, (const int[])PNET_HTTP_REDIRECT_STATUS, PNET_HTTP_REDIRECT_STATUS_COUNT)) return false;
  if (pnet_status_in(status, (const int[])PNET_HTTP_REDIRECT_ANY_TO_GET_STATUS, PNET_HTTP_REDIRECT_ANY_TO_GET_STATUS_COUNT) &&
      !pnet_ieq_n(method, method_len, "HEAD"))
    *to_get = true;
  if (pnet_status_in(status, (const int[])PNET_HTTP_REDIRECT_POST_TO_GET_STATUS, PNET_HTTP_REDIRECT_POST_TO_GET_STATUS_COUNT) &&
      pnet_ieq_n(method, method_len, "POST"))
    *to_get = true;
  return true;
}

bool pnet_status_is_null_body(int status) {
  /* Fetch null-body statuses: a response that may not carry content. */
  return pnet_status_in(status, (const int[])PNET_HTTP_NULL_BODY_STATUS, PNET_HTTP_NULL_BODY_STATUS_COUNT);
}

bool pnet_hostname_valid(const char *s, size_t len) {
  /* Lowercase ASCII DNS name: labels of [a-z0-9-], 1..63 bytes, not starting
   * or ending with '-', whole name <= 253 bytes. Mirrors
   * normalizeNetworkHostname() in contracts/spec/network-policy.ts. */
  if (len == 0 || len > 253) return false;
  /* A name whose last label is all digits is a (malformed) IPv4 literal,
   * never a DNS name (WHATWG URL "ends in a number"). */
  size_t last = len;
  while (last > 0 && s[last - 1] != '.') last--;
  bool numeric = last < len;
  for (size_t i = last; i < len; i++)
    if (s[i] < '0' || s[i] > '9') numeric = false;
  if (numeric) return false;
  size_t label = 0;
  for (size_t i = 0; i <= len; i++) {
    if (i == len || s[i] == '.') {
      if (label == 0 || label > 63) return false;
      if (s[i - 1] == '-' || s[i - label] == '-') return false;
      label = 0;
      continue;
    }
    char c = s[i];
    bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
    if (!ok) return false;
    label++;
  }
  return true;
}

bool pnet_addr_is_multicast(const pnet_addr *addr) {
  if (addr->family == 4) return (addr->addr[0] & 0xf0) == 0xe0;
  return addr->addr[0] == 0xff;
}

bool pnet_addr_is_public(const pnet_addr *addr) {
  const uint8_t *a = addr->addr;
  if (addr->family == 4) {
    if (a[0] == 0) return false;                        /* unspecified / this network */
    if (a[0] == 10) return false;                       /* private */
    if (a[0] == 127) return false;                      /* loopback */
    if (a[0] == 169 && a[1] == 254) return false;       /* link-local */
    if (a[0] == 172 && (a[1] & 0xf0) == 16) return false; /* private */
    if (a[0] == 192 && a[1] == 168) return false;       /* private */
    if (a[0] == 100 && (a[1] & 0xc0) == 64) return false; /* CGNAT */
    if ((a[0] & 0xf0) == 0xe0) return false;            /* multicast */
    if (a[0] == 255 && a[1] == 255 && a[2] == 255 && a[3] == 255) return false;
    return true;
  }
  static const uint8_t zero[16] = {0};
  if (memcmp(a, zero, 15) == 0 && (a[15] == 0 || a[15] == 1)) return false; /* :: and ::1 */
  if (a[0] == 0xfe && (a[1] & 0xc0) == 0x80) return false; /* fe80::/10 link-local */
  if ((a[0] & 0xfe) == 0xfc) return false;                 /* fc00::/7 ULA */
  if (a[0] == 0xff) return false;                          /* multicast */
  /* IPv4-mapped ::ffff:a.b.c.d */
  if (memcmp(a, zero, 10) == 0 && a[10] == 0xff && a[11] == 0xff) {
    pnet_addr v4 = {.family = 4};
    memcpy(v4.addr, a + 12, 4);
    return pnet_addr_is_public(&v4);
  }
  return true;
}
