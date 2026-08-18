// SPDX-License-Identifier: MIT

#ifndef POCKETJS_NET_HTTP1_WIRE_H
#define POCKETJS_NET_HTTP1_WIRE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* The parser never allocates. This is its only wire-line storage. */
#define POCKETJS_NET_HTTP1_MAX_LINE_BYTES 2048U
#define POCKETJS_NET_HTTP1_MAX_HEADER_BYTES 65536U
#define POCKETJS_NET_HTTP1_MAX_HEADER_FIELDS 128U
#define POCKETJS_NET_HTTP1_MAX_INFORMATIONAL_RESPONSES 16U

#define POCKETJS_NET_HTTP1_DEFAULT_HEADER_BYTES 8192U
#define POCKETJS_NET_HTTP1_DEFAULT_HEADER_FIELDS 64U
#define POCKETJS_NET_HTTP1_DEFAULT_LINE_BYTES 2048U
#define POCKETJS_NET_HTTP1_DEFAULT_INFORMATIONAL_RESPONSES 8U

typedef struct {
  size_t max_header_bytes;
  size_t max_header_fields;
  size_t max_line_bytes;
  size_t max_informational_responses;
} pocketjs_net_http1_limits_t;

extern const pocketjs_net_http1_limits_t pocketjs_net_http1_default_limits;

typedef enum {
  POCKETJS_NET_HTTP1_WIRE_ERROR_NONE = 0,
  POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_ARGUMENT,
  POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_METHOD,
  POCKETJS_NET_HTTP1_WIRE_ERROR_FORBIDDEN_METHOD,
  POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_TARGET,
  POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_HOST,
  POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_HEADER,
  POCKETJS_NET_HTTP1_WIRE_ERROR_FORBIDDEN_REQUEST_HEADER,
  POCKETJS_NET_HTTP1_WIRE_ERROR_LINE_TOO_LONG,
  POCKETJS_NET_HTTP1_WIRE_ERROR_HEADER_BYTES_EXCEEDED,
  POCKETJS_NET_HTTP1_WIRE_ERROR_HEADER_FIELDS_EXCEEDED,
  POCKETJS_NET_HTTP1_WIRE_ERROR_TOO_MANY_INFORMATIONAL_RESPONSES,
  POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_STATUS_LINE,
  POCKETJS_NET_HTTP1_WIRE_ERROR_SWITCHING_PROTOCOLS_UNSUPPORTED,
  POCKETJS_NET_HTTP1_WIRE_ERROR_OBS_FOLD,
  POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_CONTENT_LENGTH,
  POCKETJS_NET_HTTP1_WIRE_ERROR_DUPLICATE_CONTENT_LENGTH,
  POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_TRANSFER_ENCODING,
  POCKETJS_NET_HTTP1_WIRE_ERROR_DUPLICATE_TRANSFER_ENCODING,
  POCKETJS_NET_HTTP1_WIRE_ERROR_AMBIGUOUS_FRAMING,
  POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_TRAILER_DECLARATION,
  POCKETJS_NET_HTTP1_WIRE_ERROR_FORBIDDEN_TRAILER,
  POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_CHUNK_SIZE,
  POCKETJS_NET_HTTP1_WIRE_ERROR_CALLBACK_REJECTED,
  POCKETJS_NET_HTTP1_WIRE_ERROR_UNEXPECTED_EOF,
} pocketjs_net_http1_wire_error_t;

const char *pocketjs_net_http1_wire_error_name(
    pocketjs_net_http1_wire_error_t error);

bool pocketjs_net_http1_wire_error_is_limit(
    pocketjs_net_http1_wire_error_t error);

typedef struct {
  const uint8_t *data;
  size_t length;
} pocketjs_net_http1_slice_t;

typedef struct {
  pocketjs_net_http1_slice_t name;
  pocketjs_net_http1_slice_t value;
} pocketjs_net_http1_header_t;

typedef enum {
  POCKETJS_NET_HTTP1_REQUEST_BODY_NONE = 0,
  POCKETJS_NET_HTTP1_REQUEST_BODY_FIXED,
  POCKETJS_NET_HTTP1_REQUEST_BODY_CHUNKED,
} pocketjs_net_http1_request_body_kind_t;

typedef struct {
  pocketjs_net_http1_slice_t method;
  pocketjs_net_http1_slice_t target;
  pocketjs_net_http1_slice_t host;
  const pocketjs_net_http1_header_t *headers;
  size_t header_count;
  pocketjs_net_http1_request_body_kind_t body_kind;
  uint64_t content_length;
} pocketjs_net_http1_request_t;

typedef enum {
  POCKETJS_NET_HTTP1_ENCODER_MORE = 0,
  POCKETJS_NET_HTTP1_ENCODER_DONE,
  POCKETJS_NET_HTTP1_ENCODER_ERROR,
} pocketjs_net_http1_encoder_result_t;

/*
 * This encoder emits the request line and field section. The caller retains
 * all request slices until DONE, then writes either exactly content_length raw
 * bytes or valid chunked coding according to body_kind.
 */
