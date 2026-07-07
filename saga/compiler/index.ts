// saga/compiler/index.ts — compileFilm(entry): evaluate the declaration zone,
// bake assets, residualize cues, and assemble the CompiledFilm model that
// emit.ts turns into gen_data.c.

import { dirname, resolve } from "node:path";
import { evaluateFilm } from "./evaluate.ts";
import { residualizeCue, type CueCtx } from "./residualize.ts";
import { TextBank } from "./text.ts";
import {
  loadPng, quantize, tileLayer, buildMap, tileObjSheet, gradientTable,
  uiPalette, uiBgTiles, uiObjTiles, type Quantized,
} from "./assets.ts";
import {
  FARSKY_BASE, FARSKY_MAX, MAIN_TILE_MAX, GLYPH_SLOTS,
  PALBANK_SKY, PALBANK_FAR, PALBANK_MAIN, PALBANK_UI, PALBANK_OBJ_UI,
  MAX_SPRITES, MAX_SCENES, hex555, UI_INK, UI_BOX,
  SCENE_CINE, SCENE_WORLD, CELL_PX, WORLD_COLS_MAX, WORLD_ROWS_MAX,
  MAX_NPCS, MAX_TRIGS, MAX_CUES, TRIG_EXIT, TRIG_EXAMINE, TRIG_AUTO,
  DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT,
} from "../spec/saga.ts";
import type { ActorDecl, CellRef, CueRef, LayerDecl, RectRef, SceneDecl, WorldDecl } from "../dsl/index.ts";

export interface CompiledProto {
  tileBase: number;
  w: number;
  h: number;
  frames: number;
  palbank: number;
  fps: number;
  walkFpd: number;
}

export interface CompiledNpc {
  cx: number;
  cy: number;
  dir: number;
  slot: number;
  proto: number;
  cue: number; // 0xff none
  solid: number;
}

export interface CompiledTrig {
  cx: number;
  cy: number;
  w: number;
  h: number;
  kind: number;
  value: number;
  cue: number; // 0xff none
}

export interface CompiledWorld {
  cols: number;
  rows: number;
  solid: Uint8Array;
  startCx: number;
  startCy: number;
  startDir: number;
  playerSlot: number;
  playerProto: number;
  npcs: CompiledNpc[];
  trigs: CompiledTrig[];
}

export interface CompiledScene {
  id: string;
  palBg: Uint16Array; // 256
  palObj: Uint16Array; // 256
  tilesMain: Uint8Array;
  nMain: number;
  tilesShared: Uint8Array;
  nShared: number;
  mapMain: Uint16Array;
  mapFar: Uint16Array | null;
  mapSky: Uint16Array | null;
  mapSz: 0 | 1 | 2;
  kind: number;
  world: CompiledWorld | null;
  cueOffs: number[];
  farFacQ8: number;
  skyFacQ8: number;
  farVxQ8: number;
  skyVxQ8: number;
  gradient: Uint16Array | null;
  objTiles: Uint8Array;
  protos: CompiledProto[];
  cue: Uint8Array;
  cam0: number;
  camMin: number;
  camMax: number;
  rasterMode: number;
  rasterAmp: number;
  letterbox0: number;
  backdrop: number;
}

export interface CompiledFilm {
  title: string;
  scenes: CompiledScene[];
  textOffs: number[];
  textBlob: Uint8Array;
  glyphs: Uint8Array;
  nHalfcells: number;
  uiBg: Uint8Array;
  uiObj: Uint8Array;
  debug: {
    sceneIds: Record<string, number>;
    texts: string[];
    vars: Record<string, number>;
    flags: Record<string, number>;
  };
}

const RASTER_OFF = 0, RASTER_GRADIENT = 1, RASTER_WAVE_MAIN = 2, RASTER_WAVE_FAR = 3;

