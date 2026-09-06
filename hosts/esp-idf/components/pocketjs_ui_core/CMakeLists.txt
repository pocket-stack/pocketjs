idf_component_register(
    SRCS "src/ui_core.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES heap log
    REQUIRED_IDF_TARGETS esp32p4 esp32s3
)

include("${CMAKE_CURRENT_LIST_DIR}/native_archive.cmake")
pocketjs_link_native("${CMAKE_CURRENT_LIST_DIR}" "ui-core" "pocketjs_idf_ui_core" "POCKETJS_UI_CORE_ARCHIVE")
target_link_options(${COMPONENT_LIB} INTERFACE
    "-Wl,--undefined=pocketjs_idf_rust_alloc"
    "-Wl,--undefined=pocketjs_idf_rust_dealloc"
    "-Wl,--undefined=pocketjs_idf_rust_panic")
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
