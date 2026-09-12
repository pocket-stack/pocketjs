/*
 * Pocket Runtime wire v1 (PKRT) server, shared by the Nintendo 3DS host and
 * the POSIX/UIKit hosts. The transport-neutral state machine here is the only
 * place that decides what a frame means; hosts/3ds/src/devserver.c and
 * dev_wire_posix.c move bytes between it and their sockets.
 *
 * Semantics:
 * - The hello is answered with an ack. A rejected hello still receives its
 *   ack (status 2) before the client is closed, so desktop tools can report
 *   the wrong key instead of a timeout.
 * - Unknown frame types are skipped for forward compatibility. Non-zero
 *   frame flags, malformed headers, oversized or newline-bearing control
 *   records and a full control ring close the client.
 * - PING carries four bytes; the newest PONG is reserved until the output
 *   queue is empty, so bulk screenshot traffic cannot discard the heartbeat.
 * - A package upload streams into the staging file. A new begin replaces an
 *   unfinished transfer; an offset mismatch, a short commit, an abort or a
 *   closed client discards the staging file and reports transfer-error. A
 *   committed upload survives a disconnect until the host takes it.
 * - Status and install reports are critical: when they do not fit in the
 *   output queue the client is closed rather than left waiting for a record
 *   that will never arrive. Guest control records keep a reserve for them and
 *   a record larger than one frame is replaced by a ctrlDropped notice.
 */

#include "dev_server.h"

#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define RX_CAP (POCKET_RUNTIME_MAX_FRAME_BYTES + POCKET_RUNTIME_FRAME_HEADER_BYTES)
#define TX_CAP (2u * RX_CAP)
#define TX_RESERVE (4u * 1024u)
#define CTRL_CAP (4u * (POCKET_RUNTIME_MAX_CTRL_BYTES + 1u))
#define HELLO_CAP 1024u
#define SCREENSHOT_CHUNK_BYTES (48u * 1024u)

static PocketDevServerConfig config;
static int configured;
static uint8_t token[POCKET_RUNTIME_TOKEN_BYTES];
static uint64_t device_id;
static int paired;
static uint32_t generation;
static uint64_t active_hash;
static int packages_allowed = 1;

static int client_open;
static int authenticated;
static int closing;
static int failed;
static int expired;
static uint64_t last_rx_ms;
static uint8_t rx[RX_CAP];
static size_t rx_length;
static uint8_t tx[TX_CAP];
static size_t tx_length;
static size_t tx_offset;
static int pong_pending;
static uint8_t pong[4];
static char controls[CTRL_CAP];
static size_t controls_length;
static char hello[HELLO_CAP];
static size_t hello_length;

static FILE *upload;
static uint32_t upload_expected;
static uint32_t upload_received;
static uint64_t upload_hash;
static int upload_ready;

static int screenshot_requested;
static int screenshot_ready;
static uint8_t *screenshot_top;
static uint8_t *screenshot_auxiliary;
static uint32_t screenshot_top_bytes;
static uint32_t screenshot_auxiliary_bytes;
static uint32_t screenshot_frame;
static uint32_t screenshot_offset;
static uint16_t screenshot_top_width;
static uint16_t screenshot_top_height;
static uint16_t screenshot_auxiliary_width;
static uint16_t screenshot_auxiliary_height;
static uint8_t screenshot_stage;
static uint8_t screenshot_surface;

static PocketDevServerCounters counters;

static uint64_t now_ms(void) {
  return configured ? config.now_ms() : 0;
}

static void set_error(char *out, size_t length, const char *format, ...) {
  if (out == NULL || length == 0) return;
  va_list arguments;
  va_start(arguments, format);
  vsnprintf(out, length, format, arguments);
  va_end(arguments);
}

/* ---- output queue ---------------------------------------------------- */

