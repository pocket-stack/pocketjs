#ifndef POCKETJS_3DS_RUNTIME_H
#define POCKETJS_3DS_RUNTIME_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "pocket_core.h"

#define POCKET_RUNTIME_ROOT "sdmc:/pocketjs/runtime"
#define POCKET_RUNTIME_PENDING POCKET_RUNTIME_ROOT "/pending.pocket"
#define POCKET_RUNTIME_UPLOAD POCKET_RUNTIME_ROOT "/network-upload.pocket"
#define POCKET_RUNTIME_DEV_KEY POCKET_RUNTIME_ROOT "/dev.key"

typedef struct {
  uint8_t *bytes;
  size_t length;
  PocketGuestPackage guest;
  char origin[192];
} PocketRuntimePackage;

typedef struct {
  uint32_t generation;
  uint64_t active_hash;
  uint64_t last_good_hash;
} PocketRuntimeState;

/* Creates the runtime directories and loads the newest committed generation. */
bool runtime_storage_init(PocketRuntimeState *state, char *error, size_t error_length);

/* Read, hash-check and admit one target/ABI package. */
PocketRuntimePackage *runtime_package_load(
  const char *path,
  char *error,
  size_t error_length
);
PocketRuntimePackage *runtime_package_load_hash(
  uint64_t hash,
  char *error,
  size_t error_length
);
void runtime_package_free(PocketRuntimePackage *package);

/*
 * Consume pending.pocket only after it is complete and verified. The file is
 * renamed to its immutable content-addressed blob before READY is returned.
 * NONE means no upload was present; ERROR leaves an invalid/partial upload in
 * place so an in-progress FTP transfer is never destroyed.
 */
typedef enum {
  RUNTIME_PENDING_ERROR = -1,
  RUNTIME_PENDING_NONE = 0,
  RUNTIME_PENDING_READY = 1,
} RuntimePendingResult;
RuntimePendingResult runtime_prepare_pending(
  PocketRuntimePackage **out,
  char *error,
  size_t error_length
);
/* Admit a completed transport-owned file and move it to immutable storage.
 * expected_hash is the footer declared before transfer (0 skips that extra
 * comparison). The source remains in place on any validation error. */
RuntimePendingResult runtime_prepare_file(
  const char *path,
  uint64_t expected_hash,
  PocketRuntimePackage **out,
  char *error,
  size_t error_length
);

/* Append one power-loss-safe state generation after a guest frame is accepted. */
bool runtime_commit(
  PocketRuntimeState *state,
  uint64_t active_hash,
  uint64_t last_good_hash,
  char *error,
  size_t error_length
);

void runtime_write_status(
  const PocketRuntimeState *state,
  const PocketRuntimePackage *package,
  const char *phase
);
void runtime_write_error(const char *phase, const char *message);

#endif
