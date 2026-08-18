// SPDX-License-Identifier: MIT

#include "pocketjs/net/http_client_core_esp.h"

#include <string.h>

_Static_assert(POCKETJS_NET_ESP_TRANSPORT_MAX_DNS_CANDIDATES ==
                   POCKETJS_NET_HTTP_CLIENT_CORE_MAX_DNS_CANDIDATES,
               "ESP transport and HTTP Core candidate bounds must match");

static pocketjs_net_http_client_transport_result_t map_result(esp_err_t error) {
  switch (error) {
  case ESP_OK:
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK;
  case ESP_ERR_NOT_FOUND:
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_EMPTY;
  case ESP_ERR_INVALID_ARG:
  case ESP_ERR_INVALID_STATE:
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_INVALID;
  case ESP_ERR_NO_MEM:
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_RESOURCE_LIMIT;
  default:
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_FAILED;
  }
}

static pocketjs_net_http_client_transport_connection_t
map_connection(pocketjs_net_esp_connection_t connection) {
  return (pocketjs_net_http_client_transport_connection_t){
      .slot = connection.slot,
      .generation = connection.generation,
  };
}

static pocketjs_net_esp_connection_t
map_esp_connection(pocketjs_net_http_client_transport_connection_t connection) {
  return (pocketjs_net_esp_connection_t){
      .slot = connection.slot,
      .generation = connection.generation,
  };
}

static pocketjs_net_http_client_transport_read_lease_t
map_lease(pocketjs_net_esp_read_lease_t lease) {
  return (pocketjs_net_http_client_transport_read_lease_t){
      .slot = lease.slot,
      .generation = lease.generation,
  };
}

static pocketjs_net_esp_read_lease_t
map_esp_lease(pocketjs_net_http_client_transport_read_lease_t lease) {
  return (pocketjs_net_esp_read_lease_t){
      .slot = lease.slot,
      .generation = lease.generation,
  };
}

static pocketjs_net_http_client_transport_error_t
map_error(pocketjs_net_esp_error_t error) {
  switch (error) {
  case POCKETJS_NET_ESP_ERROR_ABORTED:
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_ABORTED;
  case POCKETJS_NET_ESP_ERROR_TIMED_OUT:
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TIMED_OUT;
  case POCKETJS_NET_ESP_ERROR_DNS_NOT_FOUND:
  case POCKETJS_NET_ESP_ERROR_DNS_FAILED:
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_DNS;
  case POCKETJS_NET_ESP_ERROR_CONNECTION_REFUSED:
  case POCKETJS_NET_ESP_ERROR_NETWORK_UNREACHABLE:
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_CONNECT;
  case POCKETJS_NET_ESP_ERROR_CONNECTION_RESET:
  case POCKETJS_NET_ESP_ERROR_TRANSPORT_FAILED:
  case POCKETJS_NET_ESP_ERROR_CLOSED:
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_IO;
  case POCKETJS_NET_ESP_ERROR_TLS_CERTIFICATE_INVALID:
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TLS_CERTIFICATE_INVALID;
  case POCKETJS_NET_ESP_ERROR_TLS_HOSTNAME_MISMATCH:
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TLS_HOSTNAME_MISMATCH;
  case POCKETJS_NET_ESP_ERROR_TLS_HANDSHAKE_FAILED:
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TLS_HANDSHAKE_FAILED;
  case POCKETJS_NET_ESP_ERROR_TLS_VERSION_UNSUPPORTED:
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TLS_VERSION_UNSUPPORTED;
  case POCKETJS_NET_ESP_ERROR_TLS_ALERT:
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TLS_ALERT;
  case POCKETJS_NET_ESP_ERROR_BUSY:
  case POCKETJS_NET_ESP_ERROR_RESOURCE_LIMIT:
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_RESOURCE_LIMIT;
  case POCKETJS_NET_ESP_ERROR_INVALID_ARGUMENT:
  case POCKETJS_NET_ESP_ERROR_UNSUPPORTED:
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_INVALID;
  case POCKETJS_NET_ESP_ERROR_NONE:
  default:
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_NONE;
  }
}

static pocketjs_net_http_client_transport_result_t
esp_start_resolve(void *context, uint64_t token, const char *hostname,
                  uint64_t deadline_us) {
  pocketjs_net_esp_resolve_request_t request = {
      .hostname = hostname,
      .deadline_us = deadline_us,
  };
  return map_result(
      pocketjs_net_esp_transport_start_resolve(context, token, &request));
}

static pocketjs_net_http_client_transport_result_t
esp_start_connect(void *context, uint64_t token, uint32_t ipv4_be,
                  uint16_t port, bool tls, const char *original_hostname,
                  uint64_t deadline_us) {
  pocketjs_net_esp_connect_request_t request = {
      .ipv4_be = ipv4_be,
      .port = port,
      .tls = tls,
      .original_hostname = original_hostname,
      .deadline_us = deadline_us,
  };
  return map_result(
      pocketjs_net_esp_transport_start_connect(context, token, &request));
}

static pocketjs_net_http_client_transport_result_t
esp_start_read(void *context, uint64_t token,
               pocketjs_net_http_client_transport_connection_t connection,
               size_t maximum_bytes, uint64_t deadline_us) {
  pocketjs_net_esp_read_request_t request = {
      .connection = map_esp_connection(connection),
      .maximum_bytes = maximum_bytes,
      .deadline_us = deadline_us,
  };
  return map_result(
      pocketjs_net_esp_transport_start_read(context, token, &request));
}

