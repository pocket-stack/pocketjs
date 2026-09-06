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
4. Integrate dynamic bodies and solve ground and body contacts.
5. Apply contact damage, resynchronize attachments, and commit fractures.
6. Return ordered events and the state hash.

**Stable entity IDs, deferred structural changes, and a seeded RNG determine
the result.** A seed, configuration, initial snapshot, and interaction stream
replay to the same state hash on the same target and build.

## World laws

`WorldLawRuntime` is a separate hidden-world transaction store for fictional
or otherwise non-physical ontologies. It provides typed hidden values,
persistent weighted relations, finite spherical fields, deferred transitions,
projection/materialization events, snapshots, and deterministic hashes. Games
define law packs and translate their projections into ordinary `World`
interactions; the runtime does not name characters, recipes, or scenarios.

Opposing fields on the same channel cancel only inside their shared volume.
`spherical_barrier_projection` maps a locally resolved finite field budget to
an ordinary body impulse. It changes only inward normal motion, leaves
tangential motion untouched, never increases kinetic energy, and removes no
more than either the incoming normal kinetic energy or the field budget. The
contract is tested with two mass, speed, and radial-extent configurations.

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
