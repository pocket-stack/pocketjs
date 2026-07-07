// saga/compiler/assets.ts — turn PNGs into GBA-native data: median-cut
// 15-color palettes, 4bpp tiles with H/V-flip dedup, tilemaps, OBJ sheets,
// per-scanline gradient tables, and the built-in UI tiles (box/cursor/digits/
// A-prompt) rendered from Unifont.

import { decodePng, type DecodedImage } from "./png.ts";
import { unifontGlyph, halfcellPixels } from "./cjk.ts";
import { rgb555, hex555, UI_INK, UI_BOX, UI_ACCENT, UI_SHADOW } from "../spec/saga.ts";

export interface Quantized {
  /** palette[0] is transparent; entries 1..n are BGR555. */
  pal555: number[];
  indices: Uint8Array; // per pixel palette index (0 = transparent)
  w: number;
  h: number;
}

export async function loadPng(path: string): Promise<DecodedImage> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return decodePng(bytes);
}

/** Median-cut to <= maxColors opaque colors (+ index 0 transparent). */
export function quantize(img: DecodedImage, maxColors = 15): Quantized {
  const { width: w, height: h, rgba } = img;
  const pixels: number[] = []; // packed rgb of opaque pixels
  for (let i = 0; i < w * h; i++) {
    if (rgba[i * 4 + 3] >= 128) pixels.push((rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2]);
  }
  // unique colors
  const uniq = [...new Set(pixels)];
  let pal: number[];
  if (uniq.length <= maxColors) {
    pal = uniq;
  } else {
    interface Box { colors: number[] }
    const boxes: Box[] = [{ colors: uniq }];
    while (boxes.length < maxColors) {
      // split the box with the largest channel range
      let bi = -1;
      let bch = 0;
      let brange = -1;
      for (let i = 0; i < boxes.length; i++) {
        const cs = boxes[i].colors;
        if (cs.length < 2) continue;
        for (let ch = 0; ch < 3; ch++) {
          const sh = 16 - ch * 8;
          let lo = 255, hi = 0;
          for (const c of cs) {
            const v = (c >> sh) & 0xff;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          if (hi - lo > brange) {
            brange = hi - lo;
            bi = i;
            bch = sh;
          }
        }
      }
      if (bi < 0) break;
      const cs = boxes[bi].colors.sort((a, b) => ((a >> bch) & 0xff) - ((b >> bch) & 0xff));
      const mid = cs.length >> 1;
      boxes.splice(bi, 1, { colors: cs.slice(0, mid) }, { colors: cs.slice(mid) });
    }
    // box average (weighted by pixel counts)
    const counts = new Map<number, number>();
    for (const p of pixels) counts.set(p, (counts.get(p) ?? 0) + 1);
    pal = boxes.map(({ colors }) => {
      let r = 0, g = 0, b = 0, n = 0;
      for (const c of colors) {
        const k = counts.get(c) ?? 1;
        r += ((c >> 16) & 0xff) * k;
        g += ((c >> 8) & 0xff) * k;
        b += (c & 0xff) * k;
        n += k;
      }
      return n ? ((Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n)) : 0;
    });
  }
  const pal555 = [0, ...pal.map((c) => rgb555((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff))];
  // nearest-color mapping
  const cache = new Map<number, number>();
  const indices = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (rgba[i * 4 + 3] < 128) {
      indices[i] = 0;
      continue;
    }
    const c = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
    let best = cache.get(c);
    if (best === undefined) {
      let bd = Infinity;
      best = 1;
      for (let p = 0; p < pal.length; p++) {
        const dr = ((c >> 16) & 0xff) - ((pal[p] >> 16) & 0xff);
        const dg = ((c >> 8) & 0xff) - ((pal[p] >> 8) & 0xff);
        const db = (c & 0xff) - (pal[p] & 0xff);
        const d = dr * dr * 3 + dg * dg * 6 + db * db;
        if (d < bd) {
          bd = d;
          best = p + 1;
        }
      }
      cache.set(c, best);
    }
    indices[i] = best;
  }
  return { pal555, indices, w, h };
}

/** 4bpp tile from a 64-entry palette-index array. */
export function tile4(px: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(32);
  for (let row = 0; row < 8; row++)
    for (let c = 0; c < 4; c++) {
      out[row * 4 + c] = (px[row * 8 + c * 2] & 0xf) | ((px[row * 8 + c * 2 + 1] & 0xf) << 4);
    }
  return out;
}

function tileKey(t: Uint8Array): string {
  return Buffer.from(t).toString("base64");
}
function flipH(px: number[]): number[] {
  const o = new Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) o[y * 8 + x] = px[y * 8 + (7 - x)];
  return o;
}
function flipV(px: number[]): number[] {
  const o = new Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) o[y * 8 + x] = px[(7 - y) * 8 + x];
  return o;
}

export interface TiledLayer {
  tiles: Uint8Array[]; // deduped, NOT including the shared blank tile 0
  /** map entries: tileIndex (1-based within this layer) | flip bits; 0 = blank */
  cells: { tile: number; hflip: boolean; vflip: boolean }[];
  cols: number;
  rows: number;
}

