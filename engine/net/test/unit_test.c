/* Unit tests for the portable pieces of the network core: HTTP/1.1 head and
 * body parsing (strict framing profile), URL parsing/resolution, policy
 * matching, JSON reading, UTF-8, base64/SHA-1 and the tick queue. Runs on
 * the host with a plain-heap platform; no sockets. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "pnet_internal.h"

static int failures = 0;
static int checks = 0;

#define CHECK(cond)                                                                    \
  do {                                                                                 \
    checks++;                                                                          \
    if (!(cond)) {                                                                     \
      failures++;                                                                      \
      fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);                  \
    }                                                                                  \
  } while (0)

/* --- test platform ------------------------------------------------------ */

static uint64_t fake_now = 1000;
static uint64_t now_ms(void *ctx) { (void)ctx; return fake_now; }
static void *plat_alloc(void *ctx, size_t size) { (void)ctx; return malloc(size); }
static void plat_free(void *ctx, void *ptr, size_t size) { (void)ctx; (void)size; free(ptr); }
static void plat_random(void *ctx, uint8_t *out, size_t len) {
  (void)ctx;
  for (size_t i = 0; i < len; i++) out[i] = (uint8_t)(i * 31 + 7);
}
static void plat_log(void *ctx, pnet_log_level level, const char *msg) {
  (void)ctx;
  (void)level;
  fprintf(stderr, "[pnet] %s\n", msg);
}

static int stub_resolve(void *ctx, uint32_t req_id, const char *host) { (void)ctx; (void)req_id; (void)host; return PNET_IO_ERROR; }
static void stub_resolve_cancel(void *ctx, uint32_t id) { (void)ctx; (void)id; }
static pnet_sock stub_connect(void *ctx, const pnet_addr *addr, int *err) { (void)ctx; (void)addr; *err = PNET_IO_REFUSED; return PNET_SOCK_INVALID; }
static int stub_status(void *ctx, pnet_sock s) { (void)ctx; (void)s; return PNET_IO_ERROR; }
static int stub_read(void *ctx, pnet_sock s, uint8_t *b, size_t l) { (void)ctx; (void)s; (void)b; (void)l; return PNET_IO_ERROR; }
static int stub_write(void *ctx, pnet_sock s, const uint8_t *b, size_t l) { (void)ctx; (void)s; (void)b; (void)l; return PNET_IO_ERROR; }
static void stub_shutdown(void *ctx, pnet_sock s) { (void)ctx; (void)s; }
static void stub_close(void *ctx, pnet_sock s) { (void)ctx; (void)s; }
static void stub_interest(void *ctx, pnet_sock s, unsigned f) { (void)ctx; (void)s; (void)f; }
static pnet_sock stub_listen(void *ctx, const pnet_addr *a, int b, pnet_addr *bound, int *err) { (void)ctx; (void)a; (void)b; (void)bound; *err = PNET_IO_ERROR; return PNET_SOCK_INVALID; }
static pnet_sock stub_accept(void *ctx, pnet_sock l, pnet_addr *p, int *err) { (void)ctx; (void)l; (void)p; *err = PNET_IO_AGAIN; return PNET_SOCK_INVALID; }
static int stub_local(void *ctx, pnet_sock s, pnet_addr *o) { (void)ctx; (void)s; (void)o; return PNET_IO_ERROR; }

static const pnet_driver_ops STUB_DRIVER = {
    stub_resolve, stub_resolve_cancel, stub_connect, stub_status, stub_read, stub_write,
    stub_shutdown, stub_close, stub_interest, stub_listen, stub_accept, stub_local, NULL,
};

static pnet_runtime *make_runtime(const char *policy) {
  pnet_platform plat = {NULL, now_ms, plat_alloc, plat_free, plat_random, plat_log};
  pnet_runtime_config cfg;
  pnet_runtime_config_defaults(&cfg);
  return pnet_runtime_create(&plat, &STUB_DRIVER, NULL, &cfg, policy);
}

static const char *POLICY =
    "{\"connect\":[{\"protocol\":\"http\",\"host\":\"example.test\",\"port\":80},"
    "{\"protocol\":\"http\",\"host\":\"*.devices.test\",\"port\":{\"min\":8000,\"max\":8100}},"
    "{\"protocol\":\"http\",\"host\":\"192.168.1.20\",\"port\":8080},"
    "{\"protocol\":\"ws\",\"host\":\"echo.test\",\"port\":80}],"
    "\"listen\":[{\"protocol\":\"http\",\"address\":\"0.0.0.0\",\"port\":8080},"
    "{\"protocol\":\"http\",\"address\":\"127.0.0.1\",\"port\":\"ephemeral\"}],"
    "\"credentials\":[\"device-cert\"],\"insecureTransport\":true,\"localNetwork\":true}";

/* --- HTTP/1.1 head ------------------------------------------------------ */

