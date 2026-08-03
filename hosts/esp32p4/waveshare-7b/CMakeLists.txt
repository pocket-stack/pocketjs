cmake_minimum_required(VERSION 3.22)

# This directory is a copyable firmware-project template. Generated projects
# stay checkout-bound so the local ESP-IDF component and the Rust archive can
# never be picked up silently from another PocketJS checkout.
set(IDF_TARGET "esp32p4")

if(NOT DEFINED POCKETJS_REPO_ROOT AND NOT "$ENV{POCKETJS_REPO_ROOT}" STREQUAL "")
    set(POCKETJS_REPO_ROOT "$ENV{POCKETJS_REPO_ROOT}")
endif()
if(NOT DEFINED POCKETJS_REPO_ROOT OR
   NOT EXISTS "${POCKETJS_REPO_ROOT}/hosts/esp32p4/components/pocketjs_ppa/CMakeLists.txt")
    message(FATAL_ERROR
        "Set POCKETJS_REPO_ROOT to the PocketJS checkout that produced this firmware project")
endif()

list(APPEND EXTRA_COMPONENT_DIRS
    "${POCKETJS_REPO_ROOT}/hosts/esp32p4/components"
)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(pocketjs_esp32p4_waveshare_7b)
