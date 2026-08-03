set(POCKETJS_APP_JS "${CMAKE_CURRENT_LIST_DIR}/app.js" CACHE FILEPATH
    "Target-bound PocketJS JavaScript bundle")
set(POCKETJS_APP_PAK "${CMAKE_CURRENT_LIST_DIR}/app.pak" CACHE FILEPATH
    "Target-bound PocketJS asset pak")
set(POCKETJS_APP_TITLE "PocketJS" CACHE STRING "Application title for device receipts")
set(POCKETJS_BUILD_ID "unknown" CACHE STRING "Deterministic firmware build id")

idf_component_register(
    SRCS "pocketjs_esp32p4.c"
    INCLUDE_DIRS "."
    REQUIRES
        waveshare__esp32_p4_wifi6_touch_lcd_7b
        pocketjs_ppa
        esp_driver_uart
        esp_mm
        heap
        pthread
        vfs
)

# ESP-IDF includes component CMake files once in an isolated early-expansion
# pass that only discovers dependencies. Cache arguments and imported targets
# are intentionally handled during the real configure pass below.
if(NOT CMAKE_BUILD_EARLY_EXPANSION)
if(NOT DEFINED POCKETJS_RUST_LIB AND NOT "$ENV{POCKETJS_RUST_LIB}" STREQUAL "")
    set(POCKETJS_RUST_LIB "$ENV{POCKETJS_RUST_LIB}")
endif()
if(NOT DEFINED POCKETJS_RUST_LIB OR NOT EXISTS "${POCKETJS_RUST_LIB}")
    message(FATAL_ERROR
        "Set POCKETJS_RUST_LIB to an absolute libpocketjs_esp32p4_runtime.a path")
endif()
foreach(bundle_path IN ITEMS "${POCKETJS_APP_JS}" "${POCKETJS_APP_PAK}")
    if(NOT EXISTS "${bundle_path}")
        message(FATAL_ERROR "PocketJS bundle input not found: ${bundle_path}")
    endif()
endforeach()

# RENAME_TO makes the C symbols independent of the generated project's
# absolute path: _binary_app_js_{start,end} and _binary_app_pak_{start,end}.
target_add_binary_data(${COMPONENT_LIB} "${POCKETJS_APP_JS}" BINARY RENAME_TO app_js)
target_add_binary_data(${COMPONENT_LIB} "${POCKETJS_APP_PAK}" BINARY RENAME_TO app_pak)

add_prebuilt_library(pocketjs_esp32p4_runtime "${POCKETJS_RUST_LIB}"
    REQUIRES pocketjs_ppa
    PRIV_REQUIRES log pthread vfs
)
target_link_libraries(${COMPONENT_LIB} PRIVATE pocketjs_esp32p4_runtime)

target_compile_definitions(${COMPONENT_LIB} PRIVATE
    POCKETJS_APP_TITLE="${POCKETJS_APP_TITLE}"
    POCKETJS_BUILD_ID="${POCKETJS_BUILD_ID}"
)
endif()
