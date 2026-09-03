# Frameworks

PocketJS supports four app frameworks over the same native tree and Rust
core:

| Framework | Build id | Component transform | Runtime renderer | Output suffix |
|---|---|---|---|---|
| Solid | `solid` | `babel-preset-solid` universal mode | `renderer-solid.ts` | none |
| Vue Vapor | `vue-vapor` | `vue-jsx-vapor` | `renderer-vue-vapor.ts` | `.vue-vapor` |
| Octane | `octane` | Octane universal compiler (host plans + slots) | `renderer-octane.ts` (pocket universal driver over the native tree) | `.octane` |
| Svelte | `svelte` | Svelte's custom-renderer compiler (`experimental.customRenderer`) | `renderer-svelte.ts` | `.svelte` |

Solid is the default so existing apps keep building to `dist/<app>.js` and
`dist/<app>.pak`. The others build next to it:

```sh
bun tools/build.ts hero-main                    # dist/hero-main.js
bun tools/build.ts hero-vue-vapor-main --framework=vue-vapor
# dist/hero-vue-vapor-main.vue-vapor.js
bun tools/build.ts hero-main --framework=octane
# dist/hero-main.octane.js
bun tools/build.ts hero-main --framework=svelte
# dist/hero-main.svelte.js
```

Sibling variant files select automatically: an `app.octane.tsx` (or
`app.vue-vapor.tsx`) next to `app.tsx` is picked up when building with the
matching `--framework`, which is how one demo directory carries all of its
ports — all eight showcase demos (`hero`, `cards`, `stats`, `library`,
`settings`, `notifications`, `music`, `gallery`) ship an `app.octane.tsx` and
`main.octane.tsx` beside the Solid originals. **Svelte's variant of a TypeScript
module is `<name>.svelte.ts`**, which is also Svelte's own spelling for a runes
module, so `apps/hero/` carries `app.svelte` and `main.svelte.ts`.

There is no environment-variable switch for framework selection. Product
builds declare it in `pocket.json`; low-level compiler work can still use a
project config or one-command override.

## Manifest selection

```json
{
  "app": {
    "framework": "solid"
  }
}
```

Use `"vue-vapor"` for the Vue adapter, `"octane"` for Octane and `"svelte"`
for Svelte.
`pocket check|compile|build --target …`
resolves this value once and all framework/compiler/native stages consume the same plan.
Do not also put `framework` in `pocket.config.ts` for a manifest build.

## Low-level project config

`pocket.config.ts` is the low-level script default:

```ts
import { definePocketConfig } from "@pocketjs/framework/config";

export default definePocketConfig({
  framework: "solid",
});
```

Use Vue Vapor or Octane by changing the file:

```ts
export default definePocketConfig({
  framework: "vue-vapor",
});
```

```ts
export default definePocketConfig({
  framework: "octane",
});
```

```ts
export default definePocketConfig({
  framework: "svelte",
});
```

The direct framework/compiler/dev scripts read the config by default. Use
`--framework=solid`, `--framework=vue-vapor`, `--framework=octane` or
`--framework=svelte` to override it for one invocation. `--config=<path>` selects a different config
file, and `--no-config` ignores config entirely.

The same flag works through the dev and PSP entry points:

```sh
bun tools/dev.ts --framework=vue-vapor hero-vue-vapor-main
bun tools/dev.ts --framework=octane hero-main
bun tools/dev.ts --framework=svelte hero-main
bun tools/psp.ts hero-vue-vapor --framework=vue-vapor --release
```

## Framework app imports

Apps import state and component lifecycle from the selected framework directly.
PocketJS does not wrap `createSignal`, `ref`, `useState`, `$state`, `onMount`,
`onMounted`, or `useEffect`.

Solid app:

