# PocketJS network core (engine/net) as an ESP-IDF component: the portable C
# protocol cores plus the BSD-socket driver compiled against lwIP. Nothing in
# engine/net includes ESP-IDF headers; only the driver's FreeRTOS mutex and
# sdkconfig.h are pulled in through ESP_PLATFORM.
set(PNET_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../../../engine/net")
get_filename_component(PNET_ROOT "${PNET_ROOT}" ABSOLUTE)

idf_component_register(
    SRCS
        "${PNET_ROOT}/src/pnet_util.c"
        "${PNET_ROOT}/src/pnet_json.c"
        "${PNET_ROOT}/src/pnet_url.c"
        "${PNET_ROOT}/src/pnet_policy.c"
        "${PNET_ROOT}/src/pnet_http1.c"
        "${PNET_ROOT}/src/pnet_runtime.c"
        "${PNET_ROOT}/src/pnet_http_client.c"
        "${PNET_ROOT}/src/pnet_http_server.c"
        "${PNET_ROOT}/src/pnet_ws.c"
        "${PNET_ROOT}/drivers/posix/pnet_posix_driver.c"
    INCLUDE_DIRS
        "${PNET_ROOT}/include"
        "${PNET_ROOT}/drivers/posix"
    PRIV_INCLUDE_DIRS
        "${PNET_ROOT}/src"
    REQUIRES lwip
    PRIV_REQUIRES freertos)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror -Wno-error=format)