static int queue_frame(uint8_t type, uint8_t flags, const void *payload, size_t length, int critical) {
  if (!client_open || !authenticated || closing || failed) return 0;
  if (length > POCKET_RUNTIME_MAX_FRAME_BYTES) return 0;
  if (tx_offset > 0) {
    memmove(tx, tx + tx_offset, tx_length - tx_offset);
    tx_length -= tx_offset;
    tx_offset = 0;
  }
  size_t required = POCKET_RUNTIME_FRAME_HEADER_BYTES + length;
  size_t reserve = critical ? 0 : TX_RESERVE;
  if (required + reserve > sizeof tx - tx_length) {
    if (critical) failed = 1;
    return 0;
  }
  pocket_runtime_encode_frame_header(tx + tx_length, type, flags, (uint32_t)length);
  if (length > 0) memcpy(tx + tx_length + POCKET_RUNTIME_FRAME_HEADER_BYTES, payload, length);
  tx_length += required;
  return 1;
}

static size_t json_escape(char *out, size_t capacity, const char *text) {
  size_t written = 0;
  if (capacity == 0) return 0;
  if (text == NULL) {
    out[0] = '\0';
    return 0;
  }
  for (const unsigned char *at = (const unsigned char *)text; *at != 0; at += 1) {
    const char *escape = NULL;
    char unicode[7];
    if (*at == '"') escape = "\\\"";
    else if (*at == '\\') escape = "\\\\";
    else if (*at == '\n') escape = "\\n";
    else if (*at == '\r') escape = "\\r";
    else if (*at == '\t') escape = "\\t";
    else if (*at < 0x20) {
      snprintf(unicode, sizeof unicode, "\\u%04x", *at);
      escape = unicode;
    }
    if (escape != NULL) {
      size_t length = strlen(escape);
      if (written + length >= capacity) break;
      memcpy(out + written, escape, length);
      written += length;
    } else {
      if (written + 1 >= capacity) break;
      out[written++] = (char)*at;
    }
  }
  out[written] = '\0';
  return written;
}

void pocket_devserver_send_ctrl(const char *line, size_t length) {
  if (line == NULL || length == 0) return;
  if (length > POCKET_RUNTIME_MAX_FRAME_BYTES) {
    /* Too large for any frame. Say so, so the tool waiting on this record
     * learns why it is never coming. */
    char notice[128];
    int written = snprintf(
      notice,
      sizeof notice,
      "{\"t\":\"ctrlDropped\",\"bytes\":%u,\"cap\":%u}",
      (unsigned)length,
      (unsigned)POCKET_RUNTIME_MAX_FRAME_BYTES
    );
    if (written > 0) queue_frame(POCKET_RUNTIME_MSG_CTRL, 0, notice, (size_t)written, 0);
    return;
  }
  /* The guest's DevTools hello is replayed to every later client. */
  static const char marker[] = "\"t\":\"hello\"";
  int is_hello = 0;
  for (size_t offset = 0; offset + sizeof marker - 1 <= length && !is_hello; offset += 1) {
    is_hello = memcmp(line + offset, marker, sizeof marker - 1) == 0;
  }
  if (is_hello && length < sizeof hello) {
    memcpy(hello, line, length);
    hello[length] = '\0';
    hello_length = length;
  }
  queue_frame(POCKET_RUNTIME_MSG_CTRL, 0, line, length, 0);
}

static void send_status(void) {
  char text[2048];
  if (!configured || config.status == NULL) return;
  text[0] = '\0';
  config.status(text, sizeof text);
  size_t length = strlen(text);
  if (length > 0) queue_frame(POCKET_RUNTIME_MSG_CTRL, 0, text, length, 1);
}

void pocket_devserver_report_install(const char *phase, uint64_t hash, const char *message) {
  char escaped[640];
  char line[896];
  json_escape(escaped, sizeof escaped, message);
  int length = snprintf(
    line,
    sizeof line,
    "{\"t\":\"runtime.install\",\"phase\":\"%s\",\"hash\":\"%016llx\","
    "\"generation\":%lu,\"message\":\"%s\"}",
    phase == NULL ? "unknown" : phase,
    (unsigned long long)hash,
    (unsigned long)generation,
    escaped
  );
  if (length > 0 && (size_t)length < sizeof line) {
    queue_frame(POCKET_RUNTIME_MSG_CTRL, 0, line, (size_t)length, 1);
  }
}

