# Frameworks

PocketJS supports three app frameworks over the same native tree and Rust
core:

| Framework | Build id | JSX transform | Runtime renderer | Output suffix |
|---|---|---|---|---|
| Solid | `solid` | `babel-preset-solid` universal mode | `renderer-solid.ts` | none |
| Vue Vapor | `vue-vapor` | `vue-jsx-vapor` | `renderer-vue-vapor.ts` | `.vue-vapor` |
| Octane | `octane` | Octane universal compiler (host plans + slots) | `renderer-octane.ts` (pocket universal driver over the native tree) | `.octane` |

Solid is the default so existing apps keep building to `dist/<app>.js` and
`dist/<app>.pak`. Vue Vapor and Octane build next to it:

```sh
bun tools/build.ts hero-main                    # dist/hero-main.js
bun tools/build.ts hero-vue-vapor-main --framework=vue-vapor
# dist/hero-vue-vapor-main.vue-vapor.js
bun tools/build.ts hero-main --framework=octane
# dist/hero-main.octane.js
```

Sibling variant files select on their own: an `app.octane.tsx` (or
`app.vue-vapor.tsx`) next to `app.tsx` is picked up when building with the
matching `--framework`, which is how one demo directory carries all of its
ports. The showcase demos each ship an `app.octane.tsx` and a
`main.octane.tsx` beside the Solid originals; `ls apps/*/app.octane.tsx` names
the current set.

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

Use `"vue-vapor"` for the Vue adapter and `"octane"` for Octane.
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

`framework` takes the same three build ids as the manifest.

The direct framework/compiler/dev scripts read the config by default. Use
`--framework=solid`, `--framework=vue-vapor`, or `--framework=octane` to
override it for one invocation. `--config=<path>` selects a different config
file, and `--no-config` ignores config entirely.

The same flag works through the dev and PSP entry points:

```sh
bun tools/dev.ts --framework=vue-vapor hero-vue-vapor-main
bun tools/dev.ts --framework=octane hero-main
bun tools/psp.ts hero-vue-vapor --framework=vue-vapor --release
```

## Framework app imports

Apps import state and component lifecycle from the selected framework directly.
PocketJS does not wrap `createSignal`, `ref`, `useState`, `onMount`,
`onMounted`, or `useEffect`.

A Solid app:

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

The Vue Vapor and Octane ports of that app render the same tree from the same
`View`/`Text` components. What changes is the state syntax and where it is
imported from:

| | Solid | Vue Vapor | Octane |
|---|---|---|---|
| State | `const [c, setC] = createSignal(0)` | `const c = ref(0)` | `const [c, setC] = useState(0)` |
| Read in JSX | `{c()}` | `{c.value}` | `` {`${c}`} `` — mixed static + dynamic text is one template literal |
| Mount hook | `onMount` | `onMounted` | `useLayoutEffect(fn, [])` |
| State import | `solid-js` | `vue` | `octane` |
| Runtime import | `@pocketjs/framework/solid` | `@pocketjs/framework/vue-vapor` | `@pocketjs/framework/octane` |
| Entry call | `mount(() => <App />)` | `mount(App)` | `mount(App)` |

`nodeRef` takes a callback on all three. Solid also supports `ref`; `nodeRef`
avoids framework-specific ref semantics in examples meant to read the same way
across frameworks.

The generic public subpaths remain Solid-first defaults. Use explicit framework
subpaths when an example or app is tied to a framework:

| Import | Solid build | Vue Vapor build | Octane build |
|---|---|---|---|
| `@pocketjs/framework` | `framework/src/index.ts` | `framework/src/index-vue-vapor.ts` | `framework/src/index-octane.ts` |
| `@pocketjs/framework/components` | `framework/src/components.ts` | `framework/src/components-vue-vapor.ts` | `framework/src/components-octane.tsx` |
| `@pocketjs/framework/lifecycle` | Solid lifecycle hooks | Vue Vapor lifecycle hooks | Octane lifecycle hooks (`useFrame`, `useButtonPress`, `useSpriteAnimation`) |

Not every subpath resolves under every framework. `framework/compiler/subpaths.ts`
is the registry, and it declares:

- **`gesture` and `kinetics` resolve under Solid and Vue Vapor.** The
  recognizer and scroller machinery lives in framework-neutral core modules;
  each of the two frameworks gets a thin shim that binds disposal to its own
  lifecycle.
- **`osk` and `virtual-list` resolve under Solid only.** Nothing else is
  meant to reach their Solid-flavored implementations.
