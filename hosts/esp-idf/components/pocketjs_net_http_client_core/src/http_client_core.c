// SPDX-License-Identifier: MIT

#include "pocketjs/net/http_client_core.h"

#include "pocketjs/net/http1_wire.h"

#include <limits.h>
#include <string.h>

#define CORE_MAGIC UINT64_C(0x504a534854545031)
#define CORE_CLOSE_TIMEOUT_US UINT64_C(1000000)

typedef enum {
  CORE_IDLE = 0,
  CORE_RESOLVING,
  CORE_CONNECTING,
  CORE_WRITING_HEAD,
  CORE_WRITING_BODY,
  CORE_WAITING_REQUEST_BODY,
  CORE_WRITING_REQUEST_BODY_CHUNK,
  CORE_WRITING_REQUEST_BODY_END,
  CORE_READING,
  CORE_CLOSING,
  CORE_REPLACING_CONNECTION,
  CORE_IDLE_CONNECTION_CLOSING,
  CORE_ENDPOINT_READY,
  CORE_REDIRECT_READY,
  CORE_WAITING_TERMINAL_RETIRE,
} core_state_t;

typedef enum {
  TRANSPORT_OPERATION_NONE = 0,
  TRANSPORT_OPERATION_RESOLVE,
  TRANSPORT_OPERATION_CONNECT,
  TRANSPORT_OPERATION_WRITE,
  TRANSPORT_OPERATION_READ,
  TRANSPORT_OPERATION_CLOSE,
} transport_operation_kind_t;

typedef enum {
  EVENT_EMPTY = 0,
  EVENT_PENDING,
  EVENT_DELIVERING,
} event_state_t;

struct pocketjs_net_http_client_core {
  uint64_t magic;
  pocketjs_net_http_client_core_config_t config;
  core_state_t state;
  event_state_t event_state;
  pocketjs_net_http_client_event_t event;
  uint64_t last_operation_token;
  uint64_t last_transport_token;
  uint64_t event_sequence;
  uint64_t body_lease_generation;
  uint64_t last_request_body_generation;
  uint64_t last_request_body_pull_generation;
  uint64_t lifecycle_generation;
  uint64_t now_us;
  uint64_t connect_deadline_us;
  uint64_t headers_deadline_us;
  uint64_t idle_deadline_us;
  uint64_t total_deadline_us;
  uint64_t close_deadline_us;
  pocketjs_net_http_client_operation_token_t operation_token;

  bool permission_callback_active;
  bool shutdown_requested;
  bool transport_shutdown_confirmed;
  bool transport_cancel_requested;
  bool close_cancel_requested;
  uint32_t poison_flags;
  int32_t first_poison_cause_code;

  pocketjs_net_http_client_scheme_t scheme;
  char hostname[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_HOST_BYTES + 1U];
  char host_field[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_HOST_BYTES + 7U];
  uint8_t target[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_TARGET_BYTES];
  size_t target_length;
  uint16_t port;
  bool numeric_host;
  uint32_t numeric_ipv4_be;
  uint32_t selected_ipv4_be;
  uint32_t connect_candidates[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_DNS_CANDIDATES];
  size_t connect_candidate_count;
  size_t next_connect_candidate;

  uint8_t method[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_METHOD_BYTES];
  size_t method_length;
  uint8_t request_header_storage
      [POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REQUEST_HEADER_BYTES];
  size_t request_header_storage_used;
  pocketjs_net_http1_header_t
      request_headers[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REQUEST_HEADERS + 2U];
  size_t request_header_count;
  uint8_t request_body[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REQUEST_BODY_BYTES];
  size_t request_body_length;
  pocketjs_net_http_client_request_body_kind_t request_body_kind;
  bool request_body_length_known;
  uint64_t request_body_expected_length;
  uint64_t request_body_submitted_length;
  uint64_t request_body_generation;
  uint64_t request_body_pull_generation;
  size_t request_body_pull_maximum;
  size_t request_body_pending_payload_length;
  bool request_body_pull_active;
  bool request_body_pull_event_retired;
  pocketjs_net_http1_request_encoder_t encoder;
  bool encoder_done;
  uint8_t write_bytes[POCKETJS_NET_HTTP_CLIENT_CORE_WRITE_BYTES];
  size_t write_length;

  pocketjs_net_http1_response_parser_t parser;
  bool final_headers_seen;
  bool headers_delivered;
  bool parser_complete;
  bool force_no_body;
  pocketjs_net_http_client_error_t callback_error;
  unsigned response_status;
  unsigned response_http_minor;
  pocketjs_net_http1_response_body_kind_t response_body_kind;
  bool response_connection_close;
  bool response_connection_reusable;
  bool redirect_location_seen;
  pocketjs_net_http_client_slice_t redirect_location;
  bool redirect_pending;
  pocketjs_net_http_client_redirect_mode_t redirect_mode;
  uint16_t redirect_count;
  uint16_t max_redirects;
  uint8_t response_header_storage
      [POCKETJS_NET_HTTP_CLIENT_CORE_MAX_RESPONSE_HEADER_BYTES];
  size_t response_header_storage_used;
  size_t response_header_field_bytes;
  pocketjs_net_http_client_header_t
      response_headers[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_RESPONSE_HEADERS];
  size_t response_header_count;
  pocketjs_net_http_client_slice_t response_status_text;

  bool transport_active;
  transport_operation_kind_t transport_operation_kind;
  uint64_t transport_operation_token;
  pocketjs_net_http_client_transport_connection_t connection;
  bool connection_valid;
  bool connection_reusable;
  pocketjs_net_http_client_scheme_t connection_scheme;
  char connection_hostname[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_HOST_BYTES + 1U];
  uint16_t connection_port;
  uint32_t connection_ipv4_be;
  uint64_t connection_idle_deadline_us;
  pocketjs_net_http_client_transport_read_lease_t transport_read_lease;
  bool transport_read_lease_valid;
  const uint8_t *transport_read_bytes;
  size_t transport_read_maximum;
  size_t transport_read_length;
  size_t transport_read_offset;
  bool transport_read_eof_pending;
  pocketjs_net_http_client_transport_read_lease_t orphan_read_lease;
  bool orphan_read_lease_valid;
  uint64_t completion_retire_token;
  bool completion_retire_pending;

  size_t body_credit;
  bool terminal_body_pull_active;
  uint8_t body_bytes[POCKETJS_NET_HTTP_CLIENT_CORE_BODY_LEASE_BYTES];
  size_t body_byte_count;
  bool body_lease_active;
  bool body_lease_released;
  pocketjs_net_http_client_body_lease_t body_lease;

  bool terminal_selected;
  bool terminal_success;
  pocketjs_net_http_client_error_t terminal_error;
  int32_t terminal_cause;
};

_Static_assert(sizeof(struct pocketjs_net_http_client_core) <=
                   POCKETJS_NET_HTTP_CLIENT_CORE_INSTANCE_BYTES,
               "HTTP Client Core storage constant is too small");
_Static_assert(POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES + 32U <=
                   POCKETJS_NET_HTTP_CLIENT_CORE_WRITE_BYTES,
               "request chunk plus chunked framing must fit write storage");

static const pocketjs_net_http_client_core_descriptor_t descriptor = {
    .id = POCKETJS_NET_HTTP_CLIENT_CORE_ID,
    .experimental = true,
    .advertises_public_capability = false,
    .plaintext_http = true,
    .https_fail_closed_before_io = true,
    .https_explicit_opt_in = true,
    .owner_pumped = true,
    .one_operation = true,
    .fixed_core_storage = true,
    .headers_first = true,
    .explicit_body_credit = true,
    .explicit_body_lease = true,
    .connection_reuse = true,
    .bounded_connection_pool = true,
    .redirects_followed = true,
    .redirect_manual = true,
    .redirect_error = true,
    .redirect_fixed_body_replay = true,
    .redirect_streaming_body_replay = false,
    .connect_error_candidate_fallback = true,
    .hidden_retry = false,
    .hidden_auth = false,
    .hidden_cookie_store = false,
    .proxy = false,
    .content_decoding = false,
    .cleanup_faults_separate_from_terminal = true,
    .poison_is_machine_readable = true,
    .explicit_shutdown_lifecycle = true,
    .fixed_request_body = true,
    .streaming_request_body = true,
    .chunked_request_body = true,
    .known_length_streaming_request_body = true,
    .streaming_request_body_buffered_in_full = false,
    .instance_bytes = POCKETJS_NET_HTTP_CLIENT_CORE_INSTANCE_BYTES,
    .max_request_body_bytes =
        POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REQUEST_BODY_BYTES,
    .max_fixed_request_body_bytes =
        POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REQUEST_BODY_BYTES,
    .max_request_body_chunk_bytes =
        POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES,
    .body_lease_bytes = POCKETJS_NET_HTTP_CLIENT_CORE_BODY_LEASE_BYTES,
    .max_cached_connections = 1U,
};

const pocketjs_net_http_client_core_descriptor_t *
pocketjs_net_http_client_core_descriptor(void) {
  return &descriptor;
}

static bool core_is_live(const pocketjs_net_http_client_core_t *core) {
  return core != NULL && core->magic == CORE_MAGIC;
}

static bool
core_public_entry_allowed(const pocketjs_net_http_client_core_t *core) {
  return core_is_live(core) && !core->permission_callback_active;
}

static void poison_core(pocketjs_net_http_client_core_t *core,
                        pocketjs_net_http_client_poison_flag_t flag,
                        int32_t cause_code) {
  if (core->poison_flags == 0U) {
    core->first_poison_cause_code = cause_code;
  }
  core->poison_flags |= (uint32_t)flag;
}

static size_t
owned_transport_read_lease_count(const pocketjs_net_http_client_core_t *core) {
  return (core->transport_read_lease_valid ? 1U : 0U) +
         (core->orphan_read_lease_valid ? 1U : 0U);
}

static bool
core_is_quiescent_internal(const pocketjs_net_http_client_core_t *core) {
  return core->state == CORE_IDLE && core->event_state == EVENT_EMPTY &&
         !core->transport_active && !core->connection_valid &&
         !core->transport_read_lease_valid && !core->orphan_read_lease_valid &&
         !core->completion_retire_pending && !core->body_lease_active &&
         !core->request_body_pull_active && !core->permission_callback_active;
}

