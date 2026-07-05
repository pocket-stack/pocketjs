#!/usr/bin/env bun
// Convert the imagegen source sheets into DSL asset data for the 神雕 demo.
//
//   bun aot/demo-shendiao/imagegen/build-assets.ts
//
// Reads the six *-source.png sheets in this directory (tileset + 5 character
// sheets) and writes ../assets.generated.ts. While a sheet is missing, the
// corresponding assets fall back to deterministic flat-color placeholders so
// the game stays buildable end-to-end.

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { decodePng, type DecodedImage } from "../../../compiler/pak.ts";

type RGB = [number, number, number];
type Rect = { x: number; y: number; w: number; h: number };

const HERE = dirname(new URL(import.meta.url).pathname);
const OUT = join(dirname(HERE), "assets.generated.ts");

// ---------------------------------------------------------------------------
// Palettes (16 RGB each). Index 0 = backdrop (tiles) / transparent (sprites).
// Cold grey-green wuxia mood; Xiangyang warm accents live in the same bank.
// ---------------------------------------------------------------------------
const WUXIA_PALETTE: RGB[] = [
  [16, 18, 22], // 0 backdrop / abyss black
  [96, 144, 88], // 1 grass green
  [56, 96, 64], // 2 dark green (pine)
  [140, 144, 148], // 3 rock grey
  [88, 92, 100], // 4 dark grey (wall shade)
  [52, 84, 132], // 5 deep water blue
  [236, 240, 240], // 6 white (foam / blossom / snow)
  [172, 176, 176], // 7 pale stone
  [148, 108, 64], // 8 wood brown
  [92, 64, 40], // 9 dark wood
  [196, 60, 48], // 10 banner red
  [232, 148, 48], // 11 flame orange
  [248, 220, 96], // 12 flame yellow
  [120, 116, 108], // 13 felt grey
  [32, 40, 52], // 14 near-black blue (mist/chasm streak)
  [24, 26, 30], // 15 outline
];

const SPRITE_PALETTES: Record<string, RGB[]> = {
  hero: [
    [0, 0, 0], // transparent
    [58, 70, 60], // dark grey-green robe
    [40, 48, 44], // robe shade
    [232, 200, 168], // skin
    [30, 30, 34], // hair / iron sword
    [80, 84, 92], // sword edge highlight
    [244, 244, 236], // eye/white
    [24, 24, 26],
    [140, 120, 96],
    [60, 60, 66],
    [96, 104, 96],
    [180, 180, 172],
    [48, 40, 36],
    [200, 168, 136],
    [70, 80, 72],
    [20, 20, 22],
  ],
  lady: [
    [0, 0, 0],
    [244, 246, 248], // white robe
    [212, 218, 226], // robe shade
    [232, 204, 176], // skin
    [28, 28, 32], // black hair
    [190, 196, 206],
    [252, 252, 252],
    [24, 24, 28],
    [170, 178, 190],
    [140, 148, 160],
    [100, 106, 118],
    [216, 190, 160],
    [80, 84, 94],
    [236, 238, 244],
    [120, 126, 138],
    [20, 20, 24],
  ],
  condor: [
    [0, 0, 0],
    [54, 42, 34], // near-black brown body
    [36, 28, 24], // body shade
    [216, 160, 140], // bald pinkish head
    [240, 214, 120], // beak horn
    [28, 22, 20],
    [90, 72, 58], // feather highlight
    [24, 20, 18],
    [180, 130, 110],
    [130, 100, 80],
    [70, 56, 44],
    [244, 238, 220],
    [46, 36, 30],
    [200, 180, 100],
    [110, 88, 70],
    [18, 16, 14],
  ],
  general: [
    [0, 0, 0],
    [138, 100, 62], // brown robe
    [100, 72, 46], // robe shade
    [226, 190, 158], // skin
    [52, 40, 30], // beard/hair
    [88, 62, 40], // leather
    [240, 236, 226],
    [26, 22, 18],
    [166, 128, 84],
    [120, 90, 58],
    [70, 52, 36],
    [200, 168, 128],
    [44, 34, 26],
    [180, 150, 110],
    [108, 82, 54],
    [20, 16, 12],
  ],
  monk: [
    [0, 0, 0],
    [172, 60, 42], // red robe
    [122, 40, 30], // robe shade
    [222, 178, 140], // skin (bare shoulder, shaved head)
    [212, 168, 62], // golden wheel / earrings
    [240, 208, 100], // gold highlight
    [244, 238, 226],
    [30, 22, 18],
    [196, 120, 60], // ochre layer
    [150, 90, 48],
    [90, 46, 34],
    [252, 232, 150],
    [60, 30, 24],
    [230, 196, 170],
    [140, 70, 50],
    [22, 16, 14],
  ],
};

