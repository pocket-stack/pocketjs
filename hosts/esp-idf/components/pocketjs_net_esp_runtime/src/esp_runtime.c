// SPDX-License-Identifier: MIT

#include "pocketjs/net/esp_runtime.h"

#include <stdlib.h>
#include <string.h>

#include "esp_timer.h"
#include "pocketjs/net/http_client_core_esp.h"
#include "runtime_contract.h"
#include "runtime_internal.h"

_Static_assert(POCKETJS_NET_ESP_RUNTIME_MAX_REDIRECTS ==
                   POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REDIRECTS,
               "runtime and HTTP Core redirect ceilings must match");

static const pocketjs_net_esp_runtime_descriptor_t RUNTIME_DESCRIPTOR = {
    .id = POCKETJS_NET_ESP_RUNTIME_ID,
    .implementation_version = POCKETJS_NET_ESP_RUNTIME_IMPLEMENTATION_VERSION,
    .experimental = true,
    .advertises_public_capability = false,
    .abi_major = POCKETJS_NETWORK_V1_ABI_MAJOR,
    .abi_minor = POCKETJS_NETWORK_V1_ABI_MINOR,
    .owner_only_quickjs = true,
    .worker_or_callback_calls_quickjs = false,
    .frozen_accessor_free_binding = true,
    .exact_plan_handshake = true,
    .endpoint_permission_rechecked = true,
    .fixed_operation_pool = true,
    .pocketjs_owned_native_buffer_floor_enforced = true,
    .connection_reuse = true,
    .bounded_connection_pool = true,
    .exact_lease_ownership = true,
    .explicit_three_phase_shutdown = true,
    .plaintext_http = true,
    .https_rejected_before_io = true,
    .https_explicit_opt_in = true,
    .exact_host_tls_profile = true,
    .distinct_tls_errors = true,
    .tls_close_notify = true,
    .tls_close_notify_uses_operation_deadline = true,
    .tls_close_notify_waits_for_peer = false,
    .tls_provider_id = POCKETJS_NET_ESP_TLS_PROVIDER_ID,
    .redirect_manual = true,
    .redirect_error = true,
    .redirect_follow = true,
    .redirect_replayable_stream_body = false,
    .guest_execution_guarded_dispatch = true,
    .hidden_retry = false,
    .hidden_auth = false,
    .hidden_cookie_store = false,
    .proxy = false,
    .content_decoding = false,
    .max_operations = POCKETJS_NET_ESP_RUNTIME_MAX_OPERATIONS,
    .max_cached_connections = POCKETJS_NET_ESP_RUNTIME_MAX_OPERATIONS,
    .max_redirects = POCKETJS_NET_ESP_RUNTIME_MAX_REDIRECTS,
    .operation_slot_bytes = sizeof(pocketjs_net_esp_runtime_slot_t),
    .validation_snapshot_bytes =
        POCKETJS_NET_ESP_TRANSPORT_MAX_PINNED_CA_PEM_BYTES + 1U,
};

static const pocketjs_network_v1_handle_t ABSENT_HANDLE = {0U, 0U};

static bool checked_size_add(size_t left, size_t right, size_t *out) {
  if (out == NULL || left > SIZE_MAX - right) {
    return false;
  }
  *out = left + right;
  return true;
}

static bool checked_size_multiply(size_t left, size_t right, size_t *out) {
  if (out == NULL || (right != 0U && left > SIZE_MAX / right)) {
    return false;
  }
  *out = left * right;
  return true;
}

bool pocketjs_net_esp_runtime_required_native_buffer_bytes(
    uint16_t max_operations, size_t *out_bytes) {
  if (out_bytes == NULL || max_operations == 0U ||
      max_operations > POCKETJS_NET_ESP_RUNTIME_MAX_OPERATIONS) {
    return false;
  }
  const pocketjs_net_esp_transport_descriptor_t *transport =
      pocketjs_net_esp_transport_descriptor();
  if (transport == NULL || transport->pocketjs_owned_instance_bytes == 0U) {
    return false;
  }
  size_t slots = 0U;
  size_t persistent_transports = 0U;
  size_t prefinal_transports = 0U;
  size_t base = 0U;
  if (!checked_size_multiply(sizeof(pocketjs_net_esp_runtime_slot_t),
                             max_operations, &slots) ||
      !checked_size_multiply(transport->pocketjs_owned_instance_bytes,
                             max_operations, &persistent_transports) ||
      !checked_size_multiply(transport->pocketjs_owned_instance_bytes,
                             max_operations - 1U, &prefinal_transports) ||
      !checked_size_add(sizeof(pocketjs_net_esp_runtime_t), slots, &base) ||
      !checked_size_add(base, sizeof(pocketjs_net_esp_runtime_binding_state_t),
                        &base)) {
    return false;
  }
  size_t validation_peak = 0U;
  if (!checked_size_add(prefinal_transports,
                        POCKETJS_NET_ESP_TRANSPORT_MAX_PINNED_CA_PEM_BYTES + 1U,
                        &validation_peak)) {
    return false;
  }
  const size_t dynamic_peak = persistent_transports > validation_peak
                                  ? persistent_transports
                                  : validation_peak;
  return checked_size_add(base, dynamic_peak, out_bytes);
}

static void set_error(pocketjs_net_esp_runtime_error_t *error,
                      pocketjs_network_v1_error_category_t category,
                      pocketjs_network_v1_error_code_t code,
                      const char *operation, bool temporary) {
  if (error == NULL) {
    return;
  }
  *error = (pocketjs_net_esp_runtime_error_t){
      .category = category,
      .code = code,
      .operation = operation,
      .temporary = temporary,
  };
}

static bool valid_limit(pocketjs_net_esp_runtime_limit_range_t limit,
                        bool allow_zero_minimum) {
  return limit.default_value != 0U && limit.hard != 0U &&
         (allow_zero_minimum || limit.minimum != 0U) &&
         limit.minimum <= limit.default_value &&
         limit.default_value <= limit.hard &&
         limit.hard <= POCKETJS_NET_ESP_RUNTIME_SEQUENCE_MAX;
}

static bool
valid_tls_config_shape(const pocketjs_net_esp_runtime_config_t *config,
                       bool tls_enabled) {
  if (!tls_enabled) {
    return config->tls_trust_source == POCKETJS_NET_ESP_TLS_TRUST_DISABLED &&
           config->host_pinned_ca_pem == NULL &&
           config->host_pinned_ca_pem_bytes == 0U &&
           config->wall_clock_trusted == NULL &&
           config->wall_clock_context == NULL;
  }
  if (config->wall_clock_trusted == NULL) {
    return false;
  }
  switch (config->tls_trust_source) {
  case POCKETJS_NET_ESP_TLS_TRUST_CERTIFICATE_BUNDLE:
    return config->host_pinned_ca_pem == NULL &&
           config->host_pinned_ca_pem_bytes == 0U;
  case POCKETJS_NET_ESP_TLS_TRUST_HOST_PINNED_CA:
    return config->host_pinned_ca_pem != NULL &&
           config->host_pinned_ca_pem_bytes != 0U &&
           config->host_pinned_ca_pem_bytes <=
               POCKETJS_NET_ESP_TRANSPORT_MAX_PINNED_CA_PEM_BYTES;
  default:
    return false;
  }
}

static bool
valid_provider_selection(const pocketjs_net_esp_runtime_config_t *config,
                         bool tls_enabled) {
  const pocketjs_net_esp_runtime_provider_selection_t *selection =
      &config->providers;
  if (selection->http_client_backend_id == NULL ||
      selection->net_driver_id == NULL ||
      strcmp(selection->http_client_backend_id,
             POCKETJS_NET_HTTP_CLIENT_CORE_ID) != 0 ||
      strcmp(selection->net_driver_id, POCKETJS_NET_ESP_TRANSPORT_ID) != 0) {
    return false;
  }
  if (tls_enabled) {
    return selection->http_client_tls_source ==
               POCKETJS_NET_ESP_RUNTIME_TLS_SELECTION_PROVIDER &&
           selection->http_client_tls_id != NULL &&
           strcmp(selection->http_client_tls_id,
                  POCKETJS_NET_ESP_TLS_PROVIDER_ID) == 0;
  }
  return selection->http_client_tls_source ==
             POCKETJS_NET_ESP_RUNTIME_TLS_SELECTION_NONE &&
         selection->http_client_tls_id == NULL;
}

static bool core_descriptor_compatible(
    const pocketjs_net_http_client_core_descriptor_t *core) {
  return core != NULL && core->id != NULL &&
         strcmp(core->id, POCKETJS_NET_HTTP_CLIENT_CORE_ID) == 0 &&
         core->experimental && core->plaintext_http &&
         core->https_fail_closed_before_io && core->https_explicit_opt_in &&
         core->owner_pumped && core->one_operation &&
         core->fixed_core_storage && core->headers_first &&
         core->explicit_body_credit && core->explicit_body_lease &&
         core->connection_reuse && core->bounded_connection_pool &&
         core->redirects_followed && core->redirect_manual &&
         core->redirect_error && core->redirect_fixed_body_replay &&
         !core->redirect_streaming_body_replay &&
         core->connect_error_candidate_fallback && !core->hidden_retry &&
         !core->hidden_auth && !core->hidden_cookie_store && !core->proxy &&
         !core->content_decoding &&
         core->cleanup_faults_separate_from_terminal &&
         core->poison_is_machine_readable &&
         core->explicit_shutdown_lifecycle && core->fixed_request_body &&
         core->streaming_request_body && core->chunked_request_body &&
         core->known_length_streaming_request_body &&
         !core->streaming_request_body_buffered_in_full &&
         core->instance_bytes == POCKETJS_NET_HTTP_CLIENT_CORE_INSTANCE_BYTES &&
         core->max_fixed_request_body_bytes ==
             POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REQUEST_BODY_BYTES &&
         core->max_request_body_chunk_bytes ==
             POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES &&
         core->body_lease_bytes ==
             POCKETJS_NET_HTTP_CLIENT_CORE_BODY_LEASE_BYTES &&
         core->max_cached_connections == 1U;
}

