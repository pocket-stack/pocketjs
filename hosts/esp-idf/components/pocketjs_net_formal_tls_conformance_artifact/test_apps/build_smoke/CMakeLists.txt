cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS
    "../.."
    "../../../pocketjs_esp_guest"
    "../../../pocketjs_net_http1"
    "../../../pocketjs_net_esp_transport"
    "../../../pocketjs_net_http_client_core"
    "../../../pocketjs_net_esp_runtime")
set(SDKCONFIG_DEFAULTS "sdkconfig.defaults")
set(SDKCONFIG "${CMAKE_BINARY_DIR}/sdkconfig")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(pocketjs_net_formal_tls_conformance_build_smoke)
