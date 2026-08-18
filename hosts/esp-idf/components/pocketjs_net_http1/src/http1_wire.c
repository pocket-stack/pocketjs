// SPDX-License-Identifier: MIT

#include "pocketjs/net/http1_wire.h"

#include <limits.h>
#include <string.h>

const pocketjs_net_http1_limits_t pocketjs_net_http1_default_limits = {
    .max_header_bytes = POCKETJS_NET_HTTP1_DEFAULT_HEADER_BYTES,
    .max_header_fields = POCKETJS_NET_HTTP1_DEFAULT_HEADER_FIELDS,
    .max_line_bytes = POCKETJS_NET_HTTP1_DEFAULT_LINE_BYTES,
    .max_informational_responses =
        POCKETJS_NET_HTTP1_DEFAULT_INFORMATIONAL_RESPONSES,
};

static bool ascii_is_alpha(uint8_t byte) {
  return (byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z');
}

static bool ascii_is_digit(uint8_t byte) {
  return byte >= '0' && byte <= '9';
}

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

static bool ascii_is_hex(uint8_t byte) {
  return ascii_is_digit(byte) || (byte >= 'A' && byte <= 'F') ||
         (byte >= 'a' && byte <= 'f');
}

static unsigned ascii_hex_value(uint8_t byte) {
  if (ascii_is_digit(byte)) {
    return (unsigned)(byte - '0');
  }
  return (unsigned)(ascii_lower(byte) - 'a' + 10);
}

static bool is_tchar(uint8_t byte) {
  return ascii_is_alpha(byte) || ascii_is_digit(byte) || byte == '!' ||
         byte == '#' || byte == '$' || byte == '%' || byte == '&' ||
         byte == '\'' || byte == '*' || byte == '+' || byte == '-' ||
         byte == '.' || byte == '^' || byte == '_' || byte == '`' ||
         byte == '|' || byte == '~';
}

static bool is_unreserved(uint8_t byte) {
  return ascii_is_alpha(byte) || ascii_is_digit(byte) || byte == '-' ||
         byte == '.' || byte == '_' || byte == '~';
}

static bool is_sub_delim(uint8_t byte) {
  return byte == '!' || byte == '$' || byte == '&' || byte == '\'' ||
         byte == '(' || byte == ')' || byte == '*' || byte == '+' ||
         byte == ',' || byte == ';' || byte == '=';
}

static bool valid_percent_encoding(const uint8_t *data, size_t length,
                                   size_t *index) {
  if (*index + 2U >= length || !ascii_is_hex(data[*index + 1U]) ||
      !ascii_is_hex(data[*index + 2U])) {
    return false;
  }
  *index += 2U;
  return true;
}

static bool valid_method(pocketjs_net_http1_slice_t method) {
  if (method.data == NULL || method.length == 0) {
    return false;
  }
  for (size_t index = 0; index < method.length; ++index) {
    if (!is_tchar(method.data[index])) {
      return false;
    }
  }
  return true;
}

static bool valid_target(pocketjs_net_http1_slice_t target) {
  if (target.data == NULL || target.length == 0 || target.data[0] != '/') {
    return false;
  }
  bool in_query = false;
  for (size_t index = 0; index < target.length; ++index) {
    uint8_t byte = target.data[index];
    if (byte == '?') {
      if (!in_query) {
        in_query = true;
      }
      continue;
    }
    if (byte == '%') {
      if (!valid_percent_encoding(target.data, target.length, &index)) {
        return false;
      }
      continue;
    }
    if (byte == '/' || is_unreserved(byte) || is_sub_delim(byte) ||
        byte == ':' || byte == '@' || (in_query && byte == '?')) {
      continue;
    }
    return false;
  }
  return true;
}

static bool valid_port(const uint8_t *data, size_t length) {
  if (length == 0) {
    return false;
  }
  unsigned port = 0;
  for (size_t index = 0; index < length; ++index) {
    if (!ascii_is_digit(data[index])) {
      return false;
    }
    unsigned digit = (unsigned)(data[index] - '0');
    if (port > (65535U - digit) / 10U) {
      return false;
    }
    port = port * 10U + digit;
  }
  return port != 0U;
}

static bool valid_reg_name(const uint8_t *data, size_t length) {
  if (length == 0) {
    return false;
  }
  for (size_t index = 0; index < length; ++index) {
    uint8_t byte = data[index];
    if (byte == '%') {
      if (!valid_percent_encoding(data, length, &index)) {
        return false;
      }
    } else if (!is_unreserved(byte) && !is_sub_delim(byte)) {
      return false;
    }
  }
  return true;
}

static bool valid_ipv4_address(const uint8_t *data, size_t length) {
  size_t index = 0;
  for (unsigned part = 0; part < 4U; ++part) {
    size_t start = index;
    unsigned value = 0;
    while (index < length && ascii_is_digit(data[index])) {
      unsigned digit = (unsigned)(data[index] - '0');
      if (value > (255U - digit) / 10U) {
        return false;
      }
      value = value * 10U + digit;
      ++index;
    }
    if (start == index || (index - start > 1U && data[start] == '0')) {
      return false;
    }
    if (part == 3U) {
      return index == length;
    }
    if (index == length || data[index] != '.') {
      return false;
    }
    ++index;
  }
  return false;
}

static bool valid_ipv6_address(const uint8_t *data, size_t length) {
  if (length == 0) {
    return false;
  }
  size_t index = 0;
  unsigned groups = 0;
  bool compressed = false;
  if (data[0] == ':') {
    if (length < 2U || data[1] != ':') {
      return false;
    }
    compressed = true;
    index = 2U;
    if (index == length) {
      return true;
    }
  }

  while (index < length) {
    size_t start = index;
    bool has_dot = false;
    while (index < length && data[index] != ':') {
      has_dot = has_dot || data[index] == '.';
      ++index;
    }
    size_t group_length = index - start;
    if (group_length == 0) {
      return false;
    }
    if (has_dot) {
      if (index != length || groups > 6U ||
          !valid_ipv4_address(data + start, group_length)) {
        return false;
      }
      groups += 2U;
      break;
    }
    if (group_length > 4U) {
      return false;
    }
    for (size_t digit = start; digit < index; ++digit) {
      if (!ascii_is_hex(data[digit])) {
        return false;
      }
    }
    if (++groups > 8U) {
      return false;
    }
    if (index == length) {
      break;
    }

    ++index;
    if (index == length) {
      return false;
    }
    if (data[index] == ':') {
      if (compressed) {
        return false;
      }
      compressed = true;
      ++index;
      if (index == length) {
        break;
      }
    }
  }
  return compressed ? groups < 8U : groups == 8U;
}

static bool valid_host(pocketjs_net_http1_slice_t host) {
  if (host.data == NULL || host.length == 0) {
    return false;
  }
  if (host.data[0] == '[') {
    size_t close = 1;
    for (; close < host.length && host.data[close] != ']'; ++close) {
      /* Locate the closing bracket before validating the complete address. */
    }
    if (close == 1 || close >= host.length ||
        !valid_ipv6_address(host.data + 1U, close - 1U)) {
      return false;
    }
    if (close + 1U == host.length) {
      return true;
    }
    return host.data[close + 1U] == ':' &&
           valid_port(host.data + close + 2U, host.length - close - 2U);
  }

  size_t colon = host.length;
  for (size_t index = 0; index < host.length; ++index) {
    if (host.data[index] == ':') {
      if (colon != host.length) {
        return false;
      }
      colon = index;
    }
  }
  size_t name_length = colon == host.length ? host.length : colon;
  if (!valid_reg_name(host.data, name_length)) {
    return false;
  }
  return colon == host.length ||
         valid_port(host.data + colon + 1U, host.length - colon - 1U);
}

static bool valid_field_name(pocketjs_net_http1_slice_t name) {
  if (name.data == NULL || name.length == 0) {
    return false;
  }
  for (size_t index = 0; index < name.length; ++index) {
    if (!is_tchar(name.data[index])) {
      return false;
    }
  }
  return true;
}

static bool valid_field_value(pocketjs_net_http1_slice_t value) {
  if (value.length != 0 && value.data == NULL) {
    return false;
  }
  for (size_t index = 0; index < value.length; ++index) {
    uint8_t byte = value.data[index];
    if (byte != '\t' && (byte < 0x20U || byte == 0x7fU)) {
      return false;
    }
  }
  return true;
}

static bool add_size(size_t *value, size_t increment) {
  if (*value > SIZE_MAX - increment) {
    return false;
  }
  *value += increment;
  return true;
}

static bool valid_limits(const pocketjs_net_http1_limits_t *limits) {
  return limits != NULL && limits->max_header_bytes >= 2U &&
         limits->max_header_bytes <= POCKETJS_NET_HTTP1_MAX_HEADER_BYTES &&
         limits->max_header_fields != 0 && limits->max_line_bytes != 0 &&
         limits->max_header_fields <= POCKETJS_NET_HTTP1_MAX_HEADER_FIELDS &&
         limits->max_line_bytes <= POCKETJS_NET_HTTP1_MAX_LINE_BYTES &&
         limits->max_informational_responses != 0 &&
         limits->max_informational_responses <=
             POCKETJS_NET_HTTP1_MAX_INFORMATIONAL_RESPONSES;
}

const char *pocketjs_net_http1_wire_error_name(
    pocketjs_net_http1_wire_error_t error) {
  static const char *const names[] = {
      "none",
      "invalid_argument",
      "invalid_method",
      "forbidden_method",
      "invalid_target",
      "invalid_host",
      "invalid_header",
      "forbidden_request_header",
      "line_too_long",
      "header_bytes_exceeded",
      "header_fields_exceeded",
      "too_many_informational_responses",
      "invalid_status_line",
      "switching_protocols_unsupported",
      "obs_fold",
      "invalid_content_length",
      "duplicate_content_length",
      "invalid_transfer_encoding",
      "duplicate_transfer_encoding",
      "ambiguous_framing",
      "invalid_trailer_declaration",
      "forbidden_trailer",
      "invalid_chunk_size",
      "callback_rejected",
      "unexpected_eof",
  };
  size_t index = (size_t)error;
  return index < sizeof(names) / sizeof(names[0]) ? names[index]
                                                  : "unknown";
}

bool pocketjs_net_http1_wire_error_is_limit(
    pocketjs_net_http1_wire_error_t error) {
  return error == POCKETJS_NET_HTTP1_WIRE_ERROR_LINE_TOO_LONG ||
         error == POCKETJS_NET_HTTP1_WIRE_ERROR_HEADER_BYTES_EXCEEDED ||
         error == POCKETJS_NET_HTTP1_WIRE_ERROR_HEADER_FIELDS_EXCEEDED ||
         error ==
             POCKETJS_NET_HTTP1_WIRE_ERROR_TOO_MANY_INFORMATIONAL_RESPONSES;
}

static pocketjs_net_http1_wire_error_t validate_request(
    const pocketjs_net_http1_request_t *request,
    const pocketjs_net_http1_limits_t *limits, size_t decimal_length) {
  if (request == NULL || !valid_limits(limits) ||
      (request->header_count != 0 && request->headers == NULL) ||
      request->body_kind > POCKETJS_NET_HTTP1_REQUEST_BODY_CHUNKED ||
      (request->body_kind != POCKETJS_NET_HTTP1_REQUEST_BODY_FIXED &&
       request->content_length != 0)) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_ARGUMENT;
  }
  if (!valid_method(request->method)) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_METHOD;
  }
  if (ascii_equal_case(request->method.data, request->method.length, "CONNECT") ||
      ascii_equal_case(request->method.data, request->method.length, "TRACE") ||
      ascii_equal_case(request->method.data, request->method.length, "TRACK")) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_FORBIDDEN_METHOD;
  }
  if (!valid_target(request->target)) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_TARGET;
  }
  if (!valid_host(request->host)) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_HOST;
  }

  size_t framing_fields =
      request->body_kind == POCKETJS_NET_HTTP1_REQUEST_BODY_NONE ? 0U : 1U;
  if (limits->max_header_fields < 1U + framing_fields ||
      request->header_count >
          limits->max_header_fields - 1U - framing_fields) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_HEADER_FIELDS_EXCEEDED;
  }

  size_t wire_bytes = 0;
  size_t request_line = request->method.length;
  if (!add_size(&request_line, request->target.length) ||
      !add_size(&request_line, sizeof("  HTTP/1.1\r\n") - 1U)) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_HEADER_BYTES_EXCEEDED;
  }
  if (request_line - 2U > limits->max_line_bytes ||
      !add_size(&wire_bytes, request_line)) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_LINE_TOO_LONG;
  }

  size_t fields = 1U;
  size_t host_line = sizeof("Host: \r\n") - 1U;
  if (!add_size(&host_line, request->host.length) ||
      host_line - 2U > limits->max_line_bytes ||
      !add_size(&wire_bytes, host_line)) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_LINE_TOO_LONG;
  }

  for (size_t index = 0; index < request->header_count; ++index) {
    const pocketjs_net_http1_header_t *header = &request->headers[index];
    if (!valid_field_name(header->name) || !valid_field_value(header->value)) {
      return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_HEADER;
    }
    if (ascii_equal_case(header->name.data, header->name.length, "Host") ||
        ascii_equal_case(header->name.data, header->name.length,
                         "Content-Length") ||
        ascii_equal_case(header->name.data, header->name.length,
                         "Transfer-Encoding") ||
        ascii_equal_case(header->name.data, header->name.length, "Trailer")) {
      return POCKETJS_NET_HTTP1_WIRE_ERROR_FORBIDDEN_REQUEST_HEADER;
    }
    size_t line = header->name.length;
    if (!add_size(&line, header->value.length) || !add_size(&line, 4U) ||
        line - 2U > limits->max_line_bytes || !add_size(&wire_bytes, line)) {
      return POCKETJS_NET_HTTP1_WIRE_ERROR_LINE_TOO_LONG;
    }
    ++fields;
  }

  if (request->body_kind != POCKETJS_NET_HTTP1_REQUEST_BODY_NONE) {
    size_t framing_line =
        request->body_kind == POCKETJS_NET_HTTP1_REQUEST_BODY_FIXED
            ? sizeof("Content-Length: \r\n") - 1U + decimal_length
            : sizeof("Transfer-Encoding: chunked\r\n") - 1U;
    if (framing_line - 2U > limits->max_line_bytes ||
        !add_size(&wire_bytes, framing_line)) {
      return POCKETJS_NET_HTTP1_WIRE_ERROR_LINE_TOO_LONG;
    }
    ++fields;
  }
  if (!add_size(&wire_bytes, 2U)) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_HEADER_BYTES_EXCEEDED;
  }
  if (fields > limits->max_header_fields) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_HEADER_FIELDS_EXCEEDED;
  }
  if (wire_bytes > limits->max_header_bytes) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_HEADER_BYTES_EXCEEDED;
  }
  return POCKETJS_NET_HTTP1_WIRE_ERROR_NONE;
}

