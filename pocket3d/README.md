# Pocket3D

A small, modern, extensible 3D runtime in Rust — the Pocket project's 3D
counterpart to PocketJS. Built on **wgpu** (Metal/Vulkan/DX12) + **winit**,
with GoldSrc **BSP maps as a first-class world format**.

Pocket3D is deliberately not a general-purpose engine. It is a lean runtime
you can read in an afternoon: a forward renderer, a first-person character
controller driven by collision traces, skeletal animation, an immediate-mode
HUD, and a headless verification story that makes every feature screenshot-
and script-testable without opening a window.

Its first proof is **OpenStrike**: a single-player CS-like FPS that loads
the classic `de_dust2`, gives you a rifle, and runs a full win/lose round
loop against animated bots.

![status](https://img.shields.io/badge/status-v0.1_experiment-orange)

## Layout

```
pocket3d/
├── crates/
│   ├── pocket3d/          # the runtime
│   │   ├── gpu            #   device bootstrap, offscreen targets + PNG readback
│   │   ├── renderer       #   forward renderer: world / models / sprites / viewmodel / HUD passes
│   │   ├── world          #   lightmapped static world (format-agnostic upload)
│   │   ├── model, anim    #   glTF assets, skins, clips, joint palettes
│   │   ├── collide        #   TraceWorld trait + Quake-style character controller
│   │   ├── camera, input, time, hud, scene, texture
│   │   └── app            #   winit loop (fixed-step sim, mouse capture)
│   └── pocket3d-bsp/      # GoldSrc BSP v30 + WAD3: geometry, lightmaps,
│                          # entities, clipnode hull tracing (no GPU deps)
└── examples/
    └── openstrike/        # the CS-like FPS example game
```

Dependency shape: `pocket3d-bsp` knows nothing about rendering;
`pocket3d` integrates it behind the (default) `bsp` feature
(`WorldModel::from_bsp`, `TraceWorld for MapCollision`). Games depend on
`pocket3d` and stay renderer-agnostic — a `Scene` is plain data.

## OpenStrike

<p align="center"><em>de_dust2, lightmaps, procedural rifle, animated bots,
round HUD — all rendered by Pocket3D.</em></p>

### Getting map data

Maps and textures are **not** in this repo (they are Valve-copyrighted game
data). Point OpenStrike at a directory that contains them:

```
<maps-root>/
├── maps/de_dust2.bsp  (and friends)
└── support/*.wad      (cs_dust.wad, halflife.wad, ...)
```

Any GoldSrc-era (BSP v30) map works; the eight classic CS maps are the
tested set.

### Play

```sh
cd pocket3d
cargo run --release -p openstrike -- --maps-dir ~/path/to/cs-maps
```

| Input | Action |
| --- | --- |
| Mouse | look |
| WASD | move (Shift = walk) |
| Space | jump |
| Left mouse | fire |
| R | reload |
| Esc | release/capture mouse |
| F3 | debug overlay |
| V | noclip fly (debug) |

Options: `--map de_inferno`, `--bots 5`, `--spawn-t`, `--size 1920x1080`,
`--auto-quit 5` (smoke test). `OPENSTRIKE_MAPS` can replace `--maps-dir`.

Round rules (v0.1): eliminate every bot to win; die and you lose. Either
way the round resets automatically and the score carries over.

### Headless verification

Everything above is also runnable without a window — the renderer draws
into an offscreen target and the game is driven by scripted input. This is
how the milestones were verified during development and how CI can keep
them honest:

```sh
# one-frame map viewer
cargo run -p openstrike -- --maps-dir $MAPS --screenshot shot.png --pos 100,50,-200 --yaw 90

# acceptance scripts (exit non-zero on failure, drop labeled screenshots)
cargo run -p openstrike -- --maps-dir $MAPS --script walk   --screenshot out/walk
cargo run -p openstrike -- --maps-dir $MAPS --script model  --screenshot out/model
cargo run -p openstrike -- --maps-dir $MAPS --script combat --screenshot out/combat
cargo run -p openstrike -- --maps-dir $MAPS --script round  --screenshot out/round
cargo run -p openstrike -- --maps-dir $MAPS --script lose   --screenshot out/lose
```

- `walk` — spawn, settle, run 250 u/s, slide along walls without ever
  entering solid, jump exactly ~45 units.
- `model` — skinned bot renders and its walk clip actually animates
  (pixel-diff between two clip times).
- `combat` — aim, fire, tracers/flash, bot takes 3 body shots and dies.
- `round` — observe bots patrol/chase (they move & animate on their own),
  engage, eliminate all, **win**, and verify the automatic next round.
- `lose` — stand still until the bots win, verify the loss + restart.

Unit/integration tests (`cargo test`) cover BSP parsing, entity parsing and
hull tracing; the real-map suite runs when `POCKET3D_TEST_MAPS` points at a
maps root.

## The runtime, briefly

- **Rendering** — single forward pass per frame into any `TextureView`:
  world batches (albedo × lightmap × 2, alpha-test variant, gradient sky
  from sky-brush rays), then skinned/static models (dynamic-offset instance
  + joint-palette buffers), additive sprites/beams, a depth-cleared
  viewmodel pass, and a bitmap-font HUD. sRGB-correct, CPU mipgen,
  anisotropic filtering.
- **BSP as data** — `pocket3d-bsp` parses v30 lumps + WAD3 into plain
  structs: batched geometry with a packed lightmap atlas, entities as
  key/value maps, and the original clipnode hulls. Everything is converted
  to Y-up at parse time (the transform is a proper rotation, so plane
  equations and texture projections survive unchanged).
- **Collision** — a faithful port of the recursive clipnode trace
  (`SV_RecursiveHullCheck`), then a GoldSrc-flavored controller on top:
  friction/accelerate, air control with the 30 u/s cap, 4-plane slide
  moves, 18-unit stair stepping, gravity 800. The map's own collision data
  does the work — no mesh colliders, no physics engine.
- **Animation** — glTF clips sampled onto a node hierarchy, joint palettes
  skinned on the GPU. Assets load from `.glb` or are built procedurally
  (the rifle is ~10 boxes).
- **Determinism** — fixed 64 Hz simulation, an explicit xorshift RNG, and
  injectable input make headless runs reproducible.

## Extension points

- New world format → produce a `WorldSource` (+ implement `TraceWorld`).
- New game → implement the 4-method `Game` trait; compose a `Scene`.
- More passes (decals, particles-with-physics, shadow maps) slot into
  `Renderer::render` alongside the existing ones.

## Non-goals for v0.1 (a.k.a. the roadmap)

PVS culling, audio, crouch/ladders/water movement, GoldSrc MDL models,
Source BSP, networking, and faithful CS gunfeel are all explicitly out of
scope for this first cut. The point was to prove the pipeline end to end:
**BSP in, playable round loop out.**

## Asset credits

- `examples/openstrike/assets/models/CesiumMan.glb` — “Cesium Man” from the
  Khronos glTF sample assets, © Analytical Graphics Inc. /
  [Cesium](https://cesium.com), licensed
  [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Map/texture data (`.bsp`/`.wad`) is © Valve and must be provided by the
  user from their own copy of the game.
