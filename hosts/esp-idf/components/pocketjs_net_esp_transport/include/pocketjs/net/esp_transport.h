// SPDX-License-Identifier: MIT

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define POCKETJS_NET_ESP_TRANSPORT_ID                                          \
  "pocketjs.net.esp-idf.transport.v1.experimental"
#define POCKETJS_NET_ESP_TLS_PROVIDER_ID                                       \
  "pocketjs.net.esp-idf.esp-tls.v1.experimental"

#define POCKETJS_NET_ESP_TRANSPORT_MAX_CONNECTIONS 4U
#define POCKETJS_NET_ESP_TRANSPORT_MAX_OPERATIONS 8U
#define POCKETJS_NET_ESP_TRANSPORT_COMPLETION_CAPACITY 8U
#define POCKETJS_NET_ESP_TRANSPORT_MAX_DNS_CONTEXTS 8U
#define POCKETJS_NET_ESP_TRANSPORT_MAX_DNS_CANDIDATES 4U
#define POCKETJS_NET_ESP_TRANSPORT_MAX_HOSTNAME_BYTES 253U
#define POCKETJS_NET_ESP_TRANSPORT_MAX_WRITE_BYTES 4096U
#define POCKETJS_NET_ESP_TRANSPORT_READ_LEASES 8U
#define POCKETJS_NET_ESP_TRANSPORT_READ_LEASE_BYTES 2048U
#define POCKETJS_NET_ESP_TRANSPORT_MAX_PINNED_CA_PEM_BYTES 4096U
#define POCKETJS_NET_ESP_TRANSPORT_TLS_STEP_TIMEOUT_MS 0U

typedef struct pocketjs_net_esp_transport pocketjs_net_esp_transport_t;

/**
 * Operation tokens are selected by the owner. A transport accepts non-zero
 * values in strictly increasing order and never wraps. Accepting UINT64_MAX
 * exhausts that transport's token space permanently. This makes a stale
 * completion distinguishable even after an operation slot is reused.
 */
typedef uint64_t pocketjs_net_esp_operation_token_t;

typedef struct {
  uint32_t slot;
  uint64_t generation;
} pocketjs_net_esp_connection_t;

typedef struct {
  uint32_t slot;
  uint64_t generation;
} pocketjs_net_esp_read_lease_t;

/* These values are wire/log stable. Additions must use new numeric values. */
typedef enum {
  POCKETJS_NET_ESP_TERMINAL_RESOLVED = 0x1001,
  POCKETJS_NET_ESP_TERMINAL_CONNECTED = 0x1002,
  POCKETJS_NET_ESP_TERMINAL_READ = 0x1003,
  POCKETJS_NET_ESP_TERMINAL_WRITTEN = 0x1004,
  POCKETJS_NET_ESP_TERMINAL_CLOSED = 0x1005,
  POCKETJS_NET_ESP_TERMINAL_ERROR = 0x10ff,
} pocketjs_net_esp_terminal_type_t;

typedef enum {
  POCKETJS_NET_ESP_ERROR_NONE = 0,
  POCKETJS_NET_ESP_ERROR_ABORTED = 1,
  POCKETJS_NET_ESP_ERROR_TIMED_OUT = 2,
  POCKETJS_NET_ESP_ERROR_BUSY = 3,
  POCKETJS_NET_ESP_ERROR_RESOURCE_LIMIT = 4,
  POCKETJS_NET_ESP_ERROR_INVALID_ARGUMENT = 5,
  POCKETJS_NET_ESP_ERROR_CLOSED = 6,
  POCKETJS_NET_ESP_ERROR_UNSUPPORTED = 7,

  POCKETJS_NET_ESP_ERROR_DNS_NOT_FOUND = 100,
  POCKETJS_NET_ESP_ERROR_DNS_FAILED = 101,

  POCKETJS_NET_ESP_ERROR_CONNECTION_REFUSED = 200,
  POCKETJS_NET_ESP_ERROR_CONNECTION_RESET = 201,
  POCKETJS_NET_ESP_ERROR_NETWORK_UNREACHABLE = 202,
  POCKETJS_NET_ESP_ERROR_TRANSPORT_FAILED = 203,

  POCKETJS_NET_ESP_ERROR_TLS_CERTIFICATE_INVALID = 300,
  POCKETJS_NET_ESP_ERROR_TLS_HOSTNAME_MISMATCH = 301,
  POCKETJS_NET_ESP_ERROR_TLS_HANDSHAKE_FAILED = 302,
  POCKETJS_NET_ESP_ERROR_TLS_VERSION_UNSUPPORTED = 303,
  POCKETJS_NET_ESP_ERROR_TLS_ALERT = 304,
} pocketjs_net_esp_error_t;

