# Deferred content

`@pocketjs/framework/resource-state` represents a value as **pending, ready or
error**. It has no transport or renderer dependency. `createResourceSlot()`
issues completion tickets; a superseded, duplicate or disposed completion is
rejected. The caller schedules requests and owns cancellation and native assets.

`@pocketjs/framework/resource` provides the Solid `ResourceBoundary` and
`ResourceImage` components. **Only the affected subtree shows a fallback.**
Rendering does not start IO, await a Promise or stop input and frame hooks.

```tsx
import { ResourceBoundary } from "@pocketjs/framework/resource";

<ResourceBoundary state={rowState} fallback={() => <RowSkeleton />}
  errorFallback={() => <UnavailableRow />}>
  {row => <DocumentRow value={row()} />}
</ResourceBoundary>
```

The application supplies lazy factories for its fallback and content. Ready
values update without remounting the content. Returning to pending disposes
that subtree. Preserve cached content by keeping its state ready while a
separate refresh is outstanding when that behavior is appropriate.

`ResourceImage` accepts the same state and fallback props for a
`{ handle, width, height }` texture. Its outer View keeps the application's
layout and clipping while the texture is unavailable. Dimensions describe the
texture envelope; a smaller outer View can crop padded pixels. **The image
borrows the texture handle**; its cache or resource owner calls `freeTexture`.

Low-level slots can publish during the existing bounded offload service pump.
The shared scheduler below instead stages raw completion data and materializes
it during its explicit frame step.
Text pages, table rows and image tiles use the same availability contract;
the application chooses their placeholder geometry. Animated skeletons should
use a shared animation clock or native animation, rather than one timer per row.

The state model is renderer-neutral. The UI boundary in this change supports
Solid; Vue Vapor and Octane boundary components are not implemented.

## Shared read scheduling

`@pocketjs/framework/resource-cache` exports `createResourceScheduler`. A scheduler
owns bounded collections of reproducible values. `state(input)` only reads the
cache. **Rendering never admits or starts a request.** A viewport/controller
calls `reconcile(demands)` and calls `scheduler.step()` once per frame, including
frames without network connectivity.

Each cache defines an explicit string identity, a maximum entry count, a cost
reservation, a bounded wire response, a read loader, a materializer and an
optional disposer. Equal keys share one entry and one request. Key construction
must include everything that changes the value: provider/account namespace,
source revision, layout/font version, zoom, tile coordinate, or output format.
Keys are at most 1,024 code units. Do not place credentials in keys. A cache
instance may itself provide a fixed namespace; clear it when that namespace changes.

```ts
import { createResourceScheduler } from "@pocketjs/framework/resource-cache";
import { offloadResource } from "@pocketjs/framework/resource-offload";
import { offload } from "@pocketjs/framework/offload";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createSignal, onCleanup } from "solid-js";

const io = offload();
const [version, changed] = createSignal(0);
const scheduler = createResourceScheduler({
  maxConcurrent: 4, startsPerFrame: 2, completionsPerFrame: 1,
  maxCollections: 4, available: () => io.connected() && io.pending() < 4,
});
const pages = scheduler.createCache({
  key: (input: { revision: string; page: number }) => `${input.revision}/${input.page}`,
  maxEntries: 8, maxCost: 8 * 8192, maxResponseBytes: 5000,
  cost: () => 8192,
  load: offloadResource(io, "document.page", JSON.stringify),
  materialize: (raw: string) => JSON.parse(raw) as { title: string },
  changed: () => changed(n => n + 1),
});
// In the controller, before scheduler.step():
pages.reconcile([{ input: { revision: "r7", page: 12 }, priority: 0, pin: true }]);
onFrame(() => scheduler.step());
onCleanup(() => scheduler.dispose());
// Supply this accessor to ResourceBoundary:
const state = () => { version(); return pages.state({ revision: "r7", page: 12 }); };
```

Use fixed notification lanes or per-visible-view signals for a large view; the
example uses one signal for one page. The planner owns each collection's working
set. Multiple views using that collection must merge their demands before
`reconcile`; separate collections share the scheduler's work budget but do not
deduplicate across collections. The read API does not create unbounded observers.

### Admission, execution and ownership

| Stage | Bound and owner |
| --- | --- |
| Desired working set | At most `maxEntries` demands; the application supplies visible entries before prefetch |
| Admission | Entry and cost budgets are checked before loading; pinned desired entries cannot be evicted |
| Dispatch | One shared `maxConcurrent` and `startsPerFrame`, across all collections |
| Wire completion | Only one string or Uint8Array response per active entry; `maxResponseBytes` checks UTF-16 bytes or binary byte length |
| Materialization | At most `completionsPerFrame` accepted completions per step, including failures |
| Rendering | Reads a pending/ready/error state; the existing boundary reserves fallback geometry |
| Eviction/replacement | Invalidates completion generation, cancels local interest, notifies readers, disposes the owned value |

**Raw completions remain charged against concurrency until materialization.**
A burst of network responses therefore cannot create a separate unbounded
upload queue. A loader may complete synchronously, but its value is still
materialized on a subsequent `step`. Late, duplicate, cancelled and disposed
completions never reach the materializer. A loader returning `false` declines
admission without consuming a slot or retry attempt.

