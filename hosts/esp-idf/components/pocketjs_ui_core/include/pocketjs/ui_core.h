#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "pocketjs/ui_types.h"

#ifdef __cplusplus
extern "C" {
#endif

#define POCKETJS_UI_CORE_ABI_VERSION 1U
#define POCKETJS_UI_MAX_TOUCHES 8U

typedef struct pocketjs_ui_core pocketjs_ui_core_t;

typedef enum {
  POCKETJS_UI_ASSET_STYLES = 1,
  POCKETJS_UI_ASSET_FONT = 2,
  POCKETJS_UI_ASSET_IMAGE = 3,
  POCKETJS_UI_ASSET_SPRITE = 4,
} pocketjs_ui_asset_kind_t;

/** Atomic asset batch. On any returned error core and handles are unchanged.
 * Outputs one handle per input (-1 for styles/fonts). Rust OOM is fatal. */
esp_err_t pocketjs_ui_core_load_assets(pocketjs_ui_core_t *core,
                                       const pocketjs_ui_asset_t *assets,
                                       size_t count, int32_t *handles);

void pocketjs_ui_core_config_defaults(pocketjs_ui_core_config_t *config);
esp_err_t pocketjs_ui_core_create(const pocketjs_ui_core_config_t *config,
                                  pocketjs_ui_core_t **out_core);
esp_err_t pocketjs_ui_core_get_config(const pocketjs_ui_core_t *core,
                                      pocketjs_ui_core_config_t *out_config);
void pocketjs_ui_core_destroy(pocketjs_ui_core_t *core);

int32_t pocketjs_ui_core_create_node(pocketjs_ui_core_t *core,
                                     uint32_t node_type);
void pocketjs_ui_core_destroy_node(pocketjs_ui_core_t *core, int32_t id);
void pocketjs_ui_core_insert_before(pocketjs_ui_core_t *core, int32_t parent,
                                    int32_t child, int32_t anchor);
void pocketjs_ui_core_remove_child(pocketjs_ui_core_t *core, int32_t parent,
                                   int32_t child);
void pocketjs_ui_core_set_style(pocketjs_ui_core_t *core, int32_t id,
                                int32_t style_id);
void pocketjs_ui_core_set_prop(pocketjs_ui_core_t *core, int32_t id,
                               uint32_t prop, double value);
esp_err_t pocketjs_ui_core_set_text(pocketjs_ui_core_t *core, int32_t id,
                                    const char *text, size_t size);
esp_err_t pocketjs_ui_core_replace_text(pocketjs_ui_core_t *core, int32_t id,
                                        const char *text, size_t size);
int32_t pocketjs_ui_core_animate(pocketjs_ui_core_t *core, int32_t id,
                                 uint32_t prop, double to, uint32_t duration_ms,
                                 uint32_t easing, uint32_t delay_ms);
void pocketjs_ui_core_cancel_animation(pocketjs_ui_core_t *core,
                                       int32_t animation_id);
void pocketjs_ui_core_set_focus(pocketjs_ui_core_t *core, int32_t id);
void pocketjs_ui_core_set_active(pocketjs_ui_core_t *core, int32_t id,
                                 bool active);
int32_t pocketjs_ui_core_hit_test(pocketjs_ui_core_t *core, float x, float y);
int32_t pocketjs_ui_core_hit_test_bounds(pocketjs_ui_core_t *core, float x,
                                         float y);
void pocketjs_ui_core_set_cursor(pocketjs_ui_core_t *core, int32_t texture,
                                 float hot_x, float hot_y, float width,
                                 float height);
void pocketjs_ui_core_set_cursor_position(pocketjs_ui_core_t *core, float x,
                                          float y);

esp_err_t pocketjs_ui_core_load_styles(pocketjs_ui_core_t *core,
                                       const void *data, size_t size);
esp_err_t pocketjs_ui_core_load_font_atlas(pocketjs_ui_core_t *core,
                                           const void *data, size_t size);
int32_t pocketjs_ui_core_upload_texture(pocketjs_ui_core_t *core,
                                        const void *data, size_t size,
                                        uint32_t width, uint32_t height,
                                        uint32_t psm);
int32_t pocketjs_ui_core_upload_img_entry(pocketjs_ui_core_t *core,
                                          const void *data, size_t size);
void pocketjs_ui_core_free_texture(pocketjs_ui_core_t *core, int32_t texture);
void pocketjs_ui_core_set_image(pocketjs_ui_core_t *core, int32_t id,
                                int32_t texture);
void pocketjs_ui_core_set_sprite(pocketjs_ui_core_t *core, int32_t id,
                                 int32_t atlas, uint32_t frames,
                                 uint32_t columns, uint32_t step);
float pocketjs_ui_core_measure_text(pocketjs_ui_core_t *core, const char *text,
                                    size_t size, uint32_t font_slot);
size_t pocketjs_ui_core_wrap_text(pocketjs_ui_core_t *core, const char *text,
                                  size_t size, uint32_t font_slot,
                                  float max_width, uint32_t *breaks,
                                  size_t capacity);

void pocketjs_ui_core_tick(pocketjs_ui_core_t *core);
esp_err_t pocketjs_ui_core_draw(pocketjs_ui_core_t *core,
                                pocketjs_ui_frame_view_t *out_frame);
size_t pocketjs_ui_core_touch_hits(pocketjs_ui_core_t *core,
                                   const uint32_t *touches, size_t touch_count,
                                   int32_t *out_hits, size_t hit_capacity);
/** Borrowed resource views expire on the next core mutation or tick. */
esp_err_t pocketjs_ui_core_texture(pocketjs_ui_core_t *core, int32_t handle,
                                   pocketjs_ui_texture_view_t *out_texture);
esp_err_t pocketjs_ui_core_font(pocketjs_ui_core_t *core, uint32_t slot,
                                pocketjs_ui_font_view_t *out_font);

#ifdef __cplusplus
}
#endif
