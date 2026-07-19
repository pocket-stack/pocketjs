# Pocket Static — design

**Pocket Static** (`@pocketjs/static`) is the static game compiler of the Pocket
family: you write a game as TypeScript — declarations that run at build time,
and generator functions that *never* run at all — and the compiler partially
evaluates the whole program down to a real cartridge ROM. One game source,
three consoles: **GBA, Game Boy, NES**.

It replaces `@pocketjs/aot` (the `aot/` package). "AOT" described a compiler
technique; "Static" describes the product promise: everything dynamic about
your game — layout, text wrapping, palettes, branching story logic — is
resolved statically, and only a tiny fixed interpreter ships on cartridge.
Think static-site generator, but the deploy target is 1989.

Prior art studied and deliberately not reused (fresh implementation, same
lessons): PR #52 (`aspiring-birch`, multi-target aot), and the
cine → saga → edge GBA DSL lineage.

## 1. The one idea

A game is two zones:

- **Declaration zone** — `defineGame`, `defineMap`, `defineSprite`,
  `defineTileset`: plain TypeScript, executed on the host at build time,
  filling a registry. Anything you can compute in TS is free.
- **Script zone** — `script(function* (s) { ... })`: generator functions that
  are **compiled, never executed**. The compiler lowers each generator body
  from its TypeScript AST into bytecode for a small **stack VM** that every
  target implements.

The stack VM is the portability layer. The same bytecode, byte for byte, runs
on an ARM7TDMI, an SM83, and a 6502 — because the interpreter is ~600 lines of
portable C compiled by `arm-none-eabi-gcc`, `sdcc`, and `cc65` respectively.
The E2E suite drives the same scenario through all three consoles and asserts
identical logical state.

Where PR #52's residualizer accepted only a rigid statement whitelist
(`yield op(...)`, `if (yield pred)`, choose-then-switch), Pocket Static ships
a **real expression compiler** over a typed TS subset (§5). That is the core
"完成度" upgrade: scripts read like normal TypeScript.

## 2. Categories

The framework is *category-extensible*. A **category** is a game genre package
that plugs into the shared core. The core owns: the VM (generic opcodes
0x00–0x3F), the script compiler, text encoding/wrapping, the asset encoders,
blob/bank layout, target toolchain drivers, and the debug-block/E2E contract.

A category contributes:

1. **Syscall table** (`spec/<cat>.ts`) — opcodes 0x40+ with operand layouts.
2. **DSL surface** (`<cat>/dsl.ts`) — `define*` builders + typed script ops.
3. **Model builder** (compiler stage) — DSL registry → binary records.
4. **Portable runtime module** (`<cat>/runtime/*.c`) — implements the
   syscalls + per-frame gameplay against the platform HAL.
5. **Budgets** — per-target limits checked at compile time.

v1 ships the **RPG** category. Sketches to prove the seams (not built):

- **Visual Novel** — RPG minus maps/movement: SAY/CHOICE/portrait syscalls
  and a backdrop model. Strict subset of RPG's runtime surface.
- **Platformer** — a physics core in the category runtime; the VM scripts
  cutscenes/triggers while the category owns per-frame simulation (the
  saga/edge `world()`/`action()` blocking-op pattern: the script yields into
  an engine mode and resumes with a result).

## 3. Targets

| | GBA | GB (DMG) | NES |
|---|---|---|---|
| CPU | ARM7TDMI 16.8MHz | SM83 4.19MHz | 6502 1.79MHz |
| Toolchain | arm-none-eabi-gcc | sdcc (SM83) + sdasgb/sdldgb + rgbfix | cc65/ca65/ld65 |
| Screen (tiles) | 30×20 | 20×18 | 32×30 |
| Tile format | 4bpp, 32B | 2bpp interleaved, 16B | 2bpp planar, 16B |
| BG palette | 16×16 BGR555 | BGP 4 shades | 4 subpal × 3 + backdrop, 16px attr blocks |
| OBJ (16×16 actor) | 1 OBJ, 4bpp, 15c | 2× 8×16 OBJ, 3 shades | 4× 8×8 OBJ, 3c/subpal |
| Cart | flat ROM, header checksum | MBC5, rgbfix header | UNROM (mapper 2) + CHR-RAM, iNES |
| Data access | flat pointers | banked, blob ≤ 16KB/bank | banked, blob ≤ 16KB/bank |
| Scroll | free | free | none in v1 (map = one nametable) |
| Emulator (E2E) | libmgba | libmgba | jsnes |
| Debug block | 0x02000000 (EWRAM) | 0xDD00 (WRAM) | 0x0700 (CPU RAM) |

