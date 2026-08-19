/* OpenSSL TlsProvider (see pnet_openssl_tls.h). */
#include "pnet_openssl_tls.h"

#include <stdlib.h>
#include <string.h>

#include <openssl/err.h>
#include <openssl/ssl.h>
#include <openssl/x509v3.h>

#include "pocketjs/net/spec.h"

#define MAX_SESSIONS 16

typedef struct session {
  pnet_sock s;
  SSL *ssl;
  bool in_use;
} session;

struct pnet_openssl_tls {
  const pnet_driver_ops *driver;
  void *driver_ctx;
  SSL_CTX *ctx;
  session sessions[MAX_SESSIONS];
};

static session *session_for(pnet_openssl_tls *tls, pnet_sock s) {
  for (int i = 0; i < MAX_SESSIONS; i++)
    if (tls->sessions[i].in_use && tls->sessions[i].s == s) return &tls->sessions[i];
  return NULL;
}

static session *session_alloc(pnet_openssl_tls *tls, pnet_sock s) {
  for (int i = 0; i < MAX_SESSIONS; i++) {
    if (!tls->sessions[i].in_use) {
      tls->sessions[i].in_use = true;
      tls->sessions[i].s = s;
      tls->sessions[i].ssl = NULL;
      return &tls->sessions[i];
    }
  }
  return NULL;
}

pnet_openssl_tls *pnet_openssl_tls_create(const pnet_driver_ops *driver, void *driver_ctx,
                                          const pnet_openssl_tls_config *config) {
  if (!driver || !driver->native_handle) return NULL;
  pnet_openssl_tls *tls = calloc(1, sizeof *tls);
  if (!tls) return NULL;
  tls->driver = driver;
  tls->driver_ctx = driver_ctx;
  tls->ctx = SSL_CTX_new(TLS_client_method());
  if (!tls->ctx) {
    free(tls);
    return NULL;
  }
  int min = config && config->min_version ? config->min_version : TLS1_2_VERSION;
  SSL_CTX_set_min_proto_version(tls->ctx, min);
  SSL_CTX_set_options(tls->ctx, SSL_OP_NO_RENEGOTIATION | SSL_OP_NO_TICKET);
  SSL_CTX_set_mode(tls->ctx, SSL_MODE_AUTO_RETRY | SSL_MODE_ENABLE_PARTIAL_WRITE);
  SSL_CTX_set_verify(tls->ctx, SSL_VERIFY_PEER, NULL);
  if (config && config->ca_pem) {
    X509_STORE *store = SSL_CTX_get_cert_store(tls->ctx);
    BIO *bio = BIO_new_mem_buf(config->ca_pem, -1);
    X509 *cert;
    while (bio && (cert = PEM_read_bio_X509(bio, NULL, NULL, NULL)) != NULL) {
      X509_STORE_add_cert(store, cert);
      X509_free(cert);
    }
    if (bio) BIO_free(bio);
  } else {
    SSL_CTX_set_default_verify_paths(tls->ctx);
  }
  return tls;
}

void pnet_openssl_tls_destroy(pnet_openssl_tls *tls) {
  if (!tls) return;
  for (int i = 0; i < MAX_SESSIONS; i++) {
    if (tls->sessions[i].in_use && tls->sessions[i].ssl) SSL_free(tls->sessions[i].ssl);
  }
  if (tls->ctx) SSL_CTX_free(tls->ctx);
  free(tls);
}

void *pnet_openssl_tls_ctx(pnet_openssl_tls *tls) {
  return tls;
}

static int op_start(void *ctx, pnet_sock s, const pnet_tls_policy *policy) {
  pnet_openssl_tls *tls = ctx;
  int fd = tls->driver->native_handle(tls->driver_ctx, s);
  if (fd < 0) return PNET_IO_ERROR;
  session *sess = session_alloc(tls, s);
  if (!sess) return PNET_IO_NOMEM;
  sess->ssl = SSL_new(tls->ctx);
  if (!sess->ssl) {
    sess->in_use = false;
    return PNET_IO_NOMEM;
  }
  SSL_set_fd(sess->ssl, fd);
  SSL_set_connect_state(sess->ssl);
  if (policy->server_name && *policy->server_name) {
    /* SNI + hostname verification against the authorized name. IP literals
     * are set as IP-ID, everything else as DNS-ID. */
    SSL_set_tlsext_host_name(sess->ssl, policy->server_name);
    X509_VERIFY_PARAM *param = SSL_get0_param(sess->ssl);
    X509_VERIFY_PARAM_set_hostflags(param, X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS);
    if (X509_VERIFY_PARAM_set1_ip_asc(param, policy->server_name) != 1) {
      X509_VERIFY_PARAM_set1_host(param, policy->server_name, 0);
    }
  }
  if (!policy->verify) {
    SSL_set_verify(sess->ssl, SSL_VERIFY_NONE, NULL);
  }
  if (policy->alpn) {
    unsigned char protos[64];
    size_t plen = strlen(policy->alpn);
    if (plen < sizeof protos - 1) {
      protos[0] = (unsigned char)plen;
      memcpy(protos + 1, policy->alpn, plen);
      SSL_set_alpn_protos(sess->ssl, protos, (unsigned)(plen + 1));
    }
  }
  return 0;
}

