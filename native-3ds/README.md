# PocketJS on the Nintendo 3DS (`native-3ds/`)

The 3DS backend: the same `app.tsx` + `pocketjs-core`, running on the 3DS top
screen via QuickJS + a C homebrew host, buildable for the **Azahar** emulator
and (eventually) real hardware. It is the 3DS analogue of `native/` (PSP).

> **Status: verified working on Azahar.** `bun run 3ds hero` builds the `.3dsx`
> (Rust bridge cross-compiled for `armv6k-nintendo-3ds` + QuickJS + the C host,
> linked in the `devkitpro/devkitarm` Docker image) and it runs on Azahar
> 2125.1.2 at ~99% speed: the hero demo renders on the 400×240 top screen (crisp
> baked-atlas text, gradient underline, shadowed button) and is interactive
> (D-pad focus → Circle press increments the counter). Colors and orientation
> were correct first try. Fixes found bringing it up, all in the tree:
>   - the FFI crate is `#![no_std] + alloc` with a `memalign`-backed
>     `#[global_allocator]` + `panic="abort"`, cross-built `-Z build-std=core,alloc`
>     (no std → no pthread-3ds/shim-3ds); **`lto` MUST stay off** (LTO emits
>     bitcode objects the devkitARM linker can't read);
>   - the 3dsx main thread needs a big stack for QuickJS to parse the bundle —
>     `u32 __stacksize__ = 2*1024*1024;` in `main.c` (same reason PSP uses a 2 MB
>     worker thread; without it QuickJS overflows the ~32 KB default and PC→0).

## Architecture

```
   app.tsx  (Solid + Tailwind, device profile "3ds")
      │  scripts/build.ts --device=3ds   (breakpoints/flags resolved for 400×240)
      ▼
   dist/<app>.js + dist/<app>.pak
      │  native-3ds/gen-game.ts  → source/game_{js,pak}.h  (embedded C arrays)
      ▼
   ┌── C host (source/main.c, devkitARM) ──────────────────────────┐
   │  QuickJS  ── globalThis.ui.* ─►  pj_*  (extern "C")            │
   │  (bundled     eval app.js         │                           │
   │   quickjs/)                       ▼                           │
   │                        pocketjs-3ds-ffi  (Rust staticlib)     │
   │                          = pocketjs-core + the SAME software   │
   │                            rasterizer as the wasm goldens      │
   │  per vblank: input→frame(mask)→drain jobs→pj_tick()→pj_render()│
   │                                   │ RGBA 400×240               │
   │                                   ▼                           │
   │                     present() → top-screen framebuffer (gfx)  │
   └───────────────────────────────────────────────────────────────┘
```

**Why this shape.** The [3DS toolchain research](../DESIGN.md) found that linking
QuickJS into a Rust `ctru-rs` binary is undemonstrated, whereas dreamcart already
runs QuickJS on the 3DS from a **pure-C** devkitARM host. So we keep that proven
C+QuickJS+devkitARM shell and link **only `pocketjs-core`** in as a Rust
staticlib. v1 renders by blitting `pocketjs-core`'s software-rasterized
framebuffer (the exact rasterizer behind the byte-exact wasm/Bun goldens) — with
the `3ds` profile the core lays out natively at 400×240, so it's a 1:1 copy to
the top screen, no scaling, pixel-identical to the web host. A GPU-native
`DrawList → citro3d` backend (mirroring `native/src/ge.rs`) is the **v2** perf
path (see *Roadmap*).

## Files

| path | role |
|---|---|
| `ffi/` | Rust `staticlib` `pocketjs-3ds-ffi`: the `pj_*` C ABI over `pocketjs-core` + the reused rasterizer. **Builds & is symbol-checked on the host.** |
| `source/main.c` | the C host: QuickJS boot, `ui.*` bindings → `pj_*`, `aptMainLoop` frame loop, 3DS→PSP input map, framebuffer present. |
| `source/pocketjs_ffi.h` | C declarations of the `pj_*` bridge (keep in sync with `ffi/src/lib.rs`). |
| `Makefile` | devkitARM `3ds_rules`; links `libpocketjs_3ds_ffi.a` + `quickjs/` + `ctru`. |
| `gen-game.ts` | embeds `dist/<app>.{js,pak}` into `source/game_{js,pak}.h`. |
| `quickjs/` | **not vendored** — populate from the proven 3DS QuickJS fork (see below). |
| `../scripts/3ds.ts` | one-command orchestrator (`bun run 3ds <app>`). |

## Prerequisites

1. **devkitPro + the 3DS toolchain** (or Docker, see step 4):
   ```sh
   # macOS: install dkp-pacman (devkitpro-pacman-installer.pkg from
   #   https://github.com/devkitPro/pacman/releases/latest), then:
   sudo dkp-pacman -S 3ds-dev          # devkitARM, libctru, tools (3dsxtool…)
   export DEVKITPRO=/opt/devkitpro
   export DEVKITARM=$DEVKITPRO/devkitARM
   export PATH=$DEVKITPRO/tools/bin:$DEVKITARM/bin:$PATH
   ```
2. **Rust nightly + `rust-src`** (the `armv6k-nintendo-3ds` target is Tier-3 and
   built into nightly rustc — no `rustup target add`, but std needs `-Z
   build-std`, which needs the source):
   ```sh
   rustup toolchain install nightly
   rustup component add rust-src --toolchain nightly
   ```
3. **Vendor `quickjs/`.** This repo does not ship the QuickJS C sources. Copy the
   proven 3DS fork in (it builds under devkitARM with `-fpermissive`):
   ```sh
   cp -R ../../dreamcart/*/runtime-3ds/quickjs native-3ds/quickjs   # or your fork
   ```
4. **Azahar** (the maintained Citra successor) to run the result. Already at
   `/Applications/Azahar.app` on macOS.

## Build & run

```sh
bun run 3ds hero          # = bun scripts/3ds.ts hero
# → builds dist/hero.{js,pak} (device 3ds), cross-builds the Rust bridge,
#   embeds, and makes native-3ds/pocketjs-3ds.3dsx
/Applications/Azahar.app/Contents/MacOS/azahar native-3ds/pocketjs-3ds.3dsx
```

`scripts/3ds.ts` uses the host `DEVKITARM` if set, otherwise falls back to the
`devkitpro/devkitarm` **Docker** image for the `make` step (no host toolchain /
sudo needed — the same approach dreamcart uses). It derives the 400×240 screen
size from the `3ds` profile in `spec/devices.ts` (one source of truth) and passes
it to the Rust bridge build as `POCKETJS_SCREEN_W/H`.

## Memory

libctru splits FCRAM into a cached **general heap** (newlib `malloc` → the
QuickJS allocator) and a GPU-visible **linear heap**. The Old-3DS default leaves
only **~24 MB** general heap, which is tight for a large QuickJS bundle, so
`source/main.c` overrides the split via the `__ctru_heap_size` /
`__ctru_linear_heap_size` weak symbols (40 MB / 12 MB — v1 needs little linear
since it renders via `gfx`, whose framebuffers are in VRAM). Budget QuickJS +
taffy + core + textures under **~50 MB on O3DS**; the New-3DS (124 MB region) is
comfortable. Extended-memory modes are unavailable to a plain `.3dsx`. Probe at
runtime with `linearSpaceFree()`.

## Emulator golden harness (honest status)

There is **no headless, byte-exact frame-dump path in Azahar** like PSP's
`PPSSPPHeadless` — the Qt frontend always opens a window and there is no
per-frame PNG CLI. A deterministic harness is still achievable, just more work:

- **Software renderer** — Azahar ships a CPU PICA200 rasterizer
  (`GraphicsAPI::Software`); select it for machine-independent output (host-GPU
  output is driver-dependent). This is the reference path for goldens.
- **Deterministic input** — CTM "TAS movie" record (`-r`) / replay (`-p`) seeds
  the RNG and base ticks, so input replays identically (the git-hash mismatch is
  a non-blocking warning). Playback ends in a **non-finalizing modal**, so CI
  needs a small patch (`OnMoviePlaybackCompleted → finalize + exit(0)`).
- **Recommended: self-capture.** The most robust and fully-in-our-control path
  mirrors the PSP capture feature (`native/src/main.rs cap_dump_frame`): add a
  capture build of the C host that writes `pj_render()`'s framebuffer to the SD
  card for a scripted window, then byte-compare PNGs off-device. Since the v1
  render path *is* the wasm rasterizer, these goldens should match the
  `goldens-3ds/` set produced by `test/golden.ts` at 400×240 — giving a
  cross-check that doesn't depend on the emulator at all.

## Confirmed on Azahar

The three former unknowns, now resolved by running it:

1. **Framebuffer channel order** (`main.c present()`): `d[0..3] = A,B,G,R` from the
   rasterizer's R,G,B,A is **correct** for `GSP_RGBA8_OES` — colors render right.
2. **Top-screen rotation** (`main.c present()`): the `(x*240 + 239-y)` mapping is
   **correct** — the UI is upright and correctly positioned.
3. **std linking**: resolved by making `ffi/` **`no_std` + `alloc`** with a
   `memalign`-backed `#[global_allocator]` (see `ffi/src/lib.rs`), so the build is
   `-Z build-std=core,alloc` — no std, no `pthread-3ds`/`shim-3ds`.

Remaining polish (not blockers): the hero subtitle overflows 400 px and clips at
the right edge — the intended fix is a `3ds:`/`sm:` responsive variant (the whole
point of the device-profile system); and `pj_render()` runs the software
rasterizer on the ARM11 CPU each frame (fine here at ~99% emulated speed; the
citro3d GPU path in *Roadmap* is the perf upgrade for real hardware).

## Roadmap (v2)

- GPU-native backend: walk the core `DrawList` and emit citro3d immediate-mode /
  citro2d calls (port of `native/src/ge.rs`), replacing the software-blit for
  perf. Watch-outs from research: PICA200 textures are Morton-swizzled (glyph
  atlas + image uploads need runtime tiling), and `C3D_SetScissor` works in
  rotated buffer space with no push/pop stack.
- Second screen / touch: the `3ds` profile already declares `touch` +
  `dualscreen` caps for `touch:`/`dualscreen:` variants; wiring a second `Ui`
  surface + touch input ops is the follow-up.
- CIA packaging + real-hardware `3dslink` run.

## Provenance

The C host, Makefile, `gen-game.ts`, and QuickJS integration follow dreamcart's
`runtime-3ds` (proven on Azahar + hardware). The `pj_*` op surface mirrors
`native/src/ffi.rs`; the pak feed mirrors `native/src/pak.rs`; the rasterizer is
reused verbatim from `wasm/src/raster.rs`.
