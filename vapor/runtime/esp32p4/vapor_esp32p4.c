/* vapor/runtime/esp32p4/vapor_esp32p4.c — Pocket Vapor on the Waveshare
 * ESP32-P4-WIFI6-Touch-LCD-7B.
 *
 * The generated application and vapor_core.c retain the same fixed-memory
 * contract as every Pocket Vapor target. This hardware boundary uses the
 * board vendor's ESP-IDF BSP for the 1024x600 EK79007 MIPI-DSI panel and
 * GT911 touch controller. LVGL owns display/input allocations; generated app
 * state remains allocator-free. The UI is rotated exactly as the vendor's
 * LVGL v9 example so displayed controls and touch coordinates remain paired.
 *
 * Touch callbacks never enter generated app code. They enqueue Pocket Button
 * ids, and the app_main task exclusively owns app_on_button/app_flush and the
 * logical grid. This keeps device-specific touch concepts out of app code.
 */
#include "vapor.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "bsp/esp-bsp.h"
#include "driver/uart.h"
#include "driver/uart_vfs.h"
#include "esp_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "lvgl.h"

#ifndef VP_BOARD_ID
#define VP_BOARD_ID "waveshare-esp32-p4-wifi6-touch-lcd-7b"
#endif
#ifndef VP_BUILD_ID
#define VP_BUILD_ID "unknown"
#endif
#ifndef VP_DEBUG_STATE_BYTES
#define VP_DEBUG_STATE_BYTES 1
#endif
#ifndef VP_LCD_ENABLED
#define VP_LCD_ENABLED 1
#endif
#ifndef VP_LCD_WIDTH
#define VP_LCD_WIDTH 1024
#endif
#ifndef VP_LCD_HEIGHT
#define VP_LCD_HEIGHT 600
#endif
#ifndef VP_LCD_CELL_W
#define VP_LCD_CELL_W 30
#endif
#ifndef VP_LCD_CELL_H
#define VP_LCD_CELL_H 30
#endif
#ifndef VP_TOUCH_BUTTON_MASK
#define VP_TOUCH_BUTTON_MASK 0x1ff
#endif
#ifndef VP_ABSENT_BUTTON_MASK
#define VP_ABSENT_BUTTON_MASK 0x200
#endif

#define VP_PHYS_W (VP_GRID_W * VP_LCD_CELL_W)
#define VP_PHYS_H (VP_GRID_H * VP_LCD_CELL_H)
#define VP_GRID_X 16
#define VP_GRID_Y 48
#define VP_TOUCH_QUEUE_DEPTH 16

_Static_assert(VP_GRID_W == 20, "ESP32-P4 touch layout requires the 20-column Vapor grid");
_Static_assert(VP_GRID_H == 18, "ESP32-P4 touch layout requires the 18-row Vapor grid");
_Static_assert(VP_LCD_WIDTH == 1024, "Waveshare ESP32-P4-7B panel width must be 1024");
_Static_assert(VP_LCD_HEIGHT == 600, "Waveshare ESP32-P4-7B panel height must be 600");
_Static_assert(BSP_LCD_H_RES == VP_LCD_WIDTH, "Pocket Vapor width must match the selected Waveshare BSP");
_Static_assert(BSP_LCD_V_RES == VP_LCD_HEIGHT, "Pocket Vapor height must match the selected Waveshare BSP");
_Static_assert(VP_LCD_CELL_W == 30 && VP_LCD_CELL_H == 30, "ESP32-P4-7B cells must be 30x30");
_Static_assert(VP_TOUCH_BUTTON_MASK == 0x1ff, "touch UI must expose Pocket buttons A through R");
_Static_assert(VP_ABSENT_BUTTON_MASK == 0x200, "the Waveshare touch UI must declare only L absent");
_Static_assert(VP_GRID_H <= 32, "dirty-row mask supports at most 32 rows");
_Static_assert(VP_PHYS_W <= VP_LCD_WIDTH, "logical grid is wider than the panel");
_Static_assert(VP_GRID_Y + VP_PHYS_H <= VP_LCD_HEIGHT, "logical grid is taller than the panel");
_Static_assert(VP_DEBUG_STATE_BYTES <= 65535, "debug-state receipt length must fit in u16");

