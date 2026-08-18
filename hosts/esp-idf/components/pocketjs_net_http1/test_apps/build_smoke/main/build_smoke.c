// SPDX-License-Identifier: MIT

#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "pocketjs/net/http1_wire.h"

#define SLICE(literal)                                                        \
  ((pocketjs_net_http1_slice_t){                                             \
      .data = (const uint8_t *)(literal), .length = sizeof(literal) - 1U})

typedef struct {
  unsigned status_calls;
  unsigned informational_status_calls;
  unsigned header_calls;
  unsigned headers_complete_calls;
  unsigned completion_calls;
  unsigned status;
  pocketjs_net_http1_response_body_kind_t body_kind;
  uint64_t content_length;
  uint8_t status_text[64];
  size_t status_text_length;
  uint8_t body[256];
  size_t body_length;
  unsigned repeated_header_calls;
} observation_t;

static bool observe_status(void *opaque, unsigned http_minor,
                           unsigned status_code, const uint8_t *status_text,
                           size_t status_text_length, bool informational) {
  observation_t *observation = opaque;
  assert(http_minor == 0U || http_minor == 1U);
  assert(status_text_length <= sizeof(observation->status_text));
  observation->status_calls++;
  if (informational) {
    observation->informational_status_calls++;
  } else {
    observation->status = status_code;
    observation->status_text_length = status_text_length;
    memcpy(observation->status_text, status_text, status_text_length);
  }
  return true;
}

static bool observe_header(void *opaque, const uint8_t *name,
                           size_t name_length, const uint8_t *value,
                           size_t value_length, bool informational) {
  observation_t *observation = opaque;
  (void)value;
  (void)value_length;
  (void)informational;
  observation->header_calls++;
  if (name_length == sizeof("X-Repeat") - 1U &&
      memcmp(name, "X-Repeat", name_length) == 0) {
    observation->repeated_header_calls++;
  }
  /* Valid trailers are deliberately not delivered through this callback. */
  assert(name_length != sizeof("X-PocketJS-Trailer") - 1U ||
         memcmp(name, "X-PocketJS-Trailer", name_length) != 0);
  return true;
}

static bool observe_headers_complete(
    void *opaque, unsigned status_code,
    pocketjs_net_http1_response_body_kind_t body_kind,
    uint64_t content_length, bool informational) {
  observation_t *observation = opaque;
  observation->headers_complete_calls++;
  if (!informational) {
    observation->status = status_code;
    observation->body_kind = body_kind;
    observation->content_length = content_length;
  }
  return true;
}

static bool observe_body(void *opaque, const uint8_t *body,
                         size_t body_length) {
  observation_t *observation = opaque;
  assert(body_length <= sizeof(observation->body) - observation->body_length);
  memcpy(observation->body + observation->body_length, body, body_length);
  observation->body_length += body_length;
  return true;
}

static void observe_complete(void *opaque) {
  observation_t *observation = opaque;
  observation->completion_calls++;
}

static const pocketjs_net_http1_response_callbacks_t callbacks = {
    .on_status = observe_status,
    .on_header = observe_header,
    .on_headers_complete = observe_headers_complete,
    .on_body = observe_body,
    .on_complete = observe_complete,
};

static void init_parser(pocketjs_net_http1_response_parser_t *parser,
                        observation_t *observation, bool response_to_head) {
  memset(observation, 0, sizeof(*observation));
  assert(pocketjs_net_http1_response_parser_init(
             parser, &pocketjs_net_http1_default_limits, &callbacks,
             observation, response_to_head) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_NONE);
}

static pocketjs_net_http1_parse_result_t feed_one_byte_at_a_time(
    pocketjs_net_http1_response_parser_t *parser, const uint8_t *wire,
    size_t wire_length) {
  pocketjs_net_http1_parse_result_t result =
      POCKETJS_NET_HTTP1_PARSE_NEED_MORE;
  size_t offset = 0;
  while (offset < wire_length) {
    size_t consumed = 0;
    result = pocketjs_net_http1_response_parser_feed(
        parser, wire + offset, 1U, SIZE_MAX, &consumed);
    assert(consumed == 1U);
    offset += consumed;
    if (result == POCKETJS_NET_HTTP1_PARSE_COMPLETE ||
        result == POCKETJS_NET_HTTP1_PARSE_ERROR) {
      assert(offset == wire_length);
      break;
    }
    assert(result == POCKETJS_NET_HTTP1_PARSE_NEED_MORE);
  }
  return result;
}

