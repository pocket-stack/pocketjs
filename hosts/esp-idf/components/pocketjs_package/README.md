# pocketjs_package

Zero-copy `.pocket` reader and ESP-IDF host admission.

- Public header: `pocketjs/package.h`
- Targets: ESP32-P4 and ESP32-S3
- Runtime dependencies: none beyond ESP-IDF common components
- Ownership: package bytes remain caller-owned until `pocketjs_package_close`

`pocketjs_package_select` checks the target, HostOps ABI, viewport contract,
tick rate, and host-profile hash before returning borrowed JS and PAK spans.
`pocketjs_embed_package` requires the product's independent `HOST_PROFILE`
before embedding an existing file; `pocketjs_compile_app` invokes an
already-installed PocketJS CLI with that same profile.

Existing project sources are build dependencies. Run `idf.py reconfigure`
after adding a TypeScript, Vue, or JSON source so CMake can add the new file.
