// SPDX-License-Identifier: MIT

#include "pocketjs/net/esp_transport.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#include "esp_crt_bundle.h"
#include "esp_idf_version.h"
#include "esp_timer.h"
#include "esp_tls.h"
#include "esp_tls_errors.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/dns.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"
#include "lwip/tcpip.h"
#include "mbedtls/ssl.h"
#include "mbedtls/x509.h"
#include "mbedtls/x509_crt.h"
#include "sdkconfig.h"
#include "transport_state.h"

#if ESP_IDF_VERSION != ESP_IDF_VERSION_VAL(6, 0, 2)
#error "PocketJS ESP transport is pinned to exact ESP-IDF v6.0.2"
#endif
#if !defined(CONFIG_ESP_TLS_USING_MBEDTLS) || !CONFIG_ESP_TLS_USING_MBEDTLS
#error "PocketJS ESP transport requires the ESP-TLS Mbed TLS backend"
#endif
#if !defined(CONFIG_MBEDTLS_SSL_PROTO_TLS1_2) ||                               \
    !CONFIG_MBEDTLS_SSL_PROTO_TLS1_2
#error "PocketJS ESP transport requires TLS 1.2"
#endif
#if defined(CONFIG_MBEDTLS_SSL_RENEGOTIATION) &&                               \
    CONFIG_MBEDTLS_SSL_RENEGOTIATION
#error "PocketJS ESP transport rejects TLS 1.2 renegotiation"
#endif
#if defined(CONFIG_ESP_TLS_INSECURE) && CONFIG_ESP_TLS_INSECURE
#error "PocketJS ESP transport rejects insecure ESP-TLS builds"
#endif
#if defined(CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY) &&                         \
    CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY
#error "PocketJS ESP transport requires certificate verification"
#endif
#if defined(CONFIG_MBEDTLS_ALLOW_WEAK_CERTIFICATE_VERIFICATION) &&             \
    CONFIG_MBEDTLS_ALLOW_WEAK_CERTIFICATE_VERIFICATION
#error "PocketJS ESP transport rejects weak certificate verification"
#endif
#if defined(CONFIG_MBEDTLS_DES_C) && CONFIG_MBEDTLS_DES_C
#error "PocketJS ESP transport rejects DES and 3DES"
#endif
#if defined(MBEDTLS_SSL_NULL_CIPHERSUITES) || defined(MBEDTLS_ARC4_C) ||       \
    defined(MBEDTLS_KEY_EXCHANGE_DH_ANON_ENABLED) ||                           \
    defined(MBEDTLS_KEY_EXCHANGE_ECDH_ANON_ENABLED)
#error "PocketJS ESP transport rejects NULL, RC4, and anonymous ciphersuites"
#endif
#if DNS_MAX_HOST_IP != POCKETJS_NET_ESP_TRANSPORT_MAX_DNS_CANDIDATES
#error "CONFIG_LWIP_DNS_MAX_HOST_IP must equal PocketJS candidate capacity"
#endif
#if defined(CONFIG_LWIP_HOOK_DNS_EXT_RESOLVE_CUSTOM) &&                        \
    CONFIG_LWIP_HOOK_DNS_EXT_RESOLVE_CUSTOM
#error "PocketJS ESP transport requires stock tcpip-thread DNS callbacks"
#endif

#if defined(CONFIG_MBEDTLS_CERTIFICATE_BUNDLE) &&                              \
    CONFIG_MBEDTLS_CERTIFICATE_BUNDLE
#define POCKETJS_NET_ESP_TRANSPORT_HAS_BUNDLE 1
#else
#define POCKETJS_NET_ESP_TRANSPORT_HAS_BUNDLE 0
#endif

#if POCKETJS_NET_ESP_TRANSPORT_HAS_BUNDLE &&                                   \
    defined(CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_DEPRECATED_LIST) &&              \
    CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_DEPRECATED_LIST
#error "PocketJS ESP transport rejects deprecated Host roots"
#endif

#define STRINGIFY_INNER(value) #value
#define STRINGIFY(value) STRINGIFY_INNER(value)
#define IMPLEMENTATION_VERSION                                                 \
  "esp-idf-v" STRINGIFY(ESP_IDF_VERSION_MAJOR) "." STRINGIFY(                  \
      ESP_IDF_VERSION_MINOR) "." STRINGIFY(ESP_IDF_VERSION_PATCH) "-reference" \
                                                                  "-candidate"

typedef enum {
  OP_PHASE_INITIAL = 0,
  OP_PHASE_DNS_WAIT,
  OP_PHASE_TCP_CONNECT_WAIT,
  OP_PHASE_TLS_HANDSHAKE,
  OP_PHASE_IO_WAIT,
} operation_phase_t;

typedef enum {
  CONNECTION_FREE = 0,
  CONNECTION_CONNECTING,
  CONNECTION_OPEN,
  CONNECTION_RETIRED,
} connection_state_t;

typedef enum {
  DNS_CONTEXT_FREE = 0,
  DNS_CONTEXT_SUBMIT_QUEUED,
  DNS_CONTEXT_LOOKUP_PENDING,
  DNS_CONTEXT_RESULT_READY,
} dns_context_state_t;

typedef struct {
  bool in_use;
  uint64_t generation;
  size_t byte_count;
  uint8_t bytes[POCKETJS_NET_ESP_TRANSPORT_READ_LEASE_BYTES];
} read_lease_slot_t;

typedef struct {
  connection_state_t state;
  uint64_t generation;
  int fd;
  esp_tls_t *tls;
  bool secure;
  uint32_t ipv4_be;
  pocketjs_net_esp_operation_token_t busy_token;
} connection_slot_t;

typedef struct {
  pocketjs_net_operation_lifecycle_t lifecycle;
  pocketjs_net_transport_operation_kind_t kind;
  operation_phase_t phase;
  pocketjs_net_esp_operation_token_t token;
  uint64_t deadline_us;
  atomic_bool cancel_requested;
  uint32_t connection_slot;
  uint32_t dns_context_slot;
  uint32_t read_lease_slot;
  uint32_t ipv4_be;
  uint16_t port;
  bool secure;
  char hostname[POCKETJS_NET_ESP_TRANSPORT_MAX_HOSTNAME_BYTES + 1U];
  uint8_t write_bytes[POCKETJS_NET_ESP_TRANSPORT_MAX_WRITE_BYTES];
  size_t write_length;
  size_t transferred;
} operation_slot_t;

typedef struct dns_context dns_context_t;

typedef struct {
  dns_context_t *context;
  uint64_t generation;
  bool active;
} dns_callback_ticket_t;

struct dns_context {
  struct pocketjs_net_esp_transport *owner;
  struct tcpip_callback_msg *submit_message;
  dns_callback_ticket_t callback_ticket;
  dns_context_state_t state;
  uint64_t generation;
  pocketjs_net_esp_operation_token_t token;
  atomic_bool cancelled;
  char hostname[POCKETJS_NET_ESP_TRANSPORT_MAX_HOSTNAME_BYTES + 1U];
  uint32_t candidates[POCKETJS_NET_ESP_TRANSPORT_MAX_DNS_CANDIDATES];
  size_t candidate_count;
  err_t result;
};

struct pocketjs_net_esp_transport {
  TaskHandle_t owner_task;
  portMUX_TYPE lock;
  atomic_bool closing;
  pocketjs_net_token_gate_t token_gate;
  pocketjs_net_terminal_credits_t terminal_credits;
  uint64_t next_sequence;
  size_t pump_cursor;

  pocketjs_net_esp_wake_fn wake;
  void *wake_context;
  pocketjs_net_esp_tls_trust_source_t tls_trust_source;
  pocketjs_net_esp_wall_clock_trusted_fn wall_clock_trusted;
  void *wall_clock_context;
  uint8_t pinned_ca[POCKETJS_NET_ESP_TRANSPORT_MAX_PINNED_CA_PEM_BYTES + 1U];
  size_t pinned_ca_bytes;

  operation_slot_t operations[POCKETJS_NET_ESP_TRANSPORT_MAX_OPERATIONS];
  connection_slot_t connections[POCKETJS_NET_ESP_TRANSPORT_MAX_CONNECTIONS];
  dns_context_t dns_contexts[POCKETJS_NET_ESP_TRANSPORT_MAX_DNS_CONTEXTS];
  read_lease_slot_t read_leases[POCKETJS_NET_ESP_TRANSPORT_READ_LEASES];

  pocketjs_net_esp_completion_t
      completion_ring[POCKETJS_NET_ESP_TRANSPORT_COMPLETION_CAPACITY];
  size_t completion_head;
  size_t completion_tail;
  size_t completion_count;
};

static const pocketjs_net_esp_transport_descriptor_t s_descriptor = {
    .id = POCKETJS_NET_ESP_TRANSPORT_ID,
    .implementation_version = IMPLEMENTATION_VERSION,
    .experimental = true,
    .advertises_public_capability = false,
    .ipv4 = true,
    .asynchronous_raw_dns = true,
    .stock_lwip_dns_callbacks_only = true,
    /* A full cache prefix is rejected, but stock lwIP does not expose the DNS
     * TC bit when a shorter prefix came from a truncated response. */
    .complete_dns_candidate_set = false,
    .rejects_saturated_dns_candidate_prefix = true,
    /* Both the tcpip submit and raw found callbacks carry an immutable
     * generation ticket and revalidate it under the transport lock. */
    .dns_cancel_generation_cleanup = true,
    .synchronous_getaddrinfo_for_hostname = false,
    /* The adapter creates and connects the numeric IPv4 socket, then transfers
     * it through ESP-TLS's public socket/state setters. ESP-TLS never resolves
     * the candidate or performs its internal TCP-connect select. */
    .esp_tls_numeric_getaddrinfo_internal = false,
    .nonblocking_plain_tcp_steps = true,
    /* TCP readiness is polled with a zero timeout. ESP-TLS is entered at its
     * CONNECTING state over the already-connected O_NONBLOCK socket, so each
     * Mbed TLS handshake call returns on WANT_READ/WANT_WRITE. */
    .nonblocking_tls_steps = true,
    /* Socket allocation, crypto work, and scheduler contention still have no
     * proven per-step wall-time bound. */
    .bounded_native_step_wall_time = false,
    .esp_tls_internal_select_timeout_ms =
        POCKETJS_NET_ESP_TRANSPORT_TLS_STEP_TIMEOUT_MS,
    .monotonic_deadlines = true,
    .cancel_between_native_steps = true,
    .worker_or_callback_calls_quickjs = false,
    .exact_one_terminal = true,
    .aba_safe_tokens = true,
    .fixed_operation_pool = true,
    .fixed_completion_pool = true,
    .fixed_payload_pool = true,
    .tls_compiled = true,
    .tls_1_2_only = true,
    .host_trust = true,
    .host_pinned_ca = true,
    .hostname_verification = true,
    /* ESP-TLS exposes its live Mbed TLS context through a public accessor.
     * Reading the negotiation verify result after a failed handshake preserves
     * CN_MISMATCH even when ESP-IDF's error handle retained only -0x2700. */
    .distinct_tls_errors = true,
    .sni = true,
    .trusted_wall_clock_required = true,
    .plaintext_fallback = false,
    .renegotiation = false,
    .early_data = false,
    .tls_close_notify = true,
    .tls_close_notify_uses_operation_deadline = true,
    /* The client sends an orderly alert but does not wait indefinitely for a
     * reciprocal alert before releasing the native connection. */
    .tls_close_notify_waits_for_peer = false,
    /* Static callback messages are pre-acquired at create time, but their
     * backing MEMP pool and DNS table are IDF-owned rather than byte-bounded.
     */
    .bounded_lwip_dns_callback_allocation = false,
    .bounded_lwip_socket_allocation = false,
    .bounded_esp_tls_allocation = false,
    .bounded_mbedtls_x509_parse_allocation = false,
    .pocketjs_owned_instance_bytes = sizeof(pocketjs_net_esp_transport_t),
    .lwip_static_callback_messages =
        POCKETJS_NET_ESP_TRANSPORT_MAX_DNS_CONTEXTS,
    .max_connections = POCKETJS_NET_ESP_TRANSPORT_MAX_CONNECTIONS,
    .max_operations = POCKETJS_NET_ESP_TRANSPORT_MAX_OPERATIONS,
    .completion_capacity = POCKETJS_NET_ESP_TRANSPORT_COMPLETION_CAPACITY,
    .max_dns_candidates = POCKETJS_NET_ESP_TRANSPORT_MAX_DNS_CANDIDATES,
    .max_write_bytes = POCKETJS_NET_ESP_TRANSPORT_MAX_WRITE_BYTES,
    .read_lease_bytes = POCKETJS_NET_ESP_TRANSPORT_READ_LEASE_BYTES,
    .max_pinned_ca_bytes = POCKETJS_NET_ESP_TRANSPORT_MAX_PINNED_CA_PEM_BYTES,
};