static pocketjs_net_http1_wire_error_t parse_malformed(const char *wire) {
  pocketjs_net_http1_response_parser_t parser;
  observation_t observation;
  init_parser(&parser, &observation, false);
  size_t length = strlen(wire);
  size_t consumed = 0;
  pocketjs_net_http1_parse_result_t result =
      pocketjs_net_http1_response_parser_feed(
          &parser, (const uint8_t *)wire, length, SIZE_MAX, &consumed);
  if (result != POCKETJS_NET_HTTP1_PARSE_ERROR) {
    result = pocketjs_net_http1_response_parser_finish(&parser);
  }
  assert(result == POCKETJS_NET_HTTP1_PARSE_ERROR);
  assert(parser.error != POCKETJS_NET_HTTP1_WIRE_ERROR_NONE);
  return parser.error;
}

static void test_request_encoder(void) {
  const pocketjs_net_http1_header_t headers[] = {
      {.name = SLICE("X-Repeat"), .value = SLICE("one")},
      {.name = SLICE("X-Repeat"), .value = SLICE("two")},
  };
  pocketjs_net_http1_request_t request = {
      .method = SLICE("PATCH"),
      .target = SLICE("/v1/items/a%20b?mode=wire&n=2"),
      .host = SLICE("[2001:db8::1]:8443"),
      .headers = headers,
      .header_count = sizeof(headers) / sizeof(headers[0]),
      .body_kind = POCKETJS_NET_HTTP1_REQUEST_BODY_FIXED,
      .content_length = 12,
  };
  pocketjs_net_http1_request_encoder_t encoder;
  assert(pocketjs_net_http1_request_encoder_init(
             &encoder, &request, &pocketjs_net_http1_default_limits) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_NONE);
  uint8_t wire[512];
  size_t wire_length = 0;
  pocketjs_net_http1_encoder_result_t result;
  do {
    size_t produced = 0;
    result = pocketjs_net_http1_request_encoder_write(
        &encoder, wire + wire_length, 1U, &produced);
    assert(produced == 1U || result == POCKETJS_NET_HTTP1_ENCODER_DONE);
    wire_length += produced;
  } while (result != POCKETJS_NET_HTTP1_ENCODER_DONE);
  static const char expected[] =
      "PATCH /v1/items/a%20b?mode=wire&n=2 HTTP/1.1\r\n"
      "Host: [2001:db8::1]:8443\r\n"
      "X-Repeat: one\r\n"
      "X-Repeat: two\r\n"
      "Content-Length: 12\r\n"
      "\r\n";
  assert(wire_length == sizeof(expected) - 1U);
  assert(memcmp(wire, expected, wire_length) == 0);

  request.method = SLICE("X-CUSTOM!METHOD");
  request.body_kind = POCKETJS_NET_HTTP1_REQUEST_BODY_CHUNKED;
  request.content_length = 0;
  assert(pocketjs_net_http1_request_encoder_init(
             &encoder, &request, &pocketjs_net_http1_default_limits) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_NONE);

  request.method = SLICE("CONNECT");
  assert(pocketjs_net_http1_request_encoder_init(
             &encoder, &request, &pocketjs_net_http1_default_limits) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_FORBIDDEN_METHOD);
  request.method = SLICE("trace");
  assert(pocketjs_net_http1_request_encoder_init(
             &encoder, &request, &pocketjs_net_http1_default_limits) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_FORBIDDEN_METHOD);
  request.method = SLICE("TrAcK");
  assert(pocketjs_net_http1_request_encoder_init(
             &encoder, &request, &pocketjs_net_http1_default_limits) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_FORBIDDEN_METHOD);
  request.method = SLICE("BAD METHOD");
  assert(pocketjs_net_http1_request_encoder_init(
             &encoder, &request, &pocketjs_net_http1_default_limits) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_METHOD);

  request.method = SLICE("GET");
  request.target = SLICE("https://peer.test/");
  assert(pocketjs_net_http1_request_encoder_init(
             &encoder, &request, &pocketjs_net_http1_default_limits) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_TARGET);
  request.target = SLICE("/bad#fragment");
  assert(pocketjs_net_http1_request_encoder_init(
             &encoder, &request, &pocketjs_net_http1_default_limits) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_TARGET);
  request.target = SLICE("/bad%xx");
  assert(pocketjs_net_http1_request_encoder_init(
             &encoder, &request, &pocketjs_net_http1_default_limits) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_TARGET);

  request.target = SLICE("/");
  request.host = SLICE("peer.test:99999");
  assert(pocketjs_net_http1_request_encoder_init(
             &encoder, &request, &pocketjs_net_http1_default_limits) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_HOST);
  request.host = SLICE("peer.test:0");
  assert(pocketjs_net_http1_request_encoder_init(
             &encoder, &request, &pocketjs_net_http1_default_limits) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_HOST);
  request.host = SLICE("[::::]:443");
  assert(pocketjs_net_http1_request_encoder_init(
             &encoder, &request, &pocketjs_net_http1_default_limits) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_HOST);
  request.host = SLICE("peer.test\r\nInjected: yes");
  assert(pocketjs_net_http1_request_encoder_init(
             &encoder, &request, &pocketjs_net_http1_default_limits) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_HOST);

  pocketjs_net_http1_header_t bad_header = {
      .name = SLICE("X-Test"), .value = SLICE("safe\r\nInjected: yes")};
  request.host = SLICE("peer.test");
  request.headers = &bad_header;
  request.header_count = 1;
  assert(pocketjs_net_http1_request_encoder_init(
             &encoder, &request, &pocketjs_net_http1_default_limits) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_HEADER);
  bad_header.name = SLICE("Host");
  bad_header.value = SLICE("other.test");
  assert(pocketjs_net_http1_request_encoder_init(
             &encoder, &request, &pocketjs_net_http1_default_limits) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_FORBIDDEN_REQUEST_HEADER);
  bad_header.name = SLICE("Trailer");
  assert(pocketjs_net_http1_request_encoder_init(
             &encoder, &request, &pocketjs_net_http1_default_limits) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_FORBIDDEN_REQUEST_HEADER);

  request.headers = NULL;
  request.header_count = 0;
  request.host = SLICE("peer.test");
  request.body_kind = POCKETJS_NET_HTTP1_REQUEST_BODY_CHUNKED;
  request.content_length = 1U;
  assert(pocketjs_net_http1_request_encoder_init(
             &encoder, &request, &pocketjs_net_http1_default_limits) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_ARGUMENT);
  request.body_kind = POCKETJS_NET_HTTP1_REQUEST_BODY_NONE;
  assert(pocketjs_net_http1_request_encoder_init(
             &encoder, &request, &pocketjs_net_http1_default_limits) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_ARGUMENT);
  request.content_length = 0;

  pocketjs_net_http1_limits_t tiny = pocketjs_net_http1_default_limits;
  tiny.max_header_bytes = 16U;
  request.headers = NULL;
  request.header_count = 0;
  assert(pocketjs_net_http1_request_encoder_init(&encoder, &request, &tiny) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_HEADER_BYTES_EXCEEDED);
}

