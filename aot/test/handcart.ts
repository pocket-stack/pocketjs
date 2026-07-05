// aot/test/handcart.ts — hand-built minimal PJGB cartridge -> aot/runtime/gen_cart.c
//
// Not the real compiler; a fixture that (a) validates the binary spec end-to-end
// and (b) gives the C runtime a bootable scene to verify against headlessly:
// an 8x8 grassy map bordered by trees, one solid NPC, and a script that faces
// the player, shows two text pages, and sets flag #1.
//
//   bun aot/test/handcart.ts

import {
  ByteWriter,
  CHUNK,
  DIR,
  ACTOR_FLAG,
  OP,
  SCRIPT_NONE,
  rgb555,
} from "../spec/pjgb.ts";
import { emitCartC, packCart, type Chunk } from "../compiler/pack.ts";

// --- tile / palette helpers -------------------------------------------------
// GBA 4bpp tile: 32 bytes, row-major, 4 bytes/row, low nibble = left pixel.
function tile4(px: number[]): Uint8Array {
  const out = new Uint8Array(32);
  for (let row = 0; row < 8; row++) {
    for (let c = 0; c < 4; c++) {
      const lo = px[row * 8 + c * 2] & 0xf;
      const hi = px[row * 8 + c * 2 + 1] & 0xf;
      out[row * 4 + c] = lo | (hi << 4);
    }
  }
  return out;
}
const fill = (idx: number): number[] => new Array(64).fill(idx);

// --- BG palette (256 entries = 16 banks of 16) ------------------------------
const bgPal = new Uint16Array(256);
bgPal[0] = rgb555(24, 24, 32); // backdrop
bgPal[1] = rgb555(104, 192, 96); // grass light
bgPal[2] = rgb555(72, 152, 72); // grass dark
bgPal[3] = rgb555(96, 64, 40); // trunk
bgPal[4] = rgb555(48, 120, 56); // leaves
// textbox bank 15
bgPal[240] = rgb555(0, 0, 0);
bgPal[241] = rgb555(248, 248, 248); // text
bgPal[242] = rgb555(24, 32, 72); // box bg

// --- OBJ palette (bank 0) ---------------------------------------------------
const objPal = new Uint16Array(16);
objPal[0] = 0; // transparent
objPal[1] = rgb555(240, 200, 160); // skin
objPal[2] = rgb555(200, 64, 64); // shirt
objPal[3] = rgb555(40, 32, 40); // dark
objPal[4] = rgb555(248, 248, 248); // white

// --- BG tiles ---------------------------------------------------------------
const bgTiles: Uint8Array[] = [];
bgTiles.push(tile4(fill(0))); // 0 blank
// 1 grass (dither of 1/2)
{
  const px = new Array(64);
  for (let i = 0; i < 64; i++) px[i] = (i + (i >> 3)) % 5 === 0 ? 2 : 1;
  bgTiles.push(tile4(px));
}
// 2 tree (trunk + leaves)
{
  const px = new Array(64).fill(4);
  for (let y = 5; y < 8; y++) for (let x = 3; x < 5; x++) px[y * 8 + x] = 3;
  bgTiles.push(tile4(px));
}
const FONT_BASE = bgTiles.length; // 3
// 96 procedural glyphs (ASCII 0x20..0x7F): box bg (idx2) + a mark (idx1).
for (let ch = 0x20; ch < 0x80; ch++) {
  const px = new Array(64).fill(2);
  if (ch !== 0x20) {
    for (let y = 1; y < 7; y++) {
      px[y * 8 + 1] = 1;
      px[y * 8 + 5] = 1;
    }
    for (let x = 1; x <= 5; x++) {
      px[1 * 8 + x] = 1;
      px[6 * 8 + x] = 1;
    }
  }
  bgTiles.push(tile4(px));
}
const BOX_TILE = bgTiles.length; // fill tile for the textbox
bgTiles.push(tile4(fill(2)));
const bgTileCount = bgTiles.length;

