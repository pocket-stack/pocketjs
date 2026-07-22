# Architecture

PocketJS is a JSX UI stack that runs apps on real Sony PSP and PS Vita hardware,
in PPSSPP and Vita3K, in desktop/browser hosts, and under headless Bun. It gets
there with one principle:
**one Rust core, framework-specific JS adapters, one layout engine everywhere.**

The JavaScript side can be Solid or Vue Vapor. Solid uses its universal renderer;
Vue Vapor uses a Vapor renderer adapter and a tiny DOM-shaped facade for Vue's
helpers. The rendering, layout, styling, animation, and text engine is a single
`no_std` Rust crate (`pocketjs-core`) compiled for each host: MIPS for PSP, ARM
for Vita, `wasm32` for browser/tests, and the desktop target for wgpu. Styling is a build-time
[Tailwind subset](/docs/tailwind/); fonts are baked into atlases at build time.
This page explains how the pieces fit together and why each choice was made.

## The pipeline

```
        app.tsx  (Solid or Vue Vapor + Tailwind-subset classes)
           │
           │  framework JSX transform   (two-pass build)
           ▼
   ┌────────────────────────────────────────────────┐
   │  bundle.js   +   styles.bin + atlases + images  │
   │      │                     │                     │
   │      │                     └──► app.pak        │
   └──────┼──────────────────────────────────────────┘
          │
   ┌──────┴──────────────────┐   ┌──────────────────────────┐
   │ QuickJS (PSP / Vita)    │   │ browser / desktop / Bun   │
   │    framework runtime    │   │    framework runtime      │
   │      │ ui.* ops         │   │      │ same ui.* ops      │
   │      ▼                  │   │      ▼                    │
   │  pocketjs-core          │   │  pocketjs-core            │
   │  (Rust, no_std)         │   │  (same Rust → wasm32)     │
   │  tree · taffy · anim    │   │  tree · taffy · anim      │
   │  · text                 │   │  · text                   │
   │      │ DrawList         │   │      │ DrawList           │
   │      ▼                  │   │      ▼                    │
   │ GE or GXM backend       │   │ software or wgpu backend  │
   └─────────────────────────┘   │   → canvas / PNG / window │
                                 └───────────────────────────┘
```

Reading it top to bottom:

1. **`app.tsx`** is ordinary framework JSX: PocketJS components from
   [`@pocketjs/framework/components`](/docs/components/), state/lifecycle from
   `solid-js` or `vue`, and `class` strings from the Tailwind subset.
2. A product **build** resolves `pocket.json` for one target, then runs the
   selected JSX transform, compiles class strings to a binary style table
   (`styles.bin`), bakes target-density glyph atlases/assets, and packs them
   into `app.pak`. The JS is bundled with target/ABI constants. The low-level
   `bun tools/build.ts <app>` path remains for framework development. See
   [Build pipeline](/docs/build-pipeline/) for the two-pass details.
3. At **runtime**, the selected framework runtime executes on whichever JS
   engine the host provides — QuickJS on PSP/Vita, the host engine in the browser
   or Bun — and emits mutation ops (`ui.*`) into `pocketjs-core`.
4. **`pocketjs-core`** owns the retained UI tree: it runs flexbox layout,
   ticks animations, measures and lays out text, and produces a flat
   **DrawList** each frame.
5. A thin **backend** turns the DrawList into pixels: sceGu/GE on PSP,
   vita2d/GXM on Vita, wgpu on desktop, or a deterministic software rasterizer
   for the browser canvas and byte-exact PNG goldens.

The dashed line down the middle is the whole point: everything *above* the
backend follows the same contract across targets. The layout you see in the browser
[playground](/playground/) is the same layout, computed by the same code, that
runs on the handheld.

## Why these choices

### Framework adapters over HostOps

PocketJS keeps framework code above a small renderer adapter boundary. Solid
uses `babel-preset-solid` with `generate: 'universal'`; Vue Vapor uses
`vue-jsx-vapor` and `renderer-vue-vapor.ts`. Both adapters target the same JS
mirror tree and `ui.*` HostOps, so the Rust core, input manager, style table,
animation system, `.pak` format, and native targets do not fork by framework.

