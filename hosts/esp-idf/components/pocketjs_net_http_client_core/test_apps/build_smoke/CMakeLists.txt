cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS "../.." "../../../pocketjs_net_http1"
                         "../../../pocketjs_net_esp_transport")
set(SDKCONFIG "${CMAKE_BINARY_DIR}/sdkconfig")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(pocketjs_net_http_client_core_build_smoke)
