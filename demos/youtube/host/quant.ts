// demos/youtube/host/quant.ts — RGBA -> CLUT8 quantization for the PSP GE.
//
// Everything Pocket YouTube ships to the device is PSM_T8 (one palette
// index per pixel + a 256 x u32 ABGR CLUT): video plane frames, thumbnail
// cards, title strips. This module is the host-side half of that contract —
// a histogram median-cut over 15-bit RGB bins (32768 buckets caps the box
// math regardless of image size) plus optional serpentine Floyd–Steinberg
// dithering, which hides both banding and frame-to-frame palette flicker at
// video rates.
//
// Deterministic by construction (no Math.random seeds, stable tie-breaks) so
// tests can golden the output.

export interface Quantized {
  /** 256 entries, u32 ABGR (0xAABBGGRR — the GE CLUT layout), always opaque. */
  palette: Uint32Array;
  /** w*h palette indices, row-major. */
  indices: Uint8Array;
}

interface Box {
  /** 15-bit bin ids covered by this box (histogram-weighted). */
  bins: number[];
  count: number;
  rMin: number;
  rMax: number;
  gMin: number;
  gMax: number;
  bMin: number;
  bMax: number;
}

const BIN_COUNT = 1 << 15;

function binOf(r: number, g: number, b: number): number {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

function binChannels(bin: number): [number, number, number] {
  // Bin center (the +4 halves the 8-value quantization step).
  return [((bin >> 10) << 3) + 4, (((bin >> 5) & 31) << 3) + 4, ((bin & 31) << 3) + 4];
}

function boxOf(bins: number[], hist: Uint32Array): Box {
  const box: Box = {
    bins,
    count: 0,
    rMin: 255,
    rMax: 0,
    gMin: 255,
    gMax: 0,
    bMin: 255,
    bMax: 0,
  };
  for (const bin of bins) {
    const [r, g, b] = binChannels(bin);
    box.count += hist[bin];
    if (r < box.rMin) box.rMin = r;
    if (r > box.rMax) box.rMax = r;
    if (g < box.gMin) box.gMin = g;
    if (g > box.gMax) box.gMax = g;
    if (b < box.bMin) box.bMin = b;
    if (b > box.bMax) box.bMax = b;
  }
  return box;
}

/** Per-bin channel accumulators — palette entries are the MEAN of the real
 *  pixels in each box, not bin centers: with dithering, a constant center
 *  bias (up to 4/channel) accumulates into speckle on flat areas. */
export interface BinSums {
  hist: Uint32Array;
  r: Float64Array;
  g: Float64Array;
  b: Float64Array;
}

/** Median-cut palette over the image's occupied 15-bit bins. */
function medianCut(sums: BinSums, colors: number): Uint32Array {
  const hist = sums.hist;
  const occupied: number[] = [];
  for (let bin = 0; bin < BIN_COUNT; bin++) {
    if (hist[bin] > 0) occupied.push(bin);
  }
  const boxes: Box[] = [boxOf(occupied, hist)];
  while (boxes.length < colors) {
    // Split the most populous box with any spread left; stop when every box
    // is a single bin (image has fewer distinct colors than the palette).
    let pick = -1;
    let pickCount = 0;
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i];
      const spread = bx.rMax - bx.rMin + (bx.gMax - bx.gMin) + (bx.bMax - bx.bMin);
      if (bx.bins.length > 1 && spread > 0 && bx.count > pickCount) {
        pick = i;
        pickCount = bx.count;
      }
    }
    if (pick < 0) break;
    const bx = boxes[pick];
    const rSpread = bx.rMax - bx.rMin;
    const gSpread = bx.gMax - bx.gMin;
    const bSpread = bx.bMax - bx.bMin;
    const axis = gSpread >= rSpread && gSpread >= bSpread ? 1 : rSpread >= bSpread ? 0 : 2;
    const sorted = [...bx.bins].sort((a, b) => binChannels(a)[axis] - binChannels(b)[axis]);
    // Histogram-weighted median: split where half the pixel mass falls.
    let acc = 0;
    let split = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      acc += hist[sorted[i]];
      split = i + 1;
      if (acc * 2 >= bx.count) break;
    }
    boxes[pick] = boxOf(sorted.slice(0, split), hist);
    boxes.push(boxOf(sorted.slice(split), hist));
  }
  const palette = new Uint32Array(colors);
  for (let i = 0; i < boxes.length; i++) {
    // True mean color of the box's pixels (see BinSums).
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (const bin of boxes[i].bins) {
      r += sums.r[bin];
      g += sums.g[bin];
      b += sums.b[bin];
      n += hist[bin];
    }
    if (n === 0) continue;
    palette[i] =
      ((0xff << 24) |
        ((Math.round(b / n) & 255) << 16) |
        ((Math.round(g / n) & 255) << 8) |
        (Math.round(r / n) & 255)) >>>
      0;
  }
  // Unused tail entries stay opaque black rather than transparent garbage.
  for (let i = boxes.length; i < colors; i++) palette[i] = 0xff000000;
  return palette;
}

