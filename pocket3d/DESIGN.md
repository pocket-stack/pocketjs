# Pocket3D / OpenStrike Design Document

Author: Pocket Architecture  
Status: Draft v0.1  
Date: 2026-07-05  
Scope: First playable single-player FPS prototype using Dust2-like BSP content

## 1. Executive Summary

Pocket3D is a new Rust-first 3D runtime under the Pocket repository. It is not a rewrite of the existing PocketJS 2D UI core and must not depend on the PSP-oriented 2D runtime. It should live as a separate runtime layer with its own rendering, asset, simulation, input, physics, and application interfaces.

OpenStrike is the first application built on Pocket3D. Its purpose is to validate that Pocket3D can run a small, complete, CS-like first-person shooter loop on a BSP map. The first target is not a multiplayer Counter-Strike clone. The first target is a single-player vertical slice:

The player loads into Dust2, walks around in first person, holds one weapon, finds a simple animated bot, shoots it, kills it, wins the round, waits a few seconds, and starts the next round.

The design should favor narrow, reliable systems over general game-engine abstraction. BSP is a first-class asset path, not an afterthought. Other scene formats can be added later, but the first version should be optimized around BSP world geometry, BSP collision, BSP entities, and BSP-derived runtime data.

The overall architectural posture should follow the successful PocketJS pattern: high-level authoring and scripting can exist above the runtime, but frame-critical systems live in Rust behind narrow contracts. PocketJS already uses a small native mutation surface, a Rust core, build-time asset preparation, deterministic fixed-time animation, and thin backend boundaries; Pocket3D should copy that architectural discipline, not the existing PSP/UI implementation itself.

## 2. Product Positioning

Pocket3D is a lightweight Rust 3D runtime for constrained, code-driven games and demos.

OpenStrike is an example application and stress test for Pocket3D.

Pocket3D should not try to compete with Godot, Unity, Unreal, or Bevy as a full editor-driven game engine. Its initial value is narrower:

It should load world-first 3D assets, render them through `wgpu`, run a deterministic fixed-tick simulation, expose a small application/runtime contract, and allow Rust applications or QuickJS/TypeScript extensions to define gameplay logic.

OpenStrike should not be positioned as “open-source Counter-Strike.” It should be positioned as a BSP-based FPS example that proves Pocket3D can support a complete shooter loop.

## 3. Goals

The first version must satisfy these goals.

Pocket3D must provide a standalone Rust 3D runtime inside the Pocket repository. It must not depend on the existing PocketJS PSP UI core, layout system, draw list, or renderer.

Pocket3D must use `wgpu` as the first render backend. `wgpu` is a safe, portable Rust graphics API that can target Vulkan, Metal, D3D12, OpenGL/GLES, WebGPU, and WebGL2 depending on platform support.

Pocket3D must support BSP as a first-class world format. For v0, this means GoldSrc-style BSP first, because CS 1.6 / Dust2-style assets are the motivating content type. The Rust `qbsp` crate is the preferred starting point because it already supports Quake/GoldSrc BSP formats, structured BSP access, raycasting, mesh generation, lightmap atlas generation, `.lit`, and BSPX.

OpenStrike must load a Dust2 BSP map, or a legally safe Dust2-like substitute during repository distribution. The engine may support user-supplied local CS assets during development, but the public repository must not ship Valve/Counter-Strike assets unless rights are explicitly cleared.

OpenStrike must support a single-player round loop: spawn player, spawn bot, allow player movement, allow bot movement, allow shooting, register hits and deaths, decide win/loss, then restart after a short intermission.

OpenStrike must include at least one animated humanoid bot using an industry-standard asset format. The preferred model path is glTF/GLB, because glTF is a royalty-free runtime delivery format designed for efficient transmission and loading of 3D scenes and models, and Rust has a maintained `gltf` loader crate.

OpenStrike must use a lightweight KCC path. It must not couple to Godot, Bevy, or another full game engine. Rapier’s raw Rust Kinematic Character Controller is the preferred initial dependency candidate because it exposes a generic move-and-slide controller based on ray casts and shape casts, with support for slopes, autostep, obstacles, and moving platforms.

