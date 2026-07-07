// saga/dsl/index.ts — the @pocketjs/saga authoring surface.
//
// Two zones, same discipline as @pocketjs/aot:
//  - the DECLARATION zone (defineFilm/defineScene/image/gradient/sprite) is
//    executed at build time and fills a registry;
//  - the RESIDUAL zone (`play: cue(function* () { ... })`) is never executed —
//    the compiler lowers the generator's AST to cue bytecode. The op functions
//    exported here are compile-time vocabulary; calling them outside a cue()
//    body is an authoring error.

export type Ease = "linear" | "in" | "out" | "inout";
export type CaptionStyle = "chip" | "sub" | "card";
export type Dir = "down" | "up" | "left" | "right";

export interface GradientDecl {
  kind: "gradient";
  stops: string[];
}
export interface LayerDecl {
  kind: "image";
  png: string;
  scroll?: number; // parallax factor vs camera (default: far .4, sky .15)
  vx?: number; // autoscroll px/frame (fractions fine)
  wide?: boolean; // main only: image wider than 240 -> 64x32 map
  y?: number; // vertical placement offset in px (multiple of 8)
}
export interface ActorDecl {
  png: string;
  w: number;
  h: number;
  frames?: number; // horizontal strip
  fps?: number; // anim frame period (frames per cell)
  at?: [number, number];
  show?: boolean;
  flip?: boolean;
  ghost?: boolean; // OBJ semi-transparency
  behind?: boolean; // prio 3, behind the main stage
  screen?: boolean; // screen-space (HUD-like)
  /** walker sheet: frames-per-direction. The strip holds 3*walkFpd frames in
   * row order DOWN, UP, SIDE (right = SIDE hflipped); frame 0 of a row stands. */
  walkFpd?: number;
}

// --- world (top-down grid) declarations ----------------------------------------
// `at` accepts a letter naming cells in the grid, or explicit cells.
export type CellRef = string | [number, number];
export type RectRef = string | [number, number, number, number]; // cx,cy,w,h

export interface WorldPlayerDecl {
  actor: string;
  at: CellRef;
  dir?: Dir;
}
export interface NpcDecl {
  actor: string;
  at: CellRef;
  dir?: Dir;
  talk?: CueRef; // run on A-interact
  solid?: boolean; // default true
}
export interface ExitDecl {
  at: RectRef;
  value: number; // pushed as the result of `yield world()`
}
export interface SpotDecl {
  at: RectRef;
  run: CueRef;
}
export interface WorldDecl {
  /** one string per cell row: '#' solid, '.'/' ' walkable, letters name cells
   * (walkable). Must match the main image: ceil(w/16) x ceil(h/16). */
  grid: string[];
  player: WorldPlayerDecl;
  npcs?: Record<string, NpcDecl>;
  exits?: Record<string, ExitDecl>; // step onto -> world() returns value
  spots?: Record<string, SpotDecl>; // face + A -> run cue (examine)
  autos?: Record<string, SpotDecl>; // step onto (once) -> run cue
}

export interface SceneDecl {
  id: string;
  sky?: GradientDecl | LayerDecl;
  far?: LayerDecl;
  main?: LayerDecl;
  backdrop?: string; // hex color when no gradient (default #000000)
  camera?: { start?: number; min?: number; max?: number };
  letterbox?: number; // initial bar height px
  wave?: { layer: "main" | "far"; amp: number }; // raster sine on from scene start
  actors?: Record<string, ActorDecl>;
  /** presence makes this a WORLD scene: BG1 becomes a 64x64 walkable map
   * (no far/sky layers), and `yield world()` hands input to the player. */
  world?: WorldDecl;
  play: CueRef;
}

export interface FilmDecl {
  title: string;
  scenes: SceneDecl[];
}

export interface CueRef {
  __cue: number;
}

export interface Registry {
  film: FilmDecl | null;
  scenes: SceneDecl[];
}

const REGISTRY: Registry = { film: null, scenes: [] };

export function __getRegistry(): Registry {
  return REGISTRY;
}
export function __resetRegistry(): void {
  REGISTRY.film = null;
  REGISTRY.scenes = [];
}

// --- declaration zone ---------------------------------------------------------

export function defineScene(decl: SceneDecl): SceneDecl {
  REGISTRY.scenes.push(decl);
  return decl;
}

export function defineFilm(decl: FilmDecl): FilmDecl {
  if (REGISTRY.film) throw new Error("defineFilm() called twice");
  REGISTRY.film = decl;
  return decl;
}

export function image(png: string, opts: Omit<LayerDecl, "kind" | "png"> = {}): LayerDecl {
  return { kind: "image", png, ...opts };
}

export function gradient(...stops: string[]): GradientDecl {
  if (stops.length < 2) throw new Error("gradient() needs at least 2 stops");
  return { kind: "gradient", stops };
}

export function sprite(png: string, opts: Omit<ActorDecl, "png">): ActorDecl {
  return { png, ...opts };
}

