set(reqs esp_wifi esp_netif esp_event nvs_flash esp_driver_i2c)
if(CONFIG_IDF_TARGET_ESP32P4)
  list(APPEND reqs esp_wifi_remote esp_hosted)
endif()
idf_component_register(
    SRCS "src/board_wifi.c" "src/board_prepare.c"
    INCLUDE_DIRS "include"
    REQUIRES ${reqs}
    PRIV_REQUIRES log freertos)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
