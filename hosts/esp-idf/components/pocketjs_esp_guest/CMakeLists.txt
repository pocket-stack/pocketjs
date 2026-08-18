idf_component_register(
  SRCS "src/esp_guest.c"
  INCLUDE_DIRS "include"
  REQUIRES esp_timer heap quickjs-ng
)

target_compile_options(${COMPONENT_LIB} PRIVATE
    -Wall
    -Wextra
    -Werror
)
