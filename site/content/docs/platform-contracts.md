# Platform contracts

PocketJS separates an application's portable intent from the facts of a
particular device host. The app writes a **manifest**. The framework owns
**target profiles**. A resolver combines those inputs into one immutable,
target-specific **ResolvedBuildPlan**, and every later build stage consumes
that same plan.

This page explains why that extra object exists, how it prevents platform
conditionals from spreading through the codebase, what is guaranteed today,
and which parts of the future capability DX are still prototypes.

## The short version

```text
                 app-owned                    framework-owned
              ┌──────────────┐              ┌─────────────────┐
              │ pocket.json  │              │ target profile  │
              │ requirements │              │ provided facts  │
              └──────┬───────┘              └────────┬────────┘
                     └──────────────┬────────────────┘
                                    ▼
                        schema + semantic resolution
                                    │
                                    ▼
                         target-specific TypeScript
                                    │
                                    ▼
                    .pocket/<target>/plan.json
                       (hashed ResolvedBuildPlan)
                         ┌──────────┴──────────┐
                         ▼                     ▼
                    JS/pak compiler       native backend
                         │                     │
                         └──────────┬──────────┘
                                    ▼
                         runtime hash handshake
```

The manifest says **what the app needs**. A target profile says **what a
framework-owned host actually provides**. The plan records **the one resolved
answer used for this build**.

The important design rule is not “never mention a target name.” PSP and Vita
really do have different native backends. The rule is:

> Target names belong at registry and backend boundaries. Portable app code
> and generic compiler stages depend on capabilities and resolved values.

## Terms and authority

| Object | Written by | Authority | Committed? |
|---|---|---|---|
| `pocket.json` | Application author | Identity, entry, framework, logical viewport, required and optional capabilities, package overrides | Yes |
| Capability registry | PocketJS | Names, versions, parameters, and parameter comparison rules | Yes |
| Target profile | PocketJS host owner | Host ABI, physical display, supported logical viewports, provided capabilities, package defaults | Yes |
| `ResolvedBuildPlan` | Resolver | The complete target-specific answer for one build | No; generated under `.pocket/` |
| Backend implementation | PocketJS or a custom host | How resolved artifacts become an EBOOT, VPK, or another package | Yes |
| Native host identity | Packaged binary | Target, HostOps ABI, and plan hash actually present at runtime | Embedded in the binary |

These ownership boundaries are deliberate:

- Applications may request capabilities; they may not claim that hardware
  provides them.
- Target profiles may advertise only behavior implemented and tested by their
  stock hosts.
- Compiler and native backends may consume a plan; they may not reinterpret or
  override its framework, target, ABI, or output name.
- Machine-local paths such as an output directory are build execution state,
  not portable contract data, and therefore do not enter the plan hash.

## The manifest: portable intent

`pocket.json` format 2 is a strict, pure-data application contract. A minimal
portable PSP-shaped application looks like this:

```json
{
  "$schema": "https://pocket-stack.dev/schema/pocket-2.json",
  "pocket": 2,
  "id": "dev.pocket-stack.telemetry",
  "name": "pocket-telemetry",
  "title": "Pocket Telemetry",
  "version": "1.0.0",
  "engine": {
    "abi": 1,
    "capabilities": {
      "requires": [
        { "id": "ui.drawlist", "version": 1 },
        { "id": "text.glyphs.baked", "version": 1 },
        { "id": "input.buttons", "version": 1 },
        {
          "id": "input.analog",
          "version": 1,
          "parameters": { "sticks": 1 }
        }
      ]
    }
  },
  "app": {
    "entry": "app/main.tsx",
    "output": "main",
    "framework": "solid",
    "simulationHz": 60,
    "viewport": {
      "logical": [480, 272],
      "presentation": "integer-fit"
    }
  }
}
```

Notice what is absent:

- no physical screen size;
- no scale factor;
- no Vita boolean;
- no native crate path or build command;
- no assertion that a device has a particular input API.

Those are target or backend facts, not application intent.

### `requires` and `enhances`

`requires` is the hard compatibility floor. If a selected target cannot
satisfy one entry, resolution fails before the compiler or Cargo runs.

`enhances` represents an optional capability for which the app has a fallback.
Resolution records each enhancement as `available` or `unavailable`; it does
not reject an otherwise compatible target.