typedef enum {
  POCKETJS_NET_ESP_ERROR_CATEGORY_RUNTIME = 1,
  POCKETJS_NET_ESP_ERROR_CATEGORY_RESOLVER = 2,
  POCKETJS_NET_ESP_ERROR_CATEGORY_TRANSPORT = 3,
  POCKETJS_NET_ESP_ERROR_CATEGORY_TLS = 4,
} pocketjs_net_esp_error_category_t;

typedef enum {
  POCKETJS_NET_ESP_TLS_TRUST_DISABLED = 0,
  POCKETJS_NET_ESP_TLS_TRUST_CERTIFICATE_BUNDLE = 1,
  POCKETJS_NET_ESP_TLS_TRUST_HOST_PINNED_CA = 2,
} pocketjs_net_esp_tls_trust_source_t;

typedef void (*pocketjs_net_esp_wake_fn)(void *context);
typedef bool (*pocketjs_net_esp_wall_clock_trusted_fn)(void *context);

typedef struct {
  /**
   * May run on lwIP's tcpip thread or a cancel/shutdown caller task. It must
   * only signal the product scheduler; it must not block, enter QuickJS,
   * re-enter this transport, or destroy it.
   */
  pocketjs_net_esp_wake_fn wake;
  void *wake_context;
  pocketjs_net_esp_tls_trust_source_t tls_trust_source;
  const uint8_t *host_pinned_ca_pem;
  size_t host_pinned_ca_pem_bytes;
  /** Required for either TLS trust source and called only by the owner pump. */
  pocketjs_net_esp_wall_clock_trusted_fn wall_clock_trusted;
  void *wall_clock_context;
} pocketjs_net_esp_transport_config_t;

typedef struct {
  const char *id;
  const char *implementation_version;
  bool experimental;
  bool advertises_public_capability;
  bool ipv4;
  bool asynchronous_raw_dns;
  bool stock_lwip_dns_callbacks_only;
  bool complete_dns_candidate_set;
  bool rejects_saturated_dns_candidate_prefix;
  /** Late callbacks are gated by an immutable, non-wrapping generation. */
  bool dns_cancel_generation_cleanup;
  bool synchronous_getaddrinfo_for_hostname;
  bool esp_tls_numeric_getaddrinfo_internal;
  bool nonblocking_plain_tcp_steps;
  bool nonblocking_tls_steps;
  bool bounded_native_step_wall_time;
  uint32_t esp_tls_internal_select_timeout_ms;
  bool monotonic_deadlines;
  bool cancel_between_native_steps;
  bool worker_or_callback_calls_quickjs;
  bool exact_one_terminal;
  bool aba_safe_tokens;
  bool fixed_operation_pool;
  bool fixed_completion_pool;
  bool fixed_payload_pool;
  bool tls_compiled;
  bool tls_1_2_only;
  bool host_trust;
  bool host_pinned_ca;
  bool hostname_verification;
  /** Hostname mismatch is distinct from other certificate failures. */
  bool distinct_tls_errors;
  bool sni;
  bool trusted_wall_clock_required;
  bool plaintext_fallback;
  bool renegotiation;
  bool early_data;
  bool tls_close_notify;
  bool tls_close_notify_uses_operation_deadline;
  bool tls_close_notify_waits_for_peer;
  bool bounded_lwip_dns_callback_allocation;
  bool bounded_lwip_socket_allocation;
  bool bounded_esp_tls_allocation;
  bool bounded_mbedtls_x509_parse_allocation;
  size_t pocketjs_owned_instance_bytes;
  size_t lwip_static_callback_messages;
  size_t max_connections;
  size_t max_operations;
  size_t completion_capacity;
  size_t max_dns_candidates;
  size_t max_write_bytes;
  size_t read_lease_bytes;
  size_t max_pinned_ca_bytes;
} pocketjs_net_esp_transport_descriptor_t;

