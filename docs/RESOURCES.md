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

An offload completion may publish a resource state during the existing bounded
service pump. This adds no polling, chunk accumulator or request scheduler.
Text pages, table rows and image tiles use the same availability contract;
the application chooses their placeholder geometry. Animated skeletons should
use a shared animation clock or native animation, rather than one timer per row.

The state model is renderer-neutral. The UI boundary in this change supports
Solid; Vue Vapor and Octane boundary components are not implemented.
