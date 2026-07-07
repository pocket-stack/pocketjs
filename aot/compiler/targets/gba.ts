// aot/compiler/targets/gba.ts — the GBA backend: encode neutral assets to
// 4bpp/BGR555, serialize PJGB chunks, pack the container, link the ROM.

import {
  BG_TILE_BUDGET,
  BUDGET,
  ByteWriter,
  CHUNK,
  GAME_TITLE_LEN,
  GLYPH_STORE_HEADER_SIZE,
  HALF_GLYPH_COUNT,
  OBJ_TILE_BUDGET,
  TEXT_MODE,
  TILE_4BPP_BYTES,
  TOK_ASCII_MIN,
  rgb555,
} from "../../spec/pjgb.ts";
import { FIRST_CHAR, LAST_CHAR, glyphPixels } from "../font.ts";
import { halfcellPixels, unifontGlyph } from "../cjk.ts";
import { tokenize } from "../text.ts";
import { packCart, type Chunk } from "../pack.ts";
import { buildRom, type BuildRomResult } from "../rom.ts";
import type { CompileOutput } from "../index.ts";
import type { Ctx } from "../context.ts";
import type { GameModel } from "../model.ts";

// GBA 4bpp tile: 32 bytes, 4 bytes/row, low nibble = left pixel.
export function tile4(px: number[]): Uint8Array {
  const out = new Uint8Array(TILE_4BPP_BYTES);
  for (let row = 0; row < 8; row++) {
    for (let c = 0; c < 4; c++) {
      const lo = px[row * 8 + c * 2] & 0xf;
      const hi = px[row * 8 + c * 2 + 1] & 0xf;
      out[row * 4 + c] = lo | (hi << 4);
    }
  }
  return out;
}

// Textbox palette (BG bank 15): 1..5 are subpixel coverage ink shades,
// 6 is the opaque textbox background.
const TEXT_INK_START = 1;
const TEXT_INK_LEVELS = 5;
const TEXT_BG = 6;
const CJK_INK = TEXT_INK_START + TEXT_INK_LEVELS - 1; // brightest shade

interface GbaEncoded {
  bgPalette: Uint16Array;
  objPalette: Uint16Array;
  bgTiles: Uint8Array[];
  objTiles: Uint8Array[];
  glyphStore: Uint8Array | null;
  fontBase: number;
  boxTile: number;
  glyphSlotBase: number;
  glyphSlotCount: number;
  bgTileIndexCount: number; // including reserved (dataless) slot tiles
}

function encode(out: CompileOutput): GbaEncoded {
  const { ctx, mode } = out;
  const bgPalette = new Uint16Array(256);
  const objPalette = new Uint16Array(256);

  ctx.bgPaletteRgb.forEach((rgb, i) => {
    if (i < 16) bgPalette[i] = rgb555(rgb[0], rgb[1], rgb[2]);
  });
  bgPalette[240 + 0] = rgb555(0, 0, 0);
  bgPalette[240 + 1] = rgb555(76, 88, 132);
  bgPalette[240 + 2] = rgb555(116, 128, 168);
  bgPalette[240 + 3] = rgb555(160, 170, 204);
  bgPalette[240 + 4] = rgb555(206, 214, 238);
  bgPalette[240 + 5] = rgb555(248, 248, 248);
  bgPalette[240 + TEXT_BG] = rgb555(24, 32, 72);

  const bgTiles: Uint8Array[] = ctx.bgTilePx.map(tile4);

  let fontBase = 0;
  if (mode === "ascii8") {
    fontBase = bgTiles.length;
    for (let ch = FIRST_CHAR; ch <= LAST_CHAR; ch++) {
      bgTiles.push(tile4(glyphPixels(ch, TEXT_INK_START, TEXT_BG, TEXT_INK_LEVELS)));
    }
  }
  const boxTile = bgTiles.length;
  bgTiles.push(tile4(new Array(64).fill(TEXT_BG)));

  // cjk16: reserve a dataless slot region right after the box tile; the
  // runtime streams glyph tiles into these VRAM indices on demand.
  let glyphSlotBase = 0;
  let glyphSlotCount = 0;
  if (mode === "cjk16") {
    glyphSlotBase = bgTiles.length;
    glyphSlotCount = ctx.target.glyphSlots * 2;
  }
  const bgTileIndexCount = bgTiles.length + glyphSlotCount;

  // Glyph store: 95 halfwidth ASCII + the game's fullwidth set, 4bpp.
  let glyphStore: Uint8Array | null = null;
  if (mode === "cjk16") {
    const w = new ByteWriter();
    const full = ctx.fullGlyphs.list();
    w.u16(HALF_GLYPH_COUNT).u16(full.length).u16(TILE_4BPP_BYTES).u16(0);
    for (let c = TOK_ASCII_MIN; c <= 0x7e; c++) {
      const g = unifontGlyph(c);
      const [top, bottom] = halfcellPixels(g, 0, CJK_INK, TEXT_BG);
      w.bytes(tile4(top)).bytes(tile4(bottom));
    }
    for (const ch of full) {
      const g = unifontGlyph(ch.codePointAt(0)!);
      for (const half of [0, 1] as const) {
        const [top, bottom] = halfcellPixels(g, half, CJK_INK, TEXT_BG);
        w.bytes(tile4(top)).bytes(tile4(bottom));
      }
    }
    glyphStore = w.toUint8Array();
  }

  // OBJ: 16x16 frames -> 4 tiles (TL, TR, BL, BR; 1D mapping), one palette
  // bank per sprite.
  const objTiles: Uint8Array[] = [];
  ctx.spriteProtos.forEach((sp, si) => {
    sp.palette.forEach((rgb, i) => {
      if (i < 16) objPalette[si * 16 + i] = rgb555(rgb[0], rgb[1], rgb[2]);
    });
    for (const grid of ctx.spriteFrames16[si]) {
      for (const [ox, oy] of [
        [0, 0],
        [8, 0],
        [0, 8],
        [8, 8],
      ]) {
        const t: number[] = [];
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) t.push(grid[(oy + y) * 16 + (ox + x)]);
        objTiles.push(tile4(t));
      }
    }
  });

  return { bgPalette, objPalette, bgTiles, objTiles, glyphStore, fontBase, boxTile, glyphSlotBase, glyphSlotCount, bgTileIndexCount };
}

