// SPDX-License-Identifier: MIT

#include "pocketjs/net/http_client_core.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef enum {
  FAKE_NONE = 0,
  FAKE_RESOLVE,
  FAKE_CONNECT,
  FAKE_READ,
  FAKE_WRITE,
  FAKE_CLOSE,
} fake_kind_t;

typedef struct {
  fake_kind_t active_kind;
  uint64_t active_token;
  uint64_t active_deadline;
  bool completion_queued;
  bool completion_delivering;
  pocketjs_net_http_client_transport_completion_t completion;
  pocketjs_net_http_client_transport_connection_t connection;
  uint32_t connect_ipv4_be;
  uint16_t connect_port;
  bool connect_tls;
  char resolve_hostname[254];
  char connect_hostname[254];
  uint8_t write_bytes[4096];
  size_t write_length;
  size_t requested_read_bytes;
  uint8_t read_bytes[4096];
  size_t read_length;
  bool read_lease_active;
  uint64_t read_lease_generation;
  size_t starts[6];
  size_t start_attempts[6];
  size_t cancels;
  size_t retires;
  size_t releases;
  size_t release_attempts;
  size_t pump_calls;
  size_t take_attempts;
  pocketjs_net_http_client_transport_result_t start_failure[6];
  pocketjs_net_http_client_transport_result_t cancel_failure;
  pocketjs_net_http_client_transport_result_t pump_failure;
  pocketjs_net_http_client_transport_result_t take_failure;
  pocketjs_net_http_client_transport_result_t retire_failure;
  pocketjs_net_http_client_transport_result_t lease_view_failure;
  pocketjs_net_http_client_transport_result_t lease_release_failure;
} fake_transport_t;

static pocketjs_net_http_client_transport_result_t
fake_start(fake_transport_t *fake, fake_kind_t kind, uint64_t token,
           uint64_t deadline) {
  ++fake->start_attempts[kind];
  if (fake->start_failure[kind] != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    return fake->start_failure[kind];
  }
  if (fake->active_kind != FAKE_NONE || token == 0U || deadline == 0U) {
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_BUSY;
  }
  fake->active_kind = kind;
  fake->active_token = token;
  fake->active_deadline = deadline;
  ++fake->starts[kind];
  return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK;
}

static pocketjs_net_http_client_transport_result_t
fake_start_resolve(void *context, uint64_t token, const char *hostname,
                   uint64_t deadline_us) {
  fake_transport_t *fake = context;
  if (fake->cancel_failure != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    return fake->cancel_failure;
  }
  size_t length = strlen(hostname);
  assert(length < sizeof(fake->resolve_hostname));
  memcpy(fake->resolve_hostname, hostname, length + 1U);
  return fake_start(fake, FAKE_RESOLVE, token, deadline_us);
}

static pocketjs_net_http_client_transport_result_t
fake_start_connect(void *context, uint64_t token, uint32_t ipv4_be,
                   uint16_t port, bool tls, const char *original_hostname,
                   uint64_t deadline_us) {
  fake_transport_t *fake = context;
  size_t length = strlen(original_hostname);
  assert(length < sizeof(fake->connect_hostname));
  memcpy(fake->connect_hostname, original_hostname, length + 1U);
  fake->connect_ipv4_be = ipv4_be;
  fake->connect_port = port;
  fake->connect_tls = tls;
  return fake_start(fake, FAKE_CONNECT, token, deadline_us);
}

static pocketjs_net_http_client_transport_result_t
fake_start_read(void *context, uint64_t token,
                pocketjs_net_http_client_transport_connection_t connection,
                size_t maximum_bytes, uint64_t deadline_us) {
  fake_transport_t *fake = context;
  assert(connection.slot == fake->connection.slot);
  assert(connection.generation == fake->connection.generation);
  assert(maximum_bytes != 0U);
  fake->requested_read_bytes = maximum_bytes;
  return fake_start(fake, FAKE_READ, token, deadline_us);
}

static pocketjs_net_http_client_transport_result_t
fake_start_write(void *context, uint64_t token,
                 pocketjs_net_http_client_transport_connection_t connection,
                 const uint8_t *bytes, size_t length, uint64_t deadline_us) {
  fake_transport_t *fake = context;
  assert(connection.slot == fake->connection.slot);
  assert(connection.generation == fake->connection.generation);
  assert(length <= sizeof(fake->write_bytes));
  memcpy(fake->write_bytes, bytes, length);
  fake->write_length = length;
  return fake_start(fake, FAKE_WRITE, token, deadline_us);
}

static pocketjs_net_http_client_transport_result_t
fake_start_close(void *context, uint64_t token,
                 pocketjs_net_http_client_transport_connection_t connection,
                 uint64_t deadline_us) {
  fake_transport_t *fake = context;
  assert(connection.slot == fake->connection.slot);
  assert(connection.generation == fake->connection.generation);
  return fake_start(fake, FAKE_CLOSE, token, deadline_us);
}

static void fake_queue_error(fake_transport_t *fake,
                             pocketjs_net_http_client_transport_error_t error,
                             int32_t cause) {
  assert(!fake->completion_queued && !fake->completion_delivering);
  fake->completion = (pocketjs_net_http_client_transport_completion_t){
      .type = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR,
      .operation_token = fake->active_token,
      .detail.error = {.code = error, .cause_code = cause},
  };
  fake->completion_queued = true;
  fake->active_kind = FAKE_NONE;
}

static pocketjs_net_http_client_transport_result_t fake_cancel(void *context,
                                                               uint64_t token) {
  fake_transport_t *fake = context;
  if (fake->active_kind == FAKE_NONE || fake->active_token != token) {
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_INVALID;
  }
  ++fake->cancels;
  fake_queue_error(fake, POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_ABORTED, 0);
  return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK;
}

static pocketjs_net_http_client_transport_result_t
fake_pump(void *context, uint64_t now_us, size_t max_native_steps) {
  fake_transport_t *fake = context;
  assert(now_us != 0U);
  assert(max_native_steps != 0U);
  ++fake->pump_calls;
  return fake->pump_failure;
}

static pocketjs_net_http_client_transport_result_t fake_take_completion(
    void *context,
    pocketjs_net_http_client_transport_completion_t *out_completion) {
  fake_transport_t *fake = context;
  ++fake->take_attempts;
  if (fake->take_failure != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    return fake->take_failure;
  }
  if (!fake->completion_queued) {
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_EMPTY;
  }
  assert(!fake->completion_delivering);
  *out_completion = fake->completion;
  fake->completion_queued = false;
  fake->completion_delivering = true;
  return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK;
}

static pocketjs_net_http_client_transport_result_t
fake_retire_completion(void *context, uint64_t token) {
  fake_transport_t *fake = context;
  if (fake->retire_failure != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    return fake->retire_failure;
  }
  if (!fake->completion_delivering ||
      fake->completion.operation_token != token) {
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_INVALID;
  }
  fake->completion_delivering = false;
  ++fake->retires;
  return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK;
}

static pocketjs_net_http_client_transport_result_t
fake_read_lease_view(void *context,
                     pocketjs_net_http_client_transport_read_lease_t lease,
                     const uint8_t **out_bytes, size_t *out_capacity) {
  fake_transport_t *fake = context;
  if (fake->lease_view_failure != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    return fake->lease_view_failure;
  }
  if (!fake->read_lease_active || lease.slot != 0U ||
      lease.generation != fake->read_lease_generation) {
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_INVALID;
  }
  *out_bytes = fake->read_bytes;
  *out_capacity = fake->read_length;
  return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK;
}

static pocketjs_net_http_client_transport_result_t
fake_release_read_lease(void *context,
                        pocketjs_net_http_client_transport_read_lease_t lease) {
  fake_transport_t *fake = context;
  ++fake->release_attempts;
  if (fake->lease_release_failure != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    return fake->lease_release_failure;
  }
  if (!fake->read_lease_active || lease.slot != 0U ||
      lease.generation != fake->read_lease_generation) {
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_INVALID;
  }
  fake->read_lease_active = false;
  ++fake->releases;
  return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK;
}

static const pocketjs_net_http_client_transport_ops_t fake_ops = {
    .start_resolve = fake_start_resolve,
    .start_connect = fake_start_connect,
    .start_read = fake_start_read,
    .start_write = fake_start_write,
    .start_close = fake_start_close,
    .cancel = fake_cancel,
    .pump = fake_pump,
    .take_completion = fake_take_completion,
    .retire_completion = fake_retire_completion,
    .read_lease_view = fake_read_lease_view,
    .release_read_lease = fake_release_read_lease,
};

static void fake_queue(fake_transport_t *fake,
                       pocketjs_net_http_client_transport_completion_t value) {
  assert(fake->active_kind != FAKE_NONE);
  assert(!fake->completion_queued && !fake->completion_delivering);
  value.operation_token = fake->active_token;
  fake->completion = value;
  fake->completion_queued = true;
  fake->active_kind = FAKE_NONE;
}

static void fake_complete_resolve(fake_transport_t *fake,
                                  const uint32_t *addresses, size_t count) {
  assert(fake->active_kind == FAKE_RESOLVE);
  pocketjs_net_http_client_transport_completion_t completion = {
      .type = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_RESOLVED,
  };
  assert(count <= POCKETJS_NET_HTTP_CLIENT_CORE_MAX_DNS_CANDIDATES);
  memcpy(completion.detail.resolved.ipv4_be, addresses,
         count * sizeof(addresses[0]));
  completion.detail.resolved.candidate_count = count;
  fake_queue(fake, completion);
}

static void fake_complete_connect(fake_transport_t *fake) {
  assert(fake->active_kind == FAKE_CONNECT);
  fake->connection = (pocketjs_net_http_client_transport_connection_t){
      .slot = 1U,
      .generation = 7U,
  };
  fake_queue(fake, (pocketjs_net_http_client_transport_completion_t){
                       .type = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_CONNECTED,
                       .detail.connected =
                           {
                               .connection = fake->connection,
                               .ipv4_be = fake->connect_ipv4_be,
                               .tls = fake->connect_tls,
                           },
                   });
}

static void fake_complete_write(fake_transport_t *fake) {
  assert(fake->active_kind == FAKE_WRITE);
  fake_queue(fake, (pocketjs_net_http_client_transport_completion_t){
                       .type = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_WRITTEN,
                       .detail.written =
                           {
                               .connection = fake->connection,
                               .byte_count = fake->write_length,
                           },
                   });
}

static void fake_complete_unexpected_read(
    fake_transport_t *fake,
    pocketjs_net_http_client_transport_connection_t connection,
    const char *bytes, bool eof) {
  size_t length = strlen(bytes);
  assert(length <= sizeof(fake->read_bytes));
  memcpy(fake->read_bytes, bytes, length);
  fake->read_length = length;
  if (length != 0U) {
    ++fake->read_lease_generation;
    fake->read_lease_active = true;
  }
  fake_queue(fake, (pocketjs_net_http_client_transport_completion_t){
                       .type = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_READ,
                       .detail.read =
                           {
                               .connection = connection,
                               .lease = {.slot = 0U,
                                         .generation =
                                             length == 0U
                                                 ? 0U
                                                 : fake->read_lease_generation},
                               .byte_count = length,
                               .eof = eof,
                           },
                   });
}

static void fake_complete_read(fake_transport_t *fake, const char *bytes,
                               bool eof) {
  assert(fake->active_kind == FAKE_READ);
  assert(strlen(bytes) <= fake->requested_read_bytes);
  fake_complete_unexpected_read(fake, fake->connection, bytes, eof);
}

static void fake_complete_close(fake_transport_t *fake) {
  assert(fake->active_kind == FAKE_CLOSE);
  fake_queue(fake, (pocketjs_net_http_client_transport_completion_t){
                       .type = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_CLOSED,
                       .detail.closed = {.connection = fake->connection},
                   });
}

typedef struct {
  bool allow_hostname;
  bool allowed_candidates[4];
  size_t hostname_calls;
  size_t numeric_calls;
  uint32_t candidates[4];
  char observed_hostname[254];
  uint16_t observed_port;
  bool exercise_reentrancy;
  size_t reentrancy_calls;
  pocketjs_net_http_client_core_t *core;
  pocketjs_net_http_client_core_storage_t *storage;
  const pocketjs_net_http_client_core_config_t *config;
} permission_log_t;

static bool
allow_endpoint(void *context,
               const pocketjs_net_http_client_endpoint_t *endpoint) {
  permission_log_t *log = context;
  if (log->exercise_reentrancy) {
    static const uint8_t url[] = "http://example.com/";
    static const uint8_t get[] = "GET";
    pocketjs_net_http_client_request_t request = {
        .operation_token = 99U,
        .url = {.data = url, .length = sizeof(url) - 1U},
        .method = {.data = get, .length = sizeof(get) - 1U},
    };
    pocketjs_net_http_client_event_t event;
    pocketjs_net_http_client_core_status_t status;
    pocketjs_net_http_client_core_t *reinitialized = NULL;
    const uint8_t *body = NULL;
    size_t body_length = 0U;
    pocketjs_net_http_client_body_lease_t lease = {0};
    assert(pocketjs_net_http_client_core_start(log->core, &request, 1U) ==
           POCKETJS_NET_HTTP_CLIENT_START_REENTRANT);
    assert(!pocketjs_net_http_client_core_abort(log->core, 1U));
    assert(!pocketjs_net_http_client_core_pump(log->core, 1U, 1U, 1U));
    assert(!pocketjs_net_http_client_core_grant_body_credit(log->core, 1U, 1U));
    static const uint8_t request_body_byte[] = "x";
    assert(!pocketjs_net_http_client_core_submit_request_body_chunk(
        log->core, 1U, 1U, 1U, request_body_byte, 1U));
    assert(!pocketjs_net_http_client_core_submit_request_body_end(log->core, 1U,
                                                                  1U, 1U));
    assert(!pocketjs_net_http_client_core_submit_request_body_error(
        log->core, 1U, 1U, 1U, 1));
    assert(!pocketjs_net_http_client_core_take_event(log->core, &event));
    assert(!pocketjs_net_http_client_core_retire_event(log->core, 1U));
    assert(!pocketjs_net_http_client_core_body_lease_view(log->core, lease,
                                                          &body, &body_length));
    assert(!pocketjs_net_http_client_core_release_body_lease(log->core, lease));
    assert(!pocketjs_net_http_client_core_get_status(log->core, &status));
    assert(!pocketjs_net_http_client_core_begin_shutdown(log->core, 1U));
    assert(!pocketjs_net_http_client_core_is_quiescent(log->core));
    assert(
        !pocketjs_net_http_client_core_confirm_transport_shutdown(log->core));
    assert(!pocketjs_net_http_client_core_report_host_event_retire_failure(
        log->core, 1U));
    assert(
        !pocketjs_net_http_client_core_abandon_event_after_transport_shutdown(
            log->core, 1U));
    assert(!pocketjs_net_http_client_core_deinit(log->core));
    assert(pocketjs_net_http_client_core_init(log->storage, log->config,
                                              &reinitialized) ==
           POCKETJS_NET_HTTP_CLIENT_START_BUSY);
    assert(reinitialized == NULL);
    ++log->reentrancy_calls;
  }
  size_t length = strlen(endpoint->hostname);
  assert(length < sizeof(log->observed_hostname));
  memcpy(log->observed_hostname, endpoint->hostname, length + 1U);
  log->observed_port = endpoint->port;
  if (endpoint->phase == POCKETJS_NET_HTTP_CLIENT_PERMISSION_HOSTNAME) {
    ++log->hostname_calls;
    return log->allow_hostname;
  }
  size_t index = log->numeric_calls++;
  assert(index < 4U);
  log->candidates[index] = endpoint->ipv4_be;
  return log->allowed_candidates[index];
}