void pocket_devserver_report_log(const char *level, const char *message) {
  char escaped[640];
  char line[768];
  json_escape(escaped, sizeof escaped, message);
  int length = snprintf(
    line,
    sizeof line,
    "{\"t\":\"log\",\"level\":\"%s\",\"args\":[\"%s\"]}",
    level == NULL ? "info" : level,
    escaped
  );
  if (length > 0 && (size_t)length < sizeof line) {
    queue_frame(POCKET_RUNTIME_MSG_CTRL, 0, line, (size_t)length, 0);
  }
}

/* ---- control ring ---------------------------------------------------- */

static int append_ctrl(const uint8_t *bytes, size_t length) {
  if (length == 0 || length + 1 > sizeof controls - controls_length) return 0;
  memcpy(controls + controls_length, bytes, length);
  controls_length += length;
  controls[controls_length++] = '\n';
  return 1;
}

size_t pocket_devserver_recv_ctrl(char *out, size_t capacity) {
  if (out == NULL || capacity <= 1 || controls_length == 0) return 0;
  size_t length = controls_length < capacity - 1 ? controls_length : capacity - 1;
  /* Every accepted control frame ends in a synthetic newline. Never hand the
   * guest a partial JSON record when several queued frames exceed its poll
   * capacity. */
  while (length > 0 && controls[length - 1] != '\n') length -= 1;
  if (length == 0) return 0;
  memcpy(out, controls, length);
  out[length] = '\0';
  memmove(controls, controls + length, controls_length - length);
  controls_length -= length;
  return length;
}

void pocket_devserver_reset_guest(void) {
  controls_length = 0;
  hello_length = 0;
  hello[0] = '\0';
}

/* ---- uploads --------------------------------------------------------- */

static void close_upload(void) {
  int staged = upload != NULL || upload_ready;
  if (upload != NULL) fclose(upload);
  upload = NULL;
  upload_expected = 0;
  upload_received = 0;
  upload_hash = 0;
  upload_ready = 0;
  if (staged && configured) remove(config.upload_path);
}

static void abort_upload(const char *message) {
  uint64_t rejected = upload_hash;
  close_upload();
  pocket_devserver_report_install("transfer-error", rejected, message);
}

static void handle_package_begin(const uint8_t *payload, size_t length) {
  PocketRuntimePackageBegin begin;
  if (!pocket_runtime_parse_package_begin(payload, length, &begin)) {
    abort_upload("invalid package begin frame");
    return;
  }
  if (!packages_allowed) {
    pocket_devserver_report_install(
      "rejected",
      begin.footer_hash,
      "This native host does not accept .pocket guest packages"
    );
    return;
  }
  close_upload();
  upload = fopen(config.upload_path, "wb");
  if (upload == NULL) {
    pocket_devserver_report_install("transfer-error", begin.footer_hash, "open package staging file failed");
    return;
  }
  upload_expected = begin.length;
  upload_received = 0;
  upload_hash = begin.footer_hash;
  pocket_devserver_report_install("receiving", upload_hash, "binary package transfer started");
}

static void handle_package_chunk(const uint8_t *payload, size_t length) {
  if (upload == NULL || length <= 4) {
    abort_upload("package chunk arrived without an active transfer");
    return;
  }
  uint32_t offset = pocket_runtime_read_u32(payload);
  size_t bytes = length - 4;
  if (offset != upload_received || bytes > upload_expected - upload_received ||
      fwrite(payload + 4, 1, bytes, upload) != bytes) {
    abort_upload("package chunk offset, length, or staging write failed");
    return;
  }
  upload_received += (uint32_t)bytes;
}

static void handle_package_commit(size_t length) {
  if (length != 0) {
    abort_upload("package commit payload must be empty");
    return;
  }
  if (upload == NULL || upload_received != upload_expected) {
    abort_upload("package commit arrived before every declared byte");
    return;
  }
  int written = fflush(upload) == 0 && fsync(fileno(upload)) == 0;
  if (fclose(upload) != 0) written = 0;
  upload = NULL;
  if (!written) {
    abort_upload("flush package staging file failed");
    return;
  }
  upload_ready = 1;
  counters.uploads += 1;
  pocket_devserver_report_install("received", upload_hash, "binary package transfer complete");
}

