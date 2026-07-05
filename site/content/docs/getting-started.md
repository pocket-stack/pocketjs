# Getting started

This is the fastest path from an empty checkout to JSX running on screen. You'll
write a component, mount it, build it, and see it in the browser dev host — the
same bundle that also runs on a real Sony PSP, PPSSPP, and headless Bun.

If you only want to *try* PocketJS, skip the toolchain entirely and open the
online [Playground](/playground/): it runs the Rust core as WebAssembly in your
browser, so you can edit JSX and see it render with nothing installed. Everything
below is the local workflow.

## Prerequisites

The JavaScript workflow needs one tool. The Rust toolchains are only required for
the targets that compile the core natively — you don't need them to write UI.

| You want to…                          | You need                                                        |
| ------------------------------------- | --------------------------------------------------------------- |
| Write components, build bundles       | [Bun](https://bun.sh) (drives the build, tests, and dev host)   |
| Run the local **browser** dev host    | Bun + Rust with the wasm target (`rustup target add wasm32-unknown-unknown`) |
| Ship a **PSP EBOOT** / run on hardware | Rust **nightly** + [`cargo-psp`](https://github.com/overdrivenpotato/rust-psp) |

The Rust core is `no_std` and gets built once per platform. For this guide we
stay on the JS side and let the dev host compile the wasm core for us.

## Install

```sh
git clone https://github.com/pocket-stack/pocketjs
cd pocketjs
bun install
```

That pulls `solid-js`, Vue Vapor dependencies, and the build-time tooling (the
Babel + Tailwind-subset compiler, the font baker, and the dev host). There is no
separate runtime to install — the framework is the `@pocketjs/framework` package
in this repo, exposed through subpath imports like
`@pocketjs/framework/components`.

## Write your first component

A component returns JSX. You lay out with `View`, draw text with `Text`, and
style with `class` — a **build-time subset of Tailwind**, not runtime CSS.
State comes directly from the selected framework: `createSignal` in Solid,
`ref` in Vue Vapor.

Solid is the default framework. Vue Vapor is selected with `pocket.config.ts` or
`--framework=vue-vapor`; see [Frameworks](/docs/frameworks/) for the full
selection model.

Here's a focusable counter. Put it in `demos/hero/app.tsx`:

:::framework-code
```tsx solid
import { createSignal, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";

export default function App() {
  const [count, setCount] = createSignal(0);
  return (
    <View class="w-full h-full flex-col items-center gap-4 p-4 bg-slate-50">
      <Text class="text-xl text-slate-950 font-bold">Count: {count()}</Text>

      <View
        class="px-4 py-2 rounded-xl shadow-md bg-blue-600 focus:bg-blue-500 active:bg-blue-700 transition-colors duration-150"
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
```

```tsx vue-vapor
import { ref } from "vue";
import { Text, View } from "@pocketjs/framework/components";

export default function App() {
  const count = ref(0);
  return () => (
    <View class="w-full h-full flex-col items-center gap-4 p-4 bg-slate-50">
      <Text class="text-xl text-slate-950 font-bold">Count: {count.value}</Text>

      <View
        class="px-4 py-2 rounded-xl shadow-md bg-blue-600 focus:bg-blue-500 active:bg-blue-700 transition-colors duration-150"
        focusable
        onPress={() => {
          count.value++;
        }}
      >
        <Text class="text-base text-white font-bold">Press Circle</Text>
      </View>

      {count.value > 3 ? (
        <Text class="text-sm text-emerald-600">Reactive on real hardware.</Text>
      ) : null}
    </View>
  );
}
```
:::

What's happening:

- **Layout** is flexbox. `flex-col`, `items-center`, `gap-4`, `p-4` compile to a
  layout the Rust core runs through [taffy](/docs/architecture/). See
  [Components](/docs/components/) for the full element set.
- **Styling** is class literals only. Each utility (`bg-blue-600`,
  `rounded-xl`, `text-white`, …) is resolved at build time into a style table —
  there is no CSS at runtime. The `focus:` and `active:` variants swap styles
  based on input state. Details in [Styling](/docs/styling/) and the exact
  supported utilities in [Tailwind subset](/docs/tailwind/).
- **`focusable`** opts the `View` into d-pad focus, and **`onPress`** fires when
  the focused node is confirmed (the Circle button on a PSP). Focus and input
  are covered in [Input & focus](/docs/input-focus/).
- **`{count()}` / `{count.value}`** is a reactive read. When the setter or ref
  write runs, only that `Text` updates — no re-render of the whole native tree.
  More in [Reactivity](/docs/reactivity/).

## The mount entry

`app.tsx` exports a component but doesn't put anything on screen. The **mount
entry** does that. Keep it tiny — this is just app bootstrap. Put it in
`demos/hero/main.tsx`:

:::framework-code
```tsx solid
// @title PocketJS: Hero
import App from "./app.tsx";
import { mount } from "@pocketjs/framework";

mount(() => <App />);
```

```tsx vue-vapor
// @title PocketJS: Hero Vue Vapor
import App from "./app.tsx";
import { mount } from "@pocketjs/framework";

mount(App);
```
:::

`mount` is imported from the package root, `@pocketjs/framework`. It handles host
detection (PSP vs. PPSSPP vs. browser vs. Bun), wiring the generated style table,
uploading images from the packed asset file, and installing the per-frame host
callback — you don't manage any of that yourself. (`mount` builds on the
lower-level `render` export from the same module; `mount` is what you want for an
app.)

## Build it

One command transforms your app, compiles the styles it actually uses, bakes only
the glyphs it actually renders, and bundles everything:

```sh
bun scripts/build.ts hero
```

For Vue Vapor, select the framework explicitly or put it in `pocket.config.ts`:

:::framework-code
```sh solid
bun scripts/build.ts hero
```

```sh vue-vapor
bun scripts/build.ts hero --framework=vue-vapor
```
:::

This produces two files in `dist/`:

| File              | What it is                                                                 |
| ----------------- | ------------------------------------------------------------------------- |
| `dist/hero.js`    | Your app bundled to a single IIFE (unminified) that any host loads        |
| `dist/hero.pak` | The packed asset file: the compiled style table, font atlases, and images |

Vue Vapor builds use the `.vue-vapor` suffix, for example
`dist/hero.vue-vapor.js` and `dist/hero.vue-vapor.pak`.

A few notes on the command:

- The argument resolves against `demos/`. `hero` → `demos/hero/app.tsx`. To build
  the **mounted** entry instead, target `main.tsx` — either
  `bun scripts/build.ts demos/hero/main.tsx` or the shorthand
  `bun scripts/build.ts hero-main`, which emits `dist/hero-main.js`. The dev host
  runs the mounted `-main` bundle.
- `--extra-chars=<string>` forces extra codepoints into every font atlas — useful
  when text is data-driven and not present in the source:

  ```sh
  bun scripts/build.ts hero --extra-chars="0123456789€"
  ```

## Run it

### In the browser dev host

The dev host builds the wasm core, builds the mounted demo, and serves it:

```sh
bun scripts/dev.ts          # builds the wasm core + hero-main, then serves
# or: bun run dev
```

:::framework-code
```sh solid
bun scripts/dev.ts hero-main
```

```sh vue-vapor
bun scripts/dev.ts --framework=vue-vapor hero-main
```
:::

Open the printed URL, **http://127.0.0.1:8130/**. Pass demo names to build
specific ones, or set `PORT`:

```sh
bun scripts/dev.ts hero-main cards
PORT=9000 bun scripts/dev.ts
```

Rebuild-on-change is deliberately manual: after editing a component, re-run
`bun scripts/build.ts <app>` (or the whole `dev` script) and reload the page.
The first run compiles the Rust core to wasm with cargo, so it takes a moment;
subsequent runs are fast.

### In the Playground

No local build at all: open the [Playground](/playground/), which loads the same
wasm core in your browser. Pick Solid or Vue Vapor in the toolbar, edit JSX in
the editor, and it renders live — the quickest way to explore the component and
styling surface before wiring up a local project.

## What the build just did

`bun scripts/build.ts` is a **two-pass** build:

1. **Transform & collect.** Babel (Solid's universal preset + TypeScript) runs
   over every module reachable from your entry, content-hash cached in `.cache/`.
   As it goes it collects every class literal and every text codepoint from the
   AST. The Tailwind-subset compiler turns the collected classes into
   `styles.bin`, the font baker rasterizes an Inter atlas containing *only* the
   characters your app uses, images are decoded, and it's all packed into
   `dist/<app>.pak`.
2. **Bundle.** Bun bundles the app (IIFE, targeting the browser, unminified) from
   the cached pass-1 transforms into `dist/<app>.js`.

Because styles and fonts are derived from your source, a class literal only
compiles if *every* token is a supported utility, and the atlas only holds glyphs
you reference. The full mechanics — caching, the class/codepoint collection, the
pak format — are in [Build pipeline](/docs/build-pipeline/).

## Next steps

- [Architecture](/docs/architecture/) — how one Rust core drives every host.
- [Frameworks](/docs/frameworks/) — switch between Solid and Vue Vapor.
- [Components](/docs/components/) — `View`, `Text`, `Image`, control flow, and the app-shell primitives.
- [Styling](/docs/styling/) and [Tailwind subset](/docs/tailwind/) — the compile-time class rules.
- [Reactivity](/docs/reactivity/) and [Animation](/docs/animation/) — signals, effects, and native tweens.
- [Input & focus](/docs/input-focus/) — d-pad traversal, buttons, and focus scopes.
