// static/compiler/assets.ts — neutral art -> native tile encodings.
//
// Neutral form everywhere upstream: 8x8 tiles / 16x16 sprite frames as rows
// of hex nibbles indexing a <=16-color RGB palette (index 0 = backdrop/
// transparent). This file owns the three native encodings:
//
//   GBA  4bpp packed: 32 B/tile, low nibble = LEFT pixel of the pair
//   GB   2bpp interleaved: 16 B/tile, per row lo-bitplane byte then hi byte,
//        MSB = leftmost pixel
//   NES  2bpp planar: 16 B/tile, 8 bytes plane 0 then 8 bytes plane 1
//
// Color reduction (GB shades / NES subpalettes) happens here too: GB maps
// palette entries to 4 shades by luma; NES picks the nearest entries of the
// canonical 64-color master palette.

import { rgb555 } from "../spec/isa.ts";
import type { Rgb } from "../rpg/dsl.ts";

export type TilePx = Uint8Array; // 64 palette indices, row-major

export function tileFromHexRows(rows: readonly string[]): TilePx {
  if (rows.length !== 8) throw new Error(`tile needs 8 rows (got ${rows.length})`);
  const px = new Uint8Array(64);
  rows.forEach((row, y) => {
    if (row.length !== 8) throw new Error(`tile row ${y} needs 8 nibbles (got "${row}")`);
    for (let x = 0; x < 8; x++) {
      const v = parseInt(row[x], 16);
      if (Number.isNaN(v)) throw new Error(`bad hex nibble "${row[x]}" in tile row "${row}"`);
      px[y * 8 + x] = v;
    }
  });
  return px;
}

/** 16x16 frame (16 rows x 16 nibbles) -> 4 tiles in TL,TR,BL,BR order. */
export function frameToTiles(rows: readonly string[]): TilePx[] {
  if (rows.length !== 16 || rows.some((r) => r.length !== 16)) {
    throw new Error("sprite frames are 16 rows x 16 hex nibbles");
  }
  const quad = (ox: number, oy: number): TilePx => {
    const px = new Uint8Array(64);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        px[y * 8 + x] = parseInt(rows[oy + y][ox + x], 16);
      }
    }
    return px;
  };
  return [quad(0, 0), quad(8, 0), quad(0, 8), quad(8, 8)];
}

export function hflipTile(px: TilePx): TilePx {
  const out = new Uint8Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out[y * 8 + x] = px[y * 8 + (7 - x)];
  return out;
}

/** Solid fill tile. */
export const fillTile = (index: number): TilePx => new Uint8Array(64).fill(index);

/** 1-bit glyph bitmap (8 bytes, MSB left) -> TilePx with ink/bg indices. */
export function glyphTile(bitmap: readonly number[], ink: number, bg: number): TilePx {
  const px = new Uint8Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      px[y * 8 + x] = bitmap[y] & (0x80 >> x) ? ink : bg;
    }
  }
  return px;
}

// ---------------------------------------------------------------------------
// Native encodings
// ---------------------------------------------------------------------------
export function encodeTileGba(px: TilePx): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const left = px[i * 2] & 0xf;
    const right = px[i * 2 + 1] & 0xf;
    out[i] = left | (right << 4);
  }
  return out;
}

/** 2-bit-depth encoders share a per-pixel value map (palette idx -> 0..3). */
export function encodeTileGb(px: TilePx, valueOf: (idx: number) => number): Uint8Array {
  const out = new Uint8Array(16);
  for (let y = 0; y < 8; y++) {
    let lo = 0;
    let hi = 0;
    for (let x = 0; x < 8; x++) {
      const v = valueOf(px[y * 8 + x]) & 3;
      if (v & 1) lo |= 0x80 >> x;
      if (v & 2) hi |= 0x80 >> x;
    }
    out[y * 2] = lo;
    out[y * 2 + 1] = hi;
  }
  return out;
}

