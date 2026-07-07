/* saga/runtime/main.c — fixed frame loop. */
#include "saga.h"

int main(void) {
  video_boot();
  sfx_boot();
  irq_init();
  scene_load(0);
  debug_flush();

  for (;;) {
    input_poll();
    if (g.pending_scene != 0xff) scene_load(g.pending_scene);
    vm_tick();
    tween_step();
    sprites_update();
    caption_update();
    fx_apply();
    sprites_draw();
    meters_draw();
    breakout_draw();
    debug_flush();
    g.frame++;
    frame_wait();
  }
  return 0;
}
