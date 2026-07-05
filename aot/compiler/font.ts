// aot/compiler/font.ts — compile-time Inter glyph rasterizer for GBA dialogue.
//
// Runtime text remains tile-based, but the tile pixels are no longer a 1-bit
// bitmap font. Each glyph is rasterized from Inter outlines with horizontally
// biased supersampling, then quantized into several palette coverage levels.

import { readFileSync } from "node:fs";
import { parse as parseFont, type Font, type Path } from "opentype.js";

/** First encoded code point (space). */
export const FIRST_CHAR = 0x20;
/** Last encoded code point (tilde). */
export const LAST_CHAR = 0x7e;
/** Glyph dimensions: one GBA tile. */
export const GLYPH_WIDTH = 8;
export const GLYPH_HEIGHT = 8;
/** Number of glyphs in the table. */
export const GLYPH_COUNT = LAST_CHAR - FIRST_CHAR + 1;

const FONT_PATH = new URL("../../assets/fonts/Inter-Bold.ttf", import.meta.url).pathname;
const FONT_SIZE = 7.8;
const BASELINE = 6.85;
const PEN_X = 0.25;
const CURVE_STEPS = 8;
const SS_X = 9;
const SS_Y = 3;

type Pt = { x: number; y: number };
type Contour = Pt[];

let font: Font | null = null;
const coverageCache = new Map<number, Uint8Array>();

function loadFont(): Font {
  if (!font) {
    const buf = readFileSync(FONT_PATH);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    font = parseFont(ab);
  }
  return font;
}

/** Flatten an opentype path (already in y-down px space) into closed contours. */
function flatten(path: Path): Contour[] {
  const contours: Contour[] = [];
  let cur: Contour = [];
  let sx = 0;
  let sy = 0;
  let cx = 0;
  let cy = 0;
  const close = () => {
    if (cur.length > 1) contours.push(cur);
    cur = [];
  };
  for (const cmd of path.commands) {
    switch (cmd.type) {
      case "M":
        close();
        sx = cx = cmd.x;
        sy = cy = cmd.y;
        cur.push({ x: cx, y: cy });
        break;
      case "L":
        cx = cmd.x;
        cy = cmd.y;
        cur.push({ x: cx, y: cy });
        break;
      case "Q":
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const t = i / CURVE_STEPS;
          const u = 1 - t;
          cur.push({
            x: u * u * cx + 2 * u * t * cmd.x1 + t * t * cmd.x,
            y: u * u * cy + 2 * u * t * cmd.y1 + t * t * cmd.y,
          });
        }
        cx = cmd.x;
        cy = cmd.y;
        break;
      case "C":
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const t = i / CURVE_STEPS;
          const u = 1 - t;
          cur.push({
            x: u * u * u * cx + 3 * u * u * t * cmd.x1 + 3 * u * t * t * cmd.x2 + t * t * t * cmd.x,
            y: u * u * u * cy + 3 * u * u * t * cmd.y1 + 3 * u * t * t * cmd.y2 + t * t * t * cmd.y,
          });
        }
        cx = cmd.x;
        cy = cmd.y;
        break;
      case "Z":
        cur.push({ x: sx, y: sy });
        cx = sx;
        cy = sy;
        close();
        break;
    }
  }
  close();
  return contours;
}

function rasterize(contours: Contour[]): Uint8Array {
  const out = new Uint8Array(GLYPH_WIDTH * GLYPH_HEIGHT);
  if (contours.length === 0) return out;

  const sw = GLYPH_WIDTH * SS_X;
  const samplesPerPixel = SS_X * SS_Y;
  const counts = new Uint16Array(GLYPH_WIDTH);
  const xs: number[] = [];
  for (let row = 0; row < GLYPH_HEIGHT; row++) {
    counts.fill(0);
    for (let sub = 0; sub < SS_Y; sub++) {
      const y = row + (sub + 0.5) / SS_Y;
      xs.length = 0;
      for (const c of contours) {
        for (let i = 0; i < c.length - 1; i++) {
          const p0 = c[i];
          const p1 = c[i + 1];
          if ((p0.y <= y && p1.y > y) || (p1.y <= y && p0.y > y)) {
            xs.push(p0.x + ((y - p0.y) * (p1.x - p0.x)) / (p1.y - p0.y));
          }
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        let s0 = Math.ceil(xs[k] * SS_X - 0.5);
        let s1 = Math.floor(xs[k + 1] * SS_X - 0.5);
        if (s0 < 0) s0 = 0;
        if (s1 >= sw) s1 = sw - 1;
        for (let s = s0; s <= s1; s++) {
          const center = (s + 0.5) / SS_X;
          if (center >= xs[k] && center < xs[k + 1]) counts[(s / SS_X) | 0]++;
        }
      }
    }
    for (let col = 0; col < GLYPH_WIDTH; col++) {
      out[row * GLYPH_WIDTH + col] = Math.round((counts[col] * 255) / samplesPerPixel);
    }
  }
  return out;
}

function glyphCoverage(c: number): Uint8Array {
  const cached = coverageCache.get(c);
  if (cached) return cached;

  let coverage = new Uint8Array(GLYPH_WIDTH * GLYPH_HEIGHT);
  if (c >= FIRST_CHAR && c <= LAST_CHAR && c !== 0x20) {
    const f = loadFont();
    const glyphIndex = f.charToGlyphIndex(String.fromCharCode(c));
    if (glyphIndex > 0) {
      const glyph = f.glyphs.get(glyphIndex);
      coverage = rasterize(flatten(glyph.getPath(PEN_X, BASELINE, FONT_SIZE)));
    }
  }
  coverageCache.set(c, coverage);
  return coverage;
}

/**
 * Rasterize char code `c` into an 8x8 GBA palette-index cell.
 *
 * `inkStart` is the first coverage shade. `levels` shades are used in ascending
 * order from faint edge coverage to full ink. `bg` fills zero-coverage pixels.
 */
export function glyphPixels(c: number, inkStart: number, bg: number, levels = 1): number[] {
  const cov = glyphCoverage(c);
  const out = new Array<number>(GLYPH_WIDTH * GLYPH_HEIGHT);
  for (let i = 0; i < out.length; i++) {
    const v = cov[i];
    if (v === 0 || levels <= 0) {
      out[i] = bg;
    } else {
      const boosted = Math.pow(v / 255, 0.68);
      const shade = Math.min(levels - 1, Math.max(0, Math.ceil(boosted * levels) - 1));
      out[i] = inkStart + shade;
    }
  }
  return out;
}
