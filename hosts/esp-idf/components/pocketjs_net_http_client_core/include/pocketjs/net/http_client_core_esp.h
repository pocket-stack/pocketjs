// SPDX-License-Identifier: MIT

#pragma once

#include "pocketjs/net/esp_transport.h"
#include "pocketjs/net/http_client_core.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Narrow adapter over the experimental ESP-IDF transport public API. */
const pocketjs_net_http_client_transport_ops_t *
pocketjs_net_http_client_core_esp_transport_ops(void);

#ifdef __cplusplus
}
#endif
