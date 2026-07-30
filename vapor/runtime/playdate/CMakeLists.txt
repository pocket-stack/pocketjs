cmake_minimum_required(VERSION 3.19)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

foreach(REQUIRED SDK VP_RUNTIME_DIR VP_GEN_APP VP_STAGE_DIR VP_BUILD_ID VP_DEBUG_STATE_BYTES)
  if(NOT DEFINED ${REQUIRED} OR "${${REQUIRED}}" STREQUAL "")
    message(FATAL_ERROR "${REQUIRED} is required")
  endif()
endforeach()

if(NOT EXISTS "${SDK}/C_API/pd_api.h")
  message(FATAL_ERROR "Playdate SDK headers not found under SDK=${SDK}")
endif()
if(NOT EXISTS "${VP_GEN_APP}")
  message(FATAL_ERROR "generated application not found: ${VP_GEN_APP}")
endif()

set(CMAKE_CONFIGURATION_TYPES "Debug;Release")
set(PLAYDATE_GAME_NAME pocket_vapor)
set(PLAYDATE_GAME_DEVICE pocket_vapor_device)

project(${PLAYDATE_GAME_NAME} C ASM)

set(VP_SOURCES
  "${VP_RUNTIME_DIR}/vapor_core.c"
  "${VP_RUNTIME_DIR}/playdate/framebuffer.c"
  "${VP_RUNTIME_DIR}/playdate/vapor_playdate.c"
  "${VP_GEN_APP}"
)

if(TOOLCHAIN STREQUAL "armgcc")
  add_executable(${PLAYDATE_GAME_DEVICE} ${VP_SOURCES})
  set(VP_TARGET ${PLAYDATE_GAME_DEVICE})
else()
  add_library(${PLAYDATE_GAME_NAME} SHARED ${VP_SOURCES})
  set(VP_TARGET ${PLAYDATE_GAME_NAME})
endif()

# playdate.cmake owns the SDK compiler/linker flags and device setup.c glue.
# Packaging stays in compiler/playdate.ts so Simulator and device artifacts
# are staged and validated independently.
include("${SDK}/C_API/buildsupport/playdate.cmake")

target_include_directories(${VP_TARGET} PRIVATE
  "${VP_RUNTIME_DIR}"
  "${VP_RUNTIME_DIR}/playdate"
  "${SDK}/C_API"
)
target_compile_definitions(${VP_TARGET} PRIVATE
  VP_GRID_W=50
  VP_GRID_H=30
  VP_STR_CAP=24
  VP_VIEW_CAP=32
  VP_DEBUG_STATE_BYTES=${VP_DEBUG_STATE_BYTES}
  VP_BUILD_ID=\"${VP_BUILD_ID}\"
)

if(NOT MSVC)
  target_compile_options(${VP_TARGET} PRIVATE
    -Werror=implicit-function-declaration
    -Werror=return-type
  )
endif()

if(TOOLCHAIN STREQUAL "armgcc")
  set_property(TARGET ${VP_TARGET} PROPERTY OUTPUT_NAME "pocket_vapor_device.elf")
  add_custom_command(
    TARGET ${VP_TARGET}
    POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${VP_STAGE_DIR}"
    COMMAND ${CMAKE_STRIP} --strip-unneeded -R .comment -g
      "$<TARGET_FILE:${VP_TARGET}>"
      -o "${VP_STAGE_DIR}/pdex.elf"
    VERBATIM
  )
else()
  if(MSVC OR MINGW)
    set(VP_PDEX_EXT dll)
  elseif(APPLE)
    set(VP_PDEX_EXT dylib)
  elseif(UNIX)
    set(VP_PDEX_EXT so)
  else()
    message(FATAL_ERROR "Unsupported Playdate Simulator build platform")
  endif()
  add_custom_command(
    TARGET ${VP_TARGET}
    POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${VP_STAGE_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy
      "$<TARGET_FILE:${VP_TARGET}>"
      "${VP_STAGE_DIR}/pdex.${VP_PDEX_EXT}"
    VERBATIM
  )
endif()
