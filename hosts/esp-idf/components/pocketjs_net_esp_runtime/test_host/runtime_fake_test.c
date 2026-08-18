// SPDX-License-Identifier: MIT

#include <assert.h>
#include <stdlib.h>
#include <string.h>

#include "runtime_internal.h"

struct JSContext {
  unsigned marker;
};

struct pocketjs_esp_guest {
  JSContext *context;
};

struct pocketjs_net_esp_transport {
  bool shutdown;
  bool quiescent;
  bool completion_retire_stuck;
  size_t shutdown_pumps_remaining;
};

struct pocketjs_net_http_client_core {
  pocketjs_net_http_client_core_config_t config;
  pocketjs_net_http_client_operation_token_t operation_token;
  bool active;
  bool shutdown;
  bool event_pending;
  bool event_delivering;
  bool upload_credit;
  bool response_credit;
  bool lease_released;
  bool transport_confirmed;
  bool poison_on_shutdown;
  bool poisoned;
  size_t transport_destroys_at_init;
  uint64_t transport_confirm_order;
  uint64_t terminal_retire_order;
  uint64_t terminal_abandon_order;
  uint64_t upload_body_generation;
  uint64_t upload_pull_generation;
  size_t upload_maximum;
  pocketjs_net_http_client_event_t event;
  uint8_t lease_bytes[8];
  size_t lease_length;
};

static JSContext FAKE_CONTEXT = {.marker = 1U};
static TaskHandle_t const OWNER_TASK = (TaskHandle_t)(uintptr_t)0x1234U;
static size_t transport_creates;
static size_t transport_destroys;
static size_t core_starts;
static pocketjs_net_http_client_redirect_mode_t last_core_redirect_mode;
static uint16_t last_core_max_redirects;
static size_t wake_count;
static size_t permission_count;
static bool fake_core_descriptor_drift;
static bool fake_transport_tls_descriptor_drift;

const pocketjs_net_esp_transport_descriptor_t *
pocketjs_net_esp_transport_descriptor(void) {
  static pocketjs_net_esp_transport_descriptor_t descriptor = {
      .id = POCKETJS_NET_ESP_TRANSPORT_ID,
      .implementation_version = "fake-1",
      .experimental = true,
      .advertises_public_capability = false,
      .ipv4 = true,
      .asynchronous_raw_dns = true,
      .stock_lwip_dns_callbacks_only = true,
      .rejects_saturated_dns_candidate_prefix = true,
      .dns_cancel_generation_cleanup = true,
      .synchronous_getaddrinfo_for_hostname = false,
      .nonblocking_plain_tcp_steps = true,
      .monotonic_deadlines = true,
      .cancel_between_native_steps = true,
      .worker_or_callback_calls_quickjs = false,
      .exact_one_terminal = true,
      .aba_safe_tokens = true,
      .fixed_operation_pool = true,
      .fixed_completion_pool = true,
      .fixed_payload_pool = true,
      .tls_compiled = true,
      .tls_1_2_only = true,
      .host_trust = true,
      .host_pinned_ca = true,
      .hostname_verification = true,
      .distinct_tls_errors = true,
      .sni = true,
      .trusted_wall_clock_required = true,
      .plaintext_fallback = false,
      .renegotiation = false,
      .early_data = false,
      .tls_close_notify = true,
      .tls_close_notify_uses_operation_deadline = true,
      .tls_close_notify_waits_for_peer = false,
      .pocketjs_owned_instance_bytes =
          sizeof(struct pocketjs_net_esp_transport),
      .max_connections = 1U,
      .max_operations = 1U,
      .completion_capacity = 1U,
      .max_dns_candidates = 1U,
      .max_write_bytes = POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES,
      .read_lease_bytes = POCKETJS_NET_HTTP_CLIENT_CORE_BODY_LEASE_BYTES,
  };
  descriptor.tls_close_notify = !fake_transport_tls_descriptor_drift;
  return &descriptor;
}

const pocketjs_net_http_client_core_descriptor_t *
pocketjs_net_http_client_core_descriptor(void) {
  static pocketjs_net_http_client_core_descriptor_t descriptor = {
      .id = POCKETJS_NET_HTTP_CLIENT_CORE_ID,
      .experimental = true,
      .advertises_public_capability = false,
      .plaintext_http = true,
      .https_fail_closed_before_io = true,
      .https_explicit_opt_in = true,
      .owner_pumped = true,
      .one_operation = true,
      .fixed_core_storage = true,
      .headers_first = true,
      .explicit_body_credit = true,
      .explicit_body_lease = true,
      .connection_reuse = true,
      .bounded_connection_pool = true,
      .redirects_followed = true,
      .redirect_manual = true,
      .redirect_error = true,
      .redirect_fixed_body_replay = true,
      .redirect_streaming_body_replay = false,
      .connect_error_candidate_fallback = true,
      .hidden_retry = false,
      .hidden_auth = false,
      .hidden_cookie_store = false,
      .proxy = false,
      .content_decoding = false,
      .cleanup_faults_separate_from_terminal = true,
      .poison_is_machine_readable = true,
      .explicit_shutdown_lifecycle = true,
      .fixed_request_body = true,
      .streaming_request_body = true,
      .chunked_request_body = true,
      .known_length_streaming_request_body = true,
      .streaming_request_body_buffered_in_full = false,
      .instance_bytes = POCKETJS_NET_HTTP_CLIENT_CORE_INSTANCE_BYTES,
      .max_request_body_bytes =
          POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REQUEST_BODY_BYTES,
      .max_fixed_request_body_bytes =
          POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REQUEST_BODY_BYTES,
      .max_request_body_chunk_bytes =
          POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES,
      .body_lease_bytes = POCKETJS_NET_HTTP_CLIENT_CORE_BODY_LEASE_BYTES,
      .max_cached_connections = 1U,
  };
  descriptor.connection_reuse = !fake_core_descriptor_drift;
  return &descriptor;
}
static size_t dispatcher_calls;
static int64_t fake_now_us = 1000;
static size_t next_transport_shutdown_pumps;
static bool fail_next_event_retirement;
static bool fail_next_dispatcher_call;
static bool saw_native_only_pump;
static bool saw_completion_only_pump;
static bool saw_combined_pump;
static bool next_core_poison_on_shutdown;
static bool next_transport_completion_retire_stuck;
static bool fail_next_transport_confirmation;
static bool poisoned_transport_detached;
static bool fail_event_retirement_persistently;
static uint64_t teardown_order;
static uint64_t last_transport_destroy_order;
static size_t poisoned_transport_destroys;
static size_t poisoned_events_abandoned;
static bool expect_tls_profile;
static bool expect_tls_request;
static const uint8_t *tls_ca_source;
static pocketjs_net_http_client_scheme_t expected_permission_scheme =
    POCKETJS_NET_HTTP_CLIENT_SCHEME_HTTP;
static unsigned tls_clock_context;
static const uint8_t EXPECTED_TLS_CA[] = {'t', 'e', 's', 't', '-', 'c', 'a'};

TaskHandle_t xTaskGetCurrentTaskHandle(void) { return OWNER_TASK; }

int64_t esp_timer_get_time(void) { return ++fake_now_us; }

JSContext *pocketjs_esp_guest_context(pocketjs_esp_guest_t *guest) {
  return guest == NULL ? NULL : guest->context;
}

static void fake_wake(void *context) {
  assert(context == &wake_count);
  ++wake_count;
}

static bool
fake_permission(void *context,
                const pocketjs_net_http_client_endpoint_t *endpoint) {
  assert(context == &permission_count);
  assert(endpoint != NULL);
  assert(endpoint->scheme == expected_permission_scheme);
  ++permission_count;
  return true;
}

static bool fake_wall_clock_trusted(void *context) {
  assert(context == &tls_clock_context);
  return true;
}