/* Runtime-owned logical screen. */
u8 vp_grid_ch[VP_GRID_H][VP_GRID_W];
u8 vp_grid_pal[VP_GRID_H][VP_GRID_W];

static const char *TAG = "pocket-vapor-p4";
static u32 frame_no;
static u32 flush_no;
static u32 lcd_commit_no;
static QueueHandle_t touch_queue;
static lv_display_t *display;
static lv_obj_t *cells[VP_GRID_H][VP_GRID_W];

/* Pocket Button ids from vapor/host/input.ts. */
enum {
  VP_BUTTON_A = 0,
  VP_BUTTON_B = 1,
  VP_BUTTON_SELECT = 2,
  VP_BUTTON_START = 3,
  VP_BUTTON_RIGHT = 4,
  VP_BUTTON_LEFT = 5,
  VP_BUTTON_UP = 6,
  VP_BUTTON_DOWN = 7,
  VP_BUTTON_R = 8,
};

typedef struct {
  const char *label;
  u8 button;
  int16_t x;
  int16_t y;
  int16_t width;
  int16_t height;
} touch_button_spec;

static const touch_button_spec touch_buttons[] = {
    {"UP", VP_BUTTON_UP, 700, 115, 75, 75},
    {"LEFT", VP_BUTTON_LEFT, 625, 195, 75, 75},
    {"DOWN", VP_BUTTON_DOWN, 700, 275, 75, 75},
    {"RIGHT", VP_BUTTON_RIGHT, 775, 195, 75, 75},
    {"A", VP_BUTTON_A, 915, 125, 85, 85},
    {"B", VP_BUTTON_B, 875, 225, 85, 85},
    {"SELECT", VP_BUTTON_SELECT, 640, 425, 155, 65},
    {"START", VP_BUTTON_START, 825, 425, 165, 65},
    {"R", VP_BUTTON_R, 825, 515, 165, 65},
};

/* Treat hitboxes as half-open rectangles. Validate bounds, exact button
 * coverage, and pairwise disjointness before the BSP starts any hardware. */
static esp_err_t validate_touch_layout(void) {
  size_t i, j;
  u16 button_mask = 0;

  for (i = 0; i < sizeof(touch_buttons) / sizeof(touch_buttons[0]); i++) {
    const touch_button_spec *a = &touch_buttons[i];
    if (a->button >= 16 || a->width <= 0 || a->height <= 0 || a->x < 0 || a->y < 0 ||
        a->x + a->width > VP_LCD_WIDTH || a->y + a->height > VP_LCD_HEIGHT ||
        (button_mask & (u16)(1u << a->button))) {
      ESP_LOGE(TAG, "invalid touch hitbox %s", a->label);
      return ESP_ERR_INVALID_ARG;
    }
    button_mask |= (u16)(1u << a->button);

    for (j = 0; j < i; j++) {
      const touch_button_spec *b = &touch_buttons[j];
      if (a->x < b->x + b->width && b->x < a->x + a->width &&
          a->y < b->y + b->height && b->y < a->y + a->height) {
        ESP_LOGE(TAG, "touch hitboxes %s and %s overlap", a->label, b->label);
        return ESP_ERR_INVALID_ARG;
      }
    }
  }

  if (button_mask != VP_TOUCH_BUTTON_MASK) {
    ESP_LOGE(
        TAG,
        "touch button mask 0x%x does not match board mask 0x%x",
        (unsigned)button_mask,
        (unsigned)VP_TOUCH_BUTTON_MASK);
    return ESP_ERR_INVALID_ARG;
  }
  return ESP_OK;
}

static lv_color_t rgb565_color(u16 color) {
  uint8_t r = (uint8_t)(((color >> 11) & 0x1f) * 255 / 31);
  uint8_t g = (uint8_t)(((color >> 5) & 0x3f) * 255 / 63);
  uint8_t b = (uint8_t)((color & 0x1f) * 255 / 31);
  return lv_color_make(r, g, b);
}

static const char *button_name(u8 button) {
  switch (button) {
    case VP_BUTTON_A: return "A";
    case VP_BUTTON_B: return "B";
    case VP_BUTTON_SELECT: return "SELECT";
    case VP_BUTTON_START: return "START";
    case VP_BUTTON_RIGHT: return "RIGHT";
    case VP_BUTTON_LEFT: return "LEFT";
    case VP_BUTTON_UP: return "UP";
    case VP_BUTTON_DOWN: return "DOWN";
    case VP_BUTTON_R: return "R";
    default: return "UNKNOWN";
  }
}

