# Platform contracts

PocketJS keeps application intent separate from host facts. An app writes
`pocket.json`; PocketJS owns a profile for each stock target. The resolver
combines them once, writes a small target-specific `ResolvedBuildPlan`, and all
later build stages consume that answer.

```text
  pocket.json           target profile
  (app intent)          (host facts)
       └──────── resolve ────────┘
                    │
                    ▼
       .pocket/<target>/plan.json
          small ResolvedBuildPlan
             ┌──────┴──────┐
             ▼             ▼
        JS compiler    native backend
```

This is a build-contract boundary, not a general-purpose platform type system.
It prevents platform decisions from being rediscovered in the compiler,
Cargo, packagers, and custom hosts.

## Ownership

| Data | Owner | Meaning |
|---|---|---|
| `pocket.json` | App | Entry, framework, logical viewport, required and optional APIs |
| Capability registry | PocketJS | Names of framework APIs that can be requested |
| Target profile | Stock host | Host ABI, display facts, and APIs actually implemented and tested |
| `ResolvedBuildPlan` | Resolver | One build's target-specific inputs |
| Backend | PocketJS or custom host | How those inputs become an EBOOT, VPK, or another package |

Apps never claim what a device provides. Profiles never advertise raw hardware
specifications that the PocketJS host does not expose. Generic build stages do
not branch on a target name after resolution.

## Application manifest

Format 2 is strict JSON data. A PSP-shaped portable app can say:

```json
{
  "$schema": "https://pocketjs.dev/schema/pocket-2.json",
  "pocket": 2,
  "id": "dev.pocket-stack.telemetry",
  "name": "pocket-telemetry",
  "title": "Pocket Telemetry",
  "version": "1.0.0",
  "engine": {
    "capabilities": {
      "requires": ["text.glyphs.baked", "input.buttons"],
      "enhances": ["input.analog.left"]
    }
  },
  "app": {
    "entry": "app/main.tsx",
    "output": "main",
    "framework": "solid",
    "viewport": { "logical": [480, 272], "presentation": "integer-fit" }
  }
}
```

The manifest contains no physical resolution, scale factor, Vita flag, native
crate path, or host ABI. Those are framework-owned facts.

`requires` is the compatibility floor. Resolution fails before compilation if
the selected host does not provide one of those APIs. `enhances` declares an
optional API for which the app has a fallback. Its availability becomes a
boolean in the plan and in the compiled runtime module:

```ts
import { hasFeature } from "@pocketjs/framework/platform";

if (hasFeature("input.analog.left")) {
  installAnalogNavigation();
} else {
  installButtonNavigation();
}
```

Literal `hasFeature()` calls are target-specialized during compilation, so Bun
can remove an unavailable branch from the bundle. `platform.features` remains
the runtime surface for computed feature ids and introspection. Capability ids
are plain strings, not versioned tokens or permissions passed through
application call graphs.

## What a capability means

A capability means:

> This stock host implements and tests this PocketJS framework API.

It does not mean that hardware merely contains a component. Vita advertises
touch only because the stock host now samples the front panel, maps contacts to
logical viewport coordinates, and delivers the public `touches()` API.

It also does not model mobile permissions or live device state. Those are
different questions:

- **Host API support** is a build-time capability.
- **Permission or entitlement** needs its own declaration and runtime result.
- **Runtime availability** such as window size, fold state, or an attached
  controller must be queried at runtime.

`input.touch` means that the API and delivery path exist. It does not mean a
finger is currently down: `touches()` returns an empty snapshot in that state.
An application can put touch in `enhances` and keep its button fallback for
PSP, or put it in `requires` when touch is fundamental to the product.

## Target profiles

Profiles are small, truthful records:

```ts
vita: {
  hostAbi: 2,
  display: {
    physicalViewport: [960, 544],
    logicalViewports: [[480, 272]],
    presentations: ["integer-fit"],
    rasterDensity: 2,
  },
  capabilities: ["input.analog.left", "input.buttons", "input.touch", "text.glyphs.baked"],
}
```

DrawList is intentionally absent. It is PocketJS's internal core-to-backend IR,
not behavior an application can observe or request. GE, GXM, WGPU, and software
raster hosts may consume that IR while offering the same public UI semantics.

`rasterDensity` is also not a capability. It is a target-owned rendering fact:
layout and DrawList coordinates remain logical, while font coverage, SVGs,
core masks, and target-selected image variants use that many raster samples per
logical pixel. Dynamic texture producers receive the same resolved value as
`platform.pixelRatio`; neither compiler nor application needs a Vita branch.

There is no capability-parameter comparison DSL. If PocketJS later exposes a
meaningfully different API, it can receive a new identifier once that API is
real. The registry remains data; specialized compatibility rules should live
with the feature that needs them, not in a universal constraint language.

## Resolution and PSP-to-Vita compatibility

