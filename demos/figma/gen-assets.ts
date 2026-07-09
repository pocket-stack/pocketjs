// demos/figma/gen-assets.ts — bake a Figma file into deep-zoom tile pyramids.
//
//   bun demos/figma/gen-assets.ts [--fig=<path to .fig>]
//
// Offline baker (run MANUALLY, like demos/gallery/gen-assets.ts): opens the
// Paper Wireframe Kit .fig via compiler/fig.ts, rasterizes every real page at
// a ladder of halving scales, quantizes to one 256-color palette per page, and
// writes TILESET pak entries (spec/spec.ts 'PKTS') the viewer app streams one
// tile at a time through the loadTileTexture op.
//
// Outputs are COMMITTED (builds must work without the .fig, which lives in
// ~/Downloads and never on CI):
//   demos/figma/tiles/<page>.<level>.bin   TILESET blobs
//   demos/figma/pak.json                   pak key -> file map (scripts/build.ts
//                                          splices these into dist/figma-main.pak)
//   demos/figma/tiles.ts                   hand-readable manifest the viewer
//                                          reads INSTEAD of parsing binary at
//                                          runtime (plain .ts, not *.generated.ts,
//                                          so the pass-1 scanner walks it)
//
// Size discipline: the whole committed payload must stay <= ~6 MB. Three
// things keep it there — (1) per-page max-zoom caps (MAX_SCALE below; the size
// report this script prints is how you tune them), (2) solid tiles cost 8
// directory bytes (paper wireframes are mostly whitespace), and (3) CLUT8 +
// PackBits RLE on the inked tiles (flat fills RLE beautifully — which is also
// why we do NOT dither: dithering shreds RLE runs for invisible quality gain
// on near-grayscale wireframes).
//
// Determinism: page order is document order, keys are sorted, and nothing
// here emits timestamps — a re-run over the same .fig is byte-identical.

import { homedir } from "node:os";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { openFig, renderRegion, type FigColor, type FigDoc, type FigPage as FigSrcPage } from "../../compiler/fig.ts";
import { encodeTilesetEntry, keyTileset, type TilesetTile } from "../../compiler/pak.ts";
import {
  TILESET_DIR_ENTRY_SIZE,
  TILESET_FLAG_LINEAR,
  TILESET_FLAG_RLE,
  TILESET_MAGIC,
  TILESET_VERSION,
  packbitsDecode,
} from "../../spec/spec.ts";

const HERE = new URL(".", import.meta.url).pathname; // demos/figma/
const TILE = 256;
const SCREEN_W = 480; // PSP screen — the overview level must fit inside it
const SCREEN_H = 272;
const BUDGET = 6 * 1024 * 1024; // soft cap on total committed tile bytes

// Pages that aren't content: the kit's scratch canvas and an unnamed page.
const isRealPage = (name: string): boolean => name.trim() !== "" && name !== "Internal Only Canvas";

// Per-page max-zoom caps (level-0 scale). 1.0 = native Figma px, halved per
// level below it. Tuned against the size report this script prints: Examples
// is a 26k x 10k px wall of full app mockups — at 1.0 it alone would blow the
// budget several times over, and 0.5 is still crisp on a 480x272 screen.
// Welcome is a hero banner (huge type + paper-photo textures that RLE poorly)
// so it also reads fine at 0.5. Components keeps 1.0: its small component
// labels are exactly what max zoom is for, and its ink is sparse enough to fit.
const MAX_SCALE: Record<string, number> = {
  "👋 Welcome": 0.5,
  "🌈 Examples": 0.5,
};
const DEFAULT_MAX_SCALE = 1.0;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

