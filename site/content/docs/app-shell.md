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

```tsx
import { FocusGrid, Focusable, Text, For } from "@pocketjs/framework/components";

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

```tsx
import { Modal, Focusable, Text, View } from "@pocketjs/framework/components";
import { createSignal } from "@pocketjs/framework/reactivity";

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

## Worked example: the launcher

`demos/launcher` is a small app built entirely from these primitives. It holds
two signals — the active demo index and whether the picker is open — and that is
the whole "router":

```tsx
import {
  ActionHandler,
  Match,
  Modal,
  Screen,
  Switch,
  View,
} from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import { createSignal } from "@pocketjs/framework/reactivity";

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

`ActiveDemo` is just a [`Switch`/`Match`](/docs/components/) over the index —
swapping the whole screen is nothing more than a signal write:

```tsx
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
[Components](/docs/components/) for the underlying `View`/`Text`/`Show`/`Switch`
surface.
