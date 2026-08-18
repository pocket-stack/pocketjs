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

typedef struct {
  const char *origin;
  const char *scheme;
  const char *host;
  uint16_t port;
  const char *health_url;
  const char *echo_url;
} pocketjs_net_formal_tls_smoke_endpoint_t;

typedef enum {
  POCKETJS_NET_FORMAL_TLS_SMOKE_PHASE_STARTING = 1,
  POCKETJS_NET_FORMAL_TLS_SMOKE_PHASE_HEALTH,
  POCKETJS_NET_FORMAL_TLS_SMOKE_PHASE_ECHO,
  POCKETJS_NET_FORMAL_TLS_SMOKE_PHASE_PASSED,
  POCKETJS_NET_FORMAL_TLS_SMOKE_PHASE_FAILED,
} pocketjs_net_formal_tls_smoke_phase_t;

#define POCKETJS_NET_FORMAL_TLS_SMOKE_ROUNDS 20U
#define POCKETJS_NET_FORMAL_TLS_SMOKE_REQUESTS 40U
#define POCKETJS_NET_FORMAL_TLS_SMOKE_DIAGNOSTIC_BYTES 65U
#define POCKETJS_NET_FORMAL_TLS_SMOKE_MIN_GUEST_MEMORY_BYTES                   \
  (2U * 1024U * 1024U)
#define POCKETJS_NET_FORMAL_TLS_SMOKE_RECOMMENDED_GUEST_MEMORY_BYTES           \
  (4U * 1024U * 1024U)
#define POCKETJS_NET_FORMAL_TLS_SMOKE_MIN_GUEST_STACK_BYTES (24U * 1024U)

typedef struct {
  uint32_t checkpoint;
  pocketjs_net_formal_tls_smoke_phase_t phase;
  uint32_t rounds_started;
  uint32_t rounds_passed;
  uint32_t requests_passed;
  uint32_t frame_calls;
  bool done;
  bool ok;
  char error_name[POCKETJS_NET_FORMAL_TLS_SMOKE_DIAGNOSTIC_BYTES];
  char error_code[POCKETJS_NET_FORMAL_TLS_SMOKE_DIAGNOSTIC_BYTES];
  char error_operation[POCKETJS_NET_FORMAL_TLS_SMOKE_DIAGNOSTIC_BYTES];
} pocketjs_net_formal_tls_smoke_report_t;

/** NUL-terminated factory storage; factory_length excludes the terminator. */
extern const uint8_t *const pocketjs_net_formal_tls_smoke_factory_bytes;
extern const size_t pocketjs_net_formal_tls_smoke_factory_length;
extern const size_t pocketjs_net_formal_tls_smoke_factory_storage_length;

extern const char pocketjs_net_formal_tls_smoke_plan_hash[];
extern const uint8_t pocketjs_net_formal_tls_smoke_plan_hash_bytes
    [POCKETJS_NETWORK_V1_PLAN_HASH_BYTES];
extern const pocketjs_network_v1_feature_id_t
    pocketjs_net_formal_tls_smoke_feature_ids[];
extern const uint16_t pocketjs_net_formal_tls_smoke_feature_count;

/** Exact provider selection copied from the verified Build Plan. */
extern const char pocketjs_net_formal_tls_smoke_http_client_backend_id[];
extern const char pocketjs_net_formal_tls_smoke_net_driver_id[];

extern const char pocketjs_net_formal_tls_smoke_factory_sha256[];
extern const uint8_t pocketjs_net_formal_tls_smoke_factory_sha256_bytes[32];
extern const pocketjs_net_formal_tls_smoke_endpoint_t
    pocketjs_net_formal_tls_smoke_endpoint;

/** Public test CA snapshot. The byte length excludes its trailing NUL. */
extern const uint8_t pocketjs_net_formal_tls_smoke_ca_pem[];
extern const size_t pocketjs_net_formal_tls_smoke_ca_pem_length;
extern const size_t pocketjs_net_formal_tls_smoke_ca_pem_storage_length;
extern const char pocketjs_net_formal_tls_smoke_ca_der_sha256[];
extern const char pocketjs_net_formal_tls_smoke_tls_provider_id[];

extern const char pocketjs_net_formal_tls_smoke_report_global[];
extern const char pocketjs_net_formal_tls_smoke_cancel_global[];

esp_err_t pocketjs_net_formal_tls_smoke_read_report(
    pocketjs_esp_guest_t *guest,
    pocketjs_net_formal_tls_smoke_report_t *out_report);

/** Invoke the test-only AbortController for the currently active request. */
esp_err_t
pocketjs_net_formal_tls_smoke_cancel_active_request(pocketjs_esp_guest_t *guest,
                                                    bool *out_cancelled);

typedef struct {
  /** Must equal the generated HTTPS origin exactly. */
  const char *configured_origin;
  /** Numeric IPv4 expected from stock lwIP DNS for pocketjs.test. */
  const char *configured_peer_ipv4;
  /** Host-owned, immutable trusted-clock decision used by ESP-TLS. */
  pocketjs_net_esp_wall_clock_trusted_fn wall_clock_trusted;
  void *wall_clock_context;
  size_t guest_memory_limit_bytes;
  size_t guest_stack_limit_bytes;
  uint64_t guest_execution_timeout_us;
  uint32_t guest_max_interrupt_checks;
  /** Zero selects the artifact's fixed default for each runtime deadline. */
  uint64_t connect_timeout_us;
  uint64_t headers_timeout_us;
  uint64_t idle_timeout_us;
  uint64_t total_timeout_us;
  /** Zero disables cancellation; otherwise abort the first active request. */
  uint32_t cancel_after_ms;
  uint32_t overall_timeout_ms;
  uint32_t shutdown_warning_ms;
} pocketjs_net_formal_tls_smoke_run_config_t;

typedef struct {
  pocketjs_net_formal_tls_smoke_report_t report;
  pocketjs_esp_guest_stats_t guest;
  pocketjs_net_esp_runtime_stats_t runtime;
  uint64_t service_turns;
  uint64_t guest_jobs_executed;
  uint64_t elapsed_ms;
  size_t owner_stack_low_water_bytes;
  bool shutdown_complete;
} pocketjs_net_formal_tls_smoke_run_result_t;

/**
 * Run the test-only TLS factory headlessly on a dedicated non-tcpip owner
 * task. DNS remains stock lwIP; the product test harness owns DNS server and
 * trusted wall-clock provisioning before this call. Public admission remains
 * closed, and this runner never calls globalThis.frame.
 */
esp_err_t pocketjs_net_formal_tls_smoke_run(
    const pocketjs_net_formal_tls_smoke_run_config_t *config,
    pocketjs_net_formal_tls_smoke_run_result_t *out_result);

#ifdef __cplusplus
}
#endif
