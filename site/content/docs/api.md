# API reference

The primary app-facing exports of `@pocketjs/framework`, grouped by import
path. Signatures are TypeScript-style; defaults are noted in parentheses.
Framework-internal and tests/debug helpers are intentionally not exhaustive
here. For conceptual walkthroughs see [Components](/docs/components/),
[Reactivity](/docs/reactivity/), [Animation](/docs/animation/), and
[Input & focus](/docs/input-focus/).

| Import path | Exports |
| --- | --- |
| `@pocketjs/framework` | `mount`, `render`, host/runtime helpers, types |
| `@pocketjs/framework/components` | `View`, `Text`, `Image`, `Sprite`, `Screen`, `Focusable`, `FocusScope`, `FocusGrid`, `ActionHandler`, `Portal`, `Modal`, `ActionBar`, `Named`, `Grid`, `Lazy`, `Gallery`, `DeepZoom` (Solid) |
| `solid-js` | `createSignal`, `createEffect`, `createMemo`, `onMount`, `onCleanup`, `batch`, `untrack`, `Show`, `For`, `Index`, `Switch`, `Match` |
| `vue` | `defineComponent`, `ref`, `computed`, `watchEffect`, `onMounted`, `onScopeDispose` |
| `@pocketjs/framework/animation` | `animate`, `spring`, `cancelAnim` |
| `@pocketjs/framework/lifecycle` | `onFrame`, `onButtonPress`, `analogX`, `analogY`, `analogRaw`, `createSpriteAnimation`, `pushButtonHandlerBlock` |
| `@pocketjs/framework/input` | `BTN`, `touches`, `focusNode`, `getFocused`, `pushFocusScope`, `pushFocusGrid` |
| `@pocketjs/framework/platform` | `platform`, `hasFeature` |
| `@pocketjs/framework/clock` | `simulationHz`, `ticksPerFrame`, `virtualFrame`, `virtualNow`, `after` |
| `@pocketjs/framework/effects` | `installEffectDriver`, `runEffect`, effect types |
| `@pocketjs/framework/hot` | `text`, `prop` |
| `@pocketjs/framework/manifest` | contracts/schema/manifest types, validator, `extractHostBuildInputs`, `hostBuildEnvironment`, `vitaTitleId` |

---

## `@pocketjs/framework`

The runtime entry point: mount an app, tear it down, and reach the lower-level host, sweep, style, and pack utilities.

### `mount`

```ts
function mount(code: () => unknown, opts?: MountOptions): () => void
```

App-level entry point for demo/application bundles. Resolves ops from `opts.ops` or `globalThis.ui`, loads `opts.pak` (when given), uploads the pack's images on injected hosts, feeds the default generated style table (`opts.styles` ?? `STYLE_IDS`), and mounts `code`. Returns a disposer that unmounts and destroys the app subtree. Throws if neither `opts.ops` nor `globalThis.ui` is present.

### `render`

```ts
function render(code: () => unknown, opts?: RenderOptions): () => void
```

Lower-level mount: detects and installs the host, wires the style resolver, registers `opts.styles`, feeds styles/atlases from the pack on injected hosts, builds the app + overlay layers, installs the per-frame handler, and mounts `code`. Returns a disposer. `mount` calls `render`; call `render` directly when you supply your own `ops`/`styles`.

### `RenderOptions` / `MountOptions`

`MountOptions` is an alias of `RenderOptions`.

| Field | Type | Description |
| --- | --- | --- |
| `ops` | `HostOps` | web/wasm/test hosts inject their op surface here; omit on native QuickJS hosts (`globalThis.ui`). |
| `styles` | `Record<string, number>` | class-literal → styleId table (`styles.generated.ts`). |
| `pak` | `ArrayBuffer` | app pack; defaults to `globalThis.__pak` when present. |

### Host helpers

```ts
function detectHost(injected?: HostOps): Host
function installHost(host: Host): void
function getOps(): HostOps
```

`detectHost` resolves the active host — injected ops win, otherwise
`globalThis.ui` (PSP/Vita QuickJS); throws when neither exists. `installHost`
sets the active host (called by `render`). `getOps` returns the installed op
surface. Manifest-built native bundles validate `ui.__host` and
`ui.__hostAbi` before mounting. See [Native contract](/docs/native-contract/)
for the full `HostOps` surface.

### `HostOps`

