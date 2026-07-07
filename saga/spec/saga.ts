// saga/spec/saga.ts — single source of truth for the @pocketjs/saga binary
// contract: cue bytecode, tween targets, VRAM/palette plan, debug block.
//
// @pocketjs/saga is the generalized descendant of @pocketjs/cine: a GBA-only
// interactive-biography DSL. It keeps cine's whole cinematic vocabulary
// (4-layer Mode-0 parallax, BLDCNT fades, HBlank raster FX, letterbox, affine,
// typewriter captions) and adds two playable modes: top-down WORLD scenes
// (Pokémon-style grid walking, NPCs, triggers) and set-piece minigames
// (Breakout) plus encounter UI (meters) — all driven by the same cue VM.
//
// Mirrored into C by spec/gen-c.ts -> runtime/saga_gen.h.

// --- screen / layer plan ------------------------------------------------------
export const SCREEN_W = 240;
export const SCREEN_H = 160;
export const CELLS_W = 30;
export const CELLS_H = 20;

// Mode 0. Fixed semantic layers:
//   BG0 = ui (captions/dialog/choice), prio 0, charbase 2, screenblock 28
//   BG1 = main stage, prio 2, charbase 0 (may spill into charblock 1; <=1024 tiles)
//   BG2 = far parallax, prio 3, charbase 2, screenblock 26
//   BG3 = sky, prio 3 (drawn under far via BG order), charbase 2, screenblock 27
export const CBB_MAIN = 0;
export const CBB_SHARED = 2; // ui + far + sky share charblock 2 (512 tiles)
export const SBB_MAIN = 24; // +25 when wide (64x32 map)
export const SBB_FAR = 26;
export const SBB_SKY = 27;
export const SBB_UI = 28;

// Shared charblock 2 allocation (tile indices relative to charbase 2):
export const T_BLANK = 0;
export const T_BOX = 1; // caption/dialog box fill
export const T_BOX_ACCENT = 2; // vue-green underline tile
export const T_CURSOR = 3; // choice cursor (8x8 arrow)
export const FARSKY_BASE = 4; // far+sky art tiles, up to GLYPH_SLOT area
export const GLYPH_SLOT_BASE = 320; // 96 halfcell slots x 2 stacked tiles = 192
export const GLYPH_SLOTS = 96;
export const FARSKY_MAX = GLYPH_SLOT_BASE - FARSKY_BASE; // 316 tiles

export const MAIN_TILE_MAX = 1024; // charblocks 0+1

// BG palette banks:
export const PALBANK_SKY = 1;
export const PALBANK_FAR = 2;
export const PALBANK_MAIN = 3;
export const PALBANK_UI = 15; // 0 transparent, 1 ink, 2 box, 3 accent, 4 shadow
export const UI_INK = 1;
export const UI_BOX = 2;
export const UI_ACCENT = 3;
export const UI_SHADOW = 4;

// OBJ: charblock 4-5 (1024 4bpp tiles), 1D mapping. Last palbank = built-in UI
// sheet (A-prompt 16x16 + digits 0-9 8x16 + meter segs + breakout court pieces)
// appended by the compiler at OBJ_UI_BASE. Scene sheets must stay below it.
export const OBJ_TILE_MAX = 1024;
export const OBJ_UI_BASE = 960; // 64 UI tiles: prompt 0-3, digits 4-23, meter 24-25, brick 26-27, ball 28, paddle 29-32
export const PALBANK_OBJ_UI = 15;

// OAM slot plan: 0..15 scene sprites, 16..21 counter digits, 24 A-prompt,
// 26..41 meter segments (2 meters x 8), 48..119 breakout bricks, 120 ball,
// 121 paddle.
export const MAX_SPRITES = 16;
export const OAM_COUNTER = 16;
export const COUNTER_DIGITS = 6;
export const OAM_PROMPT = 24;
export const OAM_METER = 26;
export const METER_SEGS = 8; // 8 segments x 8px = 64px bar
export const OAM_BRICK = 48;
export const BRICK_COLS = 12;
export const BRICK_ROWS_MAX = 6;
export const OAM_BALL = 120;
export const OAM_PADDLE = 121;

export const MAX_SCENES = 20;
export const MAX_PROTOS = 12;
export const MAX_TWEENS = 16;
export const N_VARS = 24; // named game vars + per-cue locals share this pool
export const N_FLAGS = 16;
export const MAX_CHOICES = 5;

// --- world (top-down grid) scenes ----------------------------------------------
// kind: what a scene IS. CINE keeps all four parallax layers; WORLD repurposes
// BG1 as a 64x64 tilemap (screenblocks 24-27, so no far/sky layers) and gives
// the player a grid walker. Encounters are CINE scenes using meters/choices.
export const SCENE_CINE = 0;
export const SCENE_WORLD = 1;

export const CELL_PX = 16; // one walk cell = 2x2 hardware tiles
export const WORLD_COLS_MAX = 25; // 400px / 16 (pixflux max canvas)
export const WORLD_ROWS_MAX = 25;
export const MAX_NPCS = 8;
export const MAX_TRIGS = 12;
export const MAX_CUES = 24; // per scene: play + npc/trigger cues

