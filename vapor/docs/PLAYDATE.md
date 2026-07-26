# Pocket Vapor Playdate target

Status: implementation design; no Playdate runtime exists yet.

This document defines the first implementation of Playdate as a fixed,
first-class Pocket Vapor AOT target. It is intentionally not a PocketJS
`guest` host: the device artifact contains generated native C,
`vapor_core.c`, and a small Playdate hardware runtime. It contains no
QuickJS, JavaScript interpreter, garbage collector, or general-purpose
allocator.

The target follows the same split as GBA, GB, NES, and ESP32:

```text
Vue Vapor TSX
  -> vapor/compiler
  -> gen_app.c
  +  vapor/runtime/vapor_core.c
  +  vapor/runtime/playdate/*
  -> Playdate C toolchain
  -> pdex.bin / simulator library
  -> .pdx
```

## Goals

- Compile the existing strict Pocket Vapor TypeScript subset to a native
  Playdate `.pdx`.
- Render the logical cell grid directly through the Playdate SDK framebuffer
  API.
- Preserve the shared `vapor.h` application/runtime contract.
- Keep memory statically planned: no VM, GC, or heap is introduced.
- Make unsupported input and style requirements visible at compile time.
- Support both Playdate Simulator and physical-device builds.
- Provide enough runtime telemetry to diagnose boot, input, paint, and screen
  commit failures on hardware.

## Non-goals for the first target

- The full retained PocketJS DrawList UI runtime.
- QuickJS or portable guest bundles.
- Arbitrary pixels, images, sprites, sound, networking, or saves.
- Runtime fonts or Unicode beyond the existing Pocket Vapor ASCII font.
- Pretending that Playdate has Start, Select, L, or R buttons.
- Grayscale simulation that silently changes the two-style rendering
  contract.
- Crank support before it has a compiler-visible host API and parity tests.

## Target contract

Playdate has a fixed 400x240 one-bit display. The initial target uses the
existing 8x8 font as a 50x30 cell grid:

```text
400 / 8 = 50 columns
240 / 8 = 30 rows
```

Proposed target entry:

```ts
playdate: {
  name: "playdate",
  width: 50,
  height: 30,
  poolCap: 32,
  strCap: 24,
}
```

This geometry deliberately fits the existing dirty-row representation:
`vp_rows_dirty` is a `u32`, so 30 logical rows require no ABI change.

Runtime-owned grid memory is small and fixed:

```text
vp_grid_ch:  50 * 30 = 1500 bytes
vp_grid_pal: 50 * 30 = 1500 bytes
font:        95 * 8  =  760 bytes
```

The style contract is `styles2`, shared with GB and NES:

- style 0: dark ink on light paper;
- style 1: light ink on dark paper.

Every Tailwind `(ink, paper)` pair lowers by luminance polarity through
`vp_pal_style`. Distinct color pairs that become indistinguishable continue
to produce `VS104`; `--strict` promotes that loss to a build failure.

## Runtime ownership

`vapor_core.c` remains target-independent and owns:

- the character and palette grids;
- row composition and dirty-bit tracking;
- bounded strings and list views;
- tripwire state.

Generated `gen_app.c` continues to own:

- refs and computed caches;
- fixed collection pools;
- reactive dependency masks;
- paint effects;
- button handlers;
- application debug-state serialization.

The Playdate runtime owns only the hardware boundary:

- `eventHandler()` and lifecycle events;
- the Playdate update callback;
- physical input edge sampling;
- dirty-row framebuffer commits;
- target identity/build receipt logging;
- Simulator/device packaging.

No Playdate-specific operation should enter `vapor_core.c` unless a second
target demonstrates that it is a shared runtime concern.

## Runtime lifecycle

The device entry point is the SDK C event handler:

```c
int eventHandler(PlaydateAPI *playdate, PDSystemEvent event, uint32_t arg);
```

On `kEventInit`, the runtime must:

1. store the `PlaydateAPI*`;
2. validate compile-time geometry assumptions;
3. clear the logical grid;
4. call `app_init()` to seed state and paint the first logical frame;
5. call `app_flush()` to preserve the shared boot sequence;
6. commit the complete first frame to the SDK framebuffer;
7. set the nominal refresh rate to 30 Hz;
8. install the native update callback;
9. log a machine-readable ready receipt.

One update callback performs exactly one Vapor turn:

```text
sample pushed buttons
  -> normalize to shared Button ids
  -> app_on_button() once per pushed edge
  -> app_flush()
  -> commit vp_rows_dirty to the framebuffer
  -> update counters/tripwire receipt
```

Input is dispatched before `app_flush()` so all edges observed in one
Playdate update batch into one reactive flush. Rendering follows the flush
so the screen commit always corresponds to the current logical grid.

Pause, resume, lock, unlock, terminate, low-power, and Mirror events must be
logged from `eventHandler()`. The first implementation may not need custom
behavior for every event, but it must not silently discard an event that
invalidates screen or input state. Resume and Mirror transitions should
force a full framebuffer commit until hardware testing proves a narrower
policy correct.

## One-bit framebuffer renderer

The renderer must use the raw framebuffer interface, not
`graphics->setPixel()`:

```c
uint8_t *frame = pd->graphics->getFrame();
pd->graphics->markUpdatedRows(first, last);
```

The SDK framebuffer contract is:

- 400 visible pixels per row;
- 52-byte row stride, with two padding bytes;
- pixels ordered most-significant bit first;
- `markUpdatedRows(start, end)` includes both endpoints.

The 50-column grid maps particularly well to that representation: each 8x8
cell contributes exactly one visible byte to each of eight physical rows.

For logical cell `(x, y)` and glyph scanline `gy`:

```text
glyph index  = vp_grid_ch[y][x] - 0x20
font byte    = vp_font_tiles[glyph index * 8 + gy]
style        = vp_pal_style[vp_grid_pal[y][x]]
physical y   = y * 8 + gy
destination  = frame + physical_y * 52 + x
```

The output byte is the glyph byte in one style and its inverse in the other.
The concrete bit polarity must be centralized in one helper and locked by a
Simulator pixel test plus one physical-device visual test. It must not be
spread through the runtime or inferred independently by different tests.

The renderer must validate character and palette indices before indexing
generated tables. Invalid data is a runtime contract violation: log the
coordinates and values, set a dedicated tripwire/diagnostic state, and stop
the update loop in debug builds. Do not substitute a blank glyph.

### Dirty rows

Each dirty logical row maps to eight physical rows:

```text
logical y -> [y * 8, y * 8 + 7]
```

The initial implementation should:

1. snapshot `vp_rows_dirty`;
2. render every logical row present in that snapshot;
3. call `markUpdatedRows()` for each contiguous physical run;
4. clear only the bits that were successfully rendered.

Calling once per contiguous run preserves disjoint damage without adding
complex rectangle tracking. A full redraw is the explicit mask covering
rows `[0, VP_GRID_H)`.

Framebuffer acquisition failure, impossible geometry, or a dirty bit above
`VP_GRID_H` must fail visibly. Dirty state must never be cleared before the
corresponding bytes have been written.

Required compile-time checks include:

```c
_Static_assert(VP_GRID_W == 50, "Playdate requires a 50-column 8px grid");
_Static_assert(VP_GRID_H == 30, "Playdate requires a 30-row 8px grid");
_Static_assert(VP_GRID_H <= 32, "dirty-row mask overflow");
```

The two stride padding bytes must remain untouched.

## Generated font and styles

Playdate can reuse the one-byte-per-scanline font encoding currently emitted
for ESP32. The implementation should rename the emitter by representation,
not duplicate it under another target name:

```text
emitFontEsp32() -> emitFont1bpp()
```

Both ESP32 and Playdate then consume `95 * 8` bytes. Playdate target data is:

```c
const u8 vp_font_tiles[] = { /* 95 * 8 bytes */ };
const u8 vp_pal_style[] = { /* pair id -> 0 or 1 */ };
```

The memory-plan report must count the Playdate font as 760 bytes and the
style data as one byte per pair. Target-data emission must have an explicit
`playdate` switch arm; falling through to another target's format is a
compiler error.

## Input

The first Playdate target directly exposes:

- D-pad Up, Down, Left, Right;
- A;
- B.

They map to the existing shared IDs:

```text
A=0, B=1, Right=4, Left=5, Up=6, Down=7
```

The SDK's pushed-button snapshot should be used so the platform remains the
authority for press edges. If current-state polling is required for a future
feature, its edge detector must reset on lock/resume to prevent synthetic
presses.

Playdate does not provide ordinary game inputs corresponding to Select,
Start, R, or L. The compiler/check matrix must therefore reject a Playdate
artifact whose derived button demands require unsupported inputs. The
runtime must not invent undocumented chords or map the system Menu button.

