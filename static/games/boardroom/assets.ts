// static/games/boardroom/assets.ts — BOARDROOM art.
//
// Declaration-zone TypeScript: a tiny deterministic pixel-person generator
// (16x16 walkers, 3 facings, 2 frames) plus a hand-tiled office tileset.
// Palette indices are authored, so every target encoder gets clean input.
// If a generated imagegen sheet lands later, it replaces THIS module while
// keeping tile/sprite names stable.

import { defineSprite, defineTileset, type Rgb, type SpriteDecl } from "@pocketjs/static/rpg";

// ---------------------------------------------------------------------------
// Office tileset. Palette (16): institutional SF-office grey-blue + accents.
// ---------------------------------------------------------------------------
const P = {
  bg: [18, 20, 26] as Rgb, // 0 backdrop
  floor: [196, 198, 206] as Rgb, // 1 light office floor
  floorShade: [168, 170, 180] as Rgb, // 2
  wall: [72, 76, 92] as Rgb, // 3
  wallDark: [48, 52, 64] as Rgb, // 4
  wood: [148, 110, 70] as Rgb, // 5 desk wood
  woodDark: [104, 76, 48] as Rgb, // 6
  screen: [120, 200, 255] as Rgb, // 7 laptop glow
  green: [72, 148, 92] as Rgb, // 8 plant
  greenDark: [44, 96, 60] as Rgb, // 9
  door: [232, 220, 200] as Rgb, // 10
  carpet: [92, 112, 152] as Rgb, // 11 boardroom carpet
  carpetDark: [72, 88, 124] as Rgb, // 12
  glass: [156, 212, 232] as Rgb, // 13 window
  accent: [214, 120, 60] as Rgb, // 14 warm accent (chair)
  ink: [28, 30, 38] as Rgb, // 15 outline
};
const PALETTE: Rgb[] = Object.values(P);

// tile helper: 8 strings of 8 chars using the nibble alphabet below
const T = (...rows: string[]) => ({ px: rows });

export const office = defineTileset("office", {
  palette: PALETTE,
  tiles: {
    floor: T("11111111", "11111112", "11111111", "11111111", "11121111", "11111111", "11111111", "21111111"),
    carpet: T("bbbbbbbb", "bbbcbbbb", "bbbbbbbb", "bbbbbcbb", "bbbbbbbb", "bcbbbbbb", "bbbbbbbb", "bbbbbbcb"),
    wall: {
      px: ["33333333", "34444443", "34444443", "33333333", "44444444", "43333334", "43333334", "44444444"],
      solid: true,
    },
    wallTop: { px: ["ffffffff", "33333333", "33333333", "34444443", "34444443", "33333333", "33333333", "ffffffff"], solid: true },
    window: {
      px: ["33333333", "3dddddd3", "3dddddd3", "3dd11dd3", "3dddddd3", "3dddddd3", "33333333", "44444444"],
      solid: true,
    },
    desk: {
      px: ["ffffffff", "f555555f", "f565655f", "f555555f", "f566665f", "f555555f", "ffffffff", "11111111"],
      solid: true,
    },
    laptop: {
      px: ["ffffffff", "f555555f", "f577775f", "f577775f", "f555555f", "f556555f", "ffffffff", "11111111"],
      solid: true,
    },
    table: {
      px: ["ffffffff", "f555555f", "f555555f", "f556555f", "f555555f", "f555655f", "f555555f", "ffffffff"],
      solid: true,
    },
    chair: T("bbbbbbbb", "bfeeeefb", "bfeeeefb", "bfeeeefb", "bffffffb", "bbfbbfbb", "bbbbbbbb", "bbbbbbbb"),
    door: T("aaaaaaaa", "aaaaaaaa", "aaaaaaaa", "aaaaafaa", "aaaaaaaa", "aaaaaaaa", "aaaaaaaa", "aaaaaaaa"),
    plant: {
      px: ["11111111", "11898111", "18999811", "11898911", "11989111", "111f1111", "11fff111", "11111111"],
      solid: true,
    },
    server: {
      px: ["ffffffff", "f444444f", "f477774f", "f444444f", "f477774f", "f444444f", "f477774f", "ffffffff"],
      solid: true,
    },
  },
});

// ---------------------------------------------------------------------------
// Pixel people. Shared skin/shadow slots + per-person hair & clothes.
// Sprite palette: 0 transparent, 1 skin, 2 hair, 3 shirt, 4 shirt shade,
// 5 legs, 6 ink, 7 skin shade.
// NES budget: 4 distinct OBJ palettes — people are grouped into wardrobe
// palettes (see WARDROBE below) so the reducer dedupes cleanly.
// ---------------------------------------------------------------------------
interface Person {
  name: string;
  skin: Rgb;
  hair: Rgb;
  shirt: Rgb;
  shirtShade: Rgb;
  legs: Rgb;
  /** bald-ish hairline (ilya, satya) */
  bald?: boolean;
}

