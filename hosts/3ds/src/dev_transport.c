/*
 * Paired in-process development transport for Pocket Runtime.
 *
 * The development worker owns all sockets, files and mutable transport state. JSON control
 * frames feed the existing Pocket DevTools shim; `.pocket` uploads stream to
 * SD and screenshots stream from linear memory. Bulk bytes never enter JS.
 */

#include "dev_transport.h"

#include <3ds.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include "dev_protocol.h"
#include "soc.h"

#ifndef POCKETJS_HOST_ABI
#error "POCKETJS_HOST_ABI must come from the verified ResolvedBuildPlan"
#endif
#ifndef POCKETJS_TARGET_ID
#error "POCKETJS_TARGET_ID must come from the verified ResolvedBuildPlan"
#endif

#define RX_BYTES (POCKET_RUNTIME_MAX_FRAME_BYTES + POCKET_RUNTIME_FRAME_HEADER_BYTES)
#define CTRL_IN_BYTES (4u * (POCKET_RUNTIME_MAX_CTRL_BYTES + 1u))
#define CTRL_OUT_BYTES (POCKET_RUNTIME_MAX_FRAME_BYTES + POCKET_RUNTIME_FRAME_HEADER_BYTES)
#define SCREENSHOT_CHUNK_BYTES (48u * 1024u)

static int server_fd = -1;
static int discovery_fd = -1;
static int client_fd = -1;
static bool initialized;
static bool authenticated;
static bool handshake_pending;
static bool handshake_accepted;
static uint8_t handshake_ack[POCKET_RUNTIME_ACK_BYTES];
static size_t handshake_ack_offset;
static uint64_t client_last_rx_ms;
static uint8_t pairing_token[POCKET_RUNTIME_TOKEN_BYTES];
static uint64_t device_id;

static uint8_t rx_buffer[RX_BYTES];
static size_t rx_length;
static uint8_t ctrl_input[CTRL_IN_BYTES];
static size_t ctrl_input_length;
static uint8_t tx_buffer[CTRL_OUT_BYTES];
static size_t tx_length;
static size_t tx_offset;
static char install_lines[8][640];
static unsigned install_read, install_write;
static bool pong_pending;
static uint8_t pong_payload[4];

static char hello_cache[1024];
static size_t hello_cache_length;

static FILE *upload_file;
static uint32_t upload_expected;
static uint32_t upload_received;
static uint64_t upload_hash;
static bool upload_ready;
static bool upload_busy;
static bool upload_discarding;
static bool screenshot_borrowed;

static bool screenshot_requested;
static bool screenshot_ready;
static uint8_t *screenshot_top;
static uint8_t *screenshot_auxiliary;
static uint32_t screenshot_top_bytes;
static uint32_t screenshot_auxiliary_bytes;
static uint32_t screenshot_frame;
static uint16_t screenshot_top_width;
static uint16_t screenshot_top_height;
static uint16_t screenshot_auxiliary_width;
static uint16_t screenshot_auxiliary_height;
static uint8_t screenshot_stage;
static uint8_t screenshot_surface;
static uint32_t screenshot_offset;

static PocketRuntimeState runtime_state;
static uint64_t running_hash;
static uint64_t variant_hash;
static uint32_t runtime_frame;
static char runtime_phase[32] = "starting";

static uint64_t rx_bytes;
static uint64_t tx_bytes;
static uint32_t connects;
static uint32_t auth_failures;
static uint32_t uploads;
static uint32_t screenshots;
static uint32_t timeouts;
static uint32_t discoveries;
static uint32_t frame_commands;
static uint32_t frame_vertices;
static uint32_t frame_dropped_vertices;
static char stats_json[768];

static void set_error(char *out, size_t length, const char *format, ...) {
  if (out == NULL || length == 0) return;
  va_list arguments;
  va_start(arguments, format);
  vsnprintf(out, length, format, arguments);
  va_end(arguments);
}

static bool would_block(void) {
  return errno == EAGAIN || errno == EWOULDBLOCK;
}

static void format_ip(char out[16]) {
  uint32_t ip = initialized ? gethostid() : 0;
  snprintf(
    out,
    16,
    "%lu.%lu.%lu.%lu",
    (unsigned long)(ip & 0xff),
    (unsigned long)((ip >> 8) & 0xff),
    (unsigned long)((ip >> 16) & 0xff),
    (unsigned long)((ip >> 24) & 0xff)
  );
}

