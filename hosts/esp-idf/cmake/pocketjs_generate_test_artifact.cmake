function(pocketjs_generate_test_artifact output_variable generator)
  set(_pocketjs_output_dir "${CMAKE_CURRENT_BINARY_DIR}/generated")
  if(CMAKE_BUILD_EARLY_EXPANSION)
    set(${output_variable} "${_pocketjs_output_dir}" PARENT_SCOPE)
    return()
  endif()

  get_filename_component(_pocketjs_component_dir "${generator}" DIRECTORY)
  get_filename_component(
    _pocketjs_root
    "${_pocketjs_component_dir}/../../../.."
    ABSOLUTE
  )

  find_program(_pocketjs_bun NAMES bun)
  if(NOT _pocketjs_bun)
    message(FATAL_ERROR
      "PocketJS test artifact generation requires Bun in PATH")
  endif()

  file(MAKE_DIRECTORY "${_pocketjs_output_dir}")

  file(GLOB_RECURSE _pocketjs_artifact_inputs
    CONFIGURE_DEPENDS
    LIST_DIRECTORIES false
    "${_pocketjs_component_dir}/*.json"
    "${_pocketjs_component_dir}/*.pem"
    "${_pocketjs_component_dir}/*.ts"
    "${_pocketjs_root}/contracts/spec/*.ts"
    "${_pocketjs_root}/framework/compiler/*.ts"
    "${_pocketjs_root}/framework/src/manifest/*.ts"
    "${_pocketjs_root}/framework/src/net/*.ts"
    "${_pocketjs_root}/hosts/esp-idf/components/pocketjs_net_formal_*_artifact/*.pem"
    "${_pocketjs_root}/hosts/esp-idf/components/pocketjs_net_formal_*_artifact/*.ts"
  )
  list(APPEND _pocketjs_artifact_inputs
    "${_pocketjs_root}/bun.lock"
    "${_pocketjs_root}/package.json"
    "${_pocketjs_root}/tools/build.ts"
    "${_pocketjs_root}/tools/network-bundle-factory.ts"
    "${_pocketjs_root}/tools/test-artifact-output.ts"
  )
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    ${_pocketjs_artifact_inputs})

  execute_process(
    COMMAND
      "${_pocketjs_bun}"
      "${generator}"
      "--output-dir=${_pocketjs_output_dir}"
    WORKING_DIRECTORY "${_pocketjs_root}"
    RESULT_VARIABLE _pocketjs_generate_result
    OUTPUT_VARIABLE _pocketjs_generate_stdout
    ERROR_VARIABLE _pocketjs_generate_stderr
  )
  if(NOT _pocketjs_generate_result EQUAL 0)
    message(FATAL_ERROR
      "PocketJS test artifact generation failed (${_pocketjs_generate_result})\n"
      "${_pocketjs_generate_stdout}${_pocketjs_generate_stderr}")
  endif()

  set(${output_variable} "${_pocketjs_output_dir}" PARENT_SCOPE)
endfunction()
