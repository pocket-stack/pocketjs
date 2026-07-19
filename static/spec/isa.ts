// static/spec/isa.ts — the Pocket Static core contract, single source of truth.
//
// Everything binary that is CATEGORY-INDEPENDENT lives here: the stack-VM ISA,
// the blob/text encodings, the per-target hardware table, and the runtime
// debug block. Category specs (spec/rpg.ts, ...) extend the opcode space from
// SYSCALL_BASE up and define their own record layouts.
//
// Both sides derive from this file:
//   - the compiler (static/compiler/*) ENCODES these layouts,
//   - every C runtime DECODES them via the generated gen/spec_gen.h
//     (static/spec/gen-c.ts), so C can never drift from TS,
//   - static/vm/ref.ts INTERPRETS the ISA on the host — the reference
//     implementation the emulator suites hold the consoles to.
//
// Conventions (non-negotiable):
//   - Little-endian everywhere (ARM7TDMI, SM83 and 6502 are all LE).
//   - All VM values are signed 16-bit integers (i16).
//   - Relative jumps are measured from AFTER the 2-byte operand.
//   - Offsets in comments are from the start of the containing record.

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------
export type TargetName = "gba" | "gb" | "nes";

export interface TargetSpec {
  name: TargetName;
  /** Visible screen in 8x8 tiles. */
  screenTilesW: number;
  screenTilesH: number;
  /** Bytes per 8x8 tile in the native format. */
  tileBytes: number;
  /** Textbox text area: columns and lines per page (compile-time wrapping). */
  textCols: number;
  textLines: number;
  /** Max options per CHOICE menu (one line each). */
  maxChoices: number;
  /**
   * Total BG tiles in the runtime's tile table. The layout convention is
   * FIXED on every target (no header fields needed):
   *   0                = blank
   *   1..total-99      = game art (bgArtTiles budget)
   *   total-97         = choice cursor
   *   total-96         = textbox fill
   *   total-95..total-1 = the 95 ASCII font glyphs
   */
  bgTotalTiles: number;
  /** BG tile budget for game art (= bgTotalTiles - 98). */
  bgArtTiles: number;
  /** OBJ tile budget in 8x8 tiles. */
  objTiles: number;
  /** Absolute bus address of the debug block. */
  debugAddr: number;
  /** Max map size in tiles. */
  maxMapW: number;
  maxMapH: number;
  /** Whether the camera may scroll (NES v1 is one static nametable). */
  scrolls: boolean;
  /** ROM file extension. */
  ext: string;
}

export const TARGETS: Record<TargetName, TargetSpec> = {
  gba: {
    name: "gba",
    screenTilesW: 30,
    screenTilesH: 20,
    tileBytes: 32, // 4bpp
    textCols: 28,
    textLines: 3,
    maxChoices: 4,
    bgTotalTiles: 512, // charblock 0
    bgArtTiles: 414,
    objTiles: 1024,
    debugAddr: 0x02000000, // EWRAM base; linker keeps EWRAM empty
    maxMapW: 32,
    maxMapH: 30,
    scrolls: true,
    ext: ".gba",
  },
  gb: {
    name: "gb",
    screenTilesW: 20,
    screenTilesH: 18,
    tileBytes: 16, // 2bpp interleaved
    textCols: 18,
    textLines: 3,
    maxChoices: 4,
    bgTotalTiles: 256, // signed addressing window 0x8800-0x97FF
    bgArtTiles: 158,
    objTiles: 128, // OBJ block 0x8000-0x87FF
    debugAddr: 0xdf00, // top of WRAM; our crt0 parks SP just below
    maxMapW: 32,
    maxMapH: 30,
    scrolls: true,
    ext: ".gb",
  },
  nes: {
    name: "nes",
    screenTilesW: 32,
    screenTilesH: 30,
    tileBytes: 16, // 2bpp planar
    textCols: 28,
    textLines: 3,
    maxChoices: 4,
    bgTotalTiles: 256, // CHR-RAM pattern table 0
    bgArtTiles: 158,
    objTiles: 256, // pattern table 1
    debugAddr: 0x0700, // top page of the 2 KB CPU RAM
    maxMapW: 32,
    // One nametable is 32x30, but the textbox permanently owns tile rows
    // 24-29 (attribute cells are 16px — the box must own whole attr rows),
    // so maps stop at 24 and closing the box restores blank fills only.
    maxMapH: 24,
    scrolls: false,
    ext: ".nes",
  },
};

