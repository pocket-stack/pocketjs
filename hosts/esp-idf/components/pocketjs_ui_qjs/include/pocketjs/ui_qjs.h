#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "pocketjs/guest.h"
#include "pocketjs/ui_core.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct pocketjs_ui_qjs pocketjs_ui_qjs_t;

typedef struct {
  uint8_t id;
  uint16_t x;
  uint16_t y;
} pocketjs_ui_touch_t;

typedef struct {
  size_t struct_size;
  uint32_t buttons;
  int16_t analog_x;
  int16_t analog_y;
  const pocketjs_ui_touch_t *touches;
  size_t touch_count;
} pocketjs_ui_input_t;

typedef struct {
  size_t struct_size;
  const char *target_id;
  uint32_t host_abi;
} pocketjs_ui_qjs_config_t;

esp_err_t pocketjs_ui_qjs_create(pocketjs_guest_t *guest,
                                 pocketjs_ui_core_t *core,
                                 const pocketjs_ui_qjs_config_t *config,
                                 pocketjs_ui_qjs_t **out_binding);

/** Atomically feed styles/fonts/images from a borrowed PAK before mounting.
 * Returned errors leave core/binding unchanged and permit retry. PAK bytes
 * must remain readable and unchanged until guest and binding are destroyed.
 * The JS ArrayBuffer is immutable; this does not extend native byte lifetime.
 * Rust allocation exhaustion is fatal, not a recoverable ESP_ERR_NO_MEM. */
esp_err_t pocketjs_ui_qjs_feed_pak(pocketjs_ui_qjs_t *binding, const void *pak,
                                   size_t pak_size);

/** Install globalThis.ui and immutable globalThis.__pak before guest eval.
 * One UI binding per guest; a second mount returns ESP_ERR_INVALID_STATE.
 * Functions capture their binding and never use JSContext's opaque slot. */
esp_err_t pocketjs_ui_qjs_mount(pocketjs_ui_qjs_t *binding);

/** One synchronous PocketJS UI turn; no rendering or presentation occurs. */
esp_err_t pocketjs_ui_turn(pocketjs_ui_qjs_t *binding,
                           const pocketjs_ui_input_t *input,
                           pocketjs_ui_frame_view_t *out_frame);

/** The cadence inherited from the caller-owned UI core; zero until mounted. */
uint32_t pocketjs_ui_qjs_tick_hz(const pocketjs_ui_qjs_t *binding);

/** Interrupt the binding's current or next guest turn from another task. */
void pocketjs_ui_qjs_interrupt(pocketjs_ui_qjs_t *binding);

/** The guest must be destroyed before its mounted binding is destroyed. */
void pocketjs_ui_qjs_destroy(pocketjs_ui_qjs_t *binding);

#ifdef __cplusplus
}
#endif
