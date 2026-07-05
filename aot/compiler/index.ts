// aot/compiler/index.ts — the @pocketjs/aot compile pipeline (design §11).
//   Source TS/TSX
//     -> evaluate (static JSX zone)   -> Registry + script ASTs
//     -> bake (assets)                -> tiles/palettes/sprites/font
//     -> script residualizer          -> bytecode
//     -> model                        -> concrete maps/actors/warps
//     -> lower (+ validate)           -> PJGB chunks
//     -> pack                         -> cartridge blob

import { evaluateGame } from "./evaluate.ts";
import { Ctx } from "./context.ts";
import { bake } from "./bake.ts";
import { compileScript } from "./script.ts";
import { buildModel, type GameModel } from "./model.ts";
import { lower } from "./lower.ts";
import { packCart, type Chunk } from "./pack.ts";
import { DBG, DEBUG_ADDR } from "../spec/pjgb.ts";
import type { GameDecl } from "../dsl/index.ts";

export interface CompileOutput {
  ctx: Ctx;
  model: GameModel;
  chunks: Chunk[];
  blob: Uint8Array;
  game: GameDecl;
}

export async function compile(entry: string): Promise<CompileOutput> {
  const ev = await evaluateGame(entry);
  const ctx = new Ctx();
  bake(ctx, ev.registry);

  // AST scripts occupy ids 0..N-1 (matching the ScriptRefs the actors carry).
  for (const site of ev.scripts) {
    const bc = compileScript(site, ctx);
    const id = ctx.addScript(`script_${site.id}`, bc);
    if (id !== site.id) throw new Error(`internal: script id ${id} != site ${site.id}`);
  }

  const model = buildModel(ctx, ev.registry); // sign scripts append at ids N+
  const chunks = lower(ctx, model, ev.registry.game!);
  const blob = packCart(chunks);
  return { ctx, model, chunks, blob, game: ev.registry.game! };
}

/** Debug map for the emulator test harness: names -> ids/addresses. */
export function debugInfo(out: CompileOutput): unknown {
  const { ctx, model } = out;
  const flags: Record<string, { id: number; byteAddr: number; bit: number }> = {};
  ctx.flags.list().forEach((name, id) => {
    flags[name] = { id, byteAddr: DEBUG_ADDR + DBG.FLAGS + (id >> 3), bit: id & 7 };
  });
  const maps: Record<string, number> = {};
  ctx.mapIndex.forEach((i, name) => (maps[name] = i));
  return {
    title: out.game.title,
    start: model.start,
    debugAddr: DEBUG_ADDR,
    fields: DBG,
    flags,
    maps,
    texts: ctx.texts.list(),
    scripts: ctx.scripts.map((s) => ({ id: s.id, name: s.name, bytes: s.bytecode.length })),
    sprites: ctx.spriteProtos,
    bgTiles: ctx.bgTiles.length,
    objTiles: ctx.objTiles.length,
    blobSize: out.blob.length,
  };
}

/** Compact IR snapshot for `dist/game.ir.json` (design §11.8). */
export function irJson(out: CompileOutput): unknown {
  return {
    title: out.game.title,
    start: out.model.start,
    maps: out.model.maps.map((m) => ({
      name: m.name,
      index: m.index,
      size: [m.w, m.h],
      actors: m.actors.map((a) => ({ name: a.name, at: [a.x, a.y], sprite: a.spriteId, onTalk: a.onTalk })),
      warps: m.warps.map((w) => ({ at: [w.x, w.y], to: `${w.destMap}:${w.destEntrance}`, dest: [w.destMapIdx, w.destX, w.destY] })),
      entrances: [...m.entrances.entries()],
    })),
    scripts: out.ctx.scripts.map((s) => ({ id: s.id, name: s.name, bytes: s.bytecode.length })),
    texts: out.ctx.texts.list(),
    flags: out.ctx.flags.list(),
  };
}

export { packCart };