typedef struct {
  pocketjs_net_http1_request_t request;
  uint8_t phase;
  size_t header_index;
  size_t segment_offset;
  uint8_t content_length_decimal[20];
  size_t content_length_decimal_length;
  bool initialized;
} pocketjs_net_http1_request_encoder_t;

pocketjs_net_http1_wire_error_t pocketjs_net_http1_request_encoder_init(
    pocketjs_net_http1_request_encoder_t *encoder,
    const pocketjs_net_http1_request_t *request,
    const pocketjs_net_http1_limits_t *limits);

pocketjs_net_http1_encoder_result_t pocketjs_net_http1_request_encoder_write(
    pocketjs_net_http1_request_encoder_t *encoder, uint8_t *output,
    size_t output_capacity, size_t *output_length);

typedef enum {
  POCKETJS_NET_HTTP1_RESPONSE_BODY_NONE = 0,
  POCKETJS_NET_HTTP1_RESPONSE_BODY_FIXED,
  POCKETJS_NET_HTTP1_RESPONSE_BODY_CHUNKED,
  POCKETJS_NET_HTTP1_RESPONSE_BODY_UNTIL_EOF,
} pocketjs_net_http1_response_body_kind_t;

typedef struct {
  /* All slices are valid only for the duration of their callback. */
  bool (*on_status)(void *context, unsigned http_minor, unsigned status_code,
                    const uint8_t *status_text, size_t status_text_length,
                    bool informational);
  bool (*on_header)(void *context, const uint8_t *name, size_t name_length,
                    const uint8_t *value, size_t value_length,
                    bool informational);
  bool (*on_headers_complete)(
      void *context, unsigned status_code,
      pocketjs_net_http1_response_body_kind_t body_kind,
      uint64_t content_length, bool informational);
  /* Body points directly into the caller's input and never into hidden storage. */
  bool (*on_body)(void *context, const uint8_t *body, size_t body_length);
  void (*on_complete)(void *context);
} pocketjs_net_http1_response_callbacks_t;

typedef enum {
  POCKETJS_NET_HTTP1_PARSE_NEED_MORE = 0,
  POCKETJS_NET_HTTP1_PARSE_PAUSED,
  POCKETJS_NET_HTTP1_PARSE_COMPLETE,
  POCKETJS_NET_HTTP1_PARSE_ERROR,
} pocketjs_net_http1_parse_result_t;

typedef enum {
  POCKETJS_NET_HTTP1_PARSER_STATUS_LINE = 0,
  POCKETJS_NET_HTTP1_PARSER_HEADER_LINE,
  POCKETJS_NET_HTTP1_PARSER_FIXED_BODY,
  POCKETJS_NET_HTTP1_PARSER_EOF_BODY,
  POCKETJS_NET_HTTP1_PARSER_CHUNK_SIZE_LINE,
  POCKETJS_NET_HTTP1_PARSER_CHUNK_BODY,
  POCKETJS_NET_HTTP1_PARSER_CHUNK_BODY_CR,
  POCKETJS_NET_HTTP1_PARSER_CHUNK_BODY_LF,
  POCKETJS_NET_HTTP1_PARSER_TRAILER_LINE,
  POCKETJS_NET_HTTP1_PARSER_COMPLETE,
  POCKETJS_NET_HTTP1_PARSER_ERROR,
} pocketjs_net_http1_parser_state_t;

typedef struct {
  pocketjs_net_http1_limits_t limits;
  pocketjs_net_http1_response_callbacks_t callbacks;
  void *callback_context;
  pocketjs_net_http1_parser_state_t state;
  pocketjs_net_http1_wire_error_t error;
  uint8_t line[POCKETJS_NET_HTTP1_MAX_LINE_BYTES];
  size_t line_length;
  bool line_cr_pending;
  bool response_to_head;
  bool saw_content_length;
  bool saw_transfer_encoding;
  bool saw_trailer_declaration;
  bool complete_notified;
  unsigned http_minor;
  unsigned status_code;
  uint64_t content_length;
  uint64_t body_remaining;
  uint64_t chunk_remaining;
  size_t header_bytes_used;
  size_t header_fields_used;
  size_t informational_responses;
  size_t validated_trailer_fields;
} pocketjs_net_http1_response_parser_t;

pocketjs_net_http1_wire_error_t pocketjs_net_http1_response_parser_init(
    pocketjs_net_http1_response_parser_t *parser,
    const pocketjs_net_http1_limits_t *limits,
    const pocketjs_net_http1_response_callbacks_t *callbacks,
    void *callback_context, bool response_to_head);

/*
 * feed consumes no more body bytes than body_credit. When PAUSED is returned,
 * the caller must retain input[consumed..] and provide it again after granting
 * more credit. Header/chunk syntax may be consumed without body credit.
 */
pocketjs_net_http1_parse_result_t pocketjs_net_http1_response_parser_feed(
    pocketjs_net_http1_response_parser_t *parser, const uint8_t *input,
    size_t input_length, size_t body_credit, size_t *consumed);

/* Signal transport EOF. Only an EOF-delimited response can complete here. */
pocketjs_net_http1_parse_result_t pocketjs_net_http1_response_parser_finish(
    pocketjs_net_http1_response_parser_t *parser);

#ifdef __cplusplus
}
#endif

#endif
