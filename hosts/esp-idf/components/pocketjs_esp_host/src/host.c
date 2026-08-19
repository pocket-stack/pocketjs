/* PocketJS ESP-IDF host: guest owner task, network task, lifecycle. */
#include "host_internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"

static const char *TAG = "pocketjs";

/* ------------------------------------------------------------------------ */
/* Config                                                                    */
/* ------------------------------------------------------------------------ */

void pocketjs_esp_host_config_defaults(pocketjs_esp_host_config *cfg) {
  memset(cfg, 0, sizeof *cfg);
  cfg->tick_hz = 60;
  cfg->guest_memory_limit = 4 * 1024 * 1024;
  cfg->guest_stack_limit = 0;
  cfg->guest_in_psram = true;
  cfg->guest_task_stack = 32 * 1024;
  cfg->guest_task_priority = 5;
  cfg->guest_task_core = tskNO_AFFINITY;
  cfg->net_task_stack = 12 * 1024;
  cfg->net_task_priority = 8;
  cfg->net_task_core = tskNO_AFFINITY;
  cfg->stop_turn_budget_ms = 50;
  cfg->network_policy_json = NULL;
  cfg->plan_hash = NULL;
  cfg->network_tls = false;
  cfg->wall_clock_trusted = NULL;
  cfg->mount_websocket_client = true;
  cfg->mount_http_server = true;
  cfg->network_config = NULL;
  cfg->network_max_sockets = 12;
}

/* ------------------------------------------------------------------------ */
/* QuickJS allocator: PSRAM when requested, byte accounting                  */
/* ------------------------------------------------------------------------ */

static uint32_t heap_caps_for(pocketjs_esp_host_t *host) {
  return host->cfg.guest_in_psram ? (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) : MALLOC_CAP_8BIT;
}

static void account(pocketjs_esp_host_t *host, void *ptr, bool add) {
  if (!ptr) return;
  size_t size = heap_caps_get_allocated_size(ptr);
  if (add) {
    host->guest_heap += size;
    if (host->guest_heap > host->guest_heap_high_water) host->guest_heap_high_water = host->guest_heap;
  } else {
    host->guest_heap = host->guest_heap >= size ? host->guest_heap - size : 0;
  }
}

static void *guest_calloc(void *opaque, size_t count, size_t size) {
  pocketjs_esp_host_t *host = opaque;
  void *p = heap_caps_calloc(count, size, heap_caps_for(host));
  account(host, p, true);
  return p;
}

static void *guest_malloc(void *opaque, size_t size) {
  pocketjs_esp_host_t *host = opaque;
  void *p = heap_caps_malloc(size, heap_caps_for(host));
  account(host, p, true);
  return p;
}

static void guest_free(void *opaque, void *ptr) {
  pocketjs_esp_host_t *host = opaque;
  account(host, ptr, false);
  heap_caps_free(ptr);
}

static void *guest_realloc(void *opaque, void *ptr, size_t size) {
  pocketjs_esp_host_t *host = opaque;
  if (size == 0) {
    guest_free(opaque, ptr);
    return NULL;
  }
  account(host, ptr, false);
  void *p = heap_caps_realloc(ptr, size, heap_caps_for(host));
  if (!p) {
    account(host, ptr, true);
    return NULL;
  }
  account(host, p, true);
  return p;
}

static size_t guest_usable_size(const void *ptr) {
  return ptr ? heap_caps_get_allocated_size((void *)ptr) : 0;
}

static const JSMallocFunctions GUEST_ALLOC = {
    .js_calloc = guest_calloc,
    .js_malloc = guest_malloc,
    .js_free = guest_free,
    .js_realloc = guest_realloc,
    .js_malloc_usable_size = guest_usable_size,
};

/* ------------------------------------------------------------------------ */
/* Network core platform                                                     */
/* ------------------------------------------------------------------------ */