The resolver performs the same steps for every registered target:

1. Validate `pocket.json` against the format-2 JSON Schema.
2. Find the selected target profile.
3. Reject unknown, duplicate, or unavailable required capabilities.
4. Resolve declared enhancements to booleans.
5. Validate the target raster density, logical viewport, and presentation mode.
6. Produce and checksum the build plan.

A PSP-oriented app is not a PSP-only app. The manifest above resolves for Vita
unchanged because Vita provides the same required APIs and accepts the same
480×272 logical viewport:

```text
PSP:  logical 480×272 → physical 480×272
      raster density 1
Vita: logical 480×272 → physical 960×544
      raster density 2
```

No `vita` stanza is needed. Compatibility is determined by requirements and
viewport rules, not by a target allowlist. A Vita app that treats touch as an
enhancement retains its button fallback for PSP; if it makes touch a
requirement, the PSP build fails during resolution.

## The small build plan

The generated plan is cross-process build IR, not public app configuration:

```json
{
  "app": { "id": "dev.pocket-stack.telemetry", "title": "Pocket Telemetry",
           "entry": "app/main.tsx", "output": "main", "framework": "solid" },
  "target": { "id": "vita", "hostAbi": 2 },
  "viewport": { "logical": [480, 272], "physical": [960, 544],
                "presentation": "integer-fit", "rasterDensity": 2 },
  "features": { "input.analog.left": true },
  "planHash": "sha256:…"
}
```

Serialization matters because PocketJS crosses Bun, the JS compiler, Cargo,
stock native crates, and downstream custom hosts. `.pocket/<target>/plan.json`
gives each stage the same debuggable input.

`planHash` is only a checksum of this generated build IR. It detects an edited
or partially copied plan and can support build caching. It is not a runtime
compatibility hash, a signature, an attestation, or a trust chain. Application
identity and title are present because package backends consume them; icons,
toolchain provenance, and other fields without a real consumer do not belong
in the plan merely to make its hash look comprehensive. The Vita backend maps
the portable reverse-DNS app id deterministically to a nine-character title id
instead of keeping a per-demo target table.

## Consumers and backend dispatch

Target selection happens once at a typed backend boundary:

```ts
const targetBackends = { psp: pspBackend, vita: vitaBackend }
  satisfies Record<PocketTargetId, TargetBackend>;

function dispatchTarget(target: PocketTargetId, context: TargetBackendContext) {
  return targetBackends[target](context);
}

await dispatchTarget(validatedTarget, context);
```

PSP and Vita still have different native commands and packages. The registry
makes that difference explicit and exhaustive while keeping the resolver and
compiler target-neutral. After dispatch, a backend reads resolved fields; it
does not recalculate physical dimensions or output names from the target id.
`validatedTarget` is the request target accepted by the registry-backed
resolver; the serialized plan deliberately keeps its cross-process id as a
string rather than pretending arbitrary custom-host plans share the stock
target union.

The complete `ResolvedBuildPlan` is internal and may evolve. Custom hosts use
the smaller stable boundary instead:

```ts
import { extractHostBuildInputs, hostBuildEnvironment }
  from "@pocketjs/framework/manifest";

const inputs = extractHostBuildInputs(planJson, { expectedTarget: "vita" });
const env = hostBuildEnvironment(inputs, {
  outputDirectory: "dist/pocket/vita",
  embedApp: false,
});
```

This verifies the plan checksum, exposes only host build inputs, and produces
the shared Cargo environment without downstream code duplicating Plan parsing.

## Runtime and TypeScript checks

At startup, a manifest-driven bundle verifies only the native target id and
HostOps ABI. Those are the runtime compatibility facts. Stock builds embed the
JS and native host together, so repeating the whole build plan as a runtime
hash would make unrelated build metadata part of the wire contract.

`bun pocket check`, `compile`, and `build` type-check the app entry and its
reachable imports with the app's ordinary TypeScript configuration. There is
no generated ambient target module, branded capability token, or special
reachability authorization model. Optional APIs are ordinary guarded feature
checks; the manifest provides the build-time compatibility guarantee.
`platform.pixelRatio` is an ordinary build-defined number for code that must
produce raster data at runtime; it does not change layout units or API
availability.

## Deliberate non-goals

This contract does not currently include:

- a capability-token programming model;
- capability versions or a generic parameter constraint DSL;
- a full-plan runtime hash, signing, or supply-chain attestation;
- package fields whose backends do not consume them;
- dynamic-text APIs before their host implementations exist;
- a claim that fixed PSP/Vita profiles model dynamic mobile device conditions.

Those concerns can gain separate contracts when PocketJS has concrete APIs and
consumers for them. They do not need to complicate today's PSP/Vita build IR.

Schema/resolver tests, byte-exact plan fixtures, ordinary TypeScript checks,
native target/ABI checks, and PSP/Vita golden E2E tests cover this contract.
