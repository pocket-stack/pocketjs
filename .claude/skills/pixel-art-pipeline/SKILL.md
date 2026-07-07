---
name: pixel-art-pipeline
description: Generate committed pixel-art assets for GBA games via the PixelLab API (with codex/gpt-image as a secondary tool), including prompt recipes, caching/manifest discipline, and when to bake art from vector geometry instead. Use when creating or regenerating backgrounds, sprites, portraits, or props for aot/cine/saga-style packages.
---

# Pixel-art asset pipeline

## PixelLab (primary tool for GBA-native art)

- API `https://api.pixellab.ai/v1`, Bearer key `PIXELLAB_API_KEY` from the
  **repo-root `.env`** (git-ignored — never print or commit it). Typed client:
  `cine/pixellab/client.ts` (`pixflux()` + retry ×4 backoff, no retry on 422/401).
- `generate-image-pixflux`: text → pixel art at the **native target size**.
  Limits: max 400×400, **min 32×32** ("Canvas must be size 32x32 area or
  larger"). Full GBA backgrounds (240×160) and wide pans (384×160) come out
  directly — no downscaling ever needed.
- `/balance` shows `{"usd": 0.0}` on subscription accounts — generations still
  work; it bills per generation, so **cache everything**.

### Caching discipline (why builds never re-bill)

One generator script per game (`pixellab/generate.ts`) holding a SPECS table:
`{ name, width, height, description, negative, seed, ... }` with **fixed seeds**.
Generated PNGs are **committed** under `<game>/art/` next to a `manifest.json`
recording the exact request; the script skips files that exist. `--only <name>`
+ `--force` to redo one asset; tweak the seed when re-rolling composition.

### Prompt recipes that actually worked (cine, 25 assets)

- Backgrounds: subject + explicit props list + light ("warm evening light",
  "dawn"), "wide shot, detailed pixel art game background",
  `shading: "detailed shading"`, `detail: "highly detailed"`,
  negative `"people, text, logo, watermark"`. Quality is shockingly good at
  240×160; interiors and skylines both.
- Character sprites: "**tiny full body** pixel art sprite of ... , standing,
  **head to toe visible**", `noBackground: true`, `outline: "single color black
  outline"`, negative `"portrait, bust, cropped"`. Without the full-body
  incantation you get bust portraits at any canvas size.
- Top-down (Pokémon-style) sprites: add `view: "low top-down"` +
  `direction: "south" | "north" | "east"`.
- Props: describe *material and silhouette*, and put what the model drifts
  toward in the negative (a flag kept coming out as a signpost until
  negative `"arrow, sign"` + "rectangular dark navy fabric flag waving").
- 15-color palbank target: prompts with "limited palette" quantize cleaner
  through the median-cut pipeline, but PixelLab output generally survives
  15-color quantization well without it.

### What PixelLab cannot do → bake from geometry

Exact marks/logos (e.g. the Vue logo) never come out right from any generator.
Rasterize from the official SVG path vertices instead: ray-casting
point-in-polygon, 4×4 supersampling, ≥50% coverage threshold, snap to the
official flat colors, native sprite size, no AA. Reference implementation:
`cine/film/bake-logo.ts`. Same trick applies to flags, pixel headlines, and any
trademarked-shape stand-in you have vector data for.

## codex imagegen (gpt-image) as a secondary tool

The local codex skill (`~/.codex/skills/.system/imagegen`) drives OpenAI
gpt-image; invoke headlessly with
`codex exec --sandbox workspace-write --skip-git-repo-check "<prompt>"`
(ChatGPT-login auth; no OPENAI_API_KEY needed for the built-in tool path).
Measured head-to-head on the same GBA subjects (garage background, full-body
sprite, 1970s computer prop, 4-dir walk sheet):

- **Backgrounds: both excellent.** gpt-image composes richer scenes/lighting
  and even self-downscales to the exact 240×160 target, but its soft gradients
  can mud a 15-color palbank; PixelLab stays pixel-grid-true and quantizes
  cleaner. Default PixelLab; reach for gpt-image when pixflux won't follow a
  specific composition/mood.
- **Sprites & props ≤64px: PixelLab wins clearly.** Native canvas size, true
  alpha (`noBackground`), `view`/`direction`/`outline` control. gpt-image edges
  smear at sprite scale and its chroma-key background needs a removal pass
  (`remove_chroma_key.py`) with fringe risk on 1px outlines.
- **Multi-frame sheets: gpt-image only — but curate.** It will produce a
  plausible 3×4 walk-cycle grid in one shot; cell consistency is good but
  direction/phase semantics are unreliable (rows come out wrong or as poses,
  not walk phases). Treat as raw material. For walk cycles prefer per-direction
  pixflux (`direction: south/north/east`, same seed) + mirrored-step animation.
- **Exact marks/logos: neither.** Bake from vector geometry (above).
- **Ops:** PixelLab = seeded, reproducible, manifest-cached, ~5-15s/image.
  codex = no seed control, ~90s/image through an agent loop, ChatGPT-login
  auth, output lands wherever the agent decides (pin exact filenames in the
  prompt). Full head-to-head with images: `saga/docs/imagegen-eval/`.

## Shared rules

- Franchise-neutral prompts always — no trademarked logos, mascots, or trade
  dress in any prompt; real marks only by explicit user request and then baked
  locally from vector geometry.
- Commit the PNGs, review each one visually (Read the file) before wiring it
  into a scene; regenerate with a stronger prompt + new seed rather than
  accepting a wrong pose/crop.
- Characters must be generated (or cropped) so their **feet reach the sprite
  bottom edge** — the runtime places sprites by feet line.