static bool owner_task(const pocketjs_net_esp_transport_t *transport) {
  return transport != NULL &&
         xTaskGetCurrentTaskHandle() == transport->owner_task;
}

static bool hostname_is_local(const char *hostname) {
  size_t length = strlen(hostname);
  static const char suffix[] = ".local";
  return strcmp(hostname, "local") == 0 ||
         (length > sizeof(suffix) - 1U &&
          strcmp(hostname + length - (sizeof(suffix) - 1U), suffix) == 0);
}

static bool hostname_is_canonical(const char *hostname) {
  if (hostname == NULL) {
    return false;
  }
  size_t length = strlen(hostname);
  if (length == 0U || length > POCKETJS_NET_ESP_TRANSPORT_MAX_HOSTNAME_BYTES ||
      hostname[length - 1U] == '.' || hostname_is_local(hostname)) {
    return false;
  }

  size_t label_length = 0U;
  for (size_t index = 0; index < length; ++index) {
    unsigned char byte = (unsigned char)hostname[index];
    if (byte == '.') {
      if (label_length == 0U || label_length > 63U ||
          hostname[index - 1U] == '-') {
        return false;
      }
      label_length = 0U;
      continue;
    }
    if (!((byte >= 'a' && byte <= 'z') || (byte >= '0' && byte <= '9') ||
          byte == '-')) {
      return false;
    }
    if (label_length == 0U && byte == '-') {
      return false;
    }
    ++label_length;
  }
  return label_length > 0U && label_length <= 63U &&
         hostname[length - 1U] != '-';
}

static bool connection_matches(const connection_slot_t *slot,
                               pocketjs_net_esp_connection_t handle) {
  return slot != NULL && slot->state == CONNECTION_OPEN &&
         handle.generation != 0U && slot->generation == handle.generation;
}

static pocketjs_net_esp_connection_t connection_handle(size_t slot,
                                                       uint64_t generation) {
  pocketjs_net_esp_connection_t result = {
      .slot = (uint32_t)slot,
      .generation = generation,
  };
  return result;
}

static void connection_native_close(connection_slot_t *connection) {
  if (connection->tls != NULL) {
    esp_tls_conn_destroy(connection->tls);
    connection->tls = NULL;
    connection->fd = -1;
  } else if (connection->fd >= 0) {
    close(connection->fd);
    connection->fd = -1;
  }
  connection->busy_token = 0U;
  connection->secure = false;
  connection->ipv4_be = 0U;
  connection->state = CONNECTION_FREE;
}

static operation_slot_t *find_operation(pocketjs_net_esp_transport_t *transport,
                                        uint64_t token) {
  for (size_t index = 0; index < POCKETJS_NET_ESP_TRANSPORT_MAX_OPERATIONS;
       ++index) {
    operation_slot_t *operation = &transport->operations[index];
    if (pocketjs_net_operation_ticket_matches(operation->lifecycle,
                                              operation->token, token)) {
      return operation;
    }
  }
  return NULL;
}

static operation_slot_t *
find_free_operation(pocketjs_net_esp_transport_t *transport) {
  for (size_t index = 0; index < POCKETJS_NET_ESP_TRANSPORT_MAX_OPERATIONS;
       ++index) {
    if (transport->operations[index].lifecycle == POCKETJS_NET_OPERATION_FREE) {
      return &transport->operations[index];
    }
  }
  return NULL;
}

static dns_context_t *
reserve_dns_context(pocketjs_net_esp_transport_t *transport,
                    size_t *out_index) {
  dns_context_t *result = NULL;
  portENTER_CRITICAL(&transport->lock);
  for (size_t index = 0; index < POCKETJS_NET_ESP_TRANSPORT_MAX_DNS_CONTEXTS;
       ++index) {
    dns_context_t *context = &transport->dns_contexts[index];
    if (context->state == DNS_CONTEXT_FREE &&
        !context->callback_ticket.active &&
        pocketjs_net_generation_advance(&context->generation)) {
      context->callback_ticket.generation = context->generation;
      context->callback_ticket.active = true;
      context->state = DNS_CONTEXT_SUBMIT_QUEUED;
      *out_index = index;
      result = context;
      break;
    }
  }
  portEXIT_CRITICAL(&transport->lock);
  return result;
}

static connection_slot_t *
reserve_connection(pocketjs_net_esp_transport_t *transport, size_t *out_index) {
  for (size_t index = 0; index < POCKETJS_NET_ESP_TRANSPORT_MAX_CONNECTIONS;
       ++index) {
    connection_slot_t *connection = &transport->connections[index];
    if (connection->state == CONNECTION_FREE &&
        pocketjs_net_generation_advance(&connection->generation)) {
      connection->state = CONNECTION_CONNECTING;
      connection->fd = -1;
      *out_index = index;
      return connection;
    }
  }
  return NULL;
}

static read_lease_slot_t *
reserve_read_lease(pocketjs_net_esp_transport_t *transport, size_t *out_index) {
  for (size_t index = 0; index < POCKETJS_NET_ESP_TRANSPORT_READ_LEASES;
       ++index) {
    read_lease_slot_t *lease = &transport->read_leases[index];
    if (!lease->in_use && pocketjs_net_generation_advance(&lease->generation)) {
      lease->in_use = true;
      lease->byte_count = 0U;
      *out_index = index;
      return lease;
    }
  }
  return NULL;
}

static void release_read_lease_slot(read_lease_slot_t *lease) {
  lease->byte_count = 0U;
  lease->in_use = false;
}

static esp_err_t accept_operation(pocketjs_net_esp_transport_t *transport,
                                  uint64_t token,
                                  operation_slot_t **out_operation) {
  operation_slot_t *operation = NULL;
  pocketjs_net_operation_admission_t admission;
  portENTER_CRITICAL(&transport->lock);
  bool closing =
      atomic_load_explicit(&transport->closing, memory_order_acquire);
  if (closing) {
    admission = POCKETJS_NET_OPERATION_ADMISSION_CLOSING;
  } else if (!pocketjs_net_token_gate_can_accept(&transport->token_gate,
                                                 token)) {
    admission = POCKETJS_NET_OPERATION_ADMISSION_INVALID_TOKEN;
  } else if ((operation = find_free_operation(transport)) == NULL) {
    admission = POCKETJS_NET_OPERATION_ADMISSION_NO_CAPACITY;
  } else {
    memset(operation, 0, sizeof(*operation));
    admission = pocketjs_net_operation_admit(
        false, &transport->token_gate, &transport->terminal_credits,
        &operation->lifecycle, &operation->token, token);
    if (admission == POCKETJS_NET_OPERATION_ADMISSION_ACCEPTED) {
      operation->connection_slot = UINT32_MAX;
      operation->dns_context_slot = UINT32_MAX;
      operation->read_lease_slot = UINT32_MAX;
      atomic_init(&operation->cancel_requested, false);
    }
  }
  portEXIT_CRITICAL(&transport->lock);

  if (admission == POCKETJS_NET_OPERATION_ADMISSION_CLOSING) {
    return ESP_ERR_INVALID_STATE;
  }
  if (admission == POCKETJS_NET_OPERATION_ADMISSION_INVALID_TOKEN) {
    return ESP_ERR_INVALID_ARG;
  }
  if (admission != POCKETJS_NET_OPERATION_ADMISSION_ACCEPTED) {
    return ESP_ERR_NO_MEM;
  }
  *out_operation = operation;
  return ESP_OK;
}

static void queue_claimed_completion(pocketjs_net_esp_transport_t *transport,
                                     operation_slot_t *operation,
                                     pocketjs_net_esp_completion_t completion) {
  if (!pocketjs_net_terminal_credit_enqueue(&transport->terminal_credits) ||
      transport->completion_count >=
          POCKETJS_NET_ESP_TRANSPORT_COMPLETION_CAPACITY) {
    abort();
  }
  completion.operation_token = operation->token;
  completion.sequence = ++transport->next_sequence;
  transport->completion_ring[transport->completion_tail] = completion;
  transport->completion_tail = (transport->completion_tail + 1U) %
                               POCKETJS_NET_ESP_TRANSPORT_COMPLETION_CAPACITY;
  ++transport->completion_count;
}

static bool enqueue_completion(pocketjs_net_esp_transport_t *transport,
                               operation_slot_t *operation,
                               pocketjs_net_esp_completion_t completion) {
  portENTER_CRITICAL(&transport->lock);
  uint64_t now_us = (uint64_t)esp_timer_get_time();
  bool cancel_requested =
      atomic_load_explicit(&operation->cancel_requested, memory_order_acquire);
  bool claimed = pocketjs_net_operation_claim_native_terminal(
      &operation->lifecycle, cancel_requested,
      now_us >= operation->deadline_us);
  portEXIT_CRITICAL(&transport->lock);
  if (!claimed) {
    return false;
  }
  queue_claimed_completion(transport, operation, completion);
  return true;
}