typedef struct {
  pocketjs_net_http_client_core_storage_t storage;
  pocketjs_net_http_client_core_t *core;
  fake_transport_t fake;
  permission_log_t permissions;
  pocketjs_net_http_client_core_config_t config;
  uint64_t now;
} fixture_t;

static void fixture_init_with_options_and_reuse(fixture_t *fixture,
                                                size_t limit, bool allow_https,
                                                bool enable_reuse) {
  memset(fixture, 0, sizeof(*fixture));
  fixture->now = 1000000U;
  fixture->permissions.allow_hostname = true;
  for (size_t index = 0U; index < 4U; ++index) {
    fixture->permissions.allowed_candidates[index] = true;
  }
  fixture->config = (pocketjs_net_http_client_core_config_t){
      .transport_ops = &fake_ops,
      .transport_context = &fixture->fake,
      .allow_endpoint = allow_endpoint,
      .permission_context = &fixture->permissions,
      .connect_timeout_us = 100000U,
      .headers_timeout_us = 100000U,
      .idle_timeout_us = 100000U,
      .total_timeout_us = 1000000U,
      .allow_https = allow_https,
      .enable_connection_reuse = enable_reuse,
      .response_header_bytes_limit = limit,
  };
  assert(pocketjs_net_http_client_core_init(&fixture->storage, &fixture->config,
                                            &fixture->core) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  fixture->permissions.core = fixture->core;
  fixture->permissions.storage = &fixture->storage;
  fixture->permissions.config = &fixture->config;
}

static void fixture_init_with_options(fixture_t *fixture, size_t limit,
                                      bool allow_https) {
  fixture_init_with_options_and_reuse(fixture, limit, allow_https, false);
}

static void fixture_init_with_reuse(fixture_t *fixture, bool allow_https) {
  fixture_init_with_options_and_reuse(fixture, 0U, allow_https, true);
}

static void fixture_init_with_response_header_limit(fixture_t *fixture,
                                                    size_t limit) {
  fixture_init_with_options(fixture, limit, false);
}

static void fixture_init(fixture_t *fixture) {
  fixture_init_with_response_header_limit(fixture, 0U);
}

static void pump(fixture_t *fixture) {
  ++fixture->now;
  assert(
      pocketjs_net_http_client_core_pump(fixture->core, fixture->now, 8U, 8U));
}

static pocketjs_net_http_client_request_t make_get(uint64_t token,
                                                   const char *url) {
  static const uint8_t get[] = "GET";
  return (pocketjs_net_http_client_request_t){
      .operation_token = token,
      .url = {.data = (const uint8_t *)url, .length = strlen(url)},
      .method = {.data = get, .length = sizeof(get) - 1U},
  };
}

static pocketjs_net_http_client_request_t
make_tls_get(uint64_t token, const char *url, const char *hostname) {
  static pocketjs_net_http_client_tls_policy_t policy;
  pocketjs_net_http_client_request_t request = make_get(token, url);
  policy = (pocketjs_net_http_client_tls_policy_t){
      .server_name =
          {
              .data = (const uint8_t *)hostname,
              .length = strlen(hostname),
          },
      .minimum_version = POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_2,
      .maximum_version = POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_2,
      .client_certificate =
          POCKETJS_NET_HTTP_CLIENT_TLS_CLIENT_CERTIFICATE_NONE,
      .verification = POCKETJS_NET_HTTP_CLIENT_TLS_VERIFICATION_FULL,
      .revocation = POCKETJS_NET_HTTP_CLIENT_TLS_REVOCATION_HOST_DEFAULT,
  };
  request.tls = &policy;
  return request;
}

static pocketjs_net_http_client_event_t take_event(fixture_t *fixture,
                                                   int expected) {
  pocketjs_net_http_client_event_t event;
  assert(pocketjs_net_http_client_core_take_event(fixture->core, &event));
  assert((int)event.type == expected);
  return event;
}

static bool bytes_contain(const uint8_t *haystack, size_t haystack_length,
                          const char *needle) {
  size_t needle_length = strlen(needle);
  if (needle_length > haystack_length) {
    return false;
  }
  for (size_t index = 0U; index <= haystack_length - needle_length; ++index) {
    if (memcmp(haystack + index, needle, needle_length) == 0) {
      return true;
    }
  }
  return false;
}

static bool slice_equals(pocketjs_net_http_client_slice_t slice,
                         const char *expected) {
  const size_t length = strlen(expected);
  return slice.length == length && memcmp(slice.data, expected, length) == 0;
}

static void complete_dns_connect(fixture_t *fixture, uint32_t address) {
  assert(fixture->fake.active_kind == FAKE_RESOLVE);
  fake_complete_resolve(&fixture->fake, &address, 1U);
  pump(fixture);
  assert(fixture->fake.active_kind == FAKE_CONNECT);
  assert(fixture->fake.connect_ipv4_be == address);
  fake_complete_connect(&fixture->fake);
  pump(fixture);
  assert(fixture->fake.active_kind == FAKE_WRITE);
}

static void retire_event(fixture_t *fixture,
                         pocketjs_net_http_client_event_t event) {
  assert(pocketjs_net_http_client_core_retire_event(fixture->core,
                                                    event.sequence));
}

static pocketjs_net_http_client_core_status_t get_status(fixture_t *fixture) {
  pocketjs_net_http_client_core_status_t status;
  assert(pocketjs_net_http_client_core_get_status(fixture->core, &status));
  return status;
}

static void
connect_and_write_request(fixture_t *fixture,
                          const pocketjs_net_http_client_request_t *request,
                          const char *expected_request_line) {
  assert(pocketjs_net_http_client_core_start(fixture->core, request,
                                             fixture->now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  assert(fixture->fake.active_kind == FAKE_RESOLVE);
  uint32_t addresses[] = {0x0100007fU, 0x0200007fU, 0x0300007fU};
  fixture->permissions.allowed_candidates[0] = false;
  fixture->permissions.allowed_candidates[1] = true;
  fixture->permissions.allowed_candidates[2] = false;
  fake_complete_resolve(&fixture->fake, addresses, 3U);
  pump(fixture);
  assert(fixture->permissions.hostname_calls == 1U);
  assert(fixture->permissions.numeric_calls == 3U);
  assert(fixture->fake.connect_ipv4_be == addresses[1]);
  assert(!fixture->fake.connect_tls);
  fake_complete_connect(&fixture->fake);
  pump(fixture);
  assert(fixture->fake.active_kind == FAKE_WRITE);
  assert(bytes_contain(fixture->fake.write_bytes, fixture->fake.write_length,
                       expected_request_line));
  assert(bytes_contain(fixture->fake.write_bytes, fixture->fake.write_length,
                       "Host: example.com:8080\r\n"));
  assert(bytes_contain(fixture->fake.write_bytes, fixture->fake.write_length,
                       "Connection: close\r\n"));
  assert(bytes_contain(fixture->fake.write_bytes, fixture->fake.write_length,
                       "Accept-Encoding: identity\r\n"));
  fake_complete_write(&fixture->fake);
  pump(fixture);
  assert(fixture->fake.active_kind == FAKE_READ);
}

static void connect_and_write_get(fixture_t *fixture, uint64_t token,
                                  const char *url) {
  pocketjs_net_http_client_request_t request = make_get(token, url);
  connect_and_write_request(fixture, &request, "GET /x?q=1 HTTP/1.1\r\n");
}

static pocketjs_net_http_client_request_t
make_streaming_post(uint64_t token, bool length_known,
                    uint64_t content_length) {
  static const uint8_t url[] = "http://127.0.0.1/upload";
  static const uint8_t post[] = "POST";
  return (pocketjs_net_http_client_request_t){
      .operation_token = token,
      .url = {.data = url, .length = sizeof(url) - 1U},
      .method = {.data = post, .length = sizeof(post) - 1U},
      .body_kind = POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_STREAMING,
      .streaming_content_length_known = length_known,
      .streaming_content_length = content_length,
  };
}

static void
start_streaming_request(fixture_t *fixture,
                        const pocketjs_net_http_client_request_t *request) {
  assert(pocketjs_net_http_client_core_start(fixture->core, request,
                                             fixture->now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  assert(fixture->fake.active_kind == FAKE_CONNECT);
  fake_complete_connect(&fixture->fake);
  pump(fixture);
  assert(fixture->fake.active_kind == FAKE_WRITE);
  assert(bytes_contain(fixture->fake.write_bytes, fixture->fake.write_length,
                       "POST /upload HTTP/1.1\r\n"));
  if (request->streaming_content_length_known) {
    char expected[64];
    int length =
        snprintf(expected, sizeof(expected), "Content-Length: %llu\r\n",
                 (unsigned long long)request->streaming_content_length);
    assert(length > 0 && (size_t)length < sizeof(expected));
    assert(bytes_contain(fixture->fake.write_bytes, fixture->fake.write_length,
                         expected));
    assert(!bytes_contain(fixture->fake.write_bytes, fixture->fake.write_length,
                          "Transfer-Encoding: chunked\r\n"));
  } else {
    assert(bytes_contain(fixture->fake.write_bytes, fixture->fake.write_length,
                         "Transfer-Encoding: chunked\r\n"));
    assert(!bytes_contain(fixture->fake.write_bytes, fixture->fake.write_length,
                          "Content-Length:"));
  }
  fake_complete_write(&fixture->fake);
  pump(fixture);
}

static pocketjs_net_http_client_event_t
take_request_body_pull(fixture_t *fixture, size_t expected_maximum) {
  pocketjs_net_http_client_event_t pull =
      take_event(fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_REQUEST_BODY_PULL);
  assert(pull.operation_token != 0U);
  assert(pull.detail.request_body_pull.body_generation != 0U);
  assert(pull.detail.request_body_pull.pull_generation != 0U);
  assert(pull.detail.request_body_pull.maximum_bytes == expected_maximum);
  return pull;
}

static void retire_request_body_pull(fixture_t *fixture,
                                     pocketjs_net_http_client_event_t pull) {
  retire_event(fixture, pull);
  pocketjs_net_http_client_core_status_t status = get_status(fixture);
  assert(status.request_body_credit_outstanding);
  assert(!status.event_outstanding);
  assert(status.request_body_generation ==
         pull.detail.request_body_pull.body_generation);
  assert(status.request_body_pull_generation ==
         pull.detail.request_body_pull.pull_generation);
}

static void finish_empty_response(fixture_t *fixture) {
  assert(fixture->fake.active_kind == FAKE_READ);
  fake_complete_read(&fixture->fake, "HTTP/1.1 204 No Content\r\n\r\n", false);
  pump(fixture);
  pocketjs_net_http_client_event_t headers =
      take_event(fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  assert(headers.detail.response.status_code == 204U);
  retire_event(fixture, headers);
  assert(fixture->fake.active_kind == FAKE_CLOSE);
  fake_complete_close(&fixture->fake);
  pump(fixture);
  pocketjs_net_http_client_event_t complete =
      take_event(fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  retire_event(fixture, complete);
  assert(!pocketjs_net_http_client_core_take_event(fixture->core, &complete));
}

static void test_redirect_follow_resolves_relative_url(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  pocketjs_net_http_client_request_t request =
      make_get(1U, "http://example.com:8080/base/one?old=1");
  request.redirect_mode = POCKETJS_NET_HTTP_CLIENT_REDIRECT_FOLLOW;
  request.max_redirects = 5U;
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);

  complete_dns_connect(&fixture, 0x0100007fU);
  assert(bytes_contain(fixture.fake.write_bytes, fixture.fake.write_length,
                       "GET /base/one?old=1 HTTP/1.1\r\n"));
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_READ);

  fake_complete_read(&fixture.fake,
                     "HTTP/1.1 302 Found\r\nLocation: ../next?x=1#ignored\r\n"
                     "Content-Length: 4\r\n\r\nbody",
                     false);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_CLOSE);
  pocketjs_net_http_client_event_t event;
  assert(!pocketjs_net_http_client_core_take_event(fixture.core, &event));
  assert(fixture.fake.releases == 1U);

  fake_complete_close(&fixture.fake);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_RESOLVE);
  assert(strcmp(fixture.fake.resolve_hostname, "example.com") == 0);
  assert(fixture.permissions.hostname_calls == 2U);
  complete_dns_connect(&fixture, 0x0200007fU);
  assert(fixture.permissions.numeric_calls == 2U);
  assert(bytes_contain(fixture.fake.write_bytes, fixture.fake.write_length,
                       "GET /next?x=1 HTTP/1.1\r\n"));
  assert(bytes_contain(fixture.fake.write_bytes, fixture.fake.write_length,
                       "Host: example.com:8080\r\n"));
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  fake_complete_read(&fixture.fake, "HTTP/1.1 204 No Content\r\n\r\n", false);
  pump(&fixture);

  const pocketjs_net_http_client_event_t headers =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  assert(headers.detail.response.status_code == 204U);
  assert(headers.detail.response.redirected);
  assert(slice_equals(headers.detail.response.url,
                      "http://example.com:8080/next?x=1"));
  retire_event(&fixture, headers);
  assert(fixture.fake.active_kind == FAKE_CLOSE);
  fake_complete_close(&fixture.fake);
  pump(&fixture);
  const pocketjs_net_http_client_event_t complete =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  retire_event(&fixture, complete);
}

static void test_redirect_rechecks_permission_before_second_hop(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  pocketjs_net_http_client_request_t request =
      make_get(1U, "http://example.com/start");
  request.redirect_mode = POCKETJS_NET_HTTP_CLIENT_REDIRECT_FOLLOW;
  request.max_redirects = 5U;
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  complete_dns_connect(&fixture, 0x0100007fU);
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  fake_complete_read(
      &fixture.fake,
      "HTTP/1.1 302 Found\r\nLocation: http://denied.example/next\r\n"
      "Content-Length: 0\r\n\r\n",
      false);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_CLOSE);

  fixture.permissions.allow_hostname = false;
  fake_complete_close(&fixture.fake);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_NONE);
  assert(fixture.permissions.hostname_calls == 2U);
  assert(fixture.permissions.numeric_calls == 1U);
  assert(strcmp(fixture.permissions.observed_hostname, "denied.example") == 0);
  const pocketjs_net_http_client_event_t error =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code ==
         POCKETJS_NET_HTTP_CLIENT_ERROR_PERMISSION_DENIED);
  retire_event(&fixture, error);
}

