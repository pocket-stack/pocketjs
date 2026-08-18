// SPDX-License-Identifier: MIT

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define POCKETJS_NET_HTTP_CLIENT_CORE_ID                                       \
  "pocketjs.net.http-client-core.v1.experimental"

#define POCKETJS_NET_HTTP_CLIENT_CORE_INSTANCE_BYTES 36864U
#define POCKETJS_NET_HTTP_CLIENT_CORE_MAX_URL_BYTES 2048U
#define POCKETJS_NET_HTTP_CLIENT_CORE_MAX_METHOD_BYTES 32U
#define POCKETJS_NET_HTTP_CLIENT_CORE_MAX_HOST_BYTES 253U
#define POCKETJS_NET_HTTP_CLIENT_CORE_MAX_TARGET_BYTES 2048U
#define POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REQUEST_HEADER_BYTES 8192U
#define POCKETJS_NET_HTTP_CLIENT_CORE_MAX_RESPONSE_HEADER_BYTES 8192U
#define POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REQUEST_HEADERS 60U
#define POCKETJS_NET_HTTP_CLIENT_CORE_MAX_RESPONSE_HEADERS 64U
#define POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REQUEST_BODY_BYTES 4096U
#define POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES 2048U
#define POCKETJS_NET_HTTP_CLIENT_CORE_WRITE_BYTES 4096U
#define POCKETJS_NET_HTTP_CLIENT_CORE_BODY_LEASE_BYTES 2048U
#define POCKETJS_NET_HTTP_CLIENT_CORE_MAX_DNS_CANDIDATES 4U
#define POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REDIRECTS 5U

typedef struct pocketjs_net_http_client_core pocketjs_net_http_client_core_t;

typedef union {
  max_align_t alignment;
  uint8_t bytes[POCKETJS_NET_HTTP_CLIENT_CORE_INSTANCE_BYTES];
} pocketjs_net_http_client_core_storage_t;

typedef uint64_t pocketjs_net_http_client_operation_token_t;

typedef struct {
  uint32_t slot;
  uint64_t generation;
} pocketjs_net_http_client_transport_connection_t;

typedef struct {
  uint32_t slot;
  uint64_t generation;
} pocketjs_net_http_client_transport_read_lease_t;

typedef enum {
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK = 0,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_EMPTY,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_INVALID,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_BUSY,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_RESOURCE_LIMIT,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_FAILED,
} pocketjs_net_http_client_transport_result_t;

typedef enum {
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_RESOLVED = 1,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_CONNECTED,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_READ,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_WRITTEN,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_CLOSED,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR,
} pocketjs_net_http_client_transport_terminal_t;

typedef enum {
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_NONE = 0,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_ABORTED,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TIMED_OUT,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_DNS,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_CONNECT,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_IO,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TLS_CERTIFICATE_INVALID,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TLS_HOSTNAME_MISMATCH,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TLS_HANDSHAKE_FAILED,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TLS_VERSION_UNSUPPORTED,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TLS_ALERT,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_RESOURCE_LIMIT,
  POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_INVALID,
} pocketjs_net_http_client_transport_error_t;

typedef struct {
  pocketjs_net_http_client_transport_terminal_t type;
  uint64_t operation_token;
  union {
    struct {
      uint32_t ipv4_be[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_DNS_CANDIDATES];
      size_t candidate_count;
    } resolved;
    struct {
      pocketjs_net_http_client_transport_connection_t connection;
      uint32_t ipv4_be;
      bool tls;
    } connected;
    struct {
      pocketjs_net_http_client_transport_connection_t connection;
      pocketjs_net_http_client_transport_read_lease_t lease;
      size_t byte_count;
      bool eof;
    } read;
    struct {
      pocketjs_net_http_client_transport_connection_t connection;
      size_t byte_count;
    } written;
    struct {
      pocketjs_net_http_client_transport_connection_t connection;
    } closed;
    struct {
      pocketjs_net_http_client_transport_error_t code;
      int32_t cause_code;
    } error;
  } detail;
} pocketjs_net_http_client_transport_completion_t;

