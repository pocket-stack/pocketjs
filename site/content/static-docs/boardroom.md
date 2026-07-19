# BOARDROOM, the game

The launch game adapts the November 2023 OpenAI board crisis into a five-day
RPG: the noon Google Meet in a Las Vegas hotel, the guest badge, three CEOs
in three days, the Microsoft feint, 743 signatures, Ilya's 5 AM reversal,
and a final negotiation battle against THE BOARD.

`games/boardroom/dossier.md` pins every quoted line and date to the public
record; everything else is original parody, and the game says so. The
finale's moves — TENDER OFFER, HEART EMOJIS, THE LETTER — are a
`rpg/battle.ts` config: the whole battle system is compiler macros, and the
letter move stays gated until the signature drive reaches 743.

## Why it's a good framework demo

- **One module, three cartridges.** The same `game.ts` builds `.gba`, `.gb`
  and `.nes`, and the CI playthrough clears all 17 checkpoints on each.
- **The story is state.** Chapters are flags; the signature counter is a
  var; scene gating is `onEnter` scripts re-hiding actors — everything the
  script VM exists to do.
- **Deterministic drama.** The final battle rolls the same dice on every
  console, because the story RNG belongs to the script layer, not the
  platform.
- **Art as code.** The cast is a deterministic pixel-person generator in the
  declaration zone — hair, wardrobe and walk frames as data, no network, no
  binary assets in review.

## Playing it

```sh
cd static && bun games/boardroom/test/e2e.ts gba   # builds dist/boardroom.gba
open dist/boardroom.gba
```

D-pad walks, A talks and advances text, up/down move menu cursors. Fired to
rehired in about fifteen minutes.
