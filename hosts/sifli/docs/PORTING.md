# SiFli SF32LB5x port notes

Reference for the mechanisms behind `hosts/sifli`: the runtime path, the
memory map, the GPU queue and its EPIC executor, guest lifecycle, input,
the LCD pipeline, the profiler, and the verification boundary. The
integration steps are in [`../README.md`](../README.md).

SDK baseline: SiFli-SDK commit `bec8849d9` (`version.txt` v2.5.0), GCC
14.2.1 from the SDK toolchain, RT-Thread with `PKG_USING_QUICKJS`.

## Runtime path

```text
app + pocket-sifli.json
        │ tools/sifli.ts assets: tools/build.ts per guest (density 2, 60 Hz), optional .epic bake
        ▼
assets/<output>.js + .pak (+ .epic)  ── pocket_assets.S / pocket_catalog.generated.c ── firmware rodata
        │
        ▼
components/pocketjs_host      QuickJS realm ── `ui` C ABI ── pocketjs-core (no_std Rust)
        │                                                        │
        │                                     DrawList ── pocketjs-sifli-epic planner
        │                                                        │ Cmd sequence per damage region
        │                                     pocketjs_gpu.h ── components/pocketjs_gpu (C)
        │                                                        │ HAL_EPIC_* transactions
        ▼                                                        ▼
framebuffer ring (PSRAM2, non-cacheable) ◄────────────── EPIC ── SRAM planes/tiles ◄── CPU fallback
        │
        ▼
rt_device "lcd" draw_rect_async → DPI LCDC
```

One guest exists at a time. Mounting creates a `PocketCore` (one damage
tracker per framebuffer), loads the pak, registers native textures, and
evaluates the bundle in a fresh QuickJS runtime. Unmounting waits for the
hardware, frees the realm, resets the texture registry, and destroys the
core. There is no suspended guest state.

## Memory placement (SF32LB58, N16R32N1 board)

| Allocation | Section | Address | Size | Cache |
| --- | --- | ---: | ---: | --- |
| HCPU image (code, rodata, embedded assets) | `hcpu_flash_code` executed from the PSRAM1 alias | `0x10000000` | 9 MiB partition | I/D cached |
| Shared QuickJS + Rust heap (`POCKETJS_HEAP_KB`) | `L2_CACHE_NON_RET_BSS` | PSRAM1 `psram_data` | 7 MiB | write-back |
| Framebuffer ring (3 × 1024×600 RGB565) | `L2_NON_RET_BSS` | `0x62000000` | 3,686,400 bytes | non-cacheable (MPU override) |
| A8 planes (2 × `POCKETJS_GPU_MASK_TILE_KB`) | `L1_NON_RET_BSS` | SRAM | 128 KB | MPU non-cacheable |
| RGB565 fallback tiles (2 × `POCKETJS_GPU_CPU_TILE_KB`) | `L1_NON_RET_BSS` | SRAM | 128 KB | MPU non-cacheable |
| Native texture copies | shared heap | PSRAM1 | per guest | cleaned once at registration |

The partition table `project/<board>_hcpu/ptab.yaml` (copied into
`examples/hero-smoke`) sets the **9 MiB `hcpu_flash_code`** partition, the
**7 MiB `psram_data`** heap window at PSRAM1 offset `0x00900000`, and leaves
PSRAM2 to the ring. The stock board layout reserves 4 MiB of code, too small
for a density-2 guest pak (hero: 3,865,200 bytes).

`host_mpu.c` overrides the SDK's weak `mpu_config` only when
`POCKETJS_MPU_OVERRIDE` is set: the SDK's single cached PSRAM region becomes
cached PSRAM1 (`0x60000000..0x61FFFFFF`) plus non-cacheable PSRAM2
(`0x62000000..0x62FFFFFF`). The split must be in the startup table; adding
the PSRAM2 region after the SDK table is live raises **DACCVIOL** on the
first framebuffer write.

## The GPU queue