The current Todo example uses Start and Select, so it is not the first
Playdate acceptance application without a source-level Playdate-compatible
input branch. Add a small six-button parity fixture rather than weakening
input admission to make Todo compile.

Crank support is a second feature. It should enter the authoring model as a
real host API such as `onCrank()`, lower to a generated C hook, and gain
oracle/device parity coverage. Mapping crank motion to a fake Pocket button
or analog axis is out of scope.

## Build and package integration

The Playdate SDK supports two native outputs from the same C sources:

- an OS-native Simulator library;
- an ARM device `pdex.bin`.

The build integration should use the SDK's supported CMake configuration,
including `C_API/buildsupport/arm.cmake` for device builds. The generated
project must include:

- `gen_app.c`;
- `vapor_core.c`;
- the Playdate runtime sources;
- SDK headers;
- generated `pdxinfo`.

`vapor/compiler/playdate.ts` should own deterministic build staging:

```text
dist/vapor/gen-playdate/
  CMakeLists.txt
  Source/
    gen_app.c
    pdxinfo
  build-simulator/
  build-device/
```

Runtime sources should be referenced from the repository, not copied into
generated output. Generated files must include a source-derived build ID so
a stale `.pdx` can identify itself.

Build modes must be explicit:

- `simulator`: build and package the native Simulator library;
- `device`: cross-compile and package `pdex.bin`;
- `both`: produce a `.pdx` containing both validated outputs.

A requested mode is successful only if its expected binary exists and is
non-empty. A device build must not return a Simulator-only package, and vice
versa.

The current `buildRom(...): { romBytes }` API does not accurately describe
an ESP32 firmware or a `.pdx` directory. Before adding Playdate, generalize
the outer API to an artifact result:

```ts
interface BuiltArtifact {
  path: string;
  kind: "rom" | "firmware" | "pdx";
  bytes: number;
}
```

Keep the existing target-specific builders, but dispatch through
`buildArtifact()` so CLI output and tests do not call a `.pdx` a ROM.

`PLAYDATE_SDK_PATH` resolution must be singular and observable. An explicit
invalid path is an error; the builder must not silently fall back to another
installed SDK. The resolved SDK path and SDK version should appear once in
build diagnostics.

## Observability and debug receipt

Simulator success alone is insufficient. The runtime should emit stable,
machine-readable log records through `playdate->system->logToConsole()`:

```text
PVREADY target=playdate build=<id> grid=50x30
PVFRAME frame=<n> flush=<n> dirty=<hex> rows=<first>..<last> trips=<hex>
PVERROR stage=<stage> code=<code> detail=<...>
```

`PVREADY` is mandatory after the first framebuffer commit. `PVFRAME` may be
rate-limited in release builds, but counters must remain available on
demand. Fatal errors must include the lifecycle/build stage that failed.

The target should preserve the existing logical debug receipt:

- frame count;
- flush count;
- tripwires;
- generated application debug state;
- logical character grid;
- logical palette grid;
- build ID.

A serial-message command protocol can expose reset, synthetic button press,
and grid dump operations for Simulator and opt-in device parity tests. It
must remain debug-only and must not change ordinary physical input behavior.

## Verification

### Compiler tests without the SDK

- `VAPOR_TARGETS.playdate` is exactly 50x30 with the pinned budgets.
- Playdate emits 760 bytes of 1bpp font data.
- Playdate emits `vp_pal_style` and no RGB palette tables.
- `STYLE_CAPS.playdate` uses `styles2`.
- lossy color pairs produce `VS104`, and `--strict` fails.
- generated Playdate C is deterministic.
- the memory-plan report counts the correct font/style bytes.
- unsupported physical-button demands fail Playdate admission.

### Pure renderer tests

The byte writer should be a small C unit with no global SDK dependency. A
fake framebuffer test must verify:

- normal and inverse glyph bytes;
- MSB-left pixel ordering;
- exact 52-byte stride;
- untouched padding bytes;
- 50x30 boundary cells;
- disjoint dirty-row runs;
- full first paint;
- invalid glyph/palette failure.

### Simulator smoke

- build a Simulator `.pdx`;
- launch it with the Playdate Simulator;
- observe `PVREADY`;
- inject six-button input;
- compare the dumped logical grid after every input with the Vue oracle;
- capture the framebuffer and compare the actual one-bit pixels.