// --- validation --------------------------------------------------------------
function validate(out: CompileOutput, enc: GbaEncoded): void {
  const { ctx, model } = out;
  const err: string[] = [];
  const t = ctx.target;
  if (model.maps.length > BUDGET.MAX_MAPS) err.push(`too many maps (${model.maps.length} > ${BUDGET.MAX_MAPS})`);
  if (ctx.spriteProtos.length > BUDGET.MAX_SPRITES) err.push(`too many sprites`);
  if (ctx.flags.size > BUDGET.MAX_FLAGS) err.push(`too many flags (${ctx.flags.size} > ${BUDGET.MAX_FLAGS})`);
  if (ctx.vars.size > BUDGET.MAX_VARS) err.push(`too many vars (${ctx.vars.size} > ${BUDGET.MAX_VARS})`);
  if (ctx.texts.size > BUDGET.MAX_TEXTS) err.push(`too many texts`);
  if (ctx.scripts.length > BUDGET.MAX_SCRIPTS) err.push(`too many scripts`);
  if (ctx.fullGlyphs.size > BUDGET.MAX_FULL_GLYPHS) err.push(`too many unique CJK glyphs (${ctx.fullGlyphs.size})`);
  if (enc.bgTileIndexCount > BG_TILE_BUDGET[t.name]) err.push(`BG tiles ${enc.bgTileIndexCount} > ${BG_TILE_BUDGET[t.name]}`);
  if (enc.objTiles.length > OBJ_TILE_BUDGET[t.name]) err.push(`OBJ tiles ${enc.objTiles.length} > ${OBJ_TILE_BUDGET[t.name]}`);
  for (const m of model.maps) {
    if (m.w > t.maxMapW || m.h > t.maxMapH) err.push(`map "${m.name}" ${m.w}x${m.h} exceeds ${t.maxMapW}x${t.maxMapH}`);
    if (m.actors.length > BUDGET.MAX_ACTORS_PER_MAP) err.push(`map "${m.name}" has ${m.actors.length} actors`);
    for (const a of m.actors) {
      if (a.onTalk !== 0xffff && a.onTalk >= ctx.scripts.length) err.push(`actor "${a.name}" -> bad script ${a.onTalk}`);
    }
    for (const wp of m.warps) {
      if (wp.destMapIdx === undefined) err.push(`unresolved warp on "${m.name}"`);
    }
  }
  if (err.length) throw new Error("IR validation failed:\n  - " + err.join("\n  - "));
}

// --- serializers --------------------------------------------------------------
function u16buf(a: Uint16Array): Uint8Array {
  const w = new ByteWriter();
  for (const v of a) w.u16(v);
  return w.toUint8Array();
}
function catTiles(ts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(ts.length * TILE_4BPP_BYTES);
  ts.forEach((t, i) => out.set(t, i * TILE_4BPP_BYTES));
  return out;
}

function gameHeader(out: CompileOutput, enc: GbaEncoded): Uint8Array {
  const { ctx, model, game } = out;
  const w = new ByteWriter();
  w.ascii(game.title.replace(/[^\x20-\x7e]/g, "?"), GAME_TITLE_LEN);
  w.u8(model.start.map).u8(model.start.dir).u16(model.start.x).u16(model.start.y);
  w.u8(model.maps.length).u8(ctx.spriteProtos.length);
  w.u16(ctx.flags.size).u16(ctx.texts.size).u16(ctx.scripts.length);
  w.u16(enc.fontBase).u16(enc.boxTile);
  w.u8(out.mode === "cjk16" ? TEXT_MODE.CJK16 : TEXT_MODE.ASCII8).u8(0);
  w.u16(enc.glyphSlotBase).u16(enc.glyphSlotCount);
  return w.toUint8Array();
}