- **What a framework does not resolve is not walked in pass 1**, so class
  strings from another framework's module never enter this build's
  `styles.bin`. The bare specifier still carries an npm export pointing at
  the Solid file, so an Octane build importing `@pocketjs/framework/gesture`
  compiles against the Solid module — which the Octane entry never pumps (see
  [What stays shared](#what-stays-shared)).

## Reactivity on PocketJS

There is no PocketJS reactivity layer. Solid apps import signals, effects, and
lifecycle from `solid-js`; Vue Vapor apps import refs, computeds, watchers, and
lifecycle from `vue`; Octane apps import hooks from `octane`. Four PocketJS-side
rules sit on top of whichever one you pick.

**A state write in a handler commits in the frame that handled it.** Solid and
Vue Vapor mutate the native tree during the write itself. Octane queues its
re-renders as microtasks, so the frame handler in
`framework/src/index-octane.ts` runs that frame's hooks and input dispatch
inside `flushUniversalSync()`, which drains the queue before the sweep that
ships the frame's mutations to the core.

**The banned-import lint fires on Solid builds only.** The Babel plugin in
`framework/compiler/jsx-plugin.ts` rejects `createResource`, `useTransition`,
and `startTransition` when they are imported from `solid-js`, and its import
visitor returns without checking when the build framework is not Solid. Those
three are Solid's async and concurrent features, and they want a task queue the
PSP's QuickJS host does not have. Reach for signals plus an effect for state
over time, and [`animate()`](/docs/animation/) for motion.

QuickJS has no event loop of its own, but the runtime installs the two globals
that framework schedulers assume: `framework/src/scheduler-polyfill.ts` — the
prelude for both the Vue Vapor and the Octane entries — defines
`queueMicrotask`, `setTimeout`, and `clearTimeout` where the host lacks them.
`setTimeout` there lowers onto the promise job queue and ignores its delay, so
it is not a timer. Time a delay with `after()` from
`@pocketjs/framework/clock`, which fires off the virtual clock the frame
handler advances.

**No continuous motion out of per-frame state.** A value rewritten from JS
every frame costs a commit every frame on all three frameworks. `animate()`,
baked keyframe timelines, `<Sprite>` atlases, and `setTextContent` run the same
motion from the Rust core at zero per-frame JS. See
[Animation](/docs/animation/).

**A reactive value inside `<Text>` is not a special construct.** The static
prefix and the dynamic expression fold into one measured inline run, and a
change calls the native `replaceText` op on the dynamic segment alone. See
[Components](/docs/components/) for the text model.

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
host command batches onto the native `ui.*` tree. Vue Vapor gets a micro-DOM
shim; Octane gets none.

Authoring rules specific to Octane apps:

- **The entry passes the component itself.** `main.octane.tsx` must call
  `mount(App)` — JSX inside a call-argument arrow (`mount(() => <App />)`) is
  a universal-target compile error.
- **Mixed static + dynamic text is one template literal.** Write
  ``<Text>{`Count: ${count}`}</Text>``, not `<Text>Count: {count}</Text>` —
  the compiler drops trailing whitespace on a static segment that precedes an
  expression.
- **`class` stays full literals or ternaries of full literals**, as in
  the other frameworks.
- **Counters driven from `useFrame` use functional updates**
  (`setX((v) => v + 1)`): a same-frame handler's state write would otherwise
  be clobbered by a stale read.
- **Keep natively `animate()`d properties out of a `style` object whose value
  changes across re-renders.** Re-applying a changed style value cancels the
  running tween (unchanged values are diffed away and are safe); drive such
  properties from an effect with `animate()`/`jump()` and a `nodeRef` instead.
- **An Octane state commit replays the whole root**, which is where the
  no-per-frame-state rule bites hardest. The replay costs the same whether the
  state lives in the root or in a one-node leaf — leaf state changes *how
  often* you replay, not what a replay costs, and on the PSP one replay is a
  multi-frame stall. The showcase demos put every continuous visual on a native
  channel instead: `<Sprite>` atlases for the hero/gallery/library spinners
  (`sprites.json`), a baked keyframe timeline for the music equalizer
  (`apps/music/pocket.config.ts`), `animate()`/`jump()` for the stats bars and
  notification rows, and `setTextContent` for count-ups and percentages
  (`StatTiles`, `ProgressLine`).
- **Frame counters that only time a phase live in refs**, committing state
  once at the boundary they're waiting for (the notifications
  dismiss/rise timers, the library loading screen). Counting in state
  replays the root every frame of the phase for pixels that never change.
- **Each replay retains a residue the collector cannot reclaim** on the pinned
  QuickJS revision, and the slab allocator amplifies it on the fixed arena
  (the host's arena-pressure GC absorbs the churn). Keeping continuous motion
  on native channels holds replays down to interaction rate — button presses,
  track changes — which bounds the residue.

## What stays shared

All three frameworks use the same Tailwind-subset compiler, generated style
table, font atlas baker, `.pak` asset container, host detection, button/focus
input, overlay layer, animation API, and every native build and capture path a
target registers in `contracts/spec/platforms.ts`. Switching frameworks changes
the JS component/reactivity layer and the renderer adapter.

One exception: **touch under Octane is raw contacts only.** The Solid and Vue
Vapor entries call `installTouchActivation()` and run the gesture pump each
frame; `framework/src/index-octane.ts` does neither, so an Octane app gets no
tap-to-press on `onPress` and no recognizers — it reads `touches()` itself.
