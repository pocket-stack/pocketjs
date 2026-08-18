// SPDX-License-Identifier: MIT

#include "pocketjs/esp_guest.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_memory_utils.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define POCKETJS_ESP_GUEST_CONSOLE_BYTES 384U
#define POCKETJS_ESP_GUEST_YIELD_INTERVAL_US INT64_C(100000)
#define POCKETJS_ESP_GUEST_ALLOCATIONS_PER_YIELD_CHECK 64U

static const char *TAG = "pocketjs_guest";

struct pocketjs_esp_guest {
  JSRuntime *runtime;
  JSContext *context;
  JSValue frame_function;
  TaskHandle_t owner_task;
  pocketjs_esp_guest_stats_t stats;
  bool allocate_in_external_memory;
  bool mounted;
  bool executing;
  bool interrupted;
  uint64_t execution_timeout_us;
  int64_t execution_deadline_us;
  uint32_t max_interrupt_checks;
  uint32_t interrupt_checks_remaining;
  uint32_t allocations_until_yield_check;
  int64_t cooperative_yield_deadline_us;
};

static void guest_maybe_cooperative_yield(pocketjs_esp_guest_t *guest) {
  if (!guest->executing ||
      esp_timer_get_time() < guest->cooperative_yield_deadline_us) {
    return;
  }

  /* A ready owner task outranks the idle task, so taskYIELD() is insufficient
   * to let the idle task service the task watchdog during a large source
   * parse. Blocking for one scheduler tick preserves bounded execution while
   * keeping parser and bytecode work cooperative with the rest of the Host. */
  vTaskDelay(1);
  ++guest->stats.cooperative_yields;
  const int64_t now = esp_timer_get_time();
  guest->cooperative_yield_deadline_us =
      now > INT64_MAX - POCKETJS_ESP_GUEST_YIELD_INTERVAL_US
          ? INT64_MAX
          : now + POCKETJS_ESP_GUEST_YIELD_INTERVAL_US;
}

static void guest_allocation_checkpoint(pocketjs_esp_guest_t *guest) {
  if (!guest->executing) {
    return;
  }
  if (guest->allocations_until_yield_check > 1U) {
    --guest->allocations_until_yield_check;
    return;
  }
  guest->allocations_until_yield_check =
      POCKETJS_ESP_GUEST_ALLOCATIONS_PER_YIELD_CHECK;
  guest_maybe_cooperative_yield(guest);
}

static size_t guest_allocation_size(const void *pointer) {
  return pointer != NULL ? heap_caps_get_allocated_size((void *)pointer) : 0;
}

static void guest_record_allocation(pocketjs_esp_guest_t *guest,
                                    void *pointer) {
  if (pointer == NULL) {
    return;
  }
  const size_t size = guest_allocation_size(pointer);
  guest->stats.allocation_bytes += size;
  ++guest->stats.allocation_count;
  if (esp_ptr_external_ram(pointer)) {
    guest->stats.external_allocation_bytes += size;
  }
  if (guest->stats.allocation_bytes >
      guest->stats.allocation_bytes_high_water) {
    guest->stats.allocation_bytes_high_water = guest->stats.allocation_bytes;
  }
  if (guest->stats.external_allocation_bytes >
      guest->stats.external_allocation_bytes_high_water) {
    guest->stats.external_allocation_bytes_high_water =
        guest->stats.external_allocation_bytes;
  }
  if (guest->stats.allocation_count >
      guest->stats.allocation_count_high_water) {
    guest->stats.allocation_count_high_water = guest->stats.allocation_count;
  }
  guest_allocation_checkpoint(guest);
}

static void guest_record_free(pocketjs_esp_guest_t *guest, void *pointer) {
  if (pointer == NULL) {
    return;
  }
  const size_t size = guest_allocation_size(pointer);
  guest->stats.allocation_bytes -= size;
  --guest->stats.allocation_count;
  if (esp_ptr_external_ram(pointer)) {
    guest->stats.external_allocation_bytes -= size;
  }
}