static bool ascii_is_alpha(uint8_t byte) {
  return (byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z');
}

static bool ascii_is_digit(uint8_t byte) { return byte >= '0' && byte <= '9'; }

static uint8_t ascii_lower(uint8_t byte) {
  return byte >= 'A' && byte <= 'Z' ? (uint8_t)(byte + ('a' - 'A')) : byte;
}

static bool ascii_equal_case(const uint8_t *left, size_t left_length,
                             const char *right) {
  size_t right_length = strlen(right);
  if (left_length != right_length) {
    return false;
  }
  for (size_t index = 0; index < left_length; ++index) {
    if (ascii_lower(left[index]) != ascii_lower((uint8_t)right[index])) {
      return false;
    }
  }
  return true;
}

static bool is_tchar(uint8_t byte) {
  return ascii_is_alpha(byte) || ascii_is_digit(byte) || byte == '!' ||
         byte == '#' || byte == '$' || byte == '%' || byte == '&' ||
         byte == '\'' || byte == '*' || byte == '+' || byte == '-' ||
         byte == '.' || byte == '^' || byte == '_' || byte == '`' ||
         byte == '|' || byte == '~';
}

static bool connection_value_is_valid(const uint8_t *value, size_t length,
                                      bool *out_close) {
  size_t offset = 0U;
  bool saw_token = false;
  while (offset < length) {
    while (offset < length && (value[offset] == ' ' || value[offset] == '\t')) {
      ++offset;
    }
    const size_t start = offset;
    while (offset < length && is_tchar(value[offset])) {
      ++offset;
    }
    if (offset == start) {
      return false;
    }
    saw_token = true;
    if (ascii_equal_case(value + start, offset - start, "close")) {
      *out_close = true;
    }
    while (offset < length && (value[offset] == ' ' || value[offset] == '\t')) {
      ++offset;
    }
    if (offset == length) {
      break;
    }
    if (value[offset++] != ',') {
      return false;
    }
    if (offset == length) {
      return false;
    }
  }
  return saw_token;
}

static bool valid_method(const uint8_t *method, size_t length) {
  if (method == NULL || length == 0U ||
      length > POCKETJS_NET_HTTP_CLIENT_CORE_MAX_METHOD_BYTES) {
    return false;
  }
  for (size_t index = 0; index < length; ++index) {
    if (!is_tchar(method[index])) {
      return false;
    }
  }
  return !ascii_equal_case(method, length, "CONNECT") &&
         !ascii_equal_case(method, length, "TRACE") &&
         !ascii_equal_case(method, length, "TRACK");
}

static bool valid_config(const pocketjs_net_http_client_core_config_t *config) {
  if (config == NULL || config->transport_ops == NULL ||
      config->allow_endpoint == NULL || config->connect_timeout_us == 0U ||
      config->headers_timeout_us == 0U || config->idle_timeout_us == 0U ||
      config->total_timeout_us == 0U ||
      config->response_header_bytes_limit >
          POCKETJS_NET_HTTP_CLIENT_CORE_MAX_RESPONSE_HEADER_BYTES) {
    return false;
  }
  const pocketjs_net_http_client_transport_ops_t *ops = config->transport_ops;
  return ops->start_resolve != NULL && ops->start_connect != NULL &&
         ops->start_read != NULL && ops->start_write != NULL &&
         ops->start_close != NULL && ops->cancel != NULL && ops->pump != NULL &&
         ops->take_completion != NULL && ops->retire_completion != NULL &&
         ops->read_lease_view != NULL && ops->release_read_lease != NULL;
}

static uint64_t deadline_after(uint64_t now_us, uint64_t duration_us) {
  return duration_us > UINT64_MAX - now_us ? UINT64_MAX : now_us + duration_us;
}

static uint64_t earlier_deadline(uint64_t left, uint64_t right) {
  return left < right ? left : right;
}

static bool next_transport_token(pocketjs_net_http_client_core_t *core,
                                 uint64_t *out_token) {
  if (core->last_transport_token == UINT64_MAX) {
    return false;
  }
  ++core->last_transport_token;
  *out_token = core->last_transport_token;
  return true;
}

static bool next_event_sequence(pocketjs_net_http_client_core_t *core,
                                uint64_t *out_sequence) {
  if (core->event_sequence == UINT64_MAX) {
    return false;
  }
  ++core->event_sequence;
  *out_sequence = core->event_sequence;
  return true;
}

static bool parse_ipv4(const uint8_t *data, size_t length,
                       uint32_t *out_ipv4_be) {
  uint8_t octets[4];
  size_t index = 0U;
  for (size_t part = 0U; part < 4U; ++part) {
    size_t start = index;
    unsigned value = 0U;
    while (index < length && ascii_is_digit(data[index])) {
      unsigned digit = (unsigned)(data[index] - '0');
      if (value > (255U - digit) / 10U) {
        return false;
      }
      value = value * 10U + digit;
      ++index;
    }
    if (index == start || (index - start > 1U && data[start] == '0')) {
      return false;
    }
    octets[part] = (uint8_t)value;
    if (part == 3U) {
      if (index != length) {
        return false;
      }
    } else if (index == length || data[index++] != '.') {
      return false;
    }
  }
  memcpy(out_ipv4_be, octets, sizeof(octets));
  return true;
}

static bool looks_numeric_host(const uint8_t *data, size_t length) {
  if (length == 0U) {
    return false;
  }
  for (size_t index = 0U; index < length; ++index) {
    if (!ascii_is_digit(data[index]) && data[index] != '.') {
      return false;
    }
  }
  return true;
}

static bool canonicalize_dns_name(const uint8_t *data, size_t length,
                                  char *output) {
  if (length == 0U || length > POCKETJS_NET_HTTP_CLIENT_CORE_MAX_HOST_BYTES ||
      data[length - 1U] == '.') {
    return false;
  }
  size_t label_start = 0U;
  for (size_t index = 0U; index <= length; ++index) {
    if (index != length && data[index] != '.') {
      uint8_t byte = data[index];
      if (!ascii_is_alpha(byte) && !ascii_is_digit(byte) && byte != '-') {
        return false;
      }
      output[index] = (char)ascii_lower(byte);
      continue;
    }
    size_t label_length = index - label_start;
    if (label_length == 0U || label_length > 63U ||
        output[label_start] == '-' || output[index - 1U] == '-') {
      return false;
    }
    if (index != length) {
      output[index] = '.';
      label_start = index + 1U;
    }
  }
  output[length] = '\0';
  return true;
}

static bool parse_port(const uint8_t *data, size_t length, uint16_t *out_port) {
  if (length == 0U || (length > 1U && data[0] == '0')) {
    return false;
  }
  unsigned value = 0U;
  for (size_t index = 0U; index < length; ++index) {
    if (!ascii_is_digit(data[index])) {
      return false;
    }
    unsigned digit = (unsigned)(data[index] - '0');
    if (value > (65535U - digit) / 10U) {
      return false;
    }
    value = value * 10U + digit;
  }
  if (value == 0U) {
    return false;
  }
  *out_port = (uint16_t)value;
  return true;
}

static size_t write_port(uint16_t port, char output[5]) {
  char reversed[5];
  size_t length = 0U;
  do {
    reversed[length++] = (char)('0' + port % 10U);
    port = (uint16_t)(port / 10U);
  } while (port != 0U);
  for (size_t index = 0U; index < length; ++index) {
    output[index] = reversed[length - index - 1U];
  }
  return length;
}

static bool parse_url(pocketjs_net_http_client_core_t *core,
                      pocketjs_net_http_client_slice_t url) {
  if (url.data == NULL || url.length == 0U ||
      url.length > POCKETJS_NET_HTTP_CLIENT_CORE_MAX_URL_BYTES) {
    return false;
  }
  size_t scheme_bytes = 0U;
  uint16_t default_port = 0U;
  if (url.length >= 7U && ascii_equal_case(url.data, 7U, "http://")) {
    core->scheme = POCKETJS_NET_HTTP_CLIENT_SCHEME_HTTP;
    scheme_bytes = 7U;
    default_port = 80U;
  } else if (url.length >= 8U && ascii_equal_case(url.data, 8U, "https://")) {
    core->scheme = POCKETJS_NET_HTTP_CLIENT_SCHEME_HTTPS;
    scheme_bytes = 8U;
    default_port = 443U;
  } else {
    return false;
  }

  for (size_t index = scheme_bytes; index < url.length; ++index) {
    if (url.data[index] == '#') {
      return false;
    }
  }

  size_t authority_end = scheme_bytes;
  while (authority_end < url.length && url.data[authority_end] != '/' &&
         url.data[authority_end] != '?') {
    if (url.data[authority_end] == '@' || url.data[authority_end] == '[' ||
        url.data[authority_end] == ']') {
      return false;
    }
    ++authority_end;
  }
  if (authority_end == scheme_bytes) {
    return false;
  }

  size_t colon = authority_end;
  for (size_t index = scheme_bytes; index < authority_end; ++index) {
    if (url.data[index] == ':') {
      if (colon != authority_end) {
        return false;
      }
      colon = index;
    }
  }
  size_t hostname_length = colon - scheme_bytes;
  if (hostname_length == 0U ||
      hostname_length > POCKETJS_NET_HTTP_CLIENT_CORE_MAX_HOST_BYTES) {
    return false;
  }
  core->port = default_port;
  if (colon != authority_end &&
      !parse_port(url.data + colon + 1U, authority_end - colon - 1U,
                  &core->port)) {
    return false;
  }

  core->numeric_host = parse_ipv4(url.data + scheme_bytes, hostname_length,
                                  &core->numeric_ipv4_be);
  if (!core->numeric_host) {
    if (looks_numeric_host(url.data + scheme_bytes, hostname_length) ||
        !canonicalize_dns_name(url.data + scheme_bytes, hostname_length,
                               core->hostname)) {
      return false;
    }
  } else {
    memcpy(core->hostname, url.data + scheme_bytes, hostname_length);
    core->hostname[hostname_length] = '\0';
  }

  size_t target_length = 0U;
  if (authority_end == url.length) {
    core->target[target_length++] = '/';
  } else if (url.data[authority_end] == '?') {
    if (url.length - authority_end + 1U > sizeof(core->target)) {
      return false;
    }
    core->target[target_length++] = '/';
    memcpy(core->target + target_length, url.data + authority_end,
           url.length - authority_end);
    target_length += url.length - authority_end;
  } else {
    if (url.length - authority_end > sizeof(core->target)) {
      return false;
    }
    memcpy(core->target, url.data + authority_end, url.length - authority_end);
    target_length = url.length - authority_end;
  }
  core->target_length = target_length;

  memcpy(core->host_field, core->hostname, hostname_length);
  size_t host_length = hostname_length;
  if (core->port != default_port) {
    core->host_field[host_length++] = ':';
    host_length += write_port(core->port, core->host_field + host_length);
  }
  core->host_field[host_length] = '\0';
  return true;
}

static bool ascii_is_hex(uint8_t byte) {
  return ascii_is_digit(byte) || (byte >= 'A' && byte <= 'F') ||
         (byte >= 'a' && byte <= 'f');
}

static bool redirect_status(unsigned status) {
  return status == 301U || status == 302U || status == 303U || status == 307U ||
         status == 308U;
}

static bool append_bytes(uint8_t *output, size_t capacity, size_t *used,
                         const void *bytes, size_t length) {
  if (*used > capacity || length > capacity - *used) {
    return false;
  }
  if (length != 0U) {
    memcpy(output + *used, bytes, length);
  }
  *used += length;
  return true;
}

static bool append_current_origin(const pocketjs_net_http_client_core_t *core,
                                  uint8_t *output, size_t capacity,
                                  size_t *used) {
  static const uint8_t http[] = "http://";
  static const uint8_t https[] = "https://";
  const uint8_t *scheme =
      core->scheme == POCKETJS_NET_HTTP_CLIENT_SCHEME_HTTPS ? https : http;
  const size_t scheme_length =
      core->scheme == POCKETJS_NET_HTTP_CLIENT_SCHEME_HTTPS ? sizeof(https) - 1U
                                                            : sizeof(http) - 1U;
  const size_t host_length = strlen(core->host_field);
  return append_bytes(output, capacity, used, scheme, scheme_length) &&
         append_bytes(output, capacity, used, core->host_field, host_length);
}

static bool serialize_current_url(const pocketjs_net_http_client_core_t *core,
                                  uint8_t *output, size_t capacity,
                                  size_t *out_length) {
  size_t used = 0U;
  if (!append_current_origin(core, output, capacity, &used) ||
      !append_bytes(output, capacity, &used, core->target,
                    core->target_length)) {
    return false;
  }
  *out_length = used;
  return true;
}

static bool redirect_dot_segment(const uint8_t *segment, size_t length) {
  return (length == 1U && segment[0] == '.') ||
         (length == 3U && segment[0] == '%' && segment[1] == '2' &&
          ascii_lower(segment[2]) == 'e');
}

static bool redirect_double_dot_segment(const uint8_t *segment, size_t length) {
  if (length == 2U && segment[0] == '.' && segment[1] == '.') {
    return true;
  }
  uint8_t lowered[6];
  if (length > sizeof(lowered)) {
    return false;
  }
  for (size_t index = 0U; index < length; ++index) {
    lowered[index] = ascii_lower(segment[index]);
  }
  static const uint8_t left_encoded[] = ".%2e";
  static const uint8_t right_encoded[] = "%2e.";
  static const uint8_t both_encoded[] = "%2e%2e";
  return (length == sizeof(left_encoded) - 1U &&
          memcmp(lowered, left_encoded, length) == 0) ||
         (length == sizeof(right_encoded) - 1U &&
          memcmp(lowered, right_encoded, length) == 0) ||
         (length == sizeof(both_encoded) - 1U &&
          memcmp(lowered, both_encoded, length) == 0);
}

static bool normalize_redirect_target(pocketjs_net_http_client_core_t *core) {
  if (core->target_length == 0U || core->target[0] != '/') {
    return false;
  }
  size_t path_length = core->target_length;
  for (size_t index = 0U; index < core->target_length; ++index) {
    const uint8_t byte = core->target[index];
    if (byte == '?') {
      path_length = index;
      break;
    }
    if (byte <= 0x20U || byte >= 0x7fU || byte == '\\' || byte == '#') {
      return false;
    }
    if (byte == '%' && (index + 2U >= core->target_length ||
                        !ascii_is_hex(core->target[index + 1U]) ||
                        !ascii_is_hex(core->target[index + 2U]))) {
      return false;
    }
  }
  for (size_t index = path_length; index < core->target_length; ++index) {
    const uint8_t byte = core->target[index];
    if (byte <= 0x20U || byte >= 0x7fU || byte == '\\' || byte == '#') {
      return false;
    }
    if (byte == '%' && (index + 2U >= core->target_length ||
                        !ascii_is_hex(core->target[index + 1U]) ||
                        !ascii_is_hex(core->target[index + 2U]))) {
      return false;
    }
  }

  size_t output_length = 1U;
  core->write_bytes[0] = '/';
  size_t segment_start = 1U;
  for (size_t cursor = 1U; cursor <= path_length; ++cursor) {
    if (cursor < path_length && core->target[cursor] != '/') {
      continue;
    }
    const size_t segment_length = cursor - segment_start;
    const bool slash_follows = cursor < path_length;
    const uint8_t *segment = core->target + segment_start;
    if (redirect_dot_segment(segment, segment_length)) {
      if (!slash_follows && core->write_bytes[output_length - 1U] != '/') {
        core->write_bytes[output_length++] = '/';
      }
    } else if (redirect_double_dot_segment(segment, segment_length)) {
      if (output_length > 1U && core->write_bytes[output_length - 1U] == '/') {
        --output_length;
      }
      while (output_length > 1U &&
             core->write_bytes[output_length - 1U] != '/') {
        --output_length;
      }
    } else {
      if (!append_bytes(core->write_bytes, sizeof(core->write_bytes),
                        &output_length, segment, segment_length) ||
          (slash_follows &&
           !append_bytes(core->write_bytes, sizeof(core->write_bytes),
                         &output_length, "/", 1U))) {
        return false;
      }
    }
    segment_start = cursor + 1U;
  }
  if (!append_bytes(core->write_bytes, sizeof(core->write_bytes),
                    &output_length, core->target + path_length,
                    core->target_length - path_length) ||
      output_length > sizeof(core->target)) {
    return false;
  }
  memcpy(core->target, core->write_bytes, output_length);
  core->target_length = output_length;
  return true;
}

static bool resolve_redirect_url(pocketjs_net_http_client_core_t *core,
                                 bool *out_cross_origin) {
  const uint8_t *location = core->redirect_location.data;
  size_t start = 0U;
  size_t end = core->redirect_location.length;
  while (start < end && location[start] <= 0x20U) {
    ++start;
  }
  while (end > start && location[end - 1U] <= 0x20U) {
    --end;
  }
  for (size_t index = start; index < end; ++index) {
    if (location[index] == '#') {
      end = index;
      break;
    }
    if (location[index] <= 0x20U || location[index] >= 0x7fU ||
        location[index] == '\\') {
      return false;
    }
  }

  const pocketjs_net_http_client_scheme_t previous_scheme = core->scheme;
  const uint16_t previous_port = core->port;
  char previous_hostname[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_HOST_BYTES + 1U];
  memcpy(previous_hostname, core->hostname, strlen(core->hostname) + 1U);

  uint8_t *candidate = core->write_bytes;
  const size_t candidate_capacity = POCKETJS_NET_HTTP_CLIENT_CORE_MAX_URL_BYTES;
  size_t candidate_length = 0U;
  const size_t location_length = end - start;
  const uint8_t *value = location + start;
  const bool absolute_http =
      location_length >= 7U && ascii_equal_case(value, 7U, "http://");
  const bool absolute_https =
      location_length >= 8U && ascii_equal_case(value, 8U, "https://");

  if (absolute_http || absolute_https) {
    if (!append_bytes(candidate, candidate_capacity, &candidate_length, value,
                      location_length)) {
      return false;
    }
  } else if (location_length >= 2U && value[0] == '/' && value[1] == '/') {
    static const uint8_t http_prefix[] = "http:";
    static const uint8_t https_prefix[] = "https:";
    const uint8_t *prefix =
        core->scheme == POCKETJS_NET_HTTP_CLIENT_SCHEME_HTTPS ? https_prefix
                                                              : http_prefix;
    const size_t prefix_length =
        core->scheme == POCKETJS_NET_HTTP_CLIENT_SCHEME_HTTPS
            ? sizeof(https_prefix) - 1U
            : sizeof(http_prefix) - 1U;
    if (!append_bytes(candidate, candidate_capacity, &candidate_length, prefix,
                      prefix_length) ||
        !append_bytes(candidate, candidate_capacity, &candidate_length, value,
                      location_length)) {
      return false;
    }
  } else {
    for (size_t index = 0U; index < location_length; ++index) {
      if (value[index] == '/' || value[index] == '?') {
        break;
      }
      if (value[index] == ':') {
        return false;
      }
    }
    if (!append_current_origin(core, candidate, candidate_capacity,
                               &candidate_length)) {
      return false;
    }
    size_t base_path_length = core->target_length;
    for (size_t index = 0U; index < core->target_length; ++index) {
      if (core->target[index] == '?') {
        base_path_length = index;
        break;
      }
    }
    if (location_length == 0U) {
      if (!append_bytes(candidate, candidate_capacity, &candidate_length,
                        core->target, core->target_length)) {
        return false;
      }
    } else if (value[0] == '/') {
      if (!append_bytes(candidate, candidate_capacity, &candidate_length, value,
                        location_length)) {
        return false;
      }
    } else if (value[0] == '?') {
      if (!append_bytes(candidate, candidate_capacity, &candidate_length,
                        core->target, base_path_length) ||
          !append_bytes(candidate, candidate_capacity, &candidate_length, value,
                        location_length)) {
        return false;
      }
    } else {
      size_t directory_length = base_path_length;
      while (directory_length > 0U &&
             core->target[directory_length - 1U] != '/') {
        --directory_length;
      }
      if (!append_bytes(candidate, candidate_capacity, &candidate_length,
                        core->target, directory_length) ||
          !append_bytes(candidate, candidate_capacity, &candidate_length, value,
                        location_length)) {
        return false;
      }
    }
  }

  if (!parse_url(core,
                 (pocketjs_net_http_client_slice_t){
                     .data = candidate,
                     .length = candidate_length,
                 }) ||
      !normalize_redirect_target(core)) {
    return false;
  }
  *out_cross_origin = previous_scheme != core->scheme ||
                      previous_port != core->port ||
                      strcmp(previous_hostname, core->hostname) != 0;
  return true;
}

static bool
base_tls_policy_valid(const pocketjs_net_http_client_core_t *core,
                      const pocketjs_net_http_client_tls_policy_t *policy) {
  if (policy == NULL ||
      (policy->server_name.length != 0U && policy->server_name.data == NULL) ||
      (policy->credential.length != 0U && policy->credential.data == NULL) ||
      policy->minimum_version != POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_2 ||
      policy->maximum_version != POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_2 ||
      policy->alpn_count != 0U || policy->credential.length != 0U ||
      policy->client_certificate !=
          POCKETJS_NET_HTTP_CLIENT_TLS_CLIENT_CERTIFICATE_NONE ||
      policy->verification != POCKETJS_NET_HTTP_CLIENT_TLS_VERIFICATION_FULL ||
      policy->revocation !=
          POCKETJS_NET_HTTP_CLIENT_TLS_REVOCATION_HOST_DEFAULT ||
      policy->custom_ca_bytes != 0U || core->numeric_host) {
    return false;
  }
  const size_t hostname_length = strlen(core->hostname);
  return policy->server_name.length == hostname_length &&
         memcmp(policy->server_name.data, core->hostname, hostname_length) == 0;
}

static bool forbidden_request_header(const uint8_t *name, size_t length) {
  static const char *const forbidden[] = {
      "host",
      "content-length",
      "transfer-encoding",
      "trailer",
      "connection",
      "keep-alive",
      "proxy-connection",
      "proxy-authorization",
      "proxy-authenticate",
      "te",
      "upgrade",
      "accept-encoding",
  };
  for (size_t index = 0U; index < sizeof(forbidden) / sizeof(forbidden[0]);
       ++index) {
    if (ascii_equal_case(name, length, forbidden[index])) {
      return true;
    }
  }
  static const char proxy_prefix[] = "proxy-";
  if (length >= sizeof(proxy_prefix) - 1U) {
    bool matches = true;
    for (size_t index = 0U; index < sizeof(proxy_prefix) - 1U; ++index) {
      if (ascii_lower(name[index]) != (uint8_t)proxy_prefix[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return true;
    }
  }
  return false;
}

static bool redirect_body_header(const uint8_t *name, size_t length) {
  return ascii_equal_case(name, length, "Content-Encoding") ||
         ascii_equal_case(name, length, "Content-Language") ||
         ascii_equal_case(name, length, "Content-Location") ||
         ascii_equal_case(name, length, "Content-Type");
}

static bool redirect_sensitive_header(const uint8_t *name, size_t length) {
  return ascii_equal_case(name, length, "Authorization") ||
         ascii_equal_case(name, length, "Proxy-Authorization") ||
         ascii_equal_case(name, length, "Cookie");
}

static void filter_redirect_headers(pocketjs_net_http_client_core_t *core,
                                    bool remove_body_headers,
                                    bool remove_sensitive_headers) {
  size_t output = 0U;
  for (size_t index = 0U; index < core->request_header_count; ++index) {
    const pocketjs_net_http1_header_t header = core->request_headers[index];
    if ((remove_body_headers &&
         redirect_body_header(header.name.data, header.name.length)) ||
        (remove_sensitive_headers &&
         redirect_sensitive_header(header.name.data, header.name.length))) {
      continue;
    }
    core->request_headers[output++] = header;
  }
  core->request_header_count = output;
}

static pocketjs_net_http_client_start_result_t
initialize_request_encoder(pocketjs_net_http_client_core_t *core) {
  pocketjs_net_http1_request_body_kind_t wire_body_kind =
      POCKETJS_NET_HTTP1_REQUEST_BODY_NONE;
  uint64_t wire_content_length = 0U;
  if (core->request_body_kind == POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_FIXED) {
    wire_body_kind = POCKETJS_NET_HTTP1_REQUEST_BODY_FIXED;
    wire_content_length = core->request_body_length;
  } else if (core->request_body_kind ==
             POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_STREAMING) {
    wire_body_kind = core->request_body_length_known
                         ? POCKETJS_NET_HTTP1_REQUEST_BODY_FIXED
                         : POCKETJS_NET_HTTP1_REQUEST_BODY_CHUNKED;
    wire_content_length = core->request_body_expected_length;
  }

  pocketjs_net_http1_request_t wire_request = {
      .method = {.data = core->method, .length = core->method_length},
      .target = {.data = core->target, .length = core->target_length},
      .host = {.data = (const uint8_t *)core->host_field,
               .length = strlen(core->host_field)},
      .headers = core->request_headers,
      .header_count = core->request_header_count,
      .body_kind = wire_body_kind,
      .content_length = wire_content_length,
  };
  pocketjs_net_http1_wire_error_t wire_error =
      pocketjs_net_http1_request_encoder_init(
          &core->encoder, &wire_request, &pocketjs_net_http1_default_limits);
  if (wire_error == POCKETJS_NET_HTTP1_WIRE_ERROR_NONE) {
    return POCKETJS_NET_HTTP_CLIENT_START_OK;
  }
  return pocketjs_net_http1_wire_error_is_limit(wire_error)
             ? POCKETJS_NET_HTTP_CLIENT_START_LIMIT_EXCEEDED
             : POCKETJS_NET_HTTP_CLIENT_START_FORBIDDEN_REQUEST;
}

static pocketjs_net_http_client_start_result_t
snapshot_request(pocketjs_net_http_client_core_t *core,
                 const pocketjs_net_http_client_request_t *request) {
  if (request == NULL || request->operation_token == 0U ||
      (request->header_count != 0U && request->headers == NULL) ||
      request->body_kind > POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_STREAMING ||
      request->redirect_mode > POCKETJS_NET_HTTP_CLIENT_REDIRECT_ERROR ||
      request->max_redirects > POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REDIRECTS ||
      (request->body.length != 0U && request->body.data == NULL)) {
    return POCKETJS_NET_HTTP_CLIENT_START_INVALID_ARGUMENT;
  }
  switch (request->body_kind) {
  case POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_NONE:
    if (request->body.length != 0U || request->streaming_content_length_known ||
        request->streaming_content_length != 0U) {
      return POCKETJS_NET_HTTP_CLIENT_START_INVALID_ARGUMENT;
    }
    break;
  case POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_FIXED:
    if (request->streaming_content_length_known ||
        request->streaming_content_length != 0U) {
      return POCKETJS_NET_HTTP_CLIENT_START_INVALID_ARGUMENT;
    }
    if (request->body.length >
        POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REQUEST_BODY_BYTES) {
      return POCKETJS_NET_HTTP_CLIENT_START_LIMIT_EXCEEDED;
    }
    break;
  case POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_STREAMING:
    if (request->body.length != 0U ||
        (!request->streaming_content_length_known &&
         request->streaming_content_length != 0U)) {
      return POCKETJS_NET_HTTP_CLIENT_START_INVALID_ARGUMENT;
    }
    if (core->last_request_body_generation == UINT64_MAX ||
        core->last_request_body_pull_generation == UINT64_MAX) {
      return POCKETJS_NET_HTTP_CLIENT_START_TOKEN_EXHAUSTED;
    }
    break;
  default:
    return POCKETJS_NET_HTTP_CLIENT_START_INVALID_ARGUMENT;
  }
  if (core->last_operation_token == UINT64_MAX) {
    return POCKETJS_NET_HTTP_CLIENT_START_TOKEN_EXHAUSTED;
  }
  if (request->operation_token <= core->last_operation_token) {
    return POCKETJS_NET_HTTP_CLIENT_START_INVALID_ARGUMENT;
  }
  if (!parse_url(core, request->url)) {
    return POCKETJS_NET_HTTP_CLIENT_START_INVALID_URL;
  }
  if (core->scheme == POCKETJS_NET_HTTP_CLIENT_SCHEME_HTTPS) {
    if (!core->config.allow_https ||
        !base_tls_policy_valid(core, request->tls)) {
      return POCKETJS_NET_HTTP_CLIENT_START_UNSUPPORTED_TLS;
    }
  } else if (request->tls != NULL) {
    return POCKETJS_NET_HTTP_CLIENT_START_UNSUPPORTED_TLS;
  }
  if (!valid_method(request->method.data, request->method.length)) {
    return POCKETJS_NET_HTTP_CLIENT_START_FORBIDDEN_REQUEST;
  }
  if (request->header_count >
      POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REQUEST_HEADERS) {
    return POCKETJS_NET_HTTP_CLIENT_START_LIMIT_EXCEEDED;
  }
  if (request->body_kind != POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_NONE &&
      (ascii_equal_case(request->method.data, request->method.length, "GET") ||
       ascii_equal_case(request->method.data, request->method.length,
                        "HEAD"))) {
    return POCKETJS_NET_HTTP_CLIENT_START_FORBIDDEN_REQUEST;
  }

  memcpy(core->method, request->method.data, request->method.length);
  core->method_length = request->method.length;
  core->request_header_storage_used = 0U;
  core->request_header_count = 0U;
  for (size_t index = 0U; index < request->header_count; ++index) {
    pocketjs_net_http_client_header_t header = request->headers[index];
    if (header.name.data == NULL || header.name.length == 0U ||
        (header.value.length != 0U && header.value.data == NULL)) {
      return POCKETJS_NET_HTTP_CLIENT_START_INVALID_ARGUMENT;
    }
    if (forbidden_request_header(header.name.data, header.name.length)) {
      return POCKETJS_NET_HTTP_CLIENT_START_FORBIDDEN_REQUEST;
    }
    if (header.name.length > sizeof(core->request_header_storage) -
                                 core->request_header_storage_used ||
        header.value.length > sizeof(core->request_header_storage) -
                                  core->request_header_storage_used -
                                  header.name.length) {
      return POCKETJS_NET_HTTP_CLIENT_START_LIMIT_EXCEEDED;
    }
    uint8_t *name =
        core->request_header_storage + core->request_header_storage_used;
    memcpy(name, header.name.data, header.name.length);
    core->request_header_storage_used += header.name.length;
    uint8_t *value =
        core->request_header_storage + core->request_header_storage_used;
    if (header.value.length != 0U) {
      memcpy(value, header.value.data, header.value.length);
    }
    core->request_header_storage_used += header.value.length;
    core->request_headers[core->request_header_count++] =
        (pocketjs_net_http1_header_t){
            .name = {.data = name, .length = header.name.length},
            .value = {.data = value, .length = header.value.length},
        };
  }
  static const uint8_t connection_name[] = "Connection";
  static const uint8_t connection_value[] = "close";
  static const uint8_t encoding_name[] = "Accept-Encoding";
  static const uint8_t encoding_value[] = "identity";
  if (!core->config.enable_connection_reuse) {
    core->request_headers[core->request_header_count++] =
        (pocketjs_net_http1_header_t){
            .name = {.data = connection_name,
                     .length = sizeof(connection_name) - 1U},
            .value = {.data = connection_value,
                      .length = sizeof(connection_value) - 1U},
        };
  }
  core->request_headers[core->request_header_count++] =
      (pocketjs_net_http1_header_t){
          .name = {.data = encoding_name, .length = sizeof(encoding_name) - 1U},
          .value = {.data = encoding_value,
                    .length = sizeof(encoding_value) - 1U},
      };
  if (request->body_kind == POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_FIXED &&
      request->body.length != 0U) {
    memcpy(core->request_body, request->body.data, request->body.length);
  }
  core->request_body_kind = request->body_kind;
  core->request_body_length =
      request->body_kind == POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_FIXED
          ? request->body.length
          : 0U;
  core->request_body_length_known =
      request->body_kind == POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_STREAMING &&
      request->streaming_content_length_known;
  core->request_body_expected_length =
      core->request_body_length_known ? request->streaming_content_length : 0U;
  core->request_body_submitted_length = 0U;
  core->request_body_pending_payload_length = 0U;
  core->request_body_pull_active = false;
  core->request_body_pull_event_retired = false;
  core->redirect_mode = request->redirect_mode;
  core->redirect_count = 0U;
  core->max_redirects = request->max_redirects;
  core->redirect_pending = false;
  return initialize_request_encoder(core);
}

static bool publish_event(pocketjs_net_http_client_core_t *core,
                          pocketjs_net_http_client_event_type_t type) {
  uint64_t sequence = 0U;
  bool terminal = type == POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE ||
                  type == POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR;
  if (core->event_state != EVENT_EMPTY ||
      (!terminal && core->event_sequence >= UINT64_MAX - 1U) ||
      !next_event_sequence(core, &sequence)) {
    return false;
  }
  memset(&core->event, 0, sizeof(core->event));
  core->event.type = type;
  core->event.sequence = sequence;
  core->event.operation_token = core->operation_token;
  core->event_state = EVENT_PENDING;
  return true;
}

typedef enum {
  REDIRECT_DECISION_PUBLISH = 0,
  REDIRECT_DECISION_FOLLOW,
  REDIRECT_DECISION_FAIL,
} redirect_decision_t;

static redirect_decision_t
prepare_redirect(pocketjs_net_http_client_core_t *core) {
  if (!redirect_status(core->response_status) ||
      core->redirect_mode == POCKETJS_NET_HTTP_CLIENT_REDIRECT_MANUAL) {
    return REDIRECT_DECISION_PUBLISH;
  }
  if (core->redirect_mode == POCKETJS_NET_HTTP_CLIENT_REDIRECT_ERROR) {
    core->callback_error = POCKETJS_NET_HTTP_CLIENT_ERROR_REDIRECT;
    return REDIRECT_DECISION_FAIL;
  }
  if (!core->redirect_location_seen) {
    return REDIRECT_DECISION_PUBLISH;
  }
  if (core->redirect_count >= core->max_redirects) {
    core->callback_error = POCKETJS_NET_HTTP_CLIENT_ERROR_REDIRECT_LIMIT;
    return REDIRECT_DECISION_FAIL;
  }

  const bool rewrite_get =
      ((core->response_status == 301U || core->response_status == 302U) &&
       ascii_equal_case(core->method, core->method_length, "POST")) ||
      (core->response_status == 303U &&
       !ascii_equal_case(core->method, core->method_length, "HEAD"));
  if (!rewrite_get && core->request_body_kind ==
                          POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_STREAMING) {
    core->callback_error =
        POCKETJS_NET_HTTP_CLIENT_ERROR_REDIRECT_BODY_NOT_REPLAYABLE;
    return REDIRECT_DECISION_FAIL;
  }

  bool cross_origin = false;
  if (!resolve_redirect_url(core, &cross_origin)) {
    core->callback_error = POCKETJS_NET_HTTP_CLIENT_ERROR_REDIRECT;
    return REDIRECT_DECISION_FAIL;
  }
  if (core->scheme == POCKETJS_NET_HTTP_CLIENT_SCHEME_HTTPS &&
      (!core->config.allow_https || core->numeric_host)) {
    core->callback_error = POCKETJS_NET_HTTP_CLIENT_ERROR_UNSUPPORTED;
    return REDIRECT_DECISION_FAIL;
  }

  if (rewrite_get) {
    static const uint8_t get[] = "GET";
    memcpy(core->method, get, sizeof(get) - 1U);
    core->method_length = sizeof(get) - 1U;
    core->request_body_kind = POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_NONE;
    core->request_body_length = 0U;
    core->request_body_length_known = false;
    core->request_body_expected_length = 0U;
    core->request_body_submitted_length = 0U;
    core->request_body_pending_payload_length = 0U;
    core->request_body_pull_active = false;
    core->request_body_pull_event_retired = false;
  }
  filter_redirect_headers(core, rewrite_get, cross_origin);
  const pocketjs_net_http_client_start_result_t encoder_result =
      initialize_request_encoder(core);
  if (encoder_result != POCKETJS_NET_HTTP_CLIENT_START_OK) {
    core->callback_error =
        encoder_result == POCKETJS_NET_HTTP_CLIENT_START_LIMIT_EXCEEDED
            ? POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT
            : POCKETJS_NET_HTTP_CLIENT_ERROR_REDIRECT;
    return REDIRECT_DECISION_FAIL;
  }

  ++core->redirect_count;
  core->redirect_pending = true;
  return REDIRECT_DECISION_FOLLOW;
}

static bool publish_headers(pocketjs_net_http_client_core_t *core) {
  size_t url_length = 0U;
  if (!serialize_current_url(core, core->write_bytes,
                             POCKETJS_NET_HTTP_CLIENT_CORE_MAX_URL_BYTES,
                             &url_length)) {
    return false;
  }
  if (!publish_event(core, POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS)) {
    return false;
  }
  core->event.detail.response.status_code = core->response_status;
  core->event.detail.response.status_text = core->response_status_text;
  core->event.detail.response.headers = core->response_headers;
  core->event.detail.response.header_count = core->response_header_count;
  core->event.detail.response.url = (pocketjs_net_http_client_slice_t){
      .data = core->write_bytes,
      .length = url_length,
  };
  core->event.detail.response.redirected = core->redirect_count != 0U;
  return true;
}

static bool publish_terminal(pocketjs_net_http_client_core_t *core) {
  pocketjs_net_http_client_event_type_t type =
      core->terminal_success ? POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE
                             : POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR;
  if (!publish_event(core, type)) {
    return false;
  }
  if (!core->terminal_success) {
    core->event.detail.error.code = core->terminal_error;
    core->event.detail.error.cause_code = core->terminal_cause;
  }
  core->state = CORE_WAITING_TERMINAL_RETIRE;
  return true;
}

static bool response_on_status(void *context, unsigned http_minor,
                               unsigned status_code, const uint8_t *status_text,
                               size_t status_text_length, bool informational) {
  pocketjs_net_http_client_core_t *core = context;
  if (informational) {
    return true;
  }
  core->callback_error = 0;
  core->force_no_body = false;
  core->response_header_storage_used = 0U;
  core->response_header_field_bytes = 0U;
  core->response_header_count = 0U;
  core->redirect_location_seen = false;
  core->redirect_location = (pocketjs_net_http_client_slice_t){0};
  core->response_status = status_code;
  core->response_http_minor = http_minor;
  core->response_body_kind = POCKETJS_NET_HTTP1_RESPONSE_BODY_NONE;
  core->response_connection_close = false;
  core->response_connection_reusable = false;
  if (status_text_length > sizeof(core->response_header_storage)) {
    core->callback_error = POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT;
    return false;
  }
  uint8_t *copy = core->response_header_storage;
  if (status_text_length != 0U) {
    memcpy(copy, status_text, status_text_length);
  }
  core->response_header_storage_used = status_text_length;
  core->response_status_text = (pocketjs_net_http_client_slice_t){
      .data = copy,
      .length = status_text_length,
  };
  return true;
}

static bool response_on_header(void *context, const uint8_t *name,
                               size_t name_length, const uint8_t *value,
                               size_t value_length, bool informational) {
  pocketjs_net_http_client_core_t *core = context;
  if (informational) {
    return true;
  }
  if (ascii_equal_case(name, name_length, "Content-Encoding") &&
      !ascii_equal_case(value, value_length, "identity")) {
    core->callback_error = POCKETJS_NET_HTTP_CLIENT_ERROR_PROTOCOL;
    return false;
  }
  if (ascii_equal_case(name, name_length, "Connection") &&
      !connection_value_is_valid(value, value_length,
                                 &core->response_connection_close)) {
    core->callback_error = POCKETJS_NET_HTTP_CLIENT_ERROR_PROTOCOL;
    return false;
  }
  const size_t header_limit =
      core->config.response_header_bytes_limit == 0U
          ? POCKETJS_NET_HTTP_CLIENT_CORE_MAX_RESPONSE_HEADER_BYTES
          : core->config.response_header_bytes_limit;
  if (value_length > SIZE_MAX - 4U ||
      name_length > SIZE_MAX - value_length - 4U) {
    core->callback_error = POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT;
    return false;
  }
  const size_t field_bytes = name_length + value_length + 4U;
  if (field_bytes > header_limit ||
      core->response_header_field_bytes > header_limit - field_bytes) {
    core->callback_error = POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT;
    return false;
  }
  if (core->response_header_count >=
          POCKETJS_NET_HTTP_CLIENT_CORE_MAX_RESPONSE_HEADERS ||
      name_length > sizeof(core->response_header_storage) -
                        core->response_header_storage_used ||
      value_length > sizeof(core->response_header_storage) -
                         core->response_header_storage_used - name_length) {
    core->callback_error = POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT;
    return false;
  }
  uint8_t *name_copy =
      core->response_header_storage + core->response_header_storage_used;
  memcpy(name_copy, name, name_length);
  core->response_header_storage_used += name_length;
  uint8_t *value_copy =
      core->response_header_storage + core->response_header_storage_used;
  if (value_length != 0U) {
    memcpy(value_copy, value, value_length);
  }
  core->response_header_storage_used += value_length;
  core->response_header_field_bytes += field_bytes;
  core->response_headers[core->response_header_count++] =
      (pocketjs_net_http_client_header_t){
          .name = {.data = name_copy, .length = name_length},
          .value = {.data = value_copy, .length = value_length},
      };
  if (redirect_status(core->response_status) &&
      core->redirect_mode == POCKETJS_NET_HTTP_CLIENT_REDIRECT_FOLLOW &&
      ascii_equal_case(name, name_length, "Location")) {
    if (core->redirect_location_seen) {
      core->callback_error = POCKETJS_NET_HTTP_CLIENT_ERROR_REDIRECT;
      return false;
    }
    core->redirect_location_seen = true;
    core->redirect_location = (pocketjs_net_http_client_slice_t){
        .data = value_copy,
        .length = value_length,
    };
  }
  return true;
}

static bool
response_on_headers_complete(void *context, unsigned status_code,
                             pocketjs_net_http1_response_body_kind_t body_kind,
                             uint64_t content_length, bool informational) {
  pocketjs_net_http_client_core_t *core = context;
  if (informational) {
    return true;
  }
  if (status_code == 205U) {
    if (body_kind == POCKETJS_NET_HTTP1_RESPONSE_BODY_CHUNKED ||
        (body_kind == POCKETJS_NET_HTTP1_RESPONSE_BODY_FIXED &&
         content_length != 0U)) {
      core->callback_error = POCKETJS_NET_HTTP_CLIENT_ERROR_PROTOCOL;
      return false;
    }
    core->force_no_body = true;
  }
  core->response_body_kind = body_kind;
  core->response_connection_reusable =
      core->config.enable_connection_reuse && core->response_http_minor == 1U &&
      !core->response_connection_close &&
      body_kind != POCKETJS_NET_HTTP1_RESPONSE_BODY_UNTIL_EOF;
  core->final_headers_seen = true;
  const redirect_decision_t redirect = prepare_redirect(core);
  if (redirect == REDIRECT_DECISION_FAIL) {
    return false;
  }
  if (redirect == REDIRECT_DECISION_FOLLOW) {
    return true;
  }
  if (!publish_headers(core)) {
    core->callback_error = POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT;
    return false;
  }
  return true;
}

static bool response_on_body(void *context, const uint8_t *body,
                             size_t body_length) {
  pocketjs_net_http_client_core_t *core = context;
  if (!core->headers_delivered || body_length > core->body_credit ||
      body_length > sizeof(core->body_bytes) - core->body_byte_count) {
    core->callback_error = POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT;
    return false;
  }
  if (body_length != 0U) {
    memcpy(core->body_bytes + core->body_byte_count, body, body_length);
  }
  core->body_byte_count += body_length;
  core->body_credit -= body_length;
  return true;
}

static void response_on_complete(void *context) {
  pocketjs_net_http_client_core_t *core = context;
  core->parser_complete = true;
}

static pocketjs_net_http_client_error_t
map_transport_error(pocketjs_net_http_client_transport_error_t error) {
  switch (error) {
  case POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_ABORTED:
    return POCKETJS_NET_HTTP_CLIENT_ERROR_ABORTED;
  case POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TIMED_OUT:
    return POCKETJS_NET_HTTP_CLIENT_ERROR_TIMED_OUT;
  case POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_DNS:
    return POCKETJS_NET_HTTP_CLIENT_ERROR_DNS;
  case POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_CONNECT:
    return POCKETJS_NET_HTTP_CLIENT_ERROR_CONNECT;
  case POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_IO:
    return POCKETJS_NET_HTTP_CLIENT_ERROR_IO;
  case POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_RESOURCE_LIMIT:
    return POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT;
  case POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TLS_CERTIFICATE_INVALID:
    return POCKETJS_NET_HTTP_CLIENT_ERROR_TLS_CERTIFICATE_INVALID;
  case POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TLS_HOSTNAME_MISMATCH:
    return POCKETJS_NET_HTTP_CLIENT_ERROR_TLS_HOSTNAME_MISMATCH;
  case POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TLS_HANDSHAKE_FAILED:
    return POCKETJS_NET_HTTP_CLIENT_ERROR_TLS_HANDSHAKE_FAILED;
  case POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TLS_VERSION_UNSUPPORTED:
    return POCKETJS_NET_HTTP_CLIENT_ERROR_TLS_VERSION_UNSUPPORTED;
  case POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_TLS_ALERT:
    return POCKETJS_NET_HTTP_CLIENT_ERROR_TLS_ALERT;
  case POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_INVALID:
  case POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_NONE:
  default:
    return POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT;
  }
}

static void select_failure(pocketjs_net_http_client_core_t *core,
                           pocketjs_net_http_client_error_t error,
                           int32_t cause) {
  if (core->terminal_selected) {
    return;
  }
  core->terminal_selected = true;
  core->terminal_success = false;
  core->terminal_error = error;
  core->terminal_cause = cause;
}

static void select_success(pocketjs_net_http_client_core_t *core) {
  if (core->terminal_selected) {
    return;
  }
  core->terminal_selected = true;
  core->terminal_success = true;
}

static void revoke_request_body_credit(pocketjs_net_http_client_core_t *core) {
  core->request_body_pull_active = false;
  core->request_body_pull_event_retired = false;
  core->request_body_pull_maximum = 0U;
  if (core->event_state == EVENT_PENDING &&
      core->event.type == POCKETJS_NET_HTTP_CLIENT_EVENT_REQUEST_BODY_PULL) {
    core->event_state = EVENT_EMPTY;
    memset(&core->event, 0, sizeof(core->event));
  }
}

static bool publish_request_body_pull(pocketjs_net_http_client_core_t *core) {
  if (core->state != CORE_WAITING_REQUEST_BODY || core->terminal_selected ||
      core->event_state != EVENT_EMPTY || core->request_body_pull_active) {
    return false;
  }
  size_t maximum = POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES;
  if (core->request_body_length_known) {
    if (core->request_body_submitted_length >=
        core->request_body_expected_length) {
      select_failure(
          core, POCKETJS_NET_HTTP_CLIENT_ERROR_REQUEST_BODY,
          POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_CAUSE_LENGTH_UNDERFLOW);
      return false;
    }
    uint64_t remaining = core->request_body_expected_length -
                         core->request_body_submitted_length;
    if (remaining < maximum) {
      maximum = (size_t)remaining;
    }
  }
  if (maximum == 0U || core->last_request_body_pull_generation == UINT64_MAX) {
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT, 0);
    return false;
  }
  ++core->last_request_body_pull_generation;
  core->request_body_pull_generation = core->last_request_body_pull_generation;
  core->request_body_pull_maximum = maximum;
  core->request_body_pull_active = true;
  core->request_body_pull_event_retired = false;
  if (!publish_event(core, POCKETJS_NET_HTTP_CLIENT_EVENT_REQUEST_BODY_PULL)) {
    revoke_request_body_credit(core);
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT, 0);
    return false;
  }
  core->event.detail.request_body_pull.body_generation =
      core->request_body_generation;
  core->event.detail.request_body_pull.pull_generation =
      core->request_body_pull_generation;
  core->event.detail.request_body_pull.maximum_bytes = maximum;
  return true;
}

static bool
invoke_permission(pocketjs_net_http_client_core_t *core,
                  const pocketjs_net_http_client_endpoint_t *endpoint,
                  core_state_t expected_state, bool *out_allowed) {
  uint64_t generation = core->lifecycle_generation;
  pocketjs_net_http_client_operation_token_t operation_token =
      core->operation_token;
  core->permission_callback_active = true;
  bool allowed =
      core->config.allow_endpoint(core->config.permission_context, endpoint);
  core->permission_callback_active = false;
  if (!core_is_live(core) || core->lifecycle_generation != generation ||
      core->state != expected_state ||
      core->operation_token != operation_token || core->transport_active ||
      core->terminal_selected) {
    if (core_is_live(core)) {
      poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_PERMISSION_REENTRANCY,
                  0);
      select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT, 0);
    }
    *out_allowed = false;
    return false;
  }
  *out_allowed = allowed;
  return true;
}

