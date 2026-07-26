idf_component_register(
    SRCS "src/pocketjs_ppa.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_driver_ppa
    PRIV_REQUIRES log
)

# EspIdfPpaOps normally references this C ABI from a Rust static archive.
# Root the symbols so the one-pass linker extracts this component regardless
# of archive ordering.
target_link_options(${COMPONENT_LIB} INTERFACE
    "-Wl,--undefined=pocketjs_ppa_create"
    "-Wl,--undefined=pocketjs_ppa_destroy"
    "-Wl,--undefined=pocketjs_ppa_fill_rgb565"
    "-Wl,--undefined=pocketjs_ppa_blend_a8_rgb565"
    "-Wl,--undefined=pocketjs_ppa_srm_psm5650_rgb565"
)
