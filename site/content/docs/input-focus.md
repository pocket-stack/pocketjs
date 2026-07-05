# Input & focus

PocketJS targets a game console: there is no pointer, no touch, no tab key — just a
d-pad and a handful of face buttons. A single **focus manager** tracks one focused
node, the d-pad moves focus between focusable nodes, and **CIRCLE** activates whatever
is focused. On top of that sits a thin layer of per-frame hooks for anything the focus
manager doesn't cover (global shortcuts, held buttons, custom navigation).

Everything here runs identically on real PSP hardware, PPSSPP, the browser host, and
headless Bun. The browser and Bun hosts just remap keys onto the same
[`BTN`](#buttons) bitmask the console reads from the hardware controller.

## Buttons

Every host reports the controller as one integer per frame: a bitmask of the buttons
currently held. The bit values live in the spec and never change across hosts.

```ts
import { BTN } from "@pocketjs/framework/input";
```

| Member | Bit | Notes |
| --- | --- | --- |
| `BTN.SELECT` | `0x0001` | |
| `BTN.START` | `0x0008` | |
| `BTN.UP` | `0x0010` | d-pad |
| `BTN.RIGHT` | `0x0020` | d-pad |
| `BTN.DOWN` | `0x0040` | d-pad |
| `BTN.LEFT` | `0x0080` | d-pad |
| `BTN.LTRIGGER` | `0x0100` | shoulder |
| `BTN.RTRIGGER` | `0x0200` | shoulder |
| `BTN.TRIANGLE` | `0x1000` | |
| `BTN.CIRCLE` | `0x2000` | default "confirm" / press |
| `BTN.CROSS` | `0x4000` | |
| `BTN.SQUARE` | `0x8000` | |

Test a button with a bitwise `&`, and combine buttons with `|`:

```ts
if (buttons & BTN.CROSS) { /* CROSS is down this frame */ }
const confirmOrBack = BTN.CIRCLE | BTN.CROSS;
```

The raw bitmask is a *held* state — it stays set for every frame the button is down.
When you want "the frame a button went down" (edge detection), use the focus manager,
[`onButtonPress`](#button-press-hooks), or edge-detect it yourself.

## The focus model

The focus manager keeps exactly **one** focused node (or none). The default traversal
order is **document order** — a depth-first walk of the live tree, recomputed on each
navigation press, so it is always correct even after a [`<For>`](/docs/components/)
reorders its children.

Each frame, before the render sweep, the manager edge-detects the bitmask and:

- **d-pad moves focus.** Outside a [grid](#focus-grids), `DOWN`/`RIGHT` move to the
  next focusable node and `UP`/`LEFT` move to the previous one. Movement clamps at the
  ends of the list (no wrap). If nothing is focused, the first press enters the order
  from the matching end.
- **CIRCLE fires a press.** It calls `onPress` on the focused node, and if the focused
  node has no handler it **bubbles up** to the nearest ancestor that does.
- **Every focus change is pushed to the native core** (`setFocus`), which applies the
  [`focus:` style variant](#focus-and-active-variants) with zero further JS.

That is the entire default interaction loop. For most screens you never touch the
input API directly — you just mark nodes focusable and give them an `onPress`.

## Making things focusable

Any `View` becomes focusable with the `focusable` prop, and gains a CIRCLE handler
with `onPress`. The [`Focusable`](/docs/app-shell/) component is just a `View` with
`focusable` preset to `true`.

```tsx
import { Focusable, Text } from "@pocketjs/framework/components";

function PlayButton(props: { onStart: () => void }) {
  return (
    <Focusable
      class="px-4 py-2 rounded-lg bg-slate-200 focus:bg-sky-500"
      onPress={props.onStart}
    >
      <Text class="text-slate-900 focus:text-white">Play</Text>
    </Focusable>
  );
}
```

`focusable` and `onPress` are independent. A plain `View` can carry `onPress` without
being focusable — it then acts as a **bubble target**: a focused descendant with no
handler of its own forwards its CIRCLE press up to the nearest ancestor that has one.

## `focus:` and `active:` variants

Because focus lives in the native core, the visual focus state is a **style variant**,
not a JS re-render. Prefix any utility with `focus:` and the core swaps in that value
the instant the node becomes focused — no effect, no reconciliation, no per-frame work
on the JS side.

```tsx
<Focusable class="bg-slate-200 focus:bg-sky-500 focus:scale-105">…</Focusable>
```

The core also supports an `active:` variant for the pressed state. Both are compiled at
build time from the Tailwind subset — see [Styling](/docs/styling/) for the full list of
variants and how they compile.

## Programmatic focus

Grab a node with `ref` (refs hand you the `NodeMirror`) and move focus imperatively.

```tsx
import { focusNode, getFocused } from "@pocketjs/framework/input";
import { onMount } from "solid-js";
import { Focusable, type NodeMirror } from "@pocketjs/framework/components";

function Menu() {
  let first: NodeMirror | undefined;
  onMount(() => focusNode(first ?? null)); // focus the first item on mount
  return <Focusable ref={(n) => (first = n)}>New game</Focusable>;
}
```

| Function | Signature | Behavior |
| --- | --- | --- |
| `focusNode` | `(node: NodeMirror \| null) => void` | Focus a node; `null` clears focus. |
| `getFocused` | `() => NodeMirror \| null` | The currently focused node, or `null`. |

Turning off a node's `focusable` while it is focused automatically clears focus.

## Focus scopes

A **focus scope** temporarily restricts d-pad traversal and CIRCLE press to one
subtree — exactly what a dialog or a menu wants so the background can't be navigated.
The declarative [`FocusScope`](/docs/app-shell/) component (and
[`Modal`](/docs/app-shell/), which is built on it) is the usual way in; the imperative
primitive underneath is `pushFocusScope`.

```ts
import { pushFocusScope } from "@pocketjs/framework/input";
import { onCleanup } from "solid-js";

// `panel` is a NodeMirror captured from a ref.
const dispose = pushFocusScope(panel, { autoFocus: true, restoreFocus: true });
onCleanup(dispose); // always release the scope when it unmounts
```

```ts
interface FocusScopeOptions {
  autoFocus?: boolean;    // focus the scope's first focusable on push (default true)
  restoreFocus?: boolean; // restore the previously focused node on dispose (default true)
}
```

`pushFocusScope` returns a disposer. While a scope is on the stack, focus traversal only
sees nodes inside it, so navigation cannot leak out. Disposing pops the scope and
(unless `restoreFocus` is `false`) returns focus to wherever it was before.

## Focus grids

By default the d-pad walks a flat list. A **focus grid** overlays true row/column
semantics on a subtree: `LEFT`/`RIGHT` move within a row, `UP`/`DOWN` move between rows.
Use the [`FocusGrid`](/docs/app-shell/) component, or the primitive:

```ts
import { pushFocusGrid } from "@pocketjs/framework/input";
import { onCleanup } from "solid-js";

const dispose = pushFocusGrid(gridRoot, { columns: 4, wrap: true });
onCleanup(dispose);
```

```ts
interface FocusGridOptions {
  columns: number; // items per row (clamped to a minimum of 1)
  wrap?: boolean;  // wrap around row/column edges (default false)
}
```

The focusable descendants of `gridRoot`, in document order, are laid out into rows of
`columns`. With `wrap: false`, movement stops at the grid edges; with `wrap: true`,
`RIGHT` off the end of a row returns to its start, `DOWN` off the bottom returns to the
top of that column, and so on.

## Refocus on removal

When the focused node (or an ancestor of it) is removed — a list item deleted, a panel
closed — the manager repairs focus **before** the node is unlinked, so it can still see
the surrounding tree. It searches, in order:

1. the **next sibling** subtree's first focusable,
2. then the **previous sibling** subtrees, nearest first,
3. then the **nearest focusable ancestor**,
4. and finally clears focus if nothing qualifies.

This keeps a sensible node focused as content churns, without any bookkeeping in your
components.

## Per-frame hooks

`onFrame` registers a callback that runs once per frame with the current button
bitmask. It cleans itself up when the owning component unmounts. Use it for held-button
behavior (movement, charging) or anything that must sample input every frame.

```tsx
import { onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { createSignal } from "solid-js";

function Player() {
  const [x, setX] = createSignal(0);
  onFrame((buttons) => {
    if (buttons & BTN.LEFT) setX((v) => v - 2);
    if (buttons & BTN.RIGHT) setX((v) => v + 2);
  });
  // …
}
```

## Button-press hooks

`onFrame` gives you the held state; `onButtonPress` gives you **edge-triggered**
presses. It fires your callback on the frame a matching button transitions from up to
down.

```tsx
import { onButtonPress } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";

// Fires once per press of TRIANGLE.
onButtonPress(BTN.TRIANGLE, () => openMenu());

// Multiple buttons in one handler; `pressed` is the edge mask this frame.
onButtonPress(BTN.CROSS | BTN.CIRCLE, (pressed) => {
  if (pressed & BTN.CROSS) goBack();
  else confirm();
});
```

The callback receives `(pressed, buttons)` — the newly-pressed edge mask and the full
held mask. Options:

```ts
interface ButtonPressOptions {
  active?: boolean | (() => boolean); // gate the handler on/off (default true)
  allowWhenBlocked?: boolean;         // keep firing while input is blocked (default false)
}
```

`active` can be a reactive accessor, so a handler can be enabled only on a given screen:

```tsx
onButtonPress(BTN.SQUARE, () => favorite(), { active: () => tab() === "browse" });
```

The declarative equivalent is the [`ActionHandler`](/docs/app-shell/) component, which
wraps `onButtonPress`:

```tsx
import { ActionHandler } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";

<ActionHandler button={BTN.START} onPress={() => togglePause()} />;
```

## Blocking background input

When a modal or overlay owns input, the buttons behind it should go quiet.
`pushButtonHandlerBlock` increments a global block depth: while it is non-zero, every
`onButtonPress` handler is suppressed **except** those that opted in with
`allowWhenBlocked: true` (system/close handlers). It returns a disposer that decrements
the depth.

```ts
import { pushButtonHandlerBlock } from "@pocketjs/framework/lifecycle";
import { onCleanup } from "solid-js";

const release = pushButtonHandlerBlock();
onCleanup(release);
```

The block only affects `onButtonPress` / `ActionHandler`; the focus manager's own d-pad
navigation and CIRCLE press are unaffected (they are already contained by whatever
[focus scope](#focus-scopes) the overlay pushes). [`Modal`](/docs/app-shell/) combines
both: it pushes a focus scope *and* a handler block for you.

## Browser & playground keyboard mapping

The browser host and the [playground](/playground/) map the keyboard onto the same
`BTN` bitmask the console reads from hardware, so the exact same code runs everywhere:

| Key | Button |
| --- | --- |
| Arrow keys | `UP` / `RIGHT` / `DOWN` / `LEFT` (d-pad) |
| Enter or Z | `CIRCLE` |
| X | `CROSS` |
| A | `SQUARE` |
| S | `TRIANGLE` |
| Left/Right Shift | `SELECT` |
| Space | `START` |
| L or Q | `LTRIGGER` (left shoulder) |
| R or E | `RTRIGGER` (right shoulder) |

The shoulder triggers map to the literal `L` / `R` keys (with `Q` / `E` as a
left-hand alternate). Everything behaves identically to hardware: arrows drive
focus, Enter/Z confirms, `L` / `R` page the shoulder-driven UI, and your
`onButtonPress` handlers fire on the mapped presses.

## Related

- [App shell](/docs/app-shell/) — `Focusable`, `FocusScope`, `FocusGrid`, `Modal`, and `ActionBar` components.
- [Components](/docs/components/) — `View`, `Text`, `Image`, and how Solid control flow maps onto the native tree.
- [Styling](/docs/styling/) — the `focus:` / `active:` variants and the Tailwind subset.
- [Reactivity](/docs/reactivity/) — `createSignal`, `onMount`, `onCleanup`.
