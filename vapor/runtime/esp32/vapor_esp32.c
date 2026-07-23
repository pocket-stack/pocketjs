/* vapor/runtime/esp32/vapor_esp32.c — Pocket Vapor on classic ESP32.
 *
 * The generated application and vapor_core.c remain allocator-free. This
 * target owns the hardware boundary: an SPI LCD, a release-latched button
 * pad, the 60 Hz frame loop, and a UART receipt protocol used by the
 * real-device parity runner.
 *
 * Board profiles choose the logical geometry and physical cell size. The
 * ESP32 MeowBit profile renders a 20x18 grid as 8x7 cells centered on its
 * 160x128 ST7735 panel.
 */
#include "vapor.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "driver/uart.h"
#include "driver/uart_vfs.h"
#include "esp_check.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#ifndef VP_ESP32_BOARD
#define VP_ESP32_BOARD "serial"
#endif
#ifndef VP_BUILD_ID
#define VP_BUILD_ID "unknown"
#endif
#ifndef VP_DEBUG_STATE_BYTES
#define VP_DEBUG_STATE_BYTES 1
#endif

#ifndef VP_LCD_ENABLED
#define VP_LCD_ENABLED 0
#endif
#ifndef VP_LCD_CONTROLLER
#define VP_LCD_CONTROLLER 0 /* 1 = ILI934x, 2 = ST7789, 3 = ST7735 */
#endif
#ifndef VP_LCD_WIDTH
#define VP_LCD_WIDTH 320
#endif
#ifndef VP_LCD_HEIGHT
#define VP_LCD_HEIGHT 240
#endif
#ifndef VP_LCD_CELL_W
#define VP_LCD_CELL_W 8
#endif
#ifndef VP_LCD_CELL_H
#define VP_LCD_CELL_H 8
#endif
#ifndef VP_LCD_OFFSET_X
#define VP_LCD_OFFSET_X 0
#endif
#ifndef VP_LCD_OFFSET_Y
#define VP_LCD_OFFSET_Y 0
#endif
#ifndef VP_LCD_MADCTL
#define VP_LCD_MADCTL 0x60
#endif
#ifndef VP_LCD_SCLK
#define VP_LCD_SCLK 18
#endif
#ifndef VP_LCD_MOSI
#define VP_LCD_MOSI 23
#endif
#ifndef VP_LCD_CS
#define VP_LCD_CS 14
#endif
#ifndef VP_LCD_DC
#define VP_LCD_DC 27
#endif
#ifndef VP_LCD_RST
#define VP_LCD_RST 33
#endif
#ifndef VP_LCD_BL
#define VP_LCD_BL 32
#endif
#ifndef VP_LCD_BL_ON
#define VP_LCD_BL_ON 1
#endif
#ifndef VP_LCD_SPI_HZ
#define VP_LCD_SPI_HZ (30 * 1000 * 1000)
#endif

#ifndef VP_BUTTON_COUNT
#define VP_BUTTON_COUNT 0
#endif
#ifndef VP_BUTTON_UP
#define VP_BUTTON_UP -1
#endif
#ifndef VP_BUTTON_DOWN
#define VP_BUTTON_DOWN -1
#endif
#ifndef VP_BUTTON_LEFT
#define VP_BUTTON_LEFT -1
#endif
#ifndef VP_BUTTON_RIGHT
#define VP_BUTTON_RIGHT -1
#endif
#ifndef VP_BUTTON_A
#define VP_BUTTON_A -1
#endif
#ifndef VP_BUTTON_B
#define VP_BUTTON_B -1
#endif

#define VP_LCD_ILI934X 1
#define VP_LCD_ST7789 2
#define VP_LCD_ST7735 3
#define VP_PHYS_W (VP_GRID_W * VP_LCD_CELL_W)
#define VP_PHYS_H (VP_GRID_H * VP_LCD_CELL_H)
#define VP_ORIGIN_X (((VP_LCD_WIDTH - VP_PHYS_W) / 2) + VP_LCD_OFFSET_X)
#define VP_ORIGIN_Y (((VP_LCD_HEIGHT - VP_PHYS_H) / 2) + VP_LCD_OFFSET_Y)
#define VP_ROW_PIXELS (VP_PHYS_W * VP_LCD_CELL_H)

