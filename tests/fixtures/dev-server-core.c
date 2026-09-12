/* Transcript test for the shared Pocket Runtime server (engine/runtime/
 * dev_server.c): the transport is a pair of in-memory queues and the clock a
 * counter, so every rule the 3DS and POSIX pumps rely on runs here without a
 * socket. Run from an empty scratch directory. */
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "dev_server.h"

static uint64_t clock_now = 1000;
static uint64_t fake_now(void) { return clock_now; }
static void status(char *out, size_t capacity) {
  snprintf(out, capacity, "{\"t\":\"runtime.status\",\"phase\":\"test\",\"generation\":%lu}",
    (unsigned long)pocket_devserver_generation());
}
static void *shot_alloc(size_t bytes) { return malloc(bytes); }
static void shot_free(void *bytes) { free(bytes); }

static uint8_t token[POCKET_RUNTIME_TOKEN_BYTES];
static uint8_t out_type, out_flags;
static uint8_t out_payload[POCKET_RUNTIME_MAX_FRAME_BYTES];
static size_t out_length;

static int exists(const char *path) {
  struct stat info;
  return stat(path, &info) == 0;
}
static void write_text(const char *path, const char *text) {
  FILE *file = fopen(path, "wb");
  assert(file != NULL);
  fputs(text, file);
  assert(fclose(file) == 0);
}
/* Pull one frame off the output queue; 0 when it is empty. */
static int next_frame(void) {
  const uint8_t *bytes = NULL;
  size_t pending = pocket_devserver_tx_pending(&bytes);
  if (pending == 0) return 0;
  PocketRuntimeFrameHeader header;
  assert(pocket_runtime_parse_frame_header(bytes, pending, &header));
  assert(pending >= POCKET_RUNTIME_FRAME_HEADER_BYTES + header.length);
  out_type = header.type;
  out_flags = header.flags;
  out_length = header.length;
  memcpy(out_payload, bytes + POCKET_RUNTIME_FRAME_HEADER_BYTES, header.length);
  pocket_devserver_tx_consumed(POCKET_RUNTIME_FRAME_HEADER_BYTES + header.length);
  return 1;
}
static int payload_has(const char *text) {
  return out_length >= strlen(text) && memmem(out_payload, out_length, text, strlen(text)) != NULL;
}
static void expect_ctrl(const char *text) {
  assert(next_frame());
  assert(out_type == POCKET_RUNTIME_MSG_CTRL);
  assert(payload_has(text));
}
static int feed(const uint8_t *bytes, size_t length) {
  uint8_t *room = NULL;
  size_t capacity = pocket_devserver_rx_room(&room);
  assert(capacity >= length);
  memcpy(room, bytes, length);
  return pocket_devserver_rx_commit(length);
}
static size_t encode(uint8_t *out, uint8_t type, const void *payload, size_t length) {
  pocket_runtime_encode_frame_header(out, type, 0, (uint32_t)length);
  if (length > 0) memcpy(out + POCKET_RUNTIME_FRAME_HEADER_BYTES, payload, length);
  return POCKET_RUNTIME_FRAME_HEADER_BYTES + length;
}
static int frame(uint8_t type, const void *payload, size_t length) {
  static uint8_t buffer[POCKET_RUNTIME_FRAME_HEADER_BYTES + POCKET_RUNTIME_MAX_FRAME_BYTES];
  return feed(buffer, encode(buffer, type, payload, length));
}
static void hello(uint8_t *out, int valid) {
  memset(out, 0, POCKET_RUNTIME_HELLO_BYTES);
  pocket_runtime_write_u32(out, POCKET_RUNTIME_WIRE_MAGIC);
  out[4] = POCKET_RUNTIME_WIRE_VERSION;
  pocket_runtime_write_u16(out + 6, POCKET_RUNTIME_TOKEN_BYTES);
  memcpy(out + 8, token, sizeof token);
  if (!valid) out[39] ^= 1;
}
static void expect_ack(uint8_t status_code) {
  const uint8_t *bytes = NULL;
  size_t pending = pocket_devserver_tx_pending(&bytes);
  assert(pending >= POCKET_RUNTIME_ACK_BYTES);
  assert(pocket_runtime_read_u32(bytes) == POCKET_RUNTIME_WIRE_MAGIC);
  assert(bytes[5] == status_code);
  assert(pocket_runtime_read_u16(bytes + 6) == 8);
  assert(pocket_runtime_read_u32(bytes + 8) == 3);
  assert(pocket_runtime_read_u32(bytes + 12) == POCKET_DEV_SERVER_ACK_FLAG_PACKAGES);
  assert(pocket_runtime_read_u64(bytes + 16) == 0xe01adc15327d4203ULL);
  pocket_devserver_tx_consumed(POCKET_RUNTIME_ACK_BYTES);
}
static void authenticate(void) {
  uint8_t bytes[POCKET_RUNTIME_HELLO_BYTES];
  pocket_devserver_client_open();
  hello(bytes, 1);
  assert(feed(bytes, sizeof bytes));
  expect_ack(0);
  while (next_frame()) assert(out_type == POCKET_RUNTIME_MSG_CTRL);
  assert(pocket_devserver_connected());
}
static void package_bytes(uint8_t *out, size_t length, uint64_t hash) {
  for (size_t index = 0; index < length; index += 1) out[index] = (uint8_t)(index * 7);
  pocket_runtime_write_u64(out + length - 8, hash);
}
static void begin(uint32_t length, uint64_t hash) {
  uint8_t payload[POCKET_RUNTIME_PACKAGE_BEGIN_BYTES];
  pocket_runtime_write_u32(payload, length);
  pocket_runtime_write_u64(payload + 4, hash);
  assert(frame(POCKET_RUNTIME_MSG_PACKAGE_BEGIN, payload, sizeof payload));
}
static void chunk(uint32_t offset, const uint8_t *bytes, size_t length) {
  static uint8_t payload[4 + POCKET_RUNTIME_MAX_FRAME_BYTES];
  pocket_runtime_write_u32(payload, offset);
  memcpy(payload + 4, bytes, length);
  assert(frame(POCKET_RUNTIME_MSG_PACKAGE_CHUNK, payload, 4 + length));
}
static void upload(const uint8_t *bytes, size_t length, uint64_t hash) {
  begin((uint32_t)length, hash);
  expect_ctrl("\"phase\":\"receiving\"");
  chunk(0, bytes, 60);
  chunk(60, bytes + 60, length - 60);
  assert(frame(POCKET_RUNTIME_MSG_PACKAGE_COMMIT, NULL, 0));
  expect_ctrl("\"phase\":\"received\"");
  assert(pocket_devserver_upload_pending());
}

