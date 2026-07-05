// aot/compiler/model.ts — Stage 3b: normalize the executed JSX scene trees into
// a concrete GameModel (tile grids, collision, actors, warps, entrances). Signs
// expand into a solid tile + a synthetic one-line text script (design §11.3).

import { DIR_NAMES, MOVE_NAMES, OP, ACTOR_FLAG, DIR } from "../spec/pjgb.ts";
import { wrapPages } from "./text.ts";
import type { Ctx } from "./context.ts";
import type { TextMode } from "./script.ts";
import type { PjgbNode, Registry } from "../dsl/index.ts";

const NO_SPRITE = 0xff;
const NO_SCRIPT8 = 0xff;

export interface ActorModel {
  name: string;
  x: number;
  y: number;
  spriteId: number;
  facing: number;
  movement: number;
  flags: number;
  onTalk: number; // script id or 0xffff
}
export interface WarpModel {
  x: number;
  y: number;
  destMap: string;
  destEntrance: string;
  // resolved in a second pass:
  destMapIdx?: number;
  destX?: number;
  destY?: number;
  destDir?: number;
}
export interface MapModel {
  name: string;
  index: number;
  w: number;
  h: number;
  tiles: number[];
  collision: number[];
  palbank: number;
  onEnter: number; // script id or 0xff
  actors: ActorModel[];
  warps: WarpModel[];
  entrances: globalThis.Map<string, { x: number; y: number; dir: number }>;
}
export interface GameModel {
  maps: MapModel[];
  start: { map: number; x: number; y: number; dir: number };
}

const prop = (n: PjgbNode, k: string): unknown => n.props[k];
const at = (n: PjgbNode): [number, number] => {
  const a = n.props.at as [number, number] | undefined;
  if (!a) throw new Error(`<${n.host}> missing at={[x,y]}`);
  return a;
};
const dirOf = (v: unknown, dflt = DIR.DOWN): number =>
  v == null ? dflt : DIR_NAMES[String(v)] ?? dflt;

