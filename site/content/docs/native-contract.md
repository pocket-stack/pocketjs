# Native contract

Everything in PocketJS — the Solid reconciler, the styling layer, animation, input — ultimately drives a native, retained-mode UI tree through one small, synchronous op surface: `ui.*`. This page documents that surface, the runtime model around it, and the constraints that make a JSX app run inside a 2 MB QuickJS worker on a 333 MHz PSP.

If you only write app code you never call these ops directly — you write [`View` / `Text` / `Image`](/docs/components/) and the renderer emits ops for you. This page is for understanding *why* the surface looks the way it does, and for anyone writing a new host.

## The shape of the contract

Three rules define the whole model:

1. **Mutation-only.** Every op is a fire-and-forget mutation of the native tree. There are no queries that walk the tree, no getters that return children. The one read-shaped op, `measureText`, is a stateless convenience — layout still measures natively.
2. **Synchronous.** Each op is a single blocking FFI call. There is no command buffer, no async batching at this layer; the batching that matters happens one level up (Solid only runs effects for changed signals).
3. **The reconciler never reads across FFI.** The renderer keeps a **JS mirror tree** of the native tree. Every structural read Solid performs — parent, first child, next sibling, "is this a text node?" — is a plain JS object walk. Only *writes* cross the boundary.

The op codes are pinned once, in `spec/spec.ts` (the `OP` table), and shared by every host and the Rust core. Codes are append-only: never renumbered, never reused. `0` is reserved as invalid/nop.

## The op table

Signatures are authoritative from `src/host.ts` (`HostOps`) and `spec/spec.ts`. Handles are generation-tagged positive `i32` node ids; `0` means "none".

| # | op | signature | notes |
|---|---|---|---|
| 1 | `createNode` | `(type: i32) → id` | `type` is a `NODE_TYPE`: `0` view, `1` text, `2` image. Returns a fresh node id. |
| 2 | `destroyNode` | `(id) → void` | Destroys the **whole subtree**; frees its anim tracks; clears focus if the focused node was inside. |
| 3 | `insertBefore` | `(parent, child, anchorOr0) → void` | DOM move semantics: if `child` is already attached anywhere it is unlinked first (core tree + taffy + mirror). `anchor = 0` appends. Silently no-ops past `MAX_TREE_DEPTH` (64). |
| 4 | `removeChild` | `(parent, child) → void` | Detaches but **keeps the node alive** — Solid may re-insert it this frame. The renderer sweep destroys it at frame end if still detached. |
| 5 | `setStyle` | `(id, styleId) → void` | `styleId` indexes the compiled style table. `STYLE_ID_NONE` (`-1`) clears back to default. Triggers transitions (old→new animatable diff). |
| 6 | `setProp` | `(id, propId: i32, value: f64) → void` | One dynamic prop. `propId` is a `PROP` id; colors/enums pass their `u32` bits as the number. |
| 7 | `setText` | `(id, str) → void` | UTF-8; text nodes only. Used at node creation. |
| 8 | `replaceText` | `(id, str) → void` | UTF-8; text nodes only. Solid universal calls this on reactive text updates. |
| 9 | `uploadTexture` | `(buf, w, h, psm) → handle` | Dimensions power-of-two and `≤ 512`; `psm` is a `PSM` code. Bytes are copied and 16-byte aligned. Returns a **0-based** texture handle. |
| 10 | `setImage` | `(id, texHandle) → void` | Binds a texture to an image node. `texHandle < 0` clears (handles are 0-based, so `0` is a real handle). |
| 11 | `animate` | `(id, propId, to: f64, durMs, easing, delayMs) → animId` | `from` is the current value. `easing` is an `ENUMS.Easing` ordinal. Returns an anim id. |
| 12 | `cancelAnim` | `(animId) → void` | Stops the track. |
| 13 | `setFocus` | `(idOr0) → void` | Applies the `focus:` style variant natively. `0` clears focus. |
| 14 | `loadStyles` | `(buf) → void` | **web/test hosts only.** Optional. Feeds the compiled `styles.bin`. On PSP the native binary feeds core from the pak. |
| 15 | `loadFontAtlas` | `(buf) → void` | **web/test hosts only.** Optional. One call per baked font atlas blob. |
| 16 | `measureText` | `(str, fontSlot) → width` | JS-side convenience returning width in px. Layout still measures natively. |

