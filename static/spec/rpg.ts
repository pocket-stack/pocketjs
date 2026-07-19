// static/spec/rpg.ts — the RPG category contract: syscall opcodes 0x40+ and
// the binary record layouts of the RPG game model. Extends spec/isa.ts; the
// same derivation rules apply (compiler encodes, gen/spec_gen.h keeps C
// honest, vm/ref.ts + rpg host stubs interpret on the host).
//
// A category is: syscalls + records + budgets + a portable runtime module.
// This file is the whole binary surface of the RPG category.

import { SYSCALL_BASE } from "./isa.ts";

// ---------------------------------------------------------------------------
// Syscalls (0x40..). Blocking ops SUSPEND the VM; value ops push a result.
// ---------------------------------------------------------------------------
export const RPG_OP = {
  SAY: SYSCALL_BASE + 0x00, //    u16 textId       page up, SUSPEND until A
  CHOICE: SYSCALL_BASE + 0x01, // u8 n, u16 t0..   menu, SUSPEND, push index
  LOCK: SYSCALL_BASE + 0x02, //                    player input off (movement)
  RELEASE: SYSCALL_BASE + 0x03, //                 player input on
  FACE: SYSCALL_BASE + 0x04, //   u8 slot          actor faces the player; 0xFF = the actor that started this script
  AVIS: SYSCALL_BASE + 0x05, //   u8 slot, u8 on   actor visible/hidden (hidden = no draw, no collide, no talk)
  WARP: SYSCALL_BASE + 0x06, //   u8 map, u8 x, u8 y, u8 dir   move player (loads map if different)
  SFX: SYSCALL_BASE + 0x07, //    u8 id            square-wave blip (SFX.*)
} as const;

export const RPG_OP_OPERANDS: Record<number, number> = {
  [RPG_OP.SAY]: 2,
  [RPG_OP.CHOICE]: -1, // variable: 1 + 2*n
  [RPG_OP.LOCK]: 0,
  [RPG_OP.RELEASE]: 0,
  [RPG_OP.FACE]: 1,
  [RPG_OP.AVIS]: 2,
  [RPG_OP.WARP]: 4,
  [RPG_OP.SFX]: 1,
};

export const FACE_SELF = 0xff;

export const SFX = {
  CONFIRM: 0,
  DENY: 1,
  DAMAGE: 2,
  HEAL: 3,
  FANFARE: 4,
} as const;
export type SfxName = keyof typeof SFX;

// ---------------------------------------------------------------------------
// Directions / movement
// ---------------------------------------------------------------------------
export const DIR = { DOWN: 0, UP: 1, LEFT: 2, RIGHT: 3 } as const;
export type DirName = "down" | "up" | "left" | "right";
export const DIR_BY_NAME: Record<DirName, number> = { down: 0, up: 1, left: 2, right: 3 };
export const DIR_DX = [0, 0, -1, 1] as const;
export const DIR_DY = [1, -1, 0, 0] as const;

export const MOVE = { STATIC: 0, WANDER: 1 } as const;
export type MoveName = "static" | "wander";
// Wander cadence: an actor attempts one random step every WANDER_PERIOD
// frames (per-slot phase offset = slot * WANDER_PHASE), using its own tiny
// LCG so gameplay RNG (OP.RND) stays script-deterministic.
export const WANDER_PERIOD = 96;
export const WANDER_PHASE = 17;

// Player/actor movement: 8px logical grid, 2px per frame => 4 frames per
// tile step. Walk animation flips frame every 8px moved.
export const STEP_PX = 2;

// ---------------------------------------------------------------------------
// Game header (fixed region, GAME_HEADER_SIZE bytes)
//   0  u8[16] title (ascii, null-padded; also feeds cart headers)
//   16 u8  start_map
//   17 u8  start_x        (tile)
//   18 u8  start_y
//   19 u8  start_dir
//   20 u8  map_count
//   21 u8  sprite_count
//   22 u16 text_count
//   24 u16 script_count
//   26 u8  player_sprite
//   27 u8  reserved
// = 28 bytes
// ---------------------------------------------------------------------------
export const GAME_TITLE_LEN = 16;
export const GAME_HEADER_SIZE = 28;

