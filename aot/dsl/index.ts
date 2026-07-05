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

import {
  hostElement,
  normalizeSceneChildren,
  type EntranceProps,
  type LayerProps,
  type NpcProps,
  type PjgbChild,
  type PjgbNode,
  type PlayerSpawnProps,
  type SignProps,
  type TriggerProps,
  type WarpProps,
} from "./jsx-runtime.ts";
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
export type {
  EntranceProps,
  LayerProps,
  NpcProps,
  PjgbChild,
  PjgbNode,
  PlayerSpawnProps,
  SignProps,
  TriggerProps,
  WarpProps,
} from "./jsx-runtime.ts";

type Rgb = readonly [number, number, number];
type Whitespace = " " | "\t" | "\r";

type TrimLineLeft<S extends string> = S extends `${Whitespace}${infer Rest}` ? TrimLineLeft<Rest> : S;
type TrimLineRight<S extends string> = S extends `${infer Rest}${Whitespace}` ? TrimLineRight<Rest> : S;
type TrimLine<S extends string> = TrimLineRight<TrimLineLeft<S>>;
type SplitLines<S extends string> = S extends `${infer Head}\n${infer Rest}` ? [Head, ...SplitLines<Rest>] : [S];
type NonEmptyTrimmedLines<Lines extends readonly string[]> = Lines extends readonly [
  infer Head extends string,
  ...infer Rest extends readonly string[],
]
  ? TrimLine<Head> extends ""
    ? NonEmptyTrimmedLines<Rest>
    : [TrimLine<Head>, ...NonEmptyTrimmedLines<Rest>]
  : [];
type RowsOf<Source extends string> = NonEmptyTrimmedLines<SplitLines<Source>>;
type Chars<S extends string> = S extends `${infer Head}${infer Rest}` ? Head | Chars<Rest> : never;
type RowChars<Rows extends readonly string[]> = Rows[number] extends infer Row extends string ? Chars<Row> : never;
type RowLength<S extends string, Acc extends unknown[] = []> = S extends `${infer _Head}${infer Rest}`
  ? RowLength<Rest, [unknown, ...Acc]>
  : Acc["length"];
type SameWidth<Rows extends readonly string[], Width extends number | null = null> = Rows extends readonly [
  infer Head extends string,
  ...infer Rest extends readonly string[],
]
  ? Width extends number
    ? RowLength<Head> extends Width
      ? [Head, ...SameWidth<Rest, Width>]
      : never
    : [Head, ...SameWidth<Rest, RowLength<Head>>]
  : [];
type RowsForLegend<Source extends string> = string extends Source ? readonly string[] : SameWidth<RowsOf<Source>>;
type TileNameOf<Tileset> = Tileset extends TilesetDecl<string, infer Tiles> ? Extract<keyof Tiles, string> : string;
type LayerTileNames<Layer> = Layer extends LayerSpec<readonly string[], infer TileName> ? TileName : string;
type CompatibleLayer<Tileset, Layer> = string extends LayerTileNames<Layer>
  ? Layer
  : Exclude<LayerTileNames<Layer>, TileNameOf<Tileset>> extends never
    ? Layer
    : never;

// ---------------------------------------------------------------------------
// Registry — module-level, shared between the executed game module and the
// compiler (both import this exact module instance).
// ---------------------------------------------------------------------------
export interface TileDecl {
  px: readonly string[]; // 8 rows of 8 hex-nibble palette indices (0-f)
  solid?: boolean;
}
export interface TilesetDecl<
  Name extends string = string,
  Tiles extends Record<string, TileDecl> = Record<string, TileDecl>,
