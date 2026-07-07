// aot/spec/pjgb.ts — THE single source of truth for the PJGB game data model,
// the script bytecode ISA, the text/glyph encoding, and the runtime debug
// block — shared by ALL cartridge targets (GBA, Game Boy, NES, 3DS, DS).
//
// Both sides derive from this file:
//   - the compiler (aot/compiler/*) ENCODES these layouts,
//   - each C runtime (aot/runtime/<target>/*) DECODES them, via a generated
//     pjgb_gen.h (aot/spec/gen-c.ts emits per-target #defines so C can never
//     drift from TS).
//
// Target split:
//   - The GBA target ships the PJGB chunk container below verbatim and parses
//     it at boot (flat 32 MB ROM space makes that free).
//   - The GB/NES targets do NOT parse a container: the compiler residualizes
//     the same logical records into per-bank C arrays (gen_data.c) because
//     banked 8-bit ROMs have no flat address space. The RECORD layouts
//     (actors, warps, text tokens, script bytecode, debug block) stay
//     byte-identical across targets; only the packaging differs.
//
// Conventions (non-negotiable, matches the repo-wide rule in ../../spec/spec.ts):
//   - Little-endian EVERYWHERE (all three CPUs are LE).
//   - All offsets in comments are from the start of the containing blob/chunk.
//   - GBA colors are 15-bit BGR555: bit0-4 R, 5-9 G, 10-14 B, bit15 unused.

// ---------------------------------------------------------------------------
// Screen / hardware (GBA values; per-target values live in TARGETS below)
// ---------------------------------------------------------------------------
export const SCREEN_W = 240;
export const SCREEN_H = 160;
export const TILE_PX = 8; // one BG tile is 8x8 px on every target
export const SCREEN_TILES_W = SCREEN_W / TILE_PX; // 30
export const SCREEN_TILES_H = SCREEN_H / TILE_PX; // 20
export const TILE_4BPP_BYTES = 32; // 8x8 @ 4bpp (GBA)
export const TILE_2BPP_BYTES = 16; // 8x8 @ 2bpp (GB interleaved / NES planar)

// ---------------------------------------------------------------------------
// Targets. One authored game compiles to any of these; the compiler wraps
// text and sizes VRAM slot regions per target, so these numbers are part of
// the binary contract (they shape text banks and glyph slot ids).
// ---------------------------------------------------------------------------
export interface TargetSpec {
  name: "gba" | "gb" | "nes" | "3ds" | "nds";
  screenW: number;
  screenH: number;
  /** Max map size in tiles (w, h). NES is bounded by a single nametable. */
  maxMapW: number;
  maxMapH: number;
  /** Bytes per 8x8 tile in this target's native format. */
  tileBytes: number;
  /** Text metrics for cjk16 mode: halfcell columns and 16px lines per page. */
  textCols: number;
  textLines: number;
  /** Halfcell columns available for a choice row (incl. 2-cell cursor). */
  choiceCols: number;
  /** Max choice options per menu. */
  maxChoices: number;
  /** Dynamic glyph slot budget (1 slot = 1 halfcell = 2 stacked 8x8 tiles). */
  glyphSlots: number;
  /** Absolute bus address of the debug block. */
  debugAddr: number;
  /** ROM file extension (with the dot) — CLI/e2e derive it from here. */
  ext: string;
}