static void test_redirect_rewrites_post_and_strips_cross_origin_headers(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  static const uint8_t post[] = "POST";
  static const uint8_t body[] = "payload";
  static const uint8_t authorization[] = "Authorization";
  static const uint8_t bearer[] = "Bearer secret";
  static const uint8_t cookie[] = "Cookie";
  static const uint8_t cookie_value[] = "a=b";
  static const uint8_t content_type[] = "Content-Type";
  static const uint8_t content_type_value[] = "text/plain";
  static const uint8_t keep[] = "X-Keep";
  static const uint8_t keep_value[] = "yes";
  const pocketjs_net_http_client_header_t headers[] = {
      {.name = {.data = authorization, .length = sizeof(authorization) - 1U},
       .value = {.data = bearer, .length = sizeof(bearer) - 1U}},
      {.name = {.data = cookie, .length = sizeof(cookie) - 1U},
       .value = {.data = cookie_value, .length = sizeof(cookie_value) - 1U}},
      {.name = {.data = content_type, .length = sizeof(content_type) - 1U},
       .value = {.data = content_type_value,
                 .length = sizeof(content_type_value) - 1U}},
      {.name = {.data = keep, .length = sizeof(keep) - 1U},
       .value = {.data = keep_value, .length = sizeof(keep_value) - 1U}},
  };
  pocketjs_net_http_client_request_t request = {
      .operation_token = 1U,
      .url = {.data = (const uint8_t *)"http://example.com:8080/start",
              .length = sizeof("http://example.com:8080/start") - 1U},
      .method = {.data = post, .length = sizeof(post) - 1U},
      .headers = headers,
      .header_count = sizeof(headers) / sizeof(headers[0]),
      .body_kind = POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_FIXED,
      .body = {.data = body, .length = sizeof(body) - 1U},
      .redirect_mode = POCKETJS_NET_HTTP_CLIENT_REDIRECT_FOLLOW,
      .max_redirects = 5U,
  };
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  complete_dns_connect(&fixture, 0x0100007fU);
  assert(bytes_contain(fixture.fake.write_bytes, fixture.fake.write_length,
                       "POST /start HTTP/1.1\r\n"));
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_WRITE);
  assert(fixture.fake.write_length == sizeof(body) - 1U);
  assert(memcmp(fixture.fake.write_bytes, body, sizeof(body) - 1U) == 0);
  fake_complete_write(&fixture.fake);
  pump(&fixture);

  fake_complete_read(
      &fixture.fake,
      "HTTP/1.1 302 Found\r\nLocation: http://other.example/final\r\n"
      "Content-Length: 0\r\n\r\n",
      false);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_CLOSE);
  fake_complete_close(&fixture.fake);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_RESOLVE);
  assert(strcmp(fixture.fake.resolve_hostname, "other.example") == 0);
  complete_dns_connect(&fixture, 0x0200007fU);
  assert(bytes_contain(fixture.fake.write_bytes, fixture.fake.write_length,
                       "GET /final HTTP/1.1\r\n"));
  assert(bytes_contain(fixture.fake.write_bytes, fixture.fake.write_length,
                       "Host: other.example\r\n"));
  assert(bytes_contain(fixture.fake.write_bytes, fixture.fake.write_length,
                       "X-Keep: yes\r\n"));
  assert(!bytes_contain(fixture.fake.write_bytes, fixture.fake.write_length,
                        "Authorization:"));
  assert(!bytes_contain(fixture.fake.write_bytes, fixture.fake.write_length,
                        "Cookie:"));
  assert(!bytes_contain(fixture.fake.write_bytes, fixture.fake.write_length,
                        "Content-Type:"));
  assert(!bytes_contain(fixture.fake.write_bytes, fixture.fake.write_length,
                        "Content-Length:"));
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_READ);
  finish_empty_response(&fixture);
}

static void
test_redirect_replays_fixed_body_and_rejects_streaming_replay(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  static const uint8_t post[] = "POST";
  static const uint8_t body[] = "abc";
  pocketjs_net_http_client_request_t request = {
      .operation_token = 1U,
      .url = {.data = (const uint8_t *)"http://example.com/upload",
              .length = sizeof("http://example.com/upload") - 1U},
      .method = {.data = post, .length = sizeof(post) - 1U},
      .body_kind = POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_FIXED,
      .body = {.data = body, .length = sizeof(body) - 1U},
      .redirect_mode = POCKETJS_NET_HTTP_CLIENT_REDIRECT_FOLLOW,
      .max_redirects = 5U,
  };
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  complete_dns_connect(&fixture, 0x0100007fU);
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_WRITE);
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  fake_complete_read(&fixture.fake,
                     "HTTP/1.1 307 Temporary Redirect\r\nLocation: /again\r\n"
                     "Content-Length: 0\r\n\r\n",
                     false);
  pump(&fixture);
  fake_complete_close(&fixture.fake);
  pump(&fixture);
  complete_dns_connect(&fixture, 0x0200007fU);
  assert(bytes_contain(fixture.fake.write_bytes, fixture.fake.write_length,
                       "POST /again HTTP/1.1\r\n"));
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_WRITE);
  assert(fixture.fake.write_length == sizeof(body) - 1U);
  assert(memcmp(fixture.fake.write_bytes, body, sizeof(body) - 1U) == 0);
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  finish_empty_response(&fixture);

  fixture_init(&fixture);
  request = make_streaming_post(1U, false, 0U);
  request.redirect_mode = POCKETJS_NET_HTTP_CLIENT_REDIRECT_FOLLOW;
  request.max_redirects = 5U;
  start_streaming_request(&fixture, &request);
  pocketjs_net_http_client_event_t pull = take_request_body_pull(
      &fixture, POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES);
  retire_request_body_pull(&fixture, pull);
  assert(pocketjs_net_http_client_core_submit_request_body_end(
      fixture.core, pull.operation_token,
      pull.detail.request_body_pull.body_generation,
      pull.detail.request_body_pull.pull_generation));
  assert(fixture.fake.active_kind == FAKE_WRITE);
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_READ);
  fake_complete_read(&fixture.fake,
                     "HTTP/1.1 307 Temporary Redirect\r\nLocation: /again\r\n"
                     "Content-Length: 0\r\n\r\n",
                     false);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_CLOSE);
  fake_complete_close(&fixture.fake);
  pump(&fixture);
  const pocketjs_net_http_client_event_t error =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code ==
         POCKETJS_NET_HTTP_CLIENT_ERROR_REDIRECT_BODY_NOT_REPLAYABLE);
  retire_event(&fixture, error);
}

static void test_redirect_modes_and_limit_fail_closed(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  pocketjs_net_http_client_request_t request =
      make_get(1U, "http://example.com/start");
  request.redirect_mode = POCKETJS_NET_HTTP_CLIENT_REDIRECT_ERROR;
  request.max_redirects = 5U;
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  complete_dns_connect(&fixture, 0x0100007fU);
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  fake_complete_read(&fixture.fake,
                     "HTTP/1.1 302 Found\r\nLocation: /next\r\n"
                     "Content-Length: 0\r\n\r\n",
                     false);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_CLOSE);
  fake_complete_close(&fixture.fake);
  pump(&fixture);
  pocketjs_net_http_client_event_t error =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code == POCKETJS_NET_HTTP_CLIENT_ERROR_REDIRECT);
  retire_event(&fixture, error);

  fixture_init(&fixture);
  request = make_get(1U, "http://example.com/start");
  request.redirect_mode = POCKETJS_NET_HTTP_CLIENT_REDIRECT_FOLLOW;
  request.max_redirects = 0U;
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  complete_dns_connect(&fixture, 0x0100007fU);
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  fake_complete_read(&fixture.fake,
                     "HTTP/1.1 302 Found\r\nLocation: /next\r\n"
                     "Content-Length: 0\r\n\r\n",
                     false);
  pump(&fixture);
  fake_complete_close(&fixture.fake);
  pump(&fixture);
  error = take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code ==
         POCKETJS_NET_HTTP_CLIENT_ERROR_REDIRECT_LIMIT);
  retire_event(&fixture, error);
}

static void test_headers_body_and_status_success(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  connect_and_write_get(&fixture, 1U, "http://EXAMPLE.com:8080/x?q=1");

  fake_complete_read(&fixture.fake,
                     "HTTP/1.1 404 Not Found\r\nContent-Length: 5\r\n"
                     "X-Test: yes\r\n\r\nhello",
                     false);
  pump(&fixture);
  pocketjs_net_http_client_event_t headers =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  assert(headers.detail.response.status_code == 404U);
  assert(headers.detail.response.header_count == 2U);
  assert(headers.detail.response.status_text.length == 9U);
  assert(memcmp(headers.detail.response.status_text.data, "Not Found", 9U) ==
         0);
  retire_event(&fixture, headers);

  assert(pocketjs_net_http_client_core_grant_body_credit(fixture.core, 1U, 3U));
  pump(&fixture);
  pocketjs_net_http_client_event_t body =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_BODY);
  const uint8_t *body_bytes = NULL;
  size_t body_length = 0U;
  assert(pocketjs_net_http_client_core_body_lease_view(
      fixture.core, body.detail.body.lease, &body_bytes, &body_length));
  assert(body_length == 3U && memcmp(body_bytes, "hel", 3U) == 0);
  assert(
      !pocketjs_net_http_client_core_retire_event(fixture.core, body.sequence));
  assert(pocketjs_net_http_client_core_release_body_lease(
      fixture.core, body.detail.body.lease));
  retire_event(&fixture, body);

  assert(pocketjs_net_http_client_core_grant_body_credit(fixture.core, 1U, 2U));
  pump(&fixture);
  body = take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_BODY);
  assert(pocketjs_net_http_client_core_body_lease_view(
      fixture.core, body.detail.body.lease, &body_bytes, &body_length));
  assert(body_length == 2U && memcmp(body_bytes, "lo", 2U) == 0);
  assert(pocketjs_net_http_client_core_release_body_lease(
      fixture.core, body.detail.body.lease));
  retire_event(&fixture, body);
  assert(pocketjs_net_http_client_core_grant_body_credit(fixture.core, 1U, 1U));
  pump(&fixture);
  assert(
      !pocketjs_net_http_client_core_grant_body_credit(fixture.core, 1U, 1U));
  assert(fixture.fake.active_kind == FAKE_CLOSE);
  fake_complete_close(&fixture.fake);
  pump(&fixture);
  pocketjs_net_http_client_event_t complete =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  retire_event(&fixture, complete);
  assert(!pocketjs_net_http_client_core_take_event(fixture.core, &complete));
  assert(fixture.fake.starts[FAKE_CONNECT] == 1U);
}

static void test_response_header_limit_configuration_boundaries(void) {
  fixture_t maximum;
  fixture_init_with_response_header_limit(
      &maximum, POCKETJS_NET_HTTP_CLIENT_CORE_MAX_RESPONSE_HEADER_BYTES);
  assert(
      pocketjs_net_http_client_core_begin_shutdown(maximum.core, maximum.now));
  assert(pocketjs_net_http_client_core_deinit(maximum.core));

  pocketjs_net_http_client_core_storage_t invalid_storage = {0};
  pocketjs_net_http_client_core_t *invalid_core = maximum.core;
  maximum.config.response_header_bytes_limit =
      POCKETJS_NET_HTTP_CLIENT_CORE_MAX_RESPONSE_HEADER_BYTES + 1U;
  assert(pocketjs_net_http_client_core_init(&invalid_storage, &maximum.config,
                                            &invalid_core) ==
         POCKETJS_NET_HTTP_CLIENT_START_INVALID_ARGUMENT);
  assert(invalid_core == NULL);

  fixture_t zero_uses_maximum;
  fixture_init_with_response_header_limit(&zero_uses_maximum, 0U);
  assert(pocketjs_net_http_client_core_begin_shutdown(zero_uses_maximum.core,
                                                      zero_uses_maximum.now));
  assert(pocketjs_net_http_client_core_deinit(zero_uses_maximum.core));
}

static void test_selected_response_header_limit(void) {
  enum { SELECTED_HEADER_BYTES = 19U };

  fixture_t exact;
  fixture_init_with_response_header_limit(&exact, SELECTED_HEADER_BYTES);
  connect_and_write_get(&exact, 1U, "http://example.com:8080/x?q=1");
  fake_complete_read(&exact.fake,
                     "HTTP/1.1 204 No Content\r\nX-Test: yes\r\nY: 1\r\n\r\n",
                     false);
  pump(&exact);
  pocketjs_net_http_client_event_t headers =
      take_event(&exact, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  assert(headers.detail.response.header_count == 2U);
  retire_event(&exact, headers);
  assert(exact.fake.active_kind == FAKE_CLOSE);
  fake_complete_close(&exact.fake);
  pump(&exact);
  pocketjs_net_http_client_event_t complete =
      take_event(&exact, POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  retire_event(&exact, complete);

  fixture_t exceeded;
  fixture_init_with_response_header_limit(&exceeded, SELECTED_HEADER_BYTES);
  connect_and_write_get(&exceeded, 1U, "http://example.com:8080/x?q=1");
  fake_complete_read(&exceeded.fake,
                     "HTTP/1.1 204 No Content\r\nX-Test: yes\r\nY: 12\r\n\r\n",
                     false);
  pump(&exceeded);
  pocketjs_net_http_client_event_t event;
  assert(!pocketjs_net_http_client_core_take_event(exceeded.core, &event));
  assert(exceeded.fake.active_kind == FAKE_CLOSE);
  fake_complete_close(&exceeded.fake);
  pump(&exceeded);
  event = take_event(&exceeded, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(event.detail.error.code ==
         POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT);
  retire_event(&exceeded, event);
  assert(!pocketjs_net_http_client_core_take_event(exceeded.core, &event));
}

static void test_https_and_permissions_fail_before_io(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  pocketjs_net_http_client_request_t request =
      make_get(1U, "https://example.com/");
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_UNSUPPORTED_TLS);
  assert(fixture.permissions.hostname_calls == 0U);
  assert(fixture.permissions.numeric_calls == 0U);
  assert(fixture.fake.active_kind == FAKE_NONE);

  fixture.permissions.allow_hostname = false;
  request = make_get(1U, "http://example.com/");
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  assert(fixture.permissions.hostname_calls == 1U);
  assert(fixture.fake.active_kind == FAKE_NONE);
  pocketjs_net_http_client_event_t error =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code ==
         POCKETJS_NET_HTTP_CLIENT_ERROR_PERMISSION_DENIED);
  retire_event(&fixture, error);

  fixture_t tls;
  fixture_init_with_options(&tls, 0U, true);
  static const uint8_t server_name[] = "example.com";
  static const pocketjs_net_http_client_tls_policy_t tls_policy = {
      .server_name = {.data = server_name, .length = sizeof(server_name) - 1U},
      .minimum_version = POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_2,
      .maximum_version = POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_2,
      .client_certificate =
          POCKETJS_NET_HTTP_CLIENT_TLS_CLIENT_CERTIFICATE_NONE,
      .verification = POCKETJS_NET_HTTP_CLIENT_TLS_VERIFICATION_FULL,
      .revocation = POCKETJS_NET_HTTP_CLIENT_TLS_REVOCATION_HOST_DEFAULT,
  };
  request = make_get(1U, "https://example.com/health");
  request.tls = &tls_policy;
  assert(pocketjs_net_http_client_core_start(tls.core, &request, tls.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  assert(tls.permissions.hostname_calls == 1U);
  assert(tls.fake.active_kind == FAKE_RESOLVE);
  const uint32_t address = 0x0100007fU;
  fake_complete_resolve(&tls.fake, &address, 1U);
  pump(&tls);
  assert(tls.permissions.numeric_calls == 1U);
  assert(tls.fake.active_kind == FAKE_CONNECT);
  assert(tls.fake.connect_tls);
  assert(tls.fake.connect_port == 443U);
  assert(strcmp(tls.fake.connect_hostname, "example.com") == 0);
  fake_complete_connect(&tls.fake);
  pump(&tls);
  assert(tls.fake.active_kind == FAKE_WRITE);
  assert(bytes_contain(tls.fake.write_bytes, tls.fake.write_length,
                       "GET /health HTTP/1.1\r\n"));
  assert(bytes_contain(tls.fake.write_bytes, tls.fake.write_length,
                       "Host: example.com\r\n"));
}

static void assert_tls_policy_rejected(
    const char *url, const pocketjs_net_http_client_tls_policy_t *policy) {
  fixture_t fixture;
  fixture_init_with_options(&fixture, 0U, true);
  pocketjs_net_http_client_request_t request = make_get(1U, url);
  request.tls = policy;
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_UNSUPPORTED_TLS);
  assert(fixture.permissions.hostname_calls == 0U);
  assert(fixture.permissions.numeric_calls == 0U);
  assert(fixture.fake.active_kind == FAKE_NONE);
}

static void test_https_base_policy_is_fail_closed(void) {
  static const uint8_t server_name[] = "example.com";
  static const uint8_t wrong_name[] = "other.example";
  pocketjs_net_http_client_tls_policy_t policy = {
      .server_name = {.data = server_name, .length = sizeof(server_name) - 1U},
      .minimum_version = POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_2,
      .maximum_version = POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_2,
      .client_certificate =
          POCKETJS_NET_HTTP_CLIENT_TLS_CLIENT_CERTIFICATE_NONE,
      .verification = POCKETJS_NET_HTTP_CLIENT_TLS_VERIFICATION_FULL,
      .revocation = POCKETJS_NET_HTTP_CLIENT_TLS_REVOCATION_HOST_DEFAULT,
  };
  assert_tls_policy_rejected("https://example.com/", NULL);
  policy.server_name = (pocketjs_net_http_client_slice_t){
      .data = wrong_name, .length = sizeof(wrong_name) - 1U};
  assert_tls_policy_rejected("https://example.com/", &policy);
  policy.server_name = (pocketjs_net_http_client_slice_t){
      .data = server_name, .length = sizeof(server_name) - 1U};
  policy.maximum_version = POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_3;
  assert_tls_policy_rejected("https://example.com/", &policy);
  policy.maximum_version = POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_2;
  policy.alpn_count = 1U;
  assert_tls_policy_rejected("https://example.com/", &policy);
  policy.alpn_count = 0U;
  policy.server_name = (pocketjs_net_http_client_slice_t){0};
  assert_tls_policy_rejected("https://127.0.0.1/", &policy);

  policy.server_name = (pocketjs_net_http_client_slice_t){
      .data = server_name, .length = sizeof(server_name) - 1U};
  assert_tls_policy_rejected("http://example.com/", &policy);
}

static void assert_tls_error_mapping(
    pocketjs_net_http_client_transport_error_t transport_error,
    pocketjs_net_http_client_error_t core_error) {
  fixture_t fixture;
  fixture_init_with_options(&fixture, 0U, true);
  static const uint8_t server_name[] = "example.com";
  static const pocketjs_net_http_client_tls_policy_t policy = {
      .server_name = {.data = server_name, .length = sizeof(server_name) - 1U},
      .minimum_version = POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_2,
      .maximum_version = POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_2,
      .client_certificate =
          POCKETJS_NET_HTTP_CLIENT_TLS_CLIENT_CERTIFICATE_NONE,
      .verification = POCKETJS_NET_HTTP_CLIENT_TLS_VERIFICATION_FULL,
      .revocation = POCKETJS_NET_HTTP_CLIENT_TLS_REVOCATION_HOST_DEFAULT,
  };
  pocketjs_net_http_client_request_t request =
      make_get(1U, "https://example.com/");
  request.tls = &policy;
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  const uint32_t addresses[] = {0x0100007fU, 0x0200007fU};
  fake_complete_resolve(&fixture.fake, addresses, 2U);
  pump(&fixture);
  assert(fixture.permissions.numeric_calls == 2U);
  assert(fixture.fake.starts[FAKE_CONNECT] == 1U);
  fake_queue_error(&fixture.fake, transport_error, 55);
  pump(&fixture);
  assert(fixture.fake.starts[FAKE_CONNECT] == 1U);
  pocketjs_net_http_client_event_t error =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code == core_error);
  assert(error.detail.error.cause_code == 55);
  retire_event(&fixture, error);
}

static void test_tls_errors_remain_distinct(void) {
  assert_tls_error_mapping(
      POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TLS_CERTIFICATE_INVALID,
      POCKETJS_NET_HTTP_CLIENT_ERROR_TLS_CERTIFICATE_INVALID);
  assert_tls_error_mapping(
      POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TLS_HOSTNAME_MISMATCH,
      POCKETJS_NET_HTTP_CLIENT_ERROR_TLS_HOSTNAME_MISMATCH);
  assert_tls_error_mapping(
      POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TLS_HANDSHAKE_FAILED,
      POCKETJS_NET_HTTP_CLIENT_ERROR_TLS_HANDSHAKE_FAILED);
  assert_tls_error_mapping(
      POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TLS_VERSION_UNSUPPORTED,
      POCKETJS_NET_HTTP_CLIENT_ERROR_TLS_VERSION_UNSUPPORTED);
  assert_tls_error_mapping(POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TLS_ALERT,
                           POCKETJS_NET_HTTP_CLIENT_ERROR_TLS_ALERT);
}

static void test_all_candidates_checked_before_denial(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  for (size_t index = 0U; index < 4U; ++index) {
    fixture.permissions.allowed_candidates[index] = false;
  }
  pocketjs_net_http_client_request_t request =
      make_get(1U, "http://example.com/");
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  uint32_t addresses[] = {0x0100000aU, 0x0200000aU, 0x0300000aU, 0x0400000aU};
  fake_complete_resolve(&fixture.fake, addresses, 4U);
  pump(&fixture);
  assert(fixture.permissions.numeric_calls == 4U);
  assert(fixture.fake.starts[FAKE_CONNECT] == 0U);
  pocketjs_net_http_client_event_t error =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code ==
         POCKETJS_NET_HTTP_CLIENT_ERROR_PERMISSION_DENIED);
  retire_event(&fixture, error);
}