```tsx
import { mount, frameworkName } from "@pocketjs/framework/solid";
import { View, Text, type NodeMirror } from "@pocketjs/framework/solid/components";
import { createSignal, onMount, Show } from "solid-js";

export default function App() {
  const [count, setCount] = createSignal(0);
  let marker: NodeMirror | undefined;

  onMount(() => {
    console.log(frameworkName(), marker?.id);
  });

  return (
    <View class="p-4 flex-col gap-2">
      <Text class="text-base text-slate-950">Framework: {frameworkName()}</Text>
      <View nodeRef={(node) => (marker = node ?? undefined)} focusable onPress={() => setCount(count() + 1)}>
        <Text class="text-sm text-blue-600">Count: {count()}</Text>
      </View>
      <Show when={count() > 2}>
        <Text class="text-sm text-emerald-600">Solid, native tree.</Text>
      </Show>
    </View>
  );
}

mount(() => <App />);
```

Vue Vapor app:

```tsx
import { mount, frameworkName } from "@pocketjs/framework/vue-vapor";
import { View, Text, type NodeMirror } from "@pocketjs/framework/vue-vapor/components";
import { onMounted, ref } from "vue";

export default function App() {
  const count = ref(0);
  let marker: NodeMirror | undefined;

  onMounted(() => {
    console.log(frameworkName(), marker?.id);
  });

  return (
    <View class="p-4 flex-col gap-2">
      <Text class="text-base text-slate-950">Framework: {frameworkName()}</Text>
      <View nodeRef={(node) => (marker = node ?? undefined)} focusable onPress={() => count.value++}>
        <Text class="text-sm text-blue-600">Count: {count.value}</Text>
      </View>
      {count.value > 2 ? (
        <Text class="text-sm text-emerald-600">Vue Vapor, native tree.</Text>
      ) : null}
    </View>
  );
}

mount(App);
```

Octane app:

```tsx
import { mount, frameworkName } from "@pocketjs/framework/octane";
import { View, Text, type NodeMirror } from "@pocketjs/framework/octane/components";
import { useEffect, useRef, useState } from "octane";

export default function App() {
  const [count, setCount] = useState(0);
  const marker = useRef<NodeMirror | null>(null);

  useEffect(() => {
    console.log(frameworkName(), marker.current?.id);
  }, []);

  return (
    <View class="p-4 flex-col gap-2">
      <Text class="text-base text-slate-950">{`Framework: ${frameworkName()}`}</Text>
      <View
        nodeRef={(node: NodeMirror | null) => {
          marker.current = node;
        }}
        focusable
        onPress={() => setCount(count + 1)}
      >
        <Text class="text-sm text-blue-600">{`Count: ${count}`}</Text>
      </View>
      {count > 2 ? (
        <Text class="text-sm text-emerald-600">Octane, native tree.</Text>
      ) : null}
    </View>
  );
}

mount(App);
```

Svelte app:

```svelte
<script lang="ts">
  import { frameworkName } from "@pocketjs/framework/svelte";
  import { Text, View, type NodeMirror } from "@pocketjs/framework/svelte/components";
  import { onMount } from "svelte";

  let count = $state(0);
  let marker: NodeMirror | undefined;

  onMount(() => console.log(frameworkName(), marker?.id));
</script>

<View class="p-4 flex-col gap-2">
  <Text class="text-base text-slate-950">Framework: {frameworkName()}</Text>
  <View nodeRef={(node: NodeMirror) => (marker = node)} focusable onPress={() => count++}>
    <Text class="text-sm text-blue-600">Count: {count}</Text>
  </View>
  {#if count > 2}
    <Text class="text-sm text-emerald-600">Svelte, native tree.</Text>
  {/if}
</View>
```

Its entry is an ordinary TypeScript module, because a manifest's `app.entry`
takes `.ts`/`.tsx` only:

```ts
import { mount } from "@pocketjs/framework/svelte";
import App from "./app.svelte";

mount(App);
```

The generic public subpaths remain Solid-first defaults. Use explicit framework
subpaths when an example or app is tied to a framework:

| Import | Solid build | Vue Vapor build | Octane build | Svelte build |
|---|---|---|---|---|
| `@pocketjs/framework` | `framework/src/index.ts` | `framework/src/index-vue-vapor.ts` | `framework/src/index-octane.ts` | `framework/src/index-svelte.ts` |
| `@pocketjs/framework/components` | `framework/src/components.ts` | `framework/src/components-vue-vapor.ts` | `framework/src/components-octane.tsx` | `framework/src/components-svelte.ts` |
| `@pocketjs/framework/lifecycle` | Solid lifecycle hooks | Vue Vapor lifecycle hooks | Octane lifecycle hooks (`useFrame`, `useButtonPress`, `useSpriteAnimation`) | Svelte lifecycle hooks |

