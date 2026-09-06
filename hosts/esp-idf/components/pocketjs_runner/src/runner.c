#include "pocketjs/runner.h"

#include <stdatomic.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

struct pocketjs_runner {
  pocketjs_ui_qjs_t *binding;
  pocketjs_runner_config_t config;
  uint32_t tick_hz;
  SemaphoreHandle_t wake;
  SemaphoreHandle_t exited;
  SemaphoreHandle_t stats_lock;
  atomic_bool stopping;
  pocketjs_runner_stats_t stats;
};

void pocketjs_runner_config_defaults(pocketjs_runner_config_t *config) {
  if (config != NULL) {
    *config = (pocketjs_runner_config_t){
        .struct_size = sizeof(*config),
        .task_name = "pocketjs",
        .task_stack_bytes = 32U * 1024U,
        .task_priority = 5,
        .task_core = tskNO_AFFINITY,
        .max_lag_us = 500000,
        .stop_timeout_ms = 5000,
    };
  }
}

static void wait_until(pocketjs_runner_t *runner, int64_t deadline) {
  while (!atomic_load_explicit(&runner->stopping, memory_order_relaxed)) {
    const int64_t remaining = deadline - esp_timer_get_time();
    if (remaining <= 0)
      return;
    if (remaining > 2000) {
      const TickType_t ticks = pdMS_TO_TICKS((uint32_t)(remaining / 1000));
      (void)xSemaphoreTake(runner->wake, ticks > 1 ? ticks - 1 : 1);
    } else {
      taskYIELD();
    }
  }
}

static void runner_task(void *opaque) {
  pocketjs_runner_t *runner = opaque;
  const int64_t started = esp_timer_get_time();
  uint64_t tick = 0;
  while (!atomic_load_explicit(&runner->stopping, memory_order_relaxed)) {
    const int64_t deadline =
        started + (int64_t)((tick * UINT64_C(1000000)) / runner->tick_hz);
    wait_until(runner, deadline);
    if (atomic_load_explicit(&runner->stopping, memory_order_relaxed))
      break;
    const int64_t now = esp_timer_get_time();
    if (now - deadline > runner->config.max_lag_us) {
      const uint64_t current =
          (uint64_t)(now - started) * runner->tick_hz / UINT64_C(1000000);
      if (current > tick) {
        xSemaphoreTake(runner->stats_lock, portMAX_DELAY);
        runner->stats.frames_skipped += (uint32_t)(current - tick);
        xSemaphoreGive(runner->stats_lock);
        tick = current;
      }
    }
    pocketjs_ui_input_t input = {.struct_size = sizeof(input)};
    esp_err_t result = ESP_OK;
    if (runner->config.sample_input != NULL) {
      result = runner->config.sample_input(&input, runner->config.user_data);
    }
    pocketjs_ui_frame_view_t frame = {.struct_size = sizeof(frame)};
    const int64_t frame_started = esp_timer_get_time();
    if (result == ESP_OK) {
      result = pocketjs_ui_turn(runner->binding, &input, &frame);
    }
    if (result == ESP_OK && runner->config.after_turn != NULL) {
      result = runner->config.after_turn(&frame, runner->config.user_data);
    }
    const uint32_t elapsed = (uint32_t)(esp_timer_get_time() - frame_started);
    xSemaphoreTake(runner->stats_lock, portMAX_DELAY);
    runner->stats.frames++;
    if (result != ESP_OK)
      runner->stats.frame_errors++;
    if (elapsed > runner->stats.max_frame_us)
      runner->stats.max_frame_us = elapsed;
    xSemaphoreGive(runner->stats_lock);
    tick++;
  }
  xSemaphoreGive(runner->exited);
  vTaskDelete(NULL);
}

esp_err_t pocketjs_runner_start(pocketjs_ui_qjs_t *binding,
                                const pocketjs_runner_config_t *config,
                                pocketjs_runner_t **out_runner) {
  if (binding == NULL || config == NULL || out_runner == NULL ||
      config->struct_size < sizeof(*config) ||
      config->task_stack_bytes < 4096U || config->max_lag_us == 0U ||
      config->stop_timeout_ms == 0U) {
    return ESP_ERR_INVALID_ARG;
  }
  *out_runner = NULL;
  pocketjs_runner_t *runner = calloc(1, sizeof(*runner));
  if (runner == NULL)
    return ESP_ERR_NO_MEM;
  runner->binding = binding;
  runner->config = *config;
  runner->tick_hz = pocketjs_ui_qjs_tick_hz(binding);
  if (runner->tick_hz == 0U) {
    free(runner);
    return ESP_ERR_INVALID_ARG;
  }
  atomic_init(&runner->stopping, false);
  runner->stats.struct_size = sizeof(runner->stats);
  runner->wake = xSemaphoreCreateBinary();
  runner->exited = xSemaphoreCreateBinary();
  runner->stats_lock = xSemaphoreCreateMutex();
  if (runner->wake == NULL || runner->exited == NULL ||
      runner->stats_lock == NULL) {
    if (runner->wake != NULL)
      vSemaphoreDelete(runner->wake);
    if (runner->exited != NULL)
      vSemaphoreDelete(runner->exited);
    if (runner->stats_lock != NULL)
      vSemaphoreDelete(runner->stats_lock);
    free(runner);
    return ESP_ERR_NO_MEM;
  }
  const BaseType_t created = xTaskCreatePinnedToCore(
      runner_task, config->task_name != NULL ? config->task_name : "pocketjs",
      config->task_stack_bytes, runner, config->task_priority, NULL,
      config->task_core);
  if (created != pdPASS) {
    vSemaphoreDelete(runner->wake);
    vSemaphoreDelete(runner->exited);
    vSemaphoreDelete(runner->stats_lock);
    free(runner);
    return ESP_ERR_NO_MEM;
  }
  *out_runner = runner;
  return ESP_OK;
}

esp_err_t pocketjs_runner_stats(pocketjs_runner_t *runner,
                                pocketjs_runner_stats_t *out_stats) {
  if (runner == NULL || out_stats == NULL ||
      out_stats->struct_size < sizeof(*out_stats)) {
    return ESP_ERR_INVALID_ARG;
  }
  const size_t output_size = out_stats->struct_size;
  xSemaphoreTake(runner->stats_lock, portMAX_DELAY);
  *out_stats = runner->stats;
  xSemaphoreGive(runner->stats_lock);
  out_stats->struct_size = output_size;
  return ESP_OK;
}

esp_err_t pocketjs_runner_stop(pocketjs_runner_t *runner) {
  if (runner == NULL)
    return ESP_ERR_INVALID_ARG;
  atomic_store_explicit(&runner->stopping, true, memory_order_relaxed);
  pocketjs_ui_qjs_interrupt(runner->binding);
  (void)xSemaphoreGive(runner->wake);
  if (xSemaphoreTake(runner->exited,
                     pdMS_TO_TICKS(runner->config.stop_timeout_ms)) != pdTRUE) {
    return ESP_ERR_TIMEOUT;
  }
  vSemaphoreDelete(runner->wake);
  vSemaphoreDelete(runner->exited);
  vSemaphoreDelete(runner->stats_lock);
  free(runner);
  return ESP_OK;
}
