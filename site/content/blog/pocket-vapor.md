<video class="w-full rounded-xl border border-line" src="/assets/pocket-vapor-promo.mp4" poster="/assets/blog/pocket-vapor-promo-poster.jpg" controls playsinline preload="metadata"></video>

<p class="text-sm text-slate-500 -mt-4">The 47-second tour: a real Vue component, compiled to three consoles, running the same inputs in lockstep. Sound on; the chiptune is synthesized by the same repo that builds the ROMs.</p>

<img class="w-full rounded-xl border border-line" src="/assets/blog/vapor-gba-edit.png" alt="A Game Boy Advance screen running a todo app: an emerald title bar reading POCKET VAPOR TODO, a list with SHIP POCKET VAPOR selected, WRITE THE COMPILER checked off, and an amber editor bar at the bottom reading NEW: HELLO HN with a glyph picker cursor" />

<p class="text-sm text-slate-500 -mt-4">A Vue component, mid-keystroke. The amber bar is a reactive string ref being edited with a d-pad; the emerald title is <code>class="bg-emerald-500 text-slate-950 align-center"</code>; the machine is a Game Boy Advance. The whole cartridge is 9.1 KB.</p>

This is a Vue component, lightly abridged from the demo app:

```tsx
export default () => {
  const todos = ref<Todo[]>([
    { text: "SHIP POCKET VAPOR", done: false },
    { text: "WRITE THE COMPILER", done: true },
    { text: "RUN ON A REAL GBA", done: false },
  ]);
  const remaining = computed(() => todos.value.filter((t) => !t.done).length);
  const current = computed(() => filtered.value[cursor.value]);
  // ...cursor, filter and draft refs, the filtered/visible computeds,
  // and the keymap-driven onButton handler live here too...

  return (
    <>
      <TitleBar line={0} text="POCKET VAPOR TODO" />
      <StatusBar line={1} count={remaining.value} label={FILTERS[filter.value]} />
      {visible.value.map((t, i) => (
        <TodoRow line={LIST_Y + i} todo={t} selected={t === current.value} />
      ))}
    </>
  );
};
```

`ref`, `computed`, `.filter`, `.map`, `.slice`, JSX, functional components, Tailwind classes, all imported from `"vue"` and runnable unmodified on Vue 3.6's Vapor runtime in a browser. It is also, after one compile command each, a **9.1 KB Game Boy Advance ROM**, a **32 KB Game Boy cartridge**, and a **40 KB NES cartridge**. No JavaScript engine ships on any of them. No garbage collector. No `malloc`. The consoles run C that a compiler derived from the component. A differential test suite drives the same 31-button input tape through real Vue and all three ROMs, asserting the rendered screen is identical cell-for-cell after every press. 7,264 assertions currently agree.

We call the experiment **Pocket Vapor**. This post is the first public writeup, not a release; the subset is deliberately small. But the reason it works at all is, I think, the interesting part, and it fits in one sentence: *a reactive UI program is far more static than the machinery we usually run it on.* The rest of this post unpacks that sentence until it turns into C.

If you're new here: [PocketJS](/blog/introducing-pocketjs/) is a UI engine that runs real Solid and Vue Vapor components outside the browser (a 2004 Sony PSP, a PS Vita, your desktop) by pairing an interpreted JavaScript guest with a native rendering core. Pocket Vapor is the family's newest wing, and its bet is different: for machines where even an interpreter is too expensive, *compile the framework away entirely*.

## The machines

A quick tour for readers who have never programmed a console, because the constraints are the whole plot:

| | NES (1983) | Game Boy (1989) | Game Boy Advance (2001) |
|---|---|---|---|
| CPU | 6502 core @ 1.79 MHz | SM83 @ 4.19 MHz | ARM7TDMI @ 16.78 MHz |
| Work RAM | **2 KB** | 8 KB | 288 KB |
| Video | tiles via PPU, no framebuffer | 160×144, 4 shades | 240×160, 15-bit color |
| OS / allocator / libc | none / none / none | none / none / none | none / none / none |

Three things matter. First, **there is no software floor**: no OS, no allocator, no runtime. A cartridge is a bare address space; whatever memory discipline your program has is the memory discipline you wrote. Second, **video is tiles, not pixels**: you don't own a framebuffer, you write tile indices into a table the video chip reads while it races the electron beam, and on the older machines you may only touch that table during the ~1.1 ms vertical blank between frames. Third, **the numbers are absurd by web standards**: the production build of Vue's Vapor runtime is 218,493 bytes of JavaScript, about **106×** the NES's entire 2 KB of work RAM. The interpreter that would read that JavaScript is bigger still.