typedef struct {
  pocketjs_net_http_client_transport_result_t (*start_resolve)(
      void *context, uint64_t token, const char *hostname,
      uint64_t deadline_us);
  pocketjs_net_http_client_transport_result_t (*start_connect)(
      void *context, uint64_t token, uint32_t ipv4_be, uint16_t port, bool tls,
      const char *original_hostname, uint64_t deadline_us);
  pocketjs_net_http_client_transport_result_t (*start_read)(
      void *context, uint64_t token,
      pocketjs_net_http_client_transport_connection_t connection,
      size_t maximum_bytes, uint64_t deadline_us);
  pocketjs_net_http_client_transport_result_t (*start_write)(
      void *context, uint64_t token,
      pocketjs_net_http_client_transport_connection_t connection,
      const uint8_t *bytes, size_t length, uint64_t deadline_us);
  pocketjs_net_http_client_transport_result_t (*start_close)(
      void *context, uint64_t token,
      pocketjs_net_http_client_transport_connection_t connection,
      uint64_t deadline_us);
  pocketjs_net_http_client_transport_result_t (*cancel)(void *context,
                                                        uint64_t token);
  pocketjs_net_http_client_transport_result_t (*pump)(void *context,
                                                      uint64_t now_us,
                                                      size_t max_native_steps);
  pocketjs_net_http_client_transport_result_t (*take_completion)(
      void *context,
      pocketjs_net_http_client_transport_completion_t *out_completion);
  pocketjs_net_http_client_transport_result_t (*retire_completion)(
      void *context, uint64_t token);
  pocketjs_net_http_client_transport_result_t (*read_lease_view)(
      void *context, pocketjs_net_http_client_transport_read_lease_t lease,
      const uint8_t **out_bytes, size_t *out_capacity);
  pocketjs_net_http_client_transport_result_t (*release_read_lease)(
      void *context, pocketjs_net_http_client_transport_read_lease_t lease);
} pocketjs_net_http_client_transport_ops_t;

typedef enum {
  POCKETJS_NET_HTTP_CLIENT_SCHEME_HTTP = 1,
  POCKETJS_NET_HTTP_CLIENT_SCHEME_HTTPS = 2,
} pocketjs_net_http_client_scheme_t;

typedef enum {
  POCKETJS_NET_HTTP_CLIENT_PERMISSION_HOSTNAME = 1,
  POCKETJS_NET_HTTP_CLIENT_PERMISSION_NUMERIC_CANDIDATE = 2,
} pocketjs_net_http_client_permission_phase_t;

typedef struct {
  pocketjs_net_http_client_permission_phase_t phase;
  pocketjs_net_http_client_scheme_t scheme;
  const char *hostname;
  uint16_t port;
  uint32_t ipv4_be;
} pocketjs_net_http_client_endpoint_t;

typedef bool (*pocketjs_net_http_client_permission_fn)(
    void *context, const pocketjs_net_http_client_endpoint_t *endpoint);

typedef struct {
  const pocketjs_net_http_client_transport_ops_t *transport_ops;
  void *transport_context;
  pocketjs_net_http_client_permission_fn allow_endpoint;
  void *permission_context;
  uint64_t connect_timeout_us;
  uint64_t headers_timeout_us;
  uint64_t idle_timeout_us;
  uint64_t total_timeout_us;
  /** HTTPS stays pre-I/O fail-closed unless the selected Host opts in. */
  bool allow_https;
  /** Retain one fully delimited same-origin HTTP/1.1 connection per Core. */
  bool enable_connection_reuse;
  /** Final response fields as name + value + ": " + CRLF; zero uses max. */
  size_t response_header_bytes_limit;
} pocketjs_net_http_client_core_config_t;

typedef struct {
  const uint8_t *data;
  size_t length;
} pocketjs_net_http_client_slice_t;

typedef enum {
  POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_2 = 1,
  POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_3,
} pocketjs_net_http_client_tls_version_t;