```json
{
  "requires": [
    { "id": "input.buttons", "version": 1 }
  ],
  "enhances": [
    { "id": "input.touch", "version": 1, "parameters": { "points": 2 } }
  ]
}
```

The example describes the intended future shape. `input.touch` is not in the
production capability registry today, so this exact manifest currently fails
with `capability.unknown`. A capability definition and a real API must land
before any target may advertise it.

### Package entries are not a target allowlist

`packages.psp` and `packages.vita` override deterministic target packaging
defaults. Their presence does not mean “this app supports only these targets,”
and their absence does not disable a target.

Compatibility is computed from:

```text
app requirements × target-provided capabilities × viewport compatibility
```

This distinction is what lets an old PSP-oriented manifest compile for Vita
without adding an empty `packages.vita` stanza merely to opt in.

## Target profiles: framework-owned facts

The registry in `spec/platforms.ts` has two levels.

The capability registry defines the vocabulary and comparison semantics:

```ts
"input.analog": {
  version: 1,
  parameters: {
    sticks: {
      kind: "integer",
      required: true,
      relation: "at-least",
      minimum: 1,
    },
  },
}
```

The target registry declares what each stock host provides:

```ts
vita: {
  profileVersion: 1,
  hostAbi: 1,
  display: {
    physicalViewport: [960, 544],
    logicalViewports: [[480, 272]],
    presentations: ["integer-fit", "stretch"],
  },
  capabilities: {
    "input.analog": { version: 1, parameters: { sticks: 1 } },
    "input.buttons": { version: 1 },
    "text.glyphs.baked": { version: 1 },
    "ui.drawlist": { version: 1 },
  },
}
```

The current Vita profile intentionally advertises one stick, not two. Vita
hardware has more input than that, but the stock PocketJS frame ABI currently
delivers only the left stick. A target profile describes the tested host API,
not a hardware marketing sheet.

That truthfulness rule prevents this failure mode:

```text
hardware exists → profile claims feature → typecheck passes
                                  ↓
                 runtime never delivered the data
```

## Resolution: requirements meet facts

The resolver in `src/manifest/resolve.ts` is target-generic. It does not have a
PSP branch and a Vita branch. Given a registry entry, it applies the same rules:

1. Validate the manifest against the format-2 JSON Schema.
2. Find the requested target profile.
3. Compare `engine.abi` with the target `hostAbi`.
4. Validate capability ids, versions, parameters, and duplicates.
5. Ensure every required capability is provided.
6. Resolve every enhancement to available or unavailable.
7. Validate logical viewport and presentation against the display profile.
8. Compute exact rational X/Y scale values.
9. Merge target package defaults with app overrides.
10. Produce and hash a canonical plan.

Capability parameters carry an explicit relation. For `sticks`, `at-least`
means a host providing two sticks can satisfy an app requiring one. Equality
parameters require an exact value. These comparison rules live in the registry
rather than being hidden in target conditionals.

### PSP baseline resolved for Vita

For the manifest above, PSP resolution produces:

```text
logical  480 × 272
physical 480 × 272
scale    1/1 × 1/1
```

The same manifest resolved for Vita produces:

```text
logical  480 × 272
physical 960 × 544
scale    2/1 × 2/1
```

No app source or platform stanza changes. The target profile supplies the
physical facts, and the plan records the result.

If the app requests `input.analog { sticks: 2 }`, both current PSP and Vita
profiles fail with `capability.unavailable`. The resolver does not silently
degrade a hard requirement.

## The plan: target-specific build IR

The resolved plan is best understood as target-specific build intermediate
representation, not as another user configuration file.

```json
{
  "pocket": 2,
  "app": {
    "id": "dev.pocket-stack.telemetry",
    "entry": "app/main.tsx",
    "output": "main",
    "framework": "solid",
    "viewport": {
      "logical": [480, 272],
      "presentation": "integer-fit"
    }
  },
  "target": {
    "id": "vita",
    "profileVersion": 1,
    "hostAbi": 1
  },
  "viewport": {
    "logical": [480, 272],
    "physical": [960, 544],
    "presentation": "integer-fit",
    "scale": {
      "x": { "numerator": 2, "denominator": 1 },
      "y": { "numerator": 2, "denominator": 1 }
    }
  },
  "capabilities": {
    "requires": [],
    "enhances": []
  },
  "contractHash": "sha256:…"
}
```

The real plan includes resolved capability and package records omitted from
this shortened example. It is written to:

```text
.pocket/psp/plan.json
.pocket/vita/plan.json
```