static pocketjs_net_http_client_transport_result_t
esp_start_write(void *context, uint64_t token,
                pocketjs_net_http_client_transport_connection_t connection,
                const uint8_t *bytes, size_t length, uint64_t deadline_us) {
  pocketjs_net_esp_write_request_t request = {
      .connection = map_esp_connection(connection),
      .bytes = bytes,
      .length = length,
      .deadline_us = deadline_us,
  };
  return map_result(
      pocketjs_net_esp_transport_start_write(context, token, &request));
}

static pocketjs_net_http_client_transport_result_t
esp_start_close(void *context, uint64_t token,
                pocketjs_net_http_client_transport_connection_t connection,
                uint64_t deadline_us) {
  pocketjs_net_esp_close_request_t request = {
      .connection = map_esp_connection(connection),
      .deadline_us = deadline_us,
  };
  return map_result(
      pocketjs_net_esp_transport_start_close(context, token, &request));
}

static pocketjs_net_http_client_transport_result_t esp_cancel(void *context,
                                                              uint64_t token) {
  return map_result(pocketjs_net_esp_transport_cancel(context, token));
}

static pocketjs_net_http_client_transport_result_t
esp_pump(void *context, uint64_t now_us, size_t max_native_steps) {
  return map_result(
      pocketjs_net_esp_transport_pump(context, now_us, max_native_steps));
}

static pocketjs_net_http_client_transport_result_t esp_take_completion(
    void *context,
    pocketjs_net_http_client_transport_completion_t *out_completion) {
  pocketjs_net_esp_completion_t completion;
  esp_err_t error =
      pocketjs_net_esp_transport_take_completion(context, &completion);
  if (error != ESP_OK) {
    return map_result(error);
  }
  memset(out_completion, 0, sizeof(*out_completion));
  out_completion->operation_token = completion.operation_token;
  switch (completion.type) {
  case POCKETJS_NET_ESP_TERMINAL_RESOLVED:
    out_completion->type = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_RESOLVED;
    out_completion->detail.resolved.candidate_count =
        completion.detail.resolved.candidate_count;
    size_t copy_count = out_completion->detail.resolved.candidate_count;
    if (copy_count > POCKETJS_NET_HTTP_CLIENT_CORE_MAX_DNS_CANDIDATES) {
      copy_count = POCKETJS_NET_HTTP_CLIENT_CORE_MAX_DNS_CANDIDATES;
    }
    memcpy(out_completion->detail.resolved.ipv4_be,
           completion.detail.resolved.ipv4_be,
           copy_count * sizeof(out_completion->detail.resolved.ipv4_be[0]));
    break;
  case POCKETJS_NET_ESP_TERMINAL_CONNECTED:
    out_completion->type = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_CONNECTED;
    out_completion->detail.connected.connection =
        map_connection(completion.detail.connected.connection);
    out_completion->detail.connected.ipv4_be =
        completion.detail.connected.ipv4_be;
    out_completion->detail.connected.tls = completion.detail.connected.tls;
    break;
  case POCKETJS_NET_ESP_TERMINAL_READ:
    out_completion->type = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_READ;
    out_completion->detail.read.connection =
        map_connection(completion.detail.read.connection);
    out_completion->detail.read.lease = map_lease(completion.detail.read.lease);
    out_completion->detail.read.byte_count = completion.detail.read.byte_count;
    out_completion->detail.read.eof = completion.detail.read.eof;
    break;
  case POCKETJS_NET_ESP_TERMINAL_WRITTEN:
    out_completion->type = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_WRITTEN;
    out_completion->detail.written.connection =
        map_connection(completion.detail.written.connection);
    out_completion->detail.written.byte_count =
        completion.detail.written.byte_count;
    break;
  case POCKETJS_NET_ESP_TERMINAL_CLOSED:
    out_completion->type = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_CLOSED;
    out_completion->detail.closed.connection =
        map_connection(completion.detail.closed.connection);
    break;
  case POCKETJS_NET_ESP_TERMINAL_ERROR:
  default:
    out_completion->type = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR;
    out_completion->detail.error.code = map_error(completion.detail.error.code);
    out_completion->detail.error.cause_code =
        completion.detail.error.cause_code;
    break;
  }
  return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK;
}

static pocketjs_net_http_client_transport_result_t
esp_retire_completion(void *context, uint64_t token) {
  return map_result(
      pocketjs_net_esp_transport_retire_completion(context, token));
}

static pocketjs_net_http_client_transport_result_t
esp_read_lease_view(void *context,
                    pocketjs_net_http_client_transport_read_lease_t lease,
                    const uint8_t **out_bytes, size_t *out_capacity) {
  return map_result(pocketjs_net_esp_transport_read_lease_view(
      context, map_esp_lease(lease), out_bytes, out_capacity));
}

static pocketjs_net_http_client_transport_result_t
esp_release_read_lease(void *context,
                       pocketjs_net_http_client_transport_read_lease_t lease) {
  return map_result(pocketjs_net_esp_transport_release_read_lease(
      context, map_esp_lease(lease)));
}

const pocketjs_net_http_client_transport_ops_t *
pocketjs_net_http_client_core_esp_transport_ops(void) {
  static const pocketjs_net_http_client_transport_ops_t ops = {
      .start_resolve = esp_start_resolve,
      .start_connect = esp_start_connect,
      .start_read = esp_start_read,
      .start_write = esp_start_write,
      .start_close = esp_start_close,
      .cancel = esp_cancel,
      .pump = esp_pump,
      .take_completion = esp_take_completion,
      .retire_completion = esp_retire_completion,
      .read_lease_view = esp_read_lease_view,
      .release_read_lease = esp_release_read_lease,
  };
  return &ops;
}
