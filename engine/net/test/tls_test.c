/* TLS conformance harness for the HTTP client and WebSocket client cores.
 *
 * An in-process OpenSSL PKI (one CA, several leaf certs) and OpenSSL server
 * threads stand in for an independent TLS peer. The core runs with the
 * OpenSSL TlsProvider trusting only the test CA, so every case exercises the
 * real handshake: a valid chain, an unknown CA, an expired cert, a hostname
 * mismatch, an untrusted wall clock (fail-closed before I/O), no plaintext
 * fallback, and a working WSS echo. */
#include <arpa/inet.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include <openssl/bio.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/sha.h>
#include <openssl/ssl.h>
#include <openssl/x509v3.h>

#include "pnet_openssl_tls.h"
#include "pnet_posix_driver.h"
#include "pocketjs/net/runtime.h"

static int failures = 0;
static int checks = 0;
#define CHECK(cond)                                                             \
  do {                                                                          \
    checks++;                                                                   \
    if (!(cond)) {                                                              \
      failures++;                                                               \
      fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);           \
    }                                                                           \
  } while (0)

static uint64_t now_ms(void *ctx) {
  (void)ctx;
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000 + (uint64_t)ts.tv_nsec / 1000000;
}
static void *plat_alloc(void *ctx, size_t size) { (void)ctx; return malloc(size); }
static void plat_free(void *ctx, void *ptr, size_t size) { (void)ctx; (void)size; free(ptr); }
static void plat_random(void *ctx, uint8_t *out, size_t len) { (void)ctx; for (size_t i = 0; i < len; i++) out[i] = (uint8_t)rand(); }
static void plat_log(void *ctx, pnet_log_level level, const char *msg) { (void)ctx; if (level <= PNET_LOG_WARN) fprintf(stderr, "[pnet] %s\n", msg); }

static bool g_clock_trusted = true;
static bool wall_clock_trusted(void *ctx) { (void)ctx; return g_clock_trusted; }

/* --- PKI ---------------------------------------------------------------- */

typedef struct pki {
  EVP_PKEY *ca_key;
  X509 *ca_cert;
  char *ca_pem;
} pki;

static EVP_PKEY *gen_key(void) {
  return EVP_RSA_gen(2048);
}

static void add_ext(X509 *cert, X509 *issuer, int nid, const char *value) {
  X509V3_CTX ctx;
  X509V3_set_ctx(&ctx, issuer, cert, NULL, NULL, 0);
  X509_EXTENSION *ext = X509V3_EXT_conf_nid(NULL, &ctx, nid, value);
  if (ext) {
    X509_add_ext(cert, ext, -1);
    X509_EXTENSION_free(ext);
  }
}

static X509 *make_cert(EVP_PKEY *key, EVP_PKEY *issuer_key, X509 *issuer, const char *cn, const char *san,
                       long not_before_days, long not_after_days, bool is_ca) {
  X509 *cert = X509_new();
  X509_set_version(cert, 2);
  ASN1_INTEGER_set(X509_get_serialNumber(cert), rand());
  X509_gmtime_adj(X509_get_notBefore(cert), not_before_days * 86400);
  X509_gmtime_adj(X509_get_notAfter(cert), not_after_days * 86400);
  X509_set_pubkey(cert, key);
  X509_NAME *name = X509_get_subject_name(cert);
  X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_ASC, (const unsigned char *)cn, -1, -1, 0);
  X509_set_issuer_name(cert, issuer ? X509_get_subject_name(issuer) : name);
  if (is_ca) add_ext(cert, issuer ? issuer : cert, NID_basic_constraints, "critical,CA:TRUE");
  else {
    add_ext(cert, issuer, NID_basic_constraints, "CA:FALSE");
    if (san) add_ext(cert, issuer, NID_subject_alt_name, san);
  }
  X509_sign(cert, issuer_key, EVP_sha256());
  return cert;
}

static char *cert_pem(X509 *cert) {
  BIO *bio = BIO_new(BIO_s_mem());
  PEM_write_bio_X509(bio, cert);
  char *data;
  long n = BIO_get_mem_data(bio, &data);
  char *out = malloc((size_t)n + 1);
  memcpy(out, data, (size_t)n);
  out[n] = 0;
  BIO_free(bio);
  return out;
}

