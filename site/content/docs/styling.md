# Styling

PocketJS styling is a **build-time Tailwind subset**. The classes you write are
not CSS: at build time the compiler parses each class literal, turns it into a
binary style record, and packs the whole table into `styles.bin` inside your
app's `.pak`. At runtime the renderer looks a class attribute up **verbatim**,
gets back a numeric `styleId`, and hands that to the Rust core via `setStyle`.

There is **zero runtime CSS**: no CSS parser, no cascade, no string matching on
the device. A class is just an integer index into a table that was resolved and
frozen at build time.

This page covers the model and the rules. The exhaustive list of supported
utilities lives on [/docs/tailwind/](/docs/tailwind/); motion utilities
(`transition-*`, `duration-*`, `ease-*`, `delay-*`) are covered on
[/docs/animation/](/docs/animation/).

## The pipeline

The Tailwind compiler runs in pass 1 of `bun tools/build.ts <app>` (see
[/docs/build-pipeline/](/docs/build-pipeline/)):

1. The babel pass collects **candidate class strings** from the AST — every
   string literal, every template-literal quasi, and every chunk of JSX text.
2. `framework/compiler/tailwind.ts` tries to parse each candidate. The ones that parse
   become style records; identical records are deduplicated to a single
   `styleId`.
3. The records are encoded to `styles.bin` and a generated `styles.generated.ts`
   module (`STYLE_IDS`: the class-literal → `styleId` map, plus the font-slot
   metadata) that the renderer imports.

`styles.bin` is shipped in the `.pak`. On PSP the native pak walker feeds it
straight into the core; on the browser and headless Bun hosts it is loaded
through the `loadStyles` op ([/docs/native-contract/](/docs/native-contract/)).

## The all-or-nothing rule

The compiler sees *every* string literal in your source, not just `class`
attributes — so it needs a rule for deciding which strings are actually styles.
That rule is strict:

> A class literal compiles to a style record **if and only if every
> whitespace-separated token is a supported utility.** If any token is not a
> utility, the whole literal is treated as ordinary text and ignored.

```tsx
"flex-col items-center gap-4 p-4"   // every token is a utility -> style record
"Ready to play"                     // no token is a utility   -> plain text
"flex the muscles"                  // one bad token ("the")   -> ignored entirely
```

This is why a label like `"flex the muscles"` never accidentally becomes a
layout: a single unrecognized token disqualifies the whole literal. The flip
side is that a class attribute must be a **literal the compiler can see** — the
renderer resolves it by exact string match against `STYLE_IDS`.

## Utilities at a glance

Utilities use Tailwind's default value scales.

| Group | Examples |
|---|---|
| Layout | `flex`, `flex-row`, `flex-col`, `justify-center`, `items-start`, `gap-4`, `grow`, `shrink-0`, `flex-1`, `flex-wrap` |
| Box | `w-12`, `h-full`, `min-w-4`, `max-h-40`, `p-2`, `px-4`, `mt-2`, `absolute`, `inset-0`, `hidden`, `overflow-hidden`, `z-10` |
| Visual | `bg-blue-600`, `bg-gradient-to-b`, `from-slate-800`, `to-slate-950`, `rounded-md`, `opacity-50`, `shadow-lg`, `border`, `border-slate-700` |
| Text | `text-slate-50`, `text-xl`, `font-bold`, `text-center`, `leading-6`, `tracking-wide` |
| Transform | `translate-x-2`, `scale-95`, `rotate-45`, `rotate-y-[35]`, `translate-z-[-40]`, `perspective-[800]` |
| Arc | `arc-start-[45]`, `arc-sweep-[315]`, `arc-width-[5]` |
| Motion | `transition-colors`, `duration-150`, `ease-out`, `animate-spin`, `animate-menu-pill`, `animate-loop-[4s]` |

**Spacing scale.** Numeric spacing follows Tailwind: `N` means `N * 4` px, so
`p-2` is 8px and `gap-4` is 16px.

**Arbitrary pixels.** Size and spacing utilities also accept an arbitrary pixel
value in brackets: `w-[123]`, `w-[123px]`, `p-[10px]`, `top-[6px]`,
`min-w-[200px]`.

**Colors.** The full Tailwind v3 default palette is available — families `slate`
through `rose`, shades `50`–`950` (`bg-slate-900`, `text-blue-400`), plus
`white`, `black`, and `transparent`.

See [/docs/tailwind/](/docs/tailwind/) for the complete, authoritative list.

## Text sizes bake fonts

Text-size utilities do more than set a number — they select a **baked font
atlas slot**. The supported sizes map to fixed baked pixel sizes:

| Utility | Baked px |
|---|---|
| `text-xs` | 12 |
| `text-sm` | 14 |
| `text-base` | 16 |
| `text-lg` | 18 |
| `text-xl` | 20 |
| `text-2xl` | 24 |
| `text-4xl` | 36 |

`font-bold` selects the bold weight of the same size. Text with no text-size or
weight utility uses the default slot: **16px regular**. Because sizes are baked,
the set of sizes is fixed — there is no arbitrary font size.

## Dynamic styling

Styles are frozen at build time, so you cannot build a class string at runtime.
There are exactly three ways to make styling dynamic:

**1. Ternaries of full class literals.** Both branches must be complete literals
the compiler can see:

```tsx
import { View } from "@pocketjs/framework/components";
import { createSignal } from "solid-js";

const [armed, setArmed] = createSignal(false);

<View class={armed() ? "p-2 bg-red-500" : "p-2 bg-slate-700"} />;
```

Each branch is compiled independently; the renderer swaps the resolved `styleId`
when the signal changes (which also triggers any transitions on the new record).

**2. `style={{ ... }}` objects.** An inline style object sets individual style
properties at runtime, bypassing the class table. Each key is diffed against the
previous frame and pushed as a single `setProp`. Use this for values you cannot
know at build time.

**3. `animate()`.** Declarative motion driven natively per vblank — see
[/docs/animation/](/docs/animation/).

## Variants: `focus:` and `active:`

`focus:` and `active:` are folded into the **same** style record as a separate
variant block. When focus or the active state changes, the Rust core switches to
the matching variant natively — **zero JS runs on the state change**.

```tsx
<View
  class="p-2 rounded-md bg-blue-600 focus:bg-blue-500 active:scale-95 transition-colors duration-150"
  focusable
  onPress={() => {}}
/>;
```

Here `focus:bg-blue-500` and `active:scale-95` live in the same record as the
base styles. Setting focus (`setFocus`) or pressing the node applies the variant
without touching JavaScript or reconciling the tree. See
[/docs/input-focus/](/docs/input-focus/) for how focus moves.

## `rounded-full` needs a known size

`rounded-full` bakes an exact pixel radius at build time, so the compiler must be
able to compute it. That means the **same literal** must pin both `w-N` and
`h-N` (or their arbitrary-pixel forms); the radius becomes `min(w, h) / 2`:

```tsx
<View class="w-12 h-12 rounded-full bg-slate-700" />   // ok: radius baked to 24px
```

If `rounded-full` appears in an otherwise-valid literal without a build-time
width and height, it is a **loud compile error** — not a silent drop:

```tsx
<View class="rounded-full bg-slate-700" />             // compile error
```

```
PocketJS tailwind: `rounded-full` needs build-time known size — add w-N and h-N
to the same literal
```

`rounded-full` on runtime-sized nodes is explicitly out of scope for v1.

## Loud errors

Three patterns look like styling but are not supported. Rather than silently do
nothing, they fail the build with a code frame:

| Pattern | Why it fails | Do this instead |
|---|---|---|
| `classList={{ ... }}` | Not supported in v1 | Ternary of full literals |
| ``class={`a ${b}`}`` (template-interpolated) | Styles resolve at build time; a fragment isn't a literal | Ternary of full literals |
| `hover:...` | The PSP has no pointer | Use `focus:` / `active:` |

```tsx
// All three throw at build time:
<View classList={{ "bg-red-500": armed() }} />;
<View class={`p-2 ${bg}`} />;
<View class="p-2 hover:bg-blue-500" />;
```

The `classList` and template-interpolation errors are raised by the babel pass;
`hover:` is raised by the Tailwind compiler once it confirms every other token in
the literal is valid. (A stray word like `"hover over here"` is just text — it
only errors when it genuinely parses as a `hover:` variant on an otherwise-valid
class literal.)

## Token order does not matter

Within a literal, declarations are deduplicated **last-wins** (a later token
overrides an earlier one for the same property) and then sorted into a canonical
order by property id. Two literals with the same tokens in a different order
compile to **byte-identical** records and therefore share one `styleId`:

```tsx
"p-2 bg-red-500"   // same style record...
"bg-red-500 p-2"   // ...and the same styleId
```

Because records are deduplicated across your whole app, writing the same set of
utilities in many places costs one entry in `styles.bin`, not one per call site.

## See also

- [/docs/tailwind/](/docs/tailwind/) — the complete supported-utility reference
- [/docs/animation/](/docs/animation/) — `transition-*` and `animate()`
- [/docs/build-pipeline/](/docs/build-pipeline/) — how `styles.bin` is built
- [/docs/native-contract/](/docs/native-contract/) — `setStyle`, `setProp`, `setFocus`
- Try classes live in the [playground](/playground/)
