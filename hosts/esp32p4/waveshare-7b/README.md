# Full PocketJS on Waveshare ESP32-P4 7B

This is the board-side ESP-IDF template for the complete PocketJS runtime,
not Pocket Vapor. It hosts a target-bound JavaScript bundle in QuickJS, mounts
the full UI HostOps surface, renders its 480x272 logical viewport at density 2
into a persistent 960x544 RGB565 PSRAM buffer, and centers that buffer at
`32,28` on the board's 1024x600 EK79007 panel. GT911 positions in that rectangle
are delivered to apps as logical PocketJS touch contacts. Guest turns, retained
core ticks, and board presentation all share the normal PocketJS 60 Hz cadence.

Generated firmware projects copy the four root files and the source files in
`main/`, then place their compiled `app.js` and `app.pak` in `main/`. Configure
the project with two checkout-bound absolute paths:

```sh
bun run esp32p4:device build chrome
bun run esp32p4:device flash cards --port /dev/cu.usbmodem101
```

Those commands compile the target-bound bundle, cross-build the complete
QuickJS runtime, stage a clean project, and use ESP-IDF's generated segmented
flash plan. For direct template development, configure the same paths
manually:

```sh
export POCKETJS_REPO_ROOT=/absolute/path/to/pocketjs
export POCKETJS_RUST_LIB=/absolute/path/to/libpocketjs_esp32p4_runtime.a
idf.py build
```

The reproducible board dependency graph is ESP-IDF v5.5.4, Waveshare BSP
v1.0.4, `esp_lvgl_port` v2.7.2, and LVGL v9.2.2. `dependencies.lock` is copied
from the already verified Pocket Vapor bring-up for this exact hardware.

At 115200 baud the runtime emits `PJREADY`, periodic `PJFRAME`, and physical
`PJTOUCH source=gt911` receipts. UART line commands are:

- `H` — repeat the ready/identity receipt;
- `D` — hash and print current render statistics;
- `P <mask>` — inject that PocketJS button bitmask for one frame, then release.

The firmware image uses a 15 MiB factory-app partition starting at `0x10000`.
Flash it with the generated project's `idf.py flash`; the ESP32-P4 bootloader
offset and the other segmented images come from its `flasher_args.json`.
