// SPDX-License-Identifier: MIT

#include "pocketjs/net/formal_smoke_artifact.h"

#include <limits.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/ip4_addr.h"
#include "quickjs.h"

#define FORMAL_SMOKE_RUNTIME_GENERATION 1U
#define FORMAL_SMOKE_MAX_OPERATIONS 1U
#define FORMAL_SMOKE_SERVICE_NATIVE_STEPS 16U
#define FORMAL_SMOKE_SERVICE_COMPLETIONS 16U
#define FORMAL_SMOKE_SERVICE_EVENTS 16U
#define FORMAL_SMOKE_SERVICE_PAYLOAD_BYTES 4096U
#define FORMAL_SMOKE_GUEST_JOBS 32U
#define FORMAL_SMOKE_WAIT_MS 10U
#define FORMAL_SMOKE_CONNECT_TIMEOUT_US UINT64_C(10000000)
#define FORMAL_SMOKE_HEADERS_TIMEOUT_US UINT64_C(10000000)
#define FORMAL_SMOKE_IDLE_TIMEOUT_US UINT64_C(10000000)
#define FORMAL_SMOKE_TOTAL_TIMEOUT_US UINT64_C(30000000)

static const char *const TAG = "pocketjs_formal_smoke";

typedef struct {
  TaskHandle_t owner_task;
  uint32_t expected_ipv4_be;
} formal_smoke_host_context_t;

static uint64_t monotonic_us(void) {
  const int64_t now = esp_timer_get_time();
  return now > 0 ? (uint64_t)now : UINT64_C(1);
}

static uint64_t deadline_after_ms(uint64_t now_us, uint32_t milliseconds) {
  const uint64_t delta = (uint64_t)milliseconds * UINT64_C(1000);
  return delta > UINT64_MAX - now_us ? UINT64_MAX : now_us + delta;
}

static void wake_owner(void *context) {
  formal_smoke_host_context_t *host = context;
  if (host != NULL && host->owner_task != NULL) {
    xTaskNotifyGive(host->owner_task);
  }
}

static bool
allow_endpoint(void *context,
               const pocketjs_net_http_client_endpoint_t *endpoint) {
  const formal_smoke_host_context_t *host = context;
  if (host == NULL || endpoint == NULL ||
      endpoint->scheme != POCKETJS_NET_HTTP_CLIENT_SCHEME_HTTP ||
      endpoint->hostname == NULL ||
      strcmp(endpoint->hostname, pocketjs_net_formal_smoke_endpoint.host) !=
          0 ||
      endpoint->port != pocketjs_net_formal_smoke_endpoint.port) {
    return false;
  }
  if (endpoint->phase == POCKETJS_NET_HTTP_CLIENT_PERMISSION_HOSTNAME) {
    return endpoint->ipv4_be == 0U;
  }
  return endpoint->phase ==
             POCKETJS_NET_HTTP_CLIENT_PERMISSION_NUMERIC_CANDIDATE &&
         endpoint->ipv4_be == host->expected_ipv4_be;
}

static bool valid_config(const pocketjs_net_formal_smoke_run_config_t *config,
                         pocketjs_net_formal_smoke_run_result_t *out_result) {
  const pocketjs_net_esp_runtime_descriptor_t *descriptor =
      pocketjs_net_esp_runtime_descriptor();
  size_t required_native_bytes = 0U;
  return config != NULL && out_result != NULL && descriptor != NULL &&
         descriptor->pocketjs_owned_native_buffer_floor_enforced &&
         pocketjs_net_esp_runtime_required_native_buffer_bytes(
             FORMAL_SMOKE_MAX_OPERATIONS, &required_native_bytes) &&
         required_native_bytes <= 524288U &&
         config->configured_origin != NULL &&
         strcmp(config->configured_origin,
                pocketjs_net_formal_smoke_endpoint.origin) == 0 &&
         config->guest_memory_limit_bytes >=
             POCKETJS_NET_FORMAL_SMOKE_MIN_GUEST_MEMORY_BYTES &&
         config->guest_stack_limit_bytes >=
             POCKETJS_NET_FORMAL_SMOKE_MIN_GUEST_STACK_BYTES &&
         config->guest_execution_timeout_us != 0U &&
         config->guest_max_interrupt_checks != 0U &&
         config->overall_timeout_ms != 0U &&
         config->shutdown_warning_ms != 0U &&
         pocketjs_net_formal_smoke_factory_bytes != NULL &&
         pocketjs_net_formal_smoke_factory_storage_length ==
             pocketjs_net_formal_smoke_factory_length + 1U &&
         pocketjs_net_formal_smoke_factory_bytes
                 [pocketjs_net_formal_smoke_factory_length] == 0U &&
         pocketjs_net_formal_smoke_feature_count == 1U &&
         pocketjs_net_formal_smoke_feature_ids[0] ==
             POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT;
}

