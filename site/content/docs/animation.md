# Animation

PocketJS has two ways to move things:

- **Declarative motion utilities** — Tailwind-subset classes (`transition`, `duration-N`,
  `ease-*`, `delay-N`) that tween a node whenever its style is swapped.
- **The imperative API** — `animate()`, `spring()` and `cancelAnim()` from
  [`@pocketjs/framework/animation`](/docs/api/), for one-off tweens you kick off from code.

Both compile down to the same native machinery. **You declare motion once in JS; the
Rust core owns the tween from there.**

## How native animation works

Tweens and springs tick in the Rust core once per vblank at a **fixed `dt = 1/60 s`**.
That has two consequences worth internalizing:

- **Zero steady-state JS.** After you call `animate()` (or a style swap starts a
  transition), JavaScript is not involved again until the tween ends. A 20-second
  drift costs exactly one FFI call to start — no per-frame `requestAnimationFrame`,
  no signal churn.
- **Deterministic, byte-exact.** Because `dt` is fixed and frame content is a pure
  function of the frame index, the same app produces the same pixels on every run.
  That is what makes PocketJS's byte-exact PNG goldens possible. See
  [Native contract](/docs/native-contract/) and [Build pipeline](/docs/build-pipeline/).

## Imperative: `animate()`

```ts
import { animate } from "@pocketjs/framework/animation";

animate(node, prop, to, { dur, easing, delay }): number
```

`animate` tweens one prop from its **current** value to `to`, and returns an `animId`
you can later pass to `cancelAnim()`. `node` is a node ref (see below) or a raw node id.

| Option   | Type                    | Default | Notes                                              |
| -------- | ----------------------- | ------- | -------------------------------------------------- |
| `dur`    | `number` (ms)           | `200`   | Ignored by spring easings — those run on physics.  |
| `easing` | `EasingName \| number`  | `"out"` | A name below, or a raw `ENUMS.Easing` ordinal.     |
| `delay`  | `number` (ms)           | `0`     | Wait before the tween starts.                      |

Only **animatable** props are accepted; passing an unknown or non-animatable prop
throws at the call site.

### Easing names

`easing` accepts any of these `EasingName` values:

| Name             | Feel                                            |
| ---------------- | ----------------------------------------------- |
| `"linear"`       | Constant speed.                                 |
| `"in"`           | Ease-in (accelerate).                           |
| `"out"`          | Ease-out (decelerate). **Default.**             |
| `"in-out"`       | Ease-in-out.                                    |
| `"out-back"`     | Overshoots the target, then settles.            |
| `"spring"`       | Physics spring; `dur` is ignored.               |
| `"spring-bouncy"`| Springier spring; `dur` is ignored.             |

### Getting a node ref

Give any component a `ref` and Solid assigns the underlying `NodeMirror` to your
variable. Kick the tween off in `onMount`, once the node exists:

```tsx
import { View, type NodeMirror } from "@pocketjs/framework/components";
import { animate } from "@pocketjs/framework/animation";
import { onMount } from "@pocketjs/framework/reactivity";

function Underline() {
  let el: NodeMirror | undefined;
  onMount(() => {
    // Sweep the underline in once on mount — native tween, zero steady-state JS.
    if (el) animate(el, "width", 210, { dur: 700, easing: "out", delay: 150 });
  });
  return <View ref={el} class="h-1 w-0 rounded-full bg-blue-500" />;
}
```