static void test_fragmented_fixed_and_informational(void) {
  static const uint8_t wire[] =
      "HTTP/1.1 103 Early Hints\r\n"
      "Link: </style.css>; rel=preload\r\n"
      "\r\n"
      "HTTP/1.1 299 Odd Wire Text\r\n"
      "X-Repeat: one\r\n"
      "X-Repeat: two\r\n"
      "Content-Length: 5\r\n"
      "\r\n"
      "hello";
  pocketjs_net_http1_response_parser_t parser;
  observation_t observation;
  init_parser(&parser, &observation, false);
  assert(feed_one_byte_at_a_time(&parser, wire, sizeof(wire) - 1U) ==
         POCKETJS_NET_HTTP1_PARSE_COMPLETE);
  assert(observation.status_calls == 2U);
  assert(observation.informational_status_calls == 1U);
  assert(observation.headers_complete_calls == 2U);
  assert(observation.status == 299U);
  assert(observation.body_kind == POCKETJS_NET_HTTP1_RESPONSE_BODY_FIXED);
  assert(observation.content_length == 5U);
  assert(observation.status_text_length == sizeof("Odd Wire Text") - 1U);
  assert(memcmp(observation.status_text, "Odd Wire Text",
                observation.status_text_length) == 0);
  assert(observation.repeated_header_calls == 2U);
  assert(observation.body_length == 5U);
  assert(memcmp(observation.body, "hello", 5U) == 0);
  assert(observation.completion_calls == 1U);
}

