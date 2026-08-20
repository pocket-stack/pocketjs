// apps/desk98/gen-icons.ts — pixel-art icon source. ASCII grids compile to
// crispEdges SVGs in apps/desk98/icons/ (committed; re-run on art changes):
//
//   bun apps/desk98/gen-icons.ts
//
// One 16×16 grid per subject; desktop icons emit a second 32px file scaled
// 2× so both stay one art. Caption glyphs and tiny hud art carry their own
// grids at native size. The build then rasterizes each SVG at the plan's
// density like any other asset — no hand-baked PNGs.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

const PAL: Record<string, string> = {
  k: "#000000",
  w: "#ffffff",
  g: "#c0c0c0",
  d: "#808080",
  e: "#dfdfdf",
  y: "#fcd116",
  Y: "#fcf080",
  b: "#000080",
  B: "#1084d0",
  r: "#ff0000",
  R: "#800000",
  t: "#008080",
  G: "#008000",
  o: "#ff8000",
  s: "#ffd800", // smiley yellow
};

interface Icon {
  file: string;
  rows: string[];
  /** Also emit `${file}` at 2× under this name (desktop icons). */
  big?: string;
}

function svgFor(rows: string[], scale: number): string {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  for (const r of rows) {
    if (r.length !== w) throw new Error(`gen-icons: ragged grid (row "${r}" vs width ${w})`);
  }
  const byColor = new Map<string, string[]>();
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (ch === "." || ch === " ") {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < row.length && row[x + run] === ch) run++;
      const color = PAL[ch];
      if (!color) throw new Error(`gen-icons: unknown palette char '${ch}'`);
      const d = byColor.get(color) ?? [];
      d.push(`M${x * scale} ${y * scale}h${run * scale}v${scale}h${-run * scale}z`);
      byColor.set(color, d);
      x += run;
    }
  }
  const paths = [...byColor.entries()]
    .map(([color, ds]) => `<path fill="${color}" d="${ds.join("")}"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w * scale} ${h * scale}" shape-rendering="crispEdges">${paths}</svg>\n`;
}