static const char *map_verify_failure(long verify_result) {
  /* Any peer-certificate verification failure maps to one of two stable
   * codes: a name/identity mismatch, or an invalid certificate (chain,
   * validity, trust, signature). X509_V_OK means the failure was not a
   * verification problem — the caller reports tls_handshake_failed. */
  if (verify_result == X509_V_OK) return NULL;
  if (verify_result == X509_V_ERR_HOSTNAME_MISMATCH || verify_result == X509_V_ERR_IP_ADDRESS_MISMATCH ||
      verify_result == X509_V_ERR_EMAIL_MISMATCH) {
    return PNET_ERROR_TLS_HOSTNAME_MISMATCH;
  }
  return PNET_ERROR_TLS_CERTIFICATE_INVALID;
}

static int op_step(void *ctx, pnet_sock s, pnet_tls_failure *failure) {
  pnet_openssl_tls *tls = ctx;
  session *sess = session_for(tls, s);
  if (!sess || !sess->ssl) return -1;
  ERR_clear_error();
  int rc = SSL_do_handshake(sess->ssl);
  if (rc == 1) return 1;
  int err = SSL_get_error(sess->ssl, rc);
  if (err == SSL_ERROR_WANT_READ || err == SSL_ERROR_WANT_WRITE) return 0;
  /* Failure: classify. */
  long verify = SSL_get_verify_result(sess->ssl);
  const char *code = map_verify_failure(verify);
  if (!code) code = PNET_ERROR_TLS_HANDSHAKE_FAILED;
  failure->code = code;
  failure->cause = (int)ERR_peek_last_error();
  return -1;
}

static int map_io(session *sess, int rc) {
  int err = SSL_get_error(sess->ssl, rc);
  switch (err) {
    case SSL_ERROR_WANT_READ:
    case SSL_ERROR_WANT_WRITE:
      return PNET_IO_AGAIN;
    case SSL_ERROR_ZERO_RETURN:
      return PNET_IO_EOF;
    case SSL_ERROR_SYSCALL:
      return rc == 0 ? PNET_IO_EOF : PNET_IO_CLOSED;
    default:
      return PNET_IO_CLOSED;
  }
}

static int op_read(void *ctx, pnet_sock s, uint8_t *buf, size_t len) {
  pnet_openssl_tls *tls = ctx;
  session *sess = session_for(tls, s);
  if (!sess || !sess->ssl) return PNET_IO_ERROR;
  ERR_clear_error();
  int rc = SSL_read(sess->ssl, buf, (int)len);
  if (rc > 0) return rc;
  return map_io(sess, rc);
}

static int op_write(void *ctx, pnet_sock s, const uint8_t *buf, size_t len) {
  pnet_openssl_tls *tls = ctx;
  session *sess = session_for(tls, s);
  if (!sess || !sess->ssl) return PNET_IO_ERROR;
  ERR_clear_error();
  int rc = SSL_write(sess->ssl, buf, (int)len);
  if (rc > 0) return rc;
  int mapped = map_io(sess, rc);
  return mapped == PNET_IO_AGAIN ? PNET_IO_AGAIN : mapped;
}

static unsigned op_interest(void *ctx, pnet_sock s) {
  pnet_openssl_tls *tls = ctx;
  session *sess = session_for(tls, s);
  if (!sess || !sess->ssl) return PNET_INTEREST_READ;
  /* During the handshake OpenSSL tells us which direction it is blocked on
   * through the last want; default to read. */
  return SSL_want_write(sess->ssl) ? PNET_INTEREST_WRITE : PNET_INTEREST_READ;
}

static void op_close(void *ctx, pnet_sock s) {
  pnet_openssl_tls *tls = ctx;
  session *sess = session_for(tls, s);
  if (!sess) return;
  if (sess->ssl) {
    /* One non-blocking close_notify attempt; do not block on the peer. */
    SSL_shutdown(sess->ssl);
    SSL_free(sess->ssl);
    sess->ssl = NULL;
  }
  sess->in_use = false;
}

static const pnet_tls_ops OPS = {
    .start = op_start,
    .step = op_step,
    .read = op_read,
    .write = op_write,
    .interest = op_interest,
    .close = op_close,
};

const pnet_tls_ops *pnet_openssl_tls_ops(void) {
  return &OPS;
}
