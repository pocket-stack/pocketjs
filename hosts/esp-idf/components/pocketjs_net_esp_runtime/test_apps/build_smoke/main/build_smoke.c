// SPDX-License-Identifier: MIT

#include <assert.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "pocketjs/net/esp_runtime.h"

static bool permission_called;
static bool wake_called;
static unsigned tls_clock_context;
static const char *const TAG = "pocketjs_net_runtime";

static bool
allow_endpoint(void *context,
               const pocketjs_net_http_client_endpoint_t *endpoint) {
  (void)context;
  assert(endpoint != NULL);
  permission_called = true;
  return true;
}

static void wake_runtime(void *context) {
  (void)context;
  wake_called = true;
}

static bool trusted_wall_clock(void *context) {
  assert(context == &tls_clock_context);
  ++tls_clock_context;
  return true;
}

static const char FACTORY[] =
    "(binding => {"
    "  if (!Object.isFrozen(binding) || !Object.isFrozen(binding.handshake))"
    "    throw new Error('binding is mutable');"
    "  if (binding.handshake.abiMajor !== 1 ||"
    "      binding.handshake.abiMinor !== 1 ||"
    "      binding.handshake.runtimeGeneration !== 7 ||"
    "      binding.handshake.featureIds.length !== 1 ||"
    "      binding.handshake.featureIds[0] !== 256 ||"
    "      binding.handshake.planHash.byteLength !== 32)"
    "    throw new Error('bad handshake');"
    "  const limits = binding.getLimits(Object.freeze({"
    "    runtimeGeneration: 7, protocol: 1, role: 1"
    "  }));"
    "  if (!Object.isFrozen(limits) || limits.featureIds[0] !== 256 ||"
    "      limits.values.length !== 5) throw new Error('bad limits');"
    "  binding.registerServiceDispatcher(request => {"
    "    const poll = binding.nextCompletion(Object.freeze({"
    "      runtimeGeneration: 7, maxPayloadBytes: request.maxPayloadBytes"
    "    }));"
    "    if (!Object.isFrozen(poll) || poll.status !== 2 ||"
    "        poll.payloadBytesDelivered !== 0)"
    "      throw new Error('completion poll did not drain');"
    "    return Object.freeze({"
    "      status: 1, eventsDelivered: 0, payloadBytesDelivered: 0,"
    "      lastSequence: 0"
    "    });"
    "  });"
    "  let frameCount = 0;"
    "  globalThis.frame = () => {"
    "    frameCount += 1;"
    "    if (frameCount !== 1) {"
    "      let revoked = false;"
    "      try {"
    "        binding.getLimits(Object.freeze({"
    "          runtimeGeneration: 7, protocol: 1, role: 1"
    "        }));"
    "      } catch (error) {"
    "        revoked = error instanceof TypeError;"
    "      }"
    "      if (!revoked) throw new Error('stale binding was callable');"
    "      return;"
    "    }"
    "    const handle = (id, generation) => Object.freeze({id, generation});"
    "    const result = binding.dispatch(Object.freeze({"
    "      opcode: 256,"
    "      identity: Object.freeze({"
    "        runtimeGeneration: 7, resource: handle(1, 1),"
    "        operation: handle(1, 1), body: handle(0, 0), commandSequence: 1"
    "      }),"
    "      metadata: Object.freeze({"
    "        url: 'https://example.com/', method: 'GET',"
    "        headers: Object.freeze([]), hasBody: false, redirect: 2,"
    "        timeouts: Object.freeze({connectMs: 0, headersMs: 0, idleMs: 0, "
    "totalMs: 0}),"
    "        maxRedirects: 5, tls: Object.freeze({"
    "          serverName: 'example.com', minVersion: 258, maxVersion: 258,"
    "          alpn: Object.freeze([]), credential: '',"
    "          clientCertificate: 1, verification: 1, revocation: 1,"
    "          customCaBytes: 0"
    "        }),"
    "        limits: Object.freeze([]), ref: true"
    "      })"
    "    }));"
    "    if (result.status !== 3 || result.error.code !== 262)"
    "      throw new Error('HTTPS did not fail closed');"
    "  };"
    "})";

