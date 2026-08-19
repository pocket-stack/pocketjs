# net-smoke firmware. Build from a copy or a symlinked project directory:
#   idf.py -B build set-target esp32s3 && idf.py build flash monitor
cmake_minimum_required(VERSION 3.16)
get_filename_component(POCKETJS_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../../../.." ABSOLUTE)
list(APPEND EXTRA_COMPONENT_DIRS "${POCKETJS_ROOT}/hosts/esp-idf/components")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(pocketjs_net_smoke)
