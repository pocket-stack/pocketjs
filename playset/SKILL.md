---
name: playset
description: Use when building 3D mini-games for Pocket with playset modules — coordinate systems, actor motion, camera rigs, collision-aware movement, gameplay state, world building — or when porting a Three.js/GameBlocks-style browser game to Pocket.
---

# Playset

Use playset as source material before inventing 3D game systems from scratch,
and as the target vocabulary when porting Three.js mini-games to Pocket.

## Workflow

- Use `modules/math/world-basis.ts` as the single source of truth for
  gameplay-space coordinates, forward/right/up axes, planar movement,
  heading, and control-signal transforms.
- Review `summary.md` and select modules that can support the game
  implementation. Prioritize existing modules whenever possible, especially
  for motion controllers, camera rigs, and the collision world.
- Copy the `playset/` tree (`math/`, `scene3d/`, `modules/`, `loop.ts`) into
  the game project, preserving relative directory structure so imports keep
  working. Reuse modules as-is when they satisfy the design; adapt from the
  existing implementation instead of rewriting when they don't.
- Structure the game as a deterministic fixed-step machine:
  `createGameLoop({ step, render })` from `loop.ts` — ALL simulation in
  `step` (1/60 s, hz-invariant), ALL scene writes in `render`, ending with
  `scene.flush()`. Never read the wall clock; never call `Math.random`
  (inject `RandomGenerator` seeds); express delays with the injected `Clock`
  or `after()` from `@pocketjs/framework/clock`.
- Presentation goes through one `Scene3D` bound to a `<Viewport3D>`; the HUD
  is ordinary PocketJS UI composed as children of the viewport. Picking and
  collision are guest-side: `modules/physics/collision-world.ts`, never a
  scene query.
- Create `playset_usage.md` documenting the selected modules, their purpose,
  reuse/adaptation status, key changes, and game integration.

## Porting a Three.js game

1. Locate the sim: state + `step(state, input)` logic ports nearly verbatim
   (swap `three` math imports for `math/index.ts`). If state lives on the
   scene graph (`mesh.position` as the source of truth), extract it into
   plain state first — the ops boundary requires it anyway.
2. Map presentation with the table below. Visual factories become
   `Scene3D`-based builders returning `SceneNode` trees (see
   `modules/world/object/factory/` for the idiom).
3. Replace `Raycaster` picking with `CollisionWorld.raycast` +
   `Camera3D.rayFromNdc`; replace physics with `KinematicBatchResolver` /
   the arcade car resolver; register environment colliders in the
   `CollisionWorld`.
4. Make the original deterministic FIRST (seeded PRNG, fixed step) — a small
   diff — then record input-tape goldens on both sides and compare state
   traces (host-sim on the Pocket side).
5. **Say what never moves.** Call `scene.freeze(root)` on scenery once it is
   built. That is the whole performance contract for a port — see below.

## Performance you get for free (and the one line that buys it)

A port should not need hand tuning per game. Two mechanisms do the work, and
both are driven by declarations rather than by optimizing a particular scene:

- `scene.freeze(root)` — a promise that these transforms never change again.
  The host merges frozen nodes that share geometry, material and tint into one
  draw per spatial cell. MEASURED on a real PSP: rally's fence is ~270 posts
  plus ~270 rails, and with frustum culling in place the frame is GE-bound, so
  the submitted draw count swings 6-7x with camera direction (72 parked,
  380-470 looking down the circuit) — which a player feels as a stutter on
  parts of the track. **The ported environment factories already freeze their
  own scenery**, so a game composed from `NaturalEnvironment` /
  `RaceTrackEnvironment` inherits this without writing anything.
- `scene.markStatic(root?)` — strictly weaker, and about the GUEST only: it
  stops the per-frame pose differ from walking nodes the guest no longer
  writes. A car driven by the native sim is `markStatic` but must NEVER be
  `freeze`d, or it bakes in place.

If you build scenery yourself instead of via the ported environments, freeze it
at the end of your builder — the same place the environments do it — rather
than leaving it to the game. Scenery knows it is scenery.

Two more things that are engine-side and automatic, listed so you do not
re-derive them: large meshes are split for culling (`createTerrainMesh`'s
`tiles`), and the native sim writes visual poses straight into the store, so
a bound car costs no per-frame JS at all.

## Three.js → playset mapping

| Three.js | playset |
|---|---|
| `Scene`, `Group`, `Object3D` | `Scene3D`, `scene.node()` (SceneNode) |
| `Mesh(geometry, material)` + `add` | `scene.mesh(geomId, matId, parent)` |
| `BoxGeometry(w,h,d)` | `scene.box(w/2, h/2, d/2)` — HALF extents |
| `Sphere/Cylinder/Cone/Plane/TorusGeometry` | `scene.sphere/cylinder/cone/plane/torus` |
| `BufferGeometry` (indexed) | `scene.meshGeom(positions, indices, colors)` |
| terrain grid mesh | `scene.heightfield(w, d, cols, rows, heights, colors)` |
| `MeshStandardMaterial{color}` | `scene.material(abgr, 0)` (vertex-lit; PBR params drop) |
| `MeshBasicMaterial` | `MAT.unlit` |
| `vertexColors: true` | `MAT.vertexColors` |
| `transparent`/`AdditiveBlending`/`DoubleSide` | `MAT.transparent` / `MAT.additive` / `MAT.doubleSided` |
| `DirectionalLight` + `HemisphereLight` | `scene.sun(dir, color)` + `scene.ambient(sky, ground)` |
| `Fog(color, near, far)` | `scene.fog(color, near, far)` |
| shadow maps (`castShadow` etc.) | `modules/world/blob-shadow.ts` decals |
| `Points`/particles | `scene.spritePool(capacity, mat)` + per-frame writes |
| `LineSegments` tracers / trails | `scene.beamPool(capacity, mat)` |
| `Sprite` billboards | camera-quaternion-billboarded node groups |
| `ShaderMaterial` | layered additive nodes (see `jet-flame.ts` for the pattern) |
| `Raycaster` | `CollisionWorld.raycast` + `Camera3D.rayFromNdc` |
| Rapier world / character controller | `CollisionWorld` + `KinematicBatchResolver` |
| Rapier raycast vehicle | `DynamicCarBatchResolver` (arcade approximation) |
| DOM / Canvas2D HUD | PocketJS `View`/`Text` components (`modules/user-interface/`) |
| `requestAnimationFrame` + dt clamp | `createGameLoop` (fixed 1/60, hz-invariant) |
| `Math.random()` / `Date.now()` | injected `RandomGenerator` / `Clock` (virtual time) |

Colors are u32 ABGR on the surface; module files carry an `rgbToAbgr` helper
for 0xRRGGBB literals.
