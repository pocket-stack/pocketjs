# PocketJS for PS Vita

`pocketjs-vita` is the native PS Vita host for PocketJS. It embeds QuickJS,
feeds the normal PocketJS pak, renders the standard DrawList with vita2d/GXM,
and reads the physical Vita controller. Existing PocketJS bundles do not need
a Vita-specific entry point.

The PocketJS logical viewport remains 480x272. The Vita backend multiplies
every coordinate by exactly two and fills the native 960x544 framebuffer;
there is no letterboxing or aspect-ratio crop. Touch is intentionally not
implemented yet. D-pad, face buttons, shoulders and both analog sticks are
available through `input::read`; reusable game hosts can pass the left-stick
packing through `Runtime::frame_with_analog`.

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

bun run vita hero --release
# native-vita/target/armv7-sony-vita-newlibeabihf/release/pocketjs-vita.vpk
```

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
It checks that every guest frame is exactly 960x544, that every logical pixel
occupies a 2x2 physical block, and that the downsampled PNG is byte-identical
to `test/goldens`. Stable, visually reviewed ARM layout rounding differences
may live in `test/goldens-vita`; currently 33/35 frames use the shared oracle
directly and two library frames carry the same one-pixel Vita override.

Current Vita3K 0.2.1 builds on macOS can fault while tearing down GXM after a
guest calls `sceKernelExitProcess`. Capture builds therefore park after the
`done` marker and let the host driver own process termination. Production VPKs
are unaffected.