So "run Vue on an NES" cannot mean *run* Vue. It has to mean something else.

## Why this is even possible

Vue 3.6's Vapor mode is built on an observation: templates are static enough that the virtual DOM, a runtime data structure whose job is to *discover* what changed, can be compiled away into direct, targeted updates. The compiler reads the template, already knows `{count.value}` is the only dynamic hole in that `<span>`, and emits exactly the code that patches it.

Pocket Vapor extends the same observation one layer down. Look at what Vue's *reactivity* runtime does dynamically: it tracks which effects read which refs (dependency collection), it schedules re-runs when refs change (dirty propagation), it caches computed values with invalidation flags. All of that machinery exists to answer questions at runtime whose answers are, for the overwhelming majority of components, **visible in the source code**:

- Which refs exist? They're lexically declared: `const cursor = ref(0)`.
- Which bindings read which refs? It's right there in the expression: `{remaining.value}` reads `remaining`, which reads `todos`.
- How big can the list get? In an embedded UI, you were going to decide that anyway.

A reactive runtime is an *interpreter for a dependency graph*. When the graph is a static property of the program, the interpreter can be specialized away. It is the same move Vapor already made against the virtual DOM, taken one abstraction lower. (If you've met the [first Futamura projection](https://en.wikipedia.org/wiki/Partial_evaluation), where specializing an interpreter against a fixed program yields a compiled program, this rhymes with it deliberately. We are not partially evaluating Vue's actual runtime; we reimplement its observable semantics with the graph baked in. The oracle suite below is what keeps the word "semantics" honest.)

Concretely, the whole reactive system compiles to three kinds of data:

<svg viewBox="0 0 760 300" width="100%" role="img" aria-label="Reactivity as data: refs compile to state slots plus dirty bits, dependency edges compile to bitmasks stored in ROM, and template bindings compile to paint effects gated by mask AND dirty" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="20" y="16" width="220" height="112" rx="10" fill="#0e1626" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="130" y="42" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">refs → slots + bits</text>
  <text x="130" y="66" fill="#94a3b8" font-size="11" text-anchor="middle">todos·cursor·filter</text>
  <text x="130" y="84" fill="#94a3b8" font-size="11" text-anchor="middle">editing·draft·glyph</text>
  <text x="130" y="108" fill="#38bdf8" font-size="11" text-anchor="middle">6 dirty bits in one u32</text>
  <rect x="270" y="16" width="220" height="112" rx="10" fill="#0e1626" stroke="#34d399" stroke-width="1.5"/>
  <text x="380" y="42" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">edges → ROM masks</text>
  <text x="380" y="66" fill="#94a3b8" font-size="11" text-anchor="middle">status bar: 0x5</text>
  <text x="380" y="84" fill="#94a3b8" font-size="11" text-anchor="middle">list block: 0x7 · editor: 0x38</text>
  <text x="380" y="108" fill="#34d399" font-size="11" text-anchor="middle">computed statically, stored in ROM</text>
  <rect x="520" y="16" width="220" height="112" rx="10" fill="#0e1626" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="630" y="42" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">bindings → effects</text>
  <text x="630" y="66" fill="#94a3b8" font-size="11" text-anchor="middle">4 paint functions,</text>
  <text x="630" y="84" fill="#94a3b8" font-size="11" text-anchor="middle">merged by screen row span</text>
  <text x="630" y="108" fill="#a78bfa" font-size="11" text-anchor="middle">run iff mask ∧ dirty ≠ 0</text>
  <path d="M380 128 L380 168" stroke="#475569" stroke-width="1.5"/>
  <path d="M380 168 l-5 -8 M380 168 l5 -8" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="120" y="172" width="520" height="100" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="380" y="200" fill="#e2e8f0" font-size="13" font-weight="700" text-anchor="middle">once per frame, at vertical blank</text>
  <text x="380" y="224" fill="#94a3b8" font-size="12" text-anchor="middle">if (vp_dirty &amp; 0x7) repaint_list();  …  vp_dirty = 0;</text>
  <text x="380" y="252" fill="#64748b" font-size="11" text-anchor="middle">a frame where nothing changed costs zero cycles of UI work</text>