Banking rule (GB/NES): the linker assigns each *blob* (a script bank, a text
bank, a map, a tile store) wholly into one 16KB bank; the runtime latches the
bank per access site. No blob may exceed 16KB (compile error). GBA ignores
banking (flat).

NES color: encoders map authored RGB to nearest entry of the canonical 64-color
NES master palette. GB: authored colors map to 4 shades by luma (per-asset
override allowed).

## 4. Core VM

Stack machine. u8 opcode + little-endian operands. All values are **i16**.
State (per running script): operand stack (16), locals (16 slots/frame), call
stack (4 frames). Globals: 256 flags (bitset), 64 vars (i16). One script runs
at a time (RPG v1; the category decides concurrency).

Core opcodes 0x00–0x3F (`spec/isa.ts` is the single source of truth; the
table below is illustrative):

```
END RET NOP
PUSH8 i8 / PUSH16 i16 / POP / DUP
JMP rel16 / JZ rel16 / JNZ rel16          rel measured from AFTER the operand
CALL u16 scriptId                          no args; locals fresh per frame
LDV u8 / STV u8                            global var
LDL u8 / STL u8                            local slot
FLAG u8 -> push / SETF u8 / CLRF u8        flags
ADD SUB MUL DIV MOD NEG                    signed 16-bit; DIV/MOD by 0 -> 0
EQ NE LT GT LE GE NOT
RND                                        pop n, push 0..n-1 (xorshift16, fixed boot seed)
WAIT                                       pop n, suspend n frames
```

`&&`/`||` compile to short-circuit jumps; there are no boolean binary ops in
the ISA. RNG advances **only per RND call** with a constant boot seed: the same
script produces the same story on all three consoles, and E2E can assert
RNG-dependent outcomes cross-target.

Suspension: SAY/CHOICE/WAIT (and future category ops) suspend the VM with a
reason; the main loop resumes it when the condition clears. The interpreter
runs bounded bursts (≤64 ops) per frame between suspensions.

RPG syscalls 0x40+:

```
SAY u16 textId                 textbox page; typewriter; suspend until A
CHOICE u8 n, u16 t0..t(n-1)    menu; suspend; push picked index
LOCK / RELEASE                 player input
FACE u8 slot                   actor faces player (0xFF = talking actor)
AVIS u8 slot, u8 visible       actor visibility (people *leave* in this story)
WARP u8 map, u8 x, u8 y, u8 dir
SFX u8 id                      square-wave blips (confirm/deny/damage/heal/fanfare)
```

Items and battles are **not** syscalls: items compile to reserved vars, and
battles are DSL library code (§5) compiled through the same generator
pipeline — menus via CHOICE, HP via vars. A whole battle system with zero
bespoke runtime is the framework's best demo.

## 5. The script compiler

Input: `script(function* (s) { ... })` bodies (TS AST). Output: bytecode.
Ops are typed methods on the `s` handle and are always invoked with `yield*`,
which gives exact return typing (`Generator<..., number>` for value ops):

```ts
const meeting = script(function* (s) {
  yield* s.say("ILYA: The board has decided.");
  let resolve = 3;
  while (resolve > 0) {
    const pick = yield* s.choose(["Push back", "Stay calm", "Check phone"]);
    if (pick === 0 && !(yield* s.flag("board_softened"))) {
      resolve -= 1 + (yield* s.rnd(2));
      yield* s.say(`Resolve: ${resolve}`);
    } else if (pick === 2) { yield* s.call(twitterScene); }
  }
});
```

Supported statically (compile error otherwise, with file:line):

- **Expressions**: i16 arithmetic (`+ - * / %`, unary `-`), comparisons,
  `! && ||` (short-circuit), parens, numeric/boolean/string literals,
  locals, `yield* s.<op>(...)` value ops. Constant subexpressions fold.
- **Locals**: `let/const` with initializers, assignment, `+=` family, `++/--`.
- **Control flow**: `if/else`, `while`, `for(;;)`, `break/continue`,
  `switch` over any i16 expression (numeric or choice-string case labels),
  plain `return`.
- **Subroutines**: `yield* s.call(otherScript)` → VM CALL (no arguments).
- **Macros (partial evaluation)**: `yield* helper(s, args)` where `helper` is
  a plain generator function *inlines* its body at the call site with
  parameters bound to compile-time constants (numbers, strings, arrays,
  objects). Member access on bound objects folds; `for...of` over bound
  arrays unrolls; `if` over a static condition drops the dead branch. This is
  how `rpg/battle.ts` specializes a battle per enemy definition.