static bool transport_descriptor_compatible(
    const pocketjs_net_esp_transport_descriptor_t *transport,
    const pocketjs_net_http_client_core_descriptor_t *core, bool tls_enabled) {
  bool compatible =
      transport != NULL && core != NULL && transport->id != NULL &&
      strcmp(transport->id, POCKETJS_NET_ESP_TRANSPORT_ID) == 0 &&
      transport->implementation_version != NULL && transport->experimental &&
      transport->ipv4 && transport->asynchronous_raw_dns &&
      transport->stock_lwip_dns_callbacks_only &&
      transport->rejects_saturated_dns_candidate_prefix &&
      transport->dns_cancel_generation_cleanup &&
      !transport->synchronous_getaddrinfo_for_hostname &&
      transport->nonblocking_plain_tcp_steps &&
      transport->monotonic_deadlines &&
      transport->cancel_between_native_steps &&
      !transport->worker_or_callback_calls_quickjs &&
      transport->exact_one_terminal && transport->aba_safe_tokens &&
      transport->fixed_operation_pool && transport->fixed_completion_pool &&
      transport->fixed_payload_pool &&
      transport->pocketjs_owned_instance_bytes != 0U &&
      transport->max_connections != 0U && transport->max_operations != 0U &&
      transport->completion_capacity != 0U &&
      transport->max_dns_candidates != 0U &&
      transport->max_write_bytes >= core->max_request_body_chunk_bytes &&
      transport->read_lease_bytes >= core->body_lease_bytes;
  if (!compatible || !tls_enabled) {
    return compatible;
  }
  return transport->tls_compiled && transport->tls_1_2_only &&
         transport->host_trust && transport->host_pinned_ca &&
         transport->hostname_verification && transport->distinct_tls_errors &&
         transport->sni && transport->trusted_wall_clock_required &&
         !transport->plaintext_fallback && !transport->renegotiation &&
         !transport->early_data && transport->tls_close_notify &&
         transport->tls_close_notify_uses_operation_deadline &&
         !transport->tls_close_notify_waits_for_peer;
}

static bool compiled_descriptors_compatible(bool tls_enabled) {
  const pocketjs_net_http_client_core_descriptor_t *core =
      pocketjs_net_http_client_core_descriptor();
  const pocketjs_net_esp_transport_descriptor_t *transport =
      pocketjs_net_esp_transport_descriptor();
  return core_descriptor_compatible(core) &&
         transport_descriptor_compatible(transport, core, tls_enabled);
}

static bool public_descriptors_admitted(bool tls_enabled) {
  const pocketjs_net_http_client_core_descriptor_t *core =
      pocketjs_net_http_client_core_descriptor();
  const pocketjs_net_esp_transport_descriptor_t *transport =
      pocketjs_net_esp_transport_descriptor();
  bool admitted = core_descriptor_compatible(core) &&
                  transport_descriptor_compatible(transport, core, tls_enabled);
  admitted &= RUNTIME_DESCRIPTOR.advertises_public_capability;
  admitted &= core != NULL && core->advertises_public_capability;
  admitted &= transport != NULL && transport->advertises_public_capability;
  admitted &= transport != NULL && transport->complete_dns_candidate_set;
  admitted &= transport != NULL && transport->dns_cancel_generation_cleanup;
  admitted &= transport != NULL && transport->bounded_native_step_wall_time;
  admitted &=
      transport != NULL && transport->bounded_lwip_dns_callback_allocation;
  admitted &= transport != NULL && transport->bounded_lwip_socket_allocation;
  if (tls_enabled) {
    admitted &= RUNTIME_DESCRIPTOR.distinct_tls_errors;
    admitted &= transport != NULL && transport->nonblocking_tls_steps;
    admitted &=
        transport != NULL && !transport->esp_tls_numeric_getaddrinfo_internal;
    admitted &= transport != NULL && transport->bounded_esp_tls_allocation;
    admitted &=
        transport != NULL && transport->bounded_mbedtls_x509_parse_allocation;
  }
  return admitted;
}

static bool valid_config(const pocketjs_net_esp_runtime_config_t *config) {
  if (config == NULL || config->guest == NULL ||
      config->runtime_generation == 0U || config->max_operations == 0U ||
      config->max_operations > POCKETJS_NET_ESP_RUNTIME_MAX_OPERATIONS ||
      config->max_operations != config->limits.max_operations.default_value ||
      config->limits.max_operations.hard >
          POCKETJS_NET_ESP_RUNTIME_MAX_OPERATIONS ||
      config->connect_timeout_us == 0U || config->headers_timeout_us == 0U ||
      config->idle_timeout_us == 0U || config->total_timeout_us == 0U ||
      config->allow_endpoint == NULL ||
      !pocketjs_net_esp_runtime_feature_projection_valid(
          config->feature_ids, config->feature_count)) {
    return false;
  }
  const bool tls_enabled = pocketjs_net_esp_runtime_feature_projection_has_tls(
      config->feature_ids, config->feature_count);
  if ((config->admission != POCKETJS_NET_ESP_RUNTIME_ADMISSION_TEST_ONLY &&
       config->admission != POCKETJS_NET_ESP_RUNTIME_ADMISSION_PUBLIC) ||
      !valid_provider_selection(config, tls_enabled) ||
      !compiled_descriptors_compatible(tls_enabled) ||
      !valid_tls_config_shape(config, tls_enabled) ||
      (config->admission == POCKETJS_NET_ESP_RUNTIME_ADMISSION_PUBLIC &&
       !public_descriptors_admitted(tls_enabled))) {
    return false;
  }
  size_t required_native_bytes = 0U;
  if (config->limits.native_buffer_bytes.default_value > SIZE_MAX ||
      config->limits.native_buffer_bytes.hard > SIZE_MAX ||
      !pocketjs_net_esp_runtime_required_native_buffer_bytes(
          config->max_operations, &required_native_bytes) ||
      config->limits.native_buffer_bytes.default_value <
          required_native_bytes ||
      config->limits.native_buffer_bytes.hard < required_native_bytes) {
    return false;
  }
  return valid_limit(config->limits.buffered_body_bytes, true) &&
         valid_limit(config->limits.header_bytes, true) &&
         valid_limit(config->limits.max_body_chunk_bytes, true) &&
         valid_limit(config->limits.max_operations, false) &&
         valid_limit(config->limits.native_buffer_bytes, true) &&
         config->limits.header_bytes.hard <=
             POCKETJS_NET_HTTP_CLIENT_CORE_MAX_RESPONSE_HEADER_BYTES &&
         config->limits.max_body_chunk_bytes.hard <=
             POCKETJS_NET_HTTP_CLIENT_CORE_BODY_LEASE_BYTES;
}

const pocketjs_net_esp_runtime_descriptor_t *
pocketjs_net_esp_runtime_descriptor(void) {
  return &RUNTIME_DESCRIPTOR;
}

bool pocketjs_net_esp_runtime_is_owner(
    const pocketjs_net_esp_runtime_t *runtime) {
  return runtime != NULL && runtime->magic == POCKETJS_NET_ESP_RUNTIME_MAGIC &&
         runtime->owner_task == xTaskGetCurrentTaskHandle();
}

void pocketjs_net_esp_runtime_poison(pocketjs_net_esp_runtime_t *runtime,
                                     uint32_t flag) {
  if (runtime != NULL) {
    runtime->poison_flags |= flag;
  }
}

void pocketjs_net_esp_runtime_signal(pocketjs_net_esp_runtime_t *runtime) {
  if (runtime != NULL && runtime->wake != NULL) {
    runtime->wake(runtime->wake_context);
  }
}

static void transport_wake(void *context) {
  pocketjs_net_esp_runtime_signal(context);
}

static bool
core_permission(void *context,
                const pocketjs_net_http_client_endpoint_t *endpoint) {
  pocketjs_net_esp_runtime_t *runtime = context;
  if (runtime->permission_call_active) {
    pocketjs_net_esp_runtime_poison(runtime,
                                    POCKETJS_NET_ESP_RUNTIME_POISON_CORE);
    return false;
  }
  ++runtime->permission_checks;
  runtime->permission_call_active = true;
  const bool allowed =
      runtime->allow_endpoint(runtime->permission_context, endpoint);
  runtime->permission_call_active = false;
  return allowed;
}

