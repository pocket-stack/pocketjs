// SPDX-License-Identifier: MIT

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "quickjs.h"

#ifdef __cplusplus
extern "C" {
#endif

#define POCKETJS_ESP_GUEST_ENGINE_ID "quickjs-ng"
#define POCKETJS_ESP_GUEST_ENGINE_VERSION "0.14.0"

typedef struct pocketjs_esp_guest pocketjs_esp_guest_t;

typedef struct {
  /** Zero keeps the engine default. */
  size_t memory_limit_bytes;
  /** Zero keeps the engine default. */
  size_t stack_limit_bytes;
  /** Require every engine allocation to come from external RAM. */
  bool allocate_in_external_memory;
  /** Abort one eval, call, or job checkpoint after this many microseconds. */
  uint64_t execution_timeout_us;
  /** Abort after this many QuickJS interrupt checks (one check per 10k polls).
   */
  uint32_t max_interrupt_checks;
} pocketjs_esp_guest_config_t;

typedef struct {
  size_t allocation_bytes;
  size_t allocation_bytes_high_water;
  size_t external_allocation_bytes;
  size_t external_allocation_bytes_high_water;
  size_t allocation_count;
  size_t allocation_count_high_water;
  size_t engine_memory_used_bytes;
  size_t engine_object_count;
  /** Total one-tick FreeRTOS yields during bounded Guest execution. */
  uint32_t cooperative_yields;
} pocketjs_esp_guest_stats_t;

/**
 * Create one QuickJS runtime and realm owned by the calling FreeRTOS task.
 * Every later call, including destruction, must run on that same task.
 */
esp_err_t pocketjs_esp_guest_create(const pocketjs_esp_guest_config_t *config,
                                    pocketjs_esp_guest_t **out_guest);

/**
 * Return the realm context so a product Host can install private bindings
 * before evaluating the Guest bootstrap. The pointer is borrowed and remains
 * valid only until pocketjs_esp_guest_destroy().
 */
JSContext *pocketjs_esp_guest_context(pocketjs_esp_guest_t *guest);

/**
 * Evaluate one NUL-terminated global-script bundle. source_length excludes the
 * terminator and source[source_length] must be zero.
 */
esp_err_t pocketjs_esp_guest_eval(pocketjs_esp_guest_t *guest,
                                  const char *label, const char *source,
                                  size_t source_length);

/**
 * Evaluate a bundle whose completion value is a factory function, freeze the
 * borrowed private binding object, and call factory(binding). The factory must
 * install a callable globalThis.frame, which is cached by the Host. The binding
 * is not consumed. A non-NULL out_result receives an owned JSValue; otherwise
 * the call result is released before returning.
 */
esp_err_t
pocketjs_esp_guest_mount_factory(pocketjs_esp_guest_t *guest, const char *label,
                                 const char *source, size_t source_length,
                                 JSValueConst binding, JSValue *out_result);

/** Call the frame function cached by mount_factory(). Arguments are borrowed.
 */
esp_err_t pocketjs_esp_guest_call_frame(pocketjs_esp_guest_t *guest,
                                        size_t argument_count,
                                        JSValueConst *arguments);

/**
 * Call a borrowed Guest function under the same interrupt-check and monotonic
 * timeout guard used by bundle, frame, and job execution. The receiver and
 * arguments are borrowed. A non-NULL out_result receives an owned JSValue on
 * success; it is set to JS_UNDEFINED on entry and remains so on failure.
 * phase is a Host-selected non-sensitive diagnostic label.
 */
esp_err_t pocketjs_esp_guest_call_function(
    pocketjs_esp_guest_t *guest, const char *phase, JSValueConst function,
    JSValueConst receiver, size_t argument_count, JSValueConst *arguments,
    JSValue *out_result);

/**
 * Execute at most max_jobs pending Promise jobs on the owner task. A zero
 * max_jobs is invalid. out_executed and out_pending may be NULL. A true
 * out_pending means the caller must schedule another bounded checkpoint.
 */
esp_err_t pocketjs_esp_guest_execute_jobs(pocketjs_esp_guest_t *guest,
                                          size_t max_jobs, size_t *out_executed,
                                          bool *out_pending);

/** Snapshot allocator counters on the owner task. */
esp_err_t pocketjs_esp_guest_get_stats(pocketjs_esp_guest_t *guest,
                                       pocketjs_esp_guest_stats_t *out_stats);

/** Log and clear the current QuickJS exception on the owner task. */
void pocketjs_esp_guest_log_exception(pocketjs_esp_guest_t *guest,
                                      const char *phase);

/** Release the realm and runtime on their owner task. */
void pocketjs_esp_guest_destroy(pocketjs_esp_guest_t *guest);

#ifdef __cplusplus
}
#endif
