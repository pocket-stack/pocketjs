# Pocket Vapor — design

**Pocket Vapor** (`@pocketjs/vapor`) is the ahead-of-time Vue compiler of the
Pocket family: you write a component in a **strict TypeScript subset of Vue
Vapor** — real `ref`/`computed` reactivity, real JSX templates — and the
compiler emits native code for machines that could never host a JavaScript
engine. The proof target is the Game Boy Advance: 16.8 MHz ARM7TDMI, 256 KB
of work RAM, no OS, no allocator, no GC.

Vue Vapor's thesis is *compile the virtual DOM away*. Pocket Vapor extends
it one machine layer down: **compile the JavaScript engine away.** The
component keeps Vue's authoring model and update semantics; the runtime that
ships is a few kilobytes of C — a dirty-bit scheduler, an arena, and a block
tree — not an interpreter.

## 1. Why not another DSL

Two prior Pocket experiments (`@pocketjs/aot`, then Pocket Static) compiled
games for retro consoles by carving TypeScript down to a bespoke DSL:
declaration builders plus generator scripts lowered to bytecode for a ~600
line stack VM. They work, but the author is always aware they are writing
the DSL, not the framework: no shared reactivity model, no component tree,
nothing transfers to or from real app code.

Pocket Vapor inverts the contract. The input is not a DSL that resembles
TypeScript; it is **Vue Vapor code that happens to obey a subset**. The
subset is enforced by the compiler with file:line errors, and membership has
an operational definition:

> Every Pocket Vapor component must also run, unmodified, under the real
> `@vue/runtime-vapor` on a JS host. The E2E suite executes both — the real
> Vue build as the oracle, the compiled ROM in an emulator — drives the same
> input script into each, and asserts the same rendered screen.

That is the MicroPython positioning: MicroPython is not a Python-flavored
DSL, it is a subset of Python with an implementation sized for
microcontrollers. Pocket Vapor is that, for Vue.

## 2. The one idea: reactivity as a compile-time artifact

A Vue component's reactive graph — which bindings read which refs — is
almost always statically evident in the source. Vapor already exploits this
shape at the template level; Pocket Vapor exploits it at the memory level.

The compiler builds the whole graph at build time:

- every `ref()` / `computed()` in setup becomes a **slot** in one statically
  sized state struct (no boxing, no heap);
- every dynamic template binding becomes an **effect function** in ROM;
- every dependency edge becomes a bit in a **subscriber bitmask** in ROM.

At runtime, writing `count.value = n` through a generated setter marks a
dirty bit and clears the validity bits of every computed whose (compile-time)
dependency mask includes that ref. Once per frame (Vue's batched-scheduler
semantics, with vblank as the microtask boundary) the flush runs each effect
whose mask intersects the dirty word; computeds recompute lazily through
generated accessors, exactly like Vue's `computed` — including inside event
handlers that read a computed between two mutations. Dependency *tracking* —
the expensive, allocating part of any reactive runtime — has no runtime
existence at all.

Where a dependency is conditional (`flag.value ? a.value : b.value`), the
compiler over-approximates: the effect subscribes to all refs it *may* read.
An over-approximated effect can only re-run redundantly — it renders the
same value it would have — so Vue's observable semantics are preserved; the
graph is a superset, never a subset. This is the one deliberate divergence
from Vue's dynamic dependency collection, and the E2E oracle keeps it
honest.

## 3. Memory: arenas, not GC

The runtime never calls `malloc` and never frees:

- **Static plan** — refs, computed caches, effect tables: fixed-size, laid
  out by the compiler. The compiler prints the memory plan (bytes of state,
  bytes of ROM tables) as part of the build.
- **Typed pools as arenas** — a `ref<T[]>` compiles to a fixed-capacity
  contiguous pool of inline `T` records; `push`/`splice` become pool ops
  (append / shift-down), and string fields are bounded byte arrays living
  inside their record. Exceeding a budget drops the operation and raises a
  tripwire flag the debug block exposes — never UB.