int pocket_devserver_take_upload(uint64_t *declared_hash) {
  if (!upload_ready) return 0;
  if (declared_hash != NULL) *declared_hash = upload_hash;
  upload_ready = 0;
  upload_expected = 0;
  upload_received = 0;
  upload_hash = 0;
  return 1;
}

const char *pocket_devserver_upload_path(void) {
  return configured ? config.upload_path : "";
}

int pocket_devserver_upload_pending(void) {
  return upload_ready;
}

void pocket_devserver_allow_packages(int allowed) {
  packages_allowed = allowed ? 1 : 0;
  if (!allowed && (upload != NULL || upload_ready)) {
    abort_upload("guest package admission disabled by host");
  }
}

/* ---- screenshots ----------------------------------------------------- */

void pocket_devserver_screenshot_cancel(void) {
  if (configured && config.screenshot_free != NULL) {
    if (screenshot_top != NULL) config.screenshot_free(screenshot_top);
    if (screenshot_auxiliary != NULL) config.screenshot_free(screenshot_auxiliary);
  }
  screenshot_top = NULL;
  screenshot_auxiliary = NULL;
  screenshot_top_bytes = 0;
  screenshot_auxiliary_bytes = 0;
  screenshot_ready = 0;
  screenshot_stage = 0;
  screenshot_surface = 0;
  screenshot_offset = 0;
}

int pocket_devserver_request_screenshot(void) {
  if (!configured || config.screenshot_alloc == NULL) return 0;
  if (!pocket_devserver_connected() || screenshot_requested || screenshot_ready) return 0;
  screenshot_requested = 1;
  return 1;
}

int pocket_devserver_take_screenshot_request(void) {
  if (!screenshot_requested) return 0;
  screenshot_requested = 0;
  return 1;
}

int pocket_devserver_screenshot_begin(
  uint32_t frame,
  uint16_t top_width,
  uint16_t top_height,
  uint16_t auxiliary_width,
  uint16_t auxiliary_height,
  uint8_t **top,
  uint8_t **auxiliary
) {
  if (!configured || config.screenshot_alloc == NULL || config.screenshot_free == NULL) return 0;
  if (top == NULL || auxiliary == NULL || screenshot_ready || screenshot_top != NULL) return 0;
  uint32_t top_bytes = (uint32_t)top_width * top_height * 3u;
  uint32_t auxiliary_bytes = (uint32_t)auxiliary_width * auxiliary_height * 3u;
  screenshot_top = config.screenshot_alloc(top_bytes);
  screenshot_auxiliary = config.screenshot_alloc(auxiliary_bytes);
  if (screenshot_top == NULL || screenshot_auxiliary == NULL) {
    pocket_devserver_screenshot_cancel();
    return 0;
  }
  screenshot_frame = frame;
  screenshot_top_width = top_width;
  screenshot_top_height = top_height;
  screenshot_auxiliary_width = auxiliary_width;
  screenshot_auxiliary_height = auxiliary_height;
  screenshot_top_bytes = top_bytes;
  screenshot_auxiliary_bytes = auxiliary_bytes;
  *top = screenshot_top;
  *auxiliary = screenshot_auxiliary;
  return 1;
}

void pocket_devserver_screenshot_ready(void) {
  if (screenshot_top == NULL || screenshot_auxiliary == NULL) return;
  screenshot_ready = 1;
  screenshot_stage = 0;
  screenshot_surface = 0;
  screenshot_offset = 0;
}

/* Streams one frame at a time into an empty queue, so the heartbeat and every
 * control record get a turn between 48 KiB chunks. Surface and stage changes
 * that queue nothing continue in the same call. */
