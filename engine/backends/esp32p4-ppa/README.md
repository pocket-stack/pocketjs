# PocketJS ESP32-P4 PPA backend

This `no_std` crate interprets PocketJS DrawLists directly into an RGB565
surface. It accelerates operations that map exactly to the ESP32-P4 Pixel
Processing Accelerator and preserves DrawList order with an RGB565 software
fallback for everything else.

The crate deliberately does not depend on ESP-IDF or a board support package.
An ESP-IDF host implements `PpaOps` with `ppa_do_fill`, `ppa_do_blend`, and
`ppa_do_scale_rotate_mirror`. Board-specific display presentation remains in
the BSP.

Accelerated paths:

- opaque and translucent flat rectangles (`FILL` or A8 `BLEND`);
- antialiased font runs (`A8` coverage composed once, then `BLEND`);
- single-color alpha textures such as PocketJS rounded-corner masks (`A8`
  `BLEND`);
- opaque PSM 5650 texture quads (`SRM`) when scaling semantics are compatible.

Gradients, arbitrary triangles, textured triangles, and unsupported texture
formats fall back to `pocketjs_core::raster::render_scaled_rgb565_over`.
No full-frame RGB888 or ARGB8888 surface is allocated.
