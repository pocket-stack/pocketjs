# App shell & overlays

Screens, focus regions, and floating UI (modals, action bars) are the pieces you
assemble a whole app out of. PocketJS ships these as small, unopinionated
primitives from `@pocketjs/framework/components` — thin wrappers over the same
[`View`](/docs/components/), [focus manager](/docs/input-focus/), and frame
hooks you already use. Nothing here is a framework-within-a-framework: there is
no router, no navigation stack, no global store. Screen switching is ordinary
[reactive state](/docs/reactivity/).

```tsx
import {
  Screen,
  Focusable,
  FocusScope,
  FocusGrid,
  ActionHandler,
  Portal,
  Modal,
  ActionBar,
} from "@pocketjs/framework/components";
```

## The primitives at a glance

| Primitive       | What it is                                                                 |
| --------------- | -------------------------------------------------------------------------- |
| `Screen`        | A full-bleed root `View` with sensible defaults — one per visible page.    |
| `Focusable`     | A `View` that is `focusable` and takes an `onPress`.                        |
| `FocusScope`    | Traps d-pad traversal + CIRCLE inside its subtree while active.             |
| `FocusGrid`     | Gives its subtree explicit row/column d-pad traversal.                     |
| `ActionHandler` | Binds a raw button bitmask to a callback (no focus required).              |
| `Portal`        | Mounts children into the overlay root, outside the screen's flex layout.   |
| `Modal`         | A portalled panel that owns a focus scope and blocks background input.     |
| `ActionBar`     | A portalled, bottom-anchored hint/button strip.                            |
| `Grid`          | A wrapping tile layout that can hand its tiles row/column d-pad traversal.  |
| `Lazy`          | Mounts a subtree on demand, with an optional reveal (loading) delay.        |
| `Gallery`       | A full-screen L/R-paged strip — one whole screen slides in per shoulder press. |

Every one of these except `ActionHandler` and `Portal` extends
[`ViewProps`](/docs/components/) (`class`, `style`, `ref`, `children`,
`focusable`, `onPress`), so anything you can do to a `View` you can do to them.

## Screen

`Screen` is a `View` with a default class of
`relative flex-col w-full h-full bg-slate-50 overflow-hidden`. Use one as the
root of each page. Pass your own `class` to override the default entirely (the
launcher below swaps in a dark wash).

```tsx
function HomeScreen() {
  return (
    <Screen class="relative flex-col w-full h-full bg-slate-950 overflow-hidden">
      {/* page content */}
    </Screen>
  );
}
```

## Focusable

`Focusable` is a `View` with `focusable` pre-set. It exists so intent reads
clearly at the call site; `<Focusable onPress={...}>` and
`<View focusable onPress={...}>` are equivalent.

```tsx
<Focusable
  class="p-2 rounded-md bg-white border-slate-200 focus:border-blue-500"
  onPress={() => select(item)}
>
  <Text class="text-sm text-slate-950">{item.title}</Text>
</Focusable>
```

CIRCLE fires the `onPress` of the focused node, bubbling to the nearest ancestor
handler. The `focus:` style variant is applied by the core with zero extra JS —
see [Input & focus](/docs/input-focus/) for the full model.

## FocusScope

`FocusScope` temporarily restricts d-pad traversal **and** CIRCLE press to its
subtree. This is what keeps a dialog from letting focus wander back into the page
behind it. It adds two options on top of `ViewProps`:

| Prop           | Type                          | Default | Effect                                                          |
| -------------- | ----------------------------- | ------- | -------------------------------------------------------------- |
| `active`       | `boolean \| (() => boolean)`  | `true`  | Whether the scope is currently pushed. Accepts a signal.       |
| `autoFocus`    | `boolean`                     | `true`  | On entry, move focus to the first focusable inside the scope.  |
| `restoreFocus` | `boolean`                     | `true`  | On exit, return focus to whatever was focused before.          |

While the scope is active, navigation is confined to its focusables; when it
tears down it restores the previous focus (unless `restoreFocus={false}`). You
rarely reach for this directly — `Modal` wraps its panel in one for you — but it
is the right tool for a side panel or tab region that should own the d-pad while
open.

