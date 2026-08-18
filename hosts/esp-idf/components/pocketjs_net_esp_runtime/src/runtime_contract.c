// SPDX-License-Identifier: MIT

#include "runtime_contract.h"

#include <string.h>

bool pocketjs_net_esp_runtime_feature_projection_valid(
    const pocketjs_network_v1_feature_id_t *feature_ids,
    uint16_t feature_count) {
  return feature_ids != NULL &&
         (feature_count == 1U ||
          (feature_count == 2U &&
           feature_ids[1] == POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_TLS)) &&
         feature_ids[0] == POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT;
}

bool pocketjs_net_esp_runtime_feature_projection_has_tls(
    const pocketjs_network_v1_feature_id_t *feature_ids,
    uint16_t feature_count) {
  return pocketjs_net_esp_runtime_feature_projection_valid(feature_ids,
                                                            feature_count) &&
         feature_count == 2U;
}

bool pocketjs_net_esp_runtime_next_sequence(uint64_t *sequence) {
  if (sequence == NULL || *sequence >= POCKETJS_NETWORK_V1_SEQUENCE_MAX) {
    return false;
  }
  ++*sequence;
  return true;
}

bool pocketjs_net_esp_runtime_live_handle(pocketjs_network_v1_handle_t handle) {
  return pocketjs_network_v1_handle_is_live(handle) != 0;
}

bool pocketjs_net_esp_runtime_same_handle(pocketjs_network_v1_handle_t left,
                                          pocketjs_network_v1_handle_t right) {
  return left.id == right.id && left.generation == right.generation;
}

static bool ascii_equal_case(const uint8_t *left, size_t left_length,
                             const char *right) {
  const size_t right_length = strlen(right);
  if (left == NULL || left_length != right_length) {
    return false;
  }
  for (size_t index = 0U; index < left_length; ++index) {
    uint8_t value = left[index];
    if (value >= 'A' && value <= 'Z') {
      value = (uint8_t)(value + ('a' - 'A'));
    }
    if (value != (uint8_t)right[index]) {
      return false;
    }
  }
  return true;
}

pocketjs_net_esp_redirect_action_t
pocketjs_net_esp_runtime_redirect_action(unsigned status, const uint8_t *method,
                                         size_t method_length) {
  if (status != 301U && status != 302U && status != 303U && status != 307U &&
      status != 308U) {
    return POCKETJS_NET_ESP_REDIRECT_NOT_REDIRECT;
  }
  if (status == 303U || ((status == 301U || status == 302U) &&
                         ascii_equal_case(method, method_length, "post"))) {
    return POCKETJS_NET_ESP_REDIRECT_REWRITE_GET;
  }
  return POCKETJS_NET_ESP_REDIRECT_PRESERVE_METHOD_BODY;
}

bool pocketjs_net_esp_runtime_sensitive_redirect_header(const uint8_t *name,
                                                        size_t name_length) {
  return ascii_equal_case(name, name_length, "authorization") ||
         ascii_equal_case(name, name_length, "proxy-authorization") ||
         ascii_equal_case(name, name_length, "cookie");
}
