# Animation

PocketJS has three ways to move things:

- **Baked keyframe timelines** — CSS-grade `keyframes` / `animation` choreography
  authored in `pocket.config.ts` and applied with `animate-<name>` classes. Compiled
  into binary timelines at build time; the richest option.
- **Transition utilities** — Tailwind-subset classes (`transition`, `duration-N`,
  `ease-*`, `delay-N`) that tween a node whenever its style is swapped.
- **The imperative API** — `animate()`, `spring()` and `cancelAnim()` from
  [`@pocketjs/framework/animation`](/docs/api/), for one-off tweens you kick off from code.

All three compile down to the same native machinery. **You declare motion once; the
Rust core owns every frame from there.**

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
import { onMount } from "solid-js";

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
| `rotate`, `rotateX`, `rotateY`                                     | degrees                 |
| `translateZ`                                                       | pixels                  |
| `arcStart`, `arcSweep`                                             | degrees                 |
| `arcWidth`                                                         | pixels                  |
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
import { onMount } from "solid-js";

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
| `transition-transform` | `translateX/Y`, `scale`, `scaleX/Y`, `rotate` (2D only — see [below](#which-props-animate-where)) |
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

## Baked keyframe timelines

For anything richer than a single tween — multi-stop choreography, staggered
sequences, loops — author `keyframes` and `animation` in `pocket.config.ts`, in the
exact shape of a `tailwind.config.js` theme:

```ts
// pocket.config.ts
export default {
  framework: "solid",
  theme: {
    keyframes: {
      "menu-open":  { from: { width: 38 }, "60%": { width: 144 }, to: { width: 141 } },
      "menu-close": { from: { width: 141 }, "60%": { width: 31 }, to: { width: 38 } },
    },
    animation: {
      "menu-pill": {
        value: "menu-open 0.6s ease-in-out 0.2s both, menu-close 0.6s ease-in-out 1.2s forwards",
        loop: "4000ms",
      },
    },
  },
};
```

```tsx
<View class="w-[38] h-[38] rounded-[19px] bg-white overflow-hidden animate-menu-pill" />
```

The compiler bakes every referenced animation into frame-precise, per-property
segment timelines inside `styles.bin`. At runtime the core never parses a string —
a timeline is pure data, sampled once per tick. Zero per-frame JS, byte-exact
across every host.

### CSS shorthand semantics

The `animation` value is the standard CSS shorthand, and its semantics survive the
bake:

- **Comma lists** with independent durations and delays.
- **Fill modes** — `forwards`, `backwards`, `both`; list precedence works the CSS
  way (the last animation currently *applying* a property wins, so an intro that
  fills forwards hands off to a later outro with no JS sequencing).
- **`reverse`** (baked as flipped segments) and **`infinite`**.
- **`cubic-bezier(x1, y1, x2, y2)`** plus the named easings (`linear`, `ease`,
  `ease-in`, `ease-out`, `ease-in-out`), which bake to their canonical browser
  curves.

### Keyframe properties

Keyframe declarations are CSS-in-JS (camelCase or kebab-case). Bakeable
properties: `opacity`, `width`/`height`, `top`/`right`/`bottom`/`left`/`inset`,
`padding`, `margin`, `gap`, `borderRadius`, `borderWidth`, `backgroundColor`,
`color`, `borderColor`, `letterSpacing`, `lineHeight`, the arc props
(`arcStart`/`arcSweep`/`arcWidth`) — and `transform` strings, which decompose
into per-property tracks:

```ts
"card-flip": {
  from: { transform: "rotateY(0deg) translateZ(0px)" },
  to:   { transform: "rotateY(180deg) translateZ(24px)" },
},
```

Supported transform functions: `translate()`, `translateX/Y/Z()`, `rotate()`,
`rotateX/Y()`, `scale()`, `scaleX/Y()`. Mixed `scale()`/`scaleX()` keyframes
share one prop space (uniform scale decomposes to X + Y).

**Values must be build-time absolute.** A `translateX(-50%)`, `calc()` or
`var()` is a compile error, not a silent guess — the core has no reference box
at runtime. Write the resolved pixel value.

### The loop CSS cannot write: `animate-loop-[N]`

Plain CSS cannot say *replay this whole comma list — delays included — every
N milliseconds*. PocketJS adds a style-level loop period, either as the `loop`
key in the config (above) or inline:

```tsx
<View class="… animate-dpad-up animate-loop-[4000ms]" />
```

Every node's animation clock wraps modulo the period, so a whole page of tiles
restarts in sync — no remounts, no timers, no drift. `animate-loop-[…]` accepts
`ms` or `s` and must appear in the same literal as an `animate-<name>` (compile
error otherwise).

### Tailwind built-ins

`animate-spin`, `animate-ping`, `animate-pulse` and `animate-bounce` ship with
their standard Tailwind definitions (bounce's `-25%` translate is pinned to the
default `-6px`, since percentages don't bake).

## 3D transforms

A node with `perspective-[N]` becomes a **3D context root**: its subtree composes
3D transforms, projects through the root's perspective distance about the root
center, and painter-sorts into clipped triangles the GPU rasterizes.

| Utility | Effect |
|---|---|
| `perspective-[800]` | 3D context root; perspective distance in px |
| `rotate-x-[deg]` | rotation about the X axis |
| `rotate-y-[deg]` | rotation about the Y axis |
| `translate-z-[px]` | depth translation (positive = toward the viewer) |

```tsx
<View class="perspective-[800]">
  <View class="w-24 h-24 bg-blue-600 rotate-y-[35] translate-z-[-40]" />
</View>
```

All four take bracketed arbitrary values (negatives allowed). `rotate-N` without
an axis stays the 2D Z rotation. Transforms compose in a fixed canonical order —
scale, then rotate Y, rotate X, rotate Z, then translate — the common CSS idiom,
though not an arbitrary `transform:` function list: there is no `matrix3d()`,
`rotate3d()`, `scaleZ()`, or custom function ordering. `perspective` itself is a
static context property, not animatable.

`rotateX`, `rotateY` and `translateZ` animate through **baked timelines** and
**`animate()`** — the card-flip example above is the canonical use. See
[which props animate where](#which-props-animate-where) for why `transition-*`
can't drive them.

## Arcs

`arc-start-[deg]`, `arc-sweep-[deg]` and `arc-width-[px]` turn a node's
background into a round-capped annular sector — a stroke arc as a native
primitive, no SVG path renderer required:

```tsx
{/* a reload spinner: 315° of stroke, drawn from the background color */}
<View class="w-10 h-10 bg-blue-600 arc-start-[45] arc-sweep-[315] arc-width-[5]" />
```

All three are animatable (timelines and `animate()`), which is how the Motion
Lab reload study reproduces SVG `stroke-dasharray` drawing: the compiler samples
the dash motion into `arcStart`/`arcSweep` keyframe stops.

## Which props animate where

Every animation path gates on the same native animatable-prop set, with one
boundary worth knowing:

| Props | `animate()` / `spring()` | Baked timelines | `transition-*` classes |
|---|---|---|---|
| 2D transforms, colors, opacity, layout props | ✓ | ✓ | ✓ |
| `rotateX`, `rotateY`, `translateZ` | ✓ | ✓ | — |
| `arcStart`, `arcSweep`, `arcWidth` | ✓ | ✓ | — |

The transition mask is a u32 and the 3D/arc props live beyond bit 32, so a
`transition-transform` on a `focus:rotate-y-[…]` swap will not tween — it snaps.
Drive 3D and arc motion with a timeline or `animate()`.

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
