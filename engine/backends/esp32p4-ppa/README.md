# PocketJS ESP32-P4 PPA backend

This `no_std` crate interprets PocketJS DrawLists directly into an RGB565
surface. It accelerates operations that map exactly to the ESP32-P4 Pixel
Processing Accelerator and preserves DrawList order with an RGB565 software
fallback for everything else.

The default crate deliberately does not depend on ESP-IDF or a board support
package. Hosts can implement `PpaOps` for another driver or test double.
Enabling the `esp-idf` feature exposes the concrete `EspIdfPpaOps`
implementation, backed by the reusable ESP-IDF component under
[`hosts/esp32p4`](../../../hosts/esp32p4/README.md). Board-specific display
presentation remains in the BSP.

Accelerated paths:

- opaque and translucent flat rectangles (`FILL` or A8 `BLEND`);
- antialiased font runs (`A8` coverage composed once, then `BLEND`);
- single-color alpha textures such as PocketJS rounded-corner masks (`A8`
  `BLEND`);
- opaque PSM 5650 texture quads (`SRM`) when scaling semantics are compatible.

Gradients, arbitrary triangles, textured triangles, and unsupported texture
formats fall back to `pocketjs_core::raster::render_scaled_rgb565_over`.
No full-frame RGB888 or ARGB8888 surface is allocated.

## Test

Run the portable renderer and pixel-parity tests on the host:

```sh
cargo test --locked --manifest-path engine/backends/esp32p4-ppa/Cargo.toml \
  --features std
```

Compile-check the Rust side of the ESP-IDF adapter without linking an IDF
application:

```sh
cargo check --locked --manifest-path engine/backends/esp32p4-ppa/Cargo.toml \
  --features esp-idf
```
