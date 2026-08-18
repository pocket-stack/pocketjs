idf_component_register(
  SRCS
    "../../../../pocketjs_net_formal_tls_smoke_artifact/test_apps/build_smoke/main/build_smoke.c"
  INCLUDE_DIRS "."
  REQUIRES pocketjs_net_formal_tls_conformance_artifact
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