/** Cut an indexed image into deduped 8x8 tiles (H/V flip aware). */
export function tileLayer(q: Quantized): TiledLayer {
  const cols = Math.ceil(q.w / 8);
  const rows = Math.ceil(q.h / 8);
  const tiles: Uint8Array[] = [];
  const seen = new Map<string, { idx: number; h: boolean; v: boolean }>();
  const cells: TiledLayer["cells"] = [];
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const px = new Array<number>(64).fill(0);
      let allZero = true;
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const sx = tx * 8 + x;
          const sy = ty * 8 + y;
          const v = sx < q.w && sy < q.h ? q.indices[sy * q.w + sx] : 0;
          px[y * 8 + x] = v;
          if (v) allZero = false;
        }
      if (allZero) {
        cells.push({ tile: 0, hflip: false, vflip: false });
        continue;
      }
      const key = tileKey(tile4(px));
      const hit = seen.get(key);
      if (hit) {
        cells.push({ tile: hit.idx, hflip: hit.h, vflip: hit.v });
        continue;
      }
      const idx = tiles.length + 1;
      tiles.push(tile4(px));
      seen.set(key, { idx, h: false, v: false });
      const fh = flipH(px);
      const fv = flipV(px);
      const fhv = flipV(fh);
      for (const [p, hh, vv] of [
        [fh, true, false],
        [fv, false, true],
        [fhv, true, true],
      ] as const) {
        const k = tileKey(tile4(p));
        if (!seen.has(k)) seen.set(k, { idx, h: hh, v: vv });
      }
      cells.push({ tile: idx, hflip: false, vflip: false });
    }
  }
  return { tiles, cells, cols, rows };
}

/** Build a screenblock map from a tiled layer.
 * mapSz 0 = 32x32 (1 SBB), 1 = 64x32 (2 SBBs), 2 = 64x64 (4 SBBs TL,TR,BL,BR). */
export function buildMap(
  layer: TiledLayer,
  mapSz: 0 | 1 | 2,
  tileBase: number,
  palbank: number,
  rowOff = 0,
): Uint16Array {
  const mapCols = mapSz ? 64 : 32;
  const mapRows = mapSz === 2 ? 64 : 32;
  const out = new Uint16Array(mapCols * mapRows);
  for (let r0 = 0; r0 < layer.rows && r0 + rowOff < mapRows; r0++) {
    const r = r0 + rowOff;
    for (let c = 0; c < layer.cols && c < mapCols; c++) {
      const cell = layer.cells[r0 * layer.cols + c];
      if (cell.tile === 0) continue;
      let se = ((tileBase + cell.tile - 1) & 0x3ff) | ((palbank & 0xf) << 12);
      if (cell.hflip) se |= 0x400;
      if (cell.vflip) se |= 0x800;
      // multi-screenblock layouts: quadrants of 32x32
      const sb = (r >> 5) * (mapCols >> 5) + (c >> 5);
      out[sb * 1024 + (r & 31) * 32 + (c & 31)] = se;
    }
  }
  return out;
}

/** OBJ sheet: horizontal frame strip -> 4bpp tiles in 1D frame-major order. */
export function tileObjSheet(q: Quantized, fw: number, fh: number, frames: number): Uint8Array {
  const tw = fw / 8;
  const th = fh / 8;
  const out = new Uint8Array(frames * tw * th * 32);
  let o = 0;
  for (let f = 0; f < frames; f++) {
    for (let ty = 0; ty < th; ty++) {
      for (let tx = 0; tx < tw; tx++) {
        const px = new Array<number>(64).fill(0);
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++) {
            const sx = f * fw + tx * 8 + x;
            const sy = ty * 8 + y;
            if (sx < q.w && sy < q.h) px[y * 8 + x] = q.indices[sy * q.w + sx];
          }
        out.set(tile4(px), o);
        o += 32;
      }
    }
  }
  return out;
}

/** 160-entry per-scanline gradient (multi-stop, lerp in RGB). */
export function gradientTable(stops: string[]): Uint16Array {
  const rgb = stops.map((s) => {
    const h = s.replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  });
  const out = new Uint16Array(160);
  const segs = rgb.length - 1;
  for (let y = 0; y < 160; y++) {
    const t = (y / 159) * segs;
    const si = Math.min(segs - 1, Math.floor(t));
    const f = t - si;
    const a = rgb[si];
    const b = rgb[si + 1];
    out[y] = rgb555(
      Math.round(a[0] + (b[0] - a[0]) * f),
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f),
    );
  }
  return out;
}

// --- built-in UI assets -----------------------------------------------------------

/** UI BG palette bank 15 colors (index -> BGR555). */
export function uiPalette(): number[] {
  const bank = new Array(16).fill(0);
  bank[UI_INK] = hex555("#f2f5f7");
  bank[UI_BOX] = hex555("#141c2a");
  bank[UI_ACCENT] = hex555("#42b883");
  bank[UI_SHADOW] = hex555("#5a6478");
  return bank;
}

