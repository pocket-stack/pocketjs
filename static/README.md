# Pocket Static

**Write a generator. Ship a cartridge.**

Pocket Static is the static game compiler of the Pocket family: a game is one
TypeScript module — declarations that run at build time, and generator
functions that *never run at all* — and the compiler partially evaluates the
whole thing down to real console ROMs. One source, three cartridges:
**Game Boy Advance, Game Boy, and NES.**

```ts
const GuideTalk = script(function* (s, v, f) {
  yield* s.say("GUIDE: New build! Want to spar?");
  if ((yield* s.choose(["Spar", "Later"])) === "Spar") {
    v.hp = 8; v.foe = 6;
    while (v.foe > 0 && v.hp > 0) {
      if ((yield* s.choose(["Strike", "Guard"])) === "Strike") {
        v.foe -= 2 + (yield* s.rnd(2));
      } else { v.hp += 1; }
      if (v.foe > 0) v.hp -= 1;
    }
    if (v.hp > 0) { f.beat_guide = true; yield* s.say(`You win with ${v.hp} HP left.`); }
  }
});
```

That script body is never executed. The compiler lowers it from its AST into
bytecode for a small stack VM whose interpreter is ~600 lines of portable C —
compiled by `arm-none-eabi-gcc`, `sdcc`, and `cc65` respectively. Locals,
arithmetic, `if/while/for/switch`, short-circuit `&&`/`||`, subroutine calls,
compile-time macro expansion, and `${...}` text interpolation all work the
way the TypeScript reads. Everything static — text wrapping, palettes, map
data, branching structure — is resolved at build time; only a fixed
interpreter ships.

The launch game is **BOARDROOM** (`games/boardroom/`): the November 2023
OpenAI board crisis as a five-day RPG, with a research dossier pinning every
quoted line to the public record. The finale's turn-based battle against THE
BOARD is `rpg/battle.ts` — a complete battle system written as compiler
macros, zero bespoke runtime.

## Determinism is the product

- The story RNG is a seeded xorshift16 advanced only by script `rnd()` calls:
  the same playthrough produces the same story on every console.
- `vm/ref.ts` is a host-side reference interpreter — the semantic golden.
  Compiler tests run against it with no emulator in the loop.
- Every runtime mirrors one debug block (same layout, fixed address) each
  frame. The E2E suites drive headless emulators (libmgba, jsnes) through
  identical scenarios and hold all three consoles to the reference VM's
  answers: the smoke suite is 35 assertions × 3 consoles, the BOARDROOM
  playthrough 17 checkpoints × 3.

## Layout

```
spec/       the contract: ISA, records, debug block, targets (gen-c.ts -> C)
vm/         reference interpreter + bytecode assembler/disassembler
compiler/   evaluate -> script compiler -> model -> link -> targets/{gba,gb,nes}
rpg/        the RPG category: DSL, battle macros, portable C engine
runtime/    core/ (portable vm.c + rpg.c) + one small HAL per console
test/       vm + compiler + pipeline unit tests, cross-target E2E, harnesses
games/      boardroom/ (+ test/smoke/ contract game)
```

## Build & test

Prereqs: `bun`, `arm-none-eabi-gcc`, `sdcc`, `cc65`, `mgba` (Homebrew), and
`rgbds` for header fixing. `jsnes` comes from npm.

```sh
bun install && bun spec/gen-c.ts
bun test/harness/build.ts        # mgba runner (once)
bun test .                       # unit tests (vm, compiler, pipeline)
bun test/e2e.ts                  # smoke game on gba+gb+nes
bun games/boardroom/test/e2e.ts  # the full BOARDROOM playthrough x3
```

ROMs land in `dist/` — `.gba`, `.gb` (MBC5, rgbfix'd), `.nes` (UNROM,
CHR-RAM). Headers are flashcart-correct; only emulators are in CI.

## Categories

RPG is the first category; the seams for more are deliberate. A category is
a syscall table (opcodes 0x40+), a DSL, a model builder, budgets, and a
portable runtime module — the core VM, script compiler, text pipeline, and
target toolchains are shared. Visual novels are a strict subset of RPG's
surface; platformers put a physics core behind a blocking `action()` op, the
way saga/edge did on GBA. See `DESIGN.md` for the full contract.

Supersedes `@pocketjs/aot` (and the multi-target prototype in PR #52) with a
fresh implementation: a real expression compiler instead of a statement
whitelist, one portable engine instead of three, and the reference-VM oracle
holding every console to the same story.
