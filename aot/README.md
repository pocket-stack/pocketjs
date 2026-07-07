# @pocketjs/aot

**Write cartridge RPGs in TypeScript and JSX; ship console-native tiles, sprites, palettes, and bytecode for GBA, Game Boy, NES, 3DS, and DS.**

`@pocketjs/aot` is a first-class PocketJS architecture that coexists with `@pocketjs/framework`. Where the framework runs a live Solid/Vue reactive UI on PSP-class hardware, `@pocketjs/aot` goes *below the runtime line*: it **partially evaluates** a TypeScript/JSX game program at build time and emits a small fixed native runtime plus binary game data — per console. No JS engine, no Solid, no VDOM ships on any cartridge.

> TypeScript and JSX are the authoring language. Partial evaluation is the compiler strategy. Console-native tile/sprite data and bytecode are the runtime artifact. **One game source compiles to `.gba`, `.gb`, `.nes`, `.3dsx`, and `.nds`.**

This is not a TypeScript-to-console compiler. It is a domain-aware partial evaluator for a constrained RPG DSL (design: `pocketjs_gba_partial_evaluation_design.md`).

## Status

Five targets run the same games end to end, verified by one cross-target E2E contract:

- **GBA** — arm-none-eabi-gcc runtime, PJGB chunk cartridge, headless libmgba harness. Header logo/checksum pass for real hardware.
- **Game Boy (DMG)** — GBDK-2020/SDCC runtime, MBC5 autobanked data, window textbox with STAT-safe typewriter glyph streaming, headless mGBA GB core.
- **NES** — cc65/UNROM runtime with CHR-RAM, custom crt0 + NMI-owned VRAM update buffer, nametable-overlay textbox, headless jsnes harness.
- **Nintendo 3DS** — devkitARM/libctru `.3dsx` homebrew. The flat-address ARM11 lets it ship the *exact* GBA lowering (same PJGB blob, 4bpp/BGR555) and render it **in software**, split across both screens: the world owns the top screen at 2x, dialogue/choices own the bottom screen so text never covers the map. The renderer core is platform-free, so the E2E harness drives the identical code as a host dylib over Bun FFI (`test/harness/host_runner.ts`); a real `.3dsx` boot is verified through Azahar's RPC memory interface (`test/harness/azahar_probe.ts`).
- **Nintendo DS (NTR)** — BlocksDS `.nds` homebrew, arm9-only against BlocksDS's default ARM7, combined by ndstool. The DS 2D hardware is "GBA x2" (same 4bpp tiles + BGR555 screen entries), so it ships the GBA lowering and renders it in **hardware** across both engines: the MAIN engine drives the world on the top screen as a 128x96 viewport scaled 2x to fill the panel (extended-affine BG + affine double-size sprites), the SUB engine drives the textbox/choices on the bottom screen, streaming glyph tiles into a slot region per page (GBA-style — a 10-bit tile index can't address a whole CJK store). Logic is verified via the shared host-dylib harness (`test/harness/host_runner.ts`, driving the same software renderer the 3DS ships); the `.nds` **boots on a real DS Lite from a stock-kernel R4 clone** (see the flashcart-compatibility notes below). **This is how the same game reaches a DS Lite** — a DS Lite cannot run a 3DS `.3dsx`, but it runs this `.nds` natively.

The same `demo/game.tsx` (Pokemon-like town) passes the identical scenario suite on all five (`test/e2e-multi.ts`), and `demo-shendiao/` — a 神雕侠侣 fan mini-RPG with a title-screen chapter select, three story segments, CJK dialogue, choices, items, flags, and a scripted turn-based boss battle — passes a full-story suite on all five (`test/e2e-shendiao.ts`).

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
       3ds: reuse the GBA PJGB blob verbatim -> software renderer core
            -> devkitARM/libctru .3dsx (+ host dylib for the harness)
       nds: reuse the GBA PJGB blob verbatim -> libnds dual-engine HW render
            (2x-scaled affine world) -> BlocksDS arm9 + default arm7 -> ndstool .nds
  -> emulator harnesses drive input + assert a fixed RAM debug block
       mGBA (gba + gb, test/harness/mgba_runner.c) / jsnes (nes, nes_runner.ts)
       / host-dylib FFI (3ds + nds, test/harness/host_runner.ts)
