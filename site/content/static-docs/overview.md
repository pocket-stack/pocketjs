# Pocket Static

Pocket Static is the cartridge product line of the Pocket family. A game is
one TypeScript module; the build compiles it into real ROMs for three
consoles at once — Game Boy Advance, Game Boy, and NES. No JavaScript engine
ships: scripts become bytecode for a small stack VM, and everything the
compiler can decide statically (text wrapping, palettes, maps, branching
structure, battle logic) is decided before the cartridge exists.

The framework docs describe the PSP-oriented UI runtime powered by QuickJS,
Solid, Vue Vapor, and PocketJS host components. Pocket Static is intentionally
different: it targets tile maps, sprites, dialogue, flags, choices, warps,
and turn-based battles on consoles with 2-16 KB of RAM.

## The one idea

A game has two zones:

- **Declaration zone** — `defineGame`, `defineMap`, `defineSprite`,
  `defineTileset`: plain TypeScript, executed at build time. Anything you can
  compute in TS is free (BOARDROOM's cast is a tiny procedural pixel-person
  generator).
- **Script zone** — `script(function* (s, v, f) { ... })`: generator
  functions that are compiled, never executed. `s` is the engine, `v` your
  numeric vars, `f` your boolean flags.

The stack VM is the portability layer: its interpreter is ~600 lines of
portable C, compiled by `arm-none-eabi-gcc`, `sdcc`, and `cc65`. The same
bytecode runs on all three CPUs, and a TypeScript reference interpreter
(`vm/ref.ts`) defines the semantics that every console is tested against.

## What exists today

The RPG category: grid movement, solid tiles and actors, talk scripts,
step-on triggers, warps, a typewriter textbox, choice menus, deterministic
RNG, and a battle system that is literally a compiler macro library
(`rpg/battle.ts`). The launch game BOARDROOM plays the same 17-checkpoint
story on all three consoles in CI.

Categories are a deliberate seam: a category is a syscall table, a DSL, a
model builder, budgets, and one portable runtime module. Visual novels are a
strict subset of the RPG surface; platformers put a physics core behind a
blocking op. See `static/DESIGN.md` in the repo for the contract.
