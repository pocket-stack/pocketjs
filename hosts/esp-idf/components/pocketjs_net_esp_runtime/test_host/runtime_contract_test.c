// SPDX-License-Identifier: MIT

#include <assert.h>
#include <stdint.h>
#include <string.h>

#include "runtime_contract.h"

int main(void) {
  const pocketjs_network_v1_feature_id_t http[] = {
      POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT,
  };
  const pocketjs_network_v1_feature_id_t http_tls[] = {
      POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT,
      POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_TLS,
  };
  assert(pocketjs_net_esp_runtime_feature_projection_valid(http, 1U));
  assert(pocketjs_net_esp_runtime_feature_projection_valid(http_tls, 2U));
  assert(!pocketjs_net_esp_runtime_feature_projection_has_tls(http, 1U));
  assert(pocketjs_net_esp_runtime_feature_projection_has_tls(http_tls, 2U));
  assert(!pocketjs_net_esp_runtime_feature_projection_valid(NULL, 0U));

  uint64_t sequence = POCKETJS_NETWORK_V1_SEQUENCE_MAX - 1U;
  assert(pocketjs_net_esp_runtime_next_sequence(&sequence));
  assert(sequence == POCKETJS_NETWORK_V1_SEQUENCE_MAX);
  assert(!pocketjs_net_esp_runtime_next_sequence(&sequence));

  const pocketjs_network_v1_handle_t live = {.id = 2U, .generation = 9U};
  const pocketjs_network_v1_handle_t stale = {.id = 2U, .generation = 8U};
  const pocketjs_network_v1_handle_t partial = {.id = 2U, .generation = 0U};
  assert(pocketjs_net_esp_runtime_live_handle(live));
  assert(!pocketjs_net_esp_runtime_live_handle(partial));
  assert(pocketjs_net_esp_runtime_same_handle(live, live));
  assert(!pocketjs_net_esp_runtime_same_handle(live, stale));

  static const uint8_t post[] = "POST";
  static const uint8_t get[] = "GET";
  assert(pocketjs_net_esp_runtime_redirect_action(200U, get, 3U) ==
         POCKETJS_NET_ESP_REDIRECT_NOT_REDIRECT);
  assert(pocketjs_net_esp_runtime_redirect_action(301U, post, 4U) ==
         POCKETJS_NET_ESP_REDIRECT_REWRITE_GET);
  assert(pocketjs_net_esp_runtime_redirect_action(303U, get, 3U) ==
         POCKETJS_NET_ESP_REDIRECT_REWRITE_GET);
  assert(pocketjs_net_esp_runtime_redirect_action(307U, post, 4U) ==
         POCKETJS_NET_ESP_REDIRECT_PRESERVE_METHOD_BODY);
  assert(pocketjs_net_esp_runtime_redirect_action(308U, get, 3U) ==
         POCKETJS_NET_ESP_REDIRECT_PRESERVE_METHOD_BODY);

  assert(pocketjs_net_esp_runtime_sensitive_redirect_header(
      (const uint8_t *)"Authorization", strlen("Authorization")));
  assert(pocketjs_net_esp_runtime_sensitive_redirect_header(
      (const uint8_t *)"proxy-authorization", strlen("proxy-authorization")));
  assert(pocketjs_net_esp_runtime_sensitive_redirect_header(
      (const uint8_t *)"COOKIE", strlen("COOKIE")));
  assert(!pocketjs_net_esp_runtime_sensitive_redirect_header(
      (const uint8_t *)"content-type", strlen("content-type")));
  return 0;
}
