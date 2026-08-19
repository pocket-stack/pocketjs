/* Board-specific preparation before esp_wifi_init(). */
#include "pocketjs/board.h"

#include "esp_log.h"
#include "sdkconfig.h"

static const char *TAG = "board";

#if CONFIG_IDF_TARGET_ESP32P4
/* Tab5: the ESP32-C6 module is powered through the second PI4IOE5V6408 IO
 * expander (0x44, bit 0 = WLAN_PWR_EN) on the internal I2C bus, and reached
 * over SDIO through esp_hosted. The expander register values are the ones
 * M5Stack's Tab5 demo programs; only bit 0 matters here. GPIO15 (P4) drives
 * the C6 EN pin through 1 kΩ and is left to esp_hosted's reset sequence,
 * which the sdkconfig must configure active-high. */
#include "driver/i2c_master.h"
#include "esp_hosted.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define TAB5_I2C_PORT 0
#define TAB5_I2C_SDA 31
#define TAB5_I2C_SCL 32
#define TAB5_PI4IOE2_ADDR 0x44
#define PI4IO_REG_CHIP_RESET 0x01
#define PI4IO_REG_IO_DIR 0x03
#define PI4IO_REG_OUT_SET 0x05
#define PI4IO_REG_OUT_H_IM 0x07
#define PI4IO_REG_PULL_EN 0x0B
#define PI4IO_REG_PULL_SEL 0x0D

static bool s_prepared;

static esp_err_t pi4io_write(i2c_master_dev_handle_t dev, uint8_t reg, uint8_t value) {
  uint8_t buf[2] = {reg, value};
  return i2c_master_transmit(dev, buf, sizeof buf, 100);
}

static esp_err_t tab5_power_wlan(void) {
  i2c_master_bus_config_t bus_cfg = {
      .clk_source = I2C_CLK_SRC_DEFAULT,
      .i2c_port = TAB5_I2C_PORT,
      .sda_io_num = TAB5_I2C_SDA,
      .scl_io_num = TAB5_I2C_SCL,
      .glitch_ignore_cnt = 7,
      .flags.enable_internal_pullup = true,
  };
  i2c_master_bus_handle_t bus;
  esp_err_t err = i2c_new_master_bus(&bus_cfg, &bus);
  if (err != ESP_OK) {
    /* The bus may already exist (a display BSP created it). */
    err = i2c_master_get_bus_handle(TAB5_I2C_PORT, &bus);
    if (err != ESP_OK) return err;
  }
  i2c_device_config_t dev_cfg = {
      .dev_addr_length = I2C_ADDR_BIT_LEN_7,
      .device_address = TAB5_PI4IOE2_ADDR,
      .scl_speed_hz = 400000,
  };
  i2c_master_dev_handle_t dev;
  err = i2c_master_bus_add_device(bus, &dev_cfg, &dev);
  if (err != ESP_OK) return err;
  /* Same programming as the M5Stack Tab5 demo for PI4IOE2. */
  err = pi4io_write(dev, PI4IO_REG_IO_DIR, 0xB9);
  if (err == ESP_OK) err = pi4io_write(dev, PI4IO_REG_OUT_SET, 0x09);
  if (err == ESP_OK) err = pi4io_write(dev, PI4IO_REG_OUT_H_IM, 0x06);
  if (err == ESP_OK) err = pi4io_write(dev, PI4IO_REG_PULL_EN, 0xF9);
  if (err == ESP_OK) err = pi4io_write(dev, PI4IO_REG_PULL_SEL, 0xB9);
  if (err == ESP_OK) {
    /* WLAN_PWR_EN = bit 0 high (read-modify-write like bsp_set_wifi_power_enable). */
    uint8_t reg = PI4IO_REG_OUT_SET;
    uint8_t cur = 0;
    if (i2c_master_transmit_receive(dev, &reg, 1, &cur, 1, 100) == ESP_OK) {
      err = pi4io_write(dev, PI4IO_REG_OUT_SET, (uint8_t)(cur | 0x01));
    } else {
      err = pi4io_write(dev, PI4IO_REG_OUT_SET, 0x09);
    }
  }
  i2c_master_bus_rm_device(dev);
  if (err != ESP_OK) return err;
  vTaskDelay(pdMS_TO_TICKS(200)); /* rail settle before the C6 reset sequence */
  return ESP_OK;
}

esp_err_t pocketjs_board_prepare_wifi(void) {
  if (s_prepared) return ESP_OK;
  ESP_LOGI(TAG, "Tab5: enabling the WLAN power rail");
  esp_err_t err = tab5_power_wlan();
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "Tab5: WLAN_PWR_EN failed: %s", esp_err_to_name(err));
    return err;
  }
  ESP_LOGI(TAG, "Tab5: starting the esp_hosted SDIO transport to the C6");
  int rc = esp_hosted_init();
  if (rc != 0) {
    ESP_LOGE(TAG, "esp_hosted_init: %d", rc);
    return ESP_FAIL;
  }
  rc = esp_hosted_connect_to_slave();
  if (rc != 0) {
    ESP_LOGE(TAG, "esp_hosted_connect_to_slave: %d", rc);
    return ESP_FAIL;
  }
  s_prepared = true;
  return ESP_OK;
}
#else
esp_err_t pocketjs_board_prepare_wifi(void) {
  ESP_LOGI(TAG, "native Wi-Fi: no board preparation needed");
  return ESP_OK;
}
#endif
