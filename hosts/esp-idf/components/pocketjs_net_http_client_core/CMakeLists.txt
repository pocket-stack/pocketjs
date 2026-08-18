idf_component_register(
    SRCS
        "src/http_client_core.c"
        "src/http_client_core_esp.c"
    INCLUDE_DIRS "include"
    REQUIRES pocketjs_net_http1 pocketjs_net_esp_transport
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