typedef enum {
  POCKETJS_NET_HTTP_CLIENT_TLS_CLIENT_CERTIFICATE_NONE = 1,
  POCKETJS_NET_HTTP_CLIENT_TLS_CLIENT_CERTIFICATE_OPTIONAL,
  POCKETJS_NET_HTTP_CLIENT_TLS_CLIENT_CERTIFICATE_REQUIRED,
} pocketjs_net_http_client_tls_client_certificate_t;

typedef enum {
  POCKETJS_NET_HTTP_CLIENT_TLS_VERIFICATION_FULL = 1,
  POCKETJS_NET_HTTP_CLIENT_TLS_VERIFICATION_DEVELOPMENT_INSECURE,
} pocketjs_net_http_client_tls_verification_t;

typedef enum {
  POCKETJS_NET_HTTP_CLIENT_TLS_REVOCATION_HOST_DEFAULT = 1,
  POCKETJS_NET_HTTP_CLIENT_TLS_REVOCATION_REQUIRED,
} pocketjs_net_http_client_tls_revocation_t;

typedef struct {
  /** Required canonical DNS hostname. IP literals stay unsupported. */
  pocketjs_net_http_client_slice_t server_name;
  pocketjs_net_http_client_tls_version_t minimum_version;
  pocketjs_net_http_client_tls_version_t maximum_version;
  size_t alpn_count;
  pocketjs_net_http_client_slice_t credential;
  pocketjs_net_http_client_tls_client_certificate_t client_certificate;
  pocketjs_net_http_client_tls_verification_t verification;
  pocketjs_net_http_client_tls_revocation_t revocation;
  size_t custom_ca_bytes;
} pocketjs_net_http_client_tls_policy_t;

typedef struct {
  pocketjs_net_http_client_slice_t name;
  pocketjs_net_http_client_slice_t value;
} pocketjs_net_http_client_header_t;

typedef enum {
  POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_NONE = 0,
  POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_FIXED,
  POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_STREAMING,
} pocketjs_net_http_client_request_body_kind_t;

typedef enum {
  /* Zero intentionally preserves the historical manual behavior. */
  POCKETJS_NET_HTTP_CLIENT_REDIRECT_MANUAL = 0,
  POCKETJS_NET_HTTP_CLIENT_REDIRECT_FOLLOW,
  POCKETJS_NET_HTTP_CLIENT_REDIRECT_ERROR,
} pocketjs_net_http_client_redirect_mode_t;

typedef struct {
  pocketjs_net_http_client_operation_token_t operation_token;
  pocketjs_net_http_client_slice_t url;
  pocketjs_net_http_client_slice_t method;
  const pocketjs_net_http_client_header_t *headers;
  size_t header_count;
  pocketjs_net_http_client_request_body_kind_t body_kind;
  /* Used only by FIXED. The Core snapshots these bytes before native I/O. */
  pocketjs_net_http_client_slice_t body;
  /* Used only by STREAMING. Unknown-length streams use strict chunked coding.
   */
  bool streaming_content_length_known;
  uint64_t streaming_content_length;
  pocketjs_net_http_client_redirect_mode_t redirect_mode;
  uint16_t max_redirects;
  /** Required for HTTPS and forbidden for plaintext HTTP. Snapshotted by start.
   */
  const pocketjs_net_http_client_tls_policy_t *tls;
} pocketjs_net_http_client_request_t;

typedef enum {
  POCKETJS_NET_HTTP_CLIENT_START_OK = 0,
  POCKETJS_NET_HTTP_CLIENT_START_BUSY,
  POCKETJS_NET_HTTP_CLIENT_START_INVALID_ARGUMENT,
  POCKETJS_NET_HTTP_CLIENT_START_INVALID_URL,
  POCKETJS_NET_HTTP_CLIENT_START_UNSUPPORTED_TLS,
  POCKETJS_NET_HTTP_CLIENT_START_LIMIT_EXCEEDED,
  POCKETJS_NET_HTTP_CLIENT_START_FORBIDDEN_REQUEST,
  POCKETJS_NET_HTTP_CLIENT_START_TOKEN_EXHAUSTED,
  POCKETJS_NET_HTTP_CLIENT_START_POISONED,
  POCKETJS_NET_HTTP_CLIENT_START_SHUTTING_DOWN,
  POCKETJS_NET_HTTP_CLIENT_START_REENTRANT,
} pocketjs_net_http_client_start_result_t;