static void close_upload(void) {
  if (upload_file != NULL) fclose(upload_file);
  upload_file = NULL;
  upload_expected = 0;
  upload_received = 0;
  upload_hash = 0;
}

void devtransport_screenshot_cancel(void) {
  if (!screenshot_borrowed && screenshot_top != NULL) linearFree(screenshot_top);
  if (!screenshot_borrowed && screenshot_auxiliary != NULL) linearFree(screenshot_auxiliary);
  screenshot_top = NULL;
  screenshot_auxiliary = NULL;
  screenshot_top_bytes = 0;
  screenshot_auxiliary_bytes = 0;
  screenshot_ready = false;
  screenshot_stage = 0;
  screenshot_surface = 0;
  screenshot_offset = 0;
  screenshot_borrowed = false;
}

void devtransport_set_upload_busy(bool busy) { upload_busy = busy; }
void devtransport_reset_guest(void) {
  ctrl_input_length = 0;
  hello_cache_length = 0;
}
bool devtransport_ctrl_available(size_t length) {
  return length <= POCKET_RUNTIME_MAX_FRAME_BYTES &&
    length + POCKET_RUNTIME_FRAME_HEADER_BYTES <= sizeof tx_buffer - (tx_length - tx_offset);
}
bool devtransport_screenshot_busy(void) { return screenshot_top != NULL; }
void devtransport_adopt_screenshot(uint32_t frame, uint16_t tw, uint16_t th,
    uint16_t aw, uint16_t ah, uint8_t *top, uint8_t *aux) {
  screenshot_borrowed = true;
  screenshot_frame = frame;
  screenshot_top_width = tw; screenshot_top_height = th;
  screenshot_auxiliary_width = aw; screenshot_auxiliary_height = ah;
  screenshot_top_bytes = (uint32_t)tw * th * 3;
  screenshot_auxiliary_bytes = (uint32_t)aw * ah * 3;
  screenshot_top = top; screenshot_auxiliary = aux;
  devtransport_screenshot_ready();
}

static void disconnect_client(void) {
  if (client_fd >= 0) close(client_fd);
  client_fd = -1;
  authenticated = false;
  handshake_pending = false;
  handshake_accepted = false;
  handshake_ack_offset = 0;
  rx_length = 0;
  ctrl_input_length = 0;
  tx_length = 0;
  tx_offset = 0;
  install_read = install_write = 0;
  pong_pending = false;
  screenshot_requested = false;
  devtransport_screenshot_cancel();
  if (upload_file != NULL && !upload_ready) close_upload();
}

static bool set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

static int hex_digit(int value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
}

static DevserverInitResult load_key(char *error, size_t error_length) {
  FILE *file = fopen(POCKET_RUNTIME_DEV_KEY, "rb");
  if (file == NULL) {
    if (errno == ENOENT) return DEVSERVER_DISABLED;
    set_error(error, error_length, "open %s failed (%d)", POCKET_RUNTIME_DEV_KEY, errno);
    return DEVSERVER_ERROR;
  }
  char hex[66] = {0};
  size_t length = fread(hex, 1, sizeof hex, file);
  int close_result = fclose(file);
  if (close_result != 0 || (length != 64 && length != 65) ||
      (length == 65 && hex[64] != '\n')) {
    set_error(error, error_length, "dev.key must contain exactly 64 hexadecimal characters");
    return DEVSERVER_ERROR;
  }
  for (size_t index = 0; index < POCKET_RUNTIME_TOKEN_BYTES; index += 1) {
    int high = hex_digit(hex[index * 2]);
    int low = hex_digit(hex[index * 2 + 1]);
    if (high < 0 || low < 0) {
      set_error(error, error_length, "dev.key contains a non-hexadecimal character");
      return DEVSERVER_ERROR;
    }
    pairing_token[index] = (uint8_t)((high << 4) | low);
  }
  device_id = pocket_runtime_device_id(pairing_token);
  return DEVSERVER_READY;
}

