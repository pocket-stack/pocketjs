idf_component_register(
    SRCS "build_smoke.c"
    INCLUDE_DIRS "."
    REQUIRES pocketjs_net_esp_transport
    PRIV_REQUIRES mbedtls
)

target_compile_definitions(${COMPONENT_LIB}
    PRIVATE POCKETJS_NET_ESP_TRANSPORT_TEST_INTERNALS=1
)
