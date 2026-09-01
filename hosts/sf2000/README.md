# SF2000 / UniFrog host

This host runs a PocketJS `.pocket` package as an external libretro module on
an SF2000 with UniFrog 0.6.3. It targets MIPS32r1 little-endian soft-float and
renders the PocketJS draw list into a native 320x240 RGB565 frame.

## Build the app

From the PocketJS checkout:

```sh
bun install
bun tools/pocket.ts build --target sf2000 \
  --manifest apps/sf2000-demo/pocket.json \
  --project-root .
```

The app package is written to `dist/sf2000-demo.pocket`.

## Build the UniFrog module

Use a clean UniFrog 0.6.3 checkout. Apply the small integration patch and point
it at this checkout. The build needs a Linux environment (WSL works), the
UniFrog prerequisites, and a Rust nightly toolchain with `rust-src`:

```sh
rustup toolchain install nightly-2026-05-28 --component rust-src
git apply /path/to/pocketjs/hosts/sf2000/unifrog-v0.6.3.patch
printf '%s\n' 'POCKETJS_DIR := /path/to/pocketjs/hosts/sf2000' >> config.mk
make setup
make core CORE=pocketjs
```

The module is written to
`output/sdcard/unifrog/cores/pocketjs.bin`.

For a checkout whose UniFrog dependencies are already initialized, the shorter
core-only build is:

```sh
make core-out CORE=pocketjs
make output/sdcard/unifrog/cores/pocketjs.bin
```

## Install on the SD card

1. Copy `pocketjs.bin` to `/unifrog/cores/pocketjs.bin`.
2. Copy `sf2000-demo.pocket` to a ROM directory scanned by UniFrog.
3. Refresh the UniFrog game list and associate the `.pocket` extension with the
   PocketJS core if it is not selected automatically.
4. Launch the demo and use the D-pad plus the face-button mapped as libretro B
   (PocketJS Confirm/Cross).

The current module is an initial hardware milestone. It exposes UI rendering,
baked text, image/sprite assets, focus navigation, and digital buttons. Audio,
save states, networking, launcher switching, touch, and DevTools are not yet
implemented.

The software renderer emits a 320x240 RGB565 framebuffer at 60 Hz. QuickJS runs
inside the same external libretro module, so `.pocket` files are loaded as ROM
content rather than installed as native HCRTOS applications.