/* Runs on the BSP's LVGL task. App state is deliberately not touched here. */
static void touch_button_clicked(lv_event_t *event) {
  u8 button;
  if (lv_event_get_code(event) != LV_EVENT_CLICKED) return;
  button = (u8)(uintptr_t)lv_event_get_user_data(event);
  (void)xQueueSend(touch_queue, &button, 0);
}

static void style_text(lv_obj_t *object, const lv_font_t *font, lv_color_t color) {
  lv_obj_set_style_text_font(object, font, LV_PART_MAIN);
  lv_obj_set_style_text_color(object, color, LV_PART_MAIN);
  lv_obj_set_style_text_align(object, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
}

static void create_cell_grid(lv_obj_t *screen) {
  u8 y, x;
  for (y = 0; y < VP_GRID_H; y++) {
    for (x = 0; x < VP_GRID_W; x++) {
      lv_obj_t *cell = lv_label_create(screen);
      cells[y][x] = cell;
      lv_obj_set_pos(cell, VP_GRID_X + x * VP_LCD_CELL_W, VP_GRID_Y + y * VP_LCD_CELL_H);
      lv_obj_set_size(cell, VP_LCD_CELL_W, VP_LCD_CELL_H);
      lv_obj_set_style_border_width(cell, 0, LV_PART_MAIN);
      lv_obj_set_style_radius(cell, 0, LV_PART_MAIN);
      lv_obj_set_style_pad_all(cell, 0, LV_PART_MAIN);
      lv_obj_set_style_pad_top(cell, 3, LV_PART_MAIN);
      lv_obj_set_style_bg_opa(cell, LV_OPA_COVER, LV_PART_MAIN);
      lv_obj_set_style_bg_color(cell, rgb565_color(vp_paper565[0]), LV_PART_MAIN);
      style_text(cell, &lv_font_montserrat_20, rgb565_color(vp_ink565[0]));
      lv_label_set_long_mode(cell, LV_LABEL_LONG_CLIP);
      lv_label_set_text(cell, " ");
    }
  }
}

static void create_touch_buttons(lv_obj_t *screen) {
  size_t i;
  for (i = 0; i < sizeof(touch_buttons) / sizeof(touch_buttons[0]); i++) {
    const touch_button_spec *spec = &touch_buttons[i];
    lv_obj_t *button = lv_button_create(screen);
    lv_obj_t *label;
    lv_obj_set_pos(button, spec->x, spec->y);
    lv_obj_set_size(button, spec->width, spec->height);
    lv_obj_set_style_radius(button, 18, LV_PART_MAIN);
    lv_obj_set_style_bg_color(button, lv_color_hex(0x252B35), LV_PART_MAIN);
    lv_obj_set_style_bg_color(button, lv_color_hex(0x4F7DFF), LV_PART_MAIN | LV_STATE_PRESSED);
    lv_obj_set_style_border_width(button, 2, LV_PART_MAIN);
    lv_obj_set_style_border_color(button, lv_color_hex(0x617086), LV_PART_MAIN);
    lv_obj_set_style_shadow_width(button, 12, LV_PART_MAIN);
    lv_obj_set_style_shadow_opa(button, LV_OPA_30, LV_PART_MAIN);
    lv_obj_add_event_cb(button, touch_button_clicked, LV_EVENT_CLICKED, (void *)(uintptr_t)spec->button);

    label = lv_label_create(button);
    style_text(label, &lv_font_montserrat_20, lv_color_hex(0xF8FAFC));
    lv_label_set_text(label, spec->label);
    lv_obj_center(label);
  }
}

static void create_ui(void) {
  lv_obj_t *screen = lv_screen_active();
  lv_obj_t *title;
  lv_obj_t *hint;

  lv_obj_remove_flag(screen, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_set_style_bg_color(screen, lv_color_hex(0x10141B), LV_PART_MAIN);
  lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, LV_PART_MAIN);

  title = lv_label_create(screen);
  style_text(title, &lv_font_montserrat_24, lv_color_hex(0xF3F6FC));
  lv_label_set_text_fmt(title, "Pocket Vapor - %s", vp_app_title);
  lv_obj_set_width(title, VP_PHYS_W);
  lv_obj_set_pos(title, VP_GRID_X, 9);

  create_cell_grid(screen);

  hint = lv_label_create(screen);
  style_text(hint, &lv_font_montserrat_20, lv_color_hex(0x94A3B8));
  lv_label_set_text(hint, "Touch controls");
  lv_obj_set_width(hint, VP_LCD_WIDTH - 640);
  lv_obj_set_pos(hint, 640, 28);

  create_touch_buttons(screen);
}

static void display_init(void) {
  bsp_display_cfg_t cfg = {
      .lvgl_port_cfg = ESP_LVGL_PORT_INIT_CONFIG(),
      .buffer_size = BSP_LCD_DRAW_BUFF_SIZE,
      .double_buffer = BSP_LCD_DRAW_BUFF_DOUBLE,
      .flags = {
          .buff_dma = true,
          .buff_spiram = false,
          .sw_rotate = true,
      },
  };

  display = bsp_display_start_with_config(&cfg);
  if (display == NULL) {
    ESP_LOGE(TAG, "EK79007/GT911 BSP initialization failed");
    ESP_ERROR_CHECK(ESP_FAIL);
  }
  /* Match the official Waveshare LVGL v9 example. esp_lvgl_port applies the
   * same transform to the display and its associated GT911 input device. */
  bsp_display_rotate(display, LV_DISPLAY_ROTATION_180);
  if (!bsp_display_lock(0)) {
    ESP_LOGE(TAG, "could not acquire LVGL lock while creating UI");
    ESP_ERROR_CHECK(ESP_ERR_TIMEOUT);
  }
  create_ui();
  bsp_display_unlock();
  ESP_ERROR_CHECK(bsp_display_backlight_on());
}

static void display_commit_rows(void) {
  u32 dirty = vp_rows_dirty;
  u8 y, x;
  if (!dirty) return;
  if (!bsp_display_lock(0)) {
    vp_tripwires |= VP_TRIP_PLATFORM_RENDER;
    return;
  }
  for (y = 0; y < VP_GRID_H; y++) {
    if (!(dirty & vp_bit32[y])) continue;
    for (x = 0; x < VP_GRID_W; x++) {
      u8 ch = vp_grid_ch[y][x];
      u8 pair = vp_grid_pal[y][x];
      char text[2];
      /* Palette ids originate in compiler-generated paint code and index the
       * generated RGB565 tables directly, as in the classic ESP32 runtime. */
      if (ch < 0x20 || ch > 0x7e) ch = '?';
      text[0] = (char)ch;
      text[1] = '\0';
      lv_obj_set_style_bg_color(cells[y][x], rgb565_color(vp_paper565[pair]), LV_PART_MAIN);
      lv_obj_set_style_text_color(cells[y][x], rgb565_color(vp_ink565[pair]), LV_PART_MAIN);
      lv_label_set_text(cells[y][x], text);
    }
  }
  bsp_display_unlock();
  vp_rows_dirty &= ~dirty;
  lcd_commit_no++;
}

/* ---- UART device receipt protocol ---------------------------------------- */
static char serial_line[32];
static u8 serial_len;

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
  ESP_ERROR_CHECK(
      uart_set_pin(UART_NUM_0, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));
  ESP_ERROR_CHECK(uart_driver_install(UART_NUM_0, 512, 0, 0, NULL, 0));
  uart_vfs_dev_use_driver(UART_NUM_0);
}