static pki make_pki(void) {
  pki p;
  p.ca_key = gen_key();
  static int ca_seq = 0;
  char cn[64];
  snprintf(cn, sizeof cn, "PocketJS Test CA %d", ca_seq++);
  p.ca_cert = make_cert(p.ca_key, p.ca_key, NULL, cn, NULL, -1, 3650, true);
  p.ca_pem = cert_pem(p.ca_cert);
  return p;
}

/* --- HTTPS/WSS peer ----------------------------------------------------- */

typedef enum peer_kind { PEER_HTTP, PEER_WS } peer_kind;

typedef struct tls_peer {
  int listen_fd;
  uint16_t port;
  SSL_CTX *ctx;
  peer_kind kind;
  pthread_t thread;
  volatile int stop;
} tls_peer;

static SSL_CTX *server_ctx(EVP_PKEY *key, X509 *cert, X509 *ca) {
  SSL_CTX *ctx = SSL_CTX_new(TLS_server_method());
  SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION);
  SSL_CTX_use_certificate(ctx, cert);
  if (ca) SSL_CTX_add_extra_chain_cert(ctx, X509_dup(ca));
  SSL_CTX_use_PrivateKey(ctx, key);
  return ctx;
}

static void ws_accept_key(const char *key, char *out) {
  char concat[128];
  snprintf(concat, sizeof concat, "%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11", key);
  unsigned char digest[SHA_DIGEST_LENGTH];
  SHA1((const unsigned char *)concat, strlen(concat), digest);
  EVP_EncodeBlock((unsigned char *)out, digest, SHA_DIGEST_LENGTH);
}

static void *peer_thread(void *arg) {
  tls_peer *p = arg;
  while (!p->stop) {
    struct sockaddr_in a;
    socklen_t al = sizeof a;
    int fd = accept(p->listen_fd, (struct sockaddr *)&a, &al);
    if (fd < 0) {
      if (p->stop) break;
      continue;
    }
    SSL *ssl = SSL_new(p->ctx);
    SSL_set_fd(ssl, fd);
    if (SSL_accept(ssl) != 1) {
      SSL_free(ssl);
      close(fd);
      continue;
    }
    char head[2048] = {0};
    size_t len = 0;
    while (len + 1 < sizeof head) {
      int n = SSL_read(ssl, head + len, 1);
      if (n <= 0) break;
      len += (size_t)n;
      if (len >= 4 && memcmp(head + len - 4, "\r\n\r\n", 4) == 0) break;
    }
    if (p->kind == PEER_HTTP) {
      const char *r = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 9\r\n\r\nsecure ok";
      SSL_write(ssl, r, (int)strlen(r));
    } else {
      const char *keyh = strcasestr(head, "sec-websocket-key:");
      char key[64] = {0};
      if (keyh) sscanf(keyh + 18, " %63s", key);
      char accept_key[64];
      ws_accept_key(key, accept_key);
      char resp[256];
      int n = snprintf(resp, sizeof resp,
                       "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n",
                       accept_key);
      SSL_write(ssl, resp, n);
      /* Echo one masked client frame back unmasked. */
      unsigned char h[2];
      if (SSL_read(ssl, h, 2) == 2 && (h[1] & 0x80)) {
        size_t plen = h[1] & 0x7f;
        unsigned char mask[4], payload[256];
        SSL_read(ssl, mask, 4);
        if (plen <= sizeof payload && SSL_read(ssl, payload, (int)plen) == (int)plen) {
          for (size_t i = 0; i < plen; i++) payload[i] ^= mask[i & 3];
          unsigned char out[260];
          out[0] = 0x81;
          out[1] = (unsigned char)plen;
          memcpy(out + 2, payload, plen);
          SSL_write(ssl, out, (int)(plen + 2));
        }
      }
      usleep(50000);
    }
    SSL_shutdown(ssl);
    SSL_free(ssl);
    close(fd);
  }
  return NULL;
}

