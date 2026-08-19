/* Absolute URL parsing for the schemes the modules speak (http, https, ws,
 * wss) plus Location resolution for redirects. The SDK already normalized
 * the request URL (lowercase scheme/host, no credentials, percent-encoded
 * path); this parser re-checks what the wire needs and rejects the rest. */
#include "pnet_internal.h"

static bool valid_host_char(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '.' ||
         c == '_';
}

static bool set_path(pnet_runtime *rt, pnet_url *out, const char *path, size_t len) {
  /* Drop a fragment; keep path + query. */
  size_t n = 0;
  while (n < len && path[n] != '#') n++;
  if (n == 0) {
    out->path = pnet_strdup_n(rt, "/", 1);
    out->path_len = 1;
    return out->path != NULL;
  }
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)path[i];
    if (c <= 0x20 || c == 0x7f) return false;
  }
  if (path[0] == '?') {
    out->path = pnet_alloc(rt, n + 2);
    if (!out->path) return false;
    out->path[0] = '/';
    memcpy(out->path + 1, path, n);
    out->path[n + 1] = 0;
    out->path_len = n + 1;
    return true;
  }
  if (path[0] != '/') return false;
  out->path = pnet_strdup_n(rt, path, n);
  out->path_len = n;
  return out->path != NULL;
}

bool pnet_url_parse(pnet_runtime *rt, const char *text, size_t len, pnet_url *out) {
  memset(out, 0, sizeof *out);
  const char *colon = memchr(text, ':', len);
  if (!colon) return false;
  size_t scheme_len = (size_t)(colon - text);
  if (scheme_len == 0 || scheme_len >= sizeof out->scheme) return false;
  for (size_t i = 0; i < scheme_len; i++) {
    char c = text[i];
    if (c >= 'A' && c <= 'Z') c = (char)(c + 32);
    out->scheme[i] = c;
  }
  out->scheme[scheme_len] = 0;
  if (strcmp(out->scheme, "http") && strcmp(out->scheme, "https") && strcmp(out->scheme, "ws") &&
      strcmp(out->scheme, "wss"))
    return false;
  size_t i = scheme_len + 1;
  if (i + 2 > len || text[i] != '/' || text[i + 1] != '/') return false;
  i += 2;
  size_t auth_start = i;
  while (i < len && text[i] != '/' && text[i] != '?' && text[i] != '#') i++;
  size_t auth_len = i - auth_start;
  const char *auth = text + auth_start;
  if (memchr(auth, '@', auth_len)) return false; /* credentials are refused */
  const char *host;
  size_t host_len;
  const char *port_text = NULL;
  size_t port_len = 0;
  if (auth_len > 0 && auth[0] == '[') {
    const char *close = memchr(auth, ']', auth_len);
    if (!close) return false;
    host = auth + 1;
    host_len = (size_t)(close - auth) - 1;
    size_t rest = auth_len - (size_t)(close - auth) - 1;
    if (rest > 0) {
      if (close[1] != ':') return false;
      port_text = close + 2;
      port_len = rest - 1;
    }
    out->host_is_ipv6 = true;
    pnet_addr tmp;
    if (!pnet_parse_ip_literal(host, host_len, &tmp) || tmp.family != 6) return false;
  } else {
    const char *c = NULL;
    for (size_t k = 0; k < auth_len; k++)
      if (auth[k] == ':') c = auth + k;
    if (c) {
      host = auth;
      host_len = (size_t)(c - auth);
      port_text = c + 1;
      port_len = auth_len - host_len - 1;
    } else {
      host = auth;
      host_len = auth_len;
    }
    if (host_len == 0 || host_len > 253) return false;
    for (size_t k = 0; k < host_len; k++)
      if (!valid_host_char(host[k])) return false;
    if (host[0] == '.' || host[host_len - 1] == '-') return false;
  }
  out->host = pnet_strdup_n(rt, host, host_len);
  if (!out->host) return false;
  pnet_lower(out->host, host_len);
  /* Trailing root dot normalizes away. */
  if (!out->host_is_ipv6 && host_len > 1 && out->host[host_len - 1] == '.') out->host[host_len - 1] = 0;
  out->port = pnet_url_default_port(out->scheme);
  if (port_text) {
    uint64_t p;
    if (port_len == 0 || !pnet_parse_u64(port_text, port_len, &p) || p > 65535) {
      pnet_url_free(rt, out);
      return false;
    }
    out->port = (uint16_t)p;
    out->port_explicit = out->port != pnet_url_default_port(out->scheme);
  }
  if (!set_path(rt, out, text + i, len - i)) {
    pnet_url_free(rt, out);
    return false;
  }
  return true;
}