static pocketjs_net_esp_error_category_t
error_category(pocketjs_net_esp_error_t error) {
  if (error >= POCKETJS_NET_ESP_ERROR_TLS_CERTIFICATE_INVALID) {
    return POCKETJS_NET_ESP_ERROR_CATEGORY_TLS;
  }
  if (error >= POCKETJS_NET_ESP_ERROR_CONNECTION_REFUSED) {
    return POCKETJS_NET_ESP_ERROR_CATEGORY_TRANSPORT;
  }
  if (error >= POCKETJS_NET_ESP_ERROR_DNS_NOT_FOUND) {
    return POCKETJS_NET_ESP_ERROR_CATEGORY_RESOLVER;
  }
  return POCKETJS_NET_ESP_ERROR_CATEGORY_RUNTIME;
}

static pocketjs_net_esp_completion_t
make_error_completion(pocketjs_net_esp_error_t code, int cause_code,
                      int tls_code, uint32_t certificate_flags,
                      bool temporary) {
  return (pocketjs_net_esp_completion_t){
      .type = POCKETJS_NET_ESP_TERMINAL_ERROR,
      .detail.error =
          {
              .code = code,
              .category = error_category(code),
              .cause_code = cause_code,
              .tls_code = tls_code,
              .tls_certificate_flags = certificate_flags,
              .temporary = temporary,
          },
  };
}

static bool enqueue_error(pocketjs_net_esp_transport_t *transport,
                          operation_slot_t *operation,
                          pocketjs_net_esp_error_t code, int cause_code,
                          int tls_code, uint32_t certificate_flags,
                          bool temporary) {
  return enqueue_completion(transport, operation,
                            make_error_completion(code, cause_code, tls_code,
                                                  certificate_flags,
                                                  temporary));
}

static pocketjs_net_esp_error_t map_errno(int code) {
  switch (code) {
  case ECONNREFUSED:
    return POCKETJS_NET_ESP_ERROR_CONNECTION_REFUSED;
  case ECONNRESET:
  case EPIPE:
    return POCKETJS_NET_ESP_ERROR_CONNECTION_RESET;
  case ENETUNREACH:
  case EHOSTUNREACH:
    return POCKETJS_NET_ESP_ERROR_NETWORK_UNREACHABLE;
  case ENOMEM:
  case ENOBUFS:
    return POCKETJS_NET_ESP_ERROR_RESOURCE_LIMIT;
  default:
    return POCKETJS_NET_ESP_ERROR_TRANSPORT_FAILED;
  }
}

static pocketjs_net_esp_error_t map_tls_error(int tls_code,
                                              uint32_t certificate_flags) {
  static const pocketjs_net_tls_error_symbols_t symbols = {
      .certificate_verify_failed = MBEDTLS_ERR_X509_CERT_VERIFY_FAILED,
      .bad_certificate = MBEDTLS_ERR_SSL_BAD_CERTIFICATE,
      .ca_chain_required = MBEDTLS_ERR_SSL_CA_CHAIN_REQUIRED,
      .bad_protocol_version = MBEDTLS_ERR_SSL_BAD_PROTOCOL_VERSION,
      .fatal_alert_message = MBEDTLS_ERR_SSL_FATAL_ALERT_MESSAGE,
      .allocation_failed = MBEDTLS_ERR_SSL_ALLOC_FAILED,
      .hostname_mismatch_flag = MBEDTLS_X509_BADCERT_CN_MISMATCH,
  };
  switch (
      pocketjs_net_classify_tls_error(tls_code, certificate_flags, &symbols)) {
  case POCKETJS_NET_TLS_ERROR_CLASS_HOSTNAME_MISMATCH:
    return POCKETJS_NET_ESP_ERROR_TLS_HOSTNAME_MISMATCH;
  case POCKETJS_NET_TLS_ERROR_CLASS_CERTIFICATE_INVALID:
    return POCKETJS_NET_ESP_ERROR_TLS_CERTIFICATE_INVALID;
  case POCKETJS_NET_TLS_ERROR_CLASS_VERSION_UNSUPPORTED:
    return POCKETJS_NET_ESP_ERROR_TLS_VERSION_UNSUPPORTED;
  case POCKETJS_NET_TLS_ERROR_CLASS_ALERT:
    return POCKETJS_NET_ESP_ERROR_TLS_ALERT;
  case POCKETJS_NET_TLS_ERROR_CLASS_RESOURCE_LIMIT:
    return POCKETJS_NET_ESP_ERROR_RESOURCE_LIMIT;
  case POCKETJS_NET_TLS_ERROR_CLASS_HANDSHAKE_FAILED:
  default:
    return POCKETJS_NET_ESP_ERROR_TLS_HANDSHAKE_FAILED;
  }
}

pocketjs_net_esp_error_t
pocketjs_net_esp_transport_map_tls_error_for_test(int tls_code,
                                                  uint32_t certificate_flags) {
  return map_tls_error(tls_code, certificate_flags);
}

static void read_tls_error(esp_tls_t *tls, int *cause, int *system_error,
                           int *tls_code, uint32_t *certificate_flags) {
  esp_tls_error_handle_t error_handle = NULL;
  *cause = 0;
  *system_error = 0;
  *tls_code = 0;
  *certificate_flags = 0U;
  if (esp_tls_get_error_handle(tls, &error_handle) == ESP_OK &&
      error_handle != NULL) {
    int flags = 0;
    (void)esp_tls_get_and_clear_error_type(
        error_handle, ESP_TLS_ERR_TYPE_SYSTEM, system_error);
    (void)esp_tls_get_and_clear_error_type(error_handle, ESP_TLS_ERR_TYPE_ESP,
                                           cause);
    (void)esp_tls_get_and_clear_error_type(error_handle,
                                           ESP_TLS_ERR_TYPE_MBEDTLS, tls_code);
    (void)esp_tls_get_and_clear_error_type(
        error_handle, ESP_TLS_ERR_TYPE_MBEDTLS_CERT_FLAGS, &flags);
    *certificate_flags = (uint32_t)flags;
    if (*system_error != 0) {
      *cause = *system_error;
    }
  }
  mbedtls_ssl_context *ssl =
      (mbedtls_ssl_context *)esp_tls_get_ssl_context(tls);
  if (ssl != NULL) {
    *certificate_flags = pocketjs_net_select_tls_certificate_flags(
        *certificate_flags, mbedtls_ssl_get_verify_result(ssl));
  }
}

static size_t
copy_dns_candidates(const ip_addr_t *addresses,
                    uint32_t out[POCKETJS_NET_ESP_TRANSPORT_MAX_DNS_CANDIDATES],
                    bool *out_saturated) {
  size_t count = 0U;
  size_t populated_slots = 0U;
  *out_saturated = false;
  if (addresses == NULL) {
    return 0U;
  }
  for (size_t index = 0; index < DNS_MAX_HOST_IP &&
                         count < POCKETJS_NET_ESP_TRANSPORT_MAX_DNS_CANDIDATES;
       ++index) {
    if (ip_addr_isany(&addresses[index])) {
      continue;
    }
    ++populated_slots;
#if LWIP_IPV4 && LWIP_IPV6
    if (!IP_IS_V4(&addresses[index])) {
      continue;
    }
#endif
    uint32_t address = ip_2_ip4(&addresses[index])->addr;
    bool duplicate = false;
    for (size_t previous = 0; previous < count; ++previous) {
      duplicate = duplicate || out[previous] == address;
    }
    if (!duplicate) {
      out[count++] = address;
    }
  }
  *out_saturated = pocketjs_net_dns_candidate_prefix_saturated(populated_slots,
                                                               DNS_MAX_HOST_IP);
  return count;
}

static void pocketjs_dns_found(const char *name, const ip_addr_t *addresses,
                               void *callback_arg) {
  dns_callback_ticket_t *ticket = callback_arg;
  if (ticket == NULL || ticket->context == NULL) {
    return;
  }
  dns_context_t *context = ticket->context;
  const uint64_t callback_generation = ticket->generation;
  pocketjs_net_esp_transport_t *transport = context->owner;

  portENTER_CRITICAL(&transport->lock);
  const bool current =
      pocketjs_net_dns_callback_ticket_matches(
          ticket->active, context->generation, callback_generation) &&
      context->state == DNS_CONTEXT_LOOKUP_PENDING;
  portEXIT_CRITICAL(&transport->lock);
  if (!current) {
    return;
  }

  ip_addr_t cached_addresses[DNS_MAX_HOST_IP];
  memset(cached_addresses, 0, sizeof(cached_addresses));
  /* IDF 6.0.2 passes the DNS table's whole fixed address array, but entry
   * reuse resets only ipaddr_cnt and can leave stale addresses in its tail.
   * During the success callback the completed entry is already cacheable, so
   * copy it through dns_lookup into a zeroed caller array. dns_lookup copies
   * only the current entry's ipaddr_cnt prefix. */
  err_t cache_result =
      addresses != NULL && name != NULL && strcmp(name, context->hostname) == 0
          ? dns_gethostbyname_addrtype(name, cached_addresses, NULL, NULL,
                                       LWIP_DNS_ADDRTYPE_IPV4)
          : ERR_VAL;
  uint32_t candidates[POCKETJS_NET_ESP_TRANSPORT_MAX_DNS_CANDIDATES] = {0};
  bool saturated = false;
  size_t count =
      cache_result == ERR_OK
          ? copy_dns_candidates(cached_addresses, candidates, &saturated)
          : 0U;

  portENTER_CRITICAL(&transport->lock);
  if (pocketjs_net_dns_callback_ticket_matches(
          ticket->active, context->generation, callback_generation) &&
      context->state == DNS_CONTEXT_LOOKUP_PENDING) {
    if (atomic_load_explicit(&context->cancelled, memory_order_acquire)) {
      context->state = DNS_CONTEXT_FREE;
    } else {
      memcpy(context->candidates, candidates, sizeof(candidates));
      context->candidate_count = saturated ? 0U : count;
      context->result =
          saturated ? ERR_BUF : (count == 0U ? cache_result : ERR_OK);
      if (context->result == ERR_OK && count == 0U) {
        context->result = ERR_VAL;
      }
      context->state = DNS_CONTEXT_RESULT_READY;
    }
    ticket->active = false;
  }
  portEXIT_CRITICAL(&transport->lock);

  if (transport->wake != NULL) {
    transport->wake(transport->wake_context);
  }
}

