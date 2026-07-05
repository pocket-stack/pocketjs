# PocketJS — a JSX UI stack for the Sony PSP (and beyond)

**One Rust core. One JSX app. Runs on real PSP hardware, PPSSPP, the browser, and headless Bun.**

PocketJS is a standalone cross-platform UI engine: a retained-mode native UI tree
(Rust: flexbox layout, styling, animation, text, rendering) driven from
JavaScript (QuickJS on PSP, the host JS engine elsewhere) by **Solid** through
its universal renderer, styled with a **build-time Tailwind-subset compiler**,
with **baked font atlases** for text. It lives in `PocketJS/` and deliberately
shares no code with the dreamcart game framework — it will be extracted into
its own repository later. (It *does* copy proven low-level patterns from the
dreamcart runtime; every copy is noted below.)

This design was adversarially reviewed by three independent audits (PSP-native
feasibility, Solid-universal correctness, compiler/pipeline); every confirmed
finding is folded in below and marked **[R]**.

```
        app.tsx  (Solid + Tailwind classes)
           │  babel-preset-solid {generate:'universal'}  (two-pass build)
           ▼
        bundle.js      styles.bin + font atlases + images ──► app.pak
           │
   ┌── QuickJS (PSP) ──────────┐   ┌── browser / Bun ────────┐
   │ Solid runtime             │   │ Solid runtime           │
   │   │ createNode/setStyle…  │   │   │ same ui.* ops       │
   │   ▼                       │   │   ▼                     │
   │ ui-core (Rust, no_std)    │   │ ui-core (same Rust,     │
   │  tree·taffy·anim·text     │   │   compiled to WASM)     │
   │   │ DrawList              │   │   │ DrawList            │
   │   ▼                       │   │   ▼                     │
   │ sceGu backend (GE)        │   │ software rasterizer     │
   └───────────────────────────┘   │  → canvas / PNG golden  │
                                   └─────────────────────────┘
```

## Why these choices

Decisions grounded in a full audit of the dreamcart runtime (research
artifacts: `$JOB_TMP/map-*.json`).

- **Solid + universal renderer** (`solid-js@1.9.x`, `babel-preset-solid@1.9.x`
  `{generate:'universal', moduleName:<ABSOLUTE path to src/renderer.ts>}` —
  moduleName is emitted verbatim into every file, so it must be absolute or a
  bundler-aliased bare specifier **[R]**): no VDOM — updates run only the
  effect closures of changed signals. Verified: Solid's dist references no
  `window`/`document`/`setTimeout`/`WeakRef`; needs Proxy, WeakMap, Promise.
  Prior art: Lightning TV, `@opentui/solid`. Preact+DOM-shim is the fallback.
- **QuickJS reality [R]**: the linked engine (quickjs-rs submodule) is
  **Bellard 2025 (VERSION 2026-06-04), ~ES2023** — logical assignment, WeakRef
  and **FinalizationRegistry are available**. Still absent: `queueMicrotask`
  (polyfill via `Promise.resolve().then`), `setTimeout`, `MessageChannel`,
  `performance` — so Solid's `createResource`/transitions/`enableScheduling`
  remain off-limits on PSP (compiler lints on import).
- **taffy 0.11** (`default-features=false, features=["alloc","taffy_tree","flexbox","content_size"]`):
  verified `no_std`+alloc, f32-only, no libm. Fallback: hand-rolled flexbox
  subset — only if code size or hardware measurement disqualifies it.
- **Rust core compiled twice**: `core/` is a platform-agnostic `no_std` lib.
  PSP bin wraps it with QuickJS + sceGu; `wasm32-unknown-unknown` build wraps
  it with a deterministic software rasterizer used by BOTH the browser dev
  host and headless Bun goldens. One layout engine everywhere.
- **Native animation**: tweens/springs tick in Rust per vblank with **fixed
  dt = 1/60 s** (frame content is a pure function of frame index — this is
  what makes byte-exact goldens possible **[R]**). JS only declares motion.
