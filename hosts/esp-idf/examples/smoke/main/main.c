#include <assert.h>
#include <inttypes.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "pocketjs/guest.h"
#include "pocketjs/package.h"
#include "pocketjs/render_rgb565.h"
#include "pocketjs/ui_core.h"
#include "pocketjs/ui_qjs.h"
#include "pocketjs_package_smoke.h"

#if CONFIG_IDF_TARGET_ESP32P4
#include "pocketjs/esp32p4_ppa.h"
#endif

static const char *TAG = "pocketjs_smoke";

static uint64_t fnv1a64_u16(uint64_t hash, const uint16_t *pixels,
                            size_t count) {
  for (size_t index = 0; index < count; ++index) {
    hash ^= pixels[index] & 0xffU;
    hash *= UINT64_C(0x100000001b3);
    hash ^= pixels[index] >> 8U;
    hash *= UINT64_C(0x100000001b3);
  }
  return hash;
}

void app_main(void) {
  pocketjs_package_t *package = NULL;
  ESP_ERROR_CHECK(pocketjs_package_open(
      pocketjs_package_smoke.data, pocketjs_package_smoke.size, 0, &package));
  pocketjs_package_variant_t app = {.struct_size = sizeof(app)};
  ESP_ERROR_CHECK(
      pocketjs_package_select(package, &pocketjs_package_smoke_contract, &app));

  pocketjs_guest_config_t guest_config;
  pocketjs_guest_config_defaults(&guest_config);
  pocketjs_guest_t *guest = NULL;
  ESP_ERROR_CHECK(pocketjs_guest_create(&guest_config, &guest));

  pocketjs_ui_core_config_t core_config;
  pocketjs_ui_core_config_defaults(&core_config);
  core_config.logical_width = pocketjs_package_smoke_contract.logical_width;
  core_config.logical_height = pocketjs_package_smoke_contract.logical_height;
  core_config.raster_density = pocketjs_package_smoke_contract.raster_density;
  core_config.tick_hz = pocketjs_package_smoke_contract.tick_hz;
  pocketjs_ui_core_t *core = NULL;
  ESP_ERROR_CHECK(pocketjs_ui_core_create(&core_config, &core));

  const pocketjs_ui_qjs_config_t binding_config = {
      .struct_size = sizeof(binding_config),
      .target_id = pocketjs_package_smoke_contract.target_id,
      .host_abi = pocketjs_package_smoke_contract.host_abi,
  };
  pocketjs_ui_qjs_t *binding = NULL;
  ESP_ERROR_CHECK(
      pocketjs_ui_qjs_create(guest, core, &binding_config, &binding));
  ESP_ERROR_CHECK(
      pocketjs_ui_qjs_feed_pak(binding, app.pak.data, app.pak.size));
  ESP_ERROR_CHECK(pocketjs_ui_qjs_mount(binding));
  ESP_ERROR_CHECK(pocketjs_guest_eval(guest, (const char *)app.javascript.data,
                                      app.javascript.size - 1U, "idf-smoke"));

  pocketjs_ui_frame_view_t frame = {.struct_size = sizeof(frame)};
  pocketjs_ui_input_t input = {.struct_size = sizeof(input)};
  ESP_ERROR_CHECK(pocketjs_ui_turn(binding, &input, &frame));

  pocketjs_rgb565_renderer_config_t renderer_config;
  pocketjs_rgb565_renderer_config_defaults(&renderer_config);
  renderer_config.scale = pocketjs_package_smoke_contract.raster_density;
  pocketjs_rgb565_renderer_t *renderer = NULL;
  pocketjs_rgb565_target_t *target = NULL;
  ESP_ERROR_CHECK(pocketjs_rgb565_renderer_create(&renderer_config, &renderer));
  ESP_ERROR_CHECK(pocketjs_rgb565_target_create(&target));

#if CONFIG_IDF_TARGET_ESP32P4
  pocketjs_esp32p4_ppa_t *ppa = NULL;
  ESP_ERROR_CHECK(pocketjs_esp32p4_ppa_create(&ppa));
  const pocketjs_rgb565_accelerator_t *accelerator =
      pocketjs_esp32p4_ppa_accelerator(ppa);
#else
  const pocketjs_rgb565_accelerator_t *accelerator = NULL;
#endif

  pocketjs_rgb565_damage_plan_t plan = {.struct_size = sizeof(plan)};
  ESP_ERROR_CHECK(pocketjs_rgb565_prepare(renderer, target, &frame, &plan));
  uint64_t hash = UINT64_C(0xcbf29ce484222325);
  pocketjs_rgb565_render_stats_t totals = {.struct_size = sizeof(totals)};
  for (uint32_t index = 0; index < plan.region_count; ++index) {
    const pocketjs_rgb565_rect_t region = plan.regions[index];
    const size_t pixels = (size_t)frame.logical_width * region.height;
    uint16_t *strip = heap_caps_aligned_alloc(
        128, pixels * sizeof(*strip), MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    assert(strip != NULL);
    memset(strip, 0, pixels * sizeof(*strip));
    pocketjs_rgb565_render_stats_t stats = {.struct_size = sizeof(stats)};
    ESP_ERROR_CHECK(pocketjs_rgb565_render_strip(
        renderer, &frame, strip, pixels, region, accelerator, &stats));
    hash = fnv1a64_u16(hash, strip, pixels);
    totals.ppa_fills += stats.ppa_fills;
    totals.ppa_blends += stats.ppa_blends;
    totals.ppa_srm += stats.ppa_srm;
    totals.software_ops += stats.software_ops;
    heap_caps_free(strip);
  }
  ESP_ERROR_CHECK(pocketjs_rgb565_commit(renderer, target, &frame));
  ESP_LOGI(TAG,
           "PASS target=%s hash=%016" PRIx64 " damage=%" PRIu32 " ppa=%" PRIu32
           "/%" PRIu32 "/%" PRIu32 " software=%" PRIu32,
           pocketjs_package_smoke_contract.target_id, hash, plan.region_count,
           totals.ppa_fills, totals.ppa_blends, totals.ppa_srm,
           totals.software_ops);

#if CONFIG_IDF_TARGET_ESP32P4
  pocketjs_esp32p4_ppa_destroy(ppa);
#endif
  pocketjs_rgb565_target_destroy(target);
  pocketjs_rgb565_renderer_destroy(renderer);
  pocketjs_guest_destroy(guest);
  pocketjs_ui_qjs_destroy(binding);
  pocketjs_ui_core_destroy(core);
  pocketjs_package_close(package);
}