DevserverInitResult devtransport_init(
  const PocketRuntimeState *state,
  char *error,
  size_t error_length
) {
  if (initialized) return DEVSERVER_READY;
  if (state != NULL) runtime_state = *state;
  DevserverInitResult key = load_key(error, error_length);
  if (key != DEVSERVER_READY) return key;

  if (!soc_ensure(error, error_length)) return DEVSERVER_ERROR;

  server_fd = socket(AF_INET, SOCK_STREAM, 0);
  if (server_fd < 0) {
    set_error(error, error_length, "Pocket Runtime socket failed (%d)", errno);
    devtransport_shutdown();
    return DEVSERVER_ERROR;
  }
  int reuse = 1;
  setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof reuse);
  struct sockaddr_in address;
  memset(&address, 0, sizeof address);
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = INADDR_ANY;
  address.sin_port = htons(POCKET_RUNTIME_WIRE_PORT);
  if (bind(server_fd, (struct sockaddr *)&address, sizeof address) != 0 ||
      listen(server_fd, 1) != 0 || !set_nonblocking(server_fd)) {
    set_error(error, error_length, "Pocket Runtime listen on %u failed (%d)", POCKET_RUNTIME_WIRE_PORT, errno);
    devtransport_shutdown();
    return DEVSERVER_ERROR;
  }

  discovery_fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (discovery_fd >= 0) {
    setsockopt(discovery_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof reuse);
    if (bind(discovery_fd, (struct sockaddr *)&address, sizeof address) != 0 ||
        !set_nonblocking(discovery_fd)) {
      close(discovery_fd);
      discovery_fd = -1;
    }
  }
  initialized = true;
  return DEVSERVER_READY;
}

void devtransport_shutdown(void) {
  disconnect_client();
  close_upload();
  if (server_fd >= 0) close(server_fd);
  server_fd = -1;
  if (discovery_fd >= 0) close(discovery_fd);
  discovery_fd = -1;
  /* SOC itself is shared with the svc transport; main owns soc_shutdown. */
  initialized = false;
}

bool devtransport_active(void) {
  return initialized;
}

bool devtransport_connected(void) {
  return authenticated && client_fd >= 0;
}

void devtransport_snapshot(DevserverSnapshot *out) {
  if (out == NULL) return;
  memset(out, 0, sizeof *out);
  out->enabled = initialized;
  out->discoverable = discovery_fd >= 0;
  out->connected = devtransport_connected();
  format_ip(out->ip);
  snprintf(out->phase, sizeof out->phase, "%s", runtime_phase);
  out->port = POCKET_RUNTIME_WIRE_PORT;
  out->host_abi = POCKETJS_HOST_ABI;
  out->generation = runtime_state.generation;
  out->running_hash = running_hash;
  out->device_id = device_id;
  out->connects = connects;
  out->auth_failures = auth_failures;
  out->timeouts = timeouts;
  out->uploads = uploads;
  out->screenshots = screenshots;
}

static bool queue_frame(uint8_t type, uint8_t flags, const uint8_t *payload, size_t length) {
  if (length > POCKET_RUNTIME_MAX_FRAME_BYTES) return false;
  uint8_t header[POCKET_RUNTIME_FRAME_HEADER_BYTES];
  pocket_runtime_encode_frame_header(header, type, flags, (uint32_t)length);
  if (tx_offset > 0) {
    if (tx_offset < tx_length) {
      memmove(tx_buffer, tx_buffer + tx_offset, tx_length - tx_offset);
      tx_length -= tx_offset;
    } else {
      tx_length = 0;
    }
    tx_offset = 0;
  }
  if (sizeof header + length > sizeof tx_buffer - tx_length) return false;
  memcpy(tx_buffer + tx_length, header, sizeof header);
  tx_length += sizeof header;
  if (length > 0) {
    memcpy(tx_buffer + tx_length, payload, length);
    tx_length += length;
  }
  return true;
}

static size_t json_escape(char *out, size_t capacity, const char *text) {
  size_t written = 0;
  if (text == NULL) return 0;
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
  if (capacity > 0) out[written < capacity ? written : capacity - 1] = '\0';
  return written;
}