static void submit_dns_in_tcpip_thread(void *callback_arg) {
  dns_callback_ticket_t *ticket = callback_arg;
  if (ticket == NULL || ticket->context == NULL) {
    return;
  }
  dns_context_t *context = ticket->context;
  const uint64_t callback_generation = ticket->generation;
  pocketjs_net_esp_transport_t *transport = context->owner;

  portENTER_CRITICAL(&transport->lock);
  bool cancelled =
      atomic_load_explicit(&context->cancelled, memory_order_acquire);
  if (!pocketjs_net_dns_callback_ticket_matches(
          ticket->active, context->generation, callback_generation) ||
      context->state != DNS_CONTEXT_SUBMIT_QUEUED) {
    portEXIT_CRITICAL(&transport->lock);
    return;
  }
  if (cancelled) {
    context->state = DNS_CONTEXT_FREE;
    ticket->active = false;
    portEXIT_CRITICAL(&transport->lock);
    if (transport->wake != NULL) {
      transport->wake(transport->wake_context);
    }
    return;
  }
  context->state = DNS_CONTEXT_LOOKUP_PENDING;
  portEXIT_CRITICAL(&transport->lock);

  ip_addr_t addresses[DNS_MAX_HOST_IP];
  memset(addresses, 0, sizeof(addresses));
  err_t result = dns_gethostbyname_addrtype(context->hostname, addresses,
                                            pocketjs_dns_found, ticket,
                                            LWIP_DNS_ADDRTYPE_IPV4);
  if (result == ERR_INPROGRESS) {
    return;
  }

  uint32_t candidates[POCKETJS_NET_ESP_TRANSPORT_MAX_DNS_CANDIDATES] = {0};
  bool saturated = false;
  size_t count = result == ERR_OK
                     ? copy_dns_candidates(addresses, candidates, &saturated)
                     : 0U;
  portENTER_CRITICAL(&transport->lock);
  if (!pocketjs_net_dns_callback_ticket_matches(
          ticket->active, context->generation, callback_generation) ||
      context->state != DNS_CONTEXT_LOOKUP_PENDING) {
    portEXIT_CRITICAL(&transport->lock);
    return;
  }
  if (atomic_load_explicit(&context->cancelled, memory_order_acquire)) {
    context->state = DNS_CONTEXT_FREE;
  } else {
    memcpy(context->candidates, candidates, sizeof(candidates));
    context->candidate_count = saturated ? 0U : count;
    context->result =
        saturated ? ERR_BUF
                  : (result == ERR_OK && count == 0U ? ERR_VAL : result);
    context->state = DNS_CONTEXT_RESULT_READY;
  }
  ticket->active = false;
  portEXIT_CRITICAL(&transport->lock);
  if (transport->wake != NULL) {
    transport->wake(transport->wake_context);
  }
}

static bool validate_pinned_ca(const uint8_t *pem, size_t bytes) {
  if (pem == NULL || bytes == 0U ||
      bytes > POCKETJS_NET_ESP_TRANSPORT_MAX_PINNED_CA_PEM_BYTES ||
      memchr(pem, '\0', bytes) != NULL) {
    return false;
  }
  uint8_t *snapshot = malloc(bytes + 1U);
  if (snapshot == NULL) {
    return false;
  }
  memcpy(snapshot, pem, bytes);
  snapshot[bytes] = '\0';
  mbedtls_x509_crt certificate;
  mbedtls_x509_crt_init(&certificate);
  int result = mbedtls_x509_crt_parse(&certificate, snapshot, bytes + 1U);
  bool valid = result == 0 && certificate.next == NULL &&
               mbedtls_x509_crt_get_ca_istrue(&certificate) == 1;
  mbedtls_x509_crt_free(&certificate);
  free(snapshot);
  return valid;
}

static bool
tls_config_shape_valid(const pocketjs_net_esp_transport_config_t *config) {
  switch (config->tls_trust_source) {
  case POCKETJS_NET_ESP_TLS_TRUST_DISABLED:
    return config->host_pinned_ca_pem == NULL &&
           config->host_pinned_ca_pem_bytes == 0U &&
           config->wall_clock_trusted == NULL;
  case POCKETJS_NET_ESP_TLS_TRUST_CERTIFICATE_BUNDLE:
    return POCKETJS_NET_ESP_TRANSPORT_HAS_BUNDLE &&
           config->host_pinned_ca_pem == NULL &&
           config->host_pinned_ca_pem_bytes == 0U &&
           config->wall_clock_trusted != NULL;
  case POCKETJS_NET_ESP_TLS_TRUST_HOST_PINNED_CA:
    return config->wall_clock_trusted != NULL &&
           config->host_pinned_ca_pem != NULL &&
           config->host_pinned_ca_pem_bytes > 0U &&
           config->host_pinned_ca_pem_bytes <=
               POCKETJS_NET_ESP_TRANSPORT_MAX_PINNED_CA_PEM_BYTES &&
           memchr(config->host_pinned_ca_pem, '\0',
                  config->host_pinned_ca_pem_bytes) == NULL;
  default:
    return false;
  }
}

static void tcpip_destroy_barrier(void *context) { (void)context; }

static esp_err_t
prepare_poisoned_dns_teardown(pocketjs_net_esp_transport_t *transport) {
  portENTER_CRITICAL(&transport->lock);
  for (size_t index = 0; index < POCKETJS_NET_ESP_TRANSPORT_MAX_DNS_CONTEXTS;
       ++index) {
    dns_context_t *context = &transport->dns_contexts[index];
    atomic_store_explicit(&context->cancelled, true, memory_order_release);
    if (context->state == DNS_CONTEXT_RESULT_READY) {
      context->state = DNS_CONTEXT_FREE;
    }
  }
  portEXIT_CRITICAL(&transport->lock);

  /* A queued submission observes cancelled and frees its context. A lookup
   * already owned by lwIP must run its late callback before the backing context
   * can be released; the barrier makes both observations stable. */
  if (tcpip_callback_wait(tcpip_destroy_barrier, NULL) != ERR_OK) {
    return ESP_FAIL;
  }

  bool callbacks_drained = true;
  portENTER_CRITICAL(&transport->lock);
  for (size_t index = 0;
       callbacks_drained && index < POCKETJS_NET_ESP_TRANSPORT_MAX_DNS_CONTEXTS;
       ++index) {
    callbacks_drained =
        transport->dns_contexts[index].state == DNS_CONTEXT_FREE &&
        !transport->dns_contexts[index].callback_ticket.active;
  }
  portEXIT_CRITICAL(&transport->lock);
  return callbacks_drained ? ESP_OK : ESP_ERR_NOT_FINISHED;
}

static void release_transport_storage(pocketjs_net_esp_transport_t *transport) {
  for (size_t index = 0; index < POCKETJS_NET_ESP_TRANSPORT_MAX_DNS_CONTEXTS;
       ++index) {
    tcpip_callbackmsg_delete(transport->dns_contexts[index].submit_message);
  }
  memset(transport->pinned_ca, 0, sizeof(transport->pinned_ca));
  free(transport);
}

const pocketjs_net_esp_transport_descriptor_t *
pocketjs_net_esp_transport_descriptor(void) {
  return &s_descriptor;
}

esp_err_t pocketjs_net_esp_transport_validate_config(
    const pocketjs_net_esp_transport_config_t *config) {
  if (config == NULL || !tls_config_shape_valid(config)) {
    return ESP_ERR_INVALID_ARG;
  }
  if (config->tls_trust_source == POCKETJS_NET_ESP_TLS_TRUST_HOST_PINNED_CA &&
      !validate_pinned_ca(config->host_pinned_ca_pem,
                          config->host_pinned_ca_pem_bytes)) {
    return ESP_ERR_INVALID_ARG;
  }
  return ESP_OK;
}

esp_err_t pocketjs_net_esp_transport_create(
    const pocketjs_net_esp_transport_config_t *config,
    pocketjs_net_esp_transport_t **out_transport) {
  if (out_transport == NULL || *out_transport != NULL ||
      pocketjs_net_esp_transport_validate_config(config) != ESP_OK) {
    return ESP_ERR_INVALID_ARG;
  }

  pocketjs_net_esp_transport_t *transport = calloc(1U, sizeof(*transport));
  if (transport == NULL) {
    return ESP_ERR_NO_MEM;
  }
  portMUX_INITIALIZE(&transport->lock);
  atomic_init(&transport->closing, false);
  transport->owner_task = xTaskGetCurrentTaskHandle();
  transport->terminal_credits.capacity =
      POCKETJS_NET_ESP_TRANSPORT_COMPLETION_CAPACITY;
  transport->wake = config->wake;
  transport->wake_context = config->wake_context;
  transport->tls_trust_source = config->tls_trust_source;
  transport->wall_clock_trusted = config->wall_clock_trusted;
  transport->wall_clock_context = config->wall_clock_context;
  if (config->tls_trust_source == POCKETJS_NET_ESP_TLS_TRUST_HOST_PINNED_CA) {
    memcpy(transport->pinned_ca, config->host_pinned_ca_pem,
           config->host_pinned_ca_pem_bytes);
    transport->pinned_ca[config->host_pinned_ca_pem_bytes] = '\0';
    transport->pinned_ca_bytes = config->host_pinned_ca_pem_bytes;
  }
  for (size_t index = 0; index < POCKETJS_NET_ESP_TRANSPORT_MAX_CONNECTIONS;
       ++index) {
    transport->connections[index].fd = -1;
  }
  for (size_t index = 0; index < POCKETJS_NET_ESP_TRANSPORT_MAX_DNS_CONTEXTS;
       ++index) {
    dns_context_t *context = &transport->dns_contexts[index];
    context->owner = transport;
    context->callback_ticket.context = context;
    atomic_init(&context->cancelled, false);
    context->submit_message = tcpip_callbackmsg_new(submit_dns_in_tcpip_thread,
                                                    &context->callback_ticket);
    if (context->submit_message == NULL) {
      for (size_t previous = 0; previous < index; ++previous) {
        tcpip_callbackmsg_delete(
            transport->dns_contexts[previous].submit_message);
      }
      free(transport);
      return ESP_ERR_NO_MEM;
    }
  }

  *out_transport = transport;
  return ESP_OK;
}

void pocketjs_net_esp_transport_begin_shutdown(
    pocketjs_net_esp_transport_t *transport) {
  if (transport == NULL) {
    return;
  }
  portENTER_CRITICAL(&transport->lock);
  atomic_store_explicit(&transport->closing, true, memory_order_release);
  for (size_t index = 0; index < POCKETJS_NET_ESP_TRANSPORT_MAX_OPERATIONS;
       ++index) {
    operation_slot_t *operation = &transport->operations[index];
    if (operation->lifecycle == POCKETJS_NET_OPERATION_ACTIVE &&
        pocketjs_net_operation_shutdown_requests_cancel(operation->kind)) {
      atomic_store_explicit(&operation->cancel_requested, true,
                            memory_order_release);
    }
  }
  portEXIT_CRITICAL(&transport->lock);
  if (transport->wake != NULL) {
    transport->wake(transport->wake_context);
  }
}