QuickJS + TypeScript should be supported as an extension boundary, not as the simulation core. Scripts may define weapon data, round rules, bot behavior parameters, HUD state, and debug commands. Rust owns frame-critical movement, physics queries, rendering, asset loading, animation evaluation, and hit detection.

## 4. Non-Goals

The first version does not need multiplayer.

The first version does not need Counter-Strike-accurate movement, recoil, networking, economy, buy zones, bomb planting, hostages, prediction, rollback, lag compensation, demo playback, workshop support, or anti-cheat.

The first version does not need a full editor.

The first version does not need general scene import from Unity, Unreal, Godot, Blender scenes, USD, FBX, or Source 2.

The first version does not need PBR correctness. BSP world rendering can use base texture multiplied by lightmap, with simple forward rendering for models.

The first version does not need to run on PSP. Pocket3D should be designed with portability in mind, but the first target should be desktop development through `wgpu`.

The first version does not need to share runtime code with PocketJS 2D. Reuse is allowed only where it is genuinely clean, such as repository tooling patterns, spec/codegen style, QuickJS embedding lessons, or asset-packing philosophy.

## 5. Repository Layout

Pocket3D should live under a separate directory inside the Pocket repository.

```text
pocket/
  pocket3d/
    README.md
    DESIGN.md
    Cargo.toml
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
      pocket3d-tools/
    examples/
      openstrike/
        Cargo.toml
        src/
        assets/
        scripts/
        maps/
        config/
```

`pocket3d-core` contains platform-neutral runtime types: math conventions, transforms, entity IDs, time, input snapshots, world storage, cameras, schedules, and events.

`pocket3d-app` defines the application lifecycle contract.

`pocket3d-render` defines renderer-facing data structures, render graph concepts, material handles, mesh handles, camera views, draw packets, and debug draw APIs.

`pocket3d-render-wgpu` implements the first renderer backend.

`pocket3d-assets` defines asset IDs, asset database, pack format, import cache, and runtime loading.

`pocket3d-bsp` handles BSP ingestion, compiled BSP world output, WAD texture lookup, entity lump parsing, lightmap handling, collision extraction, and optional visibility data.

`pocket3d-physics` wraps engine-independent physics queries and static/dynamic collider storage.

`pocket3d-kcc` defines the KCC abstraction and contains the initial Rapier-backed implementation.

`pocket3d-anim` handles skeletons, clips, skinning, pose evaluation, animation state machines, and GPU joint buffer preparation.

`pocket3d-audio` can be minimal in v0, but it should have a defined home for gunshots, footsteps, impact sounds, and round cues.

`pocket3d-script` embeds QuickJS and exposes a narrow event/config API.

`pocket3d-tools` provides CLI commands for asset building, BSP inspection, pack generation, map debugging, and scripted test launching.

`examples/openstrike` is the first game. It is allowed to use every Pocket3D crate, but Pocket3D crates must not depend on OpenStrike.

## 6. Runtime Model

Pocket3D uses a fixed simulation tick and variable render interpolation.

The default simulation tick is 60 Hz. Rendering can run at the display refresh rate. The runtime must accumulate real time, run zero or more fixed updates, then render using an interpolation alpha.

```rust
pub trait Pocket3dApp {
    fn init(&mut self, ctx: &mut AppInitContext) -> anyhow::Result<()>;
    fn fixed_update(&mut self, ctx: &mut FixedUpdateContext);
    fn update(&mut self, ctx: &mut FrameUpdateContext);
    fn render(&mut self, ctx: &mut RenderContext);
}
```

The engine should distinguish between simulation state and render state. Simulation state is authoritative. Render state is derived.

For OpenStrike v0, the authoritative simulation includes player transform, player velocity, player health, bot transforms, bot health, weapon cooldowns, hit events, round state, and simple AI state.

The renderer must not own gameplay state. It consumes a scene view built from runtime handles and transforms.

## 7. World and Entity Model

Do not adopt a large ECS dependency in v0.

The first implementation should use simple typed storage with stable entity IDs. `slotmap` or a small custom generational arena is enough. The engine should avoid Bevy ECS in v0 because the stated goal is to avoid coupling to an existing game engine. Avian, for example, is explicitly designed as an ECS-driven physics engine for Bevy and is therefore not aligned with this v0 independence requirement, even though it is a capable Rust physics project.