/*
 * On the way out a control record may be as large as a frame. tx_buffer is
 * sized for a whole frame and the screenshot path already pushes 48 KiB
 * through it, whereas MAX_CTRL_BYTES bounds what the TOOL sends — ctrl_input,
 * the inbound ring, is sized from it. Holding outgoing records to the inbound
 * bound cost the devtools tree dump: past a few hundred nodes it went over
 * 16 KiB and was discarded here without a word, which on the tool side is
 * indistinguishable from a hung device until the 15 s timeout expires.
 */
void devtransport_send_ctrl(const char *line, size_t length) {
  if (line == NULL || length == 0) return;
  if (length > POCKET_RUNTIME_MAX_FRAME_BYTES) {
    /* Too large for any frame. Say so, so the caller waiting on this record
     * learns why it is never coming. */
    char notice[128];
    int written = snprintf(
      notice,
      sizeof notice,
      "{\"t\":\"ctrlDropped\",\"bytes\":%u,\"cap\":%u}",
      (unsigned)length,
      (unsigned)POCKET_RUNTIME_MAX_FRAME_BYTES
    );
    if (written > 0) {
      queue_frame(POCKET_RUNTIME_MSG_CTRL, 0, (const uint8_t *)notice, (size_t)written);
    }
    return;
  }
  static const char hello_marker[] = "\"t\":\"hello\"";
  bool is_hello = false;
  if (length >= sizeof hello_marker - 1) {
    for (size_t offset = 0; offset + sizeof hello_marker - 1 <= length; offset += 1) {
      if (memcmp(line + offset, hello_marker, sizeof hello_marker - 1) == 0) {
        is_hello = true;
        break;
      }
    }
  }
  if (is_hello && length < sizeof hello_cache) {
    memcpy(hello_cache, line, length);
    hello_cache[length] = '\0';
    hello_cache_length = length;
  }
  queue_frame(POCKET_RUNTIME_MSG_CTRL, 0, (const uint8_t *)line, length);
}

static void send_status(void) {
  char message[640];
  char ip[16];
  format_ip(ip);
  snprintf(
    message,
    sizeof message,
    "{\"t\":\"runtime.status\",\"phase\":\"%s\",\"target\":\"%s\",\"hostAbi\":%u,"
    "\"ip\":\"%s\",\"port\":%u,\"generation\":%lu,"
    "\"active\":\"%016llx\",\"lastGood\":\"%016llx\",\"running\":\"%016llx\","
    "\"frame\":%lu}",
    runtime_phase,
    POCKETJS_TARGET_ID,
    (unsigned)POCKETJS_HOST_ABI,
    ip,
    (unsigned)POCKET_RUNTIME_WIRE_PORT,
    (unsigned long)runtime_state.generation,
    (unsigned long long)runtime_state.active_hash,
    (unsigned long long)runtime_state.last_good_hash,
    (unsigned long long)running_hash,
    (unsigned long)runtime_frame
  );
  devtransport_send_ctrl(message, strlen(message));
}

void devtransport_report_install(const char *phase, uint64_t hash, const char *message) {
  /* Receipts belong to the requesting connection, never a later client. */
  if (!devtransport_connected()) return;
  char escaped[384] = {0};
  if (install_write - install_read == 8) {
    /* Explicit disconnect beats silently losing the terminal install receipt. */
    disconnect_client(); return;
  }
  char *line = install_lines[install_write % 8];
  json_escape(escaped, sizeof escaped, message == NULL ? "" : message);
  snprintf(
    line,
    sizeof install_lines[0],
    "{\"t\":\"runtime.install\",\"phase\":\"%s\",\"hash\":\"%016llx\","
    "\"generation\":%lu,\"message\":\"%s\"}",
    phase == NULL ? "unknown" : phase,
    (unsigned long long)hash,
    (unsigned long)runtime_state.generation,
    escaped
  );
  install_write += 1;
}

void devtransport_report_log(const char *level, const char *message) {
  char escaped[448] = {0};
  char line[560];
  json_escape(escaped, sizeof escaped, message == NULL ? "" : message);
  snprintf(
    line,
    sizeof line,
    "{\"t\":\"log\",\"level\":\"%s\",\"args\":[\"%s\"]}",
    level == NULL ? "info" : level,
    escaped
  );
  devtransport_send_ctrl(line, strlen(line));
}

