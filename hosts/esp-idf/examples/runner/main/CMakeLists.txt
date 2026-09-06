idf_component_register(
    SRCS "main.c"
    REQUIRES pocketjs_package pocketjs_guest pocketjs_ui_core pocketjs_ui_qjs pocketjs_runner
)

set(POCKETJS_RUNNER_PREBUILT_PACKAGE "" CACHE FILEPATH "Prebuilt runner package")
if(NOT POCKETJS_RUNNER_PREBUILT_PACKAGE AND
   EXISTS "${CMAKE_CURRENT_LIST_DIR}/../../prebuilt/idf-smoke.pocket")
    set(POCKETJS_RUNNER_PREBUILT_PACKAGE "${CMAKE_CURRENT_LIST_DIR}/../../prebuilt/idf-smoke.pocket")
endif()
if(POCKETJS_RUNNER_PREBUILT_PACKAGE)
    pocketjs_embed_package(
        TARGET ${COMPONENT_LIB}
        NAME runner
        PACKAGE "${POCKETJS_RUNNER_PREBUILT_PACKAGE}"
        HOST_PROFILE "../../smoke/pocket.host.json")
else()
    pocketjs_compile_app(
        TARGET ${COMPONENT_LIB}
        NAME runner
        MANIFEST "../../smoke/pocket.json"
        HOST_PROFILE "../../smoke/pocket.host.json"
        PROJECT_ROOT "../../smoke")
endif()
