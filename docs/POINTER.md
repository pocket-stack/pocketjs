# Real pointer input

`input.pointer` is the framework-owned path for a mouse or trackpad. It is
separate from `input.cursor`: a real pointer supplies absolute logical
coordinates and ordered host edges; the virtual cursor integrates a nub and
owns a framework-rendered sprite.

## Frame contract

Hosts keep the four legacy tracks and append one versioned extension:

```ts
frame(buttons, analog, touches, touchHits, {
  v: 1,
  pointer: [
    [POINTER_EVENT.MOVE, x, y],
    [POINTER_EVENT.DOWN, x, y, 0, modifiers],
    [POINTER_EVENT.UP, x, y, 0, modifiers],
  ],
});
```

The fifth argument is the only extension point for new frame-input families.
Version 1's `pointer` value is an ordered batch. Coordinates are finite JS
numbers in logical viewport pixels; they are not packed, so the
`macos-widget` 4096x4096 viewport remains exact. Button `0` is primary and
modifier bit `1` is Shift.

Events, not sampled levels, are authoritative:

- `MOVE` enters/moves and performs hover-to-focus.
- `DOWN` arms the focusable under the point and applies `active:`.
- `UP` over the armed node fires its bubbling `onPress`; release elsewhere
  cancels the click.
- `LEAVE` clears hover and the active look while retaining capture, allowing a
  held pointer to re-enter.
- `CANCEL` (focus loss, host-owned window drag, device loss) clears capture
  without firing.

`DOWN` followed by `UP` in one batch is a complete fast click and fires once.
The framework reads the host's live `__viewport` for every position event, so
resizes cannot retain stale bounds.

Applications that need lower-level gestures read `pointerEvents()` from
`@pocketjs/framework/input`. Focus, `active:`, and `onPress` remain automatic;
apps do not synthesize button masks or call cursor sprite operations.

## Native hosts and replay

`pocket-mod::Guest::frame_with_input` is the native QuickJS bridge. Its
`FrameInput` and `PointerEvent` types preserve event order and full-resolution
coordinates. `note-widget` is the stock receipt: winit mouse input reaches the
framework through this method, while Note reads the same events for caret and
drag selection.

The flight recorder stores non-empty fifth-argument payloads as the sparse
v3 tape `input` track. Replay owns that track and scrubs live pointer hardware;
v1/v2 tapes replay with no pointer events. Hit results are derived again from
the same committed layout, as touch replay already does for omitted hit facts.