- **Bounded strings** — a `ref<string>` is a `{len, bytes[24]}` slot;
  string expressions build into stack scratch and assign through a
  change-compare (Vue's `Object.is` set gate, by value).

Nothing is ever collected because nothing is ever untracked: object shapes
are closed (the TS subset forbids dynamic keys), so lifetime is the pool
slot's lifetime. This is the "arena instead of GC" bet: for the UI workloads
these devices run, *ownership is structural* — state lives exactly as long
as the component or the collection entry that declares it.

## 4. The subset (v1)

Enforced with diagnostics, not documentation. In:

- `ref<number>`, `ref<boolean>`, `ref<string>`, `ref<T[]>` of a closed
  interface `T` with number/boolean/string fields; `computed<...>` of pure
  expressions over those.
- Component = `setup()` returning a JSX render closure. One root component
  (v1: no props, no child components — the block machinery supports them,
  the demo doesn't need them).
- JSX: the Pocket host vocabulary (§5) with text interpolation
  `{expr}`, conditional attributes, list rendering via `.map()` over a
  `ref<T[]>` (compiled to a keyed list block), event handlers referencing
  setup-scope functions.
- Statements in setup functions: `let/const`, assignment and compound
  assignment, `if/else`, `for`/`while`, early `return`; expressions:
  arithmetic/comparison/logical ops, template literals, method subset on
  arrays (`push`, `splice`, `filter`, `map`, `find`, `length`) and strings
  (`slice`, `length`, concatenation).
- Numbers are 32-bit signed integers on the device. Fractional literals and
  `/` results are a compile error unless annotated — the demo needs none.

Out (compile errors): closures escaping setup, dynamic property access,
`any`, exceptions, async, classes, prototype anything, recursion in render,
`reactive()` deep proxies (v1 is `ref`-first; `reactive` is sugar the
compiler can add later).

## 5. Host vocabulary and rendering

The GBA presents a 30×20 cell text screen (mode 0, one background) driven
by the same public-domain 8×8 ASCII font Pocket Static bakes. The JSX
vocabulary is deliberately one intrinsic with two interpreters — the C cell
grid on device, and a ~60-line tree walker over the oracle's micro-DOM:

- `<row y={n} x={n} pal={p}>` — paints its text children at (x, y) in
  palette `p`, padded with spaces to the right edge; later rows overwrite
  earlier ones (document order).
- Children are string literals and `{expr}` interpolations (numbers,
  strings, chars, ternaries of literals).
- Lists are plain Vue: `{view.value.map((t, i) => <row y={BASE + i} …/>)}`.
  The compiler turns the whole map into one paint loop; the oracle lets
  vapor's own reactive block machinery re-render it.
- Conditional rows are plain Vue too: `{cond ? <row …/> : null}`.
- Palettes express selection/done/dim states (GBA: BG palette banks; the
  oracle asserts them as a per-cell palette grid).

Input is not DOM events: the host module exposes
`onButton((b: Button) => void)` (frame-latched edge triggering, GBA
KEYINPUT bit order). Under the oracle the module executes and the test tape
feeds it; under the compiler the import is recognized and the handler
compiles to a C function fed by the runtime's key-edge loop.

## 6. Pipeline

```
todo.tsx ─┬─ compiler/jsx-plugin.ts + vue-jsx-vapor ──► real Vue Vapor app (oracle)
          │
          └─ vapor/compiler/compile.ts (Bun, TS compiler API)
               1 subset check      diagnostics with file:line
               2 setup analysis    refs/computeds/functions/handler → slots + C fns
               3 template analysis JSX → static rows + effects + map loops
               4 graph build       reads → transitive ref deps → bitmasks
               5 span merge        overlapping row spans fuse into one effect
               6 memory plan       slots, pools, budgets (printed with the graph)
               7 emit C            gen_app.c (state, computeds, effects, handler)
               8 cc + link         arm-none-eabi-gcc -Os + vapor/runtime/gba/*
                                   → header-patched .gba ROM (compiler/rom.ts)
```

The fixed C runtime (`vapor/runtime/gba/`) is shared by all apps:
`vapor.h` (the contract both sides compile against), `vapor_gba.c` (cell
grid with per-cell diff + row-dirty VRAM commit, bounded strings, input
edges, vblank loop, debug block), and `crt0.s`/`gba.ld` — the startup and
header-patch lineage carried over from Pocket Static's GBA target.

## 7. E2E: the oracle is real Vue

`vapor/test/`:

1. **Compiler unit tests** (`compiler.test.ts`) — subset diagnostics with
   file:line, deterministic C output, dependency-mask assertions on the
   reactive graph.
2. **Oracle tests** (`oracle.test.ts`) — the app's behavior pinned on real
   `vue@3.6` runtime-with-vapor over the micro-DOM: filters, toggles,
   editing, clamping, the empty state.
3. **Oracle ↔ ROM parity** (`parity.test.ts`) — one tape of button presses
   drives both the oracle and the real `.gba` in headless libmgba; after
   every press the 30×20 grid (chars *and* palettes) is compared
   cell-for-cell, read from a debug block the runtime mirrors to EWRAM each
   frame (magic `PVDB`, frame counter, reactive state snapshot, tripwires,
   the full cell grid).

Layer 3 is the claim of the whole project: same file, real Vue on a JS
engine, native code on a 2001 handheld, cell-identical output — proven for
every step of the interaction, not just the final frame.

## 8. The demo — VAPOR TODO

`vapor/examples/todo/todo.tsx` — TodoMVC, GBA-idiomatic:

- List mode: ↑/↓ cursor, A toggle done, B delete, R cycles filter
  (ALL/ACTIVE/DONE — a `computed` filtered view), SELECT clears completed,
  START opens the editor.
- Edit mode: ←/→ scrub the glyph picker, A commits a glyph, B backspaces,
  START commits the todo (`todos.value.push(...)` into the pool).
- Header shows `{remaining.value} LEFT` (a `computed`); footer shows mode
  keys. Done rows render dim with a filled checkbox.

State: 6 refs, 4 computeds (two of them list views), 4 span-merged paint
effects, a 32-entry todo pool. The compiler's memory plan for the whole app
is ~940 bytes of RAM; the finished cartridge is under 9 KB — which is the
point.

## 9. Out of scope v1 (explicit)

Components-with-props and slots (block machinery is shaped for them; not
demoed), `reactive()`/`watch()` sugar, floats/fixed-point, CJK text, sound,
saves, GB/NES backends (the block runtime is portable C by construction;
only the HAL and budgets differ), real-hardware verification (headers are
flashcart-correct; emulator-only in CI).