static void test_h1_head(void) {
  char raw[] = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nSet-Cookie: a=1\r\nset-cookie: b=2\r\n"
               "Content-Length: 5\r\nConnection: keep-alive\r\n\r\nhello";
  pnet_h1_head head;
  int rc = pnet_h1_parse_head((uint8_t *)raw, sizeof raw - 1, false, 8192, 64, 2048, &head);
  CHECK(rc == PNET_H1_OK);
  CHECK(head.status == 200);
  CHECK(head.reason_len == 2 && memcmp(head.reason, "OK", 2) == 0);
  CHECK(head.field_count == 5);
  CHECK(head.content_length == 5);
  CHECK(!head.chunked);
  CHECK(head.connection_keep_alive && !head.connection_close);
  CHECK(head.head_len == sizeof raw - 1 - 5);
  const pnet_h1_field *ct = pnet_h1_find(&head, "content-type");
  CHECK(ct && strcmp(ct->value, "text/plain") == 0);
  CHECK(pnet_h1_validate_framing(&head));

  /* Incomplete */
  char partial[] = "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n";
  CHECK(pnet_h1_parse_head((uint8_t *)partial, sizeof partial - 1, false, 8192, 64, 2048, &head) == PNET_H1_INCOMPLETE);

  /* TE + CL rejected */
  char both[] = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\n\r\n";
  CHECK(pnet_h1_parse_head((uint8_t *)both, sizeof both - 1, false, 8192, 64, 2048, &head) == PNET_H1_ERROR);
  /* Duplicate CL rejected even when equal */
  char dup[] = "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 5\r\n\r\n";
  CHECK(pnet_h1_parse_head((uint8_t *)dup, sizeof dup - 1, false, 8192, 64, 2048, &head) == PNET_H1_ERROR);
  /* CL comma list rejected */
  char comma[] = "HTTP/1.1 200 OK\r\nContent-Length: 5, 5\r\n\r\n";
  CHECK(pnet_h1_parse_head((uint8_t *)comma, sizeof comma - 1, false, 8192, 64, 2048, &head) == PNET_H1_ERROR);
  /* Unknown coding / combined codings rejected */
  char gz[] = "HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n";
  CHECK(pnet_h1_parse_head((uint8_t *)gz, sizeof gz - 1, false, 8192, 64, 2048, &head) == PNET_H1_ERROR);
  char twice[] = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n";
  CHECK(pnet_h1_parse_head((uint8_t *)twice, sizeof twice - 1, false, 8192, 64, 2048, &head) == PNET_H1_ERROR);
  /* obs-fold rejected */
  char fold[] = "HTTP/1.1 200 OK\r\nX-A: 1\r\n  2\r\n\r\n";
  CHECK(pnet_h1_parse_head((uint8_t *)fold, sizeof fold - 1, false, 8192, 64, 2048, &head) == PNET_H1_ERROR);
  /* Header block over limit */
  char big[] = "HTTP/1.1 200 OK\r\nX-A: 0123456789012345678901234567890123456789\r\n\r\n";
  CHECK(pnet_h1_parse_head((uint8_t *)big, sizeof big - 1, false, 32, 64, 2048, &head) == PNET_H1_TOO_LARGE);
  /* Chunked ok */
  char ch[] = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n";
  CHECK(pnet_h1_parse_head((uint8_t *)ch, sizeof ch - 1, false, 8192, 64, 2048, &head) == PNET_H1_OK && head.chunked);
  /* Request line */
  char req[] = "POST /a/b?c=1 HTTP/1.1\r\nHost: h\r\nExpect: 100-continue\r\n\r\n";
  CHECK(pnet_h1_parse_head((uint8_t *)req, sizeof req - 1, true, 8192, 64, 2048, &head) == PNET_H1_OK);
  CHECK(head.method_len == 4 && memcmp(head.method, "POST", 4) == 0);
  CHECK(head.target_len == 8 && memcmp(head.target, "/a/b?c=1", 8) == 0);
  CHECK(head.expect_continue);
  char longtarget[] = "GET /0123456789 HTTP/1.1\r\n\r\n";
  CHECK(pnet_h1_parse_head((uint8_t *)longtarget, sizeof longtarget - 1, true, 8192, 64, 4, &head) == PNET_H1_TARGET_TOO_LONG);
  char badver[] = "GET / HTTP/2.0\r\n\r\n";
  CHECK(pnet_h1_parse_head((uint8_t *)badver, sizeof badver - 1, true, 8192, 64, 2048, &head) == PNET_H1_ERROR);
  char toomany[] = "GET / HTTP/1.1\r\nA: 1\r\nB: 2\r\nC: 3\r\n\r\n";
  CHECK(pnet_h1_parse_head((uint8_t *)toomany, sizeof toomany - 1, true, 8192, 2, 2048, &head) == PNET_H1_TOO_MANY_FIELDS);
}

/* --- body decoding ------------------------------------------------------ */

typedef struct collect {
  uint8_t out[512];
  size_t len;
} collect;

static bool collect_sink(void *ctx, const uint8_t *data, size_t len) {
  collect *c = ctx;
  if (c->len + len > sizeof c->out) return false;
  memcpy(c->out + c->len, data, len);
  c->len += len;
  return true;
}

static void test_h1_body(void) {
  pnet_h1_body b;
  collect c = {{0}, 0};
  pnet_h1_body_init(&b, PNET_H1_BODY_LENGTH, 5);
  const uint8_t in[] = "hello world";
  size_t used = pnet_h1_body_feed(&b, in, 11, collect_sink, &c);
  CHECK(used == 5 && b.done && c.len == 5 && memcmp(c.out, "hello", 5) == 0);

  /* Chunked, split across feeds, with extension and trailer. */
  const char *chunks = "4;ext=1\r\nWiki\r\n5\r\npedia\r\nE\r\n in\r\n\r\nchunks.\r\n0\r\nX-Trailer: ok\r\n\r\nNEXT";
  size_t total = strlen(chunks);
  pnet_h1_body_init(&b, PNET_H1_BODY_CHUNKED, 0);
  c.len = 0;
  size_t pos = 0;
  while (pos < total && !b.done && !b.error) {
    size_t step = pos % 3 + 1;
    if (pos + step > total) step = total - pos;
    size_t n = pnet_h1_body_feed(&b, (const uint8_t *)chunks + pos, step, collect_sink, &c);
    pos += n;
    if (n == 0) break;
  }
  CHECK(b.done && !b.error);
  CHECK(c.len == 23 && memcmp(c.out, "Wikipedia in\r\n\r\nchunks.", 23) == 0);
  CHECK(total - pos == 4); /* "NEXT" left unconsumed */

  /* Forbidden trailer field */
  const char *badtrailer = "0\r\nContent-Length: 3\r\n\r\n";
  pnet_h1_body_init(&b, PNET_H1_BODY_CHUNKED, 0);
  c.len = 0;
  pnet_h1_body_feed(&b, (const uint8_t *)badtrailer, strlen(badtrailer), collect_sink, &c);
  CHECK(b.error);
  /* Bad chunk size */
  const char *badsize = "zz\r\n";
  pnet_h1_body_init(&b, PNET_H1_BODY_CHUNKED, 0);
  pnet_h1_body_feed(&b, (const uint8_t *)badsize, 4, collect_sink, &c);
  CHECK(b.error);
  /* Missing CRLF after data */
  const char *badcrlf = "3\r\nabcX";
  pnet_h1_body_init(&b, PNET_H1_BODY_CHUNKED, 0);
  c.len = 0;
  pnet_h1_body_feed(&b, (const uint8_t *)badcrlf, 7, collect_sink, &c);
  CHECK(b.error);
  /* Close-delimited passes everything through */
  pnet_h1_body_init(&b, PNET_H1_BODY_CLOSE, 0);
  c.len = 0;
  CHECK(pnet_h1_body_feed(&b, in, 11, collect_sink, &c) == 11 && !b.done && c.len == 11);
}

