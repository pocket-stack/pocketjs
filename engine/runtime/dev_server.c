/* Pocket Runtime wire v1 over non-blocking BSD sockets (UIKit and host tests).
 * Uses the same codec and desktop client as the 3DS. No device SDK symbols. */
#include "dev_server.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif
#define RX_CAP (POCKET_RUNTIME_MAX_FRAME_BYTES + POCKET_RUNTIME_FRAME_HEADER_BYTES)
#define TX_CAP (2u * RX_CAP)
#define CTRL_CAP (32u * 1024u)
#define IO_BUDGET (64u * 1024u)

static int listener = -1, discovery = -1, peer = -1;
static int authenticated, suspended, configured, upload_ready;
static uint8_t token[32], rx[RX_CAP], tx[TX_CAP];
static char controls[CTRL_CAP], hello[1024];
static size_t rx_len, tx_len, tx_off, controls_len, hello_len;
static char key_path[POCKET_DEV_PATH_BYTES], upload_path[POCKET_DEV_PATH_BYTES];
static char target_id[16];
static uint16_t host_abi, listen_port;
static uint32_t generation, upload_expected, upload_received;
static uint64_t active_hash, device_id, last_rx, next_listen, upload_hash;
static FILE *upload;
static void (*write_status)(char *, size_t);

uint64_t pocket_devwire_now_ms(void) {
  struct timeval time;
  gettimeofday(&time, NULL);
  return (uint64_t)time.tv_sec * 1000u + (uint64_t)time.tv_usec / 1000u;
}

static int nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}
static int again(void) { return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR; }
static void abort_upload(void) {
  if (upload) fclose(upload);
  upload = NULL;
  upload_expected = upload_received = 0;
  upload_hash = 0;
  upload_ready = 0;
  if (upload_path[0]) remove(upload_path);
}
static void disconnect(void) {
  if (peer >= 0) close(peer);
  peer = -1;
  authenticated = 0;
  rx_len = tx_len = tx_off = controls_len = 0;
  abort_upload();
}
static void close_listeners(void) {
  disconnect();
  if (listener >= 0) close(listener);
  if (discovery >= 0) close(discovery);
  listener = discovery = -1;
}

static int queue(uint8_t type, const void *bytes, size_t length, int critical) {
  if (peer < 0 || length > POCKET_RUNTIME_MAX_FRAME_BYTES) return 0;
  if (tx_off) {
    memmove(tx, tx + tx_off, tx_len - tx_off);
    tx_len -= tx_off;
    tx_off = 0;
  }
  size_t required = POCKET_RUNTIME_FRAME_HEADER_BYTES + length;
  size_t reserve = critical ? 0 : 4096;
  if (required + reserve > sizeof tx - tx_len) {
    if (critical) disconnect();
    return 0;
  }
  pocket_runtime_encode_frame_header(tx + tx_len, type, 0, (uint32_t)length);
  if (length) memcpy(tx + tx_len + POCKET_RUNTIME_FRAME_HEADER_BYTES, bytes, length);
  tx_len += required;
  return 1;
}
static void escape(char *out, size_t cap, const char *in) {
  size_t length = 0;
  for (; *in && length + 7 < cap; ++in) {
    unsigned char c = (unsigned char)*in;
    if (c == '"' || c == '\\') { out[length++] = '\\'; out[length++] = (char)c; }
    else if (c < 32) { length += (size_t)snprintf(out + length, cap - length, "\\u%04x", c); }
    else out[length++] = (char)c;
  }
  out[length] = 0;
}
void pocket_devwire_report(const char *phase, uint64_t hash, const char *message) {
  char escaped[1024], line[1280];
  escape(escaped, sizeof escaped, message ? message : "");
  int length = snprintf(line, sizeof line,
    "{\"t\":\"runtime.install\",\"phase\":\"%s\",\"hash\":\"%016llx\",\"generation\":%u,\"message\":\"%s\"}",
    phase, (unsigned long long)hash, generation, escaped);
  if (authenticated && length > 0 && (size_t)length < sizeof line)
    queue(POCKET_RUNTIME_MSG_CTRL, line, (size_t)length, 1);
}
void pocket_devwire_log(const char *level, const char *message) {
  char escaped[1024], line[1152];
  escape(escaped, sizeof escaped, message ? message : "");
  int length = snprintf(line, sizeof line, "{\"t\":\"log\",\"level\":\"%s\",\"args\":[\"%s\"]}", level, escaped);
  if (authenticated && length > 0 && (size_t)length < sizeof line)
    queue(POCKET_RUNTIME_MSG_CTRL, line, (size_t)length, 0);
}
void pocket_devwire_send(const char *text, size_t length) {
  if (!text || !length || length > POCKET_RUNTIME_MAX_FRAME_BYTES) return;
  static const char marker[] = "\"t\":\"hello\"";
  int is_hello = 0;
  for (size_t i = 0; i + sizeof marker - 1 <= length && !is_hello; ++i)
    is_hello = memcmp(text + i, marker, sizeof marker - 1) == 0;
  if (length < sizeof hello && is_hello) {
    memcpy(hello, text, length);
    hello[length] = 0;
    hello_len = length;
  }
  if (authenticated) queue(POCKET_RUNTIME_MSG_CTRL, text, length, 0);
}
size_t pocket_devwire_poll(char *out, size_t capacity) {
  size_t length = controls_len < capacity ? controls_len : capacity;
  while (length && controls[length - 1] != '\n') --length;
  if (length) {
    memcpy(out, controls, length);
    memmove(controls, controls + length, controls_len - length);
    controls_len -= length;
  }
  return length;
}
void pocket_devwire_reset_guest(void) { controls_len = hello_len = 0; hello[0] = 0; }
static void status(void) {
  char text[2048];
  if (!write_status) return;
  write_status(text, sizeof text);
  queue(POCKET_RUNTIME_MSG_CTRL, text, strlen(text), 1);
}