export const DIR_DOWN = 0;
export const DIR_UP = 1;
export const DIR_LEFT = 2;
export const DIR_RIGHT = 3;

// trigger kinds
export const TRIG_EXIT = 0; // step onto -> OP_WORLD returns, pushes value
export const TRIG_EXAMINE = 1; // face + A -> run cue, then resume roaming
export const TRIG_AUTO = 2; // step onto -> run cue once (sets its seen-flag)

// walker proto sheet layout: rows DOWN, UP, SIDE (right = SIDE hflipped),
// walk_fpd frames per row; frame 0 of each row = standing.
export const WALK_ROW_DOWN = 0;
export const WALK_ROW_UP = 1;
export const WALK_ROW_SIDE = 2;
export const STEP_FRAMES = 8; // frames per 16px cell step (2px/frame)

// --- cue bytecode -------------------------------------------------------------
// One byte op + little-endian args. Blocking ops suspend the VM until done.
export const OP = {
  END: 0x00, // scene done -> next scene in film order (or film end)
  WAIT: 0x01, // u16 frames
  WAITA: 0x02, // blinking A prompt
  WAIT_TWEENS: 0x03,
  FADE: 0x04, // u8 mode (FADE_*), u16 frames — blocking BLDY fade
  CAPTION: 0x05, // u8 style, u16 text — blocking while typing, stays shown
  CAPTION_CLR: 0x06, // u8 style (0xff = all)
  DIALOG: 0x07, // u16 speaker_text, u16 body_text — type, waitA, clear
  CHOICE: 0x08, // u8 n, u16 ids[n] — pushes result
  TWEEN: 0x09, // u8 target, u8 ease, s16 to, u16 frames — non-blocking
  SPRITE_SHOW: 0x0a, // u8 slot, u8 proto, s16 x, s16 y, u8 flags
  SPRITE_HIDE: 0x0b, // u8 slot
  SPRITE_ANIM: 0x0c, // u8 slot, u8 mode (0 static,1 loop), u8 frame_or_fps
  SPRITE_MOVE: 0x0d, // u8 slot, u8 ease, s16 x, s16 y, u16 frames — non-blocking
  CONTROL: 0x0e, // u8 slot, s16 exit_x, u8 speed_q4 — blocking L/R walk
  MASH: 0x0f, // u8 var, u16 target — blocking, A presses increment var
  GOTO_SCENE: 0x10, // u8 scene
  RASTER: 0x11, // u8 mode (RASTER_*), u8 amp_or_table
  SFX: 0x12, // u8 id
  COUNTER: 0x13, // u8 var, u8 show, s16 x, s16 y — OBJ digit HUD bound to var
  AFFINE: 0x14, // u8 slot, u8 on — sprite uses affine matrix 0 (dbl-size)
  LETTERBOX: 0x15, // u8 px, u16 frames — tween letterbox bar height
  WORLD: 0x16, // (world scenes) blocking free roam; exit trigger pushes value
  BREAKOUT: 0x17, // u8 rows, u8 lives, u16 budget frames — blocking; pushes bricks cleared
  METER: 0x18, // u8 id, u8 var, s16 x, s16 y, u8 max, u8 show — HUD bar bound to var
  WARP: 0x19, // u8 cx, u8 cy, u8 dir — reposition player on the grid
  FACE: 0x1a, // u8 slot, u8 dir — set a walker sprite's facing row
  WALK: 0x1b, // u8 slot, u8 cx, u8 cy — blocking scripted grid walk (x then y)

  PUSH: 0x20, // s16
  SET_VAR: 0x21, // u8 (pop)
  GET_VAR: 0x22, // u8 (push)
  ADD_VAR: 0x23, // u8, s16 (var += imm)
  SET_FLAG: 0x24, // u8
  CLR_FLAG: 0x25, // u8
  GET_FLAG: 0x26, // u8 (push)
  CMP: 0x27, // u8 kind (pop b, a; push a?b)
  JZ: 0x28, // u16 (pop; jump if 0)
  JMP: 0x29, // u16
  RND: 0x2a, // u8 n (push 0..n-1)
  POP: 0x2b,
} as const;

export const CMP_EQ = 0, CMP_NE = 1, CMP_LT = 2, CMP_GT = 3, CMP_LE = 4, CMP_GE = 5;

export const FADE_IN_BLACK = 0;
export const FADE_OUT_BLACK = 1;
export const FADE_IN_WHITE = 2;
export const FADE_OUT_WHITE = 3;

export const RASTER_OFF = 0;
export const RASTER_GRADIENT = 1; // per-line backdrop color from scene table
export const RASTER_WAVE_MAIN = 2; // per-line BG1 HOFS sine (amp tweenable)
export const RASTER_WAVE_FAR = 3; // per-line BG2 HOFS sine

// caption styles
export const CAP_CHIP = 0; // top-left place/date chip (1 line)
export const CAP_SUB = 1; // bottom subtitle bar (<=2 lines)
export const CAP_CARD = 2; // centered title card (<=2 lines)
export const CAP_DIALOG = 3; // internal: dialog body (speaker chip + 2 lines)