static uint64_t plat_now_ms(void *ctx) {
  (void)ctx;
  return (uint64_t)(esp_timer_get_time() / 1000);
}

static void *plat_alloc(void *ctx, size_t size) {
  (void)ctx;
  /* Prefer PSRAM for payload buffers; fall back to internal RAM. */
  void *p = heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!p) p = heap_caps_malloc(size, MALLOC_CAP_8BIT);
  return p;
}

static void plat_free(void *ctx, void *ptr, size_t size) {
  (void)ctx;
  (void)size;
  heap_caps_free(ptr);
}

static void plat_random(void *ctx, uint8_t *out, size_t len) {
  (void)ctx;
  esp_fill_random(out, len);
}

static bool plat_clock_trusted(void *ctx) {
  /* Trust is a platform state the board/product layer maintains (SNTP sync
   * completed, validated RTC, provisioning) — never "the date looks
   * plausible". No callback = never trusted = TLS fails closed. */
  pocketjs_esp_host_t *host = ctx;
  return host->cfg.wall_clock_trusted ? host->cfg.wall_clock_trusted(host->cfg.user) : false;
}

static void plat_log(void *ctx, pnet_log_level level, const char *msg) {
  (void)ctx;
  switch (level) {
    case PNET_LOG_ERROR: ESP_LOGE("pnet", "%s", msg); break;
    case PNET_LOG_WARN: ESP_LOGW("pnet", "%s", msg); break;
    case PNET_LOG_INFO: ESP_LOGI("pnet", "%s", msg); break;
    default: ESP_LOGD("pnet", "%s", msg); break;
  }
}

/* ------------------------------------------------------------------------ */
/* Guest console                                                             */
/* ------------------------------------------------------------------------ */

static JSValue console_write(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic) {
  (void)this_val;
  char line[512];
  size_t used = 0;
  for (int i = 0; i < argc && used + 2 < sizeof line; i++) {
    const char *s = JS_ToCString(ctx, argv[i]);
    if (!s) continue;
    int n = snprintf(line + used, sizeof line - used, "%s%s", i ? " " : "", s);
    JS_FreeCString(ctx, s);
    if (n > 0) used += (size_t)n < sizeof line - used ? (size_t)n : sizeof line - used - 1;
  }
  line[used] = 0;
  switch (magic) {
    case 0: ESP_LOGE("guest", "%s", line); break;
    case 1: ESP_LOGW("guest", "%s", line); break;
    default: ESP_LOGI("guest", "%s", line); break;
  }
  return JS_UNDEFINED;
}

static void install_console(JSContext *ctx) {
  JSValue global = JS_GetGlobalObject(ctx);
  JSValue console = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, console, "error", JS_NewCFunctionMagic(ctx, console_write, "error", 1, JS_CFUNC_generic_magic, 0));
  JS_SetPropertyStr(ctx, console, "warn", JS_NewCFunctionMagic(ctx, console_write, "warn", 1, JS_CFUNC_generic_magic, 1));
  JS_SetPropertyStr(ctx, console, "log", JS_NewCFunctionMagic(ctx, console_write, "log", 1, JS_CFUNC_generic_magic, 2));
  JS_SetPropertyStr(ctx, console, "info", JS_NewCFunctionMagic(ctx, console_write, "info", 1, JS_CFUNC_generic_magic, 2));
  JS_SetPropertyStr(ctx, console, "debug", JS_NewCFunctionMagic(ctx, console_write, "debug", 1, JS_CFUNC_generic_magic, 3));
  JS_SetPropertyStr(ctx, global, "console", console);
  JS_FreeValue(ctx, global);
}