The synchronous `ui.*` op surface. Node ids are generation-tagged positive
i32 values and reserve `0` for "none"; texture handles have separate 0-based
or generation-tagged contracts. Each op is documented in full on the
[Native contract](/docs/native-contract/) page; the summary:

| Op | Signature | Purpose |
| --- | --- | --- |
| `createNode` | `(type: number) => number` | New node (spec `NODE_TYPE`) → id. |
| `destroyNode` | `(id: number) => void` | Destroy subtree; free anim tracks; clear focus. |
| `insertBefore` | `(parent, child, anchorOr0) => void` | Move/insert; anchor `0` = append. |
| `removeChild` | `(parent, child) => void` | Detach but keep the node alive. |
| `setStyle` | `(id, styleId) => void` | Apply a compiled style; `-1` clears. |
| `setProp` | `(id, propId, value) => void` | Set one spec `PROP`. |
| `setText` / `replaceText` | `(id, str) => void` | Text-node content. |
| `uploadTexture` | `(buf, w, h, psm) => number` | Upload a pow2 image (≤512) → handle. |
| `setImage` | `(id, texHandle) => void` | Bind an image; `<0` clears. |
| `setSprite` | `(id, atlas, frames, cols, step) => void` | Bind/clear a native-ticked sprite atlas. |
| `animate` | `(id, propId, to, durMs, easing, delayMs) => number` | Start a tween → animId. |
| `cancelAnim` | `(animId) => void` | Stop a tween. |
| `setFocus` | `(idOr0) => void` | Focus a node; `0` clears. |
| `setActive?` | `(id, active) => void` | Apply/clear the native `active:` variant. |
| `loadStyles?` | `(buf) => void` | web/test only — feed the style table. |
| `loadFontAtlas?` | `(buf) => void` | web/test only — feed one baked atlas. |
| `measureText` | `(str, fontSlot) => number` | Measured width in px. |
| `loadTileTexture?` / `freeTexture?` | tile key/index or handle | Stream and release generation-tagged DeepZoom textures. |
| `uploadImgEntry?` | `(blob) => number` | Upload a self-contained baked image entry; returns a handle or `-1`. |
| `debugInspect?` … `debugStep?` | debug-only | Optional DevTools inspection and pause/step surface. |
| `__host?` / `__hostAbi?` | metadata | Native target and HostOps ABI handshake. |

### `Host`

```ts
interface Host {
  ops: HostOps;
  kind: "native" | "injected";
  target: string;
  strict: boolean;
}
```

`kind` describes who owns the transport, not the target. Native PSP and Vita
hosts are non-strict and count an unknown class or texture; injected
web/wasm/test hosts throw. `target` normally carries `"psp"`, `"vita"`, or
`"injected"`; a pre-contract native host reports `"unknown"`, and a custom
injected host may supply another identifier.

### End-of-frame sweep

```ts
function retain(node: NodeMirror): void
function release(node: NodeMirror): void
function runSweep(): void
```

`retain` keeps a detached subtree alive across frames (skips the sweep); `release` undoes it so a still-detached node re-enters the next sweep. `runSweep` destroys every subtree removed during the frame and still detached — the runtime already calls it once per frame after user code and input, so remove-then-reinsert (Solid moves) never destroys live nodes. Reach for these only when hand-managing detached subtrees.

### `registerTexture`

```ts
function registerTexture(key: string, handle: number): void
```

Bind an image key (the `src` string) to an `uploadTexture` handle so `<Image src="key">` resolves through the renderer's texture registry.

### `missCounters`

```ts
const missCounters: { unknownClass: number; unknownTexture: number }
```

On a non-strict native host, an unknown class or texture increments a counter
instead of throwing. Read it to diagnose missing styles/images without
crashing hardware.

### Styles

```ts
function registerStyles(table: Record<string, number>): void
function resolveStyle(cls: string): number | undefined
```