- **Text interpolation**: template literals; `${...}` of static values fold
  into the string, `${...}` of runtime i16 expressions compile to a store
  into a scratch var + an inline format token the textbox renders as decimal
  digits (≤2 runtime slots per page).

Text is wrapped and paginated **per target at compile time** (28/18/28 cols ×
3/2/3 lines); the runtime never measures. `say()` emits one SAY per page.
Speaker prefixes are plain text ("SAM: ..."), resolved statically.

Correctness story: `vm/ref.ts` is a TypeScript reference interpreter of the
full ISA. Compiler unit tests execute compiled bytecode against scripted
syscall stubs and assert results — no emulator in the loop. The C VM then only
has to match `ref.ts`, which the cross-target E2E suite enforces.

## 6. RPG model & assets

Model records (all layouts in `spec/rpg.ts`, byte-exact across targets;
packaging differs per target — GBA parses a container, GB/NES get residualized
per-bank arrays):

- **Game**: title, start map/pos/dir, counts, text mode, font/box tile ids.
- **Map**: w×h ≤ 32×30, tile grid (u8 tile ids ≤ 256/target budget),
  collision bitmap, actors, warps, step triggers, onEnter script.
- **Actor**: tile pos, sprite id, facing, movement (static/wander), solid,
  onTalk script, initial visibility.
- **Sprite**: 16×16, 4 facings × 1–2 walk frames.
- **Text bank**: token streams (ASCII + newline + FMT var slots), deduped.
- **Script bank**: bytecode + u16 offset table.

Authoring (plain typed builders, no JSX — less machinery than aot's
jsx-runtime and reads just as well):

```ts
const hq = defineMap("hq", {
  tileset: office,
  layout: `
    ##########
    #....d...#
    #..______#
  `,
  legend: { "#": "wall", ".": "floor", d: "desk", _: "table" },
  actors: [npc("ilya", { sprite: ilya, at: [4, 2], talk: meeting })],
  warps: [warp({ at: [9, 1], to: "street:door" })],
  triggers: [trigger({ at: [2, 1], run: introScene, once: true })],
});
```

Art pipeline (three lanes, all producing the same neutral form — indexed-
palette hex-row tiles/frames in a generated `assets.generated.ts`):

1. **Procedural** placeholders (test smoke game; no network, deterministic).
2. **codex imagegen** — `codex exec` generates character/tileset source
   sheets (committed PNGs); a deterministic extractor (grid detection +
   per-cell quantize to the authored palette) emits the neutral form.
3. **PixelLab** (`api.pixellab.ai/v1`, key in root `.env`) — native-size
   pixel sprites with seeds; the SPECS + committed manifest.json discipline
   from cine/saga/edge.

Target encoders consume the neutral form: GBA packs 4bpp + BGR555 banks;
GB maps palette→shades by luma and packs interleaved 2bpp; NES packs planar
2bpp, clusters tile colors into ≤4 BG subpalettes with 16px attribute
consistency (compile error on conflict), and assigns sprites to OBJ subpalettes.
Font: a 95-glyph 8×8 ASCII bitmap font checked in as a neutral asset.

## 7. Runtimes

```
static/vm/core.c            portable interpreter (gcc/sdcc/cc65)
static/rpg/runtime/rpg.c    portable gameplay: grid movement (8px grid,
                            2px/frame), collision, actor update, interact,
                            warps/triggers, textbox/choice state machines,
                            syscall handlers — against the HAL below
static/runtime/<t>/*        the HAL: video (tiles/map/OBJ/scroll), input,
                            frame wait, textbox blit, SFX, debug mirror,
                            bank latch, crt0 + linker script / header
```

HAL is a small header of functions (`hal.h`): `hal_poll_input`,
`hal_vsync`, `hal_map_load`, `hal_tile_write`, `hal_obj_set`,
`hal_text_cell`, `hal_sfx`, `hal_data_ptr(blobId)` (bank latch),
`hal_debug_commit`. Per-target quirks live behind it:

- **GBA**: mode 0, BG0 map + BG1 textbox, shadow OAM DMA at vblank,
  crt0 ends `msr cpsr_c, #0x5F` (IRQ-enabled — the aot 0xDF hang lesson),
  header logo+checksum patched for real hardware.
- **GB**: BG + window textbox, STAT-safe VRAM writes (only during
  vblank/hblank budget), OAM via DMA routine in HRAM, MBC5 bank latch,
  rgbfix -v -m 0x19.
