// static/rpg/dsl.ts — the @pocketjs/static RPG authoring surface.
//
// Two zones (see static/DESIGN.md §1):
//   - Declaration zone: defineTileset / defineSprite / defineMap / defineGame
//     and the npc/warp/trigger builders. Plain TypeScript, EXECUTED at build
//     time on the host; fills the module-level REGISTRY.
//   - Residual zone: script(function* (s, v, f) { ... }). NEVER executed —
//     the compiler rewrites each script(<generator>) to script(<id>) before
//     evaluation and lowers the generator body from its AST
//     (static/compiler/script.ts).
//
// The `s` ops below therefore have no host implementation: their types are
// the API; their bodies throw if anything ever actually calls them.

// ---------------------------------------------------------------------------
// Residual script surface (types only)
// ---------------------------------------------------------------------------
export type Vars = Record<string, number>;
export type Flags = Record<string, boolean>;

/** Engine ops available inside scripts. All are used with `yield*`. */
export interface Ops {
  /** Show textbox pages (auto-wrapped per console). `${}` of runtime values allowed. */
  say(text: string): Generator<unknown, void, unknown>;
  /** Menu; resolves to the picked index. Options are compile-time strings. */
  choose(options: readonly string[]): Generator<unknown, number, unknown>;
  /** Uniform 0..n-1 from the deterministic story RNG. */
  rnd(n: number): Generator<unknown, number, unknown>;
  /** Suspend for n frames. */
  wait(frames: number): Generator<unknown, void, unknown>;
  /** Freeze / unfreeze player movement. */
  lock(): Generator<unknown, void, unknown>;
  release(): Generator<unknown, void, unknown>;
  /** Actor faces the player. No argument = the actor that started this script. */
  face(actorId?: string): Generator<unknown, void, unknown>;
  /** Show/hide an actor on the current map (persist via flags + onEnter). */
  show(actorId: string): Generator<unknown, void, unknown>;
  hide(actorId: string): Generator<unknown, void, unknown>;
  /** Move the player to "map:entrance". */
  warp(dest: string): Generator<unknown, void, unknown>;
  /** Square-wave blip: confirm/deny/damage/heal/fanfare. */
  sfx(name: "confirm" | "deny" | "damage" | "heal" | "fanfare"): Generator<unknown, void, unknown>;
  /** Run another top-level script as a subroutine. */
  call(target: ScriptRef): Generator<unknown, void, unknown>;
}

export type ScriptBody = (s: Ops, v: Vars, f: Flags) => Generator<unknown, void, unknown>;

export interface ScriptRef {
  readonly __script: number;
}

const residual = (name: string) => {
  throw new Error(`${name}() is residual-only: script bodies never execute (the compiler lowers them)`);
};

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------
export type Rgb = readonly [number, number, number];
export type DirName = "down" | "up" | "left" | "right";
export type MoveName = "static" | "wander";

export interface TileDecl {
  /** 8 rows of 8 hex nibbles (palette indices, 0 = backdrop). */
  px: readonly string[];
  solid?: boolean;
}

export interface TilesetDecl<Tiles extends Record<string, TileDecl> = Record<string, TileDecl>> {
  name: string;
  /** Up to 16 colors; index 0 = backdrop. */
  palette: readonly Rgb[];
  tiles: Tiles;
}

export interface SpriteDecl {
  name: string;
  /** Up to 16 colors; index 0 = transparent. */
  palette: readonly Rgb[];
  /**
   * 16x16 frames as 16 rows of 16 hex nibbles. Facings down/up/right with
   * 1..2 frames each (left renders as mirrored right). Frame 0 stands,
   * frame 1 (optional) is the walk alternate.
   */
  facings: {
    down: readonly (readonly string[])[];
    up: readonly (readonly string[])[];
    right: readonly (readonly string[])[];
  };
}

export interface ActorDecl {
  id: string;
  sprite: SpriteDecl;
  at: readonly [number, number];
  facing?: DirName;
  move?: MoveName;
  /** Solid defaults to true (actors block the player). */
  solid?: boolean;
  talk?: ScriptRef;
  /** Start hidden (reveal with s.show). */
  hidden?: boolean;
}

export interface WarpDecl {
  at: readonly [number, number];
  to: string; // "map:entrance"
}

export interface TriggerDecl {
  at: readonly [number, number];
  run: ScriptRef;
  /** Run once: the runtime arms an auto-allocated flag afterwards. */
  once?: boolean;
}

export interface EntranceDecl {
  at: readonly [number, number];
  dir?: DirName;
}

export interface MapDecl {
  name: string;
  tileset: TilesetDecl;
  /** Rows of legend characters; uniform width; blank lines ignored. */
  layout: string;
  /** char -> tile name in the tileset. " " is always the blank tile. */
  legend: Record<string, string>;
  entrances?: Record<string, EntranceDecl>;
  actors?: ActorDecl[];
  warps?: WarpDecl[];
  triggers?: TriggerDecl[];
  onEnter?: ScriptRef;
}

