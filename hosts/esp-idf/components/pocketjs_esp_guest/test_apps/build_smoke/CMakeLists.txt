cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS "../..")
set(SDKCONFIG "${CMAKE_BINARY_DIR}/sdkconfig")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
idf_build_set_property(MINIMAL_BUILD ON)
project(pocketjs_esp_guest_build_smoke)