### Why serialize it?

If validation, compilation, and packaging all happened inside one process, a
resolved object could remain in memory. PocketJS crosses several process and
repository boundaries:

- Bun orchestration;
- the TypeScript/JS and asset compiler;
- Cargo and `build.rs`;
- stock native runtimes;
- downstream custom hosts such as Pocket Figma and OpenStrike.

Serializing the plan gives each consumer the same immutable input and leaves a
debuggable artifact when a build fails.

The essential abstraction is the canonical resolved contract. `plan.json` is
its transport format.

### What the plan is not

- **Not a dependency lockfile.** Cargo and package lockfiles still select code
  versions.
- **Not a build script.** It contains data, not commands.
- **Not a cache key for machine paths.** `POCKETJS_OUTPUT_DIR` is deliberately
  outside the plan.
- **Not app-authored.** Editing a generated plan is unsupported. Plan-reading
  consumers verify its hash, and native consumers receive that verified hash
  for the runtime handshake.
- **Not a target allowlist.** Target compatibility comes from resolution.

## Why manifest alone is insufficient

It is possible to build without a serialized plan, but then every stage tends
to reinterpret the manifest independently:

```ts
// compiler
if (target === "vita") scale = 2;

// package script
if (target === "vita") output = "main";

// custom host
const hostAbi = 1;
```

The values look harmless in isolation. Together they create multiple sources
of truth. Common failures include:

- validation checks one profile while packaging uses another;
- JS output naming differs from the file embedded by Cargo;
- the compiler uses a 480×272 viewport while native rendering assumes a
  different scale;
- a custom host copies or symlinks framework-local artifacts to satisfy a
  hard-coded path;
- a stale native binary boots a newly compiled bundle;
- platform handling spreads as unrelated `if (target === …)` branches.

Resolving once does not remove platform differences. It prevents later stages
from making new platform-policy decisions.

## Where target branching is allowed

PocketJS contains platform dispatch in one typed backend registry:

```ts
const targetBackends = {
  psp: pspBackend,
  vita: vitaBackend,
} satisfies Record<PocketTargetId, TargetBackend>;

await targetBackends[plan.target.id](context);
```

This is intentional. PSP packaging needs `cargo psp`; Vita packaging needs
`cargo vita`. A typed registry provides two useful properties:

- adding a target without adding a backend is a TypeScript error;
- generic resolver/compiler code never grows a platform switch.

After dispatch, a backend reads resolved values:

```ts
const [logicalWidth, logicalHeight] = plan.viewport.logical;
const [physicalWidth, physicalHeight] = plan.viewport.physical;
const abi = plan.target.hostAbi;
```

It does not recalculate them from the target name.

### File suffixes still have a place

React Native-style platform suffixes answer “which implementation file should
this target compile?” They are useful *inside* a backend or component that
truly has different implementations.

They do not answer:

- whether a target satisfies an app's requirements;
- what viewport and scale were selected;
- whether an optional capability has a fallback;
- whether JS and native packaging used the same contract.

PocketJS therefore uses capability resolution for compatibility and explicit
backend modules for implementation. Suffixes could be added as backend-local
source selection later without replacing the manifest/plan model.

## Target-specific TypeScript

After resolution, `compiler/target-check.ts` checks only the app entry's
reachable import graph. It inherits compiler options and path mappings from the
app's `tsconfig`, but deliberately does not inherit a broad project `include`.

The checker generates a virtual `@pocketjs/framework/target` ambient module
containing branded capability tokens for that one build:

```ts
declare module "@pocketjs/framework/target" {
  export type TargetName = "psp";

  export const capabilities: {
    readonly "input.buttons@1": CapabilityToken<"input.buttons@1">;
  };

  export const enhancements: {
    readonly "input.touch@1":
      | CapabilityToken<"input.touch@1">
      | undefined;
  };
}
```

This proves several type-system properties in tests:

- host availability alone does not authorize an undeclared capability;
- required capabilities are non-optional tokens;
- unavailable enhancements become `Token | undefined`;
- unguarded enhancement use fails only for targets where it is unavailable;
- a guarded enhancement checks for both the base and enhanced targets.

The intended authoring shape is:

```ts
import { capabilities, enhance, useCapability }
  from "@pocketjs/framework/target";

useCapability(capabilities["input.buttons@1"]);

enhance("input.touch@1", (touch) => {
  useCapability(touch);
  // Install touch-specific behavior here; button fallback remains outside.
});
```