static void queue_screenshot_frame(void) {
  while (screenshot_ready && tx_length == tx_offset) {
    if (screenshot_stage == 0) {
      uint8_t begin[POCKET_RUNTIME_SCREENSHOT_BEGIN_BYTES];
      pocket_runtime_encode_screenshot_begin(
        begin,
        screenshot_frame,
        screenshot_top_width,
        screenshot_top_height,
        screenshot_auxiliary_width,
        screenshot_auxiliary_height,
        screenshot_top_bytes,
        screenshot_auxiliary_bytes
      );
      if (queue_frame(POCKET_RUNTIME_MSG_SCREENSHOT_BEGIN, 0, begin, sizeof begin, 0)) {
        screenshot_stage = 1;
      }
      return;
    }
    if (screenshot_stage == 1) {
      const uint8_t *surface = screenshot_surface == 0 ? screenshot_top : screenshot_auxiliary;
      uint32_t bytes = screenshot_surface == 0 ? screenshot_top_bytes : screenshot_auxiliary_bytes;
      if (screenshot_offset < bytes) {
        uint32_t amount = bytes - screenshot_offset;
        if (amount > SCREENSHOT_CHUNK_BYTES) amount = SCREENSHOT_CHUNK_BYTES;
        static uint8_t payload[4 + SCREENSHOT_CHUNK_BYTES];
        pocket_runtime_write_u32(payload, screenshot_offset);
        memcpy(payload + 4, surface + screenshot_offset, amount);
        if (queue_frame(POCKET_RUNTIME_MSG_SCREENSHOT_CHUNK, screenshot_surface, payload, 4 + amount, 0)) {
          screenshot_offset += amount;
        }
        return;
      }
      if (screenshot_surface == 0) {
        screenshot_surface = 1;
        screenshot_offset = 0;
        continue;
      }
      screenshot_stage = 2;
      continue;
    }
    if (screenshot_stage == 2) {
      uint8_t end[4];
      pocket_runtime_write_u32(end, screenshot_frame);
      if (queue_frame(POCKET_RUNTIME_MSG_SCREENSHOT_END, 0, end, sizeof end, 0)) {
        screenshot_stage = 3;
      }
      return;
    }
    /* The end frame has left the queue: the capture is complete. */
    counters.screenshots += 1;
    pocket_devserver_screenshot_cancel();
  }
}

/* ---- frames ---------------------------------------------------------- */

static void handle_frame(const PocketRuntimeFrameHeader *header, const uint8_t *payload) {
  if (header->flags != 0) {
    failed = 1;
    return;
  }
  switch (header->type) {
    case POCKET_RUNTIME_MSG_PING:
      if (header->length == sizeof pong) {
        memcpy(pong, payload, sizeof pong);
        pong_pending = 1;
      }
      break;
    case POCKET_RUNTIME_MSG_PONG:
      break;
    case POCKET_RUNTIME_MSG_CTRL:
      if (header->length == 0 || header->length > POCKET_RUNTIME_MAX_CTRL_BYTES ||
          memchr(payload, '\0', header->length) != NULL ||
          memchr(payload, '\n', header->length) != NULL ||
          memchr(payload, '\r', header->length) != NULL ||
          !append_ctrl(payload, header->length)) {
        failed = 1;
      }
      break;
    case POCKET_RUNTIME_MSG_PACKAGE_BEGIN:
      handle_package_begin(payload, header->length);
      break;
    case POCKET_RUNTIME_MSG_PACKAGE_CHUNK:
      handle_package_chunk(payload, header->length);
      break;
    case POCKET_RUNTIME_MSG_PACKAGE_COMMIT:
      handle_package_commit(header->length);
      break;
    case POCKET_RUNTIME_MSG_PACKAGE_ABORT:
      abort_upload("client aborted package transfer");
      break;
    case POCKET_RUNTIME_MSG_STATUS_REQUEST:
      if (header->length == 0) send_status();
      break;
    default:
      /* Unknown length-framed messages are skipped for forward compatibility. */
      break;
  }
}

/* ---- client lifecycle ------------------------------------------------ */

static void reset_client(void) {
  authenticated = 0;
  closing = 0;
  failed = 0;
  expired = 0;
  rx_length = 0;
  tx_length = 0;
  tx_offset = 0;
  pong_pending = 0;
  controls_length = 0;
  screenshot_requested = 0;
  pocket_devserver_screenshot_cancel();
}