`include/pocketjs_gpu.h` is the ABI between the Rust renderer and the C
executor: `pocketjs_gpu_caps` (a `PocketjsGpuCaps` read once at
`pocket_core_create`), `begin`/`submit`/`fence`/`end` per frame, `mask` and
`tile` for the SRAM planes, and `native_texture` to resolve a core handle
plus revision to a registered blob. Every `PocketjsGpuCmd` carries
target-local physical rectangles; the executor validates each command
before it touches hardware and answers `-(index + 1)` for a refused
command, which the renderer treats as `SubmitError::Unsupported` and
abandons the frame's damage.

The planner never issues a command the capability report forbids.
`pocketjs_gpu_chip.h` derives the report from the SDK feature gates:

| Capability | Source | 58x value |
| --- | --- | --- |
| `coordinate_limit` | `EPIC_COORDINATES_MAX` | 1010 (505 on 52x/57x) |
| `A8_BLEND` | `EPIC_SUPPORT_A8` | yes |
| L8 native textures | `EPIC_SUPPORT_L8` | yes |
| vertical mirror | 52x/57x only | no (`MIRROR_Y` blits are refused) |
| portable blit formats | none (needs the color matrix 57x alone has) | 0 |
| `BLIT_NATIVE` | always | yes |
| `DIRECT_CPU_WRITES` | `POCKETJS_GPU_DIRECT_CPU_WRITES` | off |

### EPIC executor recipes

One interrupt-driven HAL transaction is in flight at a time; the next
submission, a fence, `end`, texture reset, and close all wait for it. The
component provides `EPIC_IRQHandler` and calls `HAL_EPIC_IRQHandler`; the
NVIC priority is 3. The HAL's clock gating and `op_hist` debug ring are used
as the SDK ships them.

| Command | HAL call | Notes |
| --- | --- | --- |
| `FILL`, `FILL_ALPHA` | `HAL_EPIC_FillStart_IT` | `fill.alpha` carries translucency; alpha 0 is a no-op |
| `GRADIENT` | `HAL_EPIC_FillGrad_IT` | corners `color[0][0]` TL, `[0][1]` TR, `[1][0]` BL, `[1][1]` BR |
| `BLEND_A8` | `HAL_EPIC_BlendStartEx_IT`, 2 layers | layer 0 = destination window, layer 1 = A8 plane window (`data = plane + offset`, `total_width = stride`, `color_en`, `ALPHA_BLEND_RGBCOLOR`, global alpha) |
| `BLIT` (native) | `HAL_EPIC_BlendStartEx_IT`, 2 layers | layer 0 = clip window as background and output; layer 1 = texture sub-rectangle at the unclipped destination with `scale_x/y = src × 1024 / dst` (rounded), `h_mirror`, global alpha; L8 sets `lookup_table` |
| `TILE_OUT` / `TILE_IN` | `HAL_EPIC_BlendStartEx_IT`, 1 layer | RGB565 copy between the target and a packed tile (`total_width = tile width`) |
| `FENCE` | wait | — |
| `BLIT_QUAD`, portable `BLIT` | refused | reserved for the VG Lite executor |

Every rectangle is checked against the bound target and
`EPIC_COORDINATES_MAX`; the renderer splits fills and A8 bands below the
limit and routes oversized blits to the CPU, so refusals only happen for
malformed input.

### VG Lite executor recipes (SF32LB58, `POCKETJS_GPU_VGLITE`)

`vg_lite_init_mem` receives a **contiguous pool in SRAM**
(`POCKETJS_GPU_VGLITE_POOL_KB`, 64-byte aligned, `L1_NON_RET_BSS`); the
library carves its two command buffers (`POCKETJS_GPU_VGLITE_CMD_KB` each)
and a 64×64 tessellation buffer from it. The component enables
`V2D_GPU_IRQn` at priority 3; the SDK's `vg_lite_hal.c` owns
`V2D_GPU_IRQHandler` and turns on `RCC_MOD_GPU`. The target is the bound
framebuffer described as `VG_LITE_BGR565` (the format names list channels
from the low byte up, so BGR565 is EPIC's RGB565 and `VG_LITE_RGB565` is
PocketJS PSM_5650).

