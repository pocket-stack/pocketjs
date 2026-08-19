/* Wi-Fi station bring-up shared by the AtomS3R and Tab5 profiles. */
#include "pocketjs/board.h"

#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "esp_netif_sntp.h"
#include "esp_sntp.h"
#include "nvs_flash.h"
#include "sdkconfig.h"
#include <time.h>

static const char *TAG = "board";

static EventGroupHandle_t s_events;
static esp_ip4_addr_t s_ip;
static int s_retries;
static bool s_started;
#define GOT_IP_BIT BIT0
#define FAILED_BIT BIT1

static void on_wifi(void *arg, esp_event_base_t base, int32_t id, void *data) {
  (void)arg;
  (void)data;
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
    esp_wifi_connect();
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    memset(&s_ip, 0, sizeof s_ip);
    s_retries++;
    ESP_LOGW(TAG, "station disconnected (attempt %d), reconnecting", s_retries);
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_wifi_connect();
  } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    ip_event_got_ip_t *ev = data;
    s_ip = ev->ip_info.ip;
    ESP_LOGI(TAG, "station got ip " IPSTR, IP2STR(&s_ip));
    xEventGroupSetBits(s_events, GOT_IP_BIT);
  }
}

esp_err_t pocketjs_board_wifi_connect(const pocketjs_board_wifi_config *cfg, esp_ip4_addr_t *ip) {
  if (!cfg || !cfg->ssid) return ESP_ERR_INVALID_ARG;
  if (!s_started) {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
      ESP_ERROR_CHECK(nvs_flash_erase());
      err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    ESP_ERROR_CHECK(pocketjs_board_prepare_wifi());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    s_events = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi, NULL));
    wifi_config_t wc;
    memset(&wc, 0, sizeof wc);
    strncpy((char *)wc.sta.ssid, cfg->ssid, sizeof wc.sta.ssid - 1);
    if (cfg->password) strncpy((char *)wc.sta.password, cfg->password, sizeof wc.sta.password - 1);
    wc.sta.threshold.authmode = cfg->password && cfg->password[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    wc.sta.pmf_cfg.capable = true;
    wc.sta.pmf_cfg.required = false;
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_ERROR_CHECK(esp_wifi_start());
    s_started = true;
    ESP_LOGI(TAG, "connecting to \"%s\"", cfg->ssid);
  }
  uint32_t timeout = cfg->timeout_ms ? cfg->timeout_ms : 30000;
  EventBits_t bits = xEventGroupWaitBits(s_events, GOT_IP_BIT, pdFALSE, pdFALSE, pdMS_TO_TICKS(timeout));
  if (!(bits & GOT_IP_BIT)) {
    ESP_LOGE(TAG, "no address after %u ms", (unsigned)timeout);
    return ESP_ERR_TIMEOUT;
  }
  if (ip) *ip = s_ip;
  return ESP_OK;
}

/* Wall-clock trust: latched by a completed SNTP sync (first sync and every
 * later re-sync, through the notification callback) or by the product. */
static volatile bool s_clock_trusted;

static void on_time_synced(struct timeval *tv) {
  (void)tv;
  s_clock_trusted = true;
}

bool pocketjs_board_clock_trusted(void) {
  return s_clock_trusted;
}

void pocketjs_board_set_clock_trusted(bool trusted) {
  s_clock_trusted = trusted;
}

bool pocketjs_board_clock_trusted_cb(void *user) {
  (void)user;
  return s_clock_trusted;
}

esp_err_t pocketjs_board_sync_time(uint32_t timeout_ms) {
  static bool started;
  if (!started) {
    esp_sntp_config_t cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    cfg.sync_cb = on_time_synced;
    ESP_ERROR_CHECK(esp_netif_sntp_init(&cfg));
    started = true;
  }
  if (esp_netif_sntp_sync_wait(pdMS_TO_TICKS(timeout_ms ? timeout_ms : 15000)) != ESP_OK) {
    ESP_LOGW(TAG, "SNTP did not sync in time; the wall clock stays untrusted (TLS fails closed)");
    return ESP_ERR_TIMEOUT;
  }
  s_clock_trusted = true;
  time_t now = time(NULL);
  struct tm tm;
  localtime_r(&now, &tm);
  ESP_LOGI(TAG, "time synced: %04d-%02d-%02d %02d:%02d:%02d UTC (wall clock trusted)", tm.tm_year + 1900, tm.tm_mon + 1,
           tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec);
  return ESP_OK;
}

void pocketjs_board_ip_text(char *out, size_t cap) {
  snprintf(out, cap, IPSTR, IP2STR(&s_ip));
}