export const TARGETS: Record<"gba" | "gb" | "nes" | "3ds" | "nds", TargetSpec> = {
  gba: {
    name: "gba",
    screenW: 240,
    screenH: 160,
    maxMapW: 32,
    maxMapH: 32,
    tileBytes: TILE_4BPP_BYTES,
    textCols: 28,
    textLines: 3,
    choiceCols: 20,
    maxChoices: 4,
    glyphSlots: 84, // 28 cols x 3 lines
    debugAddr: 0x02000000, // EWRAM base
    ext: ".gba",
  },
  gb: {
    name: "gb",
    screenW: 160,
    screenH: 144,
    maxMapW: 32,
    maxMapH: 32,
    tileBytes: TILE_2BPP_BYTES,
    textCols: 18,
    textLines: 2,
    choiceCols: 18,
    maxChoices: 4,
    glyphSlots: 72, // max(18x2 text, 18x4 choices)
    debugAddr: 0xde00, // top of DMG WRAM, below the GBDK stack
    ext: ".gb",
  },
  nes: {
    name: "nes",
    screenW: 256,
    screenH: 240,
    maxMapW: 32,
    maxMapH: 30, // one nametable; v1 NES does not scroll
    tileBytes: TILE_2BPP_BYTES,
    textCols: 28,
    textLines: 3,
    choiceCols: 20,
    maxChoices: 4,
    glyphSlots: 84, // max(28x3 text, 20x4 choices)
    debugAddr: 0x0700, // top page of the 2 KB CPU RAM
    ext: ".nes",
  },
  // 3DS: dual screen. The top screen (400x240) shows the world at 2x scale
  // (one 200x120 world viewport); the bottom screen (320x240) owns the
  // textbox/choice UI, so dialogue never covers the map. The runtime renders
  // in software from the SAME PJGB blob as GBA (4bpp tiles + BGR555), so
  // screenW/H here are WORLD-view pixels, not physical pixels, and glyph
  // "slots" are a reserved-index formality (glyphs draw straight from the
  // store — no VRAM streaming).
  "3ds": {
    name: "3ds",
    screenW: 200,
    screenH: 120,
    maxMapW: 32,
    maxMapH: 32,
    tileBytes: TILE_4BPP_BYTES,
    textCols: 36, // bottom screen: 40 halfcells minus a 2-cell margin each side
    textLines: 4,
    choiceCols: 34,
    maxChoices: 4,
    glyphSlots: 144, // 36 cols x 4 lines
    debugAddr: 0x14000000, // virtual marker; the host harness reads block-relative
    ext: ".3dsx",
  },
  // DS (NTR): true dual screen, two independent 2D engines. The MAIN engine
  // drives the top screen with the world: a 128x96 viewport hardware-scaled
  // 2x (extended-affine BG + affine sprites) to fill the 256x192 panel — GBA
  // maps are smaller than the DS screen, so 1:1 would letterbox. The SUB
  // engine drives the bottom screen (256x192) with the textbox/choice UI, so
  // dialogue never covers the map. The DS 2D hardware is essentially "GBA x2"
  // and uses the same 4bpp tiles + BGR555 palettes, so the DS runtime ships
  // the GBA PJGB blob verbatim and renders it in HARDWARE. Like the GBA, the
  // sub engine STREAMS glyph tiles into a glyphSlots-sized VRAM slot region
  // per page (a 10-bit screen-entry tile index cannot address a whole CJK
  // store). debugAddr is DS main RAM (0x02000000), matching the GBA
  // debug-block convention.
  nds: {
    name: "nds",
    screenW: 128, // world viewport; shown at 2x = 256x192
    screenH: 96,
    maxMapW: 32,
    maxMapH: 32,
    tileBytes: TILE_4BPP_BYTES,
    textCols: 28, // 256px / 8 = 32 halfcells, minus a 2-cell margin each side
    textLines: 4,
    choiceCols: 26,
    maxChoices: 4,
    glyphSlots: 112, // 28 cols x 4 lines
    debugAddr: 0x02000000, // DS main RAM base (== GBA EWRAM convention)
    ext: ".nds",
  },
} as const;
export type TargetName = keyof typeof TARGETS;

// ---------------------------------------------------------------------------
// Cartridge container: "PJGB"
// ---------------------------------------------------------------------------
export const PJGB_MAGIC = 0x424a5250; // 'P''J''G''B' read as LE u32 -> "PJGB" bytes
export const PJGB_MAGIC_BYTES = [0x50, 0x4a, 0x47, 0x42] as const; // 'P','J','G','B'
export const PJGB_VERSION = 1;

// Header (16 bytes), at blob offset 0:
//   0  u8[4] magic "PJGB"
//   4  u16   version
//   6  u16   chunk_count
//   8  u32   chunk_table_offset  (offset of the chunk directory)
//   12 u32   total_size
export const PJGB_HEADER_SIZE = 16;

// Chunk directory entry (16 bytes each):
//   0  u32 kind   (CHUNK.*)
//   4  u32 id     (per-kind index, e.g. map index)
//   8  u32 offset (from blob start)
//   12 u32 size
export const PJGB_CHUNK_ENTRY_SIZE = 16;