_Static_assert(VP_GRID_H <= 32, "ESP32 dirty-row mask supports at most 32 rows");
_Static_assert(VP_PHYS_W <= VP_LCD_WIDTH, "logical grid is wider than the panel");
_Static_assert(VP_PHYS_H <= VP_LCD_HEIGHT, "logical grid is taller than the panel");
_Static_assert(VP_BUTTON_COUNT <= 6, "ESP32 runtime supports at most six physical buttons");
_Static_assert(VP_DEBUG_STATE_BYTES <= 65535, "debug-state receipt length must fit in u16");

/* Runtime-owned logical screen. */
u8 vp_grid_ch[VP_GRID_H][VP_GRID_W];
u8 vp_grid_pal[VP_GRID_H][VP_GRID_W];

static const char *TAG = "pocket-vapor";
static u32 frame_no;
static u32 flush_no;
static u32 lcd_commit_no;

#if VP_LCD_ENABLED
static spi_device_handle_t lcd;
static u16 row_pixels[VP_ROW_PIXELS] __attribute__((aligned(4)));
static u16 clear_pixels[VP_LCD_WIDTH] __attribute__((aligned(4)));

typedef struct {
  u8 cmd;
  u8 len;
  u8 data[16];
  u16 delay_ms;
} lcd_init_cmd;

/* Conservative init accepted by ILI9341 and ILI9342C panels. */
static const lcd_init_cmd ili934x_init[] = {
    {0x01, 0, {0}, 120},
    {0x28, 0, {0}, 0},
    {0xcf, 3, {0x00, 0xc1, 0x30}, 0},
    {0xed, 4, {0x64, 0x03, 0x12, 0x81}, 0},
    {0xe8, 3, {0x85, 0x00, 0x78}, 0},
    {0xcb, 5, {0x39, 0x2c, 0x00, 0x34, 0x02}, 0},
    {0xf7, 1, {0x20}, 0},
    {0xea, 2, {0x00, 0x00}, 0},
    {0xc0, 1, {0x23}, 0},
    {0xc1, 1, {0x10}, 0},
    {0xc5, 2, {0x3e, 0x28}, 0},
    {0xc7, 1, {0x86}, 0},
    {0x36, 1, {VP_LCD_MADCTL}, 0},
    {0x3a, 1, {0x55}, 0},
    {0xb1, 2, {0x00, 0x18}, 0},
    {0xb6, 3, {0x08, 0x82, 0x27}, 0},
    {0xf2, 1, {0x00}, 0},
    {0x26, 1, {0x01}, 0},
    {0x11, 0, {0}, 120},
    {0x29, 0, {0}, 20},
};

static const lcd_init_cmd st7789_init[] = {
    {0x01, 0, {0}, 120},
    {0x11, 0, {0}, 120},
    {0x36, 1, {VP_LCD_MADCTL}, 0},
    {0x3a, 1, {0x55}, 0},
    {0xb2, 5, {0x0c, 0x0c, 0x00, 0x33, 0x33}, 0},
    {0xb7, 1, {0x35}, 0},
    {0xbb, 1, {0x19}, 0},
    {0xc0, 1, {0x2c}, 0},
    {0xc2, 1, {0x01}, 0},
    {0xc3, 1, {0x12}, 0},
    {0xc4, 1, {0x20}, 0},
    {0xc6, 1, {0x0f}, 0},
    {0xd0, 2, {0xa4, 0xa1}, 0},
    {0x21, 0, {0}, 0},
    {0x13, 0, {0}, 10},
    {0x29, 0, {0}, 20},
};

/* ST7735V sequence used by the ESP32 MeowBit's known-good framebuffer
 * firmware. The panel is 128x160 native, rotated into 160x128 landscape by
 * VP_LCD_MADCTL (0x60: MV | MX | RGB for this panel). */
