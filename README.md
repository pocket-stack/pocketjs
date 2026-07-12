<h1><img src="./site/assets/favicon.svg" width="40" height="40" alt="" align="absmiddle" /> PocketJS</h1>

[![@pocketjs/framework](https://img.shields.io/npm/v/%40pocketjs%2Fframework?label=%40pocketjs%2Fframework)](https://www.npmjs.com/package/@pocketjs/framework)
[![@pocketjs/cli](https://img.shields.io/npm/v/%40pocketjs%2Fcli?label=%40pocketjs%2Fcli)](https://www.npmjs.com/package/@pocketjs/cli)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/cTce4eXzSK)

High-performance JSX UI outside the browser, with native rendering, standard
Vue Vapor and Solid support, a Tailwind design system, and 60 FPS animation
under an 8 MB memory budget. Write Solid or Vue Vapor components, run them on
QuickJS, and let PocketJS move layout, styling, text and animation into a tiny
`no_std` Rust core.

It runs on real PSP and PS Vita hardware, PPSSPP, Vita3K, the browser (WASM),
native macOS windows (wgpu) and headless Bun. Full design + contracts:
[DESIGN.md](./DESIGN.md). PocketJS is growing into a family of specialized
runtimes — Rust cores, spec-pinned surfaces, one QuickJS guest — documented
in [RUNTIMES.md](./RUNTIMES.md); the 3D base lives in
[pocket3d/](./pocket3d/), and its first game runtime is
[OpenStrike](https://github.com/pocket-stack/open-strike).

## Screenshots

https://github.com/user-attachments/assets/dbbf656f-a3b2-411d-ab52-fece6a10f68a

These PocketJS UIs run smoothly at 60 FPS on a Sony PSP within an 8 MB memory
budget, including animated transitions and input feedback.

| Gallery | Settings |
| --- | --- |
| ![Gallery demo UI showing a paged texture grid](./assets/screenshots/gallery.png) | ![Settings demo UI showing toggles, a slider and theme swatches](./assets/screenshots/settings.png) |
| **Motion Lab — baked keyframe timelines** | **Motion Lab — 3D pipeline** |
| ![Motion studies: menu, d-pad, share, hover, reload and keypad animating from compile-time keyframe timelines](./assets/screenshots/motions-53.gif) | ![3D motion studies: a swinging door, spinning cubes, page flips and a room transition, painter-sorted by the core](./assets/screenshots/motions-3d.gif) |

## Quickstart

```sh
bun install
bun pocket check --target psp         # schema + capabilities + ordinary app TypeScript
bun pocket compile --target psp       # check + emit JS/pak from the resolved plan
bun pocket build --target psp -- --release

# Low-level compiler commands used by framework demos/tests:
bun scripts/build.ts hero             # -> dist/hero.js + dist/hero.pak
bun scripts/build.ts hero-vue-vapor-main --framework=vue-vapor
```

Or drive everything through the [`pocket` CLI](https://www.npmjs.com/package/@pocketjs/cli):
`npm i -g @pocketjs/cli`, then `pocket doctor` checks the bun / Rust / PSP
toolchain (`pocket setup` installs what's missing), `pocket create <name>`
scaffolds an app, and `pocket dev|build|psp|hw|psplink` wrap the scripts
below.

The build is two-pass: pass 1 babel-transforms every module reachable from the
entry (framework-specific JSX + TypeScript, content-hash cached in
`.cache/`) while collecting class strings + text codepoints from the AST; then
the Tailwind compiler writes `styles.bin` + `src/styles.generated.ts`, the font
baker rasterizes Inter atlas slots for exactly the characters your app uses,
and everything is packed into `dist/<app>.pak`. Pass 2 bundles with Bun
(iife, unminified) from the cached transforms.

```tsx
import { createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";

export default function Counter() {
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

Mounting entries should look like ordinary app bootstrap code; the framework
handles host detection, the generated style table, pak image uploads and the
host frame callback:

```tsx
import { mount } from "@pocketjs/framework";
import App from "./app.tsx";

mount(() => <App />);
```

Styling rules (compile-time, no runtime CSS): a class literal compiles iff
*every* token is a supported utility (see DESIGN.md "Tailwind subset (v1)");
dynamic styling is ternaries of full literals, `style={{...}}`, or `animate()`.
`classList`, `hover:` and template-interpolated classes are compile errors.
`rounded-full` requires `w-N h-N` in the same literal.

Framework selection is explicit: set `framework: "solid"` or
`framework: "vue-vapor"` in `pocket.config.ts`, or pass `--framework=...` to
`scripts/build.ts`, `scripts/dev.ts`, or `scripts/psp.ts`. App state and
component lifecycle come from the native framework package (`solid-js` or
`vue`); PocketJS supplies host components, input, animation, assets and native
runtime wiring.

`@pocketjs/framework/components` also exposes small app-shell primitives:
`Screen`, `Focusable`, `FocusScope`, `ActionHandler`, `FocusGrid`, `Portal`,
`Modal`, and `ActionBar`. `FocusGrid` gives a subtree explicit row/column d-pad
traversal today; a virtualized grid can sit behind the same focus contract
later. `Portal` mounts into the runtime overlay root, so modal/action-bar UI
never participates in the active screen's flex layout. `Modal` owns a focus
scope and blocks background button handlers while leaving frame animation
lifecycle callbacks running; route switching is still ordinary app state, not a
required router package.

## Commands

```sh
bun play vita hero                    # build, install and launch in Vita3K
bun play vita gallery --fullscreen    # stretch to the host's full screen
bun play --help                       # list every runnable demo
bun run test                          # spec contract + tailwind parser tests
bun pocket check --target psp         # validate pocket.json + resolved target contract
bun pocket compile --target psp       # typecheck and compile, for custom native hosts
bun pocket build --target psp         # typecheck, compile, and package the target
bun scripts/build.ts <app> [--framework=solid|vue-vapor] [--extra-chars=…]
bun run psp / bun run vita / bun run dev / bun run wasm
bun run e2e:vita                     # Vita3K, 960x544 exact-2x golden E2E
bun psplink                           # interactive real PSP switcher over PSPLINK
bun run hw hero --trace              # real PSP via PSPLINK + host0 trace
bunx tsc --noEmit                     # typecheck (babel owns the JSX transform)
```

Manifest-driven builds resolve `pocket.json` once into a small
`ResolvedBuildPlan`. The JS/font/pak compiler and native backend consume that
same serialized plan; `planHash` is only its build-time checksum. At startup,
the bundle checks the native host's target and HostOps ABI. The app entry and
its reachable imports use the app's ordinary TypeScript configuration.

Capabilities are plain framework API identifiers. `requires` must exist on the
selected host; `enhances` resolves to booleans available from
`@pocketjs/framework/platform`:

```ts
import { platform } from "@pocketjs/framework/platform";

if (platform.features["input.touch"]) installTouchControls();
else installButtonControls();
```

They describe fixed host API support, not permissions or live device state.
Custom native hosts should use `extractHostBuildInputs()` and
`hostBuildEnvironment()` from `@pocketjs/framework/manifest`; the complete
Plan remains an internal build IR.

The complete design, including authority boundaries, compatibility rules,
typed backend dispatch, runtime hash handshake, extension points, and current
limitations, is documented in
[Platform contracts](./site/content/docs/platform-contracts.md).

The Vita host is documented in [native-vita/README.md](./native-vita/README.md).
It fills the native 960x544 screen by scaling PocketJS's 480x272 logical
viewport exactly 2x. Physical controls and analog input are supported; touch
input is intentionally deferred.

## DevTools + time travel

Pocket DevTools ([DEVTOOLS.md](DEVTOOLS.md)) is built into every bundle: a
component tree with semantic names (`debugName` / `<Named>`), hover-to-
highlight **on the device screen** (real PSP included, over the PSPLINK USB
cable), pause/step, a REPL, `console.log` from hardware, and an always-on
input-tape flight recorder — sessions replay byte-exactly because the whole
runtime is fixed-dt deterministic.

```sh
bun run devtools                      # panel + hub + USB bridge, one process
bun run devtools cards                # + build, link and launch cards on a real PSP
bun run tape replay <app> <tape.json> --png 60   # render any frame headlessly
bun run tape:check                    # session-golden replay regression
```

On-demand device screenshots (📷 in the panel) work on every host — on real
hardware the raw VRAM rides the usbhostfs mount and the bridge encodes the
PNG desktop-side.

## Determinism + the sim host

Time is a frame counter, not the wall clock ([DETERMINISM.md](DETERMINISM.md)):
the virtual clock (`@pocketjs/framework/clock`) makes the simulation rate a
host policy (`?hz=2` on the web host runs the 2 FPS world on a real screen),
the effect shell (`@pocketjs/framework/effects`) quantizes async results onto
frame boundaries, and the headless sim host (`host-sim/`) replays scripted
user journeys as byte-exact per-frame pixel traces — `test/sim.test.ts` is
the proof, `scripts/flake-lab.ts` the wall-clock control experiment.

Fonts: Inter (OFL), vendored in `assets/fonts/`.
