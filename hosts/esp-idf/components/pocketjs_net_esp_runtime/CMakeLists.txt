idf_component_register(
  SRCS
    "src/esp_runtime.c"
    "src/network_v1_binding.c"
    "src/runtime_contract.c"
  INCLUDE_DIRS
    "include"
    "../../../../contracts/spec/network/generated"
  PRIV_INCLUDE_DIRS "private"
  REQUIRES
    esp_timer
    pocketjs_esp_guest
    pocketjs_net_esp_transport
    pocketjs_net_http_client_core
    quickjs-ng
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
