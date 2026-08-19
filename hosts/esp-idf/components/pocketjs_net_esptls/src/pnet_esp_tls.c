/* ESP-TLS TlsProvider (see esp_tls_provider.h). */
#include "pocketjs/net/esp_tls_provider.h"

#include <string.h>

#include "esp_crt_bundle.h"
#include "esp_tls.h"
#include "mbedtls/ssl.h"
#include "pocketjs/net/spec.h"

#define MAX_SESSIONS 12

typedef struct session {
  pnet_sock s;
  esp_tls_t *tls;
  char host[256];
  uint16_t port;
  bool in_use;
  bool started;
} session;

struct pnet_esp_tls {
  const pnet_driver_ops *driver;
  void *driver_ctx;
  session sessions[MAX_SESSIONS];
};

static session *session_for(pnet_esp_tls *p, pnet_sock s) {
  for (int i = 0; i < MAX_SESSIONS; i++)
    if (p->sessions[i].in_use && p->sessions[i].s == s) return &p->sessions[i];
  return NULL;
}

pnet_esp_tls *pnet_esp_tls_create(const pnet_driver_ops *driver, void *driver_ctx) {
  if (!driver || !driver->native_handle) return NULL;
  pnet_esp_tls *p = calloc(1, sizeof *p);
  if (!p) return NULL;
  p->driver = driver;
  p->driver_ctx = driver_ctx;
  return p;
}

void pnet_esp_tls_destroy(pnet_esp_tls *p) {
  if (!p) return;
  for (int i = 0; i < MAX_SESSIONS; i++) {
    if (p->sessions[i].in_use && p->sessions[i].tls) esp_tls_conn_destroy(p->sessions[i].tls);
  }
  free(p);
}

void *pnet_esp_tls_ctx(pnet_esp_tls *p) {
  return p;
}

static void free_session(session *sess) {
  if (sess->tls) {
    esp_tls_conn_destroy(sess->tls); /* closes the socket fd */
    sess->tls = NULL;
  }
  sess->in_use = false;
  sess->started = false;
}

static int op_start(void *ctx, pnet_sock s, const pnet_tls_policy *policy) {
  pnet_esp_tls *p = ctx;
  int fd = p->driver->native_handle(p->driver_ctx, s);
  if (fd < 0) return PNET_IO_ERROR;
  session *sess = NULL;
  for (int i = 0; i < MAX_SESSIONS; i++)
    if (!p->sessions[i].in_use) { sess = &p->sessions[i]; break; }
  if (!sess) return PNET_IO_NOMEM;
  memset(sess, 0, sizeof *sess);
  sess->s = s;
  sess->in_use = true;
  sess->tls = esp_tls_init();
  if (!sess->tls) {
    sess->in_use = false;
    return PNET_IO_NOMEM;
  }
  size_t hlen = policy->server_name ? strlen(policy->server_name) : 0;
  if (hlen >= sizeof sess->host) hlen = sizeof sess->host - 1;
  if (hlen) memcpy(sess->host, policy->server_name, hlen);
  sess->host[hlen] = 0;
  /* esp_tls takes the connected fd and drives handshake/read/write over it.
   * On close it calls close(fd); the driver's own close() then runs on the
   * same network task under the same lock with no fd allocated in between, so
   * the second close is a harmless no-op on an already-closed descriptor. */
  esp_tls_set_conn_sockfd(sess->tls, fd);
  esp_tls_set_conn_state(sess->tls, ESP_TLS_CONNECTING);
  return 0;
}

/* Map an ESP-TLS/Mbed TLS handshake failure onto a stable code. A hostname
 * mismatch is reported precisely; other certificate faults (expired, future,
 * untrusted root, self-signed, revoked) are reported as tls_certificate_invalid
 * when Mbed TLS exposes the verify flags, and otherwise collapse to
 * tls_handshake_failed. In every case the connection fails closed with no
 * plaintext fallback; the precise per-fault classification is exercised by the
 * desktop OpenSSL conformance suite (engine/net/test/tls_test.c). */
