// aot/runtime/shared/core.c — the embeddable frame interface + game state.
//
// One pj_frame(keys) call = one 60 Hz tick, mirroring the GBA main loop
// body order exactly (input -> deferred on-enter -> vm -> player -> textbox
// -> choice -> actors -> camera -> render -> debug). Every device shell and
// the host E2E harness drive the game only through this file.
#include "runtime.h"

// The single definition of the global game state (all other modules extern it).
Game g;

void pj_init(void) {
  cart_load(pjgb_cart);
  g.game = (const GameHeader *)cart_chunk(CHUNK_GAME, 0, 0);

  render_init(); // device: VRAM banks + engine setup + glyph/tile upload
  textbox_init();
  debug_init();

  g.pending_enter = -1;
  map_enter(g.game->start_map, g.game->start_x, g.game->start_y, g.game->start_dir);
  render_frame(); // a screenshot before the first tick shows the spawn, not garbage
}

void pj_frame(u32 keys) {
  g.keys_prev = g.keys;
  g.keys = (u16)(keys & 0x3ff);

  // A map's on-enter script starts as soon as no other script is running.
  if (!vm_active() && g.pending_enter >= 0) {
    int sid = g.pending_enter;
    g.pending_enter = -1;
    vm_start(sid, -1);
  }
  vm_tick();
  if (!vm_active()) player_update();
  textbox_tick();
  choice_tick();
  actors_update();
  camera_follow();
  render_frame();
  debug_update();
  g.frame++;
}

int key_held(int mask) { return (g.keys & mask) != 0; }

int key_pressed(int mask) {
  return (g.keys & mask) != 0 && (g.keys_prev & mask) == 0;
}