Recommended model:

```text
World
  EntityArena
  TransformStore
  MeshRendererStore
  SkinnedMeshStore
  KccStore
  ColliderStore
  CameraStore
  AudioEmitterStore
  ScriptBindingStore
```

OpenStrike can add game-specific stores:

```text
OpenStrikeWorld
  PlayerStore
  BotStore
  WeaponStore
  HealthStore
  TeamStore
  RoundStore
```

The core should not pretend to be fully data-driven too early. The first target is a playable shooter loop, not an editor.

## 8. Coordinate System

Pocket3D should use a Z-up world coordinate system for the first BSP path.

Reason: GoldSrc / Hammer-style BSP content is naturally Z-up. Preserving Z-up internally reduces import confusion, collision bugs, and map entity conversion errors.

Recommended convention:

```text
+X = right/east
+Y = forward/north
+Z = up
1 world unit = 1 BSP map unit
```

The renderer is responsible for mapping Pocket3D camera matrices into `wgpu` clip-space conventions. Simulation, physics, BSP entities, and debug tools should remain in Pocket3D world coordinates.

## 9. Asset Pipeline

Pocket3D should support two modes:

Development mode loads source assets directly when convenient.

Packed mode uses compiled Pocket3D assets.

The public runtime path should be:

```text
source assets
  -> p3d asset build
  -> compiled cache
  -> .p3dpak
  -> runtime asset database
```

Initial source asset types:

```text
.bsp     GoldSrc BSP map
.wad     GoldSrc texture archive
.glb     weapon, bot, props
.gltf    optional, for development
.png     debug textures, sprites, HUD assets
.wav     gunshot, footstep, impact sounds
.toml    OpenStrike config
.ts      optional gameplay/script data
```

Initial compiled asset types:

```text
.p3dworld   compiled BSP world
.p3dmesh    static mesh
.p3dskin    skinned mesh
.p3danim    animation clips
.p3dmat     material metadata
.p3dtex     texture payload
.p3dscene   optional future generic scene
.p3dpak     packed archive
```

For v0, `.p3dpak` can be simple: header, table of contents, content blobs, checksums, version numbers. Compression is optional. Hash-based cache invalidation is more important than compression.

## 10. BSP as a First-Class Format

The BSP path must not be implemented as “convert BSP to generic mesh and forget everything else.”

The BSP importer should produce a compiled world asset with several independent layers:

```text
BspWorldAsset
  WorldRenderGeometry
  WorldMaterials
  LightmapAtlases
  StaticCollision
  TriggerVolumes
  EntityRecords
  SpawnPoints
  VisibilityData
  DebugMetadata
```

The importer should preserve raw entity key-value data even when OpenStrike only understands a subset. Unknown entities should be retained and visible in inspection tools.

Initial BSP requirements:

- Load BSP geometry.
- Resolve WAD textures.
- Generate renderable world mesh.
- Generate lightmap atlas or import precomputed lightmaps.
- Create static collision from world geometry.
- Parse entity lump into raw records.
- Recognize player spawn points.
- Recognize simple trigger volumes if available.
- Expose map bounds and debug metadata.

Optional early features:

- PVS visibility.
- Water/translucent materials.
- Sky material.
- Clip brushes.
- Brush entities.
- Decals.

The GoldSrc BSP documentation notes that BSP content includes lightmap data, and related BSP formats store map data in lumps such as entities and world geometry. `qbsp` should be used first, with missing pieces filled by `pocket3d-bsp` as necessary.

## 11. Dust2 Development Policy

OpenStrike’s first vertical slice may use local user-supplied `de_dust2.bsp` during development.

The public repository must not include proprietary Valve/Counter-Strike assets by default. The repository should include either:

- A small open test BSP made specifically for Pocket3D, or
- A script that asks the developer to point to a local game installation, or
- A Dust2-like test map created from scratch with permissive licensing.

OpenStrike should treat Dust2 as a compatibility target, not as redistributable project content.

Asset-source policy for bots, weapons, and placeholder art:

- Prefer CC0 or project-owned assets for repository content.
- Kenney and Quaternius are good sources for prototype-friendly permissive assets.
- Mixamo can be useful for humanoid animation experiments, but any committed assets must be checked carefully before redistribution.

## 12. Renderer Design

The first renderer backend is `pocket3d-render-wgpu`.

It should be forward-rendered and intentionally simple. The goal is stable FPS gameplay, not cinematic rendering.

Initial render passes:

```text
1. World opaque pass
2. Skinned actor pass
3. Alpha-tested / translucent pass
4. Viewmodel weapon pass
5. Debug draw pass
6. UI / HUD overlay pass
```

World opaque pass:

- BSP world mesh.
- Batch by texture and lightmap.
- Shader: `final_rgb = base_texture * lightmap * exposure`.
- No dynamic shadows in v0.
- No PBR in v0.

Skinned actor pass:

- Bot character mesh.
- Simple directional/ambient lighting.
- Skinned vertex shader using joint matrices.
- Animation-driven pose buffer updated per frame.

Alpha/translucent pass:

- Water and glass can be crude in v0.
- Correct sorting can be approximate.

Viewmodel pass:

- Weapon drawn after world.
- Use separate FOV.
- Clear or override depth as needed to avoid clipping.

Debug draw pass:

- Collision shapes.
- Bot paths.
- Waypoint graph.
- Raycasts.
- Hitboxes.
- Spawn points.
- Trigger volumes.

Material model:

```rust
enum MaterialKind {
    BspWorldLit,
    BspSky,
    BspWater,
    StaticUnlit,
    StaticLit,
    SkinnedLit,
    Viewmodel,
    Debug,
}
```

The renderer should expose stable high-level handles:

```rust
MeshHandle
TextureHandle
MaterialHandle
WorldHandle
SkeletonHandle
AnimationClipHandle
```

OpenStrike should not directly create `wgpu::Buffer` or `wgpu::Texture`. Those are backend details.

## 13. Camera and First-Person View

The player camera is attached to the player KCC body, not to the weapon.

Player state:

```text
position
velocity
yaw
pitch
grounded
stance
health
active_weapon
```

Camera state:

```text
eye_position = player.position + stance_eye_offset
yaw/pitch from input
fov = 75–90 degrees
near = 0.03
far = map-dependent, default 4096 or 8192
```

Weapon viewmodel state:

```text
weapon_model
fire_anim_state
reload_anim_state
sway
bob
muzzle_flash_timer
```

For v0, weapon sway and bob can be minimal. The weapon can be a simple GLB model parented to the camera. Shooting can be hitscan from the camera center.

## 14. Physics and Collision

The physics design should be split into three layers.

First, static world collision. This comes from BSP geometry and is used by KCC, bots, bullets, and debug raycasts.

Second, character collision. Player and bots use KCC movement. They are not dynamic rigid bodies.

Third, simple query-only hit detection. Bullets are raycasts. Bot hitboxes are simple capsules or boxes.

Rapier’s raw Kinematic Character Controller is the preferred initial implementation because it is available as a Rust library and exposes move-and-slide behavior with ray/shape-cast based obstacle handling. The Rapier documentation also explicitly notes that character control is often game-specific and that the built-in controller may need customization, so Pocket3D must wrap it behind its own trait instead of exposing Rapier directly to applications.

Required abstraction:

```rust
pub trait CharacterController {
    fn move_character(
        &mut self,
        world: &PhysicsWorld,
        character: CharacterBody,
        desired_delta: Vec3,
        dt: f32,
    ) -> CharacterMoveResult;
}
```

Recommended v0 character shape:

A vertical capsule.

Reason: it is standard for modern FPS movement, lighter than full hull semantics, and sufficient for proving feasibility. It does not need to match GoldSrc’s box hull.

Required KCC features:

- Ground detection.
- Sliding along walls.
- Step climbing.
- Slope limit.
- Gravity.
- Jumping.

Deferred KCC features:

- Crouch.
- Water.
- Ladders.

Physics dependency policy:

- `pocket3d-kcc` may depend on Rapier.
- `pocket3d-core` must not depend on Rapier.
- `pocket3d-render` must not depend on Rapier.
- OpenStrike should depend on Pocket3D abstractions, not on Rapier directly, except in temporary experiments.

