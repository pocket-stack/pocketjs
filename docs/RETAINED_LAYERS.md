# Retained raster layers

Status: accepted and implemented.

## Context

`Ui::draw()` deliberately produces one flat DrawList. That contract is simple
and deterministic, but a host cannot reuse subtree pixels when only the
subtree's screen translation changes. Re-rasterizing text during scrolling is
especially expensive on small no-JIT systems.

## Decision

Property id 143 is the append-only `rasterCache` integer property. A value of
`RasterCache.Retained` asks a capable host to cache that subtree as a
transparent raster surface. It is a hint: ordinary `Ui::draw()` stays flat and
pixel-compatible.

Capable hosts opt in with `Ui::draw_retained()`. It returns ordered
`RetainedPass` values:

- `Draw` contains regular content before or after a layer;
- `Layer` contains a layer-local DrawList, logical surface dimensions, screen
  translation, and the inherited screen clip.

Hosts must composite every pass in order. A layer's DrawList remains unchanged
when only its translation changes, so the host can keep pixels and update the
composition coordinates. Layer content changes are compatible with the normal
per-target `DamageTracker`; explicit-size ARGB surface raster functions avoid
pretending that the layer is a viewport-sized framebuffer.

The core currently retains translation-only 2D layer roots. Scale, rotation,
or perspective on a requested root falls back to the surrounding regular
DrawList. This preserves content until a host can implement those transforms
without forcing re-rasterization.

## Consequences

- The flat DrawList ABI and existing hosts do not change behavior.
- A retained host owns surface allocation, double buffering, damage trackers,
  and composition scheduling.
- Ordered regular passes can be transparent and sparse. `draw_list_coverage()`
  exposes conservative disjoint rectangles so a compositor can skip guaranteed
  transparent space without changing pixels.
- Retaining many or large subtrees can consume substantial memory; the hint is
  intentionally explicit rather than automatic.

## Rejected alternatives

- Moving a rectangle after rendering the flat frame does not avoid subtree
  raster work and cannot recover painter-order ownership.
- Making all transformed nodes implicit layers makes memory and scheduling
  costs unpredictable.
- Teaching the application to draw text through a platform-specific side path
  duplicates layout and font semantics outside PocketJS.

## Verification

- Core tests compare flat raster output with CPU composition of translated and
  clipped retained passes (maximum channel delta: one, from blend rounding).
- Translation-only tests assert that layer-local words remain stable while the
  composition coordinates change.
- Damage coverage tests verify conservative, disjoint painted regions.