enum request_encoder_phase {
  REQUEST_PHASE_METHOD = 0,
  REQUEST_PHASE_METHOD_SPACE,
  REQUEST_PHASE_TARGET,
  REQUEST_PHASE_VERSION,
  REQUEST_PHASE_HOST_PREFIX,
  REQUEST_PHASE_HOST,
  REQUEST_PHASE_HOST_END,
  REQUEST_PHASE_HEADER_NAME,
  REQUEST_PHASE_HEADER_SEPARATOR,
  REQUEST_PHASE_HEADER_VALUE,
  REQUEST_PHASE_HEADER_END,
  REQUEST_PHASE_FRAMING_PREFIX,
  REQUEST_PHASE_FRAMING_VALUE,
  REQUEST_PHASE_FRAMING_END,
  REQUEST_PHASE_FINAL_END,
  REQUEST_PHASE_DONE,
};

static size_t write_decimal(uint64_t value, uint8_t output[20]) {
  uint8_t reversed[20];
  size_t length = 0;
  do {
    reversed[length++] = (uint8_t)('0' + value % 10U);
    value /= 10U;
  } while (value != 0);
  for (size_t index = 0; index < length; ++index) {
    output[index] = reversed[length - index - 1U];
  }
  return length;
}

pocketjs_net_http1_wire_error_t pocketjs_net_http1_request_encoder_init(
    pocketjs_net_http1_request_encoder_t *encoder,
    const pocketjs_net_http1_request_t *request,
    const pocketjs_net_http1_limits_t *limits) {
  if (encoder == NULL) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_ARGUMENT;
  }
  memset(encoder, 0, sizeof(*encoder));
  if (request == NULL) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_ARGUMENT;
  }
  size_t decimal_length =
      write_decimal(request->content_length, encoder->content_length_decimal);
  pocketjs_net_http1_wire_error_t error =
      validate_request(request, limits, decimal_length);
  if (error != POCKETJS_NET_HTTP1_WIRE_ERROR_NONE) {
    return error;
  }
  encoder->request = *request;
  encoder->content_length_decimal_length = decimal_length;
  encoder->phase = REQUEST_PHASE_METHOD;
  encoder->initialized = true;
  return POCKETJS_NET_HTTP1_WIRE_ERROR_NONE;
}