static void test_connect_error_tries_next_allowed_candidate(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  fixture.permissions.allowed_candidates[0] = true;
  fixture.permissions.allowed_candidates[1] = false;
  fixture.permissions.allowed_candidates[2] = true;
  fixture.permissions.allowed_candidates[3] = true;
  pocketjs_net_http_client_request_t request =
      make_get(1U, "http://example.com/");
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  const uint32_t addresses[] = {0x0100000aU, 0x0200000aU, 0x0300000aU,
                                0x0400000aU};
  fake_complete_resolve(&fixture.fake, addresses, 4U);
  pump(&fixture);
  assert(fixture.permissions.numeric_calls == 4U);
  assert(fixture.fake.starts[FAKE_CONNECT] == 1U);
  assert(fixture.fake.connect_ipv4_be == addresses[0]);
  const uint64_t connect_deadline = fixture.fake.active_deadline;

  fake_queue_error(&fixture.fake,
                   POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_CONNECT, 11);
  pump(&fixture);
  assert(fixture.fake.starts[FAKE_CONNECT] == 2U);
  assert(fixture.fake.connect_ipv4_be == addresses[2]);
  assert(fixture.fake.active_deadline == connect_deadline);

  fake_queue_error(&fixture.fake,
                   POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_CONNECT, 22);
  pump(&fixture);
  assert(fixture.fake.starts[FAKE_CONNECT] == 3U);
  assert(fixture.fake.connect_ipv4_be == addresses[3]);
  assert(fixture.fake.active_deadline == connect_deadline);

  fake_complete_connect(&fixture.fake);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_WRITE);
}

static void test_connect_candidate_exhaustion_preserves_last_error(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  pocketjs_net_http_client_request_t request =
      make_get(1U, "http://example.com/");
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  const uint32_t addresses[] = {0x0100000aU, 0x0200000aU};
  fake_complete_resolve(&fixture.fake, addresses, 2U);
  pump(&fixture);
  assert(fixture.fake.connect_ipv4_be == addresses[0]);

  fake_queue_error(&fixture.fake,
                   POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_CONNECT, 11);
  pump(&fixture);
  assert(fixture.fake.connect_ipv4_be == addresses[1]);
  assert(fixture.fake.starts[FAKE_CONNECT] == 2U);

  fake_queue_error(&fixture.fake,
                   POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_CONNECT, 22);
  pump(&fixture);
  assert(fixture.fake.starts[FAKE_CONNECT] == 2U);
  pocketjs_net_http_client_event_t error =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code == POCKETJS_NET_HTTP_CLIENT_ERROR_CONNECT);
  assert(error.detail.error.cause_code == 22);
  retire_event(&fixture, error);
}

static void assert_candidate_error_does_not_retry(
    pocketjs_net_http_client_transport_error_t transport_error,
    pocketjs_net_http_client_error_t expected_error) {
  fixture_t fixture;
  fixture_init(&fixture);
  pocketjs_net_http_client_request_t request =
      make_get(1U, "http://example.com/");
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  const uint32_t addresses[] = {0x0100000aU, 0x0200000aU};
  fake_complete_resolve(&fixture.fake, addresses, 2U);
  pump(&fixture);
  fake_queue_error(&fixture.fake, transport_error, 33);
  pump(&fixture);
  assert(fixture.fake.starts[FAKE_CONNECT] == 1U);
  pocketjs_net_http_client_event_t error =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code == expected_error);
  assert(error.detail.error.cause_code == 33);
  retire_event(&fixture, error);
}

static void test_non_connect_errors_do_not_advance_candidates(void) {
  assert_candidate_error_does_not_retry(
      POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TIMED_OUT,
      POCKETJS_NET_HTTP_CLIENT_ERROR_TIMED_OUT);
  assert_candidate_error_does_not_retry(
      POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_IO,
      POCKETJS_NET_HTTP_CLIENT_ERROR_IO);
  assert_candidate_error_does_not_retry(
      POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_RESOURCE_LIMIT,
      POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT);
  assert_candidate_error_does_not_retry(
      POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_ABORTED,
      POCKETJS_NET_HTTP_CLIENT_ERROR_ABORTED);
}

static void test_connect_error_does_not_retry_after_deadline(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  pocketjs_net_http_client_request_t request =
      make_get(1U, "http://example.com/");
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  const uint32_t addresses[] = {0x0100000aU, 0x0200000aU};
  fake_complete_resolve(&fixture.fake, addresses, 2U);
  pump(&fixture);
  fixture.now = fixture.fake.active_deadline;
  fake_queue_error(&fixture.fake,
                   POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_CONNECT, 44);
  pump(&fixture);
  assert(fixture.fake.starts[FAKE_CONNECT] == 1U);
  pocketjs_net_http_client_event_t error =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code == POCKETJS_NET_HTTP_CLIENT_ERROR_CONNECT);
  assert(error.detail.error.cause_code == 44);
  retire_event(&fixture, error);
}

static void test_protocol_error_closes_before_terminal(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  connect_and_write_get(&fixture, 1U, "http://example.com:8080/x?q=1");
  fake_complete_read(&fixture.fake,
                     "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
                     "0\r\nContent-Length: 1\r\n\r\n",
                     false);
  pump(&fixture);
  pocketjs_net_http_client_event_t headers =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  retire_event(&fixture, headers);
  assert(fixture.fake.active_kind == FAKE_CLOSE);
  pocketjs_net_http_client_event_t event;
  assert(!pocketjs_net_http_client_core_take_event(fixture.core, &event));
  fake_complete_close(&fixture.fake);
  pump(&fixture);
  event = take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(event.detail.error.code == POCKETJS_NET_HTTP_CLIENT_ERROR_PROTOCOL);
  retire_event(&fixture, event);
}

static void test_chunked_body_and_valid_trailer(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  connect_and_write_get(&fixture, 1U, "http://example.com:8080/x?q=1");
  fake_complete_read(&fixture.fake,
                     "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n"
                     "Trailer: X-Checksum\r\n\r\n3;ok=yes\r\nabc\r\n0\r\n"
                     "X-Checksum: 123\r\n\r\n",
                     false);
  pump(&fixture);
  pocketjs_net_http_client_event_t headers =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  retire_event(&fixture, headers);
  assert(
      pocketjs_net_http_client_core_grant_body_credit(fixture.core, 1U, 16U));
  pump(&fixture);
  pocketjs_net_http_client_event_t body =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_BODY);
  const uint8_t *bytes = NULL;
  size_t length = 0U;
  assert(pocketjs_net_http_client_core_body_lease_view(
      fixture.core, body.detail.body.lease, &bytes, &length));
  assert(length == 3U && memcmp(bytes, "abc", 3U) == 0);
  assert(pocketjs_net_http_client_core_release_body_lease(
      fixture.core, body.detail.body.lease));
  retire_event(&fixture, body);
  assert(fixture.fake.active_kind == FAKE_CLOSE);
  fake_complete_close(&fixture.fake);
  pump(&fixture);
  pocketjs_net_http_client_event_t complete =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  retire_event(&fixture, complete);
}

static void test_protocol_error_selected_before_body_pull(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  connect_and_write_get(&fixture, 1U, "http://example.com:8080/x?q=1");
  fake_complete_read(&fixture.fake,
                     "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
                     "Z\r\ninvalid\r\n",
                     false);
  pump(&fixture);
  pocketjs_net_http_client_event_t headers =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  retire_event(&fixture, headers);

  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_CLOSE);
  assert(
      pocketjs_net_http_client_core_grant_body_credit(fixture.core, 1U, 16U));
  assert(
      !pocketjs_net_http_client_core_grant_body_credit(fixture.core, 1U, 16U));
  fake_complete_close(&fixture.fake);
  pump(&fixture);
  pocketjs_net_http_client_event_t error =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code == POCKETJS_NET_HTTP_CLIENT_ERROR_PROTOCOL);
  retire_event(&fixture, error);
}

static void test_eof_delimited_body(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  connect_and_write_get(&fixture, 1U, "http://example.com:8080/x?q=1");
  fake_complete_read(&fixture.fake, "HTTP/1.1 200 OK\r\n\r\nabc", false);
  pump(&fixture);
  pocketjs_net_http_client_event_t headers =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  retire_event(&fixture, headers);
  assert(pocketjs_net_http_client_core_grant_body_credit(fixture.core, 1U, 3U));
  pump(&fixture);
  pocketjs_net_http_client_event_t body =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_BODY);
  assert(pocketjs_net_http_client_core_release_body_lease(
      fixture.core, body.detail.body.lease));
  retire_event(&fixture, body);
  assert(pocketjs_net_http_client_core_grant_body_credit(fixture.core, 1U, 1U));
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_READ);
  fake_complete_read(&fixture.fake, "", true);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_CLOSE);
  fake_complete_close(&fixture.fake);
  pump(&fixture);
  pocketjs_net_http_client_event_t complete =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  retire_event(&fixture, complete);
}

static void test_205_has_no_body(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  connect_and_write_get(&fixture, 1U, "http://example.com:8080/x?q=1");
  fake_complete_read(&fixture.fake,
                     "HTTP/1.1 205 Reset Content\r\nX-Test: yes\r\n\r\n",
                     false);
  pump(&fixture);
  pocketjs_net_http_client_event_t headers =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  assert(headers.detail.response.status_code == 205U);
  retire_event(&fixture, headers);
  assert(fixture.fake.active_kind == FAKE_CLOSE);
  assert(
      !pocketjs_net_http_client_core_grant_body_credit(fixture.core, 1U, 1U));
  fake_complete_close(&fixture.fake);
  pump(&fixture);
  pocketjs_net_http_client_event_t complete =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  retire_event(&fixture, complete);
}

static void test_content_coding_fails_closed(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  connect_and_write_get(&fixture, 1U, "http://example.com:8080/x?q=1");
  fake_complete_read(&fixture.fake,
                     "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n"
                     "Content-Encoding: gzip\r\n\r\nx",
                     false);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_CLOSE);
  pocketjs_net_http_client_event_t event;
  assert(!pocketjs_net_http_client_core_take_event(fixture.core, &event));
  fake_complete_close(&fixture.fake);
  pump(&fixture);
  event = take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(event.detail.error.code == POCKETJS_NET_HTTP_CLIENT_ERROR_PROTOCOL);
  retire_event(&fixture, event);
}

static void test_request_body_is_snapshotted(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  static const uint8_t url[] = "http://127.0.0.1/upload";
  static const uint8_t post[] = "POST";
  uint8_t source_body[] = "abc";
  pocketjs_net_http_client_request_t request = {
      .operation_token = 1U,
      .url = {.data = url, .length = sizeof(url) - 1U},
      .method = {.data = post, .length = sizeof(post) - 1U},
      .body_kind = POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_FIXED,
      .body = {.data = source_body, .length = sizeof(source_body) - 1U},
  };
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  assert(fixture.permissions.hostname_calls == 0U);
  assert(fixture.permissions.numeric_calls == 1U);
  assert(fixture.fake.active_kind == FAKE_CONNECT);
  source_body[0] = 'z';
  fake_complete_connect(&fixture.fake);
  pump(&fixture);
  assert(bytes_contain(fixture.fake.write_bytes, fixture.fake.write_length,
                       "Content-Length: 3\r\n"));
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_WRITE);
  assert(fixture.fake.write_length == 3U);
  assert(memcmp(fixture.fake.write_bytes, "abc", 3U) == 0);
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  fake_complete_read(&fixture.fake, "HTTP/1.1 204 No Content\r\n\r\n", false);
  pump(&fixture);
  pocketjs_net_http_client_event_t headers =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  retire_event(&fixture, headers);
  fake_complete_close(&fixture.fake);
  pump(&fixture);
  pocketjs_net_http_client_event_t complete =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  retire_event(&fixture, complete);
}

