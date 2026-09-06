#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define POCKETJS_PACKAGE_OPEN_SKIP_HASH (1U << 0)
#define POCKETJS_PACKAGE_TARGET_BYTES 16U
#define POCKETJS_PACKAGE_HASH_BYTES 32U

typedef struct pocketjs_package pocketjs_package_t;

typedef struct {
  const uint8_t *data;
  size_t size;
} pocketjs_bytes_t;

typedef struct {
  const uint8_t *data;
  size_t size;
} pocketjs_embedded_package_t;

typedef enum {
  POCKETJS_PRESENTATION_FILL = 0,
  POCKETJS_PRESENTATION_FIT = 1,
  POCKETJS_PRESENTATION_INTEGER_FIT = 2,
  POCKETJS_PRESENTATION_NATIVE = 3,
  POCKETJS_PRESENTATION_STRETCH = 4,
} pocketjs_presentation_t;

/** Product-owned facts generated from pocket.host.json. */
typedef struct {
  size_t struct_size;
  const char *target_id;
  uint32_t host_abi;
  uint32_t tick_hz;
  uint32_t logical_width;
  uint32_t logical_height;
  uint32_t physical_width;
  uint32_t physical_height;
  uint32_t raster_density;
  pocketjs_presentation_t presentation;
  uint8_t profile_hash[POCKETJS_PACKAGE_HASH_BYTES];
} pocketjs_package_host_contract_t;

typedef struct {
  size_t struct_size;
  pocketjs_bytes_t javascript;
  pocketjs_bytes_t pak;
  pocketjs_bytes_t plan_json;
  uint8_t plan_hash[POCKETJS_PACKAGE_HASH_BYTES];
  uint64_t variant_hash;
} pocketjs_package_variant_t;

/** Parse a borrowed .pocket container. The bytes must outlive the handle. */
esp_err_t pocketjs_package_open(const void *data, size_t size, uint32_t flags,
                                pocketjs_package_t **out_package);

void pocketjs_package_close(pocketjs_package_t *package);

pocketjs_bytes_t pocketjs_package_manifest(const pocketjs_package_t *package);

/** Select and validate one ESP-IDF variant without parsing plan JSON. */
esp_err_t
pocketjs_package_select(const pocketjs_package_t *package,
                        const pocketjs_package_host_contract_t *contract,
                        pocketjs_package_variant_t *out_variant);

#ifdef __cplusplus
}
#endif
