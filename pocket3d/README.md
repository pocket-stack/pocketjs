# Pocket3D / OpenStrike

Pocket3D is a standalone Rust-first 3D runtime layer inside the PocketJS
repository. It deliberately lives under `pocket3d/` instead of joining the
existing PSP-oriented PocketJS UI crates.

OpenStrike is the first Pocket3D application: a single-player BSP FPS vertical
slice that loads a GoldSrc map, spawns a player and bot, runs fixed-tick
movement, fires a hitscan rifle, kills the bot, and advances the round state.

## Layout

```text
pocket3d/
  Cargo.toml
  DESIGN.md
  crates/
    pocket3d-core/
    pocket3d-app/
    pocket3d-render/
    pocket3d-render-wgpu/
    pocket3d-assets/
    pocket3d-bsp/
    pocket3d-physics/
    pocket3d-kcc/
    pocket3d-anim/
    pocket3d-audio/
    pocket3d-script/
  tools/p3d/
  examples/openstrike/
```

## Asset Policy

The repository must not commit Counter-Strike or Valve assets. OpenStrike
loads local user-supplied BSP/WAD files during development.

This worktree has been validated against:

```sh
~/Downloads/cs-maps-20260705-1836/maps/de_dust2.bsp
~/Downloads/cs-maps-20260705-1836/support
```

## Commands

Run all tests:

```sh
cd pocket3d
cargo test --workspace
```

Inspect a BSP:

```sh
cd pocket3d
cargo run -p p3d -- bsp inspect \
  ~/Downloads/cs-maps-20260705-1836/maps/de_dust2.bsp \
  --wad-dir ~/Downloads/cs-maps-20260705-1836/support
```

Run the deterministic headless OpenStrike loop:

```sh
cd pocket3d
cargo run -p openstrike -- \
  --headless \
  --ticks 600 \
  --map ~/Downloads/cs-maps-20260705-1836/maps/de_dust2.bsp \
  --wad-dir ~/Downloads/cs-maps-20260705-1836/support
```

Run the interactive `wgpu` prototype:

```sh
cd pocket3d
cargo run -p openstrike -- \
  --map ~/Downloads/cs-maps-20260705-1836/maps/de_dust2.bsp \
  --wad-dir ~/Downloads/cs-maps-20260705-1836/support
```

Controls:

- `WASD`: move
- mouse: look
- left mouse: fire
- `Space`: jump
- `Shift`: sprint
- `Esc`: quit

## Implemented Vertical Slice

- Standalone Cargo workspace under `pocket3d/`
- Fixed 60 Hz simulation tick
- GoldSrc BSP loading through `qbsp`
- WAD3 texture discovery and RGBA decoding
- BSP entity lump parsing, spawn extraction, bounds, mesh and triangle output
- BSP inspector and asset packer CLI
- BSP-backed raycast physics wrapper
- Pocket3D character-controller trait with a BSP raycast move-and-slide v0
- OpenStrike player movement, gravity, jump, weapon cooldown, hitscan damage
- Bot capsule, procedural humanoid mesh, simple walk/death animation state
- Round states from pre-round to live to win/restart
- `wgpu` window renderer with a forward world pass and depth buffer
- Headless validation path for CI-friendly gameplay checks

Known v0 simplifications:

- The renderer currently hashes material/texture names to colors; WAD texture
  pixels are parsed and available, but not yet bound into the `wgpu` material
  pipeline.
- The bot uses a procedural humanoid skeleton/mesh instead of a committed GLB,
  preserving the repository asset policy while keeping the animation boundary in
  place.
- The KCC is the documented fallback path: a Pocket3D trait backed by BSP
  raycasts. Rapier can replace it behind the same trait later.
