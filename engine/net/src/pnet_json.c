/* Minimal JSON reader for the guest metadata objects (start/connect/listen/
 * respond meta and the policy). Nodes live in a caller-provided array, so a
 * parse costs no heap; strings are unescaped on demand. Depth is bounded by
 * the node array. */
#include "pnet_internal.h"

typedef struct jparser {
  const char *s;
  size_t len;
  size_t pos;
  pnet_jdoc *doc;
  int depth;
} jparser;

static void skip_ws(jparser *p) {
  while (p->pos < p->len) {
    char c = p->s[p->pos];
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') p->pos++;
    else break;
  }
}

static int new_node(jparser *p, pnet_jtype type) {
  if (p->doc->count >= p->doc->cap) return -1;
  int idx = p->doc->count++;
  pnet_jnode *n = &p->doc->nodes[idx];
  n->type = (uint8_t)type;
  n->truthy = false;
  n->raw = NULL;
  n->raw_len = 0;
  n->first_child = -1;
  n->next = -1;
  return idx;
}

static int parse_value(jparser *p);

static bool parse_string_raw(jparser *p, const char **raw, size_t *raw_len) {
  if (p->pos >= p->len || p->s[p->pos] != '"') return false;
  p->pos++;
  size_t start = p->pos;
  while (p->pos < p->len) {
    char c = p->s[p->pos];
    if (c == '"') {
      *raw = p->s + start;
      *raw_len = p->pos - start;
      p->pos++;
      return true;
    }
    if (c == '\\') {
      p->pos++;
      if (p->pos >= p->len) return false;
      char e = p->s[p->pos];
      if (e == 'u') {
        if (p->pos + 4 >= p->len) return false;
        for (int k = 1; k <= 4; k++) {
          char h = p->s[p->pos + k];
          if (!((h >= '0' && h <= '9') || (h >= 'a' && h <= 'f') || (h >= 'A' && h <= 'F'))) return false;
        }
        p->pos += 5;
        continue;
      }
      if (!strchr("\"\\/bfnrt", e)) return false;
      p->pos++;
      continue;
    }
    if ((unsigned char)c < 0x20) return false;
    p->pos++;
  }
  return false;
}

static int parse_object(jparser *p) {
  int obj = new_node(p, PNET_J_OBJECT);
  if (obj < 0) return -1;
  p->pos++; /* { */
  skip_ws(p);
  int last = -1;
  if (p->pos < p->len && p->s[p->pos] == '}') {
    p->pos++;
    return obj;
  }
  for (;;) {
    skip_ws(p);
    const char *raw;
    size_t raw_len;
    if (!parse_string_raw(p, &raw, &raw_len)) return -1;
    int key = new_node(p, PNET_J_STRING);
    if (key < 0) return -1;
    p->doc->nodes[key].raw = raw;
    p->doc->nodes[key].raw_len = raw_len;
    skip_ws(p);
    if (p->pos >= p->len || p->s[p->pos] != ':') return -1;
    p->pos++;
    int value = parse_value(p);
    if (value < 0) return -1;
    p->doc->nodes[key].first_child = value;
    if (last < 0) p->doc->nodes[obj].first_child = key;
    else p->doc->nodes[last].next = key;
    last = key;
    skip_ws(p);
    if (p->pos >= p->len) return -1;
    if (p->s[p->pos] == ',') {
      p->pos++;
      continue;
    }
    if (p->s[p->pos] == '}') {
      p->pos++;
      return obj;
    }
    return -1;
  }
}

static int parse_array(jparser *p) {
  int arr = new_node(p, PNET_J_ARRAY);
  if (arr < 0) return -1;
  p->pos++; /* [ */
  skip_ws(p);
  int last = -1;
  if (p->pos < p->len && p->s[p->pos] == ']') {
    p->pos++;
    return arr;
  }
  for (;;) {
    int value = parse_value(p);
    if (value < 0) return -1;
    if (last < 0) p->doc->nodes[arr].first_child = value;
    else p->doc->nodes[last].next = value;
    last = value;
    skip_ws(p);
    if (p->pos >= p->len) return -1;
    if (p->s[p->pos] == ',') {
      p->pos++;
      continue;
    }
    if (p->s[p->pos] == ']') {
      p->pos++;
      return arr;
    }
    return -1;
  }
}