static bool initialize_slot(pocketjs_net_esp_runtime_t *runtime,
                            pocketjs_net_esp_runtime_slot_t *slot,
                            pocketjs_net_esp_runtime_error_t *out_error) {
  if (slot->initialized) {
    return true;
  }
  pocketjs_net_esp_transport_config_t transport_config = {
      .wake = transport_wake,
      .wake_context = runtime,
      .tls_trust_source = runtime->tls_trust_source,
      .host_pinned_ca_pem =
          runtime->tls_trust_source == POCKETJS_NET_ESP_TLS_TRUST_HOST_PINNED_CA
              ? runtime->pinned_ca
              : NULL,
      .host_pinned_ca_pem_bytes = runtime->pinned_ca_bytes,
      .wall_clock_trusted = runtime->wall_clock_trusted,
      .wall_clock_context = runtime->wall_clock_context,
  };
  esp_err_t create_result =
      pocketjs_net_esp_transport_create(&transport_config, &slot->transport);
  if (create_result != ESP_OK) {
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              POCKETJS_NETWORK_V1_ERROR_RESOURCE_LIMIT, "http.fetch", false);
    return false;
  }
  pocketjs_net_http_client_core_config_t core_config = {
      .transport_ops = pocketjs_net_http_client_core_esp_transport_ops(),
      .transport_context = slot->transport,
      .allow_endpoint = core_permission,
      .permission_context = runtime,
      .connect_timeout_us = runtime->connect_timeout_us,
      .headers_timeout_us = runtime->headers_timeout_us,
      .idle_timeout_us = runtime->idle_timeout_us,
      .total_timeout_us = runtime->total_timeout_us,
      .allow_https = runtime->tls_enabled,
      .enable_connection_reuse = true,
      .response_header_bytes_limit =
          (size_t)runtime->limits.header_bytes.default_value,
  };
  pocketjs_net_http_client_start_result_t init_result =
      pocketjs_net_http_client_core_init(&slot->core_storage, &core_config,
                                         &slot->core);
  if (init_result != POCKETJS_NET_HTTP_CLIENT_START_OK) {
    pocketjs_net_esp_transport_begin_shutdown(slot->transport);
    if (pocketjs_net_esp_transport_is_quiescent(slot->transport)) {
      (void)pocketjs_net_esp_transport_destroy(slot->transport);
    }
    slot->transport = NULL;
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              POCKETJS_NETWORK_V1_ERROR_RESOURCE_LIMIT, "http.fetch", false);
    return false;
  }
  slot->initialized = true;
  return true;
}

static void observe_core_status(pocketjs_net_esp_runtime_t *runtime,
                                pocketjs_net_esp_runtime_slot_t *slot) {
  pocketjs_net_http_client_core_status_t status = {0};
  if (!pocketjs_net_http_client_core_get_status(slot->core, &status) ||
      status.poisoned) {
    pocketjs_net_esp_runtime_poison(runtime,
                                    POCKETJS_NET_ESP_RUNTIME_POISON_CORE);
  }
}

static pocketjs_net_esp_runtime_slot_t *
slot_for_operation(pocketjs_net_esp_runtime_t *runtime,
                   pocketjs_network_v1_handle_t operation) {
  if (!pocketjs_net_esp_runtime_live_handle(operation) || operation.id == 0U ||
      operation.id > runtime->max_operations) {
    return NULL;
  }
  pocketjs_net_esp_runtime_slot_t *slot = &runtime->slots[operation.id - 1U];
  return slot->active && pocketjs_net_esp_runtime_same_handle(slot->operation,
                                                              operation)
             ? slot
             : NULL;
}

bool pocketjs_net_esp_runtime_validate_identity(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity,
    bool consume_sequence, pocketjs_net_esp_runtime_error_t *out_error) {
  if (!pocketjs_net_esp_runtime_is_owner(runtime) || identity == NULL ||
      identity->runtime_generation != runtime->runtime_generation ||
      identity->resource.id != POCKETJS_NET_ESP_RUNTIME_HTTP_RESOURCE_ID ||
      identity->resource.generation !=
          POCKETJS_NET_ESP_RUNTIME_HTTP_RESOURCE_GENERATION ||
      !pocketjs_net_esp_runtime_live_handle(identity->operation) ||
      (!pocketjs_network_v1_handle_is_absent(identity->body) &&
       !pocketjs_net_esp_runtime_live_handle(identity->body)) ||
      identity->command_sequence == 0U ||
      identity->command_sequence > POCKETJS_NETWORK_V1_SEQUENCE_MAX ||
      identity->command_sequence <= runtime->command_sequence) {
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              POCKETJS_NETWORK_V1_ERROR_INVALID_STATE, "network.dispatch",
              false);
    return false;
  }
  if (consume_sequence) {
    runtime->command_sequence = identity->command_sequence;
  }
  return true;
}

static void clear_operation(pocketjs_net_esp_runtime_slot_t *slot) {
  slot->active = false;
  slot->headers_delivered = false;
  slot->response_body_published = false;
  slot->upload_credit_active = false;
  slot->operation = ABSENT_HANDLE;
  slot->request_body = ABSENT_HANDLE;
  slot->response_body = ABSENT_HANDLE;
  slot->core_operation_token = 0U;
  slot->upload_body_generation = 0U;
  slot->upload_pull_generation = 0U;
  slot->upload_maximum_bytes = 0U;
  slot->event_pending = false;
  slot->lease_state = POCKETJS_NET_ESP_RUNTIME_LEASE_NONE;
  slot->lease_descriptor_delivered = false;
  slot->lease = ABSENT_HANDLE;
  slot->lease_byte_length = 0U;
}

static void map_start_error(pocketjs_net_http_client_start_result_t result,
                            pocketjs_net_esp_runtime_error_t *out_error) {
  pocketjs_network_v1_error_code_t code =
      POCKETJS_NETWORK_V1_ERROR_INVALID_STATE;
  switch (result) {
  case POCKETJS_NET_HTTP_CLIENT_START_BUSY:
    code = POCKETJS_NETWORK_V1_ERROR_BUSY;
    break;
  case POCKETJS_NET_HTTP_CLIENT_START_UNSUPPORTED_TLS:
    code = POCKETJS_NETWORK_V1_ERROR_UNSUPPORTED;
    break;
  case POCKETJS_NET_HTTP_CLIENT_START_LIMIT_EXCEEDED:
  case POCKETJS_NET_HTTP_CLIENT_START_TOKEN_EXHAUSTED:
    code = POCKETJS_NETWORK_V1_ERROR_RESOURCE_LIMIT;
    break;
  case POCKETJS_NET_HTTP_CLIENT_START_FORBIDDEN_REQUEST:
    code = POCKETJS_NETWORK_V1_ERROR_PERMISSION_DENIED;
    break;
  case POCKETJS_NET_HTTP_CLIENT_START_INVALID_URL:
  case POCKETJS_NET_HTTP_CLIENT_START_INVALID_ARGUMENT:
    code = POCKETJS_NETWORK_V1_ERROR_HTTP_PROTOCOL_ERROR;
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_PROTOCOL, code,
              "http.fetch", false);
    return;
  case POCKETJS_NET_HTTP_CLIENT_START_POISONED:
  case POCKETJS_NET_HTTP_CLIENT_START_SHUTTING_DOWN:
  case POCKETJS_NET_HTTP_CLIENT_START_REENTRANT:
  case POCKETJS_NET_HTTP_CLIENT_START_OK:
  default:
    break;
  }
  set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME, code,
            "http.fetch", false);
}

