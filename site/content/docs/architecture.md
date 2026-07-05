# Architecture

PocketJS is a JSX UI stack that runs apps on real Sony PSP hardware, in PPSSPP,
in the browser, and under headless Bun. It gets there with one principle:
**one Rust core, framework-specific JS adapters, one layout engine everywhere.**

The JavaScript side can be Solid or Vue Vapor. Solid uses its universal renderer;
Vue Vapor uses a Vapor renderer adapter and a tiny DOM-shaped facade for Vue's
helpers. The rendering, layout, styling, animation, and text engine is a single
`no_std` Rust crate (`pocketjs-core`) compiled twice: once to MIPS for the PSP,
once to `wasm32` for the browser and tests. Styling is a build-time
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
   │  QuickJS (PSP)          │   │  browser / headless Bun   │
   │    framework runtime    │   │    framework runtime      │
   │      │ ui.* ops         │   │      │ same ui.* ops      │
   │      ▼                  │   │      ▼                    │
   │  pocketjs-core          │   │  pocketjs-core            │
   │  (Rust, no_std)         │   │  (same Rust → wasm32)     │
   │  tree · taffy · anim    │   │  tree · taffy · anim      │
   │  · text                 │   │  · text                   │
   │      │ DrawList         │   │      │ DrawList           │
   │      ▼                  │   │      ▼                    │
   │  sceGu backend (GE)     │   │  software rasterizer      │
   └─────────────────────────┘   │    → canvas / PNG golden  │
                                 └───────────────────────────┘
```

Reading it top to bottom:

1. **`app.tsx`** is ordinary framework JSX: PocketJS components from
   [`@pocketjs/framework/components`](/docs/components/), state/lifecycle from
   `solid-js` or `vue`, and `class` strings from the Tailwind subset.
2. The **build** (`bun scripts/build.ts <app>`) selects a framework from
   `pocket.config.ts` or `--framework=...`, runs that JSX transform, compiles
   class strings to a binary style table (`styles.bin`), bakes the exact glyphs
   the app uses into font atlases, and packs styles + atlases + images into
   `app.pak`. The JS is bundled to `bundle.js`. See
   [Build pipeline](/docs/build-pipeline/) for the two-pass details.
3. At **runtime**, the selected framework runtime executes on whichever JS
   engine the host provides — QuickJS on the PSP, the host engine in the browser
   or Bun — and emits mutation ops (`ui.*`) into `pocketjs-core`.
4. **`pocketjs-core`** owns the retained UI tree: it runs flexbox layout,
   ticks animations, measures and lays out text, and produces a flat
   **DrawList** each frame.
5. A thin **backend** turns the DrawList into pixels: `sceGu` (the PSP's
   Graphics Engine) on hardware, or a deterministic software rasterizer in
   `wasm32` for the browser canvas and for byte-exact PNG goldens.

The dashed line down the middle is the whole point: everything *above* the
backend is identical across targets. The layout you see in the browser
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
assignment operators, and importantly **`WeakRef` and `FinalizationRegistry`
are both available**, which PocketJS uses as a backstop for reclaiming
abandoned nodes.

What is *not* there shapes the API surface:

| Missing on QuickJS | Consequence |
|---|---|
| `queueMicrotask` | Polyfilled via `Promise.resolve().then(...)`. |
| `setTimeout` / `MessageChannel` | No wall-clock scheduling; use [`onFrame`](/docs/animation/) / native animation instead. |
| `performance` | No high-res timer in JS; timing is frame-index based. |

Because there is no timer or microtask *scheduler*, Solid's
`createResource`, transitions, and `enableScheduling` are **off-limits on the
PSP**. The compiler lints on importing them so you find out at build time, not
on-device. Everything the browser and Bun hosts run is deliberately kept to the
same subset, so an app that builds is an app that runs everywhere.

### taffy 0.11 for layout

Flexbox is computed by **taffy 0.11**, built with
`default-features = false` and the `alloc`, `taffy_tree`, `flexbox`, and
`content_size` features. That configuration is verified `no_std` + `alloc`,
f32-only, and needs no `libm`, which is exactly what a bare-metal PSP binary
requires. Using a real, tested layout engine — rather than a hand-rolled
subset — is why layout is identical on every host.

### One Rust core, compiled twice

`core/` is a platform-agnostic `#![no_std]` + `alloc` library,
**`pocketjs-core`**. It contains no I/O, no graphics API, and no timing — just
the tree, layout, styling, animation, text, and DrawList generation. Two thin
wrappers give it a body:

- **`pocketjs-psp`** (`native/`) — the PSP EBOOT. It embeds QuickJS, feeds JS
  the `ui.*` ops, and renders the DrawList through `sceGu`.
- **`pocketjs-wasm`** (`wasm/`) — a `wasm32-unknown-unknown` `cdylib` that wraps
  the *same* core with a deterministic software rasterizer. This one binary
  serves **both** the browser dev host and the headless Bun golden tests.

One layout engine, one animation clock, one text layouter — reused, never
reimplemented per platform.

### Native, fixed-dt animation

Tweens and springs tick inside Rust, once per vblank, at a **fixed
`dt = 1/60 s`**. JavaScript only *declares* motion (via
[`@pocketjs/framework/animation`](/docs/animation/) or `transition-*` classes); it
never drives it frame by frame.

