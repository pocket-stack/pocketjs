// saga/compiler/cjk.ts — GNU Unifont loader (copied from aot; same font asset).
//
// Unifont ships every BMP glyph as a 16px-tall 1-bit bitmap in .hex format:
// one line per codepoint, "XXXX:<hex>", where halfwidth glyphs are 8px wide
// (32 hex digits) and fullwidth glyphs 16px wide (64 hex digits). That makes
// it the single cross-target glyph source: the compiler bakes only the glyphs
// a game actually uses, in each target's native tile encoding.
//
// Unifont is dual-licensed (GNU GPLv2+ with the font embedding exception /
// SIL OFL 1.1); embedding rendered glyphs in a ROM is explicitly permitted.

import { gunzipSync } from "bun";
import { readFileSync } from "node:fs";

const HEX_PATH = new URL("../../assets/fonts/unifont-16.0.04.hex.gz", import.meta.url).pathname;

export interface UnifontGlyph {
  /** 8 or 16 pixels wide; always 16 tall. */
  width: 8 | 16;
  /** 16 rows; each row is a bitmask, MSB = leftmost pixel. */
  rows: Uint16Array; // length 16
}

let table: Map<number, UnifontGlyph> | null = null;

function load(): Map<number, UnifontGlyph> {
  if (table) return table;
  const text = new TextDecoder().decode(gunzipSync(readFileSync(HEX_PATH)));
  table = new Map();
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const cp = parseInt(line.slice(0, colon), 16);
    const hex = line.slice(colon + 1).trim();
    if (hex.length !== 32 && hex.length !== 64) continue;
    const width = hex.length === 32 ? 8 : 16;
    const rows = new Uint16Array(16);
    const digitsPerRow = width / 4;
    for (let r = 0; r < 16; r++) {
      rows[r] = parseInt(hex.slice(r * digitsPerRow, (r + 1) * digitsPerRow), 16);
    }
    table.set(cp, { width: width as 8 | 16, rows });
  }
  return table;
}

/** Glyph for a codepoint, or null if Unifont has none. */
export function unifontGlyph(cp: number): UnifontGlyph | null {
  return load().get(cp) ?? null;
}

/** True if the char renders fullwidth (2 halfcells). ASCII is halfwidth. */
export function isFullwidth(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  if (cp <= 0x7e) return false;
  const g = unifontGlyph(cp);
  if (!g) return true; // unknown chars reserve a full cell (rendered blank)
  return g.width === 16;
}

/**
 * Rasterize one halfcell (8x16 column) of a glyph into two stacked 8x8
 * palette-index tiles: [top 64 px, bottom 64 px], row-major.
 *
 * `half` selects the left (0) or right (1) 8px column of a 16px glyph.
 * `ink`/`bg` are the palette indices to write.
 */
export function halfcellPixels(
  glyph: UnifontGlyph | null,
  half: 0 | 1,
  ink: number,
  bg: number,
): [number[], number[]] {
  const top = new Array<number>(64).fill(bg);
  const bottom = new Array<number>(64).fill(bg);
  if (glyph) {
    const shiftBase = glyph.width - 8 * (half + 1); // bits below the column
    for (let y = 0; y < 16; y++) {
      const row = glyph.rows[y];
      const dst = y < 8 ? top : bottom;
      const dy = y & 7;
      for (let x = 0; x < 8; x++) {
        const bit = (row >> (shiftBase + 7 - x)) & 1;
        if (bit) dst[dy * 8 + x] = ink;
      }
    }
  }
  return [top, bottom];
}
