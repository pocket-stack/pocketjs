# PocketJS network core — host build (macOS/Linux) for the conformance
# harness. ESP-IDF consumes the same sources through
# hosts/esp-idf/components/pocketjs_net_core.
#
#   cmake -S engine/net -B engine/net/build && cmake --build engine/net/build
#   ctest --test-dir engine/net/build --output-on-failure

cmake_minimum_required(VERSION 3.16)
project(pocketjs_net C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS ON)

set(PNET_CORE_SOURCES
    src/pnet_util.c
    src/pnet_json.c
    src/pnet_url.c
    src/pnet_policy.c
    src/pnet_http1.c
    src/pnet_runtime.c
    src/pnet_http_client.c
    src/pnet_http_server.c
    src/pnet_ws.c)

add_library(pocketjs_net STATIC ${PNET_CORE_SOURCES})
target_include_directories(pocketjs_net PUBLIC include PRIVATE src)
target_compile_options(pocketjs_net PRIVATE -Wall -Wextra -Werror -pedantic -Wshadow -Wconversion -Wno-sign-conversion)

add_library(pocketjs_net_posix STATIC drivers/posix/pnet_posix_driver.c)
target_include_directories(pocketjs_net_posix PUBLIC include drivers/posix)
target_compile_options(pocketjs_net_posix PRIVATE -Wall -Wextra -Werror -Wshadow)
target_link_libraries(pocketjs_net_posix PUBLIC pocketjs_net)

# Optional OpenSSL TlsProvider + TLS conformance harness (desktop only).
find_package(OpenSSL QUIET)
if(NOT OpenSSL_FOUND AND EXISTS "/opt/homebrew/opt/openssl@3")
  set(OPENSSL_ROOT_DIR "/opt/homebrew/opt/openssl@3")
  find_package(OpenSSL QUIET)
endif()

option(PNET_SANITIZE "Build the tests with ASan/UBSan" ON)

enable_testing()
add_executable(pnet_unit_test test/unit_test.c)
target_include_directories(pnet_unit_test PRIVATE src)
target_link_libraries(pnet_unit_test PRIVATE pocketjs_net)
# The shared conformance vectors (TypeScript reference, C core, Rust core).
get_filename_component(PNET_REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
target_compile_definitions(pnet_unit_test PRIVATE "PNET_VECTORS_DIR=\"${PNET_REPO_ROOT}/contracts/spec/vectors\"")
add_test(NAME unit COMMAND pnet_unit_test)

add_executable(pnet_host_test test/host_test.c)
target_include_directories(pnet_host_test PRIVATE src)
target_link_libraries(pnet_host_test PRIVATE pocketjs_net_posix pocketjs_net)
find_package(Threads REQUIRED)
target_link_libraries(pnet_host_test PRIVATE Threads::Threads)
add_test(NAME host COMMAND pnet_host_test)

if(OpenSSL_FOUND)
  add_library(pocketjs_net_openssl STATIC drivers/openssl/pnet_openssl_tls.c)
  target_include_directories(pocketjs_net_openssl PUBLIC include drivers/openssl PRIVATE src)
  target_link_libraries(pocketjs_net_openssl PUBLIC pocketjs_net OpenSSL::SSL OpenSSL::Crypto)
  target_compile_options(pocketjs_net_openssl PRIVATE -Wall -Wextra -Werror)

  add_executable(pnet_tls_test test/tls_test.c)
  target_include_directories(pnet_tls_test PRIVATE src drivers/openssl)
  target_link_libraries(pnet_tls_test PRIVATE pocketjs_net_openssl pocketjs_net_posix pocketjs_net OpenSSL::SSL OpenSSL::Crypto Threads::Threads)
  add_test(NAME tls COMMAND pnet_tls_test)
else()
  message(STATUS "OpenSSL not found; skipping the TLS provider and tls conformance test")
endif()

if(OpenSSL_FOUND AND PNET_SANITIZE)
  # OpenSSL leak reports from its one-time global init are not our bug.
  target_compile_options(pnet_tls_test PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer -g)
  target_link_options(pnet_tls_test PRIVATE -fsanitize=address,undefined)
  target_compile_options(pocketjs_net_openssl PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer -g)
endif()

if(PNET_SANITIZE)
  foreach(t pocketjs_net pocketjs_net_posix pnet_unit_test pnet_host_test)
    target_compile_options(${t} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer -g)
    target_link_options(${t} PRIVATE -fsanitize=address,undefined)
  endforeach()
endif()