> {
  name: Name;
  palette: readonly Rgb[]; // up to 16 rgb triples; index 0 = transparent/backdrop
  tiles: Tiles;
}
export interface SpriteDecl<Name extends string = string> {
  name: Name;
  size: [number, number];
  palette: readonly Rgb[];
  // one entry per facing (down,up,left,right); each is `frames` grids of
  // `w*h` hex-nibble palette indices (rows joined). v1: 16x16, 1-2 frames.
  facings: Record<Direction, readonly (readonly string[])[]>;
}
export interface MapDecl {
  name: string;
  tileset: string;
  root: PjgbNode; // the <Map> element tree
  size?: [number, number];
  onEnter?: ScriptRef; // script that runs whenever this map loads
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
  /**
   * Text renderer: "ascii8" = legacy 8x8 ASCII font (GBA only); "cjk16" =
   * 16px lines with on-demand Unifont glyph streaming (any target; forced on
   * gb/nes). Default: ascii8 on gba, cjk16 elsewhere.
   */
  textMode?: "ascii8" | "cjk16";
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

/**
 * Compiler entry point: reset before executing a fresh game module.
 *
 * Only per-run state (the game decl + the map list) is cleared. Tileset and
 * sprite declarations often live in helper modules (e.g. demo/assets.ts)
 * whose top-level side effects run ONCE per process — Bun caches them by
 * resolved path — so clearing those interners would lose them on the second
 * compile in one process (e.g. building several targets). Their define*
 * calls are idempotent (keyed by name), so persisting them is safe.
 */
export function __resetRegistry(): void {
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
export const Layer = hostElement<LayerProps>("Layer");
export const Npc = hostElement<NpcProps>("Npc");
export const Warp = hostElement<WarpProps>("Warp");
export const Sign = hostElement<SignProps>("Sign");
export const PlayerSpawn = hostElement<PlayerSpawnProps>("PlayerSpawn");
export const Entrance = hostElement<EntranceProps>("Entrance");
export const Trigger = hostElement<TriggerProps>("Trigger");
export const Collision = hostElement("Collision");

// ---------------------------------------------------------------------------
// Static builders + strongly-typed map DSL
// ---------------------------------------------------------------------------
export interface TileRef<Name extends string = string> {
  readonly __pjgbTile: true;
  readonly name: Name;
}
type TileInput<Name extends string = string> = TileRef<Name> | Name;

export interface LayerSpec<Rows extends readonly string[] = readonly string[], TileName extends string = string> {
  readonly __pjgbLayer: true;
  readonly rows: Rows;
  readonly legend: Record<string, TileName>;
}

export interface AsciiLayer<Source extends string = string> {
  readonly __pjgbAscii: true;
  readonly source: Source;
  readonly rows: string[];
  legend<const Legend extends Record<RowChars<RowsForLegend<Source>>, TileInput>>(
    legend: RowsForLegend<Source> extends never ? never : Legend,
  ): LayerSpec<RowsForLegend<Source>, ExtractTileNames<Legend>>;
}

type ExtractTileNames<Legend> = Extract<
  {
    [K in keyof Legend]: Legend[K] extends TileRef<infer Name> ? Name : Legend[K] extends string ? Legend[K] : never;
  }[keyof Legend],
  string
>;
const ENTITY_HOSTS = new Set(["PlayerSpawn", "Entrance", "Npc", "Sign", "Warp", "Trigger"]);

function node(host: string, props: Record<string, unknown>, children: PjgbNode[] = []): PjgbNode {
  return { host, props, children };
}

function isTileRef(v: unknown): v is TileRef {
  return typeof v === "object" && v !== null && (v as TileRef).__pjgbTile === true;
}

function tileName(v: TileInput): string {
  return isTileRef(v) ? v.name : String(v);
}

function normalizeAscii(source: string): string[] {
  const lines = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  while (lines.length && lines[0]!.trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (!lines.length) throw new Error("ascii map must contain at least one row");

  let indent = Infinity;
  for (const line of lines) {
    if (line.trim() === "") continue;
    indent = Math.min(indent, line.match(/^[ \t]*/)![0].length);
  }
  const cut = Number.isFinite(indent) ? indent : 0;
  return lines.map((line) => line.slice(cut).trimEnd());
}

function makeLayerSpec(rows: readonly string[], legendInput: Record<string, TileInput>): LayerSpec {
  const width = rows[0]?.length ?? 0;
  if (!width) throw new Error("ascii map must contain non-empty rows");
  rows.forEach((row, i) => {
    if (row.length !== width) throw new Error(`ascii map row ${i} width ${row.length} != ${width}`);
  });

  const legend: Record<string, string> = {};
  for (const [symbol, value] of Object.entries(legendInput)) {
    if (symbol.length !== 1) throw new Error(`ascii legend key "${symbol}" must be exactly one character`);
    legend[symbol] = tileName(value);
  }
  for (const row of rows) {
    for (const symbol of row) {
      if (legend[symbol] === undefined) throw new Error(`ascii legend missing entry for "${symbol}"`);
    }
  }
  return { __pjgbLayer: true, rows: [...rows], legend };
}

class AsciiLayerImpl<Source extends string> implements AsciiLayer<Source> {
  readonly __pjgbAscii = true;
  readonly rows: string[];

  constructor(readonly source: Source) {
    this.rows = normalizeAscii(source);
  }

  legend<const Legend extends Record<RowChars<RowsForLegend<Source>>, TileInput>>(
    legend: RowsForLegend<Source> extends never ? never : Legend,
  ): LayerSpec<RowsForLegend<Source>, ExtractTileNames<Legend>> {
    return makeLayerSpec(this.rows, legend as Record<string, TileInput>) as LayerSpec<
      RowsForLegend<Source>,
      ExtractTileNames<Legend>
    >;
  }
}

export function tile<const Name extends string>(name: Name): TileRef<Name> {
  return { __pjgbTile: true, name };
}

export function ascii<const Source extends string>(
  strings: TemplateStringsArray,
  ...values: never[]
): AsciiLayer<Source> {
  if (values.length) throw new Error("ascii maps do not support interpolation");
  return new AsciiLayerImpl(String.raw({ raw: strings.raw }) as Source);
}

class MapBuilderStart<Name extends string> {
  constructor(private readonly name: Name) {}

  tileset<const Tileset extends TilesetDecl>(tileset: Tileset): MapBuilder<Name, Tileset> {
    return new MapBuilder(this.name, tileset);
  }
}

class FacingPlacement<Parent> {
  private position: [number, number] | null = null;

  constructor(
    private readonly parent: Parent,
    private readonly host: string,
    private readonly props: Record<string, unknown>,
    private readonly append: (node: PjgbNode) => void,
  ) {}

  at(x: number, y: number): this {
    this.position = [x, y];
    return this;
  }

  facing(dir: Direction): Parent {
    if (!this.position) throw new Error(`<${this.host}> needs .at(x, y) before .facing(...)`);
    this.append(node(this.host, { ...this.props, at: this.position, facing: dir }));
    return this.parent;
  }
}

class AtPlacement<Parent> {
  constructor(
    private readonly parent: Parent,
    private readonly host: string,
    private readonly props: Record<string, unknown>,
    private readonly append: (node: PjgbNode) => void,
  ) {}

  at(x: number, y: number): Parent {
    this.append(node(this.host, { ...this.props, at: [x, y] }));
    return this.parent;
  }
}

class NpcBuilder<Parent> {
  private spriteName: string | null = null;

  constructor(
    private readonly parent: Parent,
    private readonly id: string,
    private readonly append: (node: PjgbNode) => void,
  ) {}

  sprite(spriteRef: SpriteId | string): NpcAfterSprite<Parent> {
    this.spriteName = String(spriteRef);
    return new NpcAfterSprite(this.parent, this.id, this.spriteName, this.append);
  }
}

class NpcAfterSprite<Parent> {
  private position: [number, number] | null = null;

  constructor(
    private readonly parent: Parent,
    private readonly id: string,
    private readonly spriteName: string,
    private readonly append: (node: PjgbNode) => void,
  ) {}

  at(x: number, y: number): NpcAfterAt<Parent> {
    this.position = [x, y];
    return new NpcAfterAt(this.parent, this.id, this.spriteName, this.position, this.append);
  }
}

class NpcAfterAt<Parent> {
  constructor(
    private readonly parent: Parent,
    private readonly id: string,
    private readonly spriteName: string,
    private readonly position: [number, number],
    private readonly append: (node: PjgbNode) => void,
  ) {}

  facing(dir: Direction): NpcAfterFacing<Parent> {
    return new NpcAfterFacing(this.parent, {
      id: this.id,
      sprite: this.spriteName,
      at: this.position,
      facing: dir,
    }, this.append);
  }
}

class NpcAfterFacing<Parent> {
  constructor(
    private readonly parent: Parent,
    private readonly props: Record<string, unknown>,
    private readonly append: (node: PjgbNode) => void,
  ) {}

  movement(kind: MovementKind): this {
    this.props.movement = kind;
    return this;
  }

  talk(scriptRef: ScriptRef): Parent {
    this.append(node("Npc", { ...this.props, onTalk: scriptRef }));
    return this.parent;
  }
}

export class MapBuilder<Name extends string = string, Tileset extends TilesetDecl = TilesetDecl> {
  private readonly children: PjgbNode[] = [];

  constructor(
    private readonly name: Name,
    private readonly tilesetDecl: Tileset,
  ) {}

  private append = (child: PjgbNode): void => {
    this.children.push(child);
  };

  layer<const Layer extends LayerSpec>(layer: CompatibleLayer<Tileset, Layer>): this {
    this.append(node("Layer", { rows: [...layer.rows], legend: { ...layer.legend } }));
    return this;
  }

  entities(...children: PjgbChild[]): this {
    for (const child of normalizeSceneChildren(children)) {
      if (!ENTITY_HOSTS.has(child.host)) {
        throw new Error(
          `defineMap("${this.name}").entities(...) does not accept <${child.host}>; use .layer(...) for tile layers`,
        );
      }
      this.append(child);
    }
    return this;
  }

  spawn<const Id extends string>(_id: Id): FacingPlacement<this> {
    return new FacingPlacement(this, "PlayerSpawn", { id: _id }, this.append);
  }

  entrance<const Id extends string>(id: Id): FacingPlacement<this> {
    return new FacingPlacement(this, "Entrance", { id }, this.append);
  }

  npc<const Id extends string>(id: Id): NpcBuilder<this> {
    return new NpcBuilder(this, id, this.append);
  }

  sign(text: string): AtPlacement<this> {
    return new AtPlacement(this, "Sign", { text }, this.append);
  }

  warp(to: `${string}:${string}` | string): AtPlacement<this> {
    return new AtPlacement(this, "Warp", { to }, this.append);
  }

  onEnter(scriptRef: ScriptRef): this {
    this.onEnterRef = scriptRef;
    return this;
  }
  private onEnterRef?: ScriptRef;

  done(): MapDecl {
    const firstLayer = this.children.find((c) => c.host === "Layer");
    const rows = firstLayer?.props.rows as string[] | undefined;
    const root = node("Map", {}, this.children);
    const decl: MapDecl = {
      name: this.name,
      tileset: this.tilesetDecl.name,
      root,
      size: rows ? [rows[0]?.length ?? 0, rows.length] : undefined,
      onEnter: this.onEnterRef,
    };
    REGISTRY.maps.push(decl);
    return decl;
  }
}

export function defineTileset<
  const Name extends string,
  const Tiles extends Record<string, TileDecl>,
>(name: Name, decl: { palette: readonly Rgb[]; tiles: Tiles }): TilesetDecl<Name, Tiles> {
  const full: TilesetDecl = { name, ...decl };
  REGISTRY.tilesets.set(name, full);
  return full as TilesetDecl<Name, Tiles>;
}

export function defineSprite<const Name extends string>(name: Name, decl: Omit<SpriteDecl<Name>, "name">): SpriteId {
  REGISTRY.sprites.set(name, { name, ...decl });
  return name as unknown as SpriteId;
}

export function defineMap<const Name extends string>(name: Name): MapBuilderStart<Name>;
export function defineMap<const Name extends string>(
  name: Name,
  opts: { size?: [number, number]; tileset: string },
  build: () => PjgbNode,
): MapDecl;
export function defineMap(
  name: string,
  opts?: { size?: [number, number]; tileset: string },
  build?: () => PjgbNode,
): MapDecl | MapBuilderStart<string> {
  if (!opts || !build) return new MapBuilderStart(name);
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
// Compare a var against a compile-time constant; yields a testable value for
// `if (yield varGt("hp", 0))` / `while (yield varGt("hp", 0))`.
export function varEq(_id: VarId | string, _value: number): boolean {
  return false;
}
export function varGt(_id: VarId | string, _value: number): boolean {
  return false;
}
export function varLt(_id: VarId | string, _value: number): boolean {
  return false;
}
export function varGe(_id: VarId | string, _value: number): boolean {
  return false;
}
export function varLe(_id: VarId | string, _value: number): boolean {
  return false;
}
/** Uniform random integer 0..n-1 (frame-seeded LCG on the cartridge). */
export function rnd(_n: number): number {
  return 0;
}
export function playSfx(_id: string): unknown {
  return undefined;
}

export type { Direction, MovementKind, TileCoord };