static void log_exception(JSContext *ctx, const char *phase) {
  JSValue exc = JS_GetException(ctx);
  const char *msg = JS_ToCString(ctx, exc);
  ESP_LOGE("guest", "%s: %s", phase, msg ? msg : "(exception)");
  if (msg) JS_FreeCString(ctx, msg);
  if (JS_IsObject(exc)) {
    JSValue stack = JS_GetPropertyStr(ctx, exc, "stack");
    const char *st = JS_ToCString(ctx, stack);
    if (st && *st) ESP_LOGE("guest", "%s", st);
    if (st) JS_FreeCString(ctx, st);
    JS_FreeValue(ctx, stack);
  }
  JS_FreeValue(ctx, exc);
}

/* ------------------------------------------------------------------------ */
/* Task exit protocol                                                        */
/* ------------------------------------------------------------------------ */

/* The last thing a task does with `host`: publish its done flag, then wake
 * whoever waits in stop()/unwind. The waiter handle is read BEFORE the flag
 * is published (after the flag the owner may free `host`). */
static void task_exit(pocketjs_esp_host_t *host, volatile bool *done_flag) {
  TaskHandle_t waiter = __atomic_load_n(&host->stop_waiter, __ATOMIC_SEQ_CST);
  __atomic_store_n(done_flag, true, __ATOMIC_SEQ_CST);
  if (waiter) xTaskNotifyGive(waiter);
  vTaskDelete(NULL);
}

/* Block until `flag` is set: notification-driven with a short poll fallback
 * (a task that finished before the waiter registered itself never notifies).
 * Returns false if the deadline passed. */
static bool wait_flag(volatile bool *flag, uint32_t deadline_ms) {
  int64_t end = esp_timer_get_time() + (int64_t)deadline_ms * 1000;
  while (!__atomic_load_n(flag, __ATOMIC_SEQ_CST)) {
    if (esp_timer_get_time() >= end) return false;
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(10));
  }
  return true;
}

/* ------------------------------------------------------------------------ */
/* Network task                                                              */
/* ------------------------------------------------------------------------ */

static void net_task(void *arg) {
  pocketjs_esp_host_t *host = arg;
  while (!host->stopping) {
    pocketjs_host_net_lock(host);
    pnet_posix_driver_dispatch(host->driver, host->net);
    pnet_runtime_service(host->net);
    uint64_t deadline = pnet_runtime_next_deadline_ms(host->net);
    bool more = pnet_runtime_has_pending_output(host->net);
    pocketjs_host_net_unlock(host);
    int timeout = 250;
    if (deadline) {
      uint64_t now = plat_now_ms(NULL);
      timeout = deadline > now ? (int)(deadline - now) : 0;
      if (timeout > 250) timeout = 250;
    }
    if (more) timeout = 0;
    if (host->stopping) break;
    pnet_posix_driver_wait(host->driver, timeout);
  }
  task_exit(host, &host->net_done);
}

/* ------------------------------------------------------------------------ */
/* Guest task                                                                */
/* ------------------------------------------------------------------------ */

/* QuickJS interrupt handler: while stopping, a turn that outlives the budget
 * is aborted (QuickJS raises an uncatchable InternalError at the next
 * check), so shutdown is bounded whatever the bundle does. */
static int guest_interrupt(JSRuntime *rt, void *opaque) {
  (void)rt;
  pocketjs_esp_host_t *host = opaque;
  if (!host->stopping) return 0;
  uint32_t budget = host->cfg.stop_turn_budget_ms ? host->cfg.stop_turn_budget_ms : 50;
  return (esp_timer_get_time() - host->turn_started_us) > (int64_t)budget * 1000;
}

static void drain_jobs(pocketjs_esp_host_t *host) {
  JSContext *ctx;
  for (int i = 0; i < 4096; i++) {
    int rc = JS_ExecutePendingJob(host->rt, &ctx);
    if (rc == 0) break;
    host->stats.jobs++;
    if (rc < 0) log_exception(ctx ? ctx : host->ctx, "job");
  }
}