static bool runtime_idle(const pocketjs_net_esp_runtime_stats_t *stats) {
  return stats->active_operations == 0U && stats->pending_core_events == 0U &&
         stats->queued_leases == 0U && stats->taken_leases == 0U;
}

static esp_err_t service_once(pocketjs_net_esp_runtime_t *runtime,
                              pocketjs_esp_guest_t *guest,
                              pocketjs_net_formal_smoke_run_result_t *result,
                              bool *out_more_ready, bool *out_jobs_pending) {
  pocketjs_net_esp_runtime_service_result_t service = {0};
  esp_err_t status = pocketjs_net_esp_runtime_service(
      runtime, monotonic_us(), FORMAL_SMOKE_SERVICE_NATIVE_STEPS,
      FORMAL_SMOKE_SERVICE_COMPLETIONS, FORMAL_SMOKE_SERVICE_EVENTS,
      FORMAL_SMOKE_SERVICE_PAYLOAD_BYTES, &service);
  ++result->service_turns;
  if (status != ESP_OK) {
    *out_more_ready = true;
    *out_jobs_pending = false;
    return status;
  }

  size_t executed = 0U;
  bool pending = false;
  status = pocketjs_esp_guest_execute_jobs(guest, FORMAL_SMOKE_GUEST_JOBS,
                                           &executed, &pending);
  result->guest_jobs_executed += executed;
  *out_more_ready =
      service.status != POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_DRAINED;
  *out_jobs_pending = pending;
  return status;
}

static esp_err_t
shutdown_runtime(pocketjs_net_esp_runtime_t *runtime,
                 pocketjs_esp_guest_t *guest, uint32_t warning_ms,
                 pocketjs_net_formal_smoke_run_result_t *result) {
  esp_err_t first_error = ESP_OK;
  esp_err_t status =
      pocketjs_net_esp_runtime_begin_shutdown(runtime, monotonic_us());
  if (status != ESP_OK) {
    first_error = status;
  }
  const uint64_t warning_deadline =
      deadline_after_ms(monotonic_us(), warning_ms);
  bool warning_logged = false;
  while (!pocketjs_net_esp_runtime_is_ready_to_destroy(runtime)) {
    if (!warning_logged && monotonic_us() >= warning_deadline) {
      ESP_LOGE(TAG, "POCKET_NET_FORMAL_SHUTDOWN_FAIL_STOP first_error=%s",
               esp_err_to_name(first_error));
      warning_logged = true;
    }
    bool more_ready = false;
    bool jobs_pending = false;
    status = service_once(runtime, guest, result, &more_ready, &jobs_pending);
    if (status != ESP_OK && first_error == ESP_OK) {
      first_error = status;
    }
    if (!more_ready && !jobs_pending) {
      (void)ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(FORMAL_SMOKE_WAIT_MS));
    }
  }
  status = pocketjs_net_esp_runtime_get_stats(runtime, &result->runtime);
  if (status != ESP_OK && first_error == ESP_OK) {
    first_error = status;
  }
  while ((status = pocketjs_net_esp_runtime_destroy(runtime)) != ESP_OK) {
    if (first_error == ESP_OK) {
      first_error = status;
    }
    ESP_LOGE(TAG, "POCKET_NET_FORMAL_DESTROY_FAIL_STOP esp_err=%s",
             esp_err_to_name(status));
    vTaskDelay(pdMS_TO_TICKS(FORMAL_SMOKE_WAIT_MS));
  }
  result->shutdown_complete = true;
  return first_error;
}

