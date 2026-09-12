/*
 * libctru socket pump for the shared Pocket Runtime server
 * (engine/runtime/dev_server.c).
 *
 * The main/render thread owns this bounded non-blocking pump. Everything the
 * wire means — pairing, handshake, frame dispatch, control records, uploads,
 * screenshot streaming, timeouts — is decided by the shared server; this file
 * supplies SOC ownership, the sockets, the ARM11 clock, linear-memory
 * screenshot buffers and the 3DS status and counter records.
 */

#include "devserver.h"

#include <3ds.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include "dev_server.h"
#include "soc.h"

#ifndef POCKETJS_HOST_ABI
#error "POCKETJS_HOST_ABI must come from the verified ResolvedBuildPlan"
#endif
#ifndef POCKETJS_TARGET_ID
#error "POCKETJS_TARGET_ID must come from the verified ResolvedBuildPlan"
#endif
/* Host tests bind an ephemeral port; the console keeps the published one. */
#ifndef POCKETJS_DEV_PORT
#define POCKETJS_DEV_PORT POCKET_RUNTIME_WIRE_PORT
#endif

#define IO_BUDGET (64u * 1024u)

static int server_fd = -1;
static int discovery_fd = -1;
static int client_fd = -1;
static bool initialized;

static PocketRuntimeState runtime_state;
static uint64_t running_hash;
static uint64_t variant_hash;
static uint32_t runtime_frame;
static char runtime_phase[32] = "starting";
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

static bool set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

