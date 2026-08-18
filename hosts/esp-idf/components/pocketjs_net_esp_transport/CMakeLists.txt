idf_component_register(
    SRCS
        "src/esp_transport.c"
        "src/transport_state.c"
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "private"
    REQUIRES esp_common freertos
    PRIV_REQUIRES esp-tls esp_timer lwip mbedtls
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