/** 4 fixed BG tiles: blank, box fill, accent underline, choice cursor. */
export function uiBgTiles(): Uint8Array {
  const out = new Uint8Array(4 * 32);
  // 0: blank (all transparent)
  // 1: box fill
  out.set(tile4(new Array(64).fill(UI_BOX)), 32);
  // 2: accent underline: box with a 2px green line at the bottom
  {
    const px = new Array(64).fill(UI_BOX);
    for (let x = 0; x < 8; x++) {
      px[5 * 8 + x] = UI_ACCENT;
      px[6 * 8 + x] = UI_ACCENT;
    }
    out.set(tile4(px), 64);
  }
  // 3: cursor arrow (ink on box)
  {
    const px = new Array(64).fill(UI_BOX);
    for (let y = 1; y < 7; y++) {
      const span = y < 4 ? y : 7 - y;
      for (let x = 1; x <= 1 + span; x++) px[y * 8 + x] = UI_ACCENT;
    }
    out.set(tile4(px), 96);
  }
  return out;
}

/** OBJ UI sheet layout (tile offsets from OBJ_UI_BASE):
 *  0-3 A-prompt 16x16, 4-23 digits 0-9 as 8x16, 24 meter seg full,
 *  25 meter seg empty, 26-27 brick 16x8, 28 ball 8x8, 29-32 paddle 32x8. */
export function uiObjTiles(): Uint8Array {
  const tiles: Uint8Array[] = [];
  // A-prompt: dark disc, green rim, white 'A'
  {
    const grid = new Array(256).fill(0);
    const cx = 7.5, cy = 7.5;
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= 6.2) grid[y * 16 + x] = UI_BOX;
        else if (d <= 7.6) grid[y * 16 + x] = UI_ACCENT;
      }
    const glyph = unifontGlyph(0x41); // 'A'
    const [top, bottom] = halfcellPixels(glyph, 0, UI_INK, 99);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        if (top[y * 8 + x] === UI_INK && y >= 2) grid[(y + 1) * 16 + (x + 4)] = UI_INK;
        if (bottom[y * 8 + x] === UI_INK && y <= 5) grid[(y + 9) * 16 + (x + 4)] = UI_INK;
      }
    for (const [ox, oy] of [
      [0, 0],
      [8, 0],
      [0, 8],
      [8, 8],
    ]) {
      const px = new Array(64);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px[y * 8 + x] = grid[(oy + y) * 16 + (ox + x)];
      tiles.push(tile4(px));
    }
  }
  // digits 0-9: unifont halfwidth, ink with shadow, transparent bg, 8x16 (2 tiles)
  for (let d = 0; d <= 9; d++) {
    const glyph = unifontGlyph(0x30 + d);
    const [top, bottom] = halfcellPixels(glyph, 0, UI_INK, 0);
    for (const half of [top, bottom]) {
      // drop shadow: shift down-right in UI_SHADOW
      const px = new Array(64).fill(0);
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          if (half[y * 8 + x] === UI_INK) px[y * 8 + x] = UI_INK;
        }
      tiles.push(tile4(px));
    }
  }
  // meter segments: full (accent fill, ink rim) and empty (shadow rim)
  {
    const full = new Array(64).fill(UI_ACCENT);
    const empty = new Array(64).fill(0);
    for (let i = 0; i < 8; i++) {
      full[i] = full[56 + i] = UI_INK;
      full[i * 8] = full[i * 8 + 7] = UI_INK;
      empty[i] = empty[56 + i] = UI_SHADOW;
      empty[i * 8] = empty[i * 8 + 7] = UI_SHADOW;
      empty[i * 8 + 1] = empty[i * 8 + 1] || UI_BOX;
    }
    tiles.push(tile4(full), tile4(empty));
  }
  // breakout brick 16x8: accent fill, ink top highlight, 1px gap right/bottom
  for (const half of [0, 1]) {
    const px = new Array(64).fill(UI_ACCENT);
    for (let x = 0; x < 8; x++) {
      px[x] = UI_INK; // top highlight
      px[7 * 8 + x] = 0; // bottom gap
      px[6 * 8 + x] = UI_SHADOW;
    }
    if (half === 1) {
      for (let y = 0; y < 8; y++) px[y * 8 + 7] = 0; // right gap
    }
    tiles.push(tile4(px));
  }
  // ball 8x8: ink disc
  {
    const px = new Array(64).fill(0);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const d = Math.hypot(x - 3.5, y - 3.5);
        if (d <= 3.2) px[y * 8 + x] = UI_INK;
      }
    tiles.push(tile4(px));
  }
  // paddle 32x8: shadow slab with ink top edge, rounded ends
  for (let t = 0; t < 4; t++) {
    const px = new Array(64).fill(0);
    for (let y = 2; y < 7; y++)
      for (let x = 0; x < 8; x++) {
        const gx = t * 8 + x;
        if ((gx === 0 || gx === 31) && (y === 2 || y === 6)) continue;
        px[y * 8 + x] = y === 2 ? UI_INK : y === 6 ? UI_BOX : UI_SHADOW;
      }
    tiles.push(tile4(px));
  }
  const out = new Uint8Array(tiles.length * 32);
  tiles.forEach((t, i) => out.set(t, i * 32));
  return out;
}