// ---------------------------------------------------------------------------
// Tile specs: name, solid, placeholder recipe, and (once the sheet exists)
// crop rects into tileset-source.png.
// ---------------------------------------------------------------------------
interface TileSpec {
  name: string;
  solid?: boolean;
  /** placeholder: [fill, accent] palette indices */
  ph: [number, number];
  /** sheet cell (col, row); rows have 6,6,6,7 columns */
  cell: [number, number];
  /** palette index composited under near-white sheet background, if any */
  bgFill?: number;
}

// tileset-source.png layout: 4 rows of cells (6 + 6 + 6 + 7); decor cells sit
// on a near-white background that gets composited over bgFill.
const TILE_SPECS: TileSpec[] = [
  { name: "grass", ph: [1, 2], cell: [0, 0] },
  { name: "path", ph: [8, 9], cell: [2, 0] },
  { name: "gravel", ph: [7, 3], cell: [3, 0] },
  { name: "flower", ph: [1, 6], cell: [4, 0] },
  { name: "bridge", ph: [8, 9], cell: [5, 0] },
  { name: "stairs", ph: [9, 8], cell: [0, 1] },
  { name: "cave_floor", ph: [4, 14], cell: [1, 1] },
  { name: "platform", ph: [9, 8], cell: [2, 1] },
  { name: "gate", ph: [14, 4], cell: [3, 1] },
  { name: "cliff", solid: true, ph: [3, 4], cell: [4, 1] },
  { name: "chasm", solid: true, ph: [0, 14], cell: [5, 1] },
  { name: "water", solid: true, ph: [5, 14], cell: [0, 2] },
  { name: "rapids", solid: true, ph: [5, 6], cell: [1, 2] },
  { name: "pine", solid: true, ph: [2, 15], cell: [2, 2], bgFill: 1 },
  { name: "tomb_wall", solid: true, ph: [4, 15], cell: [3, 2] },
  { name: "stone_door", solid: true, ph: [7, 4], cell: [4, 2] },
  { name: "sword_mound", solid: true, ph: [3, 15], cell: [5, 2], bgFill: 1 },
  { name: "stele", solid: true, ph: [7, 15], cell: [0, 3], bgFill: 1 },
  { name: "city_wall", solid: true, ph: [4, 3], cell: [1, 3], bgFill: 14 },
  { name: "banner_song", solid: true, ph: [10, 9], cell: [2, 3], bgFill: 1 },
  { name: "banner_mongol", solid: true, ph: [14, 9], cell: [3, 3], bgFill: 1 },
  { name: "torch", solid: true, ph: [11, 12], cell: [4, 3], bgFill: 1 },
  { name: "fire", solid: true, ph: [11, 12], cell: [5, 3], bgFill: 1 },
  { name: "tent", solid: true, ph: [13, 9], cell: [6, 3], bgFill: 1 },
];
const TILE_ROW_COLS = [6, 6, 6, 7];