- **Baked text**: opentype.js atlas baker → horizontally-supersampled 8-bit
  coverage cells + proportional advances + cmap; native draw = alpha run-length
  extraction into batched GE sprites. Font: **Inter** (OFL), vendored in
  `assets/fonts/`.

## Repository layout

```
PocketJS/
  DESIGN.md, README.md
  package.json         self-contained; PINNED: solid-js@^1.9, babel-preset-solid@^1.9,
                       @babel/core@^7 (Babel 8 breaks preset-solid [R]),
                       @babel/preset-typescript@^7 (required for .tsx [R]), opentype.js, typescript
  tsconfig.json        jsx:'preserve' (babel owns the transform); editors typecheck only [R]
  src/jsx.d.ts         JSX component typing only; public primitives live in src/primitives.ts [R]
  assets/fonts/        Inter-Regular.ttf, Inter-Bold.ttf (+ OFL LICENSE)
  spec/
    spec.ts            SINGLE SOURCE OF TRUTH: op codes, prop ids, enums,
                       style-table format, atlas format, DrawList format,
                       pak container constants (magic/header/entry/align/fnv1a) [R]
    gen-rust.ts        codegen → core/src/spec.rs (committed)
  core/                Rust lib `pocketjs-core` — #![no_std] + alloc
    src/lib.rs         pub struct Ui: apply-ops, tick(1/60), draw() → &DrawList
    src/spec.rs        GENERATED — test/contract.ts re-runs gen-rust.ts and
                       byte-compares this file (airtight drift guard) [R]
    src/tree.rs        node arena: Vec<Node> + free list + GENERATION COUNTER
                       (ids are (gen<<20)|slot; stale ids are no-ops) [R]
    src/style.rs       style table parse/resolve; base/focus/active variants
    src/layout.rs      taffy sync + text measure closures + dirty tracking;
                       empty text nodes are excluded from the taffy tree [R]
    src/text.rs        atlas registry, cmap (miss → gid 0 tofu + miss counter [R]),
                       measurement, inline-run layout
    src/anim.rs        tween/spring tracks; transitions on style swap; fixed dt
    src/draw.rs        tree walk → DrawList + CPU CLIP STAGE: axis-aligned clip
                       with UV/color re-interpolation for textured/gradient quads;
                       rotated quads Sutherland-Hodgman-clipped (or culled) so no
                       negative/oversized coords ever reach a backend [R]
  native/              Rust bin `pocketjs-psp` — the EBOOT (standalone dir, lone bin)
    Cargo.toml         psp {external-c-heap, abort-only, external-global-alloc},
                       libquickjs-sys, pocketjs-core (path)
    build.rs           embeds $POCKETJS_APP js + app.pak (PSPJS_GAME pattern);
                       [features] capture = [] for the E2E frame-dump
    targets/mipsel-sony-psp.json  copied from runtime/ (self-contained)
    src/main.rs        boot (2MB USER|VFPU worker), vblank loop, job pump
    src/alloc.rs       #[global_allocator] backed by the arena [R] — see Memory
    src/arena.rs       ┐ copied from dreamcart runtime; ensure_init changed to
    src/c_heap.rs      ├ call sceKernelAllocPartitionMemory DIRECTLY (no recursion
    src/qjs_alloc.rs   ┘ through alloc::alloc now that arena IS the global) [R]
    src/ffi.rs         QuickJS ui.* bindings → core ops
    src/ge.rs          DrawList → sceGu; PER-FRAME BUMP VERTEX ARENA (Vec<Chunk16>
                       pool allocated at boot, reset after sceGuSync — never reuse
                       a region within a frame; GE reads async in Direct mode) [R]
    src/pak.rs       native read-only .pak walker: styles + atlases + images
                       are fed to core DIRECTLY from include_bytes! before JS eval
                       (zero QuickJS-heap transit) [R]
  wasm/                Rust cdylib `pocketjs-wasm` — core + rasterizer, no wasm-bindgen
    src/lib.rs         extern "C" op mirror + render() → RGBA8 480×272
    src/raster.rs      deterministic scanline rasterizer (blend, gradients, glyphs)
  src/                 TS/JS runtime shared by all hosts
    renderer.ts        Solid universal createRenderer; JS mirror tree; setProperty
                       DISPATCH TABLE [R]: class→styleId, on*→input registry,
                       src→texture registry, style object→per-key propId (prev-diffed);
                       classList / on: / bool: / unknown → loud dev error.
                       NODE RECLAMATION [R]: end-of-frame sweep destroys subtrees
                       removed and not re-attached during the frame; retain()/release()
                       escape hatch; FinalizationRegistry as backstop tier.
    host.ts            HostOps interface + PSP(globalThis.ui) / wasm bindings
    pak.ts           QuickJS-safe reader (fromCharCode, NO TextDecoder) — web/test
                       hosts load styles/atlases through ops; PSP does it natively [R]
    styles.ts          class-string → styleId map (imports generated table)
    input.ts           edge-detect, focus manager (refocus on removal:
                       next sibling → prev → nearest focusable ancestor [R]), onPress
    anim.ts            animate()/spring() typed API
    index.ts           render(), signals re-export
  compiler/
    solid-plugin.ts    babel transformAsync: [[babel-preset-solid,{generate:'universal',
                       moduleName}], [@babel/preset-typescript]]; ALSO collects, per file,
                       class strings + text codepoints FROM THE AST (StringLiteral +
                       TemplateLiteral quasis — JSX text compiles to template literals [R]);
                       lints: classList attr, solid createResource/transition imports
    tailwind.ts        token parser + style-table compiler → styles.bin + styles.generated.ts;
                       a literal becomes a style record iff EVERY whitespace-separated
                       token parses as a supported utility (else ignored) [R]
    bake-font.ts       atlas baker (charset from AST scan + ASCII always + extraChars
                       option [R]; gid 0 = tofu box)
    pak.ts           writer (standalone; constants imported from spec/spec.ts)
  host-web/
    index.html         480×272 canvas playground, virtual buttons, demo picker
    engine.js          loads wasm, HostOps, rAF loop (fixed-step), keyboard map
    serve.ts           static Bun.serve dev server (no livereload; rebuild + reload manually)
  demos/
    hero/, cards/, stats/, library/, settings/, notifications/, music/
                       each demo has app.tsx + main.tsx (mount entry)
  test/
    contract.ts        spec drift guard (regen + byte-compare) + engine constants
    golden.ts          headless Bun: wasm rasterizer, scripted input, byte-exact PNGs
    goldens/           *.png (wasm rasterizer goldens)
    goldens-psp/       *.png + PPSSPP-COMMIT.txt (emulator build stamp [R])
    e2e-ppsspp.ts      EBOOT (capture) → PPSSPPHeadless → frames vs goldens-psp/
  scripts/
    build.ts           TWO-PASS build [R] — see Build pipeline
    psp.ts             build.ts + cargo psp (env from runtime/build.ts) → EBOOT
    dev.ts             one-shot: wasm build + demo build(s) + serve
    wasm.ts            cargo build --target wasm32-unknown-unknown --release
```