int main(int argc, char **argv) {
  assert(argc == 2);
  assert(chdir(argv[1]) == 0);
  for (uint32_t index = 0; index < POCKET_RUNTIME_TOKEN_BYTES; index += 1) token[index] = (uint8_t)index;
  char error[128] = {0};

  /* Pairing keys. */
  assert(pocket_devserver_load_key("missing.key", error, sizeof error) == POCKET_DEV_SERVER_KEY_DISABLED);
  write_text("bad.key", "not a key\n");
  assert(pocket_devserver_load_key("bad.key", error, sizeof error) == POCKET_DEV_SERVER_KEY_ERROR);
  assert(strstr(error, "64 hexadecimal") != NULL);
  write_text("nonhex.key", "zz0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  assert(pocket_devserver_load_key("nonhex.key", error, sizeof error) == POCKET_DEV_SERVER_KEY_ERROR);
  assert(!pocket_devserver_paired());
  write_text("dev.key", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f\n");
  assert(pocket_devserver_load_key("dev.key", error, sizeof error) == POCKET_DEV_SERVER_KEY_READY);
  assert(pocket_devserver_paired());
  assert(pocket_devserver_device_id() == 0xe6cb594c1a148ac5ULL);

  const PocketDevServerConfig config = {
    "test-dev", "PocketJS Test", 8, 8131, "upload.tmp", fake_now, status, shot_alloc, shot_free,
  };
  const PocketDevServerConfig incomplete = {
    "test-dev", "PocketJS Test", 8, 0, "upload.tmp", fake_now, status, shot_alloc, shot_free,
  };
  assert(!pocket_devserver_configure(&incomplete));
  const PocketDevServerConfig long_label = {
    "test-dev", "PocketJS Sixteen", 8, 8131, "upload.tmp", fake_now, status, shot_alloc, shot_free,
  };
  assert(!pocket_devserver_configure(&long_label));
  assert(pocket_devserver_configure(&config));
  pocket_devserver_set_state(3, 0xe01adc15327d4203ULL);

  /* Discovery answers only real requests, with the configured identity. */
  uint8_t request[POCKET_RUNTIME_DISCOVERY_REQUEST_BYTES] = {0};
  uint8_t reply[POCKET_RUNTIME_DISCOVERY_REPLY_BYTES];
  pocket_runtime_write_u32(request, POCKET_RUNTIME_DISCOVERY_MAGIC);
  request[4] = POCKET_RUNTIME_WIRE_VERSION;
  request[5] = POCKET_RUNTIME_DISCOVERY_REQUEST;
  assert(!pocket_devserver_discovery(request, 7, reply));
  assert(pocket_devserver_discovery(request, sizeof request, reply));
  assert(pocket_runtime_read_u16(reply + 6) == 8 && pocket_runtime_read_u16(reply + 8) == 8131);
  assert(pocket_runtime_read_u16(reply + 10) == 0);
  assert(pocket_runtime_read_u32(reply + 12) == 3);
  assert(pocket_runtime_read_u64(reply + 16) == 0xe01adc15327d4203ULL);
  assert(pocket_runtime_read_u64(reply + 24) == 0xe6cb594c1a148ac5ULL);
  assert(strcmp((const char *)reply + 32, "test-dev") == 0);
  assert(strcmp((const char *)reply + 48, "PocketJS Test") == 0);

  /* A rejected hello still receives its ack, then the client is closed. */
  uint8_t bytes[POCKET_RUNTIME_HELLO_BYTES + 64];
  pocket_devserver_client_open();
  hello(bytes, 0);
  assert(feed(bytes, POCKET_RUNTIME_HELLO_BYTES));
  assert(!pocket_devserver_client_closing());
  expect_ack(2);
  assert(pocket_devserver_client_closing());
  assert(!pocket_devserver_connected());
  pocket_devserver_client_close();

  /* A coalesced hello and status request: ack, then status twice (connect
   * receipt and the request's answer). */
  pocket_devserver_client_open();
  hello(bytes, 1);
  size_t length = POCKET_RUNTIME_HELLO_BYTES + encode(bytes + POCKET_RUNTIME_HELLO_BYTES, POCKET_RUNTIME_MSG_STATUS_REQUEST, NULL, 0);
  assert(feed(bytes, length));
  expect_ack(0);
  expect_ctrl("\"t\":\"runtime.status\"");
  expect_ctrl("\"generation\":3");
  assert(!next_frame());
  assert(pocket_devserver_connected());
  assert(pocket_devserver_discovery(request, sizeof request, reply) && pocket_runtime_read_u16(reply + 10) == 1);

  /* Unknown frame types and wrong-sized pings are skipped; PING echoes. */
  assert(frame(0x7f, "abc", 3));
  assert(pocket_devserver_connected() && !next_frame());
  assert(frame(POCKET_RUNTIME_MSG_PING, "\x01\x02", 2));
  assert(!next_frame());
  assert(frame(POCKET_RUNTIME_MSG_PING, "\x01\x02\x03\x04", 4));
  assert(next_frame() && out_type == POCKET_RUNTIME_MSG_PONG && out_length == 4 && memcmp(out_payload, "\x01\x02\x03\x04", 4) == 0);
  assert(frame(POCKET_RUNTIME_MSG_STATUS_REQUEST, "x", 1));
  assert(!next_frame());

  /* Control records arrive as whole lines, never split. */
  char line[128];
  assert(frame(POCKET_RUNTIME_MSG_CTRL, "{\"t\":\"getTree\"}", 15));
  assert(pocket_devserver_recv_ctrl(line, 8) == 0);
  assert(pocket_devserver_recv_ctrl(line, sizeof line) == 16);
  assert(strcmp(line, "{\"t\":\"getTree\"}\n") == 0);
  assert(frame(POCKET_RUNTIME_MSG_CTRL, "{\"t\":\"a\"}", 9));
  assert(frame(POCKET_RUNTIME_MSG_CTRL, "{\"t\":\"b\"}", 9));
  assert(pocket_devserver_recv_ctrl(line, 12) == 10);
  assert(pocket_devserver_recv_ctrl(line, sizeof line) == 10 && strcmp(line, "{\"t\":\"b\"}\n") == 0);

  /* Guest output: hello caching, a dropped-record notice, escaped logs. */
  pocket_devserver_send_ctrl("{\"t\":\"hello\",\"v\":1}", 19);
  expect_ctrl("\"t\":\"hello\"");
  static char big[POCKET_RUNTIME_MAX_FRAME_BYTES + 1];
  memset(big, 'a', sizeof big);
  pocket_devserver_send_ctrl(big, sizeof big);
  expect_ctrl("\"t\":\"ctrlDropped\"");
  pocket_devserver_report_log("warn", "quote \" and\nline");
  expect_ctrl("\"args\":[\"quote \\\" and\\nline\"]");
  assert(!next_frame());
  pocket_devserver_client_close();
  authenticate();
  /* The cached hello precedes the status receipt on every new client. */
  pocket_devserver_client_close();
  pocket_devserver_client_open();
  hello(bytes, 1);
  assert(feed(bytes, POCKET_RUNTIME_HELLO_BYTES));
  expect_ack(0);
  expect_ctrl("\"t\":\"hello\"");
  expect_ctrl("\"t\":\"runtime.status\"");
  assert(!next_frame());
  pocket_devserver_reset_guest();
  pocket_devserver_client_close();
  authenticate();

  /* Malformed control closes the client. */
  assert(!frame(POCKET_RUNTIME_MSG_CTRL, "{\n}", 3));
  assert(pocket_devserver_client_closing());
  pocket_devserver_client_close();
  authenticate();
  uint8_t flagged[POCKET_RUNTIME_FRAME_HEADER_BYTES];
  pocket_runtime_encode_frame_header(flagged, POCKET_RUNTIME_MSG_PING, 1, 0);
  assert(!feed(flagged, sizeof flagged));
  pocket_devserver_client_close();
  authenticate();

  /* Uploads. */
  uint8_t package[100];
  package_bytes(package, sizeof package, 0x0102030405060708ULL);
  begin(sizeof package, 0x0102030405060708ULL);
  expect_ctrl("\"phase\":\"receiving\"");
  chunk(1, package, 16);
  expect_ctrl("\"phase\":\"transfer-error\"");
  assert(!exists("upload.tmp") && !pocket_devserver_upload_pending());
  upload(package, sizeof package, 0x0102030405060708ULL);
  /* Later frames wait behind the admission decision. */
  assert(frame(POCKET_RUNTIME_MSG_STATUS_REQUEST, NULL, 0));
  assert(!next_frame());
  uint64_t declared = 0;
  assert(pocket_devserver_take_upload(&declared) && declared == 0x0102030405060708ULL);
  assert(!pocket_devserver_upload_pending());
  FILE *staged = fopen("upload.tmp", "rb");
  assert(staged != NULL);
  uint8_t stored[128];
  assert(fread(stored, 1, sizeof stored, staged) == sizeof package && memcmp(stored, package, sizeof package) == 0);
  fclose(staged);
  assert(remove("upload.tmp") == 0);
  assert(pocket_devserver_rx_commit(0));
  expect_ctrl("\"t\":\"runtime.status\"");
  assert(!next_frame());
  /* Short commit, abort, and a disconnect discard the staging file. */
  begin(sizeof package, 0x0102030405060708ULL);
  expect_ctrl("\"phase\":\"receiving\"");
  chunk(0, package, 60);
  assert(frame(POCKET_RUNTIME_MSG_PACKAGE_COMMIT, NULL, 0));
  expect_ctrl("before every declared byte");
  assert(!exists("upload.tmp"));
  begin(sizeof package, 0x0102030405060708ULL);
  expect_ctrl("\"phase\":\"receiving\"");
  assert(frame(POCKET_RUNTIME_MSG_PACKAGE_ABORT, NULL, 0));
  expect_ctrl("aborted");
  assert(!exists("upload.tmp"));
  begin(sizeof package, 0x0102030405060708ULL);
  expect_ctrl("\"phase\":\"receiving\"");
  chunk(0, package, 60);
  pocket_devserver_client_close();
  assert(!exists("upload.tmp"));
  authenticate();
  /* A committed upload survives the client that sent it. */
  upload(package, sizeof package, 0x0102030405060708ULL);
  pocket_devserver_client_close();
  assert(pocket_devserver_upload_pending() && exists("upload.tmp"));
  assert(pocket_devserver_take_upload(&declared) && declared == 0x0102030405060708ULL);
  assert(remove("upload.tmp") == 0);
  authenticate();
  /* Hosts that refuse packages answer with a rejection. */
  pocket_devserver_allow_packages(0);
  begin(sizeof package, 0x0102030405060708ULL);
  expect_ctrl("\"phase\":\"rejected\"");
  pocket_devserver_allow_packages(1);

  /* Screenshot streaming: begin, both surfaces in order, end. */
  assert(pocket_devserver_request_screenshot());
  assert(!pocket_devserver_request_screenshot());
  assert(pocket_devserver_take_screenshot_request());
  assert(!pocket_devserver_take_screenshot_request());
  uint8_t *top = NULL;
  uint8_t *auxiliary = NULL;
  assert(pocket_devserver_screenshot_begin(7, 2, 1, 1, 1, &top, &auxiliary));
  memcpy(top, "\x01\x02\x03\x04\x05\x06", 6);
  memcpy(auxiliary, "\x09\x08\x07", 3);
  pocket_devserver_screenshot_ready();
  assert(next_frame() && out_type == POCKET_RUNTIME_MSG_SCREENSHOT_BEGIN);
  assert(pocket_runtime_read_u32(out_payload) == 7 && pocket_runtime_read_u16(out_payload + 4) == 2);
  assert(next_frame() && out_type == POCKET_RUNTIME_MSG_SCREENSHOT_CHUNK && out_flags == 0);
  assert(out_length == 10 && pocket_runtime_read_u32(out_payload) == 0 && memcmp(out_payload + 4, "\x01\x02\x03\x04\x05\x06", 6) == 0);
  assert(next_frame() && out_type == POCKET_RUNTIME_MSG_SCREENSHOT_CHUNK && out_flags == 1);
  assert(out_length == 7 && memcmp(out_payload + 4, "\x09\x08\x07", 3) == 0);
  assert(next_frame() && out_type == POCKET_RUNTIME_MSG_SCREENSHOT_END && pocket_runtime_read_u32(out_payload) == 7);
  assert(!next_frame());
  /* The heartbeat answer is queued before the next screenshot chunk. */
  assert(pocket_devserver_request_screenshot() && pocket_devserver_take_screenshot_request());
  assert(pocket_devserver_screenshot_begin(8, 1, 1, 1, 1, &top, &auxiliary));
  pocket_devserver_screenshot_ready();
  assert(frame(POCKET_RUNTIME_MSG_PING, "\x0a\x0b\x0c\x0d", 4));
  assert(next_frame() && out_type == POCKET_RUNTIME_MSG_PONG);
  assert(next_frame() && out_type == POCKET_RUNTIME_MSG_SCREENSHOT_BEGIN);
  while (next_frame()) assert(out_type != POCKET_RUNTIME_MSG_PONG);

  /* Timeouts: idle after authentication, and a hello that never arrives. */
  PocketDevServerCounters counters;
  pocket_devserver_counters(&counters);
  assert(counters.connects == 8 && counters.auth_failures == 1 && counters.uploads == 2);
  assert(counters.screenshots == 2 && counters.discoveries == 2 && counters.timeouts == 0);
  clock_now += POCKET_DEV_SERVER_IDLE_TIMEOUT_MS;
  assert(!pocket_devserver_client_closing());
  clock_now += 1;
  assert(pocket_devserver_client_closing());
  pocket_devserver_client_close();
  pocket_devserver_client_open();
  clock_now += POCKET_DEV_SERVER_HELLO_TIMEOUT_MS + 1;
  assert(pocket_devserver_client_closing());
  pocket_devserver_client_close();
  pocket_devserver_counters(&counters);
  assert(counters.timeouts == 2);

  /* Shutdown forgets the pairing. */
  pocket_devserver_shutdown();
  assert(!pocket_devserver_paired());
  assert(!pocket_devserver_discovery(request, sizeof request, reply));
  puts("ok");
  return 0;
}
