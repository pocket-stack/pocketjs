# Pocket Vapor

**Vue Vapor, compiled all the way down.** You write a component in a strict
TypeScript subset of Vue Vapor — real `ref`/`computed`, real JSX — and the
Pocket Vapor compiler emits native code for consoles that could never host
a JavaScript engine: **ARM7 on the Game Boy Advance, SM83 on the Game Boy,
6502 on the NES**. No JS engine, no GC, no allocator. Vue Vapor compiles
the virtual DOM away; Pocket Vapor compiles the JavaScript engine away.

| GBA (arm-none-eabi-gcc) | GBA edit mode |
|---|---|
| ![boot](docs/todo-boot.png) | ![edit](docs/todo-edit.png) |

| Game Boy (sdcc, 20x18) | NES (cc65, 22x18) |
|---|---|
| ![gb](docs/todo-gb.png) | ![nes](docs/todo-nes.png) |

One component file, four executions: the oracle on real vue 3.6, and three
cartridges. Screen geometry is a compile-time constant (`SCREEN.width`/
`SCREEN.height` from the host module): layout math and width ternaries fold
per target, so the narrow help strings on GB/NES cost zero bytes on GBA —
compile-time responsive UI.

The proof is [`examples/todo/todo.tsx`](examples/todo/todo.tsx) — TodoMVC
with filters, a computed remaining-count, windowed scrolling and a glyph
editor. The **same file** runs two ways:

- **Oracle**: unmodified on `vue@3.6` `runtime-with-vapor` (through the
  repo's vue-jsx-vapor pipeline) over a micro-DOM, in bun.
- **Device**: compiled to C by `framework/compiler/compile.ts`, linked against a
  ~9 KB runtime, running on an ARM7TDMI at 16.8 MHz.

The parity suite drives one tape of button presses through both and
compares the rendered 30×20 cell grid — characters *and* palettes —
cell-for-cell after every press.

```
$ bun test vapor/tests/
 30 pass, 0 fail, 3658 expect() calls   # incl. 3-console per-press parity

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
block. See [docs/DESIGN.md](docs/DESIGN.md) for the whole argument, including where
it deliberately over-approximates Vue (static dependency analysis).

## Commands

```sh
bun vapor/compiler/cli.ts vapor/examples/todo/todo.tsx                 # → dist/vapor/todo.gba
bun vapor/compiler/cli.ts vapor/examples/todo/todo.tsx --target gb     # → todo.gb  (32 KB)
bun vapor/compiler/cli.ts vapor/examples/todo/todo.tsx --target nes    # → todo.nes (40 KB)
bun vapor/scripts/play.ts                                 # build + open in mGBA
bun vapor/scripts/shot.ts                                 # bake docs screenshots
bun test vapor/tests/                                      # oracle + compiler + 3-console parity
```

Toolchains: `arm-none-eabi-gcc` + `mgba` (GBA/GB), `sdcc` + `rgbfix` (GB),
`cc65` (NES, emulated by the jsnes dev-dependency). Oracle tests run with
bun alone. Notable per-console facts the runtime absorbs: the shadow grid
IS the debug block (fixed WRAM/CPU-RAM addresses), so the harness reads the
logical screen even while a 1 MHz SM83 trickles VRAM through vblank; DMG
has one palette, so logical palettes map to baked glyph styles; NES fits
grid + pool + views into 2 KB of CPU RAM with the font in CHR-ROM; and
sdcc 4.6's SM83 port miscompiles some u8-by-u8 multiplies, so generated
indexing is u16 pointer arithmetic and bit masks come from a ROM table.

## Layout

```
vapor/
  docs/DESIGN.md            the thesis + the subset definition + target table
  examples/todo/       todo.tsx — the multi-console demo app
  host/                input.ts (Button/onButton), screen.ts (SCREEN geometry)
  oracle/              micro-DOM + grid painter + bundle boot (real vue)
  framework/compiler/            compile.ts (TS AST → C, per-target), rom.ts (3 toolchains), cli.ts
  runtime/             vapor.h contract + vapor_core.c (shared grid/strings)
  runtime/gba|gb|nes/  per-console halves: crt0, video commit, input, debug block
  tests/                compiler.test.ts, oracle.test.ts, parity.test.ts (3 consoles)
  tests/harness/        headless libmgba runner (GBA+GB) + jsnes runner (NES)
```
