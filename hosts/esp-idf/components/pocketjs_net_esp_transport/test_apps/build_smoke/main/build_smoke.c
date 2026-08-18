// SPDX-License-Identifier: MIT

#include <assert.h>
#include <stdint.h>
#include <string.h>

#include "mbedtls/ssl.h"
#include "mbedtls/x509.h"
#include "pocketjs/net/esp_transport.h"

void app_main(void) {
  assert(pocketjs_net_esp_transport_map_tls_error_for_test(
             MBEDTLS_ERR_X509_CERT_VERIFY_FAILED, 0U) ==
         POCKETJS_NET_ESP_ERROR_TLS_CERTIFICATE_INVALID);
  assert(pocketjs_net_esp_transport_map_tls_error_for_test(
             -MBEDTLS_ERR_X509_CERT_VERIFY_FAILED, 0U) ==
         POCKETJS_NET_ESP_ERROR_TLS_CERTIFICATE_INVALID);
  assert(pocketjs_net_esp_transport_map_tls_error_for_test(
             0, MBEDTLS_X509_BADCERT_CN_MISMATCH) ==
         POCKETJS_NET_ESP_ERROR_TLS_HOSTNAME_MISMATCH);
  assert(pocketjs_net_esp_transport_map_tls_error_for_test(
             0, MBEDTLS_X509_BADCERT_NOT_TRUSTED) ==
         POCKETJS_NET_ESP_ERROR_TLS_CERTIFICATE_INVALID);
  assert(pocketjs_net_esp_transport_map_tls_error_for_test(-0x1234, 0U) ==
         POCKETJS_NET_ESP_ERROR_TLS_HANDSHAKE_FAILED);

  const pocketjs_net_esp_transport_descriptor_t *descriptor =
      pocketjs_net_esp_transport_descriptor();
  assert(descriptor != NULL);
  assert(strcmp(descriptor->id, POCKETJS_NET_ESP_TRANSPORT_ID) == 0);
  assert(strlen(POCKETJS_NET_ESP_TLS_PROVIDER_ID) != 0U);
  assert(descriptor->experimental);
  assert(!descriptor->advertises_public_capability);
  assert(descriptor->ipv4);
  assert(descriptor->asynchronous_raw_dns);
  assert(descriptor->stock_lwip_dns_callbacks_only);
  assert(!descriptor->complete_dns_candidate_set);
  assert(descriptor->rejects_saturated_dns_candidate_prefix);
  assert(descriptor->dns_cancel_generation_cleanup);
  assert(!descriptor->synchronous_getaddrinfo_for_hostname);
  assert(!descriptor->esp_tls_numeric_getaddrinfo_internal);
  assert(descriptor->nonblocking_plain_tcp_steps);
  assert(descriptor->nonblocking_tls_steps);
  assert(!descriptor->bounded_native_step_wall_time);
  assert(descriptor->esp_tls_internal_select_timeout_ms == 0U);
  assert(descriptor->monotonic_deadlines);
  assert(descriptor->cancel_between_native_steps);
  assert(!descriptor->worker_or_callback_calls_quickjs);
  assert(descriptor->exact_one_terminal);
  assert(descriptor->aba_safe_tokens);
  assert(descriptor->fixed_operation_pool);
  assert(descriptor->fixed_completion_pool);
  assert(descriptor->fixed_payload_pool);
  assert(descriptor->tls_compiled);
  assert(descriptor->tls_1_2_only);
  assert(descriptor->host_trust);
  assert(descriptor->host_pinned_ca);
  assert(descriptor->hostname_verification);
  assert(descriptor->distinct_tls_errors);
  assert(descriptor->sni);
  assert(descriptor->trusted_wall_clock_required);
  assert(!descriptor->plaintext_fallback);
  assert(!descriptor->renegotiation);
  assert(!descriptor->early_data);
  assert(descriptor->tls_close_notify);
  assert(descriptor->tls_close_notify_uses_operation_deadline);
  assert(!descriptor->tls_close_notify_waits_for_peer);
  assert(!descriptor->bounded_lwip_dns_callback_allocation);
  assert(!descriptor->bounded_lwip_socket_allocation);
  assert(!descriptor->bounded_esp_tls_allocation);
  assert(!descriptor->bounded_mbedtls_x509_parse_allocation);
  assert(descriptor->pocketjs_owned_instance_bytes > 0U);
  assert(descriptor->lwip_static_callback_messages == 8U);
  assert(descriptor->max_dns_candidates == 4U);

  const pocketjs_net_esp_transport_config_t disabled = {
      .tls_trust_source = POCKETJS_NET_ESP_TLS_TRUST_DISABLED,
  };
  assert(pocketjs_net_esp_transport_validate_config(&disabled) == ESP_OK);
  pocketjs_net_esp_transport_config_t invalid = disabled;
  invalid.tls_trust_source = POCKETJS_NET_ESP_TLS_TRUST_HOST_PINNED_CA;
  assert(pocketjs_net_esp_transport_validate_config(&invalid) ==
         ESP_ERR_INVALID_ARG);

  assert(strcmp(pocketjs_net_esp_error_name(
                    POCKETJS_NET_ESP_ERROR_TLS_CERTIFICATE_INVALID),
                "tls_certificate_invalid") == 0);
  assert(strcmp(pocketjs_net_esp_error_name(
                    POCKETJS_NET_ESP_ERROR_TLS_HOSTNAME_MISMATCH),
                "tls_hostname_mismatch") == 0);
  assert(pocketjs_net_esp_error_name((pocketjs_net_esp_error_t)UINT16_MAX) ==
         NULL);
}