typedef struct {
  const char *hostname;
  uint64_t deadline_us;
} pocketjs_net_esp_resolve_request_t;

typedef struct {
  /** IPv4 address in network byte order, already selected by the Core. */
  uint32_t ipv4_be;
  uint16_t port;
  bool tls;
  /** Required for TLS and used for certificate verification and SNI. */
  const char *original_hostname;
  uint64_t deadline_us;
} pocketjs_net_esp_connect_request_t;

typedef struct {
  pocketjs_net_esp_connection_t connection;
  size_t maximum_bytes;
  uint64_t deadline_us;
} pocketjs_net_esp_read_request_t;

typedef struct {
  pocketjs_net_esp_connection_t connection;
  const uint8_t *bytes;
  size_t length;
  uint64_t deadline_us;
} pocketjs_net_esp_write_request_t;

typedef struct {
  pocketjs_net_esp_connection_t connection;
  uint64_t deadline_us;
} pocketjs_net_esp_close_request_t;

typedef struct {
  pocketjs_net_esp_error_t code;
  pocketjs_net_esp_error_category_t category;
  int32_t cause_code;
  int32_t tls_code;
  uint32_t tls_certificate_flags;
  bool temporary;
} pocketjs_net_esp_error_detail_t;

typedef struct {
  pocketjs_net_esp_terminal_type_t type;
  pocketjs_net_esp_operation_token_t operation_token;
  uint64_t sequence;
  union {
    struct {
      uint32_t ipv4_be[POCKETJS_NET_ESP_TRANSPORT_MAX_DNS_CANDIDATES];
      size_t candidate_count;
    } resolved;
    struct {
      pocketjs_net_esp_connection_t connection;
      uint32_t ipv4_be;
      bool tls;
    } connected;
    struct {
      pocketjs_net_esp_connection_t connection;
      pocketjs_net_esp_read_lease_t lease;
      size_t byte_count;
      bool eof;
    } read;
    struct {
      pocketjs_net_esp_connection_t connection;
      size_t byte_count;
    } written;
    struct {
      pocketjs_net_esp_connection_t connection;
    } closed;
    pocketjs_net_esp_error_detail_t error;
  } detail;
} pocketjs_net_esp_completion_t;

const pocketjs_net_esp_transport_descriptor_t *
pocketjs_net_esp_transport_descriptor(void);

/** Validate and parse a Host TLS profile without creating transport state. */
esp_err_t pocketjs_net_esp_transport_validate_config(
    const pocketjs_net_esp_transport_config_t *config);

/**
 * create fixes the calling task as owner. The owner must be a product task,
 * never lwIP's tcpip task, because destroy uses a synchronous tcpip callback
 * barrier. Except for cancel and begin_shutdown, every API below must be called
 * by that same task.
 */
esp_err_t pocketjs_net_esp_transport_create(
    const pocketjs_net_esp_transport_config_t *config,
    pocketjs_net_esp_transport_t **out_transport);

/** Thread-safe.
 * Starts quiescing and requests cancellation for every active operation except
 * an already accepted close, which continues under its monotonic deadline.
 * The owner must continue pump/take/retire until is_quiescent returns true.
 * The wake hook is called after releasing the transport lock.
 */
void pocketjs_net_esp_transport_begin_shutdown(
    pocketjs_net_esp_transport_t *transport);

bool pocketjs_net_esp_transport_is_quiescent(
    const pocketjs_net_esp_transport_t *transport);

/**
 * Returns ESP_ERR_INVALID_STATE until the transport is quiescent. Before this
 * call, the Host must prevent new cancel/begin_shutdown calls and join every
 * in-flight caller; internal quiescence does not own external caller lifetime.
 */
esp_err_t
pocketjs_net_esp_transport_destroy(pocketjs_net_esp_transport_t *transport);

