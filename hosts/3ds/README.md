# Nintendo 3DS host

PocketJS on the 3DS top screen: QuickJS runs the guest bundle, the Rust core
owns the retained tree, layout, animation and DrawList emission, and a C
backend walks that DrawList into **PICA200 draw calls through citro3d**. The
app owns the whole panel — **400x240, rasterDensity 1, presentation `native`**
— under the out-of-registry `3ds-dev` profile in `tools/3ds-profile.ts`.

**The CIA boots and renders the calibration app on a New 3DS LL.** The profile
remains out of the production registry because the current hardware and golden
suite does not directly exercise the synthesized cursor, sprites, streamed
textures or a large font atlas.

`hosts/psp` puts its GPU backend in Rust because the `psp` crate has bindings
for the GE. citro3d is a C library of mostly `static inline` functions, so here
the split is the other way round and matches `hosts/iphone2g`: **C owns the
graphics API, Rust owns everything above it.** That is why this host's crate
exports the DrawList itself (`ui_draw`, `ui_draw_list_ptr`,
`ui_draw_list_len`) and the texture and font registries over the C ABI, which
`engine/symbian` does not — its GLES backends consume the list internally.

```
core/                 pocketjs-3ds-core: the ui_* C ABI over pocketjs-core
  src/lib.rs          lifecycle, HostOps, DrawList handoff, pak feed
  src/alloc.rs        #[global_allocator] over newlib + panic handler
include/pocket_core.h the C header for the above
src/main.c            libctru/citro3d boot, the frame loop, frame capture
src/gfx.c             the DrawList -> citro3d walker
src/qjs.c             QuickJS embedding: globalThis.ui -> ui_* calls
src/input.c           3DS keys and circle pad -> the PSP BTN bitmask
src/vshader.v.pica    the PICA200 vertex shader
Makefile              run INSIDE the container by tools/3ds.ts
app.rsf               the CIA descriptor makerom reads
icon.png              48x48 SMDH icon
```

## Building

Two toolchains, one repository:

- The **Rust staticlib builds on macOS**. `armv6k-nintendo-3ds` is a built-in
  rustc target, so `core/.cargo/config.toml` only has to ask for `build-std`;
  `core/rust-toolchain.toml` pins the nightly. The target defaults to unwind,
  so the crate sets `panic = "abort"`.
- The **C half builds in the digest-pinned `devkitpro/devkitarm` image**, which brings
  `arm-none-eabi-gcc`, libctru, citro3d, `picasso`, `smdhtool` and `3dsxtool`.

`tools/3ds.ts` drives both and hands this Makefile container paths in
environment variables (the list is at the top of the Makefile). Nothing here
reaches outside `hosts/3ds` except through them.

```sh
bun tools/3ds.ts 3ds-demo              # dist/3ds/<output>.3dsx
bun tools/3ds.ts 3ds-demo --capture    # the deterministic e2e binary
bun tools/3ds.ts 3ds-demo --cia        # also dist/3ds/<output>.cia
```

Two build-time facts are load-bearing:

- **`-DJS_NO_NAN_BOXING` must be on every translation unit that includes
  `quickjs.h`.** The header turns NaN boxing on by default for any 32-bit
  target, which makes `JSValue` 8 bytes instead of 16, while `libquickjs.a` is
  compiled with the flag. The mismatch links cleanly and then hands the library
  differently shaped values: the guest boots and QuickJS's GC walks garbage
  pointers a few hundred milliseconds later.
- **`__stacksize__` is raised to 1 MiB.** devkitPro's 3dsx crt0 gives the main
  thread 32 KiB, and QuickJS's interpreter plus the guest's render pass recurse
  far past that.

## The CIA, and the memory region it asks for

`--cia` writes `dist/3ds/<output>.cia` next to the `.3dsx`, from the same ELF
and the same staged romfs directory.

**A `.3dsx` runs under the Homebrew Launcher and lives inside hbmenu's memory
allocation. A CIA is its own installed title and asks the kernel for its own
memory region.** That request is `SystemMode: 64MB` in `app.rsf` — the largest
region an Old 3DS gives an application, out of the console's 128 MiB — plus
`SystemModeExt: 124MB`, which a New 3DS honours and an Old 3DS ignores. A guest
whose arena, expanded textures and pak add up past what hbmenu hands out has no
way to ask for more as a `.3dsx`. That is why the format is here: Pocket Voxel's
12 MiB arena plus ~14 MiB of expanded textures plus a 30.6 MiB pak is exactly
the budget that may not fit under the Homebrew Launcher on a real console.