</svg>

Dependency *tracking*, the allocating, pointer-chasing part of every reactive system, has no runtime existence at all. One honest caveat: where Vue collects dependencies dynamically, we over-approximate statically. `flag.value ? a.value : b.value` subscribes to all three, always. An over-approximated effect can only re-run redundantly and repaint the pixels it would have painted anyway, so the divergence is unobservable on screen, and the differential suite exists to catch us if that argument ever springs a leak.

## `ref` and `computed`, in C

Here is what the compiler actually emits. These snippets are copied from the generated `gen_app.c` of the todo app, not idealized. A `ref` write is a change-gated store plus a bit:

```c
/* cursor.value = Math.max(0, Math.min(cursor.value + d, filtered.value.length - 1)) */
static void fn_moveCursor(s32 p_d) {
  const vp_view *v15;
  v15 = c_filtered();
  { s32 nv16 = vp_max(0, vp_min((g_cursor + p_d), ((s32)v15->len - 1)));
    if (g_cursor != nv16) { g_cursor = nv16; vp_mark(1); } }
}

static void vp_mark(u8 refIdx) {
  vp_dirty |= vp_bit32[refIdx];      /* wake the effects subscribed to me   */
  c_valid  &= ~C_INVAL[refIdx];      /* invalidate the computeds that read me */
}
```

The `if (g_cursor != nv16)` is Vue's `Object.is` set-gate, compiled. `C_INVAL` is a per-ref constant the compiler derived by asking, for every computed, "does your dependency closure include this ref?" Vue answers that question at runtime with a subscriber list; we answer it once, at build time, and store the answer in ROM.

A `computed` keeps Vue's exact laziness (cached value, validity bit, recompute on first read after invalidation) minus the discovery:

```c
/* const current = computed(() => filtered.value[cursor.value]) */
static rec_todo *c_current(void) {
  if (!(c_valid & 4u)) { c_current_update(); c_valid |= 4u; }
  return c_current_v;
}
```

That laziness is not a nicety; it's semantics. An event handler that mutates `todos` and then reads `filtered.value` mid-handler must see the recomputed view, exactly as in Vue, and the validity bit makes that fall out for free.

And the per-frame flush is the entire scheduler:

```c
u8 app_flush(void) {
  if (!vp_dirty) return 0;
  if (vp_dirty & 0x5u)  eff_0();   /* status bar: reads todos, filter          */
  if (vp_dirty & 0x7u)  eff_1();   /* list block: todos, cursor, filter        */
  if (vp_dirty & 0x38u) eff_2();   /* editor bar: editing, draft, glyph        */
  if (vp_dirty & 0x8u)  eff_3();   /* help bar:   editing                      */
  vp_dirty = 0;
  return 1;
}
```

Four `if`s. Pressing ↑ sets bit 1, which intersects only `eff_1`'s mask: the list repaints, the title/status/help bars are untouched, and a frame where nothing changed does no UI work whatsoever. This is Vue's batched-scheduler contract with the vertical blank as the microtask boundary. Fine-grained reactivity turns out to be a *remarkably* good fit for machines where every cycle is visible.

## `map` / `filter` / `slice`, without a heap

Arrays are where "no GC" usually kills the dream, and the escape hatch is an ownership observation: in this subset, **object lifetime is structural**. A `ref<Todo[]>` owns its records; the interface is closed (no dynamic keys); records don't escape. So the compiler lays the array out as a fixed-capacity pool of inline structs, and then every "fancy" array method falls out of one representation choice:

> `filter` and `slice` never create objects. They create **views**: orderings of indices into a pool that already exists.

```c
/* filtered = computed(() => … todos.value.filter((t) => !t.done) …) */
{ u8 i1; c_filtered_v.len = 0;
  for (i1 = 0; i1 < g_todos_len; i1++) {
    rec_todo *p2 = g_todos + (u16)(i1);
    if (!p2->done) c_filtered_v.idx[c_filtered_v.len++] = i1;
  }
}
```