void pocket_devserver_client_open(void) {
  reset_client();
  if (upload != NULL && !upload_ready) close_upload();
  last_rx_ms = now_ms();
  client_open = 1;
}

void pocket_devserver_client_close(void) {
  reset_client();
  /* A committed upload is complete and hashed; the host still takes it. */
  if (upload != NULL && !upload_ready) close_upload();
  client_open = 0;
}

int pocket_devserver_connected(void) {
  return client_open && authenticated && !closing && !failed;
}

size_t pocket_devserver_rx_room(uint8_t **out) {
  if (out == NULL || !client_open) return 0;
  *out = rx + rx_length;
  return sizeof rx - rx_length;
}

int pocket_devserver_rx_commit(size_t length) {
  if (!client_open || failed) return 0;
  if (length > sizeof rx - rx_length) {
    failed = 1;
    return 0;
  }
  rx_length += length;
  counters.rx_bytes += length;
  last_rx_ms = now_ms();
  if (closing) {
    /* Nothing after a rejected hello is read; its ack is still on the way. */
    rx_length = 0;
    return 1;
  }
  if (!authenticated) {
    if (rx_length < POCKET_RUNTIME_HELLO_BYTES) return 1;
    int accepted = paired && pocket_runtime_verify_hello(rx, POCKET_RUNTIME_HELLO_BYTES, token);
    /* The ack is the first thing on the wire; the queue is empty here. */
    pocket_runtime_encode_ack(
      tx,
      accepted ? 0 : 2,
      config.host_abi,
      generation,
      packages_allowed ? POCKET_DEV_SERVER_ACK_FLAG_PACKAGES : 0u,
      active_hash
    );
    tx_length = POCKET_RUNTIME_ACK_BYTES;
    tx_offset = 0;
    memmove(rx, rx + POCKET_RUNTIME_HELLO_BYTES, rx_length - POCKET_RUNTIME_HELLO_BYTES);
    rx_length -= POCKET_RUNTIME_HELLO_BYTES;
    if (!accepted) {
      counters.auth_failures += 1;
      closing = 1;
      rx_length = 0;
      return 1;
    }
    authenticated = 1;
    counters.connects += 1;
    if (hello_length > 0) queue_frame(POCKET_RUNTIME_MSG_CTRL, 0, hello, hello_length, 0);
    send_status();
  }
  while (!failed && !upload_ready && rx_length >= POCKET_RUNTIME_FRAME_HEADER_BYTES) {
    PocketRuntimeFrameHeader header;
    if (!pocket_runtime_parse_frame_header(rx, rx_length, &header)) {
      failed = 1;
      break;
    }
    size_t total = POCKET_RUNTIME_FRAME_HEADER_BYTES + (size_t)header.length;
    if (rx_length < total) break;
    handle_frame(&header, rx + POCKET_RUNTIME_FRAME_HEADER_BYTES);
    memmove(rx, rx + total, rx_length - total);
    rx_length -= total;
  }
  return !failed;
}

size_t pocket_devserver_tx_pending(const uint8_t **out) {
  if (out == NULL || !client_open) return 0;
  if (authenticated && !closing && !failed && tx_offset == tx_length) {
    tx_offset = 0;
    tx_length = 0;
    if (pong_pending && queue_frame(POCKET_RUNTIME_MSG_PONG, 0, pong, sizeof pong, 1)) {
      pong_pending = 0;
    }
    queue_screenshot_frame();
  }
  *out = tx + tx_offset;
  return tx_length - tx_offset;
}

void pocket_devserver_tx_consumed(size_t length) {
  if (length > tx_length - tx_offset) length = tx_length - tx_offset;
  tx_offset += length;
  counters.tx_bytes += length;
  if (tx_offset == tx_length) {
    tx_offset = 0;
    tx_length = 0;
  }
}

