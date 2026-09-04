#include <inttypes.h>
#include <stddef.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "pocketjs/guest.h"
#include "pocketjs/package.h"
#include "pocketjs/runner.h"
#include "pocketjs/ui_core.h"
#include "pocketjs/ui_qjs.h"
#include "pocketjs_package_runner.h"

static const char *TAG = "pocketjs_runner_example";

static esp_err_t sample_input(pocketjs_ui_input_t *input, void *user_data) {
  (void)user_data;
  input->buttons = 0;
  return ESP_OK;
}

static esp_err_t after_turn(const pocketjs_ui_frame_view_t *frame,
                            void *user_data) {
  (void)user_data;
  if (frame->draw_words == NULL || frame->draw_word_count == 0U)
    return ESP_FAIL;
  return ESP_OK;
}

void app_main(void) {
  pocketjs_package_t *package = NULL;
  ESP_ERROR_CHECK(pocketjs_package_open(
      pocketjs_package_runner.data, pocketjs_package_runner.size, 0, &package));
  pocketjs_package_variant_t app = {.struct_size = sizeof(app)};
  ESP_ERROR_CHECK(pocketjs_package_select(
      package, &pocketjs_package_runner_contract, &app));

  pocketjs_guest_config_t guest_config;
  pocketjs_guest_config_defaults(&guest_config);
  pocketjs_guest_t *guest = NULL;
  ESP_ERROR_CHECK(pocketjs_guest_create(&guest_config, &guest));

  pocketjs_ui_core_config_t core_config;
  pocketjs_ui_core_config_defaults(&core_config);
  core_config.logical_width = pocketjs_package_runner_contract.logical_width;
  core_config.logical_height = pocketjs_package_runner_contract.logical_height;
  core_config.raster_density = pocketjs_package_runner_contract.raster_density;
  core_config.tick_hz = pocketjs_package_runner_contract.tick_hz;
  pocketjs_ui_core_t *core = NULL;
  ESP_ERROR_CHECK(pocketjs_ui_core_create(&core_config, &core));

  const pocketjs_ui_qjs_config_t binding_config = {
      .struct_size = sizeof(binding_config),
      .target_id = pocketjs_package_runner_contract.target_id,
      .host_abi = pocketjs_package_runner_contract.host_abi,
  };
  pocketjs_ui_qjs_t *binding = NULL;
  ESP_ERROR_CHECK(
      pocketjs_ui_qjs_create(guest, core, &binding_config, &binding));
  ESP_ERROR_CHECK(
      pocketjs_ui_qjs_feed_pak(binding, app.pak.data, app.pak.size));
  ESP_ERROR_CHECK(pocketjs_ui_qjs_mount(binding));
  ESP_ERROR_CHECK(pocketjs_guest_eval(guest, (const char *)app.javascript.data,
                                      app.javascript.size - 1U, "runner"));

  pocketjs_runner_config_t runner_config;
  pocketjs_runner_config_defaults(&runner_config);
  runner_config.sample_input = sample_input;
  runner_config.after_turn = after_turn;
  pocketjs_runner_t *runner = NULL;
  ESP_ERROR_CHECK(pocketjs_runner_start(binding, &runner_config, &runner));
  vTaskDelay(pdMS_TO_TICKS(1000));
  pocketjs_runner_stats_t stats = {.struct_size = sizeof(stats)};
  ESP_ERROR_CHECK(pocketjs_runner_stats(runner, &stats));
  ESP_ERROR_CHECK(pocketjs_runner_stop(runner));
  ESP_LOGI(TAG, "PASS frames=%" PRIu32 " skipped=%" PRIu32 " errors=%" PRIu32,
           stats.frames, stats.frames_skipped, stats.frame_errors);

  pocketjs_guest_destroy(guest);
  pocketjs_ui_qjs_destroy(binding);
  pocketjs_ui_core_destroy(core);
  pocketjs_package_close(package);
}
