// aot/compiler/lower.ts — Stage 6+7: validate the Game IR, then lower it to
// PJGB chunks (design §11.6-11.7). The GameModel + Ctx together are the IR.

import {
  BUDGET,
  ByteWriter,
  CHUNK,
  GAME_TITLE_LEN,
} from "../spec/pjgb.ts";
import type { Ctx } from "./context.ts";
import type { GameModel } from "./model.ts";
import type { GameDecl } from "../dsl/index.ts";
import type { Chunk } from "./pack.ts";

export function validate(ctx: Ctx, model: GameModel): void {
  const err: string[] = [];
  if (model.maps.length > BUDGET.MAX_MAPS) err.push(`too many maps (${model.maps.length} > ${BUDGET.MAX_MAPS})`);
  if (ctx.spriteProtos.length > BUDGET.MAX_SPRITES) err.push(`too many sprites`);
  if (ctx.flags.size > BUDGET.MAX_FLAGS) err.push(`too many flags (${ctx.flags.size} > ${BUDGET.MAX_FLAGS})`);
  if (ctx.texts.size > BUDGET.MAX_TEXTS) err.push(`too many texts`);
  if (ctx.scripts.length > BUDGET.MAX_SCRIPTS) err.push(`too many scripts`);
  if (ctx.bgTiles.length > BUDGET.MAX_BG_TILES) err.push(`BG tiles ${ctx.bgTiles.length} > ${BUDGET.MAX_BG_TILES}`);
  if (ctx.objTiles.length > BUDGET.MAX_OBJ_TILES) err.push(`OBJ tiles ${ctx.objTiles.length} > ${BUDGET.MAX_OBJ_TILES}`);
  for (const m of model.maps) {
    if (m.w > 32 || m.h > 32) err.push(`map "${m.name}" ${m.w}x${m.h} exceeds 32x32 (v1 single-screenblock limit)`);
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

function u16buf(a: Uint16Array): Uint8Array {
  const w = new ByteWriter();
  for (const v of a) w.u16(v);
  return w.toUint8Array();
}
function catTiles(ts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(ts.length * 32);
  ts.forEach((t, i) => out.set(t, i * 32));
  return out;
}

function gameHeader(ctx: Ctx, model: GameModel, game: GameDecl): Uint8Array {
  const w = new ByteWriter();
  w.ascii(game.title, GAME_TITLE_LEN);
  w.u8(model.start.map).u8(model.start.dir).u16(model.start.x).u16(model.start.y);
  w.u8(model.maps.length).u8(ctx.spriteProtos.length);
  w.u16(ctx.flags.size).u16(ctx.texts.size).u16(ctx.scripts.length);
  w.u16(ctx.fontBase).u16(ctx.boxTile).u16(0);
  return w.toUint8Array();
}

function spriteTable(ctx: Ctx): Uint8Array {
  const w = new ByteWriter();
  for (const s of ctx.spriteProtos) {
    w.u16(s.tileBase).u8(s.w).u8(s.h).u8(s.palbank).u8(s.frames).u16(0);
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
  w.u8(m.palbank).u8(0xff).u16(0);
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

function textBank(ctx: Ctx): Uint8Array {
  const strs = ctx.texts.list();
  const enc = strs.map((s) => {
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

export function lower(ctx: Ctx, model: GameModel, game: GameDecl): Chunk[] {
  validate(ctx, model);
  const { code, table } = scriptChunks(ctx);
  const chunks: Chunk[] = [
    { kind: CHUNK.GAME, id: 0, data: gameHeader(ctx, model, game) },
    { kind: CHUNK.PAL_BG, id: 0, data: u16buf(ctx.bgPalette) },
    { kind: CHUNK.PAL_OBJ, id: 0, data: u16buf(ctx.objPalette) },
    { kind: CHUNK.TILES_BG, id: 0, data: catTiles(ctx.bgTiles) },
    { kind: CHUNK.TILES_OBJ, id: 0, data: catTiles(ctx.objTiles) },
    { kind: CHUNK.SPRITE_TABLE, id: 0, data: spriteTable(ctx) },
    { kind: CHUNK.TEXT_BANK, id: 0, data: textBank(ctx) },
    { kind: CHUNK.SCRIPT_CODE, id: 0, data: code },
    { kind: CHUNK.SCRIPT_TABLE, id: 0, data: table },
  ];
  for (const m of model.maps) chunks.push({ kind: CHUNK.MAP, id: m.index, data: mapChunk(m) });
  return chunks;
}
