# Changelog

Engine and site milestones, newest first. Versions track the
`@pocketjs/framework` npm package.

## 0.8.0 — August 5, 2026

**The runtime learns to be touched and heard, and reaches four new kinds
of machine.** PocketJS 0.8.0 makes Octane the third first-class framework
beside Solid and Vue Vapor, grows a real touch system with gesture
physics and a deterministic audio pipeline, and adds four machine
families: Symbian phones, PocketBook e-readers, the ESP32-P4, and the
Playdate. The [landing page](/) now tells that story: rich interactive
JavaScript where no browser fits.

- **Octane, the third framework.** Dominic Gannaway's compiled
  implementation of the React programming model (`useState`, `useEffect`,
  JSX, no virtual DOM) drives the same native tree as Solid and Vue Vapor
  through a universal framework driver. Every Vue Vapor demo has an Octane
  twin; 14 of the 23 committed Octane PSP goldens are byte-identical to
  the Vue Vapor frame, and the [three-framework
  benchmark](/blog/octane-on-psp/) lands every demo inside the 16.7 ms
  frame budget on real hardware. The port also uncovered that every PSP
  build since 2021 had shipped an unoptimized QuickJS interpreter; the fix
  speeds up every guest app.
- **A real touch system.** Per-contact snapshots carry host-resolved hit
  facts; a gesture layer sits on top with a kinetic scroller tuned to
  iOS-feel physics, axis dominance that defers instead of killing so a
  thumb can arc, and tap activation that presses any focusable.
  `VirtualList` turns the IM thread pattern into a component. The OSK
  gains a modern touch press model, backspace auto-repeat, and
  `TextField`, the editable activation semantic. DevTools tapes add a
  sparse touch track, e2e gains scripted touch input and the first touch
  goldens, and
  [docs/TOUCH.md](https://github.com/pocket-stack/pocketjs/blob/main/docs/TOUCH.md)
  writes down the measured cost model.
- **Audio, credit-based and deterministic.** `globalThis.audio` is a
  spec-first PCM streaming interface: apps push samples against a credit
  budget and hosts drain it, with a web worklet, a sim sink, and a PSP
  hardware channel behind the same contract. Playback defers until fed, so
  replays stay byte-stable, and the music demo plays real WAV files.
- **Symbian, the first phone family.** PocketJS apps run natively on a
  2011 Nokia E7 as installed Symbian applications with their own UIDs: a
  GLES2 renderer, an app catalog, live portrait and landscape relayout,
  and the slide-out QWERTY. The write-up is [Symbian Wanted a Frame
  Function](/blog/pocketjs-on-symbian/).
- **PocketBook, the first e-ink surface.** The inkview host renders
  incrementally and chooses partial, dynamic, or full refresh per update
  from tile diffs, on a display that fights every frame.
- **ESP32-P4, rendered by damage.** An RGB565 raster path and a hybrid
  PPA hardware backend (contributed by @HalfSweet, hardware-verified on an
  M5Stack Tab5 at 1280×720), built on new backend-independent damage
  rendering and transactional strip rendering with a strip-equals-full
  parity suite.
- **Playdate, the fifth Pocket Vapor target.** The 400×240 1-bit panel
  as a 50×30 grid, `.pdx` packaging for device and Simulator, and the
  crank arriving through the hardware-neutral `RelativeAxis` contract:
  hosts preserve signed millidegrees, apps own their detents, and
  admission is checked per target against the real Vue oracle.
- **Vita system services.** The Cover Flow launcher ports to Vita, and
  the svc mailbox goes wireless: a PKNT wire protocol, RAM-assembled
  `.pkst` streams, a video plane, and audio over WiFi TCP.
- **Toolchain.** `--font-regular`/`--font-bold` source overrides in the
  build, Vue SFC template comments handled correctly, and the npm files
  map pinned to its governed surface.
- **Compatibility:** apps and the npm packages build unchanged.
  **Breaking** for native embedders only: `render_scaled_argb` now emits
  the documented little-endian ARGB8888 word layout instead of the
  byte-swapped surface it produced before; re-check any code that consumed
  the old order.

## 0.7.0 — July 23, 2026

**Vue compiles all the way down.** Pocket Vapor takes a real Vue Vapor
component — actual `ref`/`computed`, actual JSX — and emits native code for
machines that could never host a JavaScript engine: Game Boy Advance, Game
Boy, NES cartridges, and now an ESP32 dev board, with the same file proven
cell-identical against real `vue@3.6` after every button press. [The film
and the whole argument](/blog/pocket-vapor/). Around it, the platform grew
a launcher, a package format, and a desktop widget runtime.

- **Pocket Vapor** (`vapor/`) — an AOT compiler for a strict TypeScript
  subset of Vue Vapor: reactivity lowered to dirty-bit dependency masks
  baked into ROM, template bindings to span-merged paint effects, every
  byte planned at compile time (no allocator, no GC). One TodoMVC component
  becomes `.gba`, `.gb`, and `.nes` carts; `SCREEN` folds make layout a
  compile-time constant per target — responsive UI with zero bytes of
  runtime cost.
- **The oracle is real Vue** — the same file runs unmodified on
  `vue@3.6` `runtime-with-vapor`, and the parity suite replays one
  interaction tape through the oracle and every console emulator, comparing
  the full logical grid — characters *and* palettes — after each press.
  `bun run vapor:dev` serves the oracle in a browser to make degradation
  visible before you burn a cart.
- **A class DSL with per-target style contracts** — the same Tailwind
  names the big framework compiles, lowered per machine: GBA palette
  banks (rgb555), ESP32 RGB565 ink/paper pairs, GB/NES two glyph styles by
  luminance. `vapor:check` prints the whole cross-target diagnostics
  matrix in one run; `--strict` turns lossy lowering into failure.
- **ESP32 MeowBit, the fourth target** — an ST7735 RGB565 cell raster,
  release-latched button chords, and a USB verifier that replays the shared
  tape against the *physical* board: 32 full-grid receipts, 23,040
  character/palette cell comparisons, zero tripwires, firmware identity
  hash-checked so a stale flash can't pass.
- **Boards as data, execution classes in the contract** — MCU devices are
  JSON board profiles (pins, panel, pad coverage) validated against the
  runtime; the compiler derives what an app demands (buttons statically
  used, style pairs, grid) and `check --json` judges every registered
  board. pocket.json v2 names the guest/aot split (`execution.classes`) —
  [vapor/BOARDS.md](https://github.com/pocket-stack/pocketjs/blob/main/vapor/BOARDS.md)
  is the scaling argument.
- **Cover Flow launcher + whole-guest app switching** — the launcher is
  Home: scrub a cover deck with real momentum, boot any installed app, and
  SELECT summons the deck from inside a running guest behind a frozen-shot
  veil (ops 39–41). Verified on real PSP hardware.
- **`.pocket` v1** — one app, every target, one file: identity, build
  plan, bundle, and assets as sorted sections with deterministic encoding;
  `build --all-targets`, `thin`, `inspect`, and `verify` in the CLI.
  Devices re-verify the embedded plan against their own profile before
  booting.
- **Widgets grow a family** — the `pocket-widget` crate (demand-rendered
  embedded surfaces with parts + picking), flat widgets — Pocket Note, a
  markdown sticky with selection/undo/clipboard/IME on a new
  `desktop-widget-macos` target — and `pocket-stage` authored 3D stage
  packages: the landing page's PSP is one, an iPod nano is another.
- **Vita renders through GXM** — Pocket3D worlds move off the CPU blitter
  onto the native GPU pipeline.
- **Vue single-file components** — `.vue` SFCs compile through
  `@vue/compiler-sfc` vapor mode in the guest vue-vapor framework, and Vue
  itself moves up to `3.6.0-rc.1` (functional props arrive resolved).
- **Contracts: semantics as fields** — target profiles carry `platform`
  and `form` as queryable fields (ids stay labels nothing may parse), and
  apps declare viewport intent per policy (`fixed`/`dynamic`) instead of
  per target.
- **Compatibility:** existing apps and the npm packages build unchanged;
  the bare fixed-viewport manifest spelling remains valid, and
  `execution.classes` is optional (omitted means guest). The repository
  itself moved to one-axis-per-top-level-directory (`docs/STRUCTURE.md`) —
  contributor-facing only.

## 0.6.0 — July 19, 2026

**The engine leaves the handheld.** The Pocket runtime's first desktop
product surface: transparent widget windows and a VRM character stack,
proven by rebuilding airi's 3D digital human as one native process at
118 MB / 3.9 % of a core — an [order of magnitude below its Electron
stage](/blog/pocket-character/) on every axis, same character, same
behaviors.

- **Widget windows** (pocket3d): `AppConfig` grows `transparent`,
  `decorations`, `always_on_top`, `resizable`, `drag_window`, and `max_fps`
  frame pacing that sleeps between frames instead of spinning on vsync;
  scenes can clear to alpha 0 for desktop-composited windows.
- **Morph targets** (pocket3d): sparse CPU deltas + per-instance overlay
  vertex buffers, flushed only when a weight changes — blend-shape faces
  cost nothing at rest. Draws redirect via `base_vertex`; shared index
  buffers stay untouched.
- **Procedural poses** (pocket3d): `Skeleton::sample_locals` /
  `globals_from_locals` split plus `ModelInstance::pose`, so hosts inject
  look-at and physics edits between clip sampling and the hierarchy walk.
  Joint palettes grow 128 → 512 matrices for VRoid-scale humanoid rigs.
- **pocket-vrm** (new crate): VRM 0.x parsing (humanoid map, blend-shape
  groups, spring config, MToon material info, look-at ranges), a
  deterministic allocation-free spring-bone verlet solver, VRMA retargeting
  with the VRM1 +Z → VRM0 −Z conversion, and bone-type eye look-at —
  21 tests against the real VRoid sample fixture.
- **Asset diet** (pocket3d): `load_glb_opts` skips images no material
  references and caps authoring-resolution textures
  (`max_texture_dim`) — 413 MB of GPU memory back on the reference
  character.
- [pocket-character](https://github.com/pocket-stack/pocket-character):
  the airi-parity widget itself — character surface + QuickJS policy
  bundle, blink/saccade schedulers with airi's exact constants, headless
  render harness, and the [measured report](/blog/pocket-character/).
- **Compatibility:** no breaking changes; `AppConfig` and `ModelInstance`
  gained fields (struct-literal constructors need `..Default::default()`).

## 0.5.0 — July 17, 2026

**The console grows system software.** Streaming media, a system keyboard, a
virtual pointer, and self-diagnosing devices — capabilities every handheld
app needs, now owned by the framework instead of copy-pasted per demo —
proven by [streaming YouTube to a PSP over USB](/blog/pocket-youtube/).

- **App services over USB** — the `pocket-svc` mailbox gives any app a JSON
  command channel to a companion desktop service (request/reply with side
  files for bulk bytes), the same file-transport model DevTools proved,
  hardened against host restarts. Pocket YouTube — search, host-rendered CJK
  result rows, and full-motion playback on real hardware — ships as its own
  app repo (`pocket-stack/pocket-youtube`) built entirely on these APIs.
- **A streaming video plane** — `.pkst` ring files carry palettized frames
  and PCM audio from the host; the native side pumps them under a per-frame
  IO budget, commits texture updates only in the GE-idle window (tear-free
  by construction), and plays audio on a dedicated hardware channel with a
  software resampler. Seek, pause, and epoch resync are part of the
  contract, not the app.
- **A system on-screen keyboard** — `@pocketjs/framework/osk`: an LVGL-style
  variable-width key grid with letters/caps/symbols layers, dark and light
  themes, and a caret-editing session (`createOsk`). While open it owns
  input outright (modal focus scope + button block), retiring the
  gate-every-handler pattern. One component, per-platform input: d-pad
  spatial navigation and the classic PSP chords, front-touch on Vita, and
  the virtual cursor for free.
- **A virtual cursor capability** (`input.cursor`) — the analog nub steers a
  core-drawn pointer; hover *is* focus, so every `focus:` style doubles as
  the hover style, presses arm and fire like real buttons, and d-pad
  traversal stays available as a fallback. Opt-in via `enableCursor()`.
- **Devices that vouch for themselves** — every build embeds an FNV-1a64
  hash of its app bundle; the PSPLINK bridge verifies it against `dist/` on
  every boot and calls out a stale embed (or a silent, pre-handshake build)
  before you trust a single observation. `OP.debugStats` exposes live
  audio/video/transport counters through the new DevTools `devStats` query —
  underruns, torn frames, and truncation resets become one request instead
  of a thread autopsy.
- **Compatibility:** existing apps build unchanged. New host ops (30–38) are
  optional capabilities — hosts that lack them simply omit the op, and the
  framework degrades gracefully (the OSK falls back to bottom-dock geometry
  without hit testing; `devStats` replies `data: null`). PS Vita builds now
  ship complete default LiveArea artwork.

## 0.4.0 — July 13, 2026

**One app, two PlayStations.** PocketJS now treats PSP and PS Vita as two
profiles of one [portable application contract](/docs/platform-contracts/),
with native-density rendering, touch, a reproducible PSP toolchain, and
target-specific golden tests.

- **PS Vita is a first-class target** — the QuickJS + vita2d host renders a
  480×272 logical scene directly at 960×544, bakes fonts, SVGs, and masks at 2×,
  accepts buttons, left-analog, and front multi-touch input, and gives every
  app a stable Title ID and named VPK. `bun play vita <demo>` builds, installs,
  and launches the selected demo in Vita3K; the Vita golden suite exercises
  the same native plan and package path used by release builds.
  [Read the port story](/blog/pocketjs-on-ps-vita/).
- **Portable build contracts** — strict `pocket.json` v2 manifests declare app
  identity, entrypoint, logical viewport, required APIs, and optional
  enhancements. One resolver produces the checked build plan consumed by the
  JS compiler and native backend; unavailable literal `hasFeature()` branches
  fold away at build time. A PSP-baseline app resolves unchanged for Vita,
  while Vita-only touch code can retain a controller fallback.
- **A self-contained PSP toolchain** — `bun run bootstrap` and `pocket setup`
  install exact `pocket-stack` revisions plus a SHA-256-verified SDK into one
  shared cache. `PSP_SDK` and `PSPDEV` remain explicit overrides, but builds no
  longer inspect DreamCart or sibling source checkouts. Cache receipts, staged
  publication, and host-revision checks make setup repeatable across PocketJS,
  OpenStrike, and Pocket Figma.
- **Pocket3D ships on the PSP GE** — the new `no_std` backend consumes cooked
  `.p3d` worlds with PVS/frustum culling, shared collision, CLUT8 mip chains,
  baked vertex lighting, and a composable JSX HUD pass. It is the framework
  path behind [OpenStrike](/blog/shipping-openstrike/), including the texture
  and light-baking improvements proven on real hardware.
- **Determinism now includes time and effects** — the virtual clock,
  frame-boundary effect shell, and headless simulation host make async product
  journeys repeatable across 60 Hz and deliberately slow worlds. Desktop wgpu
  apps join the same DevTools mailbox, while cached text shaping and the
  imperative `hot.text` / `hot.prop` path remove interaction-time PSP spikes.
  [Read the model](/blog/ui-runtime-that-cant-flake/).
- **Large native canvases and richer app chrome** — streamed TILESET entries,
  generation-tagged textures, CLUT8 palettes, and `<DeepZoom>` power the
  compile-time [Pocket Figma](/blog/pocket-figma/) viewer; Vita adds anchored
  pinch, inertial pan, and native-detail tiles. Classic bevel rings, working
  `active:` pressed styles, Pocket Talk's virtualized IM/OSK demo, and a real
  PSP texture-cache fix round out the 2D runtime.
- **Compatibility:** existing script-driven PSP apps continue to build, while
  `pocket.json` is required when opting into `bun pocket` and target-aware
  Vita builds. **Breaking for custom hosts:** `Host.kind` now reports
  `"native"` instead of `"psp"`; manifest bundles require `__host` and
  `__hostAbi`. Rebuild framework/compiler/core/host artifacts together and consume the
  stable `HostBuildInputs` projection rather than the internal build plan.
  Vita builds still require VitaSDK + `cargo-vita`; arbitrary logical sizes
  and dynamic host text are not part of this release.

## 0.3.0 — July 8, 2026

**Pocket DevTools.** Time travel + inspection as framework primitives —
[read the deep-dive](/blog/time-travel-devtools/), design in
[docs/DEVTOOLS.md](https://github.com/pocket-stack/pocketjs/blob/main/DEVTOOLS.md).

- **Component inspector with on-device highlight** — a desktop panel
  (`/devtools`) shows the component tree with semantic names (`debugName`
  prop, `<Named>` wrapper; all demos annotated); hovering a node draws a
  highlight overlay **on the device screen** — the core emits it into the
  DrawList, so real PSP hardware, the wasm rasterizer and wgpu all render
  it. Switching nodes glides the box across the screen.
- **Time travel on an always-on flight recorder** — every bundle records
  its input tape (one `u16`/frame, 10 min ≈ 70 KB); sessions replay
  byte-exactly. Pause / single-step freeze the whole world in the core;
  click the tape strip to seek (reload + deterministic fast-forward).
  `bun run tape` replays headlessly: per-frame hashes,
  first-divergent-frame asserts (session goldens, `bun run tape:check`),
  PNG of any frame, component tree as JSON at any frame.
- **Real PSP debugging over the PSPLINK USB cable** — a `host0:` file
  mailbox (the trace/bench channel, formalized): REPL `eval` into the
  running handheld, the first working `console.log` on PSP, frame-stamped
  error reports, and on-demand 📷 screenshots (raw VRAM rides usbhostfs;
  the desktop bridge encodes the PNG). Verified on hardware.
- **One command** — `bun run devtools [app]` runs the panel, WS hub, USB
  bridge and (optionally) the whole PSP session; detects an existing
  tools/psplink/hw link and bridges into it. Also via the CLI: `pocket devtools`.
- **Breaking:** the `@pocketjs/cli` binary is renamed `pocketjs` → `pocket`.
- New spec ops 18–22 (`debugInspect/RectXY/RectWH/Pause/Step`), all
  debug-only and default-off — shipped rendering is byte-identical.

## 0.2.1 — July 7, 2026

**On npm.** PocketJS is now installable.

- [`@pocketjs/framework`](https://www.npmjs.com/package/@pocketjs/framework)
  and [`@pocketjs/cli`](https://www.npmjs.com/package/@pocketjs/cli) published
  under the MIT license.
- New `pocketjs` CLI — flutter-style `doctor` / `setup` for the bun + Rust +
  PSP toolchain, `create` app scaffolding, and `dev` / `build` / `psp` / `hw` /
  `psplink` passthrough.
- Releases are automated: pushing a version tag publishes both packages from
  GitHub Actions via npm trusted publishing (OIDC), with provenance.

## 0.2.0 — July 7, 2026

**The animation engine.** The Tailwind style table learned motion —
[read the deep-dive](/blog/baking-motion/).

- **Baked keyframe timelines** — `theme.keyframes` / `theme.animation` in
  `pocket.config.ts` (tailwind.config shape) compile into frame-precise,
  per-property segment timelines inside `styles.bin`; `animate-<name>`
  utilities apply them. Full CSS shorthand semantics: comma lists, fills,
  delays, `reverse`, `infinite`, `cubic-bezier(…)` with named easings baked
  to their canonical curves.
- **`animate-loop-[Nms]`** — a style-level loop period that replays a node's
  whole choreography (delays included), the loop plain CSS can't express
  without a remount.
- **3D transform pipeline** — `perspective-[N]` context roots,
  `rotate-x/-y-[deg]`, `translate-z-[px]`; subtrees compose 3×4 matrices,
  project about the root center and painter-sort into clipped triangles.
- **Arc primitive** — `arc-start/-sweep/-width` stroke a round-capped
  annular sector from the background color; all three animatable.
- **`TEX_TRI` DrawList op** — textured triangles in all three backends;
  2D-rotated images un-culled, textures ride 3D surfaces.
- **SVG path baking** — `framework/compiler/bake-svg.ts` rasterizes `<path>` data
  (beziers, winding rules, transforms, `fill="hole"` masks) into pak
  textures.
- **Real-hardware performance** (measured on a PSP over PSPLINK): baked-disc
  rounded corners, incremental taffy layout, a radius-capped disc cache and
  a pipelined CPU/GPU frame loop took the busiest demo page from 17.4 ms
  and dropped frames to a locked 60 FPS.
- **Motion Lab demo** — four pages of yui540's motion studies ported
  one-to-one; now the homepage hero and the playground default.
- Tooling: `bun psplink` rebuilds stale cached PRXs by input mtime.

## 0.1.0 — July 6, 2026

**Initial public release** — [Introducing PocketJS](/blog/introducing-pocketjs/).

- `#![no_std]` Rust core: retained tree, taffy flexbox, compiled Tailwind
  styles, baked font atlases, tween/spring animation, deterministic
  fixed-dt DrawList rendering.
- Real Solid and Vue Vapor components through their official custom
  renderers; React Native-style `<View>` / `<Text>` / `<Image>` primitives.
- Hosts: Sony PSP (QuickJS + sceGu), browser WebAssembly (software
  rasterizer), desktop wgpu window, headless Bun for byte-exact golden
  tests, PPSSPP end-to-end capture harness.
- Two-pass build: class literals and codepoints collected from the AST,
  styles/fonts/images baked into a `.pak`.
- pocketjs.dev: docs, blog, and the in-browser live-recompile playground.