| Command | Path | Notes |
| --- | --- | --- |
| `BLIT` from a native RGB565/BGRA8888/L8 texture, white tint | EPIC | unchanged |
| `BLIT` with an RGB tint, or from a portable-format texture | `vg_lite_blit_rect` | matrix = translate/scale (negative scale for mirrors), `VG_LITE_MULTIPLY_IMAGE_MODE` carries the tint |
| `BLIT_QUAD` | `vg_lite_get_transform_matrix` + `vg_lite_blit_rect` | source TL/BL/BR/TR onto the command's quad; solid quads sample a 4×4 RGBA8888 color texture in SRAM |
| clip | `vg_lite_set_scissor` | per command |
| global alpha | `vg_lite_source_global_alpha(VG_LITE_SCALED)` | per command |
| PSM_T8 / L8 | `vg_lite_set_CLUT(256)` | ARGB words built from the RGBA (portable) or BGRA (native) palette, cached by palette pointer |

Sources must be **64-byte aligned and cache-clean**, which the registry
enforces at registration; the queue therefore advertises no inline portable
formats and the host registers every image without a native copy as a
portable copy staged in the heap (`register_portable_texture`). Code-bus
addresses (`0x10000000..0x1BFFFFFF`) are rewritten with
`HCPU_MPI_SBUS_ADDR`; staged copies in PSRAM1 need no rewrite.

Engine arbitration: the queue tracks the engine in use; a command bound for
the other engine first drains the current one (EPIC wait or
`vg_lite_finish`), and `engine_switches` in the profile counts those
drains. Commands on VG Lite are flushed after each blit; fences, `end`, and
texture resets call `vg_lite_finish`. A `vg_lite_finish` failure disables
VG Lite for the rest of the session and the renderer falls back.

Cache rules: the framebuffer and the SRAM planes are non-cacheable, so no
maintenance is required for them. `mpu_dcache_clean` runs once over a
native texture blob at registration and over a tile before `TILE_IN`; both
are no-ops below `PSRAM_BASE` and cover blobs staged in cached PSRAM1.

### CPU fallback

Operations the plan cannot express (Gouraud triangles, PSM4444, clipped or
translucent gradients, unmatched triangle fans, blits without a native
copy) render through `pocketjs_core::raster` into an SRAM tile:
`TILE_OUT` copies the affected target window into the tile, a fence
completes it, the core rasterizer draws into the tile with the global
sampling phase preserved, and `TILE_IN` copies it back. Consecutive
fallback operations share one round trip; windows larger than a tile are
split into bands. The renderer counts `cpu_tiles`, `cpu_tile_pixels`, and
`fences` in `PocketRenderStats`.

Text and coverage-only textures are composited into an A8 plane by the CPU
and blended in one `BLEND_A8` per run and band (`mask_bands`); a plane is
rewritten only after a fence retired the blend that read it.

## Guest lifecycle and switching

`pocketjs_host_run` mounts `catalog->launcher` at boot. A guest calls
`ui.appLaunch(output)`; the host accepts it only while the launcher is
active and the name is in the catalog, records it, and returns 1. The switch
happens after the current frame finished its guest work, rendering, and
present:

1. `pocketjs_guest_unmount`: free the QuickJS values, context, and runtime;
   `pocketjs_gpu_texture_reset` (waits for the hardware) and free staged
   blobs; `pocket_core_destroy`.
2. `pocketjs_guest_mount`: `pocket_core_create` with
   `POCKETJS_FRAMEBUFFER_COUNT` damage targets, `load_pak`, native texture
   registration under each handle's `pocket_core_texture_revision`, a new
   runtime with the shared-heap allocator (`JS_SetMemoryLimit`,
   `JS_SetGCThreshold` 768 KB, `JS_SetMaxStackSize` 48 KB), `register_ui`,
   `JS_Eval` of the bundle, `globalThis.frame`.
3. The next framebuffer receives a full redraw; the LCD keeps scanning the
   previously presented buffer, so the panel never shows uninitialized
   memory.

Returning from a guest (long KEY1 with `POCKETJS_KEY_LONG_PRESS_MS > 0`)
queues the same sequence with the launcher as the target.