The universal renderer means Solid never touches the DOM. Instead it calls a
small set of node operations (`createNode`, `insertBefore`, `setProperty`,
`replaceText`, …) that PocketJS maps onto the native `ui.*` contract. Solid's
distributed runtime references no `window`, `document`, `setTimeout`, or
`WeakRef`; it needs only `Proxy`, `WeakMap`, and `Promise`, all of which the
target engines provide.

### QuickJS reality: ES2023, minus timers

On the PSP the JavaScript engine is **QuickJS** (Bellard's engine, the
`2026-06-04` build), which is roughly **ES2023**. Modern syntax works — logical
assignment operators, `WeakRef`, and `FinalizationRegistry` are available.
PocketJS node lifetime does not depend on garbage-collector timing: the mirror
tree uses an explicit end-of-frame sweep plus `retain` / `release` for detached
subtrees.

What is *not* there shapes the API surface:

| Missing on QuickJS | Consequence |
|---|---|
| `queueMicrotask` | Polyfilled via `Promise.resolve().then(...)`. |
| `setTimeout` / `MessageChannel` | No wall-clock scheduling; use [`onFrame`](/docs/animation/) / native animation instead. |
| `performance` | No high-res timer in JS; timing is frame-index based. |

Because there is no timer or microtask *scheduler*, Solid's
`createResource`, transitions, and `enableScheduling` are **off-limits on the
PSP**. The compiler lints on importing them so you find out at build time, not
on-device. Browser and Bun development builds stay inside the same syntax and
scheduler subset. Target compatibility is checked separately from the
manifest's required APIs and viewport contract, so (for example) a
touch-required Vita app is rejected for PSP before compilation.

### taffy 0.11 for layout

Flexbox is computed by **taffy 0.11**, built with
`default-features = false` and the `alloc`, `taffy_tree`, `flexbox`, and
`content_size` features. That configuration is verified `no_std` + `alloc`,
f32-only, and needs no `libm`, which is exactly what a bare-metal PSP binary
requires. Using a real, tested layout engine — rather than a hand-rolled
subset — is why layout is identical on every host.

### One Rust core, compiled per host

`engine/core/` is a platform-agnostic `#![no_std]` + `alloc` library,
**`pocketjs-core`**. It contains no I/O, no graphics API, and no timing — just
the tree, layout, styling, animation, text, and DrawList generation. Thin
wrappers give it a body:

- **`pocketjs-psp`** (`hosts/psp/`) — the PSP EBOOT. It embeds QuickJS, feeds JS
  the `ui.*` ops, and renders the DrawList through `sceGu`.
- **`pocketjs-vita`** (`hosts/vita/`) — the PS Vita VPK host. It embeds the
  same guest/core contract and renders native-density output through vita2d/GXM.
- **`pocketjs-wasm`** (`engine/wasm/`) — a `wasm32-unknown-unknown` `cdylib` that wraps
  the *same* core with a deterministic software rasterizer. This one binary
  serves **both** the browser dev host and the headless Bun golden tests.
- **Desktop uihosts** — native debug/custom-host crates consume the same
  DrawList through wgpu and the stable `HostBuildInputs` projection.

One layout engine, one animation clock, one text layouter — reused, never
reimplemented per platform.

### Native animation on a fixed core clock

Tweens and springs tick inside Rust in exact **`dt = 1/60 s`** steps. A 60 Hz
host advances one core tick per virtual frame; a deliberately slower simulation
can advance multiple ticks for that frame. JavaScript only *declares* motion (via
[`@pocketjs/framework/animation`](/docs/animation/) or `transition-*` classes); it
never drives it frame by frame.

Given the same build, simulation-rate policy, input tape, and frame-boundary
effect deliveries, those discrete ticks follow the same trajectory. That is
what makes the PNG golden tests exact rather than fuzzy — the `wasm32`
rasterizer and the goldens agree down to the pixel.

### Baked text

