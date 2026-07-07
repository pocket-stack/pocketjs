/* saga/runtime/debug.c — fixed EWRAM debug block; the E2E contract. */
#include "saga.h"

#define D8(off) (*(vu8 *)(C_DEBUG_ADDR + (off)))
#define D16(off) (*(vu16 *)(C_DEBUG_ADDR + (off)))
#define D32(off) (*(vu32 *)(C_DEBUG_ADDR + (off)))

void debug_flush(void) {
  int i;
  D32(DBGO_MAGIC) = DBG_MAGIC_VAL;
  D8(DBGO_BOOTED) = 1;
  D8(DBGO_SCENE) = g.scene;
  D8(DBGO_WAITING) = g.waiting;
  D8(DBGO_LAST_CHOICE) = (u8)g.last_choice;
  D16(DBGO_FRAME) = g.frame;
  D16(DBGO_CUE_IP) = g.ip;
  D16(DBGO_CAM_X) = (u16)g.fx[TW_CAM_X];
  D16(DBGO_CUR_TEXT) = g.cur_text;
  D16(DBGO_TWEEN_MASK) = g.tween_mask;
  D8(DBGO_CAPTION_BUSY) = g.caption_busy;
  D8(DBGO_FILM_DONE) = g.film_done;
  for (i = 0; i < C_N_VARS; i++) D16(DBGO_VARS + i * 2) = (u16)g.vars[i];
  D16(DBGO_SPR0_X) = (u16)g.spr[0].x;
  D16(DBGO_SPR0_Y) = (u16)g.spr[0].y;
  D8(DBGO_PLAYER_CX) = g.pl_cx;
  D8(DBGO_PLAYER_CY) = g.pl_cy;
  D8(DBGO_PLAYER_DIR) = g.pl_dir;
  D8(DBGO_BRICKS) = breakout_left();
  D8(DBGO_KIND) = g.sc ? g.sc->kind : 0;
}