Three facts about the packaging itself:

- **No banner is required.** makerom needs one only for a title that plays an
  animated banner in HOME Menu. The SMDH passed as `-icon` already carries the
  icon and the title strings, and `-exefslogo` supplies the boot logo.
- **The romfs is a directory, not an image.** makerom builds the romfs itself
  from `RomFs.RootPath`, pointed at the same directory 3dsxtool embeds. Handing
  it the raw romfs binary that `mkromfs3ds` produces — the container 3dsxtool
  takes — fails with `Invalid RomFS Binary`; the two packagers share the staged
  directory and nothing else.
- **makerom ships in neither devkitPro nor Homebrew**, so `tools/3ds.ts` fetches
  one pinned `github.com/3DSGuy/Project_CTR` revision into
  `dist/3ds/makerom/src`, builds it in the same container as everything else,
  and caches the binary against the container image and revision. mbedtls, blz
  and yaml are vendored in that repository, so the fetch is the only step that
  needs the network.

The title's identity comes from the resolved plan, never from a literal per app
(`ciaUniqueId`, `ciaProductCode`, `ciaProcessName` in `tools/3ds.ts`): the
**unique id is `0xFF000 | hash(app.id) & 0xFFF`**, inside the `0xFF000-0xFFFFF`
block that no retail or system title uses, so an app keeps one title id across
rebuilds and an install replaces its predecessor instead of accumulating. The
product code is `CTR-P-` plus four characters of the app id. The RSF's
`BasicInfo.Title` is the exheader's process name, which is 8 bytes — the cut
happens in TypeScript rather than silently inside makerom, and the title HOME
Menu shows is the SMDH's, still whole.

Azahar installs one and then boots the installed title from its own SD card:

```sh
azahar -i dist/3ds/pocket3ds-demo-main.cia
azahar "$HOME/Library/Application Support/Azahar/sdmc/Nintendo 3DS/\
00000000000000000000000000000000/00000000000000000000000000000000/\
title/00040000/0ffc1900/content/0429b6bc.app"
```

`00040000` is the application category and `0ffc1900` is this demo's unique id
shifted up by its 8-bit variation; `tools/3ds.ts` prints the whole title id when
it writes the file. A capture build installed and booted this way produced
frames **byte-identical to the `.3dsx` goldens** in `tests/goldens/3ds/`.

## What `globalThis.ui` has to publish

Beyond the HostOps table, `src/qjs.c` publishes four properties the framework
reads directly. `__host` and `__hostAbi` come from the build's `-D` defines and
gate mounting. `__textures` and `__sprites` are the pak name tables. The fourth
is geometry:

- **`ui.__viewport` is the logical UI size, and omitting it is a layout bug,
  not a missing nicety.** `framework/src/index.ts` sizes the mounted app and
  overlay layers from it and falls back to the spec screen, 480x272, when a
  host leaves it off. On this 400x240 panel that fallback lays the app out
  **80 px too wide**: the extra width is invisible for anything anchored left,
  and moves everything measured from the layer's right edge — `justify-between`,
  a row's last child after a `grow` sibling, every `right-0` absolute — off the
  panel. The value is read back from the core with `ui_viewport_width` /
  `ui_viewport_height` after `main.c` has called `ui_set_viewport`, so the JS
  root layer and the native root node cannot drift apart. Publishing a size is
  not a live-resize capability: that needs `installResizeViewportHook`, which a
  `takeover` host never calls.

## What the backend has to honour

`src/gfx.c` is the 3DS twin of `engine/symbian/src/gl/mod.rs`: the same walk,
the same texture and font-atlas caches, the same batching by texture and
scissor. It does **no clipping** — the core's CPU clip stage guarantees every
coordinate is already inside the viewport and i16-safe. The PICA200 adds:

- Render targets are created **rotated**: `C3D_RenderTargetCreate(240, 400, …)`
  for the top screen, and `Mtx_OrthoTilt` keeps guest coordinates landscape.
  `C3D_FrameDrawOn` resets the viewport, so `C3D_SetViewport` comes after it.