export const TILE_PX = 8;

/** Fixed BG tile layout (see TargetSpec.bgTotalTiles). */
export const bgLayout = (t: TargetSpec) => ({
  blank: 0,
  artBase: 1,
  cursorTile: t.bgTotalTiles - 97,
  boxTile: t.bgTotalTiles - 96,
  fontBase: t.bgTotalTiles - 95,
});

// ---------------------------------------------------------------------------
// Core stack-VM ISA — opcodes 0x00..0x3F. Categories own 0x40+.
//
// The VM: operand stack of i16 (depth VM_STACK), call stack of VM_FRAMES
// frames, each frame owning VM_LOCALS fresh local slots. Globals: VM_VARS
// i16 vars + VM_FLAGS single-bit flags. One script runs at a time; blocking
// ops SUSPEND the VM (the frame loop resumes it when the condition clears).
// The interpreter executes at most VM_BURST ops per frame between suspensions
// (runaway-loop guard: a script that never suspends still yields the frame).
// ---------------------------------------------------------------------------
export const OP = {
  END: 0x00, //                     terminate the whole script (any depth)
  NOP: 0x01,
  PUSH8: 0x02, //  i8               push sign-extended
  PUSH16: 0x03, // i16              push
  POP: 0x04, //                     discard top
  DUP: 0x05, //                     duplicate top
  JMP: 0x06, //   rel16             ip += rel
  JZ: 0x07, //    rel16             a=pop; if a==0 ip += rel
  JNZ: 0x08, //   rel16             a=pop; if a!=0 ip += rel
  CALL: 0x09, //  u16 scriptId      push frame, jump to script entry
  RET: 0x0a, //                     pop frame; at depth 0 acts like END
  LDV: 0x0b, //   u8 varId          push vars[id]
  STV: 0x0c, //   u8 varId          vars[id] = pop
  LDL: 0x0d, //   u8 slot           push locals[slot]
  STL: 0x0e, //   u8 slot           locals[slot] = pop
  FLAG: 0x0f, //  u8 flagId         push flags[id] (0/1)
  SETF: 0x10, //  u8 flagId         flags[id] = 1
  CLRF: 0x11, //  u8 flagId         flags[id] = 0
  STF: 0x12, //   u8 flagId         flags[id] = (pop != 0)
  ADD: 0x13, //                     b=pop,a=pop, push a+b   (i16 wrap)
  SUB: 0x14, //                     push a-b
  MUL: 0x15, //                     push a*b (low 16)
  DIV: 0x16, //                     push a/b trunc; b==0 -> 0
  MOD: 0x17, //                     push a%b (sign of a);  b==0 -> 0
  NEG: 0x18, //                     push -pop
  EQ: 0x19, //                      push a==b
  NE: 0x1a,
  LT: 0x1b, //                      signed
  GT: 0x1c,
  LE: 0x1d,
  GE: 0x1e,
  NOT: 0x1f, //                     push pop==0
  RND: 0x20, //                     n=pop, push uniform 0..n-1 (n<=0 -> 0)
  WAIT: 0x21, //                    n=pop, SUSPEND n frames
} as const;
export type CoreOpName = keyof typeof OP;

/** First category-owned opcode. */
export const SYSCALL_BASE = 0x40;

