# pocketjs_guest

Caller-driven QuickJS guest for ESP-IDF.

- Public headers: `pocketjs/guest.h`, `pocketjs/guest_quickjs.h`
- Targets: ESP32-P4 and ESP32-S3
- Dependency: `espressif/quickjs-ng` 0.14.0
- Ownership: one caller-selected owner task invokes every API except
  `pocketjs_guest_interrupt`, which is safe to call from a stopping task

The component creates no FreeRTOS task and mounts no PocketJS capability by
itself. `pocketjs_guest_frame` calls `globalThis.frame` once and drains the
pending job queue. The QuickJS header is a version-pinned extension surface;
ordinary firmware includes only `guest.h`.