void devtransport_set_runtime(
  const PocketRuntimeState *state,
  const PocketRuntimePackage *package,
  const char *phase,
  uint32_t frame
) {
  if (state != NULL) runtime_state = *state;
  running_hash = package == NULL ? 0 : package->guest.package_hash;
  variant_hash = package == NULL ? 0 : package->guest.variant_hash;
  runtime_frame = frame;
  snprintf(runtime_phase, sizeof runtime_phase, "%s", phase == NULL ? "unknown" : phase);
}

void devtransport_set_frame_stats(
  uint32_t frame,
  uint32_t commands,
  uint32_t vertices,
  uint32_t dropped_vertices
) {
  runtime_frame = frame;
  frame_commands = commands;
  frame_vertices = vertices;
  frame_dropped_vertices = dropped_vertices;
}

const char *devtransport_debug_stats(void) {
  snprintf(
    stats_json,
    sizeof stats_json,
    "{\"target\":\"%s\",\"hostAbi\":%u,\"package\":\"%016llx\","
    "\"variant\":\"%016llx\",\"generation\":%lu,\"frame\":%lu,"
    "\"gfx\":{\"commands\":%lu,\"vertices\":%lu,\"droppedVertices\":%lu},"
    "\"net\":{\"connected\":%s,\"rxBytes\":%llu,\"txBytes\":%llu,"
    "\"connects\":%lu,\"authFailures\":%lu,\"timeouts\":%lu,"
    "\"discoveries\":%lu,\"uploads\":%lu,\"screenshots\":%lu}}",
    POCKETJS_TARGET_ID,
    (unsigned)POCKETJS_HOST_ABI,
    (unsigned long long)running_hash,
    (unsigned long long)variant_hash,
    (unsigned long)runtime_state.generation,
    (unsigned long)runtime_frame,
    (unsigned long)frame_commands,
    (unsigned long)frame_vertices,
    (unsigned long)frame_dropped_vertices,
    devtransport_connected() ? "true" : "false",
    (unsigned long long)rx_bytes,
    (unsigned long long)tx_bytes,
    (unsigned long)connects,
    (unsigned long)auth_failures,
    (unsigned long)timeouts,
    (unsigned long)discoveries,
    (unsigned long)uploads,
    (unsigned long)screenshots
  );
  return stats_json;
}

static void accept_client(void) {
  if (client_fd >= 0 || server_fd < 0) return;
  int fd = accept(server_fd, NULL, NULL);
  if (fd < 0) return;
  if (!set_nonblocking(fd)) {
    close(fd);
    return;
  }
  client_fd = fd;
  authenticated = false;
  handshake_pending = false;
  handshake_accepted = false;
  handshake_ack_offset = 0;
  rx_length = 0;
  ctrl_input_length = 0;
  tx_length = 0;
  tx_offset = 0;
  install_read = install_write = 0;
  pong_pending = false;
  client_last_rx_ms = osGetTime();
}

static void poll_discovery(void) {
  if (discovery_fd < 0) return;
  for (uint32_t attempt = 0; attempt < 4; attempt += 1) {
    uint8_t request[POCKET_RUNTIME_DISCOVERY_REQUEST_BYTES];
    struct sockaddr_in sender;
    socklen_t sender_length = sizeof sender;
    ssize_t length = recvfrom(
      discovery_fd,
      request,
      sizeof request,
      0,
      (struct sockaddr *)&sender,
      &sender_length
    );
    if (length < 0 && would_block()) return;
    if (length <= 0) return;
    if (!pocket_runtime_is_discovery_request(request, (size_t)length)) continue;

    uint8_t reply[POCKET_RUNTIME_DISCOVERY_REPLY_BYTES];
    pocket_runtime_encode_discovery_reply(
      reply,
      POCKETJS_HOST_ABI,
      POCKET_RUNTIME_WIRE_PORT,
      devtransport_connected() ? 1u : 0u,
      runtime_state.generation,
      runtime_state.active_hash,
      device_id,
      POCKETJS_TARGET_ID,
      "PocketJS 3DS"
    );
    if (sendto(
          discovery_fd,
          reply,
          sizeof reply,
          0,
          (struct sockaddr *)&sender,
          sender_length
        ) == (ssize_t)sizeof reply) {
      discoveries += 1;
    }
  }
}