static void *guest_heap_malloc(void *opaque, size_t size) {
  pocketjs_esp_guest_t *guest = opaque;
  void *pointer =
      guest->allocate_in_external_memory
          ? heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
          : heap_caps_malloc(size, MALLOC_CAP_8BIT);
  guest_record_allocation(guest, pointer);
  return pointer;
}

static void *guest_heap_calloc(void *opaque, size_t count, size_t size) {
  pocketjs_esp_guest_t *guest = opaque;
  if (size != 0 && count > SIZE_MAX / size) {
    return NULL;
  }
  void *pointer =
      guest->allocate_in_external_memory
          ? heap_caps_calloc(count, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
          : heap_caps_calloc(count, size, MALLOC_CAP_8BIT);
  guest_record_allocation(guest, pointer);
  return pointer;
}

static void guest_heap_free(void *opaque, void *pointer) {
  pocketjs_esp_guest_t *guest = opaque;
  guest_record_free(guest, pointer);
  heap_caps_free(pointer);
}

static void *guest_heap_realloc(void *opaque, void *pointer, size_t size) {
  pocketjs_esp_guest_t *guest = opaque;
  if (size == 0) {
    guest_heap_free(opaque, pointer);
    return NULL;
  }

  const size_t old_size = guest_allocation_size(pointer);
  const bool old_external = pointer != NULL && esp_ptr_external_ram(pointer);
  void *replacement =
      guest->allocate_in_external_memory
          ? heap_caps_realloc(pointer, size,
                              MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
          : heap_caps_realloc(pointer, size, MALLOC_CAP_8BIT);
  if (replacement == NULL) {
    return NULL;
  }

  if (pointer != NULL) {
    guest->stats.allocation_bytes -= old_size;
    if (old_external) {
      guest->stats.external_allocation_bytes -= old_size;
    }
    --guest->stats.allocation_count;
  }
  guest_record_allocation(guest, replacement);
  return replacement;
}

static size_t guest_heap_usable_size(const void *pointer) {
  return guest_allocation_size(pointer);
}

static const JSMallocFunctions GUEST_ALLOCATOR = {
    .js_calloc = guest_heap_calloc,
    .js_malloc = guest_heap_malloc,
    .js_free = guest_heap_free,
    .js_realloc = guest_heap_realloc,
    .js_malloc_usable_size = guest_heap_usable_size,
};

static int guest_interrupt(JSRuntime *runtime, void *opaque) {
  (void)runtime;
  pocketjs_esp_guest_t *guest = opaque;
  if (!guest->executing) {
    return 0;
  }
  guest_maybe_cooperative_yield(guest);
  if (guest->max_interrupt_checks != 0) {
    if (guest->interrupt_checks_remaining == 0) {
      guest->interrupted = true;
      return 1;
    }
    --guest->interrupt_checks_remaining;
  }
  if (guest->execution_timeout_us != 0 &&
      esp_timer_get_time() >= guest->execution_deadline_us) {
    guest->interrupted = true;
    return 1;
  }
  return 0;
}

static esp_err_t guest_begin_execution(pocketjs_esp_guest_t *guest) {
  if (guest->executing) {
    return ESP_ERR_INVALID_STATE;
  }
  guest->executing = true;
  guest->interrupted = false;
  guest->interrupt_checks_remaining = guest->max_interrupt_checks;
  const int64_t now = esp_timer_get_time();
  guest->execution_deadline_us =
      guest->execution_timeout_us > (uint64_t)(INT64_MAX - now)
          ? INT64_MAX
          : now + (int64_t)guest->execution_timeout_us;
  guest->allocations_until_yield_check =
      POCKETJS_ESP_GUEST_ALLOCATIONS_PER_YIELD_CHECK;
  guest->cooperative_yield_deadline_us =
      now > INT64_MAX - POCKETJS_ESP_GUEST_YIELD_INTERVAL_US
          ? INT64_MAX
          : now + POCKETJS_ESP_GUEST_YIELD_INTERVAL_US;
  return ESP_OK;
}

static esp_err_t guest_end_execution(pocketjs_esp_guest_t *guest,
                                     bool exception) {
  const bool interrupted = guest->interrupted;
  guest->executing = false;
  guest->interrupted = false;
  if (interrupted) {
    return ESP_ERR_TIMEOUT;
  }
  return exception ? ESP_FAIL : ESP_OK;
}

static bool guest_is_owner(const pocketjs_esp_guest_t *guest) {
  return guest != NULL && guest->owner_task == xTaskGetCurrentTaskHandle();
}

static JSValue guest_console(JSContext *context, JSValueConst this_value,
                             int argument_count, JSValueConst *arguments,
                             int magic) {
  (void)this_value;

  char line[POCKETJS_ESP_GUEST_CONSOLE_BYTES];
  size_t used = 0;
  line[0] = '\0';

  for (int index = 0; index < argument_count; ++index) {
    const char *text = JS_ToCString(context, arguments[index]);
    if (text == NULL) {
      continue;
    }

    if (used != 0 && used + 1 < sizeof(line)) {
      line[used++] = ' ';
    }
    const size_t available = sizeof(line) - used - 1;
    const size_t length = strnlen(text, available);
    memcpy(&line[used], text, length);
    used += length;
    line[used] = '\0';
    JS_FreeCString(context, text);
  }

  switch (magic) {
  case ESP_LOG_ERROR:
    ESP_LOGE(TAG, "POCKETJS_GUEST_CONSOLE %s", line);
    break;
  case ESP_LOG_WARN:
    ESP_LOGW(TAG, "POCKETJS_GUEST_CONSOLE %s", line);
    break;
  case ESP_LOG_DEBUG:
    ESP_LOGD(TAG, "POCKETJS_GUEST_CONSOLE %s", line);
    break;
  default:
    ESP_LOGI(TAG, "POCKETJS_GUEST_CONSOLE %s", line);
    break;
  }
  return JS_UNDEFINED;
}

static bool set_console_method(JSContext *context, JSValue console,
                               const char *name, int level) {
  JSValue function = JS_NewCFunctionMagic(context, guest_console, name, 1,
                                          JS_CFUNC_generic_magic, level);
  if (JS_IsException(function)) {
    return false;
  }
  if (JS_SetPropertyStr(context, console, name, function) < 0) {
    return false;
  }
  return true;
}

static bool install_console(JSContext *context) {
  JSValue console = JS_NewObject(context);
  if (JS_IsException(console)) {
    return false;
  }

  const bool installed =
      set_console_method(context, console, "log", ESP_LOG_INFO) &&
      set_console_method(context, console, "info", ESP_LOG_INFO) &&
      set_console_method(context, console, "warn", ESP_LOG_WARN) &&
      set_console_method(context, console, "error", ESP_LOG_ERROR) &&
      set_console_method(context, console, "debug", ESP_LOG_DEBUG);
  if (!installed) {
    JS_FreeValue(context, console);
    return false;
  }

  JSValue global = JS_GetGlobalObject(context);
  if (JS_IsException(global)) {
    JS_FreeValue(context, console);
    return false;
  }
  const int result = JS_SetPropertyStr(context, global, "console", console);
  JS_FreeValue(context, global);
  return result >= 0;
}

static void log_context_exception(JSContext *context, const char *phase) {
  JSValue exception = JS_GetException(context);
  const char *message = JS_ToCString(context, exception);
  JSValue stack = JS_GetPropertyStr(context, exception, "stack");
  const char *stack_text = JS_IsException(stack) || JS_IsUndefined(stack)
                               ? NULL
                               : JS_ToCString(context, stack);

  ESP_LOGE(TAG, "POCKETJS_GUEST_EXCEPTION phase=%s message=%s", phase,
           message != NULL ? message : "<unprintable>");
  if (stack_text != NULL && stack_text[0] != '\0') {
    ESP_LOGE(TAG, "POCKETJS_GUEST_STACK %s", stack_text);
  }

  if (stack_text != NULL) {
    JS_FreeCString(context, stack_text);
  }
  JS_FreeValue(context, stack);
  if (message != NULL) {
    JS_FreeCString(context, message);
  }
  JS_FreeValue(context, exception);
}

esp_err_t pocketjs_esp_guest_create(const pocketjs_esp_guest_config_t *config,
                                    pocketjs_esp_guest_t **out_guest) {
  if (out_guest == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  *out_guest = NULL;

  pocketjs_esp_guest_t *guest = calloc(1, sizeof(*guest));
  if (guest == NULL) {
    return ESP_ERR_NO_MEM;
  }

  guest->owner_task = xTaskGetCurrentTaskHandle();
  guest->frame_function = JS_UNDEFINED;
  guest->allocate_in_external_memory =
      config != NULL && config->allocate_in_external_memory;
  guest->execution_timeout_us =
      config != NULL ? config->execution_timeout_us : 0;
  guest->max_interrupt_checks =
      config != NULL ? config->max_interrupt_checks : 0;
  guest->runtime = JS_NewRuntime2(&GUEST_ALLOCATOR, guest);
  if (guest->runtime == NULL) {
    free(guest);
    return ESP_ERR_NO_MEM;
  }
  JS_SetInterruptHandler(guest->runtime, guest_interrupt, guest);
  JS_SetCanBlock(guest->runtime, false);

  if (config != NULL && config->memory_limit_bytes != 0) {
    JS_SetMemoryLimit(guest->runtime, config->memory_limit_bytes);
  }
  if (config != NULL && config->stack_limit_bytes != 0) {
    JS_SetMaxStackSize(guest->runtime, config->stack_limit_bytes);
  }

  guest->context = JS_NewContext(guest->runtime);
  if (guest->context == NULL) {
    JS_FreeRuntime(guest->runtime);
    free(guest);
    return ESP_ERR_NO_MEM;
  }
  if (!install_console(guest->context)) {
    log_context_exception(guest->context, "install_console");
    JS_FreeContext(guest->context);
    JS_FreeRuntime(guest->runtime);
    free(guest);
    return ESP_FAIL;
  }

  *out_guest = guest;
  ESP_LOGI(TAG,
           "POCKETJS_GUEST_READY engine=%s version=%s memory_limit=%u "
           "stack_limit=%u external_required=%d timeout_us=%llu "
           "interrupt_checks=%u",
           POCKETJS_ESP_GUEST_ENGINE_ID, POCKETJS_ESP_GUEST_ENGINE_VERSION,
           config != NULL ? (unsigned)config->memory_limit_bytes : 0,
           config != NULL ? (unsigned)config->stack_limit_bytes : 0,
           guest->allocate_in_external_memory,
           (unsigned long long)guest->execution_timeout_us,
           (unsigned)guest->max_interrupt_checks);
  return ESP_OK;
}

JSContext *pocketjs_esp_guest_context(pocketjs_esp_guest_t *guest) {
  if (!guest_is_owner(guest)) {
    return NULL;
  }
  return guest->context;
}

esp_err_t pocketjs_esp_guest_eval(pocketjs_esp_guest_t *guest,
                                  const char *label, const char *source,
                                  size_t source_length) {
  if (!guest_is_owner(guest) || label == NULL || source == NULL ||
      source_length == 0 || source[source_length] != '\0') {
    return ESP_ERR_INVALID_ARG;
  }

  esp_err_t error = guest_begin_execution(guest);
  if (error != ESP_OK) {
    return error;
  }

  JSValue result = JS_Eval(guest->context, source, source_length, label,
                           JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(result)) {
    log_context_exception(guest->context, "eval");
    JS_FreeValue(guest->context, result);
    return guest_end_execution(guest, true);
  }
  JS_FreeValue(guest->context, result);
  return guest_end_execution(guest, false);
}

esp_err_t
pocketjs_esp_guest_mount_factory(pocketjs_esp_guest_t *guest, const char *label,
                                 const char *source, size_t source_length,
                                 JSValueConst binding, JSValue *out_result) {
  if (!guest_is_owner(guest) || label == NULL || source == NULL ||
      source_length == 0 || source[source_length] != '\0' ||
      !JS_IsObject(binding) || guest->mounted) {
    return ESP_ERR_INVALID_ARG;
  }
  if (out_result != NULL) {
    *out_result = JS_UNDEFINED;
  }

  esp_err_t error = guest_begin_execution(guest);
  if (error != ESP_OK) {
    return error;
  }
  if (JS_FreezeObject(guest->context, binding) < 0) {
    log_context_exception(guest->context, "freeze_binding");
    return guest_end_execution(guest, true);
  }

  JSValue factory = JS_Eval(guest->context, source, source_length, label,
                            JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(factory)) {
    log_context_exception(guest->context, "eval_factory");
    JS_FreeValue(guest->context, factory);
    return guest_end_execution(guest, true);
  }
  if (!JS_IsFunction(guest->context, factory)) {
    JS_FreeValue(guest->context, factory);
    JS_ThrowTypeError(guest->context,
                      "PocketJS Guest bundle must evaluate to a factory");
    log_context_exception(guest->context, "validate_factory");
    return guest_end_execution(guest, true);
  }

  JSValueConst arguments[] = {binding};
  JSValue result = JS_Call(guest->context, factory, JS_UNDEFINED, 1, arguments);
  JS_FreeValue(guest->context, factory);
  if (JS_IsException(result)) {
    log_context_exception(guest->context, "call_factory");
    JS_FreeValue(guest->context, result);
    return guest_end_execution(guest, true);
  }

  JSValue global = JS_GetGlobalObject(guest->context);
  JSValue frame = JS_IsException(global)
                      ? JS_EXCEPTION
                      : JS_GetPropertyStr(guest->context, global, "frame");
  JS_FreeValue(guest->context, global);
  if (JS_IsException(frame) || !JS_IsFunction(guest->context, frame)) {
    JS_FreeValue(guest->context, frame);
    JS_FreeValue(guest->context, result);
    JS_ThrowTypeError(guest->context,
                      "PocketJS Guest factory must install globalThis.frame");
    log_context_exception(guest->context, "capture_frame");
    return guest_end_execution(guest, true);
  }
  guest->frame_function = frame;
  guest->mounted = true;
  if (out_result != NULL) {
    *out_result = result;
  } else {
    JS_FreeValue(guest->context, result);
  }
  return guest_end_execution(guest, false);
}

esp_err_t pocketjs_esp_guest_call_frame(pocketjs_esp_guest_t *guest,
                                        size_t argument_count,
                                        JSValueConst *arguments) {
  if (!guest_is_owner(guest) || !guest->mounted || argument_count > INT32_MAX ||
      (argument_count != 0 && arguments == NULL)) {
    return ESP_ERR_INVALID_ARG;
  }
  esp_err_t error = guest_begin_execution(guest);
  if (error != ESP_OK) {
    return error;
  }
  JSValue global = JS_GetGlobalObject(guest->context);
  if (JS_IsException(global)) {
    log_context_exception(guest->context, "get_frame_receiver");
    JS_FreeValue(guest->context, global);
    return guest_end_execution(guest, true);
  }
  JSValue result = JS_Call(guest->context, guest->frame_function, global,
                           (int)argument_count, arguments);
  JS_FreeValue(guest->context, global);
  if (JS_IsException(result)) {
    log_context_exception(guest->context, "call_frame");
    JS_FreeValue(guest->context, result);
    return guest_end_execution(guest, true);
  }
  JS_FreeValue(guest->context, result);
  return guest_end_execution(guest, false);
}

esp_err_t pocketjs_esp_guest_call_function(
    pocketjs_esp_guest_t *guest, const char *phase, JSValueConst function,
    JSValueConst receiver, size_t argument_count, JSValueConst *arguments,
    JSValue *out_result) {
  if (out_result != NULL) {
    *out_result = JS_UNDEFINED;
  }
  if (!guest_is_owner(guest) || phase == NULL ||
      !JS_IsFunction(guest->context, function) || argument_count > INT32_MAX ||
      (argument_count != 0 && arguments == NULL)) {
    return ESP_ERR_INVALID_ARG;
  }

  esp_err_t error = guest_begin_execution(guest);
  if (error != ESP_OK) {
    return error;
  }
  JSValue result = JS_Call(guest->context, function, receiver,
                           (int)argument_count, arguments);
  if (JS_IsException(result)) {
    log_context_exception(guest->context, phase);
    JS_FreeValue(guest->context, result);
    return guest_end_execution(guest, true);
  }
  if (out_result != NULL) {
    *out_result = result;
  } else {
    JS_FreeValue(guest->context, result);
  }
  return guest_end_execution(guest, false);
}

esp_err_t pocketjs_esp_guest_execute_jobs(pocketjs_esp_guest_t *guest,
                                          size_t max_jobs, size_t *out_executed,
                                          bool *out_pending) {
  if (!guest_is_owner(guest) || max_jobs == 0) {
    return ESP_ERR_INVALID_ARG;
  }
  if (out_executed != NULL) {
    *out_executed = 0;
  }
  if (out_pending != NULL) {
    *out_pending = false;
  }
  esp_err_t error = guest_begin_execution(guest);
  if (error != ESP_OK) {
    return error;
  }
  size_t executed = 0;
  while (executed < max_jobs) {
    JSContext *job_context = NULL;
    const int result = JS_ExecutePendingJob(guest->runtime, &job_context);
    if (result == 0) {
      break;
    }
    if (result < 0) {
      log_context_exception(job_context != NULL ? job_context : guest->context,
                            "pending_job");
      if (out_executed != NULL) {
        *out_executed = executed;
      }
      if (out_pending != NULL) {
        *out_pending = JS_IsJobPending(guest->runtime);
      }
      return guest_end_execution(guest, true);
    }
    ++executed;
  }
  if (out_executed != NULL) {
    *out_executed = executed;
  }
  if (out_pending != NULL) {
    *out_pending = JS_IsJobPending(guest->runtime);
  }
  return guest_end_execution(guest, false);
}

esp_err_t pocketjs_esp_guest_get_stats(pocketjs_esp_guest_t *guest,
                                       pocketjs_esp_guest_stats_t *out_stats) {
  if (!guest_is_owner(guest) || out_stats == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  *out_stats = guest->stats;
  JSMemoryUsage usage = {0};
  JS_ComputeMemoryUsage(guest->runtime, &usage);
  if (usage.memory_used_size > 0) {
    out_stats->engine_memory_used_bytes = (size_t)usage.memory_used_size;
  }
  if (usage.obj_count > 0) {
    out_stats->engine_object_count = (size_t)usage.obj_count;
  }
  return ESP_OK;
}

void pocketjs_esp_guest_log_exception(pocketjs_esp_guest_t *guest,
                                      const char *phase) {
  if (!guest_is_owner(guest)) {
    return;
  }
  log_context_exception(guest->context, phase != NULL ? phase : "unknown");
}

void pocketjs_esp_guest_destroy(pocketjs_esp_guest_t *guest) {
  if (!guest_is_owner(guest)) {
    return;
  }
  JS_FreeValue(guest->context, guest->frame_function);
  JS_FreeContext(guest->context);
  JS_FreeRuntime(guest->runtime);
  free(guest);
}