export const CHUNK = {
  GAME: 1, // GameHeader (see below)
  PAL_BG: 2, // u16[] BGR555 (16 * n colors)
  PAL_OBJ: 3, // u16[] BGR555
  TILES_BG: 4, // 4bpp tile data (32 bytes/tile), tile 0 = blank
  TILES_OBJ: 5, // 4bpp OBJ tile data (sprites + font glyphs)
  MAP: 6, // one per map, id = map index (MapChunk)
  TEXT_BANK: 7, // string table (TextBank)
  SCRIPT_CODE: 8, // raw bytecode bytes for all scripts, concatenated
  SCRIPT_TABLE: 9, // u32[] byte-offsets into SCRIPT_CODE, indexed by script id
  SPRITE_TABLE: 10, // SpriteProto[] indexed by sprite id
  GLYPHS: 11, // cjk16 glyph tile store (GlyphStore, target-encoded tiles)
} as const;
export type ChunkKind = (typeof CHUNK)[keyof typeof CHUNK];

// ---------------------------------------------------------------------------
// GameHeader chunk (CHUNK.GAME, id 0)
//   0  u8[24] title (ascii, null-padded)
//   24 u8   start_map
//   25 u8   start_dir
//   26 u16  start_x   (tile)
//   28 u16  start_y   (tile)
//   30 u8   map_count
//   31 u8   sprite_count
//   32 u16  flag_count
//   34 u16  text_count
//   36 u16  script_count
//   38 u16  font_base   (ascii8: BG tile index of ASCII 0x20; cjk16: 0)
//   40 u16  box_tile    (BG tile index of the opaque textbox fill tile)
//   42 u8   text_mode   (TEXT_MODE.*)
//   43 u8   reserved
//   44 u16  glyph_slot_base  (cjk16: first BG tile of the dynamic slot region)
//   46 u16  glyph_slot_count (cjk16: slot region size in 8x8 tiles)
// = 48 bytes
// ---------------------------------------------------------------------------
export const GAME_TITLE_LEN = 24;
export const GAME_HEADER_SIZE = 48;

export const TEXT_MODE = {
  ASCII8: 0, // legacy 8x8 ASCII font baked as static BG tiles (GBA only)
  CJK16: 1, // 16px lines; glyphs streamed into VRAM slots on demand
} as const;

// ---------------------------------------------------------------------------
// Text token stream (cjk16 mode). A "halfcell" is an 8px-wide, 16px-tall
// column = 2 stacked 8x8 tiles (top tile first in every glyph store).
//   0x00        end of string
//   0x0A        newline (advance one 16px line)
//   0x20..0x7E  ASCII literal -> halfwidth glyph id (byte - 0x20), 1 halfcell
//   0x80|hi, lo fullwidth glyph id ((hi & 0x3F) << 8) | lo, 2 halfcells
// Line wrapping and pagination happen AT COMPILE TIME (per target): the
// runtime only ever sees streams that fit one textbox page.
// ---------------------------------------------------------------------------
export const TOK_END = 0x00;
export const TOK_NEWLINE = 0x0a;
export const TOK_ASCII_MIN = 0x20;
export const TOK_ASCII_MAX = 0x7e;
export const TOK_FULL_FLAG = 0x80;
export const HALF_GLYPH_COUNT = TOK_ASCII_MAX - TOK_ASCII_MIN + 1; // 95

// GlyphStore (CHUNK.GLYPHS, id 0; GB/NES: gen_data.c arrays with these counts):
//   0 u16 half_count   (always HALF_GLYPH_COUNT for v1)
//   2 u16 full_count   (game-specific: unique CJK/fullwidth glyphs used)
//   4 u16 tile_bytes   (bytes per 8x8 tile in the target encoding)
//   6 u16 reserved
//   8 ... half glyphs: half_count x 2 tiles (top, bottom)
//   ... full glyphs: full_count x 4 tiles (left top, left bottom,
//                                          right top, right bottom)
export const GLYPH_STORE_HEADER_SIZE = 8;

// ---------------------------------------------------------------------------
// MapChunk (CHUNK.MAP, id = map index). Self-describing; all *_off are
// relative to the START of this chunk.
//   0  u16 width           (tiles)
//   2  u16 height          (tiles)
//   4  u16 num_actors
//   6  u16 num_warps
//   8  u8  bg_palbank       (which 16-color BG palette bank the map tiles use)
//   9  u8  on_enter_script  (script id, 0xFF = none; runs when the map loads)
//   10 u16 reserved
//   12 u32 tiles_off        -> u16[width*height] BG screen-entry tile indices
//   16 u32 collision_off    -> u8[width*height] (0 = walkable, 1 = solid)
//   20 u32 actors_off       -> ActorInstance[num_actors]
//   24 u32 warps_off        -> Warp[num_warps]
// = 28 byte header, then the referenced tables.
// ---------------------------------------------------------------------------
export const MAP_HEADER_SIZE = 28;
export const COLLISION_WALKABLE = 0;
export const COLLISION_SOLID = 1;