static int parse_value(jparser *p) {
  skip_ws(p);
  if (p->pos >= p->len) return -1;
  if (++p->depth > 32) return -1;
  int result = -1;
  char c = p->s[p->pos];
  if (c == '{' || c == '[') {
    /* Containers record their source span so a caller can hand a
     * sub-document (a nested policy, a vector) to another parser verbatim. */
    size_t start = p->pos;
    result = c == '{' ? parse_object(p) : parse_array(p);
    if (result >= 0) {
      p->doc->nodes[result].raw = p->s + start;
      p->doc->nodes[result].raw_len = p->pos - start;
    }
  } else if (c == '"') {
    const char *raw;
    size_t raw_len;
    if (parse_string_raw(p, &raw, &raw_len)) {
      result = new_node(p, PNET_J_STRING);
      if (result >= 0) {
        p->doc->nodes[result].raw = raw;
        p->doc->nodes[result].raw_len = raw_len;
      }
    }
  } else if (c == 't' && p->pos + 4 <= p->len && memcmp(p->s + p->pos, "true", 4) == 0) {
    result = new_node(p, PNET_J_BOOL);
    if (result >= 0) p->doc->nodes[result].truthy = true;
    p->pos += 4;
  } else if (c == 'f' && p->pos + 5 <= p->len && memcmp(p->s + p->pos, "false", 5) == 0) {
    result = new_node(p, PNET_J_BOOL);
    p->pos += 5;
  } else if (c == 'n' && p->pos + 4 <= p->len && memcmp(p->s + p->pos, "null", 4) == 0) {
    result = new_node(p, PNET_J_NULL);
    p->pos += 4;
  } else if (c == '-' || (c >= '0' && c <= '9')) {
    size_t start = p->pos;
    if (c == '-') p->pos++;
    size_t digits = 0;
    while (p->pos < p->len && p->s[p->pos] >= '0' && p->s[p->pos] <= '9') { p->pos++; digits++; }
    if (digits == 0) return -1;
    if (p->pos < p->len && p->s[p->pos] == '.') {
      p->pos++;
      digits = 0;
      while (p->pos < p->len && p->s[p->pos] >= '0' && p->s[p->pos] <= '9') { p->pos++; digits++; }
      if (digits == 0) return -1;
    }
    if (p->pos < p->len && (p->s[p->pos] == 'e' || p->s[p->pos] == 'E')) {
      p->pos++;
      if (p->pos < p->len && (p->s[p->pos] == '+' || p->s[p->pos] == '-')) p->pos++;
      digits = 0;
      while (p->pos < p->len && p->s[p->pos] >= '0' && p->s[p->pos] <= '9') { p->pos++; digits++; }
      if (digits == 0) return -1;
    }
    result = new_node(p, PNET_J_NUMBER);
    if (result >= 0) {
      p->doc->nodes[result].raw = p->s + start;
      p->doc->nodes[result].raw_len = p->pos - start;
    }
  }
  p->depth--;
  return result;
}

int pnet_json_parse(pnet_jdoc *doc, pnet_jnode *nodes, int cap, const char *text, size_t len) {
  doc->nodes = nodes;
  doc->count = 0;
  doc->cap = cap;
  jparser p = {.s = text, .len = len, .pos = 0, .doc = doc, .depth = 0};
  int root = parse_value(&p);
  if (root < 0) return -1;
  skip_ws(&p);
  if (p.pos != p.len) return -1;
  return root;
}

bool pnet_json_key_is(const pnet_jdoc *doc, int key, const char *name) {
  const pnet_jnode *n = &doc->nodes[key];
  size_t nl = strlen(name);
  /* Keys with escapes never match our plain identifiers. */
  return n->raw_len == nl && memcmp(n->raw, name, nl) == 0;
}

int pnet_json_get(const pnet_jdoc *doc, int object, const char *key) {
  if (object < 0 || doc->nodes[object].type != PNET_J_OBJECT) return -1;
  for (int k = doc->nodes[object].first_child; k >= 0; k = doc->nodes[k].next) {
    if (pnet_json_key_is(doc, k, key)) return doc->nodes[k].first_child;
  }
  return -1;
}

static bool put_utf8(char *out, size_t cap, size_t *o, uint32_t cp) {
  char tmp[4];
  size_t n;
  if (cp < 0x80) { tmp[0] = (char)cp; n = 1; }
  else if (cp < 0x800) { tmp[0] = (char)(0xc0 | (cp >> 6)); tmp[1] = (char)(0x80 | (cp & 63)); n = 2; }
  else if (cp < 0x10000) {
    tmp[0] = (char)(0xe0 | (cp >> 12)); tmp[1] = (char)(0x80 | ((cp >> 6) & 63)); tmp[2] = (char)(0x80 | (cp & 63)); n = 3;
  } else {
    tmp[0] = (char)(0xf0 | (cp >> 18)); tmp[1] = (char)(0x80 | ((cp >> 12) & 63));
    tmp[2] = (char)(0x80 | ((cp >> 6) & 63)); tmp[3] = (char)(0x80 | (cp & 63)); n = 4;
  }
  if (*o + n >= cap) return false;
  memcpy(out + *o, tmp, n);
  *o += n;
  return true;
}