/** Nearest palette index by squared RGB distance (stable: first best wins). */
function nearest(palette: Uint32Array, r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const dr = (p & 255) - r;
    const dg = ((p >>> 8) & 255) - g;
    const db = ((p >>> 16) & 255) - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export interface QuantizeOptions {
  /** Floyd–Steinberg serpentine dithering (default true — hides banding AND
   *  per-frame palette flicker at video rates). */
  dither?: boolean;
}

/**
 * Quantize RGBA pixels to a 256-color CLUT8 image. Alpha is ignored (the
 * device formats this feeds are opaque planes: video frames, cards).
 */
export function quantize(
  rgba: Uint8Array,
  w: number,
  h: number,
  opts: QuantizeOptions = {},
): Quantized {
  if (rgba.length !== w * h * 4) {
    throw new Error(`quantize: rgba length ${rgba.length} != ${w}x${h}*4`);
  }
  const dither = opts.dither ?? true;
  const sums: BinSums = {
    hist: new Uint32Array(BIN_COUNT),
    r: new Float64Array(BIN_COUNT),
    g: new Float64Array(BIN_COUNT),
    b: new Float64Array(BIN_COUNT),
  };
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const bin = binOf(r, g, b);
    sums.hist[bin]++;
    sums.r[bin] += r;
    sums.g[bin] += g;
    sums.b[bin] += b;
  }
  const palette = medianCut(sums, 256);
  const indices = new Uint8Array(w * h);
  // Lazy nearest-neighbor cache over 15-bit bins: dithered error offsets
  // create colors outside the histogram, so the cache covers all bins.
  const lut = new Int16Array(BIN_COUNT).fill(-1);
  const lookup = (r: number, g: number, b: number): number => {
    const bin = binOf(r, g, b);
    let idx = lut[bin];
    if (idx < 0) {
      idx = nearest(palette, r, g, b);
      lut[bin] = idx;
    }
    return idx;
  };
  if (!dither) {
    for (let i = 0; i < w * h; i++) {
      indices[i] = lookup(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    }
    return { palette, indices };
  }
  // Serpentine FS over f32 error buffers (two rows).
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
  let cur = new Float32Array((w + 2) * 3);
  let nxt = new Float32Array((w + 2) * 3);
  for (let y = 0; y < h; y++) {
    nxt.fill(0);
    const ltr = y % 2 === 0;
    for (let step = 0; step < w; step++) {
      const x = ltr ? step : w - 1 - step;
      const px = (y * w + x) * 4;
      const e = (x + 1) * 3;
      const r = clamp(rgba[px] + cur[e]);
      const g = clamp(rgba[px + 1] + cur[e + 1]);
      const b = clamp(rgba[px + 2] + cur[e + 2]);
      const idx = lookup(r, g, b);
      indices[y * w + x] = idx;
      const p = palette[idx];
      const er = r - (p & 255);
      const eg = g - ((p >>> 8) & 255);
      const eb = b - ((p >>> 16) & 255);
      const ahead = ltr ? e + 3 : e - 3;
      const behind = ltr ? e - 3 : e + 3;
      cur[ahead] += er * (7 / 16);
      cur[ahead + 1] += eg * (7 / 16);
      cur[ahead + 2] += eb * (7 / 16);
      nxt[behind] += er * (3 / 16);
      nxt[behind + 1] += eg * (3 / 16);
      nxt[behind + 2] += eb * (3 / 16);
      nxt[e] += er * (5 / 16);
      nxt[e + 1] += eg * (5 / 16);
      nxt[e + 2] += eb * (5 / 16);
      nxt[ahead] += er * (1 / 16);
      nxt[ahead + 1] += eg * (1 / 16);
      nxt[ahead + 2] += eb * (1 / 16);
    }
    [cur, nxt] = [nxt, cur];
  }
  return { palette, indices };
}

/** Serialize a Quantized palette to the 1024-byte CLUT the formats embed. */
export function paletteBytes(palette: Uint32Array): Uint8Array {
  const out = new Uint8Array(1024);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 256; i++) dv.setUint32(i * 4, palette[i] ?? 0, true);
  return out;
}
