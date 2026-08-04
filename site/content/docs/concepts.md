# Core concepts

PocketJS looks like a UI framework, but the thing underneath is a small
platform ontology: five nouns and one relation.
**A Host composes a Runtime at build time by mounting Modules — vertical
slices of Core + Spec + SDK — over shared Substrate, gated by Capabilities.**
The UI engine is one instance of that pattern, not the pattern itself. This
page defines the nouns; [Architecture](/docs/architecture/) shows how the UI
module is wired, and [Platform contracts](/docs/platform-contracts/) covers
the capability machinery in depth.

```
Runtime  =  Host  +  mounted Modules  +  Guest

┌────────────────────────── Runtime ──────────────────────────┐
│  Guest        product code (QuickJS bundle / wasm host eval) │
│  ─────────  one namespace per mounted module  ─────────────  │
│  Modules      ui          audio        strike (OpenStrike)   │
│               core+spec   core+spec    core+spec             │
│  Substrate    pocket3d · platform drivers (no vocabulary)    │
│  Host         PSP EBOOT · Vita · browser · headless sim      │
└──────────────────────────────────────────────────────────────┘
```

## Host

The platform-native shell: it owns what the operating system owns — the
window or framebuffer, input devices, GPU, audio device, filesystem. The PSP
EBOOT, the Vita binary, the browser dev host, and the headless deterministic
sim are all hosts. A host has no product logic; its job is to compose
everything else and drive the tick loop.

## Module

A module is a reusable vertical slice of one domain, exactly three layers:

```
SDK    the domain's natural algebra for guest code
────── Spec ──────  the pinned boundary (the module's identity)
Core   owner of the domain's state and time
```

The **core** owns domain state and the domain clock; per-entity, per-frame
work happens only there, and the core never calls the guest. The **SDK** is
whatever shape the domain wants — JSX components for `ui`, a `WavPlayer` for
`audio`, a mod API for OpenStrike's `strike`. Both layers are replaceable
because the **spec** between them is not: swap Solid for Vue Vapor, rewrite
the layout engine, and the other side cannot tell.

`ui` (pocketjs-core + the `ui.*` ops + the JSX SDK) was the first module.
`strike` (OpenStrike's FPS core and mod API) was the second. `audio` —
credit-based PCM streaming — is the third, and the first built module-first:
spec before any host code.

## Spec

A spec does not describe a module's implementation; it describes the
**boundary** between two execution domains — what may cross, in which
direction, when, and in what shape. Everything that can cross decomposes
into three axes, so a spec has exactly four parts:

| Part | Direction | Shape |
| --- | --- | --- |
| **ops** | guest → core | intent: synchronous calls, numeric codes, append-only |
| **events** | core → guest | facts: batched per tick, drained inside the guest's turn, never re-entrant |
| **data contract** | both | every bulk payload's byte layout plus ownership (`move` or `borrow` — nothing else) |
| **frame contract** | — | when the guest runs relative to the core clock, and what has happened before and after |

Specs are plain TypeScript data (`contracts/spec/*.ts`), code-generated into
the Rust side, and byte-compared in CI so the two languages can never drift.
The versioning rule is one word: **append-only**. Queries are an attribute
of an op, not a fourth axis; flow control (audio's credit protocol) is a
pattern of ops + events, not a new mechanism.

## Capability

A capability id names stable, observable behavior an app can rely on — and
it shares its name with the spec namespace it exposes: the `audio.pcm`
capability means `globalThis.audio` is mounted, which means `audio:*` pak
entries have meaning. One name, three layers.

Capabilities are resolved entirely at build time. An app's `pocket.json`
declares `requires` (the compatibility floor) and `enhances` (optional,
degrade-gracefully); the resolver checks them against each target's profile
and writes one `ResolvedBuildPlan`. There is no runtime permission system
and no dynamic negotiation — a guest can do exactly what its mounted specs
express, one thing less than nothing more. Sandboxing falls out of the
ontology instead of being bolted on.

## Substrate

Shared native code with **no guest vocabulary**: the pocket3d rendering and
collision crates, platform audio drivers, DMA helpers. The line between
substrate and module is a single question — *is there a spec?* If guests
can name it, it's a module; if only native code can, it's substrate.

## Runtime

A runtime is not a product class; it is a composition, and a product is one
composition:

| Runtime | Host | Modules | Guest |
| --- | --- | --- | --- |
| PSP UI runtime | PSP EBOOT | `ui` + `audio` | any PocketJS app |
| Music demo, dev flavor | browser host | `ui` + `audio` | `apps/music` |
| OpenStrike | its own Rust bin | `strike` + `ui` (HUD) | round rules, weapons, bots — all JS |
| Headless CI | Bun sim | `ui` + virtual `audio` | the same bundles, byte-for-byte |

## The three laws

Every module obeys the same three laws, which is why the whole stack can be
tested headlessly:

1. **State lives in the core; the guest holds mirrors.** Hot-path reads
   never cross the boundary. Queries exist, but only on cold paths.
2. **Intent crosses as ops, facts cross as events, both spec-pinned.** No
   shared memory, no mid-tick callbacks, no string side-channels.
3. **Each host tick, the guest runs exactly once.** The guest owns no
   timers and no threads. Frame content is a pure function of tick index
   plus inputs — which is what makes byte-exact goldens, input tapes, and
   deterministic replay possible.

One placement principle rides along with the laws: draw the spec boundary
where crossings are **O(changes), not O(entities)**. Text layout stays
inside the ui core because measurement is per-element and per-frame;
a spec boundary there would die of traffic.

## Clocks

The guest has exactly one clock: the tick. Some domains genuinely need a
second one — real-time audio cannot wait for a frame — so a module may
declare a **native-side clock** in its frame contract, under strict rules:
it never calls the guest, never blocks on it, and resamples its facts to
tick boundaries for delivery. On virtual-clock hosts the same module
consumes by a pinned formula instead of a device callback, so even a
multi-clock module has a deterministic, byte-reproducible test story.

## Worked example: the audio module

Every concept above, instantiated once:

| Concept | Artifact |
| --- | --- |
| Spec | `contracts/spec/audio.ts` — 9 ops, 3 events, PCM + WAV data contract, native-clock frame contract |
| Capability | `audio.pcm`, declared by `apps/music` as an enhancement |
| Core (browser) | an `AudioWorklet` ring on the device clock |
| Core (PSP) | a mixer thread feeding one 44.1 kHz hardware channel |
| Core (headless) | a virtual sink consuming by the pinned per-tick formula |
| SDK | `@pocketjs/framework/audio` — `decodeWav` + a credit-driven `WavPlayer` |
| Guest | the music demo: same pixels with or without the module mounted |

The payoff is the composition property: the PSP gained audible audio by
changing **only host code and one line of its target profile**. The spec,
the framework, and the app did not change at all. That is what a module is
for — the next domain (networking, haptics, a camera) should land the same
way: write the vocabulary, build the core against it, mount, ship the SDK
with a headless story.
