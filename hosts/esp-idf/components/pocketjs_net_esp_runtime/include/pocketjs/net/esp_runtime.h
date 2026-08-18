// SPDX-License-Identifier: MIT

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "pocketjs/esp_guest.h"
#include "pocketjs/net/esp_transport.h"
#include "pocketjs/net/http_client_core.h"
#include "pocketjs_network_v1_abi.h"
#include "quickjs.h"

#ifdef __cplusplus
extern "C" {
#endif

#define POCKETJS_NET_ESP_RUNTIME_ID                                            \
  "pocketjs.net.esp-idf.runtime.v1.experimental"
#define POCKETJS_NET_ESP_RUNTIME_IMPLEMENTATION_VERSION                        \
  "esp-idf-v6.0.2-reference-candidate"

#define POCKETJS_NET_ESP_RUNTIME_MAX_OPERATIONS 8U
#define POCKETJS_NET_ESP_RUNTIME_MAX_FEATURES 2U
#define POCKETJS_NET_ESP_RUNTIME_MAX_REDIRECTS 5U
#define POCKETJS_NET_ESP_RUNTIME_MAX_LIMIT_ENTRIES 5U
#define POCKETJS_NET_ESP_RUNTIME_SEQUENCE_MAX UINT64_C(9007199254740991)

typedef struct pocketjs_net_esp_runtime pocketjs_net_esp_runtime_t;

typedef void (*pocketjs_net_esp_runtime_wake_fn)(void *context);
typedef bool (*pocketjs_net_esp_runtime_permission_fn)(
    void *context, const pocketjs_net_http_client_endpoint_t *endpoint);

typedef struct {
  uint64_t minimum;
  uint64_t default_value;
  uint64_t hard;
} pocketjs_net_esp_runtime_limit_range_t;

typedef struct {
  pocketjs_net_esp_runtime_limit_range_t buffered_body_bytes;
  pocketjs_net_esp_runtime_limit_range_t header_bytes;
  pocketjs_net_esp_runtime_limit_range_t max_body_chunk_bytes;
  pocketjs_net_esp_runtime_limit_range_t max_operations;
  pocketjs_net_esp_runtime_limit_range_t native_buffer_bytes;
} pocketjs_net_esp_runtime_limits_t;

typedef enum {
  POCKETJS_NET_ESP_RUNTIME_ADMISSION_TEST_ONLY = 1,
  POCKETJS_NET_ESP_RUNTIME_ADMISSION_PUBLIC,
} pocketjs_net_esp_runtime_admission_t;

typedef enum {
  POCKETJS_NET_ESP_RUNTIME_TLS_SELECTION_NONE = 0,
  POCKETJS_NET_ESP_RUNTIME_TLS_SELECTION_PROVIDER,
  POCKETJS_NET_ESP_RUNTIME_TLS_SELECTION_BACKEND,
} pocketjs_net_esp_runtime_tls_selection_source_t;

typedef struct {
  const char *http_client_backend_id;
  const char *net_driver_id;
  pocketjs_net_esp_runtime_tls_selection_source_t http_client_tls_source;
  const char *http_client_tls_id;
} pocketjs_net_esp_runtime_provider_selection_t;

typedef struct {
  /** Guest borrowed until destroy; it supplies the owner context and guard. */
  pocketjs_esp_guest_t *guest;
  /** Non-zero generation selected by the product Host; it never wraps. */
  uint32_t runtime_generation;
  /** Exact digest portion of the verified sha256 Build Plan hash. */
  uint8_t plan_hash[POCKETJS_NETWORK_V1_PLAN_HASH_BYTES];
  /** Exact, strictly increasing network feature projection. */
  const pocketjs_network_v1_feature_id_t *feature_ids;
  uint16_t feature_count;
  /** Exact provider selection copied from the already verified Build Plan. */
  pocketjs_net_esp_runtime_provider_selection_t providers;
  /** Test-only plans never cause public capability advertisement. */
  pocketjs_net_esp_runtime_admission_t admission;
  /** One through POCKETJS_NET_ESP_RUNTIME_MAX_OPERATIONS. */
  uint16_t max_operations;
  pocketjs_net_esp_runtime_limits_t limits;
  uint64_t connect_timeout_us;
  uint64_t headers_timeout_us;
  uint64_t idle_timeout_us;
  uint64_t total_timeout_us;
  /** Host-selected immutable TLS profile; Guest code cannot replace it. */
  pocketjs_net_esp_tls_trust_source_t tls_trust_source;
  /** Borrowed only for create(); a valid pinned CA is copied before return. */
  const uint8_t *host_pinned_ca_pem;
  size_t host_pinned_ca_pem_bytes;
  /**
   * Borrowed through successful destroy(). Called only by the owner pump; it
   * must read already-published trusted-clock state without blocking,
   * re-entering the runtime, or entering QuickJS.
   */
  pocketjs_net_esp_wall_clock_trusted_fn wall_clock_trusted;
  void *wall_clock_context;
  /** May run from lwIP's tcpip task; it may only signal the scheduler. */
  pocketjs_net_esp_runtime_wake_fn wake;
  void *wake_context;
  /**
   * Runs synchronously on the owner task before hostname and numeric I/O.
   * It must only inspect the endpoint and return; it must not reenter the
   * Guest or this runtime. Reentrant service/shutdown calls fail closed.
   */
  pocketjs_net_esp_runtime_permission_fn allow_endpoint;
  void *permission_context;
} pocketjs_net_esp_runtime_config_t;

typedef enum {
  POCKETJS_NET_ESP_RUNTIME_PHASE_RUNNING = 1,
  POCKETJS_NET_ESP_RUNTIME_PHASE_SHUTDOWN_REQUESTED,
  POCKETJS_NET_ESP_RUNTIME_PHASE_QUIESCING,
  POCKETJS_NET_ESP_RUNTIME_PHASE_READY_TO_DESTROY,
} pocketjs_net_esp_runtime_phase_t;

typedef struct {
  const char *id;
  const char *implementation_version;
  bool experimental;
  bool advertises_public_capability;
  uint16_t abi_major;
  uint16_t abi_minor;
  bool owner_only_quickjs;
  bool worker_or_callback_calls_quickjs;
  bool frozen_accessor_free_binding;
  bool exact_plan_handshake;
  bool endpoint_permission_rechecked;
  bool fixed_operation_pool;
  bool pocketjs_owned_native_buffer_floor_enforced;
  bool connection_reuse;
  bool bounded_connection_pool;
  bool exact_lease_ownership;
  bool explicit_three_phase_shutdown;
  bool plaintext_http;
  bool https_rejected_before_io;
  bool https_explicit_opt_in;
  bool exact_host_tls_profile;
  bool distinct_tls_errors;
  bool tls_close_notify;
  bool tls_close_notify_uses_operation_deadline;
  bool tls_close_notify_waits_for_peer;
  const char *tls_provider_id;
  bool redirect_manual;
  bool redirect_error;
  bool redirect_follow;
  bool redirect_replayable_stream_body;
  bool guest_execution_guarded_dispatch;
  bool hidden_retry;
  bool hidden_auth;
  bool hidden_cookie_store;
  bool proxy;
  bool content_decoding;
  size_t max_operations;
  size_t max_cached_connections;
  size_t max_redirects;
  size_t operation_slot_bytes;
  size_t validation_snapshot_bytes;
} pocketjs_net_esp_runtime_descriptor_t;

typedef struct {
  pocketjs_net_esp_runtime_phase_t phase;
  uint32_t runtime_generation;
  uint16_t configured_operation_slots;
  uint16_t initialized_operation_slots;
  uint16_t active_operations;
  uint16_t pending_core_events;
  uint16_t queued_leases;
  uint16_t taken_leases;
  uint64_t last_command_sequence;
  uint64_t last_completion_sequence;
  uint64_t last_service_turn;
  uint64_t requests_started;
  uint64_t completions_delivered;
  uint64_t leases_taken;
  uint64_t leases_released;
  uint64_t leases_cleaned_up;
  uint64_t permission_checks;
  uint32_t poison_flags;
  uint16_t poisoned_core_slots;
  uint32_t core_poison_flags;
  int32_t first_core_poison_cause_code;
  size_t runtime_instance_bytes;
  size_t core_storage_bytes;
  size_t transport_instances;
  size_t pocketjs_owned_native_bytes;
  size_t admitted_native_buffer_bytes;
} pocketjs_net_esp_runtime_stats_t;

typedef struct {
  pocketjs_network_v1_service_turn_status_t status;
  uint32_t events_delivered;
  uint32_t payload_bytes_delivered;
  uint64_t last_sequence;
} pocketjs_net_esp_runtime_service_result_t;

const pocketjs_net_esp_runtime_descriptor_t *
pocketjs_net_esp_runtime_descriptor(void);

/**
 * Compute the maximum PocketJS-owned native allocation payload for the fixed
 * runtime, binding tombstone, configured slots, transports, and CA-validation
 * snapshot. Allocator metadata and IDF-owned lwIP/Mbed TLS pools are excluded
 * and remain separate descriptor/admission requirements.
 */
bool pocketjs_net_esp_runtime_required_native_buffer_bytes(
    uint16_t max_operations, size_t *out_bytes);

/** Create on the same FreeRTOS task that owns quickjs_context. */
esp_err_t
pocketjs_net_esp_runtime_create(const pocketjs_net_esp_runtime_config_t *config,
                                pocketjs_net_esp_runtime_t **out_runtime);

/** Return an owned reference to the frozen private ABI table. */
esp_err_t
pocketjs_net_esp_runtime_get_binding(pocketjs_net_esp_runtime_t *runtime,
                                     JSValue *out_binding);

/**
 * Pump bounded native work, then invoke the registered formal dispatcher on
 * the owner task. During shutdown the invocation kind is SHUTDOWN.
 *
 * The registered dispatcher runs through pocketjs_esp_guest_call_function(),
 * under the Guest's interrupt-count and monotonic execution-time guard.
 */
esp_err_t pocketjs_net_esp_runtime_service(
    pocketjs_net_esp_runtime_t *runtime, uint64_t now_us,
    uint32_t max_native_steps, uint32_t max_transport_completions,
    uint32_t max_events, uint32_t max_payload_bytes,
    pocketjs_net_esp_runtime_service_result_t *out_result);

/** Phase 1: permanently stop admission and request bounded cancellation. */
esp_err_t
pocketjs_net_esp_runtime_begin_shutdown(pocketjs_net_esp_runtime_t *runtime,
                                        uint64_t now_us);

/** Phase 2 completes through repeated service calls until this becomes true. */
bool pocketjs_net_esp_runtime_is_ready_to_destroy(
    const pocketjs_net_esp_runtime_t *runtime);

/**
 * Phase 3: destroy quiescent transports, deinitialize Cores, and release
 * QuickJS values. The pocketjs_esp_guest context must still be alive.
 */
esp_err_t pocketjs_net_esp_runtime_destroy(pocketjs_net_esp_runtime_t *runtime);

esp_err_t
pocketjs_net_esp_runtime_get_stats(pocketjs_net_esp_runtime_t *runtime,
                                   pocketjs_net_esp_runtime_stats_t *out_stats);

#ifdef __cplusplus
}
#endif
