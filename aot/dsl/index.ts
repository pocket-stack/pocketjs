// aot/dsl/index.ts — the @pocketjs/aot public authoring surface.
//
// Two zones (design §8):
//   - Static declaration zone: defineTileset / defineSprite / defineMap /
//     defineGame + host elements. EXECUTED at build time; fills REGISTRY.
//   - Residual script zone: script(function*(){ yield say(...) ... }). NOT
//     executed — the compiler rewrites each script(...) to script(<id>) and
//     lowers the generator body from its AST (aot/compiler/script.ts).
//
// The op wrappers (say/choose/hasFlag/...) exist for typing + AST recognition;
// their runtime bodies never run on host or GBA.

import { hostElement, type PjgbNode } from "./jsx-runtime.ts";
import type {
  BattleId,
  Direction,
  FlagId,
  ItemId,
  MapId,
  MovementKind,
  ScriptRef,
  SpriteId,
  TileCoord,
  VarId,
} from "./types.ts";

export * from "./types.ts";
export { Fragment } from "./jsx-runtime.ts";
export type { PjgbNode } from "./jsx-runtime.ts";

// ---------------------------------------------------------------------------
// Registry — module-level, shared between the executed game module and the
// compiler (both import this exact module instance).
// ---------------------------------------------------------------------------
export interface TileDecl {
  px: string[]; // 8 rows of 8 hex-nibble palette indices (0-f)
  solid?: boolean;
}
export interface TilesetDecl {
  name: string;
  palette: [number, number, number][]; // up to 16 rgb triples; index 0 = transparent/backdrop
  tiles: Record<string, TileDecl>;
}
export interface SpriteDecl {
  name: string;
  size: [number, number];
  palette: [number, number, number][];
  // one entry per facing (down,up,left,right); each is `frames` grids of
  // `w*h` hex-nibble palette indices (rows joined). v1: 16x16, 1-2 frames.
  facings: Record<Direction, string[][]>;
}
export interface MapDecl {
  name: string;
  tileset: string;
  root: PjgbNode; // the <Map> element tree
  size?: [number, number];
}
export interface GameDecl {
  title: string;
  start: string; // "map:entrance"
  maps: MapDecl[];
  sprites?: string[];
  items?: string[];
  battles?: string[];
  flags?: string[];
  vars?: string[];
}

export interface Registry {
  tilesets: Map<string, TilesetDecl>;
  sprites: Map<string, SpriteDecl>;
  maps: MapDecl[];
  game: GameDecl | null;
  // scriptId -> nothing at runtime; the AST is recovered by the compiler.
  scriptCount: number;
}

// NOTE: this module exports a host element named `Map`, which shadows the JS
// global. Use globalThis.Map for the real collections.
const REGISTRY: Registry = {
  tilesets: new globalThis.Map(),
  sprites: new globalThis.Map(),
  maps: [],
  game: null,
  scriptCount: 0,
};

/** Compiler entry point: reset before executing a fresh game module. */
export function __resetRegistry(): void {
  REGISTRY.tilesets.clear();
  REGISTRY.sprites.clear();
  REGISTRY.maps = [];
  REGISTRY.game = null;
  REGISTRY.scriptCount = 0;
}
/** Compiler entry point: read what the executed module declared. */
export function __getRegistry(): Registry {
  return REGISTRY;
}

// ---------------------------------------------------------------------------
// Host elements (design §18). These are markers; the IR builder walks them.
// ---------------------------------------------------------------------------
export const Map = hostElement("Map");
export const Layer = hostElement("Layer");
export const Npc = hostElement("Npc");
export const Warp = hostElement("Warp");
export const Sign = hostElement("Sign");
export const PlayerSpawn = hostElement("PlayerSpawn");
export const Entrance = hostElement("Entrance");
export const Trigger = hostElement("Trigger");
export const Collision = hostElement("Collision");

// ---------------------------------------------------------------------------
// Static builders
// ---------------------------------------------------------------------------
export function defineTileset(name: string, decl: Omit<TilesetDecl, "name">): TilesetDecl {
  const full: TilesetDecl = { name, ...decl };
  REGISTRY.tilesets.set(name, full);
  return full;
}

export function defineSprite(name: string, decl: Omit<SpriteDecl, "name">): SpriteId {
  REGISTRY.sprites.set(name, { name, ...decl });
  return name as SpriteId;
}

export function defineMap(
  name: string,
  opts: { size?: [number, number]; tileset: string },
  build: () => PjgbNode,
): MapDecl {
  const root = build();
  const decl: MapDecl = { name, tileset: opts.tileset, root, size: opts.size };
  REGISTRY.maps.push(decl);
  return decl;
}

export function defineGame(decl: Omit<GameDecl, "maps"> & { maps: MapDecl[] }): GameDecl {
  REGISTRY.game = decl;
  return decl;
}

// ---------------------------------------------------------------------------
// Branded id helpers (identity at runtime; brands for the type checker).
// ---------------------------------------------------------------------------
export const flag = <T extends string>(id: T): FlagId => id as unknown as FlagId;
export const sprite = <T extends string>(id: T): SpriteId => id as unknown as SpriteId;
export const mapId = <T extends string>(id: T): MapId => id as unknown as MapId;
export const varId = <T extends string>(id: T): VarId => id as unknown as VarId;

// ---------------------------------------------------------------------------
// Scripts + ops. The compiler rewrites `script(function*(){...})` to
// `script(<id>)`, so at runtime we only ever see the id.
// ---------------------------------------------------------------------------
export type ScriptBody = () => Generator<unknown, void, unknown>;

export function script(bodyOrId: ScriptBody | number): ScriptRef {
  // The compiler rewrites every `script(function*(){...})` to `script(<id>)`
  // before executing this module, so we only ever see a number here.
  if (typeof bodyOrId === "number") return { __pjgbScript: bodyOrId };
  throw new Error(
    "script() must be compiled by @pocketjs/aot, not executed directly — the generator body is lowered from its AST.",
  );
}

// Op wrappers — recognized by name in the residualizer. Runtime bodies unused.
export function say(_text: string): unknown {
  return undefined;
}
export function choose<const T extends readonly string[]>(_options: T): T[number] {
  return _options[0];
}
export function hasFlag(_id: FlagId | string): boolean {
  return false;
}
export function setFlag(_id: FlagId | string): unknown {
  return undefined;
}
export function clearFlag(_id: FlagId | string): unknown {
  return undefined;
}
export function lockPlayer(): unknown {
  return undefined;
}
export function releasePlayer(): unknown {
  return undefined;
}
export function facePlayer(_actor: string): unknown {
  return undefined;
}
export function warpTo(_dest: string): unknown {
  return undefined;
}
export function battle(_id: BattleId | string): boolean {
  return true;
}
export function giveItem(_id: ItemId | string, _count?: number): unknown {
  return undefined;
}
export function takeItem(_id: ItemId | string, _count?: number): unknown {
  return undefined;
}
export function wait(_frames: number): unknown {
  return undefined;
}
export function getVar(_id: VarId | string): number {
  return 0;
}
export function setVar(_id: VarId | string, _value: number): unknown {
  return undefined;
}
export function addVar(_id: VarId | string, _delta: number): unknown {
  return undefined;
}
export function playSfx(_id: string): unknown {
  return undefined;
}

export type { Direction, MovementKind, TileCoord };
