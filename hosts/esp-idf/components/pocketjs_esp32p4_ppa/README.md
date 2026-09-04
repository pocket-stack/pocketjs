# pocketjs_esp32p4_ppa

ESP32-P4 PPA accelerator for `pocketjs_render_rgb565`.

- Public header: `pocketjs/esp32p4_ppa.h`
- Target: ESP32-P4 only
- Dependencies: `pocketjs_render_rgb565`, `esp_driver_ppa`

One handle registers blocking FILL, A8 BLEND, and SRM clients. The returned
accelerator vtable is borrowed until `pocketjs_esp32p4_ppa_destroy`. Rejected or
failed operations return `false`, so the renderer preserves painter order with
its software implementation.