- **The scissor register is in raw framebuffer pixels and both of its axes run
  opposite to the logical ones**: the horizontal pair counts down from the
  logical height, the vertical pair from the logical width. Flipping only one
  of them mirrors the clip along the other axis, which stays invisible until
  the clipped content is not already the size of its window.
- Textures must be power-of-two, 8..1024 per side, and **already in the
  hardware's tiled layout** — 8x8 tiles row-major, Morton order inside a tile.
  `C3D_TexUpload` is a plain `memcpy`. Non-power-of-two images get a
  power-of-two envelope and their UVs are rescaled.
- **Tiled row 0 is sampled at v = 1**, so the source is flipped vertically
  while it is tiled and DrawList UVs then pass through unchanged.
- **RGBA8 texels are stored bytes A, B, G, R** — the reverse of the core's
  order.
- **Vertex buffers must live in `linearAlloc` memory** (`BufInfo_Add` rejects
  any pointer below physical `0x18000000`), and the arena is flushed out of the
  data cache before the draws that read it.
- There is **no fragment shader**: one TEV stage modulates the sampled texel by
  the vertex colour, and untextured ops bind an 8x8 white texture so that
  single stage covers every op. There is also **no paletted format**, so
  `PSM_T8` is expanded at upload.

## Capture and the Azahar loop

`-DPOCKETJS_CAPTURE` turns `main.c` into the e2e binary: input comes from a
tape baked into the binary rather than from the emulator's filesystem, the
frames in `[POCKETJS_CAP_START, POCKETJS_CAP_START + POCKETJS_CAP_N)` are read
back off the render target, and the process **parks instead of exiting** —
Azahar does not stop when the app returns from `main()`.

Emitted under `sdmc:/pocketjs-captures/`: `fNNNN.raw` named by the
process-global frame counter (exactly `400*240*4` bytes), then `done` written
only after the last frame is closed, and `error.txt` on the failure path so the
driver reports the message instead of a timeout.

The readback is **not** `gfxGetFramebuffer` after `C3D_FrameEnd` — that buffer
has already been swapped and reads back black. It is an explicit
`C3D_SyncDisplayTransfer` of the render target, after a vblank so the GPU has
finished. The bytes stay in the screen's rotated orientation, 240 wide by 400
tall, so the driver decodes `src[(x * 240 + (239 - y)) * 4]` into
`dst[y * 400 + x]` and reads the channels back as A, B, G, R.

**That transfer's output format is `GX_TRANSFER_FMT_RGB8`, and `main.c` widens
B, G, R into the A, B, G, R capture word itself.** Asking the transfer engine
for a 32-bit linear output out of this 240x400 tiled colour buffer returns rows
that are each individually correct and progressively misregistered — every
fourth output row slips a further 64 texels — while the same frame presents
perfectly on the screen. Azahar's software rasterizer answers the 32-bit request
correctly, so the wrong format is invisible until something renders through a
GPU: the identical build and the identical CIA both came back shredded under
Vulkan. Measured in the Pocket Voxel host against a known probe rectangle,
RGBA8 out matched 74.6% of it and RGB8 out matched 100.0%. RGB8 is also the
format citro3d's own presentation transfer uses, so the capture travels the path
the screen travels; the alpha byte it drops was never read, because the decode
takes R, G and B only.

```sh
bun tests/e2e/azahar.ts
```

**Azahar's two renderers agree on the picture but not on every byte.** With the
RGB8 readback in place, a Vulkan (`graphics_api=2`) capture of the demo differs
from the committed Software (`graphics_api=0`) goldens on **5.1% of pixels,
99.5% of them by 1 or 2 of 255** — the two rasterizers round texture filtering
and TEV blending differently — plus **24 pixels along the logo's one diagonal
edge**, by up to 157. A golden therefore still belongs to one backend, and the
e2e fixture pins it to Software, the backend that does not depend on the
developer's GPU driver. `E2E_AZAHAR_GRAPHICS_API=2 bun tests/e2e/azahar.ts`
re-measures the gap.

Azahar derives its whole user directory from `$HOME` and has no switch for any
part of it, so a run gets its own config and SD card by getting its own `$HOME`.

## Not advertised

`input.touch` is deliberately absent from the profile. The touchscreen is the
**bottom** screen at 320x240 while the UI renders on the **top** at 400x240;
reporting bottom-screen contacts as logical coordinates inside the top screen's
space would be a lie, and a second surface needs a design, not a capability id.
`audio.pcm` is not implemented in v1.
