# PocketJS for PS Vita

`pocketjs-vita` is the native PS Vita host for PocketJS. It embeds QuickJS,
feeds the normal PocketJS pak, renders the standard DrawList with vita2d/GXM,
and reads the physical Vita controller. Existing PocketJS bundles do not need
a Vita-specific entry point.

The PocketJS logical viewport remains 480x272, so PSP applications keep the
same layout. The resolved Vita profile separately sets a 960x544 physical
viewport and raster density 2: geometry is sampled at physical resolution,
font coverage/SVG/core masks are baked at 2x, and `@2x` image or raw-pak
siblings are selected when present. There is no letterboxing or aspect-ratio
crop. Touch is intentionally not implemented yet. D-pad, face buttons,
shoulders and both analog sticks are available through `input::read`; reusable
game hosts can pass the left-stick packing through `Runtime::frame_with_analog`.

## Toolchain

The supported local setup is:

- VitaSDK in `$VITASDK` (this workstation uses `~/vitasdk`)
- `cargo-vita` 0.2.2
- Rust nightly `2026-05-28` with `rust-src`
- Vita3K for emulator E2E

`scripts/vita.ts` prepends VitaSDK and the rustup shims to `PATH`, so a
Homebrew stable Rust installation cannot accidentally take over a Vita build.
The pinned toolchain is also recorded in `rust-toolchain.toml`.

```sh
export VITASDK="$HOME/vitasdk"
export PATH="$VITASDK/bin:$HOME/.cargo/bin:$PATH"

bun play vita hero
# builds, replaces PCKT00001 in the configured VitaFS, and launches Vita3K
bun play vita gallery --fullscreen
# also enters host fullscreen and stretches the Vita display to fill it
bun play --help
# lists every demo accepted by the command

# Low-level build only:
bun run vita hero --release
# native-vita/target/armv7-sony-vita-newlibeabihf/release/pocketjs-vita.vpk
```

`bun play vita <demo>` owns the interactive loop: it builds the selected demo,
validates and installs the VPK, safely restarts an existing Vita3K instance,
then checks that the new emulator process survives startup. In Vita3K, use the
arrow keys for the d-pad, `Q`/`E` for L/R, `C` for Circle, `X` for Cross, `V`
for Triangle, `Z` for Square, WASD/IJKL for the two sticks, and `F11` to toggle
fullscreen.

The VPK uses vita2d's precompiled shaders and does not require
`libshacccg.suprx`. Vita3K's normal interactive setup should still install the
official PS Vita firmware; the isolated homebrew E2E deliberately runs HLE
modules only so it cannot mutate a developer's normal VitaFS.

## Golden E2E

```sh
bun run e2e:vita
E2E_VITA3K_APP=hero bun run e2e:vita  # focused iteration
```

For each demo the driver builds a capture VPK, boots it in an isolated VitaFS,
waits for the guest `done` marker, and terminates only the spawned emulator.
It checks that every guest frame is exactly 960x544, was rasterized directly at
physical resolution, contains real detail inside at least one 2x2 logical
block, and is byte-identical to its independent `test/goldens-vita` image.
Vita3K's GXM framebuffer cannot currently be read
back coherently on macOS, so the pixel oracle is CPU-rendered; each capture also
asserts that every DrawList texture and font atlas used by the production GXM
pass is resident in its GPU cache. This catches backend-only omissions such as
core-generated rounded-corner textures or a font atlas rejected by the Vita
texture packer.

Current Vita3K 0.2.1 builds on macOS can fault while tearing down GXM after a
guest calls `sceKernelExitProcess`. Capture builds therefore park after the
`done` marker and let the host driver own process termination. Production VPKs
are unaffected.
