/* Full PocketJS host for the Waveshare ESP32-P4-WIFI6-Touch-LCD-7B.
 *
 * The reusable Rust static library owns QuickJS, HostOps, retained UI state,
 * and hybrid PPA/software DrawList rendering. This board boundary owns the
 * exact EK79007/GT911 BSP, the persistent RGB565 framebuffer, presentation,
 * touch-coordinate conversion, frame pacing, and UART acceptance receipts.
 */
#include "pocketjs_runtime.h"

#include <errno.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bsp/esp-bsp.h"
#include "driver/uart.h"
#include "driver/uart_vfs.h"
#include "esp_cache.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "lvgl.h"

#ifndef POCKETJS_APP_TITLE
#define POCKETJS_APP_TITLE "PocketJS"
#endif
#ifndef POCKETJS_BUILD_ID
#define POCKETJS_BUILD_ID "unknown"
#endif

#define PJ_BOARD_ID "waveshare-esp32-p4-wifi6-touch-lcd-7b"
#define PJ_LOGICAL_WIDTH 480
#define PJ_LOGICAL_HEIGHT 272
#define PJ_RASTER_DENSITY 2
#define PJ_FRAMEBUFFER_WIDTH (PJ_LOGICAL_WIDTH * PJ_RASTER_DENSITY)
#define PJ_FRAMEBUFFER_HEIGHT (PJ_LOGICAL_HEIGHT * PJ_RASTER_DENSITY)
#define PJ_FRAMEBUFFER_PIXELS ((size_t)PJ_FRAMEBUFFER_WIDTH * PJ_FRAMEBUFFER_HEIGHT)
#define PJ_FRAMEBUFFER_BYTES (PJ_FRAMEBUFFER_PIXELS * sizeof(uint16_t))
#define PJ_PANEL_WIDTH 1024
#define PJ_PANEL_HEIGHT 600
#define PJ_CONTENT_X 32
#define PJ_CONTENT_Y 28
#define PJ_FRAME_RATE 60
#define PJ_RECEIPT_PERIOD 60
#define PJ_CACHE_ALIGNMENT 128

_Static_assert(BSP_LCD_H_RES == PJ_PANEL_WIDTH, "selected BSP panel width must be 1024");
_Static_assert(BSP_LCD_V_RES == PJ_PANEL_HEIGHT, "selected BSP panel height must be 600");
_Static_assert(PJ_CONTENT_X * 2 + PJ_FRAMEBUFFER_WIDTH == PJ_PANEL_WIDTH,
               "PocketJS framebuffer must be horizontally centered");
_Static_assert(PJ_CONTENT_Y * 2 + PJ_FRAMEBUFFER_HEIGHT == PJ_PANEL_HEIGHT,
               "PocketJS framebuffer must be vertically centered");
_Static_assert(PJ_LOGICAL_WIDTH <= 511 && PJ_LOGICAL_HEIGHT <= 511,
               "legacy packed-touch coordinates are nine bits per axis");
_Static_assert(PJ_FRAMEBUFFER_BYTES % PJ_CACHE_ALIGNMENT == 0,
               "framebuffer size must preserve the PPA cache-line contract");

extern const uint8_t app_js_start[] asm("_binary_app_js_start");
extern const uint8_t app_js_end[] asm("_binary_app_js_end");
extern const uint8_t app_pak_start[] asm("_binary_app_pak_start");
extern const uint8_t app_pak_end[] asm("_binary_app_pak_end");

static const char *TAG = "pocketjs-p4";

typedef struct {
  bool down;
  int16_t panel_x;
  int16_t panel_y;
  int16_t logical_x;
  int16_t logical_y;
  uint32_t packed;
} TouchSnapshot;

