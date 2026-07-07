---
name: gba-dsl-game
description: Build a GBA game as a TypeScript DSL + partial-evaluation compiler + fixed C runtime, the way aot/ and cine/ do it. Use when creating a new GBA title, a new game DSL package in this repo, or extending an existing one (new ops, scenes, modes), and when debugging a ROM headlessly with the mGBA harness.
---

# GBA DSL game workflow

This repo ships GBA games as **DSL packages**: a TypeScript authoring surface whose
declaration zone runs at build time, plus `cue(function* () { ... })` /
`script(...)` bodies that are **never executed** — their AST is lowered to bytecode
for a small VM inside a fixed C runtime. Proven twice: `aot/` (tile RPGs,
3 consoles) and `cine/` (cinematic montage films, GBA-only). Read one of them
before starting; `cine/` is the smaller, more modern reference.

## Architecture (copy this shape)

```
<pkg>/spec/<pkg>.ts   THE single source of truth: opcode table, tween/FX targets,
                      waiting states, VRAM budget constants, debug-block offsets.
<pkg>/spec/gen-c.ts   emits runtime/<pkg>_gen.h from the spec. TS and C never
                      drift because both read the same table.
<pkg>/dsl/index.ts    defineX() factories + residual op stubs (return plain
                      tagged objects; no logic).
<pkg>/compiler/       evaluate → residualize → assets → emit gen_data.c → rom
<pkg>/runtime/        fixed C files: crt0.s, gba.h, gba.ld, irq.c, cue/script VM,
                      fx compositor, caption/dialog UI, obj.c, sfx
<pkg>/test/e2e.ts     headless mGBA playthrough with bus-level assertions
```

Build = `bun compiler/cli.ts build <game>.ts` → evaluate the module (Bun temp-file
trick: write `entry.__<pkg>.<pid>.<n>.mjs` next to the entry, import, delete),
residualize generator ASTs to bytecode, quantize/tile art, emit one `gen_data.c`,
compile ~12 C files with `arm-none-eabi-gcc`, patch the GBA header (BIOS logo
bitmap + complement checksum) so the ROM is flashcart-ready.

## Non-negotiable sharp edges (each cost real debugging time)

1. **crt0 must end with `msr cpsr_c, #0x5F`** (system mode, IRQ *enabled*).
   aot's crt0 uses 0xDF (IRQ masked at the CPU) because aot never uses
   interrupts; any interrupt-driven runtime copied from it hangs on the first
   frame wait with a black-ish screen and a frame counter stuck at 0.
2. **Namespace generated debug macros.** Emit offsets as `DBGO_*` and values as
   `*_VAL`. A `#define DBG_MAGIC 0` (offset) silently clobbers the magic *value*
   macro and every debug read returns garbage.
3. **Partition the glyph-slot ring.** Typewriter text streams Unifont halfcells
   into a VRAM slot ring. Any caption that must PERSIST (chip/topbar style)
   needs a private slot range sized to its column limit; if it shares the ring,
   later dialog reuses its tiles and the persistent caption turns to mojibake.
4. **OBJ priority vs UI BG.** Caption/dialog BG0 runs at priority 0; scene
   sprites at priority 1 are *correctly* hidden behind text boxes. Author around
   it: keep actor beats above the text rows or clear captions first.
5. **Feet, not origin.** Characters read as "standing" only when sprite bottom
   sits on the ground line: `y = ground_row*8 - sprite_h`. Floating characters
   are the most common visual bug in generated scenes.
6. **`.iwram.text` must be in the .data LMA copy region** of the linker script,
   and hot ISR code marked with an IWRAM_CODE attribute (`section(".iwram.text"),
   long_call, target("arm")`). HBlank work in ROM is too slow and races the
   scanline.
7. **Non-ASCII glyphs always take the fullwidth 2-cell path**, even codepoints
   Unifont calls halfwidth (e.g. U+00B7), else tokenizer/interner disagree and
   you get "glyph not interned" at build time. English-only text is all-ASCII
   halfcells — nothing special needed.
8. **Mode 0 layer plan that works:** BG0 = UI text (charbase 2, prio 0),
   BG1 = main stage (wide pans = 2 consecutive screenblocks), BG2 = far
   parallax, BG3 = sky — or drop the sky layer and repaint the backdrop color
   per scanline from the HBlank ISR (160 free shades of gradient).
   One palbank per BG layer (15 colors + shared transparent 0), OBJ sheets
   frame-major with 1D mapping, UI OBJ tiles parked high (e.g. tile 1000).

## GBA FX vocabulary already proven in `cine/runtime/`

Steal, don't reinvent: IWRAM HBlank ISR (per-scanline backdrop gradient,
letterbox band blackout, sine-wave HOFS), BLDCNT state machine (black/white
BLDY fades — white-out must *persist across scene loads*; alpha ghosts via
2nd-target config kept armed), WIN0 letterbox, mosaic, screen shake (LCG),
one OBJ affine matrix (zoom q8 + angle 0-255, double-size flag, matrix written
into oam_shadow fill words), 16-slot tween engine (24.8 fixed point, smoothstep
`f*f*(768-2f)>>16`), PSG blips. VBlank ISR does OAM DMA + scroll latch.

## The cue/script VM pattern

Author interactive logic as a generator: `yield op(...)` per beat. The compiler
walks the TS AST (if/while/break/choice-comparisons, locals interned per cue) and
emits bytecode; the C VM executes bursts (≈64 ops) between **blocking waiting
states** (WAITING_A / DIALOG / CHOICE / CONTROL / MASH / DONE...) serviced once
per frame. vars/flags are the E2E observability surface — expose them in the
debug block.

## Headless verification (do this, not "it compiles")

- Reserve a **debug block in EWRAM 0x02000000**: magic, booted, scene id,
  waiting state, VM ip, camera, vars, sprite-0 position. Update every frame.
- Drive the ROM with `aot/test/harness/mgba_runner` scenario JSON:
  `advance` N frames, `press` buttons, `read` any bus address (EWRAM, OAM,
  PALRAM, VRAM — invaluable for "sprite invisible" forensics), `screenshot`.
- E2E = full playthrough with assertions on the debug block (scene transitions,
  choice results, var math, text pointer) — cine's 27-assert suite is the model.
- **Visually review every scene**: screenshot → PPM → PNG → look at it. Bus
  reads prove state; only eyes catch floating characters, palette mud, and
  garbled captions.

## Content discipline

- Real-person tribute games: research first (background agent → source-cited
  dossier, verified vs unverified separated), avoid every unverified fact,
  all dialogue original writing, disclaimer on the title screen.
- Art via the pixel-art pipeline skill (PixelLab, committed PNG cache).
  Franchise-neutral prompts; exact logos get baked from vector geometry instead.
- Repo rules: draft PR when validated, Conventional Commits title, never
  print or commit API keys (`.env` is git-ignored).