// ---------------------------------------------------------------------------
// Map blob (one BLOB_KIND.MAP per map). Header, then tables; *_off relative
// to blob start.
//   0  u8  width          (tiles)
//   1  u8  height
//   2  u8  actor_count
//   3  u8  warp_count
//   4  u8  trigger_count
//   5  u8  reserved
//   6  u16 on_enter       (script id, 0xFFFF = none; runs on map load)
//   8  u16 tiles_off      -> u8[w*h] tile ids (row-major)
//   10 u16 collision_off  -> u8[ceil(w*h/8)] solidity bitset (bit = x + y*w)
//   12 u16 actors_off     -> Actor[actor_count]
//   14 u16 warps_off      -> Warp[warp_count]
//   16 u16 triggers_off   -> Trigger[trigger_count]
//   18 u16 reserved
// = 20 bytes
// ---------------------------------------------------------------------------
export const MAP_HEADER_SIZE = 20;

// Actor (8 bytes):
//   0 u8  x   (tile)
//   1 u8  y
//   2 u8  sprite_id
//   3 u8  facing        DIR.*
//   4 u8  move          MOVE.*
//   5 u8  flags         ACTOR_F.* (SOLID | HIDDEN)
//   6 u16 on_talk       script id, 0xFFFF = none
export const ACTOR_SIZE = 8;
export const ACTOR_F = { SOLID: 1, HIDDEN: 2 } as const;
export const MAX_ACTORS_PER_MAP = 16;

// Warp (6 bytes): stepping onto (x,y) relocates the player.
//   0 u8 x
//   1 u8 y
//   2 u8 dest_map
//   3 u8 dest_x
//   4 u8 dest_y
//   5 u8 dest_dir
export const WARP_SIZE = 6;

// Trigger (6 bytes): stepping onto (x,y) runs a script.
//   0 u8  x
//   1 u8  y
//   2 u16 script        (0xFFFF = none)
//   4 u8  flags         TRIGGER_F.*
//   5 u8  once_flag     (flag id armed when TRIGGER_F.ONCE; skip if set)
export const TRIGGER_SIZE = 6;
export const TRIGGER_F = { ONCE: 1 } as const;

export const SCRIPT_NONE = 0xffff;
export const TEXT_NONE = 0xffff;

// ---------------------------------------------------------------------------
// Sprites — 16x16 actors, 4 facings, 1..2 walk frames per facing.
// Sprite table entry (4 bytes), OBJ tiles indexed in 8x8 units:
//   0 u16 tile_base   (facing/frame block: dir*frames + frame, 4 tiles each,
//                      order TL,TR,BL,BR)
//   2 u8  frames      (1 or 2)
//   3 u8  palette     (OBJ palette bank / NES OBJ subpalette)
// LEFT renders as RIGHT h-flipped via OAM attributes on every target (GBA
// OBJ attr, GB OAM flags, NES OAM byte 2 — all have H-flip bits).
// Facing order in tile data: DOWN, UP, RIGHT. The per-frame TILE ORDER is
// target-chosen by the packager (GBA 1D: TL,TR,BL,BR; GB/NES 8x16 pairs:
// TL,BL,TR,BR) — tile_base counts in that native order.
// ---------------------------------------------------------------------------
export const SPRITE_ENTRY_SIZE = 4;
export const SPRITE_PX = 16;
export const SPRITE_FACINGS = 3; // DOWN, UP, RIGHT (LEFT mirrors RIGHT)
export const SPRITE_TILES_PER_FRAME = 4;

// ---------------------------------------------------------------------------
// Budgets (compile-time errors)
// ---------------------------------------------------------------------------
export const RPG_BUDGET = {
  MAX_MAPS: 32,
  MAX_SPRITES: 12,
  MAX_TEXTS: 512,
  MAX_SCRIPTS: 256,
  MAX_SCRIPT_BLOB: 0x4000, // one bank
  MAX_TEXT_BLOB: 0x4000, // per TEXT blob; the compiler splits
  MAX_TILESET_TILES: 158, // shared GB/NES ceiling; GBA checked separately
} as const;