// ActorInstance (12 bytes):
//   0  u16 x            (tile)
//   2  u16 y            (tile)
//   4  u8  sprite_id
//   5  u8  facing       (DIR.*)
//   6  u8  movement     (MOVE.*)
//   7  u8  flags        (ACTOR_FLAG.*)
//   8  u16 on_talk      (script id, 0xFFFF = none)
//   10 u16 reserved
export const ACTOR_INSTANCE_SIZE = 12;
export const SCRIPT_NONE = 0xffff;

export const ACTOR_FLAG = {
  NONE: 0,
  SOLID: 1 << 0, // blocks the player tile
} as const;

// Warp (12 bytes) — the compiler resolves "map:entrance" to concrete coords:
//   0  u16 x         (tile on the source map that triggers the warp)
//   2  u16 y
//   4  u8  dest_map
//   5  u8  dest_dir
//   6  u16 dest_x
//   8  u16 dest_y
//   10 u16 reserved
export const WARP_SIZE = 12;

// SpriteProto (SPRITE_TABLE, 8 bytes) — v1: fixed 16x16 sprites, 4 facings,
// each facing = one OBJ tile block. tile_base indexes TILES_OBJ in 8x8 units.
//   0  u16 tile_base   (first OBJ tile index; layout below)
//   2  u8  w_px
//   3  u8  h_px
//   4  u8  palbank     (OBJ palette bank)
//   5  u8  frames      (walk frames per direction)
//   6  u16 reserved
// OBJ tile layout per sprite (16x16 = 4 tiles/frame, order: 4 dirs * frames):
//   tile_base + (dir * frames + frame) * tiles_per_frame
export const SPRITE_PROTO_SIZE = 8;

// ---------------------------------------------------------------------------
// TextBank (CHUNK.TEXT_BANK, id 0):
//   0  u16 count
//   2  u16 reserved
//   4  u32[count] offsets (relative to chunk start) to null-terminated ascii
//   ... string bytes
// Text uses the runtime font charset (ASCII 0x20..0x7E). '\n' (0x0A) = newline.
// ---------------------------------------------------------------------------
export const TEXTBANK_HEADER_SIZE = 4;

// ---------------------------------------------------------------------------
// Directions / movement
// ---------------------------------------------------------------------------
export const DIR = { DOWN: 0, UP: 1, LEFT: 2, RIGHT: 3 } as const;
export type DirName = keyof typeof DIR;
export const DIR_NAMES: Record<string, number> = {
  down: DIR.DOWN,
  up: DIR.UP,
  left: DIR.LEFT,
  right: DIR.RIGHT,
};
// dx/dy per direction (tile units)
export const DIR_DX = [0, 0, -1, 1] as const; // down,up,left,right
export const DIR_DY = [1, -1, 0, 0] as const;

export const MOVE = { STATIC: 0, WANDER: 1, PATROL_H: 2, PATROL_V: 3 } as const;
export const MOVE_NAMES: Record<string, number> = {
  static: MOVE.STATIC,
  wander: MOVE.WANDER,
  patrolH: MOVE.PATROL_H,
  patrolV: MOVE.PATROL_V,
};

