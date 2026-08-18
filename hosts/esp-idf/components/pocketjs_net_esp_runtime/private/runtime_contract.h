// SPDX-License-Identifier: MIT

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "pocketjs_network_v1_abi.h"

typedef enum {
  POCKETJS_NET_ESP_REDIRECT_NOT_REDIRECT = 0,
  POCKETJS_NET_ESP_REDIRECT_REWRITE_GET,
  POCKETJS_NET_ESP_REDIRECT_PRESERVE_METHOD_BODY,
} pocketjs_net_esp_redirect_action_t;

bool pocketjs_net_esp_runtime_feature_projection_valid(
    const pocketjs_network_v1_feature_id_t *feature_ids,
    uint16_t feature_count);

bool pocketjs_net_esp_runtime_feature_projection_has_tls(
    const pocketjs_network_v1_feature_id_t *feature_ids,
    uint16_t feature_count);

bool pocketjs_net_esp_runtime_next_sequence(uint64_t *sequence);

bool pocketjs_net_esp_runtime_live_handle(pocketjs_network_v1_handle_t handle);

bool pocketjs_net_esp_runtime_same_handle(pocketjs_network_v1_handle_t left,
                                          pocketjs_network_v1_handle_t right);

pocketjs_net_esp_redirect_action_t
pocketjs_net_esp_runtime_redirect_action(unsigned status, const uint8_t *method,
                                         size_t method_length);

bool pocketjs_net_esp_runtime_sensitive_redirect_header(const uint8_t *name,
                                                        size_t name_length);