static const char TLS_FACTORY[] =
    "(binding => {"
    "  const featureIds = binding.handshake.featureIds;"
    "  if (featureIds.length !== 2 || featureIds[0] !== 256 ||"
    "      featureIds[1] !== 257) throw new Error('bad TLS handshake');"
    "  const limits = binding.getLimits(Object.freeze({"
    "    runtimeGeneration: 7, protocol: 1, role: 1"
    "  }));"
    "  if (limits.featureIds.length !== 2 ||"
    "      limits.featureIds[0] !== 256 || limits.featureIds[1] !== 257)"
    "    throw new Error('bad TLS limits');"
    "  binding.registerServiceDispatcher(request => Object.freeze({"
    "    status: 1, eventsDelivered: 0, payloadBytesDelivered: 0,"
    "    lastSequence: 0"
    "  }));"
    "  globalThis.frame = () => {"
    "    const handle = (id, generation) => Object.freeze({id, generation});"
    "    const result = binding.dispatch(Object.freeze({"
    "      opcode: 256,"
    "      identity: Object.freeze({"
    "        runtimeGeneration: 7, resource: handle(1, 1),"
    "        operation: handle(1, 1), body: handle(0, 0), commandSequence: 1"
    "      }),"
    "      metadata: Object.freeze({"
    "        url: 'https://example.com/', method: 'GET',"
    "        headers: Object.freeze([]), hasBody: false, redirect: 2,"
    "        timeouts: Object.freeze({connectMs: 0, headersMs: 0, idleMs: 0,"
    "          totalMs: 0}), maxRedirects: 5,"
    "        tls: Object.freeze({"
    "          serverName: 'wrong.example', minVersion: 258, maxVersion: 258,"
    "          alpn: Object.freeze([]), credential: '',"
    "          clientCertificate: 1, verification: 1, revocation: 1,"
    "          customCaBytes: 0"
    "        }), limits: Object.freeze([]), ref: true"
    "      })"
    "    }));"
    "    if (result.status !== 3 || result.error.code !== 262)"
    "      throw new Error('bad TLS metadata did not fail closed');"
    "  };"
    "})";