function spriteTable(ctx: Ctx): Uint8Array {
  const w = new ByteWriter();
  for (const s of ctx.spriteProtos) {
    w.u16(s.tileBase * 4).u8(s.w).u8(s.h).u8(s.palbank).u8(s.frames).u16(0);
  }
  return w.toUint8Array();
}

function mapChunk(m: GameModel["maps"][number]): Uint8Array {
  const HDR = 28;
  const tilesOff = HDR;
  const collOff = tilesOff + m.tiles.length * 2;
  const actorsOff = (collOff + m.collision.length + 3) & ~3;
  const warpsOff = actorsOff + m.actors.length * 12;
  const w = new ByteWriter();
  w.u16(m.w).u16(m.h).u16(m.actors.length).u16(m.warps.length);
  w.u8(m.palbank).u8(m.onEnter).u16(0);
  w.u32(tilesOff).u32(collOff).u32(actorsOff).u32(warpsOff);
  for (const t of m.tiles) w.u16(t);
  for (const c of m.collision) w.u8(c);
  w.align4();
  for (const a of m.actors) {
    w.u16(a.x).u16(a.y).u8(a.spriteId).u8(a.facing).u8(a.movement).u8(a.flags).u16(a.onTalk).u16(0);
  }
  for (const wp of m.warps) {
    w.u16(wp.x).u16(wp.y).u8(wp.destMapIdx!).u8(wp.destDir!).u16(wp.destX!).u16(wp.destY!).u16(0);
  }
  return w.toUint8Array();
}

function textBank(out: CompileOutput): Uint8Array {
  const strs = out.ctx.texts.list();
  const enc = strs.map((s) => {
    if (out.mode === "cjk16") return Uint8Array.from(tokenize(s, out.ctx.fullGlyphId));
    const b = new Uint8Array(s.length + 1);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0x7f;
    return b;
  });
  const headerSize = 4 + strs.length * 4;
  let cur = headerSize;
  const offsets = enc.map((b) => {
    const o = cur;
    cur += b.length;
    return o;
  });
  const w = new ByteWriter();
  w.u16(strs.length).u16(0);
  for (const o of offsets) w.u32(o);
  for (const b of enc) w.bytes(b);
  return w.toUint8Array();
}

function scriptChunks(ctx: Ctx): { code: Uint8Array; table: Uint8Array } {
  const code = new ByteWriter();
  const table = new ByteWriter();
  for (const s of ctx.scripts) {
    table.u32(code.length);
    code.bytes(s.bytecode);
  }
  return { code: code.toUint8Array(), table: table.toUint8Array() };
}

// --- entry --------------------------------------------------------------------
export function lowerGba(out: CompileOutput): { chunks: Chunk[]; blob: Uint8Array } {
  // Tokenize texts FIRST so the fullwidth glyph set is complete before the
  // glyph store is built.
  const texts = textBank(out);
  const encFinal = encode(out);
  validate(out, encFinal);

  // Stash renderer ids for debugInfo consumers.
  out.ctx.fontBase = encFinal.fontBase;
  out.ctx.boxTile = encFinal.boxTile;
  out.ctx.glyphSlotBase = encFinal.glyphSlotBase;

  const { code, table } = scriptChunks(out.ctx);
  const chunks: Chunk[] = [
    { kind: CHUNK.GAME, id: 0, data: gameHeader(out, encFinal) },
    { kind: CHUNK.PAL_BG, id: 0, data: u16buf(encFinal.bgPalette) },
    { kind: CHUNK.PAL_OBJ, id: 0, data: u16buf(encFinal.objPalette) },
    { kind: CHUNK.TILES_BG, id: 0, data: catTiles(encFinal.bgTiles) },
    { kind: CHUNK.TILES_OBJ, id: 0, data: catTiles(encFinal.objTiles) },
    { kind: CHUNK.SPRITE_TABLE, id: 0, data: spriteTable(out.ctx) },
    { kind: CHUNK.TEXT_BANK, id: 0, data: texts },
    { kind: CHUNK.SCRIPT_CODE, id: 0, data: code },
    { kind: CHUNK.SCRIPT_TABLE, id: 0, data: table },
  ];
  if (encFinal.glyphStore) chunks.push({ kind: CHUNK.GLYPHS, id: 0, data: encFinal.glyphStore });
  for (const m of out.model.maps) chunks.push({ kind: CHUNK.MAP, id: m.index, data: mapChunk(m) });
  return { chunks, blob: packCart(chunks) };
}

export async function buildGba(out: CompileOutput, outPath: string): Promise<BuildRomResult & { blob: Uint8Array }> {
  const { blob } = lowerGba(out);
  const r = await buildRom(blob, outPath, out.game.title);
  return { ...r, blob };
}
