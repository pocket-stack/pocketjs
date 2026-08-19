/* net-smoke firmware: bring Wi-Fi up, start the PocketJS host with the
 * network modules, evaluate the embedded smoke bundle, report stats.
 *
 * Everything the host mounts and allows comes from the smoke manifest's
 * Build Plan (tools/esp-idf.ts, run by main/CMakeLists.txt): the embedded
 * network-policy.json is the canonical ResolvedNetworkPolicy of that plan,
 * host-inputs.h carries the plan hash and the resolved features, app.js is
 * the bundle built against the same plan. This file authors no policy; the
 * rig's addresses (Kconfig) reach the guest only as test configuration. */
#include <stdio.h>
#include <string.h>

#include "esp_chip_info.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "host-inputs.h"
#include "pocketjs/board.h"
#include "pocketjs/esp_host.h"
#include "sdkconfig.h"

static const char *TAG = "smoke";

extern const char app_js_start[] asm("_binary_app_js_start");
extern const char app_js_end[] asm("_binary_app_js_end");
extern const char network_policy_json_start[] asm("_binary_network_policy_json_start");
extern const char network_policy_json_end[] asm("_binary_network_policy_json_end");

static char s_self_ip[16] = "0.0.0.0";
/* The embedded policy text, NUL-terminated for the core (EMBED_TXTFILES adds
 * the NUL; the trailing newline is JSON whitespace). */
static char s_policy[1024];

static void install_smoke_config(JSContext *ctx, void *user) {
  (void)user;
  char json[512];
  snprintf(json, sizeof json,
           "({\"board\":\"%s\",\"selfIp\":\"%s\",\"peerHost\":\"%s\",\"peerPort\":%d,\"macHost\":\"%s\",\"macPort\":%d,"
           "\"macWsPort\":%d,\"ping\":%s,\"tls\":%s,\"tlsHost\":\"%s\"})",
           CONFIG_SMOKE_BOARD_NAME, s_self_ip, CONFIG_SMOKE_PEER_HOST, CONFIG_SMOKE_PEER_PORT, CONFIG_SMOKE_MAC_HOST,
           CONFIG_SMOKE_MAC_HTTP_PORT, CONFIG_SMOKE_MAC_WS_PORT, CONFIG_SMOKE_PEER_PING ? "true" : "false",
#if CONFIG_SMOKE_ENABLE_TLS
           "true", CONFIG_SMOKE_TLS_HOST);
#else
           "false", "");
#endif
  JSValue value = JS_Eval(ctx, json, strlen(json), "smoke-config", JS_EVAL_TYPE_GLOBAL);
  JSValue global = JS_GetGlobalObject(ctx);
  JS_SetPropertyStr(ctx, global, "__pocketSmoke", value);
  JS_FreeValue(ctx, global);
}

static void report(uint32_t frame, void *user) {
  pocketjs_esp_host_t **host = user;
  if (frame % (POCKETJS_TICK_HZ * 30) != 0 || !*host) return; /* every 30 s of guest turns */
  pocketjs_esp_host_stats_t st;
  pocketjs_esp_host_stats(*host, &st);
  ESP_LOGI(TAG,
           "frames=%u skipped=%u jobs=%u frameErrors=%u frameMax=%uus guestHeap=%u/%u netHeap=%u sockets=%d "
           "freeInternal=%u freePsram=%u uptime=%llus",
           (unsigned)st.frames, (unsigned)st.frames_skipped, (unsigned)st.jobs, (unsigned)st.frame_errors,
           (unsigned)st.frame_max_us, (unsigned)st.guest_heap_bytes, (unsigned)st.guest_heap_high_water,
           (unsigned)st.net_heap_bytes, st.net_sockets, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
           (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM), (unsigned long long)(esp_timer_get_time() / 1000000));
}

static pocketjs_esp_host_t *s_host;

void app_main(void) {
  esp_chip_info_t chip;
  esp_chip_info(&chip);
  ESP_LOGI(TAG, "%s (%s, rev v%d.%d) free internal %u, psram %u", CONFIG_SMOKE_BOARD_NAME, CONFIG_IDF_TARGET,
           chip.revision / 100, chip.revision % 100, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
           (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
  ESP_LOGI(TAG, "plan %s (target %s, host ABI %d)", POCKETJS_PLAN_HASH, POCKETJS_TARGET, POCKETJS_HOST_ABI);

  pocketjs_board_wifi_config wifi = {.ssid = CONFIG_SMOKE_WIFI_SSID, .password = CONFIG_SMOKE_WIFI_PASSWORD, .timeout_ms = 60000};
  esp_ip4_addr_t ip;
  while (pocketjs_board_wifi_connect(&wifi, &ip) != ESP_OK) {
    ESP_LOGW(TAG, "retrying Wi-Fi");
    vTaskDelay(pdMS_TO_TICKS(2000));
  }
  pocketjs_board_ip_text(s_self_ip, sizeof s_self_ip);
  ESP_LOGI(TAG, "station ip %s, serving http://%s:%d/", s_self_ip, s_self_ip, CONFIG_SMOKE_SERVE_PORT);
#if CONFIG_SMOKE_ENABLE_TLS
  if (pocketjs_board_sync_time(20000) != ESP_OK)
    ESP_LOGW(TAG, "wall clock untrusted: every verifying TLS connection will fail closed with tls_clock_untrusted");
#endif

  size_t policy_len = (size_t)(network_policy_json_end - network_policy_json_start);
  if (policy_len >= sizeof s_policy) {
    ESP_LOGE(TAG, "embedded policy is %u bytes, larger than the %u byte buffer", (unsigned)policy_len, (unsigned)sizeof s_policy);
    return;
  }
  memcpy(s_policy, network_policy_json_start, policy_len);
  s_policy[policy_len] = 0;
  ESP_LOGI(TAG, "policy %s", s_policy);

  pocketjs_esp_host_config cfg;
  pocketjs_esp_host_config_defaults(&cfg);
  cfg.tick_hz = POCKETJS_TICK_HZ;
  cfg.network_policy_json = s_policy;
  cfg.plan_hash = POCKETJS_PLAN_HASH;
  /* Roles follow the plan's features, not a host opinion. */
  cfg.mount_websocket_client = POCKETJS_FEATURE_NETWORK_WEBSOCKET_CLIENT;
  cfg.mount_http_server = POCKETJS_FEATURE_NETWORK_HTTP_SERVER;
#if CONFIG_SMOKE_ENABLE_TLS
  cfg.network_tls = POCKETJS_FEATURE_NETWORK_HTTP_CLIENT_TLS;
#endif
  cfg.wall_clock_trusted = pocketjs_board_clock_trusted_cb;
  cfg.guest_in_psram = true;
  cfg.guest_memory_limit = CONFIG_SMOKE_GUEST_MEMORY_KB * 1024;
  cfg.guest_task_stack = CONFIG_SMOKE_GUEST_STACK_KB * 1024;
  cfg.before_eval = install_smoke_config;
  cfg.after_frame = report;
  cfg.user = &s_host;
  size_t bundle_len = (size_t)(app_js_end - app_js_start);
  if (bundle_len > 0 && app_js_start[bundle_len - 1] == 0) bundle_len--; /* EMBED_TXTFILES adds a NUL */
  ESP_LOGI(TAG, "starting the guest with a %u byte bundle", (unsigned)bundle_len);
  ESP_ERROR_CHECK(pocketjs_esp_host_start(&cfg, app_js_start, bundle_len, &s_host));
}