static const lcd_init_cmd st7735_init[] = {
    {0x28, 0, {0}, 0},
    {0x01, 0, {0}, 150},
    {0x11, 0, {0}, 500},
    {0xb1, 3, {0x01, 0x2c, 0x2d}, 0},
    {0xb2, 3, {0x01, 0x2c, 0x2d}, 0},
    {0xb3, 6, {0x01, 0x2c, 0x2d, 0x01, 0x2c, 0x2d}, 0},
    {0xb4, 1, {0x07}, 0},
    {0xc0, 3, {0xa2, 0x02, 0x84}, 0},
    {0xc1, 1, {0xc5}, 0},
    {0xc2, 2, {0x0a, 0x00}, 0},
    {0xc3, 2, {0x8a, 0x2a}, 0},
    {0xc4, 2, {0x8a, 0xee}, 0},
    {0xc5, 1, {0x0e}, 0},
    {0x20, 0, {0}, 10},
    {0x36, 1, {0xc0}, 0},
    {0x3a, 1, {0x05}, 50},
    {0x2a, 4, {0x00, 0x00, 0x00, 0x7f}, 0},
    {0x2b, 4, {0x00, 0x00, 0x00, 0x9f}, 0},
    {0xe0, 16, {0x02, 0x1c, 0x07, 0x12, 0x37, 0x32, 0x29, 0x2d, 0x29, 0x25, 0x2b, 0x39, 0x00, 0x01, 0x03, 0x10}, 0},
    {0xe1, 16, {0x03, 0x1d, 0x07, 0x06, 0x2e, 0x2c, 0x29, 0x2d, 0x2e, 0x2e, 0x37, 0x3f, 0x00, 0x00, 0x02, 0x10}, 0},
    {0x13, 0, {0}, 10},
    {0x36, 1, {VP_LCD_MADCTL}, 0},
};

static void lcd_tx(int dc, const void *data, size_t len) {
  spi_transaction_t t;
  if (!len) return;
  memset(&t, 0, sizeof(t));
  gpio_set_level((gpio_num_t)VP_LCD_DC, dc);
  t.length = len * 8;
  t.tx_buffer = data;
  ESP_ERROR_CHECK(spi_device_polling_transmit(lcd, &t));
}

static void lcd_cmd(u8 cmd) { lcd_tx(0, &cmd, 1); }

static void lcd_data(const void *data, size_t len) { lcd_tx(1, data, len); }

static void lcd_window(u16 x, u16 y, u16 w, u16 h) {
  u8 col[4] = {(u8)(x >> 8), (u8)x, (u8)((x + w - 1) >> 8), (u8)(x + w - 1)};
  u8 row[4] = {(u8)(y >> 8), (u8)y, (u8)((y + h - 1) >> 8), (u8)(y + h - 1)};
  lcd_cmd(0x2a);
  lcd_data(col, sizeof(col));
  lcd_cmd(0x2b);
  lcd_data(row, sizeof(row));
  lcd_cmd(0x2c);
}

static void lcd_run_init(const lcd_init_cmd *cmds, size_t count) {
  size_t i;
  for (i = 0; i < count; i++) {
    lcd_cmd(cmds[i].cmd);
    if (cmds[i].len) lcd_data(cmds[i].data, cmds[i].len);
    if (cmds[i].delay_ms) vTaskDelay(pdMS_TO_TICKS(cmds[i].delay_ms));
  }
}

static void lcd_clear(void) {
  u16 color = (u16)((vp_backdrop << 8) | (vp_backdrop >> 8));
  int y, x;
  for (x = 0; x < VP_LCD_WIDTH; x++) clear_pixels[x] = color;
  lcd_window(0, 0, VP_LCD_WIDTH, VP_LCD_HEIGHT);
  for (y = 0; y < VP_LCD_HEIGHT; y++) lcd_data(clear_pixels, sizeof(clear_pixels));
}