bool pocketjs_net_esp_transport_is_quiescent(
    const pocketjs_net_esp_transport_t *transport) {
  if (transport == NULL) {
    return true;
  }
  if (!owner_task(transport)) {
    return false;
  }
  pocketjs_net_esp_transport_t *mutable_transport =
      (pocketjs_net_esp_transport_t *)transport;
  bool quiescent = true;
  portENTER_CRITICAL(&mutable_transport->lock);
  quiescent = transport->completion_count == 0U &&
              transport->terminal_credits.reserved == 0U &&
              transport->terminal_credits.queued == 0U &&
              transport->terminal_credits.delivering == 0U;
  for (size_t index = 0;
       quiescent && index < POCKETJS_NET_ESP_TRANSPORT_MAX_OPERATIONS;
       ++index) {
    quiescent =
        transport->operations[index].lifecycle == POCKETJS_NET_OPERATION_FREE;
  }
  for (size_t index = 0;
       quiescent && index < POCKETJS_NET_ESP_TRANSPORT_MAX_DNS_CONTEXTS;
       ++index) {
    quiescent = transport->dns_contexts[index].state == DNS_CONTEXT_FREE &&
                !transport->dns_contexts[index].callback_ticket.active;
  }
  for (size_t index = 0;
       quiescent && index < POCKETJS_NET_ESP_TRANSPORT_MAX_CONNECTIONS;
       ++index) {
    quiescent = transport->connections[index].state == CONNECTION_FREE;
  }
  for (size_t index = 0;
       quiescent && index < POCKETJS_NET_ESP_TRANSPORT_READ_LEASES; ++index) {
    quiescent = !transport->read_leases[index].in_use;
  }
  portEXIT_CRITICAL(&mutable_transport->lock);
  return quiescent;
}

