cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS "../..")
set(SDKCONFIG "${CMAKE_BINARY_DIR}/sdkconfig")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(pocketjs_net_http1_build_smoke)