static bool append_ctrl_input(const uint8_t *bytes, size_t length) {
  if (length == 0 || length + 1 > sizeof ctrl_input - ctrl_input_length) return false;
  memcpy(ctrl_input + ctrl_input_length, bytes, length);
  ctrl_input_length += length;
  ctrl_input[ctrl_input_length++] = '\n';
  return true;
}

static void abort_upload(const char *message) {
  uint64_t rejected = upload_hash;
  close_upload();
  upload_ready = false;
  upload_discarding = false;
  devtransport_report_install("transfer-error", rejected, message);
}

static void handle_package_begin(const uint8_t *payload, size_t length) {
  PocketRuntimePackageBegin begin;
  if (!pocket_runtime_parse_package_begin(payload, length, &begin)) {
    abort_upload("invalid package begin frame");
    return;
  }
  if (upload_file) { abort_upload("another begin interrupted the transfer"); return; }
  if (upload_busy || upload_ready || begin.length > POCKET_RUNTIME_UPDATE_MAX_BYTES) {
    upload_discarding = true;
    devtransport_report_install("rejected", begin.footer_hash,
      upload_busy || upload_ready ? "another update is awaiting acceptance" : "update exceeds native memory budget");
    return;
  }
  close_upload();
  upload_discarding = false;
  upload_ready = false;
  upload_file = fopen(POCKET_RUNTIME_UPLOAD, "wb");
  if (upload_file == NULL) {
    devtransport_report_install("transfer-error", begin.footer_hash, "open network staging file failed");
    return;
  }
  upload_expected = begin.length;
  upload_received = 0;
  upload_hash = begin.footer_hash;
  devtransport_report_install("receiving", upload_hash, "binary package transfer started");
}

static void handle_package_chunk(const uint8_t *payload, size_t length) {
  if (upload_discarding) return;
  if (upload_file == NULL || length <= 4) {
    abort_upload("package chunk arrived without an active transfer");
    return;
  }
  uint32_t offset = pocket_runtime_read_u32(payload);
  size_t bytes = length - 4;
  if (upload_received > upload_expected || offset != upload_received ||
      bytes > upload_expected - upload_received ||
      fwrite(payload + 4, 1, bytes, upload_file) != bytes) {
    abort_upload("package chunk offset, length, or SD write failed");
    return;
  }
  upload_received += (uint32_t)bytes;
}

static void handle_package_commit(void) {
  if (upload_discarding) { upload_discarding = false; return; }
  if (upload_file == NULL || upload_received != upload_expected) {
    abort_upload("package commit arrived before every declared byte");
    return;
  }
  bool written = fflush(upload_file) == 0 && fsync(fileno(upload_file)) == 0;
  if (fclose(upload_file) != 0) written = false;
  upload_file = NULL;
  if (!written) {
    abort_upload("flush network package staging file failed");
    return;
  }
  upload_ready = true;
  uploads += 1;
  devtransport_report_install("received", upload_hash, "binary package transfer complete");
}

static void handle_frame(uint8_t type, uint8_t flags, const uint8_t *payload, size_t length) {
  if (flags != 0) {
    disconnect_client();
    return;
  }
  switch (type) {
    case POCKET_RUNTIME_MSG_PING:
      if (length == sizeof pong_payload) {
        memcpy(pong_payload, payload, sizeof pong_payload);
        pong_pending = true;
      }
      break;
    case POCKET_RUNTIME_MSG_CTRL:
      if (length <= POCKET_RUNTIME_MAX_CTRL_BYTES &&
          memchr(payload, '\n', length) == NULL &&
          memchr(payload, '\r', length) == NULL &&
          append_ctrl_input(payload, length)) break;
      disconnect_client();
      break;
    case POCKET_RUNTIME_MSG_PACKAGE_BEGIN:
      handle_package_begin(payload, length);
      break;
    case POCKET_RUNTIME_MSG_PACKAGE_CHUNK:
      handle_package_chunk(payload, length);
      break;
    case POCKET_RUNTIME_MSG_PACKAGE_COMMIT:
      if (length == 0) handle_package_commit();
      else abort_upload("package commit payload must be empty");
      break;
    case POCKET_RUNTIME_MSG_PACKAGE_ABORT:
      if (upload_discarding) { upload_discarding = false; break; }
      abort_upload("host aborted package transfer");
      break;
    case POCKET_RUNTIME_MSG_STATUS_REQUEST:
      if (length == 0) send_status();
      break;
    default:
      /* Unknown length-framed messages are skipped for forward compatibility. */
      break;
  }
}

