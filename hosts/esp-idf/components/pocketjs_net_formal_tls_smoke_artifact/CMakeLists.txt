include("${CMAKE_CURRENT_LIST_DIR}/../../cmake/pocketjs_generate_test_artifact.cmake")
pocketjs_generate_test_artifact(
  _pocketjs_generated
  "${CMAKE_CURRENT_LIST_DIR}/generate.ts"
)

idf_component_register(
  SRCS
    "${_pocketjs_generated}/formal_tls_smoke_metadata.c"
    "src/formal_tls_smoke_ipv4.c"
    "src/formal_tls_smoke_report.c"
    "src/formal_tls_smoke_runner.c"
  INCLUDE_DIRS
    "include"
    "../../../../contracts/spec/network/generated"
  PRIV_INCLUDE_DIRS
    "private"
  REQUIRES
    pocketjs_esp_guest
    pocketjs_net_esp_runtime
    esp_timer
    lwip
    quickjs-ng
)

target_add_binary_data(
  ${COMPONENT_LIB}
  "${_pocketjs_generated}/factory.js.bin"
  BINARY
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
