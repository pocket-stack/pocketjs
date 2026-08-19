# The smoke firmware's guest bundle AND its network policy come from the
# smoke manifest's Build Plan: tools/esp-idf.ts resolves
# hosts/esp-idf/examples/net-smoke/pocket.json (format 3) plus this rig's
# endpoints (Kconfig) against the board's private profile and writes
# app.js, network-policy.json (the canonical ResolvedNetworkPolicy the host
# hands to the core verbatim), plan.json and host-inputs.h (plan hash,
# features) into the build directory. main.c embeds the first two and
# compiles against the header; it authors no policy of its own.
# Set POCKETJS_ROOT / BUN when the defaults do not match the checkout.
if(NOT DEFINED POCKETJS_ROOT)
  get_filename_component(POCKETJS_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../../../../.." ABSOLUTE)
endif()
if(NOT DEFINED BUN)
  find_program(BUN bun HINTS "$ENV{HOME}/.bun/bin" "/opt/homebrew/bin" "/usr/local/bin")
endif()
set(SMOKE_DIR "${POCKETJS_ROOT}/hosts/esp-idf/examples/net-smoke")
set(SMOKE_APP "${SMOKE_DIR}/app.ts")
set(SMOKE_MANIFEST "${SMOKE_DIR}/pocket.json")
set(SMOKE_OUT "${CMAKE_BINARY_DIR}/pocketjs-app")
set(SMOKE_JS "${SMOKE_OUT}/app.js")
set(SMOKE_POLICY "${SMOKE_OUT}/network-policy.json")
set(SMOKE_HEADER "${SMOKE_OUT}/host-inputs.h")

# Which private profile: the board name selects atoms3r-dev / tab5-dev.
if(CONFIG_SMOKE_BOARD_NAME STREQUAL "tab5")
  set(SMOKE_BOARD "tab5")
else()
  set(SMOKE_BOARD "atoms3r")
endif()

idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "${SMOKE_OUT}"
    REQUIRES pocketjs_esp_host pocketjs_board pocketjs_net_core
    PRIV_REQUIRES esp_timer heap
    EMBED_TXTFILES "${SMOKE_JS}" "${SMOKE_POLICY}")

add_custom_command(
    OUTPUT "${SMOKE_JS}" "${SMOKE_POLICY}" "${SMOKE_HEADER}"
    COMMAND "${BUN}" "${POCKETJS_ROOT}/tools/esp-idf.ts" smoke-inputs
            "--board=${SMOKE_BOARD}" "--outdir=${SMOKE_OUT}"
            "--mac-host=${CONFIG_SMOKE_MAC_HOST}" "--mac-http-port=${CONFIG_SMOKE_MAC_HTTP_PORT}"
            "--mac-ws-port=${CONFIG_SMOKE_MAC_WS_PORT}"
            "--peer-host=${CONFIG_SMOKE_PEER_HOST}" "--peer-port=${CONFIG_SMOKE_PEER_PORT}"
            "--serve-port=${CONFIG_SMOKE_SERVE_PORT}" "--tls-host=${CONFIG_SMOKE_TLS_HOST}"
            "--tick-hz=${CONFIG_SMOKE_TICK_HZ}"
    WORKING_DIRECTORY "${POCKETJS_ROOT}"
    DEPENDS "${SMOKE_APP}" "${SMOKE_MANIFEST}" "${POCKETJS_ROOT}/tools/esp-idf.ts" "${POCKETJS_ROOT}/tools/esp-idf-profile.ts"
            "${CMAKE_BINARY_DIR}/config/sdkconfig.h"
    COMMENT "PocketJS: resolving the smoke plan (${SMOKE_BOARD}) and bundling ${SMOKE_APP}"
    VERBATIM)
add_custom_target(pocketjs_smoke_inputs DEPENDS "${SMOKE_JS}" "${SMOKE_POLICY}" "${SMOKE_HEADER}")
add_dependencies(${COMPONENT_LIB} pocketjs_smoke_inputs)