// --- OBJ tiles: one 16x16 sprite, 4 facings * 1 frame = 16 tiles ------------
// 16x16 sprite = 2x2 tiles in 1D order TL,TR,BL,BR.
function sprite16(dir: number): Uint8Array {
  // 16x16 pixel grid -> 4 tiles
  const grid = new Array(16 * 16).fill(0);
  const set = (x: number, y: number, v: number) => {
    if (x >= 0 && x < 16 && y >= 0 && y < 16) grid[y * 16 + x] = v;
  };
  // body (shirt) rows 8..14, head (skin) rows 2..7
  for (let y = 8; y < 15; y++) for (let x = 4; x < 12; x++) set(x, y, 2);
  for (let y = 2; y < 8; y++) for (let x = 5; x < 11; x++) set(x, y, 1);
  // hair
  for (let x = 5; x < 11; x++) set(x, 2, 3);
  // eyes vary a touch by facing so directions are distinguishable
  if (dir !== DIR.UP) {
    const ey = 5;
    if (dir === DIR.LEFT) set(6, ey, 3);
    else if (dir === DIR.RIGHT) set(9, ey, 3);
    else {
      set(6, ey, 3);
      set(9, ey, 3);
    }
  }
  // split into 4 tiles TL,TR,BL,BR
  const out = new Uint8Array(4 * 32);
  const tiles = [
    [0, 0],
    [8, 0],
    [0, 8],
    [8, 8],
  ];
  tiles.forEach(([ox, oy], t) => {
    const px = new Array(64);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px[y * 8 + x] = grid[(oy + y) * 16 + (ox + x)];
    out.set(tile4(px), t * 32);
  });
  return out;
}
const objTiles: Uint8Array[] = [];
for (const d of [DIR.DOWN, DIR.UP, DIR.LEFT, DIR.RIGHT]) objTiles.push(sprite16(d));

// --- SPRITE_TABLE -----------------------------------------------------------
const spriteTable = new ByteWriter();
spriteTable.u16(0).u8(16).u8(16).u8(0).u8(1).u16(0); // tile_base 0, 16x16, palbank0, 1 frame

// --- MAP 0: 8x8 -------------------------------------------------------------
const MW = 8,
  MH = 8;
const mapTiles = new Uint16Array(MW * MH);
const mapColl = new Uint8Array(MW * MH);
for (let y = 0; y < MH; y++) {
  for (let x = 0; x < MW; x++) {
    const border = x === 0 || y === 0 || x === MW - 1 || y === MH - 1;
    mapTiles[y * MW + x] = border ? 2 : 1;
    mapColl[y * MW + x] = border ? 1 : 0;
  }
}
// actors: 1 NPC at (5,4), solid, on_talk=script 0
const actors = new ByteWriter();
actors.u16(5).u16(4).u8(0).u8(DIR.DOWN).u8(0).u8(ACTOR_FLAG.SOLID).u16(0).u16(0);
const N_ACTORS = 1;
const N_WARPS = 0;

function buildMapChunk(): Uint8Array {
  const header = new ByteWriter();
  // 28-byte header; offsets are from chunk start.
  const hdrSize = 28;
  const tilesOff = hdrSize;
  const collOff = tilesOff + mapTiles.length * 2;
  const actorsOff = (collOff + mapColl.length + 3) & ~3;
  const warpsOff = actorsOff + N_ACTORS * 12;
  header
    .u16(MW).u16(MH).u16(N_ACTORS).u16(N_WARPS)
    .u8(0).u8(0xff).u16(0)
    .u32(tilesOff).u32(collOff).u32(actorsOff).u32(warpsOff);
  const w = new ByteWriter();
  w.bytes(header.toUint8Array());
  for (const t of mapTiles) w.u16(t);
  w.bytes(mapColl);
  while (w.length < actorsOff) w.u8(0);
  w.bytes(actors.toUint8Array());
  return w.toUint8Array();
}