## Build pipeline (two-pass — fixes the scan cycle [R])

`scripts/build.ts <app>`:

1. **Pass 1 — transform & collect.** For every `.tsx`/`.ts` source reachable
   from the app entry, run the babel transform (cached by content hash). The
   plugin collects per-file: (a) candidate class strings, (b) text codepoints
   — both from AST literals *and template quasis*, never regex over quotes.
2. **Compile styles & fonts.** `tailwind.ts` validates tokens (all-or-nothing
   per literal), assigns styleIds, writes `styles.bin` + `styles.generated.ts`
   (excluded from future scans). `bake-font.ts` bakes atlas slots for the
   collected charset. `pak.ts` packs styles.bin + atlases + images →
   `<app>.pak`.
3. **Pass 2 — bundle.** `Bun.build` with an onLoad plugin that serves the
   *cached* pass-1 transforms (styles.generated.ts now exists), `format:
   "iife"`, `minify:false`, `target:"browser"`. Output `<app>.js` next to the
   pak.

The PSP build (`scripts/psp.ts`) then runs `rustup run nightly-2026-05-28
cargo psp` with the exact env block from `runtime/build.ts` (LLVM PATH,
TARGET_CFLAGS, AR_mipsel_sony_psp=llvm-ar, RUST_PSP_TARGET, RUST_PSP_ABORT_ONLY,
RUSTFLAGS `-A linker-messages …`), `POCKETJS_APP=<app>` consumed by `build.rs`.