// ---------------------------------------------------------------------------
// Script VM — a small stack machine. u8 opcode, then little-endian operands.
// The residualizer (aot/compiler/script.ts) emits these; script_vm.c runs them.
// ---------------------------------------------------------------------------
export const OP = {
  END: 0x00, //                       terminate script
  NOP: 0x01, //
  TEXT: 0x02, // u16 textId            show text box, SUSPEND until A
  SET_FLAG: 0x03, // u16 flagId        flags[flagId] = 1
  CLEAR_FLAG: 0x04, // u16 flagId      flags[flagId] = 0
  PUSH_FLAG: 0x05, // u16 flagId       push flags[flagId] (0/1)
  PUSH_CONST: 0x06, // i16 value       push value
  POP: 0x07, //                        discard top
  DUP: 0x08, //                        duplicate top
  EQ: 0x09, //                         b=pop,a=pop, push (a==b)
  NE: 0x0a, //                         push (a!=b)
  NOT: 0x0b, //                        a=pop, push (a==0)
  JUMP: 0x0c, // i16 rel               ip += rel (rel is from AFTER the operand)
  JUMP_IF_FALSE: 0x0d, // i16 rel      a=pop; if a==0 ip += rel
  CHOICE: 0x0e, // u8 n, u16 t0..t(n-1)  menu of n text options; SUSPEND, push chosen index
  LOCK_PLAYER: 0x0f, //
  RELEASE_PLAYER: 0x10, //
  FACE_PLAYER: 0x11, // u8 actorSlot   actor turns to face the player
  WARP: 0x12, // u8 map,u16 x,u16 y,u8 dir   change map + reposition player
  SET_VAR: 0x13, // u16 varId, i16 val
  ADD_VAR: 0x14, // u16 varId, i16 val
  PUSH_VAR: 0x15, // u16 varId
  GIVE_ITEM: 0x16, // u16 itemId, u8 count   (v1 stub: increments an inventory var)
  BATTLE: 0x17, // u16 battleId          (v1 stub: shows "* battle *" text, push 1=win)
  WAIT: 0x18, // u16 frames             SUSPEND for N frames
  PLAY_SFX: 0x19, // u16 sfxId          (v1 stub, no-op)
  LT: 0x1a, //                          b=pop,a=pop, push (a<b)   signed
  GT: 0x1b, //                          push (a>b)
  LE: 0x1c, //                          push (a<=b)
  GE: 0x1d, //                          push (a>=b)
  RND: 0x1e, // u8 n                    push uniform 0..n-1 (frame-seeded LCG)
} as const;
export type OpName = keyof typeof OP;

// Operand widths per opcode (bytes AFTER the u8 opcode). CHOICE is variable and
// handled specially (0xFF sentinel here).
export const OP_OPERAND_BYTES: Record<number, number> = {
  [OP.END]: 0,
  [OP.NOP]: 0,
  [OP.TEXT]: 2,
  [OP.SET_FLAG]: 2,
  [OP.CLEAR_FLAG]: 2,
  [OP.PUSH_FLAG]: 2,
  [OP.PUSH_CONST]: 2,
  [OP.POP]: 0,
  [OP.DUP]: 0,
  [OP.EQ]: 0,
  [OP.NE]: 0,
  [OP.NOT]: 0,
  [OP.JUMP]: 2,
  [OP.JUMP_IF_FALSE]: 2,
  [OP.CHOICE]: -1, // variable: 1 + 2*n
  [OP.LOCK_PLAYER]: 0,
  [OP.RELEASE_PLAYER]: 0,
  [OP.FACE_PLAYER]: 1,
  [OP.WARP]: 6, // u8 + u16 + u16 + u8
  [OP.SET_VAR]: 4,
  [OP.ADD_VAR]: 4,
  [OP.PUSH_VAR]: 2,
  [OP.GIVE_ITEM]: 3,
  [OP.BATTLE]: 2,
  [OP.WAIT]: 2,
  [OP.PLAY_SFX]: 2,
  [OP.LT]: 0,
  [OP.GT]: 0,
  [OP.LE]: 0,
  [OP.GE]: 0,
  [OP.RND]: 1,
};

export const VM_MAX_STACK = 16;

// ---------------------------------------------------------------------------
// Runtime debug block — written by every runtime into a FIXED RAM address so
// the emulator harnesses (mGBA for GBA/GB, jsnes for NES) can read game state
// without symbols. The LAYOUT is identical on all targets; the base address is
// per-target (TARGETS[t].debugAddr). Layout must match runtime/*/debug.c.
// ---------------------------------------------------------------------------
export const EWRAM_BASE = 0x02000000;
export const DEBUG_ADDR = EWRAM_BASE; // GBA base (kept for existing GBA paths)
// Offsets within the debug block:
export const DBG = {
  MAGIC: 0x00, // u32 'PJDB'
  PLAYER_X: 0x04, // u16 tile
  PLAYER_Y: 0x06, // u16 tile
  PLAYER_DIR: 0x08, // u8
  CUR_MAP: 0x09, // u8
  TEXT_ACTIVE: 0x0a, // u8 (1 if a text box is on screen)
  SCRIPT_ACTIVE: 0x0b, // u8 (1 if a script is running)
  FRAME: 0x0c, // u32 frame counter
  CUR_TEXT: 0x10, // u16 currently-shown text id (0xFFFF none)
  CHOICE_CURSOR: 0x12, // u8 highlighted choice index while a CHOICE menu is up
  BOOTED: 0x13, // u8 (1 once the main loop has started — liveness marker)
  FLAGS: 0x14, // u8[16] = 128 flag bits (flag n -> byte n>>3, bit n&7)
  VARS: 0x24, // i16[16] general vars
} as const;
export const DEBUG_MAGIC = 0x50_4a_44_42; // 'PJDB' as u32 (bytes P,J,D,B LE)
export const DEBUG_MAGIC_BYTES = [0x50, 0x4a, 0x44, 0x42] as const;
export const DEBUG_BLOCK_SIZE = 0x44;

