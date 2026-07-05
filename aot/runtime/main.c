// aot/runtime/main.c — the runtime entry point + per-frame game loop.
#include "runtime.h"

// The single definition of the global game state (all other modules extern it).
Game g;

int main(void) {
  cart_load(pjgb_cart);
  g.game = (const GameHeader *)cart_chunk(CHUNK_GAME, 0, 0);

  video_init();
  textbox_init();
  debug_init();

  map_enter(g.game->start_map, g.game->start_x, g.game->start_y, g.game->start_dir);

  for (;;) {
    input_poll();
    vm_tick();
    if (!vm_active()) player_update();
    textbox_tick();
    choice_tick();
    actors_update();
    camera_follow();
    bg_set_scroll();
    obj_reset();
    obj_draw_scene();
    debug_update();
    vblank_wait();
    obj_commit();
    g.frame++;
  }
  return 0;
}
