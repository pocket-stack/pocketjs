# PocketJS on SiFli SF32LB5x

This directory is the reusable SiFli half of the PocketJS EPIC renderer.
Together with
[`engine/backends/sifli-epic`](../../engine/backends/sifli-epic/README.md)
it runs PocketJS guests on SF32LB5x boards through the SDK's EPIC 2.5D engine:

- the `no_std` Rust crate decodes DrawLists once per frame, plans per-region
  command sequences against the chip's capabilities, and keeps painter order
  between hardware commands and its RGB565 software fallback;
- `components/pocketjs_gpu` executes those commands on EPIC through public
  HAL entry points, on VG Lite (SF32LB58) for the projective quads, tinted
  blits, and portable-format textures EPIC cannot read, and owns the A8
  planes and RGB565 tiles in SRAM;
- `components/pocketjs_host` owns the shared PSRAM heap, the framebuffer
  ring, the LCD device, keys and touch, the QuickJS realm, and the guest
  catalog;
- `rust/` is the `pocketjs-sifli` staticlib exporting the `pocket_core_*` C
  ABI, built by cargo from the firmware's SCons build.

A firmware project keeps its app, board files, and assets; it references
this directory through `POCKETJS_ROOT`. No project code programs hardware.

## Compatibility

Built and link-tested against the SiFli-SDK checkout recorded in
[`docs/PORTING.md`](docs/PORTING.md) with the `sf32lb58-lcd_n16r32n1_a1_dpi`
board (SF32LB58, 1024×600 HTM H070A20 DPI panel). The GPU component compiles
for every chip the SDK's `bf0_hal_epic.h` describes (52x, 55x, 56x, 57x,
58x); its capability report follows the SDK feature gates, so a chip without
A8 layers or L8 lookup simply reports fewer capabilities. The MPU override
and the memory layout below are SF32LB58-specific.

The host requires the SDK's QuickJS package (`PKG_USING_QUICKJS`), the LCD
device (`BSP_USING_LCD`), and `RT_USING_MEMHEAP`. `BSP_USING_EPIC` stays
unset: the component owns `EPIC_IRQHandler` and never links RT-Thread's
`drv_epic` or LVGL.

## Add the components

`project/SConstruct` resolves `POCKETJS_ROOT`, exports it, and depends the
firmware on the Rust archive:

```python
POCKETJS_ROOT = os.getenv('POCKETJS_ROOT')
os.environ['POCKETJS_ROOT'] = POCKETJS_ROOT   # Kconfig.proj sources through it
Export('POCKETJS_ROOT')
...
objs = PrepareBuilding(None)
Import('pocketjs_rust_lib')
env.Depends(TARGET, File(pocketjs_rust_lib))
```

`project/SConscript` includes the SDK, then this directory, then the
project's sources:

```python
objs.extend(SConscript(os.path.join(POCKETJS_ROOT, 'hosts', 'sifli', 'SConscript'),
                       variant_dir='pocketjs', duplicate=0))
```