/** Operand bytes AFTER the opcode byte, for core ops. */
export const OP_OPERANDS: Record<number, number> = {
  [OP.END]: 0,
  [OP.NOP]: 0,
  [OP.PUSH8]: 1,
  [OP.PUSH16]: 2,
  [OP.POP]: 0,
  [OP.DUP]: 0,
  [OP.JMP]: 2,
  [OP.JZ]: 2,
  [OP.JNZ]: 2,
  [OP.CALL]: 2,
  [OP.RET]: 0,
  [OP.LDV]: 1,
  [OP.STV]: 1,
  [OP.LDL]: 1,
  [OP.STL]: 1,
  [OP.FLAG]: 1,
  [OP.SETF]: 1,
  [OP.CLRF]: 1,
  [OP.STF]: 1,
  [OP.ADD]: 0,
  [OP.SUB]: 0,
  [OP.MUL]: 0,
  [OP.DIV]: 0,
  [OP.MOD]: 0,
  [OP.NEG]: 0,
  [OP.EQ]: 0,
  [OP.NE]: 0,
  [OP.LT]: 0,
  [OP.GT]: 0,
  [OP.LE]: 0,
  [OP.GE]: 0,
  [OP.NOT]: 0,
  [OP.RND]: 0,
  [OP.WAIT]: 0,
};

export const VM_STACK = 16; // operand stack depth (i16 entries)
export const VM_FRAMES = 4; // call depth (top-level script = frame 0)
export const VM_LOCALS = 16; // local slots per frame
export const VM_VARS = 64; // global i16 vars
export const VM_FLAGS = 256; // global flags (bit set)
export const VM_BURST = 64; // max ops per frame between suspensions

// Vars 60..63 are compiler scratch (text interpolation slots etc).
export const VAR_SCRATCH_BASE = 60;
export const VAR_USER_MAX = VAR_SCRATCH_BASE; // user vars must intern below this

/**
 * Cross-target key bitmask (the HAL normalizes each console's pad to this;
 * harness scenarios use the names).
 */
export const KEYS = {
  A: 0x01,
  B: 0x02,
  SELECT: 0x04,
  START: 0x08,
  RIGHT: 0x10,
  LEFT: 0x20,
  UP: 0x40,
  DOWN: 0x80,
} as const;
export type KeyName = keyof typeof KEYS;

/** Suspension reasons (debug block WAITING field + runtime state). */
export const WAITING = {
  NONE: 0,
  TEXT: 1, // SAY page on screen, waiting for A
  CHOICE: 2, // CHOICE menu up, waiting for pick
  FRAMES: 3, // WAIT counting down
} as const;

// Deterministic RNG: xorshift16, advanced ONLY by OP.RND. Same seed, same
// script => same story on every console (and in vm/ref.ts).
//   x ^= x << 7; x ^= x >> 9; x ^= x << 8;   (all 16-bit)
export const RNG_SEED = 0x2a17;

export function rngNext(state: number): number {
  let x = state & 0xffff;
  x ^= (x << 7) & 0xffff;
  x ^= x >> 9;
  x ^= (x << 8) & 0xffff;
  return x & 0xffff;
}

// ---------------------------------------------------------------------------
// Text encoding — token streams, wrapped and paginated at COMPILE TIME per
// target. The runtime never measures text.
//   0x00        end of page
//   0x0A        newline (next line)
//   0x01, u8 v  FMT slot: render vars[v] as signed decimal (typewriter
//               reveals it as one unit); v is a VAR_SCRATCH_BASE.. slot
//   0x20..0x7E  ASCII literal -> font glyph (byte - 0x20)
// ---------------------------------------------------------------------------
export const TOK_END = 0x00;
export const TOK_FMT = 0x01;
export const TOK_NEWLINE = 0x0a;
export const TOK_ASCII_MIN = 0x20;
export const TOK_ASCII_MAX = 0x7e;
export const FONT_GLYPHS = TOK_ASCII_MAX - TOK_ASCII_MIN + 1; // 95
/** Cells reserved when wrapping a FMT slot (i16 max is "-32768" = 6; we
 *  assume gameplay numbers and reserve 5). */
