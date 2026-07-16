// demos/youtube/host/cards.ts — search-result cards, rendered host-side.
//
// The PSP's font atlas bakes only the glyphs the app's source literals name,
// so arbitrary search-result text (CJK titles above all) can never render as
// device text. The Mac has every glyph: each result becomes ONE 256x64
// CLUT8 card image — thumbnail left, two title lines + meta right — shipped
// as an IMG-entry side file and shown with loadImgFile. Text is rasterized
// here with opentype.js outlines (Arial Unicode for coverage) because the
// Homebrew ffmpeg has no drawtext; thumbnails decode through ffmpeg
// (scale/crop to the card slot).
//
// Deterministic given the same inputs — the golden test feeds a fixed RGBA
// thumb and asserts the card bytes.

import { existsSync } from "node:fs";
import { parse as parseFont, type Font } from "opentype.js";

export const CARD_W = 256;
export const CARD_H = 64;
export const THUMB_W = 116;
export const THUMB_H = 64;

const BG = [0x14, 0x1c, 0x26];
const INK = [0xe8, 0xf0, 0xf2];
const DIM = [0x8f, 0xa3, 0xad];

const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  new URL("../../../assets/fonts/Inter-Regular.ttf", import.meta.url).pathname,
];

let cachedFont: Font | null = null;

export async function cardFont(): Promise<Font> {
  if (cachedFont) return cachedFont;
  const path = FONT_CANDIDATES.find((p) => existsSync(p));
  if (!path) throw new Error("cards: no usable font (looked for Arial Unicode / Inter)");
  cachedFont = parseFont(await Bun.file(path).arrayBuffer());
  return cachedFont;
}

// ---------------------------------------------------------------------------
// Text rasterization (outline -> polylines -> even-odd scanline coverage)
// ---------------------------------------------------------------------------