static void request_encoder_segment(
    const pocketjs_net_http1_request_encoder_t *encoder, const uint8_t **data,
    size_t *length) {
  static const uint8_t space[] = " ";
  static const uint8_t version[] = " HTTP/1.1\r\n";
  static const uint8_t host_prefix[] = "Host: ";
  static const uint8_t separator[] = ": ";
  static const uint8_t line_end[] = "\r\n";
  static const uint8_t content_length_prefix[] = "Content-Length: ";
  static const uint8_t transfer_encoding[] = "Transfer-Encoding: chunked";

  *data = NULL;
  *length = 0;
  switch ((enum request_encoder_phase)encoder->phase) {
    case REQUEST_PHASE_METHOD:
      *data = encoder->request.method.data;
      *length = encoder->request.method.length;
      break;
    case REQUEST_PHASE_METHOD_SPACE:
      *data = space;
      *length = sizeof(space) - 1U;
      break;
    case REQUEST_PHASE_TARGET:
      *data = encoder->request.target.data;
      *length = encoder->request.target.length;
      break;
    case REQUEST_PHASE_VERSION:
      *data = version;
      *length = sizeof(version) - 1U;
      break;
    case REQUEST_PHASE_HOST_PREFIX:
      *data = host_prefix;
      *length = sizeof(host_prefix) - 1U;
      break;
    case REQUEST_PHASE_HOST:
      *data = encoder->request.host.data;
      *length = encoder->request.host.length;
      break;
    case REQUEST_PHASE_HOST_END:
    case REQUEST_PHASE_HEADER_END:
    case REQUEST_PHASE_FRAMING_END:
    case REQUEST_PHASE_FINAL_END:
      *data = line_end;
      *length = sizeof(line_end) - 1U;
      break;
    case REQUEST_PHASE_HEADER_NAME:
      *data = encoder->request.headers[encoder->header_index].name.data;
      *length = encoder->request.headers[encoder->header_index].name.length;
      break;
    case REQUEST_PHASE_HEADER_SEPARATOR:
      *data = separator;
      *length = sizeof(separator) - 1U;
      break;
    case REQUEST_PHASE_HEADER_VALUE:
      *data = encoder->request.headers[encoder->header_index].value.data;
      *length = encoder->request.headers[encoder->header_index].value.length;
      break;
    case REQUEST_PHASE_FRAMING_PREFIX:
      if (encoder->request.body_kind ==
          POCKETJS_NET_HTTP1_REQUEST_BODY_FIXED) {
        *data = content_length_prefix;
        *length = sizeof(content_length_prefix) - 1U;
      } else {
        *data = transfer_encoding;
        *length = sizeof(transfer_encoding) - 1U;
      }
      break;
    case REQUEST_PHASE_FRAMING_VALUE:
      *data = encoder->content_length_decimal;
      *length = encoder->content_length_decimal_length;
      break;
    case REQUEST_PHASE_DONE:
      break;
  }
}