A view is `{len, idx[32]}`, 33 bytes. `slice(a, b)` is a window copy of indices. `.length` reads `len`. Indexing bounds-checks and hands back a nullable struct pointer, which is precisely JavaScript's `array[i] ?? undefined`. And because `filter` in JavaScript *preserves element identity* (it returns the same objects, not copies), the pointer **is** the identity. `t === current.value`, the cursor-highlight comparison in the JSX, compiles to a pointer equality; `todos.value.indexOf(t)` compiles to pointer subtraction. The semantics we're preserving aren't an approximation of JavaScript's; on this representation they're the *same* semantics with smaller words.

`.map` never materializes anything either. In a template, mapping is painting:

```c
/* {visible.value.map((t, i) => <TodoRow line={LIST_Y + i} todo={t}
                                selected={t === current.value} />)} */
v39 = c_visible();
for (i40 = 0; i40 < v39->len; i40++) {
  rec_todo *t41 = g_todos + (u16)(v39->idx[i40]);
  vp_ln_reset();
  vp_ln_str(((t41 == c_current()) ? S3 : S4));   /* ">" or " "  */
  vp_ln_str((t41->done ? S6 : S4));               /* "X" or " "  */
  vp_ln_sb(&t41->text);
  vp_ln_commit(y42, 1, ((t41 == c_current()) ? 3 : (t41->done ? 4 : 0)), 0);
}
```

(That `<TodoRow>` is a real Vue functional component, by the way; the compiler inlined it to nothing. Six components in this app cost zero bytes of RAM and zero calls.)

Even mutation stays idiomatic. Deleting the selected todo in the source is the line every Vue developer would write:

```tsx
todos.value = todos.value.filter((x) => x !== t);
```

Views over one pool always carry *increasing* indices (identity source, order-preserving filter, order-preserving slice; nothing in the subset can produce anything else), so assigning a filtered view back to its own list compiles to an in-place compaction, shifting survivors down over the deleted record. No allocation happened in JavaScript (Vue got a fresh array, triggering reactivity by identity, which the compiler mirrors by marking unconditionally); no allocation happens in C. `push` appends into the pool and, at capacity, degrades *defined-ly*: the write is dropped and a tripwire flag is raised in a debug block the test harness reads. Budgets fail loudly, never undefined-behaviorly.

## Typing "HELLO HN" with a d-pad

Strings get the same treatment: a `ref<string>` is a `{len, bytes[24]}` slot, string expressions compose in stack scratch, and assignment goes through a by-value change-compare. The todo editor is an ordinary reactive string:

```tsx
function putGlyph() {
  if (draft.value.length < TEXT_MAX) draft.value += GLYPHS[glyph.value];
}
[Button.B]: () => { draft.value = draft.value.slice(0, -1); },  // backspace
```

`+=` on a string ref, negative `slice` ends: the pleasant JavaScript idioms survive, landing as a bounded-buffer append and a clamped copy. Here is that editor, mid-word, on all three consoles. One component file, three video architectures:

<div class="grid md:grid-cols-3 gap-3 items-start">
  <img class="w-full rounded-xl border border-line" src="/assets/blog/vapor-gba-edit.png" alt="GBA: color todo list with amber editor bar reading NEW: HELLO HN" />
  <img class="w-full rounded-xl border border-line" src="/assets/blog/vapor-gb-edit.png" alt="Game Boy: monochrome todo list with inverse editor bar reading NEW: HELLO HN" />
  <img class="w-full rounded-xl border border-line" src="/assets/blog/vapor-nes-edit.png" alt="NES: todo list rendered in a nametable with inverse editor bar reading NEW: HELLO HN" />
</div>

