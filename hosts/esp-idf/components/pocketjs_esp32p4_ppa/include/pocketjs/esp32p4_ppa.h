#pragma once

#include "esp_err.h"
#include "pocketjs/render_rgb565.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct pocketjs_esp32p4_ppa pocketjs_esp32p4_ppa_t;

esp_err_t pocketjs_esp32p4_ppa_create(pocketjs_esp32p4_ppa_t **out_ppa);
const pocketjs_rgb565_accelerator_t *
pocketjs_esp32p4_ppa_accelerator(pocketjs_esp32p4_ppa_t *ppa);
void pocketjs_esp32p4_ppa_destroy(pocketjs_esp32p4_ppa_t *ppa);

#ifdef __cplusplus
}
#endif
