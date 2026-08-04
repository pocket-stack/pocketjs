# Core concepts

PocketJS ships more than a UI engine. The structure that carries the UI — a
native core behind a pinned protocol, mounted into a JS guest — is the same
structure every other capability uses: audio landed this way, and
OpenStrike's game core before it. This page names the parts:
**a runtime is a host plus the modules it mounts plus one guest program,
and every boundary between them is pinned as data.**
[Architecture](/docs/architecture/) shows the UI module's internals;
[Platform contracts](/docs/platform-contracts/) covers capability
resolution in depth.

```
Runtime  =  Host  +  mounted Modules  +  Guest

┌────────────────────────── Runtime ──────────────────────────┐
│  Guest        product code (QuickJS bundle / wasm host eval) │
│  ─────────  one namespace per mounted module  ─────────────  │
│  Modules      ui          audio        strike (OpenStrike)   │
│               core+spec   core+spec    core+spec             │
│  Substrate    pocket3d · platform drivers (no guest API)     │
│  Host         PSP EBOOT · Vita · browser · headless sim      │
└──────────────────────────────────────────────────────────────┘
```

## Host

A host is the platform binary. It owns what the operating system hands out —
the window or framebuffer, input devices, GPU, audio device, filesystem. The
PSP EBOOT, the Vita binary, the browser dev host, and the headless Bun sim
are hosts. A host carries no product logic: it boots the cores, mounts each
module's namespace into the guest, and drives the tick loop.

## Module

A module packages one domain so it can be reused across hosts and products.
It has exactly three layers:

```
SDK    guest-side API (components, players, mod hooks)
────── Spec ──────  the pinned protocol between the two sides
Core   native side: owns the domain's state and clock
```

The **core** owns the domain's state and its clock; per-entity, per-frame
work happens only there, and the core never calls into the guest. The
**SDK** is ordinary guest code shaped for its domain — JSX components for
`ui`, `decodeWav` and a `WavPlayer` for `audio`, a mod API for OpenStrike's
`strike`. The two sides can be replaced independently because the **spec**
between them does not move: swap Solid for Vue Vapor, or rewrite the layout
engine, and the other side cannot tell.

`ui` (pocketjs-core + the `ui.*` ops + the JSX SDK) was the first module.
`strike` was the second. `audio` — credit-based PCM streaming — is the
third, and the first written spec-first: the protocol existed before any
host implemented it.

## Spec

A spec pins the boundary between guest and core: what crosses it, in which
direction, when, and in what byte shape. It has four parts:

| Part | Direction | Contents |
| --- | --- | --- |
| **ops** | guest → core | commands: synchronous calls, numeric codes, append-only |
| **events** | core → guest | facts: batched per tick, drained inside the guest's turn, never re-entrant |
| **data contract** | both | the byte layout of every bulk payload, plus ownership (`move` or `borrow` — nothing else) |
| **frame contract** | — | when the guest runs relative to the core clock, and what happens before and after |

Specs are plain TypeScript data (`contracts/spec/*.ts`). The Rust side is
generated from them and byte-compared in CI, so the two languages cannot
drift. The one versioning rule: codes and fields are append-only. A
synchronous return value is a property of an op, not a separate mechanism,
and flow control (audio's credit protocol) is built from ops plus events,
not a third channel.

## Capability

A capability id names behavior an app can observe, and it is the same name
as the spec namespace it stands for: the `audio.pcm` capability means
`globalThis.audio` is mounted and `audio:*` pak entries have meaning. One
name covers the manifest, the runtime namespace, and the asset prefix.

Capabilities resolve at build time only. An app's `pocket.json` declares
`requires` (the compatibility floor) and `enhances` (optional, degrades
cleanly); the resolver checks them against the target's profile and writes
one `ResolvedBuildPlan`. There is no runtime permission system and no
dynamic negotiation. The sandbox is the same fact read from the other side:
a guest can call exactly what its mounted specs define, and nothing else.

## Substrate

Native code shared by modules but invisible to guests: the pocket3d
rendering and collision crates, platform audio output, DMA helpers. The
dividing line is a single question — does it have a spec? If guest code can
name it, it is a module; if only native code links against it, it is
substrate.

## Runtime

A runtime is what a host assembles at build time. A product is one such
assembly:

| Runtime | Host | Modules | Guest |
| --- | --- | --- | --- |
| PSP UI runtime | PSP EBOOT | `ui` + `audio` | any PocketJS app |
| Music demo in the browser | browser dev host | `ui` + `audio` | `apps/music` |
| OpenStrike | its own Rust bin | `strike` + `ui` (HUD) | round rules, weapons, bots — all JS |
| Headless CI | Bun sim | `ui` + virtual `audio` | the same bundles, byte-for-byte |

## The three laws

Every module obeys the same three rules, which is why the whole stack can
be tested headlessly:

1. **State lives in the core; the guest holds mirrors.** Hot-path reads
   never cross the boundary. Queries exist, but only on cold paths.
2. **Commands cross as ops, facts cross as events, both spec-pinned.** No
   shared memory, no mid-tick callbacks, no string side-channels.
3. **Each host tick, the guest runs exactly once.** The guest owns no
   timers and no threads. Frame content is a pure function of tick index
   plus inputs — which is what makes byte-exact goldens, input tapes, and
   deterministic replay possible.

One placement rule comes with them: put the spec boundary where crossings
are proportional to **changes, not entities**. Text layout stays inside the
ui core because measurement runs per element, per frame — a boundary there
would be crossed thousands of times a tick.

## Clocks

The guest has exactly one clock: the tick. Some domains need a second one —
real-time audio cannot wait for a frame — so a module may declare a
**native-side clock** in its frame contract, under strict rules: it never
calls the guest, never blocks on it, and its facts are batched to tick
boundaries for delivery. On virtual-clock hosts the same module consumes by
a pinned per-tick formula instead of a device callback, so a two-clock
module still has a deterministic, byte-reproducible test path.

## Worked example: the audio module

Each concept above, instantiated once:

| Concept | Artifact |
| --- | --- |
| Spec | `contracts/spec/audio.ts` — 9 ops, 3 events, PCM + WAV data contract, native-clock frame contract |
| Capability | `audio.pcm`, declared by `apps/music` as an enhancement |
| Core (browser) | an `AudioWorklet` ring on the device clock |
| Core (PSP) | a mixer thread feeding one 44.1 kHz hardware channel |
| Core (headless) | a virtual sink consuming by the pinned per-tick formula |
| SDK | `@pocketjs/framework/audio` — `decodeWav` + a credit-driven `WavPlayer` |
| Guest | the music demo: same pixels with or without the module mounted |

The composition property is the point: the PSP gained audible audio by
changing only host code and one line of its target profile. The spec, the
framework, and the app did not change. A new domain — networking, haptics,
a camera — lands the same way: write the spec, build the core against it,
mount it in a host, ship the SDK with a headless test.
