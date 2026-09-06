cmake_minimum_required(VERSION 3.22)

set(pocketjs_components "../../components")
list(APPEND EXTRA_COMPONENT_DIRS
    "${pocketjs_components}/pocketjs_package"
    "${pocketjs_components}/pocketjs_guest"
    "${pocketjs_components}/pocketjs_ui_core"
    "${pocketjs_components}/pocketjs_ui_qjs"
    "${pocketjs_components}/pocketjs_render_rgb565")
set(pocketjs_idf_target "${IDF_TARGET}")
if(NOT pocketjs_idf_target AND DEFINED ENV{IDF_TARGET})
    set(pocketjs_idf_target "$ENV{IDF_TARGET}")
endif()
if(pocketjs_idf_target STREQUAL "esp32p4")
    list(APPEND EXTRA_COMPONENT_DIRS "${pocketjs_components}/pocketjs_esp32p4_ppa")
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
idf_build_set_property(MINIMAL_BUILD ON)
project(pocketjs_idf_prebuilt)