void pnet_url_free(pnet_runtime *rt, pnet_url *url) {
  if (url->host) pnet_free_str(rt, url->host);
  if (url->path) pnet_free_str(rt, url->path);
  url->host = NULL;
  url->path = NULL;
}

void pnet_url_write(pnet_runtime *rt, pnet_sb *sb, const pnet_url *url) {
  pnet_sb_puts(rt, sb, url->scheme);
  pnet_sb_puts(rt, sb, "://");
  if (url->host_is_ipv6) pnet_sb_putc(rt, sb, '[');
  pnet_sb_puts(rt, sb, url->host);
  if (url->host_is_ipv6) pnet_sb_putc(rt, sb, ']');
  if (url->port_explicit) pnet_sb_printf(rt, sb, ":%u", (unsigned)url->port);
  pnet_sb_append(rt, sb, url->path, url->path_len);
}

bool pnet_url_same_origin(const pnet_url *a, const pnet_url *b) {
  return strcmp(a->scheme, b->scheme) == 0 && strcmp(a->host, b->host) == 0 && a->port == b->port;
}

/** Remove dot segments from a path (RFC 3986 5.2.4). `path` is rewritten in
 * place; the result always starts with '/'. Paths with more than 128
 * segments are left untouched apart from the leading slash. */
static size_t remove_dot_segments(char *path, size_t len) {
  enum { MAX_SEGS = 128 };
  const char *seg_ptr[MAX_SEGS];
  size_t seg_len[MAX_SEGS];
  size_t count = 0;
  bool trailing = false;
  size_t i = 0;
  if (i < len && path[i] == '/') i++;
  if (len == 0) {
    path[0] = '/';
    return 1;
  }
  bool overflow = false;
  while (i <= len) {
    size_t j = i;
    while (j < len && path[j] != '/') j++;
    size_t n = j - i;
    bool last = j >= len;
    if (n == 1 && path[i] == '.') {
      trailing = last;
    } else if (n == 2 && path[i] == '.' && path[i + 1] == '.') {
      if (count > 0) count--;
      trailing = last;
    } else if (n == 0) {
      trailing = last; /* empty last segment: path ended with '/' */
      if (!last) { /* "//" inside path: keep an empty segment */
        if (count < MAX_SEGS) { seg_ptr[count] = path + i; seg_len[count] = 0; count++; } else overflow = true;
      }
    } else {
      if (count < MAX_SEGS) { seg_ptr[count] = path + i; seg_len[count] = n; count++; } else overflow = true;
      trailing = false;
    }
    if (last) break;
    i = j + 1;
  }
  if (overflow) {
    if (path[0] != '/') { memmove(path + 1, path, len); path[0] = '/'; len++; }
    return len;
  }
  /* Rebuild into a scratch copy: segments point into `path`, so build a
   * temporary on the stack (paths here are bounded by the target limit). */
  char tmp[2048];
  size_t o = 0;
  for (size_t k = 0; k < count; k++) {
    if (o + 1 + seg_len[k] >= sizeof tmp) break;
    tmp[o++] = '/';
    memcpy(tmp + o, seg_ptr[k], seg_len[k]);
    o += seg_len[k];
  }
  if (count == 0 || trailing) {
    if (o + 1 < sizeof tmp) tmp[o++] = '/';
  }
  memcpy(path, tmp, o);
  return o;
}