static void test_body_credit_pause(void) {
  static const uint8_t wire[] =
      "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello";
  const size_t head_length = sizeof(wire) - 1U - 5U;
  pocketjs_net_http1_response_parser_t parser;
  observation_t observation;
  init_parser(&parser, &observation, false);

  size_t consumed = 0;
  assert(pocketjs_net_http1_response_parser_feed(
             &parser, wire, sizeof(wire) - 1U, 0, &consumed) ==
         POCKETJS_NET_HTTP1_PARSE_PAUSED);
  assert(consumed == head_length);
  assert(observation.body_length == 0);

  size_t second = 0;
  assert(pocketjs_net_http1_response_parser_feed(
             &parser, wire + consumed, sizeof(wire) - 1U - consumed, 2U,
             &second) == POCKETJS_NET_HTTP1_PARSE_PAUSED);
  assert(second == 2U);
  assert(observation.body_length == 2U);
  consumed += second;

  size_t third = 0;
  assert(pocketjs_net_http1_response_parser_feed(
             &parser, wire + consumed, sizeof(wire) - 1U - consumed, 3U,
             &third) == POCKETJS_NET_HTTP1_PARSE_COMPLETE);
  assert(third == 3U);
  assert(observation.body_length == 5U);
  assert(memcmp(observation.body, "hello", 5U) == 0);
}

static void test_chunked_and_trailer(void) {
  static const uint8_t wire[] =
      "HTTP/1.1 200 Chunked\r\n"
      "Transfer-Encoding: chunked\r\n"
      "Trailer: X-PocketJS-Trailer\r\n"
      "\r\n"
      "4; source=peer\r\nPock\r\n"
      "4; quoted=\"yes\\!\"\r\netJS\r\n"
      "0\r\n"
      "X-PocketJS-Trailer: complete\r\n"
      "\r\n";
  pocketjs_net_http1_response_parser_t parser;
  observation_t observation;
  init_parser(&parser, &observation, false);
  assert(feed_one_byte_at_a_time(&parser, wire, sizeof(wire) - 1U) ==
         POCKETJS_NET_HTTP1_PARSE_COMPLETE);
  assert(observation.body_kind == POCKETJS_NET_HTTP1_RESPONSE_BODY_CHUNKED);
  assert(observation.body_length == 8U);
  assert(memcmp(observation.body, "PocketJS", 8U) == 0);
  assert(parser.validated_trailer_fields == 1U);
  assert(observation.header_calls == 2U);
  assert(observation.completion_calls == 1U);

  assert(parse_malformed(
             "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
             "1\r\na\r\n0\r\nAuthorization: secret\r\n\r\n") ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_FORBIDDEN_TRAILER);
  assert(parse_malformed(
             "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
             "4\r\ngzip\r\n0\r\nContent-Encoding: gzip\r\n\r\n") ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_FORBIDDEN_TRAILER);
  assert(parse_malformed(
             "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n"
             "Trailer: Content-Encoding\r\n\r\n0\r\n\r\n") ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_TRAILER_DECLARATION);
}