/* --- URL ---------------------------------------------------------------- */

static void test_url(pnet_runtime *rt) {
  pnet_url u;
  CHECK(pnet_url_parse(rt, "HTTP://Example.TEST:80/a?b=1#frag", 33, &u));
  CHECK(strcmp(u.scheme, "http") == 0);
  CHECK(strcmp(u.host, "example.test") == 0);
  CHECK(u.port == 80 && !u.port_explicit);
  CHECK(strcmp(u.path, "/a?b=1") == 0);
  pnet_url r;
  CHECK(pnet_url_resolve(rt, &u, "../x/./y", 8, &r));
  CHECK(strcmp(r.path, "/x/y") == 0);
  pnet_url_free(rt, &r);
  CHECK(pnet_url_resolve(rt, &u, "//other.test:8080/z", 19, &r));
  CHECK(strcmp(r.host, "other.test") == 0 && r.port == 8080 && r.port_explicit);
  pnet_url_free(rt, &r);
  CHECK(pnet_url_resolve(rt, &u, "?q", 2, &r));
  CHECK(strcmp(r.path, "/a?q") == 0);
  pnet_url_free(rt, &r);
  CHECK(pnet_url_resolve(rt, &u, "https://s.test/p", 16, &r));
  CHECK(strcmp(r.scheme, "https") == 0 && r.port == 443);
  pnet_url_free(rt, &r);
  pnet_url_free(rt, &u);
  CHECK(!pnet_url_parse(rt, "ftp://x/", 8, &u));
  CHECK(!pnet_url_parse(rt, "http://u:p@x/", 13, &u));
  CHECK(!pnet_url_parse(rt, "http:///", 8, &u));
  CHECK(pnet_url_parse(rt, "http://[::1]:8080/", 18, &u));
  CHECK(u.host_is_ipv6 && strcmp(u.host, "::1") == 0 && u.port == 8080);
  pnet_url_free(rt, &u);
  CHECK(pnet_url_parse(rt, "ws://echo.test", 14, &u));
  CHECK(strcmp(u.path, "/") == 0 && u.port == 80);
  pnet_url_free(rt, &u);
}

/* --- policy ------------------------------------------------------------- */

static void test_policy(pnet_runtime *rt) {
  const pnet_policy *p = &rt->policy;
  CHECK(p->connect_count == 4 && p->listen_count == 2 && p->credential_count == 1);
  CHECK(pnet_policy_allows_connect(p, PNET_PROTO_HTTP, "example.test", 80));
  CHECK(!pnet_policy_allows_connect(p, PNET_PROTO_HTTP, "example.test", 81));
  CHECK(!pnet_policy_allows_connect(p, PNET_PROTO_HTTPS, "example.test", 80));
  CHECK(pnet_policy_allows_connect(p, PNET_PROTO_HTTP, "a.devices.test", 8050));
  CHECK(!pnet_policy_allows_connect(p, PNET_PROTO_HTTP, "a.b.devices.test", 8050));
  CHECK(!pnet_policy_allows_connect(p, PNET_PROTO_HTTP, "devices.test", 8050));
  CHECK(pnet_policy_allows_connect(p, PNET_PROTO_HTTP, "192.168.1.20", 8080));
  CHECK(!pnet_policy_allows_connect(p, PNET_PROTO_HTTP, "192.168.1.21", 8080));
  CHECK(pnet_policy_allows_connect(p, PNET_PROTO_WS, "echo.test", 80));
  pnet_addr any = {4, {0, 0, 0, 0}, 0};
  pnet_addr lo = {4, {127, 0, 0, 1}, 0};
  CHECK(pnet_policy_allows_listen(p, PNET_PROTO_HTTP, &any, 8080));
  CHECK(!pnet_policy_allows_listen(p, PNET_PROTO_HTTP, &any, 8081));
  CHECK(pnet_policy_allows_listen(p, PNET_PROTO_HTTP, &lo, 0));
  CHECK(!pnet_policy_allows_listen(p, PNET_PROTO_HTTP, &lo, 8080));
  CHECK(pnet_policy_has_credential(p, "device-cert") && !pnet_policy_has_credential(p, "other"));
  pnet_addr priv = {4, {10, 0, 0, 5}, 0};
  pnet_addr pub = {4, {93, 184, 216, 34}, 0};
  pnet_addr mc = {4, {224, 0, 0, 1}, 0};
  CHECK(pnet_policy_allows_address(p, &priv)); /* localNetwork: true */
  CHECK(pnet_policy_allows_address(p, &pub));
  CHECK(!pnet_policy_allows_address(p, &mc));
  CHECK(!pnet_addr_is_public(&lo));
  pnet_addr v6lo = {6, {0}, 0};
  v6lo.addr[15] = 1;
  CHECK(!pnet_addr_is_public(&v6lo));

  pnet_runtime *strict = make_runtime("{\"connect\":[{\"protocol\":\"http\",\"host\":\"h.test\",\"port\":80}],\"insecureTransport\":false}");
  CHECK(strict != NULL);
  if (strict) {
    CHECK(!pnet_policy_allows_connect(&strict->policy, PNET_PROTO_HTTP, "h.test", 80));
    CHECK(!pnet_policy_allows_address(&strict->policy, &priv));
    pnet_runtime_destroy(strict);
  }
  CHECK(make_runtime("{\"connect\":[{\"protocol\":\"gopher\",\"host\":\"h\",\"port\":1}]}") == NULL);
  CHECK(make_runtime("not json") == NULL);
}

