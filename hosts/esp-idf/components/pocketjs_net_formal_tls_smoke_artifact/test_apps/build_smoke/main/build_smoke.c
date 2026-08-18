// SPDX-License-Identifier: MIT

#include <assert.h>
#include <string.h>

#include "pocketjs/net/formal_tls_smoke_artifact.h"

static bool trusted_wall_clock(void *context) { return context != NULL; }

void app_main(void) {
  assert(pocketjs_net_formal_tls_smoke_factory_bytes != NULL);
  assert(pocketjs_net_formal_tls_smoke_factory_storage_length ==
         pocketjs_net_formal_tls_smoke_factory_length + 1U);
  assert(pocketjs_net_formal_tls_smoke_factory_bytes
             [pocketjs_net_formal_tls_smoke_factory_length] == 0U);
  assert(pocketjs_net_formal_tls_smoke_feature_count == 2U);
  assert(pocketjs_net_formal_tls_smoke_feature_ids[0] ==
         POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT);
  assert(pocketjs_net_formal_tls_smoke_feature_ids[1] ==
         POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_TLS);
  assert(strcmp(pocketjs_net_formal_tls_smoke_endpoint.origin,
                "https://pocketjs.test:8443") == 0);
  assert(pocketjs_net_formal_tls_smoke_ca_pem_length == 1176U);
  assert(pocketjs_net_formal_tls_smoke_ca_pem_storage_length == 1177U);
  assert(pocketjs_net_formal_tls_smoke_ca_pem[1176] == 0U);
  assert(strcmp(pocketjs_net_formal_tls_smoke_ca_der_sha256,
                "sha256:318ae57f0fb82d12cf86431571fb6ec3556ecb74f530a5be"
                "6f741a482b5447af") == 0);
  assert(strcmp(pocketjs_net_formal_tls_smoke_report_global,
                "__pocketjsFormalNetworkTlsSmokeReportV1") == 0);
  assert(strcmp(pocketjs_net_formal_tls_smoke_cancel_global,
                "__pocketjsFormalNetworkTlsSmokeCancelV1") == 0);

  int clock_context = 1;
  const pocketjs_net_formal_tls_smoke_run_config_t config = {
      .configured_origin = pocketjs_net_formal_tls_smoke_endpoint.origin,
      .configured_peer_ipv4 = "192.0.2.1",
      .wall_clock_trusted = trusted_wall_clock,
      .wall_clock_context = &clock_context,
      .guest_memory_limit_bytes =
          POCKETJS_NET_FORMAL_TLS_SMOKE_RECOMMENDED_GUEST_MEMORY_BYTES,
      .guest_stack_limit_bytes =
          POCKETJS_NET_FORMAL_TLS_SMOKE_MIN_GUEST_STACK_BYTES,
      .guest_execution_timeout_us = 100000U,
      .guest_max_interrupt_checks = 100000U,
      .connect_timeout_us = 500000U,
      .headers_timeout_us = 1000000U,
      .idle_timeout_us = 1000000U,
      .total_timeout_us = 2000000U,
      .overall_timeout_ms = 120000U,
      .shutdown_warning_ms = 5000U,
  };
  assert(config.wall_clock_trusted(config.wall_clock_context));

  static const char *const ambiguous_ipv4[] = {
      "0", "0.0.0.0", "0177.0.0.1", "0x7f000001", "192.000.2.1",
  };
  for (size_t index = 0U;
       index < sizeof(ambiguous_ipv4) / sizeof(ambiguous_ipv4[0]); ++index) {
    pocketjs_net_formal_tls_smoke_run_config_t invalid = config;
    invalid.configured_peer_ipv4 = ambiguous_ipv4[index];
    pocketjs_net_formal_tls_smoke_run_result_t result = {0};
    assert(pocketjs_net_formal_tls_smoke_run(&invalid, &result) ==
           ESP_ERR_INVALID_ARG);
  }

  pocketjs_net_formal_tls_smoke_run_config_t invalid_cancel = config;
  invalid_cancel.cancel_after_ms = invalid_cancel.overall_timeout_ms;
  pocketjs_net_formal_tls_smoke_run_result_t invalid_cancel_result = {0};
  assert(pocketjs_net_formal_tls_smoke_run(
             &invalid_cancel, &invalid_cancel_result) == ESP_ERR_INVALID_ARG);
}