### Current status of the token API

The generated module and the compile-time behavior above are exercised by
`test/target-check.test.ts`. They are not yet a published runtime module or a
compile-erased virtual module in the production bundler.

Consequently, target-specific TypeScript checking itself is production and
runs for every `bun pocket check/compile/build`, but application imports from
`@pocketjs/framework/target` are currently an executable prototype of the
future capability-gated DX. Shipping touch or dynamic-text APIs requires
finishing that bundler/runtime boundary rather than merely adding profile data.

This distinction is important: a type design test is evidence that the model
can express safe degradation, not evidence that the public API has shipped.

## Compiler and native consumers

`scripts/pocket.ts` owns orchestration:

```sh
bun pocket check   --target vita
bun pocket compile --target vita
bun pocket build   --target vita -- --release
```

All three commands perform schema validation, resolution, and target-specific
TypeScript checking, then write the verified plan.

- `check` stops there.
- `compile` also produces JS and pak artifacts; it is the boundary for custom
  native hosts.
- `build` continues into the registered stock target backend.

The low-level `scripts/build.ts` path remains available for framework tests and
legacy demos. A manifest-driven product build should use `bun pocket` so the
compiler receives a verified plan.

### Plan-owned and execution-owned environment

The shared native-build boundary can receive two categories of data. Vita and
custom hosts consume the viewport fields shown below. The current stock PSP
backend has a fixed 480 × 272 surface and does not yet forward those viewport
environment variables.

Contract data originates in the plan:

```text
POCKETJS_APP_OUTPUT
POCKETJS_TARGET
POCKETJS_HOST_ABI
POCKETJS_CONTRACT_HASH
POCKETJS_LOGICAL_WIDTH / HEIGHT
POCKETJS_PHYSICAL_WIDTH / HEIGHT
```

Execution data describes who packages artifacts and where they live:

```text
POCKETJS_EMBED_APP
POCKETJS_OUTPUT_DIR
```

`POCKETJS_OUTPUT_DIR` is not hashed because an absolute path differs across
machines without changing the application/host contract.

`POCKETJS_EMBED_APP=1` means the stock PocketJS runtime is the primary package
and should embed the JS/pak pair. A custom host sets it to `0`: the reusable
PocketJS native crate provides HostOps and the custom primary crate embeds the
app. This prevents a dependency build script from reading PocketJS's own
unrelated `dist/` directory.

## Runtime handshake

A successful build does not prove that the correct JS and native files will be
installed together. PocketJS therefore carries the resolved identity into both
sides of the package.

The JS bundle contains:

```text
target id
HostOps ABI
contract hash
```

The native host publishes the same values on `globalThis.ui`:

```text
ui.__host
ui.__hostAbi
ui.__contractHash
```

Before app mount, `src/host.ts` checks all three. A Vita bundle under a PSP
host, a host ABI mismatch, or a stale plan hash fails before application code
starts mutating the UI tree.

Injected web/WASM/test hosts remain a separate ownership kind. They are not
mistaken for native merely because they install `globalThis.ui`; native hosts
self-identify with `__host`.

The hash proves plan identity, not binary reproducibility. Two compilers could
still produce different bytes from the same plan. Byte-exact golden tests and
toolchain lockfiles cover that separate concern.

## Version axes

Several versions coexist because they answer different questions:

| Version | Question |
|---|---|
| Manifest format (`pocket: 2`) | Can this parser understand the document shape? |
| Capability version | Does the app and host agree on one feature contract? |
| Capability parameters | Does the provided quantity/mode satisfy this request? |
| Target `profileVersion` | Which revision of framework-owned target facts was resolved? |
| `hostAbi` | Does the JS/native HostOps wire contract match? |
| `contractHash` | Did every build stage consume this exact resolved plan? |

Bumping one does not imply bumping all of them. Adding a package default might
change `profileVersion` and plan hash without changing HostOps ABI. Changing
the frame input wire shape requires a `hostAbi` bump. A breaking touch API
requires a capability-version bump.

## Adding another target

Adding 3DS, Linux handheld, Android foldable, iOS, or another device should be
a registry/backend exercise rather than an app-schema fork.

1. Implement the native host behavior.
2. Add capability definitions only for APIs with a real framework contract.
3. Register a truthful target profile: ABI, display modes, capabilities, and
   package defaults.