static void receive_client(void) {
  if (client_fd < 0) return;
  if (handshake_pending || upload_ready) return;
  while (rx_length < sizeof rx_buffer) {
    ssize_t read = recv(client_fd, rx_buffer + rx_length, sizeof rx_buffer - rx_length, 0);
    if (read > 0) {
      rx_length += (size_t)read;
      rx_bytes += (uint64_t)read;
      client_last_rx_ms = osGetTime();
      continue;
    }
    if (read == 0) {
      disconnect_client();
      return;
    }
    if (would_block()) break;
    disconnect_client();
    return;
  }

  if (!authenticated) {
    if (rx_length < POCKET_RUNTIME_HELLO_BYTES) return;
    bool accepted = pocket_runtime_verify_hello(
      rx_buffer,
      POCKET_RUNTIME_HELLO_BYTES,
      pairing_token
    );
    pocket_runtime_encode_ack(
      handshake_ack,
      accepted ? 0 : 2,
      POCKETJS_HOST_ABI,
      runtime_state.generation,
      initialized ? 1u : 0u,
      runtime_state.active_hash
    );
    memmove(rx_buffer, rx_buffer + POCKET_RUNTIME_HELLO_BYTES, rx_length - POCKET_RUNTIME_HELLO_BYTES);
    rx_length -= POCKET_RUNTIME_HELLO_BYTES;
    handshake_pending = true;
    handshake_accepted = accepted;
    handshake_ack_offset = 0;
    if (!accepted) auth_failures += 1;
    return;
  }

  while (authenticated && rx_length >= POCKET_RUNTIME_FRAME_HEADER_BYTES) {
    PocketRuntimeFrameHeader header;
    if (!pocket_runtime_parse_frame_header(rx_buffer, rx_length, &header)) {
      disconnect_client();
      return;
    }
    size_t total = POCKET_RUNTIME_FRAME_HEADER_BYTES + (size_t)header.length;
    if (rx_length < total) break;
    handle_frame(
      header.type,
      header.flags,
      rx_buffer + POCKET_RUNTIME_FRAME_HEADER_BYTES,
      header.length
    );
    if (client_fd < 0) return;
    memmove(rx_buffer, rx_buffer + total, rx_length - total);
    rx_length -= total;
    if (upload_ready) break; /* Hand the completed file to admission before reading another transfer. */
  }
  if (rx_length == sizeof rx_buffer) disconnect_client();
}

static void queue_screenshot_frame(void) {
  if (!screenshot_ready || tx_length != tx_offset) return;
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
    if (queue_frame(POCKET_RUNTIME_MSG_SCREENSHOT_BEGIN, 0, begin, sizeof begin)) {
      screenshot_stage = 1;
    }
    return;
  }
  if (screenshot_stage == 1) {
    uint8_t *surface = screenshot_surface == 0 ? screenshot_top : screenshot_auxiliary;
    uint32_t bytes = screenshot_surface == 0 ? screenshot_top_bytes : screenshot_auxiliary_bytes;
    if (screenshot_offset < bytes) {
      uint32_t amount = bytes - screenshot_offset;
      if (amount > SCREENSHOT_CHUNK_BYTES) amount = SCREENSHOT_CHUNK_BYTES;
      /* Worker stack is 32 KiB. This bounded scratch buffer is worker-owned. */
      static uint8_t payload[4 + SCREENSHOT_CHUNK_BYTES];
      pocket_runtime_write_u32(payload, screenshot_offset);
      memcpy(payload + 4, surface + screenshot_offset, amount);
      if (queue_frame(
            POCKET_RUNTIME_MSG_SCREENSHOT_CHUNK,
            screenshot_surface,
            payload,
            4 + amount
          )) {
        screenshot_offset += amount;
      }
      return;
    }
    if (screenshot_surface == 0) {
      screenshot_surface = 1;
      screenshot_offset = 0;
      return;
    }
    screenshot_stage = 2;
  }
  if (screenshot_stage == 2) {
    uint8_t end[4];
    pocket_runtime_write_u32(end, screenshot_frame);
    if (queue_frame(POCKET_RUNTIME_MSG_SCREENSHOT_END, 0, end, sizeof end)) {
      screenshot_stage = 3;
    }
    return;
  }
  if (screenshot_stage == 3) {
    screenshots += 1;
    devtransport_screenshot_cancel();
  }
}