static void lcd_init(void) {
  spi_bus_config_t bus = {
      .mosi_io_num = VP_LCD_MOSI,
      .miso_io_num = -1,
      .sclk_io_num = VP_LCD_SCLK,
      .quadwp_io_num = -1,
      .quadhd_io_num = -1,
      .max_transfer_sz = sizeof(row_pixels) > sizeof(clear_pixels) ? sizeof(row_pixels) : sizeof(clear_pixels),
  };
  spi_device_interface_config_t dev = {
      .clock_speed_hz = VP_LCD_SPI_HZ,
      .mode = 0,
      .spics_io_num = VP_LCD_CS,
      .queue_size = 1,
  };
  gpio_config_t outputs = {
      .pin_bit_mask = (1ULL << VP_LCD_DC),
      .mode = GPIO_MODE_OUTPUT,
  };

#if VP_LCD_RST >= 0
  outputs.pin_bit_mask |= 1ULL << VP_LCD_RST;
#endif
#if VP_LCD_BL >= 0
  outputs.pin_bit_mask |= 1ULL << VP_LCD_BL;
#endif
  ESP_ERROR_CHECK(gpio_config(&outputs));
#if VP_LCD_BL >= 0
  gpio_set_level((gpio_num_t)VP_LCD_BL, !VP_LCD_BL_ON);
#endif
#if VP_LCD_RST >= 0
  gpio_set_level((gpio_num_t)VP_LCD_RST, 0);
  vTaskDelay(pdMS_TO_TICKS(20));
  gpio_set_level((gpio_num_t)VP_LCD_RST, 1);
  vTaskDelay(pdMS_TO_TICKS(120));
#endif

  /* A raster row is larger than the non-DMA SPI driver's 64-byte ceiling. */
  ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));
  ESP_ERROR_CHECK(spi_bus_add_device(SPI2_HOST, &dev, &lcd));
  if (VP_LCD_CONTROLLER == VP_LCD_ST7789)
    lcd_run_init(st7789_init, sizeof(st7789_init) / sizeof(st7789_init[0]));
  else if (VP_LCD_CONTROLLER == VP_LCD_ST7735)
    lcd_run_init(st7735_init, sizeof(st7735_init) / sizeof(st7735_init[0]));
  else
    lcd_run_init(ili934x_init, sizeof(ili934x_init) / sizeof(ili934x_init[0]));
  lcd_clear();
  lcd_cmd(0x29);
  vTaskDelay(pdMS_TO_TICKS(20));
#if VP_LCD_BL >= 0
  gpio_set_level((gpio_num_t)VP_LCD_BL, VP_LCD_BL_ON);
#endif
}

static void lcd_paint_row(u8 y) {
  int py, px, cell_x;
  for (py = 0; py < VP_LCD_CELL_H; py++) {
    int font_y = (py * 8) / VP_LCD_CELL_H;
    for (cell_x = 0; cell_x < VP_GRID_W; cell_x++) {
      u8 ch = vp_grid_ch[y][cell_x];
      u8 pair = vp_grid_pal[y][cell_x];
      u8 bits;
      if (ch < 0x20 || ch > 0x7e) ch = '?';
      bits = vp_font_tiles[(u16)(ch - 0x20) * 8 + font_y];
      for (px = 0; px < VP_LCD_CELL_W; px++) {
        int font_x = (px * 8) / VP_LCD_CELL_W;
        u16 color = (bits & (0x80 >> font_x)) ? vp_ink565[pair] : vp_paper565[pair];
        /* Panels take RGB565 most-significant byte first. */
        row_pixels[py * VP_PHYS_W + cell_x * VP_LCD_CELL_W + px] = (u16)((color << 8) | (color >> 8));
      }
    }
  }
  lcd_window(VP_ORIGIN_X, VP_ORIGIN_Y + y * VP_LCD_CELL_H, VP_PHYS_W, VP_LCD_CELL_H);
  lcd_data(row_pixels, sizeof(row_pixels));
}

static void lcd_commit_rows(void) {
  u32 dirty = vp_rows_dirty;
  u8 y;
  if (!dirty) return;
  for (y = 0; y < VP_GRID_H; y++)
    if (dirty & vp_bit32[y]) lcd_paint_row(y);
  vp_rows_dirty = 0;
  lcd_commit_no++;
}
#else
static void lcd_init(void) {}
static void lcd_commit_rows(void) {
  if (vp_rows_dirty) lcd_commit_no++;
  vp_rows_dirty = 0;
}
#endif

/* ---- physical buttons ------------------------------------------------------
 *
 * MeowBit has six active-low buttons. Singles map directly to the Pocket
 * pad. Three release-latched chords expose the Todo actions for which the
 * board has no dedicated key:
 *   A+B=Start, Left+Right=Select, Up+Down=R
 */