<p class="text-sm text-slate-500 -mt-2">The same <code>draft</code> ref being typed on GBA (15-bit color palettes), Game Boy (four shades, mGBA's DMG rendering), and NES (CHR-ROM tiles inside the TV overscan border). Left/Right scrub a glyph picker, A commits a letter, Start saves.</p>

<div class="grid md:grid-cols-3 gap-3 items-start">
  <img class="w-full rounded-xl border border-line" src="/assets/blog/vapor-gba-added.png" alt="GBA: the todo list now shows a fourth item, HELLO HN, with the cursor on it and the counter reading 3 LEFT" />
  <img class="w-full rounded-xl border border-line" src="/assets/blog/vapor-gb-added.png" alt="Game Boy: the todo list shows HELLO HN as the selected fourth item, 3 LEFT" />
  <img class="w-full rounded-xl border border-line" src="/assets/blog/vapor-nes-added.png" alt="NES: the todo list shows HELLO HN as the selected fourth item, 3 LEFT" />
</div>

<p class="text-sm text-slate-500 -mt-2">After Start: <code>todos.value.push({ text: draft.value, done: false })</code> landed in a fixed pool, <code>remaining</code> recomputed to 3, and only the dirty rows repainted, each machine going through its own video hardware.</p>

Notice the counter reading `3 LEFT` in all three: that's `remaining`, a `computed` chained on a `filter`, recomputing through a validity bit because `push` marked `todos` dirty. The reactive chain you'd draw on a whiteboard for the browser is exactly the chain executing on the 6502.

## One `class` attribute, three color systems

Styling crosses the C boundary the same way everything else does: by becoming data. Rows declare their look with the same Tailwind vocabulary the rest of PocketJS compiles (the color table is literally imported from the main framework's Tailwind compiler), and every distinct (ink, paper) pair the app uses becomes an entry in a compile-time pair table. What a pair *means* is each target's **style contract**: the GBA lowers pairs to real 15-bit palette banks (up to 15 of them; exceeding that is a compile error); the Game Boy and NES, which cannot do per-cell color, lower each pair by luminance polarity onto two baked font styles, dark-on-light or light-on-dark. You can see the contract at work in the screenshots above: the emerald title bar quantizes to "inverse" on the monochrome machines.

Degradation is loud, not silent. A cross-target check runs the compiler frontend for every console at once:

```
$ bun run vapor:check
gba  OK    30x20, 6 style pairs
gb   OK    20x18, 6 style pairs
     warn  VS104: 3 distinct color pairs render as the same glyph style …
nes  OK    22x18, 6 style pairs
```

Under `--strict`, that warning is a build failure. Unknown classes, unknown colors, palette-budget overruns and non-literal dynamic classes are compile errors with file:line, in the same coded-diagnostic style as the rest of the subset. Screen geometry works the same way: `SCREEN.width` is a per-target compile-time constant, so layout math and "narrow screen" ternaries fold and the dead branches never reach ROM. Compile-time responsive design, if you like.

## How we know it's still Vue

Everything above describes a reimplementation, and reimplementations drift. The project's actual definition of correctness is operational:

> Every Pocket Vapor component must also run, **unmodified**, on the real Vue runtime. Same file, no shims in the component.

<svg viewBox="0 0 760 330" width="100%" role="img" aria-label="One component file flows two ways: through vue-jsx-vapor onto the real Vue 3.6 Vapor runtime as the oracle, and through the Pocket Vapor compiler to C, then through three toolchains to GBA, Game Boy and NES ROMs. A parity harness drives the same input tape into both sides and compares the rendered cell grid after every press." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="255" y="12" width="250" height="52" rx="10" fill="#0e1626" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="380" y="34" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">todo.tsx</text>
  <text x="380" y="52" fill="#94a3b8" font-size="11" text-anchor="middle">one Vue Vapor component</text>
  <path d="M310 64 L180 106" stroke="#475569" stroke-width="1.5"/>
  <path d="M180 106 l3 -9 M180 106 l9 -4" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M450 64 L580 106" stroke="#475569" stroke-width="1.5"/>
  <path d="M580 106 l-9 -4 M580 106 l-3 -9" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="40" y="110" width="280" height="74" rx="10" fill="#0b0f1a" stroke="#34d399" stroke-width="1.5"/>
  <text x="180" y="136" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">the oracle</text>
  <text x="180" y="156" fill="#94a3b8" font-size="11" text-anchor="middle">vue-jsx-vapor → Vue 3.6 Vapor runtime</text>
  <text x="180" y="173" fill="#64748b" font-size="11" text-anchor="middle">real reactivity · browser dev host or headless</text>
  <rect x="440" y="110" width="280" height="74" rx="10" fill="#0b0f1a" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="580" y="136" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">the compiler</text>
  <text x="580" y="156" fill="#c4b5fd" font-size="11" text-anchor="middle">TS AST → reactive graph → one C file</text>
  <text x="580" y="173" fill="#64748b" font-size="11" text-anchor="middle">arm-none-eabi-gcc · sdcc · cc65</text>
  <path d="M580 184 L580 216" stroke="#475569" stroke-width="1.5"/>
  <path d="M580 216 l-5 -8 M580 216 l5 -8" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="440" y="220" width="280" height="46" rx="9" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="580" y="248" fill="#e2e8f0" font-size="12" text-anchor="middle">todo.gba 9.1 KB · todo.gb 32 KB · todo.nes 40 KB</text>
  <path d="M180 184 L180 240 L360 292" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M580 266 L400 292" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="255" y="278" width="250" height="40" rx="9" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="380" y="303" fill="#22d3ee" font-size="12" font-weight="700" text-anchor="middle">same tape → same cells, every press</text>
</svg>

The parity harness compiles the ROMs, boots them in headless emulators (libmgba for GBA and Game Boy, jsnes for the NES), replays a 31-press tape covering every interaction the app has (navigation, toggling, filters, deleting, clearing, the whole typing flow, emptying the list, re-adding), and after **every single press** compares the logical cell grid, characters and styles both, against the oracle running the same tape on real Vue. It then decodes the consoles' *actual* video memory (GBA screenblock entries, the Game Boy tile map, the NES nametable) and asserts the physical screen agrees with the logical one. 41 tests, 7,264 assertions, three consoles, every commit.

Differential testing this aggressive has a pleasant side effect: it finds bugs in *both* directions. The suite caught real vblank-budget bugs in our C runtimes. It also surfaced a genuine bug in Vue's Vapor release candidate, where a functional component's own root-element attribute binding gets silently dropped when a same-named attribute falls through ([vuejs/core#15148](https://github.com/vuejs/core/issues/15148), minimal repro attached). When your test oracle is another team's runtime, you occasionally end up debugging the oracle.

There's also a human-shaped oracle: `bun run vapor:dev` serves the same component on real Vue in a real browser: every `<row>` is a live, inspectable DOM element, the keyboard is the pad, and a `?target=gb` switch re-renders under any console's geometry and style lowering. You can watch the Game Boy's two-tone world before ever burning a cartridge.

## What this is, and isn't

Honest inventory. The subset is strict and the compiler enforces it with file:line errors: refs of numbers, booleans, bounded strings, and arrays of closed-shape records; computeds over those (numbers, views, or a record reference); `filter`/`map`/`slice`/`push`/`splice`/`indexOf`/`length`; functional components (inlined, no nesting yet); keymap objects (compiled to ROM function-pointer tables); Tailwind-subset classes. No closures escaping setup, no `async`, no exceptions, no `reactive()` deep proxies, no floats, no dynamic keys. Some of that is future work; some of it is the point. Budgets are explicit: 32 todos on GBA and Game Boy, 8 on the NES, because the NES's 2 KB has to hold the pool, the computed views, the screen's shadow grid *and* the C stack, and every one of those bytes is accounted for in a memory plan the compiler prints at build time. Today the app state fits in about 940 bytes on GBA.

It runs in CI on emulators; the cartridge headers are flashcart-correct and the first real-hardware runs are underway. And it's an experiment, honestly the third in a lineage. We tried consoles twice before with bespoke TypeScript DSLs lowered to a bytecode VM, and they worked, but writing them never stopped feeling like writing the DSL. The thing that finally felt right was refusing to invent a language: take the framework people already know, define the subset by *what runs unmodified on the real thing*, and make a differential harness the arbiter of every claim. MicroPython did this for Python on microcontrollers. There is no reason the reactive UI stack can't have the same deal.

Adding a console is now mostly a definition, not a port: a target is a screen geometry, a set of memory budgets, and a style contract, plus a ~150-line C shim for video and input. The generated application C is identical across all three machines we ship today. The SM83 and the 6502 disagree about almost everything except, it turns out, Vue components.

## Try it

Everything is in the [PocketJS repo](https://github.com/pocket-stack/pocketjs) under `vapor/`:

```sh
bun run vapor          # → dist/vapor/todo.gba  (9.1 KB)
bun run vapor:gb       # → dist/vapor/todo.gb   (32 KB)
bun run vapor:nes      # → dist/vapor/todo.nes  (40 KB)
bun run vapor:check    # which consoles can run this file, and what degrades
bun run vapor:dev      # the same component, live on real Vue, in your browser
bun run vapor:test     # oracle + compiler + 3-console per-press parity
```

The design doc (`vapor/DESIGN.md`) has the full argument, including the parts where we deliberately diverge from Vue and why the screen can't tell. If you own an EverDrive and a soft spot for 8-bit hardware, the ROMs in `dist/vapor/` are yours to flash. And if you make a Game Boy render a Vue component, we'd genuinely love to hear about it.