Fallback plan:

If Rapier KCC becomes too heavy or hard to tune, implement a small Parry-backed KCC using capsule shape casts and explicit slide-plane resolution. The trait boundary should make this replacement possible.

## 15. Player Movement

The first movement model should be “good enough FPS,” not CS-accurate.

Input:

```text
WASD movement
mouse look
space jump
shift walk/sprint optional
left mouse fire
R reload optional
escape menu/debug
```

Movement constants:

```text
walk_speed = 240 units/s
run_speed = 300 units/s
gravity = 800 units/s²
jump_speed = 270 units/s
ground_accel = 12
air_accel = 2
friction = 8
slope_limit = 45 degrees
step_height = 18 units
capsule_radius = 16 units
capsule_height = 72 units
eye_height = 64 units
```

These values are starting points. They are not Counter-Strike compatibility targets.

Movement update:

1. Read input snapshot.
2. Convert forward/right input through yaw.
3. Compute desired horizontal velocity.
4. Apply acceleration/friction.
5. Apply gravity.
6. Feed desired displacement into KCC.
7. Update grounded state.
8. Write player transform.
9. Write camera transform.

## 16. Bot System

The first bot system should be intentionally dumb.

It only needs to prove that animated NPCs can move through a BSP world and be shot.

Bot v0 behavior:

- Spawn at predefined bot spawn.
- Select a waypoint target.
- Walk along a waypoint path.
- Idle when close to target.
- Optionally rotate toward player when visible.
- Optionally fire slow inaccurate shots later.
- Die when health <= 0.
- Play death animation or fall to static death pose.

Navigation v0:

Use a handcrafted waypoint graph for Dust2.

The waypoint graph lives in `examples/openstrike/config/dust2_waypoints.toml`.

```toml
[[waypoints]]
id = "long_a_entrance"
pos = [120.0, 450.0, 36.0]
links = ["long_a_corner", "t_spawn_mid"]

[[waypoints]]
id = "long_a_corner"
pos = [240.0, 800.0, 36.0]
links = ["long_a_entrance", "a_site"]
```

Do not build navmesh in v0.

Do not implement tactical AI in v0.

Do not implement cover selection in v0.

Do not implement team strategy in v0.

Bot movement should use the same KCC interface as the player. This validates that Pocket3D can support multiple character controllers in the same BSP world.

Bot animation states:

```text
Idle
Walk
Run optional
HitReact optional
Death
```

Animation transitions:

- Idle -> Walk when horizontal speed exceeds threshold.
- Walk -> Idle when stopped.
- Any -> Death when killed.

Use simple crossfade, e.g. 150 ms.

## 17. Skinned Animation

Pocket3D must support enough skeletal animation for one bot character.

Asset path:

```text
.glb
  -> p3d asset build
  -> p3dskin + p3danim
  -> runtime Skeleton + SkinnedMesh + AnimationClip
```

Required features:

- Joint hierarchy.
- Inverse bind matrices.
- Vertex weights.
- Animation channels for translation, rotation, scale.
- Clip sampling.
- Pose evaluation.
- Joint matrix upload.
- GPU skinning in vertex shader.

Deferred features:

- Additive animation.
- Animation events.
- Root motion.
- IK.
- Ragdoll.
- Retargeting.
- Blend trees.

The first bot should use one GLB with all required clips, or one GLB mesh plus separate GLB clips if easier. The runtime should normalize both into Pocket3D’s compiled animation format.

## 18. Weapon System

OpenStrike v0 needs one weapon.

Weapon type: hitscan rifle.

Weapon requirements:

- Viewmodel appears in first person.
- Left click fires if cooldown is ready.
- Shot traces from camera center.
- Ray hits bot hitboxes or world.
- If bot hit, apply damage.
- If world hit, spawn impact decal/debug marker.
- Play gunshot sound.
- Show muzzle flash.

Initial weapon config:

```toml
[id.rifle]
display_name = "OS Rifle"
damage = 35
fire_interval_ms = 120
magazine_size = 30
reload_ms = 1800
range = 4096
spread_degrees = 0.5
headshot_multiplier = 2.0
```