static bool
read_lease_equal(pocketjs_net_http_client_transport_read_lease_t left,
                 pocketjs_net_http_client_transport_read_lease_t right) {
  return left.slot == right.slot && left.generation == right.generation;
}

static bool
release_transport_read_lease(pocketjs_net_http_client_core_t *core) {
  if (!core->transport_read_lease_valid) {
    return true;
  }
  pocketjs_net_http_client_transport_result_t result =
      core->config.transport_ops->release_read_lease(
          core->config.transport_context, core->transport_read_lease);
  if (result != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_READ_LEASE_RELEASE,
                (int32_t)result);
    return false;
  }
  core->transport_read_lease_valid = false;
  core->transport_read_bytes = NULL;
  core->transport_read_length = 0U;
  core->transport_read_offset = 0U;
  core->transport_read_eof_pending = false;
  return true;
}

static bool release_orphan_read_lease(pocketjs_net_http_client_core_t *core) {
  if (!core->orphan_read_lease_valid) {
    return true;
  }
  pocketjs_net_http_client_transport_result_t result =
      core->config.transport_ops->release_read_lease(
          core->config.transport_context, core->orphan_read_lease);
  if (result != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_READ_LEASE_RELEASE,
                (int32_t)result);
    return false;
  }
  core->orphan_read_lease_valid = false;
  return true;
}

