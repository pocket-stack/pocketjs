#!/usr/bin/env bun
// Convert the project-bound imagegen source sheet into GBA DSL asset data.

import { basename, dirname, join } from "node:path";
import { decodePng, type DecodedImage } from "../../../compiler/pak.ts";
import type { Direction } from "../../dsl/index.ts";

type RGB = [number, number, number];
type Rect = { x: number; y: number; w: number; h: number };
type TileSpec = { name: string; rect: Rect; solid?: boolean; backgroundIndex?: number };

const HERE = dirname(new URL(import.meta.url).pathname);
const SOURCE = join(HERE, "retro-rpg-sheet-source.png");
const OUT = join(dirname(HERE), "assets.generated.ts");

// BG palette bank 0. Index 0 stays the backdrop color; generated map tiles use
// indices 1..15 so every map cell remains opaque.
const TOWN_PALETTE: RGB[] = [
  [24, 24, 32],
  [100, 188, 76],
  [50, 132, 58],
  [220, 176, 104],
  [112, 72, 40],
  [32, 92, 44],
  [110, 206, 76],
  [34, 126, 204],
  [112, 202, 244],
  [222, 214, 188],
  [214, 62, 56],
  [126, 32, 34],
  [176, 106, 50],
  [72, 46, 30],
  [244, 238, 214],
  [24, 24, 28],
];

// OBJ palette bank 0. Index 0 is transparent for sprites.
const HERO_PALETTE: RGB[] = [
  [0, 0, 0],
  [244, 184, 132],
  [50, 116, 196],
  [24, 54, 104],
  [246, 246, 230],
  [94, 60, 34],
  [18, 22, 30],
  [44, 48, 52],
  [24, 28, 28],
  [218, 158, 52],
  [122, 144, 164],
  [92, 162, 230],
  [170, 104, 58],
  [232, 210, 150],
  [70, 92, 132],
  [254, 254, 246],
];

const TILE_SPECS: TileSpec[] = [
  { name: "grass", rect: { x: 50, y: 48, w: 181, h: 183 } },
  { name: "grass2", rect: { x: 278, y: 48, w: 199, h: 183 } },
  { name: "path", rect: { x: 526, y: 48, w: 178, h: 183 } },
  { name: "tree", rect: { x: 745, y: 27, w: 194, h: 204 }, solid: true, backgroundIndex: 1 },
  { name: "water", rect: { x: 973, y: 48, w: 176, h: 184 }, solid: true },
  { name: "wall", rect: { x: 50, y: 270, w: 181, h: 183 }, solid: true },
  { name: "roof", rect: { x: 278, y: 270, w: 199, h: 183 }, solid: true },
  { name: "door", rect: { x: 526, y: 270, w: 178, h: 183 }, solid: true },
  { name: "sign", rect: { x: 746, y: 270, w: 178, h: 183 }, solid: true },
  { name: "flower", rect: { x: 973, y: 270, w: 176, h: 183 } },
  { name: "fence", rect: { x: 50, y: 489, w: 181, h: 149 }, solid: true },
];

const SPRITE_RECTS: Record<Direction, Rect[]> = {
  down: [
    { x: 244, y: 664, w: 116, h: 152 },
    { x: 433, y: 664, w: 116, h: 152 },
  ],
  up: [
    { x: 244, y: 825, w: 116, h: 142 },
    { x: 433, y: 825, w: 116, h: 142 },
  ],
  left: [
    { x: 244, y: 977, w: 116, h: 137 },
    { x: 433, y: 977, w: 116, h: 137 },
  ],
  right: [
    { x: 244, y: 1113, w: 116, h: 132 },
    { x: 433, y: 1113, w: 116, h: 132 },
  ],
};

function px(img: DecodedImage, x: number, y: number): RGB {
  const sx = Math.max(0, Math.min(img.width - 1, x));
  const sy = Math.max(0, Math.min(img.height - 1, y));
  const i = (sy * img.width + sx) * 4;
  return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]];
}