static void test_abort_exact_one(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  connect_and_write_get(&fixture, 1U, "http://example.com:8080/x?q=1");
  assert(fixture.fake.active_kind == FAKE_READ);
  assert(pocketjs_net_http_client_core_abort(fixture.core, 1U));
  assert(fixture.fake.cancels == 1U);
  pump(&fixture);
  pocketjs_net_http_client_event_t error =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code == POCKETJS_NET_HTTP_CLIENT_ERROR_ABORTED);
  retire_event(&fixture, error);
  pump(&fixture);
  assert(!pocketjs_net_http_client_core_take_event(fixture.core, &error));
}

static void test_total_timeout_exact_one(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  pocketjs_net_http_client_request_t request =
      make_get(1U, "http://example.com/");
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  fixture.now += 1000001U;
  assert(pocketjs_net_http_client_core_pump(fixture.core, fixture.now, 8U, 8U));
  pocketjs_net_http_client_event_t error =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code == POCKETJS_NET_HTTP_CLIENT_ERROR_TIMED_OUT);
  retire_event(&fixture, error);
  pump(&fixture);
  assert(!pocketjs_net_http_client_core_take_event(fixture.core, &error));
}

static void test_permission_callback_reentrancy_is_rejected(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  fixture.permissions.exercise_reentrancy = true;
  pocketjs_net_http_client_request_t request =
      make_get(1U, "http://example.com/");
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  assert(fixture.permissions.reentrancy_calls == 1U);
  assert(fixture.fake.active_kind == FAKE_RESOLVE);
  uint32_t addresses[] = {0x0100007fU, 0x0200007fU, 0x0300007fU};
  fake_complete_resolve(&fixture.fake, addresses, 3U);
  pump(&fixture);
  assert(fixture.permissions.reentrancy_calls == 4U);
  assert(fixture.fake.active_kind == FAKE_CONNECT);
  pocketjs_net_http_client_core_status_t status = get_status(&fixture);
  assert(!status.poisoned);
  assert(status.request_active);
  assert(pocketjs_net_http_client_core_abort(fixture.core, 1U));
  pump(&fixture);
  pocketjs_net_http_client_event_t error =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code == POCKETJS_NET_HTTP_CLIENT_ERROR_ABORTED);
  retire_event(&fixture, error);
}

static void test_read_bytes_with_eof_waits_for_full_consumption(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  connect_and_write_get(&fixture, 1U, "http://example.com:8080/x?q=1");
  fake_complete_read(&fixture.fake,
                     "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello", true);
  pump(&fixture);
  pocketjs_net_http_client_event_t headers =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  retire_event(&fixture, headers);

  const uint8_t *bytes = NULL;
  size_t length = 0U;
  assert(pocketjs_net_http_client_core_grant_body_credit(fixture.core, 1U, 3U));
  pump(&fixture);
  pocketjs_net_http_client_event_t body =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_BODY);
  assert(pocketjs_net_http_client_core_body_lease_view(
      fixture.core, body.detail.body.lease, &bytes, &length));
  assert(length == 3U && memcmp(bytes, "hel", 3U) == 0);
  assert(pocketjs_net_http_client_core_release_body_lease(
      fixture.core, body.detail.body.lease));
  retire_event(&fixture, body);

  assert(pocketjs_net_http_client_core_grant_body_credit(fixture.core, 1U, 2U));
  pump(&fixture);
  body = take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_BODY);
  assert(pocketjs_net_http_client_core_body_lease_view(
      fixture.core, body.detail.body.lease, &bytes, &length));
  assert(length == 2U && memcmp(bytes, "lo", 2U) == 0);
  assert(pocketjs_net_http_client_core_release_body_lease(
      fixture.core, body.detail.body.lease));
  retire_event(&fixture, body);
  assert(fixture.fake.active_kind == FAKE_CLOSE);
  fake_complete_close(&fixture.fake);
  pump(&fixture);
  pocketjs_net_http_client_event_t complete =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  retire_event(&fixture, complete);

  fixture_t eof_delimited;
  fixture_init(&eof_delimited);
  connect_and_write_get(&eof_delimited, 1U, "http://example.com:8080/x?q=1");
  fake_complete_read(&eof_delimited.fake, "HTTP/1.1 200 OK\r\n\r\nabc", true);
  pump(&eof_delimited);
  headers = take_event(&eof_delimited,
                       POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  retire_event(&eof_delimited, headers);
  assert(pocketjs_net_http_client_core_grant_body_credit(eof_delimited.core, 1U,
                                                         3U));
  pump(&eof_delimited);
  body = take_event(&eof_delimited, POCKETJS_NET_HTTP_CLIENT_EVENT_BODY);
  assert(pocketjs_net_http_client_core_body_lease_view(
      eof_delimited.core, body.detail.body.lease, &bytes, &length));
  assert(length == 3U && memcmp(bytes, "abc", 3U) == 0);
  assert(pocketjs_net_http_client_core_release_body_lease(
      eof_delimited.core, body.detail.body.lease));
  retire_event(&eof_delimited, body);
  assert(eof_delimited.fake.active_kind == FAKE_CLOSE);
  fake_complete_close(&eof_delimited.fake);
  pump(&eof_delimited);
  complete =
      take_event(&eof_delimited, POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  retire_event(&eof_delimited, complete);
}

static void test_head_informational_and_304_are_bodyless(void) {
  fixture_t head_fixture;
  fixture_init(&head_fixture);
  static const uint8_t head[] = "HEAD";
  pocketjs_net_http_client_request_t head_request =
      make_get(1U, "http://example.com:8080/x?q=1");
  head_request.method = (pocketjs_net_http_client_slice_t){
      .data = head,
      .length = sizeof(head) - 1U,
  };
  connect_and_write_request(&head_fixture, &head_request,
                            "HEAD /x?q=1 HTTP/1.1\r\n");
  fake_complete_read(&head_fixture.fake,
                     "HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\n", true);
  pump(&head_fixture);
  pocketjs_net_http_client_event_t headers = take_event(
      &head_fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  assert(headers.detail.response.status_code == 200U);
  retire_event(&head_fixture, headers);
  assert(head_fixture.fake.active_kind == FAKE_CLOSE);
  fake_complete_close(&head_fixture.fake);
  pump(&head_fixture);
  pocketjs_net_http_client_event_t complete =
      take_event(&head_fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  retire_event(&head_fixture, complete);

  fixture_t not_modified_fixture;
  fixture_init(&not_modified_fixture);
  connect_and_write_get(&not_modified_fixture, 1U,
                        "http://example.com:8080/x?q=1");
  fake_complete_read(
      &not_modified_fixture.fake,
      "HTTP/1.1 100 Continue\r\nX-I: ignored\r\n\r\n"
      "HTTP/1.1 304 Not Modified\r\nContent-Length: 4096\r\n\r\n",
      true);
  pump(&not_modified_fixture);
  headers = take_event(&not_modified_fixture,
                       POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  assert(headers.detail.response.status_code == 304U);
  assert(headers.detail.response.header_count == 1U);
  retire_event(&not_modified_fixture, headers);
  assert(not_modified_fixture.fake.active_kind == FAKE_CLOSE);
  fake_complete_close(&not_modified_fixture.fake);
  pump(&not_modified_fixture);
  complete = take_event(&not_modified_fixture,
                        POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  retire_event(&not_modified_fixture, complete);
}

static void test_numeric_permission_denial_has_no_io(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  fixture.permissions.allowed_candidates[0] = false;
  pocketjs_net_http_client_request_t request =
      make_get(1U, "http://127.0.0.1/");
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  assert(fixture.permissions.hostname_calls == 0U);
  assert(fixture.permissions.numeric_calls == 1U);
  assert(fixture.fake.active_kind == FAKE_NONE);
  pocketjs_net_http_client_event_t error =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code ==
         POCKETJS_NET_HTTP_CLIENT_ERROR_PERMISSION_DENIED);
  retire_event(&fixture, error);
}

static void test_maximum_request_body_boundary(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  static const uint8_t url[] = "http://127.0.0.1/upload";
  static const uint8_t post[] = "POST";
  uint8_t source_body[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REQUEST_BODY_BYTES];
  memset(source_body, 'a', sizeof(source_body));
  pocketjs_net_http_client_request_t request = {
      .operation_token = 1U,
      .url = {.data = url, .length = sizeof(url) - 1U},
      .method = {.data = post, .length = sizeof(post) - 1U},
      .body_kind = POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_FIXED,
      .body = {.data = source_body, .length = sizeof(source_body)},
  };
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  memset(source_body, 'z', sizeof(source_body));
  fake_complete_connect(&fixture.fake);
  pump(&fixture);
  assert(bytes_contain(fixture.fake.write_bytes, fixture.fake.write_length,
                       "Content-Length: 4096\r\n"));
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_WRITE);
  assert(fixture.fake.write_length == sizeof(source_body));
  for (size_t index = 0U; index < fixture.fake.write_length; ++index) {
    assert(fixture.fake.write_bytes[index] == 'a');
  }
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_READ);
  assert(pocketjs_net_http_client_core_abort(fixture.core, 1U));
  pump(&fixture);
  pocketjs_net_http_client_event_t error =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code == POCKETJS_NET_HTTP_CLIENT_ERROR_ABORTED);
  retire_event(&fixture, error);
}

static void test_streaming_chunked_upload_exceeds_64k(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  pocketjs_net_http_client_request_t request =
      make_streaming_post(1U, false, 0U);
  start_streaming_request(&fixture, &request);

  uint8_t chunk[POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES];
  memset(chunk, 'a', sizeof(chunk));
  uint64_t body_generation = 0U;
  uint64_t previous_pull_generation = 0U;
  uint64_t previous_event_sequence = 0U;
  size_t total = 0U;
  for (size_t index = 0U; index < 33U; ++index) {
    chunk[0] = (uint8_t)('a' + index % 26U);
    pocketjs_net_http_client_event_t pull = take_request_body_pull(
        &fixture, POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES);
    if (index == 0U) {
      body_generation = pull.detail.request_body_pull.body_generation;
    } else {
      assert(pull.detail.request_body_pull.body_generation == body_generation);
    }
    assert(pull.detail.request_body_pull.pull_generation >
           previous_pull_generation);
    assert(pull.sequence > previous_event_sequence);
    previous_pull_generation = pull.detail.request_body_pull.pull_generation;
    previous_event_sequence = pull.sequence;
    retire_request_body_pull(&fixture, pull);
    assert(pocketjs_net_http_client_core_submit_request_body_chunk(
        fixture.core, 1U, body_generation, previous_pull_generation, chunk,
        sizeof(chunk)));
    assert(fixture.fake.active_kind == FAKE_WRITE);
    assert(fixture.fake.write_length == sizeof(chunk) + 7U);
    assert(memcmp(fixture.fake.write_bytes, "800\r\n", 5U) == 0);
    assert(memcmp(fixture.fake.write_bytes + 5U, chunk, sizeof(chunk)) == 0);
    assert(memcmp(fixture.fake.write_bytes + 5U + sizeof(chunk), "\r\n", 2U) ==
           0);
    pocketjs_net_http_client_core_status_t status = get_status(&fixture);
    assert(!status.request_body_credit_outstanding);
    fake_complete_write(&fixture.fake);
    pump(&fixture);
    total += sizeof(chunk);
  }
  assert(total > 64U * 1024U);

  pocketjs_net_http_client_event_t end_pull = take_request_body_pull(
      &fixture, POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES);
  assert(end_pull.detail.request_body_pull.body_generation == body_generation);
  assert(end_pull.detail.request_body_pull.pull_generation >
         previous_pull_generation);
  retire_request_body_pull(&fixture, end_pull);
  assert(pocketjs_net_http_client_core_submit_request_body_end(
      fixture.core, 1U, body_generation,
      end_pull.detail.request_body_pull.pull_generation));
  assert(fixture.fake.active_kind == FAKE_WRITE);
  assert(fixture.fake.write_length == 5U);
  assert(memcmp(fixture.fake.write_bytes, "0\r\n\r\n", 5U) == 0);
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  finish_empty_response(&fixture);

  request = make_streaming_post(2U, false, 0U);
  start_streaming_request(&fixture, &request);
  pocketjs_net_http_client_event_t next_body_pull = take_request_body_pull(
      &fixture, POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES);
  assert(next_body_pull.detail.request_body_pull.body_generation >
         body_generation);
  assert(next_body_pull.detail.request_body_pull.pull_generation >
         end_pull.detail.request_body_pull.pull_generation);
  retire_request_body_pull(&fixture, next_body_pull);
  assert(pocketjs_net_http_client_core_submit_request_body_end(
      fixture.core, 2U, next_body_pull.detail.request_body_pull.body_generation,
      next_body_pull.detail.request_body_pull.pull_generation));
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  finish_empty_response(&fixture);
}

static void test_streaming_credit_is_hostile_input_safe(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  pocketjs_net_http_client_request_t request =
      make_streaming_post(1U, false, 0U);
  static const uint8_t x[] = "x";
  assert(!pocketjs_net_http_client_core_submit_request_body_chunk(
      fixture.core, 1U, 1U, 1U, x, 1U));
  assert(!pocketjs_net_http_client_core_submit_request_body_end(fixture.core,
                                                                1U, 1U, 1U));
  assert(!pocketjs_net_http_client_core_submit_request_body_error(
      fixture.core, 1U, 1U, 1U, 7));
  start_streaming_request(&fixture, &request);

  pocketjs_net_http_client_event_t first = take_request_body_pull(
      &fixture, POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES);
  uint64_t body_generation = first.detail.request_body_pull.body_generation;
  uint64_t first_pull_generation =
      first.detail.request_body_pull.pull_generation;
  assert(!pocketjs_net_http_client_core_submit_request_body_chunk(
      fixture.core, 1U, body_generation, first_pull_generation, x, 1U));
  assert(!pocketjs_net_http_client_core_submit_request_body_end(
      fixture.core, 1U, body_generation, first_pull_generation));
  retire_request_body_pull(&fixture, first);

  uint8_t oversize[POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES + 1U];
  memset(oversize, 'z', sizeof(oversize));
  assert(!pocketjs_net_http_client_core_submit_request_body_chunk(
      fixture.core, 2U, body_generation, first_pull_generation, x, 1U));
  assert(!pocketjs_net_http_client_core_submit_request_body_chunk(
      fixture.core, 1U, body_generation + 1U, first_pull_generation, x, 1U));
  assert(!pocketjs_net_http_client_core_submit_request_body_chunk(
      fixture.core, 1U, body_generation, first_pull_generation + 1U, x, 1U));
  assert(!pocketjs_net_http_client_core_submit_request_body_chunk(
      fixture.core, 1U, body_generation, first_pull_generation, NULL, 1U));
  assert(!pocketjs_net_http_client_core_submit_request_body_chunk(
      fixture.core, 1U, body_generation, first_pull_generation, x, 0U));
  assert(!pocketjs_net_http_client_core_submit_request_body_chunk(
      fixture.core, 1U, body_generation, first_pull_generation, oversize,
      sizeof(oversize)));
  assert(get_status(&fixture).request_body_credit_outstanding);
  assert(pocketjs_net_http_client_core_submit_request_body_chunk(
      fixture.core, 1U, body_generation, first_pull_generation, x, 1U));
  assert(fixture.fake.write_length == 6U);
  assert(memcmp(fixture.fake.write_bytes, "1\r\nx\r\n", 6U) == 0);
  assert(!pocketjs_net_http_client_core_submit_request_body_chunk(
      fixture.core, 1U, body_generation, first_pull_generation, x, 1U));
  assert(!pocketjs_net_http_client_core_submit_request_body_end(
      fixture.core, 1U, body_generation, first_pull_generation));
  fake_complete_write(&fixture.fake);
  pump(&fixture);

  pocketjs_net_http_client_event_t second = take_request_body_pull(
      &fixture, POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES);
  assert(second.detail.request_body_pull.pull_generation >
         first_pull_generation);
  retire_request_body_pull(&fixture, second);
  assert(!pocketjs_net_http_client_core_submit_request_body_chunk(
      fixture.core, 1U, body_generation, first_pull_generation, x, 1U));
  static const uint8_t y[] = "y";
  assert(pocketjs_net_http_client_core_submit_request_body_chunk(
      fixture.core, 1U, body_generation,
      second.detail.request_body_pull.pull_generation, y, 1U));
  assert(memcmp(fixture.fake.write_bytes, "1\r\ny\r\n", 6U) == 0);
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  pocketjs_net_http_client_event_t end_pull = take_request_body_pull(
      &fixture, POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES);
  retire_request_body_pull(&fixture, end_pull);
  assert(pocketjs_net_http_client_core_submit_request_body_end(
      fixture.core, 1U, body_generation,
      end_pull.detail.request_body_pull.pull_generation));
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  finish_empty_response(&fixture);
}

static void test_known_length_streaming_accounting(void) {
  fixture_t exact;
  fixture_init(&exact);
  pocketjs_net_http_client_request_t request =
      make_streaming_post(1U, true, 5U);
  start_streaming_request(&exact, &request);
  pocketjs_net_http_client_event_t pull = take_request_body_pull(&exact, 5U);
  uint64_t body_generation = pull.detail.request_body_pull.body_generation;
  uint64_t pull_generation = pull.detail.request_body_pull.pull_generation;
  retire_request_body_pull(&exact, pull);
  static const uint8_t too_many[] = "123456";
  assert(!pocketjs_net_http_client_core_submit_request_body_chunk(
      exact.core, 1U, body_generation, pull_generation, too_many,
      sizeof(too_many) - 1U));
  assert(get_status(&exact).request_body_credit_outstanding);
  static const uint8_t first[] = "12";
  assert(pocketjs_net_http_client_core_submit_request_body_chunk(
      exact.core, 1U, body_generation, pull_generation, first,
      sizeof(first) - 1U));
  assert(exact.fake.write_length == 2U);
  assert(memcmp(exact.fake.write_bytes, "12", 2U) == 0);
  fake_complete_write(&exact.fake);
  pump(&exact);
  pull = take_request_body_pull(&exact, 3U);
  assert(pull.detail.request_body_pull.body_generation == body_generation);
  assert(pull.detail.request_body_pull.pull_generation > pull_generation);
  pull_generation = pull.detail.request_body_pull.pull_generation;
  retire_request_body_pull(&exact, pull);
  static const uint8_t last[] = "345";
  assert(pocketjs_net_http_client_core_submit_request_body_chunk(
      exact.core, 1U, body_generation, pull_generation, last,
      sizeof(last) - 1U));
  assert(exact.fake.write_length == 3U);
  assert(memcmp(exact.fake.write_bytes, "345", 3U) == 0);
  fake_complete_write(&exact.fake);
  pump(&exact);
  assert(exact.fake.active_kind == FAKE_READ);
  assert(!pocketjs_net_http_client_core_submit_request_body_chunk(
      exact.core, 1U, body_generation, pull_generation, first,
      sizeof(first) - 1U));
  assert(!pocketjs_net_http_client_core_submit_request_body_end(
      exact.core, 1U, body_generation, pull_generation));
  finish_empty_response(&exact);

  fixture_t underflow;
  fixture_init(&underflow);
  request = make_streaming_post(1U, true, 5U);
  start_streaming_request(&underflow, &request);
  pull = take_request_body_pull(&underflow, 5U);
  body_generation = pull.detail.request_body_pull.body_generation;
  pull_generation = pull.detail.request_body_pull.pull_generation;
  retire_request_body_pull(&underflow, pull);
  assert(pocketjs_net_http_client_core_submit_request_body_chunk(
      underflow.core, 1U, body_generation, pull_generation, first,
      sizeof(first) - 1U));
  fake_complete_write(&underflow.fake);
  pump(&underflow);
  pull = take_request_body_pull(&underflow, 3U);
  pull_generation = pull.detail.request_body_pull.pull_generation;
  retire_request_body_pull(&underflow, pull);
  assert(pocketjs_net_http_client_core_submit_request_body_end(
      underflow.core, 1U, body_generation, pull_generation));
  assert(underflow.fake.active_kind == FAKE_CLOSE);
  assert(!pocketjs_net_http_client_core_submit_request_body_end(
      underflow.core, 1U, body_generation, pull_generation));
  fake_complete_close(&underflow.fake);
  pump(&underflow);
  pocketjs_net_http_client_event_t error =
      take_event(&underflow, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code ==
         POCKETJS_NET_HTTP_CLIENT_ERROR_REQUEST_BODY);
  assert(error.detail.error.cause_code ==
         POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_CAUSE_LENGTH_UNDERFLOW);
  retire_event(&underflow, error);
  assert(!pocketjs_net_http_client_core_take_event(underflow.core, &error));

  fixture_t zero;
  fixture_init(&zero);
  request = make_streaming_post(1U, true, 0U);
  start_streaming_request(&zero, &request);
  assert(zero.fake.active_kind == FAKE_READ);
  pocketjs_net_http_client_event_t unexpected;
  assert(!pocketjs_net_http_client_core_take_event(zero.core, &unexpected));
  finish_empty_response(&zero);
}

static void complete_streaming_error(fixture_t *fixture,
                                     pocketjs_net_http_client_error_t code,
                                     int32_t cause) {
  assert(fixture->fake.active_kind == FAKE_CLOSE);
  fake_complete_close(&fixture->fake);
  pump(fixture);
  pocketjs_net_http_client_event_t error =
      take_event(fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code == code);
  assert(error.detail.error.cause_code == cause);
  retire_event(fixture, error);
  assert(!pocketjs_net_http_client_core_take_event(fixture->core, &error));
}

static void test_streaming_cancel_timeout_error_and_teardown(void) {
  static const uint8_t x[] = "x";

  fixture_t aborted;
  fixture_init(&aborted);
  pocketjs_net_http_client_request_t request =
      make_streaming_post(1U, false, 0U);
  start_streaming_request(&aborted, &request);
  pocketjs_net_http_client_event_t pull = take_request_body_pull(
      &aborted, POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES);
  uint64_t body_generation = pull.detail.request_body_pull.body_generation;
  uint64_t pull_generation = pull.detail.request_body_pull.pull_generation;
  assert(pocketjs_net_http_client_core_abort(aborted.core, 1U));
  assert(!get_status(&aborted).request_body_credit_outstanding);
  assert(
      pocketjs_net_http_client_core_retire_event(aborted.core, pull.sequence));
  assert(!pocketjs_net_http_client_core_submit_request_body_chunk(
      aborted.core, 1U, body_generation, pull_generation, x, 1U));
  complete_streaming_error(&aborted, POCKETJS_NET_HTTP_CLIENT_ERROR_ABORTED, 0);

  fixture_t timed_out;
  fixture_init(&timed_out);
  request = make_streaming_post(1U, false, 0U);
  start_streaming_request(&timed_out, &request);
  pull = take_request_body_pull(
      &timed_out, POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES);
  body_generation = pull.detail.request_body_pull.body_generation;
  pull_generation = pull.detail.request_body_pull.pull_generation;
  retire_request_body_pull(&timed_out, pull);
  timed_out.now += timed_out.config.total_timeout_us + 1U;
  assert(pocketjs_net_http_client_core_pump(timed_out.core, timed_out.now, 8U,
                                            8U));
  assert(!get_status(&timed_out).request_body_credit_outstanding);
  assert(!pocketjs_net_http_client_core_submit_request_body_end(
      timed_out.core, 1U, body_generation, pull_generation));
  complete_streaming_error(&timed_out, POCKETJS_NET_HTTP_CLIENT_ERROR_TIMED_OUT,
                           0);

  fixture_t producer_error;
  fixture_init(&producer_error);
  request = make_streaming_post(1U, false, 0U);
  start_streaming_request(&producer_error, &request);
  pull = take_request_body_pull(
      &producer_error, POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES);
  body_generation = pull.detail.request_body_pull.body_generation;
  pull_generation = pull.detail.request_body_pull.pull_generation;
  retire_request_body_pull(&producer_error, pull);
  assert(pocketjs_net_http_client_core_submit_request_body_error(
      producer_error.core, 1U, body_generation, pull_generation, 31337));
  assert(!pocketjs_net_http_client_core_submit_request_body_error(
      producer_error.core, 1U, body_generation, pull_generation, 99));
  complete_streaming_error(&producer_error,
                           POCKETJS_NET_HTTP_CLIENT_ERROR_REQUEST_BODY, 31337);

  fixture_t teardown;
  fixture_init(&teardown);
  request = make_streaming_post(1U, false, 0U);
  start_streaming_request(&teardown, &request);
  pull = take_request_body_pull(
      &teardown, POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES);
  body_generation = pull.detail.request_body_pull.body_generation;
  pull_generation = pull.detail.request_body_pull.pull_generation;
  retire_request_body_pull(&teardown, pull);
  ++teardown.now;
  assert(pocketjs_net_http_client_core_begin_shutdown(teardown.core,
                                                      teardown.now));
  assert(!pocketjs_net_http_client_core_submit_request_body_chunk(
      teardown.core, 1U, body_generation, pull_generation, x, 1U));
  complete_streaming_error(&teardown, POCKETJS_NET_HTTP_CLIENT_ERROR_ABORTED,
                           0);
  assert(pocketjs_net_http_client_core_is_quiescent(teardown.core));
  assert(pocketjs_net_http_client_core_deinit(teardown.core));
}

static void test_request_body_mode_validation(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  static const uint8_t x[] = "x";
  pocketjs_net_http_client_request_t request =
      make_get(1U, "http://127.0.0.1/");
  request.body_kind = POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_STREAMING;
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_FORBIDDEN_REQUEST);
  request.body_kind = POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_FIXED;
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_FORBIDDEN_REQUEST);
  static const uint8_t head[] = "HEAD";
  request.method = (pocketjs_net_http_client_slice_t){
      .data = head,
      .length = sizeof(head) - 1U,
  };
  request.body_kind = POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_STREAMING;
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_FORBIDDEN_REQUEST);

  static const uint8_t post[] = "POST";
  request.method = (pocketjs_net_http_client_slice_t){
      .data = post,
      .length = sizeof(post) - 1U,
  };
  request.body_kind = POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_NONE;
  request.body = (pocketjs_net_http_client_slice_t){.data = x, .length = 1U};
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_INVALID_ARGUMENT);
  request.body = (pocketjs_net_http_client_slice_t){0};
  request.streaming_content_length_known = true;
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_INVALID_ARGUMENT);
  request.body_kind = POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_FIXED;
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_INVALID_ARGUMENT);
  request.streaming_content_length_known = false;
  request.body_kind = POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_FIXED;
  request.body = (pocketjs_net_http_client_slice_t){
      .data = x,
      .length = POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REQUEST_BODY_BYTES + 1U,
  };
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_LIMIT_EXCEEDED);
  request.body_kind = POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_STREAMING;
  request.body = (pocketjs_net_http_client_slice_t){.data = x, .length = 1U};
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_INVALID_ARGUMENT);
  request.body = (pocketjs_net_http_client_slice_t){0};
  request.streaming_content_length = 1U;
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_INVALID_ARGUMENT);
  request.streaming_content_length = 0U;
  request.body_kind = (pocketjs_net_http_client_request_body_kind_t)UINT32_MAX;
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_INVALID_ARGUMENT);
  assert(fixture.fake.active_kind == FAKE_NONE);
}