Reload can be implemented after the first kill loop. For the earliest vertical slice, infinite ammo is acceptable as long as the weapon has cooldown, sound, muzzle feedback, and hit detection.

Hit detection order:

1. Build ray from camera.
2. Query bot hitboxes.
3. Query world collision.
4. Choose nearest hit.
5. If nearest hit is bot, apply damage.
6. If nearest hit is world, stop at wall.

Bot hitboxes v0:

- One capsule for body.
- Optional head sphere.
- No skeletal per-bone hitboxes in v0.

## 19. Round System

OpenStrike round states:

```rust
enum RoundState {
    Loading,
    PreRound,
    Live,
    PlayerWon,
    PlayerLost,
    Intermission,
    Restarting,
}
```

Initial flow:

1. Load map and assets.
2. Spawn player.
3. Spawn one or more bots.
4. Enter `PreRound` for 1 second.
5. Enter `Live`.
6. If all bots dead, enter `PlayerWon`.
7. If player dead, enter `PlayerLost`.
8. Show result for 3 seconds.
9. Restart round.

The round restart should reset:

- Player position.
- Player health.
- Weapon state.
- Bot positions.
- Bot health.
- Bot AI state.
- Temporary decals.
- Muzzle flashes.
- Transient sounds.

The world map and static assets should not be reloaded between rounds.

## 20. Script and TypeScript Boundary

Pocket3D should support QuickJS + TypeScript as an extension layer, but v0 must remain Rust-first.

Good script responsibilities:

- Weapon definitions.
- Round constants.
- Bot waypoint graph loading or selection.
- Bot behavior parameters.
- HUD text and debug state.
- Event callbacks.
- Console commands.

Bad script responsibilities:

- Per-frame collision resolution.
- KCC internals.
- Raycast acceleration structure.
- Animation sampling.
- Renderer resource management.
- Asset loading internals.

Example TypeScript shape:

```ts
export const weapon = defineWeapon({
  id: "os_rifle",
  displayName: "OS Rifle",
  damage: 35,
  fireIntervalMs: 120,
  magazineSize: 30,
  reloadMs: 1800,
  range: 4096,
  spreadDegrees: 0.5,
});

export const round = defineRoundRules({
  preRoundMs: 1000,
  intermissionMs: 3000,
  playerHealth: 100,
  botHealth: 100,
});
```

Script execution model:

- Scripts are loaded at boot.
- Scripts register data and callbacks.
- Rust compiles script-defined data into compact runtime structs.
- Rust calls script callbacks only on events, not for every hot-path calculation.

Allowed callbacks:

```text
onRoundStart
onRoundEnd
onBotKilled
onPlayerKilled
onTriggerEnter
onConsoleCommand
```

The QuickJS bridge should learn from PocketJS’s small native contract model, but remain separate. PocketJS’s existing architecture uses a small synchronous mutation surface into Rust and keeps native state on the Rust side; Pocket3D should use the same philosophy for scripts.

## 21. HUD and UI

OpenStrike v0 needs a minimal HUD.

HUD elements:

- Crosshair.
- Health.
- Ammo or infinite-ammo marker.
- Round result text.
- Debug overlay toggle.

Initial implementation may be immediate-mode debug UI rendered by Pocket3D.

Later, PocketJS can be integrated as a 2D overlay layer, but v0 must not depend on that integration. Pocket3D should expose a future `OverlaySurface` or `UiLayer` abstraction so PocketJS can render into the final pass later.

HUD v0 can be implemented using:

- Bitmap font.
- Simple textured quads.
- Debug line/text renderer.

No layout engine required.

## 22. Audio

Audio should be minimal but present.

Required sounds:

- Gunshot.
- Hit marker or impact.
- Bot death.
- Round win/loss cue optional.
- Footstep optional.

Implementation candidates can be selected later. The abstraction should be simple:

```rust
pub trait AudioBackend {
    fn play_2d(&mut self, sound: SoundHandle, volume: f32);
    fn play_3d(&mut self, sound: SoundHandle, pos: Vec3, volume: f32);
    fn set_listener(&mut self, pos: Vec3, forward: Vec3, up: Vec3);
}
```

Audio must not block the main simulation loop.

