// SPDX-License-Identifier: MIT

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "pocketjs/esp_guest.h"
#include "pocketjs/net/esp_runtime.h"
#include "pocketjs_network_v1_abi.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Test-only canonical permission tuple compiled into the verified Build Plan.
 * A board Host must reject startup unless its configured peer origin matches
 * this tuple exactly.
 */
typedef struct {
  const char *origin;
  const char *scheme;
  const char *host;
  uint16_t port;
  const char *health_url;
  const char *echo_url;
} pocketjs_net_formal_smoke_endpoint_t;

typedef enum {
  POCKETJS_NET_FORMAL_SMOKE_PHASE_STARTING = 1,
  POCKETJS_NET_FORMAL_SMOKE_PHASE_HEALTH,
  POCKETJS_NET_FORMAL_SMOKE_PHASE_ECHO,
  POCKETJS_NET_FORMAL_SMOKE_PHASE_PASSED,
  POCKETJS_NET_FORMAL_SMOKE_PHASE_FAILED,
} pocketjs_net_formal_smoke_phase_t;

#define POCKETJS_NET_FORMAL_SMOKE_ROUNDS 20U
#define POCKETJS_NET_FORMAL_SMOKE_REQUESTS 40U
#define POCKETJS_NET_FORMAL_SMOKE_DIAGNOSTIC_BYTES 65U
#define POCKETJS_NET_FORMAL_SMOKE_MIN_GUEST_MEMORY_BYTES (2U * 1024U * 1024U)
#define POCKETJS_NET_FORMAL_SMOKE_RECOMMENDED_GUEST_MEMORY_BYTES               \
  (4U * 1024U * 1024U)
#define POCKETJS_NET_FORMAL_SMOKE_MIN_GUEST_STACK_BYTES (24U * 1024U)

typedef struct {
  uint32_t checkpoint;
  pocketjs_net_formal_smoke_phase_t phase;
  uint32_t rounds_started;
  uint32_t rounds_passed;
  uint32_t requests_passed;
  uint32_t frame_calls;
  bool done;
  bool ok;
  char error_name[POCKETJS_NET_FORMAL_SMOKE_DIAGNOSTIC_BYTES];
  char error_code[POCKETJS_NET_FORMAL_SMOKE_DIAGNOSTIC_BYTES];
  char error_operation[POCKETJS_NET_FORMAL_SMOKE_DIAGNOSTIC_BYTES];
} pocketjs_net_formal_smoke_report_t;

/** NUL-terminated factory storage; factory_length excludes the terminator. */
extern const uint8_t *const pocketjs_net_formal_smoke_factory_bytes;
extern const size_t pocketjs_net_formal_smoke_factory_length;
extern const size_t pocketjs_net_formal_smoke_factory_storage_length;

/** Full textual Build Plan hash plus the exact 32-byte handshake digest. */
extern const char pocketjs_net_formal_smoke_plan_hash[];
extern const uint8_t pocketjs_net_formal_smoke_plan_hash_bytes
    [POCKETJS_NETWORK_V1_PLAN_HASH_BYTES];

/** Strictly increasing exact network feature projection for the handshake. */
extern const pocketjs_network_v1_feature_id_t
    pocketjs_net_formal_smoke_feature_ids[];
extern const uint16_t pocketjs_net_formal_smoke_feature_count;

/** Exact provider selection copied from the verified Build Plan. */
extern const char pocketjs_net_formal_smoke_http_client_backend_id[];
extern const char pocketjs_net_formal_smoke_net_driver_id[];

/** SHA-256 of factory_length source bytes, excluding the trailing NUL. */
extern const char pocketjs_net_formal_smoke_factory_sha256[];
extern const uint8_t pocketjs_net_formal_smoke_factory_sha256_bytes[32];

extern const pocketjs_net_formal_smoke_endpoint_t
    pocketjs_net_formal_smoke_endpoint;

/** Global function installed by the Guest; each call returns a frozen report.
 */
extern const char pocketjs_net_formal_smoke_report_global[];

/**
 * Call and strictly snapshot the test-only report on the Guest owner task.
 * No eval string is used. The helper rejects proxies, accessors, wrong field
 * types, out-of-range counters, and inconsistent terminal states.
 */
esp_err_t pocketjs_net_formal_smoke_read_report(
    pocketjs_esp_guest_t *guest,
    pocketjs_net_formal_smoke_report_t *out_report);

/**
 * Owner-task configuration for the shared two-board hardware smoke.
 * configured_origin must exactly equal
 * pocketjs_net_formal_smoke_endpoint.origin. This function exclusively uses
 * FreeRTOS task notification index zero while it runs. All QuickJS allocations
 * are required to come from external RAM.
 */
typedef struct {
  const char *configured_origin;
  size_t guest_memory_limit_bytes;
  size_t guest_stack_limit_bytes;
  uint64_t guest_execution_timeout_us;
  uint32_t guest_max_interrupt_checks;
  uint32_t overall_timeout_ms;
  /** Emit a fail-stop diagnostic after this interval; cleanup still runs. */
  uint32_t shutdown_warning_ms;
} pocketjs_net_formal_smoke_run_config_t;

typedef struct {
  pocketjs_net_formal_smoke_report_t report;
  pocketjs_esp_guest_stats_t guest;
  pocketjs_net_esp_runtime_stats_t runtime;
  uint64_t service_turns;
  uint64_t guest_jobs_executed;
  uint64_t elapsed_ms;
  size_t owner_stack_low_water_bytes;
  bool shutdown_complete;
} pocketjs_net_formal_smoke_run_result_t;

/**
 * Create the Guest and formal runtime, mount the shared factory, run its
 * headless service loop, then always attempt the three-phase shutdown.
 * The caller must be a dedicated non-tcpip owner task with external RAM.
 * This function never calls globalThis.frame. Once a runtime exists it does
 * not return until native shutdown and Guest destruction are safe; a broken
 * native subsystem therefore leaves the owner task in fail-stop cleanup.
 */
esp_err_t pocketjs_net_formal_smoke_run(
    const pocketjs_net_formal_smoke_run_config_t *config,
    pocketjs_net_formal_smoke_run_result_t *out_result);

#ifdef __cplusplus
}
#endif