static bool cleanup_completion_read_lease(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_transport_read_lease_t lease) {
  if ((core->transport_read_lease_valid &&
       read_lease_equal(core->transport_read_lease, lease)) ||
      (core->orphan_read_lease_valid &&
       read_lease_equal(core->orphan_read_lease, lease))) {
    poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_STALE_COMPLETION, 0);
    return false;
  }
  pocketjs_net_http_client_transport_result_t result =
      core->config.transport_ops->release_read_lease(
          core->config.transport_context, lease);
  if (result == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    return true;
  }
  poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_READ_LEASE_RELEASE,
              (int32_t)result);
  if (!core->transport_read_lease_valid) {
    core->transport_read_lease = lease;
    core->transport_read_lease_valid = true;
    core->transport_read_bytes = NULL;
    core->transport_read_length = 0U;
    core->transport_read_offset = 0U;
    core->transport_read_eof_pending = false;
  } else if (!core->orphan_read_lease_valid) {
    core->orphan_read_lease = lease;
    core->orphan_read_lease_valid = true;
  } else {
    poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_STALE_COMPLETION, 0);
  }
  return false;
}

static bool start_close(pocketjs_net_http_client_core_t *core) {
  if (core->event_state != EVENT_EMPTY || core->transport_active) {
    return true;
  }
  if (!core->connection_valid) {
    return publish_terminal(core);
  }
  uint64_t token = 0U;
  if (!next_transport_token(core, &token)) {
    poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_ADMISSION, 0);
    (void)publish_terminal(core);
    return false;
  }
  uint64_t close_deadline = deadline_after(core->now_us, CORE_CLOSE_TIMEOUT_US);
  pocketjs_net_http_client_transport_result_t result =
      core->config.transport_ops->start_close(core->config.transport_context,
                                              token, core->connection,
                                              close_deadline);
  if (result != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_ADMISSION,
                (int32_t)result);
    (void)publish_terminal(core);
    return false;
  }
  core->transport_active = true;
  core->transport_cancel_requested = false;
  core->transport_operation_kind = TRANSPORT_OPERATION_CLOSE;
  core->transport_operation_token = token;
  core->close_deadline_us = close_deadline;
  core->close_cancel_requested = false;
  core->state = CORE_CLOSING;
  return true;
}