bool pocketjs_net_esp_runtime_start_http(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity,
    const pocketjs_net_esp_runtime_http_command_t *command,
    pocketjs_net_esp_runtime_error_t *out_error) {
  if (!pocketjs_net_esp_runtime_validate_identity(runtime, identity, true,
                                                  out_error)) {
    return false;
  }
  if (runtime->phase != POCKETJS_NET_ESP_RUNTIME_PHASE_RUNNING ||
      runtime->poison_flags != 0U || command == NULL ||
      identity->operation.id > runtime->max_operations) {
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              POCKETJS_NETWORK_V1_ERROR_INVALID_STATE, "http.fetch", false);
    return false;
  }
  if (command->has_body !=
      pocketjs_net_esp_runtime_live_handle(identity->body)) {
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_PROTOCOL,
              POCKETJS_NETWORK_V1_ERROR_HTTP_PROTOCOL_ERROR, "http.fetch",
              false);
    return false;
  }
  const uint64_t request_header_bytes =
      (uint64_t)command->header_bytes_used +
      (uint64_t)command->header_count * UINT64_C(4);
  if (request_header_bytes > runtime->limits.header_bytes.default_value) {
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              POCKETJS_NETWORK_V1_ERROR_RESOURCE_LIMIT, "http.fetch", false);
    return false;
  }
  pocketjs_net_esp_runtime_slot_t *slot =
      &runtime->slots[identity->operation.id - 1U];
  if (slot->active) {
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              POCKETJS_NETWORK_V1_ERROR_BUSY, "http.fetch", false);
    return false;
  }
  if (slot->last_operation_generation == UINT32_MAX) {
    pocketjs_net_esp_runtime_poison(runtime,
                                    POCKETJS_NET_ESP_RUNTIME_POISON_SEQUENCE);
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              POCKETJS_NETWORK_V1_ERROR_RESOURCE_LIMIT, "http.fetch", false);
    return false;
  }
  if (identity->operation.generation <= slot->last_operation_generation) {
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              POCKETJS_NETWORK_V1_ERROR_INVALID_STATE, "http.fetch", false);
    return false;
  }
  /*
   * A valid formal slot generation is consumed even by pre-I/O refusal.
   * Guest validation may consume generations without dispatching them, so the
   * Host requires strict monotonicity but does not require contiguity.
   */
  slot->last_operation_generation = identity->operation.generation;
  if (slot->last_response_body_generation == UINT32_MAX ||
      slot->last_lease_generation == UINT32_MAX) {
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              POCKETJS_NETWORK_V1_ERROR_RESOURCE_LIMIT, "http.fetch", false);
    return false;
  }
  if ((command->tls_requested && !runtime->tls_enabled) ||
      command->borrowed_input_present || command->has_timeout_overrides ||
      command->has_limit_overrides) {
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              POCKETJS_NETWORK_V1_ERROR_UNSUPPORTED, "http.fetch", false);
    return false;
  }
  if (!initialize_slot(runtime, slot, out_error)) {
    return false;
  }
  const uint64_t operation_token =
      ((uint64_t)identity->operation.generation << 32U) |
      (uint64_t)identity->operation.id;
  if (operation_token == 0U) {
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              POCKETJS_NETWORK_V1_ERROR_RESOURCE_LIMIT, "http.fetch", false);
    return false;
  }

  slot->active = true;
  slot->operation = identity->operation;
  slot->request_body = identity->body;
  slot->response_body = ABSENT_HANDLE;
  slot->core_operation_token = operation_token;
  memcpy(slot->request_method, command->method, command->method_length);
  slot->request_method_length = command->method_length;

  pocketjs_net_http_client_request_t request = {
      .operation_token = operation_token,
      .url = {.data = command->url, .length = command->url_length},
      .method = {.data = command->method, .length = command->method_length},
      .headers = command->headers,
      .header_count = command->header_count,
      .body_kind = command->has_body
                       ? POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_STREAMING
                       : POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_NONE,
      .streaming_content_length_known = false,
      .streaming_content_length = 0U,
      .redirect_mode =
          command->redirect_mode == POCKETJS_NETWORK_V1_HTTP_REDIRECT_FOLLOW
              ? POCKETJS_NET_HTTP_CLIENT_REDIRECT_FOLLOW
          : command->redirect_mode == POCKETJS_NETWORK_V1_HTTP_REDIRECT_ERROR
              ? POCKETJS_NET_HTTP_CLIENT_REDIRECT_ERROR
              : POCKETJS_NET_HTTP_CLIENT_REDIRECT_MANUAL,
      .max_redirects = command->max_redirects,
      .tls = command->tls_present ? &command->tls_policy : NULL,
  };
  const uint64_t now_us = (uint64_t)esp_timer_get_time();
  pocketjs_net_http_client_start_result_t result =
      pocketjs_net_http_client_core_start(slot->core, &request, now_us);
  observe_core_status(runtime, slot);
  if (result != POCKETJS_NET_HTTP_CLIENT_START_OK) {
    clear_operation(slot);
    map_start_error(result, out_error);
    return false;
  }
  ++runtime->requests_started;
  pocketjs_net_esp_runtime_signal(runtime);
  return true;
}

static bool current_body_matches(const pocketjs_net_esp_runtime_slot_t *slot,
                                 pocketjs_network_v1_handle_t body) {
  return pocketjs_net_esp_runtime_same_handle(
      slot->headers_delivered ? slot->response_body : slot->request_body, body);
}

bool pocketjs_net_esp_runtime_cancel(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity,
    pocketjs_net_esp_runtime_error_t *out_error) {
  if (!pocketjs_net_esp_runtime_validate_identity(runtime, identity, true,
                                                  out_error)) {
    return false;
  }
  pocketjs_net_esp_runtime_slot_t *slot =
      slot_for_operation(runtime, identity->operation);
  if (slot == NULL || !current_body_matches(slot, identity->body)) {
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              POCKETJS_NETWORK_V1_ERROR_INVALID_STATE, "http.fetch.cancel",
              false);
    return false;
  }
  if (!pocketjs_net_http_client_core_abort(slot->core,
                                           slot->core_operation_token)) {
    pocketjs_net_http_client_core_status_t status = {0};
    if (!pocketjs_net_http_client_core_get_status(slot->core, &status) ||
        !status.request_active ||
        status.operation_token != slot->core_operation_token) {
      set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
                POCKETJS_NETWORK_V1_ERROR_INVALID_STATE, "http.fetch.cancel",
                false);
      return false;
    }
  }
  observe_core_status(runtime, slot);
  pocketjs_net_esp_runtime_signal(runtime);
  return true;
}

bool pocketjs_net_esp_runtime_grant_body_credit(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity,
    uint32_t maximum_bytes, pocketjs_net_esp_runtime_error_t *out_error) {
  if (!pocketjs_net_esp_runtime_validate_identity(runtime, identity, true,
                                                  out_error)) {
    return false;
  }
  pocketjs_net_esp_runtime_slot_t *slot =
      slot_for_operation(runtime, identity->operation);
  const uint64_t selected = runtime->limits.max_body_chunk_bytes.default_value;
  if (slot == NULL || !slot->headers_delivered ||
      !pocketjs_net_esp_runtime_same_handle(slot->response_body,
                                            identity->body) ||
      maximum_bytes == 0U || maximum_bytes > selected ||
      slot->last_lease_generation == UINT32_MAX ||
      !pocketjs_net_http_client_core_grant_body_credit(
          slot->core, slot->core_operation_token, maximum_bytes)) {
    set_error(
        out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
        maximum_bytes > selected ||
                (slot != NULL && slot->last_lease_generation == UINT32_MAX)
            ? POCKETJS_NETWORK_V1_ERROR_RESOURCE_LIMIT
            : POCKETJS_NETWORK_V1_ERROR_INVALID_STATE,
        "http.body.pull", false);
    return false;
  }
  pocketjs_net_esp_runtime_signal(runtime);
  return true;
}

static bool
upload_command_slot(pocketjs_net_esp_runtime_t *runtime,
                    const pocketjs_network_v1_command_identity_t *identity,
                    pocketjs_net_esp_runtime_slot_t **out_slot,
                    pocketjs_net_esp_runtime_error_t *out_error) {
  if (!pocketjs_net_esp_runtime_validate_identity(runtime, identity, true,
                                                  out_error)) {
    return false;
  }
  pocketjs_net_esp_runtime_slot_t *slot =
      slot_for_operation(runtime, identity->operation);
  if (slot == NULL || slot->headers_delivered || !slot->upload_credit_active ||
      !pocketjs_net_esp_runtime_same_handle(slot->request_body,
                                            identity->body)) {
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              POCKETJS_NETWORK_V1_ERROR_INVALID_STATE, "http.fetch.upload",
              false);
    return false;
  }
  *out_slot = slot;
  return true;
}

bool pocketjs_net_esp_runtime_submit_body_chunk(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity,
    const uint8_t *bytes, size_t length,
    pocketjs_net_esp_runtime_error_t *out_error) {
  pocketjs_net_esp_runtime_slot_t *slot = NULL;
  if (!upload_command_slot(runtime, identity, &slot, out_error)) {
    return false;
  }
  if (bytes == NULL || length == 0U || length > slot->upload_maximum_bytes ||
      !pocketjs_net_http_client_core_submit_request_body_chunk(
          slot->core, slot->core_operation_token, slot->upload_body_generation,
          slot->upload_pull_generation, bytes, length)) {
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              length > slot->upload_maximum_bytes
                  ? POCKETJS_NETWORK_V1_ERROR_RESOURCE_LIMIT
                  : POCKETJS_NETWORK_V1_ERROR_INVALID_STATE,
              "http.fetch.upload", false);
    return false;
  }
  slot->upload_credit_active = false;
  pocketjs_net_esp_runtime_signal(runtime);
  return true;
}

bool pocketjs_net_esp_runtime_submit_body_end(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity,
    pocketjs_net_esp_runtime_error_t *out_error) {
  pocketjs_net_esp_runtime_slot_t *slot = NULL;
  if (!upload_command_slot(runtime, identity, &slot, out_error)) {
    return false;
  }
  if (!pocketjs_net_http_client_core_submit_request_body_end(
          slot->core, slot->core_operation_token, slot->upload_body_generation,
          slot->upload_pull_generation)) {
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              POCKETJS_NETWORK_V1_ERROR_INVALID_STATE, "http.fetch.upload",
              false);
    return false;
  }
  slot->upload_credit_active = false;
  pocketjs_net_esp_runtime_signal(runtime);
  return true;
}

bool pocketjs_net_esp_runtime_submit_body_error(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity, int32_t cause_code,
    pocketjs_net_esp_runtime_error_t *out_error) {
  pocketjs_net_esp_runtime_slot_t *slot = NULL;
  if (!upload_command_slot(runtime, identity, &slot, out_error)) {
    return false;
  }
  if (!pocketjs_net_http_client_core_submit_request_body_error(
          slot->core, slot->core_operation_token, slot->upload_body_generation,
          slot->upload_pull_generation, cause_code)) {
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              POCKETJS_NETWORK_V1_ERROR_INVALID_STATE, "http.fetch.upload",
              false);
    return false;
  }
  slot->upload_credit_active = false;
  pocketjs_net_esp_runtime_signal(runtime);
  return true;
}

