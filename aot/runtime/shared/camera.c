// aot/runtime/shared/camera.c — follow the player, clamped to the map bounds.
#include "runtime.h"

static s32 clampi(s32 v, s32 lo, s32 hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

void camera_follow(void) {
  s32 max_x = (s32)g.map_w * 8 - PJGB_SCREEN_W;
  s32 max_y = (s32)g.map_h * 8 - PJGB_SCREEN_H;
  if (max_x < 0) max_x = 0; // map narrower than the screen -> pin to 0
  if (max_y < 0) max_y = 0;

  g.cam_x = clampi(g.player.px + 4 - PJGB_SCREEN_W / 2, 0, max_x);
  g.cam_y = clampi(g.player.py + 4 - PJGB_SCREEN_H / 2, 0, max_y);
}