## FocusGrid

By default, focus traversal is linear over document order: DOWN/RIGHT go to the
next focusable, UP/LEFT to the previous. `FocusGrid` overrides that inside its
subtree with true two-dimensional movement, which is what you want for a grid of
tiles or a picker.

| Prop      | Type                          | Default | Effect                                                    |
| --------- | ----------------------------- | ------- | -------------------------------------------------------- |
| `columns` | `number`                      | —       | Number of columns (required, floored to at least `1`).   |
| `wrap`    | `boolean`                     | `false` | Wrap around row/column edges instead of clamping.        |
| `active`  | `boolean \| (() => boolean)`  | `true`  | Whether the grid traversal is currently applied.         |

The grid collects its focusables in document order and treats them as a
`columns`-wide table. From index `i`: RIGHT goes to `i + 1` unless you are at the
right edge, LEFT to `i - 1` unless at the left edge, DOWN to `i + columns`, UP to
`i - columns`. With `wrap`, edge moves loop to the other side of the same
row/column instead of clamping.

:::framework-code
```tsx solid
import { For } from "solid-js";
import { FocusGrid, Focusable, Text } from "@pocketjs/framework/components";

<FocusGrid class="flex-row flex-wrap gap-2 w-[440]" columns={3} wrap>
  <For each={games()}>
    {(game) => (
      <Focusable
        class="w-[140] h-[72] rounded-lg bg-white border-slate-200 focus:border-blue-500"
        onPress={() => launch(game)}
      >
        <Text class="text-sm text-slate-950">{game.title}</Text>
      </Focusable>
    )}
  </For>
</FocusGrid>;
```

```tsx vue-vapor
import { FocusGrid, Focusable, Text } from "@pocketjs/framework/components";

<FocusGrid class="flex-row flex-wrap gap-2 w-[440]" columns={3} wrap>
  {games.value.map((game) => (
    <Focusable
      class="w-[140] h-[72] rounded-lg bg-white border-slate-200 focus:border-blue-500"
      onPress={() => launch(game)}
    >
      <Text class="text-sm text-slate-950">{game.title}</Text>
    </Focusable>
  ))}
</FocusGrid>;
```
:::

Because the grid keys off document order, it stays correct after a
[`For`](/docs/components/) reorders or filters its rows. It is a traversal
override only — it does not lay anything out, so use flexbox
([styling](/docs/styling/)) to actually position the tiles.

## ActionHandler

`ActionHandler` binds a raw button bitmask to a callback, independent of focus.
Use it for global shortcuts — open a menu on SELECT, back out on CROSS, cycle a
value on a shoulder button.

| Prop               | Type                                          | Notes                                              |
| ------------------ | --------------------------------------------- | -------------------------------------------------- |
| `button`           | `number`                                      | A `BTN` value, or several OR'd together.           |
| `onPress`          | `(pressed: number, buttons: number) => void`  | `pressed` = newly-pressed edge bits this frame.    |
| `active`           | `boolean \| (() => boolean)`                  | Gate the handler on/off. Defaults to on.           |
| `allowWhenBlocked` | `boolean`                                     | Keep firing even while a `Modal` blocks input.     |

It renders its `children` (or nothing), so drop it anywhere in the tree.

```tsx
import { ActionHandler } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";

<ActionHandler button={BTN.SELECT} onPress={() => setMenuOpen((v) => !v)} />;

// Combine buttons and inspect the edge bitmask:
<ActionHandler
  button={BTN.LTRIGGER | BTN.RTRIGGER}
  onPress={(pressed) => {
    if (pressed & BTN.LTRIGGER) prevTab();
    if (pressed & BTN.RTRIGGER) nextTab();
  }}
/>;
```

`BTN` is imported from [`@pocketjs/framework/input`](/docs/input-focus/) and covers
every PSP button (`SELECT`, `START`, `UP`/`DOWN`/`LEFT`/`RIGHT`, `LTRIGGER`,
`RTRIGGER`, `TRIANGLE`, `CIRCLE`, `CROSS`, `SQUARE`).