void app_main(void) {
  const pocketjs_net_esp_runtime_descriptor_t *descriptor =
      pocketjs_net_esp_runtime_descriptor();
  assert(descriptor != NULL);
  assert(strcmp(descriptor->id, POCKETJS_NET_ESP_RUNTIME_ID) == 0);
  assert(descriptor->experimental);
  assert(!descriptor->advertises_public_capability);
  assert(descriptor->abi_major == 1U && descriptor->abi_minor == 1U);
  assert(descriptor->owner_only_quickjs);
  assert(!descriptor->worker_or_callback_calls_quickjs);
  assert(descriptor->frozen_accessor_free_binding);
  assert(descriptor->exact_plan_handshake);
  assert(descriptor->fixed_operation_pool);
  assert(descriptor->pocketjs_owned_native_buffer_floor_enforced);
  assert(descriptor->validation_snapshot_bytes ==
         POCKETJS_NET_ESP_TRANSPORT_MAX_PINNED_CA_PEM_BYTES + 1U);
  assert(descriptor->connection_reuse);
  assert(descriptor->bounded_connection_pool);
  assert(descriptor->max_cached_connections == descriptor->max_operations);
  assert(descriptor->exact_lease_ownership);
  assert(descriptor->explicit_three_phase_shutdown);
  assert(descriptor->plaintext_http);
  assert(descriptor->https_rejected_before_io);
  assert(descriptor->https_explicit_opt_in);
  assert(descriptor->exact_host_tls_profile);
  assert(descriptor->distinct_tls_errors);
  assert(descriptor->tls_close_notify);
  assert(descriptor->tls_close_notify_uses_operation_deadline);
  assert(!descriptor->tls_close_notify_waits_for_peer);
  assert(strcmp(descriptor->tls_provider_id,
                POCKETJS_NET_ESP_TLS_PROVIDER_ID) == 0);
  assert(descriptor->redirect_manual);
  assert(descriptor->redirect_error);
  assert(descriptor->redirect_follow);
  assert(!descriptor->redirect_replayable_stream_body);
  assert(descriptor->guest_execution_guarded_dispatch);

  pocketjs_esp_guest_t *guest = NULL;
  const pocketjs_esp_guest_config_t guest_config = {
      .memory_limit_bytes = 1024U * 1024U,
      .stack_limit_bytes = 24U * 1024U,
      .execution_timeout_us = 1000000U,
      .max_interrupt_checks = 100U,
  };
  assert(pocketjs_esp_guest_create(&guest_config, &guest) == ESP_OK);

  static const pocketjs_network_v1_feature_id_t features[] = {
      POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT,
  };
  pocketjs_net_esp_runtime_t *runtime = NULL;
  pocketjs_net_esp_runtime_config_t config = {
      .guest = guest,
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
              .buffered_body_bytes = {512U, 4096U, 16384U},
              .header_bytes = {1024U, 4096U, 8192U},
              .max_body_chunk_bytes = {512U, 2048U, 2048U},
              .max_operations = {1U, 1U, 1U},
              .native_buffer_bytes = {32768U, 524288U, 524288U},
          },
      .connect_timeout_us = 1000000U,
      .headers_timeout_us = 1000000U,
      .idle_timeout_us = 1000000U,
      .total_timeout_us = 4000000U,
      .wake = wake_runtime,
      .allow_endpoint = allow_endpoint,
  };
  memset(config.plan_hash, 0x5a, sizeof(config.plan_hash));
  size_t required_native_bytes = 0U;
  assert(pocketjs_net_esp_runtime_required_native_buffer_bytes(
      config.max_operations, &required_native_bytes));
  assert(required_native_bytes <=
         config.limits.native_buffer_bytes.default_value);
  pocketjs_net_esp_runtime_config_t underbudgeted = config;
  underbudgeted.limits.native_buffer_bytes.default_value =
      required_native_bytes - 1U;
  assert(pocketjs_net_esp_runtime_create(&underbudgeted, &runtime) ==
         ESP_ERR_INVALID_ARG);
  assert(runtime == NULL);
  ESP_LOGI(TAG, "network runtime owner task=%p",
           (void *)xTaskGetCurrentTaskHandle());
  assert(pocketjs_net_esp_runtime_create(&config, &runtime) == ESP_OK);

  JSValue binding = JS_UNDEFINED;
  assert(pocketjs_net_esp_runtime_get_binding(runtime, &binding) == ESP_OK);
  assert(pocketjs_esp_guest_mount_factory(guest, "esp-runtime-smoke.js",
                                          FACTORY, sizeof(FACTORY) - 1U,
                                          binding, NULL) == ESP_OK);
  JS_FreeValue(pocketjs_esp_guest_context(guest), binding);
  assert(pocketjs_esp_guest_call_frame(guest, 0U, NULL) == ESP_OK);

  pocketjs_net_esp_runtime_service_result_t service = {0};
  assert(pocketjs_net_esp_runtime_service(runtime,
                                          (uint64_t)esp_timer_get_time(), 1U,
                                          1U, 8U, 4096U, &service) == ESP_OK);
  assert(service.status == POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_DRAINED);
  assert(service.events_delivered == 0U);
  assert(!permission_called);

  assert(pocketjs_net_esp_runtime_begin_shutdown(
             runtime, (uint64_t)esp_timer_get_time()) == ESP_OK);
  assert(wake_called);
  assert(pocketjs_net_esp_runtime_service(runtime,
                                          (uint64_t)esp_timer_get_time(), 1U,
                                          1U, 8U, 4096U, &service) == ESP_OK);
  assert(pocketjs_net_esp_runtime_is_ready_to_destroy(runtime));

  pocketjs_net_esp_runtime_stats_t stats;
  assert(pocketjs_net_esp_runtime_get_stats(runtime, &stats) == ESP_OK);
  assert(stats.runtime_generation == 7U);
  assert(stats.configured_operation_slots == 1U);
  assert(stats.active_operations == 0U);
  assert(stats.initialized_operation_slots == 0U);
  assert(stats.last_command_sequence == 1U);
  assert(stats.poison_flags == 0U);

  assert(pocketjs_net_esp_runtime_destroy(runtime) == ESP_OK);
  assert(pocketjs_esp_guest_call_frame(guest, 0U, NULL) == ESP_OK);
  pocketjs_esp_guest_destroy(guest);

  permission_called = false;
  wake_called = false;
  guest = NULL;
  assert(pocketjs_esp_guest_create(&guest_config, &guest) == ESP_OK);
  static const pocketjs_network_v1_feature_id_t tls_features[] = {
      POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT,
      POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_TLS,
  };
  pocketjs_net_esp_runtime_config_t tls_config = config;
  tls_config.guest = guest;
  tls_config.feature_ids = tls_features;
  tls_config.feature_count = 2U;
  tls_config.providers.http_client_tls_source =
      POCKETJS_NET_ESP_RUNTIME_TLS_SELECTION_PROVIDER;
  tls_config.providers.http_client_tls_id = POCKETJS_NET_ESP_TLS_PROVIDER_ID;
  tls_config.tls_trust_source = POCKETJS_NET_ESP_TLS_TRUST_CERTIFICATE_BUNDLE;
  tls_config.wall_clock_trusted = trusted_wall_clock;
  tls_config.wall_clock_context = &tls_clock_context;
  runtime = NULL;
  assert(pocketjs_net_esp_runtime_create(&tls_config, &runtime) == ESP_OK);
  binding = JS_UNDEFINED;
  assert(pocketjs_net_esp_runtime_get_binding(runtime, &binding) == ESP_OK);
  assert(pocketjs_esp_guest_mount_factory(guest, "esp-runtime-tls-smoke.js",
                                          TLS_FACTORY, sizeof(TLS_FACTORY) - 1U,
                                          binding, NULL) == ESP_OK);
  JS_FreeValue(pocketjs_esp_guest_context(guest), binding);
  assert(pocketjs_esp_guest_call_frame(guest, 0U, NULL) == ESP_OK);
  assert(!permission_called && tls_clock_context == 0U);

  assert(pocketjs_net_esp_runtime_begin_shutdown(
             runtime, (uint64_t)esp_timer_get_time()) == ESP_OK);
  for (size_t turn = 0U;
       turn < 4U && !pocketjs_net_esp_runtime_is_ready_to_destroy(runtime);
       ++turn) {
    assert(pocketjs_net_esp_runtime_service(runtime,
                                            (uint64_t)esp_timer_get_time(), 1U,
                                            1U, 8U, 4096U, &service) == ESP_OK);
  }
  assert(wake_called && pocketjs_net_esp_runtime_is_ready_to_destroy(runtime));
  assert(pocketjs_net_esp_runtime_get_stats(runtime, &stats) == ESP_OK);
  assert(stats.configured_operation_slots == 1U &&
         stats.initialized_operation_slots == 1U &&
         stats.active_operations == 0U && stats.requests_started == 0U &&
         stats.last_command_sequence == 1U && stats.poison_flags == 0U);
  assert(pocketjs_net_esp_runtime_destroy(runtime) == ESP_OK);
  pocketjs_esp_guest_destroy(guest);
  ESP_LOGI(TAG, "POCKET_NET_ESP_RUNTIME_SMOKE PASS");
}
