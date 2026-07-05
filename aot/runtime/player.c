// aot/runtime/player.c — grid movement, collision, and A-to-interact.
#include "runtime.h"

#define SPEED 2   // pixels per frame while sliding between tiles
#define ANIM_RATE 6

// Indexed by DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT.
static const int DX[4] = {0, 0, -1, 1};
static const int DY[4] = {1, -1, 0, 0};

void player_update(void) {
  Player *p = &g.player;

  // Decide a new action only when standing still (and not script-locked).
  if (!p->moving && !p->locked) {
    // A pressed (edge) -> interact with the tile we face.
    if (key_pressed(KEY_A)) {
      int tx = (int)(p->px >> 3), ty = (int)(p->py >> 3);
      int fx = tx + DX[p->dir], fy = ty + DY[p->dir];
      int slot = map_actor_at(fx, fy);
      if (slot >= 0 && g.actors[slot].on_talk != PJGB_SCRIPT_NONE) {
        vm_start(g.actors[slot].on_talk, slot);
        return;
      }
    }

    // Directional input: always turn, move if the target tile is free.
    int dir = -1;
    if (key_held(KEY_DOWN)) dir = DIR_DOWN;
    else if (key_held(KEY_UP)) dir = DIR_UP;
    else if (key_held(KEY_LEFT)) dir = DIR_LEFT;
    else if (key_held(KEY_RIGHT)) dir = DIR_RIGHT;

    if (dir >= 0) {
      p->dir = (u8)dir;
      int nx = (int)(p->px >> 3) + DX[dir];
      int ny = (int)(p->py >> 3) + DY[dir];
      if (!map_solid(nx, ny)) p->moving = 1;
    }
  }

  // Slide toward the target tile; land exactly on the 8px grid.
  if (p->moving) {
    p->px += DX[p->dir] * SPEED;
    p->py += DY[p->dir] * SPEED;
    if (++p->anim_timer >= ANIM_RATE) {
      p->anim_timer = 0;
      p->anim_frame++;
    }
    if ((p->px & 7) == 0 && (p->py & 7) == 0) {
      p->moving = 0;
      // Stepping onto a warp tile transports the player.
      int tx = (int)(p->px >> 3), ty = (int)(p->py >> 3);
      for (int i = 0; i < g.n_warps; i++) {
        if (g.warps[i].x == tx && g.warps[i].y == ty) {
          const WarpRec *w = &g.warps[i];
          map_enter(w->dest_map, w->dest_x, w->dest_y, w->dest_dir);
          return;
        }
      }
    }
  }
}