There are no runtime font files. At build time an `opentype.js`-based baker
turns each glyph the app actually uses into a horizontally-supersampled, 8-bit
coverage cell, plus proportional advances and a cmap. On device, drawing text
means run-length-extracting the alpha coverage and batching it into GE sprites —
no glyph rasterization at runtime. The bundled typeface is **Inter** (OFL),
vendored under `assets/fonts/`.

Because only the used glyphs are baked, the compiler scans your source for text
codepoints during the build. See [Styling](/docs/styling/) and
[Build pipeline](/docs/build-pipeline/) for how that scan works.

## The three layers

It helps to think of PocketJS as three layers with narrow contracts between
them.

**1. The app + framework runtime (JavaScript).** Your components and reactive
state. The Solid/Vue adapters keep a lightweight JS *mirror* of the tree —
`{ id, parent, children[], … }` — so the reconciler can *read* tree structure
without crossing the FFI boundary.
Only *mutations* cross into native. `setProperty` runs through a dispatch table:
`className` → style id, `on*` → the input registry, `src` → the texture
registry, a `style={{…}}` object → per-key property ids (previous-value
diffed). Anything unrecognized is a loud dev-time error rather than a silent
no-op.

**2. `pocketjs-core` (Rust, `no_std`).** The retained tree lives in a node arena
(`Vec<Node>` + free list) with a **generation counter**, so a stale handle is a
safe no-op rather than a dangling reference. Core parses the style table,
resolves `base` / `focus` / `active` variants, syncs nodes into taffy, measures
text, ticks animation tracks, and walks the tree into a DrawList. A CPU **clip
stage** in `draw.rs` guarantees no negative or oversized coordinates ever reach
a backend — axis-aligned quads are clipped with UV/color re-interpolation,
rotated quads are Sutherland–Hodgman-clipped or culled.

**3. The backend.** Consumes the DrawList and nothing else. PSP uses `sceGu`,
Vita uses vita2d/GXM, desktop uses wgpu, and `wasm32` uses a scanline rasterizer
that handles blending, gradients, and glyph coverage deterministically.
Backends do not redefine layout, input, or styling semantics.

The exact op signatures, node lifecycle, and per-frame ordering live on the
[Native contract](/docs/native-contract/) page.

## Repository layout

```
pocketjs/
  docs/DESIGN.md, README.md
  package.json          pinned: solid-js@^1.9, babel-preset-solid@^1.9,
                        @babel/core@^7, @babel/preset-typescript@^7,
                        opentype.js, typescript
  tsconfig.json         jsx: 'preserve' (Babel owns the transform)
  assets/fonts/         Inter-Regular.ttf, Inter-Bold.ttf (+ OFL LICENSE)

  contracts/spec/
    spec.ts             SINGLE SOURCE OF TRUTH: op codes, prop ids, enums,
                        style-table / atlas / DrawList / pak formats
    gen-rust.ts         codegen → engine/core/src/spec.rs (committed)

  engine/core/                 Rust lib `pocketjs-core` — #![no_std] + alloc
    framework/src/lib.rs          Ui: apply ops, tick(1/60), draw() → &DrawList
    framework/src/spec.rs         GENERATED — drift-guarded against contracts/spec/
    framework/src/tree.rs         node arena + free list + generation counter
    framework/src/style.rs        style-table parse/resolve; base/focus/active variants
    framework/src/layout.rs       taffy sync + text-measure closures + dirty tracking
    framework/src/text.rs         atlas registry, cmap, measurement, inline-run layout
    framework/src/anim.rs         tween/spring tracks; transitions on style swap; fixed dt
    framework/src/draw.rs         tree walk → DrawList + CPU clip stage
    framework/src/raster.rs       shared deterministic software rasterizer

  hosts/psp/               Rust bin `pocketjs-psp` — the PSP EBOOT
    Cargo.toml          psp, libquickjs-sys, pocketjs-core (path)
    build.rs            embeds the app JS + app.pak
    framework/src/main.rs         boot, vblank loop, job pump
    framework/src/alloc.rs        #[global_allocator] backed by the arena
    framework/src/arena.rs        single-kernel-block allocator (see Memory)
    framework/src/ffi.rs          QuickJS ui.* bindings → core ops
    framework/src/ge.rs           DrawList → sceGu; per-frame bump vertex arena
    framework/src/pak.rs        native read-only .pak walker (styles/atlases/images)

  hosts/vita/          Rust bin `pocketjs-vita` — the Vita VPK host
    build.rs            consumes the same HostBuildInputs environment
    framework/src/                QuickJS bindings + vita2d/GXM DrawList backend

  engine/wasm/                 Rust cdylib `pocketjs-wasm` — core + rasterizer
    framework/src/lib.rs          extern "C" op mirror + render() → RGBA8 480×272

  framework/src/                  TS/JS runtime shared by all hosts
    renderer.ts         Solid universal renderer; JS mirror tree; dispatch table
    host.ts             HostOps interface + hosts/psp/injected target handshake
    pak.ts            QuickJS-safe reader (web/test hosts)
    input.ts            edge-detect + focus manager
    anim.ts             animate() / spring() implementation
    primitives.ts       lower-case host tags → View/Text/Image primitives
    components.ts        ┐
    animation.ts         ├ the public @pocketjs/framework/* subpath modules
    lifecycle.ts         │   (Solid primitives are imported from solid-js)
    input-api.ts, overlay.ts, index.ts  ┘

  framework/compiler/
    solid-plugin.ts     babel transform + per-file class/codepoint collection
    tailwind.ts         token parser → styles.bin + styles.generated.ts
    bake-font.ts        atlas baker (charset from AST scan + ASCII)
    pak.ts            container writer

  hosts/web/             480×272 canvas playground + Bun dev server
  apps/                hero, cards, stats, library, settings, notifications, music
  tests/                 contract drift guard, wasm goldens, PPSSPP e2e
  tools/              build.ts, psp.ts, dev.ts, wasm.ts
  site/                 this documentation
```

