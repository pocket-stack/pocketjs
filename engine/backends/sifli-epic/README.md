# PocketJS SiFli render backend

This `no_std` crate renders PocketJS DrawLists into a persistent RGB565 target
through a hardware executor. It is the Rust half of the SiFli SF32LB5x host;
the executor that actually programs EPIC and VG Lite lives in `hosts/sifli`.

## Structure

- `plan` decodes the DrawList once per frame with
  `pocketjs_core::drawlist`, recovers the rectangles and quads the core
  flattened into triangles, and groups consecutive alpha-only texture quads
  into one A8 run.
- `emit` walks that plan once per damage region, clips every item to the
  region, checks the executor's `Capabilities` and thresholds, and either
  submits a `Cmd` or appends the operation to a CPU batch. Consecutive CPU
  operations share one `pocketjs_core::raster` dispatch; a fence separates
  hardware writes from CPU writes so painter order holds on both sides.
- `cmd` is the command set: `Fill`, `FillAlpha`, `BlendA8`, `Gradient`,
  `Blit`, `BlitQuad`, `TileOut`, `TileIn`, `Fence`. Every rectangle is in
  physical target pixels; textures are referenced as portable core bytes,
  executor-registered native copies, or solid colors.
- `submit` is the executor contract: `Submit::begin` binds a target for one
  frame, `Frame::submit` runs commands in order, `Frame::fence` completes
  them, `Frame::mask_mut` and `Frame::tile_mut` expose executor-owned A8
  planes and RGB565 tiles, and `Frame::target_mut` allows direct CPU writes
  where the executor permits them. When it does not (a GPU-only
  framebuffer), CPU batches round-trip through tiles: `TileOut`, a fence,
  the core rasterizer into the tile, `TileIn`. A8 runs larger than a plane
  are split into bands, and a plane is only rewritten after a fence
  retired the blend that read it.
- `caps` describes what an executor can run. The planner never builds a
  command the capabilities forbid, so executors do not decline work; on the
  SiFli host the values come from the chip's SDK feature gates.
- `mock` (feature `mock`, always on for tests) is a recording software
  executor that runs every command with the core's exact pixel formulas;
  `DeferredMockGpu` keeps commands in flight until a fence and panics when
  the renderer touches a plane, tile, or the target too early.

## Routing

| DrawList operation | Hardware path | CPU path |
| --- | --- | --- |
| RECT, opaque | `Fill` | below `min_fill` |
| RECT, translucent | `FillAlpha`, else an A8 plane filled with the alpha | below `min_blend` |
| GRAD_RECT | `Gradient` for unclipped opaque two-stop gradients | clipped, translucent, or below `min_gradient` |
| GLYPH_RUN | atlas coverage composited into an A8 plane, one `BlendA8` per run | below `min_blend` |
| TEX_QUAD, coverage-only texture | consecutive quads composited into one A8 plane | below `min_blend` |
| TEX_QUAD, PSM_5650 opaque | `Blit` copy at 1:1 or hardware scaling when the texture is linear | fractional texel edges |
| TEX_QUAD, other formats | `Blit` with scaling, mirroring, and modulation | format or capability missing |
| TEX_TRI pair | `Blit` when the quad is upright, else `BlitQuad` | unmatched pairs, missing capability |
| TRI pair, flat color | `Fill`/`FillAlpha` when upright, else a solid `BlitQuad` | unmatched pairs, Gouraud colors |
| SCISSOR, TEXT_RUN, SURFACE_QUAD | skipped | skipped |

Coverage-only textures are classified by the core at upload
(`Ui::texture_coverage_only`); baked rounded-corner discs qualify by
construction.

## Damage tracking

Keep one `RenderTargetState` for every persistent framebuffer. This is
required for RAM-less multi-buffered displays because alternating targets
contain different older frames. Inserted, removed, or type-changed operations
are resynchronized at exact nearby anchors and only the unmatched bounds are
repainted; damage covering at least 75 percent of the viewport is promoted to
a full redraw. `render_strip` renders one dirty rectangle into a compact
full-width strip for hosts that present through their own pipeline.

## Test

```bash
cargo test --locked --manifest-path engine/backends/sifli-epic/Cargo.toml \
  --features std
```

The tests compare the hybrid output against the core RGB565 software
rasterizer for every routing decision, including incremental damage, A8
batching, texture blits, quad reconstruction, and CPU fallback ordering.