For the meaning of `PROP` ids, `ENUMS`, and how a `class` string becomes a `styleId`, see [Styling](/docs/styling/) and the [API reference](/docs/api/). For `animate`/`easing` semantics see [Animation](/docs/animation/).

### Prop value encoding

`setProp` and `animate` carry every value as one number (`f64` on the wire). `src/host.ts` encodes the JS value per the prop's kind (`PROP_VALUE_KIND` in the spec):

- **f32 props** (dimensions, scalars, degrees) pass through as-is.
- **color props** travel as their `u32` **ABGR** bits (`0xAABBGGRR`, the GE `COLOR_8888` layout). A `'#rgb' / '#rrggbb' / '#rrggbbaa'` string is parsed by `parseHexColor` — full-string hex validation, so `#ff00zz` throws rather than silently painting a prefix.
- **int/enum props** travel as their `u32` ordinal.

`encodePropValue(prop, value)` is the single choke point; a non-numeric string for a non-color prop throws loudly.

## Generation-tagged handles

Node ids are not pointers and not plain indices. Each id packs a slot and a generation:

```ts
id = (generation << ID_SLOT_BITS) | slot; // ID_SLOT_BITS = 20, mask 0xFFFFF
```

- **slot** — index into the core's node arena (`Vec<Node>` + free list).
- **generation** — a counter that increments every time a slot is reused.

When a node is destroyed its slot returns to the free list and its generation bumps. A stale id held by JS — say a handler that fires after its node was swept — decodes to a slot whose live generation no longer matches, so the core recognizes it and the op becomes a **safe no-op** instead of corrupting a reused node. This is the same class of guard as a generational index in an ECS.

Fixed invariants:

- Bit 31 stays `0`, so ids are always positive `i32`.
- `0` is "no node" — `insertBefore` anchor `0` = append, `setFocus 0` = clear focus.
- `ROOT_ID` is `1` (slot 1, generation 0): the pre-created full-screen root, a flex column. Your tree mounts under it.
- `MAX_TREE_DEPTH` is `64`. `insertBefore` past the cap is a silent no-op — the same contract as a stale id — which bounds every recursive tree walk (layout build/readback, paint, subtree destroy) so a runaway tree cannot overflow the small PSP thread stacks.

## The JS mirror tree

The renderer (`src/renderer.ts`) implements Solid's universal `createRenderer` over a `NodeMirror`:

```ts
interface NodeMirror {
  id: number;                 // native generation-tagged id
  type: number;               // NODE_TYPE ordinal
  parent: NodeMirror | null;
  children: NodeMirror[];
  text?: string;              // text nodes only
  focusable?: boolean;
  onPress?: (() => void) | undefined;
}
```

Every reconciler *read* resolves against this object graph:

| reconciler hook | implementation |
|---|---|
| `getParentNode` | `node.parent` |
| `getFirstChild` | `node.children[0]` |
| `getNextSibling` | index-of in `parent.children`, return next |
| `isTextNode` | `node.type === NODE_TYPE.text` |

None of those touch the host. Structural mutations (`insertNode`, `removeNode`, `createElement`, `createTextNode`, `replaceText`, `setProperty`) update the mirror *and* emit the matching op. Because the mirror mirrors the native tree exactly — including DOM move semantics on re-parenting — the two never disagree, and Solid's frequent tree walks stay entirely in JS. This is what keeps steady-state frames near-zero FFI.

`setProperty` is a dispatch table, not a generic setter: `class → styleId` (via the injected style resolver), `onPress`/`on:press` → input registry, `src` → texture registry, `style={{…}}` → per-key `setProp` (prev-diffed, so only changed keys cross FFI). Anything else — `classList`, `on:`/`bool:`/`prop:` namespaces, unknown props — is a loud error. See [Styling](/docs/styling/) for why `classList` is rejected.

## Two host kinds

