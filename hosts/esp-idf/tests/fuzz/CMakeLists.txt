cmake_minimum_required(VERSION 3.20)
project(pocketjs_package_fuzz C)
set(POCKETJS_FUZZ_SANITIZERS "fuzzer,address,undefined" CACHE STRING "Standalone fuzz sanitizers")
get_filename_component(ROOT "${CMAKE_CURRENT_LIST_DIR}/../../../.." ABSOLUTE)
add_executable(package_fuzz package.c "${ROOT}/hosts/esp-idf/components/pocketjs_package/src/package.c")
target_include_directories(package_fuzz PRIVATE
  "${ROOT}/hosts/esp-idf/tests/host/include"
  "${ROOT}/hosts/esp-idf/components/pocketjs_package/include")
target_compile_options(package_fuzz PRIVATE -g -O1 "-fsanitize=${POCKETJS_FUZZ_SANITIZERS}")
target_link_options(package_fuzz PRIVATE "-fsanitize=${POCKETJS_FUZZ_SANITIZERS}")
