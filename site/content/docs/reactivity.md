# Reactivity

This page documents the default **Solid** runtime. PocketJS uses Solid's
reactive system directly — the same `createSignal` / `createEffect` /
`createMemo` you'd use in a Solid web app. Vue Vapor apps import Vue's
Composition API directly from `vue`; see [Frameworks](/docs/frameworks/).
There is no PocketJS reactivity wrapper.

Import these primitives directly from `solid-js`; PocketJS does not provide a
reactivity layer. The PocketJS compiler only checks that the Solid primitives
you import can run on the target hosts:

```ts
import {
  createSignal,
  createEffect,
  createMemo,
  onMount,
  onCleanup,
  batch,
  untrack,
} from "solid-js";
```

If you already know Solid, you know this API. If you're coming from React: these
are fine-grained signals, not hooks. They aren't tied to a component render, they
don't re-run a component function, and there are no dependency arrays.

## The no-VDOM model

React re-renders a component, builds a new virtual tree, and diffs it against the
old one. Solid does none of that. A component function runs **once**, wiring up
signals and effects. After that, the only things that ever run again are the
effect closures whose signals changed.

That property is what makes PocketJS viable on a 2005 handheld:

- **No diffing.** There is no reconciliation walk per frame. A signal update
  touches only the nodes that actually depend on it.
- **One FFI crossing per frame.** The renderer keeps a JS *mirror tree* of the
  native node tree, so Solid's reconciler reads (parent, children, siblings)
  never cross into Rust. Only *mutations* — `setText`, `setStyle`, `setProp`,
  `insertBefore` — cross, and they're flushed as one batch per frame. See
  [Architecture](/docs/architecture/) and the [native contract](/docs/native-contract/).
- **Effects only fire on interaction.** In steady state (no signal changed) the
  JS side does essentially nothing; the Rust core still ticks animations and
  layout at a fixed 1/60 s. Idle screens cost no JS work.

## createSignal

A signal is a getter/setter pair. Call the getter to read (and, inside a tracking
scope, subscribe); call the setter to write.

```tsx
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

The setter also accepts an updater function — `setCount((n) => n + 1)` — which
is handy when the next value depends on the previous one.

### Signals in text

`Count: {count()}` is not a special construct — it's a `<Text>` element with two
children: a static string `"Count: "` and a dynamic expression `count()`. The
renderer lays both out as a **single concatenated inline run** (one measure, not
two flex items), and when `count()` changes, Solid calls `replaceText` on just
the dynamic segment. The static prefix never re-measures unless it too changes.

You can mix as many static and dynamic segments as you like inside one `<Text>`;
they all fold into one inline run. See [Components](/docs/components/) for the
text model.

## createEffect

An effect runs immediately, tracks every signal it reads, and re-runs whenever any
of them changes. Use it for side effects — driving an animation, logging, imperative
work — not for producing values you render (use a signal or memo for that).

```tsx
import { createSignal, createEffect } from "solid-js";

const [level, setLevel] = createSignal(0);

createEffect(() => {
  // Re-runs every time level() changes.
  if (level() >= 100) console.log("charged");
});
```

Effects are the right place to bridge reactive state to imperative APIs like
[`animate()`](/docs/animation/): read a signal, and when it changes, kick a
native tween.

## createMemo

A memo is a derived, cached signal. It re-computes only when one of its inputs
changes, and downstream readers only re-run when the memo's *result* actually
changes. Reach for it when a derivation is expensive or read in several places.

```tsx
import { createSignal, createMemo } from "solid-js";

const [items, setItems] = createSignal<string[]>([]);
const total = createMemo(() => items().length);

// total() is cached; it recomputes only when items() changes.
```

## onMount and onCleanup

`onMount` runs a callback once, after the component's initial render — the place
to do one-time imperative setup. It's exactly where the hero demo starts its
underline sweep:

```tsx
import { View, type NodeMirror } from "@pocketjs/framework/components";
import { animate } from "@pocketjs/framework/animation";
import { onMount } from "solid-js";

function Underline() {
  let underline: NodeMirror | undefined;
  onMount(() => {
    // Runs once; the tween ticks natively — zero steady-state JS.
    if (underline) animate(underline, "width", 210, { dur: 700, easing: "out", delay: 150 });
  });
  return <View ref={underline} class="h-1 w-0 rounded-full bg-blue-500" />;
}
```

`onCleanup` registers a callback that runs when the enclosing scope is disposed —
a component unmounting, or an effect re-running. Use it to release anything you
acquired imperatively.

```tsx
import { createEffect, onCleanup } from "solid-js";
import { animate, cancelAnim } from "@pocketjs/framework/animation";

createEffect(() => {
  const anim = animate(node, "opacity", 1, { dur: 300 });
  onCleanup(() => cancelAnim(anim)); // runs before the next re-run / on dispose
});
```

## batch and untrack

`batch` groups multiple signal writes so dependent effects run **once** at the end
instead of after each write — useful when you update several related signals
together.

```tsx
import { batch } from "solid-js";

batch(() => {
  setX(10);
  setY(20); // effects that read x() and y() run once, after the batch
});
```

`untrack` reads a signal **without** subscribing to it — the current effect or
memo won't re-run when that signal later changes.

```tsx
import { untrack } from "solid-js";

createEffect(() => {
  const live = trigger();           // tracked: re-runs when trigger() changes
  const snapshot = untrack(config); // read once, not a dependency
  apply(live, snapshot);
});
```

## What is banned — and why

The PSP runs JavaScript on **QuickJS** (Bellard's engine, roughly ES2023).
Critically, that host has **no scheduler**: there is no `setTimeout`, no
`MessageChannel`, and no `performance`. `queueMicrotask` is polyfilled via
`Promise.resolve().then(...)`, which is enough for Solid's synchronous batching —
but nothing that needs real timers or a task queue can work.

That rules out Solid's async and concurrent features. These are **compile errors**
in PocketJS — the build's Babel plugin lints their imports and fails the
[build](/docs/build-pipeline/) rather than shipping something that would break at
runtime on hardware:

| Banned import | Why |
|---|---|
| `createResource` | Needs async scheduling; QuickJS has no task queue / timers. |
| `useTransition` | Time-slicing needs a scheduler (`setTimeout` / `MessageChannel`). |
| `startTransition` | Same — concurrent scheduling is unavailable on PSP. |

### What to use instead

- **For state that changes over time:** signals + `createEffect`. There's no
  "pending" transition state to model — updates are synchronous and cheap.
- **For motion:** don't reach for transitions to smooth a change. Declare motion
  with [`animate()`](/docs/animation/) or a Tailwind `transition-*` class. Those
  tick in Rust at a fixed 1/60 s, so animation is a pure function of frame index
  (which is what makes byte-exact goldens possible) and costs the JS side nothing
  per frame.
- **For "async" data:** load it at build time into the app bundle / pak, or
  drive it from host input. There is no runtime fetch on the PSP.

Everything you need for interactive UI — derive with memos, react with effects,
animate natively — is covered by the seven primitives above.