/**
 * Cleanup faults are independent from the first selected HTTP terminal result.
 * They make the instance reject new requests until the dedicated transport is
 * shut down and the Core is deinitialized.
 */
typedef enum {
  POCKETJS_NET_HTTP_CLIENT_POISON_NONE = 0U,
  POCKETJS_NET_HTTP_CLIENT_POISON_PERMISSION_REENTRANCY = 1U << 0,
  POCKETJS_NET_HTTP_CLIENT_POISON_TRANSPORT_PUMP = 1U << 1,
  POCKETJS_NET_HTTP_CLIENT_POISON_COMPLETION_TAKE = 1U << 2,
  POCKETJS_NET_HTTP_CLIENT_POISON_COMPLETION_RETIRE = 1U << 3,
  POCKETJS_NET_HTTP_CLIENT_POISON_READ_LEASE_RELEASE = 1U << 4,
  POCKETJS_NET_HTTP_CLIENT_POISON_CANCEL = 1U << 5,
  POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_ADMISSION = 1U << 6,
  POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_COMPLETION = 1U << 7,
  POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_TIMEOUT = 1U << 8,
  POCKETJS_NET_HTTP_CLIENT_POISON_STALE_COMPLETION = 1U << 9,
  POCKETJS_NET_HTTP_CLIENT_POISON_HOST_EVENT_RETIRE = 1U << 10,
} pocketjs_net_http_client_poison_flag_t;

typedef struct {
  bool initialized;
  bool shutdown_requested;
  bool poisoned;
  bool quiescent;
  bool request_active;
  bool transport_operation_active;
  bool connection_owned;
  bool completion_retire_pending;
  bool event_outstanding;
  bool request_body_credit_outstanding;
  bool connection_reusable;
  size_t transport_read_leases_owned;
  uint32_t poison_flags;
  int32_t first_poison_cause_code;
  uint64_t lifecycle_generation;
  pocketjs_net_http_client_operation_token_t operation_token;
  uint64_t request_body_generation;
  uint64_t request_body_pull_generation;
} pocketjs_net_http_client_core_status_t;

typedef enum {
  POCKETJS_NET_HTTP_CLIENT_ERROR_ABORTED = 1,
  POCKETJS_NET_HTTP_CLIENT_ERROR_TIMED_OUT,
  POCKETJS_NET_HTTP_CLIENT_ERROR_PERMISSION_DENIED,
  POCKETJS_NET_HTTP_CLIENT_ERROR_DNS,
  POCKETJS_NET_HTTP_CLIENT_ERROR_CONNECT,
  POCKETJS_NET_HTTP_CLIENT_ERROR_IO,
  POCKETJS_NET_HTTP_CLIENT_ERROR_PROTOCOL,
  POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT,
  POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT,
  POCKETJS_NET_HTTP_CLIENT_ERROR_REQUEST_BODY,
  POCKETJS_NET_HTTP_CLIENT_ERROR_TLS_CERTIFICATE_INVALID,
  POCKETJS_NET_HTTP_CLIENT_ERROR_TLS_HOSTNAME_MISMATCH,
  POCKETJS_NET_HTTP_CLIENT_ERROR_TLS_HANDSHAKE_FAILED,
  POCKETJS_NET_HTTP_CLIENT_ERROR_TLS_VERSION_UNSUPPORTED,
  POCKETJS_NET_HTTP_CLIENT_ERROR_TLS_ALERT,
  POCKETJS_NET_HTTP_CLIENT_ERROR_UNSUPPORTED,
  POCKETJS_NET_HTTP_CLIENT_ERROR_REDIRECT,
  POCKETJS_NET_HTTP_CLIENT_ERROR_REDIRECT_LIMIT,
  POCKETJS_NET_HTTP_CLIENT_ERROR_REDIRECT_BODY_NOT_REPLAYABLE,
} pocketjs_net_http_client_error_t;