esp_err_t pocketjs_net_esp_transport_validate_config(
    const pocketjs_net_esp_transport_config_t *config) {
  if (config == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  if (!expect_tls_profile) {
    return config->tls_trust_source == POCKETJS_NET_ESP_TLS_TRUST_DISABLED &&
                   config->host_pinned_ca_pem == NULL &&
                   config->host_pinned_ca_pem_bytes == 0U &&
                   config->wall_clock_trusted == NULL
               ? ESP_OK
               : ESP_ERR_INVALID_ARG;
  }
  return config->tls_trust_source ==
                     POCKETJS_NET_ESP_TLS_TRUST_HOST_PINNED_CA &&
                 config->host_pinned_ca_pem != NULL &&
                 config->host_pinned_ca_pem != tls_ca_source &&
                 config->host_pinned_ca_pem_bytes == sizeof(EXPECTED_TLS_CA) &&
                 memcmp(config->host_pinned_ca_pem, EXPECTED_TLS_CA,
                        sizeof(EXPECTED_TLS_CA)) == 0 &&
                 config->wall_clock_trusted == fake_wall_clock_trusted &&
                 config->wall_clock_context == &tls_clock_context
             ? ESP_OK
             : ESP_ERR_INVALID_ARG;
}

esp_err_t pocketjs_net_esp_transport_create(
    const pocketjs_net_esp_transport_config_t *config,
    pocketjs_net_esp_transport_t **out_transport) {
  assert(config != NULL);
  assert(pocketjs_net_esp_transport_validate_config(config) == ESP_OK);
  assert(out_transport != NULL && *out_transport == NULL);
  *out_transport = calloc(1U, sizeof(**out_transport));
  if (*out_transport == NULL) {
    return ESP_ERR_NO_MEM;
  }
  (*out_transport)->shutdown_pumps_remaining = next_transport_shutdown_pumps;
  (*out_transport)->completion_retire_stuck =
      next_transport_completion_retire_stuck;
  next_transport_completion_retire_stuck = false;
  ++transport_creates;
  return ESP_OK;
}

void pocketjs_net_esp_transport_begin_shutdown(
    pocketjs_net_esp_transport_t *transport) {
  assert(transport != NULL);
  transport->shutdown = true;
  transport->quiescent = transport->shutdown_pumps_remaining == 0U &&
                         !transport->completion_retire_stuck;
}

bool pocketjs_net_esp_transport_is_quiescent(
    const pocketjs_net_esp_transport_t *transport) {
  return transport != NULL && transport->shutdown && transport->quiescent;
}

esp_err_t
pocketjs_net_esp_transport_destroy(pocketjs_net_esp_transport_t *transport) {
  if (!pocketjs_net_esp_transport_is_quiescent(transport)) {
    return ESP_ERR_INVALID_STATE;
  }
  last_transport_destroy_order = ++teardown_order;
  ++transport_destroys;
  free(transport);
  return ESP_OK;
}

esp_err_t pocketjs_net_esp_transport_destroy_poisoned(
    pocketjs_net_esp_transport_t *transport) {
  if (transport == NULL || !transport->shutdown) {
    return ESP_ERR_INVALID_STATE;
  }
  last_transport_destroy_order = ++teardown_order;
  ++transport_destroys;
  ++poisoned_transport_destroys;
  assert(!poisoned_transport_detached);
  poisoned_transport_detached = true;
  free(transport);
  return ESP_OK;
}

static const pocketjs_net_http_client_transport_ops_t FAKE_TRANSPORT_OPS = {0};

const pocketjs_net_http_client_transport_ops_t *
pocketjs_net_http_client_core_esp_transport_ops(void) {
  return &FAKE_TRANSPORT_OPS;
}

pocketjs_net_http_client_start_result_t pocketjs_net_http_client_core_init(
    pocketjs_net_http_client_core_storage_t *storage,
    const pocketjs_net_http_client_core_config_t *config,
    pocketjs_net_http_client_core_t **out_core) {
  assert(storage != NULL && config != NULL && out_core != NULL);
  assert(sizeof(struct pocketjs_net_http_client_core) <= sizeof(*storage));
  struct pocketjs_net_http_client_core *core = (void *)storage;
  memset(core, 0, sizeof(*core));
  core->config = *config;
  assert(core->config.allow_https == expect_tls_profile);
  core->poison_on_shutdown = next_core_poison_on_shutdown;
  core->transport_destroys_at_init = transport_destroys;
  next_core_poison_on_shutdown = false;
  *out_core = core;
  return POCKETJS_NET_HTTP_CLIENT_START_OK;
}

pocketjs_net_http_client_start_result_t pocketjs_net_http_client_core_start(
    pocketjs_net_http_client_core_t *core,
    const pocketjs_net_http_client_request_t *request, uint64_t now_us) {
  assert(core != NULL && request != NULL && now_us != 0U);
  assert(!core->active && !core->shutdown);
  assert(request->operation_token != 0U);
  assert(request->body_kind == POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_NONE ||
         request->body_kind == POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_STREAMING);
  const bool tls = request->tls != NULL;
  assert(tls == expect_tls_request);
  if (tls) {
    assert(request->tls->minimum_version ==
               POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_2 &&
           request->tls->maximum_version ==
               POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_2 &&
           request->tls->server_name.length == sizeof("example.test") - 1U &&
           memcmp(request->tls->server_name.data, "example.test",
                  sizeof("example.test") - 1U) == 0);
  }
  const pocketjs_net_http_client_endpoint_t hostname = {
      .phase = POCKETJS_NET_HTTP_CLIENT_PERMISSION_HOSTNAME,
      .scheme = tls ? POCKETJS_NET_HTTP_CLIENT_SCHEME_HTTPS
                    : POCKETJS_NET_HTTP_CLIENT_SCHEME_HTTP,
      .hostname = "example.test",
      .port = tls ? 443U : 80U,
  };
  const pocketjs_net_http_client_endpoint_t numeric = {
      .phase = POCKETJS_NET_HTTP_CLIENT_PERMISSION_NUMERIC_CANDIDATE,
      .scheme = hostname.scheme,
      .hostname = "example.test",
      .port = hostname.port,
      .ipv4_be = UINT32_C(0x7f000001),
  };
  if (!core->config.allow_endpoint(core->config.permission_context,
                                   &hostname) ||
      !core->config.allow_endpoint(core->config.permission_context, &numeric)) {
    return POCKETJS_NET_HTTP_CLIENT_START_FORBIDDEN_REQUEST;
  }
  core->operation_token = request->operation_token;
  core->active = true;
  last_core_redirect_mode = request->redirect_mode;
  last_core_max_redirects = request->max_redirects;
  ++core_starts;
  return POCKETJS_NET_HTTP_CLIENT_START_OK;
}

bool pocketjs_net_http_client_core_abort(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_operation_token_t operation_token) {
  return core != NULL && core->active &&
         core->operation_token == operation_token;
}

bool pocketjs_net_http_client_core_get_status(
    const pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_core_status_t *out_status) {
  assert(!poisoned_transport_detached);
  if (core == NULL || out_status == NULL) {
    return false;
  }
  *out_status = (pocketjs_net_http_client_core_status_t){
      .initialized = true,
      .shutdown_requested = core->shutdown,
      .poisoned = core->poisoned,
      .quiescent = pocketjs_net_http_client_core_is_quiescent(core),
      .request_active = core->active,
      .connection_owned = core->poisoned && !core->transport_confirmed,
      .completion_retire_pending = core->poisoned && !core->transport_confirmed,
      .event_outstanding = core->event_pending || core->event_delivering,
      .poison_flags = core->poisoned
                          ? POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_COMPLETION
                          : POCKETJS_NET_HTTP_CLIENT_POISON_NONE,
      .first_poison_cause_code = core->poisoned ? -123 : 0,
      .operation_token = core->operation_token,
  };
  return true;
}

bool pocketjs_net_http_client_core_pump(pocketjs_net_http_client_core_t *core,
                                        uint64_t now_us,
                                        size_t max_native_steps,
                                        size_t max_transport_completions) {
  assert(!poisoned_transport_detached);
  if (core == NULL || now_us == 0U) {
    return false;
  }
  if (max_native_steps == 0U && max_transport_completions == 0U) {
    return false;
  }
  saw_native_only_pump |=
      max_native_steps != 0U && max_transport_completions == 0U;
  saw_completion_only_pump |=
      max_native_steps == 0U && max_transport_completions != 0U;
  saw_combined_pump |=
      max_native_steps != 0U && max_transport_completions != 0U;
  pocketjs_net_esp_transport_t *transport = core->config.transport_context;
  if (transport != NULL && transport->shutdown && !transport->quiescent &&
      (max_native_steps != 0U || max_transport_completions != 0U)) {
    if (!transport->completion_retire_stuck) {
      assert(transport->shutdown_pumps_remaining != 0U);
      --transport->shutdown_pumps_remaining;
      transport->quiescent = transport->shutdown_pumps_remaining == 0U;
    }
  }
  return true;
}

bool pocketjs_net_http_client_core_grant_body_credit(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_operation_token_t operation_token,
    size_t maximum_bytes) {
  if (core == NULL || !core->active || core->response_credit ||
      core->operation_token != operation_token || maximum_bytes == 0U) {
    return false;
  }
  core->response_credit = true;
  return true;
}

bool pocketjs_net_http_client_core_submit_request_body_chunk(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_operation_token_t operation_token,
    uint64_t body_generation, uint64_t pull_generation, const uint8_t *bytes,
    size_t length) {
  if (core == NULL || !core->upload_credit || bytes == NULL || length == 0U ||
      length > core->upload_maximum ||
      core->operation_token != operation_token ||
      core->upload_body_generation != body_generation ||
      core->upload_pull_generation != pull_generation) {
    return false;
  }
  core->upload_credit = false;
  return true;
}

bool pocketjs_net_http_client_core_submit_request_body_end(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_operation_token_t operation_token,
    uint64_t body_generation, uint64_t pull_generation) {
  static const uint8_t ignored = 0U;
  return pocketjs_net_http_client_core_submit_request_body_chunk(
      core, operation_token, body_generation, pull_generation, &ignored, 1U);
}

bool pocketjs_net_http_client_core_submit_request_body_error(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_operation_token_t operation_token,
    uint64_t body_generation, uint64_t pull_generation, int32_t cause_code) {
  return cause_code != 0 &&
         pocketjs_net_http_client_core_submit_request_body_end(
             core, operation_token, body_generation, pull_generation);
}

bool pocketjs_net_http_client_core_take_event(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_event_t *out_event) {
  if (core == NULL || out_event == NULL || !core->event_pending ||
      core->event_delivering) {
    return false;
  }
  *out_event = core->event;
  core->event_delivering = true;
  return true;
}

bool pocketjs_net_http_client_core_retire_event(
    pocketjs_net_http_client_core_t *core, uint64_t sequence) {
  if (core == NULL || !core->event_delivering ||
      core->event.sequence != sequence ||
      (core->event.type == POCKETJS_NET_HTTP_CLIENT_EVENT_BODY &&
       !core->lease_released)) {
    return false;
  }
  if (fail_event_retirement_persistently || fail_next_event_retirement) {
    fail_next_event_retirement = false;
    return false;
  }
  if (core->event.type == POCKETJS_NET_HTTP_CLIENT_EVENT_REQUEST_BODY_PULL) {
    core->upload_body_generation =
        core->event.detail.request_body_pull.body_generation;
    core->upload_pull_generation =
        core->event.detail.request_body_pull.pull_generation;
    core->upload_maximum = core->event.detail.request_body_pull.maximum_bytes;
    core->upload_credit = true;
  } else if (core->event.type == POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE ||
             core->event.type == POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR) {
    core->active = false;
    if (core->poisoned && core->transport_confirmed) {
      core->terminal_retire_order = ++teardown_order;
    }
  }
  core->event_pending = false;
  core->event_delivering = false;
  return true;
}

bool pocketjs_net_http_client_core_body_lease_view(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_body_lease_t lease, const uint8_t **out_bytes,
    size_t *out_length) {
  if (core == NULL || out_bytes == NULL || out_length == NULL ||
      !core->event_delivering || core->lease_released ||
      core->event.detail.body.lease.slot != lease.slot ||
      core->event.detail.body.lease.generation != lease.generation) {
    return false;
  }
  *out_bytes = core->lease_bytes;
  *out_length = core->lease_length;
  return true;
}

bool pocketjs_net_http_client_core_release_body_lease(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_body_lease_t lease) {
  if (core == NULL || !core->event_delivering || core->lease_released ||
      core->event.detail.body.lease.slot != lease.slot ||
      core->event.detail.body.lease.generation != lease.generation) {
    return false;
  }
  core->lease_released = true;
  return true;
}

bool pocketjs_net_http_client_core_begin_shutdown(
    pocketjs_net_http_client_core_t *core, uint64_t now_us) {
  if (core == NULL || core->shutdown || now_us == 0U) {
    return false;
  }
  core->shutdown = true;
  core->poisoned = core->poison_on_shutdown;
  return true;
}

bool pocketjs_net_http_client_core_is_quiescent(
    const pocketjs_net_http_client_core_t *core) {
  assert(!poisoned_transport_detached);
  return core != NULL && core->shutdown &&
         (!core->poisoned || core->transport_confirmed) && !core->active &&
         !core->event_pending && !core->event_delivering;
}

bool pocketjs_net_http_client_core_confirm_transport_shutdown(
    pocketjs_net_http_client_core_t *core) {
  if (core == NULL || !core->shutdown) {
    return false;
  }
  if (core->transport_confirmed) {
    return true;
  }
  if (core->poisoned) {
    if (transport_destroys != core->transport_destroys_at_init + 1U ||
        last_transport_destroy_order == 0U) {
      return false;
    }
    if (fail_next_transport_confirmation) {
      fail_next_transport_confirmation = false;
      return false;
    }
    assert(poisoned_transport_detached);
    poisoned_transport_detached = false;
    core->transport_confirmed = true;
    core->transport_confirm_order = ++teardown_order;
    assert(last_transport_destroy_order < core->transport_confirm_order);
    assert(core->active && !core->event_pending && !core->event_delivering);
    core->event = (pocketjs_net_http_client_event_t){
        .type = POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR,
        .sequence = 501U,
        .operation_token = core->operation_token,
        .detail.error =
            {
                .code = POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT,
            },
    };
    core->event_pending = true;
    return true;
  }
  if (!pocketjs_net_http_client_core_is_quiescent(core)) {
    return false;
  }
  core->transport_confirmed = true;
  return true;
}

bool pocketjs_net_http_client_core_report_host_event_retire_failure(
    pocketjs_net_http_client_core_t *core, uint64_t sequence) {
  if (core == NULL || !core->event_delivering ||
      core->event.sequence != sequence) {
    return false;
  }
  core->poisoned = true;
  return true;
}

bool pocketjs_net_http_client_core_abandon_event_after_transport_shutdown(
    pocketjs_net_http_client_core_t *core, uint64_t sequence) {
  if (core == NULL || !core->shutdown || !core->poisoned ||
      !core->transport_confirmed || !core->event_delivering ||
      core->event.sequence != sequence) {
    return false;
  }
  const pocketjs_net_http_client_event_type_t type = core->event.type;
  core->event_pending = false;
  core->event_delivering = false;
  core->lease_released = false;
  if (type == POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE ||
      type == POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR) {
    core->active = false;
    core->terminal_abandon_order = ++teardown_order;
  }
  ++poisoned_events_abandoned;
  return true;
}

bool pocketjs_net_http_client_core_deinit(
    pocketjs_net_http_client_core_t *core) {
  return core != NULL && core->transport_confirmed;
}

esp_err_t
pocketjs_net_esp_runtime_create_binding(pocketjs_net_esp_runtime_t *runtime) {
  assert(runtime != NULL);
  runtime->binding = UINT64_C(42);
  return ESP_OK;
}

void pocketjs_net_esp_runtime_revoke_binding(
    pocketjs_net_esp_runtime_t *runtime) {
  assert(runtime != NULL);
  runtime->binding = JS_UNDEFINED;
  runtime->dispatcher = JS_UNDEFINED;
  runtime->dispatcher_registered = false;
}

esp_err_t pocketjs_net_esp_runtime_call_dispatcher(
    pocketjs_net_esp_runtime_t *runtime,
    pocketjs_network_v1_service_turn_kind_t kind, uint32_t max_events,
    uint32_t max_payload_bytes,
    pocketjs_net_esp_runtime_service_result_t *out_result) {
  assert(runtime != NULL);
  (void)kind;
  (void)max_events;
  (void)max_payload_bytes;
  assert(out_result != NULL);
  ++dispatcher_calls;
  if (fail_next_dispatcher_call) {
    fail_next_dispatcher_call = false;
    return ESP_FAIL;
  }
  *out_result = (pocketjs_net_esp_runtime_service_result_t){
      .status = POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_DRAINED,
  };
  return ESP_OK;
}

static void queue_event(pocketjs_net_http_client_core_t *core,
                        pocketjs_net_http_client_event_t event) {
  assert(core != NULL && core->active && !core->event_pending &&
         !core->event_delivering);
  event.operation_token = core->operation_token;
  core->event = event;
  core->event_pending = true;
  core->lease_released = false;
}

static pocketjs_network_v1_command_identity_t
identity(uint32_t operation_generation, pocketjs_network_v1_handle_t body,
         uint64_t command_sequence) {
  return (pocketjs_network_v1_command_identity_t){
      .runtime_generation = 7U,
      .resource = {POCKETJS_NET_ESP_RUNTIME_HTTP_RESOURCE_ID,
                   POCKETJS_NET_ESP_RUNTIME_HTTP_RESOURCE_GENERATION},
      .operation = {1U, operation_generation},
      .body = body,
      .command_sequence = command_sequence,
  };
}

typedef struct {
  pocketjs_net_esp_runtime_t *runtime;
  pocketjs_net_esp_runtime_slot_t *slot;
  pocketjs_net_http_client_core_t *core;
  pocketjs_network_v1_command_identity_t response_identity;
  pocketjs_network_v1_handle_t lease;
} taken_lease_fixture_t;

static taken_lease_fixture_t
start_taken_lease(const pocketjs_net_esp_runtime_config_t *config,
                  const pocketjs_net_esp_runtime_http_command_t *command) {
  pocketjs_net_esp_runtime_t *runtime = NULL;
  assert(pocketjs_net_esp_runtime_create(config, &runtime) == ESP_OK);
  assert(pocketjs_net_esp_runtime_completion_readiness(runtime) == 0);
  pocketjs_net_esp_runtime_error_t error = {0};
  pocketjs_network_v1_command_identity_t request_identity =
      identity(1U, (pocketjs_network_v1_handle_t){0U, 0U}, 1U);
  assert(pocketjs_net_esp_runtime_start_http(runtime, &request_identity,
                                             command, &error));
  assert(pocketjs_net_esp_runtime_completion_readiness(runtime) == 0);
  pocketjs_net_esp_runtime_slot_t *slot = &runtime->slots[0];
  pocketjs_net_http_client_core_t *core = slot->core;

  static const uint8_t status_text[] = "OK";
  queue_event(
      core, (pocketjs_net_http_client_event_t){
                .type = POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS,
                .sequence = 101U,
                .detail.response =
                    {
                        .status_code = 200U,
                        .status_text = {status_text, sizeof(status_text) - 1U},
                    },
            });
  assert(pocketjs_net_esp_runtime_completion_readiness(runtime) == 1);
  pocketjs_net_esp_runtime_slot_t *selected = NULL;
  assert(pocketjs_net_esp_runtime_peek_event(runtime, &selected) &&
         selected == slot);
  assert(pocketjs_net_esp_runtime_retire_nonlease_event(runtime, slot));
  assert(slot->response_body.id != 0U && slot->response_body.generation != 0U);

  pocketjs_network_v1_command_identity_t response_identity =
      identity(1U, slot->response_body, 2U);
  assert(pocketjs_net_esp_runtime_grant_body_credit(runtime, &response_identity,
                                                    3U, &error));
  memcpy(core->lease_bytes, "abc", 3U);
  core->lease_length = 3U;
  queue_event(core, (pocketjs_net_http_client_event_t){
                        .type = POCKETJS_NET_HTTP_CLIENT_EVENT_BODY,
                        .sequence = 102U,
                        .detail.body =
                            {
                                .lease = {7U, 8U},
                                .byte_count = 3U,
                            },
                    });
  assert(pocketjs_net_esp_runtime_peek_event(runtime, &selected) &&
         selected == slot &&
         slot->lease_state == POCKETJS_NET_ESP_RUNTIME_LEASE_QUEUED);
  slot->lease_descriptor_delivered = true;
  const pocketjs_network_v1_handle_t lease = slot->lease;
  uint32_t taken = 0U;
  response_identity.command_sequence = 3U;
  assert(pocketjs_net_esp_runtime_lease_take(runtime, &response_identity, lease,
                                             3U, &taken, &error));
  assert(taken == 3U &&
         slot->lease_state == POCKETJS_NET_ESP_RUNTIME_LEASE_TAKEN);
  return (taken_lease_fixture_t){
      .runtime = runtime,
      .slot = slot,
      .core = core,
      .response_identity = response_identity,
      .lease = lease,
  };
}

static void queue_shutdown_error(taken_lease_fixture_t *fixture,
                                 uint64_t event_sequence) {
  queue_event(fixture->core,
              (pocketjs_net_http_client_event_t){
                  .type = POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR,
                  .sequence = event_sequence,
                  .detail.error =
                      {
                          .code = POCKETJS_NET_HTTP_CLIENT_ERROR_ABORTED,
                      },
              });
}

static void assert_shutdown_rejects_new_work(
    pocketjs_net_esp_runtime_t *runtime,
    const pocketjs_net_esp_runtime_http_command_t *command,
    uint64_t command_sequence) {
  pocketjs_net_esp_runtime_error_t error = {0};
  pocketjs_network_v1_command_identity_t request_identity =
      identity(2U, (pocketjs_network_v1_handle_t){0U, 0U}, command_sequence);
  assert(!pocketjs_net_esp_runtime_start_http(runtime, &request_identity,
                                              command, &error));
  assert(error.code == POCKETJS_NETWORK_V1_ERROR_INVALID_STATE);
  assert(pocketjs_net_esp_runtime_begin_shutdown(runtime, 9000U) ==
         ESP_ERR_INVALID_STATE);
}

static void test_dispatcher_poison_native_fallback(
    const pocketjs_net_esp_runtime_config_t *config,
    const pocketjs_net_esp_runtime_http_command_t *command) {
  next_transport_shutdown_pumps = 2U;
  pocketjs_net_esp_runtime_t *runtime = NULL;
  assert(pocketjs_net_esp_runtime_create(config, &runtime) == ESP_OK);
  pocketjs_net_esp_runtime_error_t error = {0};
  pocketjs_network_v1_command_identity_t request_identity =
      identity(1U, (pocketjs_network_v1_handle_t){0U, 0U}, 1U);
  assert(pocketjs_net_esp_runtime_start_http(runtime, &request_identity,
                                             command, &error));
  pocketjs_net_esp_runtime_slot_t *slot = &runtime->slots[0];
  pocketjs_net_http_client_core_t *core = slot->core;

  saw_native_only_pump = false;
  saw_completion_only_pump = false;
  saw_combined_pump = false;
  pocketjs_net_esp_runtime_service_result_t service_result = {0};
  assert(pocketjs_net_esp_runtime_service(runtime, 2000U, 10U, 1U, 1U, 16U,
                                          &service_result) == ESP_OK);
  assert(saw_combined_pump && saw_native_only_pump &&
         runtime->poison_flags == 0U);
  assert(pocketjs_net_esp_runtime_service(runtime, 3000U, 0U, 1U, 1U, 16U,
                                          &service_result) == ESP_OK);
  assert(saw_completion_only_pump && runtime->poison_flags == 0U);
  saw_native_only_pump = false;
  assert(pocketjs_net_esp_runtime_service(runtime, 4000U, 1U, 0U, 1U, 16U,
                                          &service_result) == ESP_OK);
  assert(saw_native_only_pump && runtime->poison_flags == 0U);

  fail_next_dispatcher_call = true;
  const size_t dispatcher_calls_before_failure = dispatcher_calls;
  assert(pocketjs_net_esp_runtime_service(runtime, 5000U, 1U, 1U, 1U, 16U,
                                          &service_result) == ESP_FAIL);
  assert(dispatcher_calls == dispatcher_calls_before_failure + 1U);
  assert(runtime->poison_flags == POCKETJS_NET_ESP_RUNTIME_POISON_QUICKJS);

  assert(pocketjs_net_esp_runtime_begin_shutdown(runtime, 6000U) == ESP_OK);
  assert_shutdown_rejects_new_work(runtime, command, 2U);
  queue_event(core, (pocketjs_net_http_client_event_t){
                        .type = POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR,
                        .sequence = 100U,
                        .detail.error =
                            {
                                .code = POCKETJS_NET_HTTP_CLIENT_ERROR_ABORTED,
                            },
                    });

  assert(pocketjs_net_esp_runtime_service(runtime, 7000U, 1U, 1U, 1U, 16U,
                                          &service_result) == ESP_OK);
  assert(service_result.status ==
         POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_MORE_READY);
  assert(pocketjs_net_http_client_core_is_quiescent(core));
  assert(!pocketjs_net_esp_transport_is_quiescent(slot->transport));
  assert(!pocketjs_net_esp_runtime_is_ready_to_destroy(runtime));

  assert(pocketjs_net_esp_runtime_service(runtime, 8000U, 1U, 1U, 1U, 16U,
                                          &service_result) == ESP_OK);
  assert(service_result.status ==
         POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_DRAINED);
  assert(dispatcher_calls == dispatcher_calls_before_failure + 1U);
  assert(pocketjs_net_esp_runtime_is_ready_to_destroy(runtime));
  assert(pocketjs_net_esp_runtime_service(runtime, 9000U, 1U, 1U, 1U, 16U,
                                          &service_result) ==
         ESP_ERR_INVALID_ARG);

  pocketjs_net_esp_runtime_stats_t stats = {0};
  assert(pocketjs_net_esp_runtime_get_stats(runtime, &stats) == ESP_OK);
  assert(stats.active_operations == 0U && stats.requests_started == 1U &&
         stats.poison_flags == POCKETJS_NET_ESP_RUNTIME_POISON_QUICKJS);
  assert(pocketjs_net_esp_runtime_destroy(runtime) == ESP_OK);
  next_transport_shutdown_pumps = 0U;
}

static void test_released_lease_retire_failure(
    const pocketjs_net_esp_runtime_config_t *config,
    const pocketjs_net_esp_runtime_http_command_t *command) {
  next_transport_shutdown_pumps = 0U;
  taken_lease_fixture_t fixture = start_taken_lease(config, command);
  pocketjs_net_esp_runtime_error_t error = {0};
  fail_next_event_retirement = true;
  fixture.response_identity.command_sequence = 4U;
  assert(!pocketjs_net_esp_runtime_lease_release(
      fixture.runtime, &fixture.response_identity, fixture.lease, &error));
  assert(error.category == POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME &&
         error.code == POCKETJS_NETWORK_V1_ERROR_INVALID_STATE &&
         strcmp(error.operation, "http.body.lease") == 0);
  assert(fixture.slot->event_pending && fixture.core->lease_released &&
         fixture.slot->lease_state == POCKETJS_NET_ESP_RUNTIME_LEASE_RELEASED);
  assert((fixture.runtime->poison_flags &
          POCKETJS_NET_ESP_RUNTIME_POISON_LEASE) != 0U);

  pocketjs_net_esp_runtime_service_result_t service_result = {0};
  assert(pocketjs_net_esp_runtime_begin_shutdown(fixture.runtime, 6000U) ==
         ESP_OK);
  assert(!fixture.slot->event_pending &&
         fixture.slot->lease_state == POCKETJS_NET_ESP_RUNTIME_LEASE_NONE);
  assert_shutdown_rejects_new_work(fixture.runtime, command, 5U);
  queue_shutdown_error(&fixture, 103U);

  assert(pocketjs_net_esp_runtime_service(fixture.runtime, 7000U, 1U, 1U, 1U,
                                          16U, &service_result) == ESP_OK);
  assert(service_result.status ==
         POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_DRAINED);
  assert(pocketjs_net_http_client_core_is_quiescent(fixture.core));
  assert(pocketjs_net_esp_transport_is_quiescent(fixture.slot->transport));
  assert(pocketjs_net_esp_runtime_is_ready_to_destroy(fixture.runtime));
  assert(pocketjs_net_esp_runtime_service(fixture.runtime, 9000U, 1U, 1U, 1U,
                                          16U, &service_result) ==
         ESP_ERR_INVALID_ARG);

  pocketjs_net_esp_runtime_stats_t stats = {0};
  assert(pocketjs_net_esp_runtime_get_stats(fixture.runtime, &stats) == ESP_OK);
  assert(stats.active_operations == 0U && stats.leases_taken == 1U &&
         stats.leases_released == 1U && stats.leases_cleaned_up == 0U &&
         stats.poison_flags == POCKETJS_NET_ESP_RUNTIME_POISON_LEASE);
  assert(pocketjs_net_esp_runtime_destroy(fixture.runtime) == ESP_OK);
  next_transport_shutdown_pumps = 0U;
}

static void test_held_lease_shutdown_cleanup(
    const pocketjs_net_esp_runtime_config_t *config,
    const pocketjs_net_esp_runtime_http_command_t *command) {
  next_transport_shutdown_pumps = 1U;
  taken_lease_fixture_t fixture = start_taken_lease(config, command);
  fail_next_event_retirement = true;
  assert(pocketjs_net_esp_runtime_begin_shutdown(fixture.runtime, 10000U) ==
         ESP_OK);
  assert(fixture.core->lease_released && fixture.slot->event_pending &&
         fixture.slot->lease_state == POCKETJS_NET_ESP_RUNTIME_LEASE_RELEASED &&
         (fixture.runtime->poison_flags &
          POCKETJS_NET_ESP_RUNTIME_POISON_LEASE) != 0U);
  assert_shutdown_rejects_new_work(fixture.runtime, command, 4U);

  pocketjs_net_esp_runtime_service_result_t service_result = {0};
  assert(pocketjs_net_esp_runtime_service(fixture.runtime, 11000U, 1U, 1U, 1U,
                                          16U, &service_result) == ESP_OK);
  assert(service_result.status ==
         POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_MORE_READY);
  assert(!fixture.slot->event_pending && fixture.slot->active &&
         !pocketjs_net_esp_runtime_is_ready_to_destroy(fixture.runtime));

  queue_shutdown_error(&fixture, 104U);
  assert(pocketjs_net_esp_runtime_service(fixture.runtime, 12000U, 1U, 1U, 1U,
                                          16U, &service_result) == ESP_OK);
  assert(service_result.status ==
         POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_DRAINED);
  assert(pocketjs_net_esp_runtime_is_ready_to_destroy(fixture.runtime));

  pocketjs_net_esp_runtime_stats_t stats = {0};
  assert(pocketjs_net_esp_runtime_get_stats(fixture.runtime, &stats) == ESP_OK);
  assert(stats.active_operations == 0U && stats.leases_taken == 1U &&
         stats.leases_released == 0U && stats.leases_cleaned_up == 1U &&
         stats.poison_flags == POCKETJS_NET_ESP_RUNTIME_POISON_LEASE);
  assert(pocketjs_net_esp_runtime_destroy(fixture.runtime) == ESP_OK);
  next_transport_shutdown_pumps = 0U;
}

static void test_poisoned_core_retained_transport_teardown(
    const pocketjs_net_esp_runtime_config_t *config,
    const pocketjs_net_esp_runtime_http_command_t *command) {
  next_transport_shutdown_pumps = 1U;
  next_transport_completion_retire_stuck = true;
  next_core_poison_on_shutdown = true;
  pocketjs_net_esp_runtime_t *runtime = NULL;
  assert(pocketjs_net_esp_runtime_create(config, &runtime) == ESP_OK);
  pocketjs_net_esp_runtime_error_t error = {0};
  pocketjs_network_v1_command_identity_t request_identity =
      identity(1U, (pocketjs_network_v1_handle_t){0U, 0U}, 1U);
  assert(pocketjs_net_esp_runtime_start_http(runtime, &request_identity,
                                             command, &error));
  pocketjs_net_esp_runtime_slot_t *slot = &runtime->slots[0];
  pocketjs_net_http_client_core_t *core = slot->core;
  const size_t destroys_before_shutdown = transport_destroys;
  const size_t poisoned_destroys_before_shutdown = poisoned_transport_destroys;
  const size_t abandoned_before_shutdown = poisoned_events_abandoned;
  fail_next_transport_confirmation = true;
  fail_event_retirement_persistently = true;

  assert(pocketjs_net_esp_runtime_begin_shutdown(runtime, 13000U) == ESP_OK);
  pocketjs_net_http_client_core_status_t core_status = {0};
  assert(pocketjs_net_http_client_core_get_status(core, &core_status));
  assert(core_status.poisoned && core_status.connection_owned &&
         core_status.completion_retire_pending && !core_status.quiescent &&
         !core->transport_confirmed &&
         !pocketjs_net_esp_transport_is_quiescent(slot->transport));
  assert(runtime->poison_flags == POCKETJS_NET_ESP_RUNTIME_POISON_CORE);
  assert(pocketjs_net_esp_runtime_completion_readiness(runtime) == -1);

  pocketjs_net_esp_runtime_service_result_t service_result = {0};
  assert(pocketjs_net_esp_runtime_service(runtime, 14000U, 1U, 1U, 1U, 16U,
                                          &service_result) == ESP_OK);
  assert(service_result.status ==
         POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_MORE_READY);
  assert(!pocketjs_net_esp_runtime_is_ready_to_destroy(runtime));
  assert(slot->transport == NULL && slot->transport_detached_awaiting_confirm &&
         !core->transport_confirmed && poisoned_transport_detached);

  assert(pocketjs_net_esp_runtime_service(runtime, 15000U, 1U, 1U, 1U, 16U,
                                          &service_result) == ESP_OK);
  assert(service_result.status ==
         POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_DRAINED);
  assert(pocketjs_net_esp_runtime_is_ready_to_destroy(runtime));
  assert(slot->transport == NULL && core->transport_confirmed &&
         !slot->event_pending && !slot->active &&
         pocketjs_net_http_client_core_is_quiescent(core));
  assert(transport_destroys == destroys_before_shutdown + 1U);
  assert(poisoned_transport_destroys == poisoned_destroys_before_shutdown + 1U);
  assert(poisoned_events_abandoned == abandoned_before_shutdown + 1U);
  assert(last_transport_destroy_order < core->transport_confirm_order &&
         core->transport_confirm_order < core->terminal_abandon_order &&
         core->terminal_retire_order == 0U);

  pocketjs_net_esp_runtime_stats_t stats = {0};
  assert(pocketjs_net_esp_runtime_get_stats(runtime, &stats) == ESP_OK);
  assert(stats.active_operations == 0U && stats.pending_core_events == 0U &&
         stats.poison_flags == (POCKETJS_NET_ESP_RUNTIME_POISON_CORE |
                                POCKETJS_NET_ESP_RUNTIME_POISON_SHUTDOWN));
  assert(stats.poisoned_core_slots == 1U &&
         stats.core_poison_flags ==
             POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_COMPLETION &&
         stats.first_core_poison_cause_code == -123);
  const size_t destroys_before_runtime_destroy = transport_destroys;
  const size_t poisoned_destroys_before_runtime_destroy =
      poisoned_transport_destroys;
  assert(pocketjs_net_esp_runtime_destroy(runtime) == ESP_OK);
  assert(transport_destroys == destroys_before_runtime_destroy);
  assert(poisoned_transport_destroys ==
         poisoned_destroys_before_runtime_destroy);
  next_transport_shutdown_pumps = 0U;
  assert(!next_core_poison_on_shutdown);
  assert(!next_transport_completion_retire_stuck);
  assert(!fail_next_transport_confirmation);
  assert(!poisoned_transport_detached);
  fail_event_retirement_persistently = false;
}

static void test_tls_profile_snapshot(
    const pocketjs_net_esp_runtime_config_t *plain_config) {
  const pocketjs_network_v1_feature_id_t tls_features[] = {
      POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT,
      POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_TLS,
  };
  pocketjs_net_esp_runtime_config_t tls_config = *plain_config;
  tls_config.feature_ids = tls_features;
  tls_config.feature_count = 2U;
  tls_config.providers.http_client_tls_source =
      POCKETJS_NET_ESP_RUNTIME_TLS_SELECTION_PROVIDER;
  tls_config.providers.http_client_tls_id = POCKETJS_NET_ESP_TLS_PROVIDER_ID;

  pocketjs_net_esp_runtime_t *runtime = NULL;
  assert(pocketjs_net_esp_runtime_create(&tls_config, &runtime) ==
         ESP_ERR_INVALID_ARG);
  assert(runtime == NULL);

  uint8_t mutable_ca[sizeof(EXPECTED_TLS_CA)];
  memcpy(mutable_ca, EXPECTED_TLS_CA, sizeof(mutable_ca));
  tls_config.tls_trust_source = POCKETJS_NET_ESP_TLS_TRUST_HOST_PINNED_CA;
  tls_config.host_pinned_ca_pem = mutable_ca;
  tls_config.host_pinned_ca_pem_bytes = sizeof(mutable_ca);
  tls_config.wall_clock_trusted = fake_wall_clock_trusted;
  tls_config.wall_clock_context = &tls_clock_context;
  expect_tls_profile = true;
  expect_tls_request = true;
  tls_ca_source = mutable_ca;
  expected_permission_scheme = POCKETJS_NET_HTTP_CLIENT_SCHEME_HTTPS;

  fake_transport_tls_descriptor_drift = true;
  assert(pocketjs_net_esp_runtime_create(&tls_config, &runtime) ==
         ESP_ERR_INVALID_ARG);
  assert(runtime == NULL);
  fake_transport_tls_descriptor_drift = false;

  const size_t creates_before = transport_creates;
  const size_t destroys_before = transport_destroys;
  const size_t starts_before = core_starts;
  assert(pocketjs_net_esp_runtime_create(&tls_config, &runtime) == ESP_OK);
  assert(runtime != NULL && runtime->tls_enabled &&
         runtime->feature_count == 2U &&
         runtime->pinned_ca_bytes == sizeof(EXPECTED_TLS_CA));
  mutable_ca[0] = 'X';

  pocketjs_net_esp_runtime_http_command_t command = {
      .url = "https://example.test/",
      .url_length = sizeof("https://example.test/") - 1U,
      .method = "GET",
      .method_length = 3U,
      .tls_present = true,
      .tls_requested = true,
      .tls_server_name = "example.test",
      .tls_server_name_length = sizeof("example.test") - 1U,
      .redirect_mode = POCKETJS_NETWORK_V1_HTTP_REDIRECT_MANUAL,
      .max_redirects = 5U,
      .ref = true,
  };
  command.tls_policy = (pocketjs_net_http_client_tls_policy_t){
      .server_name = {command.tls_server_name, command.tls_server_name_length},
      .minimum_version = POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_2,
      .maximum_version = POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_2,
      .client_certificate =
          POCKETJS_NET_HTTP_CLIENT_TLS_CLIENT_CERTIFICATE_NONE,
      .verification = POCKETJS_NET_HTTP_CLIENT_TLS_VERIFICATION_FULL,
      .revocation = POCKETJS_NET_HTTP_CLIENT_TLS_REVOCATION_HOST_DEFAULT,
  };
  pocketjs_net_esp_runtime_error_t error = {0};
  pocketjs_network_v1_command_identity_t request_identity =
      identity(1U, (pocketjs_network_v1_handle_t){0U, 0U}, 1U);
  assert(pocketjs_net_esp_runtime_start_http(runtime, &request_identity,
                                             &command, &error));
  assert(transport_creates == creates_before + 1U &&
         core_starts == starts_before + 1U);
  pocketjs_net_esp_runtime_slot_t *slot = &runtime->slots[0];
  queue_event(slot->core, (pocketjs_net_http_client_event_t){
                              .type = POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE,
                              .sequence = 601U,
                          });
  pocketjs_net_esp_runtime_slot_t *selected = NULL;
  assert(pocketjs_net_esp_runtime_peek_event(runtime, &selected) &&
         selected == slot);
  assert(pocketjs_net_esp_runtime_retire_nonlease_event(runtime, slot));

  expect_tls_request = false;
  expected_permission_scheme = POCKETJS_NET_HTTP_CLIENT_SCHEME_HTTP;
  command.tls_present = false;
  command.tls_requested = false;
  command.redirect_mode = POCKETJS_NETWORK_V1_HTTP_REDIRECT_FOLLOW;
  command.max_redirects = 2U;
  memcpy(command.url, "http://example.test/", sizeof("http://example.test/"));
  command.url_length = sizeof("http://example.test/") - 1U;
  request_identity = identity(2U, (pocketjs_network_v1_handle_t){0U, 0U}, 2U);
  assert(pocketjs_net_esp_runtime_start_http(runtime, &request_identity,
                                             &command, &error));
  assert(last_core_redirect_mode == POCKETJS_NET_HTTP_CLIENT_REDIRECT_FOLLOW &&
         last_core_max_redirects == 2U);
  assert(transport_creates == creates_before + 1U &&
         core_starts == starts_before + 2U);
  queue_event(slot->core, (pocketjs_net_http_client_event_t){
                              .type = POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE,
                              .sequence = 602U,
                          });
  assert(pocketjs_net_esp_runtime_peek_event(runtime, &selected) &&
         selected == slot);
  assert(pocketjs_net_esp_runtime_retire_nonlease_event(runtime, slot));
  assert(pocketjs_net_esp_runtime_begin_shutdown(runtime, 16000U) == ESP_OK);
  pocketjs_net_esp_runtime_service_result_t service_result = {0};
  assert(pocketjs_net_esp_runtime_service(runtime, 17000U, 1U, 1U, 1U, 16U,
                                          &service_result) == ESP_OK);
  assert(pocketjs_net_esp_runtime_is_ready_to_destroy(runtime));
  assert(pocketjs_net_esp_runtime_destroy(runtime) == ESP_OK);
  assert(transport_destroys == destroys_before + 1U);

  expect_tls_profile = false;
  expect_tls_request = false;
  tls_ca_source = NULL;
  expected_permission_scheme = POCKETJS_NET_HTTP_CLIENT_SCHEME_HTTP;
}

int main(void) {
  const pocketjs_network_v1_feature_id_t features[] = {
      POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT,
  };
  struct pocketjs_esp_guest guest = {.context = &FAKE_CONTEXT};
  pocketjs_net_esp_runtime_config_t config = {
      .guest = &guest,
      .runtime_generation = 7U,
      .feature_ids = features,
      .feature_count = 1U,
      .providers =
          {
              .http_client_backend_id = POCKETJS_NET_HTTP_CLIENT_CORE_ID,
              .net_driver_id = POCKETJS_NET_ESP_TRANSPORT_ID,
              .http_client_tls_source =
                  POCKETJS_NET_ESP_RUNTIME_TLS_SELECTION_NONE,
          },
      .admission = POCKETJS_NET_ESP_RUNTIME_ADMISSION_TEST_ONLY,
      .max_operations = 1U,
      .limits =
          {
              .buffered_body_bytes = {0U, 1024U, 4096U},
              .header_bytes = {0U, 2048U, 8192U},
              .max_body_chunk_bytes = {1U, 256U, 2048U},
              .max_operations = {1U, 1U, 1U},
              .native_buffer_bytes = {0U, 524288U, 524288U},
          },
      .connect_timeout_us = 1000U,
      .headers_timeout_us = 2000U,
      .idle_timeout_us = 3000U,
      .total_timeout_us = 4000U,
      .wake = fake_wake,
      .wake_context = &wake_count,
      .allow_endpoint = fake_permission,
      .permission_context = &permission_count,
  };
  size_t required_native_bytes = 0U;
  assert(pocketjs_net_esp_runtime_required_native_buffer_bytes(
      config.max_operations, &required_native_bytes));
  assert(required_native_bytes <=
         config.limits.native_buffer_bytes.default_value);
  assert(!pocketjs_net_esp_runtime_required_native_buffer_bytes(
      0U, &required_native_bytes));
  assert(!pocketjs_net_esp_runtime_required_native_buffer_bytes(
      POCKETJS_NET_ESP_RUNTIME_MAX_OPERATIONS + 1U, &required_native_bytes));
  assert(!pocketjs_net_esp_runtime_required_native_buffer_bytes(1U, NULL));
  pocketjs_net_esp_runtime_t *runtime = NULL;
  pocketjs_net_esp_runtime_config_t refused = config;
  fake_core_descriptor_drift = true;
  assert(pocketjs_net_esp_runtime_create(&refused, &runtime) ==
         ESP_ERR_INVALID_ARG);
  assert(runtime == NULL);
  fake_core_descriptor_drift = false;
  refused = config;
  refused.limits.native_buffer_bytes.default_value = required_native_bytes - 1U;
  assert(pocketjs_net_esp_runtime_create(&refused, &runtime) ==
         ESP_ERR_INVALID_ARG);
  assert(runtime == NULL);
  refused = config;
  refused.providers.http_client_backend_id = "wrong.backend";
  assert(pocketjs_net_esp_runtime_create(&refused, &runtime) ==
         ESP_ERR_INVALID_ARG);
  assert(runtime == NULL);
  refused = config;
  refused.providers.net_driver_id = "wrong.driver";
  assert(pocketjs_net_esp_runtime_create(&refused, &runtime) ==
         ESP_ERR_INVALID_ARG);
  assert(runtime == NULL);
  refused = config;
  refused.providers.http_client_tls_source =
      POCKETJS_NET_ESP_RUNTIME_TLS_SELECTION_PROVIDER;
  refused.providers.http_client_tls_id = POCKETJS_NET_ESP_TLS_PROVIDER_ID;
  assert(pocketjs_net_esp_runtime_create(&refused, &runtime) ==
         ESP_ERR_INVALID_ARG);
  assert(runtime == NULL);
  refused = config;
  refused.admission = POCKETJS_NET_ESP_RUNTIME_ADMISSION_PUBLIC;
  assert(pocketjs_net_esp_runtime_create(&refused, &runtime) ==
         ESP_ERR_INVALID_ARG);
  assert(runtime == NULL);
  assert(pocketjs_net_esp_runtime_create(&config, &runtime) == ESP_OK);
  assert(runtime != NULL && runtime->max_operations == 1U);

  pocketjs_net_esp_runtime_http_command_t command = {
      .url = "https://example.test/",
      .url_length = sizeof("https://example.test/") - 1U,
      .method = "GET",
      .method_length = 3U,
      .tls_requested = true,
      .redirect_mode = POCKETJS_NETWORK_V1_HTTP_REDIRECT_MANUAL,
      .max_redirects = 5U,
      .ref = true,
  };
  pocketjs_net_esp_runtime_error_t error = {0};
  pocketjs_network_v1_command_identity_t request_identity =
      identity(1U, (pocketjs_network_v1_handle_t){0U, 0U}, 1U);
  assert(!pocketjs_net_esp_runtime_start_http(runtime, &request_identity,
                                              &command, &error));
  assert(error.code == POCKETJS_NETWORK_V1_ERROR_UNSUPPORTED);
  assert(transport_creates == 0U &&
         runtime->slots[0].last_operation_generation == 1U);

  command.tls_requested = false;
  memcpy(command.url, "http://example.test/", sizeof("http://example.test/"));
  command.url_length = sizeof("http://example.test/") - 1U;
  request_identity = identity(1U, (pocketjs_network_v1_handle_t){0U, 0U}, 2U);
  memset(&error, 0, sizeof(error));
  assert(!pocketjs_net_esp_runtime_start_http(runtime, &request_identity,
                                              &command, &error));
  assert(error.code == POCKETJS_NETWORK_V1_ERROR_INVALID_STATE);
  assert(transport_creates == 0U);

  command.has_body = true;
  request_identity = identity(2U, (pocketjs_network_v1_handle_t){1U, 2U}, 3U);
  memset(&error, 0, sizeof(error));
  assert(pocketjs_net_esp_runtime_start_http(runtime, &request_identity,
                                             &command, &error));
  assert(transport_creates == 1U && core_starts == 1U &&
         permission_count == 2U);
  pocketjs_net_esp_runtime_slot_t *slot = &runtime->slots[0];
  pocketjs_net_http_client_core_t *core = slot->core;

  queue_event(core,
              (pocketjs_net_http_client_event_t){
                  .type = POCKETJS_NET_HTTP_CLIENT_EVENT_REQUEST_BODY_PULL,
                  .sequence = 11U,
                  .detail.request_body_pull =
                      {
                          .body_generation = 4U,
                          .pull_generation = 5U,
                          .maximum_bytes = 16U,
                      },
              });
  pocketjs_net_esp_runtime_slot_t *selected = NULL;
  assert(pocketjs_net_esp_runtime_peek_event(runtime, &selected) &&
         selected == slot);
  assert(pocketjs_net_esp_runtime_retire_nonlease_event(runtime, slot));
  const uint8_t upload[] = {1U, 2U, 3U};
  pocketjs_network_v1_command_identity_t upload_identity =
      identity(2U, (pocketjs_network_v1_handle_t){1U, 2U}, 4U);
  assert(pocketjs_net_esp_runtime_submit_body_chunk(
      runtime, &upload_identity, upload, sizeof(upload), &error));

  static const uint8_t status_text[] = "OK";
  static const uint8_t header_name[] = "content-type";
  static const uint8_t header_value[] = "text/plain";
  static const pocketjs_net_http_client_header_t headers[] = {{
      .name = {header_name, sizeof(header_name) - 1U},
      .value = {header_value, sizeof(header_value) - 1U},
  }};
  queue_event(
      core, (pocketjs_net_http_client_event_t){
                .type = POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS,
                .sequence = 12U,
                .detail.response =
                    {
                        .status_code = 200U,
                        .status_text = {status_text, sizeof(status_text) - 1U},
                        .headers = headers,
                        .header_count = 1U,
                    },
            });
  assert(pocketjs_net_esp_runtime_peek_event(runtime, &selected) &&
         selected == slot && slot->response_body.id == 1U &&
         slot->response_body.generation == 1U);
  assert(pocketjs_net_esp_runtime_retire_nonlease_event(runtime, slot));
  pocketjs_network_v1_command_identity_t response_identity =
      identity(2U, slot->response_body, 5U);
  assert(pocketjs_net_esp_runtime_grant_body_credit(runtime, &response_identity,
                                                    3U, &error));

  memcpy(core->lease_bytes, "abc", 3U);
  core->lease_length = 3U;
  queue_event(core, (pocketjs_net_http_client_event_t){
                        .type = POCKETJS_NET_HTTP_CLIENT_EVENT_BODY,
                        .sequence = 13U,
                        .detail.body =
                            {
                                .lease = {3U, 4U},
                                .byte_count = 3U,
                            },
                    });
  assert(pocketjs_net_esp_runtime_peek_event(runtime, &selected) &&
         selected == slot &&
         slot->lease_state == POCKETJS_NET_ESP_RUNTIME_LEASE_QUEUED);
  /* binding_next_completion marks the descriptor selected after JS creation. */
  slot->lease_descriptor_delivered = true;
  const pocketjs_network_v1_handle_t lease = slot->lease;
  uint32_t taken = 0U;
  response_identity.command_sequence = 6U;
  assert(pocketjs_net_esp_runtime_lease_take(runtime, &response_identity, lease,
                                             3U, &taken, &error));
  assert(taken == 3U);
  uint8_t oversized_destination[3] = {0};
  uint8_t destination[2] = {0};
  uint32_t copied = 0U;
  response_identity.command_sequence = 7U;
  assert(!pocketjs_net_esp_runtime_lease_read(
      runtime, &response_identity, lease, 1U, 2U, oversized_destination,
      sizeof(oversized_destination), &copied, &error));
  response_identity.command_sequence = 8U;
  assert(!pocketjs_net_esp_runtime_lease_read(
      runtime, &response_identity, lease, 2U, 2U, destination,
      sizeof(destination), &copied, &error));
  response_identity.command_sequence = 9U;
  assert(pocketjs_net_esp_runtime_lease_read(
      runtime, &response_identity, lease, 1U, 2U, destination,
      sizeof(destination), &copied, &error));
  assert(copied == 2U && destination[0] == 'b' && destination[1] == 'c');
  response_identity.command_sequence = 10U;
  assert(pocketjs_net_esp_runtime_lease_release(runtime, &response_identity,
                                                lease, &error));
  assert(!slot->event_pending &&
         slot->lease_state == POCKETJS_NET_ESP_RUNTIME_LEASE_NONE);

  queue_event(core, (pocketjs_net_http_client_event_t){
                        .type = POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE,
                        .sequence = 14U,
                    });
  assert(pocketjs_net_esp_runtime_peek_event(runtime, &selected) &&
         selected == slot);
  assert(pocketjs_net_esp_runtime_retire_nonlease_event(runtime, slot));
  assert(!slot->active);

  command.has_body = false;
  request_identity = identity(3U, (pocketjs_network_v1_handle_t){0U, 0U}, 11U);
  assert(pocketjs_net_esp_runtime_start_http(runtime, &request_identity,
                                             &command, &error));
  assert(core_starts == 2U && permission_count == 4U);
  queue_event(
      core, (pocketjs_net_http_client_event_t){
                .type = POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS,
                .sequence = 19U,
                .detail.response =
                    {
                        .status_code = 204U,
                        .status_text = {status_text, sizeof(status_text) - 1U},
                        .headers = headers,
                        .header_count = 1U,
                    },
            });
  assert(pocketjs_net_esp_runtime_peek_event(runtime, &selected) &&
         selected == slot &&
         pocketjs_network_v1_handle_is_absent(slot->response_body));
  assert(pocketjs_net_esp_runtime_retire_nonlease_event(runtime, slot));
  assert(slot->active);
  queue_event(core, (pocketjs_net_http_client_event_t){
                        .type = POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE,
                        .sequence = 20U,
                    });
  assert(pocketjs_net_esp_runtime_peek_event(runtime, &selected) &&
         selected == slot);
  assert(pocketjs_net_esp_runtime_retire_nonlease_event(runtime, slot));
  assert(!slot->active);

  request_identity = identity(4U, (pocketjs_network_v1_handle_t){0U, 0U}, 12U);
  assert(pocketjs_net_esp_runtime_start_http(runtime, &request_identity,
                                             &command, &error));
  assert(core_starts == 3U && permission_count == 6U);
  assert(pocketjs_net_esp_runtime_begin_shutdown(runtime, 5000U) == ESP_OK);
  queue_event(core, (pocketjs_net_http_client_event_t){
                        .type = POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR,
                        .sequence = 21U,
                        .detail.error =
                            {
                                .code = POCKETJS_NET_HTTP_CLIENT_ERROR_ABORTED,
                            },
                    });
  assert(pocketjs_net_esp_runtime_peek_event(runtime, &selected) &&
         selected == slot);
  assert(pocketjs_net_esp_runtime_retire_nonlease_event(runtime, slot));
  pocketjs_net_esp_runtime_service_result_t service_result = {0};
  assert(pocketjs_net_esp_runtime_service(runtime, 6000U, 1U, 1U, 1U, 16U,
                                          &service_result) == ESP_OK);
  assert(service_result.status ==
         POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_DRAINED);
  assert(pocketjs_net_esp_runtime_is_ready_to_destroy(runtime));

  pocketjs_net_esp_runtime_stats_t stats = {0};
  assert(pocketjs_net_esp_runtime_get_stats(runtime, &stats) == ESP_OK);
  assert(stats.configured_operation_slots == 1U &&
         stats.initialized_operation_slots == 1U &&
         stats.active_operations == 0U && stats.requests_started == 3U &&
         stats.leases_taken == 1U && stats.leases_released == 1U &&
         stats.permission_checks == 6U && stats.poison_flags == 0U &&
         stats.runtime_instance_bytes ==
             sizeof(*runtime) + sizeof(runtime->slots[0]) &&
         stats.pocketjs_owned_native_bytes ==
             stats.runtime_instance_bytes +
                 sizeof(pocketjs_net_esp_runtime_binding_state_t) +
                 sizeof(struct pocketjs_net_esp_transport) &&
         stats.admitted_native_buffer_bytes == 524288U);
  assert(pocketjs_net_esp_runtime_destroy(runtime) == ESP_OK);
  assert(transport_destroys == 1U && wake_count >= 4U);
  test_dispatcher_poison_native_fallback(&config, &command);
  test_released_lease_retire_failure(&config, &command);
  test_held_lease_shutdown_cleanup(&config, &command);
  test_poisoned_core_retained_transport_teardown(&config, &command);
  assert(transport_creates == 5U && transport_destroys == 5U);
  test_tls_profile_snapshot(&config);
  assert(transport_creates == 6U && transport_destroys == 6U);
  assert(!fail_next_event_retirement && !fail_next_dispatcher_call);
  return 0;
}