The `contracts/spec/` directory is the seam that keeps JS and Rust honest: `spec.ts` is
the single source of truth for every op code, property id, enum, and binary
format, and `gen-rust.ts` generates `engine/core/src/spec.rs` from it. A contract test
regenerates that file in memory and byte-compares it, so the two sides can never
drift apart silently.

## Memory (PSP)

The PSP build carries one hard constraint worth knowing about here. `rust-psp`'s
default `#[global_allocator]` makes **one kernel object per allocation**, which
caps out and crashes long before a real UI tree is built (taffy slotmaps,
children `Vec`s, per-pass collections, the DrawList). PocketJS installs its own
global allocator (`hosts/psp/src/alloc.rs`) backed by a single arena
(`arena.rs`) — the *same* kernel block that QuickJS allocates from. Textures and
retained core buffers live in that arena too. JS runs on the 2 MB `USER|VFPU`
worker; a 2 MB margin is kept for the GE display list and stack safety.

Clarification: the public "8MB RAM" line is shorthand for this PocketJS
application arena with safety headroom, not the PSP's whole main-memory budget.
Code and embedded `.pak`/JS bytes live in the EBOOT image, the worker stack is
separate, and PSP display framebuffers are allocated from VRAM. On a unified
memory machine you would add those pieces back to estimate total process memory.

The full allocator setup, the per-frame vertex bump pool, and the exact PSP
frame order are covered on the [Native contract](/docs/native-contract/) page.

## Where to go next

- [Platform contracts](/docs/platform-contracts/) — how an app manifest and a
  truthful target profile become one small, checksummed build plan consumed by
  JS and native packaging.
- [Build pipeline](/docs/build-pipeline/) — the two-pass build, style
  compilation, and font baking in detail.
- [Native contract](/docs/native-contract/) — the `ui.*` ops, node lifecycle,
  generation-tagged handles, and per-frame ordering.
- [Frameworks](/docs/frameworks/) — Solid and Vue Vapor selection, imports, and
  output naming.
- [Reactivity](/docs/reactivity/) — how Solid signals and effects behave on the
  default runtime.
- [Styling](/docs/styling/) and [Tailwind subset](/docs/tailwind/) — the
  supported utilities and how classes become the binary style table.
- [Getting started](/docs/getting-started/) — build and run your first app in
  the browser, on PSP/PPSSPP, or in Vita3K.
