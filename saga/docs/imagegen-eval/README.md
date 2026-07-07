# PixelLab vs codex imagegen (gpt-image) — GBA asset head-to-head

Same subjects, both tools, July 2026. PixelLab via `pixellab/client.ts`
(pixflux, fixed seeds 61001-61003); codex via
`codex exec --sandbox workspace-write --skip-git-repo-check "<prompt>"`
driving its built-in `image_gen` tool (ChatGPT-login auth, no API key).

| Subject | PixelLab | codex/gpt-image |
| --- | --- | --- |
| 1970s garage workshop, 240×160 background | `pixellab/garage-bg.png` — pixel-grid-true, flat color regions, quantizes to a 15-color palbank with almost no loss | `codex/garage-bg.png` — richer composition (window night sky, garage door, hanging bulb glow), self-downscaled to exactly 240×160, but soft gradient shading costs more under 15-color quantization |
| Full-body 32×48 character sprite | `pixellab/founder-spr.png` — native size, true alpha, clean 1px outline, correct RPG proportions | `codex/founder-spr.png` — decent character but on a #00ff00 chroma background (needs removal pass), edges smear at this scale |
| Late-70s beige computer prop, 64×48 | `pixellab/computer-obj.png` — crisp, reads instantly, true alpha | `codex/computer-obj.png` — good silhouette, same chroma/removal caveat |
| 3×4 walk-cycle sheet (codex only) | pixflux cannot produce multi-frame sheets | `codex/walksheet.png` — real 96×192 grid with consistent character, but rows/phases don't reliably match the requested down/left/right/up walk semantics; raw material, not drop-in |

## Verdict

- **Default to PixelLab** for everything that ships on the GBA: native target
  size, real alpha, `view`/`direction`/`outline`/`negative` control, fixed
  seeds → reproducible + cacheable via manifest.
- **Reach for codex/gpt-image** when a background needs composition/mood
  control that pixflux won't follow, or as raw material for structured sheets
  (then hand-curate cells). Budget ~90s/image and pin exact output filenames in
  the prompt.
- **Neither draws exact marks** (the Vue-logo problem). Bake those from vector
  geometry: `cine/film/bake-logo.ts`.

Details + prompt recipes: `.claude/skills/pixel-art-pipeline/SKILL.md`.