const ICONS: Icon[] = [
  {
    // My Computer: a CRT over a slim base, navy screen with a sky glint.
    file: "computer-16.svg",
    big: "computer.svg",
    rows: [
      "................",
      ".kkkkkkkkkkkkk..",
      ".kggggggggggkk..",
      ".kgkkkkkkkkgkk..",
      ".kgkbbbbbbkgkk..",
      ".kgkbBBbbbkgkk..",
      ".kgkbBbbbbkgkk..",
      ".kgkbbbbbbkgkk..",
      ".kgkkkkkkkkgkk..",
      ".kggggggggggkk..",
      ".kkkkkkkkkkkkk..",
      "......kggk......",
      "....kkggggkk....",
      "..kggggggggggk..",
      "..kggkkkkkkggk..",
      "..kkkkkkkkkkkk..",
    ],
  },
  {
    // My Documents: the two-tone yellow folder with a paper peeking out.
    file: "folder-16.svg",
    big: "documents.svg",
    rows: [
      "................",
      "................",
      ".kkkkk..........",
      "kYYYYYkkkkkkkk..",
      "kYYYYYYYYYYYYk..",
      "kYwwwwwwwwwwYk..",
      "kYwkkkwwkkwwYk..",
      "kkkkkkkkkkkkkkk.",
      "kyyyyyyyyyyyyyk.",
      "kyYYYYYYYYYYYyk.",
      "kyyyyyyyyyyyyyk.",
      "kyyyyyyyyyyyyyk.",
      "kyyyyyyyyyyyyyk.",
      "kkkkkkkkkkkkkkk.",
      "................",
      "................",
    ],
  },
  {
    // Recycle Bin: gray basket, dark lid, recycle chevrons.
    file: "recycle-16.svg",
    big: "recycle.svg",
    rows: [
      "................",
      "......kkkk......",
      "....kkggggkk....",
      "..kkggggggggkk..",
      ".kddddddddddddk.",
      ".kddddddddddddk.",
      "..kggggggggggk..",
      "..kgGGggggGGgk..",
      "..kgGgggggGggk..",
      "..kggGGgGGgggk..",
      "..kgggGGGggggk..",
      "..kggggGgggggk..",
      "..kggggggggggk..",
      "...kggggggggk...",
      "...kkkkkkkkkk...",
      "................",
    ],
  },
  {
    // Notepad: spiral pad, ruled lines.
    file: "notepad-16.svg",
    big: "notepad.svg",
    rows: [
      "................",
      "..kdkdkdkdkdk...",
      ".kwwwwwwwwwwwk..",
      ".kwwwwwwwwwwwk..",
      ".kwkkkkkkkkwwk..",
      ".kwwwwwwwwwwwk..",
      ".kwkkkkkkwwwwk..",
      ".kwwwwwwwwwwwk..",
      ".kwkkkkkkkwwwk..",
      ".kwwwwwwwwwwwk..",
      ".kwkkkkwwwwwwk..",
      ".kwwwwwwwwwwwk..",
      ".kwwwwwwwwwwwk..",
      ".kkkkkkkkkkkkk..",
      "................",
      "................",
    ],
  },
  {
    // Minesweeper: a raised cell with a mine.
    file: "mines-16.svg",
    big: "mines.svg",
    rows: [
      "wwwwwwwwwwwwwwwd",
      "wggggggggggggggd",
      "wgggggggkggggggd",
      "wgggkggkkkggkggd",
      "wggggkkkkkkkgggd",
      "wgggkkkwwkkkkggd",
      "wgggkkwwkkkkkggd",
      "wgkkkkwwkkkkkkgd",
      "wgggkkkkkkkkkggd",
      "wgggkkkkkkkkkggd",
      "wggggkkkkkkkgggd",
      "wgggkggkkkggkggd",
      "wgggggggkggggggd",
      "wggggggggggggggd",
      "wggggggggggggggd",
      "dddddddddddddddd",
    ],
  },
  {
    // Local disk.
    file: "drive-16.svg",
    rows: [
      "................",
      "................",
      "................",
      "................",
      ".kkkkkkkkkkkkkk.",
      ".kggggggggggggk.",
      ".keeeeeeeeeeegk.",
      ".kggggggggggggk.",
      ".kgggggggggkgGk.",
      ".kkkkkkkkkkkkkk.",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
    ],
  },
  {
    // CD-ROM drive: a disc.
    file: "cdrom-16.svg",
    rows: [
      "................",
      "................",
      ".....kkkkkk.....",
      "...kkeeeeeekk...",
      "..keeeeeeeeeek..",
      "..keeewwweeeek..",
      ".keeewgggweeeek.",
      ".keewggkggweeek.",
      ".keewgkwkgweeek.",
      ".keewggkggweeek.",
      ".keeewgggweeeek.",
      "..keeewwweeeek..",
      "..keeeeeeeeeek..",
      "...kkeeeeeekk...",
      ".....kkkkkk.....",
      "................",
    ],
  },
  {
    // Plain document.
    file: "file-16.svg",
    rows: [
      "................",
      "..kkkkkkkkk.....",
      "..kwwwwwwwkk....",
      "..kwwwwwwwkgk...",
      "..kwwwwwwwkkkk..",
      "..kwkkkkkwwwwk..",
      "..kwwwwwwwwwwk..",
      "..kwkkkkkkkwwk..",
      "..kwwwwwwwwwwk..",
      "..kwkkkkkkwwwk..",
      "..kwwwwwwwwwwk..",
      "..kwkkkkkkkkwk..",
      "..kwwwwwwwwwwk..",
      "..kwwwwwwwwwwk..",
      "..kkkkkkkkkkkk..",
      "................",
    ],
  },
  {
    // Shut Down: a power key on a gray keycap.
    file: "shutdown-16.svg",
    big: "shutdown.svg",
    rows: [
      "................",
      ".kkkkkkkkkkkkkk.",
      ".kwwwwwwwwwwwgk.",
      ".kwggggggggggdk.",
      ".kwgggkkkgggggk.",
      ".kwggkgkgkggggk.",
      ".kwgkggkggkgggk.",
      ".kwgkggkggkgggk.",
      ".kwgkggggggkggk.",
      ".kwgkggggggkggk.",
      ".kwggkggggkgggk.",
      ".kwgggkkkkggggk.",
      ".kwggggggggggdk.",
      ".kgddddddddddgk.",
      ".kkkkkkkkkkkkkk.",
      "................",
    ],
  },
  {
    // Settings: a gear.
    file: "settings-16.svg",
    rows: [
      "................",
      "......kk........",
      "..kk.kggk.kk....",
      "..kgkkggkkgk....",
      "...kggggggk.....",
      "..kkggkkggkk....",
      ".kgggkwwkgggk...",
      ".kgggkwwkgggk...",
      "..kkggkkggkk....",
      "...kggggggk.....",
      "..kgkkggkkgk....",
      "..kk.kggk.kk....",
      "......kk........",
      "................",
      "................",
      "................",
    ],
  },
  {
    // Find: a magnifier.
    file: "find-16.svg",
    rows: [
      "................",
      "...kkkk.........",
      "..kwwwwk........",
      ".kwggggwk.......",
      ".kwgggggk.......",
      ".kwgggggk.......",
      ".kwggggwk.......",
      "..kwwwwk........",
      "...kkkkkk.......",
      "......kkdk......",
      ".......kddk.....",
      "........kddk....",
      ".........kddk...",
      "..........kk....",
      "................",
      "................",
    ],
  },
  {
    // Help: a question mark on a page.
    file: "help-16.svg",
    rows: [
      "................",
      "....kkkkkk......",
      "...kbbbbbbk.....",
      "..kbbkkkbbbk....",
      "..kbbk.kbbbk....",
      "...kk..kbbbk....",
      "......kbbbk.....",
      ".....kbbbk......",
      ".....kbbk.......",
      ".....kbbk.......",
      "......kk........",
      ".....kbbk.......",
      ".....kbbk.......",
      "......kk........",
      "................",
      "................",
    ],
  },
  {
    // Run…: a command window.
    file: "run-16.svg",
    rows: [
      "................",
      ".kkkkkkkkkkkkk..",
      ".kbbbbbbbbbbbk..",
      ".kkkkkkkkkkkkk..",
      ".kwwwwwwwwwwwk..",
      ".kwkwwwwwwwwwk..",
      ".kwkkwwwwwwwwk..",
      ".kwkkkwwwwwwwk..",
      ".kwkkwwkkkkwwk..",
      ".kwkwwwwwwwwwk..",
      ".kwwwwwwwwwwwk..",
      ".kkkkkkkkkkkkk..",
      "................",
      "................",
      "................",
      "................",
    ],
  },
  {
    // Recycle 16 shares the desktop art; folder-16 doubles as Documents.
    // Start logo: the PocketJS favicon motif (site/assets/favicon.svg) as a
    // single-color pixel mark — rounded pocket frame, lens, two bars.
    file: "start-logo.svg",
    rows: [
      "................",
      "................",
      "................",
      "..kkkkkkkkkkkk..",
      ".k............k.",
      ".k............k.",
      ".k..kk..kkkkk.k.",
      ".k.kkkk.......k.",
      ".k.kkkk.kkk...k.",
      ".k..kk........k.",
      ".k............k.",
      ".k............k.",
      "..kkkkkkkkkkkk..",
      "................",
      "................",
      "................",
    ],
  },
];

