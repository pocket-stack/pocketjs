#ifndef POCKETJS_RUNTIME_DEV_SERVER_H
#define POCKETJS_RUNTIME_DEV_SERVER_H

#include <stddef.h>
#include <stdint.h>

#include "dev_protocol.h"

/*
 * Pocket Runtime wire v1 (PKRT) server semantics shared by every native host:
 * pairing, the hello/ack handshake, frame parsing and dispatch, DevTools
 * control records, `.pocket` uploads, two-surface screenshot streaming,
 * discovery replies, idle timeouts and the counters hosts report.
 *
 * The host owns only its transport. It accepts one TCP client, receives into
 * pocket_devserver_rx_room, sends what pocket_devserver_tx_pending returns,
 * answers UDP datagrams through pocket_devserver_discovery, and supplies its
 * clock, staging path, target identity and runtime status through
 * PocketDevServerConfig. Every call happens on the host's frame thread and
 * nothing here blocks. Package bytes never enter the guest: a committed upload
 * waits in the staging file until the host's frame loop takes it.
 */

#define POCKET_DEV_SERVER_MAX_PACKAGE_BYTES (24u * 1024u * 1024u)
/* A client that has not completed its hello within this window is dropped. */
#define POCKET_DEV_SERVER_HELLO_TIMEOUT_MS 3000u
/* An authenticated client that sends nothing, not even a PING, is dropped. */
#define POCKET_DEV_SERVER_IDLE_TIMEOUT_MS 15000u
/* Ack flag bit 0: this Runtime admits `.pocket` uploads. */
#define POCKET_DEV_SERVER_ACK_FLAG_PACKAGES 1u

enum {
  POCKET_DEV_SERVER_KEY_ERROR = -1,
  POCKET_DEV_SERVER_KEY_DISABLED = 0,
  POCKET_DEV_SERVER_KEY_READY = 1,
};

/* Discovery carries the target id and label in 16-byte NUL-padded fields. */
#define POCKET_DEV_SERVER_NAME_BYTES 15u

typedef struct {
  /* Target id and label published in discovery replies; borrowed, at most
   * POCKET_DEV_SERVER_NAME_BYTES each. */
  const char *target;
  const char *label;
  uint16_t host_abi;
  /* TCP port advertised in discovery replies. */
  uint16_t port;
  /* Staging file for one package upload; borrowed. */
  const char *upload_path;
  uint64_t (*now_ms)(void);
  /* Writes one runtime.status JSON record (no newline) into out. */
  void (*status)(char *out, size_t capacity);
  /* Screenshot surface buffers. Leaving both NULL disables screenshots. */
  void *(*screenshot_alloc)(size_t bytes);
  void (*screenshot_free)(void *bytes);
} PocketDevServerConfig;

typedef struct {
  uint32_t connects;
  uint32_t auth_failures;
  uint32_t timeouts;
  uint32_t uploads;
  uint32_t screenshots;
  uint32_t discoveries;
  uint64_t rx_bytes;
  uint64_t tx_bytes;
} PocketDevServerCounters;

/* Stores a copy of config; the strings it points at must outlive the server.
 * Returns 0 for an incomplete configuration or a name the discovery reply
 * cannot carry whole. */
int pocket_devserver_configure(const PocketDevServerConfig *config);
/* Drops the client, any upload, cached guest records and the pairing token.
 * The configuration and counters stay. */
void pocket_devserver_shutdown(void);
/* Reads a 64-hex-digit pairing key. DISABLED when the file is absent; ERROR,
 * with a message in error when provided, when it is unreadable or malformed. */
int pocket_devserver_load_key(const char *path, char *error, size_t error_length);
int pocket_devserver_paired(void);
uint64_t pocket_devserver_device_id(void);

/* Runtime facts published in acks, discovery replies and install reports. */
void pocket_devserver_set_state(uint32_t generation, uint64_t active_hash);
uint32_t pocket_devserver_generation(void);
/* Defaults to allowed. Disallowing discards a staged or in-flight upload. */
void pocket_devserver_allow_packages(int allowed);

/* Client lifecycle, driven by the transport. */
void pocket_devserver_client_open(void);
/* Free receive space; 0 means the client must be closed. */
size_t pocket_devserver_rx_room(uint8_t **out);
/* Accounts for received bytes and dispatches every complete frame. Returns 0
 * when the client must be closed. */
int pocket_devserver_rx_commit(size_t length);
/* True while a committed upload waits for the host; the transport stops
 * receiving so later frames wait behind the admission decision. */
int pocket_devserver_upload_pending(void);
/* Bytes waiting to be sent. A pending PONG and the next screenshot chunk are
 * queued here whenever the queue is empty. */
size_t pocket_devserver_tx_pending(const uint8_t **out);
void pocket_devserver_tx_consumed(size_t length);
/* True when the transport must close the client: a rejected hello whose ack
 * has been sent, a critical record that did not fit, or an idle timeout. */
int pocket_devserver_client_closing(void);
void pocket_devserver_client_close(void);
/* An authenticated client is attached. */
int pocket_devserver_connected(void);
/* Answers one discovery datagram. Returns 1 when reply must be sent. */
int pocket_devserver_discovery(
  const uint8_t *request,
  size_t length,
  uint8_t reply[POCKET_RUNTIME_DISCOVERY_REPLY_BYTES]
);

/* Pocket DevTools JSON-line transport exposed through ui.__dbg*. Records
 * handed to recv are complete lines with a trailing newline and NUL. */
size_t pocket_devserver_recv_ctrl(char *out, size_t capacity);
void pocket_devserver_send_ctrl(const char *line, size_t length);
void pocket_devserver_report_install(const char *phase, uint64_t hash, const char *message);
void pocket_devserver_report_log(const char *level, const char *message);
/* Forgets queued control records and the cached hello of a stopped guest. */
void pocket_devserver_reset_guest(void);

/* A committed upload waits in upload_path until the host takes it. Taking it
 * hands the staged file to the host; the server no longer touches it. */
int pocket_devserver_take_upload(uint64_t *declared_hash);
const char *pocket_devserver_upload_path(void);

/* On-demand two-surface screenshot. The host fills the returned buffers while
 * its GPU is idle; the server streams and frees them after the binary send. */
int pocket_devserver_request_screenshot(void);
int pocket_devserver_take_screenshot_request(void);
int pocket_devserver_screenshot_begin(
  uint32_t frame,
  uint16_t top_width,
  uint16_t top_height,
  uint16_t auxiliary_width,
  uint16_t auxiliary_height,
  uint8_t **top,
  uint8_t **auxiliary
);
void pocket_devserver_screenshot_ready(void);
void pocket_devserver_screenshot_cancel(void);

void pocket_devserver_counters(PocketDevServerCounters *out);

#endif
