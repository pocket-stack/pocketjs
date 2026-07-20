# @pocketjs/playset

*Game-mechanism playsets for Pocket: the GameBlocks module taxonomy, ported to
TypeScript and extended, running on the `scene3d` surface.*

A playset is not an engine and not an npm dependency — it is a library of
copy-in game mechanisms (motion controllers, camera rigs, AI behaviors,
gameplay referees, world builders, HUD components) that a game project vendors
and adapts. The taxonomy and most module semantics come from
[GameBlocks](https://github.com/xt4d/GameBlocks) (74 ported modules); playset
adds what a renderer-free, deterministic port needs: a collision core, blob
shadows, and ABGR color plumbing. See `ATTRIBUTION.md`.

## Three layers

1. **`scene3d/`** — the presentation surface (RUNTIMES.md §3): a closed,
   write-only 3D vocabulary sized for fixed-function GPUs. Ops contract
   (`ops.ts`), guest client (`Scene3D`, `SceneNode`, `Camera3D`, sprite/beam
   pools), `<Viewport3D>`, and a renderless sim host (`sim.ts`) that replays
   op streams headlessly. No reads: picking and collision are the guest's job.
2. **`modules/`** — the vendored module library, organized by GameBlocks'
   categories (actor motion, behavior, camera, gameplay, math, physics,
   user interface, world). `math/` supplies three-compatible value types
   (`Vector3`, `Quaternion`, ...) so sim code ports as an import swap;
   `loop.ts` supplies the fixed-step driver.
3. **`SKILL.md`** — the porting skill: the copy-into-project workflow, the
   determinism rules, and the Three.js → playset mapping table for bringing
   browser mini-games to Pocket.

Where GameBlocks depends on Three.js and Rapier from a CDN, playset modules
have **no runtime dependencies**: Three.js math → `math/`, scene graph →
`scene3d/`, Rapier → `modules/physics/collision-world.ts`. HUD modules build
on `@pocketjs/framework/*` + `solid-js` like any Pocket UI.

## Determinism

- **Fixed-step loop** — `createGameLoop` steps the sim at exactly 1/60 s,
  `60/hz` times per virtual frame, so the trajectory is identical at every
  `simulationHz` and input tapes replay byte-exact.
- **Seeded PRNG** — `RandomGenerator` is bit-identical to GameBlocks'
  Mulberry32: seeded alike, both engines draw the same stream, which makes
  cross-engine golden traces possible.
- **Virtual clock** — the wall clock is never an input; `Clock` reads
  `virtualNow` by default (DETERMINISM.md).
- **Host-sim goldens** — the scene3d sim host serializes canonical,
  platform-stable state, so a frame's pixels are a pure function of the op
  stream and suites in `test/` pin behavior without a GPU.

## Status

- TypeScript reference implementation, complete with the renderless scene3d
  sim host and the test suites under `test/`.
- Native cores (wgpu desktop, sceGu PSP) are next — guest program first,
  cores follow (RUNTIMES.md). CollisionWorld is deliberately v1 (planar
  resolution, static shapes); the native Rust physics block is the upgrade
  path.

## See also

- `SKILL.md` — workflow + Three.js → playset mapping.
- `summary.md` — the full module catalog with per-module deviation notes.
- `ATTRIBUTION.md` — GameBlocks provenance and license.
