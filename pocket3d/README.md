# Pocket3D

A small, modern, extensible 3D runtime in Rust — the native desktop base of
the Pocket runtime family (see [RUNTIMES.md](../RUNTIMES.md)). Built on
**wgpu** (Metal/Vulkan/DX12) + **winit**, with GoldSrc **BSP maps as a
first-class world format**.

Pocket3D is deliberately not a general-purpose engine. It is a lean substrate
you can read in an afternoon: a forward renderer, a first-person character
controller driven by collision traces, skeletal animation, and a headless
verification story that makes every feature screenshot- and script-testable
without opening a window. Specialized runtimes compose it with the guest
infrastructure below; the first one is
**[OpenStrike](https://github.com/pocket-stack/open-strike)**, a CS-like FPS
whose gameplay rules are QuickJS mods and whose HUD is a PocketJS app.

![status](https://img.shields.io/badge/status-v0.1_experiment-orange)

## Layout

```
pocket3d/
├── crates/
│   ├── pocket3d/          # the 3D substrate
│   │   ├── gpu            #   device bootstrap, offscreen targets + PNG readback
│   │   ├── renderer       #   forward renderer: world / models / sprites / viewmodel / HUD passes
│   │   ├── world          #   lightmapped static world (format-agnostic upload)
│   │   ├── model, anim    #   glTF assets, multi-skin characters, clips, joint palettes
│   │   ├── collide        #   TraceWorld trait + Quake-style character controller
│   │   ├── camera, input, time, hud, scene, texture
│   │   └── app            #   winit loop (fixed-step sim, mouse capture, overlay hook)
│   ├── pocket3d-bsp/      # GoldSrc BSP v30 + WAD3: geometry, lightmaps,
│   │                      # entities, clipnode hull tracing (no GPU deps)
│   ├── pocket-mod/        # guest hosting: one QuickJS realm, mounted surfaces,
│   │                      # one guest turn per tick (the mod-runtime mechanism)
│   ├── pocket-ui-wgpu/    # the PocketJS `ui` surface on this base: pak feeding,
│   │                      # HostOps for the guest, DrawList → wgpu, Blit compositor
│   └── pocket-widget/     # desktop widgets as a capability: demand-render shell,
│                          # embedded `ui` surfaces on meshes, part picking (WIDGET.md)
└── examples/
    ├── uihost/            # PocketJS UI demos in a native macOS window
    └── handheld/          # a borderless 3D PSP that runs Pocket apps (pocket-widget)
```

Dependency shape: `pocket3d-bsp` knows nothing about rendering; `pocket3d`
integrates it behind the (default) `bsp` feature (`WorldModel::from_bsp`,
`TraceWorld for MapCollision`). Games depend on `pocket3d` and stay
renderer-agnostic — a `Scene` is plain data. `pocket-mod` and
`pocket-ui-wgpu` are the shared mechanism every specialized runtime reuses
(RUNTIMES.md); neither knows anything about FPS games.

## uihost — the PSP UI runtime on the desktop

The same app bundle + pak that boots on PSP hardware runs in a native window:
QuickJS guest (`pocket-mod`), the same `pocketjs-core`, rendered through wgpu
(`pocket-ui-wgpu`) with a chunky nearest-neighbor integer upscale.

```sh
# from the repo root: build a demo, then host it
bun scripts/build.ts hero-main
cd pocket3d
cargo run -p uihost -- --app hero-main                # window, 2x scale
cargo run -p uihost -- --app hero-main --screenshot out.png --frames 10
```

Arrows = D-pad, Z/Enter = CROSS, X = CIRCLE, A/S = SQUARE/TRIANGLE,
Q/W = triggers, Tab = SELECT, Space = START, Esc quits.

## handheld — a 3D PSP on your desk

The first pocket-widget runtime (WIDGET.md): a transparent, undecorated,
always-on-top window framing a procedurally built PSP. Its screen is a live
`ui` surface (an `OffscreenTarget` bound onto the screen mesh), its buttons
are pickable parts that feed real BTN bits — the same unmodified bundle
uihost runs, inside a handheld you can click.

```sh
bun run widget                   # from the repo root: build bundle + binary, launch
bun run widget im                # any demo
bun run widget --proof           # headless acceptance (scripted taps → Count: 2)
```

Or by hand:

```sh
bun scripts/build.ts hero-main   # from the repo root
cd pocket3d
cargo run -p handheld -- --app hero-main
cargo run -p handheld -- --app hero-main --screenshot out.png --frames 30
```

Click caps to press them, drag the nub, double-click the screen to zoom
into a screen-filling focus framing (`--focus` starts there), drag the body
to move the window. The uihost key map works throughout. Headless scripting:
`--click x,y` presses that window pixel mid-run, `--tap circle@30` holds a
button for six ticks, `--hold circle` holds it for the whole run. The guest
ticks at a fixed 60 Hz; GPU frames render only when something changed
(watch the `pocket-widget: … frames rendered` line on exit).

## The substrate, briefly

- **Rendering** — single forward pass per frame into any `TextureView`:
  world batches (albedo × lightmap × 2, alpha-test variant, gradient sky
  from sky-brush rays), then skinned/static models (dynamic-offset instance
  + joint-palette buffers), additive sprites/beams, a depth-cleared
  viewmodel pass, and a bitmap-font debug HUD. A `Game::overlay` hook admits
  composite passes (this is where OpenStrike's JSX HUD draws). sRGB-correct,
  CPU mipgen, anisotropic filtering.
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
  skinned on the GPU. Multi-skin characters concatenate into one palette;
  skinned bounds are measured in rest pose, so cm-scale or Z-up rigs
  (Mixamo exports) size correctly. Assets load from `.glb` or are built
  procedurally.
- **Determinism** — fixed-step simulation, an explicit xorshift RNG, and
  injectable input make headless runs reproducible.

## Extension points

- New world format → produce a `WorldSource` (+ implement `TraceWorld`).
- New game → implement the `Game` trait; compose a `Scene`; mount surfaces
  with `pocket-mod` (see RUNTIMES.md for the discipline).
- More passes (decals, particles-with-physics, shadow maps) slot into
  `Renderer::render` alongside the existing ones, or hang off
  `Game::overlay`.

## Non-goals for v0.1 (a.k.a. the roadmap)

PVS culling, audio, crouch/ladders/water movement, GoldSrc MDL models,
Source BSP, and networking are all explicitly out of scope for this first
cut. The point was to prove the pipeline end to end: **BSP in, playable
round loop out** — which OpenStrike does, in its own repo, through the mod
runtime.
