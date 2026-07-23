# Boards: how the AOT target family scales

The MeowBit (PR #154) made Pocket Vapor's problem concrete: PocketJS just
built a capability system for PSP/Vita (`contracts/spec/platforms.ts`,
pocket.json v2), and the ESP32 fits none of its assumptions. This document
records the design that keeps both worlds honest as MCU boards multiply.

## Two execution classes, two admission machineries

The platform contract now names the split (`EXECUTION_CLASSES` in
`contracts/spec/platforms.ts`):

|  | `guest` | `aot` |
|---|---|---|
| what ships | one portable bundle | source, recompiled per device |
| runs on | the embedded JS engine of a stock host | bare metal; no JS engine exists |
| admission | runtime: manifest `requires` ⊆ target `capabilities` | compile time: derived demands ⊨ board profile |
| device registry | `POCKET_TARGETS` — an inventory of real, golden-tested hosts | board files — open-ended data, schema + verifier validated |
| identity | hostAbi + bundle | `esp32BuildId` — content hash of generated app + board definitions + runtime sources |

The guest registry is small on purpose and must stay that way: every entry
is a stock host somebody built, tested and goldens. That doctrine is exactly
wrong for MCUs — the cross product of chip × panel × input × RAM is
open-ended and mostly built by other people. Stretching capability ids over
it ("esp32.lcd.st7735") would burn the registry's own first rule: ids name
observable framework behavior, never hardware.

A pocket.json may declare which classes it ships as
(`execution.classes`, default `["guest"]`); the guest build resolver
refuses a manifest that ships no guest artifact (`execution.guestExcluded`).

## A board is data; the runtime contract stays code

`vapor/boards/<name>.json` is the devicetree of one device:

```jsonc
{
  "board": "meowbit",                    // = file name
  "title": "Xueersi/KittenBot MeowBit",
  "chip": "esp32",                       // selects runtime/esp32/
  "lcd": {
    "controller": "st7735",              // ili934x | st7789 | st7735
    "width": 160, "height": 128,
    "cell": [8, 7],                      // px per logical cell
    "madctl": 96,                        // panel orientation register
    "pins": { "sclk": 18, "mosi": 23, "cs": 5, "dc": 4, "rst": -1, "backlight": -1 }
  },
  "input": {
    "pins": { "up": 2, "down": 13, "left": 27, "right": 35, "a": 34, "b": 12 },
    "chorded": { "start": ["a","b"], "select": ["left","right"], "r": ["up","down"] },
    "absent": ["l"]
  }
}
```

`vapor/compiler/boards.ts` loads and validates it, then derives the compile
definitions the ESP-IDF build injects (`boardDefinitions`). Adding a device
means adding a JSON file — never editing the compiler or the C.

Two validation rules carry the weight:

- **Chords are pinned to the runtime.** The release-latch chord decoder is
  fixed in `runtime/esp32/vapor_esp32.c`; a board declares *which* of those
  chords its pad exposes, and validation rejects any pair that differs from
  the C. Data can describe the runtime; it cannot contradict it.
- **Coverage is total.** Every one of the ten Pocket buttons must have
  exactly one spelling per board: a direct pad key, a runtime chord, or an
  explicit `absent`. Silence is how coverage claims rot.

What deliberately stays code: the frame loop, the panel init sequences, the
chord decoder, the UART receipt protocol. A board file selects among
behaviors the runtime already has; it never programs new ones.

## Demands are derived, never authored

Guest apps hand-declare `requires` because the framework cannot always see
what they use. The AOT compiler *can* see: which buttons the keymaps and
handlers statically reference (`CompiledApp.buttonsUsed`), how many style
pairs the class DSL resolved, which `SCREEN` folds the layout takes, the
whole memory plan. So the demand block is compiler output:

```sh
bun vapor/compiler/cli.ts check app.tsx --json
# { targets: { esp32: { ok, grid, stylePairs, buttonsUsed, ... } },
#   boards:  { meowbit: { ok, issues: [...] } } }
```

Derived demands cannot lie, and they are per-target precise: code behind a
false `SCREEN` fold is never compiled, so an app that only uses `R` on the
GBA's wide layout doesn't demand `R` from a 20×18 board.

## The admission rule

`admitBoard(demands, board, grid)` is the whole aot-class admission rule:

| code | severity | meaning |
|---|---|---|
| VB101 | error | logical grid × cell size does not fit the panel |
| VB102 | error | app uses a button the board neither wires nor chords |
| VB103 | warn | button only reachable as a two-key chord — the VS104 of input |

`check` prints board rows in the same matrix as targets. Board rows inform;
they never fail the check — an app is not obligated to fit every board, the
verdict exists so a store, a CI, or a person can decide with facts.

## Identity and the registration gate

`esp32BuildId` hashes the generated app, the *derived* board definitions,
the runtime sources and sdkconfig. Two consequences:

- A board-file refactor that keeps the derived definitions byte-identical
  keeps every flashed device's identity (locked by a test in
  `tests/boards.test.ts`).
- The physical verifier (`vapor:esp32:verify`) refuses firmware whose
  receipt doesn't match the source-derived id — so "this board file works"
  is a claim with a receipt, not a vibe.

That receipt is the registration gate: a board file joins this directory
with a passing device-parity receipt, the same way a guest target joins
`POCKET_TARGETS` with goldens. Community boards without receipts can exist
anywhere; the schema and verifier make them cheap to trust when they arrive.

## What a store does with this (forward-looking)

A store never enumerates boards. It stores the app's derived demands and
lets the edge evaluate: the device's companion (the same Mac-side tooling
that flashes and verifies today) loads its board file, runs the admission
rule, then compiles from source with a pinned compiler version — cacheable
by `esp32BuildId` for popular (app, board, toolchain) triples. Web apps
don't enumerate monitors; they declare breakpoints and the client decides.
`SCREEN` folds are compile-time breakpoints, so the analogy is exact.

## Deliberately not built yet

- **Per-board grid geometry.** Today the `esp32` target owns 20×18 and the
  board must fit it. The second board with a different panel promotes
  geometry to a board field and turns `VAPOR_TARGETS.esp32` into a family.
- **Chord tables as data.** Needs the C decoder to read a generated table
  first; until then data is pinned to the runtime's fixed chords.
- **A build service.** Source + companion-local compile is enough until
  board count makes server-side `esp32BuildId` caching worth running.
