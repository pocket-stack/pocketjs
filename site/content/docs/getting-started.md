# Getting started

This is the fastest path from an empty checkout to JSX running on screen. You'll
write a component, mount it, build it, and see it in the browser dev host — the
same source and `pocket.json` can also be compiled into target-specific PSP and
PS Vita packages. The logical 480×272 UI stays portable while each target owns
its native renderer, raster density, and HostOps ABI.

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
| Ship a **PSP EBOOT** | `bun run bootstrap` (pinned Rust, [`cargo-psp`](https://github.com/pocket-stack/rust-psp), LLVM, and verified SDK) |
| Ship a **PS Vita VPK** | [VitaSDK](https://vitasdk.org/), `cargo-vita` 0.2.2, and Rust nightly `2026-05-28` with `rust-src` |
| Hot-reload on **real PSP hardware** | The build toolchain above + optional [PSPLINK](https://github.com/pspdev/psplinkusb) host tools |

The Rust core is `no_std` and gets built once per platform. For this guide we
stay on the JS side and let the dev host compile the wasm core for us.

## Install

```sh
git clone https://github.com/pocket-stack/pocketjs
cd pocketjs
bun install
bun run bootstrap   # one-time PSP setup; omit for browser-only development
```

The [`@pocketjs/cli`](https://www.npmjs.com/package/@pocketjs/cli) package can
check (and mostly install) the toolchain for you, flutter-doctor style:

```sh
npm install -g @pocketjs/cli
pocket doctor   # diagnoses bun, the Rust targets, and the PSP toolchain
pocket setup    # runs the checkout's pinned, idempotent bootstrap
```

The PSP setup is self-contained in PocketJS; it does not inspect DreamCart or
any sibling source checkout. Its exact revisions and SDK checksum live in
`cli/psp-toolchain.json`. By default artifacts are shared through
`${XDG_CACHE_HOME:-~/.cache}/pocket-stack`; `POCKET_STACK_CACHE_DIR` overrides
that root. For a custom SDK, set `PSP_SDK` or `PSPDEV` (in that precedence
order). The build validates an explicit path and then exports both names to the
selected SDK, so a typo cannot silently fall through to a different cached
toolchain.

It also wraps the day-to-day commands. `pocket create <name>` scaffolds a
manifest-first demo; `pocket check|compile|build --target psp|vita` delegate to
the canonical resolver; `pocket dev|psp|vita|hw|psplink` retain the low-level
host-development paths; and `pocket devtools [app]` opens the
[DevTools](/docs/devtools/) panel with the USB debug bridge.

That pulls `solid-js`, Vue Vapor dependencies, and the build-time tooling (the
Babel + Tailwind-subset compiler, the font baker, and the dev host). There is no
separate runtime to install — the framework is the `@pocketjs/framework` package
in this repo, exposed through subpath imports like
`@pocketjs/framework/components`.

Create an app and validate it against both stock profiles:

```sh
pocket create my-app
pocket check --target psp --manifest demos/my-app/pocket.json
pocket check --target vita --manifest demos/my-app/pocket.json
```

The generated `pocket.json` is strict application intent:

```json
{
  "$schema": "https://pocketjs.dev/schema/pocket-2.json",
  "pocket": 2,
  "id": "dev.example.my-app",
  "name": "my-app",
  "title": "My App",
  "version": "0.1.0",
  "engine": {
    "capabilities": {
      "requires": ["text.glyphs.baked", "input.buttons"]
    }
  },
  "app": {
    "entry": "main.tsx",
    "output": "my-app-main",
    "framework": "solid",
    "viewport": {
      "logical": [480, 272],
      "presentation": "integer-fit"
    }
  }
}
```

Keep `id` stable across releases: the Vita backend derives the installed Title
ID from it. Put optional APIs such as `input.touch` under `enhances` and retain
a controller fallback; unsupported entries under `requires` fail before the
compiler runs.

## Write your first component

A component returns JSX. You lay out with `View`, draw text with `Text`, and
style with `class` — a **build-time subset of Tailwind**, not runtime CSS.
State comes directly from the selected framework: `createSignal` in Solid,
`ref` in Vue Vapor.

Solid is the default low-level framework. Manifest builds select Solid or Vue
Vapor with `app.framework` in `pocket.json`; see [Frameworks](/docs/frameworks/)
for the full selection model.

Here's a focusable counter. Put it in the scaffolded
`demos/my-app/app.tsx`:

:::framework-code
```tsx solid
import { createSignal, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/solid/components";

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
import { Text, View } from "@pocketjs/framework/vue-vapor/components";

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
entry** does that. Keep it tiny — this is just app bootstrap. Put it in the
scaffolded `demos/my-app/main.tsx`:

:::framework-code
```tsx solid
// @title PocketJS: My App
import App from "./app.tsx";
import { mount } from "@pocketjs/framework/solid";

mount(() => <App />);
```

```tsx vue-vapor
// @title PocketJS: My App
import App from "./app.tsx";
import { mount } from "@pocketjs/framework/vue-vapor";

mount(App);
```
:::

`mount` comes from the selected framework runtime subpath. It handles host
detection (native PSP/Vita vs. injected browser/headless hosts), wiring the generated style table,
uploading images from the packed asset file, and installing the per-frame host
callback — you don't manage any of that yourself. (`mount` builds on the
lower-level `render` export from the same module; `mount` is what you want for an
app.)

## Build it

Use the manifest path for product builds. It validates the app, resolves the
target once, compiles target-specific assets, and dispatches the native backend:

```sh
pocket build --target psp --manifest demos/my-app/pocket.json -- --release
# native/target/mipsel-sony-psp/release/EBOOT.PBP

export VITASDK="$HOME/vitasdk"
export PATH="$VITASDK/bin:$HOME/.cargo/bin:$PATH"
pocket build --target vita --manifest demos/my-app/pocket.json -- --release
# demos/my-app/dist/vita/my-app-main.vpk
```

Vita VPKs include PocketJS's default black 128x128 bubble icon and complete
LiveArea background/startup artwork, so a newly built application does not get
a blank bubble or generic launch gate. Custom native hosts call
`packageVitaVpk()` from `@pocketjs/framework/vita-package`; VPK-relative app
assets override matching defaults while missing artwork continues to inherit
PocketJS's complete set.

`pocket compile --target …` stops after the JS/pak artifacts for a custom native
host. `pocket check --target …` is read-only. Arguments after `--` belong to the
selected native backend.

For framework work, the lower-level compiler remains available:

:::framework-code
```sh solid
bun scripts/build.ts hero
```

```sh vue-vapor
bun scripts/build.ts hero --framework=vue-vapor
```
:::

That density-1 development command produces two files in `dist/`:

| File              | What it is                                                                 |
| ----------------- | ------------------------------------------------------------------------- |
| `dist/hero.js`    | Your app bundled to a single IIFE for the selected development contract   |
| `dist/hero.pak` | The packed asset file: the compiled style table, font atlases, and images |

Vue Vapor builds use the `.vue-vapor` suffix, for example
`dist/hero.vue-vapor.js` and `dist/hero.vue-vapor.pak`.

A few notes on the low-level command:

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

### In Vita3K

For stock demos, one command builds a manifest-driven VPK, installs it under a
stable per-demo Title ID, and launches it:

```sh
pocket play vita hero
pocket play vita gallery --fullscreen
```

Vita3K is interactive here; `--fullscreen` controls the emulator window. The
application still uses the profile's 480×272 logical viewport rendered at
960×544 density 2. See the [Vita host guide](https://github.com/pocket-stack/pocketjs/blob/main/native-vita/README.md)
for toolchain setup, key mappings, real-device installation, and the golden E2E.

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