`project/Kconfig.proj` sources the host menu (the SDK generates the build's
Kconfig root from `Kconfig.proj`, not from the project's `Kconfig`):

```
source "$POCKETJS_ROOT/hosts/sifli/Kconfig"
```

`project/proj.conf` enables both components; the viewport, scale, density,
frame rate, heap, framebuffer count, and input semantics are Kconfig
options with the defaults listed at the end of this page:

```
CONFIG_PKG_USING_QUICKJS=y
CONFIG_BSP_USING_LCD=y
CONFIG_POCKETJS_GPU=y
CONFIG_POCKETJS_HOST=y
# CONFIG_BSP_USING_EPIC is not set
```

`src/main.c` hands the generated catalog to the host:

```c
#include "pocketjs_host.h"
extern const PocketjsCatalog pocketjs_catalog;
int main(void) { return pocketjs_host_run(&pocketjs_catalog); }
```

[`examples/hero-smoke`](examples/hero-smoke) is the complete minimal
project.

## The Rust staticlib

`hosts/sifli/SConscript` runs
`cargo build --release --locked --target thumbv8m.main-none-eabihf` on
`rust/Cargo.toml` with the project directory as the working directory, so a
project's `.cargo/config.toml` (offline vendoring) applies, and appends
`libpocketjs_sifli.a` to `LINKFLAGS_POST`. The toolchain is pinned by
`rust/rust-toolchain.toml` (**Rust 1.93.0 with the `thumbv8m.main-none-eabihf`
target**) and exported through `RUSTUP_TOOLCHAIN`.

`bun tools/sifli.ts vendor <project>` copies the staticlib's third-party
crates (taffy, slotmap, arrayvec, serde, syn, …) into
`<project>/rust/vendor/crates` and writes the `.cargo/config.toml` that
makes the build offline. The PocketJS crates stay path dependencies inside
`POCKETJS_ROOT`.

The archive expects four symbols from the host: `pocket_heap_alloc`,
`pocket_heap_free`, `pocket_rust_panic` (provided by
`components/pocketjs_host`), and the `pocketjs_gpu_*` queue (provided by
`components/pocketjs_gpu`). Its exports are declared in
[`include/pocket_core.h`](include/pocket_core.h); the queue ABI is
[`include/pocketjs_gpu.h`](include/pocketjs_gpu.h); button and analog
constants come from the generated
[`include/pocket_spec.h`](include/pocket_spec.h).

## Assets and the catalog

`pocket-sifli.json` lists the guests a firmware embeds:

```json
{
  "density": 2, "hz": 60, "framework": "solid",
  "launcher": "launcher-main",
  "guests": [
    { "output": "launcher-main", "title": "Cover Flow",
      "entry": "app/launcher/launcher-main.tsx", "native": { "opaque": "d9e7ef" } },
    { "output": "hero-main", "title": "Hero" }
  ]
}
```

`bun tools/sifli.ts assets <project>` compiles each guest with
`tools/build.ts` (a project entry with the project as its root and the
`pocket.config.ts` next to the entry when one exists, or one of this
repository's demo outputs), writes `<project>/assets/<output>.js|.pak`,
bakes an optional `.epic` native texture pak, and generates
`src/pocket_assets.S` (`.incbin` of every file, `../assets/` relative to
`project/`) and `src/pocket_catalog.generated.c` (the `PocketjsCatalog`
table). `assets/MANIFEST.txt` records sizes and SHA-256 digests; the build
is deterministic, so regenerating from the same checkout reproduces them.

A `.epic` pak holds every `ui:img.*` entry as an 8-byte header plus
EPIC-order pixels: **RGB565 with red in the high bits, BGRA8888, or L8 with a
1024-byte BGRA palette**. The core keeps the portable PSM bytes, so software
fallback stays exact; the native copy only feeds hardware blits.
`native: { "opaque": "RRGGBB" }` precomposites PSM_8888 alpha over that color
at bake time and stores opaque RGB565.

Images without a native copy are registered in their portable format when
`POCKETJS_GPU_VGLITE` is on: VG Lite reads PSM_5650, PSM_4444, PSM_8888,
and PSM_T8 directly, so a guest needs no `.epic` pak to blit through
hardware. Without VG Lite those textures render through the CPU tile path.

## Buffer contract

- The framebuffer ring (`POCKETJS_FRAMEBUFFER_COUNT`, default **3**) is one
  static array in the `L2_NON_RET_BSS` section, **64-byte aligned, in
  PSRAM2 (`0x62000000`)**. With `POCKETJS_MPU_OVERRIDE` the host's
  `mpu_config` marks `0x62000000..0x62FFFFFF` normal non-cacheable, so EPIC
  writes and LCD scan-out see the same bytes without cache maintenance.
- The renderer never writes the framebuffer from the CPU
  (`POCKETJS_GPU_DIRECT_CPU_WRITES` is off): CPU fallback renders into
  SRAM tiles that EPIC copies in and out, and A8 coverage is built in SRAM
  planes. Both live in `L1_NON_RET_BSS`, two slots each,
  `POCKETJS_GPU_MASK_TILE_KB` and `POCKETJS_GPU_CPU_TILE_KB` (default **64 KB
  each, 256 KB total**).
- The shared heap (`POCKETJS_HEAP_KB`, default **7 MiB**) is one
  `rt_memheap` in cached PSRAM1; QuickJS is limited to
  `POCKETJS_QJS_MEMORY_LIMIT_KB` (default **4 MiB**) of it. Native texture
  blobs are copied into it at mount (`POCKETJS_NATIVE_TEXTURE_STAGING`) and
  cleaned once for EPIC.
- Presentation is `draw_rect_async`; the next present waits for the previous
  `tx_complete` first, so scanned, pending, and rendering buffers stay
  distinct on RAM-less DPI panels.

## Input

Keys map to PocketJS buttons; the guest never sees board pins.

| `POCKETJS_KEY_LONG_PRESS_MS` | KEY1 | KEY2 |
| --- | --- | --- |
| 0 (default) | `LEFT` while held | `RIGHT` while held |
| >0, tap | one `LEFT` pulse on release | one `RIGHT` pulse on release |
| >0, hold, launcher active | consumed | one latched `CIRCLE` pulse |
| >0, hold, guest active | return to the launcher | release still emits `RIGHT` |

With `POCKETJS_INPUT_TOUCH` (needs `BSP_USING_TOUCHD`) the `touch` device's
contact is divided by the render scale and packed into the wide-coordinate
wire form; the host resolves bounds hits before the frame call, as every
device host does.

## Directory

```
hosts/sifli/
├─ SConscript, Kconfig            project entry points
├─ include/                       pocket_core.h, pocketjs_gpu.h, pocket_spec.h
├─ components/pocketjs_gpu/       EPIC executor, SRAM planes, texture registry
├─ components/pocketjs_host/      heap, MPU, LCD ring, input, QuickJS guest, frame loop
├─ rust/                          pocketjs-sifli staticlib (standalone crate)
├─ examples/hero-smoke/           minimal project: the hero demo on sf32lb58-lcd_n16r32n1_a1_dpi
└─ docs/PORTING.md                memory map, executor recipes, profiler, verification
```

## Build smoke test

```sh
bun tools/sifli.ts assets hosts/sifli/examples/hero-smoke
cd hosts/sifli/examples/hero-smoke/project
source $SIFLI_SDK/export.sh
scons --board=sf32lb58-lcd_n16r32n1_a1_dpi -j8
```

`bun tools/sifli.ts build hosts/sifli/examples/hero-smoke` runs the same
scons command with `POCKETJS_ROOT` set. The example ships the **9 MiB
`hcpu_flash_code` partition table** the 3.8 MB hero pak needs; the stock
board layout reserves 4 MiB.

## Verification

- `cargo test --locked --manifest-path engine/backends/sifli-epic/Cargo.toml --features std`
  — the renderer against the core software rasterizer.
- `bun tools/sifli.ts verify` — `tests/sifli-sim.test.ts`: the hero demo at
  512×300, density 2, scale 2 renders a non-flat, deterministic 1024×600
  frame. `POCKETJS_SIFLI_PROJECT=<project>` adds every guest of that
  project and its launcher selection flow.
- `bun tools/sifli.ts audit <build>/main.elf` — no undefined symbols, the
  queue and HAL EPIC entry points linked, `EPIC_IRQHandler` owned by the
  component, no `drv_epic` symbols.
- `bun tests/contract.ts` — `pocket_spec.h` matches `contracts/spec/spec.ts`.
- `bun tools/sifli.ts selfcheck <serial log>` — a board built with
  `POCKETJS_SELF_CHECK` renders every 60th frame twice, on the hardware
  and with the core software rasterizer, and prints the mismatch ratio,
  PSNR, largest channel delta, and both CRC32s; the tool applies the
  acceptance thresholds (exact for fills, A8 blends, and 1:1 copies;
  ≥ 45 dB for EPIC gradients and scaled blits; ≥ 38 dB for VG Lite).
- `bun tools/sifli.ts crc <output> --frames N --assert <serial log>` — a
  board built with `POCKETJS_FRAME_CRC` prints a CRC32 per presented
  frame; the tool renders the same guest through the simulator's RGB565
  path (`ui_render_rgb565_scaled`) and compares the sequence. Run it with
  `POCKETJS_FORCE_SOFTWARE` first to validate the host, heap, MPU, LCD,
  and input chain, then with the hardware path.

On the board the serial profiler prints three lines per second; the fields
are documented in [`docs/PORTING.md`](docs/PORTING.md).

## Kconfig reference

| Option | Default | Meaning |
| --- | --- | --- |
| `POCKETJS_GPU` | y | The command queue and EPIC executor |
| `POCKETJS_GPU_MASK_TILE_KB` | 64 | A8 plane per slot (two slots, SRAM) |
| `POCKETJS_GPU_CPU_TILE_KB` | 64 | RGB565 fallback tile per slot (two slots, SRAM) |
| `POCKETJS_GPU_MAX_TEXTURES` | 32 | Native texture registry capacity |
| `POCKETJS_GPU_MIN_PIXELS` | 64 | Smallest rectangle worth a hardware transaction |
| `POCKETJS_GPU_DIRECT_CPU_WRITES` | n | Let the renderer write the framebuffer from the CPU |
| `POCKETJS_GPU_VGLITE` | y | VG Lite executor for quads, tinted and portable-format blits (needs `USING_VGLITE`, SF32LB58) |
| `POCKETJS_GPU_VGLITE_POOL_KB` | 320 | VG Lite contiguous pool in SRAM |
| `POCKETJS_GPU_VGLITE_CMD_KB` | 64 | VG Lite command buffer size |
| `POCKETJS_HOST` | y | Heap, LCD ring, input, QuickJS guest, frame loop |
| `POCKETJS_LOGICAL_WIDTH` / `_HEIGHT` | 512 / 300 | Guest viewport |
| `POCKETJS_RENDER_SCALE` | 2 | Physical pixels per logical pixel |
| `POCKETJS_RASTER_DENSITY` | 2 | Density the assets were baked at |
| `POCKETJS_TICK_HZ` | 60 | Guest frame rate |
| `POCKETJS_FRAMEBUFFER_COUNT` | 3 | Framebuffers in PSRAM2 |
| `POCKETJS_HEAP_KB` | 7168 | Shared QuickJS + Rust heap |
| `POCKETJS_QJS_MEMORY_LIMIT_KB` | 4096 | QuickJS limit inside the heap |
| `POCKETJS_MPU_OVERRIDE` | y | PSRAM1 cached, PSRAM2 non-cacheable (SF32LB58) |
| `POCKETJS_KEY_LONG_PRESS_MS` | 0 | Level keys, or pulse + long-press semantics |
| `POCKETJS_INPUT_TOUCH` | y | Forward touch contacts (needs `BSP_USING_TOUCHD`) |
| `POCKETJS_NATIVE_TEXTURE_STAGING` | y | Copy `.epic` blobs into the heap at mount |
| `POCKETJS_PROFILE` | y | Serial statistics once per second |
| `POCKETJS_FORCE_SOFTWARE` | n | Full software render every frame (bring-up) |
| `POCKETJS_SELF_CHECK` / `_INTERVAL` | n / 60 | Compare hardware frames against the software rasterizer |
| `POCKETJS_FRAME_CRC` | n | Print a CRC32 of every presented frame |
