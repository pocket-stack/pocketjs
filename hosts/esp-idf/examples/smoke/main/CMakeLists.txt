set(pocketjs_smoke_requires
    pocketjs_package
    pocketjs_guest
    pocketjs_ui_core
    pocketjs_ui_qjs
    pocketjs_render_rgb565)
if(IDF_TARGET STREQUAL "esp32p4")
    list(APPEND pocketjs_smoke_requires pocketjs_esp32p4_ppa)
endif()

idf_component_register(
    SRCS "main.c"
    REQUIRES ${pocketjs_smoke_requires}
)

set(POCKETJS_SMOKE_PREBUILT_PACKAGE "" CACHE FILEPATH
    "Use an existing idf-smoke.pocket instead of invoking the PocketJS CLI")
if(NOT POCKETJS_SMOKE_PREBUILT_PACKAGE AND
   EXISTS "${CMAKE_CURRENT_LIST_DIR}/../idf-smoke.pocket")
    set(POCKETJS_SMOKE_PREBUILT_PACKAGE
        "${CMAKE_CURRENT_LIST_DIR}/../idf-smoke.pocket")
endif()
if(POCKETJS_SMOKE_PREBUILT_PACKAGE)
    pocketjs_embed_package(
        TARGET ${COMPONENT_LIB}
        NAME smoke
        PACKAGE "${POCKETJS_SMOKE_PREBUILT_PACKAGE}"
        HOST_PROFILE "../pocket.host.json")
else()
    pocketjs_compile_app(
        TARGET ${COMPONENT_LIB}
        NAME smoke
        MANIFEST "../pocket.json"
        HOST_PROFILE "../pocket.host.json"
        PROJECT_ROOT "..")
endif()