bool pocketjs_net_esp_runtime_cancel_body(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity,
    pocketjs_net_esp_runtime_error_t *out_error) {
  return pocketjs_net_esp_runtime_cancel(runtime, identity, out_error);
}

static bool response_has_body(const pocketjs_net_esp_runtime_slot_t *slot,
                              unsigned status) {
  const bool head =
      slot->request_method_length == 4U &&
      (slot->request_method[0] == 'H' || slot->request_method[0] == 'h') &&
      (slot->request_method[1] == 'E' || slot->request_method[1] == 'e') &&
      (slot->request_method[2] == 'A' || slot->request_method[2] == 'a') &&
      (slot->request_method[3] == 'D' || slot->request_method[3] == 'd');
  return !head && status != 204U && status != 205U && status != 304U;
}

static bool prepare_event(pocketjs_net_esp_runtime_t *runtime,
                          pocketjs_net_esp_runtime_slot_t *slot) {
  if (slot->event.type == POCKETJS_NET_HTTP_CLIENT_EVENT_REQUEST_BODY_PULL) {
    const size_t selected =
        (size_t)runtime->limits.max_body_chunk_bytes.default_value;
    if (slot->event.detail.request_body_pull.maximum_bytes > selected) {
      slot->event.detail.request_body_pull.maximum_bytes = selected;
    }
  } else if (slot->event.type ==
             POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS) {
    if (response_has_body(slot, slot->event.detail.response.status_code)) {
      if (slot->last_response_body_generation == UINT32_MAX) {
        pocketjs_net_esp_runtime_poison(
            runtime, POCKETJS_NET_ESP_RUNTIME_POISON_SEQUENCE);
        return false;
      }
      ++slot->last_response_body_generation;
      slot->response_body = (pocketjs_network_v1_handle_t){
          .id = slot->operation.id,
          .generation = slot->last_response_body_generation,
      };
      slot->response_body_published = true;
    } else {
      slot->response_body = ABSENT_HANDLE;
      slot->response_body_published = false;
    }
  } else if (slot->event.type == POCKETJS_NET_HTTP_CLIENT_EVENT_BODY) {
    if (slot->last_lease_generation == UINT32_MAX) {
      pocketjs_net_esp_runtime_poison(runtime,
                                      POCKETJS_NET_ESP_RUNTIME_POISON_SEQUENCE);
      return false;
    }
    ++slot->last_lease_generation;
    slot->lease = (pocketjs_network_v1_handle_t){
        .id = slot->operation.id,
        .generation = slot->last_lease_generation,
    };
    slot->lease_byte_length = (uint32_t)slot->event.detail.body.byte_count;
    slot->core_lease = slot->event.detail.body.lease;
    slot->lease_state = POCKETJS_NET_ESP_RUNTIME_LEASE_QUEUED;
    slot->lease_descriptor_delivered = false;
  }
  return true;
}

static bool
abandon_poisoned_pending_event(pocketjs_net_esp_runtime_t *runtime,
                               pocketjs_net_esp_runtime_slot_t *slot) {
  if (runtime->phase == POCKETJS_NET_ESP_RUNTIME_PHASE_RUNNING ||
      !slot->event_pending || slot->transport != NULL ||
      slot->transport_detached_awaiting_confirm) {
    return false;
  }
  pocketjs_net_http_client_core_status_t status = {0};
  if (!pocketjs_net_http_client_core_get_status(slot->core, &status) ||
      !status.shutdown_requested || !status.poisoned ||
      !pocketjs_net_http_client_core_abandon_event_after_transport_shutdown(
          slot->core, slot->event.sequence)) {
    return false;
  }

  const pocketjs_net_http_client_event_type_t type = slot->event.type;
  if (type == POCKETJS_NET_HTTP_CLIENT_EVENT_BODY &&
      slot->lease_state != POCKETJS_NET_ESP_RUNTIME_LEASE_NONE &&
      slot->lease_state != POCKETJS_NET_ESP_RUNTIME_LEASE_RELEASED) {
    ++runtime->leases_cleaned_up;
  }
  slot->event_pending = false;
  memset(&slot->event, 0, sizeof(slot->event));
  slot->lease_state = POCKETJS_NET_ESP_RUNTIME_LEASE_NONE;
  slot->lease_descriptor_delivered = false;
  slot->lease = ABSENT_HANDLE;
  slot->lease_byte_length = 0U;
  slot->core_lease = (pocketjs_net_http_client_body_lease_t){0};
  if (type == POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE ||
      type == POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR) {
    clear_operation(slot);
  }
  return true;
}

static bool cleanup_pending_event(pocketjs_net_esp_runtime_t *runtime,
                                  pocketjs_net_esp_runtime_slot_t *slot) {
  if (!slot->event_pending) {
    return true;
  }
  const pocketjs_net_http_client_event_type_t type = slot->event.type;
  if (type == POCKETJS_NET_HTTP_CLIENT_EVENT_BODY &&
      slot->lease_state != POCKETJS_NET_ESP_RUNTIME_LEASE_RELEASED) {
    const pocketjs_net_http_client_body_lease_t lease =
        slot->lease_state == POCKETJS_NET_ESP_RUNTIME_LEASE_NONE
            ? slot->event.detail.body.lease
            : slot->core_lease;
    if (!pocketjs_net_http_client_core_release_body_lease(slot->core, lease)) {
      (void)pocketjs_net_http_client_core_report_host_event_retire_failure(
          slot->core, slot->event.sequence);
      pocketjs_net_esp_runtime_poison(runtime,
                                      POCKETJS_NET_ESP_RUNTIME_POISON_LEASE);
      return abandon_poisoned_pending_event(runtime, slot);
    }
    slot->core_lease = lease;
    slot->lease_state = POCKETJS_NET_ESP_RUNTIME_LEASE_RELEASED;
    ++runtime->leases_cleaned_up;
  }
  if (!pocketjs_net_http_client_core_retire_event(slot->core,
                                                  slot->event.sequence)) {
    (void)pocketjs_net_http_client_core_report_host_event_retire_failure(
        slot->core, slot->event.sequence);
    pocketjs_net_esp_runtime_poison(runtime,
                                    type == POCKETJS_NET_HTTP_CLIENT_EVENT_BODY
                                        ? POCKETJS_NET_ESP_RUNTIME_POISON_LEASE
                                        : POCKETJS_NET_ESP_RUNTIME_POISON_CORE);
    return abandon_poisoned_pending_event(runtime, slot);
  }
  slot->event_pending = false;
  slot->lease_state = POCKETJS_NET_ESP_RUNTIME_LEASE_NONE;
  slot->lease_descriptor_delivered = false;
  slot->lease = ABSENT_HANDLE;
  slot->lease_byte_length = 0U;
  if (type == POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE ||
      type == POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR) {
    clear_operation(slot);
  }
  return true;
}

bool pocketjs_net_esp_runtime_peek_event(
    pocketjs_net_esp_runtime_t *runtime,
    pocketjs_net_esp_runtime_slot_t **out_slot) {
  if (!pocketjs_net_esp_runtime_is_owner(runtime) || out_slot == NULL) {
    return false;
  }
  *out_slot = NULL;
  for (size_t offset = 0U; offset < runtime->max_operations; ++offset) {
    const size_t index =
        (runtime->completion_cursor + offset) % runtime->max_operations;
    pocketjs_net_esp_runtime_slot_t *slot = &runtime->slots[index];
    if (!slot->initialized || !slot->active) {
      continue;
    }
    if (!slot->event_pending) {
      if (!pocketjs_net_http_client_core_take_event(slot->core, &slot->event)) {
        continue;
      }
      slot->event_pending = true;
      if (slot->event.operation_token != slot->core_operation_token ||
          !prepare_event(runtime, slot)) {
        pocketjs_net_esp_runtime_poison(runtime,
                                        POCKETJS_NET_ESP_RUNTIME_POISON_CORE);
        (void)cleanup_pending_event(runtime, slot);
        return false;
      }
    }
    if (slot->event.type == POCKETJS_NET_HTTP_CLIENT_EVENT_BODY &&
        slot->lease_descriptor_delivered) {
      continue;
    }
    runtime->completion_cursor = (index + 1U) % runtime->max_operations;
    *out_slot = slot;
    return true;
  }
  return false;
}

int pocketjs_net_esp_runtime_completion_readiness(
    pocketjs_net_esp_runtime_t *runtime) {
  if (!pocketjs_net_esp_runtime_is_owner(runtime)) {
    return -1;
  }
  for (size_t index = 0U; index < runtime->max_operations; ++index) {
    pocketjs_net_esp_runtime_slot_t *slot = &runtime->slots[index];
    if (!slot->initialized) {
      continue;
    }
    if (slot->transport_detached_awaiting_confirm) {
      pocketjs_net_esp_runtime_poison(runtime,
                                      POCKETJS_NET_ESP_RUNTIME_POISON_SHUTDOWN);
      return -1;
    }
    pocketjs_net_http_client_core_status_t status = {0};
    if (!pocketjs_net_http_client_core_get_status(slot->core, &status) ||
        status.poisoned) {
      pocketjs_net_esp_runtime_poison(runtime,
                                      POCKETJS_NET_ESP_RUNTIME_POISON_CORE);
      return -1;
    }
    if (slot->event_pending || status.event_outstanding) {
      return 1;
    }
  }
  return 0;
}

