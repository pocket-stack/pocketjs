idf_component_register(
    SRCS
        "src/accelerator.c"
        "src/pocketjs_ppa.c"
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "src"
    REQUIRES pocketjs_render_rgb565 esp_driver_ppa
    PRIV_REQUIRES log
    REQUIRED_IDF_TARGETS esp32p4
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
