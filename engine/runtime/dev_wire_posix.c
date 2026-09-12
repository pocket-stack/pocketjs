/* Non-blocking BSD socket pump for the shared Pocket Runtime server. No
 * device SDK symbols: the same file serves UIKit shells and host tests. */
#include "dev_wire_posix.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif
#define IO_BUDGET (64u * 1024u)

static int listener = -1;
static int discovery = -1;
static int peer = -1;
static int configured;
static int suspended;
static char key_path[POCKET_DEV_PATH_BYTES];
static char upload_path[POCKET_DEV_PATH_BYTES];
static uint16_t listen_port;
static uint64_t next_listen;

uint64_t pocket_devwire_now_ms(void) {
  struct timeval time;
  gettimeofday(&time, NULL);
  return (uint64_t)time.tv_sec * 1000u + (uint64_t)time.tv_usec / 1000u;
}

static int nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

static int again(void) {
  return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR;
}

static void close_peer(void) {
  if (peer >= 0) close(peer);
  peer = -1;
  pocket_devserver_client_close();
}

static void close_listeners(void) {
  close_peer();
  if (listener >= 0) close(listener);
  if (discovery >= 0) close(discovery);
  listener = -1;
  discovery = -1;
}

static void listen_if_paired(void) {
  uint64_t now = pocket_devwire_now_ms();
  if (listener >= 0 || now < next_listen || !configured || suspended) return;
  next_listen = now + 1000;
  if (pocket_devserver_load_key(key_path, NULL, 0) != POCKET_DEV_SERVER_KEY_READY) return;
  struct sockaddr_in address;
  memset(&address, 0, sizeof address);
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_ANY);
  address.sin_port = htons(listen_port);
  listener = socket(AF_INET, SOCK_STREAM, 0);
  if (listener < 0) return;
  int yes = 1;
  setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);
  if (!nonblocking(listener) ||
      bind(listener, (struct sockaddr *)&address, sizeof address) != 0 ||
      listen(listener, 1) != 0) {
    close_listeners();
    return;
  }
  discovery = socket(AF_INET, SOCK_DGRAM, 0);
  if (discovery >= 0) {
    setsockopt(discovery, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);
    if (!nonblocking(discovery) || bind(discovery, (struct sockaddr *)&address, sizeof address) != 0) {
      close(discovery);
      discovery = -1;
    }
  }
}

int pocket_devwire_init(const PocketDevWireOptions *options) {
  pocket_devwire_shutdown();
  if (options == NULL || options->root == NULL || options->root[0] == '\0') return 0;
  if (snprintf(key_path, sizeof key_path, "%s/dev.key", options->root) >= (int)sizeof key_path ||
      snprintf(upload_path, sizeof upload_path, "%s/upload.tmp", options->root) >= (int)sizeof upload_path) {
    return 0;
  }
  PocketDevServerConfig config;
  memset(&config, 0, sizeof config);
  config.target = options->target;
  config.label = options->label;
  config.host_abi = options->host_abi;
  config.port = options->port;
  config.upload_path = upload_path;
  config.now_ms = pocket_devwire_now_ms;
  config.status = options->status;
  if (!pocket_devserver_configure(&config)) return 0;
  listen_port = options->port;
  configured = 1;
  next_listen = 0;
  return 1;
}

void pocket_devwire_suspend(int value) {
  suspended = value ? 1 : 0;
  if (suspended) close_listeners();
  next_listen = 0;
}

void pocket_devwire_shutdown(void) {
  close_listeners();
  pocket_devserver_shutdown();
  configured = 0;
  suspended = 0;
}

const char *pocket_devwire_state_name(void) {
  if (suspended) return "suspended";
  if (pocket_devserver_connected()) return "connected";
  if (listener >= 0) return "listening";
  return "unpaired-or-unavailable";
}

static void pump_discovery(void) {
  if (discovery < 0) return;
  for (int attempt = 0; attempt < 4; attempt += 1) {
    uint8_t request[64];
    uint8_t reply[POCKET_RUNTIME_DISCOVERY_REPLY_BYTES];
    struct sockaddr_in source;
    socklen_t size = sizeof source;
    ssize_t length = recvfrom(discovery, request, sizeof request, 0, (struct sockaddr *)&source, &size);
    if (length < 0) break;
    if (!pocket_devserver_discovery(request, (size_t)length, reply)) continue;
    sendto(discovery, reply, sizeof reply, MSG_NOSIGNAL, (struct sockaddr *)&source, size);
  }
}

static void accept_peer(void) {
  peer = accept(listener, NULL, NULL);
  if (peer < 0) return;
  int yes = 1;
  setsockopt(peer, IPPROTO_TCP, TCP_NODELAY, &yes, sizeof yes);
#ifdef SO_NOSIGPIPE
  if (setsockopt(peer, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof yes) != 0) {
    close(peer);
    peer = -1;
    return;
  }
#endif
  if (!nonblocking(peer)) {
    close(peer);
    peer = -1;
    return;
  }
  pocket_devserver_client_open();
}

static void pump_rx(void) {
  size_t budget = IO_BUDGET;
  while (peer >= 0 && budget > 0 && !pocket_devserver_upload_pending()) {
    uint8_t *room = NULL;
    size_t capacity = pocket_devserver_rx_room(&room);
    if (capacity == 0) {
      close_peer();
      return;
    }
    if (capacity > budget) capacity = budget;
    ssize_t count = recv(peer, room, capacity, 0);
    if (count > 0) {
      budget -= (size_t)count;
      if (!pocket_devserver_rx_commit((size_t)count)) close_peer();
      continue;
    }
    if (count == 0 || !again()) close_peer();
    return;
  }
}

static void pump_tx(void) {
  const uint8_t *bytes = NULL;
  size_t length = pocket_devserver_tx_pending(&bytes);
  if (peer < 0 || length == 0) return;
  if (length > IO_BUDGET) length = IO_BUDGET;
  ssize_t count = send(peer, bytes, length, MSG_NOSIGNAL);
  if (count > 0) pocket_devserver_tx_consumed((size_t)count);
  else if (count == 0 || !again()) close_peer();
}

void pocket_devwire_pump(void) {
  if (suspended || !configured) return;
  listen_if_paired();
  if (listener < 0) return;
  pump_discovery();
  if (peer < 0) accept_peer();
  if (peer < 0) return;
  pump_rx();
  if (peer < 0) return;
  pump_tx();
  if (peer < 0) return;
  if (pocket_devserver_client_closing()) close_peer();
}
