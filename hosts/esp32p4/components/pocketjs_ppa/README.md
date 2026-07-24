# pocketjs_ppa

ESP-IDF component implementing blocking RGB565 FILL, A8-over-RGB565 BLEND, and
PSP PSM5650-to-RGB565 SRM operations for PocketJS on ESP32-P4.

The public C ABI is normally consumed by the `EspIdfPpaOps` Rust type. See the
[ESP32-P4 host documentation](../../README.md) for integration, compatibility,
buffer ownership, and build instructions.