int pocket_devserver_client_closing(void) {
  if (!client_open) return 0;
  if (failed) return 1;
  if (closing && tx_offset == tx_length) return 1;
  uint64_t limit = authenticated
    ? POCKET_DEV_SERVER_IDLE_TIMEOUT_MS
    : POCKET_DEV_SERVER_HELLO_TIMEOUT_MS;
  if (now_ms() - last_rx_ms > limit) {
    if (!expired) {
      expired = 1;
      counters.timeouts += 1;
    }
    return 1;
  }
  return 0;
}

int pocket_devserver_discovery(
  const uint8_t *request,
  size_t length,
  uint8_t reply[POCKET_RUNTIME_DISCOVERY_REPLY_BYTES]
) {
  if (!configured || !paired || reply == NULL) return 0;
  if (!pocket_runtime_is_discovery_request(request, length)) return 0;
  pocket_runtime_encode_discovery_reply(
    reply,
    config.host_abi,
    config.port,
    pocket_devserver_connected() ? 1u : 0u,
    generation,
    active_hash,
    device_id,
    config.target,
    config.label
  );
  counters.discoveries += 1;
  return 1;
}

/* ---- configuration and pairing --------------------------------------- */

int pocket_devserver_configure(const PocketDevServerConfig *value) {
  if (value == NULL || value->target == NULL || value->target[0] == '\0' ||
      value->label == NULL || value->upload_path == NULL || value->upload_path[0] == '\0' ||
      value->now_ms == NULL || value->port == 0) {
    return 0;
  }
  /* A truncated name would pair the desktop with a Runtime it cannot name. */
  if (strlen(value->target) > POCKET_DEV_SERVER_NAME_BYTES ||
      strlen(value->label) > POCKET_DEV_SERVER_NAME_BYTES) {
    return 0;
  }
  config = *value;
  configured = 1;
  return 1;
}

static int hex_digit(int value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
}

int pocket_devserver_load_key(const char *path, char *error, size_t error_length) {
  if (path == NULL) {
    set_error(error, error_length, "pairing key path is empty");
    return POCKET_DEV_SERVER_KEY_ERROR;
  }
  FILE *file = fopen(path, "rb");
  if (file == NULL) {
    if (errno == ENOENT) return POCKET_DEV_SERVER_KEY_DISABLED;
    set_error(error, error_length, "open %s failed (%d)", path, errno);
    return POCKET_DEV_SERVER_KEY_ERROR;
  }
  char hex[66] = {0};
  size_t length = fread(hex, 1, sizeof hex, file);
  int close_result = fclose(file);
  if (close_result != 0 || (length != 64 && length != 65) || (length == 65 && hex[64] != '\n')) {
    set_error(error, error_length, "dev.key must contain exactly 64 hexadecimal characters");
    return POCKET_DEV_SERVER_KEY_ERROR;
  }
  uint8_t decoded[POCKET_RUNTIME_TOKEN_BYTES];
  for (size_t index = 0; index < POCKET_RUNTIME_TOKEN_BYTES; index += 1) {
    int high = hex_digit(hex[index * 2]);
    int low = hex_digit(hex[index * 2 + 1]);
    if (high < 0 || low < 0) {
      set_error(error, error_length, "dev.key contains a non-hexadecimal character");
      return POCKET_DEV_SERVER_KEY_ERROR;
    }
    decoded[index] = (uint8_t)((high << 4) | low);
  }
  memcpy(token, decoded, sizeof token);
  device_id = pocket_runtime_device_id(token);
  paired = 1;
  return POCKET_DEV_SERVER_KEY_READY;
}

int pocket_devserver_paired(void) {
  return paired;
}

uint64_t pocket_devserver_device_id(void) {
  return paired ? device_id : 0;
}

void pocket_devserver_set_state(uint32_t next_generation, uint64_t next_active_hash) {
  generation = next_generation;
  active_hash = next_active_hash;
}

uint32_t pocket_devserver_generation(void) {
  return generation;
}

void pocket_devserver_shutdown(void) {
  pocket_devserver_client_close();
  close_upload();
  pocket_devserver_reset_guest();
  memset(token, 0, sizeof token);
  device_id = 0;
  paired = 0;
}

void pocket_devserver_counters(PocketDevServerCounters *out) {
  if (out != NULL) *out = counters;
}