static bool start_idle_connection_close(pocketjs_net_http_client_core_t *core) {
  if (!core->connection_valid) {
    return true;
  }
  if (core->transport_active || core->event_state != EVENT_EMPTY) {
    return false;
  }
  uint64_t token = 0U;
  if (!next_transport_token(core, &token)) {
    poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_ADMISSION, 0);
    return false;
  }
  const uint64_t close_deadline =
      deadline_after(core->now_us, CORE_CLOSE_TIMEOUT_US);
  const pocketjs_net_http_client_transport_result_t result =
      core->config.transport_ops->start_close(core->config.transport_context,
                                              token, core->connection,
                                              close_deadline);
  if (result != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_ADMISSION,
                (int32_t)result);
    return false;
  }
  core->connection_reusable = false;
  core->connection_idle_deadline_us = 0U;
  core->transport_active = true;
  core->transport_cancel_requested = false;
  core->transport_operation_kind = TRANSPORT_OPERATION_CLOSE;
  core->transport_operation_token = token;
  core->close_deadline_us = close_deadline;
  core->close_cancel_requested = false;
  core->state = CORE_IDLE_CONNECTION_CLOSING;
  return true;
}

static bool
terminal_can_retain_connection(const pocketjs_net_http_client_core_t *core) {
  return core->config.enable_connection_reuse && !core->shutdown_requested &&
         core->terminal_success && core->parser_complete &&
         core->response_connection_reusable && core->connection_valid;
}

static void progress_terminal(pocketjs_net_http_client_core_t *core) {
  if (!core->terminal_selected) {
    return;
  }
  revoke_request_body_credit(core);
  if (core->event_state != EVENT_EMPTY) {
    return;
  }
  (void)release_transport_read_lease(core);
  (void)release_orphan_read_lease(core);
  core->body_credit = 0U;
  core->body_byte_count = 0U;
  if (core->completion_retire_pending) {
    return;
  }
  if (core->transport_active) {
    if (core->transport_operation_kind == TRANSPORT_OPERATION_CLOSE) {
      return;
    }
    if (core->transport_cancel_requested) {
      return;
    }
    pocketjs_net_http_client_transport_result_t result =
        core->config.transport_ops->cancel(core->config.transport_context,
                                           core->transport_operation_token);
    if (result != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
      poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_CANCEL,
                  (int32_t)result);
      (void)publish_terminal(core);
    } else {
      core->transport_cancel_requested = true;
    }
    return;
  }
  if (terminal_can_retain_connection(core)) {
    core->connection_reusable = true;
    core->connection_idle_deadline_us =
        deadline_after(core->now_us, core->config.idle_timeout_us);
    (void)publish_terminal(core);
    return;
  }
  core->connection_reusable = false;
  core->connection_idle_deadline_us = 0U;
  (void)start_close(core);
}

static pocketjs_net_http_client_transport_result_t
start_resolve(pocketjs_net_http_client_core_t *core) {
  uint64_t token = 0U;
  if (!next_transport_token(core, &token)) {
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_RESOURCE_LIMIT;
  }
  pocketjs_net_http_client_transport_result_t result =
      core->config.transport_ops->start_resolve(core->config.transport_context,
                                                token, core->hostname,
                                                core->connect_deadline_us);
  if (result == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    core->transport_active = true;
    core->transport_cancel_requested = false;
    core->transport_operation_kind = TRANSPORT_OPERATION_RESOLVE;
    core->transport_operation_token = token;
    core->state = CORE_RESOLVING;
  }
  return result;
}

static pocketjs_net_http_client_transport_result_t
start_connect(pocketjs_net_http_client_core_t *core, uint32_t ipv4_be) {
  uint64_t token = 0U;
  if (!next_transport_token(core, &token)) {
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_RESOURCE_LIMIT;
  }
  pocketjs_net_http_client_transport_result_t result =
      core->config.transport_ops->start_connect(
          core->config.transport_context, token, ipv4_be, core->port,
          core->scheme == POCKETJS_NET_HTTP_CLIENT_SCHEME_HTTPS, core->hostname,
          core->connect_deadline_us);
  if (result == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    core->selected_ipv4_be = ipv4_be;
    core->transport_active = true;
    core->transport_cancel_requested = false;
    core->transport_operation_kind = TRANSPORT_OPERATION_CONNECT;
    core->transport_operation_token = token;
    core->state = CORE_CONNECTING;
  }
  return result;
}

static pocketjs_net_http_client_transport_result_t
start_next_connect_candidate(pocketjs_net_http_client_core_t *core) {
  if (core->next_connect_candidate >= core->connect_candidate_count) {
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_INVALID;
  }
  const uint32_t ipv4_be =
      core->connect_candidates[core->next_connect_candidate++];
  return start_connect(core, ipv4_be);
}

static bool initialize_parser(pocketjs_net_http_client_core_t *core);
static bool emit_next_request_head(pocketjs_net_http_client_core_t *core);

static bool
connection_origin_matches(const pocketjs_net_http_client_core_t *core) {
  return core->connection_valid && core->connection_reusable &&
         core->connection_idle_deadline_us != 0U &&
         core->now_us < core->connection_idle_deadline_us &&
         core->connection_scheme == core->scheme &&
         core->connection_port == core->port &&
         strcmp(core->connection_hostname, core->hostname) == 0;
}

static bool
begin_reused_connection_request(pocketjs_net_http_client_core_t *core) {
  bool allowed = false;
  if (!core->numeric_host) {
    const pocketjs_net_http_client_endpoint_t hostname_endpoint = {
        .phase = POCKETJS_NET_HTTP_CLIENT_PERMISSION_HOSTNAME,
        .scheme = core->scheme,
        .hostname = core->hostname,
        .port = core->port,
        .ipv4_be = 0U,
    };
    if (!invoke_permission(core, &hostname_endpoint, CORE_RESOLVING,
                           &allowed)) {
      return false;
    }
    if (!allowed) {
      select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_PERMISSION_DENIED, 0);
      return false;
    }
  }
  const pocketjs_net_http_client_endpoint_t numeric_endpoint = {
      .phase = POCKETJS_NET_HTTP_CLIENT_PERMISSION_NUMERIC_CANDIDATE,
      .scheme = core->scheme,
      .hostname = core->hostname,
      .port = core->port,
      .ipv4_be = core->connection_ipv4_be,
  };
  if (!invoke_permission(core, &numeric_endpoint, CORE_RESOLVING, &allowed)) {
    return false;
  }
  if (!allowed) {
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_PERMISSION_DENIED, 0);
    return false;
  }

  core->connection_reusable = false;
  core->connection_idle_deadline_us = 0U;
  core->selected_ipv4_be = core->connection_ipv4_be;
  core->headers_deadline_us = earlier_deadline(
      deadline_after(core->now_us, core->config.headers_timeout_us),
      core->total_deadline_us);
  if (!initialize_parser(core)) {
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_PROTOCOL, 0);
    return false;
  }
  return emit_next_request_head(core);
}

static bool
start_connection_replacement_close(pocketjs_net_http_client_core_t *core) {
  uint64_t token = 0U;
  if (!next_transport_token(core, &token)) {
    poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_ADMISSION, 0);
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT, 0);
    return false;
  }
  const uint64_t close_deadline =
      earlier_deadline(deadline_after(core->now_us, CORE_CLOSE_TIMEOUT_US),
                       core->total_deadline_us);
  const pocketjs_net_http_client_transport_result_t result =
      core->config.transport_ops->start_close(core->config.transport_context,
                                              token, core->connection,
                                              close_deadline);
  if (result != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_ADMISSION,
                (int32_t)result);
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT,
                   (int32_t)result);
    return false;
  }
  core->connection_reusable = false;
  core->connection_idle_deadline_us = 0U;
  core->transport_active = true;
  core->transport_cancel_requested = false;
  core->transport_operation_kind = TRANSPORT_OPERATION_CLOSE;
  core->transport_operation_token = token;
  core->close_deadline_us = close_deadline;
  core->close_cancel_requested = false;
  core->state = CORE_REPLACING_CONNECTION;
  return true;
}

static bool begin_current_endpoint(pocketjs_net_http_client_core_t *core) {
  if (core->now_us >= core->total_deadline_us) {
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TIMED_OUT, 0);
    return false;
  }
  core->connect_deadline_us = earlier_deadline(
      deadline_after(core->now_us, core->config.connect_timeout_us),
      core->total_deadline_us);
  core->headers_deadline_us = core->total_deadline_us;
  core->idle_deadline_us = core->total_deadline_us;
  core->state = CORE_RESOLVING;
  core->connect_candidate_count = 0U;
  core->next_connect_candidate = 0U;

  if (core->connection_valid) {
    if (connection_origin_matches(core)) {
      return begin_reused_connection_request(core);
    }
    return start_connection_replacement_close(core);
  }

  if (core->numeric_host) {
    pocketjs_net_http_client_endpoint_t endpoint = {
        .phase = POCKETJS_NET_HTTP_CLIENT_PERMISSION_NUMERIC_CANDIDATE,
        .scheme = core->scheme,
        .hostname = core->hostname,
        .port = core->port,
        .ipv4_be = core->numeric_ipv4_be,
    };
    bool allowed = false;
    if (!invoke_permission(core, &endpoint, CORE_RESOLVING, &allowed)) {
      return false;
    }
    if (!allowed) {
      select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_PERMISSION_DENIED, 0);
      return false;
    }
    pocketjs_net_http_client_transport_result_t result =
        start_connect(core, core->numeric_ipv4_be);
    if (result != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
      select_failure(core,
                     result == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_RESOURCE_LIMIT
                         ? POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT
                         : POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT,
                     (int32_t)result);
      return false;
    }
    return true;
  }

  pocketjs_net_http_client_endpoint_t endpoint = {
      .phase = POCKETJS_NET_HTTP_CLIENT_PERMISSION_HOSTNAME,
      .scheme = core->scheme,
      .hostname = core->hostname,
      .port = core->port,
      .ipv4_be = 0U,
  };
  bool allowed = false;
  if (!invoke_permission(core, &endpoint, CORE_RESOLVING, &allowed)) {
    return false;
  }
  if (!allowed) {
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_PERMISSION_DENIED, 0);
    return false;
  }
  const pocketjs_net_http_client_transport_result_t result =
      start_resolve(core);
  if (result != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    select_failure(core,
                   result == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_RESOURCE_LIMIT
                       ? POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT
                       : POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT,
                   (int32_t)result);
    return false;
  }
  return true;
}

static bool start_redirect_close(pocketjs_net_http_client_core_t *core) {
  if (!core->redirect_pending || core->event_state != EVENT_EMPTY ||
      core->transport_active) {
    return false;
  }
  if (!core->connection_valid) {
    core->state = CORE_REDIRECT_READY;
    return true;
  }
  uint64_t token = 0U;
  if (!next_transport_token(core, &token)) {
    core->redirect_pending = false;
    poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_ADMISSION, 0);
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT, 0);
    return false;
  }
  const uint64_t close_deadline =
      earlier_deadline(deadline_after(core->now_us, CORE_CLOSE_TIMEOUT_US),
                       core->total_deadline_us);
  const pocketjs_net_http_client_transport_result_t result =
      core->config.transport_ops->start_close(core->config.transport_context,
                                              token, core->connection,
                                              close_deadline);
  if (result != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    core->redirect_pending = false;
    poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_ADMISSION,
                (int32_t)result);
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT,
                   (int32_t)result);
    return false;
  }
  core->transport_active = true;
  core->transport_cancel_requested = false;
  core->transport_operation_kind = TRANSPORT_OPERATION_CLOSE;
  core->transport_operation_token = token;
  core->close_deadline_us = close_deadline;
  core->close_cancel_requested = false;
  core->state = CORE_CLOSING;
  return true;
}

static void begin_redirect_hop(pocketjs_net_http_client_core_t *core) {
  if (core->state != CORE_REDIRECT_READY || !core->redirect_pending ||
      core->event_state != EVENT_EMPTY || core->transport_active ||
      core->completion_retire_pending || core->connection_valid ||
      core->terminal_selected) {
    return;
  }
  core->redirect_pending = false;
  core->final_headers_seen = false;
  core->headers_delivered = false;
  core->parser_complete = false;
  core->force_no_body = false;
  core->callback_error = 0;
  core->response_status = 0U;
  core->response_http_minor = 0U;
  core->response_body_kind = POCKETJS_NET_HTTP1_RESPONSE_BODY_NONE;
  core->response_connection_close = false;
  core->response_connection_reusable = false;
  core->response_header_storage_used = 0U;
  core->response_header_field_bytes = 0U;
  core->response_header_count = 0U;
  core->redirect_location_seen = false;
  core->redirect_location = (pocketjs_net_http_client_slice_t){0};
  core->body_credit = 0U;
  core->terminal_body_pull_active = false;
  core->body_byte_count = 0U;
  if (!begin_current_endpoint(core)) {
    progress_terminal(core);
  }
}

static void begin_queued_endpoint(pocketjs_net_http_client_core_t *core) {
  if (core->state != CORE_ENDPOINT_READY || core->event_state != EVENT_EMPTY ||
      core->transport_active || core->completion_retire_pending ||
      core->connection_valid || core->terminal_selected) {
    return;
  }
  if (!begin_current_endpoint(core)) {
    progress_terminal(core);
  }
}

static pocketjs_net_http_client_transport_result_t
start_write(pocketjs_net_http_client_core_t *core, const uint8_t *bytes,
            size_t length, core_state_t state) {
  uint64_t token = 0U;
  if (!next_transport_token(core, &token)) {
    return POCKETJS_NET_HTTP_CLIENT_TRANSPORT_RESOURCE_LIMIT;
  }
  pocketjs_net_http_client_transport_result_t result =
      core->config.transport_ops->start_write(core->config.transport_context,
                                              token, core->connection, bytes,
                                              length, core->total_deadline_us);
  if (result == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    core->write_length = length;
    core->transport_active = true;
    core->transport_cancel_requested = false;
    core->transport_operation_kind = TRANSPORT_OPERATION_WRITE;
    core->transport_operation_token = token;
    core->state = state;
  }
  return result;
}

