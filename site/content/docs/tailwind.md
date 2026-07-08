# Tailwind utilities

PocketJS styles come from a **build-time Tailwind subset**. There is no runtime
Tailwind, no CSS, and no arbitrary-utility escape hatch: a fixed set of
utilities is parsed at build time by `compiler/tailwind.ts` and baked into
`styles.bin`, which the Rust core reads directly. This page is the exhaustive
reference for exactly which utilities exist and what values they accept.

For how styling fits into the pipeline, see [/docs/styling/](/docs/styling/) and
[/docs/build-pipeline/](/docs/build-pipeline/).

```tsx
import { View, Text } from "@pocketjs/framework/components";

function Card() {
  return (
    <View class="flex flex-col gap-2 p-4 bg-slate-800 rounded-lg">
      <Text class="text-lg font-bold text-slate-50">Hello PSP</Text>
    </View>
  );
}
```

## How a class literal compiles

A candidate string is split on whitespace into tokens. **Every** token must
parse as a supported utility for the string to become a style record.

- If **all** tokens parse, the literal is compiled to a `styleId` and stored in
  `styles.bin`. The `class` attribute is resolved to that id natively.
- If **any** token is not a supported utility, the whole literal is *silently
  ignored* — it is assumed to be ordinary text, not a class string. There is no
  partial application: one unknown token drops the entire literal.
- Token **order does not matter**. Records are canonicalized and deduped, so
  `"p-4 flex"` and `"flex p-4"` share one `styleId`.