### Device verification

- build the same application as `pdex.bin`;
- run it on physical hardware;
- verify the build ID receipt;
- replay the six-button tape;
- compare logical grid receipts with the oracle;
- manually verify framebuffer polarity and orientation;
- verify resume, lock/unlock, Mirror, and full-redraw behavior;
- run long enough to prove counters and tripwires remain stable.

The stock target is not complete until both logical parity and actual screen
pixels have been verified. A logical-grid-only receipt cannot detect a
reversed bit polarity or incorrect framebuffer stride.

## File plan

### Add

| Path | Responsibility |
| --- | --- |
| `vapor/runtime/playdate/vapor_playdate.c` | SDK lifecycle, update callback, input dispatch, diagnostics |
| `vapor/runtime/playdate/framebuffer.c` | Pure 1bpp cell-grid renderer and dirty-row commit planning |
| `vapor/runtime/playdate/framebuffer.h` | Testable renderer contract |
| `vapor/runtime/playdate/CMakeLists.txt` | Static Playdate runtime build template |
| `vapor/runtime/playdate/pdxinfo.in` | Package metadata template |
| `vapor/runtime/playdate/README.md` | SDK prerequisites, commands, artifact layout, hardware checklist |
| `vapor/compiler/playdate.ts` | Generated project, SDK resolution, Simulator/device build and `.pdx` validation |
| `vapor/scripts/playdate.ts` | Explicit build/run/verify developer workflow |
| `vapor/examples/playdate-six-button/playdate-six-button.tsx` | Input-compatible oracle/device parity fixture |
| `vapor/tests/playdate.test.ts` | Target data, builder, admission, and renderer fixture tests |

### Modify

| Path | Change |
| --- | --- |
| `vapor/compiler/compile.ts` | Add target/profile, shared 1bpp font emission, Playdate target data and memory accounting |
| `vapor/compiler/styles.ts` | Add the Playdate `styles2` contract |
| `vapor/compiler/rom.ts` | Generalize artifact dispatch and add the Playdate builder |
| `vapor/compiler/cli.ts` | Add target/usage/artifact reporting |
| `vapor/runtime/vapor.h` | Document Playdate generated data; keep hooks unchanged |
| `vapor/host/input.ts` | Document Playdate direct inputs; add shared admission data only if it remains target-neutral |
| `vapor/host/screen.ts` | Document the 50x30 target geometry |
| `vapor/scripts/dev.ts` | Add Playdate oracle preview geometry/style |
| `vapor/tests/compiler.test.ts` | Pin target profile and generated data |
| `vapor/tests/styles.test.ts` | Pin two-style Playdate lowering |
| `vapor/README.md` | Add Playdate commands, artifact, and target status |
| `vapor/DESIGN.md` | Add Playdate to the AOT target and style-contract tables |
| `package.json` | Add `vapor:playdate`, Simulator, and verify commands |

## Implementation order

1. Add the compiler profile, `styles2` lowering, 1bpp target data, and
   SDK-independent tests.
2. Add the pure framebuffer writer and run its desktop unit tests.
3. Add `vapor_playdate.c` lifecycle/input integration.
4. Add deterministic CMake staging and build a Simulator `.pdx`.
5. Establish oracle-to-Simulator logical and pixel parity.
6. Cross-compile `pdex.bin` and validate on physical hardware.
7. Add the debug serial receipt and opt-in device tape.
8. Update target documentation only with claims backed by the completed
   verification stages.

## Acceptance criteria

The initial Playdate target is complete when:

- `check` reports a truthful Playdate row;
- a six-button Pocket Vapor application compiles to native C;
- Simulator and device artifacts are independently validated;
- the first frame and subsequent dirty rows render through `getFrame()` and
  `markUpdatedRows()`;
- normal/inverse styles match the oracle and physical screen;
- every input step matches the Vue Vapor oracle;
- unsupported buttons fail before toolchain invocation;
- boot and fatal failures identify their stage in logs;
- no QuickJS, interpreter, GC, or allocator is linked into the `.pdx`.

## Primary references

- [Pocket Vapor design](../DESIGN.md)
- [AOT board/target split](../BOARDS.md)
- [Shared runtime contract](../runtime/vapor.h)
- [Playdate C API 3.1.1](https://sdk.play.date/3.1.1/Inside%20Playdate%20with%20C.html)