export interface GameDecl {
  /** Cartridge title (ASCII, <= 16 chars). */
  title: string;
  /** "map:entrance" the player spawns at. */
  start: string;
  player: SpriteDecl;
  maps: MapDecl[];
}

// ---------------------------------------------------------------------------
// Registry — module-level, shared between the executed game module and the
// compiler (both import this exact module instance).
// ---------------------------------------------------------------------------
export interface Registry {
  tilesets: TilesetDecl[];
  sprites: SpriteDecl[];
  scriptCount: number;
  game: GameDecl | null;
}

export const REGISTRY: Registry = { tilesets: [], sprites: [], scriptCount: 0, game: null };

/**
 * Reset per-compile state. Tilesets/sprites deliberately SURVIVE: asset
 * modules are cached by the JS runtime and only execute once, while the
 * (rewritten) game module re-executes per compile — so declarations register
 * idempotently by name and the game/script state resets every time.
 */
export function resetRegistry(): void {
  REGISTRY.scriptCount = 0;
  REGISTRY.game = null;
}

function upsert<T extends { name: string }>(list: T[], item: T): void {
  const at = list.findIndex((x) => x.name === item.name);
  if (at >= 0) list[at] = item;
  else list.push(item);
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------
export function defineTileset<Tiles extends Record<string, TileDecl>>(
  name: string,
  decl: { palette: readonly Rgb[]; tiles: Tiles },
): TilesetDecl<Tiles> {
  if (decl.palette.length > 16) throw new Error(`tileset ${name}: palette > 16 colors`);
  for (const [tn, t] of Object.entries(decl.tiles)) {
    if (t.px.length !== 8 || t.px.some((r) => r.length !== 8)) {
      throw new Error(`tileset ${name}: tile "${tn}" must be 8 rows x 8 hex nibbles`);
    }
  }
  const ts: TilesetDecl<Tiles> = { name, ...decl };
  upsert(REGISTRY.tilesets, ts);
  return ts;
}

export function defineSprite(name: string, decl: Omit<SpriteDecl, "name">): SpriteDecl {
  const sp: SpriteDecl = { name, ...decl };
  for (const key of ["down", "up", "right"] as const) {
    const frames = sp.facings[key];
    if (!frames || frames.length < 1 || frames.length > 2) {
      throw new Error(`sprite ${name}: facing "${key}" needs 1..2 frames`);
    }
    for (const f of frames) {
      if (f.length !== 16 || f.some((r) => r.length !== 16)) {
        throw new Error(`sprite ${name}: frames are 16 rows x 16 hex nibbles`);
      }
    }
  }
  if (sp.palette.length > 16) throw new Error(`sprite ${name}: palette > 16 colors`);
  upsert(REGISTRY.sprites, sp);
  return sp;
}

export function defineMap(name: string, decl: Omit<MapDecl, "name">): MapDecl {
  return { name, ...decl };
}

export function defineGame(decl: GameDecl): GameDecl {
  if (REGISTRY.game) throw new Error("defineGame called twice");
  if (!/^[\x20-\x7e]{1,16}$/.test(decl.title)) {
    throw new Error(`game title must be 1..16 ASCII chars (got ${JSON.stringify(decl.title)})`);
  }
  REGISTRY.game = decl;
  return decl;
}

export const npc = (id: string, decl: Omit<ActorDecl, "id">): ActorDecl => ({ id, ...decl });
export const warp = (decl: WarpDecl): WarpDecl => decl;
export const trigger = (decl: TriggerDecl): TriggerDecl => decl;

/**
 * Residual script. At compile time the argument is a generator function; the
 * compiler rewrites the call to `script(<id>)` before the module executes,
 * so at build-run time we only see numbers and hand out stable refs.
 */
export function script(body: ScriptBody | number): ScriptRef {
  if (typeof body !== "number") {
    throw new Error(
      "script(fn) reached the host un-rewritten — build games with the Pocket Static compiler (bun static/compiler/cli.ts)",
    );
  }
  if (body !== REGISTRY.scriptCount) {
    throw new Error(`script id ${body} registered out of order (expected ${REGISTRY.scriptCount})`);
  }
  REGISTRY.scriptCount++;
  return { __script: body };
}

// Residual op namespace values (never called; here so `s` has a runtime
// identity if anyone pokes it).
export const __residualOps: Ops = {
  say: () => residual("s.say"),
  choose: () => residual("s.choose"),
  rnd: () => residual("s.rnd"),
  wait: () => residual("s.wait"),
  lock: () => residual("s.lock"),
  release: () => residual("s.release"),
  face: () => residual("s.face"),
  show: () => residual("s.show"),
  hide: () => residual("s.hide"),
  warp: () => residual("s.warp"),
  sfx: () => residual("s.sfx"),
  call: () => residual("s.call"),
} as unknown as Ops;