static int hex4(const char *s) {
  int v = 0;
  for (int i = 0; i < 4; i++) {
    char c = s[i];
    int h = (c >= '0' && c <= '9') ? c - '0' : (c >= 'a' && c <= 'f') ? c - 'a' + 10 : (c >= 'A' && c <= 'F') ? c - 'A' + 10 : -1;
    if (h < 0) return -1;
    v = (v << 4) | h;
  }
  return v;
}

bool pnet_json_string(const pnet_jdoc *doc, int node, char *out, size_t cap, size_t *out_len) {
  if (node < 0 || doc->nodes[node].type != PNET_J_STRING || cap == 0) return false;
  const char *s = doc->nodes[node].raw;
  size_t len = doc->nodes[node].raw_len;
  size_t o = 0;
  for (size_t i = 0; i < len;) {
    char c = s[i];
    if (c != '\\') {
      if (o + 1 >= cap) return false;
      out[o++] = c;
      i++;
      continue;
    }
    i++;
    if (i >= len) return false;
    char e = s[i++];
    uint32_t cp;
    switch (e) {
      case '"': cp = '"'; break;
      case '\\': cp = '\\'; break;
      case '/': cp = '/'; break;
      case 'b': cp = '\b'; break;
      case 'f': cp = '\f'; break;
      case 'n': cp = '\n'; break;
      case 'r': cp = '\r'; break;
      case 't': cp = '\t'; break;
      case 'u': {
        if (i + 4 > len) return false;
        int v = hex4(s + i);
        if (v < 0) return false;
        i += 4;
        cp = (uint32_t)v;
        if (cp >= 0xd800 && cp <= 0xdbff) {
          if (i + 6 <= len && s[i] == '\\' && s[i + 1] == 'u') {
            int lo = hex4(s + i + 2);
            if (lo >= 0xdc00 && lo <= 0xdfff) {
              cp = 0x10000 + ((cp - 0xd800) << 10) + ((uint32_t)lo - 0xdc00);
              i += 6;
            } else {
              cp = 0xfffd;
            }
          } else {
            cp = 0xfffd;
          }
        } else if (cp >= 0xdc00 && cp <= 0xdfff) {
          cp = 0xfffd;
        }
        break;
      }
      default:
        return false;
    }
    if (!put_utf8(out, cap, &o, cp)) return false;
  }
  out[o] = 0;
  if (out_len) *out_len = o;
  return true;
}

char *pnet_json_string_dup(pnet_runtime *rt, const pnet_jdoc *doc, int node, size_t *out_len) {
  if (node < 0 || doc->nodes[node].type != PNET_J_STRING) return NULL;
  size_t cap = doc->nodes[node].raw_len + 1;
  char *out = pnet_alloc(rt, cap);
  if (!out) return NULL;
  size_t len = 0;
  if (!pnet_json_string(doc, node, out, cap, &len)) {
    pnet_free(rt, out, cap);
    return NULL;
  }
  if (out_len) *out_len = len;
  /* Shrink bookkeeping: keep the block as allocated (cap bytes). Callers free
   * with pnet_free_str which uses strlen+1; keep exact only when equal. */
  if (len + 1 != cap) {
    char *exact = pnet_strdup_n(rt, out, len);
    pnet_free(rt, out, cap);
    return exact;
  }
  return out;
}

bool pnet_json_i64(const pnet_jdoc *doc, int node, int64_t *out) {
  if (node < 0 || doc->nodes[node].type != PNET_J_NUMBER) return false;
  const char *s = doc->nodes[node].raw;
  size_t len = doc->nodes[node].raw_len;
  bool neg = false;
  size_t i = 0;
  if (i < len && s[i] == '-') { neg = true; i++; }
  int64_t v = 0;
  size_t digits = 0;
  for (; i < len; i++) {
    if (s[i] < '0' || s[i] > '9') return false; /* fraction/exponent: not integral */
    if (v > (INT64_MAX - 9) / 10) return false;
    v = v * 10 + (s[i] - '0');
    digits++;
  }
  if (digits == 0) return false;
  *out = neg ? -v : v;
  return true;
}
