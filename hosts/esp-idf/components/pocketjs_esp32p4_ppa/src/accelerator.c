#include "pocketjs/esp32p4_ppa.h"

#include <stdlib.h>

#include "pocketjs_ppa.h"

struct pocketjs_esp32p4_ppa {
  pocketjs_ppa_handle_t handle;
  pocketjs_rgb565_accelerator_t accelerator;
};

static bool fill(void *user_data, uint16_t *destination,
                 size_t destination_pixels, uint32_t width, uint32_t height,
                 pocketjs_rgb565_rect_t rect, uint16_t color) {
  pocketjs_esp32p4_ppa_t *ppa = user_data;
  return pocketjs_ppa_fill_rgb565(ppa->handle, destination, destination_pixels,
                                  width, height, rect.x, rect.y, rect.width,
                                  rect.height, color) != 0;
}

static bool blend(void *user_data, uint16_t *destination,
                  size_t destination_pixels, uint32_t width, uint32_t height,
                  const uint8_t *mask, size_t mask_size,
                  pocketjs_rgb565_rect_t rect, uint8_t red, uint8_t green,
                  uint8_t blue, uint8_t alpha) {
  pocketjs_esp32p4_ppa_t *ppa = user_data;
  return pocketjs_ppa_blend_a8_rgb565(
             ppa->handle, destination, destination_pixels, width, height, mask,
             mask_size, rect.x, rect.y, rect.width, rect.height, red, green,
             blue, alpha) != 0;
}

static bool srm(void *user_data, uint16_t *destination,
                size_t destination_pixels, uint32_t width, uint32_t height,
                const uint8_t *source, size_t source_size,
                uint32_t source_width, uint32_t source_height,
                pocketjs_rgb565_rect_t source_rect,
                pocketjs_rgb565_rect_t destination_rect, uint32_t quarter_turn,
                bool mirror_x, bool mirror_y) {
  pocketjs_esp32p4_ppa_t *ppa = user_data;
  return pocketjs_ppa_srm_psm5650_rgb565(
             ppa->handle, destination, destination_pixels, width, height,
             source, source_size, source_width, source_height, source_rect.x,
             source_rect.y, source_rect.width, source_rect.height,
             destination_rect.x, destination_rect.y, destination_rect.width,
             destination_rect.height, quarter_turn, mirror_x, mirror_y) != 0;
}

esp_err_t pocketjs_esp32p4_ppa_create(pocketjs_esp32p4_ppa_t **out_ppa) {
  if (out_ppa == NULL)
    return ESP_ERR_INVALID_ARG;
  *out_ppa = NULL;
  pocketjs_esp32p4_ppa_t *ppa = calloc(1, sizeof(*ppa));
  if (ppa == NULL)
    return ESP_ERR_NO_MEM;
  const esp_err_t result = pocketjs_ppa_create(&ppa->handle);
  if (result != ESP_OK) {
    free(ppa);
    return result;
  }
  ppa->accelerator = (pocketjs_rgb565_accelerator_t){
      .struct_size = sizeof(ppa->accelerator),
      .user_data = ppa,
      .fill_rgb565 = fill,
      .blend_a8_rgb565 = blend,
      .srm_psm5650_rgb565 = srm,
  };
  *out_ppa = ppa;
  return ESP_OK;
}

const pocketjs_rgb565_accelerator_t *
pocketjs_esp32p4_ppa_accelerator(pocketjs_esp32p4_ppa_t *ppa) {
  return ppa != NULL ? &ppa->accelerator : NULL;
}

void pocketjs_esp32p4_ppa_destroy(pocketjs_esp32p4_ppa_t *ppa) {
  if (ppa == NULL)
    return;
  pocketjs_ppa_destroy(ppa->handle);
  free(ppa);
}
