# PocketJS Nintendo Switch host

This host packages one manifest-resolved PocketJS guest as a Nintendo Switch
homebrew `.nro`. libnx owns startup, RomFS, controller input, and the linear
framebuffer. A linked Rust static library owns QuickJS, the complete `HostOps`
surface, `pocketjs-core`, pak resources, and density-2 software rasterization.
The same guest bundle and framework APIs used by the PSP and Vita hosts run
without Switch branches in application code.

## Supported contract

The stock `switch` target uses host ABI 4 and supports the current
PSP-compatible application surface:

- a fixed 480x272 logical viewport;
- density-2 rasterization into a centered 960x544 image in the 1280x720
  framebuffer;
- buttons, left analog input, and the framework's analog-driven virtual cursor;
- baked glyphs, images, sprites, gradients, clipping, and transformed draw
  commands through the shared deterministic rasterizer;
- Solid, Vue Vapor JSX, and Vue single-file-component guests through the shared
  `globalThis.ui` contract.

Switch A/B/X/Y map to PocketJS Circle/Cross/Triangle/Square. The D-pad and
shoulder buttons preserve the PSP mask, the left stick supplies packed analog
input, Minus maps to Select, and Plus maps to Start. Plus+Minus exits the
homebrew application without consuming the mapped Start button.

This is a QuickJS **guest** target. It does not add a `vapor/runtime/switch`
backend: Pocket Vapor is the separate AOT compiler family for devices that do
not ship a JavaScript engine. Vue Vapor guest applications already run on this
host through the platform-independent framework runtime and shared `HostOps`.

## Dependencies

- Bun;
- the Rust nightly pinned in [`tools/cli/psp-toolchain.json`](../../tools/cli/psp-toolchain.json),
  including its `rust-src` component;
- devkitPro pacman and the `switch-dev` package group, which supplies devkitA64,
  libnx, switch-tools, deko3d, and the official examples;
- Ryujinx for local integration testing.

On macOS, install devkitPro pacman with its official installer, then install the
Switch package group and pinned Rust component:

```sh
sudo dkp-pacman -Syu
sudo dkp-pacman -S --needed switch-dev
rustup toolchain install nightly-2026-05-28 --component rust-src
```

The backend resolves `/opt/devkitpro` by default. Override `DEVKITPRO` or
`DEVKITA64` for another installation; the build command supplies the required
compiler and tool paths without requiring shell startup-file changes.

Verify the native tools independently before debugging PocketJS:

```sh
export DEVKITPRO=/opt/devkitpro
export DEVKITA64="$DEVKITPRO/devkitA64"
export PATH="$DEVKITA64/bin:$DEVKITPRO/tools/bin:$PATH"

aarch64-none-elf-gcc --version
elf2nro --help
nxlink --help
```

The Rust half builds `core` and `alloc` for
`aarch64-nintendo-switch-freestanding` with panic abort and position-independent
AArch64 code. The backend supplies the Unix/newlib cfg values omitted by Rust's
built-in Tier-3 target. The pinned QuickJS C build also receives Switch newlib's
`malloc_usable_size` declaration and the zero-timezone fallback used by the
other native console hosts. These are backend-owned target facts; applications
must not set them.

## Build and run

Build a repository demo directly:

```sh
bun switch hero --release
```

Build any manifest-driven application:

```sh
bun pocket build \
  --target switch \
  --manifest apps/hero/pocket.json \
  --project-root . \
  -- \
  --release
```

Build and launch a repository demo in Ryujinx:

```sh
bun play switch hero
```

Set `RYUJINX` to the emulator executable or `RYUJINX_APP` to its macOS app
bundle when it is not installed at `/Applications/Ryujinx.app`. Add
`--no-launch` to build without opening the emulator. `--no-build` launches only
when the NRO content hash and play stamp match the selected demo and framework,
which prevents accidentally launching a stale artifact.

The equivalent direct emulator invocation is:

```sh
/Applications/Ryujinx.app/Contents/MacOS/Ryujinx /path/to/application.nro
```

The NRO is written to `dist/switch/<app.output>.nro`. `app.js` and `app.pak` are
embedded under `romfs:/pocketjs/`. The manifest title and version become NACP
metadata, and the package uses libnx's valid default homebrew icon.

The Makefile deliberately runs `build_romfs` and passes the resulting image to
`elf2nro` with `--romfs`. The tested macOS `elf2nro --romfsdir` path can silently
produce an NRO without its ASET payload, so it is not used.

## Emulator setup and limitations

Ryujinx firmware and keys are proprietary, user-local inputs. They are not
build dependencies and must never be added to this repository. First validate a
local emulator installation with an official devkitPro homebrew example if an
NRO does not reach the framebuffer.

The current host intentionally does not advertise native touch, right analog,
motion, rumble, audio, networking, or service mailboxes. It packages one guest
per NRO; the Pocket Launcher multi-guest lifecycle is not implemented for
Switch. Automated Ryujinx frame capture, real-hardware acceptance, and a pinned
Switch CI artifact are also not part of the supported contract. Do not infer
those guarantees from successful emulator execution.