static tls_peer *peer_start(SSL_CTX *ctx, peer_kind kind) {
  tls_peer *p = calloc(1, sizeof *p);
  p->ctx = ctx;
  p->kind = kind;
  p->listen_fd = socket(AF_INET, SOCK_STREAM, 0);
  int one = 1;
  setsockopt(p->listen_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in a = {.sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
  bind(p->listen_fd, (struct sockaddr *)&a, sizeof a);
  listen(p->listen_fd, 8);
  socklen_t al = sizeof a;
  getsockname(p->listen_fd, (struct sockaddr *)&a, &al);
  p->port = ntohs(a.sin_port);
  pthread_create(&p->thread, NULL, peer_thread, p);
  return p;
}

static void peer_stop(tls_peer *p) {
  p->stop = 1;
  shutdown(p->listen_fd, SHUT_RDWR);
  close(p->listen_fd);
  pthread_join(p->thread, NULL);
  SSL_CTX_free(p->ctx);
  free(p);
}

/* --- runtime harness ---------------------------------------------------- */

typedef struct harness {
  pnet_runtime *rt;
  pnet_posix_driver *driver;
  pnet_openssl_tls *tls;
  pthread_mutex_t lock;
  pthread_t thread;
  volatile int stop;
} harness;

static void *net_thread(void *arg) {
  harness *h = arg;
  while (!h->stop) {
    pthread_mutex_lock(&h->lock);
    pnet_posix_driver_dispatch(h->driver, h->rt);
    pnet_runtime_service(h->rt);
    uint64_t deadline = pnet_runtime_next_deadline_ms(h->rt);
    bool more = pnet_runtime_has_pending_output(h->rt);
    pthread_mutex_unlock(&h->lock);
    int timeout = 50;
    if (deadline) {
      uint64_t now = now_ms(NULL);
      timeout = deadline > now ? (int)(deadline - now) : 0;
      if (timeout > 50) timeout = 50;
    }
    if (more) timeout = 0;
    pnet_posix_driver_wait(h->driver, timeout);
  }
  return NULL;
}

static void harness_start(harness *h, const char *policy, const char *ca_pem) {
  memset(h, 0, sizeof *h);
  pnet_platform plat = {NULL, now_ms, plat_alloc, plat_free, plat_random, plat_log, wall_clock_trusted};
  pnet_runtime_config cfg;
  pnet_runtime_config_defaults(&cfg);
  cfg.io_chunk_bytes = 1024;
  h->driver = pnet_posix_driver_create(32);
  pnet_openssl_tls_config tcfg = {.ca_pem = ca_pem, .min_version = 0};
  h->tls = pnet_openssl_tls_create(pnet_posix_driver_ops(), h->driver, &tcfg);
  h->rt = pnet_runtime_create_tls(&plat, pnet_posix_driver_ops(), h->driver, pnet_openssl_tls_ops(),
                                  pnet_openssl_tls_ctx(h->tls), &cfg, policy);
  pthread_mutex_init(&h->lock, NULL);
  pthread_create(&h->thread, NULL, net_thread, h);
}

static void harness_stop(harness *h) {
  h->stop = 1;
  pnet_posix_driver_wake(h->driver);
  pthread_join(h->thread, NULL);
  pnet_runtime_destroy(h->rt);
  pnet_openssl_tls_destroy(h->tls);
  pnet_posix_driver_destroy(h->driver);
  pthread_mutex_destroy(&h->lock);
}

typedef const char *(*poll_fn)(pnet_runtime *, size_t *);

static char *tick(harness *h, poll_fn poll) {
  pthread_mutex_lock(&h->lock);
  pnet_runtime_begin_tick(h->rt);
  size_t len = 0;
  const char *batch = poll(h->rt, &len);
  char *copy = batch ? strdup(batch) : NULL;
  pthread_mutex_unlock(&h->lock);
  pnet_posix_driver_wake(h->driver);
  return copy;
}

static bool wait_for(harness *h, poll_fn poll, const char *needle, int timeout_ms, char *log, size_t cap) {
  uint64_t end = now_ms(NULL) + (uint64_t)timeout_ms;
  size_t used = strlen(log);
  while (now_ms(NULL) < end) {
    char *batch = tick(h, poll);
    if (batch) {
      size_t n = strlen(batch);
      if (used + n + 2 < cap) {
        memcpy(log + used, batch, n);
        used += n;
        log[used++] = '\n';
        log[used] = 0;
      }
      bool hit = strstr(batch, needle) != NULL;
      free(batch);
      if (hit) return true;
    }
    usleep(3000);
  }
  return false;
}

static int https_get(harness *h, uint16_t port, const char *extra) {
  char meta[512];
  snprintf(meta, sizeof meta, "{\"url\":\"https://127.0.0.1:%u/x\",\"method\":\"GET\",\"headers\":{}%s}", port,
           extra ? extra : "");
  pthread_mutex_lock(&h->lock);
  int handle = pnet_http_start(h->rt, meta, NULL, 0);
  if (handle < 0) fprintf(stderr, "https start refused: %s\n", pnet_http_last_error(h->rt));
  pthread_mutex_unlock(&h->lock);
  pnet_posix_driver_wake(h->driver);
  return handle;
}

int main(void) {
  srand(4321);
  SSL_library_init();
  pki p = make_pki();

  EVP_PKEY *leaf_key = gen_key();
  X509 *valid = make_cert(leaf_key, p.ca_key, p.ca_cert, "127.0.0.1", "IP:127.0.0.1,DNS:localhost", -1, 365, false);
  X509 *expired = make_cert(leaf_key, p.ca_key, p.ca_cert, "127.0.0.1", "IP:127.0.0.1", -10, -1, false);
  X509 *wronghost = make_cert(leaf_key, p.ca_key, p.ca_cert, "other.test", "DNS:other.test", -1, 365, false);
  /* A leaf signed by a CA the provider does not trust. */
  pki rogue = make_pki();
  X509 *unknown = make_cert(leaf_key, rogue.ca_key, rogue.ca_cert, "127.0.0.1", "IP:127.0.0.1", -1, 365, false);

  tls_peer *valid_peer = peer_start(server_ctx(leaf_key, valid, p.ca_cert), PEER_HTTP);
  tls_peer *expired_peer = peer_start(server_ctx(leaf_key, expired, p.ca_cert), PEER_HTTP);
  tls_peer *wrong_peer = peer_start(server_ctx(leaf_key, wronghost, p.ca_cert), PEER_HTTP);
  tls_peer *unknown_peer = peer_start(server_ctx(leaf_key, unknown, rogue.ca_cert), PEER_HTTP);
  tls_peer *wss_peer = peer_start(server_ctx(leaf_key, valid, p.ca_cert), PEER_WS);

  char policy[512];
  snprintf(policy, sizeof policy,
           "{\"connect\":[{\"protocol\":\"https\",\"host\":\"127.0.0.1\",\"port\":{\"min\":1,\"max\":65535}},"
           "{\"protocol\":\"wss\",\"host\":\"127.0.0.1\",\"port\":{\"min\":1,\"max\":65535}},"
           "{\"protocol\":\"http\",\"host\":\"127.0.0.1\",\"port\":{\"min\":1,\"max\":65535}}],"
           "\"insecureTransport\":true,\"localNetwork\":true}");
  harness h;
  harness_start(&h, policy, p.ca_pem);
  CHECK(h.rt != NULL);
  char log[8192];

  /* limits advertise tls now */
  pthread_mutex_lock(&h.lock);
  CHECK(strstr(pnet_http_limits(h.rt), "\"features\":[\"tls\"]") != NULL);
  pthread_mutex_unlock(&h.lock);

  /* 1. valid chain + hostname (IP-ID) → 200 over TLS. */
  log[0] = 0;
  int handle = https_get(&h, valid_peer->port, NULL);
  CHECK(handle > 0);
  CHECK(wait_for(&h, pnet_http_poll, "\"status\":200", 4000, log, sizeof log));
  {
    char body[64];
    size_t total = 0;
    uint64_t end = now_ms(NULL) + 2000;
    bool done = false;
    while (now_ms(NULL) < end && !done) {
      char *b = tick(&h, pnet_http_poll);
      if (b) { if (strstr(b, "\"t\":\"end\"")) done = true; free(b); }
      pthread_mutex_lock(&h.lock);
      int n = pnet_http_read_into(h.rt, handle, (uint8_t *)body + total, sizeof body - total);
      pthread_mutex_unlock(&h.lock);
      if (n > 0) total += (size_t)n;
      usleep(2000);
    }
    CHECK(total == 9 && memcmp(body, "secure ok", 9) == 0);
  }

  /* 2. unknown CA → tls_certificate_invalid. */
  log[0] = 0;
  https_get(&h, unknown_peer->port, NULL);
  CHECK(wait_for(&h, pnet_http_poll, "\"code\":\"tls_certificate_invalid\"", 4000, log, sizeof log));

  /* 3. expired cert → tls_certificate_invalid. */
  log[0] = 0;
  https_get(&h, expired_peer->port, NULL);
  CHECK(wait_for(&h, pnet_http_poll, "\"code\":\"tls_certificate_invalid\"", 4000, log, sizeof log));

  /* 4. hostname mismatch → tls_hostname_mismatch. */
  log[0] = 0;
  https_get(&h, wrong_peer->port, NULL);
  CHECK(wait_for(&h, pnet_http_poll, "\"code\":\"tls_hostname_mismatch\"", 4000, log, sizeof log));

  /* 5. no plaintext fallback: a TLS failure never retries as http. The
   *    unknown-CA peer only speaks TLS; the request ended in a tls_* error,
   *    never a plain 200 — already asserted in case 2. Re-check the handle
   *    count is clean. */
  pthread_mutex_lock(&h.lock);
  CHECK(!pnet_runtime_has_live_handles(h.rt));
  pthread_mutex_unlock(&h.lock);

  /* 6. WSS: handshake over TLS, echo, clean close. */
  {
    char meta[256];
    snprintf(meta, sizeof meta, "{\"url\":\"wss://127.0.0.1:%u/echo\"}", wss_peer->port);
    pthread_mutex_lock(&h.lock);
    int ws = pnet_ws_connect(h.rt, meta);
    pthread_mutex_unlock(&h.lock);
    pnet_posix_driver_wake(h.driver);
    CHECK(ws > 0);
    log[0] = 0;
    CHECK(wait_for(&h, pnet_ws_poll, "\"t\":\"open\"", 4000, log, sizeof log));
    pthread_mutex_lock(&h.lock);
    CHECK(pnet_ws_send(h.rt, ws, 1, (const uint8_t *)"tls-ws", 6) == 0);
    pthread_mutex_unlock(&h.lock);
    pnet_posix_driver_wake(h.driver);
    log[0] = 0;
    CHECK(wait_for(&h, pnet_ws_poll, "\"text\":\"tls-ws\"", 4000, log, sizeof log));
    pthread_mutex_lock(&h.lock);
    pnet_ws_close(h.rt, ws, 1000, NULL, 0);
    pthread_mutex_unlock(&h.lock);
    log[0] = 0;
    CHECK(wait_for(&h, pnet_ws_poll, "\"t\":\"close\"", 4000, log, sizeof log));
  }

  harness_stop(&h);

  /* 7. Untrusted wall clock: fail-closed before any I/O, no server touched. */
  g_clock_trusted = false;
  harness h2;
  harness_start(&h2, policy, p.ca_pem);
  log[0] = 0;
  https_get(&h2, valid_peer->port, NULL);
  CHECK(wait_for(&h2, pnet_http_poll, "\"code\":\"tls_clock_untrusted\"", 3000, log, sizeof log));
  harness_stop(&h2);
  g_clock_trusted = true;

  /* 8. development-insecure still refused without the triple opt-in. */
  harness h3;
  harness_start(&h3, policy, p.ca_pem);
  log[0] = 0;
  https_get(&h3, unknown_peer->port, ",\"tls\":{\"verification\":\"development-insecure\"}");
  {
    pthread_mutex_lock(&h3.lock);
    /* The runtime was not created as a development build, so start() refuses
     * synchronously. */
    char meta[256];
    snprintf(meta, sizeof meta, "{\"url\":\"https://127.0.0.1:%u/x\",\"method\":\"GET\",\"headers\":{},\"tls\":{\"verification\":\"development-insecure\"}}", unknown_peer->port);
    int rc = pnet_http_start(h3.rt, meta, NULL, 0);
    CHECK(rc == -1 && strstr(pnet_http_last_error(h3.rt), "unsupported") != NULL);
    pthread_mutex_unlock(&h3.lock);
  }
  harness_stop(&h3);

  peer_stop(valid_peer);
  peer_stop(expired_peer);
  peer_stop(wrong_peer);
  peer_stop(unknown_peer);
  peer_stop(wss_peer);
  X509_free(valid);
  X509_free(expired);
  X509_free(wronghost);
  X509_free(unknown);
  EVP_PKEY_free(leaf_key);
  EVP_PKEY_free(p.ca_key);
  X509_free(p.ca_cert);
  free(p.ca_pem);
  EVP_PKEY_free(rogue.ca_key);
  X509_free(rogue.ca_cert);
  free(rogue.ca_pem);

  printf("tls: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