static bool guest_boot(pocketjs_esp_host_t *host) {
  host->rt = JS_NewRuntime2(&GUEST_ALLOC, host);
  if (!host->rt) {
    ESP_LOGE(TAG, "JS_NewRuntime2 failed");
    return false;
  }
  JS_SetMemoryLimit(host->rt, host->cfg.guest_memory_limit ? host->cfg.guest_memory_limit : 4 * 1024 * 1024);
  size_t stack_limit = host->cfg.guest_stack_limit ? host->cfg.guest_stack_limit : (host->cfg.guest_task_stack / 4) * 3;
  JS_SetMaxStackSize(host->rt, stack_limit);
  JS_UpdateStackTop(host->rt);
  JS_SetInterruptHandler(host->rt, guest_interrupt, host);
  host->ctx = JS_NewContext(host->rt);
  if (!host->ctx) {
    ESP_LOGE(TAG, "JS_NewContext failed");
    return false;
  }
  install_console(host->ctx);
  JSValue global = JS_GetGlobalObject(host->ctx);
  JS_SetPropertyStr(host->ctx, global, "__simHz", JS_NewUint32(host->ctx, host->cfg.tick_hz));
  JS_SetPropertyStr(host->ctx, global, "frame", JS_UNDEFINED);
  JS_FreeValue(host->ctx, global);
  if (host->net) pocketjs_host_mount_network(host);
  if (host->cfg.before_eval) host->cfg.before_eval(host->ctx, host->cfg.user);
  int64_t t0 = esp_timer_get_time();
  host->turn_started_us = t0;
  JSValue result = JS_Eval(host->ctx, host->bundle, host->bundle_len, "app.js", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(result)) {
    log_exception(host->ctx, "eval");
    JS_FreeValue(host->ctx, result);
    return false;
  }
  JS_FreeValue(host->ctx, result);
  drain_jobs(host);
  ESP_LOGI(TAG, "bundle evaluated in %lld us, guest heap %u bytes%s%s", (long long)(esp_timer_get_time() - t0),
           (unsigned)host->guest_heap, host->cfg.plan_hash ? ", plan " : "", host->cfg.plan_hash ? host->cfg.plan_hash : "");
  global = JS_GetGlobalObject(host->ctx);
  host->frame_fn = JS_GetPropertyStr(host->ctx, global, "frame");
  JS_FreeValue(host->ctx, global);
  if (!JS_IsFunction(host->ctx, host->frame_fn)) {
    ESP_LOGW(TAG, "bundle installed no globalThis.frame; the host will tick without a guest turn");
  }
  return true;
}

static void guest_frame(pocketjs_esp_host_t *host, uint32_t frame) {
  if (host->net) {
    pocketjs_host_net_lock(host);
    pnet_runtime_begin_tick(host->net);
    pocketjs_host_net_unlock(host);
  }
  int64_t t0 = esp_timer_get_time();
  host->turn_started_us = t0;
  if (JS_IsFunction(host->ctx, host->frame_fn)) {
    JSValue args[2] = {JS_NewInt32(host->ctx, 0), JS_NewInt32(host->ctx, 0x8080)};
    JSValue global = JS_GetGlobalObject(host->ctx);
    JSValue r = JS_Call(host->ctx, host->frame_fn, global, 2, args);
    JS_FreeValue(host->ctx, global);
    if (JS_IsException(r)) {
      host->stats.frame_errors++;
      log_exception(host->ctx, "frame");
    }
    JS_FreeValue(host->ctx, r);
  }
  drain_jobs(host);
  uint32_t us = (uint32_t)(esp_timer_get_time() - t0);
  if (us > host->stats.frame_max_us) host->stats.frame_max_us = us;
  if (host->net && host->net_dirty) {
    host->net_dirty = false;
    pnet_posix_driver_wake(host->driver);
  }
  host->stats.frames = frame;
  if (host->cfg.after_frame) host->cfg.after_frame(frame, host->cfg.user);
}