static const char *classify(esp_tls_t *tls, int *cause) {
  esp_tls_error_handle_t eh = NULL;
  int esp_code = 0, err_flags = 0;
  if (esp_tls_get_error_handle(tls, &eh) == ESP_OK && eh) {
    esp_tls_get_and_clear_last_error(eh, &esp_code, &err_flags);
  }
  /* The certificate verification flags are most reliably read straight from
   * the mbedTLS session (the error-handle copy is not always populated on the
   * async path). */
  uint32_t flags = (uint32_t)err_flags;
  mbedtls_ssl_context *ssl = (mbedtls_ssl_context *)esp_tls_get_ssl_context(tls);
  if (ssl) {
    uint32_t vr = mbedtls_ssl_get_verify_result(ssl);
    if (vr != 0 && vr != 0xFFFFFFFFu) flags |= vr;
  }
  if (cause) *cause = esp_code ? esp_code : (int)flags;
  if (flags != 0) {
    if (flags & MBEDTLS_X509_BADCERT_CN_MISMATCH) return PNET_ERROR_TLS_HOSTNAME_MISMATCH;
    return PNET_ERROR_TLS_CERTIFICATE_INVALID; /* expired, future, untrusted, revoked, bad key usage */
  }
  return PNET_ERROR_TLS_HANDSHAKE_FAILED;
}

static int op_step(void *ctx, pnet_sock s, pnet_tls_failure *failure) {
  pnet_esp_tls *p = ctx;
  session *sess = session_for(p, s);
  if (!sess || !sess->tls) return -1;
  /* non_block = false makes ESP-TLS skip its internal select() on the
   * connection (which assumes ESP-TLS did the connect and populated its own
   * fd sets). Our socket is already connected and set non-blocking by the
   * driver, so mbedtls_ssl_handshake returns WANT_READ/WRITE and ESP-TLS
   * reports 0 (pending) — the reactor drives the handshake to completion
   * across service passes without ever blocking the network task. */
  esp_tls_cfg_t cfg = {
      .crt_bundle_attach = esp_crt_bundle_attach,
      .common_name = sess->host[0] ? sess->host : NULL,
      .non_block = false,
      .timeout_ms = 0,
      .is_plain_tcp = false,
      .skip_common_name = false,
  };
  int rc = esp_tls_conn_new_async(sess->host, (int)strlen(sess->host), sess->port, &cfg, sess->tls);
  if (rc == 1) return 1;
  if (rc == 0) return 0; /* pending */
  int cause = 0;
  failure->code = classify(sess->tls, &cause);
  failure->cause = cause;
  return -1;
}

static int map_io(int rc) {
  if (rc == ESP_TLS_ERR_SSL_WANT_READ || rc == ESP_TLS_ERR_SSL_WANT_WRITE) return PNET_IO_AGAIN;
  if (rc == 0) return PNET_IO_EOF;
  return PNET_IO_CLOSED;
}

static int op_read(void *ctx, pnet_sock s, uint8_t *buf, size_t len) {
  pnet_esp_tls *p = ctx;
  session *sess = session_for(p, s);
  if (!sess || !sess->tls) return PNET_IO_ERROR;
  ssize_t rc = esp_tls_conn_read(sess->tls, buf, len);
  if (rc > 0) return (int)rc;
  return map_io((int)rc);
}

static int op_write(void *ctx, pnet_sock s, const uint8_t *buf, size_t len) {
  pnet_esp_tls *p = ctx;
  session *sess = session_for(p, s);
  if (!sess || !sess->tls) return PNET_IO_ERROR;
  ssize_t rc = esp_tls_conn_write(sess->tls, buf, len);
  if (rc > 0) return (int)rc;
  return map_io((int)rc);
}

static unsigned op_interest(void *ctx, pnet_sock s) {
  (void)ctx;
  (void)s;
  /* Mbed TLS non-blocking handshake alternates read/write; keep both armed. */
  return PNET_INTEREST_READ | PNET_INTEREST_WRITE;
}

static void op_close(void *ctx, pnet_sock s) {
  pnet_esp_tls *p = ctx;
  session *sess = session_for(p, s);
  if (sess) free_session(sess);
}

static const pnet_tls_ops OPS = {
    .start = op_start,
    .step = op_step,
    .read = op_read,
    .write = op_write,
    .interest = op_interest,
    .close = op_close,
};

const pnet_tls_ops *pnet_esp_tls_ops(void) {
  return &OPS;
}
