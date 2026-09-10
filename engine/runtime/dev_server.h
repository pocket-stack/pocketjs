#ifndef POCKETJS_POSIX_DEV_SERVER_H
#define POCKETJS_POSIX_DEV_SERVER_H
#include <stddef.h>
#include <stdint.h>
#include "dev_protocol.h"

#define POCKET_DEV_MAX_PACKAGE (24u * 1024u * 1024u)
#define POCKET_DEV_PATH_BYTES 1024

/* Single UI-thread owner. pump bounds socket work, including unauthenticated
 * traffic. The package consumer runs outside the parser at a frame boundary. */
int pocket_devwire_init(const char *root, const char *target, uint16_t abi,
  uint16_t port, void (*status)(char *, size_t));
void pocket_devwire_pump(void);
void pocket_devwire_suspend(int suspended);
void pocket_devwire_shutdown(void);
void pocket_devwire_state(uint32_t generation, uint64_t active);
int pocket_devwire_take_upload(uint64_t *hash);
const char *pocket_devwire_upload_path(void);
int pocket_devwire_connected(void);
const char *pocket_devwire_state_name(void);
size_t pocket_devwire_poll(char *out, size_t capacity);
void pocket_devwire_send(const char *text, size_t length);
void pocket_devwire_reset_guest(void);
void pocket_devwire_report(const char *phase, uint64_t hash, const char *message);
void pocket_devwire_log(const char *level, const char *message);
uint64_t pocket_devwire_now_ms(void);
#endif