interface CharSpec {
  key: string;
  frames: number;
  grid: [number, number]; // cols, rows
  cells: Record<"down" | "up" | "left" | "right", [number, number][]>; // per frame
}
// Each imagegen character sheet came back with its own grid; cells were
// mapped by visual inspection.
const SPRITES: CharSpec[] = [
  {
    key: "hero",
    frames: 2,
    grid: [2, 4],
    cells: { down: [[0, 0], [1, 0]], up: [[0, 1], [1, 1]], left: [[0, 2], [1, 2]], right: [[0, 3], [1, 3]] },
  },
  {
    key: "lady",
    frames: 1,
    grid: [4, 4],
    cells: { down: [[0, 0]], up: [[2, 0]], left: [[0, 1]], right: [[2, 1]] },
  },
  {
    key: "condor",
    frames: 1,
    grid: [4, 5],
    cells: { down: [[0, 0]], up: [[0, 1]], left: [[0, 2]], right: [[0, 3]] },
  },
  {
    key: "general",
    frames: 1,
    grid: [4, 4],
    cells: { down: [[0, 0]], up: [[0, 1]], left: [[0, 2]], right: [[0, 3]] },
  },
  {
    key: "monk",
    frames: 1,
    grid: [2, 4],
    cells: { down: [[0, 0]], up: [[0, 1]], left: [[0, 2]], right: [[0, 3]] },
  },
];

// ---------------------------------------------------------------------------
// Placeholder painters (used until the imagegen sheets land)
// ---------------------------------------------------------------------------
function placeholderTile(spec: TileSpec): string[] {
  const [fill, accent] = spec.ph;
  const rows: string[] = [];
  for (let y = 0; y < 8; y++) {
    let row = "";
    for (let x = 0; x < 8; x++) {
      const accentHere = (x * 7 + y * 3 + spec.name.length) % 11 === 0 || (spec.solid && (y === 0 || x === 0));
      row += (accentHere ? accent : fill).toString(16);
    }
    rows.push(row);
  }
  return rows;
}

function placeholderFrame(key: string, dir: number, frame: number): string[] {
  // A readable 16x16 biped blob: head + body in the sprite's own palette,
  // with a direction marker pixel so facing changes are visible.
  const body = 1;
  const shade = 2;
  const head = 3;
  const dark = 4;
  const grid: number[][] = Array.from({ length: 16 }, () => new Array(16).fill(0));
  for (let y = 2; y < 7; y++) for (let x = 5; x < 11; x++) grid[y][x] = head;
  for (let y = 7; y < 14; y++) for (let x = 4; x < 12; x++) grid[y][x] = body;
  for (let y = 7; y < 14; y++) grid[y][4 + ((y + frame) % 2)] = shade;
  for (let x = 5; x < 11; x++) grid[14][x] = dark;
  const marks: Record<number, [number, number]> = { 0: [8, 6], 1: [8, 2], 2: [5, 4], 3: [10, 4] };
  const [mx, my] = marks[dir];
  grid[my][mx] = dark;
  if (key === "condor") for (let x = 3; x < 13; x++) grid[8][x] = 1; // wing bar
  return grid.map((r) => r.map((v) => v.toString(16)).join(""));
}

