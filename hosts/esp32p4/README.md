# PocketJS on ESP32-P4

This directory contains the reusable ESP-IDF half of the PocketJS ESP32-P4
RGB565 renderer. Together with
[`engine/backends/esp32p4-ppa`](../../engine/backends/esp32p4-ppa/README.md),
it is a concrete PPA backend:

- the `no_std` Rust crate interprets DrawLists, batches A8 coverage, selects
  hardware-compatible operations, and preserves order with its RGB565
  software fallback;
- `components/pocketjs_ppa` registers one ESP-IDF client each for FILL, BLEND,
  and SRM and executes blocking transactions;
- the product BSP owns display initialization, native presentation buffers,
  rotation into panel scan order, and vblank/present scheduling.

No full-frame RGB888 or ARGB8888 intermediate is required.

## Compatibility

The adapter is supported and build-tested with the ESP-IDF `release/v6.0` and
`release/v6.1` branches. Versions older than v6.0 have not been tested. CI
builds `release/v6.0` as the minimum supported baseline.

Only the `esp32p4` target is supported. The adapter does not select a silicon
revision, CPU frequency, PSRAM mode, display controller, or panel timing;
those remain product/BSP configuration.

## Add the ESP-IDF component

Add this repository's component directory to the host project before loading
ESP-IDF's project support:

```cmake
list(APPEND EXTRA_COMPONENT_DIRS
    "/path/to/pocketjs/hosts/esp32p4/components"
)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(my_pocketjs_host)
```

The host component that links the Rust archive should declare
`REQUIRES pocketjs_ppa`. The component roots its C ABI symbols for the final
link, so archive ordering does not require additional linker flags.

## Enable the Rust adapter

Depend on the renderer with its `esp-idf` feature:

```toml
[dependencies]
pocketjs-core = { path = "/path/to/pocketjs/engine/core" }
pocketjs-esp32p4-ppa = { path = "/path/to/pocketjs/engine/backends/esp32p4-ppa", features = ["esp-idf"] }
```

Create one `EspIdfPpaOps` on the rendering task and pass it to the persistent
renderer:

```rust
use pocketjs_esp32p4_ppa::{
    EspIdfPpaOps, Renderer, RendererConfig,
};

let mut ppa = EspIdfPpaOps::new().expect("PPA clients");
let mut renderer = Renderer::new(RendererConfig::default())
    .expect("valid renderer configuration");

let stats = renderer.render(
    &ui,
    draw_list_words,
    rgb565_framebuffer,
    framebuffer_width,
    framebuffer_height,
    &mut ppa,
);
```

Dropping `EspIdfPpaOps` unregisters its clients. Drop it before shutting down
the platform PPA/display resources.

## Buffer contract

The caller owns all image memory and must obey the ESP-IDF PPA DMA/cache
contract:

- allocate RGB565 output buffers with DMA-capable memory;
- align every output address and byte size to the platform cache-line size;
  128-byte alignment is a safe ESP32-P4 host policy;
- keep SRM input and output ranges distinct;
- do not modify or reuse a buffer while any nonblocking presentation
  transaction is reading or writing it.

The DrawList transactions in this adapter are blocking. This is intentional:
when an operation returns, subsequent PPA operations and ordered CPU fallback
segments must see its completed pixels. Display presentation can use a
separate nonblocking PPA client in the board BSP.

FILL colors are passed through `fill_argb_color` after expanding RGB565 to
8-bit channels. Passing a packed RGB565 word through `fill_color_val` produces
incorrect colors. SRM is accepted only when both scale factors are represented
exactly in the PPA's 1/16 increments; otherwise the Rust renderer uses the
software fallback.

## Build smoke test

With an activated ESP-IDF environment:

```sh
cd hosts/esp32p4/examples/ppa-smoke
idf.py set-target esp32p4
idf.py build
```

This verifies the component API and final link. It does not exercise pixels
on hardware; visual and performance verification still belongs to a product
host with a display BSP.
