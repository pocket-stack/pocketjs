<h1><img src="./site/assets/favicon.svg" width="40" height="40" alt="" align="absmiddle" /> PocketJS</h1>

High-performance JSX UI outside the browser, with native rendering, standard
Vue Vapor and Solid support, a Tailwind design system, and 60 FPS animation
under an 8 MB memory budget. Write Solid or Vue Vapor components, run them on
QuickJS, and let PocketJS move layout, styling, text and animation into a tiny
`no_std` Rust core.

It runs on real PSP hardware, PPSSPP, the browser (WASM), native macOS
windows (wgpu) and headless Bun. Full design + contracts:
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

## Quickstart

```sh
bun install
bun scripts/build.ts hero             # -> dist/hero.js + dist/hero.pak
bun scripts/build.ts hero-vue-vapor-main --framework=vue-vapor
```

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
bun run test                          # spec contract + tailwind parser tests
bun scripts/build.ts <app> [--framework=solid|vue-vapor] [--extra-chars=…]
bun run psp / bun run dev / bun run wasm      # EBOOT / web host / wasm core
bun psplink                           # interactive real PSP switcher over PSPLINK
bun run hw hero --trace              # real PSP via PSPLINK + host0 trace
bunx tsc --noEmit                     # typecheck (babel owns the JSX transform)
```

Fonts: Inter (OFL), vendored in `assets/fonts/`.
