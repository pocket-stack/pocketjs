// static/compiler/link.ts — serialize the model into the target-independent
// blobs (game header, script blob, text blobs, map blobs) and the fixed-
// region tables. Native art blobs are appended per target (targets/*), which
// then package everything for their toolchain.

import { BANK_SIZE, BLOB_KIND, ByteWriter, TEXT_ENTRY_SIZE } from "../spec/isa.ts";
import {
  ACTOR_SIZE,
  GAME_HEADER_SIZE,
  GAME_TITLE_LEN,
  MAP_HEADER_SIZE,
  RPG_BUDGET,
  TRIGGER_SIZE,
  WARP_SIZE,
} from "../spec/rpg.ts";
import type { Ctx } from "./context.ts";
import type { GameModel } from "./model.ts";

export interface Blob {
  kind: number; // BLOB_KIND.*
  /** For MAP blobs: the map id. For TEXT: the text-blob ordinal. */
  id: number;
  bytes: Uint8Array;
}

export interface LinkedGame {
  model: GameModel;
  ctx: Ctx;
  header: Uint8Array;
  /** Blob index space shared with the targets (art appended after these). */
  blobs: Blob[];
  scriptBlobIndex: number;
  /** Per script id: byte offset in the script blob. */
  scriptTable: number[];
  /** Per text id: (blob index, offset). */
  textTable: { blob: number; off: number }[];
  /** Per map id: blob index. */
  mapBlobIndex: number[];
}

export function linkGame(model: GameModel, ctx: Ctx, scriptBlob: Uint8Array, scriptTable: number[]): LinkedGame {
  if (scriptBlob.length > RPG_BUDGET.MAX_SCRIPT_BLOB) {
    throw new Error(`script bytecode is ${scriptBlob.length} B — exceeds one bank (${RPG_BUDGET.MAX_SCRIPT_BLOB})`);
  }

  const blobs: Blob[] = [];
  const scriptBlobIndex = blobs.length;
  blobs.push({ kind: BLOB_KIND.SCRIPTS, id: 0, bytes: scriptBlob });

  // Texts: first-fit into <=16 KB blobs, each stream whole.
  const textTable: { blob: number; off: number }[] = [];
  let tw: ByteWriter | null = null;
  let twIndex = -1;
  let textBlobOrdinal = 0;
  const flushText = (): void => {
    if (tw && tw.length > 0) blobs[twIndex].bytes = tw.toUint8Array();
    tw = null;
  };
  for (const t of ctx.texts) {
    if (t.tokens.length > RPG_BUDGET.MAX_TEXT_BLOB) throw new Error("single text exceeds a bank — split it");
    if (!tw || tw.length + t.tokens.length > RPG_BUDGET.MAX_TEXT_BLOB) {
      flushText();
      tw = new ByteWriter();
      twIndex = blobs.length;
      blobs.push({ kind: BLOB_KIND.TEXT, id: textBlobOrdinal++, bytes: new Uint8Array(0) });
    }
    textTable.push({ blob: twIndex, off: tw.length });
    tw.bytes(t.tokens);
  }
  flushText();

  // Maps.
  const mapBlobIndex: number[] = [];
  model.maps.forEach((m, mi) => {
    const w = new ByteWriter();
    const cells = m.width * m.height;
    const collisionBytes = Math.ceil(cells / 8);
    const tilesOff = MAP_HEADER_SIZE;
    const collisionOff = tilesOff + cells;
    const actorsOff = collisionOff + collisionBytes;
    const warpsOff = actorsOff + m.actors.length * ACTOR_SIZE;
    const triggersOff = warpsOff + m.warps.length * WARP_SIZE;

    w.u8(m.width)
      .u8(m.height)
      .u8(m.actors.length)
      .u8(m.warps.length)
      .u8(m.triggers.length)
      .u8(0)
      .u16(m.onEnter)
      .u16(tilesOff)
      .u16(collisionOff)
      .u16(actorsOff)
      .u16(warpsOff)
      .u16(triggersOff)
      .u16(0);
    if (w.length !== MAP_HEADER_SIZE) throw new Error("map header layout drifted");

    for (const t of m.tiles) w.u8(t);
    const bits = new Uint8Array(collisionBytes);
    m.solid.forEach((s, i) => {
      if (s) bits[i >> 3] |= 1 << (i & 7);
    });
    // Actors are solid obstacles too, but dynamically (they move/hide) — the
    // runtime checks them separately; the bitset is static geometry only.
    w.bytes(bits);
    for (const a of m.actors) {
      w.u8(a.x).u8(a.y).u8(a.spriteId).u8(a.facing).u8(a.move).u8(a.flags).u16(a.talk);
    }
    for (const wp of m.warps) {
      w.u8(wp.x).u8(wp.y).u8(wp.destMap).u8(wp.destX).u8(wp.destY).u8(wp.destDir);
    }
    for (const tr of m.triggers) {
      w.u8(tr.x).u8(tr.y).u16(tr.script).u8(tr.flags).u8(tr.onceFlag);
    }

    const bytes = w.toUint8Array();
    if (bytes.length > BANK_SIZE) throw new Error(`map ${m.name}: ${bytes.length} B exceeds a bank`);
    mapBlobIndex.push(blobs.length);
    blobs.push({ kind: BLOB_KIND.MAP, id: mi, bytes });
  });

  // Game header.
  const h = new ByteWriter();
  h.ascii(model.title, GAME_TITLE_LEN)
    .u8(model.start.map)
    .u8(model.start.x)
    .u8(model.start.y)
    .u8(model.start.dir)
    .u8(model.maps.length)
    .u8(model.sprites.length)
    .u16(ctx.texts.length)
    .u16(scriptTable.length)
    .u8(model.playerSpriteId)
    .u8(0);
  if (h.length !== GAME_HEADER_SIZE) throw new Error("game header layout drifted");

  if (textTable.length !== ctx.texts.length) throw new Error("text table drifted");
  void TEXT_ENTRY_SIZE;

  return {
    model,
    ctx,
    header: h.toUint8Array(),
    blobs,
    scriptBlobIndex,
    scriptTable,
    textTable,
    mapBlobIndex,
  };
}