static lv_display_t *display;
static lv_obj_t *canvas;
static QueueHandle_t touch_queue;
static uint16_t *framebuffer;
static PocketRuntime *runtime;
static PocketJsFrameStats last_stats;
static TouchSnapshot current_touch;
static uint64_t last_screen_hash;
static uint32_t last_buttons;
static uint32_t injected_buttons;
static uint8_t injected_frames;
static bool runtime_ready;

/* Rust's logger calls this symbol when the esp-idf feature is enabled. */
void pocketjs_esp32p4_log(uint32_t level, const char *message) {
  if (message == NULL) return;
  switch (level) {
    case 1: ESP_LOGE(TAG, "%s", message); break;
    case 2: ESP_LOGW(TAG, "%s", message); break;
    case 4: ESP_LOGD(TAG, "%s", message); break;
    case 5: ESP_LOGV(TAG, "%s", message); break;
    default: ESP_LOGI(TAG, "%s", message); break;
  }
}

static void queue_touch(bool down, const lv_point_t *point) {
  static TouchSnapshot last_queued;
  TouchSnapshot next = {
      .down = false,
      .panel_x = point == NULL ? -1 : (int16_t)point->x,
      .panel_y = point == NULL ? -1 : (int16_t)point->y,
      .logical_x = -1,
      .logical_y = -1,
      .packed = 0,
  };

  if (down && point != NULL) {
    int32_t content_x = point->x - PJ_CONTENT_X;
    int32_t content_y = point->y - PJ_CONTENT_Y;
    if (content_x >= 0 && content_x < PJ_FRAMEBUFFER_WIDTH &&
        content_y >= 0 && content_y < PJ_FRAMEBUFFER_HEIGHT) {
      next.down = true;
      next.logical_x = (int16_t)(content_x / PJ_RASTER_DENSITY);
      next.logical_y = (int16_t)(content_y / PJ_RASTER_DENSITY);
      next.packed = ((uint32_t)next.logical_y << 9) | (uint32_t)next.logical_x;
    }
  }

  if (next.down == last_queued.down && next.packed == last_queued.packed &&
      next.panel_x == last_queued.panel_x && next.panel_y == last_queued.panel_y) {
    return;
  }
  last_queued = next;
  (void)xQueueOverwrite(touch_queue, &next);
}

/* Runs only on the BSP's LVGL task. QuickJS and retained UI state remain
 * exclusively owned by app_main. */
static void canvas_touch_event(lv_event_t *event) {
  lv_event_code_t code = lv_event_get_code(event);
  lv_indev_t *input = lv_indev_active();
  lv_point_t point = {.x = -1, .y = -1};
  if (input != NULL) lv_indev_get_point(input, &point);

  if (code == LV_EVENT_PRESSED || code == LV_EVENT_PRESSING) {
    queue_touch(true, &point);
  } else if (code == LV_EVENT_RELEASED || code == LV_EVENT_PRESS_LOST) {
    queue_touch(false, &point);
  }
}