let figPath = homedir() + "/Downloads/Paper Wireframe Kit (Community).fig";
for (const a of process.argv.slice(2)) {
  if (a.startsWith("--fig=")) figPath = a.slice("--fig=".length);
}
if (!existsSync(figPath)) {
  console.error(`gen-assets: ${figPath} not found — pass --fig=<path to .fig>`);
  console.error("(The .fig is not committed; the baked outputs under demos/figma/ are.)");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

const toByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
const abgr = (r: number, g: number, b: number): number => ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
const bgAbgr = (c: FigColor): number => abgr(toByte(c.r), toByte(c.g), toByte(c.b));

// ---------------------------------------------------------------------------
// Median-cut palette (per page, 256 entries, index 0 = page background)
// ---------------------------------------------------------------------------
// Sampled from ONE mid-size render of the whole page (~1.5k px long side):
// big enough that every fill/stroke/text color shows up, small enough to be
// instant. Finer levels only add antialiasing blends BETWEEN those colors, so
// nearest-match error stays sub-visible on a near-grayscale kit.

/** rgb24 -> count histogram of a downscaled whole-page render. */
function samplePage(doc: FigDoc, page: FigSrcPage, ox: number, oy: number, w: number, h: number): Map<number, number> {
  const scale = Math.min(1, 1536 / Math.max(w, h));
  const { width, height, rgba } = renderRegion(doc, page.index, ox, oy, w, h, scale);
  const px = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
  const hist = new Map<number, number>();
  for (let i = 0; i < px.length; i++) {
    const rgb = px[i] & 0xffffff;
    hist.set(rgb, (hist.get(rgb) ?? 0) + 1);
  }
  return hist;
}

/** Classic median cut over an rgb24 histogram -> up to maxColors mean colors. */
function medianCut(hist: Map<number, number>, maxColors: number): number[] {
  type Item = [rgb: number, count: number];
  const boxes: Item[][] = [[...hist.entries()]];
  const chan = (rgb: number, c: number): number => (rgb >> (c * 8)) & 0xff;
  while (boxes.length < maxColors) {
    // Split the box with the widest channel range (weighted by having >1 color).
    let bi = -1;
    let bc = 0;
    let br = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      for (let c = 0; c < 3; c++) {
        let lo = 255;
        let hi = 0;
        for (const [rgb] of boxes[i]) {
          const v = chan(rgb, c);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hi - lo > br) {
          br = hi - lo;
          bi = i;
          bc = c;
        }
      }
    }
    if (bi < 0) break; // every box is a single color
    const box = boxes[bi];
    box.sort((a, b) => chan(a[0], bc) - chan(b[0], bc) || a[0] - b[0]);
    const total = box.reduce((n, [, c]) => n + c, 0);
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += box[i][1];
      if (acc * 2 >= total) {
        cut = i + 1;
        break;
      }
      cut = i + 1;
    }
    boxes.splice(bi, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (const [rgb, c] of box) {
      r += (rgb & 0xff) * c;
      g += ((rgb >> 8) & 0xff) * c;
      b += ((rgb >> 16) & 0xff) * c;
      n += c;
    }
    return (Math.round(b / n) << 16) | (Math.round(g / n) << 8) | Math.round(r / n);
  });
}

interface Palette {
  /** 256 x u32 ABGR (unused tail entries duplicate the background). */
  colors: Uint32Array;
  /** Number of REAL entries (nearest-match search range). */
  count: number;
  /** rgb24 -> palette index cache (antialiased pages reuse few thousand colors). */
  cache: Map<number, number>;
}

function buildPalette(hist: Map<number, number>, bg: number): Palette {
  const bgRgb = bg & 0xffffff;
  const means = medianCut(hist, 255).filter((rgb) => rgb !== bgRgb);
  // Sort by luminance (then rgb) purely for stable, human-scannable output.
  const luma = (rgb: number): number =>
    2 * ((rgb >> 16) & 0xff) + 7 * ((rgb >> 8) & 0xff) + (rgb & 0xff);
  means.sort((a, b) => luma(a) - luma(b) || a - b);
  const colors = new Uint32Array(256).fill(bg >>> 0);
  let count = 1; // index 0 reserved for the page background
  for (const rgb of means) {
    if (count >= 256) break;
    colors[count++] = abgr(rgb & 0xff, (rgb >> 8) & 0xff, (rgb >> 16) & 0xff);
  }
  return { colors, count, cache: new Map() };
}

function nearestIndex(pal: Palette, rgb: number): number {
  const hit = pal.cache.get(rgb);
  if (hit !== undefined) return hit;
  const r = rgb & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = (rgb >> 16) & 0xff;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < pal.count; i++) {
    const c = pal.colors[i];
    const dr = (c & 0xff) - r;
    const dg = ((c >> 8) & 0xff) - g;
    const db = ((c >> 16) & 0xff) - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  pal.cache.set(rgb, best);
  return best;
}

// ---------------------------------------------------------------------------
// Tile classification
// ---------------------------------------------------------------------------

const SOLID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

