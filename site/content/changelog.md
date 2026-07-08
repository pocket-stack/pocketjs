# Changelog

Engine and site milestones, newest first. Versions track the
`@pocketjs/framework` npm package.

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