/* Sleep until the absolute deadline (µs on the esp_timer clock). The tick
 * granularity rounds UP, so a frame starts within one RTOS tick after its
 * deadline and never before it; because deadlines are absolute (t0 + k/hz)
 * the error does not accumulate and the cadence is exactly tick_hz. */
static void sleep_until(int64_t deadline_us) {
  int64_t wait = deadline_us - esp_timer_get_time();
  if (wait <= 0) return;
  const int64_t tick_us = (int64_t)portTICK_PERIOD_MS * 1000;
  TickType_t ticks = (TickType_t)((wait + tick_us - 1) / tick_us);
  if (ticks == 0) ticks = 1;
  vTaskDelay(ticks);
}

static void guest_task(void *arg) {
  pocketjs_esp_host_t *host = arg;
  if (!guest_boot(host)) {
    host->boot_failed = true;
    host->stats.guest_boot_failed = true;
    host->stopping = true;
  }
  const uint32_t hz = host->cfg.tick_hz ? host->cfg.tick_hz : 60;
  /* Law 3: one guest turn per tick. A frame that overruns its period makes
   * the following ticks late; they still get their turn (run back to back,
   * no sleep) until the schedule is caught up. Only a host that falls more
   * than max_backlog ticks (0.5 s) behind drops the excess and resyncs —
   * the overload guard against a spiral, counted in stats.frames_skipped. */
  const uint64_t max_backlog = hz / 2 ? hz / 2 : 1;
  const int64_t t0 = esp_timer_get_time();
  uint64_t k = 0;        /* tick index on the absolute schedule */
  uint32_t frame = 0;    /* guest turns run */
  while (!host->stopping) {
    int64_t deadline = t0 + (int64_t)((k * 1000000ULL) / hz);
    int64_t now = esp_timer_get_time();
    if (now > deadline) {
      uint64_t behind = (uint64_t)(now - deadline) * hz / 1000000ULL; /* whole ticks late */
      if (behind > max_backlog) {
        k += behind;
        host->stats.frames_skipped += (uint32_t)behind;
        deadline = t0 + (int64_t)((k * 1000000ULL) / hz);
      }
    }
    sleep_until(deadline); /* returns at once when late: the catch-up turn */
    if (host->stopping) break;
    guest_frame(host, ++frame);
    k++;
  }
  /* Wind-down: bounded frames so cancellations reach the guest. Each turn is
   * bounded by the interrupt handler (stopping is set). */
  if (host->rt && host->ctx) {
    if (host->net) {
      pocketjs_host_net_lock(host);
      pnet_runtime_quiesce(host->net);
      pocketjs_host_net_unlock(host);
    }
    for (int i = 0; i < 4; i++) {
      guest_frame(host, ++frame);
      vTaskDelay(pdMS_TO_TICKS(1000 / hz ? 1000 / hz : 1));
    }
  }
  if (host->ctx) {
    JS_FreeValue(host->ctx, host->frame_fn);
    host->frame_fn = JS_UNDEFINED;
    JS_FreeContext(host->ctx);
    host->ctx = NULL;
  }
  if (host->rt) {
    JS_FreeRuntime(host->rt);
    host->rt = NULL;
  }
  task_exit(host, &host->guest_done);
}

/* ------------------------------------------------------------------------ */
/* Lifecycle                                                                 */
/* ------------------------------------------------------------------------ */

/* Release everything the host owns. Tasks that were started must already
 * have exited (their done flags set): this is the single teardown path for
 * a failed start and for stop(). */
static void host_release(pocketjs_esp_host_t *host) {
  if (host->net) pnet_runtime_destroy(host->net);
  if (host->tls_provider) pnet_esp_tls_destroy(host->tls_provider);
  if (host->driver) pnet_posix_driver_destroy(host->driver);
  if (host->net_lock) vSemaphoreDelete(host->net_lock);
  free(host);
}

