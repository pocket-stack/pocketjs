#include "pocketjs/render_rgb565.h"
#include "pocketjs/native_renderer.h"

void pocketjs_rgb565_renderer_config_defaults(
    pocketjs_rgb565_renderer_config_t *config) {
  if (config != NULL) {
    *config = (pocketjs_rgb565_renderer_config_t){
        .struct_size = sizeof(*config),
        .scale = 1,
        .min_fill_pixels = 1024,
        .min_blend_pixels = 256,
        .min_srm_pixels = 256,
    };
  }
}

esp_err_t
pocketjs_rgb565_renderer_create(const pocketjs_rgb565_renderer_config_t *config,
                                pocketjs_rgb565_renderer_t **out_renderer) {
  return pocketjs_native_renderer_create(config, out_renderer) == 0
             ? ESP_OK
             : ESP_ERR_INVALID_ARG;
}

void pocketjs_rgb565_renderer_destroy(pocketjs_rgb565_renderer_t *renderer) {
  pocketjs_native_renderer_destroy(renderer);
}

esp_err_t pocketjs_rgb565_target_create(pocketjs_rgb565_target_t **out_target) {
  return pocketjs_native_render_target_create(out_target) == 0 ? ESP_OK
                                                               : ESP_ERR_NO_MEM;
}

void pocketjs_rgb565_target_invalidate(pocketjs_rgb565_target_t *target) {
  pocketjs_native_render_target_invalidate(target);
}

void pocketjs_rgb565_target_destroy(pocketjs_rgb565_target_t *target) {
  pocketjs_native_render_target_destroy(target);
}

esp_err_t pocketjs_rgb565_prepare(pocketjs_rgb565_renderer_t *renderer,
                                  pocketjs_rgb565_target_t *target,
                                  const pocketjs_ui_frame_view_t *frame,
                                  pocketjs_rgb565_damage_plan_t *out_plan) {
  return pocketjs_native_renderer_prepare(renderer, target, frame, out_plan) ==
                 0
             ? ESP_OK
             : ESP_ERR_INVALID_STATE;
}

esp_err_t
pocketjs_rgb565_render_strip(pocketjs_rgb565_renderer_t *renderer,
                             const pocketjs_ui_frame_view_t *frame,
                             uint16_t *destination, size_t destination_pixels,
                             pocketjs_rgb565_rect_t region,
                             const pocketjs_rgb565_accelerator_t *accelerator,
                             pocketjs_rgb565_render_stats_t *out_stats) {
  return pocketjs_native_renderer_render_strip(renderer, frame, destination,
                                               destination_pixels, region,
                                               accelerator, out_stats) == 0
             ? ESP_OK
             : ESP_ERR_INVALID_ARG;
}

esp_err_t pocketjs_rgb565_commit(pocketjs_rgb565_renderer_t *renderer,
                                 pocketjs_rgb565_target_t *target,
                                 const pocketjs_ui_frame_view_t *frame) {
  return pocketjs_native_renderer_commit(renderer, target, frame) == 1
             ? ESP_OK
             : ESP_ERR_INVALID_STATE;
}

void pocketjs_rgb565_abort(pocketjs_rgb565_renderer_t *renderer,
                           pocketjs_rgb565_target_t *target) {
  pocketjs_native_renderer_abort(renderer, target);
}
