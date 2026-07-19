# The script compiler

Script bodies never execute. The compiler walks the generator's TypeScript
AST and emits stack-VM bytecode — so what you write is a real (small)
language, not a statement whitelist.

## Surface

```ts
const Fight = script(function* (s, v, f) {
  v.hp = 8;                                    // v.* — global i16 vars
  let round = 0;                               // locals get VM slots
  while (v.hp > 0 && !f.done) {                // &&/|| short-circuit
    const move = yield* s.choose(["Hit", "Run"]);
    if (move === "Hit") { v.hp -= 2 + (yield* s.rnd(3)); }
    else { f.done = true; }                    // f.* — flags
    round += 1;
  }
  yield* s.say(`Over in ${round} rounds.`);    // ${} of runtime values
});
```

Supported: i16 arithmetic with constant folding, comparisons, ternaries,
`if/else`, `while`, classic `for`, `switch` (numeric or choice-string case
labels), `break`/`continue`, compound assignment and `++`/`--`, and
`yield* s.call(OtherScript)` subroutines.

Engine ops on `s`: `say`, `choose`, `rnd`, `wait`, `lock`/`release`,
`face`, `show`/`hide` (actors), `warp("map:entrance")`, `sfx`.

## Macros: partial evaluation for gameplay

A plain generator function used with `yield*` is a **macro**: the compiler
inlines its body at the call site with arguments bound as compile-time
constants. `for...of` over a bound array unrolls; `if` over a static
condition drops the dead branch; `return value` works via a hidden slot.

`rpg/battle.ts` is a whole turn-based battle system built this way — each
encounter compiles to specialized bytecode, and the runtime needed zero new
code for it.

## Text

`say()` bodies are wrapped and paginated per console at compile time (28
columns on GBA/NES, 18 on Game Boy) — the runtime never measures text.
Runtime `${...}` values compile to scratch-var stores plus an inline format
token the textbox renders as decimal digits.

## Determinism

`rnd(n)` advances a seeded xorshift16 that only script calls touch. Same
choices in, same story out — on the reference VM and on all three consoles.
That is what lets the E2E suites use a host-side playthrough as the oracle
for emulator assertions.