static void send_client(void) {
  if (client_fd < 0) return;
  if (handshake_pending) {
    ssize_t sent = send(
      client_fd,
      handshake_ack + handshake_ack_offset,
      sizeof handshake_ack - handshake_ack_offset,
      0
    );
    if (sent > 0) {
      handshake_ack_offset += (size_t)sent;
      tx_bytes += (uint64_t)sent;
      if (handshake_ack_offset == sizeof handshake_ack) {
        bool accepted = handshake_accepted;
        handshake_pending = false;
        handshake_ack_offset = 0;
        if (!accepted) {
          disconnect_client();
          return;
        }
        authenticated = true;
        connects += 1;
        if (hello_cache_length > 0) {
          queue_frame(
            POCKET_RUNTIME_MSG_CTRL,
            0,
            (const uint8_t *)hello_cache,
            hello_cache_length
          );
        }
        send_status();
      }
      return;
    }
    if (sent < 0 && would_block()) return;
    disconnect_client();
    return;
  }
  if (!devtransport_connected()) return;
  if (pong_pending && tx_length == tx_offset &&
      queue_frame(POCKET_RUNTIME_MSG_PONG, 0, pong_payload, sizeof pong_payload)) {
    pong_pending = false;
  }
  queue_screenshot_frame();
  if (tx_offset >= tx_length) return;
  ssize_t sent = send(client_fd, tx_buffer + tx_offset, tx_length - tx_offset, 0);
  if (sent > 0) {
    tx_offset += (size_t)sent;
    tx_bytes += (uint64_t)sent;
    if (tx_offset == tx_length) {
      tx_offset = 0;
      tx_length = 0;
    }
    return;
  }
  if (sent < 0 && would_block()) return;
  disconnect_client();
}

void devtransport_poll(void) {
  if (!initialized) return;
  poll_discovery();
  accept_client();
  receive_client();
  if (client_fd >= 0 && osGetTime() - client_last_rx_ms > 15u * 1000u) {
    timeouts += 1;
    disconnect_client();
    return;
  }
  if (install_read != install_write && devtransport_connected()) {
    const char *line = install_lines[install_read % 8];
    if (queue_frame(POCKET_RUNTIME_MSG_CTRL, 0, (const uint8_t *)line, strlen(line))) install_read += 1;
  }
  send_client();
}

size_t devtransport_recv_ctrl(char *out, size_t capacity) {
  if (out == NULL || capacity <= 1 || ctrl_input_length == 0) return 0;
  size_t length = ctrl_input_length < capacity - 1 ? ctrl_input_length : capacity - 1;
  /* Every accepted control frame has a synthetic newline. Never hand QuickJS
   * a partial JSON record when several queued frames approach its poll cap. */
  while (length > 0 && ctrl_input[length - 1] != '\n') length -= 1;
  if (length == 0) return 0;
  memcpy(out, ctrl_input, length);
  out[length] = '\0';
  memmove(ctrl_input, ctrl_input + length, ctrl_input_length - length);
  ctrl_input_length -= length;
  return length;
}

bool devtransport_take_upload(uint64_t *declared_hash) {
  if (!upload_ready) return false;
  upload_ready = false;
  if (declared_hash != NULL) *declared_hash = upload_hash;
  upload_expected = 0;
  upload_received = 0;
  upload_hash = 0;
  return true;
}

bool devtransport_request_screenshot(void) {
  if (!devtransport_connected() || screenshot_requested || screenshot_ready) return false;
  screenshot_requested = true;
  return true;
}

bool devtransport_take_screenshot_request(void) {
  if (!screenshot_requested) return false;
  screenshot_requested = false;
  return true;
}

void devtransport_screenshot_ready(void) {
  if (screenshot_top == NULL || screenshot_auxiliary == NULL) return;
  screenshot_ready = true;
  screenshot_stage = 0;
  screenshot_surface = 0;
  screenshot_offset = 0;
}
