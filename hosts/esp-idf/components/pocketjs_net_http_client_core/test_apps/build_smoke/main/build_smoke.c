// SPDX-License-Identifier: MIT

#include <assert.h>
#include <string.h>

#include "pocketjs/net/http_client_core_esp.h"

static bool permission_called;

static bool
allow_endpoint(void *context,
               const pocketjs_net_http_client_endpoint_t *endpoint) {
  (void)context;
  assert(endpoint != NULL);
  permission_called = true;
  return true;
}

void app_main(void) {
  const pocketjs_net_http_client_core_descriptor_t *descriptor =
      pocketjs_net_http_client_core_descriptor();
  assert(descriptor != NULL);
  assert(strcmp(descriptor->id, POCKETJS_NET_HTTP_CLIENT_CORE_ID) == 0);
  assert(descriptor->experimental);
  assert(!descriptor->advertises_public_capability);
  assert(descriptor->plaintext_http);
  assert(descriptor->https_fail_closed_before_io);
  assert(descriptor->https_explicit_opt_in);
  assert(descriptor->owner_pumped);
  assert(descriptor->one_operation);
  assert(descriptor->fixed_core_storage);
  assert(descriptor->headers_first);
  assert(descriptor->explicit_body_credit);
  assert(descriptor->explicit_body_lease);
  assert(descriptor->connection_reuse);
  assert(descriptor->bounded_connection_pool);
  assert(descriptor->max_cached_connections == 1U);
  assert(descriptor->redirects_followed);
  assert(descriptor->redirect_manual);
  assert(descriptor->redirect_error);
  assert(descriptor->redirect_fixed_body_replay);
  assert(!descriptor->redirect_streaming_body_replay);
  assert(descriptor->connect_error_candidate_fallback);
  assert(!descriptor->hidden_retry);
  assert(!descriptor->hidden_auth);
  assert(!descriptor->hidden_cookie_store);
  assert(!descriptor->proxy);
  assert(!descriptor->content_decoding);
  assert(descriptor->cleanup_faults_separate_from_terminal);
  assert(descriptor->poison_is_machine_readable);
  assert(descriptor->explicit_shutdown_lifecycle);
  assert(descriptor->fixed_request_body);
  assert(descriptor->streaming_request_body);
  assert(descriptor->chunked_request_body);
  assert(descriptor->known_length_streaming_request_body);
  assert(!descriptor->streaming_request_body_buffered_in_full);
  assert(descriptor->instance_bytes ==
         POCKETJS_NET_HTTP_CLIENT_CORE_INSTANCE_BYTES);
  assert(descriptor->max_request_body_bytes ==
         POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REQUEST_BODY_BYTES);
  assert(descriptor->max_fixed_request_body_bytes ==
         POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REQUEST_BODY_BYTES);
  assert(descriptor->max_request_body_chunk_bytes ==
         POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES);

  const pocketjs_net_http_client_transport_ops_t *ops =
      pocketjs_net_http_client_core_esp_transport_ops();
  assert(ops != NULL);
  assert(ops->start_resolve != NULL);
  assert(ops->start_connect != NULL);
  assert(ops->start_read != NULL);
  assert(ops->start_write != NULL);
  assert(ops->start_close != NULL);

  static pocketjs_net_http_client_core_storage_t storage;
  pocketjs_net_http_client_core_t *core = NULL;
  pocketjs_net_http_client_core_config_t config = {
      .transport_ops = ops,
      .transport_context = NULL,
      .allow_endpoint = allow_endpoint,
      .permission_context = NULL,
      .connect_timeout_us = 1000000U,
      .headers_timeout_us = 1000000U,
      .idle_timeout_us = 1000000U,
      .total_timeout_us = 4000000U,
  };
  assert(pocketjs_net_http_client_core_init(&storage, &config, &core) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);

  static const uint8_t url[] = "https://example.com/";
  static const uint8_t method[] = "GET";
  pocketjs_net_http_client_request_t request = {
      .operation_token = 1U,
      .url = {.data = url, .length = sizeof(url) - 1U},
      .method = {.data = method, .length = sizeof(method) - 1U},
  };
  assert(pocketjs_net_http_client_core_start(core, &request, 1U) ==
         POCKETJS_NET_HTTP_CLIENT_START_UNSUPPORTED_TLS);
  assert(!permission_called);
  assert(pocketjs_net_http_client_core_begin_shutdown(core, 2U));
  assert(pocketjs_net_http_client_core_is_quiescent(core));
  assert(pocketjs_net_http_client_core_deinit(core));
}
