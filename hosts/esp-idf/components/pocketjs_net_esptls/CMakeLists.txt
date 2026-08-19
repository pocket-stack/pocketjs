idf_component_register(
    SRCS "src/pnet_esp_tls.c"
    INCLUDE_DIRS "include"
    REQUIRES pocketjs_net_core esp-tls mbedtls
    PRIV_REQUIRES esp_common)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror -Wno-error=unused-parameter)