static void request_encoder_advance(pocketjs_net_http1_request_encoder_t *encoder) {
  switch ((enum request_encoder_phase)encoder->phase) {
    case REQUEST_PHASE_METHOD:
      encoder->phase = REQUEST_PHASE_METHOD_SPACE;
      break;
    case REQUEST_PHASE_METHOD_SPACE:
      encoder->phase = REQUEST_PHASE_TARGET;
      break;
    case REQUEST_PHASE_TARGET:
      encoder->phase = REQUEST_PHASE_VERSION;
      break;
    case REQUEST_PHASE_VERSION:
      encoder->phase = REQUEST_PHASE_HOST_PREFIX;
      break;
    case REQUEST_PHASE_HOST_PREFIX:
      encoder->phase = REQUEST_PHASE_HOST;
      break;
    case REQUEST_PHASE_HOST:
      encoder->phase = REQUEST_PHASE_HOST_END;
      break;
    case REQUEST_PHASE_HOST_END:
      encoder->phase = encoder->request.header_count == 0
                           ? REQUEST_PHASE_FRAMING_PREFIX
                           : REQUEST_PHASE_HEADER_NAME;
      if (encoder->request.header_count == 0 &&
          encoder->request.body_kind == POCKETJS_NET_HTTP1_REQUEST_BODY_NONE) {
        encoder->phase = REQUEST_PHASE_FINAL_END;
      }
      break;
    case REQUEST_PHASE_HEADER_NAME:
      encoder->phase = REQUEST_PHASE_HEADER_SEPARATOR;
      break;
    case REQUEST_PHASE_HEADER_SEPARATOR:
      encoder->phase = REQUEST_PHASE_HEADER_VALUE;
      break;
    case REQUEST_PHASE_HEADER_VALUE:
      encoder->phase = REQUEST_PHASE_HEADER_END;
      break;
    case REQUEST_PHASE_HEADER_END:
      ++encoder->header_index;
      if (encoder->header_index < encoder->request.header_count) {
        encoder->phase = REQUEST_PHASE_HEADER_NAME;
      } else if (encoder->request.body_kind ==
                 POCKETJS_NET_HTTP1_REQUEST_BODY_NONE) {
        encoder->phase = REQUEST_PHASE_FINAL_END;
      } else {
        encoder->phase = REQUEST_PHASE_FRAMING_PREFIX;
      }
      break;
    case REQUEST_PHASE_FRAMING_PREFIX:
      encoder->phase =
          encoder->request.body_kind == POCKETJS_NET_HTTP1_REQUEST_BODY_FIXED
              ? REQUEST_PHASE_FRAMING_VALUE
              : REQUEST_PHASE_FRAMING_END;
      break;
    case REQUEST_PHASE_FRAMING_VALUE:
      encoder->phase = REQUEST_PHASE_FRAMING_END;
      break;
    case REQUEST_PHASE_FRAMING_END:
      encoder->phase = REQUEST_PHASE_FINAL_END;
      break;
    case REQUEST_PHASE_FINAL_END:
      encoder->phase = REQUEST_PHASE_DONE;
      break;
    case REQUEST_PHASE_DONE:
      break;
  }
}

pocketjs_net_http1_encoder_result_t pocketjs_net_http1_request_encoder_write(
    pocketjs_net_http1_request_encoder_t *encoder, uint8_t *output,
    size_t output_capacity, size_t *output_length) {
  if (output_length != NULL) {
    *output_length = 0;
  }
  if (encoder == NULL || !encoder->initialized || output_length == NULL ||
      (output_capacity != 0 && output == NULL)) {
    return POCKETJS_NET_HTTP1_ENCODER_ERROR;
  }
  size_t produced = 0;
  while (produced < output_capacity &&
         encoder->phase != REQUEST_PHASE_DONE) {
    const uint8_t *segment = NULL;
    size_t segment_length = 0;
    request_encoder_segment(encoder, &segment, &segment_length);
    if (encoder->segment_offset == segment_length) {
      encoder->segment_offset = 0;
      request_encoder_advance(encoder);
      continue;
    }
    size_t available = segment_length - encoder->segment_offset;
    size_t capacity = output_capacity - produced;
    size_t amount = available < capacity ? available : capacity;
    memcpy(output + produced, segment + encoder->segment_offset, amount);
    encoder->segment_offset += amount;
    produced += amount;
  }
  while (encoder->phase != REQUEST_PHASE_DONE) {
    const uint8_t *segment = NULL;
    size_t segment_length = 0;
    request_encoder_segment(encoder, &segment, &segment_length);
    (void)segment;
    if (encoder->segment_offset != segment_length) {
      break;
    }
    encoder->segment_offset = 0;
    request_encoder_advance(encoder);
  }
  *output_length = produced;
  return encoder->phase == REQUEST_PHASE_DONE
             ? POCKETJS_NET_HTTP1_ENCODER_DONE
             : POCKETJS_NET_HTTP1_ENCODER_MORE;
}