Two constructs are compile errors rather than silent drops — see
[Not supported](#not-supported-loud-errors) below.

## The spacing scale

Most sizing/offset utilities take a value on Tailwind's spacing scale, where the
numeric step **N maps to `N * 4` pixels**. Decimals are allowed.

| Token part | Pixels |
|---|---|
| `0` | 0 |
| `1` | 4 |
| `2` | 8 |
| `3` | 12 |
| `4` | 16 |
| `6` | 24 |
| `8` | 32 |
| `12` | 48 |
| `2.5` | 10 |

**Arbitrary pixel values** are supported for every spacing-scale utility using
bracket syntax — the value is taken as literal pixels (the `px` suffix is
optional):

```tsx
<View class="w-[123] h-[123px] p-[10] gap-[6px]" />
```

A second group of utilities (`z`, `opacity`, `scale`, `scale-x`, `scale-y`,
`rotate`, `duration`, `delay`) take a **plain number** instead. Those do **not**
accept bracket/arbitrary syntax — only bare digits.

**Negative values are not supported.** There are no `-m-2`, `-translate-x-2`,
`-rotate-45`, etc. Any token beginning with `-` fails to parse.

## Color palette

Colors come from the Tailwind v3 default palette. A color reference is
`{family}-{shade}`, plus the three keywords `white`, `black`, `transparent`.

**Families:** `slate`, `gray`, `zinc`, `red`, `orange`, `amber`, `yellow`,
`green`, `emerald`, `teal`, `cyan`, `sky`, `blue`, `indigo`, `violet`, `purple`,
`fuchsia`, `pink`, `rose`.

**Shades:** `50`, `100`, `200`, `300`, `400`, `500`, `600`, `700`, `800`,
`900`, `950`.

Colors are consumed through these prefixes:

| Prefix | Applies to | Example |
|---|---|---|
| `bg-{color}` | background fill | `bg-slate-800`, `bg-white` |
| `text-{color}` | text color | `text-emerald-400` |
| `border-{color}` | border color (also sets a 1px border) | `border-slate-600` |
| `from-{color}` | gradient start stop | `from-sky-500` |
| `to-{color}` | gradient end stop | `to-blue-700` |

An unrecognized family or shade (e.g. `bg-slate-999`, `text-brand-500`) does not
parse, so the whole literal is ignored.

## Flex

| Utility | Effect |
|---|---|
| `flex` | `display: flex` |
| `flex-row` | main axis = row |
| `flex-col` | main axis = column |
| `flex-wrap` | allow wrapping |
| `flex-1` | `grow: 1`, `shrink: 1`, `basis: 0` |
| `grow` | `flex-grow: 1` |
| `grow-0` | `flex-grow: 0` |
| `shrink-0` | `flex-shrink: 0` |
| `basis-N` | flex basis (spacing scale) |
| `gap-N` | gap between children (spacing scale) |
| `justify-start` \| `-center` \| `-end` \| `-between` \| `-around` | main-axis distribution |
| `items-start` \| `-center` \| `-end` \| `-stretch` | cross-axis alignment |

Only the five `justify-*` and four `items-*` values above exist (no
`justify-evenly`, no `items-baseline`).

## Box & position

| Utility | Effect |
|---|---|
| `w-N` \| `w-full` \| `w-[px]` | width (spacing, full, or arbitrary px) |
| `h-N` \| `h-full` \| `h-[px]` | height |
| `min-w-N`, `min-h-N`, `max-w-N`, `max-h-N` | min/max size (spacing or arbitrary px) |
| `p-N`, `px-N`, `py-N`, `pt-N`, `pr-N`, `pb-N`, `pl-N` | padding |
| `m-N`, `mx-N`, `my-N`, `mt-N`, `mr-N`, `mb-N`, `ml-N` | margin |
| `absolute` | `position: absolute` |
| `relative` | `position: relative` |
| `inset-N`, `top-N`, `right-N`, `bottom-N`, `left-N` | position offsets (spacing or arbitrary px) |
| `hidden` | `display: none` |
| `overflow-hidden` | clip children (native scissor) |
| `z-N` | z-index (plain integer) |

`w-full` / `h-full` are the only percentage-style sizes. `min-*` / `max-*` do
**not** accept `-full`. The padding/margin/inset families take the spacing scale
or arbitrary px; `p-N` and `m-N` fan out to all four sides, `px`/`py` and
`mx`/`my` to the two axes.

## Visual

| Utility | Effect |
|---|---|
| `bg-{color}` | background color |
| `bg-gradient-to-t` \| `-b` \| `-l` \| `-r` | gradient direction (top / bottom / left / right) |
| `from-{color}` | gradient start color |
| `to-{color}` | gradient end color |
| `rounded` | 4px corner radius |
| `rounded-sm` | 2px |
| `rounded-md` | 6px |
| `rounded-lg` | 8px |
| `rounded-xl` | 12px |
| `rounded-full` | pill/circle — **build-time size required** (see below) |
| `opacity-N` | opacity, `N/100` (0–100) |
| `shadow` | small shadow |
| `shadow-md` | medium shadow |
| `shadow-lg` | large shadow |
| `border` | 1px border (width only) |
| `border-{color}` | border color **and** a 1px border |

Gradients only run along the four cardinal directions (no diagonals). Set a
direction with `bg-gradient-to-*` and the stops with `from-*` / `to-*`:

```tsx
<View class="bg-gradient-to-b from-sky-500 to-blue-700 w-full h-16" />
```

**Border width** is fixed at 1px. `border-2`, `border-4`, etc. do not exist —
only bare `border` and `border-{color}`.

**Only three shadow steps** exist: `shadow`, `shadow-md`, `shadow-lg`.

### `rounded-full`

`rounded-full` bakes an exact radius at build time, so it needs the node's width
and height to be **build-time known** in the *same* literal via `w-N`/`h-N` (or
arbitrary px `w-[px]`/`h-[px]`). The radius becomes `min(w, h) / 2`.

```tsx
{/* OK — concrete w/h, radius baked to 24px */}
<View class="w-12 h-12 rounded-full bg-rose-500" />

{/* Compile error — w-full is not a build-time pixel size */}
<View class="w-full h-12 rounded-full" />
```

Using `rounded-full` without a concrete `w-N` and `h-N` is a **hard compile
error**, not a silent drop.

## Text

| Utility | Effect |
|---|---|
| `text-{color}` | text color |
| `text-xs` | 12px |
| `text-sm` | 14px |
| `text-base` | 16px (default) |
| `text-lg` | 18px |
| `text-xl` | 20px |
| `text-2xl` | 24px |
| `text-4xl` | 36px |
| `font-bold` | bold weight (baked bold atlas) |
| `text-left` \| `text-center` \| `text-right` | horizontal alignment |
| `leading-N` | line height (spacing scale or arbitrary px) |
| `tracking-wide` | letter spacing = `0.025 × font-size` |

Font sizes are **baked into atlases** at build time, so only the seven sizes
above exist: **12 / 14 / 16 / 18 / 20 / 24 / 36 px**. There is no `text-3xl`,
`text-5xl`, etc. Each size ships in two weights (regular and, when `font-bold`
is used, bold). Text with no size/weight utility inherits the 16px regular
default.

Only `font-bold` exists for weight (no `font-normal` / `font-semibold`), and
only `tracking-wide` for tracking.

## Transform

Transforms are animatable and do **not** trigger relayout — prefer them for
motion.

| Utility | Effect |
|---|---|
| `translate-x-N` | translate X (spacing scale or arbitrary px) |
| `translate-y-N` | translate Y (spacing scale or arbitrary px) |
| `scale-N` | uniform scale, `N/100` (e.g. `scale-105` → 1.05) |
| `scale-x-N` | X scale, `N/100` |
| `scale-y-N` | Y scale, `N/100` |
| `rotate-N` | rotation in degrees (e.g. `rotate-45`) |
| `rotate-x-[N]` | 3D rotation about X, degrees (bracket-only, negatives ok) |
| `rotate-y-[N]` | 3D rotation about Y, degrees (bracket-only, negatives ok) |
| `translate-z-[N]` | 3D depth translation, px (bracket-only, negatives ok) |
| `perspective-[N]` | makes the node a 3D context root; distance in px |

`scale-*` and `rotate-*` take plain numbers only (no bracket syntax, no
negatives); the 3D utilities are bracket-only. A `perspective-[N]` root
projects its subtree through that distance and painter-sorts the result —
see [Animation → 3D transforms](/docs/animation/#3d-transforms).

## Arc

`arc-*` strokes a round-capped annular sector from the node's background
color — a native stroke-arc primitive (all three animatable via timelines
and `animate()`):

| Utility | Effect |
|---|---|
| `arc-start-[N]` | start angle, degrees |
| `arc-sweep-[N]` | sweep angle, degrees |
| `arc-width-[N]` | stroke width, px |

## Motion / transition

Adding any motion token to a literal attaches a transition block to that style.
Transitions fire when the style is swapped (for example on `focus:` / `active:`)
and interpolate the animatable properties in the mask.

| Utility | Effect |
|---|---|
| `transition` | animate colors, opacity, and transforms |
| `transition-all` | animate all animatable properties |
| `transition-colors` | animate bg / text / border / gradient colors |
| `transition-opacity` | animate opacity |
| `transition-transform` | animate translate / scale / rotate (2D only — 3D/arc props exceed the u32 transition mask; use timelines or `animate()`) |
| `animate-<name>` | apply a baked keyframe timeline from `theme.animation` (built-ins: `spin`, `ping`, `pulse`, `bounce`) |
| `animate-loop-[Nms]` \| `[Ns]` | whole-choreography loop period (needs `animate-<name>` in the same literal) |
| `duration-N` | duration in ms (0–65535) |
| `delay-N` | delay in ms (0–65535) |
| `ease-linear` \| `-in` \| `-out` \| `-in-out` \| `-spring` \| `-out-back` | easing curve |

`duration-N` and `delay-N` are plain millisecond values (bare numbers). `spring`
and `out-back` are PocketJS additions beyond the standard Tailwind easings.

**Defaults.** When a literal contains any motion token, unspecified fields fall
back to: duration **150ms**, delay **0ms**, easing **in-out**. The property mask
defaults to *all* animatable properties **unless** you used the bare
`transition` shorthand (which is limited to colors + opacity + transforms). So
`duration-200 ease-out` on its own still animates every animatable property.

```tsx
<View class="bg-slate-700 transition-colors duration-200 focus:bg-slate-500" />
```

## Variants

Two state variants are supported. They compile into separate blocks of the same
style record and are switched **natively** — no JS runs on focus change.

| Variant | Applies when |
|---|---|
| `focus:` | the node is the focused node |
| `active:` | the node is pressed/active |

```tsx
<View class="bg-slate-700 border-slate-600
             focus:bg-slate-600 focus:border-blue-500
             active:scale-95 transition" />
```

Any utility can be prefixed. Motion tokens (`transition*`, `duration`, `delay`,
`ease`) apply to the whole record and are only recognized on the base variant,
not behind `focus:` / `active:`.

## Not supported (loud errors)

These are rejected loudly at build/dev time, not silently dropped:

| Construct | Why |
|---|---|
| `classList={{…}}` | dynamic class objects are not supported; the renderer raises a dev error |
| Template-interpolated class fragments (e.g. `` class={`p-${n}`} ``) | classes must be static literals so they can be collected and baked at build time |
| `hover:` | the PSP has no pointer — using `hover:` in an otherwise-valid literal is a hard compile error; use `focus:` / `active:` |
| `rounded-full` without build-time `w-N`/`h-N` | the radius must be bakeable at build time |

For dynamic styling, use one of:

- **Ternaries of complete literals** — swap whole class strings, e.g.
  `class={ok() ? "bg-green-600" : "bg-red-600"}`.
- **`style={{…}}` objects** — per-key dynamic props applied at runtime.
- **`animate()`** — imperative property animation (see
  [/docs/animation/](/docs/animation/)).

See also [/docs/styling/](/docs/styling/) for the styling model overview and
[/docs/components/](/docs/components/) for the primitives that accept `class`.