export const FMT_CELLS = 5;

// ---------------------------------------------------------------------------
// Blobs — the unit of data placement. GBA concatenates them flat; GB/NES
// assign each blob wholly into one 16 KB switchable bank and latch per
// access. Blob ids are u8, dense from 0, in BLOB_KIND declaration order per
// game (the compiler emits a per-target directory; see targets/*).
// ---------------------------------------------------------------------------
export const BANK_SIZE = 0x4000; // GB/NES switchable window
export const BLOB_KIND = {
  SCRIPTS: 0, // bytecode, all scripts concatenated (single blob, <= 16 KB)
  TEXT: 1, // token streams (may be several TEXT blobs)
  MAP: 2, // one blob per map (grid + collision + actors + warps + triggers)
  TILES_BG: 3, // native-encoded BG art tiles
  TILES_OBJ: 4, // native-encoded OBJ tiles
  FONT: 5, // 95 glyphs, native encoding
} as const;

// Script table (fixed region): u16 byte offset into the SCRIPTS blob per id.
// Text table (fixed region): per text id, 3 bytes: u8 blobId, u16 offset.
export const TEXT_ENTRY_SIZE = 3;

// ---------------------------------------------------------------------------
// Debug block — every runtime mirrors this to TARGETS[t].debugAddr each
// frame; emulator harnesses read it over the bus. Same layout on all targets.
// ---------------------------------------------------------------------------
export const DBG = {
  MAGIC: 0x00, // u32 'PSDB' bytes P,S,D,B
  BOOTED: 0x04, // u8 1 once the main loop runs
  PLAYER_DIR: 0x05, // u8 DIR.*
  CUR_MAP: 0x06, // u8
  TEXT_ACTIVE: 0x07, // u8
  SCRIPT_ACTIVE: 0x08, // u8
  CHOICE_CURSOR: 0x09, // u8
  WAITING: 0x0a, // u8 WAITING.*
  RESERVED0: 0x0b, // u8
  PLAYER_X: 0x0c, // u16 tile
  PLAYER_Y: 0x0e, // u16 tile
  CUR_TEXT: 0x10, // u16 text id shown (0xFFFF none)
  CUR_SCRIPT: 0x12, // u16 running script id (0xFFFF none)
  FRAME: 0x14, // u32
  RNG: 0x18, // u16 rng state
  RESERVED1: 0x1a, // u16
  FLAGS: 0x1c, // u8[32]  flag n -> byte n>>3, bit n&7
  VARS: 0x3c, // i16[64]
} as const;
export const DEBUG_MAGIC_BYTES = [0x50, 0x53, 0x44, 0x42] as const; // P,S,D,B
export const DEBUG_BLOCK_SIZE = DBG.VARS + VM_VARS * 2; // 0xBC = 188

export const dbgAddr = (t: TargetName, field: keyof typeof DBG): number =>
  TARGETS[t].debugAddr + DBG[field];
export const dbgFlagAddr = (t: TargetName, flagId: number): { addr: number; bit: number } => ({
  addr: TARGETS[t].debugAddr + DBG.FLAGS + (flagId >> 3),
  bit: flagId & 7,
});
export const dbgVarAddr = (t: TargetName, varId: number): number =>
  TARGETS[t].debugAddr + DBG.VARS + varId * 2;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
export const i16 = (v: number): number => {
  const x = v & 0xffff;
  return x >= 0x8000 ? x - 0x10000 : x;
};

export function rgb555(r: number, g: number, b: number): number {
  return (((b >> 3) & 0x1f) << 10) | (((g >> 3) & 0x1f) << 5) | ((r >> 3) & 0x1f);
}

/** Little-endian byte builder used by every compiler stage. */
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
  patchU16(at: number, v: number): this {
    this.buf[at] = v & 0xff;
    this.buf[at + 1] = (v >> 8) & 0xff;
    return this;
  }
  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}