static pocketjs_net_http1_parse_result_t parser_fail(
    pocketjs_net_http1_response_parser_t *parser,
    pocketjs_net_http1_wire_error_t error) {
  parser->error = error;
  parser->state = POCKETJS_NET_HTTP1_PARSER_ERROR;
  return POCKETJS_NET_HTTP1_PARSE_ERROR;
}

static bool parser_complete(pocketjs_net_http1_response_parser_t *parser) {
  parser->state = POCKETJS_NET_HTTP1_PARSER_COMPLETE;
  if (!parser->complete_notified) {
    parser->complete_notified = true;
    if (parser->callbacks.on_complete != NULL) {
      parser->callbacks.on_complete(parser->callback_context);
    }
  }
  return true;
}

static void trim_ows(const uint8_t *data, size_t length, size_t *start,
                     size_t *end) {
  *start = 0;
  *end = length;
  while (*start < *end &&
         (data[*start] == ' ' || data[*start] == '\t')) {
    ++*start;
  }
  while (*end > *start &&
         (data[*end - 1U] == ' ' || data[*end - 1U] == '\t')) {
    --*end;
  }
}

static bool parse_content_length(const uint8_t *data, size_t length,
                                 uint64_t *result) {
  if (length == 0) {
    return false;
  }
  uint64_t value = 0;
  for (size_t index = 0; index < length; ++index) {
    if (!ascii_is_digit(data[index])) {
      return false;
    }
    unsigned digit = (unsigned)(data[index] - '0');
    if (value > (UINT64_MAX - digit) / 10U) {
      return false;
    }
    value = value * 10U + digit;
  }
  *result = value;
  return true;
}

static bool trailer_name_forbidden(const uint8_t *name, size_t length) {
  static const char *const forbidden[] = {
      "content-length",       "transfer-encoding", "host",
      "content-encoding",
      "connection",           "trailer",           "upgrade",
      "authorization",        "proxy-authorization",
      "proxy-authenticate",   "www-authenticate",  "authentication-info",
      "proxy-authentication-info", "te",            "keep-alive",
      "proxy-connection",
  };
  for (size_t index = 0; index < sizeof(forbidden) / sizeof(forbidden[0]);
       ++index) {
    if (ascii_equal_case(name, length, forbidden[index])) {
      return true;
    }
  }
  return false;
}

static bool validate_trailer_declaration(const uint8_t *value, size_t length) {
  size_t index = 0;
  bool saw_name = false;
  for (;;) {
    while (index < length && (value[index] == ' ' || value[index] == '\t')) {
      ++index;
    }
    if (index == length) {
      return false;
    }
    size_t start = index;
    while (index < length && is_tchar(value[index])) {
      ++index;
    }
    if (start == index || trailer_name_forbidden(value + start, index - start)) {
      return false;
    }
    saw_name = true;
    while (index < length && (value[index] == ' ' || value[index] == '\t')) {
      ++index;
    }
    if (index == length) {
      return saw_name;
    }
    if (value[index] != ',') {
      return false;
    }
    ++index;
  }
}

static pocketjs_net_http1_wire_error_t parse_status_line(
    pocketjs_net_http1_response_parser_t *parser) {
  const uint8_t *line = parser->line;
  size_t length = parser->line_length;
  if (length < 13U || memcmp(line, "HTTP/1.", 7U) != 0 ||
      (line[7] != '0' && line[7] != '1') || line[8] != ' ' ||
      !ascii_is_digit(line[9]) || !ascii_is_digit(line[10]) ||
      !ascii_is_digit(line[11]) || line[12] != ' ') {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_STATUS_LINE;
  }
  unsigned status = (unsigned)(line[9] - '0') * 100U +
                    (unsigned)(line[10] - '0') * 10U +
                    (unsigned)(line[11] - '0');
  if (status < 100U || status > 599U) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_STATUS_LINE;
  }
  if (status == 101U) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_SWITCHING_PROTOCOLS_UNSUPPORTED;
  }
  for (size_t index = 13U; index < length; ++index) {
    uint8_t byte = line[index];
    if (byte != '\t' && (byte < 0x20U || byte == 0x7fU)) {
      return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_STATUS_LINE;
    }
  }
  parser->http_minor = (unsigned)(line[7] - '0');
  parser->status_code = status;
  parser->saw_content_length = false;
  parser->saw_transfer_encoding = false;
  parser->saw_trailer_declaration = false;
  parser->content_length = 0;
  bool informational = status < 200U;
  if (parser->callbacks.on_status != NULL &&
      !parser->callbacks.on_status(parser->callback_context,
                                   parser->http_minor, status, line + 13U,
                                   length - 13U, informational)) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_CALLBACK_REJECTED;
  }
  return POCKETJS_NET_HTTP1_WIRE_ERROR_NONE;
}

