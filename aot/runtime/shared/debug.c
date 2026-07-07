// aot/runtime/shared/debug.c — mirror game state into the debug block.
//
// On the tile targets the block lives at a fixed bus address the emulator
// can read. The pj_frame-based cores keep it in an exported buffer instead: the host
// harness reads it through pj_debug_block(), translating scenario addresses
// as (addr - PJGB_DEBUG_ADDR). Layout is byte-identical to every other
// target (spec/pjgb.ts DBG).
#include "runtime.h"

// Non-static and distinctively named: the emulator harness locates this
// buffer in the .elf symbol table (arm-none-eabi-nm) to bus-read the block
// through Azahar/Citra's UDP scripting interface.
u8 pj_debug_ram[PJGB_DEBUG_BLOCK_SIZE];
#define dbg pj_debug_ram

const u8 *pj_debug_block(void) { return dbg; }

#define DBG8(off) (*(u8 *)(dbg + (off)))
#define DBG16(off) (*(u16 *)(dbg + (off)))
#define DBG32(off) (*(u32 *)(dbg + (off)))

void debug_init(void) {
  DBG32(DBG_MAGIC) = DEBUG_MAGIC;
  DBG8(DBG_BOOTED) = 1;
}

void debug_update(void) {
  DBG32(DBG_MAGIC) = DEBUG_MAGIC;
  DBG16(DBG_PLAYER_X) = (u16)(g.player.px >> 3);
  DBG16(DBG_PLAYER_Y) = (u16)(g.player.py >> 3);
  DBG8(DBG_PLAYER_DIR) = g.player.dir;
  DBG8(DBG_CUR_MAP) = g.map_id;
  DBG8(DBG_TEXT_ACTIVE) = g.text_active;
  DBG8(DBG_SCRIPT_ACTIVE) = (u8)vm_active();
  DBG32(DBG_FRAME) = g.frame;
  DBG16(DBG_CUR_TEXT) = g.text_active ? g.cur_text : 0xFFFF;
  DBG8(DBG_CHOICE_CURSOR) = g.choice_cursor;
  DBG8(DBG_BOOTED) = 1;
  for (int i = 0; i < 16; i++) DBG8(DBG_FLAGS + i) = g.flags[i];
  for (int i = 0; i < 16; i++) *(s16 *)(dbg + DBG_VARS + i * 2) = g.vars[i];
}