interface LevelBake {
  scale: number;
  cols: number;
  rows: number;
  key: string;
  file: string;
  grid: string[];
  solids: number[];
  bytes: number;
  textured: number;
  solid: number;
}

interface BakedPage {
  name: string;
  ox: number;
  oy: number;
  w: number;
  h: number;
  bg: number;
  levels: LevelBake[];
}

// ---------------------------------------------------------------------------
// Bake
// ---------------------------------------------------------------------------

console.log(`gen-assets: opening ${figPath}`);
const doc = await openFig(figPath);
const pages = doc.pages.filter((p) => isRealPage(p.name) && p.bounds);
console.log(`  pages: ${pages.map((p) => JSON.stringify(p.name)).join(", ")}`);

const tilesDir = HERE + "tiles/";
mkdirSync(tilesDir, { recursive: true });
// Re-runs must not leave stale pyramids behind (a cap change alters level counts).
for (const f of readdirSync(tilesDir)) {
  if (f.endsWith(".bin")) unlinkSync(tilesDir + f);
}

/** Filesystem-safe page slug: "👋 Welcome" -> "welcome". */
const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const baked: BakedPage[] = [];
let totalBytes = 0;

for (let p = 0; p < pages.length; p++) {
  const page = pages[p];
  const b = page.bounds!;
  // Snap content bounds to integer page px so every level's tile grid maps to
  // exact pixel rects (scales are binary fractions; TILE/scale stays integral).
  const ox = Math.floor(b.x);
  const oy = Math.floor(b.y);
  const w = Math.ceil(b.x + b.w) - ox;
  const h = Math.ceil(b.y + b.h) - oy;
  const bg = bgAbgr(page.background);

  const cap = MAX_SCALE[page.name] ?? DEFAULT_MAX_SCALE;
  const scales: number[] = [cap];
  while (w * scales[scales.length - 1] > SCREEN_W || h * scales[scales.length - 1] > SCREEN_H) {
    scales.push(scales[scales.length - 1] / 2);
  }

  console.log(`page ${p} ${JSON.stringify(page.name)}: ${w}x${h} @ (${ox},${oy}), cap ${cap}, ${scales.length} level(s)`);
  const pal = buildPalette(samplePage(doc, page, ox, oy, w, h), bg);
  console.log(`  palette: ${pal.count} colors (index 0 = bg #${(bg >>> 0).toString(16).padStart(8, "0")})`);

  const levels: LevelBake[] = [];
  for (let l = 0; l < scales.length; l++) {
    const scale = scales[l];
    const cols = Math.ceil((w * scale) / TILE);
    const rows = Math.ceil((h * scale) / TILE);
    const tiles: TilesetTile[] = [];
    const grid: string[] = [];
    const solids: number[] = [];
    const solidChar = new Map<number, string>(); // palette index -> grid char
    const texturedIdx: number[] = [];
    let sampleTile: { index: number; indices: Uint8Array } | null = null;

    // Rasterize one TILE-high strip per row (a whole Examples level in one
    // canvas would be ~500 MB; a strip tops out around ~14 MB) and slice it.
    for (let r = 0; r < rows; r++) {
      const strip = renderRegion(doc, page.index, ox, oy + (r * TILE) / scale, (cols * TILE) / scale, TILE / scale, scale);
      const stripPx = new Uint32Array(strip.rgba.buffer, strip.rgba.byteOffset, strip.width * strip.height);
      let rowChars = "";
      for (let c = 0; c < cols; c++) {
        // Uniformity scan straight off the strip (no tile copy for solids).
        const first = stripPx[c * TILE];
        let uniform = true;
        for (let y = 0; y < TILE && uniform; y++) {
          const base = y * strip.width + c * TILE;
          for (let x = 0; x < TILE; x++) {
            if (stripPx[base + x] !== first) {
              uniform = false;
              break;
            }
          }
        }
        if (uniform) {
          const idx = nearestIndex(pal, first & 0xffffff);
          tiles.push({ kind: "solid", paletteIndex: idx });
          if (idx === 0) {
            rowChars += ".";
          } else {
            let ch = solidChar.get(idx);
            if (ch === undefined && solidChar.size < SOLID_CHARS.length) {
              ch = SOLID_CHARS[solidChar.size];
              solidChar.set(idx, ch);
              solids.push(pal.colors[idx]);
            }
            if (ch === undefined) {
              // > 52 distinct solid colors in one level (never happens on the
              // kit): demote to a textured tile so the grid stays truthful.
              tiles[tiles.length - 1] = { kind: "pixels", indices: new Uint8Array(TILE * TILE).fill(idx) };
              texturedIdx.push(tiles.length - 1);
              rowChars += "#";
            } else {
              rowChars += ch;
            }
          }
        } else {
          const indices = new Uint8Array(TILE * TILE);
          for (let y = 0; y < TILE; y++) {
            const base = y * strip.width + c * TILE;
            for (let x = 0; x < TILE; x++) {
              indices[y * TILE + x] = nearestIndex(pal, stripPx[base + x] & 0xffffff);
            }
          }
          tiles.push({ kind: "pixels", indices });
          texturedIdx.push(tiles.length - 1);
          rowChars += "#";
        }
      }
      grid.push(rowChars);
    }

    // Deterministic self-check sample: the middle textured tile of the level.
    if (texturedIdx.length > 0) {
      const index = texturedIdx[Math.floor(texturedIdx.length / 2)];
      const t = tiles[index];
      if (t.kind === "pixels") sampleTile = { index, indices: t.indices.slice() };
    }

    const blob = encodeTilesetEntry({
      tileW: TILE,
      tileH: TILE,
      cols,
      rows,
      flags: TILESET_FLAG_RLE | TILESET_FLAG_LINEAR,
      palette: pal.colors,
      tiles,
    });
    selfCheck(blob, cols, rows, sampleTile);

    const file = `tiles/${slug(page.name)}.${l}.bin`;
    await Bun.write(HERE + file, blob);
    totalBytes += blob.length;
    levels.push({
      scale,
      cols,
      rows,
      key: keyTileset(`fig.${p}.${l}`),
      file,
      grid,
      solids,
      bytes: blob.length,
      textured: texturedIdx.length,
      solid: cols * rows - texturedIdx.length,
    });
    console.log(
      `  level ${l}: scale ${scale}, ${cols}x${rows} = ${cols * rows} tiles ` +
        `(${texturedIdx.length} textured, ${cols * rows - texturedIdx.length} solid), ${(blob.length / 1024).toFixed(1)} KB`,
    );
  }
  baked.push({ name: page.name, ox, oy, w, h, bg, levels });
}