static int hex(int c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
static int load_key(void) {
  char text[66];
  FILE *file = fopen(key_path, "rb");
  if (!file) return 0;
  size_t length = fread(text, 1, sizeof text, file);
  fclose(file);
  if (length != 64 && !(length == 65 && text[64] == '\n')) return 0;
  for (size_t i = 0; i < sizeof token; ++i) {
    int high = hex(text[2 * i]), low = hex(text[2 * i + 1]);
    if (high < 0 || low < 0) return 0;
    token[i] = (uint8_t)((high << 4) | low);
  }
  device_id = pocket_runtime_device_id(token);
  return 1;
}
static void listen_if_paired(void) {
  uint64_t now = pocket_devwire_now_ms();
  if (listener >= 0 || now < next_listen || !configured || suspended) return;
  next_listen = now + 1000;
  if (!load_key()) return;
  struct sockaddr_in address;
  memset(&address, 0, sizeof address);
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_ANY);
  address.sin_port = htons(listen_port);
  listener = socket(AF_INET, SOCK_STREAM, 0);
  if (listener < 0) return;
  int yes = 1;
  setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);
  if (!nonblocking(listener) || bind(listener, (struct sockaddr *)&address, sizeof address) || listen(listener, 1)) {
    close_listeners();
    return;
  }
  discovery = socket(AF_INET, SOCK_DGRAM, 0);
  if (discovery >= 0) {
    setsockopt(discovery, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);
    if (!nonblocking(discovery) || bind(discovery, (struct sockaddr *)&address, sizeof address)) {
      close(discovery);
      discovery = -1;
    }
  }
}
int pocket_devwire_init(const char *root, const char *target, uint16_t abi,
  uint16_t port, void (*status_callback)(char *, size_t)) {
  pocket_devwire_shutdown();
  if (!root || !target || strlen(target) >= sizeof target_id || !port) return 0;
  if (snprintf(key_path, sizeof key_path, "%s/dev.key", root) >= (int)sizeof key_path ||
      snprintf(upload_path, sizeof upload_path, "%s/upload.tmp", root) >= (int)sizeof upload_path) return 0;
  strcpy(target_id, target);
  host_abi = abi;
  listen_port = port;
  write_status = status_callback;
  configured = 1;
  next_listen = 0;
  return 1;
}
void pocket_devwire_state(uint32_t next_generation, uint64_t active) {
  generation = next_generation;
  active_hash = active;
}
void pocket_devwire_suspend(int value) {
  suspended = value;
  if (value) close_listeners();
  next_listen = 0;
}
void pocket_devwire_shutdown(void) {
  close_listeners();
  configured = suspended = 0;
  pocket_devwire_reset_guest();
}
const char *pocket_devwire_upload_path(void) { return upload_path; }
int pocket_devwire_connected(void) { return authenticated; }
const char *pocket_devwire_state_name(void) {
  if (suspended) return "suspended";
  if (authenticated) return "connected";
  if (listener >= 0) return "listening";
  return "unpaired-or-unavailable";
}
int pocket_devwire_take_upload(uint64_t *hash) {
  if (!upload_ready) return 0;
  *hash = upload_hash;
  upload_ready = 0;
  upload_hash = 0;
  return 1;
}
static void transfer_error(const char *message) {
  uint64_t hash = upload_hash;
  abort_upload();
  pocket_devwire_report("transfer-error", hash, message);
}