The `ui` object exposes the same operations as the other native hosts
(`createNode` … `debugStep`, `appLaunch`), `__host` (`"sf32lb58"`),
`__hostAbi` 3, `__tickHz`, `__viewport`, `__textures`, `__sprites`;
`console.*` prints to the serial port with a `[PocketJS JS]` prefix.
`JS_RunGC` runs every four seconds of guest frames.

## Input contract

| `POCKETJS_KEY_LONG_PRESS_MS` | State | KEY1 | KEY2 |
| --- | --- | --- | --- |
| 0 | any | `LEFT` level | `RIGHT` level |
| >0 | tap, release | one `LEFT` pulse | one `RIGHT` pulse |
| >0 | hold, launcher active | consumed | one latched `CIRCLE` pulse |
| >0 | hold, guest active | queue launcher return | release still emits `RIGHT` |

The long action latches until release, so the newly mounted guest cannot
see a stray pulse. Touch (`POCKETJS_INPUT_TOUCH`): the `touch` device's
`rx_indicate` counts pending messages; the frame loop drains them, divides
coordinates by the render scale, clamps to the viewport, and packs the
contact as `0x80000000 | id << 20 | y << 10 | x`. `pocket_core_touch_hits`
resolves bounds hits before `frame(buttons, 0x8080, touches, hits)`.

## LCD pipeline

`host_lcd.c` mirrors `SiFli-SDK/example/rt_driver`: open `lcd`, require the
configured physical size, select `RTGRAPHIC_PIXEL_FORMAT_RGB565`, set the
full-screen window, install `tx_complete`. Each frame renders into
`framebuffers[target]`, then `pocketjs_lcd_present` waits for the previous
`tx_complete` and submits the new buffer with `draw_rect_async`. On
DPI-AUX the HAL reports completion when its frame interrupt sees ext-DMA
reading the new address, at which point the buffer scanned before it is
retired; **three buffers** keep one transaction in flight without writing
the live or pending scan source. Frame pacing uses `rt_tick` with the
fractional remainder of `RT_TICK_PER_SECOND / POCKETJS_TICK_HZ` carried
across frames.

## Profiler

With `POCKETJS_PROFILE`, every `POCKETJS_TICK_HZ` presented frames print:

```
[PocketJS] perf frame=<n> fps=<f> total=<ms> guest=<ms> render=<ms> lcd_wait=<ms> other=<ms>
[PocketJS] render cpu=<ms> gpu_submit=<ms> gpu_wait=<ms> calls=<n>/f switches=<n> rejected=<n> full=<a>/<b> policy=<n> dirty_avg=<px> last=<px> regions=<n>[ full]
[PocketJS] work words=<n> gpu=<fills>/<gradients>/<blends>/<copies> sw=<ops>/<words> tiles=<n>/<KB> fences=<n> bands=<n> miss=<n> mem=<qjsKB>/<freeKB>
```

- `guest` is the JavaScript frame plus `pocket_core_tick`; `render` is
  `pocket_core_render_rgb565`; `lcd_wait` is the present call including the
  wait for the previous scan; `other` is the remainder of the frame period.
- `gpu_submit` and `gpu_wait` are DWT cycles inside the executors (HAL or
  VG Lite programming, and waiting for completion); `cpu` is the rest of
  `render`: planning, A8 composition, tile rasterization. `calls` counts
  transactions per frame; `switches` counts EPIC/VG Lite drains;
  `rejected` must stay 0.
- `full`/`policy`: frames repainted whole, and how many of those the 75 %
  damage threshold promoted. A large `full` with a small `policy` points at
  structural DrawList changes or invalidation.
- `sw`, `tiles`, `fences`, `bands` describe the fallback and plane traffic
  of the last frame; a static launcher screen reports `sw=0/0`.
- `mem` is QuickJS bytes in use and the free bytes of the shared heap.

## Self-check and frame CRC

`POCKETJS_SELF_CHECK` renders every `POCKETJS_SELF_CHECK_INTERVAL`-th frame
a second time with `pocket_core_render_rgb565_software` into a scratch
buffer in PSRAM2 (one more framebuffer, 1,228,800 bytes) and compares it
with the hardware frame just rendered:

