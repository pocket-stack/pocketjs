#ifndef POCKETJS_3DS_DEV_TRANSPORT_H
#define POCKETJS_3DS_DEV_TRANSPORT_H
#include "devserver.h"
void devtransport_set_upload_busy(bool busy);
void devtransport_reset_guest(void);
bool devtransport_ctrl_available(size_t length);
void devtransport_adopt_screenshot(uint32_t frame, uint16_t tw, uint16_t th,
  uint16_t aw, uint16_t ah, uint8_t *top, uint8_t *aux);
bool devtransport_screenshot_busy(void);
/* Starts the paired LAN listener. A missing dev.key is an intentional
 * DISABLED state; malformed key or socket initialization is ERROR. */
DevserverInitResult devtransport_init(
  const PocketRuntimeState *state,
  char *error,
  size_t error_length
);
void devtransport_shutdown(void);

/* Worker-only network pump. libctru IPC and SD may block this thread. */
void devtransport_poll(void);
bool devtransport_active(void);
bool devtransport_connected(void);
void devtransport_snapshot(DevserverSnapshot *out);

/* Pocket DevTools JSON-line transport exposed through ui.__dbg*. */
size_t devtransport_recv_ctrl(char *out, size_t capacity);
void devtransport_send_ctrl(const char *line, size_t length);
bool devtransport_request_screenshot(void);
const char *devtransport_debug_stats(void);

/* Completed binary upload. The caller admits POCKET_RUNTIME_UPLOAD, then
 * reports staged/rejected/accepted at the same lifecycle boundaries used by
 * FTP packages. */
bool devtransport_take_upload(uint64_t *declared_hash);
void devtransport_report_install(
  const char *phase,
  uint64_t hash,
  const char *message
);
void devtransport_report_log(const char *level, const char *message);

/* Current runtime facts are cached for connect/status/debugStats receipts. */
void devtransport_set_runtime(
  const PocketRuntimeState *state,
  const PocketRuntimePackage *package,
  const char *phase,
  uint32_t frame
);
void devtransport_set_frame_stats(
  uint32_t frame,
  uint32_t commands,
  uint32_t vertices,
  uint32_t dropped_vertices
);

/* Transport borrows UI-owned linear buffers until completion/disconnect. */
bool devtransport_take_screenshot_request(void);
void devtransport_screenshot_ready(void);
void devtransport_screenshot_cancel(void);

#endif
