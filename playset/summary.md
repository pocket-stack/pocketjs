# Playset Modules Summary

This document summarizes the playset modules under `modules/`. Each entry
states the main capability the module provides. The 3D coordinate system is
right-handed; the default world basis is right = +X, up = +Y, forward = −Z
(`modules/math/world-basis.ts` is the single source of truth).

Module dependencies: **none at runtime**. Where GameBlocks imported Three.js
and Rapier3D from a CDN, playset modules use:

1. `playset/math` — three-compatible math value types (`Vector3`,
   `Quaternion`, `Matrix4`, `Euler`, `Color`); clean-room, see
   `ATTRIBUTION.md`.
2. `playset/scene3d` — the scene3d presentation surface (write-only ops
   contract, `Scene3D` client, `<Viewport3D>`, renderless sim host).
3. `modules/physics/collision-world.ts` — the deterministic collision core
   (replaces Rapier).
4. `@pocketjs/framework/*` + `solid-js` — HUD components and the virtual
   clock. The fixed-step driver is `playset/loop.ts` (`createGameLoop`).

Modules are **copied into the game project**, not installed as a dependency —
see `SKILL.md` for the workflow and the Three.js → playset mapping table.

Most entries are ports of the corresponding GameBlocks module (source stated
in each file's header). Ports keep GameBlocks semantics unless a "Differs
from GameBlocks" note says otherwise; two substitutions apply throughout and
are not repeated per entry: models and cameras are typed structurally
(position + quaternion) instead of three.js `Object3D`, and colors are u32
ABGR instead of hex + float opacity (`modules/world/color-utils.ts`).

## Actor Motion

### `modules/actor-motion/kinematic-batch-resolver.ts`
- Functionality: Resolves many kinematic movement requests through the deterministic CollisionWorld and returns grounded/collision outcomes.
- Differs from GameBlocks: Reengineered — Rapier's KinematicCharacterController is replaced by `CollisionWorld.resolveCapsule` (planar wall slide, climb step-up, ground snap) plus planar circle push-out for actor-vs-actor collision resolved in registration order; the `rapier` constructor argument is gone, collider friction/restitution/group options are accepted but inert, and the native Rust physics block is the planned upgrade path.

### `modules/actor-motion/general-vehicle-motion-controller.ts`
- Functionality: Converts local vehicle controls into general-purpose motion with six-axis shifting, four-way path steering, independent body yaw rotation, optional body banking, and instant or acceleration-based response. Supports a wide range of vehicles across aircraft, watercraft, spacecraft, and landcraft.

### `modules/actor-motion/general-object-model-controller.ts`
- Functionality: Applies caller-provided position and pose frame to object model transforms, with configurable mesh forward direction and optional keep-basis-up alignment.

### `modules/actor-motion/aircraft/airplane-model-controller.ts`
- Functionality: Applies flight motion state to airplane visual transforms, including position, yaw, pitch, and roll, and drives jet-flame effects.

### `modules/actor-motion/aircraft/airplane-motion-controller.ts`
- Functionality: Converts local pilot controls for steering, throttle, and boost into fixed-wing airplane motion.

### `modules/actor-motion/character/base-character-motion-controller.ts`
- Functionality: Provides shared grounded character locomotion for position, velocity, yaw/pitch, sprint, crouch, jump, gravity, resolver intent creation, and commit behavior.

### `modules/actor-motion/character/world-target-character-motion-controller.ts`
- Functionality: Converts world-space move and face target points into shared character locomotion. Recommended camera pairing: `PositionFollowCameraRig`.

### `modules/actor-motion/character/world-cardinal-character-motion-controller.ts`
- Functionality: Converts world-space left/right/forward/backward movement and rotateCCW/rotateCW input into shared character locomotion. Recommended camera pairing: `PositionFollowCameraRig`.

### `modules/actor-motion/character/heading-relative-character-motion-controller.ts`
- Functionality: Converts character-heading-relative forward/backward movement, strafeLeft/strafeRight movement, and turnLeft/turnRight input into shared character locomotion. Recommended camera pairing: `PoseFollowCameraRig`.

### `modules/actor-motion/character/mouse-look-character-motion-controller.ts`
- Functionality: Converts local left/right/forward/backward movement plus mouse-look yaw/pitch deltas into shared character locomotion. Recommended camera pairing: `FirstPersonCameraRig` for first-person view or `PoseFollowCameraRig` for third-person chase view.

### `modules/actor-motion/ground-vehicle/drifting-plugin.ts`
- Functionality: Adds drift response to dynamic car physics by detecting slip and modifying car control behavior.
- Differs from GameBlocks: Typed structurally so it plugs into both the motion controller (planMovement/commitMovement) and the kinematic batch resolver's rigid-body shim (applyDynamicCarControls / yaw-rate assist).

### `modules/actor-motion/ground-vehicle/dynamic-car-batch-resolver.ts`
- Functionality: Resolves dynamic car physics for multiple actors and returns synchronized car state (position, rotation, velocity, wheel states) each frame.
- Differs from GameBlocks: Reengineered — the Rapier raycast-vehicle becomes a deterministic kinematic approximation on the CollisionWorld (accel/brake curves derived from the config module, grip-clamped bicycle-model steering with lateral slip state so DriftingPlugin stays functional, terrain following with suspension lag and a ballistic airborne phase, planar wall push-out); the public API and per-actor result shape match the original exactly, the `rapier` option is gone, and the native Rust physics block is the planned upgrade path.

### `modules/actor-motion/ground-vehicle/dynamic-car-motion-controller.ts`
- Functionality: Converts local driver controls for steering, throttle, reverse, brake, handbrake, and boost into dynamic car control intent for full wheel-physics simulation.

### `modules/actor-motion/ground-vehicle/dynamic-car-config.ts`
- Functionality: Builds basis-aware dynamic car setup data (chassis mass/extents, damping, drive forces, per-wheel suspension/friction specs) for the dynamic car resolver.
- Differs from GameBlocks: Only the file name drops "rapier" (source: `DynamicCarRapierConfig.js`; the exported function keeps its original name so call sites port unchanged) — same semantics and numbers, now feeding the kinematic `dynamic-car-batch-resolver`.

### `modules/actor-motion/ground-vehicle/car-model-controller.ts`
- Functionality: Applies car motion state to visual transforms, including vehicle body pose and wheel animation.

### `modules/actor-motion/ground-vehicle/arcade-car-motion-controller.ts`
- Functionality: Converts local driver controls for steering, throttle, reverse, and boost into lightweight arcade car motion with basic terrain height/normal following.

### `modules/actor-motion/plate-tilt-controller.ts`
- Functionality: Converts directional tilt controls into smoothed plate rotations and gameplay slope values.

### `modules/actor-motion/snake-motion-controller.ts`
- Functionality: Converts snake turn and growth input into updated grid-cell direction and segment state.

## Behavior

### `modules/behavior/nearby-avoidance-steering.ts`
- Functionality: Adjusts planar movement intent to steer an actor away from nearby agents while preserving intended travel direction.

### `modules/behavior/grid-path-planner.ts`
- Functionality: Plans grid-board routes (A*) and reachable cells (flood fill) with blocked cells and wrapping or bounded edges.

### `modules/behavior/agent-path-navigator.ts`
- Functionality: Converts character position, current waypoint, and speed limit into planar movement intent, including direction, desired speed, waypoint, and distance.

### `modules/behavior/waypoint-progress-tracker.ts`
- Functionality: Tracks route progress by advancing waypoints after the reach distance is met and reporting the current waypoint, progress, and corner profile.

### `modules/behavior/waypoint-driver.ts`
- Functionality: Converts waypoint, vehicle pose, speed, and corner profile into AI vehicle controls, including throttle, reverse, brake, left/right steering, and boost, with stuck detection and reverse recovery.

### `modules/behavior/combat-behavior-director.ts`
- Functionality: Maintains tactical state for shooter agents as they idle, patrol, chase, attack, or die, with per-agent memory, repath/attack cooldowns, and prng-driven strafing.

## Camera

### `modules/camera/base-camera-rig.ts`
- Functionality: Provides base smoothing and basis-aware pose behavior for concrete camera rigs.
- Differs from GameBlocks: `applyToCamera` drives a structural CameraLike whose `up`/`lookAt` are optional — scene3d's `Camera3D` has no `up` field — so both it and three-style cameras work unchanged.

### `modules/camera/position-follow-camera-rig.ts`
- Functionality: Follows a target position with a fixed world-basis offset and fixed viewing angle while looking at the target.

### `modules/camera/pose-follow-camera-rig.ts`
- Functionality: Follows a target position and targetFrame with a pose-relative offset and pose-relative look target so the view moves and turns with the target.

### `modules/camera/first-person-camera-rig.ts`
- Functionality: Follows a target eye position and current forward direction to produce actor-locked first-person view motion.

### `modules/camera/look-offset-camera-rig.ts`
- Functionality: Applies temporary free-look rotation around a target and recenters the view when look input stops.

## Gameplay

### `modules/gameplay/aim-resolver.ts`
- Functionality: Resolves screen/camera aiming or explicit ray aiming into hit position, aim direction, matched target, and launch-to-hit shooting direction.
- Differs from GameBlocks: Deliberate API deviation — playset has no scene raycasting (the presentation surface is write-only), so `camera.rayFromNdc` replaces `Raycaster.setFromCamera` and the `objects`/`recursive` pick list is replaced by two pick sources, `world` (CollisionWorld raycast) and `targets` (analytic ray-vs-sphere), with the nearest hit across both winning; the result keeps the original shape and field names with `targetObject` renamed `target`, and the virtual-point and launch≈hit fallbacks are preserved verbatim.

### `modules/gameplay/combat-play.ts`
- Functionality: Owns team combat player state, health and armor changes, death events, winner resolution, and reset behavior.

### `modules/gameplay/flight-play.ts`
- Functionality: Owns flight player state, terrain crash checks, hit-ground events, finish state, and reset behavior.

### `modules/gameplay/race-checkpoint-lap-play.ts`
- Functionality: Owns checkpoint-lap race state, countdown start, player progress, lap completion, finish order, standings, race events, and reset behavior.

### `modules/gameplay/snake-play.ts`
- Functionality: Owns snake player and item state, wall collisions, self collisions, snake collisions, item pickups, death events, and reset behavior.

### `modules/gameplay/wave-spawn-director.ts`
- Functionality: Schedules and spawns enemy waves, escalates spawn pressure, and advances waves as active units are cleared.

### `modules/gameplay/combat/projectile-weapon-system.ts`
- Functionality: Manages gun and missile weapon selection, ammo, cooldowns, gun heat, missile lock-on targeting, and fire decisions with launch position, direction, and speed.
- Differs from GameBlocks: `aimMode` is typed to the two supported modes, so the original's implicit crash on an unknown mode becomes the same TypeError as a zero fire direction.

### `modules/gameplay/combat/projectile-manager.ts`
- Functionality: Manages live projectile objects, removes inactive projectiles, and returns projectile hit events.
- Differs from GameBlocks: Takes a required `createProjectile` factory instead of constructing `ProjectileObject` directly (playset gameplay modules stay decoupled from world/object); spawn options and defaults, the step loop, hit-event shape, and clear/dispose semantics are otherwise verbatim.

## Math

### `modules/math/random-utils.ts`
- Functionality: Provides a deterministic pseudo-random generator with uniform, integer range, step range, and choice helpers. Bit-identical Mulberry32 sequence to the GameBlocks original: seeded alike, both draw the same stream, which is what makes cross-engine golden traces possible.

### `modules/math/scalar-utils.ts`
- Functionality: Provides shared scalar operations for stable numeric motion and value normalization — the framerate-independence backbone every motion controller leans on.

### `modules/math/time-utils.ts`
- Functionality: Provides system and manually controlled clock helpers for consistent millisecond and second timestamps.
- Differs from GameBlocks: One deliberate semantic upgrade — the non-manual path reads the virtual clock (`@pocketjs/framework/clock` `virtualNow`) instead of falling back to `Date.now()`, so clocks are deterministic by default and replayable under host-sim; `useManual()` behaves exactly like the original.

### `modules/math/vector3-utils.ts`
- Functionality: Normalizes vector inputs into safe `playset/math` vectors and basis-aware planar directions.

### `modules/math/world-basis.ts`
- Functionality: Defines how gameplay directions map onto world axes and keeps basis-aware movement, height, compass, and frame math consistent. The default basis (right = +X, up = +Y, forward = −Z) matches both Three.js convention and pocket3d's camera space.

## Physics

### `modules/physics/collision-world.ts`
- Functionality: The deterministic collision core: static cuboid / y-cylinder / ball colliders, a terrain heightfield sampler as the ground authority, planar capsule push-out with wall sliding and ground snapping, and raycasts for aiming. Colliders resolve in insertion order; plain f64 math, no wall clock, no `Math.random`.
- Differs from GameBlocks: Playset-native (no GameBlocks counterpart) — it replaces the injected Rapier `world` in the ported environments and batch resolvers; dynamic rigid bodies, wedge trimeshes, and stacked-shape climbing are the native Rust block follow-up.

## User Interface

### `modules/user-interface/hud-binder.ts`
- Functionality: Tiny reactive HUD bindings: `HudValue` (a Text bound to an accessor) and `HudBar` (a fill View whose width tracks a 0..1 accessor).
- Differs from GameBlocks: Supersedes `DomHudRenderer.js`, which is deliberately not exported — under PocketJS, Solid reactivity is the binder: bindText → HudValue, bindStyleWidth → HudBar (+ `hudBarRatio`), bindClassToggle/bindAttribute → plain Solid expressions at the call site; `DEFAULT_FORMATTER` is verbatim.

### `modules/user-interface/minimap-projector-2d.ts`
- Functionality: Maps world-space positions and headings into minimap-space coordinates.

### `modules/user-interface/notification-queue.ts`
- Functionality: Maintains visible and pending notification state over time (capped toast queue with sticky and per-item lifetimes, plus an expiring message feed), driven by an injected Clock.

### `modules/user-interface/heading-relative-radar.ts`
- Functionality: Renders nearby contacts in heading-relative radar space, range-clamped to the scope edge inside a fixed square scope.
- Differs from GameBlocks: The projection math is verbatim (exposed as `HeadingRelativeRadarProjection`); the Canvas2D painting becomes a PocketJS View tree with contacts as an `<Index>` of dot Views — cross/triangle contact shapes and the player arrow collapse to dots (no path primitive), and contact yaw rotation is dropped with them.

### `modules/user-interface/storage-settings-store.ts`
- Functionality: Persists user settings safely as typed key/value pairs, with raw readers/writers plus a JSON settings store.
- Differs from GameBlocks: The `window.localStorage` backend becomes an injectable `{getItem/setItem/removeItem}` interface with a shared in-memory Map fallback (settings survive within a session by default; hosts can inject a persistent backend later without touching callers); all parsing/merging semantics are verbatim.

### `modules/user-interface/ui-state-model.ts`
- Functionality: Provides observable UI state updates with stable snapshots — patch/replace with per-key equality; listeners get (snapshot, changedKeys).
- Differs from GameBlocks: Adds `createUiSignal()`, a Solid bridge (model.subscribe → signal) so PocketJS HUDs consume snapshots idiomatically.

### `modules/user-interface/flight-hud.ts`
- Functionality: Renders flight, weapon, navigation, scoring, and warning state as a cockpit-style HUD: compass heading + cardinal, roll-rotated pitch tape, SPD/THR/AOA-ROLL and ALT/AGL/WPN data boxes, status row, PULL UP warning.
- Differs from GameBlocks: The state→presentation mapping is verbatim (exposed as `computeFlightHudReadouts()`); the DOM→PocketJS move drops the injected-CSS animations, dashed negative pitch lines, pseudo-element art and vw/vh sizing, and `pullUpWarning: null` (original: "keep previous") renders as hidden — a reactive tree has no imperative latch.

### `modules/user-interface/race-minimap.ts`
- Functionality: Renders race progress and competitors into a track-aware minimap: checkpoints, AI competitors with a leader ring, and the local vehicle projected through MinimapProjector2D.
- Differs from GameBlocks: Projection, dot radii, style keys and the next-checkpoint rule are verbatim; the Canvas2D class becomes a PocketJS component of `<Index>` dot Views — the track polyline is skipped in v1 (no line primitive; checkpoint dots still trace the circuit), the local-vehicle triangle collapses to a stroked dot that still carries yaw as a rotation, and `basis` is exposed as a prop.

## World

### `modules/world/scene-node-utils.ts`
- Functionality: Removes and disposes scene-graph hierarchies.
- Differs from GameBlocks: Renamed from `Object3DUtils.js` `disposeObject3D` → `disposeSceneNode` — `node.destroy()` already detaches the whole subtree and geometry/material lifetime is host-side, so the recursive geometry/material dispose traverse has no guest analog; `disposeObject3D` stays exported as an alias for port compatibility.

### `modules/world/blob-shadow.ts`
- Functionality: Renders a flattened dark disc (unlit transparent squashed cylinder just above the ground) that fakes a contact shadow under an entity; the owner calls `updateBlobShadow` each frame before `scene.flush()`.
- Differs from GameBlocks: Playset-native — scene3d has no shadow maps by contract, so every castShadow/receiveShadow flag the world factories dropped is replaced by one of these.

### `modules/world/color-utils.ts`
- Functionality: Converts hex-RGB colors to scene3d u32 ABGR, folding opacity into the color the same way across all world ports.
- Differs from GameBlocks: Playset-native — GameBlocks hands three.js 0xRRGGBB hex plus a float opacity; scene3d materials, tints, and pool colors take one u32 ABGR.

### `modules/world/environment/arena-environment.ts`
- Functionality: Builds arena scene visuals (ground, grid, four walls, eight pillars, three ramps), supports spawn position sampling and obstacle queries, and creates explicit CollisionWorld colliders.
- Differs from GameBlocks: scene3d + CollisionWorld substitutions — SceneNodes are in-scene from creation, GridHelper becomes unlit thin boxes, roughness/metalness and node names are dropped, and `createPhysicsColliders(world, rapier)` → `createColliders(world)` with the ground cuboid skipped (the ground authority is terrain/ground height) and ramp colliders deferred to native physics (the ramp visuals keep the exact 6-corner wedge geometry).

### `modules/world/environment/natural-environment.ts`
- Functionality: Builds natural scene visuals with procedural terrain and prng-placed tree/rock/grass props, supports terrain height queries, and creates explicit CollisionWorld colliders (terrain ground authority, tree cylinders, rock balls).
- Differs from GameBlocks: scene3d + CollisionWorld substitutions — renderOrder is kept for API compatibility but inert, plant/rock factories are injectable (defaulting to the real modules), and the prng draw order per prop is exactly the original's so a given seed reproduces the original's layout counts; the terrain trimesh becomes `registerTerrainCollider` (sampler as ground authority).

### `modules/world/environment/race-track-environment.ts`
- Functionality: Builds a closed race track composed over NaturalEnvironment — road-flattened terrain, checkpoint gates, inner/outer barrier fences — with spawn pose sampling and CollisionWorld colliders.
- Differs from GameBlocks: scene3d + CollisionWorld substitutions — shadows become blob decals, barrier posts → addCylinder and rails → yaw-only addCuboid (CollisionWorld v1 drops the rails' terrain-following tilt, faithful for the planar resolver), and `prng`/factory injection flows through to the composed NaturalEnvironment.

### `modules/world/environment/board-environment.ts`
- Functionality: Builds board scene visuals with grid cells and lighting, supports cell/world coordinate helpers, and exposes grid bounds.
- Differs from GameBlocks: scene3d substitutions — `scene` may be null for board math only, GridHelper becomes unlit thin boxes with opacity in the material alpha, Ambient/DirectionalLight become `scene.ambient`/`scene.sun` plus plain descriptor records, and shadow-map config is dropped (blob decals).

### `modules/world/environment/terrain-mesh-factory.ts`
- Functionality: Bakes a terrain sampler into a scene3d heightfield mesh and registers the sampler as the CollisionWorld ground authority.
- Differs from GameBlocks: The indexed BufferGeometry maps onto `geomHeightfield` (the host owns tessellation and normals; heights sampled in the original's row/col order); `createTerrainTrimeshCollider(world, rapier, mesh)` is replaced by `registerTerrainCollider(world, sampler)` — the ground authority is the sampler, exact heights instead of triangle interpolation; `materialOptions` is accepted but ignored.

### `modules/world/environment/terrain-sampler.ts`
- Functionality: Provides terrain sampler classes that expose `heightAt`, `normalAt`, `colorAt`, and `sample(right, forward)` for procedural worlds. Includes natural grassland terrain, archipelago terrain, and road terrain via road flattening. Pure math; no scene graph.

### `modules/world/environment/world-bounds-collider-factory.ts`
- Functionality: Builds physical boundary wall colliders around a basis-aware planar world area.
- Differs from GameBlocks: The injected Rapier `world`+`rapier` pair becomes a CollisionWorld with one solid `addCuboid` per wall, returning collider handles instead of {body, collider} pairs; friction and restitution are accepted for API compatibility but inert.

### `modules/world/environment/spawn-area-sampler.ts`
- Functionality: Samples planar spawn positions inside optional allowed regions while rejecting blocked regions, using simple rect, circle, polygon, and segment-corridor shape contracts.

### `modules/world/environment/planar-utils.ts`
- Functionality: Provides shared basis-aware planar geometry and terrain helpers (tangents, centroids, terrain height lookups).

### `modules/world/object/pickup-object.ts`
- Functionality: Updates pickup world state, including visual animation (bob and spin), collection bounds, and collection checks; the visual is driven structurally with zero scene coupling.

### `modules/world/object/projectile-object.ts`
- Functionality: Updates projectile world state, including linear or homing motion, hit checks, visual updates, and expiry; the visual is driven structurally with zero scene coupling.

### `modules/world/object/fps-weapon-view-model.ts`
- Functionality: Updates first-person weapon presentation from player movement, stance, aiming, and recoil state.
- Differs from GameBlocks: Per-frame `step()` math is verbatim; constructor options gain `scene: Scene3D`, and the depthTest:false + renderOrder always-on-top overlay renders as ordinary nodes until the native core adds an overlay depth pass.

### `modules/world/object/health-bar-view.ts`
- Functionality: Updates floating camera-billboarded health presentation above an entity.
- Differs from GameBlocks: THREE.Sprite layers become unlit transparent thin boxes billboarded by the same camera-quaternion copy — the fill box is re-centered each step to emulate the sprite's left anchor, fill color swaps ride `nodeSetTint`, and layers get a tiny +Z stagger to survive a depth-tested host.

### `modules/world/object/factory/airplane-visual-factory.ts`
- Functionality: Builds airplane visual models for flight actors: fuselage, nose, canopy, wings, tail, engines, jet flames, optional debug centroid and target ring.
- Differs from GameBlocks: emissive/metalness/roughness options are accepted but ignored (fixed-function lighting), shadow flags become blob decals, part rotations become node quaternions, and the Box3 airframe recenter folds to the analytic-primitive constant (0, 0.315, −0.4525).

### `modules/world/object/factory/plant-visual-factory.ts`
- Functionality: Builds plant visual models and materials for natural environments, including tree trunks, conifer and broadleaf canopies, branch stubs, and grass blades, with prng-randomized shape.
- Differs from GameBlocks: PRNG draw order is preserved call-for-call so a seeded tree is deterministic; material factories take `scene` and return handles, broadleaf dodecahedron clusters become low-segment spheres, and roughness/flatShading/openEnded/shadow flags are dropped.

### `modules/world/object/factory/rock-visual-factory.ts`
- Functionality: Builds rock visual models and materials for natural environments, including squashed ground rocks and irregular boulders with randomized shape variation.
- Differs from GameBlocks: Polyhedron geoms become low-segment spheres, and `applySeamSafeIrregularity`'s per-vertex prng scaling is skipped (parametric spheres have no guest-side vertex buffer) — `createIrregularRockVisual`'s prng stream position differs from GameBlocks after that call; the per-axis scale draws that follow are kept, in order.

### `modules/world/object/factory/pickup-visual-factory.ts`
- Functionality: Builds pickup visual models for ammo, health, and armor pickups.
- Differs from GameBlocks: The shared MeshStandardMaterial's emissive/metalness/roughness have no fixed-function analog and are dropped — parts keep their base colors as plain lit materials.

### `modules/world/object/factory/projectile-visual-factory.ts`
- Functionality: Builds projectile visual models and update helpers for bullets and missiles.
- Differs from GameBlocks: Per-frame `material.opacity` writes become `nodeSetTint` alpha (bullet age fade; the missile flame's flicker replaces its opacity), depthTest/renderOrder/emissive/group names are dropped, and `setCylinderBetween` is verbatim (scene3d cylinders are +Y-aligned like three's).

### `modules/world/object/factory/car-visual-factory.ts`
- Functionality: Builds lightweight car visual models (body, cabin, four steerable/spinning wheels) for racing and prototype vehicles.
- Differs from GameBlocks: The wheel geometry's baked `rotateZ(π/2)` moves onto a child mesh under a bare spin node (spinning about local X behaves exactly like the original), the debug ArrowHelper is emulated with an unlit shaft + cone group, and metalness/shadow flags are dropped.

### `modules/world/visual-effects/jet-flame.ts`
- Functionality: Renders jet exhaust intensity from aircraft throttle and boost state.
- Differs from GameBlocks: The ShaderMaterial (radial glow, shock diamonds, hash-noise flicker) becomes two nested additive unlit cones — the exact boostFactor smoothing and scale formulas are kept, the orange→blue boost color shift rides `nodeSetTint`, the shader's noise flicker becomes a deterministic ±18% sine on timeSeconds (not prng), the PointLight is dropped, and the constructor gains `scene`.

### `modules/world/visual-effects/ground-click-indicator.ts`
- Functionality: Renders a fading, expanding ring-and-disk ground marker for click or target feedback.
- Differs from GameBlocks: Step math is verbatim (420 ms fade, 0.42→1.4 scale); with no Circle/Ring geometry the disk is a thin flat cylinder and the ring a thin torus (already ground-planar, so the group keeps an identity quaternion), per-frame opacity becomes `nodeSetTint` alpha, and the constructor gains `scene`.

### `modules/world/visual-effects/vehicle-tire-mark-renderer.ts`
- Functionality: Renders terrain-following tire trails from grounded vehicle motion behind the front and rear axles.
- Differs from GameBlocks: Segment logic is verbatim; the dynamic ring-buffer BufferGeometry becomes one BeamPool per track (the host owns quad expansion), maxSegments is capped at 256 per track, polygonOffset is replaced by the terrain lift, and the constructor gains `scene`.

### `modules/world/visual-effects/weapon-effects-system.ts`
- Functionality: Renders short-lived visual feedback for weapon fire and impacts: pooled additive tracer beams and hit-burst particle sprites.
- Differs from GameBlocks: The per-slot CPU sim is verbatim; LineSegments → BeamPool and Points → SpritePool with the vertex-color fade carried in per-entry pool colors, pools are rebuilt per frame and shipped by the owner's `scene.flush()`, and the constructor gains `scene`.