esp_err_t pocketjs_net_formal_smoke_run(
    const pocketjs_net_formal_smoke_run_config_t *config,
    pocketjs_net_formal_smoke_run_result_t *out_result) {
  if (out_result == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  memset(out_result, 0, sizeof(*out_result));
  if (!valid_config(config, out_result) ||
      heap_caps_get_total_size(MALLOC_CAP_SPIRAM) == 0U) {
    return ESP_ERR_INVALID_ARG;
  }
  const uint64_t started_us = monotonic_us();
  esp_err_t run_error = ESP_OK;
  pocketjs_esp_guest_t *guest = NULL;
  pocketjs_net_esp_runtime_t *runtime = NULL;
  JSValue binding = JS_UNDEFINED;
  bool binding_owned = false;

  formal_smoke_host_context_t host = {
      .owner_task = xTaskGetCurrentTaskHandle(),
  };
  ip4_addr_t expected_address = {0};
  if (host.owner_task == NULL ||
      !ip4addr_aton(pocketjs_net_formal_smoke_endpoint.host,
                    &expected_address)) {
    return ESP_ERR_INVALID_ARG;
  }
  host.expected_ipv4_be = expected_address.addr;
  (void)ulTaskNotifyTake(pdTRUE, 0U);

  const pocketjs_esp_guest_config_t guest_config = {
      .memory_limit_bytes = config->guest_memory_limit_bytes,
      .stack_limit_bytes = config->guest_stack_limit_bytes,
      .allocate_in_external_memory = true,
      .execution_timeout_us = config->guest_execution_timeout_us,
      .max_interrupt_checks = config->guest_max_interrupt_checks,
  };
  run_error = pocketjs_esp_guest_create(&guest_config, &guest);
  if (run_error != ESP_OK) {
    goto finish;
  }

  pocketjs_net_esp_runtime_config_t runtime_config = {
      .guest = guest,
      .runtime_generation = FORMAL_SMOKE_RUNTIME_GENERATION,
      .feature_ids = pocketjs_net_formal_smoke_feature_ids,
      .feature_count = pocketjs_net_formal_smoke_feature_count,
      .providers =
          {
              .http_client_backend_id =
                  pocketjs_net_formal_smoke_http_client_backend_id,
              .net_driver_id = pocketjs_net_formal_smoke_net_driver_id,
              .http_client_tls_source =
                  POCKETJS_NET_ESP_RUNTIME_TLS_SELECTION_NONE,
          },
      .admission = POCKETJS_NET_ESP_RUNTIME_ADMISSION_TEST_ONLY,
      .max_operations = FORMAL_SMOKE_MAX_OPERATIONS,
      .limits =
          {
              .buffered_body_bytes = {4096U, 4096U, 16384U},
              .header_bytes = {4096U, 4096U, 8192U},
              .max_body_chunk_bytes = {512U, 2048U, 2048U},
              .max_operations = {1U, 1U, 1U},
              .native_buffer_bytes = {65536U, 524288U, 524288U},
          },
      .connect_timeout_us = FORMAL_SMOKE_CONNECT_TIMEOUT_US,
      .headers_timeout_us = FORMAL_SMOKE_HEADERS_TIMEOUT_US,
      .idle_timeout_us = FORMAL_SMOKE_IDLE_TIMEOUT_US,
      .total_timeout_us = FORMAL_SMOKE_TOTAL_TIMEOUT_US,
      .wake = wake_owner,
      .wake_context = &host,
      .allow_endpoint = allow_endpoint,
      .permission_context = &host,
  };
  memcpy(runtime_config.plan_hash, pocketjs_net_formal_smoke_plan_hash_bytes,
         sizeof(runtime_config.plan_hash));
  run_error = pocketjs_net_esp_runtime_create(&runtime_config, &runtime);
  if (run_error != ESP_OK) {
    goto finish;
  }
  run_error = pocketjs_net_esp_runtime_get_binding(runtime, &binding);
  if (run_error != ESP_OK) {
    goto shutdown;
  }
  binding_owned = true;
  run_error = pocketjs_esp_guest_mount_factory(
      guest, "esp-formal-network-smoke.js",
      (const char *)pocketjs_net_formal_smoke_factory_bytes,
      pocketjs_net_formal_smoke_factory_length, binding, NULL);
  JS_FreeValue(pocketjs_esp_guest_context(guest), binding);
  binding_owned = false;
  if (run_error != ESP_OK) {
    goto shutdown;
  }

  const uint64_t deadline =
      deadline_after_ms(started_us, config->overall_timeout_ms);
  bool application_complete = false;
  while (monotonic_us() < deadline) {
    bool more_ready = false;
    bool jobs_pending = false;
    run_error =
        service_once(runtime, guest, out_result, &more_ready, &jobs_pending);
    if (run_error != ESP_OK) {
      break;
    }
    run_error =
        pocketjs_net_formal_smoke_read_report(guest, &out_result->report);
    if (run_error != ESP_OK) {
      break;
    }
    run_error =
        pocketjs_net_esp_runtime_get_stats(runtime, &out_result->runtime);
    if (run_error != ESP_OK) {
      break;
    }
    if (out_result->report.done && !jobs_pending &&
        runtime_idle(&out_result->runtime)) {
      application_complete = true;
      break;
    }
    if (!more_ready && !jobs_pending) {
      (void)ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(FORMAL_SMOKE_WAIT_MS));
    }
  }
  if (!application_complete && run_error == ESP_OK) {
    run_error = ESP_ERR_TIMEOUT;
  }

shutdown: {
  const esp_err_t shutdown_error =
      shutdown_runtime(runtime, guest, config->shutdown_warning_ms, out_result);
  runtime = NULL;
  if (run_error == ESP_OK && shutdown_error != ESP_OK) {
    run_error = shutdown_error;
  }
}

finish:
  if (binding_owned && guest != NULL) {
    JS_FreeValue(pocketjs_esp_guest_context(guest), binding);
  }
  if (runtime == NULL && guest != NULL) {
    const esp_err_t stats_error =
        pocketjs_esp_guest_get_stats(guest, &out_result->guest);
    if (run_error == ESP_OK && stats_error != ESP_OK) {
      run_error = stats_error;
    }
    pocketjs_esp_guest_destroy(guest);
  }
  out_result->owner_stack_low_water_bytes =
      uxTaskGetStackHighWaterMark(NULL) * sizeof(StackType_t);
  out_result->elapsed_ms = (monotonic_us() - started_us) / UINT64_C(1000);

  const bool successful =
      run_error == ESP_OK && out_result->shutdown_complete &&
      out_result->report.done && out_result->report.ok &&
      out_result->report.frame_calls == 0U &&
      out_result->report.rounds_passed == POCKETJS_NET_FORMAL_SMOKE_ROUNDS &&
      out_result->report.requests_passed ==
          POCKETJS_NET_FORMAL_SMOKE_REQUESTS &&
      out_result->runtime.active_operations == 0U &&
      out_result->runtime.pending_core_events == 0U &&
      out_result->runtime.queued_leases == 0U &&
      out_result->runtime.taken_leases == 0U &&
      out_result->runtime.leases_taken == out_result->runtime.leases_released &&
      out_result->runtime.poison_flags == 0U &&
      out_result->runtime.requests_started ==
          POCKETJS_NET_FORMAL_SMOKE_REQUESTS;
  if (!successful && run_error == ESP_OK) {
    run_error = ESP_ERR_INVALID_RESPONSE;
  }
  ESP_LOGI(TAG,
           "POCKET_NET_FORMAL_RUN status=%s rounds=%u/%u requests=%u/%u "
           "frame_calls=%u service_turns=%llu jobs=%llu shutdown=%d "
           "poison=0x%08x elapsed_ms=%llu",
           esp_err_to_name(run_error),
           (unsigned)out_result->report.rounds_passed,
           (unsigned)POCKETJS_NET_FORMAL_SMOKE_ROUNDS,
           (unsigned)out_result->report.requests_passed,
           (unsigned)POCKETJS_NET_FORMAL_SMOKE_REQUESTS,
           (unsigned)out_result->report.frame_calls,
           (unsigned long long)out_result->service_turns,
           (unsigned long long)out_result->guest_jobs_executed,
           out_result->shutdown_complete, out_result->runtime.poison_flags,
           (unsigned long long)out_result->elapsed_ms);
  return run_error;
}