/* Ask running tasks to stop and wait for them; true when every started task
 * has exited and the host may be released. */
static bool host_join(pocketjs_esp_host_t *host, uint32_t deadline_ms) {
  __atomic_store_n(&host->stop_waiter, xTaskGetCurrentTaskHandle(), __ATOMIC_SEQ_CST);
  __atomic_store_n(&host->stopping, true, __ATOMIC_SEQ_CST);
  if (host->driver) pnet_posix_driver_wake(host->driver);
  bool ok = true;
  if (host->guest_task && !wait_flag(&host->guest_done, deadline_ms)) ok = false;
  if (host->net_task) {
    /* Keep waking the network task: its select may have started before
     * stopping was visible to it. */
    int64_t end = esp_timer_get_time() + (int64_t)deadline_ms * 1000;
    while (!__atomic_load_n(&host->net_done, __ATOMIC_SEQ_CST)) {
      if (esp_timer_get_time() >= end) {
        ok = false;
        break;
      }
      pnet_posix_driver_wake(host->driver);
      ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(10));
    }
  }
  /* Let the idle task reclaim the deleted tasks' stacks before we free
   * memory they were allocated next to. */
  if (ok) vTaskDelay(pdMS_TO_TICKS(2));
  return ok;
}

esp_err_t pocketjs_esp_host_start(const pocketjs_esp_host_config *cfg, const char *bundle, size_t bundle_len,
                                  pocketjs_esp_host_t **out_host) {
  if (!cfg || !bundle || !out_host) return ESP_ERR_INVALID_ARG;
  pocketjs_esp_host_t *host = calloc(1, sizeof *host);
  if (!host) return ESP_ERR_NO_MEM;
  host->cfg = *cfg;
  host->bundle = bundle;
  host->bundle_len = bundle_len;
  host->frame_fn = JS_UNDEFINED;
  host->stats.plan_hash = cfg->plan_hash ? cfg->plan_hash : "";
  esp_err_t err = ESP_OK;
  if (cfg->network_policy_json) {
    if (cfg->network_tls && !cfg->wall_clock_trusted) {
      ESP_LOGW(TAG, "TLS enabled without a wall_clock_trusted callback: verifying connections fail closed "
                    "(tls_clock_untrusted) until the board layer provides one");
    }
    host->net_lock = xSemaphoreCreateMutex();
    if (!host->net_lock) { err = ESP_ERR_NO_MEM; goto fail; }
    host->driver = pnet_posix_driver_create(cfg->network_max_sockets > 0 ? cfg->network_max_sockets : 12);
    if (!host->driver) { err = ESP_ERR_NO_MEM; goto fail; }
    pnet_platform plat = {host, plat_now_ms, plat_alloc, plat_free, plat_random, plat_log, plat_clock_trusted};
    pnet_runtime_config ncfg;
    if (cfg->network_config) ncfg = *cfg->network_config;
    else {
      pnet_runtime_config_defaults(&ncfg);
      /* Host tightening for an MCU profile: queues stay in PSRAM but the
       * event/aggregate budgets are modest. */
      ncfg.http_max_inflight = 4;
      ncfg.http_default_queue_bytes = 16 * 1024;
      ncfg.http_max_queue_bytes = 64 * 1024;
      ncfg.http_default_aggregate_bytes = 256 * 1024;
      ncfg.http_max_aggregate_bytes = 1024 * 1024;
      ncfg.http_max_tick_bytes = 64 * 1024;
      ncfg.ws_max_sockets = 4;
      ncfg.ws_max_message_bytes = 64 * 1024;
      ncfg.ws_max_receive_queue_bytes = 128 * 1024;
      ncfg.ws_max_send_queue_bytes = 128 * 1024;
      ncfg.ws_send_high_water_bytes = 32 * 1024;
      ncfg.ws_send_low_water_bytes = 8 * 1024;
      ncfg.ws_max_tick_bytes = 64 * 1024;
      ncfg.httpd_max_connections = 8;
      ncfg.httpd_max_inflight = 4;
      ncfg.httpd_default_request_queue_bytes = 16 * 1024;
      ncfg.httpd_max_request_queue_bytes = 64 * 1024;
      ncfg.httpd_max_send_queue_bytes = 64 * 1024;
      ncfg.httpd_send_high_water_bytes = 32 * 1024;
      ncfg.httpd_send_low_water_bytes = 8 * 1024;
      ncfg.httpd_max_tick_bytes = 64 * 1024;
      ncfg.max_heap_bytes = 1024 * 1024;
      ncfg.io_chunk_bytes = 1460;
    }
    if (cfg->network_tls) {
      host->tls_provider = pnet_esp_tls_create(pnet_posix_driver_ops(), host->driver);
      if (!host->tls_provider) {
        ESP_LOGE(TAG, "ESP-TLS provider creation failed");
        err = ESP_ERR_NO_MEM;
        goto fail;
      }
      host->net = pnet_runtime_create_tls(&plat, pnet_posix_driver_ops(), host->driver, pnet_esp_tls_ops(),
                                          pnet_esp_tls_ctx(host->tls_provider), &ncfg, cfg->network_policy_json);
    } else {
      host->net = pnet_runtime_create(&plat, pnet_posix_driver_ops(), host->driver, &ncfg, cfg->network_policy_json);
    }
    if (!host->net) {
      ESP_LOGE(TAG, "network runtime creation failed (is network_policy_json the plan's canonical policy?)");
      err = ESP_ERR_INVALID_ARG;
      goto fail;
    }
    if (xTaskCreatePinnedToCore(net_task, "pocketjs-net", cfg->net_task_stack, host, cfg->net_task_priority,
                                &host->net_task, cfg->net_task_core) != pdPASS) {
      ESP_LOGE(TAG, "network task creation failed");
      host->net_task = NULL;
      err = ESP_ERR_NO_MEM;
      goto fail;
    }
  }
  if (xTaskCreatePinnedToCore(guest_task, "pocketjs-guest", cfg->guest_task_stack, host, cfg->guest_task_priority,
                              &host->guest_task, cfg->guest_task_core) != pdPASS) {
    ESP_LOGE(TAG, "guest task creation failed");
    host->guest_task = NULL;
    err = ESP_ERR_NO_MEM;
    goto fail;
  }
  *out_host = host;
  return ESP_OK;

fail:
  /* One unwind path: stop whatever task already runs, then release. */
  if (host_join(host, 5000)) host_release(host);
  else ESP_LOGE(TAG, "start unwind: a task did not exit; leaking the host rather than freeing under it");
  return err;
}

void pocketjs_esp_host_stop(pocketjs_esp_host_t *host) {
  if (!host) return;
  /* Bound: wind-down is 4 frames + the turn in progress, each capped by the
   * stop budget; the network task exits within one select timeout. 10 s is
   * far beyond that and exists only so a wedged task is detected. */
  if (host_join(host, 10000)) {
    host_release(host);
  } else {
    ESP_LOGE(TAG, "stop: a task did not exit in time; leaking the host rather than freeing under a running task");
  }
}

void pocketjs_esp_host_stats(pocketjs_esp_host_t *host, pocketjs_esp_host_stats_t *out) {
  *out = host->stats;
  out->guest_heap_bytes = host->guest_heap;
  out->guest_heap_high_water = host->guest_heap_high_water;
  out->guest_boot_failed = host->boot_failed;
  out->plan_hash = host->cfg.plan_hash ? host->cfg.plan_hash : "";
  if (host->net) {
    pocketjs_host_net_lock(host);
    out->net_heap_bytes = pnet_runtime_heap_bytes(host->net);
    out->net_sockets = pnet_posix_driver_socket_count(host->driver);
    pocketjs_host_net_unlock(host);
  }
}