/**
 * Owner-only poison teardown for a dedicated transport whose sole protocol
 * Core has entered shutdown and reported poisoned native ownership. The caller
 * must already have called begin_shutdown, prohibited new external calls, and
 * joined every in-flight caller. This abandons queued/delivering completions,
 * closes native connections, and releases transport-owned leases only after a
 * tcpip-thread barrier proves that no DNS callback is executing. A raw DNS
 * lookup that has not reached its late callback keeps returning
 * ESP_ERR_NOT_FINISHED; the caller must retry without freeing the Core. Once
 * this succeeds, transport_context in that Core is invalid: the caller must
 * synchronously call core_confirm_transport_shutdown before any other Core
 * entry point.
 *
 * Healthy shutdown must use pocketjs_net_esp_transport_destroy().
 */
esp_err_t pocketjs_net_esp_transport_destroy_poisoned(
    pocketjs_net_esp_transport_t *transport);

esp_err_t pocketjs_net_esp_transport_start_resolve(
    pocketjs_net_esp_transport_t *transport,
    pocketjs_net_esp_operation_token_t token,
    const pocketjs_net_esp_resolve_request_t *request);

esp_err_t pocketjs_net_esp_transport_start_connect(
    pocketjs_net_esp_transport_t *transport,
    pocketjs_net_esp_operation_token_t token,
    const pocketjs_net_esp_connect_request_t *request);

esp_err_t pocketjs_net_esp_transport_start_read(
    pocketjs_net_esp_transport_t *transport,
    pocketjs_net_esp_operation_token_t token,
    const pocketjs_net_esp_read_request_t *request);

esp_err_t pocketjs_net_esp_transport_start_write(
    pocketjs_net_esp_transport_t *transport,
    pocketjs_net_esp_operation_token_t token,
    const pocketjs_net_esp_write_request_t *request);

esp_err_t pocketjs_net_esp_transport_start_close(
    pocketjs_net_esp_transport_t *transport,
    pocketjs_net_esp_operation_token_t token,
    const pocketjs_net_esp_close_request_t *request);

/**
 * Thread-safe. Native cleanup is performed later by the owner pump. A
 * successful request calls the wake hook after releasing the transport lock.
 */
esp_err_t
pocketjs_net_esp_transport_cancel(pocketjs_net_esp_transport_t *transport,
                                  pocketjs_net_esp_operation_token_t token);

/**
 * Advances at most max_native_steps operations with persistent round-robin
 * fairness. now_us must use esp_timer_get_time()'s monotonic timebase. The
 * transport re-samples that clock after native steps before terminal claim.
 * This function never calls the wake hook or QuickJS.
 */
esp_err_t
pocketjs_net_esp_transport_pump(pocketjs_net_esp_transport_t *transport,
                                uint64_t now_us, size_t max_native_steps);

/** Non-blocking single-consumer terminal dequeue. */
esp_err_t pocketjs_net_esp_transport_take_completion(
    pocketjs_net_esp_transport_t *transport,
    pocketjs_net_esp_completion_t *out_completion);

/**
 * Ends delivery and returns the terminal admission credit. It must be called
 * exactly once after take_completion, after the Core has finished delivery.
 */
esp_err_t pocketjs_net_esp_transport_retire_completion(
    pocketjs_net_esp_transport_t *transport,
    pocketjs_net_esp_operation_token_t token);

esp_err_t pocketjs_net_esp_transport_read_lease_view(
    pocketjs_net_esp_transport_t *transport,
    pocketjs_net_esp_read_lease_t lease, const uint8_t **out_bytes,
    size_t *out_capacity);

esp_err_t pocketjs_net_esp_transport_release_read_lease(
    pocketjs_net_esp_transport_t *transport,
    pocketjs_net_esp_read_lease_t lease);

const char *pocketjs_net_esp_error_name(pocketjs_net_esp_error_t error);

#if defined(POCKETJS_NET_ESP_TRANSPORT_TEST_INTERNALS)
/** Build-smoke seam for deterministic native TLS error mapping checks. */
pocketjs_net_esp_error_t
pocketjs_net_esp_transport_map_tls_error_for_test(int tls_code,
                                                  uint32_t certificate_flags);
#endif

#ifdef __cplusplus
}
#endif
