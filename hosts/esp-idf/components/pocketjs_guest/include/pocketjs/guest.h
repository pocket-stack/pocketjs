#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define POCKETJS_GUEST_ABI_VERSION 1U
#define POCKETJS_GUEST_MAX_TOUCHES 8U

typedef struct pocketjs_guest pocketjs_guest_t;

typedef struct {
  size_t struct_size;
  size_t heap_limit;
  size_t stack_limit;
  bool prefer_psram;
} pocketjs_guest_config_t;

typedef struct {
  size_t struct_size;
  uint32_t buttons;
  /** (x << 8) | y, with both normalized axes in 0..255 and 128 centered. */
  uint32_t analog;
  const uint32_t *touches;
  const int32_t *touch_hits;
  size_t touch_count;
} pocketjs_guest_frame_t;

typedef struct {
  size_t struct_size;
  uint32_t frames;
  uint32_t frame_errors;
  uint32_t jobs;
  size_t heap_used;
  size_t heap_limit;
} pocketjs_guest_stats_t;

void pocketjs_guest_config_defaults(pocketjs_guest_config_t *config);

esp_err_t pocketjs_guest_create(const pocketjs_guest_config_t *config,
                                pocketjs_guest_t **out_guest);

/** Evaluate one global IIFE. Surfaces must be installed before this call. */
esp_err_t pocketjs_guest_eval(pocketjs_guest_t *guest, const char *source,
                              size_t source_size, const char *label);

/** Call globalThis.frame(...) once and drain every pending Promise job. */
esp_err_t pocketjs_guest_frame(pocketjs_guest_t *guest,
                               const pocketjs_guest_frame_t *frame);

/** Ask the current or next JavaScript turn to stop through QuickJS's handler.
 * This is the only guest API that may be called outside the owner task. */
void pocketjs_guest_interrupt(pocketjs_guest_t *guest);

esp_err_t pocketjs_guest_stats(pocketjs_guest_t *guest,
                               pocketjs_guest_stats_t *out_stats);

void pocketjs_guest_destroy(pocketjs_guest_t *guest);

#ifdef __cplusplus
}
#endif
