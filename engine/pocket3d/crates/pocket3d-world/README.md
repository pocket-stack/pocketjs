# pocket3d-world

`pocket3d-world` is the renderer-independent fixed-step simulation layer for
Pocket3D games. It owns stable entities, sphere and upright-capsule bodies,
attachments, structural damage, heat, retained water, fuel, and combustion.
Games submit interactions, advance one turn, consume ordered events, and map
the resulting state into any renderer.

## Fixed turn

Each call to `World::step` performs the same ordered phases:

1. Consume queued cuts, impulses, ignition, and water inputs.
2. Synchronize attached entities with their parents.
3. Integrate environmental exchange, heat transfer, evaporation, and fuel.
4. Integrate dynamic bodies, advance kinematic locomotion, and solve contacts.
5. Apply contact damage, resynchronize attachments, and commit fractures.
6. Return ordered events and the state hash.

**Stable entity IDs, deferred structural changes, and a seeded RNG determine
the result.** A seed, configuration, initial snapshot, and interaction stream
replay to the same state hash on the same target and build.

## Heat, water, and fuel

**Retained water and dry material share one energy budget.** A `Douse`
interaction adds normalized water mass at `WorldConfig::water_inlet_temperature_c`.
The dry material heat capacity and `water_specific_heat` determine the mixed
temperature. Evaporation removes the water's sensible heat plus
`water_vaporization_heat`, and cannot exceed the available thermal energy.

**Combustion heat is funded by consumed fuel.** A turn releases
`fuel_consumed * ReactiveMaterial::heat_output`; the configured local fraction
stays in the source and the remaining fixed budget is divided among nearby
receivers. Adding receivers cannot duplicate emitted energy.

## Solver changes

**Shared solvers do not branch on entity IDs, tags, recipes, or scenarios.** A
fix to collision, integration, attachments, structures, or reactions changes a
general rule, states the invariant that rule preserves, and tests the invariant
across at least two entity configurations, material combinations, or collider
combinations. Scenario regressions are additional coverage, not the proof of a
shared rule.

The current narrow phase is a single discrete sphere/capsule pass, and reactive
pair checks are quadratic in active entity count. High-speed continuous
collision, stable large stacks, spatial partitioning, and cross-architecture
bitwise replay are outside the current contract.


## Surface locomotion

Add `Locomotion::default()` to a kinematic sphere or capsule and submit
`LocomotionInput` before `World::step`. The world owns movement, contact
projection, gravity, slope limits, surface anchors and normalized stamina.
Inputs, configuration and state are included in snapshots and state hashes;
old snapshots default to no motor. Apps own key bindings and animation selection.

**Movement is tangent to an available support and cannot enter nearby solid
geometry.** Walkable normals use `min_ground_dot`; steeper surfaces require
held grip and sufficient support force. Grip acceleration times surface friction
must support tangential gravity. Retained moisture (or ambient moisture on
terrain) reduces effective grip by up to 85%; temperatures above the configured
threshold prevent grip. These are geometry/material rules, independent of names,
tags, recipes or scenarios. Sphere and rotated capsule surfaces share the rigid
body narrow-phase geometry. Terrain coefficients come from `Environment::surface`.

Release, jump, missing support or exhausted stamina return to gravity-driven
movement. Grounded contact replenishes stamina. A local support anchor follows
translation and rotation; jumping consumes an edge command and temporarily
prevents regripping. Radius-bounded substeps and iterative projections prevent
ordinary high-speed motor movement from tunneling through thin spheres/capsules.
The motor is Y-up, uses a heightfield for terrain, and remains kinematic: it
blocks against rigid bodies rather than transferring a physically simulated
actor mass. Full rigid-body CCD and arbitrary concave terrain are outside this
contract. Teleporting supports should be handled as explicit world edits.

`locomotion::tests` covers sphere/capsule actors, capsule/terrain climbing,
walk/slide limits, wet/hot supports, jump, exhaustion, moving/removed support,
fast motion and exact snapshot replay. It runs without a renderer or GPU.