`detectHost()` in `src/host.ts` resolves which `HostOps` object the ops route to, and sets a **strictness** flag that changes behavior on bad input:

| kind | ops source | strict? | on unknown class / texture |
|---|---|---|---|
| `psp` | `globalThis.ui` (installed by `native/src/ffi.rs`) | no | bump a miss counter, keep going |
| `injected` | a `HostOps` passed into `render()` (web / wasm / Bun) | yes | **throw** |

The reasoning is asymmetric on purpose. On real hardware a thrown error is a black screen; a missing style is a slightly-wrong box. So the PSP host counts misses (`missCounters.unknownClass` / `unknownTexture`) and renders on. The web, wasm, and headless-Bun hosts are development and CI surfaces, where a silent wrong-color pixel is worse than a stack trace — so they throw the moment a class isn't in the compiled table or a `src` key has no registered texture.

Resolution order: an injected `HostOps` wins; otherwise `globalThis.ui`; if neither exists, `render()` throws (PocketJS cannot run without a native tree). One special case: the PSP demo entries pass `globalThis.ui` *explicitly*. That object carries a `__textures` marker set only by native `ffi.rs`, so it is still detected as kind `psp` / non-strict — and `render()` skips re-feeding `loadStyles`/`loadFontAtlas`, because the native pak walker already fed core directly.

Every host drives frames the same way: once per tick it calls `globalThis.frame(buttons)` with the PSP button bitmask (`BTN` in the spec). `index.ts` composes input edge-detection and the end-of-frame sweep into that entry point via `installFrameHandler`. See [Input & focus](/docs/input-focus/) for the button model and [Architecture](/docs/architecture/) for how the hosts fit together. The [playground](/playground/) runs the injected web host in the browser.

## Frame order

The PSP host runs one deterministic sequence per vblank. The web and Bun hosts do the same steps under a fixed-step `requestAnimationFrame` / loop so goldens stay byte-exact.

```
sceCtrlRead                         read the controller
  ↓
sceGuStart                          begin the GE display list (main.rs owns it)
  ↓
frame(buttons)   ── JS ──►          edge-detect input, run Solid effects for
                                    changed signals (the only ops this frame),
                                    then runSweep() (node reclamation) last
  ↓
drain jobs                          while JS_ExecutePendingJob(rt, &ctx) > 0
                                    (promise microtasks — polyfilled queueMicrotask)
  ↓
core.tick(1/60)                     advance every anim/spring track at FIXED_DT
  ↓
layout (if dirty)                   taffy re-run + text re-measure, only if a
                                    layout-dirtying prop changed
  ↓
DrawList                            tree walk → flat Vec<u32> ops, CPU-clipped
  ↓
ge::render                          DrawList → sceGu; then Finish / Sync /
                                    WaitVblank / Swap
```

Key properties:

- **The sweep runs inside `frame()`**, as the last thing user code does — so a remove-then-reinsert within one frame (a `<For>` reorder, a `<Show>` toggle) never destroys a live node.
- **Fixed `dt = 1/60 s`.** `core.tick` always advances by `FIXED_DT`, never wall-clock. Frame content is a pure function of frame index, which is exactly what makes byte-exact goldens possible. JS only *declares* motion; Rust ticks it.
- **Layout is conditional.** Only a change to a layout-dirtying prop (`LAYOUT_DIRTYING` in the spec — sizes, padding, flex props, `fontSlot`/`tracking`/`lineHeight`) re-runs taffy. Transform and color changes are paint-only. Prefer transforms in animation for this reason.
- **Backends never own the display list.** `sceGuStart`/`Finish` live in `native/src/main.rs`; the GE backend only translates a DrawList into draw calls. The DrawList arrives already CPU-clipped to `[0, 480] × [0, 272]`, so backends do no clipping.

In steady state — no signals changed — `frame()` emits **no** mutation ops, the sweep set is empty, and the only boundary crossing is the single `frame(buttons)` call itself. Everything downstream (tick, layout, draw) is pure Rust.

## Node reclamation

Solid's reconciler calls `removeChild` for nodes that might be re-inserted the same frame (rows moving across a `<For>`, arms swapping in a `<Show>`). So `removeChild` deliberately does **not** destroy — it detaches and remembers the node in a sweep set:

