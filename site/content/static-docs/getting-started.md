# Getting started

## Prerequisites

- [bun](https://bun.sh)
- `arm-none-eabi-gcc` (GBA), `sdcc` (Game Boy), `cc65` (NES)
- `mgba` and `rgbds` from Homebrew (headless emulator + header fixer)

```sh
brew install --cask gcc-arm-embedded   # or brew install arm-none-eabi-gcc
brew install sdcc cc65 mgba rgbds
cd static && bun install
```

## Build the launch game

```sh
cd static
bun -e '
import { compileGame } from "./compiler/index.ts";
import { buildGba } from "./compiler/targets/gba.ts";
const out = await compileGame("games/boardroom/game.ts", "gba");
await buildGba(out.linked, "dist/boardroom.gba");
'
open dist/boardroom.gba   # any GBA emulator
```

Swap `buildGba`/`"gba"` for `buildGb`/`"gb"` or `buildNes`/`"nes"` and the
same module becomes a Game Boy or NES cartridge.

## Run the test pyramid

```sh
bun test .                       # vm semantics, script compiler, pipeline
bun test/harness/build.ts        # build the libmgba runner (once)
bun test/e2e.ts                  # smoke game, 35 assertions x 3 consoles
bun games/boardroom/test/e2e.ts  # the full story, 17 checkpoints x 3
```

The E2E suites read a fixed debug block over each emulator's bus — no
screenshots are asserted, only logical state, which is why one suite can
referee three consoles.

## A minimal game

```ts
import { defineGame, defineMap, defineSprite, defineTileset, npc, script } from "@pocketjs/static/rpg";

const tiles = defineTileset("town", { palette: [[16,18,22],[92,148,252],[56,56,72]], tiles: {
  floor: { px: ["11111111","11111111","11111111","11111111","11111111","11111111","11111111","11111111"] },
  wall: { px: ["22222222","22222222","22222222","22222222","22222222","22222222","22222222","22222222"], solid: true },
}});

const hero = defineSprite("hero", { palette: [[0,0,0],[248,248,248]], facings: {
  down: [Array.from({ length: 16 }, () => "1".repeat(16))],
  up: [Array.from({ length: 16 }, () => "1".repeat(16))],
  right: [Array.from({ length: 16 }, () => "1".repeat(16))],
}});

const Hello = script(function* (s, v, f) {
  yield* s.say("It works on three consoles.");
});

defineGame({
  title: "HELLO",
  start: "town:door",
  player: hero,
  maps: [defineMap("town", {
    tileset: tiles,
    layout: `
      ########
      #......#
      ########
    `,
    legend: { "#": "wall", ".": "floor" },
    entrances: { door: { at: [2, 1], dir: "right" } },
    actors: [npc("sign", { sprite: hero, at: [5, 1], talk: Hello })],
  })],
});
