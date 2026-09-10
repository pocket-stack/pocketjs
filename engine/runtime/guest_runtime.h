#ifndef POCKETJS_GUEST_RUNTIME_H
#define POCKETJS_GUEST_RUNTIME_H
#include "../ui-cabi/include/pocket_package.h"
#include "dev_server.h"

/* The native shell owns the window/GL context; the manager owns package
 * buffers and disk state. stop must release all borrowed guest data. */
typedef struct {
  int (*boot)(const PocketGuestPackage *guest);
  void (*stop)(void);
  int (*validate_plan)(const uint8_t *plan, size_t length);
  const char *(*error)(void);
} PocketDevHost;

int pocket_dev_runtime_init(const char *root, const PocketDevHost *host,
  const PocketGuestPackage *embedded, uint16_t port);
void pocket_dev_runtime_pump(void);
void pocket_dev_runtime_presented(void);
void pocket_dev_runtime_failed(const char *message);
void pocket_dev_runtime_shutdown(void);
void pocket_dev_runtime_status(char *out, size_t length);
int pocket_dev_runtime_running(void);
#endif