static void test_no_body_and_eof(void) {
  static const uint8_t head_wire[] =
      "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello";
  pocketjs_net_http1_response_parser_t parser;
  observation_t observation;
  init_parser(&parser, &observation, true);
  size_t consumed = 0;
  assert(pocketjs_net_http1_response_parser_feed(
             &parser, head_wire, sizeof(head_wire) - 1U, SIZE_MAX,
             &consumed) == POCKETJS_NET_HTTP1_PARSE_COMPLETE);
  assert(consumed == sizeof(head_wire) - 1U - 5U);
  assert(observation.body_kind == POCKETJS_NET_HTTP1_RESPONSE_BODY_NONE);
  assert(observation.body_length == 0);

  static const uint8_t no_content[] =
      "HTTP/1.1 204 No Content\r\nDate: now\r\n\r\n";
  init_parser(&parser, &observation, false);
  assert(feed_one_byte_at_a_time(&parser, no_content,
                                 sizeof(no_content) - 1U) ==
         POCKETJS_NET_HTTP1_PARSE_COMPLETE);
  assert(observation.status == 204U);
  assert(observation.body_kind == POCKETJS_NET_HTTP1_RESPONSE_BODY_NONE);

  static const uint8_t not_modified[] =
      "HTTP/1.1 304 Not Modified\r\nContent-Length: 123\r\n\r\n";
  init_parser(&parser, &observation, false);
  assert(feed_one_byte_at_a_time(&parser, not_modified,
                                 sizeof(not_modified) - 1U) ==
         POCKETJS_NET_HTTP1_PARSE_COMPLETE);
  assert(observation.body_kind == POCKETJS_NET_HTTP1_RESPONSE_BODY_NONE);

  static const uint8_t zero[] =
      "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n";
  init_parser(&parser, &observation, false);
  assert(feed_one_byte_at_a_time(&parser, zero, sizeof(zero) - 1U) ==
         POCKETJS_NET_HTTP1_PARSE_COMPLETE);
  assert(observation.body_kind == POCKETJS_NET_HTTP1_RESPONSE_BODY_FIXED);

  static const uint8_t eof_wire[] =
      "HTTP/1.0 200 Legacy\r\nConnection: close\r\n\r\nlegacy-body";
  init_parser(&parser, &observation, false);
  assert(feed_one_byte_at_a_time(&parser, eof_wire, sizeof(eof_wire) - 1U) ==
         POCKETJS_NET_HTTP1_PARSE_NEED_MORE);
  assert(observation.body_kind ==
         POCKETJS_NET_HTTP1_RESPONSE_BODY_UNTIL_EOF);
  assert(observation.body_length == sizeof("legacy-body") - 1U);
  assert(pocketjs_net_http1_response_parser_finish(&parser) ==
         POCKETJS_NET_HTTP1_PARSE_COMPLETE);

  assert(parse_malformed(
             "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n") ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_AMBIGUOUS_FRAMING);
  assert(parse_malformed(
             "HTTP/1.0 200 Legacy\r\nTransfer-Encoding: chunked\r\n\r\n"
             "0\r\n\r\n") ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_TRANSFER_ENCODING);
}

static void test_peer_malformed_corpus(void) {
  assert(parse_malformed(
             "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n"
             "Content-Length: 5\r\n\r\n5\r\nhello\r\n0\r\n\r\n") ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_AMBIGUOUS_FRAMING);
  assert(parse_malformed(
             "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n"
             "Content-Length: 5\r\n\r\nhello") ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_DUPLICATE_CONTENT_LENGTH);
  assert(parse_malformed(
             "HTTP/1.1 200 OK\r\nContent-Length: 5, 5\r\n\r\nhello") ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_CONTENT_LENGTH);
  assert(parse_malformed(
             "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nX-Test: first\r\n"
             " second\r\n\r\nok") ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_OBS_FOLD);
  assert(parse_malformed(
             "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n"
             "Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n") ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_DUPLICATE_TRANSFER_ENCODING);
  assert(parse_malformed(
             "HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n"
             "\r\n0\r\n\r\n") ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_TRANSFER_ENCODING);
  assert(parse_malformed(
             "HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\nopaque") ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_TRANSFER_ENCODING);
  assert(parse_malformed(
             "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n"
             "Trailer: Content-Length\r\n\r\n2\r\nok\r\n0\r\n"
             "Content-Length: 2\r\n\r\n") ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_TRAILER_DECLARATION);
  assert(parse_malformed(
             "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n"
             "Trailer: X-Valid,   \r\n\r\n0\r\n\r\n") ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_TRAILER_DECLARATION);
  assert(parse_malformed(
             "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
             "Z\r\ninvalid\r\n0\r\n\r\n") ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_CHUNK_SIZE);
  assert(parse_malformed(
             "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhe") ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_UNEXPECTED_EOF);
}