static void format_ip(char out[16]) {
  uint32_t ip = initialized ? (uint32_t)gethostid() : 0;
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

static uint64_t clock_ms(void) {
  return osGetTime();
}

static void *screenshot_alloc(size_t bytes) {
  return linearAlloc(bytes);
}

static void screenshot_free(void *bytes) {
  linearFree(bytes);
}

static void write_status(char *out, size_t capacity) {
  char ip[16];
  format_ip(ip);
  snprintf(
    out,
    capacity,
    "{\"t\":\"runtime.status\",\"phase\":\"%s\",\"target\":\"%s\",\"hostAbi\":%u,"
    "\"ip\":\"%s\",\"port\":%u,\"generation\":%lu,"
    "\"active\":\"%016llx\",\"lastGood\":\"%016llx\",\"running\":\"%016llx\","
    "\"frame\":%lu}",
    runtime_phase,
    POCKETJS_TARGET_ID,
    (unsigned)POCKETJS_HOST_ABI,
    ip,
    (unsigned)POCKETJS_DEV_PORT,
    (unsigned long)runtime_state.generation,
    (unsigned long long)runtime_state.active_hash,
    (unsigned long long)runtime_state.last_good_hash,
    (unsigned long long)running_hash,
    (unsigned long)runtime_frame
  );
}

static const PocketDevServerConfig CONFIG = {
  POCKETJS_TARGET_ID,
  "PocketJS 3DS",
  POCKETJS_HOST_ABI,
  POCKETJS_DEV_PORT,
  POCKET_RUNTIME_UPLOAD,
  clock_ms,
  write_status,
  screenshot_alloc,
  screenshot_free,
};

static void close_client(void) {
  if (client_fd >= 0) close(client_fd);
  client_fd = -1;
  pocket_devserver_client_close();
}

DevserverInitResult devserver_init(
  const PocketRuntimeState *state,
  char *error,
  size_t error_length
) {
  if (initialized) return DEVSERVER_READY;
  if (state != NULL) runtime_state = *state;
  if (!pocket_devserver_configure(&CONFIG)) {
    set_error(error, error_length, "Pocket Runtime server configuration is incomplete");
    return DEVSERVER_ERROR;
  }
  int key = pocket_devserver_load_key(POCKET_RUNTIME_DEV_KEY, error, error_length);
  if (key == POCKET_DEV_SERVER_KEY_DISABLED) return DEVSERVER_DISABLED;
  if (key != POCKET_DEV_SERVER_KEY_READY) return DEVSERVER_ERROR;

  if (!soc_ensure(error, error_length)) return DEVSERVER_ERROR;

  server_fd = socket(AF_INET, SOCK_STREAM, 0);
  if (server_fd < 0) {
    set_error(error, error_length, "Pocket Runtime socket failed (%d)", errno);
    devserver_shutdown();
    return DEVSERVER_ERROR;
  }
  int reuse = 1;
  setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof reuse);
  struct sockaddr_in address;
  memset(&address, 0, sizeof address);
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = INADDR_ANY;
  address.sin_port = htons(POCKETJS_DEV_PORT);
  if (bind(server_fd, (struct sockaddr *)&address, sizeof address) != 0 ||
      listen(server_fd, 1) != 0 || !set_nonblocking(server_fd)) {
    set_error(error, error_length, "Pocket Runtime listen on %u failed (%d)", (unsigned)POCKETJS_DEV_PORT, errno);
    devserver_shutdown();
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
  pocket_devserver_set_state(runtime_state.generation, runtime_state.active_hash);
  initialized = true;
  return DEVSERVER_READY;
}

void devserver_shutdown(void) {
  close_client();
  if (server_fd >= 0) close(server_fd);
  server_fd = -1;
  if (discovery_fd >= 0) close(discovery_fd);
  discovery_fd = -1;
  pocket_devserver_shutdown();
  /* SOC itself is shared with the svc transport; main owns soc_shutdown. */
  initialized = false;
}

bool devserver_active(void) {
  return initialized;
}

bool devserver_connected(void) {
  return client_fd >= 0 && pocket_devserver_connected();
}

void devserver_allow_packages(bool allowed) {
  pocket_devserver_allow_packages(allowed);
}

void devserver_snapshot(DevserverSnapshot *out) {
  if (out == NULL) return;
  PocketDevServerCounters counters;
  pocket_devserver_counters(&counters);
  memset(out, 0, sizeof *out);
  out->enabled = initialized;
  out->discoverable = discovery_fd >= 0;
  out->connected = devserver_connected();
  format_ip(out->ip);
  snprintf(out->phase, sizeof out->phase, "%s", runtime_phase);
  out->port = POCKETJS_DEV_PORT;
  out->host_abi = POCKETJS_HOST_ABI;
  out->generation = runtime_state.generation;
  out->running_hash = running_hash;
  out->device_id = pocket_devserver_device_id();
  out->connects = counters.connects;
  out->auth_failures = counters.auth_failures;
  out->timeouts = counters.timeouts;
  out->uploads = counters.uploads;
  out->screenshots = counters.screenshots;
}

void devserver_send_ctrl(const char *line, size_t length) {
  pocket_devserver_send_ctrl(line, length);
}

size_t devserver_recv_ctrl(char *out, size_t capacity) {
  return pocket_devserver_recv_ctrl(out, capacity);
}

void devserver_report_install(const char *phase, uint64_t hash, const char *message) {
  pocket_devserver_report_install(phase, hash, message);
}

void devserver_report_log(const char *level, const char *message) {
  pocket_devserver_report_log(level, message);
}

void devserver_set_runtime(
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
  pocket_devserver_set_state(runtime_state.generation, runtime_state.active_hash);
}

void devserver_set_frame_stats(
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

const char *devserver_debug_stats(void) {
  PocketDevServerCounters counters;
  pocket_devserver_counters(&counters);
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
    devserver_connected() ? "true" : "false",
    (unsigned long long)counters.rx_bytes,
    (unsigned long long)counters.tx_bytes,
    (unsigned long)counters.connects,
    (unsigned long)counters.auth_failures,
    (unsigned long)counters.timeouts,
    (unsigned long)counters.discoveries,
    (unsigned long)counters.uploads,
    (unsigned long)counters.screenshots
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
  pocket_devserver_client_open();
}

static void poll_discovery(void) {
  if (discovery_fd < 0) return;
  for (uint32_t attempt = 0; attempt < 4; attempt += 1) {
    uint8_t request[POCKET_RUNTIME_DISCOVERY_REQUEST_BYTES];
    uint8_t reply[POCKET_RUNTIME_DISCOVERY_REPLY_BYTES];
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
    if (length <= 0) return;
    if (!pocket_devserver_discovery(request, (size_t)length, reply)) continue;
    sendto(discovery_fd, reply, sizeof reply, 0, (struct sockaddr *)&sender, sender_length);
  }
}

static void receive_client(void) {
  size_t budget = IO_BUDGET;
  while (client_fd >= 0 && budget > 0 && !pocket_devserver_upload_pending()) {
    uint8_t *room = NULL;
    size_t capacity = pocket_devserver_rx_room(&room);
    if (capacity == 0) {
      close_client();
      return;
    }
    if (capacity > budget) capacity = budget;
    ssize_t read = recv(client_fd, room, capacity, 0);
    if (read > 0) {
      budget -= (size_t)read;
      if (!pocket_devserver_rx_commit((size_t)read)) close_client();
      continue;
    }
    if (read == 0 || !would_block()) close_client();
    return;
  }
}

static void send_client(void) {
  const uint8_t *bytes = NULL;
  size_t length = pocket_devserver_tx_pending(&bytes);
  if (client_fd < 0 || length == 0) return;
  if (length > IO_BUDGET) length = IO_BUDGET;
  ssize_t sent = send(client_fd, bytes, length, 0);
  if (sent > 0) {
    pocket_devserver_tx_consumed((size_t)sent);
    return;
  }
  if (sent < 0 && would_block()) return;
  close_client();
}

void devserver_poll(void) {
  if (!initialized) return;
  poll_discovery();
  accept_client();
  receive_client();
  send_client();
  if (client_fd >= 0 && pocket_devserver_client_closing()) close_client();
}

bool devserver_take_upload(uint64_t *declared_hash) {
  return pocket_devserver_take_upload(declared_hash);
}

bool devserver_request_screenshot(void) {
  return pocket_devserver_request_screenshot();
}

bool devserver_take_screenshot_request(void) {
  return pocket_devserver_take_screenshot_request();
}

bool devserver_screenshot_begin(
  uint32_t frame,
  uint16_t top_width,
  uint16_t top_height,
  uint16_t auxiliary_width,
  uint16_t auxiliary_height,
  uint8_t **top,
  uint8_t **auxiliary
) {
  return pocket_devserver_screenshot_begin(
    frame,
    top_width,
    top_height,
    auxiliary_width,
    auxiliary_height,
    top,
    auxiliary
  );
}

void devserver_screenshot_ready(void) {
  pocket_devserver_screenshot_ready();
}

void devserver_screenshot_cancel(void) {
  pocket_devserver_screenshot_cancel();
}
