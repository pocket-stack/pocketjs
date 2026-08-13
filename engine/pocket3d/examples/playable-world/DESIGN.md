# Playable-world runtime design

## Scope

The example proves that Pocket3D can host a small world whose objects share
the same physical and reactive rules. It includes a controllable explorer,
apple trees, detachable fruit, an axe, rigid bodies, heat, moisture,
combustion, cooking, and fire propagation.

**`pocket3d-world` owns simulation state and has no GPU, window, or asset
dependency.** The example owns the orchard recipe, input mapping, procedural
art, camera, particles, and HUD. `pocket3d` owns rendering and application
hosting. An object can therefore be simulated headlessly, rendered by another
backend, or configured by a future guest without moving authoritative state
out of the Rust runtime.

## Runtime data

Every object has a stable `EntityId` and a transform. Optional records add
behavior:

- `Body` and `Collider` determine motion and contacts.
- `PhysicalSurface` contains friction and restitution.
- `Attachment` keeps fruit or tools relative to a parent until released.
- `Structure` accumulates directed damage and emits a fracture event.
- `ReactiveMaterial` contains heat capacity, conductivity, ignition, and
  burn-rate parameters.
- `ReactiveState` contains temperature, moisture, fuel, and cooking progress.

**Physical surface properties and reactive material properties are separate.**
A wet apple can have the same bounce as a dry apple while requiring more heat
to ignite. A stone can conduct heat without holding fuel. The renderer reads
the resulting state but does not decide whether an object burns or breaks.

## Fixed update

One simulation turn uses this order:

1. Consume queued player interactions and apply impulses, cuts, ignition, or
   water.
2. Resolve attachments from parent transforms.
3. Sample ambient temperature, moisture, wind, and ground height.
4. Transfer heat, evaporate moisture, ignite eligible fuel, and consume fuel.
5. Integrate dynamic bodies and resolve ground and body contacts.
6. Commit fractures and attachment releases.
7. Sort and publish contact and state-transition events.

**The entity store is traversed by stable ID, structural changes are deferred,
and random values come from a seeded generator.** A seed plus an interaction
script produces the same state hash and ordered event sequence.

Physics callbacks do not directly run game behavior. They produce contact
records containing both IDs, position, normal, impulse, and both physical
surfaces. Structure and reaction rules consume these records in their assigned
phase. This prevents a contact insertion order from changing the result.

## Orchard composition

The orchard uses the generic records without tree-specific branches in the
runtime:

- A standing tree has a static capsule body, fuel, and a `Structure` record.
- Apples have sphere bodies attached at authored local offsets.
- Axe contact queues directed structural damage and an impulse.
- Fracture changes the tree body to dynamic and releases its attached apples.
- The stump is presentation geometry retained at the fracture position.
- Fire is a hot reactive entity with a spatial collider, fuel, and a short
  visual particle trail.
- Heat cooks an apple before sustained heat chars it. Moisture absorbs heat
  and evaporates before dry fuel can ignite.

The fallen trunk remains a normal body and reactive object. It can roll,
collide, heat nearby fruit, propagate fire, exhaust its fuel, and cool down.

## Presentation

Environment meshes are generated from mathematical primitives in this
repository. The scene uses reusable assets with per-instance transforms and
tints for terrain, trunk, canopy, apple, rock, grass, and shadow discs. Fire
and embers use the additive sprite pass.

**The explorer uses Pocket3D's normal glTF skin and clip path.** A reproducible
Blender generator authors the face, hair, clothing layers, hands, boots, axe,
19-joint armature, and `Idle`, `Walk`, and `Chop` actions. The self-contained
GLB is embedded in the executable and loaded through `ModelAsset`; the example
does not define a second animation renderer.

The simulation places the player capsule center at `ground + PLAYER_HEIGHT`.
The presentation transform separately maps the model's authored rest-pose
minimum Y to the sampled terrain height. **The collision origin stays at the
capsule center while the rendered feet stay on the ground plane.** Camera focus
is derived from that visual foot position.

Animation selection is deterministic: an active chop overrides walking, a
nonzero planar velocity selects walking, and the remaining state selects idle.
The axe is part of the same skin and is rigidly weighted to `axe.R`, below the
right hand, so hand, forearm, upper-arm, and axe motion share one sampled pose.

The Pocket3D lighting extension is opt-in. The example enables diffuse bands,
wrapped light, rim light, warm/cool ambient balance, and distance fog. Existing
Pocket3D scenes retain their previous defaults.

**A PNG is rendering evidence, not simulation evidence.** The headless command
also writes a receipt with the seed, tick count, state hash, ordered events,
tree state, detached-fruit count, temperatures, fuel, and cooking state.
The Blender receipt separately records asset topology, bone and clip contracts,
rest-pose ground contact, hand and axe travel, and self-contained GLB checks.

## Growth path

The POC keeps the contracts needed for larger worlds while using intentionally
small algorithms:

- Replace pairwise collider checks with a deterministic spatial grid while
  retaining the same contact records.
- Add sleeping islands and per-system budgets before increasing active-body
  counts.
- Store entity recipes separately from state snapshots; version both schemas.
- Stream chunks through deferred spawn and despawn commands at fixed-turn
  boundaries.
- Add shape casts, oriented boxes, joints, and continuous collision behind the
  existing body and contact interfaces.
- Expose commands, queries, and ordered events to a PocketJS guest while
  keeping collision and reactions authoritative in Rust.
- Batch repeated meshes in the renderer and cull against the camera before
  increasing vegetation density.
- Add animation cross-fades and upper-body action layers while retaining the
  current named-clip contract and fixed-step gameplay state.
- Define renderer feature tiers for desktop wgpu, GLES2, PSP GU, and Vita GXM;
  do not assume the desktop shader path is available on device backends.

The next performance milestone should be stated as an active-entity and
contact budget with captured frame time and memory, not as a map-size claim.