static void handle_frame(PocketRuntimeFrameHeader header, const uint8_t *payload) {
  switch (header.type) {
    case POCKET_RUNTIME_MSG_PING:
      if (header.length <= 16) queue(POCKET_RUNTIME_MSG_PONG, payload, header.length, 1);
      else disconnect();
      break;
    case POCKET_RUNTIME_MSG_PONG: break;
    case POCKET_RUNTIME_MSG_STATUS_REQUEST:
      if (header.length) disconnect(); else status();
      break;
    case POCKET_RUNTIME_MSG_CTRL:
      if (!header.length || header.length > POCKET_RUNTIME_MAX_CTRL_BYTES ||
          header.length + 1 > sizeof controls - controls_len ||
          memchr(payload, 0, header.length) || memchr(payload, '\n', header.length) || memchr(payload, '\r', header.length)) {
        disconnect(); break;
      }
      memcpy(controls + controls_len, payload, header.length);
      controls_len += header.length;
      controls[controls_len++] = '\n';
      break;
    case POCKET_RUNTIME_MSG_PACKAGE_BEGIN: {
      PocketRuntimePackageBegin begin;
      if (!pocket_runtime_parse_package_begin(payload, header.length, &begin) ||
          begin.length < 24 || begin.length > POCKET_DEV_MAX_PACKAGE || !begin.footer_hash) {
        disconnect(); break;
      }
      if (upload || upload_ready) { transfer_error("another upload is in progress"); break; }
      upload_hash = begin.footer_hash;
      upload_expected = begin.length;
      upload_received = 0;
      upload = fopen(upload_path, "wb");
      if (!upload) transfer_error("cannot open package staging file");
      break;
    }
    case POCKET_RUNTIME_MSG_PACKAGE_CHUNK:
      if (!upload || header.length <= 4 || pocket_runtime_read_u32(payload) != upload_received ||
          header.length - 4 > upload_expected - upload_received) {
        transfer_error("invalid package chunk offset or length"); break;
      }
      if (fwrite(payload + 4, 1, header.length - 4, upload) != header.length - 4) {
        transfer_error("package write failed"); break;
      }
      upload_received += header.length - 4;
      break;
    case POCKET_RUNTIME_MSG_PACKAGE_COMMIT: {
      if (header.length || !upload || upload_received != upload_expected) {
        transfer_error("incomplete package transfer"); break;
      }
      int ok = fflush(upload) == 0 && fsync(fileno(upload)) == 0;
      if (fclose(upload)) ok = 0;
      upload = NULL;
      if (!ok) transfer_error("package flush failed");
      else upload_ready = 1;
      break;
    }
    case POCKET_RUNTIME_MSG_PACKAGE_ABORT:
      abort_upload();
      break;
    default: disconnect(); break;
  }
}
static void pump_discovery(void) {
  if (discovery < 0) return;
  for (int i = 0; i < 4; ++i) {
    uint8_t request[64], reply[POCKET_RUNTIME_DISCOVERY_REPLY_BYTES];
    struct sockaddr_in source;
    socklen_t size = sizeof source;
    ssize_t length = recvfrom(discovery, request, sizeof request, 0, (struct sockaddr *)&source, &size);
    if (length < 0) break;
    if (!pocket_runtime_is_discovery_request(request, (size_t)length)) continue;
    pocket_runtime_encode_discovery_reply(reply, host_abi, listen_port, authenticated ? 1 : 0,
      generation, active_hash, device_id, target_id, "PocketJS iPod4");
    sendto(discovery, reply, sizeof reply, MSG_NOSIGNAL, (struct sockaddr *)&source, size);
  }
}
static void pump_rx(void) {
  size_t budget = IO_BUDGET;
  unsigned frames = 0;
  while (peer >= 0 && frames < 8 && !upload_ready) {
    if (!authenticated && rx_len >= POCKET_RUNTIME_HELLO_BYTES) {
      if (!pocket_runtime_verify_hello(rx, POCKET_RUNTIME_HELLO_BYTES, token)) { disconnect(); return; }
      memmove(rx, rx + POCKET_RUNTIME_HELLO_BYTES, rx_len - POCKET_RUNTIME_HELLO_BYTES);
      rx_len -= POCKET_RUNTIME_HELLO_BYTES;
      pocket_runtime_encode_ack(tx, 0, host_abi, generation, 0, active_hash);
      tx_len = POCKET_RUNTIME_ACK_BYTES;
      authenticated = 1;
      if (hello_len) queue(POCKET_RUNTIME_MSG_CTRL, hello, hello_len, 0);
      status();
    }
    if (authenticated && rx_len >= POCKET_RUNTIME_FRAME_HEADER_BYTES) {
      PocketRuntimeFrameHeader header;
      if (!pocket_runtime_parse_frame_header(rx, rx_len, &header) || header.flags) { disconnect(); return; }
      size_t total = POCKET_RUNTIME_FRAME_HEADER_BYTES + header.length;
      if (rx_len >= total) {
        handle_frame(header, rx + POCKET_RUNTIME_FRAME_HEADER_BYTES);
        if (peer < 0) return;
        memmove(rx, rx + total, rx_len - total);
        rx_len -= total;
        ++frames;
        continue;
      }
    }
    if (!budget) break;
    size_t room = sizeof rx - rx_len;
    if (!room) { disconnect(); return; }
    if (room > budget) room = budget;
    ssize_t count = recv(peer, rx + rx_len, room, 0);
    if (count <= 0) {
      if (count == 0 || !again()) disconnect();
      break;
    }
    rx_len += (size_t)count;
    budget -= (size_t)count;
    last_rx = pocket_devwire_now_ms();
  }
}
static void pump_tx(void) {
  if (peer < 0 || tx_off == tx_len) return;
  size_t length = tx_len - tx_off;
  if (length > IO_BUDGET) length = IO_BUDGET;
  ssize_t count = send(peer, tx + tx_off, length, MSG_NOSIGNAL);
  if (count > 0) {
    tx_off += (size_t)count;
    if (tx_off == tx_len) tx_off = tx_len = 0;
  } else if (!count || !again()) disconnect();
}
void pocket_devwire_pump(void) {
  if (suspended || !configured) return;
  listen_if_paired();
  if (listener < 0) return;
  pump_discovery();
  if (peer < 0) {
    peer = accept(listener, NULL, NULL);
    if (peer >= 0) {
      int yes = 1;
      setsockopt(peer, IPPROTO_TCP, TCP_NODELAY, &yes, sizeof yes);
#ifdef SO_NOSIGPIPE
      if (setsockopt(peer, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof yes)) { disconnect(); return; }
#endif
      if (!nonblocking(peer)) { disconnect(); return; }
      last_rx = pocket_devwire_now_ms();
    }
  }
  if (peer < 0) return;
  if (pocket_devwire_now_ms() - last_rx > (authenticated ? 10000u : 3000u)) {
    disconnect(); return;
  }
  pump_rx();
  pump_tx();
}