/** Residual generator marker. The compiler replaces the argument with an id. */
export function cue(fn: number | (() => Generator<unknown, unknown, unknown>)): CueRef {
  if (typeof fn === "number") return { __cue: fn };
  throw new Error("cue() bodies are residual-only; compile with saga/compiler");
}

// --- residual zone vocabulary ---------------------------------------------------
// Every function below may ONLY appear inside cue(function* () { ... }) as
// `yield op(...)` (or in if/while conditions where noted). Bodies never run.

const residual = (name: string) => (): never => {
  throw new Error(`${name}() is residual-only — use it inside cue(function* () {...})`);
};

type R = unknown;

// blocking
export const fadeIn = residual("fadeIn") as (frames?: number, color?: "black" | "white") => R;
export const fadeOut = residual("fadeOut") as (frames?: number, color?: "black" | "white") => R;
export const wait = residual("wait") as (frames: number) => R;
export const waitA = residual("waitA") as () => R;
export const waitTweens = residual("waitTweens") as () => R;
export const caption = residual("caption") as (style: CaptionStyle, text: string) => R;
export const dialog = residual("dialog") as (speaker: string, text: string) => R;
export const choice = residual("choice") as (options: string[]) => number;
export const walkTo = residual("walkTo") as (actor: string, x: number, frames: number) => R;
export const control = residual("control") as (actor: string, exitX: number, speed?: number) => R;
export const mash = residual("mash") as (varName: string, target: number) => R;

// non-blocking
export const captionClear = residual("captionClear") as (style?: CaptionStyle | "all") => R;
export const pan = residual("pan") as (x: number, frames: number, ease?: Ease) => R;
export const panY = residual("panY") as (y: number, frames: number, ease?: Ease) => R;
export const alpha = residual("alpha") as (eva: number, evb: number, frames: number) => R;
export const mosaicTo = residual("mosaicTo") as (level: number, frames: number) => R;
export const shake = residual("shake") as (amp: number, frames: number) => R;
export const autoScroll = residual("autoScroll") as (layer: "far" | "sky", vx: number, frames?: number) => R;
export const zoom = residual("zoom") as (scale: number, frames: number, ease?: Ease) => R;
export const spinTo = residual("spinTo") as (angle: number, frames: number, ease?: Ease) => R;
export const letterbox = residual("letterbox") as (px: number, frames?: number) => R;
export const rasterWave = residual("rasterWave") as (layer: "main" | "far", amp: number) => R;
export const rasterGradient = residual("rasterGradient") as () => R;
export const rasterOff = residual("rasterOff") as () => R;
export const show = residual("show") as (
  actor: string,
  x?: number,
  y?: number,
  opts?: { flip?: boolean },
) => R;
export const hide = residual("hide") as (actor: string) => R;
export const animate = residual("animate") as (actor: string, mode: "loop" | number, fps?: number) => R;
export const moveTo = residual("moveTo") as (actor: string, x: number, y: number, frames: number, ease?: Ease) => R;
export const affineOn = residual("affineOn") as (actor: string) => R;
export const affineOff = residual("affineOff") as (actor: string) => R;
export const counter = residual("counter") as (varName: string, x: number, y: number) => R;
export const counterHide = residual("counterHide") as () => R;
export const sfx = residual("sfx") as (id: "blip" | "confirm" | "whoosh" | "star") => R;
export const gotoScene = residual("gotoScene") as (sceneId: string) => R;

// world + encounters + minigames
export const world = residual("world") as () => number; // blocks; returns exit value
export const breakout = residual("breakout") as (rows: number, lives: number, frames?: number) => number;
export const meterShow = residual("meterShow") as (id: 0 | 1, varName: string, x: number, y: number, max: number) => R;
export const meterHide = residual("meterHide") as (id: 0 | 1) => R;
export const warp = residual("warp") as (cx: number, cy: number, dir?: Dir) => R;
export const face = residual("face") as (actor: string, dir: Dir) => R;
export const walk = residual("walk") as (actor: string, cx: number, cy: number) => R;

// state (usable in conditions)
export const setFlag = residual("setFlag") as (name: string) => R;
export const clrFlag = residual("clrFlag") as (name: string) => R;
export const hasFlag = residual("hasFlag") as (name: string) => number;
export const setVar = residual("setVar") as (name: string, v: number) => R;
export const addVar = residual("addVar") as (name: string, d: number) => R;
export const varEq = residual("varEq") as (name: string, v: number) => number;
export const varNe = residual("varNe") as (name: string, v: number) => number;
export const varLt = residual("varLt") as (name: string, v: number) => number;
export const varGt = residual("varGt") as (name: string, v: number) => number;
export const varLe = residual("varLe") as (name: string, v: number) => number;
export const varGe = residual("varGe") as (name: string, v: number) => number;
export const rnd = residual("rnd") as (n: number) => number;