esp_err_t
pocketjs_net_esp_transport_destroy(pocketjs_net_esp_transport_t *transport) {
  if (transport == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  if (!owner_task(transport) ||
      !pocketjs_net_esp_transport_is_quiescent(transport)) {
    return ESP_ERR_INVALID_STATE;
  }
  /* A raw DNS callback can make its context quiescent immediately before it
   * returns. This barrier proves that callback and every prior submission has
   * left the tcpip thread before static callback messages are released. */
  if (tcpip_callback_wait(tcpip_destroy_barrier, NULL) != ERR_OK) {
    return ESP_FAIL;
  }
  release_transport_storage(transport);
  return ESP_OK;
}

esp_err_t pocketjs_net_esp_transport_destroy_poisoned(
    pocketjs_net_esp_transport_t *transport) {
  if (!owner_task(transport) ||
      !atomic_load_explicit(&transport->closing, memory_order_acquire)) {
    return ESP_ERR_INVALID_STATE;
  }
  esp_err_t dns_result = prepare_poisoned_dns_teardown(transport);
  if (dns_result != ESP_OK) {
    return dns_result;
  }

  /* The protocol Core has abandoned this dedicated transport. With callbacks
   * drained and external callers joined, only owner-task native storage
   * remains. No completion or lease is observable after this call succeeds. */
  for (size_t index = 0; index < POCKETJS_NET_ESP_TRANSPORT_MAX_CONNECTIONS;
       ++index) {
    connection_native_close(&transport->connections[index]);
  }
  for (size_t index = 0; index < POCKETJS_NET_ESP_TRANSPORT_READ_LEASES;
       ++index) {
    release_read_lease_slot(&transport->read_leases[index]);
  }
  memset(transport->operations, 0, sizeof(transport->operations));
  memset(transport->completion_ring, 0, sizeof(transport->completion_ring));
  transport->completion_head = 0U;
  transport->completion_tail = 0U;
  transport->completion_count = 0U;
  transport->terminal_credits = (pocketjs_net_terminal_credits_t){
      .capacity = POCKETJS_NET_ESP_TRANSPORT_COMPLETION_CAPACITY,
  };
  release_transport_storage(transport);
  return ESP_OK;
}

esp_err_t pocketjs_net_esp_transport_start_resolve(
    pocketjs_net_esp_transport_t *transport, uint64_t token,
    const pocketjs_net_esp_resolve_request_t *request) {
  if (!owner_task(transport) || request == NULL || request->deadline_us == 0U ||
      !hostname_is_canonical(request->hostname)) {
    return ESP_ERR_INVALID_ARG;
  }

  struct in_addr literal = {0};
  bool is_literal = inet_pton(AF_INET, request->hostname, &literal) == 1;
  size_t context_index = 0U;
  dns_context_t *context = NULL;
  if (!is_literal) {
    context = reserve_dns_context(transport, &context_index);
    if (context == NULL) {
      return ESP_ERR_NO_MEM;
    }
  }

  operation_slot_t *operation = NULL;
  esp_err_t accept_result = accept_operation(transport, token, &operation);
  if (accept_result != ESP_OK) {
    if (context != NULL) {
      portENTER_CRITICAL(&transport->lock);
      context->state = DNS_CONTEXT_FREE;
      context->callback_ticket.active = false;
      portEXIT_CRITICAL(&transport->lock);
    }
    return accept_result;
  }
  operation->kind = POCKETJS_NET_TRANSPORT_OPERATION_RESOLVE;
  operation->deadline_us = request->deadline_us;
  memcpy(operation->hostname, request->hostname,
         strlen(request->hostname) + 1U);

  if (is_literal) {
    operation->ipv4_be = literal.s_addr;
    operation->phase = OP_PHASE_INITIAL;
    return ESP_OK;
  }

  context->token = token;
  atomic_store_explicit(&context->cancelled, false, memory_order_release);
  memcpy(context->hostname, request->hostname, strlen(request->hostname) + 1U);
  memset(context->candidates, 0, sizeof(context->candidates));
  context->candidate_count = 0U;
  context->result = ERR_INPROGRESS;
  operation->dns_context_slot = (uint32_t)context_index;
  operation->phase = OP_PHASE_DNS_WAIT;

  err_t post_result = tcpip_callbackmsg_trycallback(context->submit_message);
  if (post_result != ERR_OK) {
    portENTER_CRITICAL(&transport->lock);
    if (pocketjs_net_dns_callback_ticket_matches(
            context->callback_ticket.active, context->generation,
            context->callback_ticket.generation) &&
        context->state == DNS_CONTEXT_SUBMIT_QUEUED) {
      context->result = post_result;
      context->state = DNS_CONTEXT_RESULT_READY;
      context->callback_ticket.active = false;
    }
    portEXIT_CRITICAL(&transport->lock);
  }
  return ESP_OK;
}

esp_err_t pocketjs_net_esp_transport_start_connect(
    pocketjs_net_esp_transport_t *transport, uint64_t token,
    const pocketjs_net_esp_connect_request_t *request) {
  if (!owner_task(transport) || request == NULL || request->ipv4_be == 0U ||
      request->port == 0U || request->deadline_us == 0U ||
      (request->tls && !hostname_is_canonical(request->original_hostname))) {
    return ESP_ERR_INVALID_ARG;
  }
  if (request->tls &&
      transport->tls_trust_source == POCKETJS_NET_ESP_TLS_TRUST_DISABLED) {
    return ESP_ERR_NOT_SUPPORTED;
  }

  size_t connection_index = 0U;
  connection_slot_t *connection =
      reserve_connection(transport, &connection_index);
  if (connection == NULL) {
    return ESP_ERR_NO_MEM;
  }
  operation_slot_t *operation = NULL;
  esp_err_t accept_result = accept_operation(transport, token, &operation);
  if (accept_result != ESP_OK) {
    connection->state = CONNECTION_FREE;
    return accept_result;
  }

  operation->kind = POCKETJS_NET_TRANSPORT_OPERATION_CONNECT;
  operation->phase = OP_PHASE_INITIAL;
  operation->deadline_us = request->deadline_us;
  operation->connection_slot = (uint32_t)connection_index;
  operation->ipv4_be = request->ipv4_be;
  operation->port = request->port;
  operation->secure = request->tls;
  if (request->tls) {
    memcpy(operation->hostname, request->original_hostname,
           strlen(request->original_hostname) + 1U);
  }
  connection->busy_token = token;
  connection->secure = request->tls;
  connection->ipv4_be = request->ipv4_be;
  return ESP_OK;
}

static esp_err_t
validate_open_connection(pocketjs_net_esp_transport_t *transport,
                         pocketjs_net_esp_connection_t handle,
                         connection_slot_t **out_connection,
                         size_t *out_index) {
  if (handle.slot >= POCKETJS_NET_ESP_TRANSPORT_MAX_CONNECTIONS) {
    return ESP_ERR_INVALID_ARG;
  }
  connection_slot_t *connection = &transport->connections[handle.slot];
  if (!connection_matches(connection, handle)) {
    return ESP_ERR_NOT_FOUND;
  }
  if (connection->busy_token != 0U) {
    return ESP_ERR_INVALID_STATE;
  }
  *out_connection = connection;
  *out_index = handle.slot;
  return ESP_OK;
}

esp_err_t pocketjs_net_esp_transport_start_read(
    pocketjs_net_esp_transport_t *transport, uint64_t token,
    const pocketjs_net_esp_read_request_t *request) {
  if (!owner_task(transport) || request == NULL || request->deadline_us == 0U ||
      request->maximum_bytes == 0U ||
      request->maximum_bytes > POCKETJS_NET_ESP_TRANSPORT_READ_LEASE_BYTES) {
    return ESP_ERR_INVALID_ARG;
  }
  connection_slot_t *connection = NULL;
  size_t connection_index = 0U;
  esp_err_t result = validate_open_connection(transport, request->connection,
                                              &connection, &connection_index);
  if (result != ESP_OK) {
    return result;
  }
  size_t lease_index = 0U;
  read_lease_slot_t *lease = reserve_read_lease(transport, &lease_index);
  if (lease == NULL) {
    return ESP_ERR_NO_MEM;
  }
  operation_slot_t *operation = NULL;
  esp_err_t accept_result = accept_operation(transport, token, &operation);
  if (accept_result != ESP_OK) {
    release_read_lease_slot(lease);
    return accept_result;
  }
  operation->kind = POCKETJS_NET_TRANSPORT_OPERATION_READ;
  operation->phase = OP_PHASE_IO_WAIT;
  operation->deadline_us = request->deadline_us;
  operation->connection_slot = (uint32_t)connection_index;
  operation->read_lease_slot = (uint32_t)lease_index;
  operation->write_length = request->maximum_bytes;
  connection->busy_token = token;
  return ESP_OK;
}

esp_err_t pocketjs_net_esp_transport_start_write(
    pocketjs_net_esp_transport_t *transport, uint64_t token,
    const pocketjs_net_esp_write_request_t *request) {
  if (!owner_task(transport) || request == NULL || request->deadline_us == 0U ||
      request->bytes == NULL || request->length == 0U ||
      request->length > POCKETJS_NET_ESP_TRANSPORT_MAX_WRITE_BYTES) {
    return ESP_ERR_INVALID_ARG;
  }
  connection_slot_t *connection = NULL;
  size_t connection_index = 0U;
  esp_err_t result = validate_open_connection(transport, request->connection,
                                              &connection, &connection_index);
  if (result != ESP_OK) {
    return result;
  }
  operation_slot_t *operation = NULL;
  esp_err_t accept_result = accept_operation(transport, token, &operation);
  if (accept_result != ESP_OK) {
    return accept_result;
  }
  operation->kind = POCKETJS_NET_TRANSPORT_OPERATION_WRITE;
  operation->phase = OP_PHASE_IO_WAIT;
  operation->deadline_us = request->deadline_us;
  operation->connection_slot = (uint32_t)connection_index;
  operation->write_length = request->length;
  memcpy(operation->write_bytes, request->bytes, request->length);
  connection->busy_token = token;
  return ESP_OK;
}

esp_err_t pocketjs_net_esp_transport_start_close(
    pocketjs_net_esp_transport_t *transport, uint64_t token,
    const pocketjs_net_esp_close_request_t *request) {
  if (!owner_task(transport) || request == NULL || request->deadline_us == 0U) {
    return ESP_ERR_INVALID_ARG;
  }
  connection_slot_t *connection = NULL;
  size_t connection_index = 0U;
  esp_err_t result = validate_open_connection(transport, request->connection,
                                              &connection, &connection_index);
  if (result != ESP_OK) {
    return result;
  }
  operation_slot_t *operation = NULL;
  esp_err_t accept_result = accept_operation(transport, token, &operation);
  if (accept_result != ESP_OK) {
    return accept_result;
  }
  operation->kind = POCKETJS_NET_TRANSPORT_OPERATION_CLOSE;
  operation->phase = OP_PHASE_INITIAL;
  operation->deadline_us = request->deadline_us;
  operation->connection_slot = (uint32_t)connection_index;
  connection->busy_token = token;
  return ESP_OK;
}

esp_err_t
pocketjs_net_esp_transport_cancel(pocketjs_net_esp_transport_t *transport,
                                  uint64_t token) {
  if (transport == NULL || token == 0U) {
    return ESP_ERR_INVALID_ARG;
  }
  portENTER_CRITICAL(&transport->lock);
  operation_slot_t *operation = find_operation(transport, token);
  if (operation == NULL ||
      operation->lifecycle != POCKETJS_NET_OPERATION_ACTIVE) {
    portEXIT_CRITICAL(&transport->lock);
    return ESP_ERR_NOT_FOUND;
  }
  atomic_store_explicit(&operation->cancel_requested, true,
                        memory_order_release);
  portEXIT_CRITICAL(&transport->lock);
  if (transport->wake != NULL) {
    transport->wake(transport->wake_context);
  }
  return ESP_OK;
}

static void cancel_dns_context(pocketjs_net_esp_transport_t *transport,
                               operation_slot_t *operation) {
  if (operation->dns_context_slot >=
      POCKETJS_NET_ESP_TRANSPORT_MAX_DNS_CONTEXTS) {
    return;
  }
  dns_context_t *context =
      &transport->dns_contexts[operation->dns_context_slot];
  portENTER_CRITICAL(&transport->lock);
  if (context->token == operation->token &&
      context->state != DNS_CONTEXT_FREE) {
    atomic_store_explicit(&context->cancelled, true, memory_order_release);
    if (context->state == DNS_CONTEXT_RESULT_READY) {
      context->state = DNS_CONTEXT_FREE;
    }
  }
  portEXIT_CRITICAL(&transport->lock);
}

static void
operation_release_busy_connection(pocketjs_net_esp_transport_t *transport,
                                  operation_slot_t *operation) {
  if (operation->connection_slot >=
      POCKETJS_NET_ESP_TRANSPORT_MAX_CONNECTIONS) {
    return;
  }
  connection_slot_t *connection =
      &transport->connections[operation->connection_slot];
  if (connection->busy_token == operation->token) {
    connection->busy_token = 0U;
  }
}

static void operation_cleanup_for_error(pocketjs_net_esp_transport_t *transport,
                                        operation_slot_t *operation,
                                        bool close_connection) {
  cancel_dns_context(transport, operation);
  if (operation->read_lease_slot < POCKETJS_NET_ESP_TRANSPORT_READ_LEASES) {
    release_read_lease_slot(
        &transport->read_leases[operation->read_lease_slot]);
    operation->read_lease_slot = UINT32_MAX;
  }
  if (operation->connection_slot < POCKETJS_NET_ESP_TRANSPORT_MAX_CONNECTIONS) {
    connection_slot_t *connection =
        &transport->connections[operation->connection_slot];
    if (close_connection) {
      connection_native_close(connection);
    } else {
      operation_release_busy_connection(transport, operation);
    }
  }
}

static void
finish_cancelled_or_timed_out(pocketjs_net_esp_transport_t *transport,
                              operation_slot_t *operation,
                              pocketjs_net_esp_error_t error) {
  portENTER_CRITICAL(&transport->lock);
  bool cancel_requested =
      atomic_load_explicit(&operation->cancel_requested, memory_order_acquire);
  pocketjs_net_operation_terminal_reason_t reason =
      pocketjs_net_operation_claim_cancel_or_timeout(
          &operation->lifecycle, cancel_requested,
          error == POCKETJS_NET_ESP_ERROR_TIMED_OUT);
  portEXIT_CRITICAL(&transport->lock);
  if (reason == POCKETJS_NET_OPERATION_TERMINAL_NONE) {
    abort();
  }

  pocketjs_net_esp_error_t terminal_error =
      reason == POCKETJS_NET_OPERATION_TERMINAL_ABORTED
          ? POCKETJS_NET_ESP_ERROR_ABORTED
          : POCKETJS_NET_ESP_ERROR_TIMED_OUT;
  bool close_connection =
      pocketjs_net_operation_cancel_closes_connection(operation->kind);
  operation_cleanup_for_error(transport, operation, close_connection);
  queue_claimed_completion(
      transport, operation,
      make_error_completion(terminal_error, 0, 0, 0U, false));
}

static void pump_resolve(pocketjs_net_esp_transport_t *transport,
                         operation_slot_t *operation) {
  pocketjs_net_esp_completion_t completion = {
      .type = POCKETJS_NET_ESP_TERMINAL_RESOLVED,
  };
  if (operation->dns_context_slot == UINT32_MAX) {
    completion.detail.resolved.ipv4_be[0] = operation->ipv4_be;
    completion.detail.resolved.candidate_count = 1U;
    enqueue_completion(transport, operation, completion);
    return;
  }

  dns_context_t *context =
      &transport->dns_contexts[operation->dns_context_slot];
  portENTER_CRITICAL(&transport->lock);
  if (context->state != DNS_CONTEXT_RESULT_READY ||
      context->token != operation->token) {
    portEXIT_CRITICAL(&transport->lock);
    return;
  }
  err_t result = context->result;
  size_t count = context->candidate_count;
  memcpy(completion.detail.resolved.ipv4_be, context->candidates,
         sizeof(context->candidates));
  context->state = DNS_CONTEXT_FREE;
  portEXIT_CRITICAL(&transport->lock);

  if (result == ERR_OK && count > 0U) {
    completion.detail.resolved.candidate_count = count;
    enqueue_completion(transport, operation, completion);
  } else {
    pocketjs_net_esp_error_t error = result == ERR_MEM || result == ERR_BUF
                                         ? POCKETJS_NET_ESP_ERROR_RESOURCE_LIMIT
                                         : POCKETJS_NET_ESP_ERROR_DNS_NOT_FOUND;
    enqueue_error(transport, operation, error, (int)result, 0, 0U,
                  result == ERR_TIMEOUT);
  }
}

static bool make_tls_config(pocketjs_net_esp_transport_t *transport,
                            operation_slot_t *operation,
                            esp_tls_cfg_t *configuration) {
  if (transport->wall_clock_trusted == NULL ||
      !transport->wall_clock_trusted(transport->wall_clock_context)) {
    return false;
  }
  memset(configuration, 0, sizeof(*configuration));
  /* The adapter has already connected an O_NONBLOCK socket and enters
   * ESP-TLS at ESP_TLS_CONNECTING. false skips ESP-TLS's internal select;
   * it does not change the already-configured socket flags. */
  configuration->non_block = false;
  configuration->timeout_ms = POCKETJS_NET_ESP_TRANSPORT_TLS_STEP_TIMEOUT_MS;
  configuration->common_name = operation->hostname;
  configuration->skip_common_name = false;
  configuration->addr_family = ESP_TLS_AF_INET;
  configuration->tls_version = ESP_TLS_VER_TLS_1_2;
  if (transport->tls_trust_source ==
      POCKETJS_NET_ESP_TLS_TRUST_CERTIFICATE_BUNDLE) {
#if POCKETJS_NET_ESP_TRANSPORT_HAS_BUNDLE
    configuration->crt_bundle_attach = esp_crt_bundle_attach;
#else
    return false;
#endif
  } else if (transport->tls_trust_source ==
             POCKETJS_NET_ESP_TLS_TRUST_HOST_PINNED_CA) {
    configuration->cacert_buf = transport->pinned_ca;
    configuration->cacert_bytes = (unsigned int)transport->pinned_ca_bytes + 1U;
  } else {
    return false;
  }
  return true;
}

static void finish_connected(pocketjs_net_esp_transport_t *transport,
                             operation_slot_t *operation,
                             connection_slot_t *connection) {
  connection->state = CONNECTION_OPEN;
  pocketjs_net_esp_completion_t completion = {
      .type = POCKETJS_NET_ESP_TERMINAL_CONNECTED,
      .detail.connected =
          {
              .connection = connection_handle(operation->connection_slot,
                                              connection->generation),
              .ipv4_be = connection->ipv4_be,
              .tls = connection->secure,
          },
  };
  if (enqueue_completion(transport, operation, completion)) {
    connection->busy_token = 0U;
  }
}

typedef enum socket_connect_progress {
  SOCKET_CONNECT_FAILED = 0,
  SOCKET_CONNECT_PENDING,
  SOCKET_CONNECT_READY,
} socket_connect_progress_t;

static socket_connect_progress_t
start_socket_connect(pocketjs_net_esp_transport_t *transport,
                     operation_slot_t *operation,
                     connection_slot_t *connection) {
  int fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (fd < 0) {
    int cause = errno;
    connection_native_close(connection);
    enqueue_error(transport, operation, map_errno(cause), cause, 0, 0U,
                  cause == ENOBUFS || cause == ENOMEM);
    return SOCKET_CONNECT_FAILED;
  }
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) {
    int cause = errno;
    close(fd);
    connection_native_close(connection);
    enqueue_error(transport, operation, POCKETJS_NET_ESP_ERROR_TRANSPORT_FAILED,
                  cause, 0, 0U, false);
    return SOCKET_CONNECT_FAILED;
  }
  connection->fd = fd;
  struct sockaddr_in address = {
      .sin_family = AF_INET,
      .sin_port = htons(operation->port),
      .sin_addr.s_addr = operation->ipv4_be,
  };
  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) == 0) {
    return SOCKET_CONNECT_READY;
  }
  if (errno != EINPROGRESS) {
    int cause = errno;
    connection_native_close(connection);
    enqueue_error(transport, operation, map_errno(cause), cause, 0, 0U,
                  cause == ENETUNREACH || cause == EHOSTUNREACH);
    return SOCKET_CONNECT_FAILED;
  }
  operation->phase = OP_PHASE_TCP_CONNECT_WAIT;
  return SOCKET_CONNECT_PENDING;
}