static pocketjs_net_http1_wire_error_t parse_header_line(
    pocketjs_net_http1_response_parser_t *parser, bool trailer) {
  const uint8_t *line = parser->line;
  size_t length = parser->line_length;
  if (line[0] == ' ' || line[0] == '\t') {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_OBS_FOLD;
  }
  size_t colon = 0;
  while (colon < length && line[colon] != ':') {
    ++colon;
  }
  if (colon == 0 || colon == length) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_HEADER;
  }
  pocketjs_net_http1_slice_t name = {.data = line, .length = colon};
  if (!valid_field_name(name)) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_HEADER;
  }
  pocketjs_net_http1_slice_t raw_value = {
      .data = line + colon + 1U,
      .length = length - colon - 1U,
  };
  if (!valid_field_value(raw_value)) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_HEADER;
  }
  size_t value_start = 0;
  size_t value_end = 0;
  trim_ows(raw_value.data, raw_value.length, &value_start, &value_end);
  const uint8_t *value = raw_value.data + value_start;
  size_t value_length = value_end - value_start;

  ++parser->header_fields_used;
  if (parser->header_fields_used > parser->limits.max_header_fields) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_HEADER_FIELDS_EXCEEDED;
  }
  if (trailer) {
    if (trailer_name_forbidden(name.data, name.length)) {
      return POCKETJS_NET_HTTP1_WIRE_ERROR_FORBIDDEN_TRAILER;
    }
    ++parser->validated_trailer_fields;
    return POCKETJS_NET_HTTP1_WIRE_ERROR_NONE;
  }

  if (ascii_equal_case(name.data, name.length, "Content-Length")) {
    if (parser->saw_content_length) {
      return POCKETJS_NET_HTTP1_WIRE_ERROR_DUPLICATE_CONTENT_LENGTH;
    }
    uint64_t parsed = 0;
    if (!parse_content_length(value, value_length, &parsed)) {
      return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_CONTENT_LENGTH;
    }
    parser->saw_content_length = true;
    parser->content_length = parsed;
  } else if (ascii_equal_case(name.data, name.length, "Transfer-Encoding")) {
    if (parser->saw_transfer_encoding) {
      return POCKETJS_NET_HTTP1_WIRE_ERROR_DUPLICATE_TRANSFER_ENCODING;
    }
    if (!ascii_equal_case(value, value_length, "chunked")) {
      return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_TRANSFER_ENCODING;
    }
    parser->saw_transfer_encoding = true;
  } else if (ascii_equal_case(name.data, name.length, "Trailer")) {
    if (!validate_trailer_declaration(value, value_length)) {
      return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_TRAILER_DECLARATION;
    }
    parser->saw_trailer_declaration = true;
  }

  bool informational = parser->status_code < 200U;
  if (parser->callbacks.on_header != NULL &&
      !parser->callbacks.on_header(parser->callback_context, name.data,
                                   name.length, value, value_length,
                                   informational)) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_CALLBACK_REJECTED;
  }
  return POCKETJS_NET_HTTP1_WIRE_ERROR_NONE;
}

static pocketjs_net_http1_wire_error_t finish_headers(
    pocketjs_net_http1_response_parser_t *parser) {
  if (parser->saw_content_length && parser->saw_transfer_encoding) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_AMBIGUOUS_FRAMING;
  }
  if (parser->http_minor == 0U && parser->saw_transfer_encoding) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_TRANSFER_ENCODING;
  }
  bool informational = parser->status_code < 200U;
  if (informational) {
    if (parser->saw_content_length || parser->saw_transfer_encoding ||
        parser->saw_trailer_declaration) {
      return POCKETJS_NET_HTTP1_WIRE_ERROR_AMBIGUOUS_FRAMING;
    }
    ++parser->informational_responses;
    if (parser->informational_responses >
        parser->limits.max_informational_responses) {
      return POCKETJS_NET_HTTP1_WIRE_ERROR_TOO_MANY_INFORMATIONAL_RESPONSES;
    }
    if (parser->callbacks.on_headers_complete != NULL &&
        !parser->callbacks.on_headers_complete(
            parser->callback_context, parser->status_code,
            POCKETJS_NET_HTTP1_RESPONSE_BODY_NONE, 0, true)) {
      return POCKETJS_NET_HTTP1_WIRE_ERROR_CALLBACK_REJECTED;
    }
    parser->state = POCKETJS_NET_HTTP1_PARSER_STATUS_LINE;
    return POCKETJS_NET_HTTP1_WIRE_ERROR_NONE;
  }

  bool no_body = parser->response_to_head || parser->status_code == 204U ||
                 parser->status_code == 304U;
  if (parser->status_code == 204U &&
      (parser->saw_content_length || parser->saw_transfer_encoding)) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_AMBIGUOUS_FRAMING;
  }
  if (no_body && parser->saw_trailer_declaration) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_TRAILER_DECLARATION;
  }
  if (parser->saw_trailer_declaration &&
      !parser->saw_transfer_encoding) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_TRAILER_DECLARATION;
  }

  pocketjs_net_http1_response_body_kind_t body_kind;
  if (no_body) {
    body_kind = POCKETJS_NET_HTTP1_RESPONSE_BODY_NONE;
  } else if (parser->saw_transfer_encoding) {
    body_kind = POCKETJS_NET_HTTP1_RESPONSE_BODY_CHUNKED;
  } else if (parser->saw_content_length) {
    body_kind = POCKETJS_NET_HTTP1_RESPONSE_BODY_FIXED;
  } else {
    body_kind = POCKETJS_NET_HTTP1_RESPONSE_BODY_UNTIL_EOF;
  }
  if (parser->callbacks.on_headers_complete != NULL &&
      !parser->callbacks.on_headers_complete(
          parser->callback_context, parser->status_code, body_kind,
          parser->saw_content_length ? parser->content_length : 0, false)) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_CALLBACK_REJECTED;
  }

  if (no_body ||
      (body_kind == POCKETJS_NET_HTTP1_RESPONSE_BODY_FIXED &&
       parser->content_length == 0)) {
    parser_complete(parser);
  } else if (body_kind == POCKETJS_NET_HTTP1_RESPONSE_BODY_FIXED) {
    parser->body_remaining = parser->content_length;
    parser->state = POCKETJS_NET_HTTP1_PARSER_FIXED_BODY;
  } else if (body_kind == POCKETJS_NET_HTTP1_RESPONSE_BODY_CHUNKED) {
    parser->state = POCKETJS_NET_HTTP1_PARSER_CHUNK_SIZE_LINE;
  } else {
    parser->state = POCKETJS_NET_HTTP1_PARSER_EOF_BODY;
  }
  return POCKETJS_NET_HTTP1_WIRE_ERROR_NONE;
}

static bool valid_chunk_extension(const uint8_t *data, size_t length,
                                  size_t index) {
  while (index < length && (data[index] == ' ' || data[index] == '\t')) {
    ++index;
  }
  while (index < length) {
    if (data[index] != ';') {
      return false;
    }
    ++index;
    while (index < length && (data[index] == ' ' || data[index] == '\t')) {
      ++index;
    }
    size_t name_start = index;
    while (index < length && is_tchar(data[index])) {
      ++index;
    }
    if (name_start == index) {
      return false;
    }
    while (index < length && (data[index] == ' ' || data[index] == '\t')) {
      ++index;
    }
    if (index < length && data[index] == '=') {
      ++index;
      while (index < length && (data[index] == ' ' || data[index] == '\t')) {
        ++index;
      }
      if (index == length) {
        return false;
      }
      if (data[index] == '"') {
        ++index;
        bool closed = false;
        while (index < length) {
          uint8_t byte = data[index++];
          if (byte == '"') {
            closed = true;
            break;
          }
          if (byte == '\\') {
            if (index == length || data[index] == '\r' || data[index] == '\n' ||
                data[index] == 0x7fU ||
                (data[index] < 0x20U && data[index] != '\t')) {
              return false;
            }
            ++index;
          } else if (byte == '\r' || byte == '\n' || byte == 0x7fU ||
                     (byte < 0x20U && byte != '\t')) {
            return false;
          }
        }
        if (!closed) {
          return false;
        }
      } else {
        size_t value_start = index;
        while (index < length && is_tchar(data[index])) {
          ++index;
        }
        if (value_start == index) {
          return false;
        }
      }
      while (index < length && (data[index] == ' ' || data[index] == '\t')) {
        ++index;
      }
    }
  }
  return true;
}

