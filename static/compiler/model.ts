// static/compiler/model.ts — declarations -> the concrete game model:
// numeric ids everywhere, tile grids + collision from layout/legend, actors,
// warps, triggers, entrances resolved, budgets enforced. Target-independent
// (pixel encoding happens in targets/*; text pagination already happened in
// the script stage's Ctx).

import { type TargetSpec } from "../spec/isa.ts";
import {
  ACTOR_F,
  DIR_BY_NAME,
  MAX_ACTORS_PER_MAP,
  MOVE,
  RPG_BUDGET,
  SCRIPT_NONE,
  type DirName,
} from "../spec/rpg.ts";
import type { ActorDecl, GameDecl, Registry, SpriteDecl, TilesetDecl } from "../rpg/dsl.ts";
import type { Ctx } from "./context.ts";

export interface ActorModel {
  id: string;
  x: number;
  y: number;
  spriteId: number;
  facing: number;
  move: number;
  flags: number;
  talk: number; // script id or SCRIPT_NONE
}

export interface MapModel {
  name: string;
  width: number;
  height: number;
  tiles: number[]; // row-major tile indices (0 = blank)
  solid: boolean[];
  actors: ActorModel[];
  warps: { x: number; y: number; destMap: number; destX: number; destY: number; destDir: number }[];
  triggers: { x: number; y: number; script: number; flags: number; onceFlag: number }[];
  onEnter: number;
  entrances: Record<string, { x: number; y: number; dir: number }>;
}

export interface GameModel {
  title: string;
  start: { map: number; x: number; y: number; dir: number };
  playerSpriteId: number;
  tileset: TilesetDecl;
  /** Tile index -> tileset tile name ("" for blank at 0). */
  tileNames: string[];
  sprites: SpriteDecl[];
  maps: MapModel[];
  mapIndex: Record<string, number>;
  /** Script-referenced actor ids -> location (for AVIS/FACE fixups). */
  actorSlots: Record<string, { map: number; slot: number }>;
}

const parseLayout = (layout: string, mapName: string): string[] => {
  const rawLines = layout.split("\n");
  while (rawLines.length && rawLines[0].trim() === "") rawLines.shift();
  while (rawLines.length && rawLines[rawLines.length - 1].trim() === "") rawLines.pop();
  if (rawLines.length === 0) throw new Error(`map ${mapName}: empty layout`);
  const indents = rawLines.filter((l) => l.trim() !== "").map((l) => l.length - l.trimStart().length);
  const strip = Math.min(...indents);
  const lines = rawLines.map((l) => l.slice(strip).replace(/\s+$/, ""));
  const width = Math.max(...lines.map((l) => l.length));
  return lines.map((l) => l.padEnd(width, " "));
};