interface Seg {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Flatten an opentype path (already positioned at x/baseline/size) into
 *  line segments. Curves become 8-step polylines — plenty below 20 px. */
function flatten(font: Font, text: string, x: number, baseline: number, size: number): Seg[] {
  const path = font.getPath(text, x, baseline, size, { kerning: true });
  const segs: Seg[] = [];
  let sx = 0;
  let sy = 0;
  let cx = 0;
  let cy = 0;
  const lineTo = (nx: number, ny: number) => {
    segs.push({ x0: cx, y0: cy, x1: nx, y1: ny });
    cx = nx;
    cy = ny;
  };
  for (const c of path.commands) {
    if (c.type === "M") {
      sx = cx = c.x;
      sy = cy = c.y;
    } else if (c.type === "L") {
      lineTo(c.x, c.y);
    } else if (c.type === "Q") {
      const { x0, y0 } = { x0: cx, y0: cy };
      for (let i = 1; i <= 8; i++) {
        const t = i / 8;
        const u = 1 - t;
        lineTo(u * u * x0 + 2 * u * t * c.x1 + t * t * c.x, u * u * y0 + 2 * u * t * c.y1 + t * t * c.y);
      }
    } else if (c.type === "C") {
      const { x0, y0 } = { x0: cx, y0: cy };
      for (let i = 1; i <= 8; i++) {
        const t = i / 8;
        const u = 1 - t;
        lineTo(
          u * u * u * x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
          u * u * u * y0 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
        );
      }
    } else {
      lineTo(sx, sy);
    }
  }
  return segs;
}

/**
 * Rasterize `text` into the RGBA canvas with 4x vertical scanline
 * supersampling + analytic horizontal span coverage (the same bias
 * compiler/bake-font.ts uses: horizontal precision matters most for stems).
 */
export function drawText(
  rgba: Uint8Array,
  w: number,
  h: number,
  text: string,
  x: number,
  baseline: number,
  size: number,
  color: readonly number[],
): void {
  const font = cachedFont;
  if (!font) throw new Error("cards: cardFont() must resolve before drawText");
  const segs = flatten(font, text, x, baseline, size);
  if (segs.length === 0) return;
  let minY = h;
  let maxY = 0;
  for (const s of segs) {
    minY = Math.min(minY, s.y0, s.y1);
    maxY = Math.max(maxY, s.y0, s.y1);
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(h - 1, Math.ceil(maxY));
  const SS = 4;
  const cover = new Float32Array(w);
  for (let py = y0; py <= y1; py++) {
    cover.fill(0);
    for (let s = 0; s < SS; s++) {
      const sy = py + (s + 0.5) / SS;
      // Even-odd: collect x crossings of the scanline.
      const xs: number[] = [];
      for (const seg of segs) {
        const { x0: ax, y0: ay, x1: bx, y1: by } = seg;
        if (ay === by) continue;
        if ((sy >= ay && sy < by) || (sy >= by && sy < ay)) {
          xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const from = Math.max(0, xs[i]);
        const to = Math.min(w, xs[i + 1]);
        if (to <= from) continue;
        let px = Math.floor(from);
        while (px < to) {
          const covered = Math.min(px + 1, to) - Math.max(px, from);
          cover[px] += covered / SS;
          px++;
        }
      }
    }
    for (let px = 0; px < w; px++) {
      const a = Math.min(1, cover[px]);
      if (a <= 0) continue;
      const o = (py * w + px) * 4;
      rgba[o] = rgba[o] + (color[0] - rgba[o]) * a;
      rgba[o + 1] = rgba[o + 1] + (color[1] - rgba[o + 1]) * a;
      rgba[o + 2] = rgba[o + 2] + (color[2] - rgba[o + 2]) * a;
      rgba[o + 3] = 255;
    }
  }
}

export function textWidth(text: string, size: number): number {
  const font = cachedFont;
  if (!font) throw new Error("cards: cardFont() must resolve before textWidth");
  return font.getAdvanceWidth(text, size, { kerning: true });
}

/** Greedy character wrap into at most `maxLines` lines of `maxWidth` px;
 *  the last line ellipsizes. Character-granular on purpose: CJK has no
 *  spaces and result titles mix scripts freely. */
export function fitLines(text: string, size: number, maxWidth: number, maxLines: number): string[] {
  const chars = [...text.trim()];
  const lines: string[] = [];
  let line = "";
  for (let i = 0; i < chars.length; i++) {
    const probe = line + chars[i];
    if (textWidth(probe, size) <= maxWidth) {
      line = probe;
      continue;
    }
    if (lines.length === maxLines - 1) {
      while (line.length > 0 && textWidth(line + "…", size) > maxWidth) {
        line = line.slice(0, -1);
      }
      lines.push(line + "…");
      return lines;
    }
    lines.push(line);
    line = chars[i] === " " ? "" : chars[i];
  }
  if (line) lines.push(line);
  return lines;
}

// ---------------------------------------------------------------------------
// Card composition
// ---------------------------------------------------------------------------

export function fmtDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m >= 60) {
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function fmtViews(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return `${n}`;
}

export interface CardInput {
  title: string;
  channel: string;
  durationS: number;
  views: number;
  /** THUMB_W x THUMB_H RGBA, or null for the flat placeholder. */
  thumbRgba: Uint8Array | null;
}

/** Compose one 256x64 RGBA card (quantize + encodeImgT8 downstream). */
export async function renderCard(input: CardInput): Promise<Uint8Array> {
  await cardFont();
  const rgba = new Uint8Array(CARD_W * CARD_H * 4);
  for (let i = 0; i < CARD_W * CARD_H; i++) {
    rgba[i * 4] = BG[0];
    rgba[i * 4 + 1] = BG[1];
    rgba[i * 4 + 2] = BG[2];
    rgba[i * 4 + 3] = 255;
  }
  if (input.thumbRgba && input.thumbRgba.length === THUMB_W * THUMB_H * 4) {
    for (let y = 0; y < THUMB_H; y++) {
      const src = input.thumbRgba.subarray(y * THUMB_W * 4, (y + 1) * THUMB_W * 4);
      rgba.set(src, y * CARD_W * 4);
    }
  } else {
    // Placeholder: a dimmer panel with a play glyph, so a failed thumbnail
    // fetch still reads as "a video".
    for (let y = 0; y < THUMB_H; y++) {
      for (let x = 0; x < THUMB_W; x++) {
        const o = (y * CARD_W + x) * 4;
        rgba[o] = 0x1e;
        rgba[o + 1] = 0x2a;
        rgba[o + 2] = 0x38;
      }
    }
    drawText(rgba, CARD_W, CARD_H, "▶", (THUMB_W - textWidth("▶", 22)) / 2, 40, 22, DIM);
  }
  const tx = THUMB_W + 8;
  const maxW = CARD_W - tx - 6;
  const lines = fitLines(input.title, 13, maxW, 2);
  drawText(rgba, CARD_W, CARD_H, lines[0] ?? "", tx, 19, 13, INK);
  if (lines[1]) drawText(rgba, CARD_W, CARD_H, lines[1], tx, 36, 13, INK);
  const meta: string[] = [];
  if (input.channel) meta.push(input.channel);
  if (input.durationS > 0) meta.push(fmtDuration(input.durationS));
  if (input.views > 0) meta.push(`${fmtViews(input.views)}次`);
  const metaLine = fitLines(meta.join(" · "), 10, maxW, 1)[0] ?? "";
  drawText(rgba, CARD_W, CARD_H, metaLine, tx, 56, 10, DIM);
  return rgba;
}

// ---------------------------------------------------------------------------
// Thumbnail fetch + decode (ffmpeg scale/crop; no freetype needed here)
// ---------------------------------------------------------------------------

/** Fetch a thumbnail and decode it to THUMB_W x THUMB_H RGBA via ffmpeg.
 *  Null on any failure — the card falls back to the placeholder panel. */
export async function fetchThumbRGBA(url: string, tmpDir: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const tmp = `${tmpDir}/thumb-${Bun.hash(url).toString(16)}.img`;
    await Bun.write(tmp, await res.arrayBuffer());
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        tmp,
        "-vf",
        `scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=increase,crop=${THUMB_W}:${THUMB_H}`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "pipe:1",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    if ((await proc.exited) !== 0 || bytes.length !== THUMB_W * THUMB_H * 4) return null;
    return bytes;
  } catch {
    return null;
  }
}