/* --- shared policy vectors -------------------------------------------------- */

/* contracts/spec/vectors/network-policy.json: the same documents and
 * decisions the TypeScript reference and the Rust core run. The path comes
 * from CMake (PNET_VECTORS_DIR). */
#ifndef PNET_VECTORS_DIR
#define PNET_VECTORS_DIR "../../contracts/spec/vectors"
#endif

static char *read_file(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  char *buf = malloc((size_t)n + 1);
  if (!buf) { fclose(f); return NULL; }
  if (fread(buf, 1, (size_t)n, f) != (size_t)n) { fclose(f); free(buf); return NULL; }
  fclose(f);
  buf[n] = 0;
  *len = (size_t)n;
  return buf;
}

static pnet_runtime *vector_runtime(const pnet_jdoc *doc, int policies, const char *name) {
  int node = pnet_json_get(doc, policies, name);
  if (node < 0) return NULL;
  size_t len = doc->nodes[node].raw_len;
  char *text = malloc(len + 1);
  memcpy(text, doc->nodes[node].raw, len);
  text[len] = 0;
  pnet_runtime *rt = make_runtime(text);
  free(text);
  return rt;
}

static void test_policy_vectors(void) {
  size_t len = 0;
  char *text = read_file(PNET_VECTORS_DIR "/network-policy.json", &len);
  CHECK(text != NULL);
  if (!text) return;
  enum { CAP = 4096 };
  pnet_jnode *nodes = malloc(sizeof(pnet_jnode) * CAP);
  pnet_jdoc doc;
  int root = pnet_json_parse(&doc, nodes, CAP, text, len);
  CHECK(root >= 0);
  if (root < 0) { free(nodes); free(text); return; }
  int policies = pnet_json_get(&doc, root, "policies");
  CHECK(policies >= 0);

  /* Every named policy parses. */
  for (int k = doc.nodes[policies].first_child; k >= 0; k = doc.nodes[k].next) {
    char name[64];
    size_t nl;
    pnet_json_string(&doc, k, name, sizeof name, &nl);
    pnet_runtime *rt = vector_runtime(&doc, policies, name);
    if (!rt) fprintf(stderr, "vector policy %s did not parse\n", name);
    CHECK(rt != NULL);
    if (rt) pnet_runtime_destroy(rt);
  }

  /* Invalid documents are refused. */
  int invalid = pnet_json_get(&doc, root, "invalid");
  for (int e = pnet_json_first(&doc, invalid); e >= 0; e = pnet_json_next(&doc, e)) {
    char name[96];
    pnet_json_string(&doc, pnet_json_get(&doc, e, "name"), name, sizeof name, NULL);
    int pol = pnet_json_get(&doc, e, "policy");
    size_t plen = doc.nodes[pol].raw_len;
    char *ptext = malloc(plen + 1);
    memcpy(ptext, doc.nodes[pol].raw, plen);
    ptext[plen] = 0;
    pnet_runtime *rt = make_runtime(ptext);
    if (rt) fprintf(stderr, "invalid vector accepted: %s\n", name);
    CHECK(rt == NULL);
    if (rt) pnet_runtime_destroy(rt);
    free(ptext);
  }

  /* Connect decisions. */
  int connect = pnet_json_get(&doc, root, "connect");
  for (int e = pnet_json_first(&doc, connect); e >= 0; e = pnet_json_next(&doc, e)) {
    char pname[64], proto[8], host[256];
    int64_t port;
    pnet_json_string(&doc, pnet_json_get(&doc, e, "policy"), pname, sizeof pname, NULL);
    pnet_json_string(&doc, pnet_json_get(&doc, e, "protocol"), proto, sizeof proto, NULL);
    pnet_json_string(&doc, pnet_json_get(&doc, e, "host"), host, sizeof host, NULL);
    pnet_json_i64(&doc, pnet_json_get(&doc, e, "port"), &port);
    int allowed_node = pnet_json_get(&doc, e, "allowed");
    bool allowed = doc.nodes[allowed_node].truthy;
    pnet_runtime *rt = vector_runtime(&doc, policies, pname);
    CHECK(rt != NULL);
    if (!rt) continue;
    /* The core sees URL hosts the way pnet_url hands them over: lowercase,
     * brackets stripped, trailing dot removed. */
    char norm[256];
    size_t hl = strlen(host);
    const char *h = host;
    if (hl >= 2 && host[0] == '[' && host[hl - 1] == ']') { h = host + 1; hl -= 2; }
    memcpy(norm, h, hl);
    norm[hl] = 0;
    pnet_lower(norm, hl);
    if (hl > 1 && norm[hl - 1] == '.') norm[--hl] = 0;
    bool got = pnet_policy_allows_connect(&rt->policy, pnet_proto_from_scheme(proto), norm, (uint16_t)port);
    if (got != allowed) fprintf(stderr, "connect vector mismatch: %s %s %s %lld -> %d\n", pname, proto, host, (long long)port, got);
    CHECK(got == allowed);
    pnet_runtime_destroy(rt);
  }

  /* Address classification + the localNetwork gate. */
  pnet_runtime *open = vector_runtime(&doc, policies, "standard");
  pnet_runtime *closed = vector_runtime(&doc, policies, "secure-only");
  CHECK(open && closed);
  int address = pnet_json_get(&doc, root, "address");
  for (int e = pnet_json_first(&doc, address); e >= 0 && open && closed; e = pnet_json_next(&doc, e)) {
    char lit[64];
    pnet_json_string(&doc, pnet_json_get(&doc, e, "address"), lit, sizeof lit, NULL);
    bool is_public = doc.nodes[pnet_json_get(&doc, e, "public")].truthy;
    bool is_multicast = doc.nodes[pnet_json_get(&doc, e, "multicast")].truthy;
    pnet_addr a;
    bool parsed = pnet_parse_ip_literal(lit, strlen(lit), &a);
    CHECK(parsed);
    if (!parsed) continue;
    if (pnet_addr_is_public(&a) != is_public) fprintf(stderr, "address vector public mismatch: %s\n", lit);
    CHECK(pnet_addr_is_public(&a) == is_public);
    CHECK(pnet_addr_is_multicast(&a) == is_multicast);
    CHECK(pnet_policy_allows_address(&closed->policy, &a) == is_public);
    CHECK(pnet_policy_allows_address(&open->policy, &a) == !is_multicast);
  }
  if (open) pnet_runtime_destroy(open);
  if (closed) pnet_runtime_destroy(closed);

  /* Listen decisions. */
  int listen = pnet_json_get(&doc, root, "listen");
  for (int e = pnet_json_first(&doc, listen); e >= 0; e = pnet_json_next(&doc, e)) {
    char pname[64], proto[8], lit[64];
    int64_t port;
    pnet_json_string(&doc, pnet_json_get(&doc, e, "policy"), pname, sizeof pname, NULL);
    pnet_json_string(&doc, pnet_json_get(&doc, e, "protocol"), proto, sizeof proto, NULL);
    pnet_json_string(&doc, pnet_json_get(&doc, e, "address"), lit, sizeof lit, NULL);
    pnet_json_i64(&doc, pnet_json_get(&doc, e, "port"), &port);
    bool allowed = doc.nodes[pnet_json_get(&doc, e, "allowed")].truthy;
    pnet_runtime *rt = vector_runtime(&doc, policies, pname);
    CHECK(rt != NULL);
    if (!rt) continue;
    pnet_addr a;
    CHECK(pnet_parse_ip_literal(lit, strlen(lit), &a));
    bool got = pnet_policy_allows_listen(&rt->policy, pnet_proto_from_scheme(proto), &a, (uint16_t)port);
    if (got != allowed) fprintf(stderr, "listen vector mismatch: %s %s %s %lld -> %d\n", pname, proto, lit, (long long)port, got);
    CHECK(got == allowed);
    pnet_runtime_destroy(rt);
  }
  free(nodes);
  free(text);
}

