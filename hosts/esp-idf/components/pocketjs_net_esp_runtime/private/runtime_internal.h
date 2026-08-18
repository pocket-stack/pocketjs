// SPDX-License-Identifier: MIT

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "pocketjs/net/esp_runtime.h"
#include "pocketjs/net/esp_transport.h"
#include "quickjs.h"

#define POCKETJS_NET_ESP_RUNTIME_MAGIC UINT64_C(0x504a534e45545254)
#define POCKETJS_NET_ESP_RUNTIME_HTTP_RESOURCE_ID 1U
#define POCKETJS_NET_ESP_RUNTIME_HTTP_RESOURCE_GENERATION 1U

#define POCKETJS_NET_ESP_RUNTIME_POISON_QUICKJS (UINT32_C(1) << 0)
#define POCKETJS_NET_ESP_RUNTIME_POISON_CORE (UINT32_C(1) << 1)
#define POCKETJS_NET_ESP_RUNTIME_POISON_LEASE (UINT32_C(1) << 2)
#define POCKETJS_NET_ESP_RUNTIME_POISON_SEQUENCE (UINT32_C(1) << 3)
#define POCKETJS_NET_ESP_RUNTIME_POISON_SHUTDOWN (UINT32_C(1) << 4)

typedef enum {
  POCKETJS_NET_ESP_RUNTIME_LEASE_NONE = 0,
  POCKETJS_NET_ESP_RUNTIME_LEASE_QUEUED,
  POCKETJS_NET_ESP_RUNTIME_LEASE_TAKEN,
  POCKETJS_NET_ESP_RUNTIME_LEASE_RELEASED,
} pocketjs_net_esp_runtime_lease_state_t;

typedef struct pocketjs_net_esp_runtime_binding_state {
  pocketjs_net_esp_runtime_t *runtime;
  uint32_t references;
} pocketjs_net_esp_runtime_binding_state_t;

typedef struct {
  bool initialized;
  bool active;
  bool headers_delivered;
  bool response_body_published;
  bool upload_credit_active;
  pocketjs_network_v1_handle_t operation;
  pocketjs_network_v1_handle_t request_body;
  pocketjs_network_v1_handle_t response_body;
  uint32_t last_operation_generation;
  uint32_t last_response_body_generation;
  uint64_t core_operation_token;
  uint64_t upload_body_generation;
  uint64_t upload_pull_generation;
  size_t upload_maximum_bytes;
  uint8_t request_method[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_METHOD_BYTES];
  size_t request_method_length;

  pocketjs_net_esp_transport_t *transport;
  bool transport_detached_awaiting_confirm;
  pocketjs_net_http_client_core_storage_t core_storage;
  pocketjs_net_http_client_core_t *core;

  bool event_pending;
  pocketjs_net_http_client_event_t event;
  pocketjs_net_esp_runtime_lease_state_t lease_state;
  bool lease_descriptor_delivered;
  pocketjs_network_v1_handle_t lease;
  uint32_t last_lease_generation;
  uint32_t lease_byte_length;
  pocketjs_net_http_client_body_lease_t core_lease;
} pocketjs_net_esp_runtime_slot_t;

typedef struct {
  uint8_t url[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_URL_BYTES];
  size_t url_length;
  uint8_t method[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_METHOD_BYTES];
  size_t method_length;
  uint8_t header_bytes[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REQUEST_HEADER_BYTES];
  size_t header_bytes_used;
  pocketjs_net_http_client_header_t
      headers[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REQUEST_HEADERS];
  size_t header_count;
  bool has_body;
  bool tls_present;
  bool tls_requested;
  uint8_t tls_server_name[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_HOST_BYTES];
  size_t tls_server_name_length;
  uint8_t tls_credential[128U];
  size_t tls_credential_length;
  pocketjs_net_http_client_tls_policy_t tls_policy;
  bool borrowed_input_present;
  bool has_timeout_overrides;
  bool has_limit_overrides;
  pocketjs_network_v1_http_redirect_mode_t redirect_mode;
  uint16_t max_redirects;
  bool ref;
} pocketjs_net_esp_runtime_http_command_t;

typedef struct {
  pocketjs_network_v1_error_category_t category;
  pocketjs_network_v1_error_code_t code;
  const char *operation;
  bool temporary;
  int32_t cause_code;
  bool has_cause_code;
} pocketjs_net_esp_runtime_error_t;

struct pocketjs_net_esp_runtime {
  uint64_t magic;
  TaskHandle_t owner_task;
  pocketjs_esp_guest_t *guest;
  JSContext *context;
  pocketjs_net_esp_runtime_phase_t phase;
  uint32_t runtime_generation;
  uint8_t plan_hash[POCKETJS_NETWORK_V1_PLAN_HASH_BYTES];
  pocketjs_network_v1_feature_id_t
      feature_ids[POCKETJS_NET_ESP_RUNTIME_MAX_FEATURES];
  uint16_t feature_count;
  uint16_t max_operations;
  pocketjs_net_esp_runtime_limits_t limits;
  uint64_t connect_timeout_us;
  uint64_t headers_timeout_us;
  uint64_t idle_timeout_us;
  uint64_t total_timeout_us;
  bool tls_enabled;
  pocketjs_net_esp_tls_trust_source_t tls_trust_source;
  uint8_t pinned_ca[POCKETJS_NET_ESP_TRANSPORT_MAX_PINNED_CA_PEM_BYTES + 1U];
  size_t pinned_ca_bytes;
  pocketjs_net_esp_wall_clock_trusted_fn wall_clock_trusted;
  void *wall_clock_context;
  pocketjs_net_esp_runtime_wake_fn wake;
  void *wake_context;
  pocketjs_net_esp_runtime_permission_fn allow_endpoint;
  void *permission_context;

