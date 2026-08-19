/* PocketJS network core — OpenSSL TlsProvider (desktop conformance).
 *
 * One `pnet_tls_ops` over OpenSSL, layered on the driver's plain sockets via
 * `native_handle`. It owns a shared SSL_CTX (host trust or a pinned CA),
 * runs non-blocking client handshakes with SNI and DNS-ID/IP-ID hostname
 * verification, TLS 1.2 minimum, and maps failures onto the four stable
 * tls_* codes. It is the reference `NativeTlsProvider` for POSIX hosts and
 * the peer against which the portable cores are tested; ESP-IDF uses its own
 * ESP-TLS provider.
 */
#ifndef POCKETJS_NET_OPENSSL_TLS_H
#define POCKETJS_NET_OPENSSL_TLS_H

#include "pocketjs/net/driver.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct pnet_openssl_tls pnet_openssl_tls;

typedef struct pnet_openssl_tls_config {
  /** PEM CA bundle to trust; NULL uses the system default paths. */
  const char *ca_pem;
  /** Minimum protocol: 0x0303 = TLS 1.2 (default), 0x0304 = TLS 1.3. */
  int min_version;
} pnet_openssl_tls_config;

/** Create a provider. `driver`/`driver_ctx` are the same the runtime uses;
 * the provider calls `native_handle` to reach the fd. NULL on failure. */
pnet_openssl_tls *pnet_openssl_tls_create(const pnet_driver_ops *driver, void *driver_ctx,
                                          const pnet_openssl_tls_config *config);
void pnet_openssl_tls_destroy(pnet_openssl_tls *tls);
const pnet_tls_ops *pnet_openssl_tls_ops(void);
/** The ctx to pass as `tls_ctx` to `pnet_runtime_create_tls`. */
void *pnet_openssl_tls_ctx(pnet_openssl_tls *tls);

#ifdef __cplusplus
}
#endif

#endif /* POCKETJS_NET_OPENSSL_TLS_H */