static void print_hex(const u8 *bytes, u16 len) {
  static const char hex[] = "0123456789abcdef";
  u16 i;
  for (i = 0; i < len; i++) {
    putchar(hex[bytes[i] >> 4]);
    putchar(hex[bytes[i] & 15]);
  }
  putchar('\n');
}

static void receipt_ready(void) {
  printf(
      "PVREADY board=%s chip=%s build=%s grid=%dx%d lcd=%d panel=%dx%d cell=%dx%d frame=%lu flush=%lu commit=%lu\n",
      VP_BOARD_ID,
      CONFIG_IDF_TARGET,
      VP_BUILD_ID,
      VP_GRID_W,
      VP_GRID_H,
      VP_LCD_ENABLED,
      VP_LCD_WIDTH,
      VP_LCD_HEIGHT,
      VP_LCD_CELL_W,
      VP_LCD_CELL_H,
      (unsigned long)frame_no,
      (unsigned long)flush_no,
      (unsigned long)lcd_commit_no);
}

static void receipt_grid(void) {
  volatile u8 state[VP_DEBUG_STATE_BYTES];
  u16 state_len = app_debug_state(state);
  printf(
      "PVGRID frame=%lu flush=%lu commit=%lu trips=%u state=%u\n",
      (unsigned long)frame_no,
      (unsigned long)flush_no,
      (unsigned long)lcd_commit_no,
      vp_tripwires,
      state_len);
  printf("PVCH ");
  print_hex((const u8 *)vp_grid_ch, VP_GRID_W * VP_GRID_H);
  printf("PVPA ");
  print_hex((const u8 *)vp_grid_pal, VP_GRID_W * VP_GRID_H);
  printf("PVEND\n");
}