// Convenience: absolute address of a debug field.
export const dbgAddr = (field: keyof typeof DBG): number => DEBUG_ADDR + DBG[field];
export const flagAddr = (flagId: number): { addr: number; bit: number } => ({
  addr: DEBUG_ADDR + DBG.FLAGS + (flagId >> 3),
  bit: flagId & 7,
});

// ---------------------------------------------------------------------------
// Compile-time budgets (design §16). Exceeding -> build error.
// ---------------------------------------------------------------------------
export const BUDGET = {
  MAX_ACTORS_PER_MAP: 24,
  MAX_MAPS: 32,
  MAX_SPRITES: 16, // one OBJ palette bank per sprite; GBA hardware has 16 banks
  MAX_FLAGS: 128,
  MAX_VARS: 16,
  MAX_TEXTS: 512,
  MAX_SCRIPTS: 254, // on-enter script ids must fit a u8 with 0xFF = none
  // BG char data lives in charblock 0 (512 4bpp tiles); the map screenblock
  // sits at SBB 8 = the start of charblock 1, so BG tiles must fit in 512.
  MAX_BG_TILES: 512,
  MAX_OBJ_TILES: 1024, // OBJ VRAM 0x06010000..0x06018000 = 1024 4bpp tiles
  MAX_MAP_TILES: 128 * 128,
  MAX_FULL_GLYPHS: 512, // unique fullwidth (CJK) glyphs bakeable per game
} as const;

// Per-target VRAM budgets for BG tiles (blank + tileset + box + glyph slots).
// GB: signed BG addressing gives 256 tiles; NES: one 256-tile pattern table.
export const BG_TILE_BUDGET: Record<TargetName, number> = {
  gba: 512,
  gb: 256,
  nes: 256,
  "3ds": 1024, // software renderer: no VRAM, just a sanity cap
  nds: 1023, // 10-bit screen entries minus the blank tile 0 the renderer reserves
};
// OBJ tile budgets: GB keeps OBJ in 0x8000..0x87FF (128 tiles) so BG can own
// 0x8800..0x97FF; NES pattern table 1 holds 256 8x8 OBJ tiles.
export const OBJ_TILE_BUDGET: Record<TargetName, number> = {
  gba: 1024,
  gb: 128,
  nes: 256,
  "3ds": 1024,
  nds: 1024,
};

// ---------------------------------------------------------------------------
// Color: pack an 8-bit RGB triple into GBA BGR555.
// ---------------------------------------------------------------------------
export function rgb555(r: number, g: number, b: number): number {
  const R = (r >> 3) & 0x1f;
  const G = (g >> 3) & 0x1f;
  const B = (b >> 3) & 0x1f;
  return (B << 10) | (G << 5) | R;
}

// ---------------------------------------------------------------------------
// Little-endian byte writer used by the compiler backend (pack.ts / lower.ts).
// ---------------------------------------------------------------------------
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
  ascii(s: string, fixedLen?: number): this {
    const n = fixedLen ?? s.length;
    for (let i = 0; i < n; i++) this.buf.push(i < s.length ? s.charCodeAt(i) & 0xff : 0);
    return this;
  }
  /** Pad to a 4-byte boundary. */
  align4(): this {
    while (this.buf.length & 3) this.buf.push(0);
    return this;
  }
  patchU32(at: number, v: number): this {
    this.buf[at] = v & 0xff;
    this.buf[at + 1] = (v >> 8) & 0xff;
    this.buf[at + 2] = (v >> 16) & 0xff;
    this.buf[at + 3] = (v >> 24) & 0xff;
    return this;
  }
  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}