// sprite flags (SPRITE_SHOW)
export const SPR_HFLIP = 1;
export const SPR_SCREEN = 2; // screen-space (ignores camera)
export const SPR_BEHIND = 4; // prio 3 (behind main stage)
export const SPR_GHOST = 8; // OBJ semi-transparency (memory figures)

// tween targets
export const TW = {
  CAM_X: 0,
  CAM_Y: 1,
  BLDY: 2, // 0..16
  EVA: 3, // 0..16 (BG1 1st-target alpha)
  EVB: 4,
  MOSAIC: 5, // 0..15
  WAVE_AMP: 6, // raster sine amplitude, px
  LETTERBOX: 7, // bar height px (0..32), windowed, raster-assisted
  SHAKE: 8, // screen shake amplitude px
  FAR_VX: 9, // far autoscroll, q8 px/frame
  SKY_VX: 10, // sky autoscroll, q8 px/frame
  OBJ_SCALE: 11, // affine matrix 0 scale, q8 (256 = 1.0)
  OBJ_ANGLE: 12, // affine matrix 0 angle, 0..255
} as const;
// sprite x/y tweens are encoded as 0x40 | slot<<1 | axis
export const TW_SPRITE_BASE = 0x40;

export const EASE_LINEAR = 0, EASE_IN = 1, EASE_OUT = 2, EASE_INOUT = 3;

export const SFX_BLIP = 0, SFX_CONFIRM = 1, SFX_WHOOSH = 2, SFX_STAR = 3;

// waiting states (debug block `waiting`)
export const WAITING = {
  RUN: 0,
  A: 1,
  DIALOG: 2,
  CHOICE: 3,
  CONTROL: 4,
  MASH: 5,
  FILM_DONE: 6,
  BUSY: 7, // wait/fade/typewriter/scripted-walk
  WORLD: 8, // free roam (OP_WORLD)
  MINIGAME: 9, // breakout in flight
} as const;

// --- text encoding (same scheme as aot cjk16) ---------------------------------
// 0x00 end, 0x0a newline, 0x20..0x7e ASCII (halfcell), 0x80|hi lo fullwidth
// glyph id. Glyph store = 95 baked ASCII halfcells + 2 halfcells per fullwidth
// glyph; each halfcell = two stacked 4bpp 8x8 tiles = 64 bytes, ink=UI_INK on 0.
export const TOK_END = 0x00;
export const TOK_NL = 0x0a;
export const ASCII_HALF = 95; // halfcells 0..94 = codepoints 0x20..0x7e
export const CAP_COLS = 26; // max text cells per caption line
export const CAP_LINES = 2;

// --- debug block (EWRAM 0x02000000) --------------------------------------------
export const DEBUG_ADDR = 0x02000000;
export const DBG_MAGIC = 0x41474153; // "SAGA"
export const DBG = {
  MAGIC: 0x00, // u32
  BOOTED: 0x04, // u8
  SCENE: 0x05, // u8
  WAITING: 0x06, // u8 (WAITING.*)
  LAST_CHOICE: 0x07, // s8 (-1 none)
  FRAME: 0x08, // u16 scene-local frame
  CUE_IP: 0x0a, // u16
  CAM_X: 0x0c, // s16
  CUR_TEXT: 0x0e, // u16 (last caption/dialog text id + 1; 0 = none)
  TWEEN_MASK: 0x10, // u16
  CAPTION_BUSY: 0x12, // u8
  FILM_DONE: 0x13, // u8
  VARS: 0x14, // s16[N_VARS]
  SPR0_X: 0x44, // s16 (sprite slot 0 world x — control assertions)
  SPR0_Y: 0x46, // s16
  PLAYER_CX: 0x48, // u8 world-grid cell
  PLAYER_CY: 0x49, // u8
  PLAYER_DIR: 0x4a, // u8 DIR_*
  BRICKS: 0x4b, // u8 breakout bricks remaining
  KIND: 0x4c, // u8 SCENE_* of current scene
} as const;

// --- ByteWriter ----------------------------------------------------------------
export class ByteWriter {
  private buf: number[] = [];
  get length(): number {
    return this.buf.length;
  }
  u8(v: number): this {
    this.buf.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    this.buf.push(v & 0xff, (v >> 8) & 0xff);
    return this;
  }
  i16(v: number): this {
    return this.u16(v & 0xffff);
  }
  u32(v: number): this {
    this.buf.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
    return this;
  }
  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.buf.push(b[i] & 0xff);
    return this;
  }
  patchU16(at: number, v: number): this {
    this.buf[at] = v & 0xff;
    this.buf[at + 1] = (v >> 8) & 0xff;
    return this;
  }
  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

export function rgb555(r: number, g: number, b: number): number {
  return ((r >> 3) & 31) | (((g >> 3) & 31) << 5) | (((b >> 3) & 31) << 10);
}

export function hex555(hex: string): number {
  const h = hex.replace("#", "");
  return rgb555(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16));
}