export function buildModel(ctx: Ctx, registry: Registry, mode: TextMode = "ascii8"): GameModel {
  const game = registry.game!;
  // Iterate the game's OWN map decls (direct object refs), not the registry
  // accumulator: helper modules are cached across compiles in one process.
  game.maps.forEach((m, i) => ctx.mapIndex.set(m.name, i));

  const maps: MapModel[] = game.maps.map((mapDecl, index) => {
    const tileset = registry.tilesets.get(mapDecl.tileset)!;
    const children = mapDecl.root.children;
    const layer = children.find((c) => c.host === "Layer");
    if (!layer) throw new Error(`map "${mapDecl.name}" has no <Layer>`);

    const rows = layer.props.rows as string[];
    const legend = layer.props.legend as Record<string, string>;
    const h = rows.length;
    const w = rows[0].length;
    const tiles: number[] = new Array(w * h).fill(0);
    const collision: number[] = new Array(w * h).fill(0);
    for (let y = 0; y < h; y++) {
      if (rows[y].length !== w) throw new Error(`map "${mapDecl.name}" row ${y} width ${rows[y].length} != ${w}`);
      for (let x = 0; x < w; x++) {
        const name = legend[rows[y][x]];
        if (!name) throw new Error(`map "${mapDecl.name}": legend has no entry for "${rows[y][x]}"`);
        const id = ctx.tileNameToId.get(name);
        if (id === undefined) throw new Error(`map "${mapDecl.name}": tile "${name}" not in tileset`);
        tiles[y * w + x] = id;
        collision[y * w + x] = tileset.tiles[name].solid ? 1 : 0;
      }
    }

    const entrances = new globalThis.Map<string, { x: number; y: number; dir: number }>();
    const actors: ActorModel[] = [];
    const warps: WarpModel[] = [];

    for (const c of children) {
      switch (c.host) {
        case "Layer":
          break;
        case "PlayerSpawn":
        case "Entrance": {
          const [x, y] = at(c);
          const id = (prop(c, "id") as string) ?? (c.host === "PlayerSpawn" ? "spawn" : "entrance");
          entrances.set(id, { x, y, dir: dirOf(prop(c, "facing")) });
          break;
        }
        case "Npc": {
          const [x, y] = at(c);
          const ref = prop(c, "onTalk") as { __pjgbScript: number } | undefined;
          actors.push({
            name: (prop(c, "id") as string) ?? `npc_${actors.length}`,
            x,
            y,
            spriteId: ctx.spriteId(String(prop(c, "sprite"))),
            facing: dirOf(prop(c, "facing")),
            movement: MOVE_NAMES[String(prop(c, "movement") ?? "static")] ?? 0,
            flags: ACTOR_FLAG.SOLID,
            onTalk: ref ? ref.__pjgbScript : 0xffff,
          });
          break;
        }
        case "Sign": {
          const [x, y] = at(c);
          const text = String(prop(c, "text") ?? "");
          // synthetic script: TEXT <page id> per page; END
          const pages = mode === "cjk16" ? wrapPages(text, ctx.target) : [text];
          const bc: number[] = [];
          for (const page of pages) {
            const textId = ctx.internText(page);
            bc.push(OP.TEXT, textId & 0xff, (textId >> 8) & 0xff);
          }
          bc.push(OP.END);
          const sid = ctx.addScript(`sign_${index}_${x}_${y}`, bc);
          const signTile = ctx.tileNameToId.get("sign");
          if (signTile !== undefined) {
            tiles[y * w + x] = signTile;
          }
          collision[y * w + x] = 1;
          actors.push({
            name: `sign_${x}_${y}`,
            x,
            y,
            spriteId: NO_SPRITE,
            facing: DIR.DOWN,
            movement: 0,
            flags: ACTOR_FLAG.SOLID,
            onTalk: sid,
          });
          break;
        }
        case "Trigger": {
          // A sprite-less interactable: solid tile the player can face and
          // press A on to run a script (stone doors, cliff edges, steles...).
          const [x, y] = at(c);
          const ref = prop(c, "onTalk") as { __pjgbScript: number } | undefined;
          if (!ref) throw new Error(`map "${mapDecl.name}": <Trigger> needs onTalk={script(...)}`);
          collision[y * w + x] = 1;
          actors.push({
            name: (prop(c, "id") as string) ?? `trigger_${x}_${y}`,
            x,
            y,
            spriteId: NO_SPRITE,
            facing: DIR.DOWN,
            movement: 0,
            flags: ACTOR_FLAG.SOLID,
            onTalk: ref.__pjgbScript,
          });
          break;
        }
        case "Warp": {
          const [x, y] = at(c);
          const to = String(prop(c, "to"));
          const [destMap, destEntrance] = to.split(":");
          warps.push({ x, y, destMap, destEntrance: destEntrance ?? "spawn" });
          break;
        }
        default:
          throw new Error(`map "${mapDecl.name}": unsupported element <${c.host}>`);
      }
    }

    const onEnterRef = mapDecl.onEnter as { __pjgbScript: number } | undefined;
    const onEnter = onEnterRef ? onEnterRef.__pjgbScript : NO_SCRIPT8;
    if (onEnter !== NO_SCRIPT8 && onEnter > 0xfe) {
      throw new Error(`map "${mapDecl.name}": onEnter script id ${onEnter} exceeds the u8 field`);
    }

    return { name: mapDecl.name, index, w, h, tiles, collision, palbank: 0, onEnter, actors, warps, entrances };
  });

  // resolve warps against destination entrances
  const byName = new globalThis.Map(maps.map((m) => [m.name, m]));
  for (const m of maps) {
    for (const wp of m.warps) {
      const dm = byName.get(wp.destMap);
      if (!dm) throw new Error(`warp on "${m.name}" -> unknown map "${wp.destMap}"`);
      const ent = dm.entrances.get(wp.destEntrance);
      if (!ent) throw new Error(`warp on "${m.name}" -> "${wp.destMap}" has no entrance "${wp.destEntrance}"`);
      wp.destMapIdx = dm.index;
      wp.destX = ent.x;
      wp.destY = ent.y;
      wp.destDir = ent.dir;
    }
  }

  // resolve start
  const [startMap, startEnt] = game.start.split(":");
  const sm = byName.get(startMap);
  if (!sm) throw new Error(`start map "${startMap}" not found`);
  const se = sm.entrances.get(startEnt ?? "spawn");
  if (!se) throw new Error(`start "${game.start}": no entrance "${startEnt}"`);

  return { maps, start: { map: sm.index, x: se.x, y: se.y, dir: se.dir } };
}