bool pocketjs_net_esp_runtime_retire_nonlease_event(
    pocketjs_net_esp_runtime_t *runtime,
    pocketjs_net_esp_runtime_slot_t *slot) {
  if (!pocketjs_net_esp_runtime_is_owner(runtime) || slot == NULL ||
      !slot->event_pending ||
      slot->event.type == POCKETJS_NET_HTTP_CLIENT_EVENT_BODY) {
    return false;
  }
  const pocketjs_net_http_client_event_type_t type = slot->event.type;
  if (type == POCKETJS_NET_HTTP_CLIENT_EVENT_REQUEST_BODY_PULL) {
    slot->upload_body_generation =
        slot->event.detail.request_body_pull.body_generation;
    slot->upload_pull_generation =
        slot->event.detail.request_body_pull.pull_generation;
    slot->upload_maximum_bytes =
        slot->event.detail.request_body_pull.maximum_bytes;
  }
  if (!pocketjs_net_http_client_core_retire_event(slot->core,
                                                  slot->event.sequence)) {
    (void)pocketjs_net_http_client_core_report_host_event_retire_failure(
        slot->core, slot->event.sequence);
    pocketjs_net_esp_runtime_poison(runtime,
                                    POCKETJS_NET_ESP_RUNTIME_POISON_CORE);
    return false;
  }
  slot->event_pending = false;
  if (type == POCKETJS_NET_HTTP_CLIENT_EVENT_REQUEST_BODY_PULL) {
    slot->upload_credit_active = true;
  } else if (type == POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS) {
    slot->headers_delivered = true;
    slot->upload_credit_active = false;
  } else if (type == POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE ||
             type == POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR) {
    clear_operation(slot);
  }
  return true;
}

static bool lease_slot(pocketjs_net_esp_runtime_t *runtime,
                       const pocketjs_network_v1_command_identity_t *identity,
                       pocketjs_network_v1_handle_t lease,
                       pocketjs_net_esp_runtime_slot_t **out_slot,
                       pocketjs_net_esp_runtime_error_t *out_error) {
  if (!pocketjs_net_esp_runtime_validate_identity(runtime, identity, true,
                                                  out_error)) {
    return false;
  }
  pocketjs_net_esp_runtime_slot_t *slot =
      slot_for_operation(runtime, identity->operation);
  if (slot == NULL || !slot->event_pending ||
      slot->event.type != POCKETJS_NET_HTTP_CLIENT_EVENT_BODY ||
      !pocketjs_net_esp_runtime_same_handle(slot->response_body,
                                            identity->body) ||
      !pocketjs_net_esp_runtime_same_handle(slot->lease, lease)) {
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              POCKETJS_NETWORK_V1_ERROR_INVALID_STATE, "http.body.lease",
              false);
    return false;
  }
  *out_slot = slot;
  return true;
}

bool pocketjs_net_esp_runtime_lease_take(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity,
    pocketjs_network_v1_handle_t lease, uint32_t byte_length,
    uint32_t *out_byte_length, pocketjs_net_esp_runtime_error_t *out_error) {
  pocketjs_net_esp_runtime_slot_t *slot = NULL;
  if (out_byte_length == NULL ||
      !lease_slot(runtime, identity, lease, &slot, out_error) ||
      slot->lease_state != POCKETJS_NET_ESP_RUNTIME_LEASE_QUEUED ||
      !slot->lease_descriptor_delivered ||
      byte_length != slot->lease_byte_length) {
    if (out_error != NULL && out_error->code == 0U) {
      set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
                POCKETJS_NETWORK_V1_ERROR_INVALID_STATE, "http.body.lease",
                false);
    }
    return false;
  }
  slot->lease_state = POCKETJS_NET_ESP_RUNTIME_LEASE_TAKEN;
  *out_byte_length = slot->lease_byte_length;
  ++runtime->leases_taken;
  return true;
}

bool pocketjs_net_esp_runtime_lease_read(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity,
    pocketjs_network_v1_handle_t lease, uint32_t offset, uint32_t maximum_bytes,
    uint8_t *destination, size_t destination_length, uint32_t *out_copied,
    pocketjs_net_esp_runtime_error_t *out_error) {
  pocketjs_net_esp_runtime_slot_t *slot = NULL;
  if (out_copied == NULL || destination == NULL ||
      !lease_slot(runtime, identity, lease, &slot, out_error) ||
      slot->lease_state != POCKETJS_NET_ESP_RUNTIME_LEASE_TAKEN ||
      maximum_bytes == 0U || (size_t)maximum_bytes != destination_length ||
      offset > slot->lease_byte_length ||
      maximum_bytes > slot->lease_byte_length - offset) {
    if (out_error != NULL && out_error->code == 0U) {
      set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
                POCKETJS_NETWORK_V1_ERROR_INVALID_STATE, "http.body.lease",
                false);
    }
    return false;
  }
  const uint8_t *bytes = NULL;
  size_t byte_length = 0U;
  if (!pocketjs_net_http_client_core_body_lease_view(
          slot->core, slot->core_lease, &bytes, &byte_length) ||
      byte_length != slot->lease_byte_length) {
    pocketjs_net_esp_runtime_poison(runtime,
                                    POCKETJS_NET_ESP_RUNTIME_POISON_LEASE);
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              POCKETJS_NETWORK_V1_ERROR_INVALID_STATE, "http.body.lease",
              false);
    return false;
  }
  memcpy(destination, bytes + offset, maximum_bytes);
  *out_copied = maximum_bytes;
  return true;
}

bool pocketjs_net_esp_runtime_lease_release(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_network_v1_command_identity_t *identity,
    pocketjs_network_v1_handle_t lease,
    pocketjs_net_esp_runtime_error_t *out_error) {
  pocketjs_net_esp_runtime_slot_t *slot = NULL;
  if (!lease_slot(runtime, identity, lease, &slot, out_error) ||
      slot->lease_state != POCKETJS_NET_ESP_RUNTIME_LEASE_TAKEN) {
    pocketjs_net_esp_runtime_poison(runtime,
                                    POCKETJS_NET_ESP_RUNTIME_POISON_LEASE);
    if (out_error != NULL && out_error->code == 0U) {
      set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
                POCKETJS_NETWORK_V1_ERROR_INVALID_STATE, "http.body.lease",
                false);
    }
    return false;
  }
  if (!pocketjs_net_http_client_core_release_body_lease(slot->core,
                                                        slot->core_lease)) {
    (void)pocketjs_net_http_client_core_report_host_event_retire_failure(
        slot->core, slot->event.sequence);
    pocketjs_net_esp_runtime_poison(runtime,
                                    POCKETJS_NET_ESP_RUNTIME_POISON_LEASE);
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              POCKETJS_NETWORK_V1_ERROR_INVALID_STATE, "http.body.lease",
              false);
    return false;
  }
  slot->lease_state = POCKETJS_NET_ESP_RUNTIME_LEASE_RELEASED;
  ++runtime->leases_released;
  if (!cleanup_pending_event(runtime, slot)) {
    set_error(out_error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              POCKETJS_NETWORK_V1_ERROR_INVALID_STATE, "http.body.lease",
              false);
    return false;
  }
  return true;
}