static void test_idle_stale_read_is_cleanup_only(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  fixture.fake.read_bytes[0] = 'x';
  fixture.fake.read_length = 1U;
  fixture.fake.read_lease_generation = 1U;
  fixture.fake.read_lease_active = true;
  fixture.fake.completion = (pocketjs_net_http_client_transport_completion_t){
      .type = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_READ,
      .operation_token = 777U,
      .detail.read =
          {
              .connection = {.slot = 9U, .generation = 9U},
              .lease = {.slot = 0U, .generation = 1U},
              .byte_count = 1U,
              .eof = false,
          },
  };
  fixture.fake.completion_queued = true;
  pump(&fixture);
  assert(fixture.fake.releases == 1U);
  assert(fixture.fake.retires == 1U);
  pocketjs_net_http_client_core_status_t status = get_status(&fixture);
  assert(status.poisoned);
  assert((status.poison_flags &
          POCKETJS_NET_HTTP_CLIENT_POISON_STALE_COMPLETION) != 0U);
  assert(status.operation_token == 0U);
  assert(!status.event_outstanding);
  pocketjs_net_http_client_event_t event;
  assert(!pocketjs_net_http_client_core_take_event(fixture.core, &event));
  pocketjs_net_http_client_request_t request =
      make_get(1U, "http://example.com/");
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_POISONED);
}

static void test_close_error_preserves_success_and_explicit_teardown(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  connect_and_write_get(&fixture, 1U, "http://example.com:8080/x?q=1");
  fake_complete_read(&fixture.fake, "HTTP/1.1 204 No Content\r\n\r\n", false);
  pump(&fixture);
  pocketjs_net_http_client_event_t headers =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  retire_event(&fixture, headers);
  assert(fixture.fake.active_kind == FAKE_CLOSE);
  fake_queue_error(&fixture.fake, POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_IO,
                   77);
  pump(&fixture);
  pocketjs_net_http_client_event_t complete =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  pocketjs_net_http_client_core_status_t status = get_status(&fixture);
  assert(status.poisoned && status.connection_owned);
  assert((status.poison_flags &
          POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_COMPLETION) != 0U);
  assert(status.first_poison_cause_code == 77);
  retire_event(&fixture, complete);
  assert(!pocketjs_net_http_client_core_is_quiescent(fixture.core));
  assert(
      pocketjs_net_http_client_core_begin_shutdown(fixture.core, fixture.now));
  assert(
      pocketjs_net_http_client_core_confirm_transport_shutdown(fixture.core));
  assert(pocketjs_net_http_client_core_is_quiescent(fixture.core));
  assert(pocketjs_net_http_client_core_deinit(fixture.core));
  assert(!pocketjs_net_http_client_core_get_status(fixture.core, &status));
  pocketjs_net_http_client_core_t *reinitialized = NULL;
  assert(pocketjs_net_http_client_core_init(&fixture.storage, &fixture.config,
                                            &reinitialized) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  assert(reinitialized != NULL);
}

static void test_close_error_preserves_protocol_failure(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  connect_and_write_get(&fixture, 1U, "http://example.com:8080/x?q=1");
  fake_complete_read(&fixture.fake,
                     "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n"
                     "Content-Encoding: gzip\r\n\r\nx",
                     false);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_CLOSE);
  fake_queue_error(&fixture.fake, POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_IO,
                   88);
  pump(&fixture);
  pocketjs_net_http_client_event_t error =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code == POCKETJS_NET_HTTP_CLIENT_ERROR_PROTOCOL);
  pocketjs_net_http_client_core_status_t status = get_status(&fixture);
  assert((status.poison_flags &
          POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_COMPLETION) != 0U);
  assert(status.first_poison_cause_code == 88);
  retire_event(&fixture, error);
}