static socket_connect_progress_t
poll_socket_connect(pocketjs_net_esp_transport_t *transport,
                    operation_slot_t *operation,
                    connection_slot_t *connection) {
  struct pollfd descriptor = {
      .fd = connection->fd,
      .events = POLLOUT,
  };
  int poll_result = poll(&descriptor, 1U, 0);
  if (poll_result == 0) {
    return SOCKET_CONNECT_PENDING;
  }
  if (poll_result < 0) {
    int cause = errno;
    connection_native_close(connection);
    enqueue_error(transport, operation, map_errno(cause), cause, 0, 0U, false);
    return SOCKET_CONNECT_FAILED;
  }
  int socket_error = 0;
  if ((descriptor.revents & POLLNVAL) != 0) {
    socket_error = EBADF;
  } else {
    socklen_t error_length = sizeof(socket_error);
    if (getsockopt(connection->fd, SOL_SOCKET, SO_ERROR, &socket_error,
                   &error_length) < 0) {
      socket_error = errno;
    }
  }
  if (socket_error != 0) {
    connection_native_close(connection);
    enqueue_error(transport, operation, map_errno(socket_error), socket_error,
                  0, 0U,
                  socket_error == ENETUNREACH || socket_error == EHOSTUNREACH);
    return SOCKET_CONNECT_FAILED;
  }
  return SOCKET_CONNECT_READY;
}

static void pump_plain_connect(pocketjs_net_esp_transport_t *transport,
                               operation_slot_t *operation,
                               connection_slot_t *connection) {
  socket_connect_progress_t progress =
      operation->phase == OP_PHASE_INITIAL
          ? start_socket_connect(transport, operation, connection)
          : poll_socket_connect(transport, operation, connection);
  if (progress == SOCKET_CONNECT_READY) {
    finish_connected(transport, operation, connection);
  }
}

static bool
attach_tls_to_connected_socket(pocketjs_net_esp_transport_t *transport,
                               operation_slot_t *operation,
                               connection_slot_t *connection) {
  esp_tls_t *tls = esp_tls_init();
  if (tls == NULL) {
    connection_native_close(connection);
    enqueue_error(transport, operation, POCKETJS_NET_ESP_ERROR_RESOURCE_LIMIT,
                  ENOMEM, 0, 0U, true);
    return false;
  }
  if (esp_tls_set_conn_sockfd(tls, connection->fd) != ESP_OK) {
    esp_tls_conn_destroy(tls);
    connection_native_close(connection);
    enqueue_error(transport, operation, POCKETJS_NET_ESP_ERROR_TRANSPORT_FAILED,
                  EBADF, 0, 0U, false);
    return false;
  }

  /* Ownership transfers to ESP-TLS as soon as the socket setter succeeds. */
  connection->tls = tls;
  connection->fd = -1;
  if (esp_tls_set_conn_state(tls, ESP_TLS_CONNECTING) != ESP_OK) {
    connection_native_close(connection);
    enqueue_error(transport, operation, POCKETJS_NET_ESP_ERROR_TRANSPORT_FAILED,
                  EINVAL, 0, 0U, false);
    return false;
  }
  operation->phase = OP_PHASE_TLS_HANDSHAKE;
  return true;
}

static void pump_tls_connect(pocketjs_net_esp_transport_t *transport,
                             operation_slot_t *operation,
                             connection_slot_t *connection) {
  esp_tls_cfg_t configuration;
  if (!make_tls_config(transport, operation, &configuration)) {
    connection_native_close(connection);
    enqueue_error(transport, operation,
                  POCKETJS_NET_ESP_ERROR_TLS_CERTIFICATE_INVALID, 0, 0, 0U,
                  false);
    return;
  }
  if (connection->tls == NULL) {
    socket_connect_progress_t progress =
        operation->phase == OP_PHASE_INITIAL
            ? start_socket_connect(transport, operation, connection)
            : poll_socket_connect(transport, operation, connection);
    if (progress != SOCKET_CONNECT_READY) {
      return;
    }
    if (!attach_tls_to_connected_socket(transport, operation, connection)) {
      return;
    }
  }

  int result = esp_tls_conn_new_async(
      operation->hostname, (int)strlen(operation->hostname), operation->port,
      &configuration, connection->tls);
  if (result == 0) {
    esp_tls_conn_state_t state = ESP_TLS_INIT;
    if (esp_tls_get_conn_state(connection->tls, &state) != ESP_OK ||
        state != ESP_TLS_HANDSHAKE) {
      connection_native_close(connection);
      enqueue_error(transport, operation,
                    POCKETJS_NET_ESP_ERROR_TLS_HANDSHAKE_FAILED, 0, 0, 0U,
                    false);
      return;
    }
    return;
  }
  if (result == 1) {
    finish_connected(transport, operation, connection);
    return;
  }

  int cause = 0;
  int system_error = 0;
  int tls_code = 0;
  uint32_t certificate_flags = 0U;
  read_tls_error(connection->tls, &cause, &system_error, &tls_code,
                 &certificate_flags);
  pocketjs_net_esp_error_t error =
      system_error != 0 ? map_errno(system_error)
                        : map_tls_error(tls_code, certificate_flags);
  if (cause == ESP_ERR_ESP_TLS_CONNECTION_TIMEOUT) {
    error = POCKETJS_NET_ESP_ERROR_TIMED_OUT;
  }
  connection_native_close(connection);
  enqueue_error(transport, operation, error, cause, tls_code, certificate_flags,
                false);
}

static void pump_connect(pocketjs_net_esp_transport_t *transport,
                         operation_slot_t *operation) {
  connection_slot_t *connection =
      &transport->connections[operation->connection_slot];
  if (operation->secure) {
    pump_tls_connect(transport, operation, connection);
  } else {
    pump_plain_connect(transport, operation, connection);
  }
}

static void fail_io(pocketjs_net_esp_transport_t *transport,
                    operation_slot_t *operation, int cause, int tls_code,
                    uint32_t certificate_flags) {
  connection_slot_t *connection =
      &transport->connections[operation->connection_slot];
  pocketjs_net_esp_error_t error = map_errno(cause);
  if (connection->secure &&
      (tls_code != 0 || certificate_flags != 0U || cause == 0)) {
    error = map_tls_error(tls_code, certificate_flags);
  }
  operation_cleanup_for_error(transport, operation, true);
  enqueue_error(transport, operation, error, cause, tls_code, certificate_flags,
                false);
}

static void pump_read(pocketjs_net_esp_transport_t *transport,
                      operation_slot_t *operation) {
  connection_slot_t *connection =
      &transport->connections[operation->connection_slot];
  read_lease_slot_t *lease =
      &transport->read_leases[operation->read_lease_slot];
  ssize_t result =
      connection->secure
          ? esp_tls_conn_read(connection->tls, lease->bytes,
                              operation->write_length)
          : recv(connection->fd, lease->bytes, operation->write_length, 0);
  if (result < 0) {
    if ((!connection->secure && (errno == EAGAIN || errno == EWOULDBLOCK)) ||
        (connection->secure && (result == ESP_TLS_ERR_SSL_WANT_READ ||
                                result == ESP_TLS_ERR_SSL_WANT_WRITE))) {
      return;
    }
    int cause = connection->secure ? 0 : errno;
    int system_error = 0;
    int tls_code = connection->secure ? (int)result : 0;
    uint32_t flags = 0U;
    if (connection->secure) {
      read_tls_error(connection->tls, &cause, &system_error, &tls_code, &flags);
    }
    fail_io(transport, operation, cause, tls_code, flags);
    return;
  }

  pocketjs_net_esp_completion_t completion = {
      .type = POCKETJS_NET_ESP_TERMINAL_READ,
      .detail.read =
          {
              .connection = connection_handle(operation->connection_slot,
                                              connection->generation),
              .byte_count = (size_t)result,
              .eof = result == 0,
          },
  };
  if (result > 0) {
    lease->byte_count = (size_t)result;
    completion.detail.read.lease.slot = operation->read_lease_slot;
    completion.detail.read.lease.generation = lease->generation;
  } else {
    release_read_lease_slot(lease);
    operation->read_lease_slot = UINT32_MAX;
  }
  if (enqueue_completion(transport, operation, completion)) {
    operation->read_lease_slot = UINT32_MAX;
    connection->busy_token = 0U;
  }
}

static void pump_write(pocketjs_net_esp_transport_t *transport,
                       operation_slot_t *operation) {
  connection_slot_t *connection =
      &transport->connections[operation->connection_slot];
  const uint8_t *bytes = operation->write_bytes + operation->transferred;
  size_t remaining = operation->write_length - operation->transferred;
  ssize_t result = connection->secure
                       ? esp_tls_conn_write(connection->tls, bytes, remaining)
                       : send(connection->fd, bytes, remaining, MSG_DONTWAIT);
  if (result < 0) {
    if ((!connection->secure && (errno == EAGAIN || errno == EWOULDBLOCK)) ||
        (connection->secure && (result == ESP_TLS_ERR_SSL_WANT_READ ||
                                result == ESP_TLS_ERR_SSL_WANT_WRITE))) {
      return;
    }
    int cause = connection->secure ? 0 : errno;
    int system_error = 0;
    int tls_code = connection->secure ? (int)result : 0;
    uint32_t flags = 0U;
    if (connection->secure) {
      read_tls_error(connection->tls, &cause, &system_error, &tls_code, &flags);
    }
    fail_io(transport, operation, cause, tls_code, flags);
    return;
  }
  if (result == 0) {
    return;
  }
  operation->transferred += (size_t)result;
  if (operation->transferred < operation->write_length) {
    return;
  }

  pocketjs_net_esp_completion_t completion = {
      .type = POCKETJS_NET_ESP_TERMINAL_WRITTEN,
      .detail.written =
          {
              .connection = connection_handle(operation->connection_slot,
                                              connection->generation),
              .byte_count = operation->transferred,
          },
  };
  if (enqueue_completion(transport, operation, completion)) {
    connection->busy_token = 0U;
  }
}