## 23. Tooling

Pocket3D needs tools early. Without tooling, BSP and KCC debugging will be slow.

Required CLI commands:

```text
p3d bsp inspect <map.bsp>
p3d bsp build <map.bsp> --wad-path <dir> --out <map.p3dworld>
p3d asset build <asset-dir> --out <game.p3dpak>
p3d openstrike run --map <map-or-pak>
p3d openstrike check-assets
```

Required debug overlays:

- World axes.
- Camera position.
- Player capsule.
- Ground normal.
- KCC contacts.
- Raycast line.
- Bullet hit point.
- Bot waypoint path.
- Bot current target.
- Bot capsule/hitbox.
- Spawn points.
- BSP entity labels.
- Map bounds.

Required inspector output:

- BSP version.
- Lump summary.
- Texture count.
- Missing WAD textures.
- World vertex/index count.
- Lightmap atlas size.
- Entity count by classname.
- Collision triangle count.
- Spawn point count.

## 24. First Vertical Slice Acceptance Criteria

The first accepted OpenStrike vertical slice must pass these criteria.

- The app launches from `cargo run -p openstrike`.
- A BSP map loads.
- The player spawns inside the map.
- The world renders with recognizable textures.
- The camera can look around with mouse input.
- The player can walk on floors, collide with walls, step over small geometry, and fall under gravity.
- The player cannot walk through the main world geometry.
- A weapon appears in first person.
- Clicking fires a hitscan shot.
- A bot spawns in the world.
- The bot has a visible skinned model.
- The bot can play idle and walk animation.
- The bot walks along a waypoint path using the KCC.
- The player can shoot the bot.
- A hit applies damage.
- At zero health, the bot dies.
- When all bots are dead, the round enters win state.
- After a short intermission, the round restarts without reloading the whole map.
- The debug overlay can show player capsule, bot capsule, waypoints, and last bullet ray.

## 25. Milestones

### Milestone 0: Runtime Skeleton

Deliverables:

- Window creation.
- `wgpu` device/surface setup.
- Main loop.
- Fixed timestep.
- Input snapshot.
- Free-fly camera.
- Debug text or logging.

Success condition:

A developer can launch Pocket3D and fly a camera in an empty scene.

### Milestone 1: BSP Viewer

Deliverables:

- Load BSP.
- Resolve textures.
- Generate world mesh.
- Render textured geometry.
- Render lightmaps if available.
- Basic camera clipping and depth.
- BSP inspector CLI.

Success condition:

Dust2 or a Dust2-like BSP is visually recognizable.

### Milestone 2: Walkable BSP

Deliverables:

- Static collision world.
- Player capsule.
- KCC movement.
- Gravity.
- Ground detection.
- Wall collision.
- Step climbing.
- Debug overlay.

Success condition:

The player can walk around the BSP map in first person without falling through floors or passing through walls.

### Milestone 3: Weapon and Hit Queries

Deliverables:

- Viewmodel weapon.
- Fire input.
- Hitscan raycast.
- World impact.
- Bot placeholder capsule target.
- Health/damage.

Success condition:

The player can shoot a placeholder bot volume and kill it.

### Milestone 4: Animated Bot

Deliverables:

- GLB skinned mesh loading.
- Skeleton and animation clips.
- Idle/walk/death state machine.
- Waypoint-following bot KCC.

Success condition:

A visible humanoid bot walks through the map and dies when shot.

### Milestone 5: Round Loop

Deliverables:

- Round state machine.
- Spawn/reset logic.
- Win/loss condition.
- Intermission.
- HUD text.

Success condition:

The whole loop runs repeatedly: spawn, walk, shoot, kill, win, restart.

### Milestone 6: Scriptable Config

Deliverables:

- QuickJS boot.
- TypeScript build path.
- Script-defined weapon config.
- Script-defined round config.
- Script-defined bot config.

Success condition:

Changing weapon damage or round delay in TypeScript changes OpenStrike behavior without modifying Rust gameplay code.

## 26. Dependency Policy

Recommended initial dependencies:

- `wgpu` for rendering.
- `winit` for window/input.
- `glam` for math.
- `qbsp` for BSP parsing and initial mesh/raycast/lightmap support.
- `rapier3d` for KCC and physics queries, behind Pocket3D abstractions.
- `gltf` for GLB/glTF loading.
- `image` for texture decoding.
- `rodio`, `cpal`, or another small audio backend after the visual loop works.
- `rquickjs` or another QuickJS binding for scripting after the Rust gameplay loop works.

Dependency constraints:

- No Godot dependency.
- No Bevy dependency in v0.
- No engine-level dependency that brings in a scene tree, scheduler, renderer, or editor.
- No dependency should leak through public Pocket3D APIs unless deliberately accepted.

## 27. Why Not Godot

Godot is not required for this plan.

Godot would provide an editor, scene tree, built-in physics, import pipeline, animation tools, and high-level gameplay framework. Those are useful for a general game. They are not required for this focused runtime.

Pocket3D needs:

- First-class BSP loading.
- A Rust-owned simulation loop.
- A thin `wgpu` backend.
- A lightweight KCC abstraction.
- Headless-testable gameplay logic.
- QuickJS/TypeScript extension points.
- A repository-local example application.

These requirements are better served by a small runtime than by embedding or depending on Godot.

Godot can remain useful as a reference or prototyping tool, but it should not be in the OpenStrike v0 dependency graph.

## 28. Major Risks

BSP collision may not match player expectations.

Mitigation: start with static triangle mesh collision, then add clip brush or BSP hull support only when required by Dust2 traversal.

Texture and WAD resolution may be messy.

Mitigation: build a missing-texture report in Milestone 1 and allow configurable WAD search paths.

Rapier KCC may not feel right.

Mitigation: isolate it behind `pocket3d-kcc`. Replace with custom Parry-based KCC if needed.

Skinned animation may consume more time than expected.

Mitigation: first kill a capsule target; add animated GLB bot afterward.

Dust2 asset distribution is legally sensitive.

Mitigation: never commit proprietary assets; use user-supplied local paths or an open substitute map.

The project may over-abstract into a general engine too early.

Mitigation: OpenStrike vertical slice drives the API. Add abstractions only after the vertical slice needs them.

## 29. Testing Strategy

Unit tests:

- Math conversions.
- Fixed timestep accumulator.
- Round state transitions.
- Weapon cooldown and damage.
- KCC helper logic where deterministic.
- Asset hash/cache behavior.
- BSP entity parser.

Integration tests:

- Load test BSP.
- Build `.p3dworld`.
- Spawn player.
- Simulate movement against a wall.
- Simulate shooting a bot.
- Simulate killing all bots.
- Simulate round restart.

Golden/debug tests:

- BSP import summary snapshot.
- Known map bounds snapshot.
- Known entity count snapshot.
- Known waypoint graph validation.

Visual screenshot goldens can be added later, but should not block v0.

Manual test checklist:

- Launch.
- Load map.
- Walk to known areas.
- Climb stairs.
- Fire weapon.
- Hit wall.
- Hit bot.
- Kill bot.
- Win round.
- Restart round.
- Toggle debug overlay.

## 30. Implementation Priorities

The order matters.

Do not start with scripting.

Do not start with a general scene format.

Do not start with an editor.

Do not start with multiplayer.

Do not start with exact CS movement.

Start with:

1. `wgpu` window.
2. BSP render.
3. Player KCC.
4. Weapon raycast.
5. Bot capsule.
6. Round loop.

Then add:

1. Skinned bot.
2. Waypoint walking.
3. Sound.
4. Script config.
5. HUD polish.

The project becomes real when the player can walk inside the BSP. Everything before that is infrastructure. Everything after that is iteration.

## 31. Final Architecture Statement

Pocket3D should be a small Rust runtime for 3D applications inside the Pocket repository. It should use `wgpu` for graphics, BSP as a first-class world asset path, a replaceable KCC layer for movement, glTF/GLB for character and weapon assets, and QuickJS/TypeScript only as a controlled extension layer.

OpenStrike should be the proof that the runtime works. The proof is not “it looks exactly like Counter-Strike.” The proof is simpler: a real BSP map, a first-person player, a weapon, an animated moving bot, hit detection, death, win condition, and round restart.

That is the correct first target.