static bool emit_next_request_head(pocketjs_net_http_client_core_t *core) {
  size_t length = 0U;
  pocketjs_net_http1_encoder_result_t encoder_result =
      pocketjs_net_http1_request_encoder_write(
          &core->encoder, core->write_bytes, sizeof(core->write_bytes),
          &length);
  if (encoder_result == POCKETJS_NET_HTTP1_ENCODER_ERROR || length == 0U) {
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_PROTOCOL,
                   (int32_t)core->encoder.phase);
    return false;
  }
  core->encoder_done = encoder_result == POCKETJS_NET_HTTP1_ENCODER_DONE;
  core->write_length = length;
  pocketjs_net_http_client_transport_result_t result =
      start_write(core, core->write_bytes, length, CORE_WRITING_HEAD);
  if (result != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    select_failure(core,
                   result == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_RESOURCE_LIMIT
                       ? POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT
                       : POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT,
                   (int32_t)result);
    return false;
  }
  return true;
}

static bool initialize_parser(pocketjs_net_http_client_core_t *core) {
  pocketjs_net_http1_response_callbacks_t callbacks = {
      .on_status = response_on_status,
      .on_header = response_on_header,
      .on_headers_complete = response_on_headers_complete,
      .on_body = response_on_body,
      .on_complete = response_on_complete,
  };
  bool response_to_head =
      ascii_equal_case(core->method, core->method_length, "HEAD");
  pocketjs_net_http1_wire_error_t error =
      pocketjs_net_http1_response_parser_init(
          &core->parser, &pocketjs_net_http1_default_limits, &callbacks, core,
          response_to_head);
  return error == POCKETJS_NET_HTTP1_WIRE_ERROR_NONE;
}

static bool start_read(pocketjs_net_http_client_core_t *core) {
  if (core->transport_active || core->transport_read_lease_valid ||
      core->event_state != EVENT_EMPTY || core->terminal_selected) {
    return true;
  }
  if (core->final_headers_seen && core->body_credit == 0U) {
    return true;
  }
  uint64_t deadline =
      core->final_headers_seen
          ? earlier_deadline(core->idle_deadline_us, core->total_deadline_us)
          : earlier_deadline(core->headers_deadline_us,
                             core->total_deadline_us);
  if (core->now_us >= deadline) {
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TIMED_OUT, 0);
    return false;
  }
  size_t maximum_bytes = core->final_headers_seen
                             ? core->body_credit
                             : POCKETJS_NET_HTTP_CLIENT_CORE_BODY_LEASE_BYTES;
  if (maximum_bytes > POCKETJS_NET_HTTP_CLIENT_CORE_BODY_LEASE_BYTES) {
    maximum_bytes = POCKETJS_NET_HTTP_CLIENT_CORE_BODY_LEASE_BYTES;
  }
  uint64_t token = 0U;
  if (!next_transport_token(core, &token)) {
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT, 0);
    return false;
  }
  pocketjs_net_http_client_transport_result_t result =
      core->config.transport_ops->start_read(core->config.transport_context,
                                             token, core->connection,
                                             maximum_bytes, deadline);
  if (result != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    select_failure(core,
                   result == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_RESOURCE_LIMIT
                       ? POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT
                       : POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT,
                   (int32_t)result);
    return false;
  }
  core->transport_read_maximum = maximum_bytes;
  core->transport_active = true;
  core->transport_cancel_requested = false;
  core->transport_operation_kind = TRANSPORT_OPERATION_READ;
  core->transport_operation_token = token;
  core->state = CORE_READING;
  return true;
}

static bool begin_response_read(pocketjs_net_http_client_core_t *core) {
  core->headers_deadline_us = earlier_deadline(
      deadline_after(core->now_us, core->config.headers_timeout_us),
      core->total_deadline_us);
  core->state = CORE_READING;
  return start_read(core);
}

static void publish_body_if_any(pocketjs_net_http_client_core_t *core) {
  if (core->body_byte_count == 0U || core->event_state != EVENT_EMPTY) {
    return;
  }
  if (core->body_lease_generation == UINT64_MAX) {
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT, 0);
    return;
  }
  ++core->body_lease_generation;
  core->body_lease = (pocketjs_net_http_client_body_lease_t){
      .slot = 0U,
      .generation = core->body_lease_generation,
  };
  core->body_lease_active = true;
  core->body_lease_released = false;
  if (!publish_event(core, POCKETJS_NET_HTTP_CLIENT_EVENT_BODY)) {
    core->body_lease_active = false;
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT, 0);
    return;
  }
  core->event.detail.body.lease = core->body_lease;
  core->event.detail.body.byte_count = core->body_byte_count;
}

static void consume_retained_read(pocketjs_net_http_client_core_t *core) {
  if (!core->transport_read_lease_valid || core->event_state != EVENT_EMPTY ||
      core->terminal_selected ||
      (core->final_headers_seen && core->body_credit == 0U)) {
    return;
  }
  if (core->transport_read_bytes == NULL ||
      core->transport_read_offset > core->transport_read_length) {
    (void)release_transport_read_lease(core);
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT, 0);
    return;
  }
  size_t remaining = core->transport_read_length - core->transport_read_offset;
  size_t consumed = 0U;
  size_t credit = core->headers_delivered ? core->body_credit : 0U;
  pocketjs_net_http1_parse_result_t result =
      pocketjs_net_http1_response_parser_feed(&core->parser,
                                              core->transport_read_bytes +
                                                  core->transport_read_offset,
                                              remaining, credit, &consumed);
  core->transport_read_offset += consumed;

  if (result == POCKETJS_NET_HTTP1_PARSE_ERROR) {
    int32_t cause = (int32_t)core->parser.error;
    (void)release_transport_read_lease(core);
    select_failure(core,
                   core->callback_error != 0
                       ? core->callback_error
                       : POCKETJS_NET_HTTP_CLIENT_ERROR_PROTOCOL,
                   cause);
    return;
  }
  if (core->redirect_pending) {
    /* Redirect response bodies and trailers are intentionally abandoned. The
     * current connection is never reused, so bytes already present in this
     * lease can be discarded without becoming input to the next response. */
    core->transport_read_offset = core->transport_read_length;
    core->body_credit = 0U;
    core->body_byte_count = 0U;
    if (!release_transport_read_lease(core)) {
      core->redirect_pending = false;
      select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT, 0);
      return;
    }
    if (!start_redirect_close(core) && !core->terminal_selected) {
      core->redirect_pending = false;
      select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT, 0);
    }
    return;
  }
  if (core->force_no_body && core->final_headers_seen) {
    if (core->transport_read_offset != core->transport_read_length) {
      core->response_connection_reusable = false;
    }
    core->transport_read_offset = core->transport_read_length;
    core->parser_complete = true;
    result = POCKETJS_NET_HTTP1_PARSE_COMPLETE;
  }
  if (result == POCKETJS_NET_HTTP1_PARSE_COMPLETE) {
    if (core->transport_read_eof_pending) {
      core->response_connection_reusable = false;
    }
    if (core->transport_read_offset != core->transport_read_length) {
      (void)release_transport_read_lease(core);
      select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_PROTOCOL, 0);
      return;
    }
    (void)release_transport_read_lease(core);
    core->parser_complete = true;
  } else if (core->transport_read_offset == core->transport_read_length) {
    bool eof = core->transport_read_eof_pending;
    bool released = release_transport_read_lease(core);
    if (eof && !core->terminal_selected && !core->parser_complete) {
      pocketjs_net_http1_parse_result_t finish_result =
          pocketjs_net_http1_response_parser_finish(&core->parser);
      if (finish_result == POCKETJS_NET_HTTP1_PARSE_COMPLETE) {
        core->parser_complete = true;
      } else {
        select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_PROTOCOL,
                       (int32_t)core->parser.error);
      }
    } else if (!released && !core->terminal_selected &&
               !core->parser_complete) {
      select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT, 0);
    }
  }

  publish_body_if_any(core);
  if (core->parser_complete && !core->redirect_pending &&
      core->event_state == EVENT_EMPTY) {
    select_success(core);
  }
}

static void handle_resolved(
    pocketjs_net_http_client_core_t *core,
    const pocketjs_net_http_client_transport_completion_t *completion) {
  size_t count = completion->detail.resolved.candidate_count;
  if (count == 0U || count > POCKETJS_NET_HTTP_CLIENT_CORE_MAX_DNS_CANDIDATES) {
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_DNS, 0);
    return;
  }
  bool allowed[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_DNS_CANDIDATES] = {false};
  for (size_t index = 0U; index < count; ++index) {
    pocketjs_net_http_client_endpoint_t endpoint = {
        .phase = POCKETJS_NET_HTTP_CLIENT_PERMISSION_NUMERIC_CANDIDATE,
        .scheme = core->scheme,
        .hostname = core->hostname,
        .port = core->port,
        .ipv4_be = completion->detail.resolved.ipv4_be[index],
    };
    if (!invoke_permission(core, &endpoint, CORE_RESOLVING, &allowed[index])) {
      return;
    }
  }
  core->connect_candidate_count = 0U;
  core->next_connect_candidate = 0U;
  for (size_t index = 0U; index < count; ++index) {
    if (allowed[index]) {
      core->connect_candidates[core->connect_candidate_count++] =
          completion->detail.resolved.ipv4_be[index];
    }
  }
  if (core->connect_candidate_count == 0U) {
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_PERMISSION_DENIED, 0);
    return;
  }
  pocketjs_net_http_client_transport_result_t result =
      start_next_connect_candidate(core);
  if (result != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    select_failure(core,
                   result == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_RESOURCE_LIMIT
                       ? POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT
                       : POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT,
                   (int32_t)result);
  }
}

static void discard_completion_payload(
    pocketjs_net_http_client_core_t *core,
    const pocketjs_net_http_client_transport_completion_t *completion) {
  if (completion->type == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_READ &&
      completion->detail.read.byte_count != 0U) {
    (void)cleanup_completion_read_lease(core, completion->detail.read.lease);
  }
}