esp_err_t
pocketjs_net_esp_runtime_create(const pocketjs_net_esp_runtime_config_t *config,
                                pocketjs_net_esp_runtime_t **out_runtime) {
  if (out_runtime == NULL || *out_runtime != NULL || !valid_config(config)) {
    return ESP_ERR_INVALID_ARG;
  }
  const size_t runtime_bytes =
      sizeof(pocketjs_net_esp_runtime_t) +
      sizeof(pocketjs_net_esp_runtime_slot_t) * config->max_operations;
  pocketjs_net_esp_runtime_t *runtime = calloc(1U, runtime_bytes);
  if (runtime == NULL) {
    return ESP_ERR_NO_MEM;
  }
  runtime->tls_enabled = pocketjs_net_esp_runtime_feature_projection_has_tls(
      config->feature_ids, config->feature_count);
  runtime->tls_trust_source = config->tls_trust_source;
  runtime->pinned_ca_bytes = config->host_pinned_ca_pem_bytes;
  if (runtime->pinned_ca_bytes != 0U) {
    memcpy(runtime->pinned_ca, config->host_pinned_ca_pem,
           runtime->pinned_ca_bytes);
    runtime->pinned_ca[runtime->pinned_ca_bytes] = '\0';
  }
  runtime->wall_clock_trusted = config->wall_clock_trusted;
  runtime->wall_clock_context = config->wall_clock_context;
  const pocketjs_net_esp_transport_config_t transport_config = {
      .tls_trust_source = runtime->tls_trust_source,
      .host_pinned_ca_pem =
          runtime->tls_trust_source == POCKETJS_NET_ESP_TLS_TRUST_HOST_PINNED_CA
              ? runtime->pinned_ca
              : NULL,
      .host_pinned_ca_pem_bytes = runtime->pinned_ca_bytes,
      .wall_clock_trusted = runtime->wall_clock_trusted,
      .wall_clock_context = runtime->wall_clock_context,
  };
  if (pocketjs_net_esp_transport_validate_config(&transport_config) != ESP_OK) {
    memset(runtime->pinned_ca, 0, sizeof(runtime->pinned_ca));
    free(runtime);
    return ESP_ERR_INVALID_ARG;
  }
  runtime->magic = POCKETJS_NET_ESP_RUNTIME_MAGIC;
  runtime->owner_task = xTaskGetCurrentTaskHandle();
  runtime->guest = config->guest;
  runtime->context = pocketjs_esp_guest_context(config->guest);
  if (runtime->context == NULL) {
    runtime->magic = 0U;
    memset(runtime->pinned_ca, 0, sizeof(runtime->pinned_ca));
    free(runtime);
    return ESP_ERR_INVALID_STATE;
  }
  runtime->phase = POCKETJS_NET_ESP_RUNTIME_PHASE_RUNNING;
  runtime->runtime_generation = config->runtime_generation;
  memcpy(runtime->plan_hash, config->plan_hash, sizeof(runtime->plan_hash));
  memcpy(runtime->feature_ids, config->feature_ids,
         sizeof(runtime->feature_ids[0]) * config->feature_count);
  runtime->feature_count = config->feature_count;
  runtime->max_operations = config->max_operations;
  runtime->limits = config->limits;
  runtime->connect_timeout_us = config->connect_timeout_us;
  runtime->headers_timeout_us = config->headers_timeout_us;
  runtime->idle_timeout_us = config->idle_timeout_us;
  runtime->total_timeout_us = config->total_timeout_us;
  runtime->wake = config->wake;
  runtime->wake_context = config->wake_context;
  runtime->allow_endpoint = config->allow_endpoint;
  runtime->permission_context = config->permission_context;
  runtime->binding = JS_UNDEFINED;
  runtime->dispatcher = JS_UNDEFINED;
  esp_err_t result = pocketjs_net_esp_runtime_create_binding(runtime);
  if (result != ESP_OK) {
    runtime->magic = 0U;
    memset(runtime->pinned_ca, 0, sizeof(runtime->pinned_ca));
    free(runtime);
    return result;
  }
  *out_runtime = runtime;
  return ESP_OK;
}

esp_err_t
pocketjs_net_esp_runtime_get_binding(pocketjs_net_esp_runtime_t *runtime,
                                     JSValue *out_binding) {
  if (!pocketjs_net_esp_runtime_is_owner(runtime) || out_binding == NULL ||
      runtime->phase != POCKETJS_NET_ESP_RUNTIME_PHASE_RUNNING ||
      runtime->service_call_active || runtime->dispatcher_call_active ||
      runtime->binding_call_active || runtime->permission_call_active ||
      JS_IsUndefined(runtime->binding)) {
    return ESP_ERR_INVALID_ARG;
  }
  *out_binding = JS_DupValue(runtime->context, runtime->binding);
  return ESP_OK;
}

static bool native_quiescent(pocketjs_net_esp_runtime_t *runtime) {
  for (size_t index = 0U; index < runtime->max_operations; ++index) {
    pocketjs_net_esp_runtime_slot_t *slot = &runtime->slots[index];
    if (!slot->initialized) {
      continue;
    }
    if (slot->transport_detached_awaiting_confirm || slot->event_pending ||
        slot->lease_state != POCKETJS_NET_ESP_RUNTIME_LEASE_NONE ||
        !pocketjs_net_http_client_core_is_quiescent(slot->core) ||
        (slot->transport != NULL &&
         !pocketjs_net_esp_transport_is_quiescent(slot->transport))) {
      return false;
    }
  }
  return true;
}

static void pump_slots(pocketjs_net_esp_runtime_t *runtime, uint64_t now_us,
                       uint32_t max_native_steps,
                       uint32_t max_transport_completions) {
  uint32_t native_remaining = max_native_steps;
  uint32_t completion_remaining = max_transport_completions;
  while (native_remaining != 0U || completion_remaining != 0U) {
    bool visited = false;
    for (size_t offset = 0U; offset < runtime->max_operations; ++offset) {
      const size_t index =
          (runtime->pump_cursor + offset) % runtime->max_operations;
      pocketjs_net_esp_runtime_slot_t *slot = &runtime->slots[index];
      if (!slot->initialized || slot->transport == NULL) {
        continue;
      }
      const size_t native = native_remaining != 0U ? 1U : 0U;
      const size_t completions = completion_remaining != 0U ? 1U : 0U;
      const bool pumped = pocketjs_net_http_client_core_pump(
          slot->core, now_us, native, completions);
      if (!pumped) {
        pocketjs_net_esp_runtime_poison(runtime,
                                        POCKETJS_NET_ESP_RUNTIME_POISON_CORE);
      }
      observe_core_status(runtime, slot);
      native_remaining -= (uint32_t)native;
      completion_remaining -= (uint32_t)completions;
      runtime->pump_cursor = (index + 1U) % runtime->max_operations;
      visited = true;
      break;
    }
    if (!visited) {
      break;
    }
  }
}

static uint32_t cleanup_native_events(pocketjs_net_esp_runtime_t *runtime,
                                      uint32_t maximum_events) {
  uint32_t cleaned = 0U;
  while (cleaned < maximum_events) {
    bool found = false;
    for (size_t offset = 0U; offset < runtime->max_operations; ++offset) {
      const size_t index =
          (runtime->completion_cursor + offset) % runtime->max_operations;
      pocketjs_net_esp_runtime_slot_t *slot = &runtime->slots[index];
      if (!slot->initialized || slot->transport_detached_awaiting_confirm) {
        continue;
      }
      if (!slot->event_pending &&
          !pocketjs_net_http_client_core_take_event(slot->core, &slot->event)) {
        continue;
      }
      slot->event_pending = true;
      runtime->completion_cursor = (index + 1U) % runtime->max_operations;
      found = true;
      if (!cleanup_pending_event(runtime, slot)) {
        return cleaned;
      }
      ++cleaned;
      break;
    }
    if (!found) {
      break;
    }
  }
  return cleaned;
}

/*
 * A poisoned Core may retain transport ownership for audit until its
 * dedicated transport has been synchronously destroyed and acknowledged.
 * This is native phase-2 cleanup; it never calls the Guest.
 */
static void teardown_poisoned_transports(pocketjs_net_esp_runtime_t *runtime) {
  for (size_t index = 0U; index < runtime->max_operations; ++index) {
    pocketjs_net_esp_runtime_slot_t *slot = &runtime->slots[index];
    if (!slot->initialized) {
      continue;
    }
    if (slot->transport_detached_awaiting_confirm) {
      if (!pocketjs_net_http_client_core_confirm_transport_shutdown(
              slot->core)) {
        pocketjs_net_esp_runtime_poison(
            runtime, POCKETJS_NET_ESP_RUNTIME_POISON_SHUTDOWN);
        continue;
      }
      slot->transport_detached_awaiting_confirm = false;
      continue;
    }
    pocketjs_net_http_client_core_status_t status = {0};
    if (!pocketjs_net_http_client_core_get_status(slot->core, &status)) {
      pocketjs_net_esp_runtime_poison(runtime,
                                      POCKETJS_NET_ESP_RUNTIME_POISON_SHUTDOWN);
      continue;
    }
    if (!status.poisoned) {
      continue;
    }
    if (slot->transport != NULL) {
      const bool quiescent =
          pocketjs_net_esp_transport_is_quiescent(slot->transport);
      esp_err_t result =
          quiescent
              ? pocketjs_net_esp_transport_destroy(slot->transport)
              : pocketjs_net_esp_transport_destroy_poisoned(slot->transport);
      if (result != ESP_OK) {
        if (result != ESP_ERR_NOT_FINISHED) {
          pocketjs_net_esp_runtime_poison(
              runtime, POCKETJS_NET_ESP_RUNTIME_POISON_SHUTDOWN);
        }
        continue;
      }
      slot->transport = NULL;
      slot->transport_detached_awaiting_confirm = true;
    }
    if (!pocketjs_net_http_client_core_confirm_transport_shutdown(slot->core)) {
      pocketjs_net_esp_runtime_poison(runtime,
                                      POCKETJS_NET_ESP_RUNTIME_POISON_SHUTDOWN);
      continue;
    }
    slot->transport_detached_awaiting_confirm = false;
  }
}

static void
advance_shutdown_phase(pocketjs_net_esp_runtime_t *runtime, uint32_t max_events,
                       pocketjs_net_esp_runtime_service_result_t *out_result) {
  teardown_poisoned_transports(runtime);
  (void)cleanup_native_events(runtime, max_events);
  runtime->phase = POCKETJS_NET_ESP_RUNTIME_PHASE_QUIESCING;
  if (runtime->shutdown_dispatch_drained && native_quiescent(runtime)) {
    runtime->phase = POCKETJS_NET_ESP_RUNTIME_PHASE_READY_TO_DESTROY;
    out_result->status = POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_DRAINED;
  }
}