```

The **two zones** (design §8) are unchanged: the static declaration zone (`defineGame`/`defineMap`/`<Npc>`…) is executed at build time; the residual script zone (`script(function*(){ yield say(...) })`) is never executed — the compiler lowers the generator AST to bytecode for a small suspendable stack VM that each console runtime implements identically (ops: text/choice/flags/vars/compare/rnd/warp/while-loops…).

**The cross-target contract is the E2E suite**: every runtime writes the same debug block layout to a fixed RAM address (GBA EWRAM / GB WRAM 0xDE00 / NES $0700 / 3DS+DS the exported `pj_debug_ram`), and one scenario script drives the same logical playthrough through each console's emulator or host core.

## Text: cjk16 mode

Dialogue in 神雕旧事 is Chinese, rendered from **GNU Unifont** 16x16 bitmaps. The compiler bakes only the glyphs a game actually uses (~220 for the demo), wraps and paginates every string per target at build time, and each runtime streams glyph tiles on demand into a reserved VRAM/CHR-RAM slot region (a Game Boy has nowhere near enough VRAM for a static CJK font — this is how commercial-era CJK carts did it too). ASCII-only games on GBA keep the legacy 8x8 Inter-rasterized font (`textMode: "ascii8"`).

## The 神雕旧事 demo (`demo-shendiao/`)

A fan-made (同人) mini-RPG: the title screen auto-opens a chapter menu (剑冢神雕 / 断肠之约 / 襄阳大战 / 问世间情); each segment is a few minutes of exploration, dialogue, choices, and — in 襄阳大战 — a fully scripted turn-based boss battle written as a `while` loop over HP/气 vars in the DSL. Completing all three unlocks a short epilogue. All dialogue is original text written for the demo. Art is generated with `bun imagegen` (see `skills/pocketjs-gba-imagegen`) and deterministically quantized per target (`demo-shendiao/imagegen/build-assets.ts`).

## Build & test

```bash
# prerequisites: bun, arm-none-eabi-gcc + binutils, mgba (libmgba),
#                GBDK-2020 (~/.pocketjs/toolchains/gbdk or $GBDK_HOME), cc65,
#                3ds: devkitARM + libctru (~/.pocketjs/toolchains/devkitpro or $DEVKITPRO),
#                nds: BlocksDS (~/.pocketjs/toolchains/wonderful or $WONDERFUL_TOOLCHAIN).
#                PJ_3DS_HOST_ONLY=1 / PJ_NDS_HOST_ONLY=1 build only the harness dylib
bun aot/spec/gen-c.ts                # regenerate per-target pjgb_gen.h
bash aot/test/harness/build.sh       # build the headless mGBA runner (once)
cd aot
bun run build                        # pocket-town .gba (also: build:gb, build:nes, build:3ds, build:nds)
bun run shendiao                     # 神雕旧事 .gba + .gb + .nes  (also: shendiao:3ds, shendiao:nds)
bun run test                         # legacy GBA suite (19 assertions)
bun run test:all                     # cross-target: pocket-town (54) + 神雕 full story (69)
bun run test:3ds                     # 3ds host-dylib suite: pocket-town (18) + 神雕 (23)
bun run test:nds                     # nds host-dylib suite: pocket-town (18) + 神雕 (23)
```

Outputs land in `aot/dist/`: `pocket-town.{gba,gb,nes,3dsx,nds}`, `shendiao.{gba,gb,nes,3dsx,nds}`, plus per-build `.ir.json` / `.debug.json` (symbol maps for the harnesses) and `dist/shots/*.ppm` screenshots from E2E runs. Each `.3dsx`/`.nds` ships alongside a `.host.dylib` (the same core, host-compiled) that the FFI harness ticks.

### Running a `.3dsx` on real hardware / Azahar

The `.3dsx` files run on a modded 3DS (via the Homebrew Launcher) or in [Azahar](https://github.com/azahar-emu/azahar) (Citra's successor). To reproduce the on-device boot check the harness performs: enable Azahar's RPC server (Emulation → Configure → Debug → *Enable RPC server*), launch a game, then `bun aot/test/harness/azahar_probe.ts aot/dist/shendiao.elf` reads the live debug block over UDP (port 45987) and asserts the game booted and its main loop is ticking on the emulated ARM11.

### Running a `.nds` on real hardware / a DS or DS Lite

The `.nds` files are ordinary DS ROMs: copy `shendiao.nds` to any **Slot-1 flashcart** (R4 and the like) and launch it from the cart menu on a DS, DS Lite, DSi, or 3DS — no console modding required. They also run in [melonDS](https://melonds.kuribo64.net/) / DeSmuME. Controls: d-pad to walk, **A** to talk/confirm, **START+SELECT** to exit. The world is on the top screen, dialogue on the bottom. (A DS Lite cannot run the 3DS `.3dsx` — the `.nds` is the build that reaches that hardware.)

#### Old-flashcart compatibility (why the .nds is packaged the way it is)

Verified end-to-end on a DS Lite with a stock-kernel **R4 SDHC GOLD Pro 2020** (r4isdhc.com, a DSTTi "DEMON" clone) — one of the least homebrew-friendly loaders around. Four packaging decisions, each fixing a real boot failure on that hardware:

1. **BlocksDS, not devkitPro/calico.** calico's libnds runs its DLDI driver on a background ARM7 thread that legacy flashcart loaders never hand off to — the loader shows the ROM's banner, then hangs at "Loading…" forever. BlocksDS (non-calico libnds + its own default ARM7) boots.
2. **Classic `-h 0x200` NTR homebrew header.** With the modern 0x4000 layout (ARM9 at the retail secure-area offset), DSTT-family loaders classify the ROM as *retail*, look its game code up in their `infolib.dat` patch database, find nothing, and die with `load rom errcode=-4`. ARM9 at 0x200 routes them onto their homebrew path. (Trade-off: 0x200 ROMs don't boot in DSi mode — irrelevant for DS-mode flashcarts.)
3. **File padded to the header's declared chip capacity** (128KB << capacity byte). Loaders read by declared size; emulators merely warn (`bad ROM size … rounded`), real carts can fail the read.
4. **Valid game code + header CRC.** BlocksDS's ndstool leaves the header CRC unset and defaults the game code to `####`; the backend stamps a derived code (e.g. `PSHE`) and recomputes the CRC-16.

No DLDI pre-patching: the game links all cart data and does no SD I/O, and a pre-applied DLDI section makes some loaders' own patcher error out.

One hardware note for the curious: DS/GBA BG VRAM silently drops 8-bit writes — the runtime's 4bpp→8bpp tile expansion (for the extended-affine scaled BG) stores composed `u16`s only (`runtime/nds/render_ds.c`).

## Real hardware

- **GBA**: the ROM header gets the BIOS-required logo bitmap, title, and complement checksum (`compiler/rom.ts`) — flashcart-ready.
- **GB**: GBDK-2020's `makebin` emits a valid MBC5 header (logo included) — flashcart-ready.
- **NES**: standard iNES (mapper 2/UNROM + CHR-RAM), the best-supported discrete-mapper profile on flashcarts and emulators.
- **DS**: a standard `.nds` with a valid header + banner/icon (via ndstool), runnable from any Slot-1 flashcart on DS/DS Lite/DSi/3DS.
- **3DS**: `.3dsx` homebrew for a CFW console's Homebrew Launcher, with an SMDH icon/title.

## v1 scope & follow-ups

Still deliberately narrow (design §5, §26): 8x8 BG tiles, one tileset per game, 16x16 sprites (2 walk frames player / 1 NPC on 8-bit targets), ≤32x32 maps (≤32x30 on NES, which does not scroll in v1), stubbed `giveItem`/`battle` ops (the demo's battle is fully scripted in the DSL instead). Not yet: audio, save media, tile animation, NPC movement kinds, TMX/Aseprite import, GBC color pass.