// ---------------------------------------------------------------------------
// Self-check: the blob must round-trip through the spec decoder
// ---------------------------------------------------------------------------

function selfCheck(blob: Uint8Array, cols: number, rows: number, sample: { index: number; indices: Uint8Array } | null): void {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  if (dv.getUint32(0, true) !== TILESET_MAGIC) throw new Error("self-check: bad magic");
  if (dv.getUint16(4, true) !== TILESET_VERSION) throw new Error("self-check: bad version");
  if (dv.getUint16(12, true) !== cols || dv.getUint16(14, true) !== rows) throw new Error("self-check: bad grid");
  if (!sample) return; // all-solid level (possible for tiny overviews)
  const dirOff = dv.getUint32(20, true);
  const dataOff = dv.getUint32(24, true);
  const e = dirOff + sample.index * TILESET_DIR_ENTRY_SIZE;
  const off = dv.getUint32(e, true);
  const len = dv.getUint32(e + 4, true);
  if (len === 0) throw new Error(`self-check: tile ${sample.index} should be a pixel stream`);
  const decoded = packbitsDecode(blob.subarray(dataOff + off, dataOff + off + len), TILE * TILE);
  if (!decoded || decoded.length !== TILE * TILE) throw new Error(`self-check: tile ${sample.index} failed to decode`);
  for (let i = 0; i < decoded.length; i++) {
    if (decoded[i] !== sample.indices[i]) throw new Error(`self-check: tile ${sample.index} mismatch at index ${i}`);
  }
}

// ---------------------------------------------------------------------------
// pak.json — spliced into dist/<app>.pak by scripts/build.ts
// ---------------------------------------------------------------------------

const pakEntries = baked
  .flatMap((pg) => pg.levels.map((l) => ({ key: l.key, file: l.file })))
  .sort((a, b) => (a.key < b.key ? -1 : 1));
await Bun.write(HERE + "pak.json", JSON.stringify(pakEntries, null, 2) + "\n");