static void test_close_admission_does_not_replace_terminals(void) {
  fixture_t success_fixture;
  fixture_init(&success_fixture);
  connect_and_write_get(&success_fixture, 1U, "http://example.com:8080/x?q=1");
  success_fixture.fake.start_failure[FAKE_CLOSE] =
      POCKETJS_NET_HTTP_CLIENT_TRANSPORT_BUSY;
  fake_complete_read(&success_fixture.fake, "HTTP/1.1 204 No Content\r\n\r\n",
                     false);
  pump(&success_fixture);
  pocketjs_net_http_client_event_t headers = take_event(
      &success_fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  retire_event(&success_fixture, headers);
  pocketjs_net_http_client_event_t complete =
      take_event(&success_fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  pocketjs_net_http_client_core_status_t status = get_status(&success_fixture);
  assert((status.poison_flags &
          POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_ADMISSION) != 0U);
  assert(status.connection_owned);
  retire_event(&success_fixture, complete);

  fixture_t error_fixture;
  fixture_init(&error_fixture);
  connect_and_write_get(&error_fixture, 1U, "http://example.com:8080/x?q=1");
  error_fixture.fake.start_failure[FAKE_CLOSE] =
      POCKETJS_NET_HTTP_CLIENT_TRANSPORT_BUSY;
  fake_complete_read(&error_fixture.fake,
                     "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n"
                     "Content-Encoding: gzip\r\n\r\nx",
                     false);
  pump(&error_fixture);
  pocketjs_net_http_client_event_t error =
      take_event(&error_fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code == POCKETJS_NET_HTTP_CLIENT_ERROR_PROTOCOL);
  status = get_status(&error_fixture);
  assert((status.poison_flags &
          POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_ADMISSION) != 0U);
  retire_event(&error_fixture, error);
}

static void test_close_timeout_preserves_success(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  connect_and_write_get(&fixture, 1U, "http://example.com:8080/x?q=1");
  fake_complete_read(&fixture.fake, "HTTP/1.1 204 No Content\r\n\r\n", false);
  pump(&fixture);
  pocketjs_net_http_client_event_t headers =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  retire_event(&fixture, headers);
  assert(fixture.fake.active_kind == FAKE_CLOSE);
  fixture.now += 1000001U;
  assert(pocketjs_net_http_client_core_pump(fixture.core, fixture.now, 8U, 8U));
  assert(fixture.fake.cancels == 1U);
  pocketjs_net_http_client_event_t complete =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  pocketjs_net_http_client_core_status_t status = get_status(&fixture);
  assert((status.poison_flags &
          POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_TIMEOUT) != 0U);
  retire_event(&fixture, complete);
}

static void test_read_lease_release_failure_is_auditable(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  connect_and_write_get(&fixture, 1U, "http://example.com:8080/x?q=1");
  fake_complete_read(&fixture.fake,
                     "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nx", false);
  pump(&fixture);
  pocketjs_net_http_client_event_t headers =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  retire_event(&fixture, headers);
  fixture.fake.lease_release_failure =
      POCKETJS_NET_HTTP_CLIENT_TRANSPORT_FAILED;
  assert(pocketjs_net_http_client_core_grant_body_credit(fixture.core, 1U, 1U));
  pump(&fixture);
  pocketjs_net_http_client_event_t body =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_BODY);
  pocketjs_net_http_client_core_status_t status = get_status(&fixture);
  assert(status.transport_read_leases_owned == 1U);
  assert((status.poison_flags &
          POCKETJS_NET_HTTP_CLIENT_POISON_READ_LEASE_RELEASE) != 0U);
  assert(pocketjs_net_http_client_core_release_body_lease(
      fixture.core, body.detail.body.lease));
  retire_event(&fixture, body);
  fixture.fake.lease_release_failure = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK;
  pump(&fixture);
  status = get_status(&fixture);
  assert(status.transport_read_leases_owned == 0U);
  assert(fixture.fake.releases == 1U);
  assert(fixture.fake.active_kind == FAKE_CLOSE);
  fake_complete_close(&fixture.fake);
  pump(&fixture);
  pocketjs_net_http_client_event_t complete =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  retire_event(&fixture, complete);
  pocketjs_net_http_client_request_t request =
      make_get(2U, "http://example.com/");
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_POISONED);
}

