cmake_minimum_required(VERSION 3.22)

set(pocketjs_components "../../components")
list(APPEND EXTRA_COMPONENT_DIRS
    "${pocketjs_components}/pocketjs_package"
    "${pocketjs_components}/pocketjs_guest"
    "${pocketjs_components}/pocketjs_ui_core"
    "${pocketjs_components}/pocketjs_ui_qjs"
    "${pocketjs_components}/pocketjs_runner")
if(NOT DEFINED POCKETJS_RUST_FROM_SOURCE)
    set(POCKETJS_RUST_FROM_SOURCE ON CACHE BOOL "")
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
idf_build_set_property(MINIMAL_BUILD ON)
project(pocketjs_idf_runner)