static void handle_transport_completion(
    pocketjs_net_http_client_core_t *core,
    const pocketjs_net_http_client_transport_completion_t *completion) {
  transport_operation_kind_t completed_kind = core->transport_operation_kind;
  const core_state_t completed_state = core->state;
  core->transport_active = false;
  core->transport_cancel_requested = false;
  core->transport_operation_kind = TRANSPORT_OPERATION_NONE;

  /* A terminal event may have been retired while poisoned native cleanup was
   * still outstanding. Late completion is cleanup-only: it must never restart
   * the state machine or publish an operation-token-zero event. */
  if (core->operation_token == 0U) {
    if (completion->type == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_READ) {
      discard_completion_payload(core, completion);
    }
    if (completed_kind == TRANSPORT_OPERATION_CLOSE) {
      if (completion->type == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_CLOSED &&
          completion->detail.closed.connection.slot == core->connection.slot &&
          completion->detail.closed.connection.generation ==
              core->connection.generation) {
        core->connection_valid = false;
      } else {
        poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_COMPLETION,
                    completion->type == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR
                        ? completion->detail.error.cause_code
                        : 0);
      }
      core->connection_reusable = false;
      core->connection_idle_deadline_us = 0U;
      if (completed_state == CORE_IDLE_CONNECTION_CLOSING) {
        core->state = CORE_IDLE;
      }
    } else if (completion->type == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR &&
               (completed_kind == TRANSPORT_OPERATION_CONNECT ||
                completed_kind == TRANSPORT_OPERATION_READ ||
                completed_kind == TRANSPORT_OPERATION_WRITE)) {
      core->connection_valid = false;
    }
    return;
  }

  if (completion->type == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_READ &&
      completed_kind != TRANSPORT_OPERATION_READ) {
    discard_completion_payload(core, completion);
  }

  if (completion->type == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR &&
      completed_kind == TRANSPORT_OPERATION_CONNECT &&
      completion->detail.error.code ==
          POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR_CONNECT &&
      !core->terminal_selected &&
      core->next_connect_candidate < core->connect_candidate_count &&
      core->now_us < core->connect_deadline_us) {
    core->connection_valid = false;
    const pocketjs_net_http_client_transport_result_t retry_result =
        start_next_connect_candidate(core);
    if (retry_result == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
      return;
    }
    select_failure(core,
                   retry_result ==
                           POCKETJS_NET_HTTP_CLIENT_TRANSPORT_RESOURCE_LIMIT
                       ? POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT
                       : POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT,
                   (int32_t)retry_result);
    return;
  }

  if (completion->type == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_ERROR) {
    if (completed_kind == TRANSPORT_OPERATION_CONNECT ||
        completed_kind == TRANSPORT_OPERATION_READ ||
        completed_kind == TRANSPORT_OPERATION_WRITE) {
      core->connection_valid = false;
    }
    if (!core->terminal_selected) {
      select_failure(core, map_transport_error(completion->detail.error.code),
                     completion->detail.error.cause_code);
    }
    if (completed_kind == TRANSPORT_OPERATION_CLOSE) {
      core->redirect_pending = false;
      poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_COMPLETION,
                  completion->detail.error.cause_code);
      core->connection_reusable = false;
      core->connection_idle_deadline_us = 0U;
      if (completed_state == CORE_IDLE_CONNECTION_CLOSING) {
        core->state = CORE_IDLE;
        return;
      }
      if (!core->terminal_selected) {
        select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT,
                       completion->detail.error.cause_code);
      }
      (void)publish_terminal(core);
    }
    return;
  }

  if (core->terminal_selected && completed_kind != TRANSPORT_OPERATION_CLOSE) {
    if (completed_kind == TRANSPORT_OPERATION_READ) {
      discard_completion_payload(core, completion);
    }
    return;
  }

  switch (completed_kind) {
  case TRANSPORT_OPERATION_RESOLVE:
    if (completion->type != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_RESOLVED) {
      select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT, 0);
      return;
    }
    handle_resolved(core, completion);
    break;
  case TRANSPORT_OPERATION_CONNECT:
    if (completion->type != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_CONNECTED ||
        completion->detail.connected.tls !=
            (core->scheme == POCKETJS_NET_HTTP_CLIENT_SCHEME_HTTPS) ||
        completion->detail.connected.ipv4_be != core->selected_ipv4_be ||
        completion->detail.connected.connection.generation == 0U) {
      select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT, 0);
      return;
    }
    core->connection = completion->detail.connected.connection;
    core->connection_valid = true;
    core->connection_reusable = false;
    core->connection_idle_deadline_us = 0U;
    core->connection_scheme = core->scheme;
    memcpy(core->connection_hostname, core->hostname,
           strlen(core->hostname) + 1U);
    core->connection_port = core->port;
    core->connection_ipv4_be = core->selected_ipv4_be;
    core->connect_candidate_count = 0U;
    core->next_connect_candidate = 0U;
    core->headers_deadline_us = earlier_deadline(
        deadline_after(core->now_us, core->config.headers_timeout_us),
        core->total_deadline_us);
    if (!initialize_parser(core)) {
      select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_PROTOCOL, 0);
      return;
    }
    (void)emit_next_request_head(core);
    break;
  case TRANSPORT_OPERATION_WRITE:
    if (completion->type != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_WRITTEN ||
        completion->detail.written.byte_count != core->write_length ||
        completion->detail.written.connection.slot != core->connection.slot ||
        completion->detail.written.connection.generation !=
            core->connection.generation) {
      select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT, 0);
      return;
    }
    if (core->state == CORE_WRITING_HEAD) {
      if (!core->encoder_done) {
        (void)emit_next_request_head(core);
      } else if (core->request_body_kind ==
                     POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_FIXED &&
                 core->request_body_length != 0U) {
        pocketjs_net_http_client_transport_result_t result =
            start_write(core, core->request_body, core->request_body_length,
                        CORE_WRITING_BODY);
        if (result != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
          select_failure(
              core,
              result == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_RESOURCE_LIMIT
                  ? POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT
                  : POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT,
              (int32_t)result);
        }
      } else if (core->request_body_kind ==
                     POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_STREAMING &&
                 (!core->request_body_length_known ||
                  core->request_body_expected_length != 0U)) {
        core->state = CORE_WAITING_REQUEST_BODY;
        (void)publish_request_body_pull(core);
      } else {
        (void)begin_response_read(core);
      }
    } else if (core->state == CORE_WRITING_BODY) {
      (void)begin_response_read(core);
    } else if (core->state == CORE_WRITING_REQUEST_BODY_CHUNK) {
      core->request_body_pending_payload_length = 0U;
      if (core->request_body_length_known &&
          core->request_body_submitted_length ==
              core->request_body_expected_length) {
        (void)begin_response_read(core);
      } else {
        core->state = CORE_WAITING_REQUEST_BODY;
        (void)publish_request_body_pull(core);
      }
    } else if (core->state == CORE_WRITING_REQUEST_BODY_END) {
      (void)begin_response_read(core);
    } else {
      select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT, 0);
    }
    break;
  case TRANSPORT_OPERATION_READ:
    if (completion->type != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_READ ||
        completion->detail.read.connection.slot != core->connection.slot ||
        completion->detail.read.connection.generation !=
            core->connection.generation ||
        completion->detail.read.byte_count > core->transport_read_maximum ||
        (completion->detail.read.byte_count != 0U &&
         completion->detail.read.lease.generation == 0U) ||
        (completion->detail.read.byte_count == 0U &&
         !completion->detail.read.eof)) {
      discard_completion_payload(core, completion);
      select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT, 0);
      return;
    }
    if (completion->detail.read.byte_count != 0U) {
      const uint8_t *bytes = NULL;
      size_t capacity = 0U;
      core->transport_read_lease = completion->detail.read.lease;
      core->transport_read_lease_valid = true;
      core->transport_read_bytes = NULL;
      core->transport_read_length = completion->detail.read.byte_count;
      core->transport_read_offset = 0U;
      core->transport_read_eof_pending = completion->detail.read.eof;
      if (core->config.transport_ops->read_lease_view(
              core->config.transport_context, completion->detail.read.lease,
              &bytes, &capacity) != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK ||
          bytes == NULL || capacity < completion->detail.read.byte_count) {
        (void)release_transport_read_lease(core);
        select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT, 0);
        return;
      }
      core->transport_read_bytes = bytes;
      core->idle_deadline_us = earlier_deadline(
          deadline_after(core->now_us, core->config.idle_timeout_us),
          core->total_deadline_us);
      consume_retained_read(core);
    } else if (completion->detail.read.eof && !core->terminal_selected &&
               !core->parser_complete) {
      core->response_connection_reusable = false;
      pocketjs_net_http1_parse_result_t result =
          pocketjs_net_http1_response_parser_finish(&core->parser);
      if (result == POCKETJS_NET_HTTP1_PARSE_COMPLETE) {
        core->parser_complete = true;
        if (!core->redirect_pending && core->event_state == EVENT_EMPTY &&
            core->body_byte_count == 0U) {
          select_success(core);
        }
      } else {
        select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_PROTOCOL,
                       (int32_t)core->parser.error);
      }
    }
    break;
  case TRANSPORT_OPERATION_CLOSE:
    if (completion->type == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_CLOSED &&
        completion->detail.closed.connection.slot == core->connection.slot &&
        completion->detail.closed.connection.generation ==
            core->connection.generation) {
      core->connection_valid = false;
    } else {
      poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_COMPLETION, 0);
    }
    if (completion->type != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_CLOSED ||
        completion->detail.closed.connection.slot != core->connection.slot ||
        completion->detail.closed.connection.generation !=
            core->connection.generation) {
      core->connection_valid = true;
    }
    core->connection_reusable = false;
    core->connection_idle_deadline_us = 0U;
    if (completed_state == CORE_IDLE_CONNECTION_CLOSING) {
      core->state = CORE_IDLE;
    } else if (completed_state == CORE_REPLACING_CONNECTION &&
               !core->terminal_selected && !core->connection_valid) {
      core->state = CORE_ENDPOINT_READY;
    } else if (core->redirect_pending && !core->terminal_selected &&
               !core->connection_valid) {
      core->state = CORE_REDIRECT_READY;
    } else {
      (void)publish_terminal(core);
    }
    break;
  case TRANSPORT_OPERATION_NONE:
  default:
    poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_STALE_COMPLETION, 0);
    if (core->state != CORE_IDLE) {
      select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT, 0);
    }
    break;
  }
}

pocketjs_net_http_client_start_result_t pocketjs_net_http_client_core_init(
    pocketjs_net_http_client_core_storage_t *storage,
    const pocketjs_net_http_client_core_config_t *config,
    pocketjs_net_http_client_core_t **out_core) {
  if (out_core != NULL) {
    *out_core = NULL;
  }
  if (storage == NULL || out_core == NULL || !valid_config(config)) {
    return POCKETJS_NET_HTTP_CLIENT_START_INVALID_ARGUMENT;
  }
  uint64_t existing_magic = 0U;
  memcpy(&existing_magic, storage->bytes, sizeof(existing_magic));
  if (existing_magic == CORE_MAGIC) {
    return POCKETJS_NET_HTTP_CLIENT_START_BUSY;
  }
  memset(storage->bytes, 0, sizeof(storage->bytes));
  pocketjs_net_http_client_core_t *core = (void *)storage->bytes;
  core->config = *config;
  if (core->config.response_header_bytes_limit == 0U) {
    core->config.response_header_bytes_limit =
        POCKETJS_NET_HTTP_CLIENT_CORE_MAX_RESPONSE_HEADER_BYTES;
  }
  core->lifecycle_generation = 1U;
  core->magic = CORE_MAGIC;
  *out_core = core;
  return POCKETJS_NET_HTTP_CLIENT_START_OK;
}

pocketjs_net_http_client_start_result_t pocketjs_net_http_client_core_start(
    pocketjs_net_http_client_core_t *core,
    const pocketjs_net_http_client_request_t *request, uint64_t now_us) {
  if (!core_is_live(core) || request == NULL || now_us == 0U) {
    return POCKETJS_NET_HTTP_CLIENT_START_INVALID_ARGUMENT;
  }
  if (core->permission_callback_active) {
    return POCKETJS_NET_HTTP_CLIENT_START_REENTRANT;
  }
  if (core->shutdown_requested) {
    return POCKETJS_NET_HTTP_CLIENT_START_SHUTTING_DOWN;
  }
  if (core->poison_flags != 0U) {
    return POCKETJS_NET_HTTP_CLIENT_START_POISONED;
  }
  if (core->state != CORE_IDLE || core->event_state != EVENT_EMPTY) {
    return POCKETJS_NET_HTTP_CLIENT_START_BUSY;
  }
  if (core->lifecycle_generation == UINT64_MAX ||
      core->event_sequence == UINT64_MAX) {
    return POCKETJS_NET_HTTP_CLIENT_START_TOKEN_EXHAUSTED;
  }

  pocketjs_net_http_client_start_result_t result =
      snapshot_request(core, request);
  if (result != POCKETJS_NET_HTTP_CLIENT_START_OK) {
    return result;
  }
  if (core->request_body_kind ==
      POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_STREAMING) {
    ++core->last_request_body_generation;
    core->request_body_generation = core->last_request_body_generation;
  } else {
    core->request_body_generation = 0U;
  }
  core->request_body_pull_generation = 0U;
  core->last_operation_token = request->operation_token;
  core->operation_token = request->operation_token;
  ++core->lifecycle_generation;
  core->now_us = now_us;
  core->total_deadline_us =
      deadline_after(now_us, core->config.total_timeout_us);

  if (!begin_current_endpoint(core)) {
    progress_terminal(core);
  }
  return POCKETJS_NET_HTTP_CLIENT_START_OK;
}

bool pocketjs_net_http_client_core_abort(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_operation_token_t operation_token) {
  if (!core_public_entry_allowed(core) || core->state == CORE_IDLE ||
      operation_token != core->operation_token || core->terminal_selected) {
    return false;
  }
  select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_ABORTED, 0);
  progress_terminal(core);
  return true;
}

bool pocketjs_net_http_client_core_pump(pocketjs_net_http_client_core_t *core,
                                        uint64_t now_us,
                                        size_t max_native_steps,
                                        size_t max_transport_completions) {
  if (!core_public_entry_allowed(core) || now_us == 0U ||
      (max_native_steps == 0U && max_transport_completions == 0U)) {
    return false;
  }
  core->now_us = now_us;

  if (core->state == CORE_IDLE && core->connection_valid &&
      core->connection_reusable && core->connection_idle_deadline_us != 0U &&
      now_us >= core->connection_idle_deadline_us) {
    (void)start_idle_connection_close(core);
  }

  if (core->completion_retire_pending) {
    pocketjs_net_http_client_transport_result_t retry_result =
        core->config.transport_ops->retire_completion(
            core->config.transport_context, core->completion_retire_token);
    if (retry_result == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
      core->completion_retire_pending = false;
      core->completion_retire_token = 0U;
    } else {
      poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_COMPLETION_RETIRE,
                  (int32_t)retry_result);
    }
  }

  if (core->transport_read_lease_valid &&
      (core->terminal_selected || core->shutdown_requested ||
       core->transport_read_offset == core->transport_read_length)) {
    (void)release_transport_read_lease(core);
  }
  (void)release_orphan_read_lease(core);

  if (core->state != CORE_IDLE && !core->terminal_selected &&
      now_us >= core->total_deadline_us) {
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TIMED_OUT, 0);
  }

  if (core->transport_active &&
      core->transport_operation_kind == TRANSPORT_OPERATION_CLOSE &&
      now_us >= core->close_deadline_us && !core->close_cancel_requested) {
    poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_CLOSE_TIMEOUT, 0);
    pocketjs_net_http_client_transport_result_t cancel_result =
        core->config.transport_ops->cancel(core->config.transport_context,
                                           core->transport_operation_token);
    if (cancel_result == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
      core->close_cancel_requested = true;
    } else {
      poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_CANCEL,
                  (int32_t)cancel_result);
      if (core->terminal_selected) {
        (void)publish_terminal(core);
      }
    }
  }
  if (core->terminal_selected) {
    progress_terminal(core);
  }

  if (max_native_steps != 0U) {
    pocketjs_net_http_client_transport_result_t pump_result =
        core->config.transport_ops->pump(core->config.transport_context, now_us,
                                         max_native_steps);
    if (pump_result != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
      poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_TRANSPORT_PUMP,
                  (int32_t)pump_result);
      if (core->state != CORE_IDLE && !core->terminal_selected) {
        select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT,
                       (int32_t)pump_result);
      }
    }
  }

  for (size_t index = 0U;
       index < max_transport_completions && !core->completion_retire_pending &&
       !core->transport_read_lease_valid && !core->orphan_read_lease_valid;
       ++index) {
    pocketjs_net_http_client_transport_completion_t completion;
    pocketjs_net_http_client_transport_result_t take_result =
        core->config.transport_ops->take_completion(
            core->config.transport_context, &completion);
    if (take_result == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_EMPTY) {
      break;
    }
    if (take_result != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
      poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_COMPLETION_TAKE,
                  (int32_t)take_result);
      if (core->state != CORE_IDLE && !core->terminal_selected) {
        select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT,
                       (int32_t)take_result);
      }
      break;
    }
    if (!core->transport_active ||
        completion.operation_token != core->transport_operation_token) {
      discard_completion_payload(core, &completion);
      poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_STALE_COMPLETION, 0);
      if (core->state != CORE_IDLE && !core->terminal_selected) {
        select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT, 0);
      }
    } else {
      handle_transport_completion(core, &completion);
    }
    pocketjs_net_http_client_transport_result_t retire_result =
        core->config.transport_ops->retire_completion(
            core->config.transport_context, completion.operation_token);
    if (retire_result != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
      core->completion_retire_pending = true;
      core->completion_retire_token = completion.operation_token;
      poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_COMPLETION_RETIRE,
                  (int32_t)retire_result);
      if (core->state != CORE_IDLE && !core->terminal_selected) {
        select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT, 0);
      }
      break;
    }
  }

  begin_redirect_hop(core);
  begin_queued_endpoint(core);

  if (!core->terminal_selected && core->state == CORE_READING &&
      core->event_state == EVENT_EMPTY) {
    consume_retained_read(core);
    if (!core->terminal_selected && core->event_state == EVENT_EMPTY &&
        !core->transport_read_lease_valid && core->poison_flags == 0U) {
      (void)start_read(core);
    }
  }
  if (core->parser_complete && !core->redirect_pending &&
      !core->terminal_selected && core->event_state == EVENT_EMPTY &&
      !core->body_lease_active) {
    select_success(core);
  }
  progress_terminal(core);
  return true;
}

bool pocketjs_net_http_client_core_grant_body_credit(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_operation_token_t operation_token,
    size_t maximum_bytes) {
  if (!core_public_entry_allowed(core) ||
      operation_token != core->operation_token || !core->headers_delivered ||
      core->body_lease_active || core->body_credit != 0U ||
      maximum_bytes == 0U ||
      maximum_bytes > POCKETJS_NET_HTTP_CLIENT_CORE_BODY_LEASE_BYTES) {
    return false;
  }

  if (core->terminal_selected) {
    const bool response_exposes_body =
        !ascii_equal_case(core->method, core->method_length, "HEAD") &&
        core->response_status != 204U && core->response_status != 205U &&
        core->response_status != 304U;
    if (!response_exposes_body || core->terminal_body_pull_active ||
        (core->terminal_success && !core->parser_complete)) {
      return false;
    }
    /*
     * A terminal may be selected after headers and before the Guest issues its
     * next pull. Accept one final downstream pull while that terminal is
     * closing or queued so the binding can wait for BODY_END/BODY_ERROR rather
     * than replacing the selected outcome with invalid_state. For successful
     * responses this is also the EOF pull after the last non-empty body lease.
     * Dedicated one-shot state rejects duplicates until terminal retirement
     * resets the operation.
     */
    core->terminal_body_pull_active = true;
    return true;
  }

  if (core->event_state != EVENT_EMPTY) {
    return false;
  }
  core->body_credit = maximum_bytes;
  core->body_byte_count = 0U;
  return true;
}

