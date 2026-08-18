idf_component_register(
    SRCS "build_smoke.c"
    INCLUDE_DIRS "."
    REQUIRES pocketjs_net_http1
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
