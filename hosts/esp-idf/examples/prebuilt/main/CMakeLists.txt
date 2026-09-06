set(pocketjs_prebuilt_requires
    pocketjs_package pocketjs_guest pocketjs_ui_core pocketjs_ui_qjs pocketjs_render_rgb565)
if(IDF_TARGET STREQUAL "esp32p4")
    list(APPEND pocketjs_prebuilt_requires pocketjs_esp32p4_ppa)
endif()

idf_component_register(
    SRCS "../../smoke/main/main.c"
    REQUIRES ${pocketjs_prebuilt_requires}
)

pocketjs_embed_package(
    TARGET ${COMPONENT_LIB}
    NAME smoke
    PACKAGE "../idf-smoke.pocket"
    HOST_PROFILE "../../smoke/pocket.host.json"
)