static bool request_body_credit_matches(
    const pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_operation_token_t operation_token,
    uint64_t body_generation, uint64_t pull_generation) {
  return core->request_body_kind ==
             POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_STREAMING &&
         core->state == CORE_WAITING_REQUEST_BODY && !core->terminal_selected &&
         core->event_state == EVENT_EMPTY && core->request_body_pull_active &&
         core->request_body_pull_event_retired &&
         operation_token == core->operation_token && body_generation != 0U &&
         body_generation == core->request_body_generation &&
         pull_generation != 0U &&
         pull_generation == core->request_body_pull_generation;
}

static void consume_request_body_credit(pocketjs_net_http_client_core_t *core) {
  core->request_body_pull_active = false;
  core->request_body_pull_event_retired = false;
  core->request_body_pull_maximum = 0U;
}

static size_t encode_chunked_request_body(pocketjs_net_http_client_core_t *core,
                                          size_t payload_length) {
  static const uint8_t hex[] = "0123456789abcdef";
  uint8_t reversed[sizeof(size_t) * 2U];
  size_t reversed_length = 0U;
  size_t value = payload_length;
  do {
    reversed[reversed_length++] = hex[value & 0xfU];
    value >>= 4U;
  } while (value != 0U);
  size_t offset = 0U;
  while (reversed_length != 0U) {
    core->write_bytes[offset++] = reversed[--reversed_length];
  }
  core->write_bytes[offset++] = '\r';
  core->write_bytes[offset++] = '\n';
  memmove(core->write_bytes + offset, core->request_body, payload_length);
  offset += payload_length;
  core->write_bytes[offset++] = '\r';
  core->write_bytes[offset++] = '\n';
  return offset;
}

bool pocketjs_net_http_client_core_submit_request_body_chunk(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_operation_token_t operation_token,
    uint64_t body_generation, uint64_t pull_generation, const uint8_t *bytes,
    size_t length) {
  if (!core_public_entry_allowed(core) || bytes == NULL || length == 0U ||
      length > POCKETJS_NET_HTTP_CLIENT_CORE_REQUEST_BODY_CHUNK_BYTES ||
      !request_body_credit_matches(core, operation_token, body_generation,
                                   pull_generation) ||
      length > core->request_body_pull_maximum) {
    return false;
  }
  if (core->request_body_length_known &&
      (core->request_body_submitted_length >
           core->request_body_expected_length ||
       (uint64_t)length > core->request_body_expected_length -
                              core->request_body_submitted_length)) {
    return false;
  }
  memmove(core->request_body, bytes, length);
  consume_request_body_credit(core);
  if ((uint64_t)length > UINT64_MAX - core->request_body_submitted_length) {
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT, 0);
    progress_terminal(core);
    return true;
  }
  core->request_body_submitted_length += (uint64_t)length;
  core->request_body_pending_payload_length = length;
  const uint8_t *wire_bytes = core->request_body;
  size_t wire_length = length;
  if (!core->request_body_length_known) {
    wire_length = encode_chunked_request_body(core, length);
    wire_bytes = core->write_bytes;
  }
  pocketjs_net_http_client_transport_result_t result = start_write(
      core, wire_bytes, wire_length, CORE_WRITING_REQUEST_BODY_CHUNK);
  if (result != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    select_failure(core,
                   result == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_RESOURCE_LIMIT
                       ? POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT
                       : POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT,
                   (int32_t)result);
    progress_terminal(core);
  }
  return true;
}

bool pocketjs_net_http_client_core_submit_request_body_end(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_operation_token_t operation_token,
    uint64_t body_generation, uint64_t pull_generation) {
  if (!core_public_entry_allowed(core) ||
      !request_body_credit_matches(core, operation_token, body_generation,
                                   pull_generation)) {
    return false;
  }
  consume_request_body_credit(core);
  if (core->request_body_length_known) {
    select_failure(
        core, POCKETJS_NET_HTTP_CLIENT_ERROR_REQUEST_BODY,
        POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_CAUSE_LENGTH_UNDERFLOW);
    progress_terminal(core);
    return true;
  }
  static const uint8_t terminal_chunk[] = "0\r\n\r\n";
  memcpy(core->write_bytes, terminal_chunk, sizeof(terminal_chunk) - 1U);
  pocketjs_net_http_client_transport_result_t result =
      start_write(core, core->write_bytes, sizeof(terminal_chunk) - 1U,
                  CORE_WRITING_REQUEST_BODY_END);
  if (result != POCKETJS_NET_HTTP_CLIENT_TRANSPORT_OK) {
    select_failure(core,
                   result == POCKETJS_NET_HTTP_CLIENT_TRANSPORT_RESOURCE_LIMIT
                       ? POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT
                       : POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT,
                   (int32_t)result);
    progress_terminal(core);
  }
  return true;
}

bool pocketjs_net_http_client_core_submit_request_body_error(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_operation_token_t operation_token,
    uint64_t body_generation, uint64_t pull_generation, int32_t cause_code) {
  if (!core_public_entry_allowed(core) ||
      !request_body_credit_matches(core, operation_token, body_generation,
                                   pull_generation)) {
    return false;
  }
  consume_request_body_credit(core);
  select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_REQUEST_BODY, cause_code);
  progress_terminal(core);
  return true;
}

bool pocketjs_net_http_client_core_take_event(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_event_t *out_event) {
  if (!core_public_entry_allowed(core) || out_event == NULL ||
      core->event_state != EVENT_PENDING) {
    return false;
  }
  *out_event = core->event;
  core->event_state = EVENT_DELIVERING;
  return true;
}

static void reset_after_terminal(pocketjs_net_http_client_core_t *core) {
  core->state = CORE_IDLE;
  core->operation_token = 0U;
  core->request_body_kind = POCKETJS_NET_HTTP_CLIENT_REQUEST_BODY_NONE;
  core->request_body_length = 0U;
  core->request_body_length_known = false;
  core->request_body_expected_length = 0U;
  core->request_body_submitted_length = 0U;
  core->request_body_generation = 0U;
  core->request_body_pull_generation = 0U;
  core->request_body_pull_maximum = 0U;
  core->request_body_pending_payload_length = 0U;
  core->request_body_pull_active = false;
  core->request_body_pull_event_retired = false;
  core->body_credit = 0U;
  core->terminal_body_pull_active = false;
  core->body_byte_count = 0U;
  core->body_lease_active = false;
  core->body_lease_released = false;
  core->terminal_selected = false;
  core->terminal_success = false;
  core->terminal_error = 0;
  core->terminal_cause = 0;
  core->final_headers_seen = false;
  core->headers_delivered = false;
  core->parser_complete = false;
  core->force_no_body = false;
  core->callback_error = 0;
  core->response_http_minor = 0U;
  core->response_body_kind = POCKETJS_NET_HTTP1_RESPONSE_BODY_NONE;
  core->response_connection_close = false;
  core->response_connection_reusable = false;
  core->redirect_location_seen = false;
  core->redirect_location = (pocketjs_net_http_client_slice_t){0};
  core->redirect_pending = false;
  core->redirect_mode = POCKETJS_NET_HTTP_CLIENT_REDIRECT_MANUAL;
  core->redirect_count = 0U;
  core->max_redirects = 0U;
  core->connect_candidate_count = 0U;
  core->next_connect_candidate = 0U;
}

bool pocketjs_net_http_client_core_retire_event(
    pocketjs_net_http_client_core_t *core, uint64_t sequence) {
  const bool revoked_request_pull =
      core_public_entry_allowed(core) &&
      core->event_state == EVENT_DELIVERING &&
      core->event.type == POCKETJS_NET_HTTP_CLIENT_EVENT_REQUEST_BODY_PULL &&
      !core->request_body_pull_active && core->terminal_selected;
  if (!core_public_entry_allowed(core) ||
      core->event_state != EVENT_DELIVERING ||
      sequence != core->event.sequence ||
      (core->event.type == POCKETJS_NET_HTTP_CLIENT_EVENT_BODY &&
       !core->body_lease_released) ||
      (core->event.type == POCKETJS_NET_HTTP_CLIENT_EVENT_REQUEST_BODY_PULL &&
       !revoked_request_pull &&
       (!core->request_body_pull_active ||
        core->event.detail.request_body_pull.body_generation !=
            core->request_body_generation ||
        core->event.detail.request_body_pull.pull_generation !=
            core->request_body_pull_generation))) {
    return false;
  }
  pocketjs_net_http_client_event_type_t type = core->event.type;
  core->event_state = EVENT_EMPTY;
  if (type == POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS) {
    core->headers_delivered = true;
  } else if (type == POCKETJS_NET_HTTP_CLIENT_EVENT_BODY) {
    core->body_lease_active = false;
    core->body_lease_released = false;
    core->body_byte_count = 0U;
    core->body_credit = 0U;
  } else if (type == POCKETJS_NET_HTTP_CLIENT_EVENT_REQUEST_BODY_PULL) {
    if (revoked_request_pull) {
      progress_terminal(core);
      return true;
    }
    core->request_body_pull_event_retired = true;
    return true;
  } else {
    reset_after_terminal(core);
    if (core->shutdown_requested && core->connection_valid) {
      (void)start_idle_connection_close(core);
    }
    return true;
  }
  if (core->parser_complete && !core->body_lease_active) {
    select_success(core);
  }
  progress_terminal(core);
  return true;
}

bool pocketjs_net_http_client_core_body_lease_view(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_body_lease_t lease, const uint8_t **out_bytes,
    size_t *out_length) {
  if (out_bytes != NULL) {
    *out_bytes = NULL;
  }
  if (out_length != NULL) {
    *out_length = 0U;
  }
  if (!core_public_entry_allowed(core) || out_bytes == NULL ||
      out_length == NULL || !core->body_lease_active ||
      core->body_lease_released || lease.slot != core->body_lease.slot ||
      lease.generation != core->body_lease.generation) {
    return false;
  }
  *out_bytes = core->body_bytes;
  *out_length = core->body_byte_count;
  return true;
}

bool pocketjs_net_http_client_core_release_body_lease(
    pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_body_lease_t lease) {
  if (!core_public_entry_allowed(core) || !core->body_lease_active ||
      core->body_lease_released || lease.slot != core->body_lease.slot ||
      lease.generation != core->body_lease.generation) {
    return false;
  }
  core->body_lease_released = true;
  return true;
}

bool pocketjs_net_http_client_core_get_status(
    const pocketjs_net_http_client_core_t *core,
    pocketjs_net_http_client_core_status_t *out_status) {
  if (!core_public_entry_allowed(core) || out_status == NULL) {
    return false;
  }
  *out_status = (pocketjs_net_http_client_core_status_t){
      .initialized = true,
      .shutdown_requested = core->shutdown_requested,
      .poisoned = core->poison_flags != 0U,
      .quiescent = core_is_quiescent_internal(core),
      .request_active = core->operation_token != 0U,
      .transport_operation_active = core->transport_active,
      .connection_owned = core->connection_valid,
      .completion_retire_pending = core->completion_retire_pending,
      .event_outstanding = core->event_state != EVENT_EMPTY,
      .request_body_credit_outstanding = core->request_body_pull_active,
      .connection_reusable =
          core->connection_valid && core->connection_reusable,
      .transport_read_leases_owned = owned_transport_read_lease_count(core),
      .poison_flags = core->poison_flags,
      .first_poison_cause_code = core->first_poison_cause_code,
      .lifecycle_generation = core->lifecycle_generation,
      .operation_token = core->operation_token,
      .request_body_generation = core->request_body_generation,
      .request_body_pull_generation = core->request_body_pull_generation,
  };
  return true;
}

bool pocketjs_net_http_client_core_begin_shutdown(
    pocketjs_net_http_client_core_t *core, uint64_t now_us) {
  if (!core_public_entry_allowed(core) || now_us == 0U) {
    return false;
  }
  core->shutdown_requested = true;
  core->now_us = now_us;
  if (core->operation_token != 0U && !core->terminal_selected) {
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_ABORTED, 0);
  }
  progress_terminal(core);
  if (core->operation_token == 0U && core->state == CORE_IDLE &&
      core->connection_valid) {
    (void)start_idle_connection_close(core);
  }
  return true;
}

bool pocketjs_net_http_client_core_is_quiescent(
    const pocketjs_net_http_client_core_t *core) {
  return core_public_entry_allowed(core) && core_is_quiescent_internal(core);
}

bool pocketjs_net_http_client_core_confirm_transport_shutdown(
    pocketjs_net_http_client_core_t *core) {
  if (!core_public_entry_allowed(core) || !core->shutdown_requested) {
    return false;
  }
  core->transport_active = false;
  core->transport_operation_kind = TRANSPORT_OPERATION_NONE;
  core->transport_operation_token = 0U;
  core->transport_cancel_requested = false;
  core->close_cancel_requested = false;
  core->connection_valid = false;
  core->connection_reusable = false;
  core->connection_idle_deadline_us = 0U;
  core->transport_read_lease_valid = false;
  core->transport_read_bytes = NULL;
  core->transport_read_length = 0U;
  core->transport_read_offset = 0U;
  core->transport_read_eof_pending = false;
  core->orphan_read_lease_valid = false;
  core->completion_retire_pending = false;
  core->completion_retire_token = 0U;
  core->transport_shutdown_confirmed = true;
  if (core->operation_token == 0U &&
      core->state == CORE_IDLE_CONNECTION_CLOSING) {
    core->state = CORE_IDLE;
  }
  progress_terminal(core);
  return true;
}

bool pocketjs_net_http_client_core_report_host_event_retire_failure(
    pocketjs_net_http_client_core_t *core, uint64_t sequence) {
  if (!core_public_entry_allowed(core) ||
      core->event_state != EVENT_DELIVERING ||
      core->event.sequence != sequence) {
    return false;
  }
  poison_core(core, POCKETJS_NET_HTTP_CLIENT_POISON_HOST_EVENT_RETIRE, 0);
  if (core->operation_token != 0U && !core->terminal_selected) {
    select_failure(core, POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT, 0);
  }
  return true;
}

bool pocketjs_net_http_client_core_abandon_event_after_transport_shutdown(
    pocketjs_net_http_client_core_t *core, uint64_t sequence) {
  if (!core_public_entry_allowed(core) || !core->shutdown_requested ||
      core->poison_flags == 0U || !core->transport_shutdown_confirmed ||
      core->event_state != EVENT_DELIVERING ||
      core->event.sequence != sequence) {
    return false;
  }

  const pocketjs_net_http_client_event_type_t type = core->event.type;
  core->event_state = EVENT_EMPTY;
  memset(&core->event, 0, sizeof(core->event));
  if (type == POCKETJS_NET_HTTP_CLIENT_EVENT_BODY) {
    core->body_lease_active = false;
    core->body_lease_released = false;
    core->body_lease = (pocketjs_net_http_client_body_lease_t){0};
    core->body_byte_count = 0U;
    core->body_credit = 0U;
  } else if (type == POCKETJS_NET_HTTP_CLIENT_EVENT_REQUEST_BODY_PULL) {
    revoke_request_body_credit(core);
  } else if (type == POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE ||
             type == POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR) {
    reset_after_terminal(core);
    return true;
  }

  /* begin_shutdown selected the aborted terminal before transport teardown.
   * With native ownership confirmed absent, this can only publish that retained
   * terminal; it cannot call the destroyed transport. */
  progress_terminal(core);
  return true;
}

bool pocketjs_net_http_client_core_deinit(
    pocketjs_net_http_client_core_t *core) {
  if (!core_public_entry_allowed(core) || !core->shutdown_requested ||
      !core_is_quiescent_internal(core)) {
    return false;
  }
  memset(core, 0, sizeof(*core));
  return true;
}
