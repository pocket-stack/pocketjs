---
name: pocketjs-video-outro
description: Append a PocketJS-branded, animated end card to a local video (screen recording, demo capture, phone clip). Renders the dark brand card — logo glyph, "PocketJS" wordmark, "Bare Metal Modern Web" tagline, pocketjs.dev — with headless Chrome, then composites it with a crossfade and a staggered text entrance while preserving the source's original audio. Use when asked to add an outro / end card / 片尾 to a video, brand a recording, or produce a shareable clip with the PocketJS sign-off.
---

# PocketJS Video Outro

## Overview

Turns any local video into a shareable clip that ends on the PocketJS brand card.
The card is built from the same visual system as `site/assets/og-image.svg` — dark
`#05070d` field, faint blueprint grid, blue/cyan corner glows, the lens/viewfinder
logo glyph, the wordmark, and the hero tagline. It is rendered by headless Chrome
(full gradient/shadow/font fidelity; the site font stack falls back to system SF),
then `ffmpeg` crossfades the source into the card and animates the text in.

Design choices baked into the pipeline:

- **Crossfade first, text second.** The source dissolves into the *empty* branded
  background; the type only starts animating once the transition has settled, so it
  never fights the crossfade.
- **Staggered entrance.** Logo → tagline → URL, each fades in and eases up
  (~20-30px, ease-out cubic), ~0.35s apart, then holds.
- **Audio is the source's, never synthesized.** The card is silent; the original
  track is preserved and gently faded out under the transition (no voiceover).

## Requirements

- `ffmpeg` / `ffprobe` on PATH.
- A Chromium-family browser (Google Chrome, Chromium, Edge, or Brave) — used only
  to screenshot the card layers. The script auto-detects it.

## Standard workflow

One Bun command produces the finished file (the driver is Bun TypeScript — this
repo keeps command wrappers in Bun, not shell scripts):

```bash
bun skills/pocketjs-video-outro/scripts/make-outro.ts -i ~/Downloads/clip.mov
# writes ~/Downloads/clip_outro.mp4  (H.264 high, yuv420p, +faststart, AAC 192k)
# prints the output path on stdout; progress/summary on stderr
```

Then **verify visually** — extract a frame near the end and eyeball the card, and
confirm the tail is silent while the body kept its audio (the animation is the
whole point; always look):

```bash
V=~/Downloads/clip_outro.mp4
ffmpeg -y -sseof -0.6 -i "$V" -frames:v 1 /tmp/card.png            # final card
ffmpeg -nostats -sseof -2 -i "$V" -af volumedetect -f null - 2>&1 | grep mean_volume
```

## Options

| Flag | Default | Purpose |
|------|---------|---------|
| `-i` / `--input` | — (required) | input video |
| `-o` / `--output` | `<input>_outro.mp4` next to input | output path |
| `--tagline` | `Bare Metal Modern Web` | hero line (wraps on narrow/portrait frames) |
| `--brand` | `PocketJS` | wordmark next to the glyph |
| `--url` | `pocketjs.dev` | footer line; pass `--url ""` to hide it |
| `--outro` | `5.5` | end-card length in seconds |
| `--xfade` | `0.8` | crossfade length; text entrance keys off it |
| `--crf` / `--preset` | `18` / `medium` | x264 quality/speed |

## How it adapts to the input

- Probes width/height/fps/duration; the card is rendered at the source's native
  resolution and re-timed to its fps, so the crossfade is seamless.
- **Type scales** with `scale = min(W,H)/1080`, so 720p, 1080p, and 4K all look
  proportional. On portrait/narrow frames the tagline wraps to two lines (verified).
- **Audio:** maps the source's *first* audio stream (`0:a:0`) and downmixes to
  stereo. This is deliberate — iPhone `.mov` captures carry an extra multi-channel
  spatial-audio track plus several data streams; `a:0` is the standard stereo mix.
  If the source has no audio, the output is video-only.

## Customization & internals

- The card is `assets/outro.html`, parameterized via query string
  (`?layer=…&scale=…&brand=…&tagline=…&url=…`). Edit it to restyle; every dimension
  is in `rem` and the script sets root font-size to `10px * scale`.
- Entrance/animation is entirely in `ffmpeg`, orchestrated by `scripts/make-outro.ts`
  (Bun TypeScript, `import { $ } from "bun"`): each element is screenshotted as its
  **own transparent layer** with the *others kept in place via `visibility: hidden`*
  (so absolute positions never shift), then composited with per-layer `fade` (alpha)
  + `overlay` (ease-out slide). Change slide distances, stagger, or easing there.
- Keep new wrappers/tooling for this skill in Bun TypeScript — do not add `.sh`
  scripts (repo convention; see also `pocketjs-gba-imagegen`).
- To preview just the card without a video, screenshot the template directly:
  `"<chrome>" --headless --screenshot=card.png --window-size=1920,1080 "file://$PWD/skills/pocketjs-video-outro/assets/outro.html"`.

## Gotchas

- Chrome's headless screenshot honors `--force-device-scale-factor=1` and
  `--default-background-color=00000000`; the text layers rely on that alpha to
  composite. Don't drop those flags.
- Keep the output `yuv420p` + `+faststart` (already set) — some players choke on
  4:4:4 or non-faststart MP4s.
- `xfade` needs both sides normalized to identical size/fps/sar/pix_fmt; the graph
  does this. If you feed a variable-frame-rate capture, the `fps` filter conforms it.
- The tagline on a very wide single line can approach the frame edge; it has
  `max-width: 92vw` and will wrap before overflowing.
