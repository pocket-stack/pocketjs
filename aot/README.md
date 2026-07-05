# @pocketjs/aot

**Write cartridge RPGs in TypeScript and JSX; ship console-native tiles, sprites, palettes, and bytecode for GBA, Game Boy, and NES.**

`@pocketjs/aot` is a first-class PocketJS architecture that coexists with `@pocketjs/framework`. Where the framework runs a live Solid/Vue reactive UI on PSP-class hardware, `@pocketjs/aot` goes *below the runtime line*: it **partially evaluates** a TypeScript/JSX game program at build time and emits a small fixed native runtime plus binary game data — per console. No JS engine, no Solid, no VDOM ships on any cartridge.

> TypeScript and JSX are the authoring language. Partial evaluation is the compiler strategy. Console-native tile/sprite data and bytecode are the runtime artifact. **One game source compiles to `.gba`, `.gb`, and `.nes`.**

This is not a TypeScript-to-console compiler. It is a domain-aware partial evaluator for a constrained RPG DSL (design: `pocketjs_gba_partial_evaluation_design.md`).

## Status

Three targets run the same games end to end, verified by one cross-target E2E contract:

- **GBA** — arm-none-eabi-gcc runtime, PJGB chunk cartridge, headless libmgba harness. Header logo/checksum pass for real hardware.
- **Game Boy (DMG)** — GBDK-2020/SDCC runtime, MBC5 autobanked data, window textbox with STAT-safe typewriter glyph streaming, headless mGBA GB core.
- **NES** — cc65/UNROM runtime with CHR-RAM, custom crt0 + NMI-owned VRAM update buffer, nametable-overlay textbox, headless jsnes harness.

The same `demo/game.tsx` (Pokemon-like town) passes the identical scenario suite on all three (`test/e2e-multi.ts`), and `demo-shendiao/` — a 神雕侠侣 fan mini-RPG with a title-screen chapter select, three story segments, CJK dialogue, choices, items, flags, and a scripted turn-based boss battle — passes a full-story suite on all three (`test/e2e-shendiao.ts`).

| ![gba](docs/town.png) | ![dialogue](docs/dialogue.png) | ![choice](docs/choice.png) |
|---|---|---|

## Architecture

```
Source TS/TSX (@pocketjs/aot DSL)
  -> evaluate      static JSX/declaration zone EXECUTED at build time  (compiler/evaluate.ts)
  -> collectAssets tilesets/sprites -> target-NEUTRAL pixel data       (compiler/assets.ts)
  -> residualize   script(function*(){...}) ASTs -> stack-VM bytecode  (compiler/script.ts)
                   (text is wrapped + paginated per target here)
  -> model         JSX scene trees -> concrete maps/actors/warps       (compiler/model.ts)
  -> target backend                                                    (compiler/targets/*)
       gba: 4bpp/BGR555 encode -> PJGB chunk blob -> link with arm-none-eabi-gcc
       gb:  DMG 2bpp encode -> autobanked gen_data C arrays -> GBDK-2020 lcc (MBC5)
       nes: planar 2bpp + NES palettes -> compiler-assigned UNROM banks
            + generated ld65 config/iNES header -> cc65/ld65
  -> emulator harnesses drive input + assert a fixed RAM debug block
       mGBA (gba + gb, test/harness/mgba_runner.c) / jsnes (nes, nes_runner.ts)
```

The **two zones** (design §8) are unchanged: the static declaration zone (`defineGame`/`defineMap`/`<Npc>`…) is executed at build time; the residual script zone (`script(function*(){ yield say(...) })`) is never executed — the compiler lowers the generator AST to bytecode for a small suspendable stack VM that each console runtime implements identically (ops: text/choice/flags/vars/compare/rnd/warp/while-loops…).

**The cross-target contract is the E2E suite**: every runtime writes the same debug block layout to a fixed RAM address (GBA EWRAM / GB WRAM 0xDE00 / NES $0700), and one scenario script drives the same logical playthrough through each console's emulator.

## Text: cjk16 mode

Dialogue in 神雕旧事 is Chinese, rendered from **GNU Unifont** 16x16 bitmaps. The compiler bakes only the glyphs a game actually uses (~220 for the demo), wraps and paginates every string per target at build time, and each runtime streams glyph tiles on demand into a reserved VRAM/CHR-RAM slot region (a Game Boy has nowhere near enough VRAM for a static CJK font — this is how commercial-era CJK carts did it too). ASCII-only games on GBA keep the legacy 8x8 Inter-rasterized font (`textMode: "ascii8"`).

## The 神雕旧事 demo (`demo-shendiao/`)

A fan-made (同人) mini-RPG: the title screen auto-opens a chapter menu (剑冢神雕 / 断肠之约 / 襄阳大战 / 问世间情); each segment is a few minutes of exploration, dialogue, choices, and — in 襄阳大战 — a fully scripted turn-based boss battle written as a `while` loop over HP/气 vars in the DSL. Completing all three unlocks a short epilogue. All dialogue is original text written for the demo. Art is generated with `bun imagegen` (see `skills/pocketjs-gba-imagegen`) and deterministically quantized per target (`demo-shendiao/imagegen/build-assets.ts`).

## Build & test

```bash
# prerequisites: bun, arm-none-eabi-gcc + binutils, mgba (libmgba),
#                GBDK-2020 (~/.pocketjs/toolchains/gbdk or $GBDK_HOME), cc65
bun aot/spec/gen-c.ts                # regenerate per-target pjgb_gen.h
bash aot/test/harness/build.sh       # build the headless mGBA runner (once)
cd aot
bun run build                        # pocket-town .gba (also: build:gb, build:nes)
bun run shendiao                     # 神雕旧事 .gba + .gb + .nes
bun run test                         # legacy GBA suite (19 assertions)
bun run test:all                     # cross-target: pocket-town (54) + 神雕 full story (69)
```

Outputs land in `aot/dist/`: `pocket-town.{gba,gb,nes}`, `shendiao.{gba,gb,nes}`, plus per-build `.ir.json` / `.debug.json` (symbol maps for the harnesses) and `dist/shots/*.ppm` screenshots from E2E runs.

## Real hardware

- **GBA**: the ROM header gets the BIOS-required logo bitmap, title, and complement checksum (`compiler/rom.ts`) — flashcart-ready.
- **GB**: GBDK-2020's `makebin` emits a valid MBC5 header (logo included) — flashcart-ready.
- **NES**: standard iNES (mapper 2/UNROM + CHR-RAM), the best-supported discrete-mapper profile on flashcarts and emulators.

## v1 scope & follow-ups

Still deliberately narrow (design §5, §26): 8x8 BG tiles, one tileset per game, 16x16 sprites (2 walk frames player / 1 NPC on 8-bit targets), ≤32x32 maps (≤32x30 on NES, which does not scroll in v1), stubbed `giveItem`/`battle` ops (the demo's battle is fully scripted in the DSL instead). Not yet: audio, save media, tile animation, NPC movement kinds, TMX/Aseprite import, GBC color pass.