// Native-size art (caption glyphs, hud bits) — no 2× variant. Pak textures
// must be pow2, so every canvas is 8×8 or 16×16 with the art inside.
const NATIVE: Icon[] = [
  {
    file: "cap-min.svg",
    rows: ["........", "........", "........", "........", "........", ".kkkkkk.", ".kkkkkk.", "........"],
  },
  {
    file: "cap-max.svg",
    rows: ["kkkkkkkk", "kkkkkkkk", "k......k", "k......k", "k......k", "k......k", "k......k", "kkkkkkkk"],
  },
  {
    file: "cap-restore.svg",
    rows: [
      "...kkkkk",
      "...kkkkk",
      "...k...k",
      "kkkkk..k",
      "kkkkkkkk",
      "k...k...",
      "k...k...",
      "kkkkk...",
    ],
  },
  {
    file: "cap-close.svg",
    rows: ["........", "kk....kk", ".kk..kk.", "..kkkk..", "...kk...", "..kkkk..", ".kk..kk.", "kk....kk"],
  },
  {
    file: "menu-arrow.svg",
    rows: ["........", "..k.....", "..kk....", "..kkk...", "..kkkk..", "..kkk...", "..kk....", "..k....."],
  },
  { file: "grip.svg", rows: grip16() },
  {
    // Menu checkmark (checked toggle items, e.g. Edit > Word Wrap).
    file: "check-16.svg",
    rows: [
      "................",
      "................",
      "................",
      "..........kk....",
      ".........kkk....",
      "........kkk.....",
      "..kk...kkk......",
      "..kkk.kkk.......",
      "...kkkkk........",
      "....kkk.........",
      ".....k..........",
      "................",
      "................",
      "................",
      "................",
      "................",
    ],
  },
  {
    file: "mine.svg",
    rows: [
      "...k....",
      "..kkk.k.",
      ".kkkkkk.",
      "kkwkkkkk",
      ".kkkkkk.",
      "..kkk.k.",
      "...k....",
      "........",
    ],
  },
  {
    file: "flag.svg",
    rows: [
      "..rr....",
      "rrrr....",
      "..rr....",
      "...k....",
      "...k....",
      "..kk....",
      ".kkkkk..",
      "kkkkkkk.",
    ],
  },
  { file: "smile.svg", rows: face("smile") },
  { file: "smile-ooh.svg", rows: face("ooh") },
  { file: "smile-dead.svg", rows: face("dead") },
  { file: "smile-cool.svg", rows: face("cool") },
];

