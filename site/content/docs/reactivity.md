# Reactivity

**There is no PocketJS reactivity layer.** Solid apps import signals, effects,
and lifecycle from `solid-js`; Vue Vapor apps import refs, computeds, watchers,
and lifecycle from `vue`; Octane apps import hooks from `octane`. A state write
reaches the native tree through whichever system you picked, and PocketJS adds
four rules on top of it.

If you know the framework, you know the API. This page puts the three side by
side so you can read one column and skip the rest, then states what the runtime
adds. Which framework a build uses is set once in `pocket.json` — see
[Frameworks](/docs/frameworks/).

## The primitives, side by side

| | Solid | Vue Vapor | Octane |
| --- | --- | --- | --- |
| One reactive value | `createSignal` | `ref` / `shallowRef` | `useState` |
| Derived, cached | `createMemo` | `computed` | `useMemo` |
| Side effect on change | `createEffect` | `watchEffect` | `useEffect` |
| After first render | `onSettled` | `onMounted` | `useEffect` with no deps |
| On teardown | `onCleanup` | `onScopeDispose` | `useEffect` cleanup return |
| Escape tracking | `untrack` | — | dependency arrays |

Solid and Vue Vapor are fine-grained reactive systems: a write updates the
native nodes that read the value, and nothing re-runs the component. Octane is
React's hooks model compiled — dependency arrays may be omitted because the
compiler infers them from captures, and hooks are tracked by call site, so a
hook inside an `if` is allowed and hooks in a loop are not.

## State

:::framework-code
```tsx solid
import { View, Text } from "@pocketjs/framework/components";
import { createSignal } from "solid-js";

function Counter() {
  const [count, setCount] = createSignal(0);
  return (
    <View
      class="px-4 py-2 rounded-xl bg-blue-600 focus:bg-blue-500"
      focusable
      onPress={() => setCount(count() + 1)}
    >
      <Text class="text-base text-white font-bold">Count: {count()}</Text>
    </View>
  );
}
```

```tsx vue-vapor
import { View, Text } from "@pocketjs/framework/components";
import { shallowRef } from "vue";

function Counter() {
  const count = shallowRef(0);
  return () => (
    <View
      class="px-4 py-2 rounded-xl bg-blue-600 focus:bg-blue-500"
      focusable
      onPress={() => {
        count.value++;
      }}
    >
      <Text class="text-base text-white font-bold">Count: {count.value}</Text>
    </View>
  );
}
```

```tsx octane
import { View, Text } from "@pocketjs/framework/components";
import { useState } from "octane";

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <View
      class="px-4 py-2 rounded-xl bg-blue-600 focus:bg-blue-500"
      focusable
      onPress={() => setCount(count + 1)}
    >
      <Text class="text-base text-white font-bold">{`Count: ${count}`}</Text>
    </View>
  );
}
```
:::

A reactive value inside `<Text>` is not a special construct. The static prefix
and the dynamic expression **fold into one measured inline run**, and a change
calls the native `replaceText` op on the dynamic segment alone — the prefix
re-measures when the prefix itself changes. Mix as many segments as you want
inside one `<Text>`; they all fold into that one run. See
[Components](/docs/components/) for the text model.

## Derived values

A derived value re-computes when a source it read changes, and caches until
then. Reach for one when a computation is shared by several readers or costs
more than a property access; a plain function call in the render is cheaper for
the rest.

:::framework-code
```ts solid
import { createMemo } from "solid-js";

const total = createMemo(() => items().length);
```

```ts vue-vapor
import { computed } from "vue";

const total = computed(() => items.value.length);
```

```ts octane
import { useMemo } from "octane";

const total = useMemo(() => items.length);
```
:::

## Effects

An effect runs once on creation, tracks every reactive value it read, and runs
again when one of them changes. Use it for work that leaves the tree — driving
an animation, writing a file, logging. A value you render belongs in a derived
value instead.

:::framework-code
```ts solid
import { createEffect } from "solid-js";

createEffect(selected, value => {
  console.log("selection is", value);
});
```

```ts vue-vapor
import { watchEffect } from "vue";

watchEffect(() => {
  console.log("selection is", selected.value);
});
```

```ts octane
import { useEffect } from "octane";

useEffect(() => {
  console.log("selection is", selected);
});
```
:::

Effects deliver at a frame boundary, before app frame hooks run, so app code
reads a settled tree. [Native contract](/docs/native-contract/) has the frame
order.

## Mount and cleanup

:::framework-code
```ts solid
import { onSettled, onCleanup } from "solid-js";

onSettled(() => list.scrollToIndex(0));
onCleanup(() => handle.dispose());
```

```ts vue-vapor
import { onMounted, onScopeDispose } from "vue";

onMounted(() => list.scrollToIndex(0));
onScopeDispose(() => handle.dispose());
```

```ts octane
import { useEffect } from "octane";

useEffect(() => {
  list.scrollToIndex(0);
  return () => handle.dispose();
});
```
:::

PocketJS APIs that register something for the life of a component take the
teardown hook for you: [`createGesture`](/docs/api/#creategesture-and-attachgesture)
binds `onCleanup` under Solid and `onScopeDispose` under Vue Vapor, so a
recognizer unregisters with the component that created it.

## What the runtime adds

**A state write in a handler commits in the frame that handled it.** Solid and
Vue Vapor mutate the native tree during the write. Octane queues re-renders as
microtasks, and the frame handler in `framework/src/index-octane.ts` drains that
queue inside `flushUniversalSync()` before the sweep that ships the frame's
mutations to the core.

**The banned-import lint fires on Solid builds only.** The Babel plugin in
`framework/compiler/jsx-plugin.ts` rejects `createResource`, `useTransition`,
and `startTransition` when they come from `solid-js`, and its import visitor
returns without checking when the build framework is not Solid. Those three are
Solid's async and concurrent features and want a task queue the PSP's QuickJS
host does not have. Use a signal plus an effect for state over time, and
[`animate()`](/docs/animation/) for motion.

**QuickJS has no event loop, so the runtime installs the globals framework
schedulers assume.** `framework/src/scheduler-polyfill.ts` — the prelude for
both the Vue Vapor and the Octane entries — defines `queueMicrotask`,
`setTimeout`, and `clearTimeout` where the host lacks them. `setTimeout` there
lowers onto the promise job queue and drops its delay, so it is not a timer.
Time a delay with `after()` from `@pocketjs/framework/clock`, which fires off
the virtual clock the frame handler advances.

**Continuous motion does not come from per-frame state.** A value rewritten
from JS every frame costs a commit every frame on all three frameworks.
[`animate()`](/docs/animation/), baked keyframe timelines, `<Sprite>` atlases
and `setTextContent` run the same motion from the Rust core with no per-frame
JS.

## Related

- [Frameworks](/docs/frameworks/) — choosing one, the config, and which
  subpaths each resolves.
- [Components](/docs/components/) — the host primitives and the text model.
- [Animation](/docs/animation/) — motion that costs no per-frame JS.
- [API reference](/docs/api/) — signatures for every PocketJS subpath.