## The native contract (`ui.*`)

Mutation-only ops; the Solid renderer keeps a JS mirror tree (`{id, parent,
children[], …}`) so reconciler *reads* never cross the FFI. Handles are `i32`
**generation-tagged** ids; node 1 = pre-created root (full-screen flex column).

| op | signature | notes |
|---|---|---|
| createNode | `(type:i32) → id` | 0=view 1=text 2=image |
| destroyNode | `(id)` | subtree; frees anim tracks; clears focus if inside **[R]** |
| insertBefore | `(parent, child, anchorOr0)` | **DOM move semantics: if child is attached anywhere, unlink first** (core tree + taffy + JS mirror) **[R]**; append when anchor=0; silently no-ops past `MAX_TREE_DEPTH` (spec, 64) so recursive tree walks stay stack-bounded on PSP |
| removeChild | `(parent, child)` | keeps node alive (Solid re-inserts); renderer sweep destroys it at frame end if still detached |
| setStyle | `(id, styleId)` | triggers transitions (old→new animatable diff) |
| setProp | `(id, propId:i32, value:f64)` | dynamic single prop (colors as u32 bits) |
| setText | `(id, str)` | UTF-8; text nodes only |
| replaceText | `(id, str)` | Solid universal calls this on text updates |
| uploadTexture | `(buf, w, h, psm) → handle` | pow2 ≤512, copied + 16B-aligned |
| setImage | `(id, texHandle)` | texHandle < 0 clears (handles are 0-based: 0 is the first upload) |
| animate | `(id, propId, to:f64, durMs, easing, delayMs) → animId` | from = current |
| cancelAnim | `(animId)` | |
| setFocus | `(idOr0)` | applies `focus:` variant natively |
| loadStyles / loadFontAtlas | `(buf …)` | **web/test hosts only** — on PSP, native/src/pak.rs feeds core directly from include_bytes! **[R]** |
| measureText | `(str, fontSlot) → width` | JS convenience; layout measures natively |