```
[PocketJS] selfcheck frame=<n> mismatch=<px>/<total> (<p>%) psnr=<dB> maxd=<0..255> crc_hw=<crc32> crc_sw=<crc32> gpu=<fills>/<gradients>/<blends>/<copies> sw=<ops> vg=<n>
[PocketJS] selfcheck diff x=<x> y=<y> hw=<rgb565> sw=<rgb565>      (up to 16)
```

`maxd` is the largest 8-bit channel difference after expanding RGB565;
PSNR is computed over all three channels of every pixel (999.0 for
identical frames); `vg` is the number of commands VG Lite ran since the
last profiler reset. `bun tools/sifli.ts selfcheck <log>` applies the
thresholds: a frame whose hardware work is fills, A8 blends, and 1:1
copies must match **exactly**; EPIC gradients and scaled blits allow
**PSNR ≥ 45 dB, maxd ≤ 8, mismatch ≤ 0.5 %** (1/1024 scale rounding and
2×2 corner interpolation); VG Lite frames allow **PSNR ≥ 38 dB and
mismatch ≤ 3 %**; anything below 35 dB fails.

`POCKETJS_FRAME_CRC` prints `[PocketJS] crc frame=<n> hash=<draw hash>
crc=<crc32>` for every presented frame (IEEE CRC-32 over the little-endian
RGB565 bytes; one uncached read of the framebuffer per frame). `bun
tools/sifli.ts crc <output> --frames N --assert <log>` boots the same guest
in the simulator at 512×300, density 2, scale 2 with no input, renders
through `ui_render_rgb565_scaled` (the core's RGB565 rasterizer, byte for
byte the device's software path), and compares frame by frame. With
`POCKETJS_FORCE_SOFTWARE` the sequence must be equal; with the hardware
path only frames the self-check classifies as exact are expected to
match.

## Verification boundary

Before a commit:

- `cargo test --locked --manifest-path engine/backends/sifli-epic/Cargo.toml --features std`;
- `cargo build --release --locked --manifest-path hosts/sifli/rust/Cargo.toml --target thumbv8m.main-none-eabihf`;
- `bun tools/sifli.ts verify` (deterministic non-flat frames at the device
  viewport; project guests and the launcher flow with
  `POCKETJS_SIFLI_PROJECT`);
- `bun tools/sifli.ts assets <project>` twice: `assets/MANIFEST.txt` is
  byte-identical;
- the full `scons --board=...` build of the project and
  `bun tools/sifli.ts audit <build>/main.elf`.

On the board: the profiler at 60 Hz with `rejected=0`, `sw=0/0` on a
static screen, a heap that returns to its baseline after a guest switch,
no tearing over a continuous animation, `bun tools/sifli.ts selfcheck`
passing on a self-check build, and `bun tools/sifli.ts crc --assert`
equal for 600 frames on a `POCKETJS_FORCE_SOFTWARE` build. Hardware sampling is not
byte-identical to the core rasterizer for scaled blits and gradients
(1/1024 scale rounding, 2×2 corner interpolation); fills, A8 blends, 1:1
copies, and every CPU fallback are exact.

## Limits

- SF32LB58 EPIC has no color matrix and no 3×3 transform: the SDK defines
  `EPIC_SUPPORT_TRANS_MATRIX` and `EPIC_SUPPORT_COLOR_MATRIX` for 57x only.
  Portable PSM textures, RGB modulation, and projective quads run on VG
  Lite; without `POCKETJS_GPU_VGLITE` they fall back to the CPU.
- VG Lite conventions still to confirm on a board: the `vg_lite_color_t`
  channel order for the tint, `VG_LITE_BLEND_SRC_OVER` against
  non-premultiplied sources, and the projective sampling phase against the
  core rasterizer. The device self-check reports the mismatch.
- The executor keeps a single transaction in flight. Continuous blends
  (`HAL_EPIC_ContBlendStart`) and the shadow-instance fast path are not
  used yet; `calls`/f in the profiler is the number to watch.
- `POCKETJS_MPU_OVERRIDE` and the memory map above are SF32LB58-specific;
  another board needs its own partition table and MPU regions.