static void runtime_reset(void) {
  vp_tripwires = 0;
  vp_rows_dirty = 0;
  vp_row_clear(0, VP_GRID_H);
  app_init();
  if (app_flush()) flush_no++;
  /* app_init paints every effect, but unchanged boot cells can otherwise
   * retain a clean bit after an in-process reset. Force the physical frame. */
  vp_rows_dirty = VP_GRID_H == 32 ? 0xffffffffUL : (vp_bit32[VP_GRID_H] - 1);
  display_commit_rows();
  receipt_ready();
}

static void dispatch_button(u8 button) {
  if (button >= 10) return;
  app_on_button(button);
  if (app_flush()) flush_no++;
  display_commit_rows();
  printf(
      "PVACK button=%u frame=%lu flush=%lu commit=%lu trips=%u\n",
      button,
      (unsigned long)frame_no,
      (unsigned long)flush_no,
      (unsigned long)lcd_commit_no,
      vp_tripwires);
}

static void handle_serial_line(void) {
  int button;
  if (serial_len == 0) return;
  serial_line[serial_len] = '\0';
  if (serial_line[0] == 'H')
    receipt_ready();
  else if (serial_line[0] == 'D')
    receipt_grid();
  else if (serial_line[0] == 'R')
    runtime_reset();
  else if (sscanf(serial_line, "P %d", &button) == 1 && button >= 0 && button < 10)
    dispatch_button((u8)button);
  else
    printf("PVERR command=%s\n", serial_line);
}

static void serial_poll(void) {
  u8 ch;
  int n;
  while ((n = uart_read_bytes(UART_NUM_0, &ch, 1, 0)) == 1) {
    if (ch == '\r') continue;
    if (ch == '\n') {
      handle_serial_line();
      serial_len = 0;
    } else if (serial_len + 1 < sizeof(serial_line)) {
      serial_line[serial_len++] = (char)ch;
    } else {
      serial_len = 0;
      printf("PVERR line-too-long\n");
    }
  }
  if (n < 0) ESP_LOGW(TAG, "UART read failed: %d", n);
}

void app_main(void) {
  TickType_t last_wake;
  u32 frame_phase = 0;
  u8 button;
  setvbuf(stdout, NULL, _IONBF, 0);
  ESP_ERROR_CHECK(validate_touch_layout());

  touch_queue = xQueueCreate(VP_TOUCH_QUEUE_DEPTH, sizeof(u8));
  if (touch_queue == NULL) {
    ESP_LOGE(TAG, "could not create touch queue");
    ESP_ERROR_CHECK(ESP_ERR_NO_MEM);
  }

  serial_init();
  display_init();
  runtime_reset();
  last_wake = xTaskGetTickCount();

  for (;;) {
    TickType_t frame_ticks;
    while (xQueueReceive(touch_queue, &button, 0) == pdTRUE) {
      printf("PVTOUCH button=%u name=%s\n", button, button_name(button));
      dispatch_button(button);
    }
    serial_poll();
    if (app_flush()) flush_no++;
    display_commit_rows();
    frame_no++;
    /* Exact 60 Hz average without accumulating drift at a 1 kHz tick rate. */
    frame_phase += configTICK_RATE_HZ;
    frame_ticks = frame_phase / 60;
    frame_phase %= 60;
    xTaskDelayUntil(&last_wake, frame_ticks);
  }
}
