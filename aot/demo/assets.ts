// aot/demo/assets.ts — the demo's tileset + hero sprite.
// Tiles are 8 rows of 8 hex-nibble palette indices; sprite facings are frames
// of 16 rows of 16 hex nibbles. bake.ts turns these into GBA 4bpp tiles.

import { defineSprite, defineTileset, type Direction } from "@pocketjs/aot";

// Town palette (index -> role). Index 0 is the backdrop/transparent slot.
export const TOWN_PALETTE: [number, number, number][] = [
  [24, 24, 32], // 0 backdrop
  [112, 196, 100], // 1 grass light
  [78, 158, 74], // 2 grass dark
  [216, 192, 140], // 3 path/sand
  [96, 64, 40], // 4 trunk
  [40, 104, 52], // 5 leaves dark
  [72, 152, 72], // 6 leaves light
  [64, 120, 220], // 7 water
  [120, 176, 240], // 8 water light
  [206, 206, 214], // 9 wall
  [196, 72, 64], // a roof
  [150, 48, 44], // b roof dark
  [150, 108, 60], // c wood (sign/door)
  [70, 46, 28], // d dark wood
  [244, 244, 248], // e white
  [20, 20, 24], // f outline
];

// 8x8 tiles as hex-nibble rows.
const TILES: Record<string, { px: string[]; solid?: boolean }> = {
  grass: {
    px: ["11112111", "11111111", "11211111", "11111121", "21111111", "11111211", "11111111", "12111112"],
  },
  grass2: {
    px: ["11111111", "12111121", "11111111", "11121111", "11111111", "21111112", "11111111", "11111111"],
  },
  path: {
    px: ["33333333", "33333333", "33333333", "33333333", "33333333", "33333333", "33333333", "33333333"],
  },
  tree: {
    px: ["05566500", "56666650", "56666650", "05665500", "00644600", "00644600", "00444600", "01444210"],
    solid: true,
  },
  water: {
    px: ["77778777", "78777777", "77777877", "87777778", "77787777", "77777777", "87777787", "77778777"],
    solid: true,
  },
  wall: {
    px: ["99999999", "9e9999e9", "99999999", "99999999", "9e9999e9", "99999999", "99999999", "9999999f"],
    solid: true,
  },
  roof: {
    px: ["aaaaaaaa", "abababab", "aaaaaaaa", "babababa", "aaaaaaaa", "abababab", "aaaaaaaa", "ffffffff"],
    solid: true,
  },
  door: {
    px: ["ffffffff", "fccccccf", "fccccccf", "fccccccf", "fcc00ccf", "fcc00ccf", "fcc00ccf", "fcccddcf"],
    solid: true,
  },
  sign: {
    px: ["00000000", "0cccccc0", "0ceeeec0", "0ceeeec0", "0cccccc0", "000dd000", "000dd000", "000dd000"],
    solid: true,
  },
  flower: {
    px: ["11111111", "11e11a11", "1eae1aea", "11e11a11", "111111e1", "11a11eae", "1eae11e1", "11111111"],
  },
  fence: {
    px: ["0c0000c0", "0c0000c0", "cccccccc", "0c0000c0", "0c0000c0", "cccccccc", "0c0000c0", "0c0000c0"],
    solid: true,
  },
};

export const town = defineTileset("town", { palette: TOWN_PALETTE, tiles: TILES });

// ---------------------------------------------------------------------------
// Hero sprite — procedural 16x16, 4 facings, 2 walk frames.
// OBJ palette (bank 0).
export const HERO_PALETTE: [number, number, number][] = [
  [0, 0, 0], // 0 transparent
  [248, 216, 168], // 1 skin
  [40, 96, 200], // 2 shirt
  [30, 30, 40], // 3 hair/outline
  [200, 160, 96], // 4 boots/hat band
  [232, 72, 64], // 5 cap
  [248, 248, 248], // 6 white
];

type Grid = number[]; // 16*16
function heroGrid(dir: Direction, frame: number): Grid {
  const g = new Array(256).fill(0);
  const put = (x: number, y: number, v: number) => {
    if (x >= 0 && x < 16 && y >= 0 && y < 16) g[y * 16 + x] = v;
  };
  const rect = (x0: number, y0: number, x1: number, y1: number, v: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(x, y, v);
  };
  // cap
  rect(4, 1, 11, 3, 5);
  rect(3, 3, 12, 3, 4);
  // face/head
  rect(5, 4, 10, 8, 1);
  rect(4, 4, 4, 8, 3);
  rect(11, 4, 11, 8, 3);
  // eyes depend on facing
  if (dir !== "up") {
    const ey = 6;
    if (dir === "left") put(6, ey, 3);
    else if (dir === "right") put(9, ey, 3);
    else {
      put(6, ey, 3);
      put(9, ey, 3);
    }
  } else {
    rect(5, 4, 10, 5, 3); // back of head hair
  }
  // body (shirt)
  rect(4, 9, 11, 13, 2);
  rect(3, 9, 3, 12, 3);
  rect(12, 9, 12, 12, 3);
  // arms
  put(3, 10, 1);
  put(12, 10, 1);
  // legs / walk frame
  const swing = frame === 0 ? 0 : 1;
  rect(5, 14, 6, 15, 4);
  rect(9, 14, 10, 15, 4);
  if (swing) {
    put(5, 15, 0);
    put(10, 15, 0);
    put(7, 15, 4);
    put(8, 15, 4);
  }
  return g;
}

function gridToRows(g: Grid): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 16; y++) {
    let s = "";
    for (let x = 0; x < 16; x++) s += g[y * 16 + x].toString(16);
    rows.push(s);
  }
  return rows;
}

const dirs: Direction[] = ["down", "up", "left", "right"];
const facings = {} as Record<Direction, string[][]>;
for (const d of dirs) facings[d] = [0, 1].map((f) => gridToRows(heroGrid(d, f)));

export const hero = defineSprite("hero", {
  size: [16, 16],
  palette: HERO_PALETTE,
  facings,
});
