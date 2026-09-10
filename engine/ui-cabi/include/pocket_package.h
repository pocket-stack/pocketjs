#ifndef POCKETJS_UI_PACKAGE_H
#define POCKETJS_UI_PACKAGE_H
#include <stddef.h>
#include <stdint.h>

/* Slices borrow the complete package buffer until guest shutdown. */
typedef struct {
  const uint8_t *javascript;
  size_t javascript_length; /* includes QuickJS's trailing NUL */
  const uint8_t *pak;
  size_t pak_length;
  const uint8_t *plan;
  size_t plan_length;
  uint64_t package_hash;
  uint64_t variant_hash;
} PocketGuestPackage;

/* Same admission/error codes as the 3DS host. Hosts also validate the plan's
 * viewport before changing the running guest. 0 = success, 12 = arguments. */
int32_t pocket_package_open(const uint8_t *bytes, size_t length,
  const uint8_t *target, size_t target_length, uint32_t host_abi,
  PocketGuestPackage *out);
#endif
