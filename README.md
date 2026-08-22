<h1><img src="./site/assets/favicon.svg" width="40" height="40" alt="" align="absmiddle" /> PocketJS</h1>

[![@pocketjs/framework](https://img.shields.io/npm/v/%40pocketjs%2Fframework?label=%40pocketjs%2Fframework)](https://www.npmjs.com/package/@pocketjs/framework)
[![@pocketjs/cli](https://img.shields.io/npm/v/%40pocketjs%2Fcli?label=%40pocketjs%2Fcli)](https://www.npmjs.com/package/@pocketjs/cli)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/cTce4eXzSK)

[Website](https://pocketjs.dev) ·
[Playground](https://pocketjs.dev/playground/) ·
[Documentation](https://pocketjs.dev/docs/overview/) ·
[Blog](https://pocketjs.dev/blog/) ·
[Changelog](https://pocketjs.dev/changelog/) ·
[Pocket Lab](https://pocketlab.build) ·
[Pocket Museum](https://museum.pocketlab.build/)

## Keeps JSX, Tailwind and reactive state. Removes every layer below them.

PocketJS is a UI runtime with **no DOM, no CSS engine and no WebView**. An app
is a QuickJS guest on a Rust core that performs flexbox layout and draws every
pixel itself, in **one thread inside one process**. The frameworks, the class
strings and the reactive state stay the ones you already use; everything under
them is replaced.

<a href="https://pocketjs.dev">
  <img src="./site/assets/pocketjs-demo-wall.jpg" alt="A wall of PocketJS software: music, deep-zoom graphics, messaging, a digital character, galleries, DevTools, dashboards, media, and a café app, alongside OpenStrike, Pocket Voxel and Pocket Figma on PSP, including Motion Lab studies credited to yui540" />
</a>

## Write components as you already do

Three frameworks compile to the same native tree and run on the same QuickJS
guest, so the framework you pick changes your code and nothing below it.

| Framework | State and lifecycle | Source forms |
| --- | --- | --- |
| **Solid** | `solid-js` | JSX |
| **Vue Vapor** | `vue` | JSX and `<script setup>` single-file components |
| **Octane** | `octane` | Compiled hooks and JSX, with no virtual DOM |

Framework primitives come directly from `solid-js`, `vue`, or `octane`.
PocketJS owns the runtime, host components, lifecycle wiring, input, animation,
assets, and the native boundary.

```tsx
import { createSignal, Show } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/solid/components";

function Counter() {
  const [count, setCount] = createSignal(0);

  return (
    <View class="w-full h-full flex-col items-center gap-4 p-4 bg-slate-50">
      <Text class="text-xl text-slate-950 font-bold">Count: {count()}</Text>
      <View
        class="px-4 py-2 rounded-xl shadow-md bg-blue-600 focus:bg-blue-500"
        focusable
        onPress={() => setCount(count() + 1)}
      >
        <Text class="text-base text-white font-bold">Press Circle</Text>
      </View>
      <Show when={count() > 3}>
        <Text class="text-sm text-emerald-600">Reactive on real hardware.</Text>
      </Show>
    </View>
  );
}

mount(() => <Counter />);
```

Class literals compile into a baked style table at build time. There is no
runtime CSS parser, cascade, or specificity resolution, and no reflow: the core
lays out the tree and emits a draw list that the target backend submits through
GE, GXM, Metal, wgpu, software rasterization, e-ink updates, or another declared
host.

```text
PocketJS · 1 thread, 1 process
  your component                        guest
  renderer adapter                      guest
  native tree                           core
  flexbox layout, baked style table     core
  drawlist                              core
  backend draw                          core
  → pixels

Browser or WebView · 4 threads, 2 processes
  your component                        main
  framework runtime, vdom diff          main
  dom mutation                          main
  cssom, cascade, specificity           main
  style recalculation                   main
  layout, reflow                        main
  paint records                         main
  commit the layer tree across threads
  layer tree, tiling compositor         compositor
  queue raster tasks, invalidations     compositor
  rasterization                         raster pool
  ipc to the gpu process, sync fences
  draw quads                            gpu
  present                               gpu
  → pixels
```

One bundle serves machines of different densities. The manifest declares what
the app needs, and the target is checked against it before a build proceeds —
from the app directory, against its `pocket.json`:

```sh
pocket check --target psp     # ok  480x272 · text.glyphs.baked · input.buttons
pocket check --target vita    # ok  same bundle, density 2, no component edited
```

See [Frameworks](https://pocketjs.dev/docs/frameworks/),
[Architecture](https://pocketjs.dev/docs/architecture/) and
[Styling](https://pocketjs.dev/docs/styling/).

## Animation is compiled

Keyframe timelines and spring curves are baked into the style table at build
time and advanced by the Rust core on its own clock, so a screen can **animate
with no per-frame JavaScript at all**. Motion Lab runs the yui540 studies in
WebAssembly on [pocketjs.dev](https://pocketjs.dev), and on the handheld they
were written for.

| Baked keyframe timelines · (yui540) | 3D motion pipeline · (yui540) |
| --- | --- |
| ![Motion studies by yui540: menu, d-pad, share, hover, reload and keypad animations](./assets/screenshots/motions-53.gif) | ![3D motion studies by yui540: door, cubes, page flips and room transition](./assets/screenshots/motions-3d.gif) |

## What it asks of the machine

With no browser engine in the middle, the cost of a screen is close to what the
bare metal can do. A whole PocketJS app drawing a smooth interface **lives in
8 MB on a single 333 MHz core** — a quarter of the PSP's 32 MB, one part in 1536
of a 12 GB iPhone 17 Pro Max, on a core clocked 13 times slower than an A19 Pro
performance core at 4.26 GHz.

Benchmarked on a Sony PSP — one MIPS core at 333 MHz, 32 MB of RAM, 2004
hardware, against the 16.67 ms budget for 60 fps:

| Measurement | Result |
| --- | --- |
| OpenStrike frame budget | **2.2 ms** of JavaScript, 8.4 ms of total CPU work, worst observed frame 9.7 ms |
| Hero demo, why not just ship a virtual DOM | Solid 15.15 ms · Vue Vapor 16.74 ms · **Vue with a virtual DOM 90.75 ms** |
| Hero demo, the three shipped frameworks | Solid 3.66 ms · Vue Vapor 3.61 ms · Octane 6.53 ms |

Seven samples per app. The two hero-demo rows come from separate runs and the
toolchain got faster in between, so read each on its own terms rather than
across them.

The same markdown editor, shelled three ways on an Apple M3 Max
([full report](./docs/bench/gpui-vs-tauri-electron-2026-08-18.md), reproduce
with `bun tools/bench-desktop.ts`):

| | pocket | Tauri v2 | Electron |
| --- | --- | --- | --- |
| Processes | **1** | 4 | 5 |
| Cold start to first painted frame | **149 ms** | 380 ms | 301 ms |
| Idle resident memory | **83 MB** | 193 MB | 382 MB |
| On disk | 10 MB | 9 MB | 242 MB |

Left alone with a document open, the pocket build redraws **about twice a
second**: the caret blinking, and nothing else. The report also records where
the pocket build loses, and why — the storm CPU ramps with document length,
because the note re-wraps the whole document through the QuickJS interpreter on
every keystroke.

Further reading: [Shipping OpenStrike](https://pocketjs.dev/blog/shipping-openstrike/) ·
[Pocket Character](https://pocketjs.dev/blog/pocket-character/) ·
[Twice the pixels, zero forks](https://pocketjs.dev/blog/pocketjs-on-ps-vita/) ·
[The first iPhone](https://pocketjs.dev/blog/pocketjs-on-the-first-iphone/)

## The frame contract

Time is the frame counter. One `frame(buttons)` call is a transaction nothing
outside it can interrupt, and nothing waits on a wall clock, so tests run as
fast as the CPU allows without changing the timing they measure: a journey that
takes six seconds in front of a user is a few dozen frames in CI.

```text
state n+1 = F(state n, input n)
pixels n  = G(state n)
```

- **Effects land on frame boundaries.** A network reply that arrives partway
  through frame +3 is queued, not applied. It is delivered at the start of
  frame +4, in FIFO order, before any app hook runs. No microtask races, no
  mid-frame callbacks, and `after()` replaces `setTimeout` with a deadline
  measured in frames.
- **The same async task lands on the same frame.** Driven by
  `requestAnimationFrame` against a wall clock, one awaited confirmation lands
  on **22 different frames** across 60 runs and its timing assertion passes
  **9 times out of 60**. On the frame clock it lands on **frame 144 in every
  run**, 60 out of 60.
- **History is a data structure.** Tapes replay byte-for-byte, a session
  subsampled to 2 Hz is byte-identical to its 60 Hz counterpart, and forking a
  tape at frame 9 to splice in a different press produces a counterfactual
  world in **22 ms**.
- **Chaos mode proves the floor holds**, injecting real sleeps, allocation
  churn and forced GC between frames without moving the trace by one bit.

Further reading: [The runtime that can't flake](https://pocketjs.dev/blog/ui-runtime-that-cant-flake/) ·
[Time-travel DevTools](https://pocketjs.dev/blog/time-travel-devtools/) ·
[Determinism](./docs/DETERMINISM.md)

## Beyond 2D UI: mount what the content needs

PocketJS is an application runtime with a game engine's architecture, so a game
and an app are built the same way. Cores are **independent native modules,
loaded the way a kernel loads drivers**: an app takes the ones its content needs
and the rest never enters the build. Adding one widens what the program is
allowed to ask for; it never changes how the program is written.

```text
guest program · your JavaScript, one frame at a time
  ui       tree, layout, draw, input, focus
  net      poll batches
  audio    pcm mixer
  strike   bsp, bots, hits
  voxel    chunks, meshing
```

Further reading: [Core concepts](https://pocketjs.dev/docs/concepts/) ·
[The runtime family](./docs/RUNTIMES.md) ·
[Pocket3D](./engine/pocket3d/README.md)

## Compatibility: run on the metal, not emulated

Not a roadmap. Every entry below has booted the runtime on the real machine, and
what changes between them is one native submission layer, never the
application. Keeping the hardware bootable is its own work, so we started
[Pocket Museum](https://museum.pocketlab.build/) to repair these machines and
keep them running.

| Operating system | Native submission layer | Receipt |
| --- | --- | --- |
| PSP system software | MIPS, 32 MB | [Introducing PocketJS](https://pocketjs.dev/blog/introducing-pocketjs/) |
| PS Vita system software | ARM, GXM | [Twice the pixels, zero forks](https://pocketjs.dev/blog/pocketjs-on-ps-vita/) |
| iPhone OS 3.1.3 | ARMv6, GL ES 1.1 | [The first iPhone](https://pocketjs.dev/blog/pocketjs-on-the-first-iphone/) |
| iOS 6.1.3 | ARMv7 | [`hosts/iphone4s`](./hosts/iphone4s) |
| iOS 12.5.8 | arm64 | [#278](https://github.com/pocket-stack/pocketjs/pull/278) |
| iOS, current | NativeScript host | [#256](https://github.com/pocket-stack/pocketjs/pull/256) |
| macOS | Metal window and widget | [#293](https://github.com/pocket-stack/pocketjs/pull/293) |
| Symbian Belle | Qt, GLES2 | [Symbian wanted a frame function](https://pocketjs.dev/blog/pocketjs-on-symbian/) |
| Windows CE 6 | GDI framebuffer | [From message pump to multitouch](https://pocketjs.dev/blog/pocketjs-on-windows-ce/) |
| BlackBerry 10.3 | QNX, native ELF | [One square screen, two native stacks](https://pocketjs.dev/blog/blackberry-classic/) |
| Android 4.3 | BlackBerry runtime, JNI | [#298](https://github.com/pocket-stack/pocketjs/pull/298) |
| PocketBook e-ink | inkview, partial refresh | [#172](https://github.com/pocket-stack/pocketjs/pull/172) |
| ESP-IDF | RGB565 and PPA | [#160](https://github.com/pocket-stack/pocketjs/pull/160) |
| The browser | WebAssembly core | [Playground](https://pocketjs.dev/playground/) |

Devices it has booted on: **Sony PSP** (2004) · **PS Vita** (2011) ·
**iPhone** (2007) · **iPhone 4S** (2011) · **iPod touch 6** (2015) ·
**Nokia E7** (2011) · **Meizu M8** (2009) · **BlackBerry Classic** (2014) ·
**PocketBook reader** (e-ink) · **ESP32-P4 devkit** (microcontroller) ·
**Mac** (Apple silicon).

The authoritative host and target inventory lives in
[`contracts/spec/platforms.ts`](./contracts/spec/platforms.ts); an entry there
records what has been verified and how. See
[Platform contracts](https://pocketjs.dev/docs/platform-contracts/) and the
[Native contract](https://pocketjs.dev/docs/native-contract/).

## Shipped on the runtime

| Project | What it carries |
| --- | --- |
| [**OpenStrike**](https://pocketjs.dev/blog/shipping-openstrike/) | A Counter-Strike-shaped shooter on 2004 hardware: BSP maps, bots, and a HUD written in Solid JSX, at 60 fps with 2.2 ms of JavaScript per frame |
| [**Pocket Voxel**](https://pocketjs.dev/blog/pocket-voxel/) | A creature-RPG town rebuilt as a walking voxel diorama. Game state lives in the JS guest; logic runs at 60 Hz while presentation holds a locked 30 fps beat |
| [**Pocket Figma**](https://pocketjs.dev/blog/pocket-figma/) | A real 14,430-node design file, cooked into streamed tile pyramids and panned with the analog nub at 60 fps on a handheld with 32 MB of RAM |
| [**Pocket Character**](https://pocketjs.dev/blog/pocket-character/) | A rigged VRM companion in a transparent always-on-top window, rendering skinned 3D at 60 fps in one process and 118 MB, against 8 processes and 2184 MB for the Electron build of the same idea |
| [**Pocket YouTube**](https://pocketjs.dev/blog/pocket-youtube/) | Search, thumbnails, playback and seeking on a console that predates streaming, where the network is a USB cable and a Mac companion does the fetching |
| [**Pocket DevTools**](https://pocketjs.dev/blog/time-travel-devtools/) | Time-travel debugging over a USB cable at 2 bytes per frame. The inspector highlight is emitted by the core into the draw list, so it renders on the device, on every backend |
| [**Pocket Launcher**](./docs/LAUNCHER.md) | Whole-app lifecycle, target admission, frozen shots, and guest switching on PSP and Vita |
| [**Pocket Pi**](https://github.com/pocket-stack/pocket-pi) | A coding agent running inside the QuickJS guest environment, with no Node underneath |

<p align="center">
  <a href="https://github.com/pocket-stack/pocket-voxel"><img src="./site/assets/blog/voxel-psp-pallet-town.png" width="720" alt="Pocket Voxel on a real PSP: Pallet Town as a voxel diorama with gabled roofs, carved bushes, flowers, an NPC and the player on the path, in per-tile color." /></a>
</p>

<p align="center"><em>Pocket Voxel, captured on a PSP-2000: the flat Game Boy world standing up as geometry. <a href="https://pocketjs.dev/blog/pocket-voxel/">The making-of story</a>.</em></p>

## Try it

The fastest zero-install path is the online
[Playground](https://pocketjs.dev/playground/). Local browser development needs
[Bun](https://bun.sh/) and [Rust via rustup](https://rustup.rs/):

```sh
git clone https://github.com/pocket-stack/pocketjs
cd pocketjs
bun install
rustup target add wasm32-unknown-unknown
bun run dev                    # build WASM + the Hero app, then serve the browser host
```

The CLI operates inside a PocketJS checkout:

```sh
npm install -g @pocketjs/cli
pocket doctor                  # report missing host and target tooling
pocket setup                   # install the pinned web + PSP toolchain
pocket create my-app
pocket check --target psp --manifest apps/my-app/pocket.json
pocket build --target psp --manifest apps/my-app/pocket.json -- --release
```

Vita packaging additionally needs VitaSDK and the pinned Rust toolchain
documented in [`hosts/vita/README.md`](./hosts/vita/README.md). Guest builds can
be packaged as inspectable, target-thinnable
[`.pocket` files](./docs/PLATFORM.md) instead of ad hoc port directories.

## Machines without a JavaScript engine

Where even QuickJS is too much, [Pocket Vapor](./vapor/README.md) compiles a
strict Vue Vapor subset ahead of time into target-native C: `.gba`, `.gb`,
`.nes`, ESP32 firmware, and Playdate `.pdx` artifacts, with no JS engine, GC, or
allocator on the device. It is a separate compiler with its own target and board
contracts, not a low-memory mode for arbitrary PocketJS apps.

```sh
bun run vapor:dev             # run the component against the real Vue oracle in a browser
bun run vapor:test            # oracle + compiler + console parity suites
bun vapor/compiler/cli.ts vapor/examples/todo/todo.tsx --target gb
```

Compiler-derived demands are checked against a target or board profile before
lowering; see [`vapor/DESIGN.md`](./vapor/DESIGN.md).

## Repository map

| Path | Responsibility |
| --- | --- |
| [`framework/`](./framework/) | Public framework APIs, renderers, components, input, lifecycle, and build-time styling |
| [`engine/`](./engine/) | `no_std` UI core, render backends, native modules, Pocket3D, and platform-native crates |
| [`contracts/`](./contracts/) | Generated wire specs, capability registry, manifests, build plans, and package formats |
| [`hosts/`](./hosts/) | PSP, Vita, web, desktop, e-reader, phone, and MCU host integrations |
| [`vapor/`](./vapor/) | Pocket Vapor compiler, oracle, board contracts, target runtimes, and parity harnesses |
| [`apps/`](./apps/) | Framework demos and system applications used by the launcher and acceptance suites |
| [`tools/`](./tools/) | Build, package, launcher, device, DevTools, benchmark, and release commands |
| [`tests/`](./tests/) | Contract, compiler, simulation, emulator, package, and golden verification |
| [`docs/`](./docs/) | Platform, runtime, determinism, DevTools, backend, and benchmark records |

Common repository checks (emulator journeys require their external toolchains):

```sh
bun run test                  # contracts, compiler, packages, sims, and host suites
bun run golden                # deterministic WASM/web frame goldens
bun run e2e                   # PPSSPP journey
bun run e2e:vita              # Vita3K native-density journey
bun run site:build            # docs, playground, Stage, and landing build
```

## Who builds this

[Pocket Lab](https://pocketlab.build) is an independent, non-VC-backed
organization built on this runtime, so that the joy of creating belongs to
everyone. Development is funded by
[sponsors](https://github.com/sponsors/doodlewind).

## Motion Lab attribution

The original motion studies are by [yui540](https://yui540.com/). PocketJS
accepts yui540's two stated conditions for continued use: Motion Lab carries
the requested `(yui540)` on-screen credit, and any other yui540 animation
requires separate permission before it is ported. The accepted scope and
capture-maintenance rules are recorded in
[`apps/motions/ATTRIBUTION.md`](./apps/motions/ATTRIBUTION.md).

## License

PocketJS is [MIT licensed](./LICENSE). Inter is vendored under the OFL in
[`assets/fonts/`](./assets/fonts/).
