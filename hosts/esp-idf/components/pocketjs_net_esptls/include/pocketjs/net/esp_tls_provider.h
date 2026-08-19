/* PocketJS network core — ESP-TLS TlsProvider (ESP-IDF).
 *
 * A `pnet_tls_ops` over ESP-TLS + its default Mbed TLS backend, layered on the
 * lwIP sockets the driver already connected. Uses the ESP-IDF certificate
 * bundle for host trust, SNI = the authorized hostname, DNS-ID/IP-ID
 * hostname verification, TLS 1.2 minimum, non-blocking handshake. It maps
 * ESP-TLS/Mbed TLS failures onto the four stable tls_* codes. esp_tls drives
 * the handshake over the fd the driver already connected; on close esp_tls
 * closes the fd and the driver's own close is a harmless no-op.
 */
#ifndef POCKETJS_NET_ESP_TLS_PROVIDER_H
#define POCKETJS_NET_ESP_TLS_PROVIDER_H

#include "pocketjs/net/driver.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct pnet_esp_tls pnet_esp_tls;

/** Create the provider. `driver`/`driver_ctx` are the runtime's; the provider
 * calls `native_handle` to reach the lwIP fd. NULL on failure. */
pnet_esp_tls *pnet_esp_tls_create(const pnet_driver_ops *driver, void *driver_ctx);
void pnet_esp_tls_destroy(pnet_esp_tls *tls);
const pnet_tls_ops *pnet_esp_tls_ops(void);
void *pnet_esp_tls_ctx(pnet_esp_tls *tls);

#ifdef __cplusplus
}
#endif

#endif /* POCKETJS_NET_ESP_TLS_PROVIDER_H */