static void display_init(void) {
  bsp_display_cfg_t config = {
      .lvgl_port_cfg = ESP_LVGL_PORT_INIT_CONFIG(),
      .buffer_size = BSP_LCD_DRAW_BUFF_SIZE,
      .double_buffer = BSP_LCD_DRAW_BUFF_DOUBLE,
      .flags = {
          .buff_dma = true,
          .buff_spiram = false,
          .sw_rotate = true,
      },
  };

  display = bsp_display_start_with_config(&config);
  if (display == NULL) {
    ESP_LOGE(TAG, "EK79007/GT911 BSP initialization failed");
    ESP_ERROR_CHECK(ESP_FAIL);
  }
  if (!bsp_display_lock(0)) {
    ESP_LOGE(TAG, "could not acquire LVGL lock while creating canvas");
    ESP_ERROR_CHECK(ESP_ERR_TIMEOUT);
  }
  /* This is the exact orientation used by Waveshare's LVGL v9 example. The
   * BSP applies the matching transform to its associated GT911 input. Keep
   * the LVGL mutation under the BSP lock because its task is already live. */
  bsp_display_rotate(display, LV_DISPLAY_ROTATION_180);
  lv_obj_t *screen = lv_screen_active();
  lv_obj_remove_flag(screen, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_set_style_bg_color(screen, lv_color_hex(0x000000), LV_PART_MAIN);
  lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, LV_PART_MAIN);
  lv_obj_set_style_pad_all(screen, 0, LV_PART_MAIN);

  canvas = lv_canvas_create(screen);
  lv_canvas_set_buffer(
      canvas,
      framebuffer,
      PJ_FRAMEBUFFER_WIDTH,
      PJ_FRAMEBUFFER_HEIGHT,
      LV_COLOR_FORMAT_RGB565);
  lv_obj_set_pos(canvas, PJ_CONTENT_X, PJ_CONTENT_Y);
  lv_obj_set_style_pad_all(canvas, 0, LV_PART_MAIN);
  lv_obj_set_style_border_width(canvas, 0, LV_PART_MAIN);
  lv_obj_set_style_radius(canvas, 0, LV_PART_MAIN);
  lv_obj_add_flag(canvas, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_add_event_cb(canvas, canvas_touch_event, LV_EVENT_PRESSED, NULL);
  lv_obj_add_event_cb(canvas, canvas_touch_event, LV_EVENT_PRESSING, NULL);
  lv_obj_add_event_cb(canvas, canvas_touch_event, LV_EVENT_PRESS_LOST, NULL);
  lv_obj_add_event_cb(canvas, canvas_touch_event, LV_EVENT_RELEASED, NULL);
  bsp_display_unlock();

  ESP_ERROR_CHECK(bsp_display_backlight_on());
}

/* ---- UART device receipt protocol ------------------------------------- */
static char serial_line[64];
static uint8_t serial_length;

static void serial_init(void) {
  const uart_config_t config = {
      .baud_rate = 115200,
      .data_bits = UART_DATA_8_BITS,
      .parity = UART_PARITY_DISABLE,
      .stop_bits = UART_STOP_BITS_1,
      .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
      .source_clk = UART_SCLK_DEFAULT,
  };
  ESP_ERROR_CHECK(uart_param_config(UART_NUM_0, &config));
  ESP_ERROR_CHECK(uart_set_pin(
      UART_NUM_0,
      UART_PIN_NO_CHANGE,
      UART_PIN_NO_CHANGE,
      UART_PIN_NO_CHANGE,
      UART_PIN_NO_CHANGE));
  ESP_ERROR_CHECK(uart_driver_install(UART_NUM_0, 1024, 0, 0, NULL, 0));
  uart_vfs_dev_use_driver(UART_NUM_0);
}

static void receipt_ready(void) {
  printf(
      "PJREADY board=%s chip=%s host=%s abi=%" PRIu32
      " app=%s build=%s quickjs=1 logical=%dx%d framebuffer=%dx%d"
      " panel=%dx%d content=%d,%d,%d,%d fps=%d ppa=%" PRIu32 "\n",
      PJ_BOARD_ID,
      CONFIG_IDF_TARGET,
      pocketjs_runtime_host_id(),
      pocketjs_runtime_host_abi(),
      POCKETJS_APP_TITLE,
      POCKETJS_BUILD_ID,
      PJ_LOGICAL_WIDTH,
      PJ_LOGICAL_HEIGHT,
      PJ_FRAMEBUFFER_WIDTH,
      PJ_FRAMEBUFFER_HEIGHT,
      PJ_PANEL_WIDTH,
      PJ_PANEL_HEIGHT,
      PJ_CONTENT_X,
      PJ_CONTENT_Y,
      PJ_FRAMEBUFFER_WIDTH,
      PJ_FRAMEBUFFER_HEIGHT,
      PJ_FRAME_RATE,
      last_stats.ppa_active);
}

static void receipt_frame(void) {
  last_screen_hash = pocketjs_runtime_framebuffer_hash(framebuffer, PJ_FRAMEBUFFER_PIXELS);
  printf(
      "PJFRAME frame=%" PRIu32 " draw=%016" PRIx64 " screen=%016" PRIx64
      " ppa_fill=%" PRIu32 " ppa_blend=%" PRIu32 " ppa_srm=%" PRIu32
      " software=%" PRIu32 " damage_regions=%" PRIu32 " damage_pixels=%" PRIu32
      " full=%" PRIu32 " buttons=0x%08" PRIx32 " touch=%d\n",
      last_stats.frame,
      last_stats.draw_hash,
      last_screen_hash,
      last_stats.ppa_fills,
      last_stats.ppa_blends,
      last_stats.ppa_srm,
      last_stats.software_ops,
      last_stats.damage_regions,
      last_stats.damage_pixels,
      last_stats.full_redraw,
      last_buttons,
      current_touch.down ? 1 : 0);
}

static void receipt_touch(const TouchSnapshot *touch) {
  printf(
      "PJTOUCH source=gt911 down=%d panel=%d,%d logical=%d,%d packed=%08" PRIx32 "\n",
      touch->down ? 1 : 0,
      touch->panel_x,
      touch->panel_y,
      touch->logical_x,
      touch->logical_y,
      touch->packed);
}

static void receipt_error(const char *stage) {
  char error[256] = {0};
  (void)pocketjs_runtime_last_error(error, sizeof(error));
  printf("PJERROR stage=%s message=%s\n", stage, error[0] == '\0' ? "unknown" : error);
}

static bool parse_button_mask(const char *line, uint32_t *mask) {
  const char *cursor = line + 1;
  char *end = NULL;
  unsigned long value;
  while (*cursor == ' ' || *cursor == '\t') cursor++;
  if (*cursor == '\0' || *cursor == '-') return false;
  errno = 0;
  value = strtoul(cursor, &end, 0);
  if (errno != 0 || end == cursor || value > UINT32_MAX) return false;
  while (*end == ' ' || *end == '\t') end++;
  if (*end != '\0') return false;
  *mask = (uint32_t)value;
  return true;
}

static void handle_serial_line(void) {
  uint32_t mask;
  if (serial_length == 0) return;
  serial_line[serial_length] = '\0';
  if (strcmp(serial_line, "H") == 0) {
    if (runtime_ready) receipt_ready();
    else printf("PJSTATUS ready=0\n");
  } else if (strcmp(serial_line, "D") == 0) {
    receipt_frame();
  } else if (serial_line[0] == 'P' && parse_button_mask(serial_line, &mask)) {
    injected_buttons = mask;
    injected_frames = 1;
    printf("PJACK buttons=0x%08" PRIx32 " frames=1\n", mask);
  } else {
    printf("PJERR command=%s\n", serial_line);
  }
}

static void serial_poll(void) {
  uint8_t byte;
  int count;
  while ((count = uart_read_bytes(UART_NUM_0, &byte, 1, 0)) == 1) {
    if (byte == '\r') continue;
    if (byte == '\n') {
      handle_serial_line();
      serial_length = 0;
    } else if (serial_length + 1 < sizeof(serial_line)) {
      serial_line[serial_length++] = (char)byte;
    } else {
      serial_length = 0;
      printf("PJERR line-too-long\n");
    }
  }
  if (count < 0) ESP_LOGW(TAG, "UART read failed: %d", count);
}

static bool render_and_present(uint32_t buttons) {
  const uint32_t *touches = current_touch.down ? &current_touch.packed : NULL;
  size_t touch_count = current_touch.down ? 1 : 0;

  /* The LVGL lock covers the complete call because the Rust C ABI combines
   * the guest turn and framebuffer mutation. lv_refr_now consumes the canvas
   * while the same lock is held, so the next frame can never race its source. */
  if (!bsp_display_lock(0)) {
    ESP_LOGE(TAG, "could not acquire LVGL lock for frame");
    return false;
  }
  int ok = pocketjs_runtime_frame(
      runtime,
      buttons,
      touches,
      touch_count,
      framebuffer,
      PJ_FRAMEBUFFER_PIXELS,
      &last_stats);
  if (ok && (last_stats.full_redraw || last_stats.damage_regions > 0)) {
    esp_err_t sync = esp_cache_msync(
        framebuffer,
        PJ_FRAMEBUFFER_BYTES,
        ESP_CACHE_MSYNC_FLAG_DIR_C2M);
    if (sync != ESP_OK) {
      ESP_LOGE(TAG, "framebuffer cache sync failed: %s", esp_err_to_name(sync));
      ok = 0;
    } else {
      lv_obj_invalidate(canvas);
      lv_refr_now(display);
    }
  }
  bsp_display_unlock();
  return ok != 0;
}

void app_main(void) {
  TickType_t last_wake;
  uint32_t frame_phase = 0;
  const size_t java_script_len = (size_t)(app_js_end - app_js_start);
  const size_t pak_len = (size_t)(app_pak_end - app_pak_start);

  setvbuf(stdout, NULL, _IONBF, 0);
  serial_init();

  framebuffer = heap_caps_aligned_alloc(
      PJ_CACHE_ALIGNMENT,
      PJ_FRAMEBUFFER_BYTES,
      MALLOC_CAP_SPIRAM | MALLOC_CAP_DMA);
  if (framebuffer == NULL) {
    ESP_LOGE(TAG, "could not allocate %u-byte RGB565 framebuffer in PSRAM",
             (unsigned)PJ_FRAMEBUFFER_BYTES);
    ESP_ERROR_CHECK(ESP_ERR_NO_MEM);
  }
  memset(framebuffer, 0, PJ_FRAMEBUFFER_BYTES);

  touch_queue = xQueueCreate(1, sizeof(TouchSnapshot));
  if (touch_queue == NULL) {
    ESP_LOGE(TAG, "could not create GT911 snapshot queue");
    ESP_ERROR_CHECK(ESP_ERR_NO_MEM);
  }

  display_init();
  if (pocketjs_runtime_framebuffer_width() != PJ_FRAMEBUFFER_WIDTH ||
      pocketjs_runtime_framebuffer_height() != PJ_FRAMEBUFFER_HEIGHT) {
    ESP_LOGE(TAG, "Rust runtime and board framebuffer contracts disagree");
    ESP_ERROR_CHECK(ESP_ERR_INVALID_SIZE);
  }

  runtime = pocketjs_runtime_create(app_js_start, java_script_len, app_pak_start, pak_len);
  if (runtime == NULL) {
    receipt_error("boot");
    ESP_ERROR_CHECK(ESP_FAIL);
  }

  last_wake = xTaskGetTickCount();
  for (;;) {
    TouchSnapshot touch;
    if (xQueueReceive(touch_queue, &touch, 0) == pdTRUE) {
      current_touch = touch;
      receipt_touch(&touch);
    }
    serial_poll();

    last_buttons = injected_frames > 0 ? injected_buttons : 0;
    if (!render_and_present(last_buttons)) {
      receipt_error("frame");
      ESP_ERROR_CHECK(ESP_FAIL);
    }
    if (injected_frames > 0) injected_frames--;

    if (!runtime_ready) {
      runtime_ready = true;
      receipt_ready();
      receipt_frame();
    } else if (last_stats.frame % PJ_RECEIPT_PERIOD == 0) {
      receipt_frame();
    }

    /* Exact 60 Hz average at a 1 kHz FreeRTOS tick without drift. */
    frame_phase += configTICK_RATE_HZ;
    TickType_t frame_ticks = frame_phase / PJ_FRAME_RATE;
    frame_phase %= PJ_FRAME_RATE;
    xTaskDelayUntil(&last_wake, frame_ticks);
  }
}
