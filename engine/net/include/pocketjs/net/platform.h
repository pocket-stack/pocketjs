/* PocketJS network core — platform interface.
 *
 * The core (engine/net) is portable C99 with no OS headers. Everything it
 * needs from the host arrives through this table: a monotonic clock, a
 * bounded allocator, entropy and a log sink. The host owns thread
 * discipline: the core is not internally synchronized. Every call into a
 * runtime (owner-thread ops, `pnet_runtime_service`, `pnet_runtime_begin_tick`)
 * must be serialized by the host — one mutex around all of them is the
 * reference arrangement, a single-threaded loop calling service() then
 * begin_tick() is another.
 */
#ifndef POCKETJS_NET_PLATFORM_H
#define POCKETJS_NET_PLATFORM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum pnet_log_level {
  PNET_LOG_ERROR = 0,
  PNET_LOG_WARN = 1,
  PNET_LOG_INFO = 2,
  PNET_LOG_DEBUG = 3,
} pnet_log_level;

typedef struct pnet_platform {
  void *ctx;
  /** Monotonic milliseconds; the core's only clock. */
  uint64_t (*now_ms)(void *ctx);
  /** Allocate `size` bytes or return NULL. The core accounts every byte it
   * holds against `pnet_runtime_config.max_heap_bytes` before calling. */
  void *(*alloc)(void *ctx, size_t size);
  /** Release a block returned by alloc; `size` is what was requested. */
  void (*free)(void *ctx, void *ptr, size_t size);
  /** Cryptographic-quality random bytes (WebSocket keys and masks). */
  void (*random)(void *ctx, uint8_t *out, size_t len);
  /** Optional diagnostics sink; NULL disables logging. */
  void (*log)(void *ctx, pnet_log_level level, const char *message);
  /** Optional: whether the wall clock is trustworthy for certificate
   * validity checks (SNTP synced, persisted RTC, provisioning). NULL means
   * trusted. While false, a verifying TLS connection fails closed with
   * `tls_clock_untrusted` before any I/O. */
  bool (*wall_clock_trusted)(void *ctx);
} pnet_platform;

#ifdef __cplusplus
}
#endif

#endif /* POCKETJS_NET_PLATFORM_H */
