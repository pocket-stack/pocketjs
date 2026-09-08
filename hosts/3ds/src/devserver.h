#ifndef POCKETJS_3DS_DEVSERVER_H
#define POCKETJS_3DS_DEVSERVER_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "runtime.h"

typedef enum { DEVSERVER_DISABLED = 0, DEVSERVER_READY = 1, DEVSERVER_ERROR = -1 } DevserverInitResult;
typedef struct {
  bool enabled, discoverable, connected;
  char ip[16], phase[32];
  uint16_t port, host_abi;
  uint32_t generation;
  uint64_t running_hash, device_id;
  uint32_t connects, auth_failures, timeouts, uploads, screenshots;
} DevserverSnapshot;

/* The worker owns sockets, pairing, SD and package verification. The embedded
 * buffer is immutable and must remain alive until shutdown joins the worker. */
bool devserver_start(const PocketRuntimePackage *embedded);
void devserver_shutdown(void);
void devserver_poll(void);
bool devserver_active(void);
bool devserver_connected(void);
void devserver_snapshot(DevserverSnapshot *out);

/* One candidate at a time. A true return with NULL selects embedded recovery.
 * Buffer ownership moves to main; the worker retains only hashes afterwards. */
bool devserver_take_candidate(PocketRuntimePackage **out);
void devserver_finish_candidate(bool accepted, const char *error);
bool devserver_take_outcome(bool *committed);
bool devserver_reload(void);
bool devserver_recover(uint64_t failed_hash, const char *error);
void devserver_reset_guest(void);

/* Bounded, generation-fenced control mailboxes. No filesystem/socket calls. */
size_t devserver_recv_ctrl(char *out, size_t capacity);
void devserver_send_ctrl(const char *line, size_t length);
const char *devserver_debug_stats(void);
void devserver_set_frame_stats(uint32_t frame, uint32_t commands, uint32_t vertices, uint32_t dropped);
void devserver_set_runtime(const PocketRuntimeState *state, const PocketRuntimePackage *package, const char *phase, uint32_t frame);
void devserver_report_install(const char *phase, uint64_t hash, const char *message);
void devserver_report_log(const char *level, const char *message);

/* One borrowed screenshot slot; GPU work and linear storage remain UI-owned. */
bool devserver_request_screenshot(void);
bool devserver_take_screenshot_request(void);
bool devserver_screenshot_begin(uint32_t frame, uint16_t tw, uint16_t th, uint16_t aw, uint16_t ah, uint8_t **top, uint8_t **aux);
void devserver_screenshot_ready(void);
void devserver_screenshot_cancel(void);
#endif
