# @pocketjs/saga

**Author interactive pixel-art biographies in TypeScript; ship a real GBA ROM with walkable worlds, encounters and cinematics.**

`@pocketjs/saga` is the generalized descendant of `@pocketjs/cine`. Where cine plays a montage *at* you (with playable beats), saga hands you the D-pad: **top-down world scenes** you walk through Pokémon-style — grid stepping, collision, NPCs that turn to face you, examine spots, exit doors — plus **encounter scenes** (portraits + conviction meters driven by dialogue choices) and a **playable Breakout set piece**, all sharing cine's full cinematic vocabulary (per-scanline raster gradients, BLDCNT fades, WIN0 letterbox, affine OBJs, typewriter captions, PSG blips) and the same partial-evaluation discipline: the declaration zone runs at build time, `cue(function* () { ... })` bodies are lowered from TS AST to bytecode for a suspendable cue VM.

The first game is **REALITY DISTORTION — Part One**, an English-language fan tribute to Steve Jobs from Paul Jobs' workbench to the Macintosh launch (Jan 24, 1984). Every dated event follows a source-cited research dossier (`game/dossier.md`); disputed history (the garage myth, the Breakout bonus figure) is either avoided or framed exactly as disputed. Most dialogue is original fan writing; a handful of documented lines (the Hewlett call pitch, "gold mine" at PARC, the Carmel retreat sayings, the sugared-water question as Sculley's memoir records it, the Macintosh's own 1984 speech) appear verbatim, and the credits say so.

## The game

Boot into a chapter menu or play straight through (~10 minutes):

1. **The Workbench** — Mountain View, early 60s. *World.* Walk the garage as a kid; Dad marks off your half of the bench.
2. **The Call** — Los Altos, 1968. A phone book, Bill Hewlett, and the documented pitch, word for word.
3. **The Blue Box** — Berkeley, 1971. Woz's all-digital box; "No blue boxes, no Apple."
4. **The Letterform** — Reed, 1972. Dropped out, dropped in: Palladino's calligraphy room.
5. **Breakout** — Atari, 1975. *Minigame.* Keep the prototype alive until dawn — real bricks, real paddle. The payment dispute is presented as exactly that: disputed.
6. **Fifty Boards** — Los Altos, April 1976. *World + encounter.* Terrell ordered 50 assembled boards, COD; talk the parts man into net-30 (meter battle) and ship in 29 days.
7. **The Faire** — San Francisco, 1977. Three finished Apple IIs and a bluff of empty cases.
8. **The Goldmine** — Xerox PARC, Dec 1979. *World.* Find the Alto. Shout the documented shout.
9. **Sugared Water** — San Remo terrace, 1983. *Encounter.* Build conviction before you ask the question, or Sculley waves you off.
10. **Pirates** — Bandley 3, Aug 1983. *World.* The flag Capps sewed and Kare painted; the prototype that says hello.
11. **Hello** — Flint Center, Jan 24, 1984. Mash the applause, pull it from the bag, and let the Macintosh speak for itself.

## Authoring model

World scenes are declared as art + an ASCII grid; everything else is the same cue discipline as cine:

```ts
const garage = defineScene({
  id: "garage76",
  main: image("art/map_garage76.png"),          // 320x240 top-down map (PixelLab)
  actors: { hero: sprite("art/spr_hero.png", { w: 32, h: 32, frames: 12, walkFpd: 4 }) },
  world: {
    grid: [ "####################",
            "########ddd#########",   // # solid · . floor · letters name cells
            "#..w......p........#", /* ... 20x15 cells = the 320x240 image */ ],
    player: { actor: "hero", at: "p", dir: "up" },
    npcs: { woz: { actor: "woz", at: "w", talk: cue(function* () { /* dialog */ }) } },
    spots: { phone: { at: [7, 3, 1, 3], run: cue(function* () { /* examine */ }) } },
    exits: { door: { at: "d", value: 1 } },
  },
  play: cue(function* () {
    yield fadeIn(40);
    const exit = yield world();   // blocks: player roams until an exit trigger
    yield fadeOut(40);
  }),
});
```

NPC/spot cues interrupt the roam and return to it; `warp`/`face`/`walk` script the grid from cutscenes; `meterShow` + `choice` loops make persuasion encounters; `breakout(rows, lives, frames)` blocks until the night is over and pushes the bricks cleared.

## Build & run

```bash
# prerequisites: bun, arm-none-eabi-gcc + binutils; mgba for the headless tests
cd saga
bun run build          # dist/reality-distortion.gba
bash play.sh           # build + open in mGBA.app
bun run test           # headless E2E: full playthrough via mgba
bun run test:engine    # engine E2E on the placeholder smoke film
bun run smoke          # build the smoke film (no PixelLab needed)
bun run art            # (re)generate art via PixelLab (cached; needs PIXELLAB_API_KEY)
bun pixellab/walkers.ts  # assemble walker sheets (hero gets real 4-frame walk cycles)
```

Controls: D-pad to walk / pick, A to talk, examine, confirm, launch.

## Engine layout

```
spec/saga.ts        binary contract: ops, tween targets, world/trigger tables,
                    VRAM plan, debug block (mirrored to runtime/saga_gen.h)
dsl/index.ts        defineFilm/defineScene (+world decl) + residual op vocabulary
compiler/           evaluate -> residualize (TS AST -> bytecode, multi-cue tables)
                    -> assets (15-color quantize, flip dedup, 64x64 quadrant maps,
                    walker sheets, glyph store) -> emit gen_data.c -> rom
runtime/            fixed C: cue VM + world.c (grid walker, NPC/trigger dispatch,
                    both-axis camera) + breakout.c + fx/raster/caption/obj/sfx
pixellab/           pixflux client + game prompt sheet + walkers.ts
                    (/animate-with-text walk cycles at 64px, 2x round trip)
game/               reality-distortion.ts + dossier.md + art/ (committed PNGs)
test/               engine-e2e.ts (24 asserts), game e2e, smoke film
```

E2E drives the same debug block contract as aot/cine (EWRAM `0x02000000`) through `aot/test/harness/mgba_runner` — plus world fields: player cell/facing, bricks left, scene kind.

## Fan-work notes

Unaffiliated tribute; no trademarks or trade dress in generated art (prompts are franchise-neutral — "a beige home computer", "a black pirate flag"). Real names appear only in documented historical context. `game/dossier.md` carries the full source list and the do-not-state-as-fact ledger.