4. Add target package override schema only for metadata genuinely unique to
   that package format.
5. Register a backend. The exhaustive `Record<PocketTargetId, TargetBackend>`
   makes omission a compile error.
6. Publish target/ABI/hash from the native HostOps namespace.
7. Add byte-exact resolved-plan fixtures and negative capability tests.
8. Add native build, runtime handshake, input, viewport, and golden E2E proof.

Do not add `oneOf` branches that turn the entire manifest into a PSP document,
a Vita document, an Android document, and so on. That model duplicates common
application fields and makes multi-target intent a cross-product of schemas.

Target-specific package metadata can remain target keyed because it is already
behind the packaging boundary. Compatibility remains capability based.

## Custom hosts and extensions

Pocket Figma and OpenStrike use `bun pocket compile`, read the public
`ResolvedBuildPlan` type from `@pocketjs/framework/manifest`, and hand the same
contract values to their custom primary crates.

The current platform registry describes the framework-owned stock HostOps
surface. OpenStrike's Pocket3D/`strike` extension is not falsely advertised as
a stock PSP or Vita capability; its Rust host composition owns that additional
contract.

This is honest but not yet the final extension model. A future first-class
custom-host profile must answer who is trusted to augment target capabilities
without allowing an application to self-assert unsupported APIs. Likely design
space includes a signed/registered host profile or a typed build-plugin input;
the app manifest itself should not gain authority to declare provision.

## Current implementation boundaries

The core contract path is implemented and validated today:

- strict format-2 schema and diagnostics;
- generic capability/viewport/package resolution;
- deterministic plan canonicalization and hash verification;
- PSP and Vita target profiles;
- per-entry, per-target TypeScript execution;
- plan-consuming JS compiler and stock/custom native builds;
- JS/native target, ABI, and hash handshake;
- typed backend registry;
- PSP/Vita resolved-plan fixtures and native golden E2E.

The following areas remain intentionally incomplete or deserve further design:

1. **Capability token bundling.** The virtual target module is currently a
   type-check prototype, not a public runtime/compile-erased module.
2. **Touch and dynamic text.** Neither capability nor public API is registered
   in production. Vita therefore cannot accidentally authorize them.
3. **Custom-host capability augmentation.** Custom extensions are host-owned
   but not yet represented by a separately trusted profile.
4. **Package materialization.** Package metadata is resolved and hashed, while
   some stock/custom Cargo packages still carry static title/icon metadata.
   Backends should eventually prove that the emitted package consumed every
   resolved metadata field.
5. **Plan schema publication.** The TypeScript plan type and hash verifier are
   public, but the generated plan does not yet have a separately versioned JSON
   Schema for non-TypeScript consumers.
6. **Contract-hash scope.** Toolchain and dependency versions stay in their
   lockfiles. If reproducible artifact identity becomes a requirement, a
   separate build provenance record should reference both plan and toolchain.

These are boundaries, not reasons to move platform policy back into ad hoc
conditionals. Each can extend the same authority chain:

```text
app request → trusted host facts → resolved contract → verified consumers
```

## Verification and debugging

Resolve without compiling:

```sh
bun pocket check --target psp
bun pocket check --target vita
```

Inspect the exact answer:

```sh
jq . .pocket/vita/plan.json
jq '.viewport, .capabilities, .contractHash' .pocket/vita/plan.json
```

Compile artifacts for a custom host:

```sh
bun pocket compile --target vita --outdir dist/pocket/vita
```

Build the stock package:

```sh
bun pocket build --target vita -- --release
```

The executable specification lives in:

- `test/platform-contracts.test.ts` — schema, resolution, compatibility,
  package override, viewport, and byte-exact plan behavior;
- `test/target-check.test.ts` — target-only import graph and capability-token
  type behavior;
- `test/fixtures/plans/` — committed canonical PSP/Vita plan fixtures;
- `test/e2e-ppsspp.ts` and `test/e2e-vita3k.ts` — packaged native behavior and
  byte-exact rendering.

## Related reading

- [Architecture](/docs/architecture/) — the runtime/core/backend layering.
- [Build pipeline](/docs/build-pipeline/) — JSX, styles, fonts, pak, and bundle
  compilation after a plan has selected the inputs.
- [Native contract](/docs/native-contract/) — the synchronous HostOps surface
  protected by the target/ABI/hash handshake.
- [Frameworks](/docs/frameworks/) — Solid and Vue Vapor ownership and output
  selection.