  JSValue binding;
  JSValue dispatcher;
  pocketjs_net_esp_runtime_binding_state_t *binding_state;
  bool dispatcher_registered;
  bool binding_call_active;
  bool service_call_active;
  bool dispatcher_call_active;
  bool permission_call_active;
  bool shutdown_dispatch_drained;
  uint32_t turn_events_remaining;
  uint32_t turn_payload_remaining;
  uint32_t turn_events_observed;
  uint32_t turn_payload_observed;
  uint64_t turn_last_sequence_observed;
  uint16_t turn_last_poll_status;
  uint64_t command_sequence;
  uint64_t completion_sequence;
  uint64_t service_turn;
  size_t pump_cursor;
  size_t completion_cursor;
  uint32_t poison_flags;

  uint64_t requests_started;
  uint64_t completions_delivered;
  uint64_t leases_taken;
  uint64_t leases_released;
  uint64_t leases_cleaned_up;
  uint64_t permission_checks;

  pocketjs_net_esp_runtime_http_command_t command_scratch;
  uint16_t
      latin1_scratch[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_RESPONSE_HEADER_BYTES];
  /* Sized to max_operations by create(); capacity never changes afterward. */
  pocketjs_net_esp_runtime_slot_t slots[];
};

bool pocketjs_net_esp_runtime_is_owner(
    const pocketjs_net_esp_runtime_t *runtime);
void pocketjs_net_esp_runtime_poison(pocketjs_net_esp_runtime_t *runtime,
                                     uint32_t flag);
void pocketjs_net_esp_runtime_signal(pocketjs_net_esp_runtime_t *runtime);

bool pocketjs_net_esp_runtime_validate_identity(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity,
    bool consume_sequence, pocketjs_net_esp_runtime_error_t *out_error);

bool pocketjs_net_esp_runtime_start_http(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity,
    const pocketjs_net_esp_runtime_http_command_t *command,
    pocketjs_net_esp_runtime_error_t *out_error);

bool pocketjs_net_esp_runtime_cancel(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity,
    pocketjs_net_esp_runtime_error_t *out_error);

bool pocketjs_net_esp_runtime_grant_body_credit(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity,
    uint32_t maximum_bytes, pocketjs_net_esp_runtime_error_t *out_error);

bool pocketjs_net_esp_runtime_submit_body_chunk(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity,
    const uint8_t *bytes, size_t length,
    pocketjs_net_esp_runtime_error_t *out_error);

bool pocketjs_net_esp_runtime_submit_body_end(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity,
    pocketjs_net_esp_runtime_error_t *out_error);

bool pocketjs_net_esp_runtime_submit_body_error(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity, int32_t cause_code,
    pocketjs_net_esp_runtime_error_t *out_error);

bool pocketjs_net_esp_runtime_cancel_body(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity,
    pocketjs_net_esp_runtime_error_t *out_error);

bool pocketjs_net_esp_runtime_peek_event(
    pocketjs_net_esp_runtime_t *runtime,
    pocketjs_net_esp_runtime_slot_t **out_slot);

/* -1 is Core poison/status failure, 0 is drained, and 1 is ready. Never takes.
 */
int pocketjs_net_esp_runtime_completion_readiness(
    pocketjs_net_esp_runtime_t *runtime);

bool pocketjs_net_esp_runtime_retire_nonlease_event(
    pocketjs_net_esp_runtime_t *runtime, pocketjs_net_esp_runtime_slot_t *slot);

bool pocketjs_net_esp_runtime_lease_take(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity,
    pocketjs_network_v1_handle_t lease, uint32_t byte_length,
    uint32_t *out_byte_length, pocketjs_net_esp_runtime_error_t *out_error);

bool pocketjs_net_esp_runtime_lease_read(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity,
    pocketjs_network_v1_handle_t lease, uint32_t offset, uint32_t maximum_bytes,
    uint8_t *destination, size_t destination_length, uint32_t *out_copied,
    pocketjs_net_esp_runtime_error_t *out_error);

bool pocketjs_net_esp_runtime_lease_release(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity,
    pocketjs_network_v1_handle_t lease,
    pocketjs_net_esp_runtime_error_t *out_error);

esp_err_t
pocketjs_net_esp_runtime_create_binding(pocketjs_net_esp_runtime_t *runtime);
void pocketjs_net_esp_runtime_revoke_binding(
    pocketjs_net_esp_runtime_t *runtime);

esp_err_t pocketjs_net_esp_runtime_call_dispatcher(
    pocketjs_net_esp_runtime_t *runtime,
    pocketjs_network_v1_service_turn_kind_t kind, uint32_t max_events,
    uint32_t max_payload_bytes,
    pocketjs_net_esp_runtime_service_result_t *out_result);