export async function compileFilm(entryPath: string): Promise<CompiledFilm> {
  const entry = resolve(entryPath);
  const base = dirname(entry);
  const { registry, cues } = await evaluateFilm(entry);
  const film = registry.film!;
  if (film.scenes.length === 0) throw new Error("film has no scenes");
  if (film.scenes.length > MAX_SCENES) throw new Error(`too many scenes (max ${MAX_SCENES})`);

  const sceneIndex = new Map<string, number>();
  film.scenes.forEach((s, i) => {
    if (sceneIndex.has(s.id)) throw new Error(`duplicate scene id ${s.id}`);
    sceneIndex.set(s.id, i);
  });

  const texts = new TextBank();
  const vars = new Map<string, number>();
  const flags = new Map<string, number>();

  const scenes: CompiledScene[] = [];
  for (const decl of film.scenes) {
    scenes.push(await compileScene(decl, base, { texts, vars, flags, sceneIndex, cues }));
  }

  const { offs, blob } = texts.buildBlob();
  const glyphs = texts.bakeGlyphStore(UI_INK, UI_BOX);

  return {
    title: film.title,
    scenes,
    textOffs: offs,
    textBlob: blob,
    glyphs,
    nHalfcells: glyphs.length / 64,
    uiBg: uiBgTiles(),
    uiObj: uiObjTiles(),
    debug: {
      sceneIds: Object.fromEntries(sceneIndex),
      texts: texts.entries.map((e) => e.raw),
      vars: Object.fromEntries(vars),
      flags: Object.fromEntries(flags),
    },
  };
}

interface SceneEnv {
  texts: TextBank;
  vars: Map<string, number>;
  flags: Map<string, number>;
  sceneIndex: Map<string, number>;
  cues: import("./evaluate.ts").CueSite[];
}

async function loadLayer(base: string, layer: LayerDecl): Promise<Quantized> {
  const img = await loadPng(resolve(base, layer.png));
  return quantize(img, 15);
}

const DIR_NUM: Record<string, number> = { down: DIR_DOWN, up: DIR_UP, left: DIR_LEFT, right: DIR_RIGHT };