static pocketjs_net_http1_wire_error_t parse_chunk_size_line(
    pocketjs_net_http1_response_parser_t *parser) {
  const uint8_t *line = parser->line;
  size_t length = parser->line_length;
  size_t index = 0;
  uint64_t value = 0;
  while (index < length && ascii_is_hex(line[index])) {
    unsigned digit = ascii_hex_value(line[index]);
    if (value > (UINT64_MAX - digit) / 16U) {
      return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_CHUNK_SIZE;
    }
    value = value * 16U + digit;
    ++index;
  }
  if (index == 0 || !valid_chunk_extension(line, length, index)) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_CHUNK_SIZE;
  }
  parser->chunk_remaining = value;
  parser->state = value == 0 ? POCKETJS_NET_HTTP1_PARSER_TRAILER_LINE
                             : POCKETJS_NET_HTTP1_PARSER_CHUNK_BODY;
  return POCKETJS_NET_HTTP1_WIRE_ERROR_NONE;
}

static pocketjs_net_http1_wire_error_t account_line_byte(
    pocketjs_net_http1_response_parser_t *parser) {
  if (parser->state != POCKETJS_NET_HTTP1_PARSER_HEADER_LINE &&
      parser->state != POCKETJS_NET_HTTP1_PARSER_TRAILER_LINE) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_NONE;
  }
  if (parser->header_bytes_used == parser->limits.max_header_bytes) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_HEADER_BYTES_EXCEEDED;
  }
  ++parser->header_bytes_used;
  return POCKETJS_NET_HTTP1_WIRE_ERROR_NONE;
}

static pocketjs_net_http1_wire_error_t finish_line(
    pocketjs_net_http1_response_parser_t *parser) {
  pocketjs_net_http1_wire_error_t error =
      POCKETJS_NET_HTTP1_WIRE_ERROR_NONE;
  switch (parser->state) {
    case POCKETJS_NET_HTTP1_PARSER_STATUS_LINE:
      error = parse_status_line(parser);
      if (error == POCKETJS_NET_HTTP1_WIRE_ERROR_NONE) {
        parser->state = POCKETJS_NET_HTTP1_PARSER_HEADER_LINE;
      }
      break;
    case POCKETJS_NET_HTTP1_PARSER_HEADER_LINE:
      error = parser->line_length == 0 ? finish_headers(parser)
                                       : parse_header_line(parser, false);
      break;
    case POCKETJS_NET_HTTP1_PARSER_CHUNK_SIZE_LINE:
      error = parse_chunk_size_line(parser);
      break;
    case POCKETJS_NET_HTTP1_PARSER_TRAILER_LINE:
      if (parser->line_length == 0) {
        parser_complete(parser);
      } else {
        error = parse_header_line(parser, true);
      }
      break;
    default:
      error = POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_ARGUMENT;
      break;
  }
  parser->line_length = 0;
  parser->line_cr_pending = false;
  return error;
}

static pocketjs_net_http1_wire_error_t consume_line_byte(
    pocketjs_net_http1_response_parser_t *parser, uint8_t byte,
    bool *line_complete) {
  *line_complete = false;
  pocketjs_net_http1_wire_error_t account = account_line_byte(parser);
  if (account != POCKETJS_NET_HTTP1_WIRE_ERROR_NONE) {
    return account;
  }
  if (parser->line_cr_pending) {
    if (byte != '\n') {
      return parser->state == POCKETJS_NET_HTTP1_PARSER_CHUNK_SIZE_LINE
                 ? POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_CHUNK_SIZE
                 : POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_HEADER;
    }
    *line_complete = true;
    return finish_line(parser);
  }
  if (byte == '\r') {
    parser->line_cr_pending = true;
    return POCKETJS_NET_HTTP1_WIRE_ERROR_NONE;
  }
  if (byte == '\n') {
    return parser->state == POCKETJS_NET_HTTP1_PARSER_CHUNK_SIZE_LINE
               ? POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_CHUNK_SIZE
               : POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_HEADER;
  }
  if (parser->line_length == parser->limits.max_line_bytes) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_LINE_TOO_LONG;
  }
  parser->line[parser->line_length++] = byte;
  return POCKETJS_NET_HTTP1_WIRE_ERROR_NONE;
}

pocketjs_net_http1_wire_error_t pocketjs_net_http1_response_parser_init(
    pocketjs_net_http1_response_parser_t *parser,
    const pocketjs_net_http1_limits_t *limits,
    const pocketjs_net_http1_response_callbacks_t *callbacks,
    void *callback_context, bool response_to_head) {
  if (parser == NULL) {
    return POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_ARGUMENT;
  }
  memset(parser, 0, sizeof(*parser));
  if (!valid_limits(limits) || callbacks == NULL) {
    parser->state = POCKETJS_NET_HTTP1_PARSER_ERROR;
    parser->error = POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_ARGUMENT;
    return parser->error;
  }
  parser->limits = *limits;
  parser->callbacks = *callbacks;
  parser->callback_context = callback_context;
  parser->response_to_head = response_to_head;
  parser->state = POCKETJS_NET_HTTP1_PARSER_STATUS_LINE;
  return POCKETJS_NET_HTTP1_WIRE_ERROR_NONE;
}

