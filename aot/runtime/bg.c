// aot/runtime/bg.c — BG0 tilemap (the world map) + scroll.
#include "runtime.h"

void bg_load_map(void) {
  u16 *sb = SCREENBLOCK(PJ_MAP_SBB);
  for (int cy = 0; cy < 32; cy++) {
    for (int cx = 0; cx < 32; cx++) {
      u16 se;
      if (cx < g.map_w && cy < g.map_h)
        se = SE(g.map_tiles[cy * g.map_w + cx], g.bg_palbank);
      else
        se = SE(0, 0);
      sb[cy * 32 + cx] = se;
    }
  }
}

void bg_set_scroll(void) {
  REG_BG0HOFS = (u16)g.cam_x;
  REG_BG0VOFS = (u16)g.cam_y;
}
