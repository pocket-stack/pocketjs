#ifndef POCKET_HOST_SERVICE_H
#define POCKET_HOST_SERVICE_H
#include <stddef.h>
/* Optional local provider for the existing svcOpen/Poll/Send HostOps.
 * Calls occur on the host frame thread. Poll returns at most capacity - 1
 * bytes; send must bound its input and leave expensive work to the host. */
int pocket_host_service_open(const char *name);
size_t pocket_host_service_poll(char *out, size_t capacity);
void pocket_host_service_send(const char *line, size_t length);
#endif