/* --- JSON --------------------------------------------------------------- */

static void test_json(pnet_runtime *rt) {
  pnet_jnode nodes[64];
  pnet_jdoc doc;
  const char *text = "{\"url\":\"http://x/\\u00e9\\n\",\"n\":42,\"neg\":-7,\"arr\":[1,\"two\",true,null],\"o\":{\"k\":false}}";
  int root = pnet_json_parse(&doc, nodes, 64, text, strlen(text));
  CHECK(root >= 0);
  char buf[64];
  size_t len;
  CHECK(pnet_json_string(&doc, pnet_json_get(&doc, root, "url"), buf, sizeof buf, &len));
  CHECK(len == 12 && memcmp(buf, "http://x/\xC3\xA9\n", 12) == 0);
  int64_t v;
  CHECK(pnet_json_i64(&doc, pnet_json_get(&doc, root, "n"), &v) && v == 42);
  CHECK(pnet_json_i64(&doc, pnet_json_get(&doc, root, "neg"), &v) && v == -7);
  int arr = pnet_json_get(&doc, root, "arr");
  CHECK(pnet_json_type(&doc, arr) == PNET_J_ARRAY);
  int e = pnet_json_first(&doc, arr);
  CHECK(pnet_json_type(&doc, e) == PNET_J_NUMBER);
  e = pnet_json_next(&doc, e);
  CHECK(pnet_json_type(&doc, e) == PNET_J_STRING);
  e = pnet_json_next(&doc, e);
  CHECK(pnet_json_type(&doc, e) == PNET_J_BOOL && doc.nodes[e].truthy);
  e = pnet_json_next(&doc, e);
  CHECK(pnet_json_type(&doc, e) == PNET_J_NULL);
  CHECK(pnet_json_next(&doc, e) == -1);
  int o = pnet_json_get(&doc, root, "o");
  CHECK(pnet_json_type(&doc, pnet_json_get(&doc, o, "k")) == PNET_J_BOOL);
  CHECK(pnet_json_get(&doc, root, "missing") == -1);
  char *dup = pnet_json_string_dup(rt, &doc, pnet_json_get(&doc, root, "url"), &len);
  CHECK(dup && len == 12);
  pnet_free_str(rt, dup);
  CHECK(pnet_json_parse(&doc, nodes, 64, "{\"a\":}", 6) < 0);
  CHECK(pnet_json_parse(&doc, nodes, 64, "[1,2", 4) < 0);
  CHECK(pnet_json_parse(&doc, nodes, 4, "[1,2,3,4,5,6]", 13) < 0); /* node cap */
  CHECK(pnet_json_parse(&doc, nodes, 64, "\"a\\qb\"", 6) < 0);      /* bad escape */
  /* Writer escaping */
  pnet_sb sb;
  pnet_sb_init(&sb);
  pnet_sb_json_string(rt, &sb, "a\"b\\c\n\x01\xC3\xA9\xff", 10);
  CHECK(strcmp(pnet_sb_cstr(&sb), "\"a\\\"b\\\\c\\n\\u0001\xC3\xA9\xEF\xBF\xBD\"") == 0);
  pnet_sb_free(rt, &sb);
}

/* --- codecs ------------------------------------------------------------- */