```ts
function removeNodeImpl(parent, node) {
  notifyDetached(node);              // focus repair, before the unlink
  getOps().removeChild(parent.id, node.id);
  unlink(node);                      // drop from mirror parent
  sweepSet.add(node);                // reclaim at frame end unless re-attached
}
```

If the same node is inserted again before the frame ends, `insertNode` removes it from the sweep set (`sweepSet.delete(node)`) and it survives untouched. Whatever is still detached when `runSweep()` runs at the end of `frame()` gets `destroyNode`'d — a single recursive native destroy per orphaned subtree.

### `retain()` / `release()`

Sometimes you want to detach a subtree and keep it alive across frames — cache an offscreen panel, hold a pooled row. That opts out of the sweep:

```ts
import { retain, release } from "@pocketjs/framework";

retain(node);   // detached but preserved; the sweep skips it (and any subtree containing it)
// ... later ...
release(node);  // undo; if still detached, it re-enters the next sweep
```

`runSweep` checks `subtreeHasRetained` before destroying, so a retained node anywhere inside a detached subtree keeps the whole subtree pending until it is released or re-attached. A `FinalizationRegistry` backstop tier catches anything that slips through both the sweep and an explicit `release` — a safety net, not the primary mechanism.

## PSP memory model

On hardware the whole stack lives in **one arena**, and getting there required fixing a `rust-psp` default that quietly caps out.

`rust-psp` installs a `#[global_allocator]` that makes **one kernel memory object per allocation**. The kernel caps those at roughly 4096, and `pocketjs-core` allocates constantly — taffy slotmaps, `children` Vecs, per-pass `.collect()`s, the DrawList — so the default allocator crashes a real UI. The QuickJS-side arena only covered QuickJS + newlib `malloc`, not core's Rust allocations.

The fix, at a high level:

1. The exact-revision `pocket-stack/rust-psp` dependency exposes an **`external-global-alloc`** feature that cfg-gates out its `#[global_allocator]`.
2. `native/src/alloc.rs` installs the PocketJS global allocator, backed by `arena::alloc`/`dealloc` — the **same single kernel block** QuickJS uses. Core, QuickJS, and newlib all draw from one arena.
3. `arena.rs`'s `ensure_init` calls `sceKernelAllocPartitionMemory` / `sceKernelGetBlockHeadAddr` **directly** — no recursion back through `alloc::alloc`, now that the arena *is* the global allocator.
4. Texture uploads and retained core buffers live in that same arena. A **2 MB margin** is reserved for the GE display list and stack safety.

Other inherited hard rules worth knowing when you touch the native side:

- JS runs on the 2 MB `USER | VFPU` worker; the main stack is 256 KB. `MAX_TREE_DEPTH = 64` exists to keep recursive walks inside it.
- GE buffers are 16-byte aligned with a dcache writeback per batch.
- 2D vertex coords are `i16`; the core's CPU clip stage guarantees in-range values so the GE never wraps a coordinate.
- Textures are power-of-two, `≤ 512` per side, sampled from main RAM.

None of this is visible from app code — it is the cost of making a JSX runtime fit on the device.

## Perf budget

The whole design converges on a small steady-state cost:

| budget | target |
|---|---|
| FFI crossings per steady frame | **one** (`frame(buttons)`; no ops when nothing changed) |
| DrawList draw calls | **≤ ~40** `sceGuDrawArray` calls |
| DrawList quads | **≤ ~2000** |
| per-frame vertex bytes | **≈ 48 KB** from a per-frame bump pool (reset after `sceGuSync`) |
| Solid effects | run only on interaction / changed signals |

Two practical corollaries for app authors: animate **transforms and colors** rather than layout props, because layout-prop animations force a taffy relayout that frame (transforms are paint-only); and keep dynamic styling to ternaries of full class literals or `style={{…}}` objects so the compiler can bake every style ahead of time. See the [Build pipeline](/docs/build-pipeline/) for how styles and font atlases are baked, and [Architecture](/docs/architecture/) for how the same Rust core reaches all four hosts.