export function encodeTileNes(px: TilePx, valueOf: (idx: number) => number): Uint8Array {
  const out = new Uint8Array(16);
  for (let y = 0; y < 8; y++) {
    let p0 = 0;
    let p1 = 0;
    for (let x = 0; x < 8; x++) {
      const v = valueOf(px[y * 8 + x]) & 3;
      if (v & 1) p0 |= 0x80 >> x;
      if (v & 2) p1 |= 0x80 >> x;
    }
    out[y] = p0;
    out[8 + y] = p1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Color reduction
// ---------------------------------------------------------------------------
export const luma = ([r, g, b]: Rgb): number => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * GB (DMG): palette index -> shade 0..3 (0 = lightest under the standard
 * BGP). Index 0 maps to 0 (backdrop/transparent). Others rank by luma:
 * brighter -> lower shade value.
 */
export function gbShadeLut(palette: readonly Rgb[]): (idx: number) => number {
  const lut = new Uint8Array(16);
  for (let i = 1; i < palette.length; i++) {
    const l = luma(palette[i]);
    lut[i] = l >= 200 ? 0 : l >= 130 ? 1 : l >= 60 ? 2 : 3;
  }
  // Backdrop stays 0; but a non-transparent tile pixel that DELIBERATELY uses
  // index 0 also renders as shade 0 — acceptable: index 0 is "background".
  return (idx) => lut[idx & 0xf];
}

/** GBA: neutral palette -> BGR555 bank (16 entries, index 0 kept as-is). */
export function gbaPaletteBank(palette: readonly Rgb[]): Uint16Array {
  const bank = new Uint16Array(16);
  palette.forEach(([r, g, b], i) => {
    bank[i] = rgb555(r, g, b);
  });
  return bank;
}

// The canonical 64-color NES master palette (2C02, the ubiquitous table).
// prettier-ignore
export const NES_MASTER: Rgb[] = [
  [84,84,84],[0,30,116],[8,16,144],[48,0,136],[68,0,100],[92,0,48],[84,4,0],[60,24,0],
  [32,42,0],[8,58,0],[0,64,0],[0,60,0],[0,50,60],[0,0,0],[0,0,0],[0,0,0],
  [152,150,152],[8,76,196],[48,50,236],[92,30,228],[136,20,176],[160,20,100],[152,34,32],[120,60,0],
  [84,90,0],[40,114,0],[8,124,0],[0,118,40],[0,102,120],[0,0,0],[0,0,0],[0,0,0],
  [236,238,236],[76,154,236],[120,124,236],[176,98,236],[228,84,236],[236,88,180],[236,106,100],[212,136,32],
  [160,170,0],[116,196,0],[76,208,32],[56,204,108],[56,180,204],[60,60,60],[0,0,0],[0,0,0],
  [236,238,236],[168,204,236],[188,188,236],[212,178,236],[236,174,236],[236,174,212],[236,180,176],[228,196,144],
  [204,210,120],[180,222,120],[168,226,144],[152,226,180],[160,214,228],[160,162,160],[0,0,0],[0,0,0],
];

export function nearestNesColor([r, g, b]: Rgb): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < NES_MASTER.length; i++) {
    if ((i & 0x0f) >= 0x0e) continue; // skip the mirrored blacks
    const [nr, ng, nb] = NES_MASTER[i];
    const d = 3 * (r - nr) ** 2 + 6 * (g - ng) ** 2 + (b - nb) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * NES: reduce a <=16-color neutral palette to ONE 4-entry subpalette
 * (v1 keeps one BG subpalette for art + one for the textbox, one OBJ
 * subpalette per sprite). Entry 0 is the shared backdrop. Returns the
 * subpalette (NES master indices) + the pixel value LUT.
 */
export function nesReduce(palette: readonly Rgb[], backdrop: number): {
  subpal: [number, number, number, number];
  valueOf: (idx: number) => number;
} {
  // Pick the 3 most distinct colors by a simple max-min-distance greedy.
  const entries = palette.slice(1).map((rgb, i) => ({ rgb, idx: i + 1 }));
  const chosen: { rgb: Rgb; idx: number }[] = [];
  const dist = (a: Rgb, b: Rgb) => 3 * (a[0] - b[0]) ** 2 + 6 * (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  while (chosen.length < 3 && entries.length > 0) {
    let pick = 0;
    if (chosen.length === 0) {
      // start with the most saturated/extreme color (farthest from grey)
      let bestScore = -1;
      entries.forEach((e, i) => {
        const l = luma(e.rgb);
        const score = dist(e.rgb, [l, l, l] as unknown as Rgb) + l;
        if (score > bestScore) {
          bestScore = score;
          pick = i;
        }
      });
    } else {
      let bestScore = -1;
      entries.forEach((e, i) => {
        const score = Math.min(...chosen.map((c) => dist(e.rgb, c.rgb)));
        if (score > bestScore) {
          bestScore = score;
          pick = i;
        }
      });
    }
    chosen.push(entries.splice(pick, 1)[0]);
  }
  while (chosen.length < 3) chosen.push({ rgb: [0, 0, 0], idx: 0 });

  const subpal: [number, number, number, number] = [
    backdrop,
    nearestNesColor(chosen[0].rgb),
    nearestNesColor(chosen[1].rgb),
    nearestNesColor(chosen[2].rgb),
  ];
  const lut = new Uint8Array(16);
  for (let i = 1; i < palette.length; i++) {
    let best = 1;
    let bestD = Infinity;
    for (let c = 0; c < 3; c++) {
      const d = dist(palette[i], chosen[c].rgb);
      if (d < bestD) {
        bestD = d;
        best = c + 1;
      }
    }
    lut[i] = best;
  }
  return { subpal, valueOf: (idx) => lut[idx & 0xf] };
}