`registerStyles` loads a class-literal → styleId table (the compiler's `STYLE_IDS`); it also registers a token-sorted alias so `"a b"` resolves the id for `"b a"`. `resolveStyle` returns the styleId for a class string, or `undefined` if the compiler never saw it (or the token reordering is ambiguous). See [Styling](/docs/styling/) and [Tailwind subset](/docs/tailwind/).

### Data pack (pak)

```ts
function pakEntries(prefix?: string): string[]
function pakGet(key: string): Uint8Array
function loadPack(ab: ArrayBuffer): void
function resetPack(): void
```

`pakEntries` lists entry keys starting with `prefix` (default: all keys), sorted. `pakGet` returns a fresh copy of a blob's bytes, throwing on a missing key. `loadPack` explicitly loads a pack (web host after fetch, or tests), replacing any prior. `resetPack` drops the cached parsed pack. See [Build pipeline](/docs/build-pipeline/).

### `NodeMirror`

```ts
interface NodeMirror {
  id: number;                         // native generation-tagged node id
  type: number;                       // spec NODE_TYPE ordinal
  parent: NodeMirror | null;
  children: NodeMirror[];
  text?: string;                      // text nodes only
  focusable?: boolean;                // focus traversal membership
  onPress?: (() => void) | undefined; // CIRCLE handler while focused
}
```

The JS mirror of a native node. A `ref` receives one; `animate`, `spring`, `focusNode`, `pushFocusScope`, and `pushFocusGrid` all accept one.

---

## `@pocketjs/framework/components`

Platform primitives and higher-level components. Solid control-flow components
(`Show`, `For`, `Index`, `Switch`, `Match`) are not exported here; import them
directly from `solid-js`.

### Primitives

```ts
function View(props: ViewProps): JSX.Element
function Text(props: TextProps): JSX.Element
function Image(props: ImageProps): JSX.Element
function Sprite(props: SpriteProps): JSX.Element
```

The host primitives, wrapped React Native-style. `View` is the flex container/box, `Text` renders baked-font text, `Image` draws an uploaded texture by `src` key, and `Sprite` draws an auto-playing animation from a baked sprite atlas by `sprite` key.

**`ViewProps`**

| Prop | Type | Description |
| --- | --- | --- |
| `class` | `string` | Tailwind-subset class literal. |
| `style` | `Record<string, number \| string>` | Inline spec props (escape hatch). |
| `onPress` | `() => void` | Fired on CIRCLE while focused. |
| `focusable` | `boolean` | Joins d-pad focus traversal. |
| `ref` | `(node: NodeMirror) => void \| NodeMirror` | Node handle. |
| `children` | `JSX.Element` | Child nodes. |
| `debugName` | `string` | Semantic name in the [DevTools](/docs/devtools/) tree (mirror-only, zero native cost). |

**`TextProps`** — `class`, `style`, `ref`, `children`, `debugName`.
**`ImageProps`** — `class`, `src` (`string`), `style`, `ref`, `debugName`.
**`SpriteProps`** — `class`, `sprite` (`string` — a `ui:sprite.<name>` atlas key), `style`, `ref`, `debugName`.

`Sprite` is a native animated primitive: its atlas (a pow2 texture holding a grid of frames) is baked into the pak, and the Rust core cycles the frame cells per vblank — deterministic and with **zero per-frame JS**. It auto-plays from the first frame the moment it is displayed, so a sprite revealed by paging or a `Show`/`Lazy` starts animating on its own. Bake atlases by listing them in a demo's `sprites.json` (`{ "<atlas>.png": { cols, rows, frames, step } }`); `step` is vblanks per frame (fps = 60/step). See `apps/gallery` (its covers are shader-baked animated sprites).

### `Screen`

```ts
function Screen(props: ScreenProps): JSX.Element  // ScreenProps extends ViewProps
```

A full-screen root `View`. Defaults `class` to `"relative flex-col w-full h-full bg-slate-50 overflow-hidden"` when none is given.

### `Focusable`

```ts
interface FocusableProps extends ViewProps { onPress?: () => void }
function Focusable(props: FocusableProps): JSX.Element
```

A `View` with `focusable: true`. Use `onPress` for the CIRCLE action.

### `FocusScope`

```ts
interface FocusScopeProps extends ViewProps, FocusScopeOptions {
  active?: boolean | (() => boolean);
}
function FocusScope(props: FocusScopeProps): JSX.Element
```

Restricts d-pad traversal and CIRCLE to its subtree while `active` (default `true`). Adds `autoFocus` / `restoreFocus` from `FocusScopeOptions`. Internally pushes/pops via `pushFocusScope`.

### `FocusGrid`

```ts
interface FocusGridProps extends ViewProps, FocusGridOptions {
  active?: boolean | (() => boolean);
}
function FocusGrid(props: FocusGridProps): JSX.Element
```

Gives its subtree row/column d-pad semantics while `active`. Requires `columns`; `wrap` (default `false`) wraps at row ends. Internally pushes/pops via `pushFocusGrid`.

### `ActionHandler`

```ts
interface ActionHandlerProps extends ButtonPressOptions {
  button: number;                                    // BTN mask
  onPress: (pressed: number, buttons: number) => void;
  children?: JSX.Element;
}
function ActionHandler(props: ActionHandlerProps): JSX.Element
```

Declarative wrapper over `onButtonPress`: fires `onPress` on the button edge.
Inherits `allowWhenBlocked`, `active`, and `latched` from
`ButtonPressOptions`. Renders `children` (or nothing).

### `Portal`

```ts
interface PortalProps { children?: JSX.Element | (() => JSX.Element) }
function Portal(props: PortalProps): JSX.Element
```

Renders `children` into the full-screen overlay root (above the app layer, `zIndex 1000`) instead of the local tree. Cleans up its host node on unmount.

### `Modal`

```ts
interface ModalProps {
  class?: string;
  panelClass?: string;
  open?: boolean | (() => boolean);
  children?: JSX.Element;
}
function Modal(props: ModalProps): JSX.Element
```

A portalled backdrop + focus-scoped panel. While `open`, it blocks background button handlers (`pushButtonHandlerBlock`) and fades/scales the panel in. `class` styles the centering frame; `panelClass` styles the panel.

### `Named`

```ts
function Named(props: { name: string; children?: JSX.Element }): JSX.Element
```

Tags the host nodes it renders with a semantic name for the
[DevTools](/docs/devtools/) component tree (`<Named name="MessageCard"><Card/></Named>`).
Renders no node of its own; a child's explicit `debugName` prop wins.

### `ActionBar`

```ts
function ActionBar(props: ActionBarProps): JSX.Element  // ActionBarProps extends ViewProps
```

A portalled bottom bar. Defaults to a pinned `left-3 right-3 bottom-3` row when no `class` is given.

### `Grid`

```ts
interface GridProps extends ViewProps, Partial<FocusGridOptions> {
  gap?: number;                            // cross-axis gap px (via style)
  active?: boolean | (() => boolean);      // enable FocusGrid traversal (needs columns)
}
function Grid(props: GridProps): JSX.Element
```

A wrapping tile layout (`flex-row flex-wrap`). With `columns` + `active` it delegates row/column d-pad traversal to [`FocusGrid`](#focusgrid); `columns` drives traversal only — layout stays flexbox. `gap` is a number so `class` can stay a single compiled literal.

### `Lazy`

```ts
interface LazyProps {
  when: boolean | (() => boolean);         // mount while truthy; destroy when false
  reveal?: number;                         // host frames to show fallback first (0)
  fallback?: JSX.Element | (() => JSX.Element);
  children: () => JSX.Element;             // deferred content factory
}
function Lazy(props: LazyProps): JSX.Element
```

On-demand mount: builds `children` only while `when` is truthy (the sweep destroys the subtree when it goes false). `reveal` shows `fallback` for N frames the first time it activates, then latches revealed for its lifetime (no replay). Models on-demand *content build* — textures are still uploaded eagerly at pak load.

### `Gallery`

```ts
interface GalleryProps {
  count: number;                           // total pages
  page: () => number;                      // controlled current-page accessor
  onPageChange?: (next: number) => void;
  renderPage: (index: number) => JSX.Element;  // called only for in-window pages
  window?: number;                         // pages kept mounted each side (1)
  duration?: number;                       // slide ms (300)
  easing?: EasingName;                     // slide easing ("out")
  bindTriggers?: boolean;                  // bind LTRIGGER/RTRIGGER (true)
  wrap?: boolean;                          // wrap past the ends (false)
  class?: string;                          // outer viewport class
}
function Gallery(props: GalleryProps): JSX.Element
```

A full-screen L/R-paged strip: `LTRIGGER`/`RTRIGGER` slide one whole screen at a time. Controlled (`page` + `onPageChange`); the slide is one native `translateX` tween per press (paint-only), and pages outside `window` are not built, keeping many-page galleries inside the draw budget. See `apps/gallery`.

### `DeepZoom` (Solid)

```ts
function DeepZoom(props: DeepZoomProps): JSX.Element
```

A streamed tiled-canvas viewer. It selects from a baked `TileDoc` pyramid,
keeps an overview beneath the active level, loads a bounded number of tiles per
frame, and releases generation-tagged texture handles outside the viewport.
D-pad/left-analog panning and trigger zoom are built in; `gestureSource` can
supply logical-coordinate pan/pinch gestures with an anchored zoom point.

| Prop | Type | Description |
| --- | --- | --- |
| `doc` | `TileDoc` | Baked document dimensions, background, tile edge, and resolution levels. |
| `width` / `height` | `number` | Logical viewport size (defaults to 480×272). |
| `loadBudget` | `number` | Maximum textured-tile uploads per frame (default `2`). |
| `prefetch` | `number` | Extra mounted tile ring (default `1`). |
| `bindInput` | `boolean` | Bind controller pan/zoom internally (default `true`). |
| `gestureSource` | `() => DeepZoomGesture \| null` | Optional direct-manipulation input for touch hosts. |
| `onView` | `(view: DeepZoomView) => void` | Observe deterministic center, zoom, and selected level. |

`DeepZoom` is currently exported by the Solid components adapter. The tile
wire format and texture-streaming HostOps remain framework-neutral.

## `solid-js`

Import Solid's reactive primitives and control-flow components directly from
`solid-js`. PocketJS relies on the real Solid runtime rather than wrapping or
curating these exports. Full docs live at
[solidjs.com](https://www.solidjs.com/docs/latest/api); summary below.

### Reactivity

| Export | Signature | Purpose |
| --- | --- | --- |
| `createSignal` | `createSignal<T>(value?, opts?) => [get: () => T, set: (v) => T]` | Reactive atom. |
| `createEffect` | `createEffect(fn: (prev) => T, value?) => void` | Run on dependency change. |
| `createMemo` | `createMemo(fn: (prev) => T, value?) => () => T` | Cached derived value. |
| `onMount` | `onMount(fn: () => void) => void` | Run once after first render. |
| `onCleanup` | `onCleanup(fn: () => void) => void` | Run on owner disposal. |
| `batch` | `batch(fn: () => T) => T` | Coalesce updates. |
| `untrack` | `untrack(fn: () => T) => T` | Read without tracking. |

See [Reactivity](/docs/reactivity/).

### Control flow

| Component | Usage | Purpose |
| --- | --- | --- |
| `Show` | `<Show when={cond} fallback={…}>…</Show>` | Conditional render. |
| `For` | `<For each={list}>{(item, i) => …}</For>` | List keyed by reference. |
| `Index` | `<Index each={list}>{(item, i) => …}</Index>` | List keyed by index. |
| `Switch` / `Match` | `<Switch fallback={…}><Match when={c}>…</Match></Switch>` | Multi-branch. |

PocketJS's renderer maps these updates onto the native tree, but the component
APIs and semantics are Solid's.

## `vue`

Vue Vapor apps import Vue's Composition API directly from `vue`; PocketJS does
not wrap refs, computed values, effects, or component definitions. Use
`@pocketjs/framework/vue-vapor/components` explicitly, or set
`framework: "vue-vapor"` and import generic `@pocketjs/framework/components`.

---

## `@pocketjs/framework/animation`

Typed motion over `ops.animate`. JS declares the tween once; the Rust core
advances it in exact `dt = 1/60 s` ticks. `prop` is a spec `PROP` name and must
be animatable (e.g. `opacity`, `translateY`, `scale`, and color props) —
non-animatable props throw. See [Animation](/docs/animation/).

### `animate`

```ts
function animate(
  node: NodeMirror | number,
  prop: PropName,
  to: number | string,
  opts?: AnimateOptions,
): number   // returns animId
```

Tweens `prop` from its current value to `to`. For color props, `to` is a packed u32 ABGR or a `'#rrggbb'` / `'#rrggbbaa'` string. Returns an animId for `cancelAnim`.

**`AnimateOptions`**

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `dur` | `number` | `200` | Duration in ms (ignored by spring easings). |
| `easing` | `EasingName \| number` | `"out"` | Named easing or raw `ENUMS.Easing` ordinal. |
| `delay` | `number` | `0` | Delay in ms before the tween starts. |

**`EasingName`** — `"linear" | "in" | "out" | "in-out" | "out-back" | "spring" | "spring-bouncy"`.

### `spring`

```ts
function spring(
  node: NodeMirror | number,
  prop: PropName,
  to: number | string,
  preset?: "default" | "bouncy",
): number
```

Springs `prop` to `to`; duration comes from the physics, not a timer. `preset` (default `"default"`) selects the base or bouncy spring. Returns an animId.

### `cancelAnim`

```ts
function cancelAnim(animId: number): void
```

Stops a running animation by the id `animate`/`spring` returned.

---

## `@pocketjs/framework/lifecycle`

Component-scoped per-frame hooks. Registrations clean up with the selected
framework owner (`onCleanup` in Solid, `onScopeDispose` in Vue Vapor). See
[Reactivity](/docs/reactivity/) and [Input & focus](/docs/input-focus/).

### `onFrame`

```ts
function onFrame(callback: (buttons: number) => void): void
```

Registers `callback` to run once per host frame with the current spec `BTN` bitmask.

### Analog input

```ts
function analogX(): number
function analogY(): number
function analogRaw(): number
```

`analogX` and `analogY` return the current left stick/nub axis in `-1..1`
after PocketJS's shared deadzone (`right` and `down` are positive).
`analogRaw` returns the host word `(x << 8) | y`, with each byte in `0..255`
and `128` at center. Stickless hosts stay centered, so controller fallbacks do
not need target checks. Solid and Vue Vapor expose the same functions from
their lifecycle subpaths.

### `onButtonPress`

```ts
function onButtonPress(
  mask: number,
  callback: (pressed: number, buttons: number) => void,
  opts?: ButtonPressOptions,
): void
```

Edge-detects a button: fires `callback` on the frame a button in `mask` transitions from up to down. `pressed` is the just-pressed bitmask; `buttons` is the full held mask.

**`ButtonPressOptions`**

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `allowWhenBlocked` | `boolean` | `false` | Keep firing while a modal/system block owns input. |
| `active` | `boolean \| (() => boolean)` | `true` | Gate the handler on/off. |
| `latched` | `boolean` | `false` | Require the button to be observed released before the next edge can fire; prevents a held opener from re-triggering a newly mounted screen. |

### `createSpriteAnimation`

```ts
function createSpriteAnimation(
  frames: readonly string[],
  opts?: SpriteAnimationOptions,
): Accessor<string> | ComputedRef<string>
```

Cycles through `frames` (image `src` keys), returning a Solid `Accessor` or a
Vue Vapor `ComputedRef` for the current frame. Throws if `frames` is empty.
`opts.frameStep` (default `1`, min `1`) holds each sprite frame for that many
host frames.

### `pushButtonHandlerBlock`

```ts
function pushButtonHandlerBlock(): () => void
```

Pushes a global block so background `onButtonPress` handlers (those without `allowWhenBlocked`) stop firing; the returned disposer pops it. `Modal` uses this internally.

---

## `@pocketjs/framework/input`

Programmatic focus, the button bitmask, and the imperative focus-scope/grid stack. Prefer the `FocusScope` / `FocusGrid` components in app code. See [Input & focus](/docs/input-focus/).

### `BTN`

PSP button bitmask (identical on every host; web/Bun hosts remap keys).

| Member | Value | Member | Value |
| --- | --- | --- | --- |
| `SELECT` | `0x0001` | `LTRIGGER` | `0x0100` |
| `START` | `0x0008` | `RTRIGGER` | `0x0200` |
| `UP` | `0x0010` | `TRIANGLE` | `0x1000` |
| `RIGHT` | `0x0020` | `CIRCLE` | `0x2000` |
| `DOWN` | `0x0040` | `CROSS` | `0x4000` |
| `LEFT` | `0x0080` | `SQUARE` | `0x8000` |

### `touches`

```ts
interface TouchContact { readonly id: number; readonly x: number; readonly y: number }
function touches(): readonly TouchContact[]
```

Returns an immutable snapshot of the current front-panel contacts. Coordinates
are always logical PocketJS pixels, independent of the target raster density;
at most eight contacts are delivered. No active touch is an empty snapshot,
not an unavailable API. Declare `input.touch` in `pocket.json` and guard an
optional enhancement with `hasFeature("input.touch")`.

### `focusNode`

```ts
function focusNode(node: NodeMirror | null): void
```

Programmatically focus a node (or clear focus with `null`). Applies the native `focus:` style variant.

### `getFocused`

```ts
function getFocused(): NodeMirror | null
```

Returns the currently focused node, or `null`.

### `pushFocusScope`

```ts
function pushFocusScope(node: NodeMirror, opts?: FocusScopeOptions): () => void
```

Restricts d-pad traversal and CIRCLE to `node`'s subtree; returns a disposer that pops the scope and restores prior focus. Backs the `FocusScope` component.

**`FocusScopeOptions`**

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `autoFocus` | `boolean` | `true` | Focus the first focusable on push. |
| `restoreFocus` | `boolean` | `true` | Restore the previously focused node on pop. |

### `pushFocusGrid`

```ts
function pushFocusGrid(node: NodeMirror, opts: FocusGridOptions): () => void
```

Gives `node`'s subtree row/column d-pad semantics; returns a disposer that pops the grid. Backs the `FocusGrid` component.

**`FocusGridOptions`**

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `columns` | `number` | — | Grid column count (min `1`). Required. |
| `wrap` | `boolean` | `false` | Wrap focus at row ends. |

---

## `@pocketjs/framework/platform`

```ts
const platform: {
  readonly target: string;
  readonly pixelRatio: number;
  readonly features: Readonly<Partial<Record<PocketCapabilityId, boolean>>>;
};
function hasFeature(feature: PocketCapabilityId): boolean
```

The manifest compiler defines the target-specific constants consumed by this
module. `pixelRatio` is
physical raster samples per logical pixel (`1` on PSP, `2` on Vita), useful for
runtime-created textures; it never changes layout coordinates. Literal
`hasFeature("…")` calls are folded to booleans during the PocketJS compile, so
an unavailable enhancement branch can leave the bundle. Computed ids use the
frozen runtime map.

## `@pocketjs/framework/clock`

| Export | Purpose |
| --- | --- |
| `simulationHz()` | Active virtual-frame rate selected by the host. |
| `ticksPerFrame()` | Exact core ticks advanced per virtual frame. |
| `virtualFrame()` | Deterministic frame index. |
| `virtualNow()` | Virtual seconds since boot. |
| `after(seconds, callback)` | Schedule on the virtual clock; returns a disposer. |

Use these instead of wall-clock timers for deterministic app behavior. The
host may run at 60 Hz or a lower exact divisor while the same elapsed virtual
time produces the same trajectory.

## `@pocketjs/framework/effects`

```ts
type EffectDriver = (command: EffectCommand, deliver: (result: unknown) => void) => void;
function installEffectDriver(driver: EffectDriver): void
function runEffect<T>(kind: string, payload: unknown, onResult: (result: T) => void): number
```

`runEffect` emits an outside-world command; its driver can complete at any
time, but PocketJS delivers the result only at the next frame boundary. This
callback surface deliberately avoids promise/microtask timing in deterministic
journeys. A host-injected `globalThis.__pocketEffectDriver` overrides the app
driver for replay and simulation.

## `@pocketjs/framework/hot`

```ts
function text(node: NodeMirror | undefined, value: string | number): void
function prop(node: NodeMirror | undefined, name: PropName, value: number): void
```

An imperative, last-value-gated escape hatch for high-frequency HUD updates.
Do not bind the same value reactively as well. Prefer paint-only transforms to
layout properties and keep hot text inside a fixed-size cell.

## `@pocketjs/framework/manifest`

This is the stable build/custom-host boundary:

| Export | Purpose |
| --- | --- |
| `POCKET_MANIFEST_SCHEMA_ID` / `POCKET_MANIFEST_VERSION` | Canonical format-2 identity. |
| `pocketManifestV2Schema` / `validatePocketManifest` | Strict schema and structured diagnostics. |
| `extractHostBuildInputs(plan, options?)` | Verify a plan checksum and project it onto stable native-host inputs. |
| `hostBuildEnvironment(inputs, options)` | Produce the target-neutral Cargo environment for a custom host. |
| `vitaTitleId(applicationId)` | Deterministically derive a stable Vita Title ID. |

The complete `ResolvedBuildPlan` is internal build IR. Custom hosts should
consume `HostBuildInputs` rather than retaining or reinterpreting the plan.
See [Platform contracts](/docs/platform-contracts/).

---

Try any of these live in the [playground](/playground/), or start from [Getting started](/docs/getting-started/).
