/* Board bring-up for the first two ESP-IDF PocketJS profiles:
 *
 *   AtomS3R  ESP32-S3-PICO-1-N8R8, native Wi-Fi.
 *   Tab5     ESP32-P4 rev 1.3 + on-board ESP32-C6 over SDIO (esp_hosted +
 *            esp_wifi_remote); the C6 power rail sits behind the PI4IOE5V6408
 *            IO expander at 0x44 (bit 0, WLAN_PWR_EN) on the internal I2C bus
 *            (SDA GPIO31, SCL GPIO32) and must be on before esp_wifi_init().
 *
 * The public network modules never see any of this: link driver, BSP and
 * credentials are product/host concerns. This component gives the smoke
 * firmware one call that brings the
 * station interface up with DHCP and returns the address.
 */
#ifndef POCKETJS_BOARD_H
#define POCKETJS_BOARD_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "esp_netif_ip_addr.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct pocketjs_board_wifi_config {
  const char *ssid;
  const char *password;
  /** Wait for DHCP this long (0 = 30 s). */
  uint32_t timeout_ms;
} pocketjs_board_wifi_config;

/** Board-specific power/transport preparation (Tab5: enable the C6 rail and
 * start the hosted transport). No-op on AtomS3R. Idempotent. */
esp_err_t pocketjs_board_prepare_wifi(void);

/** NVS + netif + event loop + STA + DHCP; returns once an IPv4 address is
 * bound (written to *ip) or fails after the timeout. Reconnects on drops. */
esp_err_t pocketjs_board_wifi_connect(const pocketjs_board_wifi_config *cfg, esp_ip4_addr_t *ip);

/** Current station IPv4 address as text ("0.0.0.0" when down). */
void pocketjs_board_ip_text(char *out, size_t cap);

/** Sync the wall clock over SNTP. Returns ESP_OK once the time is set (the
 * clock is then trusted, see below), ESP_ERR_TIMEOUT otherwise. */
esp_err_t pocketjs_board_sync_time(uint32_t timeout_ms);

/** Wall-clock trust state for TLS certificate validation — a state the board
 * layer maintains, not a guess from the date: true after an SNTP sync
 * completed (pocketjs_board_sync_time, or any later SNTP re-sync reported
 * through the sync notification), or after the product asserted it with
 * pocketjs_board_set_clock_trusted (a validated battery-backed RTC,
 * provisioning). Wire it into pocketjs_esp_host_config.wall_clock_trusted. */
bool pocketjs_board_clock_trusted(void);
void pocketjs_board_set_clock_trusted(bool trusted);
/** Adapter with the host's callback signature (ignores `user`). */
bool pocketjs_board_clock_trusted_cb(void *user);

#ifdef __cplusplus
}
#endif

#endif /* POCKETJS_BOARD_H */