export function buildModel(game: GameDecl, registry: Registry, ctx: Ctx, target: TargetSpec): GameModel {
  // v1: one tileset per game — every map must share it.
  const tilesets = new Set(game.maps.map((m) => m.tileset));
  if (tilesets.size !== 1) {
    throw new Error(`v1 supports exactly one tileset per game (got ${[...tilesets].map((t) => t.name).join(", ")})`);
  }
  const tileset = game.maps[0].tileset;

  const tileIndex = new Map<string, number>();
  const tileNames = [""];
  Object.keys(tileset.tiles).forEach((name) => {
    tileIndex.set(name, tileNames.length);
    tileNames.push(name);
  });
  if (tileNames.length - 1 > Math.min(RPG_BUDGET.MAX_TILESET_TILES, target.bgArtTiles)) {
    throw new Error(
      `tileset ${tileset.name}: ${tileNames.length - 1} tiles exceeds the ${target.name} art budget (${Math.min(RPG_BUDGET.MAX_TILESET_TILES, target.bgArtTiles)})`,
    );
  }

  // Sprites: the player plus every actor sprite, in REGISTRY order.
  const spriteIds = new Map<SpriteDecl, number>();
  registry.sprites.forEach((sp, i) => spriteIds.set(sp, i));
  if (registry.sprites.length > RPG_BUDGET.MAX_SPRITES) {
    throw new Error(`${registry.sprites.length} sprites exceeds budget ${RPG_BUDGET.MAX_SPRITES}`);
  }
  const spriteIdOf = (sp: SpriteDecl, whom: string): number => {
    const id = spriteIds.get(sp);
    if (id === undefined) throw new Error(`${whom}: sprite was not created with defineSprite()`);
    return id;
  };

  if (game.maps.length > RPG_BUDGET.MAX_MAPS) throw new Error(`too many maps (${game.maps.length})`);
  const mapIndex: Record<string, number> = {};
  game.maps.forEach((m, i) => {
    if (mapIndex[m.name] !== undefined) throw new Error(`duplicate map name "${m.name}"`);
    mapIndex[m.name] = i;
  });

  const actorSlots: Record<string, { map: number; slot: number }> = {};
  const dirOf = (d: DirName | undefined, fallback = 0): number => (d ? DIR_BY_NAME[d] : fallback);

  const maps: MapModel[] = game.maps.map((m, mi) => {
    const lines = parseLayout(m.layout, m.name);
    const width = lines[0].length;
    const height = lines.length;
    if (width > target.maxMapW || height > target.maxMapH) {
      throw new Error(`map ${m.name}: ${width}x${height} exceeds ${target.name} max ${target.maxMapW}x${target.maxMapH}`);
    }
    const tiles: number[] = [];
    const solid: boolean[] = [];
    for (const line of lines) {
      for (const ch of line) {
        if (ch === " " && !(m.legend[" "] !== undefined)) {
          tiles.push(0);
          solid.push(false);
          continue;
        }
        const tileName = m.legend[ch];
        if (tileName === undefined) throw new Error(`map ${m.name}: layout char "${ch}" missing from legend`);
        const ti = tileIndex.get(tileName);
        if (ti === undefined) throw new Error(`map ${m.name}: legend "${ch}" -> unknown tile "${tileName}"`);
        tiles.push(ti);
        solid.push(tileset.tiles[tileName].solid === true);
      }
    }

    const inBounds = (x: number, y: number, what: string): void => {
      if (x < 0 || y < 0 || x >= width || y >= height) {
        throw new Error(`map ${m.name}: ${what} at (${x},${y}) is outside ${width}x${height}`);
      }
    };

    const actors = (m.actors ?? []).map((a: ActorDecl, slot: number) => {
      inBounds(a.at[0], a.at[1], `actor "${a.id}"`);
      if (actorSlots[a.id]) throw new Error(`actor id "${a.id}" is used on two maps — ids are global`);
      actorSlots[a.id] = { map: mi, slot };
      return {
        id: a.id,
        x: a.at[0],
        y: a.at[1],
        spriteId: spriteIdOf(a.sprite, `actor ${a.id}`),
        facing: dirOf(a.facing),
        move: a.move === "wander" ? MOVE.WANDER : MOVE.STATIC,
        flags: (a.solid === false ? 0 : ACTOR_F.SOLID) | (a.hidden ? ACTOR_F.HIDDEN : 0),
        talk: a.talk ? a.talk.__script : SCRIPT_NONE,
      };
    });
    if (actors.length > MAX_ACTORS_PER_MAP) {
      throw new Error(`map ${m.name}: ${actors.length} actors exceeds ${MAX_ACTORS_PER_MAP}`);
    }

    const entrances: MapModel["entrances"] = {};
    for (const [name, e] of Object.entries(m.entrances ?? {})) {
      inBounds(e.at[0], e.at[1], `entrance "${name}"`);
      entrances[name] = { x: e.at[0], y: e.at[1], dir: dirOf(e.dir) };
    }

    const triggers = (m.triggers ?? []).map((t) => {
      inBounds(t.at[0], t.at[1], "trigger");
      const onceFlag = t.once ? ctx.flagId(`__trig_${m.name}_${t.at[0]}_${t.at[1]}`, `map ${m.name}`) : 0;
      return { x: t.at[0], y: t.at[1], script: t.run.__script, flags: t.once ? 1 : 0, onceFlag };
    });

    return {
      name: m.name,
      width,
      height,
      tiles,
      solid,
      actors,
      warps: [], // filled below once all maps/entrances exist
      triggers,
      onEnter: m.onEnter ? m.onEnter.__script : SCRIPT_NONE,
      entrances,
    };
  });

  // Second pass: warps (need every map's entrances).
  const resolveDest = (dest: string, whom: string): { map: number; x: number; y: number; dir: number } => {
    const [mapName, entName] = dest.split(":");
    const di = mapIndex[mapName];
    if (di === undefined) throw new Error(`${whom}: unknown map "${mapName}" in "${dest}"`);
    const ent = maps[di].entrances[entName];
    if (!ent) throw new Error(`${whom}: map "${mapName}" has no entrance "${entName}"`);
    return { map: di, x: ent.x, y: ent.y, dir: ent.dir };
  };

  game.maps.forEach((m, mi) => {
    maps[mi].warps = (m.warps ?? []).map((w) => {
      const d = resolveDest(w.to, `map ${m.name} warp`);
      if (w.at[0] < 0 || w.at[1] < 0 || w.at[0] >= maps[mi].width || w.at[1] >= maps[mi].height) {
        throw new Error(`map ${m.name}: warp at (${w.at[0]},${w.at[1]}) out of bounds`);
      }
      return { x: w.at[0], y: w.at[1], destMap: d.map, destX: d.x, destY: d.y, destDir: d.dir };
    });
  });

  const start = resolveDest(game.start, "game start");

  return {
    title: game.title,
    start: { map: start.map, x: start.x, y: start.y, dir: start.dir },
    playerSpriteId: spriteIdOf(game.player, "player"),
    tileset,
    tileNames,
    sprites: registry.sprites,
    maps,
    mapIndex,
    actorSlots,
  };
}

/** Resolve the script stage's symbolic fixups against the built model. */
export function patchFixups(blob: Uint8Array, ctx: Ctx, model: GameModel): void {
  for (const w of ctx.warpFixups) {
    const [mapName, entName] = w.dest.split(":");
    const mi = model.mapIndex[mapName];
    if (mi === undefined) throw new Error(`${w.where}: unknown map "${mapName}"`);
    const ent = model.maps[mi].entrances[entName];
    if (!ent) throw new Error(`${w.where}: map "${mapName}" has no entrance "${entName}"`);
    blob[w.at] = mi;
    blob[w.at + 1] = ent.x;
    blob[w.at + 2] = ent.y;
    blob[w.at + 3] = ent.dir;
  }
  for (const a of ctx.actorFixups) {
    const loc = model.actorSlots[a.actorId];
    if (!loc) throw new Error(`${a.where}: unknown actor id "${a.actorId}"`);
    blob[a.at] = loc.slot;
  }
}