The fixed timestep has a powerful consequence: **frame content is a pure
function of the frame index.** Given the same inputs, frame *N* is byte-for-byte
identical every time it is computed. That is what makes the PNG golden tests
exact rather than fuzzy — the `wasm32` rasterizer and the goldens agree down to
the pixel.

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

**1. The app + Solid runtime (JavaScript).** Your components, signals, and
effects. The universal renderer (`src/renderer.ts`) keeps a lightweight JS
*mirror* of the tree — `{ id, parent, children[], … }` — so that Solid's
reconciler can *read* the tree structure without ever crossing the FFI boundary.
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

**3. The backend.** Consumes the DrawList and nothing else. On PSP that is
`sceGu`; in `wasm32` it is a scanline rasterizer that handles blending,
gradients, and glyph coverage identically. Backends never own the frame
lifecycle — on PSP the main loop owns `sceGuStart` / `sceGuFinish`.

The exact op signatures, node lifecycle, and per-frame ordering live on the
[Native contract](/docs/native-contract/) page.

## Repository layout

```
pocketjs/
  DESIGN.md, README.md
  package.json          pinned: solid-js@^1.9, babel-preset-solid@^1.9,
                        @babel/core@^7, @babel/preset-typescript@^7,
                        opentype.js, typescript
  tsconfig.json         jsx: 'preserve' (Babel owns the transform)
  assets/fonts/         Inter-Regular.ttf, Inter-Bold.ttf (+ OFL LICENSE)

  spec/
    spec.ts             SINGLE SOURCE OF TRUTH: op codes, prop ids, enums,
                        style-table / atlas / DrawList / pak formats
    gen-rust.ts         codegen → core/src/spec.rs (committed)

  core/                 Rust lib `pocketjs-core` — #![no_std] + alloc
    src/lib.rs          Ui: apply ops, tick(1/60), draw() → &DrawList
    src/spec.rs         GENERATED — drift-guarded against spec/
    src/tree.rs         node arena + free list + generation counter
    src/style.rs        style-table parse/resolve; base/focus/active variants
    src/layout.rs       taffy sync + text-measure closures + dirty tracking
    src/text.rs         atlas registry, cmap, measurement, inline-run layout
    src/anim.rs         tween/spring tracks; transitions on style swap; fixed dt
    src/draw.rs         tree walk → DrawList + CPU clip stage

  native/               Rust bin `pocketjs-psp` — the PSP EBOOT
    Cargo.toml          psp, libquickjs-sys, pocketjs-core (path)
    build.rs            embeds the app JS + app.pak
    src/main.rs         boot, vblank loop, job pump
    src/alloc.rs        #[global_allocator] backed by the arena
    src/arena.rs        single-kernel-block allocator (see Memory)
    src/ffi.rs          QuickJS ui.* bindings → core ops
    src/ge.rs           DrawList → sceGu; per-frame bump vertex arena
    src/pak.rs        native read-only .pak walker (styles/atlases/images)

  wasm/                 Rust cdylib `pocketjs-wasm` — core + rasterizer
    src/lib.rs          extern "C" op mirror + render() → RGBA8 480×272
    src/raster.rs       deterministic scanline rasterizer

  src/                  TS/JS runtime shared by all hosts
    renderer.ts         Solid universal renderer; JS mirror tree; dispatch table
    host.ts             HostOps interface + PSP / wasm bindings
    pak.ts            QuickJS-safe reader (web/test hosts)
    input.ts            edge-detect + focus manager
    anim.ts             animate() / spring() implementation
    primitives.ts       lower-case host tags → View/Text/Image primitives
    components.ts        ┐
    animation.ts         ├ the public @pocketjs/framework/* subpath modules
    lifecycle.ts         │   (Solid primitives are imported from solid-js)
    input-api.ts, overlay.ts, index.ts  ┘

  compiler/
    solid-plugin.ts     babel transform + per-file class/codepoint collection
    tailwind.ts         token parser → styles.bin + styles.generated.ts
    bake-font.ts        atlas baker (charset from AST scan + ASCII)
    pak.ts            container writer

  host-web/             480×272 canvas playground + Bun dev server
  demos/                hero, cards, stats, library, settings, notifications, music
  test/                 contract drift guard, wasm goldens, PPSSPP e2e
  scripts/              build.ts, psp.ts, dev.ts, wasm.ts
  site/                 this documentation
```

The `spec/` directory is the seam that keeps JS and Rust honest: `spec.ts` is
the single source of truth for every op code, property id, enum, and binary
format, and `gen-rust.ts` generates `core/src/spec.rs` from it. A contract test
regenerates that file in memory and byte-compares it, so the two sides can never
drift apart silently.

## Memory (PSP)

The PSP build carries one hard constraint worth knowing about here. `rust-psp`'s
default `#[global_allocator]` makes **one kernel object per allocation**, which
caps out and crashes long before a real UI tree is built (taffy slotmaps,
children `Vec`s, per-pass collections, the DrawList). PocketJS installs its own
global allocator (`native/src/alloc.rs`) backed by a single arena
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
  the browser and on PPSSPP.
