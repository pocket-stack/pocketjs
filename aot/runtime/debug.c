// aot/runtime/debug.c — mirror game state into the fixed EWRAM debug block
// so the headless mGBA harness can bus-read it.
#include "runtime.h"

#define DBG8(off) (*(volatile u8 *)(PJGB_DEBUG_ADDR + (off)))
#define DBG16(off) (*(volatile u16 *)(PJGB_DEBUG_ADDR + (off)))
#define DBG32(off) (*(volatile u32 *)(PJGB_DEBUG_ADDR + (off)))

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
  for (int i = 0; i < 16; i++)
    *(volatile s16 *)(PJGB_DEBUG_ADDR + DBG_VARS + i * 2) = g.vars[i];
}
