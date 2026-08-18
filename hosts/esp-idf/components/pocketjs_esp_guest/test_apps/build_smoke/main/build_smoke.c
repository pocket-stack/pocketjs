// SPDX-License-Identifier: MIT

#include <assert.h>
#include <string.h>

#include "pocketjs/esp_guest.h"

static const char PROBE_SCRIPT[] =
    "((binding) => {"
    "  if (!Object.isFrozen(binding) || binding.version !== 1) throw new "
    "Error('binding');"
    "  let frames = 0;"
    "  globalThis.pocketProbe = 0;"
    "  globalThis.frame = () => { frames += 1; globalThis.pocketFrames = "
    "frames; };"
    "  globalThis.pocketCall = (value) => value + 1;"
    "  Promise.resolve(21).then((value) => { globalThis.pocketProbe = value * "
    "2; });"
    "})";

void app_main(void) {
  const pocketjs_esp_guest_config_t config = {
      .memory_limit_bytes = 256U * 1024U,
      .stack_limit_bytes = 16U * 1024U,
      .allocate_in_external_memory = false,
      .execution_timeout_us = 100U * 1000U,
      .max_interrupt_checks = 64,
  };
  pocketjs_esp_guest_t *guest = NULL;
  ESP_ERROR_CHECK(pocketjs_esp_guest_create(&config, &guest));
  assert(guest != NULL);
  JSContext *context = pocketjs_esp_guest_context(guest);
  assert(context != NULL);
  JSValue binding = JS_NewObject(context);
  assert(!JS_IsException(binding));
  assert(JS_SetPropertyStr(context, binding, "version",
                           JS_NewInt32(context, 1)) >= 0);
  ESP_ERROR_CHECK(pocketjs_esp_guest_mount_factory(
      guest, "pocketjs-esp-guest-build-smoke.js", PROBE_SCRIPT,
      strlen(PROBE_SCRIPT), binding, NULL));
  JS_FreeValue(context, binding);
  ESP_ERROR_CHECK(pocketjs_esp_guest_call_frame(guest, 0, NULL));
  ESP_ERROR_CHECK(pocketjs_esp_guest_call_frame(guest, 0, NULL));

  size_t jobs = 0;
  bool pending = true;
  ESP_ERROR_CHECK(pocketjs_esp_guest_execute_jobs(guest, 8, &jobs, &pending));
  assert(jobs == 1);
  assert(!pending);

  JSValue global = JS_GetGlobalObject(context);
  JSValue value = JS_GetPropertyStr(context, global, "pocketProbe");
  int32_t probe = 0;
  assert(JS_ToInt32(context, &probe, value) == 0);
  assert(probe == 42);
  JS_FreeValue(context, value);
  value = JS_GetPropertyStr(context, global, "pocketFrames");
  assert(JS_ToInt32(context, &probe, value) == 0);
  assert(probe == 2);
  JS_FreeValue(context, value);
  JSValue call_function = JS_GetPropertyStr(context, global, "pocketCall");
  assert(JS_IsFunction(context, call_function));
  JSValue call_argument = JS_NewInt32(context, 41);
  JSValue call_result = JS_UNDEFINED;
  ESP_ERROR_CHECK(pocketjs_esp_guest_call_function(
      guest, "build_smoke_call", call_function, JS_UNDEFINED, 1,
      &call_argument, &call_result));
  assert(JS_ToInt32(context, &probe, call_result) == 0);
  assert(probe == 42);
  JS_FreeValue(context, call_result);
  JS_FreeValue(context, call_argument);
  JS_FreeValue(context, call_function);
  JS_FreeValue(context, global);

  pocketjs_esp_guest_stats_t stats = {0};
  ESP_ERROR_CHECK(pocketjs_esp_guest_get_stats(guest, &stats));
  assert(stats.allocation_bytes > 0);
  assert(stats.allocation_bytes_high_water >= stats.allocation_bytes);
  assert(stats.engine_memory_used_bytes > 0);
  pocketjs_esp_guest_destroy(guest);
}