function colorDistance2(a: RGB, b: RGB): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function nearestPalette(rgb: RGB, pal: RGB[], start = 0): number {
  let best = start;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = start; i < pal.length; i++) {
    const d = colorDistance2(rgb, pal[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function averageRegion(img: DecodedImage, rect: Rect, ox: number, oy: number, ow: number, oh: number): RGB {
  const x0 = Math.floor(rect.x + (ox / ow) * rect.w);
  const y0 = Math.floor(rect.y + (oy / oh) * rect.h);
  const x1 = Math.max(x0 + 1, Math.floor(rect.x + ((ox + 1) / ow) * rect.w));
  const y1 = Math.max(y0 + 1, Math.floor(rect.y + ((oy + 1) / oh) * rect.h));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const c = px(img, x, y);
      r += c[0];
      g += c[1];
      b += c[2];
      n++;
    }
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function generatedSheetBackground(rgb: RGB): boolean {
  const neutral = Math.abs(rgb[0] - rgb[1]) < 12 && Math.abs(rgb[1] - rgb[2]) < 12;
  return neutral && rgb[0] > 190 && rgb[1] > 190 && rgb[2] > 190;
}

function tileRows(img: DecodedImage, spec: TileSpec): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 8; y++) {
    let row = "";
    for (let x = 0; x < 8; x++) {
      const rgb = averageRegion(img, spec.rect, x, y, 8, 8);
      const idx = spec.backgroundIndex !== undefined && generatedSheetBackground(rgb)
        ? spec.backgroundIndex
        : nearestPalette(rgb, TOWN_PALETTE, 1);
      row += idx.toString(16);
    }
    rows.push(row);
  }
  return rows;
}

function borderAverage(img: DecodedImage, rect: Rect): RGB {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const add = (x: number, y: number) => {
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

function isBackground(rgb: RGB, bg: RGB): boolean {
  const neutral = Math.abs(rgb[0] - rgb[1]) < 14 && Math.abs(rgb[1] - rgb[2]) < 14;
  return colorDistance2(rgb, bg) < 34 * 34 || (neutral && rgb[0] > 190 && rgb[1] > 190 && rgb[2] > 190);
}

function spriteRows(img: DecodedImage, rect: Rect): string[] {
  const bg = borderAverage(img, rect);
  let minX = rect.x + rect.w;
  let minY = rect.y + rect.h;
  let maxX = rect.x;
  let maxY = rect.y;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (!isBackground(px(img, x, y), bg)) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const side = Math.ceil(Math.max(bw, bh) * 1.08);
  const cx = (minX + maxX + 1) / 2;
  const cy = (minY + maxY + 1) / 2;
  const crop: Rect = {
    x: Math.round(cx - side / 2),
    y: Math.round(cy - side / 2),
    w: side,
    h: side,
  };

  const rows: string[] = [];
  for (let oy = 0; oy < 16; oy++) {
    let row = "";
    for (let ox = 0; ox < 16; ox++) {
      const sx = Math.floor(crop.x + ((ox + 0.5) / 16) * crop.w);
      const sy = Math.floor(crop.y + ((oy + 0.5) / 16) * crop.h);
      const rgb = px(img, sx, sy);
      row += (isBackground(rgb, bg) ? 0 : nearestPalette(rgb, HERO_PALETTE, 1)).toString(16);
    }
    rows.push(row);
  }
  return rows;
}

function emitArray(name: string, pal: RGB[]): string {
  return `export const ${name}: [number, number, number][] = ${JSON.stringify(pal)};\n`;
}

async function main(): Promise<void> {
  const img = decodePng(await Bun.file(SOURCE).bytes());
  const tiles = Object.fromEntries(
    TILE_SPECS.map((spec) => [
      spec.name,
      {
        px: tileRows(img, spec),
        ...(spec.solid ? { solid: true } : {}),
      },
    ]),
  );
  const facings = Object.fromEntries(
    (Object.entries(SPRITE_RECTS) as [Direction, Rect[]][]).map(([dir, rects]) => [
      dir,
      rects.map((rect) => spriteRows(img, rect)),
    ]),
  ) as Record<Direction, string[][]>;

  const body =
    `// GENERATED by ${basename(new URL(import.meta.url).pathname)} from ${basename(SOURCE)}.\n` +
    "// Do not edit by hand; adjust the source sheet/crop regions and rerun the generator.\n\n" +
    'import type { Direction } from "@pocketjs/aot";\n\n' +
    emitArray("TOWN_PALETTE", TOWN_PALETTE) +
    "\n" +
    `export const TOWN_TILES = ${JSON.stringify(tiles, null, 2)};\n\n` +
    emitArray("HERO_PALETTE", HERO_PALETTE) +
    "\n" +
    `export const HERO_FACINGS: Record<Direction, string[][]> = ${JSON.stringify(facings, null, 2)};\n`;

  await Bun.write(OUT, body);
  console.log(`generated ${OUT} from ${SOURCE}`);
  console.log(`  source: ${img.width}x${img.height}`);
  console.log(`  tiles: ${TILE_SPECS.length}`);
  console.log(`  hero frames: ${Object.values(SPRITE_RECTS).reduce((n, frames) => n + frames.length, 0)}`);
}

await main();