static void test_unexpected_read_payload_is_released_in_every_phase(void) {
  pocketjs_net_http_client_transport_connection_t unexpected_connection = {
      .slot = 42U,
      .generation = 42U,
  };

  fixture_t resolving;
  fixture_init(&resolving);
  pocketjs_net_http_client_request_t request =
      make_get(1U, "http://example.com/");
  assert(pocketjs_net_http_client_core_start(resolving.core, &request,
                                             resolving.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  fake_complete_unexpected_read(&resolving.fake, unexpected_connection, "x",
                                false);
  pump(&resolving);
  assert(resolving.fake.releases == 1U);
  pocketjs_net_http_client_event_t error =
      take_event(&resolving, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code == POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT);
  retire_event(&resolving, error);

  fixture_t connecting;
  fixture_init(&connecting);
  request = make_get(1U, "http://127.0.0.1/");
  assert(pocketjs_net_http_client_core_start(connecting.core, &request,
                                             connecting.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  fake_complete_unexpected_read(&connecting.fake, unexpected_connection, "x",
                                false);
  pump(&connecting);
  assert(connecting.fake.releases == 1U);
  error = take_event(&connecting, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code == POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT);
  retire_event(&connecting, error);

  fixture_t writing;
  fixture_init(&writing);
  request = make_get(1U, "http://example.com/");
  assert(pocketjs_net_http_client_core_start(writing.core, &request,
                                             writing.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  uint32_t address = 0x0100007fU;
  fake_complete_resolve(&writing.fake, &address, 1U);
  pump(&writing);
  fake_complete_connect(&writing.fake);
  pump(&writing);
  assert(writing.fake.active_kind == FAKE_WRITE);
  fake_complete_unexpected_read(&writing.fake, writing.fake.connection, "x",
                                false);
  pump(&writing);
  assert(writing.fake.releases == 1U);
  assert(writing.fake.active_kind == FAKE_CLOSE);
  fake_complete_close(&writing.fake);
  pump(&writing);
  error = take_event(&writing, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code == POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT);
  retire_event(&writing, error);

  fixture_t closing;
  fixture_init(&closing);
  connect_and_write_get(&closing, 1U, "http://example.com:8080/x?q=1");
  fake_complete_read(&closing.fake, "HTTP/1.1 204 No Content\r\n\r\n", false);
  pump(&closing);
  pocketjs_net_http_client_event_t headers =
      take_event(&closing, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  retire_event(&closing, headers);
  assert(closing.fake.active_kind == FAKE_CLOSE);
  size_t releases_before_unexpected_close = closing.fake.releases;
  fake_complete_unexpected_read(&closing.fake, closing.fake.connection, "x",
                                false);
  pump(&closing);
  assert(closing.fake.releases == releases_before_unexpected_close + 1U);
  pocketjs_net_http_client_event_t complete =
      take_event(&closing, POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  pocketjs_net_http_client_core_status_t status = get_status(&closing);
  assert((status.poison_flags &
          POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_COMPLETION) != 0U);
  retire_event(&closing, complete);
}

static void test_malformed_read_releases_and_view_failure_retains(void) {
  fixture_t malformed;
  fixture_init(&malformed);
  connect_and_write_get(&malformed, 1U, "http://example.com:8080/x?q=1");
  malformed.fake.read_bytes[0] = 'x';
  malformed.fake.read_length = 1U;
  ++malformed.fake.read_lease_generation;
  malformed.fake.read_lease_active = true;
  fake_queue(
      &malformed.fake,
      (pocketjs_net_http_client_transport_completion_t){
          .type = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_READ,
          .detail.read =
              {
                  .connection = {.slot = 99U, .generation = 99U},
                  .lease = {.slot = 0U,
                            .generation = malformed.fake.read_lease_generation},
                  .byte_count = 1U,
                  .eof = false,
              },
      });
  pump(&malformed);
  assert(malformed.fake.release_attempts == 1U);
  assert(malformed.fake.releases == 1U);
  assert(malformed.fake.active_kind == FAKE_CLOSE);
  fake_complete_close(&malformed.fake);
  pump(&malformed);
  pocketjs_net_http_client_event_t error =
      take_event(&malformed, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code == POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT);
  retire_event(&malformed, error);

  fixture_t bad_view;
  fixture_init(&bad_view);
  connect_and_write_get(&bad_view, 1U, "http://example.com:8080/x?q=1");
  bad_view.fake.lease_view_failure = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_INVALID;
  bad_view.fake.lease_release_failure =
      POCKETJS_NET_HTTP_CLIENT_TRANSPORT_FAILED;
  fake_complete_read(&bad_view.fake, "x", false);
  pump(&bad_view);
  pocketjs_net_http_client_core_status_t status = get_status(&bad_view);
  assert(status.transport_read_leases_owned == 1U);
  assert((status.poison_flags &
          POCKETJS_NET_HTTP_CLIENT_POISON_READ_LEASE_RELEASE) != 0U);
  bad_view.fake.lease_release_failure = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK;
  pump(&bad_view);
  status = get_status(&bad_view);
  assert(status.transport_read_leases_owned == 0U);
  assert(bad_view.fake.releases == 1U);
  assert(bad_view.fake.active_kind == FAKE_CLOSE);
  fake_complete_close(&bad_view.fake);
  pump(&bad_view);
  error = take_event(&bad_view, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code == POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT);
  retire_event(&bad_view, error);
}

static void test_completion_retire_failure_is_poisoned_and_retried(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  pocketjs_net_http_client_request_t request =
      make_get(1U, "http://example.com/");
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  uint32_t address = 0x0100007fU;
  fake_complete_resolve(&fixture.fake, &address, 1U);
  fixture.fake.retire_failure = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_FAILED;
  pump(&fixture);
  pocketjs_net_http_client_core_status_t status = get_status(&fixture);
  assert(status.completion_retire_pending);
  assert((status.poison_flags &
          POCKETJS_NET_HTTP_CLIENT_POISON_COMPLETION_RETIRE) != 0U);
  fixture.fake.retire_failure = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK;
  pump(&fixture);
  status = get_status(&fixture);
  assert(!status.completion_retire_pending);
  pocketjs_net_http_client_event_t error =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  assert(error.detail.error.code == POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT);
  retire_event(&fixture, error);
}

static void test_idle_transport_faults_do_not_publish(void) {
  fixture_t pump_failure;
  fixture_init(&pump_failure);
  pump_failure.fake.pump_failure = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_FAILED;
  pump(&pump_failure);
  pocketjs_net_http_client_core_status_t status = get_status(&pump_failure);
  assert((status.poison_flags &
          POCKETJS_NET_HTTP_CLIENT_POISON_TRANSPORT_PUMP) != 0U);
  assert(status.operation_token == 0U && !status.event_outstanding);

  fixture_t take_failure;
  fixture_init(&take_failure);
  take_failure.fake.take_failure = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_FAILED;
  pump(&take_failure);
  status = get_status(&take_failure);
  assert((status.poison_flags &
          POCKETJS_NET_HTTP_CLIENT_POISON_COMPLETION_TAKE) != 0U);
  assert(status.operation_token == 0U && !status.event_outstanding);
}

static void test_native_only_pump_budget(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  pocketjs_net_http_client_request_t request =
      make_get(1U, "http://example.com/");
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  uint32_t address = 0x0100007fU;
  fake_complete_resolve(&fixture.fake, &address, 1U);

  ++fixture.now;
  assert(pocketjs_net_http_client_core_pump(fixture.core, fixture.now, 1U, 0U));
  assert(fixture.fake.pump_calls == 1U);
  assert(fixture.fake.take_attempts == 0U);
  assert(fixture.fake.completion_queued);
  pocketjs_net_http_client_core_status_t status = get_status(&fixture);
  assert(!status.poisoned && status.poison_flags == 0U);
}

static void test_completion_only_pump_budget(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  pocketjs_net_http_client_request_t request =
      make_get(1U, "http://example.com/");
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  uint32_t address = 0x0100007fU;
  fake_complete_resolve(&fixture.fake, &address, 1U);

  ++fixture.now;
  assert(pocketjs_net_http_client_core_pump(fixture.core, fixture.now, 0U, 1U));
  assert(fixture.fake.pump_calls == 0U);
  assert(fixture.fake.take_attempts == 1U);
  assert(!fixture.fake.completion_queued);
  assert(fixture.fake.active_kind == FAKE_CONNECT);
  pocketjs_net_http_client_core_status_t status = get_status(&fixture);
  assert(!status.poisoned && status.poison_flags == 0U);
}

static void test_empty_pump_budget_is_rejected_without_poison(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  fixture.fake.pump_failure = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_FAILED;
  fixture.fake.take_failure = POCKETJS_NET_HTTP_CLIENT_TRANSPORT_FAILED;

  assert(
      !pocketjs_net_http_client_core_pump(fixture.core, fixture.now, 0U, 0U));
  assert(fixture.fake.pump_calls == 0U);
  assert(fixture.fake.take_attempts == 0U);
  pocketjs_net_http_client_core_status_t status = get_status(&fixture);
  assert(!status.poisoned && status.poison_flags == 0U);
}

static void test_poison_shutdown_can_abandon_exact_host_event(void) {
  fixture_t healthy;
  fixture_init(&healthy);
  assert(!pocketjs_net_http_client_core_abandon_event_after_transport_shutdown(
      healthy.core, 1U));
  connect_and_write_get(&healthy, 1U, "http://example.com:8080/x?q=1");
  fake_complete_read(&healthy.fake, "HTTP/1.1 204 No Content\r\n\r\n", false);
  pump(&healthy);
  pocketjs_net_http_client_event_t headers =
      take_event(&healthy, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  retire_event(&healthy, headers);
  fake_complete_close(&healthy.fake);
  pump(&healthy);
  pocketjs_net_http_client_event_t complete =
      take_event(&healthy, POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  assert(pocketjs_net_http_client_core_begin_shutdown(healthy.core,
                                                      ++healthy.now));
  assert(
      pocketjs_net_http_client_core_confirm_transport_shutdown(healthy.core));
  assert(!pocketjs_net_http_client_core_abandon_event_after_transport_shutdown(
      healthy.core, complete.sequence));
  retire_event(&healthy, complete);
  assert(pocketjs_net_http_client_core_is_quiescent(healthy.core));
  assert(pocketjs_net_http_client_core_deinit(healthy.core));

  fixture_t body_fixture;
  fixture_init(&body_fixture);
  connect_and_write_get(&body_fixture, 1U, "http://example.com:8080/x?q=1");
  fake_complete_read(&body_fixture.fake,
                     "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nx", false);
  pump(&body_fixture);
  headers = take_event(&body_fixture,
                       POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  retire_event(&body_fixture, headers);
  assert(pocketjs_net_http_client_core_grant_body_credit(body_fixture.core, 1U,
                                                         1U));
  pump(&body_fixture);
  pocketjs_net_http_client_event_t body =
      take_event(&body_fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_BODY);
  const uint8_t *body_bytes = NULL;
  size_t body_length = 0U;
  assert(pocketjs_net_http_client_core_body_lease_view(
      body_fixture.core, body.detail.body.lease, &body_bytes, &body_length));
  assert(body_length == 1U && body_bytes[0] == 'x');
  assert(pocketjs_net_http_client_core_report_host_event_retire_failure(
      body_fixture.core, body.sequence));
  assert(get_status(&body_fixture).poisoned);
  assert(!pocketjs_net_http_client_core_abandon_event_after_transport_shutdown(
      body_fixture.core, body.sequence));
  assert(pocketjs_net_http_client_core_begin_shutdown(body_fixture.core,
                                                      ++body_fixture.now));
  assert(!pocketjs_net_http_client_core_abandon_event_after_transport_shutdown(
      body_fixture.core, body.sequence));
  assert(pocketjs_net_http_client_core_confirm_transport_shutdown(
      body_fixture.core));
  assert(!pocketjs_net_http_client_core_abandon_event_after_transport_shutdown(
      body_fixture.core, body.sequence + 1U));
  assert(pocketjs_net_http_client_core_abandon_event_after_transport_shutdown(
      body_fixture.core, body.sequence));
  assert(!pocketjs_net_http_client_core_body_lease_view(
      body_fixture.core, body.detail.body.lease, &body_bytes, &body_length));
  pocketjs_net_http_client_event_t error =
      take_event(&body_fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  retire_event(&body_fixture, error);
  assert(pocketjs_net_http_client_core_is_quiescent(body_fixture.core));
  assert(pocketjs_net_http_client_core_deinit(body_fixture.core));

  fixture_t pull_fixture;
  fixture_init(&pull_fixture);
  pocketjs_net_http_client_request_t request =
      make_streaming_post(1U, false, 0U);
  start_streaming_request(&pull_fixture, &request);
  pocketjs_net_http_client_event_t pull = take_request_body_pull(
      &pull_fixture, POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES);
  assert(pocketjs_net_http_client_core_report_host_event_retire_failure(
      pull_fixture.core, pull.sequence));
  assert(get_status(&pull_fixture).poisoned);
  assert(pocketjs_net_http_client_core_begin_shutdown(pull_fixture.core,
                                                      ++pull_fixture.now));
  assert(pocketjs_net_http_client_core_confirm_transport_shutdown(
      pull_fixture.core));
  assert(pocketjs_net_http_client_core_abandon_event_after_transport_shutdown(
      pull_fixture.core, pull.sequence));
  pocketjs_net_http_client_core_status_t status = get_status(&pull_fixture);
  assert(!status.request_body_credit_outstanding && status.event_outstanding);
  error = take_event(&pull_fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR);
  retire_event(&pull_fixture, error);
  assert(pocketjs_net_http_client_core_is_quiescent(pull_fixture.core));
  assert(pocketjs_net_http_client_core_deinit(pull_fixture.core));

  fixture_t terminal_fixture;
  fixture_init(&terminal_fixture);
  connect_and_write_get(&terminal_fixture, 1U, "http://example.com:8080/x?q=1");
  fake_complete_read(&terminal_fixture.fake, "HTTP/1.1 204 No Content\r\n\r\n",
                     false);
  pump(&terminal_fixture);
  headers = take_event(&terminal_fixture,
                       POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  retire_event(&terminal_fixture, headers);
  fake_queue_error(&terminal_fixture.fake,
                   POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_IO, 91);
  pump(&terminal_fixture);
  status = get_status(&terminal_fixture);
  assert(status.poisoned && status.event_outstanding);
  assert(pocketjs_net_http_client_core_begin_shutdown(terminal_fixture.core,
                                                      ++terminal_fixture.now));
  assert(pocketjs_net_http_client_core_confirm_transport_shutdown(
      terminal_fixture.core));
  assert(!pocketjs_net_http_client_core_abandon_event_after_transport_shutdown(
      terminal_fixture.core, status.operation_token));
  complete =
      take_event(&terminal_fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  assert(pocketjs_net_http_client_core_abandon_event_after_transport_shutdown(
      terminal_fixture.core, complete.sequence));
  assert(pocketjs_net_http_client_core_is_quiescent(terminal_fixture.core));
  assert(pocketjs_net_http_client_core_deinit(terminal_fixture.core));
}

static void start_first_reusable_get(fixture_t *fixture, uint64_t token,
                                     const char *url,
                                     const char *expected_target) {
  const pocketjs_net_http_client_request_t request = make_get(token, url);
  assert(pocketjs_net_http_client_core_start(fixture->core, &request,
                                             fixture->now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  assert(fixture->fake.active_kind == FAKE_RESOLVE);
  const uint32_t address = 0x0100007fU;
  fake_complete_resolve(&fixture->fake, &address, 1U);
  pump(fixture);
  assert(fixture->fake.active_kind == FAKE_CONNECT);
  fake_complete_connect(&fixture->fake);
  pump(fixture);
  assert(fixture->fake.active_kind == FAKE_WRITE);
  assert(bytes_contain(fixture->fake.write_bytes, fixture->fake.write_length,
                       expected_target));
  assert(!bytes_contain(fixture->fake.write_bytes, fixture->fake.write_length,
                        "Connection: close\r\n"));
  fake_complete_write(&fixture->fake);
  pump(fixture);
  assert(fixture->fake.active_kind == FAKE_READ);
}

static void cache_empty_response(fixture_t *fixture) {
  fake_complete_read(&fixture->fake, "HTTP/1.1 204 No Content\r\n\r\n", false);
  pump(fixture);
  const pocketjs_net_http_client_event_t headers =
      take_event(fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  retire_event(fixture, headers);
  assert(fixture->fake.active_kind == FAKE_NONE);
  const pocketjs_net_http_client_event_t complete =
      take_event(fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  assert(get_status(fixture).connection_reusable);
  retire_event(fixture, complete);
  const pocketjs_net_http_client_core_status_t status = get_status(fixture);
  assert(status.connection_owned && status.connection_reusable &&
         !status.request_active);
}

static void test_connection_reuse_is_same_origin_and_bounded(void) {
  fixture_t fixture;
  fixture_init_with_reuse(&fixture, false);
  start_first_reusable_get(&fixture, 1U, "http://example.com:8080/one",
                           "GET /one HTTP/1.1\r\n");
  cache_empty_response(&fixture);
  assert(fixture.fake.starts[FAKE_RESOLVE] == 1U);
  assert(fixture.fake.starts[FAKE_CONNECT] == 1U);

  const pocketjs_net_http_client_request_t second =
      make_get(2U, "http://example.com:8080/two");
  assert(
      pocketjs_net_http_client_core_start(fixture.core, &second, fixture.now) ==
      POCKETJS_NET_HTTP_CLIENT_START_OK);
  assert(fixture.fake.active_kind == FAKE_WRITE);
  assert(fixture.fake.starts[FAKE_RESOLVE] == 1U);
  assert(fixture.fake.starts[FAKE_CONNECT] == 1U);
  assert(fixture.permissions.hostname_calls == 2U);
  assert(fixture.permissions.numeric_calls == 2U);
  assert(bytes_contain(fixture.fake.write_bytes, fixture.fake.write_length,
                       "GET /two HTTP/1.1\r\n"));
  assert(!bytes_contain(fixture.fake.write_bytes, fixture.fake.write_length,
                        "Connection: close\r\n"));
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  fake_complete_read(
      &fixture.fake,
      "HTTP/1.1 204 No Content\r\nConnection: keep-alive, close\r\n\r\n",
      false);
  pump(&fixture);
  const pocketjs_net_http_client_event_t headers =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS);
  retire_event(&fixture, headers);
  assert(fixture.fake.active_kind == FAKE_CLOSE);
  fake_complete_close(&fixture.fake);
  pump(&fixture);
  const pocketjs_net_http_client_event_t complete =
      take_event(&fixture, POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE);
  retire_event(&fixture, complete);
  assert(!get_status(&fixture).connection_owned);
}

static void test_https_connection_reuse_preserves_tls_origin(void) {
  fixture_t fixture;
  fixture_init_with_reuse(&fixture, true);
  pocketjs_net_http_client_request_t first =
      make_tls_get(1U, "https://example.com/one", "example.com");
  assert(
      pocketjs_net_http_client_core_start(fixture.core, &first, fixture.now) ==
      POCKETJS_NET_HTTP_CLIENT_START_OK);
  assert(fixture.fake.active_kind == FAKE_RESOLVE);
  const uint32_t address = 0x0100007fU;
  fake_complete_resolve(&fixture.fake, &address, 1U);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_CONNECT);
  assert(fixture.fake.connect_tls);
  assert(strcmp(fixture.fake.connect_hostname, "example.com") == 0);
  fake_complete_connect(&fixture.fake);
  pump(&fixture);
  assert(fixture.fake.active_kind == FAKE_WRITE);
  assert(bytes_contain(fixture.fake.write_bytes, fixture.fake.write_length,
                       "GET /one HTTP/1.1\r\n"));
  assert(!bytes_contain(fixture.fake.write_bytes, fixture.fake.write_length,
                        "Connection: close\r\n"));
  fake_complete_write(&fixture.fake);
  pump(&fixture);
  cache_empty_response(&fixture);

  pocketjs_net_http_client_request_t second =
      make_tls_get(2U, "https://example.com/two", "example.com");
  assert(
      pocketjs_net_http_client_core_start(fixture.core, &second, fixture.now) ==
      POCKETJS_NET_HTTP_CLIENT_START_OK);
  assert(fixture.fake.active_kind == FAKE_WRITE);
  assert(fixture.fake.starts[FAKE_RESOLVE] == 1U);
  assert(fixture.fake.starts[FAKE_CONNECT] == 1U);
  assert(fixture.permissions.hostname_calls == 2U);
  assert(fixture.permissions.numeric_calls == 2U);
  assert(bytes_contain(fixture.fake.write_bytes, fixture.fake.write_length,
                       "GET /two HTTP/1.1\r\n"));
}

static void test_connection_pool_replaces_origin_and_closes_on_shutdown(void) {
  fixture_t replacement;
  fixture_init_with_reuse(&replacement, false);
  start_first_reusable_get(&replacement, 1U, "http://example.com/one",
                           "GET /one HTTP/1.1\r\n");
  cache_empty_response(&replacement);

  const pocketjs_net_http_client_request_t other =
      make_get(2U, "http://other.example/two");
  assert(pocketjs_net_http_client_core_start(replacement.core, &other,
                                             replacement.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_OK);
  assert(replacement.fake.active_kind == FAKE_CLOSE);
  assert(replacement.permissions.hostname_calls == 1U);
  fake_complete_close(&replacement.fake);
  pump(&replacement);
  assert(replacement.fake.active_kind == FAKE_RESOLVE);
  assert(strcmp(replacement.fake.resolve_hostname, "other.example") == 0);
  assert(replacement.permissions.hostname_calls == 2U);

  fixture_t shutdown;
  fixture_init_with_reuse(&shutdown, false);
  start_first_reusable_get(&shutdown, 1U, "http://example.com/one",
                           "GET /one HTTP/1.1\r\n");
  cache_empty_response(&shutdown);
  assert(pocketjs_net_http_client_core_begin_shutdown(shutdown.core,
                                                      ++shutdown.now));
  assert(shutdown.fake.active_kind == FAKE_CLOSE);
  pocketjs_net_http_client_event_t event;
  assert(!pocketjs_net_http_client_core_take_event(shutdown.core, &event));
  fake_complete_close(&shutdown.fake);
  pump(&shutdown);
  assert(pocketjs_net_http_client_core_is_quiescent(shutdown.core));
  assert(!pocketjs_net_http_client_core_take_event(shutdown.core, &event));
  assert(pocketjs_net_http_client_core_deinit(shutdown.core));

  fixture_t expired;
  fixture_init_with_reuse(&expired, false);
  start_first_reusable_get(&expired, 1U, "http://example.com/one",
                           "GET /one HTTP/1.1\r\n");
  cache_empty_response(&expired);
  expired.now += expired.config.idle_timeout_us;
  pump(&expired);
  assert(expired.fake.active_kind == FAKE_CLOSE);
  assert(!get_status(&expired).connection_reusable);
  assert(!pocketjs_net_http_client_core_take_event(expired.core, &event));
  fake_complete_close(&expired.fake);
  pump(&expired);
  assert(!get_status(&expired).connection_owned);
  assert(!pocketjs_net_http_client_core_take_event(expired.core, &event));
}

static void test_invalid_inputs(void) {
  fixture_t fixture;
  fixture_init(&fixture);
  pocketjs_net_http_client_request_t request =
      make_get(1U, "http://127.0.0.01/");
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_INVALID_URL);
  request = make_get(1U, "http://example.com/%zz");
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_FORBIDDEN_REQUEST);
  static const uint8_t trace[] = "TRACK";
  request = make_get(1U, "http://example.com/");
  request.method = (pocketjs_net_http_client_slice_t){
      .data = trace,
      .length = sizeof(trace) - 1U,
  };
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_FORBIDDEN_REQUEST);
  request = make_get(1U, "http://example.com/");
  request.redirect_mode =
      (pocketjs_net_http_client_redirect_mode_t)(POCKETJS_NET_HTTP_CLIENT_REDIRECT_ERROR +
                                                 1U);
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_INVALID_ARGUMENT);
  request = make_get(1U, "http://example.com/");
  request.redirect_mode = POCKETJS_NET_HTTP_CLIENT_REDIRECT_FOLLOW;
  request.max_redirects = POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REDIRECTS + 1U;
  assert(pocketjs_net_http_client_core_start(fixture.core, &request,
                                             fixture.now) ==
         POCKETJS_NET_HTTP_CLIENT_START_INVALID_ARGUMENT);
}

int main(void) {
  test_redirect_follow_resolves_relative_url();
  test_redirect_rechecks_permission_before_second_hop();
  test_redirect_rewrites_post_and_strips_cross_origin_headers();
  test_redirect_replays_fixed_body_and_rejects_streaming_replay();
  test_redirect_modes_and_limit_fail_closed();
  test_headers_body_and_status_success();
  test_response_header_limit_configuration_boundaries();
  test_selected_response_header_limit();
  test_https_and_permissions_fail_before_io();
  test_https_base_policy_is_fail_closed();
  test_tls_errors_remain_distinct();
  test_all_candidates_checked_before_denial();
  test_connect_error_tries_next_allowed_candidate();
  test_connect_candidate_exhaustion_preserves_last_error();
  test_non_connect_errors_do_not_advance_candidates();
  test_connect_error_does_not_retry_after_deadline();
  test_protocol_error_closes_before_terminal();
  test_chunked_body_and_valid_trailer();
  test_protocol_error_selected_before_body_pull();
  test_eof_delimited_body();
  test_205_has_no_body();
  test_content_coding_fails_closed();
  test_request_body_is_snapshotted();
  test_abort_exact_one();
  test_total_timeout_exact_one();
  test_permission_callback_reentrancy_is_rejected();
  test_read_bytes_with_eof_waits_for_full_consumption();
  test_head_informational_and_304_are_bodyless();
  test_numeric_permission_denial_has_no_io();
  test_maximum_request_body_boundary();
  test_streaming_chunked_upload_exceeds_64k();
  test_streaming_credit_is_hostile_input_safe();
  test_known_length_streaming_accounting();
  test_streaming_cancel_timeout_error_and_teardown();
  test_request_body_mode_validation();
  test_idle_stale_read_is_cleanup_only();
  test_close_error_preserves_success_and_explicit_teardown();
  test_close_error_preserves_protocol_failure();
  test_close_admission_does_not_replace_terminals();
  test_close_timeout_preserves_success();
  test_read_lease_release_failure_is_auditable();
  test_unexpected_read_payload_is_released_in_every_phase();
  test_malformed_read_releases_and_view_failure_retains();
  test_completion_retire_failure_is_poisoned_and_retried();
  test_idle_transport_faults_do_not_publish();
  test_native_only_pump_budget();
  test_completion_only_pump_budget();
  test_empty_pump_budget_is_rejected_without_poison();
  test_poison_shutdown_can_abandon_exact_host_event();
  test_connection_reuse_is_same_origin_and_bounded();
  test_https_connection_reuse_preserves_tls_origin();
  test_connection_pool_replaces_origin_and_closes_on_shutdown();
  test_invalid_inputs();
  puts("http client core host tests passed");
  return 0;
}
