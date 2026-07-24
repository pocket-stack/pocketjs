cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS "../../components")
set(COMPONENTS main)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(pocketjs_ppa_smoke)