Use `nodeRef` when a component should look similar across framework examples. Solid still supports
`ref`, but `nodeRef` avoids framework-specific ref semantics.

## Explicit framework subpaths

When you intentionally want one framework, import it directly:

```tsx
import { mount } from "@pocketjs/framework/solid";
import { View } from "@pocketjs/framework/solid/components";
```

```tsx
import { mount } from "@pocketjs/framework/vue-vapor";
import { View } from "@pocketjs/framework/vue-vapor/components";
```

```tsx
import { mount } from "@pocketjs/framework/octane";
import { View } from "@pocketjs/framework/octane/components";
```

```ts
import { mount } from "@pocketjs/framework/svelte";
import { View } from "@pocketjs/framework/svelte/components";
```

Explicit subpaths are useful for framework-specific examples, tests, and
integration code. Most apps should prefer the generic PocketJS subpaths and keep
framework state imports native.

## Octane notes

Octane is React's programming model, compiled: hooks and JSX, no VDOM. Hooks
(`useState`, `useEffect`, `useMemo`, `useRef`, `useLayoutEffect`,
`useEffectEvent`, …) import from `octane`. Dependency arrays may be omitted —
the compiler infers them from captures. Hooks are tracked by call site, so a
hook inside an `if` block is fine, but hooks in loops are not. PocketJS's
per-frame hooks follow the same rule: they are `useFrame`, `useButtonPress`,
and `useSpriteAnimation` (from `@pocketjs/framework/octane/lifecycle` or the
generic `lifecycle` subpath), use-prefixed because the Octane compiler
slot-keys custom hooks by the `use[A-Z]` naming convention.
(`pushButtonHandlerBlock` is not a hook and keeps its name.)

At build time, Octane's universal compiler lowers JSX to static host plans
plus dynamic slots against the "pocket" renderer; at runtime the compiled
imports retarget to `@pocketjs/framework/octane/renderer`, whose driver maps
host command batches onto the native `ui.*` tree. There is no DOM shim
(unlike Vue Vapor). PocketJS's frame loop flushes Octane's microtask-scheduled
re-renders synchronously inside each frame, so a state write in a handler
commits in that same frame.

Authoring rules specific to Octane apps:

- **The entry passes the component itself.** `main.octane.tsx` must call
  `mount(App)` — JSX inside a call-argument arrow (`mount(() => <App />)`) is
  a universal-target compile error.
- **Mixed static + dynamic text is one template literal.** Write
  ``<Text>{`Count: ${count}`}</Text>``, not `<Text>Count: {count}</Text>` —
  the compiler drops trailing whitespace on a static segment that precedes an
  expression.
- **`class` stays full literals or ternaries of full literals**, exactly as in
  the other frameworks.
- **Counters driven from `useFrame` use functional updates**
  (`setX((v) => v + 1)`): a same-frame handler's state write would otherwise
  be clobbered by a stale read.
- **Keep natively `animate()`d properties out of a `style` object whose value
  changes across re-renders.** Re-applying a changed style value cancels the
  running tween (unchanged values are diffed away and are safe); drive such
  properties from an effect with `animate()`/`jump()` and a `nodeRef` instead.
- **Continuous motion rides the native animation system, never per-frame
  state.** An Octane state commit replays the whole root — the cost is the
  same whether the state lives in the root or a one-node leaf (leaf state
  changes *how often* you replay, not what a replay costs, and on the PSP
  one replay is a multi-frame stall). Every continuous visual has a native
  channel with zero per-frame JS: `<Sprite>` atlases for sprite cycling
  (the hero/gallery/library spinners, `sprites.json`), baked keyframe
  timelines for looping choreography (the music equalizer,
  `apps/music/pocket.config.ts`), `animate()`/`jump()` for one-shot tweens
  (the stats bars and systems reveal, notification rows), and
  `setTextContent` — the text-shaped sibling of `animate()` — for per-frame
  text like count-ups and percentages (`StatTiles`, `ProgressLine`).