**Text model [R].** A `<text>` element lays out its text-node children as one
concatenated inline run (single measure, not N flex items). Text nodes inherit
the resolved text style (font slot, color, tracking, align) from the nearest
ancestor that sets text props; bare strings under `<view>` get the inherited
default. Empty text nodes (Solid's `<Show>` markers) are excluded from layout
until `replaceText` makes them non-empty.

Application code should not write those lower-case host tags directly. The
public SDK surface is imported from `PocketJS` and uses React Native-style
`View`, `Text`, and `Image` primitives; the lower-case tags remain an internal
renderer target for `src/primitives.ts` and low-level tests.

**Frame order (PSP).** `sceCtrlRead → sceGuStart → JS frame(buttons) → drain
jobs (while JS_ExecutePendingJob(rt,&mut ctx)>0 — declare the symbol in a local
extern block, the curated libquickjs-sys omits it [R]) → renderer end-of-frame
sweep runs inside frame() → core.tick(1/60): anims → layout if dirty → DrawList
→ ge::render → sceGuFinish/Sync/WaitVblank/Swap`. Backends never call
sceGuStart/Finish (display list owned by main.rs, dreamcart contract).

## Memory (the blocker fix [R])

rust-psp installs a `#[global_allocator]` that makes **one kernel object per
allocation** (cap ≈4096 → crash). The QuickJS-side arena trio only hooks
QuickJS + newlib malloc — it does NOT cover pocketjs-core's Rust allocations
(taffy slotmaps, children Vecs, per-pass `.collect()`s, DrawList). Therefore:

1. Add feature **`external-global-alloc`** to the vendored `rust-psp` fork:
   cfg-gate `psp/src/alloc_impl.rs`'s `#[global_allocator]` out.
2. `native/src/alloc.rs` installs the PocketJS global allocator backed by
   `arena::alloc/dealloc` (same single kernel block as QuickJS).
3. `arena.rs`'s `ensure_init` must call `sceKernelAllocPartitionMemory` /
   `sceKernelGetBlockHeadAddr` directly (no recursion through `alloc::alloc`).
4. Texture uploads and retained core buffers live in the same arena — the old
   "4 MB margin" no longer needs to hold them; keep a 2 MB margin for the GE
   list + stack safety.

Other inherited hard rules: JS on the 2 MB `USER|VFPU` worker (main stack
256 KB); GE buffers 16-byte aligned + dcache writeback per batch; 2D vertex
coords i16 with the CPU clip stage guaranteeing in-range values; textures pow2
≤512 sampled from main RAM; `size_t`=`usize` (MIPS o32); llvm-ar; toolchain
`nightly-2026-05-28`; JS bundle NUL-terminated, eval len-1.

## Tailwind subset (v1 — pinned)

Utilities (Tailwind default scales; `w-[123]` arbitrary px supported):

- **flex**: `flex`, `flex-row|col`, `justify-start|center|end|between|around`,
  `items-start|center|end|stretch`, `gap-N`, `grow`, `grow-0`, `shrink-0`,
  `basis-N`, `flex-1`, `flex-wrap`
- **box**: `w-N|full|[px]`, `h-N|full|[px]`, `min/max-w/h-N`, `p*/m*-N`,
  `absolute|relative`, `inset/top/right/bottom/left-N`, `hidden`,
  `overflow-hidden` (scissor), `z-N`
- **visual**: `bg-{palette}`, `bg-gradient-to-t|b|l|r` + `from-{c}`/`to-{c}`
  (per-vertex gouraud for square boxes; alpha-covered RECT spans for rounded
  boxes), `rounded|-sm|-md|-lg|-xl` (axis-aligned boxes get deterministic
  subpixel edge coverage; **`rounded-full` only on nodes whose w/h are
  build-time known** from `w-N h-N`, compiler bakes the exact radius, else
  compile error **[R]**), `opacity-N`, `shadow|-md|-lg` (layered rounded alpha
  spans), `border`+`border-{c}`
- **text**: `text-{palette}`, `text-xs|sm|base|lg|xl|2xl|4xl` → baked slots
  **12/14/16/18/20/24/36 px** (slots derived from the utility list, both
  weights **[R]**), `font-bold`, `text-left|center|right`, `leading-N`,
  `tracking-wide`
- **transform** (animatable, no relayout): `translate-x/y-N`, `scale-N`,
  `rotate-N`
- **motion**: `transition[-transform|colors|opacity|all]`, `duration-N`,
  `ease-linear|in|out|in-out|spring|out-back`, `delay-N`
- **variants**: `focus:`, `active:` — variant blocks in the style record,
  switched natively (zero JS on focus change)
- **build-time variants** (device profiles, below): width breakpoints
  `sm:`/`md:`/`lg:`/`xl:` and device/capability flags `psp:`/`3ds:`/`touch:`…,
  resolved at COMPILE time against the active profile and folded into the record

Not supported v1 (loud compile/dev errors, not silent): `classList`, template-
interpolated class fragments, `hover:`. Dynamic styling = ternaries of full
literals, `style={{…}}` objects, or `animate()`.

## Device profiles (one app source, many device sizes)

Screen size is not a hardwired constant — it is a **build-time device profile**
(`spec/devices.ts`: `{ name, width, height, caps[], fontScale }`). One profile is
selected per build (`scripts/build.ts --device=<name>`, default `psp`) and it is
the single knob that adapts an app to a physical target:

- **Core screen size.** `spec::SCREEN_W/H` is no longer baked into the generated
  `spec.rs`; `core/build.rs` emits it from `POCKETJS_SCREEN_W/H` (default 480×272
  = PSP, so PSP/wasm/goldens are byte-unchanged), and each backend build script
  sets it for its target (PSP 480×272, 3DS 400×240). The whole core reads only
  `spec::SCREEN_W/H`, so one knob reflows layout + the CPU clip stage + the root.
- **Responsive resolution, statically.** The Tailwind compiler resolves the
  build-time variants above against the profile — a matching `md:`/`3ds:` token
  folds into the style record, a non-matching one is validated then dropped (zero
  runtime cost, unlike a web media query). `md:` deliberately sits between the
  3DS (400) and PSP (480) so the two diverge; breakpoints are tuned for handheld
  screens, NOT Tailwind's 640/768 web defaults. A literal that is entirely gated
  out on the current device (e.g. only `3ds:` tokens on a PSP build) is still a
  known class — it maps to `STYLE_ID_NONE`, never the unknown-class path.
- Flexbox already does the fluid reflow (`flex-1`/`grow`/`justify-between`/`gap`/
  `w-full`), so a cleanly-authored app mostly "just works" at a new width; the
  variants cover the cases pure reflow can't. `fontScale` is a reserved future
  density knob (v1 pins it to 1.0 — absolute-px utilities + flex reflow).

Adding a device = adding a profile; the app source never changes. `native-3ds/`
is the first new target built this way (see `native-3ds/README.md`).

## Testing (definition of done)

1. `contract.ts` — regen spec.rs in-memory + byte-compare; constants greps.
2. `golden.ts` — headless Bun + wasm rasterizer; fixed dt; scripted input;
   byte-exact PNG goldens. Coverage must include: `<For>` reorder (move
   semantics), `<Show>` toggle inside `gap-N` (marker layout), `Count: {n()}`
   mixed text runs, focus traversal, a non-ASCII glyph **[R]**.
3. `e2e-ppsspp.ts` — capture-feature EBOOT (frame dump to `ms0:/dc_cap`,
   scripted input via `POCKETJS_CAPTURE_INPUT` baked at build; ported from
   origin/main's capture stack), `PPSSPPHeadless --graphics=software
   --timeout=N`, magick decode, byte-exact vs goldens. Goldens carry the
   PPSSPP build commit; mismatch message says "emulator differs → UPDATE=1 or
   threshold fallback (IoU≥0.995, meanRGB≤8)" **[R]**. FPS floor asserted as a
   separate non-golden check (HUD enabled only in that mode) **[R]**.
4. Real hardware smoke: `bun run psp:hw`-style PSPLINK loop (manual).

## Perf budget

One FFI crossing per steady-state frame; DrawList ≤ ~40 sceGuDrawArray calls,
≤ ~2000 quads; per-frame vertex bytes ≈48 KB from the bump pool; layout-prop
animations relayout that frame (prefer transforms); Solid effects only on
interaction. Boot: unminified but tree-shaken bundle; all binary assets in the
pak (base64-in-JS is the known QuickJS boot killer).

## What v1 explicitly punts

Kinetic scroll views, CLUT/swizzled textures, render-to-texture opacity groups
(per-vertex alpha propagation instead — wrong on overlap, fine for demos),
kerning, `hover:`, percentage sizes beyond `-full`, Android hosts,
`rounded-full` on runtime-sized nodes. (The 3DS is no longer punted: `native-3ds/`
is a working target — `bun run 3ds hero` builds a `.3dsx` that runs the hero demo
on the Azahar emulator at the `3ds` profile's native 400×240. See
`native-3ds/README.md`.)