static void test_codecs(void) {
  CHECK(pnet_utf8_valid((const uint8_t *)"h\xC3\xA9llo \xE2\x82\xAC \xF0\x9F\x98\x80", 15));
  CHECK(!pnet_utf8_valid((const uint8_t *)"\xC0\x80", 2));                 /* overlong */
  CHECK(!pnet_utf8_valid((const uint8_t *)"\xED\xA0\x80", 3));             /* surrogate */
  CHECK(!pnet_utf8_valid((const uint8_t *)"\xF4\x90\x80\x80", 4));         /* > U+10FFFF */
  CHECK(!pnet_utf8_valid((const uint8_t *)"\xE2\x82", 2));                 /* truncated */
  pnet_utf8_state st;
  pnet_utf8_state_init(&st);
  CHECK(pnet_utf8_feed(&st, (const uint8_t *)"\xE2\x82", 2) && !pnet_utf8_complete(&st));
  CHECK(pnet_utf8_feed(&st, (const uint8_t *)"\xAC", 1) && pnet_utf8_complete(&st));
  char b64[64];
  CHECK(pnet_base64_encode((const uint8_t *)"Man", 3, b64, sizeof b64) == 4 && strcmp(b64, "TWFu") == 0);
  CHECK(pnet_base64_encode((const uint8_t *)"Ma", 2, b64, sizeof b64) == 4 && strcmp(b64, "TWE=") == 0);
  /* RFC 6455 §1.3 example: key "dGhlIHNhbXBsZSBub25jZQ==" -> accept "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" */
  const char *concat = "dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  uint8_t digest[20];
  pnet_sha1((const uint8_t *)concat, strlen(concat), digest);
  pnet_base64_encode(digest, 20, b64, sizeof b64);
  CHECK(strcmp(b64, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=") == 0);
  /* SHA-1("abc") */
  pnet_sha1((const uint8_t *)"abc", 3, digest);
  static const uint8_t abc[20] = {0xa9, 0x99, 0x3e, 0x36, 0x47, 0x06, 0x81, 0x6a, 0xba, 0x3e,
                                  0x25, 0x71, 0x78, 0x50, 0xc2, 0x6c, 0x9c, 0xd0, 0xd8, 0x9d};
  CHECK(memcmp(digest, abc, 20) == 0);
  /* 64-byte boundary message */
  char sixtyfour[64];
  memset(sixtyfour, 'a', 64);
  pnet_sha1((const uint8_t *)sixtyfour, 64, digest);
  static const uint8_t a64[20] = {0x00, 0x98, 0xba, 0x82, 0x4b, 0x5c, 0x16, 0x42, 0x7b, 0xd7,
                                  0xa1, 0x12, 0x2a, 0x5a, 0x44, 0x2a, 0x25, 0xec, 0x64, 0x4d};
  CHECK(memcmp(digest, a64, 20) == 0);
  pnet_addr a;
  CHECK(pnet_parse_ip_literal("192.168.1.2", 11, &a) && a.family == 4 && a.addr[3] == 2);
  CHECK(!pnet_parse_ip_literal("192.168.1", 9, &a));
  CHECK(!pnet_parse_ip_literal("256.1.1.1", 9, &a));
  CHECK(pnet_parse_ip_literal("fe80::1", 7, &a) && a.family == 6 && a.addr[0] == 0xfe && a.addr[15] == 1);
  CHECK(pnet_parse_ip_literal("[::ffff:1.2.3.4]", 16, &a) && a.family == 6 && a.addr[10] == 0xff && a.addr[15] == 4);
  CHECK(!pnet_parse_ip_literal("1::2::3", 7, &a));
  char text[48];
  pnet_addr v6 = {6, {0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1}, 0};
  pnet_format_addr(&v6, text, sizeof text);
  CHECK(strcmp(text, "2001:db8::1") == 0);
  pnet_addr v4 = {4, {10, 0, 0, 7}, 0};
  pnet_format_addr(&v4, text, sizeof text);
  CHECK(strcmp(text, "10.0.0.7") == 0);
  CHECK(pnet_is_token("X-Custom_1", 10) && !pnet_is_token("bad name", 8) && !pnet_is_token("", 0));
}

/* --- queue -------------------------------------------------------------- */

static void test_queue(pnet_runtime *rt) {
  pnet_queue q;
  pnet_queue_init(&q, 3, 100);
  size_t len;
  char *j1 = pnet_event_json(rt, "headers", "h", 1, ",\"status\":200", 13, &len);
  CHECK(pnet_queue_push(rt, &q, 1, false, 10, j1, len));
  char *j2 = pnet_event_json(rt, "end", "h", 1, NULL, 0, &len);
  CHECK(pnet_queue_push(rt, &q, 1, true, 0, j2, len));
  /* readable inserted before the terminal event of handle 1 */
  CHECK(pnet_queue_push_readable(rt, &q, 1, "h", 5));
  CHECK(pnet_push_error_event(rt, &q, "h", 2, "dns", "no host", NULL));
  CHECK(pnet_queue_poll(rt, &q, &len) == NULL); /* nothing visible before freeze */
  pnet_queue_freeze(rt, &q);
  const char *batch = pnet_queue_poll(rt, &q, &len);
  CHECK(batch != NULL);
  CHECK(strcmp(batch, "[{\"t\":\"headers\",\"h\":1,\"status\":200},{\"t\":\"readable\",\"h\":1,\"avail\":5},{\"t\":\"end\",\"h\":1}]") == 0);
  pnet_queue_freeze(rt, &q); /* the 4th event (over the 3-event budget) follows */
  batch = pnet_queue_poll(rt, &q, &len);
  CHECK(batch && strstr(batch, "\"t\":\"error\",\"h\":2") != NULL);
  CHECK(pnet_queue_poll(rt, &q, &len) == NULL);
  /* byte budget: a single over-budget event still goes alone */
  char *big = pnet_event_json(rt, "headers", "h", 3, NULL, 0, &len);
  CHECK(pnet_queue_push(rt, &q, 3, false, 500, big, len));
  char *small = pnet_event_json(rt, "end", "h", 3, NULL, 0, &len);
  CHECK(pnet_queue_push(rt, &q, 3, true, 1, small, len));
  pnet_queue_freeze(rt, &q);
  CHECK(q.visible_count == 1 && q.pending_count == 1);
  pnet_queue_drop_handle(rt, &q, 3);
  CHECK(q.pending_count == 0);
  pnet_queue_free(rt, &q);

  /* Transactional poll: with the heap capped at its current usage the batch
   * cannot be allocated — nothing is consumed, the terminal event survives,
   * and the next poll (memory back) delivers the whole batch. */
  pnet_queue tq;
  pnet_queue_init(&tq, 64, 65536);
  char *e1 = pnet_event_json(rt, "headers", "h", 7, ",\"status\":200", 13, &len);
  CHECK(pnet_queue_push(rt, &tq, 7, false, 10, e1, len));
  CHECK(pnet_queue_push_readable(rt, &tq, 7, "h", 5));
  char *e2 = pnet_event_json(rt, "end", "h", 7, NULL, 0, &len);
  CHECK(pnet_queue_push(rt, &tq, 7, true, 0, e2, len));
  pnet_queue_freeze(rt, &tq);
  CHECK(tq.visible_count == 3);
  size_t saved_cap = rt->cfg.max_heap_bytes;
  rt->cfg.max_heap_bytes = pnet_runtime_heap_bytes(rt);
  CHECK(pnet_queue_poll(rt, &tq, &len) == NULL);
  CHECK(tq.visible_count == 3); /* nothing consumed */
  CHECK(pnet_queue_poll(rt, &tq, &len) == NULL);
  CHECK(tq.visible_count == 3);
  rt->cfg.max_heap_bytes = saved_cap;
  batch = pnet_queue_poll(rt, &tq, &len);
  CHECK(batch != NULL);
  CHECK(batch && strstr(batch, "\"t\":\"end\",\"h\":7") != NULL);
  CHECK(batch && strstr(batch, "\"t\":\"readable\",\"h\":7") != NULL);
  CHECK(tq.visible_count == 0);
  CHECK(pnet_queue_poll(rt, &tq, &len) == NULL);

  /* Two-phase poll: render is idempotent until consume; a freeze in between
   * keeps its new events visible for the next render. */
  char *e3 = pnet_event_json(rt, "headers", "h", 8, NULL, 0, &len);
  CHECK(pnet_queue_push(rt, &tq, 8, false, 1, e3, len));
  pnet_queue_freeze(rt, &tq);
  const char *r1 = pnet_queue_render(rt, &tq, &len);
  CHECK(r1 && strstr(r1, "\"h\":8") != NULL);
  const char *r2 = pnet_queue_render(rt, &tq, &len);
  CHECK(r2 == r1 && tq.visible_count == 1);
  char *e4 = pnet_event_json(rt, "end", "h", 8, NULL, 0, &len);
  CHECK(pnet_queue_push(rt, &tq, 8, true, 0, e4, len));
  pnet_queue_freeze(rt, &tq); /* appended behind the rendered batch */
  CHECK(tq.visible_count == 2);
  pnet_queue_consume(rt, &tq);
  CHECK(tq.visible_count == 1);
  batch = pnet_queue_poll(rt, &tq, &len);
  CHECK(batch && strstr(batch, "\"t\":\"end\",\"h\":8") != NULL && strstr(batch, "headers") == NULL);
  pnet_queue_consume(rt, &tq); /* no-op without a rendered batch */
  pnet_queue_free(rt, &tq);
}

/* --- HTTP client refusals (no I/O) -------------------------------------- */

static void test_http_refusals(pnet_runtime *rt) {
  CHECK(pnet_http_start(rt, "{\"url\":\"http://nope.test/\",\"method\":\"GET\",\"headers\":{}}", NULL, 0) == -1);
  CHECK(strncmp(pnet_http_last_error(rt), "permission_denied", 17) == 0);
  CHECK(pnet_http_start(rt, "{\"url\":\"https://example.test/\",\"method\":\"GET\",\"headers\":{}}", NULL, 0) == -1);
  CHECK(strncmp(pnet_http_last_error(rt), "unsupported", 11) == 0);
  CHECK(pnet_http_start(rt, "{\"url\":\"http://example.test/\",\"method\":\"TRACE\",\"headers\":{}}", NULL, 0) == -1);
  CHECK(strncmp(pnet_http_last_error(rt), "invalid_request", 15) == 0);
  CHECK(pnet_http_start(rt, "{\"url\":\"http://example.test/\",\"method\":\"GET\",\"headers\":{\"x\":\"a\\nb\"}}", NULL, 0) == -1);
  CHECK(pnet_http_start(rt, "{\"url\":\"http://example.test/\",\"method\":\"GET\",\"headers\":{},\"queueBytes\":0}", NULL, 0) == -1);
  CHECK(pnet_http_start(rt, "{\"url\":\"http://example.test/\",\"method\":\"GET\",\"headers\":{},\"redirect\":\"maybe\"}", NULL, 0) == -1);
  CHECK(pnet_http_start(rt, "{\"url\":\"http://example.test/\",\"method\":\"GET\",\"headers\":{},\"tls\":{\"verification\":\"development-insecure\"}}", NULL, 0) == -1);
  CHECK(strncmp(pnet_http_last_error(rt), "unsupported", 11) == 0);
  CHECK(pnet_http_start(rt, "{\"url\":\"http://example.test/\",\"method\":\"GET\",\"headers\":{}}", (const uint8_t *)"x", 1) == -1);
  /* .local names fail before any I/O with unsupported */
  pnet_runtime *rt2 = make_runtime("{\"connect\":[{\"protocol\":\"http\",\"host\":\"printer.local\",\"port\":80}],\"insecureTransport\":true,\"localNetwork\":true}");
  CHECK(rt2 != NULL);
  if (rt2) {
    int h = pnet_http_start(rt2, "{\"url\":\"http://printer.local/\",\"method\":\"GET\",\"headers\":{}}", NULL, 0);
    CHECK(h > 0); /* accepted synchronously; the terminal error arrives next tick */
    pnet_runtime_begin_tick(rt2);
    size_t len;
    const char *batch = pnet_http_poll(rt2, &len);
    CHECK(batch && strstr(batch, "\"code\":\"unsupported\"") != NULL);
    CHECK(pnet_runtime_heap_bytes(rt2) > 0);
    pnet_runtime_destroy(rt2);
  }
  /* The stub driver refuses every connect: the request fails asynchronously
   * with connect (the literal address skips DNS). */
  int h = pnet_http_start(rt, "{\"url\":\"http://192.168.1.20:8080/x\",\"method\":\"GET\",\"headers\":{}}", NULL, 0);
  CHECK(h > 0);
  pnet_runtime_service(rt);
  pnet_runtime_begin_tick(rt);
  size_t len;
  const char *batch = pnet_http_poll(rt, &len);
  CHECK(batch && strstr(batch, "\"code\":\"connect\"") != NULL);
  CHECK(pnet_http_read_into(rt, h, (uint8_t[8]){0}, 8) == -1);
  CHECK(!pnet_runtime_has_live_handles(rt));
  /* limits JSON is well-formed and reports the spec major */
  CHECK(strstr(pnet_http_limits(rt), "\"specMajor\":2") != NULL);
}

/* --- shared HTTP semantics vectors ------------------------------------------ */

static void test_http_semantics_vectors(void) {
  size_t len = 0;
  char *text = read_file(PNET_VECTORS_DIR "/http-semantics.json", &len);
  CHECK(text != NULL);
  if (!text) return;
  enum { CAP = 2048 };
  pnet_jnode *nodes = malloc(sizeof(pnet_jnode) * CAP);
  pnet_jdoc doc;
  int root = pnet_json_parse(&doc, nodes, CAP, text, len);
  CHECK(root >= 0);
  if (root < 0) { free(nodes); free(text); return; }
  pnet_runtime *rt = make_runtime("{\"connect\":[{\"protocol\":\"http\",\"host\":\"192.168.1.20\",\"port\":8080}],\"insecureTransport\":true,\"localNetwork\":true}");
  CHECK(rt != NULL);
  if (!rt) { free(nodes); free(text); return; }

  /* Methods: start() accepts or refuses the token. */
  int methods = pnet_json_get(&doc, root, "methods");
  for (int e = pnet_json_first(&doc, methods); e >= 0; e = pnet_json_next(&doc, e)) {
    char method[64];
    pnet_json_string(&doc, pnet_json_get(&doc, e, "method"), method, sizeof method, NULL);
    bool accepted = doc.nodes[pnet_json_get(&doc, e, "accepted")].truthy;
    char meta[256];
    /* Escape is unnecessary: the vectors' method tokens contain no quotes. */
    snprintf(meta, sizeof meta, "{\"url\":\"http://192.168.1.20:8080/\",\"method\":\"%s\",\"headers\":{}}", method);
    int h = pnet_http_start(rt, meta, NULL, 0);
    if ((h > 0) != accepted) fprintf(stderr, "method vector mismatch: %s -> %d\n", method, h);
    CHECK((h > 0) == accepted);
    if (h > 0) pnet_http_cancel(rt, h);
    pnet_runtime_service(rt);
    pnet_runtime_begin_tick(rt);
    pnet_http_poll(rt, &len);
  }

  /* Status classification. */
  int status = pnet_json_get(&doc, root, "status");
  for (int e = pnet_json_first(&doc, status); e >= 0; e = pnet_json_next(&doc, e)) {
    int64_t st;
    pnet_json_i64(&doc, pnet_json_get(&doc, e, "status"), &st);
    bool framing = doc.nodes[pnet_json_get(&doc, e, "bodylessFraming")].truthy;
    bool null_body = doc.nodes[pnet_json_get(&doc, e, "nullBody")].truthy;
    CHECK(pnet_status_is_bodyless((int)st) == framing);
    CHECK(pnet_status_is_null_body((int)st) == null_body);
  }

  /* Redirect plan. */
  int redirect = pnet_json_get(&doc, root, "redirect");
  for (int e = pnet_json_first(&doc, redirect); e >= 0; e = pnet_json_next(&doc, e)) {
    int64_t st;
    char method[16], next[16] = {0};
    pnet_json_i64(&doc, pnet_json_get(&doc, e, "status"), &st);
    pnet_json_string(&doc, pnet_json_get(&doc, e, "method"), method, sizeof method, NULL);
    bool followed = doc.nodes[pnet_json_get(&doc, e, "followed")].truthy;
    bool to_get = false;
    bool got = pnet_http_redirect_plan((int)st, method, strlen(method), &to_get);
    CHECK(got == followed);
    if (followed) {
      pnet_json_string(&doc, pnet_json_get(&doc, e, "nextMethod"), next, sizeof next, NULL);
      bool keep_body = doc.nodes[pnet_json_get(&doc, e, "keepBody")].truthy;
      const char *expect_method = to_get ? "GET" : method;
      if (strcmp(expect_method, next) != 0 || keep_body == to_get)
        fprintf(stderr, "redirect vector mismatch: %lld %s -> %s keepBody=%d\n", (long long)st, method, next, keep_body);
      CHECK(strcmp(expect_method, next) == 0);
      CHECK(keep_body == !to_get);
    }
  }

  /* Core-owned request headers are stripped, others pass. The request is
   * serialized into the connection tx queue on start; the stub driver never
   * connects, so the head sits in the queue where we can read it back. */
  int headers = pnet_json_get(&doc, root, "requestHeaders");
  for (int e = pnet_json_first(&doc, headers); e >= 0; e = pnet_json_next(&doc, e)) {
    char name[64];
    pnet_json_string(&doc, pnet_json_get(&doc, e, "name"), name, sizeof name, NULL);
    bool owned = doc.nodes[pnet_json_get(&doc, e, "coreOwned")].truthy;
    char lower[64];
    strcpy(lower, name);
    pnet_lower(lower, strlen(lower));
    static const char *const list[] = PNET_HTTP_CORE_OWNED_REQUEST_HEADERS;
    bool in_list = false;
    for (size_t i = 0; i < PNET_HTTP_CORE_OWNED_REQUEST_HEADERS_COUNT; i++)
      if (strcmp(lower, list[i]) == 0) in_list = true;
    CHECK(in_list == owned);
  }
  pnet_runtime_destroy(rt);
  free(nodes);
  free(text);
}

int main(void) {
  pnet_runtime *rt = make_runtime(POLICY);
  CHECK(rt != NULL);
  if (!rt) return 1;
  test_h1_head();
  test_h1_body();
  test_url(rt);
  test_policy(rt);
  test_policy_vectors();
  test_http_semantics_vectors();
  test_json(rt);
  test_codecs();
  test_queue(rt);
  test_http_refusals(rt);
  size_t before_destroy = pnet_runtime_heap_bytes(rt);
  pnet_runtime_destroy(rt);
  (void)before_destroy;
  printf("unit: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