- **NES**: NMI owns PPU: OAM DMA + a bounded VRAM update queue drained in
  vblank; CHR-RAM glyph/tile upload at map load (rendering off); textbox is
  a nametable overlay with save/restore; UNROM bank latch (bus-conflict-safe
  table write); iNES header emitted by the compiler.

All gameplay decisions (movement, collision, script effects) happen in
portable code ⇒ logical state is cycle-exact identical across targets by
construction; only presentation differs.

## 8. Debug block & E2E

Every runtime mirrors the same 176-byte block to a fixed address each frame
(`spec/isa.ts` DBG; magic `PSDB`): booted, frame u32, player x/y/dir/map,
script id/active, text id/active, choice cursor, wait counter, rng state,
flags[32], vars[64×i16]. Harnesses read it over the emulated bus:

- `test/harness/mgba_runner.c` (libmgba via Homebrew; auto-detects GBA/GB
  core) — scenario JSON in: `advance/press/read/screenshot`; JSON out.
- `test/harness/nes_runner.ts` (jsnes, pure TS) — same protocol.

Suites: `test/vm.test.ts` (compiler ↔ ref VM, no emulator),
`test/e2e.ts` (smoke game × 3 targets — boot, walk, block, talk, choice,
flags, vars, battle-loop, warp, trigger, RNG determinism),
`games/boardroom/test/e2e.ts` (full-story playthrough × 3 targets).
Screenshots land as PNG in `dist/shots/` (harness PPM → PNG in Bun).

## 9. The launch game — BOARDROOM

`static/games/boardroom/` — *BOARDROOM: five days in November*. The
November 2023 OpenAI board crisis as a satirical-but-factual RPG (public
figures, public record, original dialogue; research dossier with sources in
`games/boardroom/dossier.md`, kept accurate on dates/quotes).

- **Ch.1 THE CALL** — Fri Nov 17. HQ office map. The Google Meet trigger:
  "not consistently candid." Play as Sam; talk to Mira, Greg (who quits:
  gains item RESIGNATION LETTER ×1).
- **Ch.2 THE WEEKEND** — negotiation maps (HQ boardroom, investors' calls),
  Emmett Shear arrives; wander NPC journalists.
- **Ch.3 THE LETTER** — employee floor; collect signatures (vars) to 743;
  Ilya flips ("I deeply regret..."), joins your side (AVIS + flag).
- **Ch.4 THE RETURN** — final "negotiation battle" vs THE BOARD (DSL battle
  library: RESOLVE as HP; moves TENDER OFFER / HEART EMOJI / EMPLOYEE
  LETTER), then the epilogue map + new board.

Art: codex-generated sheets (Sam, Greg, Ilya, Mira, Adam, Helen, Emmett,
Satya walkers + office/boardroom/street tilesets), PixelLab fallback,
committed with manifest.

## 10. Replacing aot/

- `git rm -r aot/`; `static/` supersedes it (PR notes "supersedes #52").
- `tsconfig.json`: drop `@pocketjs/aot*` aliases + `"aot"` include; add
  `@pocketjs/static*` + `"static"`.
- Site: `/aot/` product page + `site/content/aot-docs/*` →
  `/static/` page + fresh docs (overview, getting started, scripts,
  categories, targets, testing); `site/build.ts` screenshot copies point at
  `static/docs/*.png`; `site/home.html` copy updated.
- Root `scripts/gba-imagegen.ts` + `skills/pocketjs-gba-imagegen` → default
  paths point at `static/games/*/imagegen/`.
- `skills/pocketjs-release/SKILL.md`: "@pocketjs/aot stays private" →
  `@pocketjs/static`.

## 11. Budgets (compile-time errors, per target)

Maps ≤ 32 (≤32×30 tiles each); BG tiles ≤ 208 (GB/NES; 95 font + box + blank
reserved above that), ≤ 448 (GBA); sprites ≤ 12 × (4 dir × 2 frames); actors
≤ 16/map; flags ≤ 256; vars ≤ 64 (upper 16 reserved: items/scratch);
scripts ≤ 256, script blob ≤ 16KB/bank; texts ≤ 512; total ROM: GBA ≤ 4MB,
GB ≤ 512KB, NES ≤ 256KB PRG.

## 12. Out of scope v1 (explicit)

CJK text (cjk16 is proven in #52; the token format reserves the escape),
music (edge's DirectSound is GBA-only; square-wave SFX only), saves, NES
scrolling, metatiles, real-hardware verification (headers are
flashcart-correct; only emulators are in CI).