- **Frame counters that merely time a phase live in refs**, committing state
  exactly once at the boundary they're waiting for (the notifications
  dismiss/rise timers, the library loading screen). Counting in state
  replays the root every frame of the phase for pixels that never change.
- **Re-render residue is per replay, not per frame, on the pinned engine.**
  Each replay retains a small residue the collector cannot reclaim on this
  QuickJS revision, and the slab allocator amplifies it on the fixed arena
  (the host's arena-pressure GC absorbs the churn). With the demos'
  continuous motion moved onto native channels, replays happen at
  interaction rate — button presses, track changes — so the residue no
  longer bounds a play session the way per-frame replays did. The engine
  repair (quickjs-rs GC fix + repin) remains the tracked follow-up, as does
  upstream work on Octane's replay cost itself, which today makes a single
  press noticeably heavier on PSP than in Solid or Vue Vapor.

## Svelte notes

Svelte compiles against its **custom-renderer API**
([sveltejs/svelte#18511](https://github.com/sveltejs/svelte/pull/18511)), which
replaces the DOM with a renderer object. PocketJS supplies that object in
`framework/src/renderer-svelte.ts`, a thin adapter over the same native mirror
tree the other three frameworks write to. The build is unreleased, so the
framework **vendors a tarball of the pull request head** in `vendor/` and ships
it inside the npm package; `bun tools/vendor-svelte.ts` moves the pin.

Svelte's own reactivity comes from `svelte` (`$state`, `$derived`, `$effect`,
`onMount`, snippets); PocketJS supplies the host components, lifecycle, input
and animation APIs.

Authoring rules specific to Svelte apps:

- **Component files are `.svelte`, shared reactive state lives in `.svelte.ts`
  runes modules.** A runes module is one instance per program, so state in one
  outlives anything that remounts the tree.
- **The entry is a `.ts` file that imports the component**, because a manifest's
  `app.entry` accepts `.ts`/`.tsx` only. `mount(App)` takes the component
  itself, never a thunk.
- **`class` stays full literals or ternaries of full literals**, exactly as in
  the other frameworks. `class:` directives, interpolated class strings and the
  `clsx` object/array forms are **compile errors** — the class table is built at
  build time.
- **Style objects are a component prop, not an attribute.** A `style` attribute
  in Svelte is CSS text, which the native tree has no parser for, so
  `<View style={{ width: 10 }} />` is the supported spelling and a raw
  `style="…"` is refused at compile time. `style:` directives are refused too.
- **`<style>` blocks are refused.** Styling is the Tailwind subset.
- **`onPress` is the only event.** Host elements expose the native press
  channel; everything else about input comes from `onFrame`/`onButtonPress` in
  `@pocketjs/framework/svelte/lifecycle`.
- **`nodeRef` hands you the `NodeMirror`** for `animate()`, `jump()` and
  `setTextContent()`. `{@attach}` and `use:` receive the same node.
- **`svelte/motion`, `svelte/transition` and `svelte/animate` are refused**:
  they reach for `requestAnimationFrame` and `performance.now`, which the
  QuickJS guest does not have. Use `animate()` and baked keyframe timelines.
- **`bind:` on a host element is refused** by Svelte itself under a custom
  renderer; `bind:` on a component is ordinary prop plumbing and works.
  `<svelte:window>`, `<svelte:document>`, `<svelte:body>`, `<svelte:head>` and
  `{@html}` are refused for the same reason.
- **A state write in a press handler lands in that frame.** The frame handler
  calls Svelte's `flushSync()` after input handling and before the end-of-frame
  sweep, so effects commit before detached subtrees are destroyed.
- **Continuous motion still rides the native channels** — sprite atlases, baked
  keyframe timelines, `animate()`/`jump()` and `setTextContent()` — rather than
  per-frame state, the same rule the other frameworks follow.

## What stays shared

All four frameworks use the same Tailwind-subset compiler, generated style table,
font atlas baker, `.pak` asset container, host detection, input/focus system,
overlay layer, animation API, PSP/Vita native build paths, browser dev host, and
PPSSPP/Vita3K capture paths. Switching frameworks changes only the JS
component/reactivity layer and renderer adapter.
