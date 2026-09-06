# Solid 2 native runtime

PocketJS pins **solid-js and @solidjs/universal 2.0.0-rc.6**, with
**babel-preset-solid 2.0.0-rc.2**. These are release candidates. The migration
follows the [upstream guide](https://v2.solidjs.com/migration/from-solid-1).
This is a coordinated renderer/compiler/runtime upgrade; external Solid 1 apps
must migrate their effects, lifecycle and package imports before updating the
PocketJS dependency. Vue Vapor and Octane keep their existing runtime paths.

## Frame delivery

Solid 2 stages ordinary signal writes. PocketJS controllers run in `latest()`
so successive input operations can read the staged state without forcing a
render after each setter. `runFrameHooks()` flushes after the controller phase;
the public frame handler flushes again after focus/press dispatch, before native
sweep and draw. **Signals and native properties commit within the same host
frame.** Physics reads the latest staged offset when integrating another step.
No controller needs its own microtask loop.

The compiler resolves Solid core, signals and universal renderer to the same
PocketJS-owned dependency graph, including for external application checkouts.
This prevents duplicated owners and cleanup registration across module copies.
The universal renderer uses zero-size, absolute, hit-transparent sentinels. Its
marked scalar-text adapter reuses the native text node; a counter update does
not allocate a replacement text node on every frame. Portal/auxiliary roots
are constructed under their component owner rather than an `onSettled` callback.

## Pocket Doc code patterns

| Concern | Before | After | Effect |
| --- | --- | --- | --- |
| Materialized reads | App maps, request tickets, row-specific cancellation and manual texture freeing | Four typed resource collections sharing one scheduler | Reuse, eviction, retries and completion budgets have one implementation |
| Native caret/animation effects | `createEffect(() => blink.setHeld(caretDragging()))` | `createEffect(caretDragging, held => blink.setHeld(held))` | Dependency reads are separated from native writes |
| Modal input blocking | Effect reads state, calls `onCleanup(pushTouchBlock())` | Compute returns blocked state; apply returns the release function | Lifetime follows the Solid 2 effect contract |
| Reply application | `batch(() => receive(reply))` | `receive(reply)` in the host frame | Default batching coalesces notifications before the frame's explicit commit |
| Previous memo value | `createMemo(previous => ..., initial)` | `createMemo<T>((previous = initial) => ...)` | Uses the v2 memo signature without another state signal |
| JSX/runtime ownership | `solid-js/universal`, DOM-oriented JSX type stand-in | `@solidjs/universal`, renderer-neutral `Element` | Removes the artificial global DOM Node declaration |
| Replay actions | Invoke a setter and immediately inspect native output | Guest-local action boundary uses `latest(run); flush()` | Tests exercise the same commit semantics as an input frame |
| Save/delete/draft operations | Explicit command IDs, local draft and provider journal | Same command protocol | No automatic mutation replay or collaborative-ordering claim |

For example, the modal lifetime is now:

```ts
import { createEffect } from "solid-js";
import { pushTouchBlock } from "@pocketjs/framework/gesture";

createEffect(
  () => !!store.menu() || store.mode() === "create",
  blocked => { if (blocked) return pushTouchBlock(); },
);
```

A cache definition replaces the app's request, ticket and disposal loops:

```ts
const tiles = scheduler.createCache({
  key: tileKey, maxEntries: 72, maxCost: 72 * 40960,
  maxResponseBytes: 5000, cost: () => 40960,
  load: offloadResource(io, "document.tile", JSON.stringify),
  materialize: decodeAndUploadOneTile,
  dispose: tile => getOps().freeTexture?.(tile.handle),
  changed: input => rowChanges.notify(input.row),
});
```

The async cache and the Solid async graph solve different parts of delivery.
Solid 2 `createMemo(() => promise)` and `Loading` work with the native renderer;
a renderer test verifies fallback, frame-hook progress while pending, and later
reveal. **Pocket Doc keeps explicit ResourceState boundaries for owned textures.**
A normal async boundary can retain its last committed branch during refresh;
that branch must not retain a handle the cache has evicted and freed. The
resource boundary preserves the cache's ready/pending/error and disposal rules.
Creating one Promise/RPC per rendered row would bypass shared admission and is
not the migration pattern. Async graph support alone does not cache IO, bound
uploads, implement collaboration, or accelerate rasterization.

## Measured changes

The same isolated 1,000-file corpus and **3,231-frame / 93-check replay** pass
before and after the Solid upgrade. Both versions reach four pending requests,
72 resident Markdown textures and 72 resource entries. The recorded inertial
scroll offsets match. The **839-frame QuickJS replay** also passes.

| Build | Guest JS bytes | Passing QuickJS stack check |
| --- | ---: | ---: |
| Original Pocket Doc / Solid 1 | 250,723 | 128 KiB |
| Shared resources / Solid 1 | 264,913 | 128 KiB |
| Shared resources / Solid 2 | See paired app's validation receipt | 192 KiB |

The Solid 2 application does not pass the former 128 KiB smoke limit. The 3DS
host already provides **384 KiB**; this upgrade does not raise that native limit.
The 192 KiB check still leaves a stricter validation target than the host's
configured limit. Bundle size and stack cost increased; the preserved scrolling
behavior does not establish a speedup or a physical 60 FPS result.

The measured benefits are retained interaction coverage and explicit shared
resource limits. The implementation benefits are fewer app-owned scheduling
paths, split effects, automatic write batching and a native async-graph path.
Hardware frame-time improvement is unmeasured. The new application binary needs
a separate device-install and interaction receipt.
