# Pocket Vapor

**Vue Vapor, compiled all the way down.** You write a component in a strict
TypeScript subset of Vue Vapor — real `ref`/`computed`, real JSX — and the
Pocket Vapor compiler emits native ARM for the Game Boy Advance: no
JavaScript engine, no GC, no allocator. Vue Vapor compiles the virtual DOM
away; Pocket Vapor compiles the JavaScript engine away.

| | |
|---|---|
| ![boot](docs/todo-boot.png) | ![edit](docs/todo-edit.png) |

The proof is [`examples/todo/todo.tsx`](examples/todo/todo.tsx) — TodoMVC
with filters, a computed remaining-count, windowed scrolling and a glyph
editor. The **same file** runs two ways:

- **Oracle**: unmodified on `vue@3.6` `runtime-with-vapor` (through the
  repo's vue-jsx-vapor pipeline) over a micro-DOM, in bun.
- **Device**: compiled to C by `compiler/compile.ts`, linked against a
  ~9 KB runtime, running on an ARM7TDMI at 16.8 MHz.

The parity suite drives one tape of button presses through both and
compares the rendered 30×20 cell grid — characters *and* palettes —
cell-for-cell after every press.

```
$ bun test vapor/test/
 26 pass, 0 fail, 1352 expect() calls

$ bun vapor/compiler/cli.ts vapor/examples/todo/todo.tsx
== reactive graph ==
refs:      todos cursor filter editing draft glyph      (6 dirty bits)
computeds: filtered remaining current scroll visible    (masks inferred)
effects:   eff_0 rows [1,2)   mask {todos, filter}
           eff_1 rows [3,15)  mask {todos, cursor, filter}
           eff_2 rows [17,18) mask {editing, draft, glyph}
           eff_3 rows [19,20) mask {editing}
== memory plan ==
state RAM: 41 B scalars/strings + 833 B pools + 66 B computed views
dist/vapor/todo.gba  (9.1 KB)
```

The business logic is keymaps, not branch ladders — and the compiler meets
the style: each named action becomes one C function, each keymap becomes a
10-slot function-pointer table in ROM, and the dispatch line becomes a
bounds-checked indexed call:

```tsx
const listKeys: Keymap = {
  [Button.Up]: () => moveCursor(-1),
  [Button.Down]: () => moveCursor(1),
  [Button.A]: toggleDone,
  [Button.B]: deleteCurrent,
  [Button.R]: cycleFilter,
  [Button.Select]: clearDone,
  [Button.Start]: openEditor,
};

onButton((b) => (editing.value ? editKeys : listKeys)[b]?.());
```

Deleting is `todos.value = todos.value.filter((x) => x !== t)` (compiled to
in-place pool compaction), and the selected todo is itself a computed —
`const current = computed(() => filtered.value[cursor.value])` — cached as
a nullable record pointer with the same validity-bit laziness as any other
computed.

The view is semantic components, not raw rows — real vapor functional
components under the oracle, **inlined to zero-cost paint code** by the
compiler (props substitute at the AST level, so const folding, dependency
masks and row spans all see through; six components add zero effects and
zero RAM):

```tsx
function TodoRow(props: { line: number; todo: Todo; selected: boolean }) { … }

<TitleBar line={0} text="POCKET VAPOR TODO" />
<StatusBar line={1} count={remaining.value} label={FILTERS[filter.value]} />
{visible.value.map((t, i) => (
  <TodoRow line={LIST_Y + i} todo={t} selected={t === current.value} />
))}
{editing.value ? <EditorBar line={17} draft={draft.value} glyph={GLYPHS[glyph.value]} /> : null}
```

Reactivity survives compilation as data: every ref is a dirty bit, every
dependency edge is a bitmask baked into ROM, computeds are lazy cached
functions with validity bits, and template bindings are paint effects that
run only when their mask intersects the dirty word. Pressing a button that
changes nothing costs zero repaints; pressing ↑ repaints only the list
block. See [DESIGN.md](DESIGN.md) for the whole argument, including where
it deliberately over-approximates Vue (static dependency analysis).

## Commands

```sh
bun vapor/compiler/cli.ts vapor/examples/todo/todo.tsx   # compile → dist/vapor/todo.gba
bun vapor/scripts/play.ts                                 # build + open in mGBA
bun vapor/scripts/shot.ts                                 # bake docs screenshots
bun test vapor/test/                                      # oracle + compiler + parity
```

Needs `arm-none-eabi-gcc` and `mgba` (Homebrew) for the device half; the
oracle tests run with bun alone.

## Layout

```
vapor/
  DESIGN.md            the thesis + the subset definition
  examples/todo/       todo.tsx — the dual-execution demo app
  host/input.ts        Button + onButton (oracle impl / compiler contract)
  oracle/              micro-DOM + grid painter + bundle boot (real vue)
  compiler/            compile.ts (TS AST → C), rom.ts (toolchain), cli.ts
  runtime/gba/         vapor.h contract, vapor_gba.c runtime, crt0.s, gba.ld
  test/                compiler.test.ts, oracle.test.ts, parity.test.ts
  test/harness/        headless libmgba scenario runner
```