Lower numerical priority runs first. Visible demand can cancel an outstanding
unpinned speculative read to recover credit. Work leaving the desired set is
cancelled; completed values can remain cached until eviction. Victims are
chosen from unpinned entries outside the working set first, then less important
speculative entries, with age breaking ties. Admission can return fewer entries
than requested; the missing ones retain their normal pending fallback. The
application can lower resolution or shrink its working set under pressure.

A cost is an application-declared upper bound, not an estimate discovered after
allocation. Include decoded data, native texture storage and the temporary old
plus replacement allocation when retaining a stale value. Raw response storage
is additionally bounded by `maxConcurrent * maxResponseBytes`. A materializer
must clean up any partial allocation if it throws. Returned values transfer
ownership to the cache; ResourceImage only borrows them until its state changes.
Disposers and notification callbacks must be bounded and must not recursively
mutate the cache. The scheduler does not own persistent storage.

The supplied `offloadResource` adapter accepts already serialized read payloads
and keeps offload's authenticated session and wire limits. A different loader
can use a companion transport or an on-device worker without changing cache or
UI code. It must provide the same nonwaiting admission/cancellation contract and
bounded immutable response ownership. It must not execute IO on the UI thread.

### Freshness and recovery

`invalidate(predicate)` fences outstanding reads and marks matching entries
stale. A ready value remains visible while the demanded entry is reacquired;
`snapshot()` exposes `stale`, `refreshing` and the last refresh error. Passing
`true` as the second argument discards the old value immediately. Use that form,
or `clear()`, when old content would be incorrect or unauthorized to display.
`maxAgeFrames` optionally expires demanded entries according to the UI frame
clock. Without it, freshness is explicit through revisions and invalidation.

Retries are per entry, with a bounded exponential frame delay and a finite
attempt count (defaults: three attempts, 30-frame initial delay, 300-frame cap).
One bad tile does not delay unrelated pages or commands. Explicit invalidation
resets the exhausted read. Reconnection policy belongs to the controller: retain
immutable revisioned assets, revalidate mutable listings, and reconcile current
selection with provider metadata. Transport session fencing alone does not prove
that cached content is current. Provider push events can invalidate a bounded
set of keys; the cache does not subscribe or reconstruct event streams.

**Commands do not enter the resource cache.** Save, delete, issue updates and
collaborative edits require operation IDs, revision checks and application-owned
conflict/recovery rules. Cancelling local interest does not roll back a provider
operation. A timeout after a command was sent can mean an unknown outcome.
Pocket Doc retains its draft journal and command path and can cancel speculative
reads to make room for user commands; this scheduler never replays those writes.

## Application coverage and limits

| Application | Reproducible resources | Application/provider responsibilities |
| --- | --- | --- |
| Map | Versioned map tiles, labels, bounded search pages, route snapshots | Projection, viewport/zoom demand, route computation, offline package policy |
| Document editor | File pages, document revisions, layout windows, glyph/code/table tiles | Local optimistic draft, operations/undo, conflict handling, collaborative ordering |
| Video browser | Feed pages, posters, subtitles, seek thumbnails | Continuous audio/video transport, decoding, timestamps, deadline/drop policy |
| Photo library | Album pages, thumbnails, screen-size image renditions, metadata | Originals, image decoding, orientation/color, edit transactions, export |
| Design canvas | Scene revision chunks, layer pages, raster tiles, font assets | Selection/drag preview, hit testing, scene consistency, collaboration operations |
| Issue tracker | Query pages, issue snapshots, avatars, attachment previews | Mutation queue, optimistic updates, authorization, conflict and subscription handling |

A revisioned tile and an editable model snapshot can share scheduling without
sharing identity or retention policy. Display geometry should be available
separately from expensive raster data so replacing a skeleton does not move
content. Pocket Doc uses an independent layout-window collection for this reason.

A continuous media stream is **not a sequence of cache refetches**. Video and
audio require a separate bounded stream contract with decoder ownership, clocks,
backpressure, seek generations and frame deadlines. This change supports the
browser surrounding a player; it does not add a 3DS video decoder. Collaborative
operation logs likewise need ordered delivery and resynchronization rather than
last-value caching. Multi-resource atomic reveal, persistent device caches and
provider invalidation subscriptions are not implemented by this scheduler.

The companion is the execution location and transport; the resource cache owns
reusable read values and their UI working set. The `createQuery` implementation
on the separate companion branch provides reactive per-query request/reply and
previous-value retention, while this scheduler adds shared admission, reuse,
priority, byte reservations and native-value disposal. No companion wire format
or daemon implementation is imported. A future adapter must preserve bounded
admission and frame delivery rather than adding another independent queue.

**These are work-count and memory contracts, not a proof of a 16.7 ms frame.**
JavaScript callbacks can still perform excessive computation. Loaders,
materializers, key functions and cost functions must be bounded; host decoding
and bulk IO remain off the UI thread. The configured collections and entry
counts also bound scheduler scans. A stronger device can increase those budgets
or run the provider locally in a worker while keeping the same guest model.

## Pocket Doc migration

Pocket Doc uses four collections: eight file pages, eight layout windows,
72 Markdown tiles and 20 text tiles. They share four active requests, two starts
and one materialization per frame. File/geometry demands precede visible text
and document textures, followed by directional prefetch. The application retains
its 12 physical row notification lanes and viewport planner. The framework owns
deduplication, generation checks, retries, admission, eviction and texture
release. Documents, SQLite drafts, Markdown layout and rasterization remain in
the Mac provider. No renderer ABI or companion protocol changes are required.