// ---------------------------------------------------------------------------
// tiles.ts — the manifest the viewer reads (no binary parsing at runtime)
// ---------------------------------------------------------------------------

const hex = (n: number): string => "0x" + (n >>> 0).toString(16).padStart(8, "0");
let ts = `// AUTO-GENERATED by demos/figma/gen-assets.ts (bun demos/figma/gen-assets.ts).
// Deep-zoom tile manifest for the baked Figma pages. The viewer positions and
// streams tiles from THIS data alone — solid tiles never touch the tileset
// blobs (they draw as plain background/solids[] colored rects), only '#'
// tiles go through the loadTileTexture op. Plain .ts (not *.generated.ts) so
// the build's pass-1 scanner walks it.

export const TILE = ${TILE};

export interface FigLevel {
  /** page-px -> level-px scale; level pixel = (pageCoord - origin) * scale */
  scale: number;
  cols: number;
  rows: number;
  /** pak key of this level's TILESET entry (tile index = row * cols + col) */
  key: string;
  /**
   * Row-major tile map, one string per row, one char per tile:
   *   '.'                 solid tile of the page background color (bg)
   *   '#'                 textured tile — stream it via loadTileTexture
   *   'a'..'z' 'A'..'Z'   solid tile of color solids[i], i = a:0 .. z:25, A:26 .. Z:51
   */
  grid: string[];
  /** ABGR colors for the lettered solid tiles above. */
  solids: number[];
}

export interface FigPage {
  name: string;
  /** content origin in page coords (tile (0,0) of every level maps here) */
  ox: number;
  oy: number;
  /** content size in page px */
  w: number;
  h: number;
  /** page background, ABGR u32 */
  bg: number;
  levels: FigLevel[];
}

export const PAGES: FigPage[] = [
`;
for (const pg of baked) {
  ts += `  {\n`;
  ts += `    name: ${JSON.stringify(pg.name)},\n`;
  ts += `    ox: ${pg.ox}, oy: ${pg.oy}, w: ${pg.w}, h: ${pg.h}, bg: ${hex(pg.bg)},\n`;
  ts += `    levels: [\n`;
  for (const l of pg.levels) {
    ts += `      {\n`;
    ts += `        scale: ${l.scale}, cols: ${l.cols}, rows: ${l.rows}, key: ${JSON.stringify(l.key)},\n`;
    ts += `        solids: [${l.solids.map(hex).join(", ")}],\n`;
    ts += `        grid: [\n`;
    for (const row of l.grid) ts += `          ${JSON.stringify(row)},\n`;
    ts += `        ],\n`;
    ts += `      },\n`;
  }
  ts += `    ],\n`;
  ts += `  },\n`;
}
ts += `];\n`;
await Bun.write(HERE + "tiles.ts", ts);

// ---------------------------------------------------------------------------
// Size report
// ---------------------------------------------------------------------------

console.log("\nsize report:");
console.log("  page                     lvl  scale      grid     tiles  tex   solid     bytes");
for (const pg of baked) {
  for (let l = 0; l < pg.levels.length; l++) {
    const lv = pg.levels[l];
    console.log(
      `  ${(l === 0 ? pg.name : "").padEnd(24)} ${String(l).padStart(3)}  ${String(lv.scale).padEnd(9)}` +
        ` ${`${lv.cols}x${lv.rows}`.padStart(8)} ${String(lv.cols * lv.rows).padStart(8)}` +
        ` ${String(lv.textured).padStart(4)} ${String(lv.solid).padStart(7)} ${String(lv.bytes).padStart(9)}`,
    );
  }
}
const pageTotals = baked.map((pg) => pg.levels.reduce((n, l) => n + l.bytes, 0));
for (let i = 0; i < baked.length; i++) {
  console.log(`  total ${baked[i].name.padEnd(24)} ${(pageTotals[i] / 1024).toFixed(1).padStart(10)} KB`);
}
console.log(`  TOTAL ${(totalBytes / 1024 / 1024).toFixed(2)} MB (budget ${(BUDGET / 1024 / 1024).toFixed(0)} MB)`);
if (totalBytes > BUDGET) {
  console.error("gen-assets: OVER BUDGET — lower a MAX_SCALE cap and re-run");
  process.exit(1);
}
console.log(`gen-assets: wrote ${pakEntries.length} tileset(s), pak.json, tiles.ts`);
