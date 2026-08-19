idf_component_register(
    SRCS "src/host.c" "src/net_binding.c"
    INCLUDE_DIRS "include"
    REQUIRES pocketjs_net_core pocketjs_net_esptls quickjs-ng
    PRIV_REQUIRES esp_timer heap freertos log)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
