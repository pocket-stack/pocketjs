#ifndef POCKETJS_RUNTIME_DEV_WIRE_POSIX_H
#define POCKETJS_RUNTIME_DEV_WIRE_POSIX_H

#include <stddef.h>
#include <stdint.h>

#include "dev_server.h"

/*
 * Pocket Runtime wire transport over non-blocking BSD sockets for POSIX hosts
 * (UIKit shells and the host test harness). Protocol semantics belong to
 * dev_server.c; this file owns the listener, one peer, UDP discovery and the
 * pairing-file and foreground policy:
 * - the listener opens once <root>/dev.key holds a valid key, rechecked once
 *   per second while unpaired;
 * - suspending closes every socket and reopens them on resume, so a shell
 *   that resigns active holds no LAN connection in the background.
 * All calls happen on the UI thread; pump bounds socket work per call.
 */

#define POCKET_DEV_PATH_BYTES 1024

typedef struct {
  /* Directory holding dev.key and the upload staging file; borrowed. */
  const char *root;
  const char *target;
  const char *label;
  uint16_t host_abi;
  uint16_t port;
  void (*status)(char *out, size_t capacity);
} PocketDevWireOptions;

int pocket_devwire_init(const PocketDevWireOptions *options);
void pocket_devwire_pump(void);
void pocket_devwire_suspend(int suspended);
void pocket_devwire_shutdown(void);
/* suspended, connected, listening or unpaired-or-unavailable. */
const char *pocket_devwire_state_name(void);
uint64_t pocket_devwire_now_ms(void);

#endif
