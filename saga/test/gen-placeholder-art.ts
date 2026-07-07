// saga/test/gen-placeholder-art.ts — procedural PNGs for the smoke film so the
// pipeline is testable without PixelLab.

import { encodePng } from "../compiler/png.ts";

const DIR = new URL("./art/", import.meta.url).pathname;

function img(w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * w + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a;
    }
  return encodePng(rgba, w, h);
}

// main stage: 384x160 "street": ground + building blocks + lamp posts
await Bun.write(
  DIR + "street.png",
  img(384, 160, (x, y) => {
    if (y > 128) return [70, 60, 56, 255]; // ground
    if (y > 124) return [110, 100, 90, 255]; // curb
    const block = Math.floor(x / 48);
    const inBuilding = y > 40 + (block % 3) * 16 && x % 48 < 40;
    if (inBuilding) {
      const win = x % 8 < 4 && y % 12 < 6 && y > 56;
      return win ? [230, 200, 120, 255] : [40 + (block % 4) * 12, 44, 60 + (block % 3) * 10, 255];
    }
    return [0, 0, 0, 0]; // transparent -> sky shows
  }),
);

// far layer: rolling hill silhouettes (transparent above)
await Bun.write(
  DIR + "hills.png",
  img(240, 160, (x, y) => {
    const ridge = 90 + Math.round(18 * Math.sin(x / 25) + 8 * Math.sin(x / 7));
    return y > ridge ? [24, 34, 52, 255] : [0, 0, 0, 0];
  }),
);

// walker sprite: 32x32, 2 frames side by side
await Bun.write(
  DIR + "walker.png",
  img(64, 32, (x, y) => {
    const f = x >= 32 ? 1 : 0;
    const lx = x % 32;
    // head
    if (Math.hypot(lx - 16, y - 8) < 5) return [240, 200, 160, 255];
    // body
    if (y >= 13 && y < 24 && lx >= 12 && lx < 20) return [66, 184, 131, 255];
    // legs alternate by frame
    if (y >= 24 && y < 30) {
      const spread = f ? 3 : 1;
      if (Math.abs(lx - (16 - spread)) < 2 || Math.abs(lx - (16 + spread)) < 2) return [40, 48, 60, 255];
    }
    return [0, 0, 0, 0];
  }),
);

// emblem: 32x32 V mark
await Bun.write(
  DIR + "emblem.png",
  img(32, 32, (x, y) => {
    const d1 = Math.abs(x - 6 - y * 0.4);
    const d2 = Math.abs(x - 26 + y * 0.4);
    if (y < 26 && (d1 < 2.5 || d2 < 2.5)) return [66, 184, 131, 255];
    if (y < 26 && (d1 < 4 || d2 < 4)) return [53, 73, 94, 255];
    return [0, 0, 0, 0];
  }),
);

// world room: 320x240 (20x15 cells), walls on the border + a 2-cell bench
const ROOM_GRID = [
  "####################",
  "#..................#",
  "#.........w........#",
  "#..................#",
  "#..##..............#",
  "#..................#",
  "#..................#",
  "#.........p........#",
  "#..................#",
  "#..................#",
  "#..................#",
  "#..................#",
  "#..................#",
  "#.........d........#",
  "####################",
];
await Bun.write(
  DIR + "room.png",
  img(320, 240, (x, y) => {
    const cx = Math.floor(x / 16);
    const cy = Math.floor(y / 16);
    const ch = ROOM_GRID[cy]?.[cx] ?? "#";
    if (ch === "#") {
      const brick = (cx + cy) % 2 === 0;
      return brick ? [86, 60, 44, 255] : [70, 48, 36, 255];
    }
    if (ch === "d") return [140, 110, 60, 255]; // doormat
    const check = (cx + cy) % 2 === 0;
    const edge = x % 16 === 0 || y % 16 === 0;
    if (edge) return [52, 56, 68, 255];
    return check ? [66, 72, 86, 255] : [60, 66, 80, 255];
  }),
);

// walker sheets: 16x32 x 6 frames (down x2, up x2, side x2)
function walkerSheet(body: [number, number, number]): Uint8Array {
  return img(96, 32, (x, y) => {
    const f = Math.floor(x / 16); // 0..5
    const row = Math.floor(f / 2); // 0 down, 1 up, 2 side
    const ph = f % 2;
    const lx = x % 16;
    // head
    if (Math.hypot(lx - 8, y - 9) < 5) {
      // face features by direction
      if (row === 0 && y >= 8 && y <= 10 && (lx === 6 || lx === 10)) return [20, 20, 30, 255];
      if (row === 2 && y >= 8 && y <= 10 && lx === 11) return [20, 20, 30, 255];
      return [240, 200, 160, 255];
    }
    // body
    if (y >= 14 && y < 25 && lx >= 4 && lx < 12) return [...body, 255] as [number, number, number, number];
    // legs alternate
    if (y >= 25 && y < 31) {
      const spread = ph ? 3 : 1;
      if (Math.abs(lx - (8 - spread)) < 2 || Math.abs(lx - (8 + spread)) < 2) return [40, 48, 60, 255];
    }
    return [0, 0, 0, 0];
  });
}
await Bun.write(DIR + "hero.png", walkerSheet([66, 184, 131]));
await Bun.write(DIR + "buddy.png", walkerSheet([214, 130, 60]));

// breakout court: 240x160 dark hall with side rails
await Bun.write(
  DIR + "court.png",
  img(240, 160, (x, y) => {
    if (x < 20 || x >= 220) return [30, 34, 52, 255];
    if (y < 12) return [30, 34, 52, 255];
    const g = 18 + Math.floor((y / 160) * 14);
    return [g - 8, g - 4, g + 10, 255];
  }),
);

console.log("placeholder art written to saga/test/art/");