const row16 = (s: string): string => {
  if (s.length !== 16) throw new Error(`row16: ${s.length}`);
  return s;
};

/** 16x16 walker frames from a compact template. Facings: down/up/right. */
function personFrames(p: Person): SpriteDecl["facings"] {
  const hairTop = p.bald ? "0000011111100000" : "0000112222110000";
  const hairTopUp = "0000112222110000"; // back of head always has hair color
  const hairRow = p.bald ? "0001111111111000".replace(/1/g, "1") : "0001222222211000";
  const hairRowUp = "0001222222221000";
  const faceRow = "0001211111121000";
  const eyeRow = "0001161111611000";
  const mouthRow = "0001111771111000".replace(/7/g, "1");
  const chinRow = "0000111111110000";
  const bodyTop = "0000333333330000";
  const bodyMid = "0003333443333000";
  const bodyArms = "0013333443333100";
  const bodyLow = "0003334433433000";
  const hips = "0000555555550000";
  const legsA = "0000550000550000";
  const legsB = "0000055005500000";
  const feetA = "0000660000660000";
  const feetB = "0000066006600000";

  const down = (legs: string, feet: string) => [
    row16("0000000000000000"),
    row16(hairTop),
    row16(hairRow),
    row16(faceRow),
    row16(eyeRow),
    row16(mouthRow),
    row16(chinRow),
    row16(bodyTop),
    row16(bodyMid),
    row16(bodyArms),
    row16(bodyLow),
    row16(hips),
    row16(legs),
    row16(legs),
    row16(feet),
    row16("0000000000000000"),
  ];
  const up = (legs: string, feet: string) => [
    row16("0000000000000000"),
    row16(hairTopUp),
    row16(hairRowUp),
    row16(hairRowUp),
    row16("0001222222221000"),
    row16("0001122222211000"),
    row16(chinRow),
    row16(bodyTop),
    row16(bodyMid),
    row16(bodyArms),
    row16(bodyLow),
    row16(hips),
    row16(legs),
    row16(legs),
    row16(feet),
    row16("0000000000000000"),
  ];
  const right = (legs: string, feet: string) => [
    row16("0000000000000000"),
    row16(p.bald ? "0000011111000000" : "0000112221100000"),
    row16(p.bald ? "0000111111100000" : "0001222221100000"),
    row16("0000112111600000"),
    row16("0000111111100000"),
    row16("0000011111100000"),
    row16("0000011110000000"),
    row16("0000333333000000"),
    row16("0000333334300000"),
    row16("0000133333100000"),
    row16("0000333433000000"),
    row16("0000055550000000"),
    row16(legs),
    row16(legs),
    row16(feet),
    row16("0000000000000000"),
  ];
  return {
    down: [down(legsA, feetA), down(legsB, feetB)],
    up: [up(legsA, feetA), up(legsB, feetB)],
    right: [right("0000055500000000", "0000066000000000"), right("0000550550000000", "0000660066000000")],
  };
}

const person = (p: Person): SpriteDecl =>
  defineSprite(p.name, {
    palette: [
      [0, 0, 0],
      p.skin,
      p.hair,
      p.shirt,
      p.shirtShade,
      p.legs,
      [24, 24, 28],
      [200, 160, 130],
    ],
    facings: personFrames(p),
  });

// Wardrobe palettes (shared per NES OBJ-palette group)
const SKIN: Rgb = [236, 188, 152];
const SKIN2: Rgb = [188, 136, 100];
const GREY = { shirt: [150, 150, 160] as Rgb, shirtShade: [110, 110, 120] as Rgb, legs: [70, 74, 90] as Rgb };
const DARK = { shirt: [64, 68, 84] as Rgb, shirtShade: [44, 46, 58] as Rgb, legs: [38, 40, 50] as Rgb };
const WARM = { shirt: [186, 88, 66] as Rgb, shirtShade: [140, 62, 46] as Rgb, legs: [60, 56, 70] as Rgb };
const BLUE = { shirt: [66, 112, 186] as Rgb, shirtShade: [46, 80, 140] as Rgb, legs: [40, 48, 72] as Rgb };

export const sam = person({ name: "sam", skin: SKIN, hair: [140, 104, 60], ...GREY });
export const employee = person({ name: "employee", skin: SKIN, hair: [80, 60, 40], ...GREY });
export const ilya = person({ name: "ilya", skin: SKIN, hair: [90, 80, 70], bald: true, ...DARK });
export const board = person({ name: "board", skin: SKIN, hair: [50, 44, 40], ...DARK });
export const greg = person({ name: "greg", skin: SKIN, hair: [104, 78, 46], ...WARM });
export const mira = person({ name: "mira", skin: SKIN, hair: [58, 44, 36], ...WARM });
export const satya = person({ name: "satya", skin: SKIN2, hair: [40, 36, 34], bald: true, ...BLUE });
export const emmett = person({ name: "emmett", skin: SKIN, hair: [150, 110, 60], ...BLUE });
