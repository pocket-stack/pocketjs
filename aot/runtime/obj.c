// aot/runtime/obj.c — sprite (OBJ) rendering via a shadow OAM buffer.
#include "runtime.h"

static ObjAttr shadow[128];

void obj_reset(void) {
  for (int i = 0; i < 128; i++) shadow[i].attr0 = ATTR0_HIDE;
}

void obj_commit(void) {
  dma3_copy32(OAM, shadow, sizeof(shadow) / 4);
}

void obj_put(int slot, int sx, int sy, int tile, int palbank) {
  if (slot < 0 || slot >= 128) return;
  ObjAttr *o = &shadow[slot];
  o->attr0 = ATTR0_Y(sy) | ATTR0_SQUARE | ATTR0_4BPP;
  o->attr1 = ATTR1_X(sx) | ATTR1_SIZE_16;
  o->attr2 = ATTR2_TILE(tile) | ATTR2_PALBANK(palbank) | ATTR2_PRIO(0);
  o->fill = 0;
}

// A 16x16 tile-occupant's sprite tile for a facing/frame.
static int sprite_tile(const SpriteRec *sp, int dir, int frame) {
  int frames = sp->frames ? sp->frames : 1;
  return sp->tile_base + dir * (frames * 4) + (frame % frames) * 4;
}

// Fully offscreen (sprite spans [s, s+16) on each axis)?
static int offscreen(int sx, int sy) {
  return sx + 16 <= 0 || sx >= PJGB_SCREEN_W || sy + 16 <= 0 || sy >= PJGB_SCREEN_H;
}

void obj_draw_scene(void) {
  const SpriteRec *table = (const SpriteRec *)cart_chunk(CHUNK_SPRITE_TABLE, 0, 0);

  // Player -> slot 0.
  {
    const SpriteRec *sp = &table[g.player.sprite_id];
    int sx = (int)g.player.px - (int)g.cam_x - 4;
    int sy = (int)g.player.py - (int)g.cam_y - 8;
    if (!offscreen(sx, sy)) {
      int frames = sp->frames ? sp->frames : 1;
      int tile = sprite_tile(sp, g.player.dir, g.player.anim_frame % frames);
      obj_put(0, sx, sy, tile, sp->palbank);
    }
  }

  // Actors -> slots 1..n.
  for (int i = 0; i < g.n_actors && i < BUDGET_MAX_ACTORS_PER_MAP; i++) {
    const ActorRec *a = &g.actors[i];
    if (a->sprite == 0xff) continue; // 0xFF = no sprite (e.g. a sign)
    const SpriteRec *sp = &table[a->sprite];
    int wx = a->x * 8, wy = a->y * 8;
    int sx = wx - (int)g.cam_x - 4;
    int sy = wy - (int)g.cam_y - 8;
    if (offscreen(sx, sy)) continue;
    int tile = sprite_tile(sp, g.actor_dir[i], g.actor_frame[i]);
    obj_put(1 + i, sx, sy, tile, sp->palbank);
  }
}
