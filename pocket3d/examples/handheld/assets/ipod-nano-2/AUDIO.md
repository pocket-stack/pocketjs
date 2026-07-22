# Pocket Sessions audio

The three short songs in `media/` are original deterministic synthesizer
outputs created by `generate_media.ts` for the Pocket Stage iPod demo:

- Neon Boardwalk
- Silver Static
- Night Bus Loop

Checked-in SHA-256 digests:

- `neon-boardwalk.wav`: `355193f178091326bb93e957a4fba750ae9e1c67afedee2204740be49467ddc9`
- `silver-static.wav`: `11c98e97e6ad64320fa60990bd8ed0b6c34173d4afe3870561f3d9ca67e9760b`
- `night-bus-loop.wav`: `d0013f6cd64fdedcd418bf5d606a3badfde95505957442b4cba1be2232cd7521`

They contain no sampled or downloaded recordings and are distributed under
the PocketJS repository's MIT license. Regenerate the byte-identical 24-second
mono PCM WAV files with:

```sh
bun pocket3d/examples/handheld/assets/ipod-nano-2/generate_media.ts
```