typedef enum {
  POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_CAUSE_LENGTH_UNDERFLOW = 1,
} pocketjs_net_http_client_request_body_cause_t;

typedef struct {
  uint32_t slot;
  uint64_t generation;
} pocketjs_net_http_client_body_lease_t;

typedef enum {
  POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS = 1,
  POCKETJS_NET_HTTP_CLIENT_EVENT_BODY,
  POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE,
  POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR,
  POCKETJS_NET_HTTP_CLIENT_EVENT_REQUEST_BODY_PULL,
} pocketjs_net_http_client_event_type_t;

typedef struct {
  pocketjs_net_http_client_event_type_t type;
  uint64_t sequence;
  pocketjs_net_http_client_operation_token_t operation_token;
  union {
    struct {
      /* Slices remain valid only until this event is retired. */
      unsigned status_code;
      pocketjs_net_http_client_slice_t status_text;
      const pocketjs_net_http_client_header_t *headers;
      size_t header_count;
      pocketjs_net_http_client_slice_t url;
      bool redirected;
    } response;
    struct {
      /* The lease must be released before this event can be retired. */
      pocketjs_net_http_client_body_lease_t lease;
      size_t byte_count;
    } body;
    struct {
      /*
       * Retiring this event does not consume its credit. A later producer
       * command must echo both generations and the operation token.
       */
      uint64_t body_generation;
      uint64_t pull_generation;
      size_t maximum_bytes;
    } request_body_pull;
    struct {
      pocketjs_net_http_client_error_t code;
      int32_t cause_code;
    } error;
  } detail;
} pocketjs_net_http_client_event_t;

typedef struct {
  const char *id;
  bool experimental;
  bool advertises_public_capability;
  bool plaintext_http;
  bool https_fail_closed_before_io;
  bool https_explicit_opt_in;
  bool owner_pumped;
  bool one_operation;
  bool fixed_core_storage;
  bool headers_first;
  bool explicit_body_credit;
  bool explicit_body_lease;
  bool connection_reuse;
  bool bounded_connection_pool;
  bool redirects_followed;
  bool redirect_manual;
  bool redirect_error;
  bool redirect_fixed_body_replay;
  bool redirect_streaming_body_replay;
  /** Retry only another already-authorized DNS address before request I/O. */
  bool connect_error_candidate_fallback;
  bool hidden_retry;
  bool hidden_auth;
  bool hidden_cookie_store;
  bool proxy;
  bool content_decoding;
  bool cleanup_faults_separate_from_terminal;
  bool poison_is_machine_readable;
  bool explicit_shutdown_lifecycle;
  bool fixed_request_body;
  bool streaming_request_body;
  bool chunked_request_body;
  bool known_length_streaming_request_body;
  bool streaming_request_body_buffered_in_full;
  size_t instance_bytes;
  /* Compatibility name for the fixed snapshot ceiling. */
  size_t max_request_body_bytes;
  size_t max_fixed_request_body_bytes;
  size_t max_request_body_chunk_bytes;
  size_t body_lease_bytes;
  size_t max_cached_connections;
} pocketjs_net_http_client_core_descriptor_t;

const pocketjs_net_http_client_core_descriptor_t *
pocketjs_net_http_client_core_descriptor(void);

pocketjs_net_http_client_start_result_t pocketjs_net_http_client_core_init(
    pocketjs_net_http_client_core_storage_t *storage,
    const pocketjs_net_http_client_core_config_t *config,
    pocketjs_net_http_client_core_t **out_core);

/*
 * All instance entry points are owner-only and non-reentrant. During a
 * permission callback, start returns START_REENTRANT and bool APIs return
 * false. Init returns START_BUSY when storage still contains a live instance.
 */
pocketjs_net_http_client_start_result_t pocketjs_net_http_client_core_start(
    pocketjs_net_http_client_core_t *core,
    const pocketjs_net_http_client_request_t *request, uint64_t now_us);