static bool parser_is_line_state(pocketjs_net_http1_parser_state_t state) {
  return state == POCKETJS_NET_HTTP1_PARSER_STATUS_LINE ||
         state == POCKETJS_NET_HTTP1_PARSER_HEADER_LINE ||
         state == POCKETJS_NET_HTTP1_PARSER_CHUNK_SIZE_LINE ||
         state == POCKETJS_NET_HTTP1_PARSER_TRAILER_LINE;
}

static pocketjs_net_http1_parse_result_t deliver_body(
    pocketjs_net_http1_response_parser_t *parser, const uint8_t *input,
    size_t amount) {
  if (amount != 0 &&
      (parser->callbacks.on_body == NULL ||
       !parser->callbacks.on_body(parser->callback_context, input, amount))) {
    return parser_fail(parser,
                       POCKETJS_NET_HTTP1_WIRE_ERROR_CALLBACK_REJECTED);
  }
  return POCKETJS_NET_HTTP1_PARSE_NEED_MORE;
}

pocketjs_net_http1_parse_result_t pocketjs_net_http1_response_parser_feed(
    pocketjs_net_http1_response_parser_t *parser, const uint8_t *input,
    size_t input_length, size_t body_credit, size_t *consumed) {
  if (consumed != NULL) {
    *consumed = 0;
  }
  if (parser == NULL || consumed == NULL ||
      (input_length != 0 && input == NULL)) {
    if (parser != NULL) {
      return parser_fail(parser,
                         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_ARGUMENT);
    }
    return POCKETJS_NET_HTTP1_PARSE_ERROR;
  }
  if (parser->state == POCKETJS_NET_HTTP1_PARSER_ERROR) {
    return POCKETJS_NET_HTTP1_PARSE_ERROR;
  }
  if (parser->state == POCKETJS_NET_HTTP1_PARSER_COMPLETE) {
    return POCKETJS_NET_HTTP1_PARSE_COMPLETE;
  }

  size_t position = 0;
  size_t credit = body_credit;
  while (position < input_length) {
    if (parser_is_line_state(parser->state)) {
      bool line_complete = false;
      pocketjs_net_http1_wire_error_t error =
          consume_line_byte(parser, input[position], &line_complete);
      ++position;
      if (error != POCKETJS_NET_HTTP1_WIRE_ERROR_NONE) {
        *consumed = position;
        return parser_fail(parser, error);
      }
      if (parser->state == POCKETJS_NET_HTTP1_PARSER_COMPLETE) {
        *consumed = position;
        return POCKETJS_NET_HTTP1_PARSE_COMPLETE;
      }
      continue;
    }

    if (parser->state == POCKETJS_NET_HTTP1_PARSER_FIXED_BODY ||
        parser->state == POCKETJS_NET_HTTP1_PARSER_EOF_BODY ||
        parser->state == POCKETJS_NET_HTTP1_PARSER_CHUNK_BODY) {
      if (credit == 0) {
        *consumed = position;
        return POCKETJS_NET_HTTP1_PARSE_PAUSED;
      }
      size_t amount = input_length - position;
      if (amount > credit) {
        amount = credit;
      }
      if (parser->state == POCKETJS_NET_HTTP1_PARSER_FIXED_BODY &&
          (uint64_t)amount > parser->body_remaining) {
        amount = (size_t)parser->body_remaining;
      }
      if (parser->state == POCKETJS_NET_HTTP1_PARSER_CHUNK_BODY &&
          (uint64_t)amount > parser->chunk_remaining) {
        amount = (size_t)parser->chunk_remaining;
      }
      pocketjs_net_http1_parse_result_t delivered =
          deliver_body(parser, input + position, amount);
      if (delivered == POCKETJS_NET_HTTP1_PARSE_ERROR) {
        *consumed = position;
        return delivered;
      }
      position += amount;
      credit -= amount;
      if (parser->state == POCKETJS_NET_HTTP1_PARSER_FIXED_BODY) {
        parser->body_remaining -= amount;
        if (parser->body_remaining == 0) {
          parser_complete(parser);
          *consumed = position;
          return POCKETJS_NET_HTTP1_PARSE_COMPLETE;
        }
      } else if (parser->state == POCKETJS_NET_HTTP1_PARSER_CHUNK_BODY) {
        parser->chunk_remaining -= amount;
        if (parser->chunk_remaining == 0) {
          parser->state = POCKETJS_NET_HTTP1_PARSER_CHUNK_BODY_CR;
        }
      }
      continue;
    }

    if (parser->state == POCKETJS_NET_HTTP1_PARSER_CHUNK_BODY_CR) {
      ++position;
      if (input[position - 1U] != '\r') {
        *consumed = position;
        return parser_fail(parser,
                           POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_CHUNK_SIZE);
      }
      parser->state = POCKETJS_NET_HTTP1_PARSER_CHUNK_BODY_LF;
      continue;
    }
    if (parser->state == POCKETJS_NET_HTTP1_PARSER_CHUNK_BODY_LF) {
      ++position;
      if (input[position - 1U] != '\n') {
        *consumed = position;
        return parser_fail(parser,
                           POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_CHUNK_SIZE);
      }
      parser->state = POCKETJS_NET_HTTP1_PARSER_CHUNK_SIZE_LINE;
      continue;
    }
  }
  *consumed = position;
  return parser->state == POCKETJS_NET_HTTP1_PARSER_COMPLETE
             ? POCKETJS_NET_HTTP1_PARSE_COMPLETE
             : POCKETJS_NET_HTTP1_PARSE_NEED_MORE;
}

pocketjs_net_http1_parse_result_t pocketjs_net_http1_response_parser_finish(
    pocketjs_net_http1_response_parser_t *parser) {
  if (parser == NULL) {
    return POCKETJS_NET_HTTP1_PARSE_ERROR;
  }
  if (parser->state == POCKETJS_NET_HTTP1_PARSER_COMPLETE) {
    return POCKETJS_NET_HTTP1_PARSE_COMPLETE;
  }
  if (parser->state == POCKETJS_NET_HTTP1_PARSER_ERROR) {
    return POCKETJS_NET_HTTP1_PARSE_ERROR;
  }
  if (parser->state == POCKETJS_NET_HTTP1_PARSER_EOF_BODY) {
    parser_complete(parser);
    return POCKETJS_NET_HTTP1_PARSE_COMPLETE;
  }
  return parser_fail(parser, POCKETJS_NET_HTTP1_WIRE_ERROR_UNEXPECTED_EOF);
}
