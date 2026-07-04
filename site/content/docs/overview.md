# Overview

PocketJS is a JSX UI stack for the Sony PSP (and beyond). You write components
with **Solid** and style them with a **Tailwind subset**; a build step compiles
your styles and bakes your fonts, and the whole thing runs on top of a single
`no_std` Rust core that does flexbox layout, styling, animation, text, and
rendering. The same `app.tsx` runs on real PSP hardware, in the PPSSPP
emulator, in the browser, and headless under Bun.

If you know React or Solid, you already know most of PocketJS. The primitives
are `View`, `Text`, and `Image`; state is `createSignal` / `createEffect`;
layout and color come from class strings like `flex-col items-center gap-4
bg-slate-50`. What is different is what happens underneath: there is no DOM, no
VDOM, and no runtime CSS.

## One core, four hosts

Everything renders through one Rust core, `pocketjs-core` — a
platform-agnostic `#![no_std]` library that owns the retained node tree,
[taffy](https://github.com/DioxusLabs/taffy) flexbox layout, the style table,
animation tracks, baked text, and a `DrawList`. That core is compiled twice and
paired with a backend per host:

| Host | JS engine | Rust build | Backend |
|---|---|---|---|
| **PSP hardware** | QuickJS | `mipsel-sony-psp` | sceGu (the GE) |
| **PPSSPP** | QuickJS | `mipsel-sony-psp` | sceGu, run headless for e2e goldens |
| **Browser** | the browser's | `wasm32-unknown-unknown` | deterministic software rasterizer → canvas |
| **Headless Bun** | Bun | `wasm32-unknown-unknown` | same rasterizer → byte-exact PNG goldens |

Layout runs in exactly one place — the Rust core — so a screen lays out the
same everywhere. The browser and Bun hosts share one rasterizer, which is what
makes deterministic golden images possible. See
[Architecture](/docs/architecture/) for the full picture and
[Native contract](/docs/native-contract/) for the `ui.*` op set that bridges JS
and Rust.

## Who it's for

PocketJS is for JavaScript and TypeScript developers who want to build real,
animated UI for the PSP — launchers, menus, dashboards, small apps — without
writing C or hand-rolling a layout engine. You get a familiar reactive
component model and utility-class styling; the framework handles host
detection, the generated style table, image uploads, and the per-frame host
callback for you.

## Three pillars

**1. Solid, with no VDOM.** PocketJS drives Solid through its *universal
renderer* (`babel-preset-solid` with `generate: 'universal'`). Solid has no
virtual DOM: when a signal changes, only the effect closures that read it
re-run, and those closures issue mutation ops straight to the core tree. There
is no diffing pass. See [Reactivity](/docs/reactivity/).

**2. A build-time Tailwind-subset compiler, with zero runtime CSS.** Class
strings are parsed at build time. A literal like `class="p-2 rounded-md
bg-blue-600"` compiles to a numeric style record iff *every* whitespace-
separated token is a supported utility; the compiler writes a binary style
table (`styles.bin`) plus a generated lookup, and at runtime a class is just a
`styleId`. There is no CSS engine on the device. Dynamic styling is expressed as
ternaries of whole class literals, `style={{…}}` objects, or `animate()`.
`classList`, `hover:`, and template-interpolated class fragments are compile
errors, not silent no-ops. See [Styling](/docs/styling/) and
[Tailwind subset](/docs/tailwind/).

**3. Baked font atlases.** Text uses **Inter** (OFL), baked into atlases at
build time. The build scans your source for the exact characters and font sizes
you actually use and rasterizes only those atlas slots — supersampled 8-bit
coverage cells with proportional advances and a cmap. There is no font
rasterizer on the device; drawing text is compositing pre-baked coverage. See
[Build pipeline](/docs/build-pipeline/).

## Hello, counter

A complete app: a counter you bump by pressing a focusable button.

```tsx
// app.tsx
import { Text, View } from "@pocketjs/framework/components";
import { createSignal } from "@pocketjs/framework/reactivity";

export default function App() {
  const [count, setCount] = createSignal(0);

  return (
    <View class="flex-col items-center gap-4 p-4 bg-slate-50">
      <Text class="text-xl text-slate-950">Count: {count()}</Text>
      <View
        class="p-2 rounded-md bg-blue-600 focus:bg-blue-500 transition-colors duration-150"
        focusable
        onPress={() => setCount(count() + 1)}
      />
    </View>
  );
}
```

The mount entry is ordinary bootstrap code — the framework detects the host,
loads the generated style table and dcpak assets, and wires up the frame
callback:

```tsx
// main.tsx
import { mount } from "@pocketjs/framework";
import App from "./app.tsx";

mount(() => <App />);
```

Build it with Bun:

```sh
bun scripts/build.ts hero      # -> dist/hero.js + dist/hero.dcpak
```

A few things worth noticing in that example:

- `focus:bg-blue-500` is a **variant** baked into the style record. Focus
  changes swap styles natively, with zero JS on the focus transition.
- `transition-colors duration-150` declares motion; the tween ticks in Rust at
  a fixed `dt = 1/60 s`. JS only declares it.
- `Count: {count()}` is a mixed text run — a static string and a reactive
  expression laid out as one inline run, not two flex items.

## The same source, everywhere

That one `app.tsx` is what runs on every host:

- **PSP hardware** — bundled into an EBOOT, QuickJS evaluating your JS, the core
  driving sceGu.
- **PPSSPP** — the same EBOOT, run headless for end-to-end frame goldens stamped
  with the emulator build.
- **Browser** — the core compiled to WASM with a software rasterizer, drawn to a
  480×272 canvas. Try demos in the [Playground](/playground/).
- **Headless Bun** — the same WASM rasterizer, scripted input, fixed timestep,
  producing byte-exact PNG goldens for the test suite.

Because animation ticks at a fixed `dt` and frame content is a pure function of
the frame index, goldens are byte-exact rather than approximate.

## What v1 punts

PocketJS v1 is deliberately scoped. It does **not** yet include:

- Kinetic / momentum scroll views
- `hover:` variants (there is no pointer on a PSP)
- Percentage sizes beyond `-full`
- `rounded-full` on runtime-sized nodes — it requires build-time-known `w-N h-N`
  in the same class literal
- CLUT / swizzled textures
- Render-to-texture opacity groups (per-vertex alpha is used instead — wrong on
  overlap, fine for demos)
- Kerning
- 3DS / Android hosts

These are omissions, not silent failures: unsupported class tokens and
disallowed patterns surface as loud compile-time or dev errors. See the full
list in the [Tailwind subset](/docs/tailwind/) reference.

## Next steps

- [Getting started](/docs/getting-started/) — install, build, and run your first
  app.
- [Architecture](/docs/architecture/) — how the JS runtime, the Rust core, and
  the four backends fit together.
- [Components](/docs/components/) — `View`, `Text`, `Image`, control flow, and
  the app-shell primitives.
- [Playground](/playground/) — run the demos in your browser.