/* Owner-only. Abort is observed between transport steps. */
bool pocketjs_net_http_client_core_abort(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_operation_token_t operation_token);

/*
 * At most max_transport_completions are delivered into the state machine.
 * Either independent budget may be zero; both zero is an invalid no-op.
 */
bool pocketjs_net_http_client_core_pump(pocketjs_net_http_client_core_t *core,
                                        uint64_t now_us,
                                        size_t max_native_steps,
                                        size_t max_transport_completions);

/*
 * Grants one bounded downstream window. It is consumed before another read.
 * After the final non-empty lease, one additional credit may be accepted while
 * a successful terminal is closing or queued; that pull is completed by the
 * terminal event and makes end-of-stream explicit to the binding.
 */
bool pocketjs_net_http_client_core_grant_body_credit(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_operation_token_t operation_token,
    size_t maximum_bytes);

/*
 * Owner-only request producer commands. They are accepted only after the
 * matching REQUEST_BODY_PULL event has been taken and retired. Each matching
 * command consumes exactly one credit; rejected commands consume nothing.
 */
bool pocketjs_net_http_client_core_submit_request_body_chunk(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_operation_token_t operation_token,
    uint64_t body_generation, uint64_t pull_generation, const uint8_t *bytes,
    size_t length);

bool pocketjs_net_http_client_core_submit_request_body_end(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_operation_token_t operation_token,
    uint64_t body_generation, uint64_t pull_generation);

bool pocketjs_net_http_client_core_submit_request_body_error(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_operation_token_t operation_token,
    uint64_t body_generation, uint64_t pull_generation, int32_t cause_code);

bool pocketjs_net_http_client_core_take_event(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_event_t *out_event);

bool pocketjs_net_http_client_core_retire_event(
    pocketjs_net_http_client_core_t *core, uint64_t sequence);

bool pocketjs_net_http_client_core_body_lease_view(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_body_lease_t lease, const uint8_t **out_bytes,
    size_t *out_length);

bool pocketjs_net_http_client_core_release_body_lease(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_body_lease_t lease);

/** Snapshot lifecycle, poison, and native-resource ownership state. */
bool pocketjs_net_http_client_core_get_status(
    const pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_core_status_t *out_status);

/**
 * Permanently stops request admission and aborts any current request. Continue
 * pumping and retiring events until is_quiescent returns true.
 */
bool pocketjs_net_http_client_core_begin_shutdown(
    pocketjs_net_http_client_core_t *core, uint64_t now_us);

bool pocketjs_net_http_client_core_is_quiescent(
    const pocketjs_net_http_client_core_t *core);

/**
 * After the product has synchronously destroyed the dedicated transport, this
 * acknowledges that any poisoned native handles retained for audit no longer
 * exist. It never releases or invalidates a delivered Core body lease/event.
 */
bool pocketjs_net_http_client_core_confirm_transport_shutdown(
    pocketjs_net_http_client_core_t *core);

/**
 * Marks an exact currently delivering event as a Host ownership failure. This
 * does not retire or release the event; shutdown must preserve it until normal
 * retirement succeeds or the poison-only abandon API is admitted.
 */
bool pocketjs_net_http_client_core_report_host_event_retire_failure(
    pocketjs_net_http_client_core_t *core, uint64_t sequence);

/**
 * Poison-only Host ownership escape hatch. After begin_shutdown and synchronous
 * destruction plus confirm_transport_shutdown of the dedicated transport, this
 * abandons the exact delivering event and any Core body lease it owns. Healthy
 * delivery must use retire_event; pending events must first be taken by the
 * sole Host consumer.
 */
bool pocketjs_net_http_client_core_abandon_event_after_transport_shutdown(
    pocketjs_net_http_client_core_t *core, uint64_t sequence);

/** Clears initialized storage only after begin_shutdown and quiescence. */
bool pocketjs_net_http_client_core_deinit(
    pocketjs_net_http_client_core_t *core);

#ifdef __cplusplus
}
#endif