/** Status-bar size grip: diagonal white/gray ridge pairs in the lower-right
 *  triangle of a 16×16 canvas. */
function grip16(): string[] {
  const N = 16;
  const grid: string[][] = Array.from({ length: N }, () => Array(N).fill("."));
  for (const k of [17, 21, 25, 29]) {
    for (let x = 0; x < N; x++) {
      const yw = k - x;
      if (yw >= 4 && yw < N && x >= 4) grid[yw][x] = "w";
      const yd = k + 1 - x;
      if (yd >= 4 && yd < N && x >= 4) grid[yd][x] = "d";
    }
  }
  return grid.map((r) => r.join(""));
}

/** Smiley faces built procedurally: a yellow disc with a black ring, then
 *  per-state eyes and mouth pixels — hand grids kept coming out ragged. */
function face(kind: "smile" | "ooh" | "dead" | "cool"): string[] {
  const N = 16;
  const grid: string[][] = Array.from({ length: N }, () => Array(N).fill("."));
  const c = (N - 1) / 2;
  const inside = (x: number, y: number) => (x - c) ** 2 + (y - c) ** 2 <= 7.2 ** 2;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) if (inside(x, y)) grid[y][x] = "s";
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (grid[y][x] !== "s") continue;
      const edge =
        !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
      if (edge) grid[y][x] = "k";
    }
  }
  const px = (x: number, y: number) => {
    grid[y][x] = "k";
  };
  if (kind === "dead") {
    for (const ex of [4, 9]) {
      px(ex, 4);
      px(ex + 2, 4);
      px(ex + 1, 5);
      px(ex, 6);
      px(ex + 2, 6);
    }
    // Frown.
    for (let x = 6; x <= 9; x++) px(x, 10);
    px(5, 11);
    px(10, 11);
  } else if (kind === "cool") {
    // Sunglasses: one bar with two lenses.
    for (let x = 2; x <= 13; x++) px(x, 5);
    for (const lx of [3, 9]) {
      for (let x = lx; x <= lx + 3; x++) {
        px(x, 6);
        px(x, 7);
      }
    }
    for (let x = 6; x <= 9; x++) px(x, 12);
    px(5, 11);
    px(10, 11);
  } else {
    // Eyes.
    for (const ex of [5, 10]) {
      px(ex, 5);
      px(ex, 6);
    }
    if (kind === "smile") {
      for (let x = 6; x <= 9; x++) px(x, 12);
      px(5, 11);
      px(10, 11);
      px(4, 10);
      px(11, 10);
    } else {
      // "ooh": a small round mouth.
      for (const [x, y] of [
        [7, 9],
        [8, 9],
        [6, 10],
        [9, 10],
        [6, 11],
        [9, 11],
        [7, 12],
        [8, 12],
      ]) {
        px(x, y);
      }
    }
  }
  return grid.map((r) => r.join(""));
}

const outDir = join(import.meta.dir, "icons");
mkdirSync(outDir, { recursive: true });
let count = 0;
for (const icon of ICONS) {
  await Bun.write(join(outDir, icon.file), svgFor(icon.rows, 1));
  count++;
  if (icon.big) {
    await Bun.write(join(outDir, icon.big), svgFor(icon.rows, 2));
    count++;
  }
}
for (const icon of NATIVE) {
  await Bun.write(join(outDir, icon.file), svgFor(icon.rows, 1));
  count++;
}
console.log(`gen-icons: wrote ${count} SVGs to apps/desk98/icons/`);