static void test_limits(void) {
  pocketjs_net_http1_limits_t limits = pocketjs_net_http1_default_limits;
  limits.max_header_fields = 1U;
  pocketjs_net_http1_response_parser_t parser;
  observation_t observation;
  memset(&observation, 0, sizeof(observation));
  assert(pocketjs_net_http1_response_parser_init(
             &parser, &limits, &callbacks, &observation, false) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_NONE);
  static const uint8_t fields[] =
      "HTTP/1.1 200 OK\r\nX-One: 1\r\nX-Two: 2\r\n\r\n";
  size_t consumed = 0;
  assert(pocketjs_net_http1_response_parser_feed(
             &parser, fields, sizeof(fields) - 1U, SIZE_MAX, &consumed) ==
         POCKETJS_NET_HTTP1_PARSE_ERROR);
  assert(parser.error ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_HEADER_FIELDS_EXCEEDED);
  assert(pocketjs_net_http1_wire_error_is_limit(parser.error));

  limits = pocketjs_net_http1_default_limits;
  limits.max_informational_responses = 1U;
  memset(&observation, 0, sizeof(observation));
  assert(pocketjs_net_http1_response_parser_init(
             &parser, &limits, &callbacks, &observation, false) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_NONE);
  static const uint8_t infos[] =
      "HTTP/1.1 100 Continue\r\n\r\n"
      "HTTP/1.1 103 Early Hints\r\n\r\n"
      "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n";
  assert(pocketjs_net_http1_response_parser_feed(
             &parser, infos, sizeof(infos) - 1U, SIZE_MAX, &consumed) ==
         POCKETJS_NET_HTTP1_PARSE_ERROR);
  assert(parser.error ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_TOO_MANY_INFORMATIONAL_RESPONSES);
  assert(strcmp(pocketjs_net_http1_wire_error_name(parser.error),
                "too_many_informational_responses") == 0);

  limits = pocketjs_net_http1_default_limits;
  limits.max_header_bytes = 20U;
  memset(&observation, 0, sizeof(observation));
  assert(pocketjs_net_http1_response_parser_init(
             &parser, &limits, &callbacks, &observation, false) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_NONE);
  static const uint8_t header_bytes[] =
      "HTTP/1.1 200 OK\r\nX-Long: 1234567890\r\n\r\n";
  assert(pocketjs_net_http1_response_parser_feed(
             &parser, header_bytes, sizeof(header_bytes) - 1U, SIZE_MAX,
             &consumed) == POCKETJS_NET_HTTP1_PARSE_ERROR);
  assert(parser.error == POCKETJS_NET_HTTP1_WIRE_ERROR_HEADER_BYTES_EXCEEDED);

  limits = pocketjs_net_http1_default_limits;
  limits.max_line_bytes = 16U;
  memset(&observation, 0, sizeof(observation));
  assert(pocketjs_net_http1_response_parser_init(
             &parser, &limits, &callbacks, &observation, false) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_NONE);
  static const uint8_t long_line[] =
      "HTTP/1.1 200 This reason phrase is too long\r\n\r\n";
  assert(pocketjs_net_http1_response_parser_feed(
             &parser, long_line, sizeof(long_line) - 1U, SIZE_MAX,
             &consumed) == POCKETJS_NET_HTTP1_PARSE_ERROR);
  assert(parser.error == POCKETJS_NET_HTTP1_WIRE_ERROR_LINE_TOO_LONG);

  limits = pocketjs_net_http1_default_limits;
  limits.max_header_fields = POCKETJS_NET_HTTP1_MAX_HEADER_FIELDS + 1U;
  assert(pocketjs_net_http1_response_parser_init(
             &parser, &limits, &callbacks, &observation, false) ==
         POCKETJS_NET_HTTP1_WIRE_ERROR_INVALID_ARGUMENT);
}

static void run_corpus(void) {
  test_request_encoder();
  test_fragmented_fixed_and_informational();
  test_body_credit_pause();
  test_chunked_and_trailer();
  test_no_body_and_eof();
  test_peer_malformed_corpus();
  test_limits();
  puts("pocketjs_net_http1: corpus passed");
}

#ifdef POCKETJS_NET_HTTP1_HOST_TEST
int main(void) {
  run_corpus();
  return 0;
}
#else
void app_main(void) { run_corpus(); }
#endif