This is the `hero` demo's title underline: it starts at `w-0` and the core animates
`width` up to `210` px. `width` is a **layout** prop, so it relayouts each frame while
tweening — fine for a one-shot flourish, but prefer transforms for anything hot (see
[below](#prefer-transforms-over-layout-props)).

### Animating colors

Color props tween per ABGR channel natively. Pass a packed `u32` ABGR value or a
`'#rrggbb'` / `'#rrggbbaa'` string as `to`:

```ts
animate(card, "bgColor", "#3b82f6", { dur: 150 });
```

### Value units

For non-color props you pass the raw native value:

| Prop family                                                        | Units                   |
| ------------------------------------------------------------------ | ----------------------- |
| `translateX`, `translateY`, `width`, `height`, padding/margin/inset | pixels                 |
| `scale`, `scaleX`, `scaleY`                                        | multiplier (`1` = 100%) |
| `rotate`                                                           | degrees                 |
| `opacity`                                                          | `0`–`1`                 |
| `bgColor`, `gradFrom`, `gradTo`, `borderColor`, `textColor`        | `u32` ABGR or hex string|

## Imperative: `spring()`

```ts
import { spring } from "@pocketjs/framework/animation";

spring(node, prop, to, preset): number
```

`spring` tweens to `to` with a physics spring — the duration comes from the physics,
not a timer, so there is no `dur`. `preset` is `"default"` or `"bouncy"` (bouncier,
more overshoot). It returns an `animId` like `animate`.

This is the `cards` demo's detail panel: it renders offscreen via a `style` object,
then springs into place on mount. Because the panel is a keyed `<Show>` child it
remounts per card, so the spring replays on every open:

```tsx
import { View, Text, type NodeMirror } from "@pocketjs/framework/components";
import { spring } from "@pocketjs/framework/animation";
import { onMount } from "@pocketjs/framework/reactivity";

function Detail(props: { title: string; detail: string }) {
  let el: NodeMirror | undefined;
  onMount(() => {
    if (el) spring(el, "translateY", 0); // springs up from +22px
  });
  return (
    <View ref={el} style={{ translateY: 22 }} class="p-3 rounded-xl bg-white">
      <Text class="text-sm text-slate-950 font-bold">{props.title}</Text>
      <Text class="text-xs text-slate-600">{props.detail}</Text>
    </View>
  );
}
```

Setting the start value with a `style={{…}}` object and animating to the end value on
mount is the canonical "enter" pattern.

## `cancelAnim()`

Stop a running tween with the id `animate()` / `spring()` returned:

```ts
import { animate, cancelAnim } from "@pocketjs/framework/animation";

const id = animate(streak, "translateX", 300, { dur: 20000, easing: "linear" });
// …later:
cancelAnim(id);
```

You rarely need this for one-shots — destroying a node frees its animation tracks
automatically.

## Declarative motion utilities

Add motion utilities to a `class` and the node tweens **whenever its style record is
swapped** — which happens on `focus:` / `active:` variant changes (switched natively,
zero JS) and when a dynamic `class` ternary swaps one full literal for another. The
core tweens only the animatable props that actually changed between the old and new
style.

| Utility                | Animates                                                     |
| ---------------------- | ------------------------------------------------------------ |
| `transition`           | transforms + colors + opacity (the default property set)     |
| `transition-transform` | `translateX/Y`, `scale`, `scaleX/Y`, `rotate`               |
| `transition-colors`    | `bgColor`, `gradFrom`, `gradTo`, `borderColor`, `textColor` |
| `transition-opacity`   | `opacity`                                                    |
| `transition-all`       | every animatable prop (including layout — can relayout)      |

Tune the tween with:

- `duration-N` — duration in ms (`duration-150` = 150 ms). Default **150**.
- `delay-N` — delay in ms. Default **0**.
- `ease-*` — `ease-linear`, `ease-in`, `ease-out`, `ease-in-out`, `ease-spring`,
  `ease-out-back`. Default **ease-in-out**. (`spring-bouncy` is imperative-only.)

A literal with `duration`/`ease`/`delay` but no `transition-*` property utility
behaves like CSS's `transition-property: all`.

This `hero` button fades its background natively on focus and press — no JS runs on
the focus change at all:

```tsx
<View
  class="px-4 py-2 rounded-xl bg-blue-600 focus:bg-blue-500 active:bg-blue-700 transition-colors duration-150"
  focusable
  onPress={() => setCount(count() + 1)}
>
  <Text class="text-base text-white font-bold">Press Circle</Text>
</View>
```

And a `cards` surface that lifts and brightens when focused — a translate plus color
change, both tweened by one `transition-all`:

```tsx
<View
  class="p-3 rounded-xl bg-white border-slate-200 translate-y-1
         focus:bg-blue-50 focus:border-blue-500 focus:translate-y-0
         transition-all duration-150 ease-out"
  focusable
>
  {/* … */}
</View>
```

See [Styling](/docs/styling/) for the full utility set and [Input & focus](/docs/input-focus/)
for how focus moves between nodes.

## Prefer transforms over layout props

Transform props — `translate-x/y`, `scale`, `rotate` — never trigger relayout. Color
and opacity changes don't either. Layout props (`width`, `height`, padding, margin,
inset) **relayout the frame they change on**, which costs a Taffy pass every animated
frame.

For anything that runs continuously or on interaction — enters, lifts, focus emphasis,
ambient drift — animate a transform and leave layout alone. In the `cards` demo the
focused-card lift is `translate-y` (never `scale`, since baked glyphs don't scale),
and the two ambient background streaks are long `translateX` tweens started once on
mount:

```tsx
onMount(() => {
  if (streakA) animate(streakA, "translateX", 300, { dur: 20000, easing: "linear" });
  if (streakB) animate(streakB, "translateX", -260, { dur: 26000, easing: "linear" });
});
```

Two FFI calls buy 20+ seconds of motion with zero further JS. Reserve layout-prop
animation for deliberate one-shots.

Try any of this live in the [playground](/playground/).
