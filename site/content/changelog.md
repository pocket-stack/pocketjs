# Changelog

Engine and site milestones, newest first. Versions track the
`@pocketjs/framework` npm package.

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
  `__hostAbi`. Rebuild compiler/core/host artifacts together and consume the
  stable `HostBuildInputs` projection rather than the internal build plan.
  Vita builds still require VitaSDK + `cargo-vita`; arbitrary logical sizes
  and dynamic host text are not part of this release.

## 0.3.0 — July 8, 2026

**Pocket DevTools.** Time travel + inspection as framework primitives —
[read the deep-dive](/blog/time-travel-devtools/), design in
[DEVTOOLS.md](https://github.com/pocket-stack/pocketjs/blob/main/DEVTOOLS.md).

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
  psplink/hw link and bridges into it. Also via the CLI: `pocket devtools`.
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
- **SVG path baking** — `compiler/bake-svg.ts` rasterizes `<path>` data
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