static void pump_close(pocketjs_net_esp_transport_t *transport,
                       operation_slot_t *operation) {
  connection_slot_t *connection =
      &transport->connections[operation->connection_slot];
  pocketjs_net_esp_connection_t handle =
      connection_handle(operation->connection_slot, connection->generation);
  if (connection->secure) {
    mbedtls_ssl_context *ssl = esp_tls_get_ssl_context(connection->tls);
    if (ssl == NULL) {
      operation_cleanup_for_error(transport, operation, true);
      enqueue_error(transport, operation,
                    POCKETJS_NET_ESP_ERROR_TRANSPORT_FAILED,
                    ESP_ERR_INVALID_STATE, 0, 0U, false);
      return;
    }
    int result = mbedtls_ssl_close_notify(ssl);
    pocketjs_net_tls_close_notify_outcome_t outcome =
        pocketjs_net_classify_tls_close_notify(
            result, MBEDTLS_ERR_SSL_WANT_READ, MBEDTLS_ERR_SSL_WANT_WRITE);
    if (outcome == POCKETJS_NET_TLS_CLOSE_NOTIFY_RETRY) {
      return;
    }
    if (outcome == POCKETJS_NET_TLS_CLOSE_NOTIFY_FAILED) {
      int cause = 0;
      int system_error = 0;
      int tls_code = 0;
      uint32_t flags = 0U;
      read_tls_error(connection->tls, &cause, &system_error, &tls_code, &flags);
      if (tls_code == 0) {
        tls_code = result;
      }
      if (system_error != 0) {
        cause = system_error;
      } else if (cause == 0) {
        /* Preserve the direct close_notify result for poison diagnostics. */
        cause = tls_code;
      }
      operation_cleanup_for_error(transport, operation, true);
      enqueue_error(transport, operation,
                    system_error != 0 ? map_errno(system_error)
                                      : map_tls_error(tls_code, flags),
                    cause, tls_code, flags, false);
      return;
    }
  }
  connection_native_close(connection);
  pocketjs_net_esp_completion_t completion = {
      .type = POCKETJS_NET_ESP_TERMINAL_CLOSED,
      .detail.closed = {.connection = handle},
  };
  enqueue_completion(transport, operation, completion);
}

esp_err_t
pocketjs_net_esp_transport_pump(pocketjs_net_esp_transport_t *transport,
                                uint64_t now_us, size_t max_native_steps) {
  if (!owner_task(transport) || now_us == 0U || max_native_steps == 0U) {
    return ESP_ERR_INVALID_ARG;
  }
  size_t steps = 0U;
  size_t examined = 0U;
  while (examined < POCKETJS_NET_ESP_TRANSPORT_MAX_OPERATIONS &&
         steps < max_native_steps) {
    size_t index = transport->pump_cursor;
    transport->pump_cursor = pocketjs_net_round_robin_next(
        transport->pump_cursor, POCKETJS_NET_ESP_TRANSPORT_MAX_OPERATIONS);
    ++examined;
    operation_slot_t *operation = &transport->operations[index];
    if (operation->lifecycle != POCKETJS_NET_OPERATION_ACTIVE) {
      continue;
    }
    ++steps;
    uint64_t sampled_now_us = (uint64_t)esp_timer_get_time();
    if (sampled_now_us < now_us) {
      sampled_now_us = now_us;
    }
    if (atomic_load_explicit(&operation->cancel_requested,
                             memory_order_acquire)) {
      finish_cancelled_or_timed_out(transport, operation,
                                    POCKETJS_NET_ESP_ERROR_ABORTED);
      continue;
    }
    if (sampled_now_us >= operation->deadline_us) {
      finish_cancelled_or_timed_out(transport, operation,
                                    POCKETJS_NET_ESP_ERROR_TIMED_OUT);
      continue;
    }
    switch (operation->kind) {
    case POCKETJS_NET_TRANSPORT_OPERATION_RESOLVE:
      pump_resolve(transport, operation);
      break;
    case POCKETJS_NET_TRANSPORT_OPERATION_CONNECT:
      pump_connect(transport, operation);
      break;
    case POCKETJS_NET_TRANSPORT_OPERATION_READ:
      pump_read(transport, operation);
      break;
    case POCKETJS_NET_TRANSPORT_OPERATION_WRITE:
      pump_write(transport, operation);
      break;
    case POCKETJS_NET_TRANSPORT_OPERATION_CLOSE:
      pump_close(transport, operation);
      break;
    default:
      abort();
    }
    if (operation->lifecycle == POCKETJS_NET_OPERATION_ACTIVE) {
      sampled_now_us = (uint64_t)esp_timer_get_time();
      bool cancel_requested = atomic_load_explicit(&operation->cancel_requested,
                                                   memory_order_acquire);
      if (cancel_requested || sampled_now_us >= operation->deadline_us) {
        finish_cancelled_or_timed_out(transport, operation,
                                      cancel_requested
                                          ? POCKETJS_NET_ESP_ERROR_ABORTED
                                          : POCKETJS_NET_ESP_ERROR_TIMED_OUT);
      }
    }
  }

  if (atomic_load_explicit(&transport->closing, memory_order_acquire)) {
    for (size_t index = 0; index < POCKETJS_NET_ESP_TRANSPORT_MAX_CONNECTIONS;
         ++index) {
      connection_slot_t *connection = &transport->connections[index];
      if (connection->state == CONNECTION_OPEN &&
          connection->busy_token == 0U) {
        connection_native_close(connection);
      }
    }
  }
  return ESP_OK;
}

esp_err_t pocketjs_net_esp_transport_take_completion(
    pocketjs_net_esp_transport_t *transport,
    pocketjs_net_esp_completion_t *out_completion) {
  if (!owner_task(transport) || out_completion == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  if (transport->completion_count == 0U) {
    return ESP_ERR_NOT_FOUND;
  }
  pocketjs_net_esp_completion_t completion =
      transport->completion_ring[transport->completion_head];
  operation_slot_t *operation =
      find_operation(transport, completion.operation_token);
  portENTER_CRITICAL(&transport->lock);
  bool began_delivery =
      operation != NULL &&
      pocketjs_net_operation_begin_delivery(&operation->lifecycle);
  portEXIT_CRITICAL(&transport->lock);
  if (!began_delivery ||
      !pocketjs_net_terminal_credit_take(&transport->terminal_credits)) {
    abort();
  }
  transport->completion_head = (transport->completion_head + 1U) %
                               POCKETJS_NET_ESP_TRANSPORT_COMPLETION_CAPACITY;
  --transport->completion_count;
  *out_completion = completion;
  return ESP_OK;
}

esp_err_t pocketjs_net_esp_transport_retire_completion(
    pocketjs_net_esp_transport_t *transport, uint64_t token) {
  if (!owner_task(transport) || token == 0U) {
    return ESP_ERR_INVALID_ARG;
  }
  operation_slot_t *operation = find_operation(transport, token);
  portENTER_CRITICAL(&transport->lock);
  bool retired =
      operation != NULL && pocketjs_net_operation_retire(&operation->lifecycle);
  if (retired) {
    memset(operation, 0, sizeof(*operation));
  }
  portEXIT_CRITICAL(&transport->lock);
  if (!retired ||
      !pocketjs_net_terminal_credit_retire(&transport->terminal_credits)) {
    return ESP_ERR_INVALID_STATE;
  }
  return ESP_OK;
}

esp_err_t pocketjs_net_esp_transport_read_lease_view(
    pocketjs_net_esp_transport_t *transport,
    pocketjs_net_esp_read_lease_t handle, const uint8_t **out_bytes,
    size_t *out_capacity) {
  if (!owner_task(transport) || out_bytes == NULL || out_capacity == NULL ||
      handle.slot >= POCKETJS_NET_ESP_TRANSPORT_READ_LEASES) {
    return ESP_ERR_INVALID_ARG;
  }
  read_lease_slot_t *lease = &transport->read_leases[handle.slot];
  if (!lease->in_use || lease->generation != handle.generation) {
    return ESP_ERR_NOT_FOUND;
  }
  *out_bytes = lease->bytes;
  *out_capacity = lease->byte_count;
  return ESP_OK;
}

esp_err_t pocketjs_net_esp_transport_release_read_lease(
    pocketjs_net_esp_transport_t *transport,
    pocketjs_net_esp_read_lease_t handle) {
  if (!owner_task(transport) ||
      handle.slot >= POCKETJS_NET_ESP_TRANSPORT_READ_LEASES) {
    return ESP_ERR_INVALID_ARG;
  }
  read_lease_slot_t *lease = &transport->read_leases[handle.slot];
  if (!lease->in_use || lease->generation != handle.generation) {
    return ESP_ERR_NOT_FOUND;
  }
  release_read_lease_slot(lease);
  return ESP_OK;
}

const char *pocketjs_net_esp_error_name(pocketjs_net_esp_error_t error) {
  switch (error) {
  case POCKETJS_NET_ESP_ERROR_NONE:
    return "none";
  case POCKETJS_NET_ESP_ERROR_ABORTED:
    return "aborted";
  case POCKETJS_NET_ESP_ERROR_TIMED_OUT:
    return "timed_out";
  case POCKETJS_NET_ESP_ERROR_BUSY:
    return "busy";
  case POCKETJS_NET_ESP_ERROR_RESOURCE_LIMIT:
    return "resource_limit";
  case POCKETJS_NET_ESP_ERROR_INVALID_ARGUMENT:
    return "invalid_argument";
  case POCKETJS_NET_ESP_ERROR_CLOSED:
    return "closed";
  case POCKETJS_NET_ESP_ERROR_UNSUPPORTED:
    return "unsupported";
  case POCKETJS_NET_ESP_ERROR_DNS_NOT_FOUND:
    return "dns_not_found";
  case POCKETJS_NET_ESP_ERROR_DNS_FAILED:
    return "dns_failed";
  case POCKETJS_NET_ESP_ERROR_CONNECTION_REFUSED:
    return "connection_refused";
  case POCKETJS_NET_ESP_ERROR_CONNECTION_RESET:
    return "connection_reset";
  case POCKETJS_NET_ESP_ERROR_NETWORK_UNREACHABLE:
    return "network_unreachable";
  case POCKETJS_NET_ESP_ERROR_TRANSPORT_FAILED:
    return "transport_failed";
  case POCKETJS_NET_ESP_ERROR_TLS_CERTIFICATE_INVALID:
    return "tls_certificate_invalid";
  case POCKETJS_NET_ESP_ERROR_TLS_HOSTNAME_MISMATCH:
    return "tls_hostname_mismatch";
  case POCKETJS_NET_ESP_ERROR_TLS_HANDSHAKE_FAILED:
    return "tls_handshake_failed";
  case POCKETJS_NET_ESP_ERROR_TLS_VERSION_UNSUPPORTED:
    return "tls_version_unsupported";
  case POCKETJS_NET_ESP_ERROR_TLS_ALERT:
    return "tls_alert";
  default:
    return NULL;
  }
}