function compileWorld(
  sceneId: string,
  wd: WorldDecl,
  imgW: number,
  imgH: number,
  actors: CueCtx["actors"],
  protos: CompiledProto[],
  addCue: (name: string, ref: CueRef | undefined) => number,
): CompiledWorld {
  const err = (msg: string): never => {
    throw new Error(`[${sceneId}] world: ${msg}`);
  };
  const rows = wd.grid.length;
  const cols = Math.max(...wd.grid.map((r) => r.length));
  const expCols = Math.ceil(imgW / CELL_PX);
  const expRows = Math.ceil(imgH / CELL_PX);
  if (cols !== expCols || rows !== expRows)
    err(`grid is ${cols}x${rows} cells but the main image is ${expCols}x${expRows} (${imgW}x${imgH}px)`);
  if (cols > WORLD_COLS_MAX || rows > WORLD_ROWS_MAX) err(`grid too large (max ${WORLD_COLS_MAX}x${WORLD_ROWS_MAX})`);

  const solid = new Uint8Array(cols * rows);
  const named = new Map<string, [number, number][]>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = wd.grid[r][c] ?? "#";
      if (ch === "#") solid[r * cols + c] = 1;
      else if (ch !== "." && ch !== " ") {
        if (!named.has(ch)) named.set(ch, []);
        named.get(ch)!.push([c, r]);
      }
    }
  }
  const cellOf = (at: CellRef, what: string): [number, number] => {
    if (typeof at !== "string") return at;
    const cells = named.get(at);
    if (!cells) return err(`${what}: no cell '${at}' in grid`);
    return cells[0];
  };
  const rectOf = (at: RectRef, what: string): [number, number, number, number] => {
    if (typeof at !== "string") return at;
    const cells = named.get(at);
    if (!cells) return err(`${what}: no cell '${at}' in grid`);
    const xs = cells.map((c) => c[0]);
    const ys = cells.map((c) => c[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    return [x0, y0, Math.max(...xs) - x0 + 1, Math.max(...ys) - y0 + 1];
  };
  const actorOf = (name: string, what: string) => {
    const a = actors.get(name);
    if (!a) return err(`${what}: unknown actor "${name}"`);
    return a;
  };

  const pa = actorOf(wd.player.actor, "player");
  if (!protos[pa.proto].walkFpd) err(`player actor "${wd.player.actor}" needs walkFpd`);
  const [scx, scy] = cellOf(wd.player.at, "player.at");

  const npcs: CompiledNpc[] = [];
  for (const [name, n] of Object.entries(wd.npcs ?? {})) {
    if (npcs.length >= MAX_NPCS) err(`too many npcs (max ${MAX_NPCS})`);
    const a = actorOf(n.actor, `npc ${name}`);
    const [cx, cy] = cellOf(n.at, `npc ${name}.at`);
    npcs.push({
      cx,
      cy,
      dir: DIR_NUM[n.dir ?? "down"],
      slot: a.slot,
      proto: a.proto,
      cue: addCue(`${sceneId}.${name}`, n.talk),
      solid: n.solid === false ? 0 : 1,
    });
  }

  const trigs: CompiledTrig[] = [];
  const addTrig = (kind: number, name: string, at: RectRef, value: number, ref?: CueRef): void => {
    if (trigs.length >= MAX_TRIGS) err(`too many triggers (max ${MAX_TRIGS})`);
    const [cx, cy, w, h] = rectOf(at, name);
    trigs.push({ cx, cy, w, h, kind, value, cue: addCue(`${sceneId}.${name}`, ref) });
  };
  for (const [name, e] of Object.entries(wd.exits ?? {})) addTrig(TRIG_EXIT, name, e.at, e.value);
  for (const [name, s] of Object.entries(wd.spots ?? {})) addTrig(TRIG_EXAMINE, name, s.at, 0, s.run);
  for (const [name, s] of Object.entries(wd.autos ?? {})) addTrig(TRIG_AUTO, name, s.at, 0, s.run);

  return {
    cols,
    rows,
    solid,
    startCx: scx,
    startCy: scy,
    startDir: DIR_NUM[wd.player.dir ?? "down"],
    playerSlot: pa.slot,
    playerProto: pa.proto,
    npcs,
    trigs,
  };
}

async function compileScene(decl: SceneDecl, base: string, env: SceneEnv): Promise<CompiledScene> {
  const palBg = new Uint16Array(256);
  const palObj = new Uint16Array(256);

  // UI palettes (BG bank 15 + OBJ bank 15)
  uiPalette().forEach((c, i) => {
    palBg[PALBANK_UI * 16 + i] = c;
    palObj[PALBANK_OBJ_UI * 16 + i] = c;
  });

  const backdrop = hex555(decl.backdrop ?? "#000000");
  palBg[0] = backdrop;

  // --- main layer -> charblock 0 ------------------------------------------------
  const isWorld = !!decl.world;
  let tilesMain = new Uint8Array(32); // tile 0 blank
  let nMain = 1;
  let mapMain = new Uint16Array(1024);
  let mapSz: 0 | 1 | 2 = 0;
  let imgW = 240;
  let imgH = 160;
  if (isWorld && !decl.main) throw new Error(`[${decl.id}] world scenes need a main image`);
  if (decl.main) {
    const q = await loadLayer(base, decl.main);
    imgW = q.w;
    imgH = q.h;
    mapSz = isWorld ? 2 : q.w > 240 ? 1 : 0;
    if (q.w > 512) throw new Error(`[${decl.id}] main image too wide (max 512): ${q.w}`);
    if (q.h > (mapSz === 2 ? 512 : 256)) throw new Error(`[${decl.id}] main image too tall: ${q.h}`);
    const tl = tileLayer(q);
    if (1 + tl.tiles.length > MAIN_TILE_MAX) throw new Error(`[${decl.id}] main tiles ${tl.tiles.length} > budget`);
    tilesMain = new Uint8Array((1 + tl.tiles.length) * 32);
    tl.tiles.forEach((t, i) => tilesMain.set(t, (1 + i) * 32));
    nMain = 1 + tl.tiles.length;
    mapMain = buildMap(tl, mapSz, 1, PALBANK_MAIN);
    q.pal555.forEach((c, i) => {
      if (i > 0) palBg[PALBANK_MAIN * 16 + i] = c;
    });
  }
  if (isWorld && (decl.far || decl.sky?.kind === "image"))
    throw new Error(`[${decl.id}] world scenes cannot have far/sky layers (their screenblocks hold the map)`);

  // --- far + sky -> shared charblock -----------------------------------------------
  const sharedTiles: Uint8Array[] = [];
  let mapFar: Uint16Array | null = null;
  let mapSky: Uint16Array | null = null;
  let gradient: Uint16Array | null = null;
  let farFacQ8 = Math.round((decl.far?.scroll ?? 0.4) * 256);
  let skyFacQ8 = 0;
  const farVxQ8 = Math.round((decl.far?.vx ?? 0) * 256);
  let skyVxQ8 = 0;

  if (decl.far) {
    const q = await loadLayer(base, decl.far);
    const tl = tileLayer(q);
    const tileBase = FARSKY_BASE + sharedTiles.length;
    sharedTiles.push(...tl.tiles);
    mapFar = buildMap(tl, 0, tileBase, PALBANK_FAR, (decl.far.y ?? 0) >> 3);
    q.pal555.forEach((c, i) => {
      if (i > 0) palBg[PALBANK_FAR * 16 + i] = c;
    });
  }
  if (decl.sky) {
    if (decl.sky.kind === "gradient") {
      gradient = gradientTable(decl.sky.stops);
    } else {
      const q = await loadPng(resolve(base, decl.sky.png)).then((img) => quantize(img, 15));
      const tl = tileLayer(q);
      const tileBase = FARSKY_BASE + sharedTiles.length;
      sharedTiles.push(...tl.tiles);
      mapSky = buildMap(tl, 0, tileBase, PALBANK_SKY, (decl.sky.y ?? 0) >> 3);
      q.pal555.forEach((c, i) => {
        if (i > 0) palBg[PALBANK_SKY * 16 + i] = c;
      });
      skyFacQ8 = Math.round((decl.sky.scroll ?? 0.15) * 256);
      skyVxQ8 = Math.round((decl.sky.vx ?? 0) * 256);
    }
  }
  if (sharedTiles.length > FARSKY_MAX) throw new Error(`[${decl.id}] far+sky tiles ${sharedTiles.length} > ${FARSKY_MAX}`);
  const tilesShared = new Uint8Array(sharedTiles.length * 32);
  sharedTiles.forEach((t, i) => tilesShared.set(t, i * 32));

  // --- actors -> protos + OBJ sheet ----------------------------------------------------
  const actorEntries = Object.entries(decl.actors ?? {});
  if (actorEntries.length > MAX_SPRITES) throw new Error(`[${decl.id}] too many actors (max ${MAX_SPRITES})`);
  const protos: CompiledProto[] = [];
  const protoByPng = new Map<string, number>();
  const objParts: Uint8Array[] = [];
  let objTileCursor = 0;
  const actors: CueCtx["actors"] = new Map();
  let nextObjBank = 0;

  for (const [name, a] of actorEntries) {
    const key = `${a.png}|${a.w}x${a.h}x${a.frames ?? 1}`;
    let protoIdx = protoByPng.get(key);
    if (protoIdx === undefined) {
      const img = await loadPng(resolve(base, a.png));
      const frames = a.frames ?? 1;
      if (img.width < a.w * frames || img.height < a.h) {
        throw new Error(`[${decl.id}] sprite ${a.png}: ${img.width}x${img.height} < ${a.w * frames}x${a.h}`);
      }
      const q = quantize(img, 15);
      if (nextObjBank >= PALBANK_OBJ_UI) throw new Error(`[${decl.id}] too many OBJ palettes`);
      const bank = nextObjBank++;
      q.pal555.forEach((c, i) => {
        if (i > 0) palObj[bank * 16 + i] = c;
      });
      const sheet = tileObjSheet(q, a.w, a.h, frames);
      if (a.walkFpd && frames < 3 * a.walkFpd) {
        throw new Error(
          `[${decl.id}] walker ${a.png}: needs ${3 * a.walkFpd} frames (3 rows x walkFpd), has ${frames}`,
        );
      }
      protoIdx = protos.length;
      protos.push({
        tileBase: objTileCursor,
        w: a.w,
        h: a.h,
        frames,
        palbank: bank,
        fps: a.fps ?? 10,
        walkFpd: a.walkFpd ?? 0,
      });
      objTileCursor += sheet.length / 32;
      objParts.push(sheet);
      protoByPng.set(key, protoIdx);
    }
    actors.set(name, { slot: actors.size, proto: protoIdx, decl: a });
  }
  if (objTileCursor > 1000) throw new Error(`[${decl.id}] OBJ tiles ${objTileCursor} > 1000 budget`);
  const objTiles = new Uint8Array(objParts.reduce((n, p) => n + p.length, 0));
  {
    let o = 0;
    for (const p of objParts) {
      objTiles.set(p, o);
      o += p.length;
    }
  }

  // --- world (top-down grid) --------------------------------------------------------
  // The cue table: cue 0 = play; NPC talk / spot / auto cues follow.
  const cueRefs: { name: string; ref: CueRef }[] = [];
  const addCue = (name: string, ref: CueRef | undefined): number => {
    if (!ref) return 0xff;
    if (typeof (ref as { __cue?: number }).__cue !== "number")
      throw new Error(`[${decl.id}] ${name}: expected cue(function* () { ... })`);
    if (cueRefs.length >= MAX_CUES) throw new Error(`[${decl.id}] too many cues (max ${MAX_CUES})`);
    cueRefs.push({ name, ref });
    return cueRefs.length - 1;
  };
  if (!decl.play || typeof (decl.play as { __cue?: number }).__cue !== "number") {
    throw new Error(`[${decl.id}] scene has no play: cue(...)`);
  }
  addCue(decl.id, decl.play);

  let world: CompiledWorld | null = null;
  if (decl.world) {
    world = compileWorld(decl.id, decl.world, imgW, imgH, actors, protos, addCue);
  }

  const cueOffs: number[] = [];
  const cueParts: Uint8Array[] = [];
  let cueLen = 0;
  for (const { name, ref } of cueRefs) {
    const site = env.cues.find((c) => c.id === (ref as { __cue: number }).__cue);
    if (!site) throw new Error(`[${decl.id}] cue site not found for ${name}`);
    const bytes = residualizeCue(
      site.body,
      {
        texts: env.texts,
        vars: env.vars,
        flags: env.flags,
        sceneIndex: env.sceneIndex,
        actors,
        cueName: name,
      },
      cueLen, // jump targets are blob-absolute
    );
    cueOffs.push(cueLen);
    cueParts.push(bytes);
    cueLen += bytes.length;
  }
  const cue = new Uint8Array(cueLen);
  {
    let o = 0;
    for (const p of cueParts) {
      cue.set(p, o);
      o += p.length;
    }
  }

  // --- camera + raster defaults ----------------------------------------------------------
  const camMin = decl.camera?.min ?? 0;
  const camMax = decl.camera?.max ?? Math.max(0, imgW - 240);
  const cam0 = decl.camera?.start ?? camMin;
  let rasterMode = RASTER_OFF;
  let rasterAmp = 0;
  if (gradient) rasterMode = RASTER_GRADIENT;
  if (decl.wave) {
    rasterMode = decl.wave.layer === "far" ? RASTER_WAVE_FAR : RASTER_WAVE_MAIN;
    rasterAmp = decl.wave.amp;
  }

  return {
    id: decl.id,
    palBg,
    palObj,
    tilesMain,
    nMain,
    tilesShared,
    nShared: sharedTiles.length,
    mapMain,
    mapFar,
    mapSky,
    mapSz,
    kind: isWorld ? SCENE_WORLD : SCENE_CINE,
    world,
    cueOffs,
    farFacQ8,
    skyFacQ8,
    farVxQ8,
    skyVxQ8,
    gradient,
    objTiles,
    protos,
    cue,
    cam0,
    camMin,
    camMax,
    rasterMode,
    rasterAmp,
    letterbox0: decl.letterbox ?? 0,
    backdrop,
  };
}
