# Pocket Vapor Playdate runtime

This directory is the native Playdate hardware boundary for Pocket Vapor.
It links generated `gen_app.c` and the shared `vapor_core.c` directly into a
Playdate C application. No JavaScript engine, interpreter, GC, or PocketJS
guest host is involved.

## Prerequisites

- Playdate SDK, resolved from an explicit `PLAYDATE_SDK_PATH` or the first
  `SDKRoot` entry in `~/.Playdate/config`
- CMake
- a platform C compiler for Simulator builds
- `arm-none-eabi-gcc` for device builds

Build through the compiler so SDK resolution, build identity, staging, and
artifact validation stay observable:

```sh
bun vapor/compiler/cli.ts vapor/examples/todo/todo.playdate.tsx \
  --target playdate --playdate-mode simulator

bun vapor/compiler/cli.ts vapor/examples/todo/todo.playdate.tsx \
  --target playdate --playdate-mode device
```

`both` produces two independent packages. Playdate loads either a native
Simulator library or a device binary from a package, so the target never
claims that one `.pdx` contains both:

```text
dist/vapor/todo.playdate.playdate-simulator.pdx
dist/vapor/todo.playdate.playdate-device.pdx
```

The renderer writes the SDK's 52-byte-stride framebuffer directly. Only the
first 50 bytes of each physical row are visible and modified. Invalid
character/palette data or framebuffer acquisition failure sets
`VP_TRIP_PLATFORM_RENDER`, logs `PVERROR`, preserves dirty state, and stops
the update loop instead of substituting fallback pixels.

The crank implements the shared `RelativeAxis.Primary` capability. The
runtime samples `getCrankChange()` and forwards signed millidegrees without
choosing an interaction detent. Fractional sub-millidegree motion is retained
between frames. Clockwise is positive. The Todo application, rather than the
runtime, chooses a 45-degree list detent. Docked and lifecycle-reset motion is
drained so it cannot reappear as a ghost event. Buttons and relative-axis
input are dispatched before one batched `app_flush()` per update.

Runtime receipts:

```text
PVREADY target=playdate build=<id> grid=50x30 ...
PVFRAME frame=<n> flush=<n> commit=<n> trips=<mask>
PVINPUT axis=primary delta_mdeg=<n> raw_mdeg=<n> sub_mdeg_x1000=<n> event=<n>
PVERROR stage=<stage> code=<code> ...
```

The checked-in fake-framebuffer test verifies byte layout. A physical-device
smoke is still required before claiming display polarity, lifecycle redraws,
or hardware input parity are verified.

## Manual acceptance checklist

Build and open the Simulator package:

```sh
bun run vapor:playdate
```

The Simulator supports dragging its crank control or using a mouse/trackpad
scroll wheel (see the
[official Simulator controls](https://help.play.date/manual/simulator/)).
Validate the following:

1. Boot shows `PLAYDATE VAPOR TODO`, three seed rows, `2 LEFT / ALL`, and no
   `PVERROR`.
2. Extend the crank. Clockwise motion moves the selection down; anti-clockwise
   moves it up. The Todo moves once per 45 degrees; slower partial turns
   accumulate instead of being lost.
3. Stow the crank, rotate/scroll, then extend it again. No delayed cursor jump
   should occur.
4. In list mode: A toggles completion, B deletes, Right cycles the filter, Up
   opens the editor, and Down clears completed todos.
5. In edit mode: Left/Right select the glyph, A inserts, B backspaces, Up
   saves, and Down cancels. Crank motion must not move the hidden list cursor.
6. Pause/resume or lock/unlock. The full screen should redraw without
   corruption or a synthetic crank step.
7. Console output should contain `PVREADY`, `PVINPUT` with signed
   millidegrees, and `PVFRAME` after paints; `trips` remains zero.

For hardware, build `bun run vapor:playdate:device`, sideload the resulting
device `.pdx`, and repeat the same sequence. Simulator success is not a
substitute for checking physical screen polarity and crank feel.
