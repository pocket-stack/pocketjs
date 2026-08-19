/* PocketJS ESP-IDF host: a QuickJS-ng guest owned by one FreeRTOS task,
 * ticked at a fixed rate through `globalThis.frame(...)`, with the network
 * modules (`globalThis.net` / `ws` / `httpd`) mounted over the portable core
 * (engine/net) and a network task driving lwIP sockets.
 *
 * Execution model: every guest turn is one `frame()` call followed by the
 * job drain, on the owner task only. Before each frame the owner task runs
 * `pnet_runtime_begin_tick()` under the runtime lock; the network task
 * services sockets under the same lock and never touches QuickJS.
 *
 * Cadence: tick k is scheduled at t0 + k / tick_hz (absolute microsecond
 * deadlines), so the host's real tick rate equals the realm's `__simHz`
 * exactly (60 Hz is 60 Hz, not the 62.5 Hz a 16 ms integer period gives),
 * and every tick gets its one guest turn (Law 3): after a frame overruns,
 * the late ticks run back to back until the schedule is caught up. Only a
 * host that falls more than half a second behind drops the excess ticks and
 * resyncs (stats.frames_skipped) — an overload guard, not the normal path.
 *
 * Ownership: the host owns the guest task, the network task, the runtime,
 * the driver and the TLS provider. Startup unwinds everything it created on
 * any failure; stop() releases a resource only after the task that uses it
 * has definitely exited. A guest turn in progress while stopping is bounded
 * by the QuickJS interrupt handler (stop_turn_budget_ms), so stop() never
 * frees under a running turn.
 *
 * Build Plan truth: the network policy is the application's
 * ResolvedNetworkPolicy (contracts/spec/network-policy.ts), handed over as
 * the canonical JSON the plan resolver emits (HostBuildInputs.network.
 * policyJson); a product host embeds that projection, it never writes a
 * policy of its own. Which modules to mount follows the plan's features.
 */
#ifndef POCKETJS_ESP_HOST_H
#define POCKETJS_ESP_HOST_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "pocketjs/net/runtime.h"
#include "quickjs.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct pocketjs_esp_host pocketjs_esp_host_t;

typedef struct pocketjs_esp_host_config {
  /** Guest ticks per second (the realm's `__simHz`). Default 60. */
  uint32_t tick_hz;
  /** QuickJS memory limit in bytes (0 = 4 MiB). */
  size_t guest_memory_limit;
  /** QuickJS stack limit in bytes (0 = 3/4 of the guest task stack). */
  size_t guest_stack_limit;
  /** Allocate the QuickJS heap from PSRAM (recommended when present). */
  bool guest_in_psram;
  /** Owner task stack bytes (default 32 KiB) and priority/core. */
  uint32_t guest_task_stack;
  int guest_task_priority;
  int guest_task_core;
  /** Network task stack bytes (default 12 KiB) and priority/core. */
  uint32_t net_task_stack;
  int net_task_priority;
  int net_task_core;
  /** While stopping, a guest turn (frame + job drain) longer than this is
   * interrupted (QuickJS interrupt handler) so shutdown is bounded.
   * Default 50 ms; 0 = default. */
  uint32_t stop_turn_budget_ms;
  /** The application's network policy: the canonical ResolvedNetworkPolicy
   * JSON from its Build Plan (version 1). NULL mounts no network module.
   * Never a host-authored string — see the header comment. */
  const char *network_policy_json;
  /** The plan's checksum (ResolvedBuildPlan.planHash), logged at boot and
   * reported in stats so a running device names the plan it runs. Optional. */
  const char *plan_hash;
  /** Enable TLS (https:/wss:) through the ESP-TLS provider with the IDF
   * certificate bundle. */
  bool network_tls;
  /** Whether the wall clock is trusted for certificate validity: true only
   * after the platform established it (SNTP sync completed, a validated
   * persisted RTC, explicit provisioning) — "the clock has a plausible
   * value" is not trust. Required for TLS: while it returns false (or when
   * NULL) every verifying connection fails closed with tls_clock_untrusted
   * before any I/O. The board layer provides it (pocketjs_board_clock_trusted). */
  bool (*wall_clock_trusted)(void *user);
  /** Which roles this host admits: `globalThis.net` is always mounted with
   * a policy; `ws` and `httpd` only when set (default true for both). A
   * product host mounts exactly the roles its plan's features turned on. */
  bool mount_websocket_client;
  bool mount_http_server;
  /** Core limits; NULL = spec ceilings tightened by the host defaults. */
  const pnet_runtime_config *network_config;
  /** Sockets the driver may track (default 12). */
  int network_max_sockets;
  /** Called on the owner task after the namespaces are mounted and before
   * the bundle is evaluated (install host globals). */
  void (*before_eval)(JSContext *ctx, void *user);
  /** Called on the owner task after every frame + job drain (diagnostics). */
  void (*after_frame)(uint32_t frame, void *user);
  void *user;
} pocketjs_esp_host_config;

/** Fill in the defaults described above. */
void pocketjs_esp_host_config_defaults(pocketjs_esp_host_config *cfg);

/** Create the runtime and both tasks, evaluate `bundle` (an IIFE that
 * installs `globalThis.frame`), and start ticking. `bundle` must stay valid
 * for the host's lifetime (embedded flash text is fine). On failure nothing
 * is left allocated and *out_host is untouched. */
esp_err_t pocketjs_esp_host_start(const pocketjs_esp_host_config *cfg, const char *bundle, size_t bundle_len,
                                  pocketjs_esp_host_t **out_host);

/** Quiesce the network, run a bounded number of wind-down frames, wait for
 * both tasks to exit, then release the guest, the runtime, the driver and
 * the TLS provider. Blocks the caller until the tasks are gone; if a task
 * does not exit within the (generous) deadline the host is leaked with an
 * error log rather than freed under a running task. */
void pocketjs_esp_host_stop(pocketjs_esp_host_t *host);

typedef struct pocketjs_esp_host_stats {
  uint32_t frames;          /* guest turns run */
  uint32_t frames_skipped;  /* ticks dropped by the overload guard (> 0.5 s behind) */
  uint32_t jobs;
  uint32_t frame_errors;
  size_t guest_heap_bytes;      /* QuickJS reported */
  size_t guest_heap_high_water;
  size_t net_heap_bytes;        /* core accounting */
  int net_sockets;
  uint32_t frame_max_us;
  bool guest_boot_failed;   /* the bundle did not evaluate; the host idles */
  const char *plan_hash;    /* cfg.plan_hash or "" */
} pocketjs_esp_host_stats_t;

void pocketjs_esp_host_stats(pocketjs_esp_host_t *host, pocketjs_esp_host_stats_t *out);

#ifdef __cplusplus
}
#endif

#endif /* POCKETJS_ESP_HOST_H */
