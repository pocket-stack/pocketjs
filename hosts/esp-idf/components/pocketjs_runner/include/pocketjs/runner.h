#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "pocketjs/ui_qjs.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct pocketjs_runner pocketjs_runner_t;

typedef esp_err_t (*pocketjs_runner_sample_input_fn)(pocketjs_ui_input_t *input,
                                                     void *user_data);

typedef esp_err_t (*pocketjs_runner_after_turn_fn)(
    const pocketjs_ui_frame_view_t *frame, void *user_data);

typedef struct {
  size_t struct_size;
  const char *task_name;
  uint32_t task_stack_bytes;
  int task_priority;
  int task_core;
  uint32_t max_lag_us;
  uint32_t stop_timeout_ms;
  pocketjs_runner_sample_input_fn sample_input;
  pocketjs_runner_after_turn_fn after_turn;
  void *user_data;
} pocketjs_runner_config_t;

typedef struct {
  size_t struct_size;
  uint32_t frames;
  uint32_t frames_skipped;
  uint32_t frame_errors;
  uint32_t max_frame_us;
} pocketjs_runner_stats_t;

void pocketjs_runner_config_defaults(pocketjs_runner_config_t *config);
esp_err_t pocketjs_runner_start(pocketjs_ui_qjs_t *binding,
                                const pocketjs_runner_config_t *config,
                                pocketjs_runner_t **out_runner);
esp_err_t pocketjs_runner_stats(pocketjs_runner_t *runner,
                                pocketjs_runner_stats_t *out_stats);
/** Stop and join the owner task from another task. On timeout the runner
 * remains allocated and may be joined by calling stop again. */
esp_err_t pocketjs_runner_stop(pocketjs_runner_t *runner);

#ifdef __cplusplus
}
#endif