// ---------------------------------------------------------------------------
// Sheet extraction (real art path)
// ---------------------------------------------------------------------------
function px(img: DecodedImage, x: number, y: number): RGB {
  const sx = Math.max(0, Math.min(img.width - 1, x));
  const sy = Math.max(0, Math.min(img.height - 1, y));
  const i = (sy * img.width + sx) * 4;
  return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]];
}
function dist2(a: RGB, b: RGB): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}
function nearest(rgb: RGB, pal: RGB[], start: number): number {
  let best = start;
  let bestD = Infinity;
  for (let i = start; i < pal.length; i++) {
    const d = dist2(rgb, pal[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
function avgRegion(img: DecodedImage, r: Rect, ox: number, oy: number, ow: number, oh: number): RGB {
  const x0 = Math.floor(r.x + (ox / ow) * r.w);
  const y0 = Math.floor(r.y + (oy / oh) * r.h);
  const x1 = Math.max(x0 + 1, Math.floor(r.x + ((ox + 1) / ow) * r.w));
  const y1 = Math.max(y0 + 1, Math.floor(r.y + ((oy + 1) / oh) * r.h));
  let rr = 0;
  let gg = 0;
  let bb = 0;
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const c = px(img, x, y);
      rr += c[0];
      gg += c[1];
      bb += c[2];
      n++;
    }
  return [Math.round(rr / n), Math.round(gg / n), Math.round(bb / n)];
}
function neutralBg(rgb: RGB): boolean {
  const neutral = Math.abs(rgb[0] - rgb[1]) < 14 && Math.abs(rgb[1] - rgb[2]) < 14;
  return neutral && rgb[0] > 185;
}

function tileFromSheet(img: DecodedImage, rect: Rect, bgFill?: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 8; y++) {
    let row = "";
    for (let x = 0; x < 8; x++) {
      const rgb = avgRegion(img, rect, x, y, 8, 8);
      const idx = bgFill !== undefined && neutralBg(rgb) ? bgFill : nearest(rgb, WUXIA_PALETTE, 1);
      row += idx.toString(16);
    }
    rows.push(row);
  }
  return rows;
}

function borderAvg(img: DecodedImage, rect: Rect): RGB {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const add = (x: number, y: number): void => {
    const c = px(img, x, y);
    r += c[0];
    g += c[1];
    b += c[2];
    n++;
  };
  for (let x = rect.x; x < rect.x + rect.w; x += 2) {
    add(x, rect.y);
    add(x, rect.y + rect.h - 1);
  }
  for (let y = rect.y; y < rect.y + rect.h; y += 2) {
    add(rect.x, y);
    add(rect.x + rect.w - 1, y);
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function spriteFromSheet(img: DecodedImage, rect: Rect, pal: RGB[]): string[] {
  const bg = borderAvg(img, rect);
  const isBg = (rgb: RGB): boolean => dist2(rgb, bg) < 34 * 34 || neutralBg(rgb);
  let minX = rect.x + rect.w;
  let minY = rect.y + rect.h;
  let maxX = rect.x;
  let maxY = rect.y;
  for (let y = rect.y; y < rect.y + rect.h; y++)
    for (let x = rect.x; x < rect.x + rect.w; x++)
      if (!isBg(px(img, x, y))) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
  const side = Math.ceil(Math.max(maxX - minX + 1, maxY - minY + 1) * 1.06);
  const cx = (minX + maxX + 1) / 2;
  const cy = (minY + maxY + 1) / 2;
  const crop: Rect = { x: Math.round(cx - side / 2), y: Math.round(cy - side / 2), w: side, h: side };
  const rows: string[] = [];
  for (let oy = 0; oy < 16; oy++) {
    let row = "";
    for (let ox = 0; ox < 16; ox++) {
      const sx = Math.floor(crop.x + ((ox + 0.5) / 16) * crop.w);
      const sy = Math.floor(crop.y + ((oy + 0.5) / 16) * crop.h);
      const rgb = px(img, sx, sy);
      row += (isBg(rgb) ? 0 : nearest(rgb, pal, 1)).toString(16);
    }
    rows.push(row);
  }
  return rows;
}

/** Uniform grid crops over a sheet (cols x rows cells with even gutters). */
function gridRect(img: DecodedImage, cols: number, rows: number, cx: number, cy: number, inset = 0.08): Rect {
  const cw = img.width / cols;
  const ch = img.height / rows;
  const ix = cw * inset;
  const iy = ch * inset;
  return { x: Math.round(cx * cw + ix), y: Math.round(cy * ch + iy), w: Math.round(cw - 2 * ix), h: Math.round(ch - 2 * iy) };
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const DIRS = ["down", "up", "left", "right"] as const;

  // tiles
  let tiles: Record<string, { px: string[]; solid?: boolean }> = {};
  const tilesheetPath = join(HERE, "tileset-source.png");
  if (existsSync(tilesheetPath)) {
    const img = decodePng(await Bun.file(tilesheetPath).bytes());
    // The sheet's outer margins differ from its inner gutters, so a uniform
    // grid bleeds gutter white into cell edges. Detect content bands instead:
    // contiguous runs of rows/cols whose non-white pixel density is high.
    const bands = (len: number, density: (i: number) => number, minLen: number): [number, number][] => {
      const out: [number, number][] = [];
      let start = -1;
      for (let i = 0; i <= len; i++) {
        const on = i < len && density(i) > 0.08;
        if (on && start < 0) start = i;
        if (!on && start >= 0) {
          if (i - start >= minLen) out.push([start, i]);
          start = -1;
        }
      }
      return out;
    };
    const rowDensity = (y: number): number => {
      let n = 0;
      for (let x = 0; x < img.width; x += 4) if (!neutralBg(px(img, x, y))) n++;
      return n / (img.width / 4);
    };
    const rowBands = bands(img.height, rowDensity, 60);
    const cellRects: Rect[][] = rowBands.map(([y0, y1]) => {
      const colDensity = (x: number): number => {
        let n = 0;
        for (let y = y0; y < y1; y += 4) if (!neutralBg(px(img, x, y))) n++;
        return n / ((y1 - y0) / 4);
      };
      return bands(img.width, colDensity, 60).map(([x0, x1]) => {
        const inw = Math.round((x1 - x0) * 0.04);
        const inh = Math.round((y1 - y0) * 0.04);
        return { x: x0 + inw, y: y0 + inh, w: x1 - x0 - 2 * inw, h: y1 - y0 - 2 * inh };
      });
    });
    for (const spec of TILE_SPECS) {
      const [cx, cy] = spec.cell;
      let rect = cellRects[cy]?.[cx];
      if (!rect) {
        // fallback: uniform grid
        const cols = TILE_ROW_COLS[cy];
        const cw = img.width / cols;
        const ch = img.height / TILE_ROW_COLS.length;
        rect = { x: Math.round(cx * cw + cw * 0.12), y: Math.round(cy * ch + ch * 0.12), w: Math.round(cw * 0.76), h: Math.round(ch * 0.76) };
      }
      tiles[spec.name] = { px: tileFromSheet(img, rect, spec.bgFill), ...(spec.solid ? { solid: true } : {}) };
    }
  } else {
    for (const spec of TILE_SPECS) {
      tiles[spec.name] = { px: placeholderTile(spec), ...(spec.solid ? { solid: true } : {}) };
    }
  }

  // sprites
  const sprites: Record<string, { palette: RGB[]; frames: number; facings: Record<string, string[][]> }> = {};
  for (const spec of SPRITES) {
    const { key, frames } = spec;
    const pal = SPRITE_PALETTES[key];
    const sheet = join(HERE, `${key}-source.png`);
    const facings: Record<string, string[][]> = {};
    if (existsSync(sheet)) {
      const img = decodePng(await Bun.file(sheet).bytes());
      const [gc, gr] = spec.grid;
      for (const d of DIRS) {
        facings[d] = spec.cells[d].slice(0, frames).map(([cx, cy]) => spriteFromSheet(img, gridRect(img, gc, gr, cx, cy, 0.06), pal));
      }
    } else {
      DIRS.forEach((d, di) => {
        facings[d] = Array.from({ length: frames }, (_, f) => placeholderFrame(key, di, f));
      });
    }
    sprites[key] = { palette: pal, frames, facings };
  }

  const body =
    `// GENERATED by ${basename(new URL(import.meta.url).pathname)} — do not edit by hand.\n` +
    `// Sources: aot/demo-shendiao/imagegen/*-source.png (placeholders where missing).\n\n` +
    `export const WUXIA_PALETTE: [number, number, number][] = ${JSON.stringify(WUXIA_PALETTE)};\n\n` +
    `export const WUXIA_TILES = ${JSON.stringify(tiles, null, 1)};\n\n` +
    `export const SPRITES = ${JSON.stringify(sprites, null, 1)};\n`;
  await Bun.write(OUT, body);
  console.log(`generated ${OUT}`);
}

await main();
