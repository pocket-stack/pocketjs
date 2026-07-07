// aot/runtime/shared/map.c — map load, collision, actor lookup.
#include "runtime.h"

void map_enter(int map_id, int tx, int ty, int dir) {
  const u8 *chunk = cart_chunk(CHUNK_MAP, (u32)map_id, 0);
  const MapHeader *mh = (const MapHeader *)chunk;

  g.map_id = (u8)map_id;
  g.map_w = mh->width;
  g.map_h = mh->height;
  g.map_tiles = (const u16 *)(chunk + mh->tiles_off);
  g.map_collision = chunk + mh->collision_off;
  g.actors = (const ActorRec *)(chunk + mh->actors_off);
  g.n_actors = mh->num_actors;
  g.warps = (const WarpRec *)(chunk + mh->warps_off);
  g.n_warps = mh->num_warps;
  g.bg_palbank = mh->bg_palbank;

  for (int i = 0; i < g.n_actors && i < BUDGET_MAX_ACTORS_PER_MAP; i++) {
    g.actor_dir[i] = g.actors[i].facing;
    g.actor_frame[i] = 0;
  }

  g.player.px = tx * 8;
  g.player.py = ty * 8;
  g.player.dir = (u8)dir;
  g.player.moving = 0;
  g.player.anim_frame = 0;
  g.player.anim_timer = 0;
  g.player.sprite_id = 0;

  g.pending_enter = (mh->on_enter == 0xff) ? -1 : (s16)mh->on_enter;

  bg_load_map();
  camera_follow();
  bg_set_scroll();
}

int map_solid(int tx, int ty) {
  if (tx < 0 || ty < 0 || tx >= (int)g.map_w || ty >= (int)g.map_h) return 1;
  if (g.map_collision[ty * g.map_w + tx]) return 1;
  for (int i = 0; i < g.n_actors; i++) {
    if ((g.actors[i].flags & ACTOR_FLAG_SOLID) &&
        g.actors[i].x == tx && g.actors[i].y == ty)
      return 1;
  }
  return 0;
}

int map_actor_at(int tx, int ty) {
  for (int i = 0; i < g.n_actors; i++) {
    if (g.actors[i].x == tx && g.actors[i].y == ty) return i;
  }
  return -1;
}
