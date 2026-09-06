idf_component_register(
    SRCS "src/ui_qjs.c"
    INCLUDE_DIRS "include"
    REQUIRES pocketjs_guest pocketjs_ui_core
    PRIV_REQUIRES log
    REQUIRED_IDF_TARGETS esp32p4 esp32s3
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