#if VP_BUTTON_COUNT > 0
static const int button_pins[6] = {
    VP_BUTTON_UP, VP_BUTTON_DOWN, VP_BUTTON_LEFT, VP_BUTTON_RIGHT, VP_BUTTON_A, VP_BUTTON_B};
static u8 chord_seen;
static u8 chord_stable;
static u8 chord_last_raw;
static int64_t chord_changed_at;

static u8 buttons_raw(void) {
  u8 mask = 0;
  int i;
  for (i = 0; i < VP_BUTTON_COUNT; i++)
    if (!gpio_get_level((gpio_num_t)button_pins[i])) mask |= (u8)(1 << i);
  return mask;
}

static int chord_button(u8 mask) {
  static const s8 direct[6] = {6, 7, 5, 4, 0, 1};
  int i;
  if (mask == ((1 << 4) | (1 << 5))) return 3; /* A+B: Start */
  if (mask == ((1 << 2) | (1 << 3))) return 2; /* Left+Right: Select */
  if (mask == ((1 << 0) | (1 << 1))) return 8; /* Up+Down: R */
  for (i = 0; i < VP_BUTTON_COUNT && i < 6; i++)
    if (mask == (1 << i)) return direct[i];
  return -1;
}

static int poll_chord(void) {
  u8 raw = buttons_raw();
  int64_t now = esp_timer_get_time();
  int mapped;
  if (raw != chord_last_raw) {
    chord_last_raw = raw;
    chord_changed_at = now;
    return -1;
  }
  if (now - chord_changed_at < 20000 || raw == chord_stable) return -1;
  chord_stable = raw;
  if (raw) {
    chord_seen |= raw;
    return -1;
  }
  mapped = chord_button(chord_seen);
  chord_seen = 0;
  return mapped;
}

static void buttons_init(void) {
  gpio_config_t inputs;
  int i;
  memset(&inputs, 0, sizeof(inputs));
  for (i = 0; i < VP_BUTTON_COUNT; i++) inputs.pin_bit_mask |= 1ULL << button_pins[i];
  inputs.mode = GPIO_MODE_INPUT;
  /* GPIO34/35 are input-only and have no software pull resistors. The board
   * supplies their pull-ups; enable internal pull-ups on the other keys. */
  inputs.pull_up_en = GPIO_PULLUP_DISABLE;
  inputs.pull_down_en = GPIO_PULLDOWN_DISABLE;
  ESP_ERROR_CHECK(gpio_config(&inputs));
  for (i = 0; i < VP_BUTTON_COUNT; i++) {
    if (button_pins[i] < 34)
      ESP_ERROR_CHECK(gpio_set_pull_mode((gpio_num_t)button_pins[i], GPIO_PULLUP_ONLY));
  }
  chord_last_raw = buttons_raw();
  chord_stable = chord_last_raw;
  chord_seen = chord_stable;
  chord_changed_at = esp_timer_get_time();
}
#else
static int poll_chord(void) { return -1; }
static void buttons_init(void) {}
#endif

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
      VP_ESP32_BOARD,
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
  lcd_commit_rows();
  receipt_ready();
}

static void dispatch_button(u8 button) {
  if (button >= 10) return;
  app_on_button(button);
  if (app_flush()) flush_no++;
  lcd_commit_rows();
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
  setvbuf(stdout, NULL, _IONBF, 0);

  serial_init();
  lcd_init();
  buttons_init();
  runtime_reset();
  last_wake = xTaskGetTickCount();

  for (;;) {
    TickType_t frame_ticks;
    int button = poll_chord();
    if (button >= 0) dispatch_button((u8)button);
    serial_poll();
    if (app_flush()) flush_no++;
    lcd_commit_rows();
    frame_no++;
    /* Exact 60 Hz average without accumulating drift at a 1 kHz tick rate:
     * alternate 16/17-tick periods and anchor them to last_wake. */
    frame_phase += configTICK_RATE_HZ;
    frame_ticks = frame_phase / 60;
    frame_phase %= 60;
    xTaskDelayUntil(&last_wake, frame_ticks);
  }
}
