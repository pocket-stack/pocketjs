idf_component_register(
    SRCS "src/package.c"
    INCLUDE_DIRS "include"
    REQUIRED_IDF_TARGETS esp32p4 esp32s3
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
