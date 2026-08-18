idf_component_register(
  SRCS "build_smoke.c"
  INCLUDE_DIRS "."
  REQUIRES pocketjs_net_formal_tls_smoke_artifact
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