bool pnet_url_resolve(pnet_runtime *rt, const pnet_url *base, const char *location, size_t len, pnet_url *out) {
  memset(out, 0, sizeof *out);
  /* Trim whitespace. */
  while (len > 0 && (location[0] == ' ' || location[0] == '\t')) { location++; len--; }
  while (len > 0 && (location[len - 1] == ' ' || location[len - 1] == '\t')) len--;
  if (len == 0) return false;
  /* Absolute? scheme ":" */
  size_t k = 0;
  while (k < len && ((location[k] >= 'a' && location[k] <= 'z') || (location[k] >= 'A' && location[k] <= 'Z') ||
                     (k > 0 && ((location[k] >= '0' && location[k] <= '9') || location[k] == '+' || location[k] == '-' || location[k] == '.'))))
    k++;
  if (k > 0 && k < len && location[k] == ':') return pnet_url_parse(rt, location, len, out);
  /* Scheme-relative //host/path */
  if (len >= 2 && location[0] == '/' && location[1] == '/') {
    pnet_sb sb;
    pnet_sb_init(&sb);
    pnet_sb_puts(rt, &sb, base->scheme);
    pnet_sb_putc(rt, &sb, ':');
    pnet_sb_append(rt, &sb, location, len);
    bool ok = !sb.failed && pnet_url_parse(rt, sb.data, sb.len, out);
    pnet_sb_free(rt, &sb);
    return ok;
  }
  strcpy(out->scheme, base->scheme);
  out->host = pnet_strdup_n(rt, base->host, strlen(base->host));
  if (!out->host) return false;
  out->host_is_ipv6 = base->host_is_ipv6;
  out->port = base->port;
  out->port_explicit = base->port_explicit;
  /* Path part: absolute-path, query-only, fragment-only, or relative. */
  const char *bpath = base->path;
  size_t bpath_len = base->path_len;
  size_t bq = 0;
  while (bq < bpath_len && bpath[bq] != '?') bq++; /* base path without query */
  pnet_sb sb;
  pnet_sb_init(&sb);
  size_t frag = 0;
  while (frag < len && location[frag] != '#') frag++;
  len = frag;
  if (len == 0) {
    pnet_sb_append(rt, &sb, bpath, bpath_len);
  } else if (location[0] == '/') {
    pnet_sb_append(rt, &sb, location, len);
  } else if (location[0] == '?') {
    pnet_sb_append(rt, &sb, bpath, bq);
    pnet_sb_append(rt, &sb, location, len);
  } else {
    size_t slash = bq;
    while (slash > 0 && bpath[slash - 1] != '/') slash--;
    pnet_sb_append(rt, &sb, bpath, slash);
    pnet_sb_append(rt, &sb, location, len);
  }
  if (sb.failed) {
    pnet_sb_free(rt, &sb);
    pnet_url_free(rt, out);
    return false;
  }
  /* Normalize dot segments in the path portion only. */
  size_t q = 0;
  while (q < sb.len && sb.data[q] != '?') q++;
  char *tmp = pnet_alloc(rt, sb.len + 2);
  if (!tmp) {
    pnet_sb_free(rt, &sb);
    pnet_url_free(rt, out);
    return false;
  }
  memcpy(tmp, sb.data, q);
  size_t plen = remove_dot_segments(tmp, q);
  memcpy(tmp + plen, sb.data + q, sb.len - q);
  size_t total = plen + (sb.len - q);
  tmp[total] = 0;
  bool ok = set_path(rt, out, tmp, total);
  pnet_free(rt, tmp, sb.len + 2);
  pnet_sb_free(rt, &sb);
  if (!ok) pnet_url_free(rt, out);
  return ok;
}