## Portal & the overlay root

`Portal` mounts its children into the runtime **overlay root** — a full-screen,
absolutely positioned layer (`z-index: 1000`) that `mount()` installs alongside
your app. Because the overlay lives outside the active screen's flex tree,
portalled UI never pushes your layout around: a modal or action bar floats on
top regardless of what the page underneath is doing.

```tsx
import { Portal, View, Text } from "@pocketjs/framework/components";

<Portal>
  <View class="absolute top-3 right-3 px-2 py-1 rounded-md bg-white border-slate-200">
    <Text class="text-xs text-slate-500">Saved</Text>
  </View>
</Portal>;
```

`Portal` renders nothing in place and cleans up its overlay host on unmount. It
throws `PocketJS: overlay root is not installed` if used outside a mounted app —
which only happens if you render components without `mount()`. `Modal` and
`ActionBar` are both built on `Portal`, so you usually reach for those instead.

## Modal

`Modal` is a portalled panel that centers itself over a dimmed backdrop, owns a
[`FocusScope`](#focusscope) on its panel, and — crucially — **blocks background
button handlers** while open. Any [`ActionHandler`](#actionhandler) /
`onButtonPress` handler in the rest of the app stops firing until the modal
closes, so the page behind can't react to input it can't see.

| Prop         | Type                          | Default                                                                      |
| ------------ | ----------------------------- | --------------------------------------------------------------------------- |
| `open`       | `boolean \| (() => boolean)`  | `true` — visibility. Pass a signal accessor to drive it reactively.         |
| `panelClass` | `string`                      | `flex-col gap-2 w-[328] p-3 rounded-xl shadow-lg bg-white border-slate-200` |
| `class`      | `string`                      | `absolute inset-0 z-50 flex-col items-center justify-center` (the layer)    |
| `children`   | `Element`                     | The panel contents.                                                         |

:::framework-code
```tsx solid
import { Modal, Focusable, Text, View } from "@pocketjs/framework/components";
import { createSignal } from "solid-js";

function DeletePrompt(props: { onConfirm: () => void }) {
  const [open, setOpen] = createSignal(false);
  return (
    <Modal open={open}>
      <Text class="text-lg text-slate-950 font-bold">Delete save?</Text>
      <View class="flex-row gap-2">
        <Focusable
          class="px-3 py-1 rounded-md bg-slate-100 border-slate-200 focus:border-blue-500"
          onPress={() => setOpen(false)}
        >
          <Text class="text-sm text-slate-950">Cancel</Text>
        </Focusable>
        <Focusable
          class="px-3 py-1 rounded-md bg-rose-600 border-rose-500 focus:border-rose-300"
          onPress={props.onConfirm}
        >
          <Text class="text-sm text-white">Delete</Text>
        </Focusable>
      </View>
    </Modal>
  );
}
```

```tsx vue-vapor
import { ref } from "vue";
import { Modal, Focusable, Text, View } from "@pocketjs/framework/components";

function DeletePrompt(props: { onConfirm: () => void }) {
  const open = ref(false);
  return () => (
    <Modal open={() => open.value}>
      <Text class="text-lg text-slate-950 font-bold">Delete save?</Text>
      <View class="flex-row gap-2">
        <Focusable
          class="px-3 py-1 rounded-md bg-slate-100 border-slate-200 focus:border-blue-500"
          onPress={() => {
            open.value = false;
          }}
        >
          <Text class="text-sm text-slate-950">Cancel</Text>
        </Focusable>
        <Focusable
          class="px-3 py-1 rounded-md bg-rose-600 border-rose-500 focus:border-rose-300"
          onPress={props.onConfirm}
        >
          <Text class="text-sm text-white">Delete</Text>
        </Focusable>
      </View>
    </Modal>
  );
}
```
:::

Two behaviors worth internalizing:

- **The block is on button *handlers*, not on rendering or animation.**
  [`onFrame`](/docs/animation/)-based work — [`animate()`](/docs/animation/),
  `createSpriteAnimation`, per-frame logic — keeps ticking while the modal is up.
  Only edge-triggered press handlers are suppressed. This is why a modal can
  fade and slide in while the page behind it holds still.
- **The block is global**, so even a handler *inside* the modal is suppressed
  unless it opts out with `allowWhenBlocked`. If your dialog drives its own
  cursor with an `ActionHandler`, set `allowWhenBlocked` on it (see the picker
  below). D-pad focus navigation is unaffected — the modal's `FocusScope`
  already confines it to the panel.

## ActionBar

`ActionBar` is a portalled strip pinned to the bottom of the screen — the
natural home for button-hint captions or a persistent set of actions. Its
default class is
`absolute left-3 right-3 bottom-3 flex-row items-center justify-between px-2 py-1 rounded-lg shadow-md bg-white border-slate-200`;
override `class` for a different look. It takes ordinary `ViewProps` children.

```tsx
import { ActionBar, Text, View } from "@pocketjs/framework/components";

<ActionBar>
  <View class="flex-row gap-3">
    <Text class="text-xs text-slate-500">CIRCLE Select</Text>
    <Text class="text-xs text-slate-500">CROSS Back</Text>
  </View>
  <Text class="text-xs text-slate-500">START Menu</Text>
</ActionBar>;
```

Because it lives in the overlay layer, the bar stays put no matter how the
underlying screen scrolls or reflows.

## Grid

`Grid` lays a wall of fixed-width tiles out as a wrapping row and — when you give
it `columns` and turn `focus` on — hands them the same row/column d-pad traversal
as [`FocusGrid`](#focusgrid). Layout stays pure flexbox: the visible column count
emerges from the tile width vs. the container width, and `columns` drives
*traversal only*.

| Prop      | Type                         | Default | Effect                                                        |
| --------- | ---------------------------- | ------- | ------------------------------------------------------------- |
| `columns` | `number`                     | —       | Column count for d-pad traversal (only used when `active` is on). |
| `gap`     | `number`                     | —       | Cross-axis gap in px, applied via `style` (keeps `class` a single literal). |
| `wrap`    | `boolean`                    | `false` | Wrap traversal around row/column edges.                       |
| `active`  | `boolean \| (() => boolean)` | —       | Enable `FocusGrid` traversal (needs `columns`). Accepts a signal — same `active` convention as `FocusScope`/`FocusGrid`. |

It otherwise takes ordinary [`ViewProps`](/docs/components/); pass a fixed width
so the tiles wrap where you want them to.

```tsx
import { Grid, Image, Text, View } from "@pocketjs/framework/components";

<Grid columns={3} active gap={10} class="flex-row flex-wrap items-start justify-center w-[264]">
  {tiles.map((t) => (
    <View class="flex-col items-center gap-1 w-[78]">
      <View class="w-[68] h-[68] rounded-xl bg-slate-900 border-slate-700 focus:border-white items-center justify-center" focusable onPress={() => open(t)}>
        <Image class="w-[56] h-[56] rounded-lg" src={t.src} />
      </View>
      <Text class="text-xs text-slate-200 font-bold">{t.name}</Text>
    </View>
  ))}
</Grid>;
```

## Lazy

`Lazy` mounts a subtree **on demand**. While `when` is false nothing is built —
the native subtree is destroyed by the end-of-frame [sweep](/docs/architecture/)
(one recursive `destroyNode`), so an off-screen region costs nothing. When `when`
turns true the content is created, optionally after a short `reveal` delay that
shows a `fallback` (a spinner or skeleton). The reveal is a **one-shot latch**:
it runs the first time the subtree activates and then stays revealed for the
component's lifetime, so re-activating shows the content immediately (no replayed
spinner). With `reveal` at its `0` default `Lazy` is a plain gate with no
per-frame cost.

| Prop       | Type                         | Default | Effect                                                             |
| ---------- | ---------------------------- | ------- | ------------------------------------------------------------------ |
| `when`     | `boolean \| (() => boolean)` | —       | Mount the content while truthy; unmount (destroy) when false.      |
| `reveal`   | `number`                     | `0`     | Host frames to show `fallback` before revealing content the first time it activates. |
| `fallback` | `Element \| (() => Element)` | —       | Shown during the reveal delay.                                     |
| `children` | `() => Element`              | —       | Deferred content — only built once active and past the reveal.     |

> **What "lazy" means here.** Textures are uploaded eagerly at pak load (there is
> no runtime texture streaming), so `Lazy` defers *content build/layout/draw*, not
> texture residency. The `reveal` delay models an on-demand load for the demo's
> sake — it is a frame counter, not real I/O.

```tsx
<Lazy when={isOpen} reveal={16} fallback={() => <Spinner />}>
  {() => <HeavyPanel />}
</Lazy>;
```

## Gallery

`Gallery` is a horizontally paged, full-screen strip: pressing `LTRIGGER` /
`RTRIGGER` slides one whole screen at a time. It is the natural shell for a photo
wall, an app launcher, or any "screen-by-screen" browse.

| Prop           | Type                          | Default | Effect                                                       |
| -------------- | ----------------------------- | ------- | ------------------------------------------------------------ |
| `count`        | `number`                      | —       | Total number of pages.                                       |
| `page`         | `() => number`                | —       | Controlled current-page accessor (0-based).                  |
| `onPageChange` | `(next: number) => void`      | —       | Called with the next page when L/R paging is requested.      |
| `renderPage`   | `(index: number) => Element`  | —       | Page factory — invoked only for pages inside the mount window (lazy). |
| `window`       | `number`                      | `1`     | Pages kept mounted on each side of the current one.          |
| `duration`     | `number`                      | `300`   | Slide duration in ms.                                        |
| `easing`       | `EasingName`                  | `"out"` | Slide easing.                                                |
| `bindTriggers` | `boolean`                     | `true`  | Bind `LTRIGGER`/`RTRIGGER` to page(-/+1) internally.         |
| `wrap`         | `boolean`                     | `false` | Wrap past the ends instead of clamping.                      |

`Gallery` is **controlled** — you own the `page` signal, so the rest of the UI (a
page indicator, a title) can read it. It reads L/R itself and calls
`onPageChange`; the slide is a single native [`translateX`](/docs/animation/)
tween per press (paint-only, no relayout), and pages outside the `window` are not
built at all, so a many-page gallery stays within the draw budget.

:::framework-code
```tsx solid
import { Gallery, Screen } from "@pocketjs/framework/components";
import { createSignal } from "solid-js";

function Photos() {
  const [page, setPage] = createSignal(0);
  return (
    <Screen class="relative w-full h-full bg-slate-950 overflow-hidden">
      <Gallery
        count={4}
        page={page}
        onPageChange={setPage}
        renderPage={(i) => <PhotoPage index={i} current={page} />}
      />
    </Screen>
  );
}
```

```tsx vue-vapor
import { ref } from "vue";
import { Gallery, Screen } from "@pocketjs/framework/components";

function Photos() {
  const page = ref(0);
  return () => (
    <Screen class="relative w-full h-full bg-slate-950 overflow-hidden">
      <Gallery
        count={4}
        page={page.value}
        onPageChange={(next) => {
          page.value = next;
        }}
        renderPage={(i) => <PhotoPage index={i} current={() => page.value} />}
      />
    </Screen>
  );
}
```
:::

Under the hood `Gallery` is a **static `overflow-hidden` viewport** wrapping an
**animated strip** of absolutely-positioned page cells. The split matters: the
scissor is taken from the clip node's own box, so the clipping viewport must not
move — only the inner strip's `translateX` animates. `demos/gallery` is a full
worked example (L/R paging, a [`Grid`](#grid) of baked tiles, [`Lazy`](#lazy)
first-visit loading, and a page-dot [`ActionBar`](#actionbar)); build it with
`bun scripts/build.ts gallery-main` and press **L / R** (or **Q / E**).

## Worked example: the launcher

`demos/launcher` is a small app built entirely from these primitives. It holds
two reactive values — the active demo index and whether the picker is open — and
that is the whole "router":

:::framework-code
```tsx solid
import { Match, Switch } from "solid-js";
import {
  ActionHandler,
  Modal,
  Screen,
  View,
} from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import { createSignal } from "solid-js";

export default function Launcher() {
  const [active, setActive] = createSignal<number | null>(null);
  const [pickerOpen, setPickerOpen] = createSignal(true);

  const togglePicker = () => {
    if (active() === null) return setPickerOpen(true);
    setPickerOpen(!pickerOpen());
  };

  return (
    <Screen class="relative w-full h-full bg-slate-950 overflow-hidden">
      {/* SELECT toggles the picker even while the modal owns input */}
      <ActionHandler button={BTN.SELECT} allowWhenBlocked onPress={togglePicker} />

      <ActiveDemo index={active()} />

      <DemoPicker
        open={pickerOpen()}
        current={active()}
        onPick={setActive}
        onClose={() => setPickerOpen(false)}
      />
    </Screen>
  );
}
```

```tsx vue-vapor
import { ref } from "vue";
import {
  ActionHandler,
  Modal,
  Screen,
  View,
} from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";

export default function Launcher() {
  const active = ref<number | null>(null);
  const pickerOpen = ref(true);

  const togglePicker = () => {
    if (active.value === null) {
      pickerOpen.value = true;
      return;
    }
    pickerOpen.value = !pickerOpen.value;
  };

  return () => (
    <Screen class="relative w-full h-full bg-slate-950 overflow-hidden">
      <ActionHandler button={BTN.SELECT} allowWhenBlocked onPress={togglePicker} />

      <ActiveDemo index={active.value} />

      <DemoPicker
        open={pickerOpen.value}
        current={active.value}
        onPick={(next) => {
          active.value = next;
        }}
        onClose={() => {
          pickerOpen.value = false;
        }}
      />
    </Screen>
  );
}
```
:::

`ActiveDemo` is just a [`Switch`/`Match`](/docs/components/) over the index —
swapping the whole screen is nothing more than a signal write:

:::framework-code
```tsx solid
function ActiveDemo(props: { index: number | null }) {
  return (
    <Switch>
      <Match when={props.index === null}>
        <View class="w-full h-full bg-slate-950" />
      </Match>
      <Match when={props.index === 0}>
        <Hero />
      </Match>
      {/* ...one Match per demo... */}
    </Switch>
  );
}
```

```tsx vue-vapor
function ActiveDemo(props: { index: number | null }) {
  return props.index === null ? (
    <View class="w-full h-full bg-slate-950" />
  ) : props.index === 0 ? (
    <Hero />
  ) : null;
}
```
:::

The picker itself is a `Modal`. Its cursor is driven by an `ActionHandler` that
reads the d-pad + CIRCLE edge bits — and because the modal blocks background
handlers globally, that handler sets `allowWhenBlocked` so it keeps firing while
the modal is the thing that's open:

```tsx
const PICKER_BUTTONS = BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT | BTN.CIRCLE;

<Modal
  open={() => props.open}
  panelClass="flex-col gap-2 w-[424] h-[240] p-2 rounded-xl bg-white border-slate-200"
>
  <ActionHandler
    button={PICKER_BUTTONS}
    active={() => props.open}
    allowWhenBlocked
    onPress={handlePickerPress}
  />
  {/* animated selection ring + demo tiles */}
</Modal>;
```

The selection ring slides between cells with [`animate()`](/docs/animation/),
which keeps running because the modal only blocks *handlers*, not frame hooks.

Run it with `bun scripts/build.ts launcher`, or try the primitives live in the
[playground](/playground/).

## Routing is just app state

There is deliberately no router package. A screen is a component; "navigating"
is writing a signal that a `Switch`/`Match` (or a `Show`) reads. That keeps
navigation fully reactive, testable in [headless Bun](/docs/architecture/), and
free of any global you didn't put there yourself. When you need a back stack,
store an array of screen ids in a signal and push/pop it — the same primitives
compose all the way up.

See also: [Input & focus](/docs/input-focus/) for the traversal model,
[Animation](/docs/animation/) for the frame hooks modals leave running, and
[Components](/docs/components/) for the underlying `View`/`Text` host
primitives and how Solid control flow maps onto the native tree.