esp_err_t pocketjs_net_esp_runtime_service(
    pocketjs_net_esp_runtime_t *runtime, uint64_t now_us,
    uint32_t max_native_steps, uint32_t max_transport_completions,
    uint32_t max_events, uint32_t max_payload_bytes,
    pocketjs_net_esp_runtime_service_result_t *out_result) {
  if (!pocketjs_net_esp_runtime_is_owner(runtime) || now_us == 0U ||
      max_events == 0U || max_payload_bytes == 0U || out_result == NULL ||
      runtime->service_call_active || runtime->binding_call_active ||
      runtime->permission_call_active ||
      runtime->phase == POCKETJS_NET_ESP_RUNTIME_PHASE_READY_TO_DESTROY) {
    return ESP_ERR_INVALID_ARG;
  }
  runtime->service_call_active = true;
  pump_slots(runtime, now_us, max_native_steps, max_transport_completions);
  const pocketjs_network_v1_service_turn_kind_t kind =
      runtime->phase == POCKETJS_NET_ESP_RUNTIME_PHASE_RUNNING
          ? POCKETJS_NETWORK_V1_SERVICE_TURN_KIND_NETWORK
          : POCKETJS_NETWORK_V1_SERVICE_TURN_KIND_SHUTDOWN;
  if (kind == POCKETJS_NETWORK_V1_SERVICE_TURN_KIND_SHUTDOWN &&
      (runtime->poison_flags != 0U || !runtime->dispatcher_registered)) {
    (void)cleanup_native_events(runtime, max_events);
    *out_result = (pocketjs_net_esp_runtime_service_result_t){
        .status = POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_MORE_READY,
    };
    runtime->shutdown_dispatch_drained = true;
    runtime->service_call_active = false;
    advance_shutdown_phase(runtime, max_events, out_result);
    return ESP_OK;
  }
  esp_err_t result = pocketjs_net_esp_runtime_call_dispatcher(
      runtime, kind, max_events, max_payload_bytes, out_result);
  runtime->service_call_active = false;
  if (result != ESP_OK) {
    pocketjs_net_esp_runtime_poison(runtime,
                                    POCKETJS_NET_ESP_RUNTIME_POISON_QUICKJS);
    if (kind == POCKETJS_NETWORK_V1_SERVICE_TURN_KIND_SHUTDOWN) {
      (void)cleanup_native_events(runtime, max_events);
      *out_result = (pocketjs_net_esp_runtime_service_result_t){
          .status = POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_MORE_READY,
      };
      runtime->shutdown_dispatch_drained = true;
      advance_shutdown_phase(runtime, max_events, out_result);
    }
    return result;
  }
  if (kind == POCKETJS_NETWORK_V1_SERVICE_TURN_KIND_SHUTDOWN) {
    runtime->shutdown_dispatch_drained =
        out_result->status == POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_DRAINED;
    advance_shutdown_phase(runtime, max_events, out_result);
  }
  return ESP_OK;
}

esp_err_t
pocketjs_net_esp_runtime_begin_shutdown(pocketjs_net_esp_runtime_t *runtime,
                                        uint64_t now_us) {
  if (!pocketjs_net_esp_runtime_is_owner(runtime) || now_us == 0U ||
      runtime->service_call_active || runtime->binding_call_active ||
      runtime->permission_call_active) {
    return ESP_ERR_INVALID_ARG;
  }
  if (runtime->phase != POCKETJS_NET_ESP_RUNTIME_PHASE_RUNNING) {
    return ESP_ERR_INVALID_STATE;
  }
  runtime->phase = POCKETJS_NET_ESP_RUNTIME_PHASE_SHUTDOWN_REQUESTED;
  for (size_t index = 0U; index < runtime->max_operations; ++index) {
    pocketjs_net_esp_runtime_slot_t *slot = &runtime->slots[index];
    if (!slot->initialized) {
      continue;
    }
    if (slot->event_pending) {
      (void)cleanup_pending_event(runtime, slot);
    }
    if (!pocketjs_net_http_client_core_begin_shutdown(slot->core, now_us)) {
      pocketjs_net_esp_runtime_poison(runtime,
                                      POCKETJS_NET_ESP_RUNTIME_POISON_SHUTDOWN);
    }
    observe_core_status(runtime, slot);
    pocketjs_net_esp_transport_begin_shutdown(slot->transport);
  }
  pocketjs_net_esp_runtime_signal(runtime);
  return ESP_OK;
}

bool pocketjs_net_esp_runtime_is_ready_to_destroy(
    const pocketjs_net_esp_runtime_t *runtime) {
  return pocketjs_net_esp_runtime_is_owner(runtime) &&
         runtime->phase == POCKETJS_NET_ESP_RUNTIME_PHASE_READY_TO_DESTROY;
}

esp_err_t
pocketjs_net_esp_runtime_destroy(pocketjs_net_esp_runtime_t *runtime) {
  if (!pocketjs_net_esp_runtime_is_owner(runtime) ||
      runtime->phase != POCKETJS_NET_ESP_RUNTIME_PHASE_READY_TO_DESTROY ||
      runtime->service_call_active || runtime->dispatcher_call_active ||
      runtime->binding_call_active || runtime->permission_call_active) {
    return ESP_ERR_INVALID_STATE;
  }
  for (size_t index = 0U; index < runtime->max_operations; ++index) {
    pocketjs_net_esp_runtime_slot_t *slot = &runtime->slots[index];
    if (!slot->initialized) {
      continue;
    }
    if (slot->transport != NULL) {
      esp_err_t result = pocketjs_net_esp_transport_destroy(slot->transport);
      if (result != ESP_OK) {
        return result;
      }
      slot->transport = NULL;
    }
    if (slot->core != NULL) {
      if (!pocketjs_net_http_client_core_confirm_transport_shutdown(
              slot->core) ||
          !pocketjs_net_http_client_core_deinit(slot->core)) {
        return ESP_ERR_INVALID_STATE;
      }
      slot->core = NULL;
    }
    slot->initialized = false;
  }
  pocketjs_net_esp_runtime_revoke_binding(runtime);
  memset(runtime->pinned_ca, 0, sizeof(runtime->pinned_ca));
  runtime->magic = 0U;
  free(runtime);
  return ESP_OK;
}

esp_err_t pocketjs_net_esp_runtime_get_stats(
    pocketjs_net_esp_runtime_t *runtime,
    pocketjs_net_esp_runtime_stats_t *out_stats) {
  if (!pocketjs_net_esp_runtime_is_owner(runtime) || out_stats == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  *out_stats = (pocketjs_net_esp_runtime_stats_t){
      .phase = runtime->phase,
      .runtime_generation = runtime->runtime_generation,
      .configured_operation_slots = runtime->max_operations,
      .last_command_sequence = runtime->command_sequence,
      .last_completion_sequence = runtime->completion_sequence,
      .last_service_turn = runtime->service_turn,
      .requests_started = runtime->requests_started,
      .completions_delivered = runtime->completions_delivered,
      .leases_taken = runtime->leases_taken,
      .leases_released = runtime->leases_released,
      .leases_cleaned_up = runtime->leases_cleaned_up,
      .permission_checks = runtime->permission_checks,
      .poison_flags = runtime->poison_flags,
      .runtime_instance_bytes = sizeof(*runtime) + sizeof(runtime->slots[0]) *
                                                       runtime->max_operations,
      .core_storage_bytes = sizeof(pocketjs_net_http_client_core_storage_t) *
                            runtime->max_operations,
      .admitted_native_buffer_bytes =
          (size_t)runtime->limits.native_buffer_bytes.default_value,
  };
  for (size_t index = 0U; index < runtime->max_operations; ++index) {
    const pocketjs_net_esp_runtime_slot_t *slot = &runtime->slots[index];
    if (slot->initialized) {
      ++out_stats->initialized_operation_slots;
      pocketjs_net_http_client_core_status_t core_status = {0};
      if (pocketjs_net_http_client_core_get_status(slot->core, &core_status) &&
          core_status.poisoned) {
        if (out_stats->poisoned_core_slots == 0U) {
          out_stats->first_core_poison_cause_code =
              core_status.first_poison_cause_code;
        }
        ++out_stats->poisoned_core_slots;
        out_stats->core_poison_flags |= core_status.poison_flags;
      }
    }
    if (slot->transport != NULL) {
      ++out_stats->transport_instances;
    }
    if (slot->active) {
      ++out_stats->active_operations;
    }
    if (slot->event_pending) {
      ++out_stats->pending_core_events;
    }
    if (slot->lease_state == POCKETJS_NET_ESP_RUNTIME_LEASE_QUEUED) {
      ++out_stats->queued_leases;
    } else if (slot->lease_state == POCKETJS_NET_ESP_RUNTIME_LEASE_TAKEN) {
      ++out_stats->taken_leases;
    }
  }
  const pocketjs_net_esp_transport_descriptor_t *transport =
      pocketjs_net_esp_transport_descriptor();
  size_t transport_bytes = 0U;
  size_t owned_bytes = 0U;
  if (transport != NULL &&
      checked_size_multiply(transport->pocketjs_owned_instance_bytes,
                            out_stats->transport_instances, &transport_bytes) &&
      checked_size_add(out_stats->runtime_instance_bytes,
                       sizeof(pocketjs_net_esp_runtime_binding_state_t),
                       &owned_bytes) &&
      checked_size_add(owned_bytes, transport_bytes, &owned_bytes)) {
    out_stats->pocketjs_owned_native_bytes = owned_bytes;
  }
  return ESP_OK;
}