// --- TEXT_BANK --------------------------------------------------------------
const texts = ["HELLO FROM POCKETJS AOT!", "THIS RUNS AS A REAL GBA ROM."];
function buildTextBank(strs: string[]): Uint8Array {
  const enc = strs.map((s) => {
    const b = new Uint8Array(s.length + 1);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0x7f;
    return b;
  });
  const headerSize = 4 + strs.length * 4;
  const offsets: number[] = [];
  let cur = headerSize;
  for (const b of enc) {
    offsets.push(cur);
    cur += b.length;
  }
  const w = new ByteWriter();
  w.u16(strs.length).u16(0);
  for (const o of offsets) w.u32(o);
  for (const b of enc) w.bytes(b);
  return w.toUint8Array();
}

// --- SCRIPT 0 ---------------------------------------------------------------
// LOCK_PLAYER; FACE_PLAYER 0; TEXT 0; SET_FLAG 1; TEXT 1; RELEASE_PLAYER; END
const code = new ByteWriter();
code.u8(OP.LOCK_PLAYER);
code.u8(OP.FACE_PLAYER).u8(0);
code.u8(OP.TEXT).u16(0);
code.u8(OP.SET_FLAG).u16(1);
code.u8(OP.TEXT).u16(1);
code.u8(OP.RELEASE_PLAYER);
code.u8(OP.END);
const scriptTable = new ByteWriter();
scriptTable.u32(0); // script 0 at byte 0

// --- GAME header (v2: 48 bytes, ascii8 text mode, no glyph slot region) ------
const game = new ByteWriter();
game
  .ascii("POCKET TEST", 24)
  .u8(0).u8(DIR.DOWN).u16(4).u16(4)
  .u8(1).u8(1).u16(4).u16(texts.length).u16(1)
  .u16(FONT_BASE).u16(BOX_TILE)
  .u8(0).u8(0) // text_mode ascii8, rsv
  .u16(0).u16(0); // glyph_slot_base/count

// --- assemble ---------------------------------------------------------------
function u16buf(a: Uint16Array): Uint8Array {
  const w = new ByteWriter();
  for (const v of a) w.u16(v);
  return w.toUint8Array();
}
function catTiles(ts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(ts.reduce((n, t) => n + t.length, 0));
  let o = 0;
  for (const t of ts) {
    out.set(t, o);
    o += t.length;
  }
  return out;
}

const chunks: Chunk[] = [
  { kind: CHUNK.GAME, id: 0, data: game.toUint8Array() },
  { kind: CHUNK.PAL_BG, id: 0, data: u16buf(bgPal) },
  { kind: CHUNK.PAL_OBJ, id: 0, data: u16buf(objPal) },
  { kind: CHUNK.TILES_BG, id: 0, data: catTiles(bgTiles) },
  { kind: CHUNK.TILES_OBJ, id: 0, data: catTiles(objTiles) },
  { kind: CHUNK.SPRITE_TABLE, id: 0, data: spriteTable.toUint8Array() },
  { kind: CHUNK.MAP, id: 0, data: buildMapChunk() },
  { kind: CHUNK.TEXT_BANK, id: 0, data: buildTextBank(texts) },
  { kind: CHUNK.SCRIPT_CODE, id: 0, data: code.toUint8Array() },
  { kind: CHUNK.SCRIPT_TABLE, id: 0, data: scriptTable.toUint8Array() },
];

const blob = packCart(chunks);
const c = emitCartC(blob);
await Bun.write(new URL("../runtime/gen_cart.c", import.meta.url).pathname, c);
console.log(
  `handcart: ${blob.length} bytes, ${chunks.length} chunks, ${bgTileCount} BG tiles, ` +
    `font_base=${FONT_BASE}, box_tile=${BOX_TILE}, script uses SCRIPT_NONE=${SCRIPT_NONE}`,
);
