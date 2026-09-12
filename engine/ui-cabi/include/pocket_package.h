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

/* Same admission/error codes as the 3DS host. Hosts also validate the plan
 * against their target contract before changing the running guest.
 * 0 = success, 12 = arguments. */
int32_t pocket_package_open(const uint8_t *bytes, size_t length,
  const uint8_t *target, size_t target_length, uint32_t host_abi,
  PocketGuestPackage *out);

/* The host's target contract: its identity, the surfaces it presents and the
 * capability ids its target registry entry lists. tools/target-contract.ts
 * generates a POCKET_TARGET_CONTRACT instance for each native build from the
 * verified build plan and the registry, so the plan admission below shares
 * one source of truth with the desktop resolver. Strings are NUL-terminated;
 * a NULL auxiliary_presentation means the host has no auxiliary surface. */
typedef struct {
  const char *target;
  uint32_t host_abi;
  uint32_t logical_width;
  uint32_t logical_height;
  uint32_t physical_width;
  uint32_t physical_height;
  uint32_t raster_density;
  const char *presentation;
  const char *const *capabilities;
  size_t capability_count;
  uint32_t auxiliary_logical_width;
  uint32_t auxiliary_logical_height;
  uint32_t auxiliary_physical_width;
  uint32_t auxiliary_physical_height;
  uint32_t auxiliary_raster_density;
  const char *auxiliary_presentation;
  uint32_t host_extension;
} PocketTargetContract;

/* Admit a package plan section for this host without evaluating it.
 * 0 = the plan matches the contract; 1 syntax, 2 target, 3 host ABI,
 * 4 viewport, 5 presentation, 6 surfaces, 7 host extension, 8 features,
 * 12 arguments. */
int32_t pocket_package_validate_plan(const uint8_t *plan, size_t length,
  const PocketTargetContract *contract);
#endif
