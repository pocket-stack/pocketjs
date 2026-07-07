/* saga/runtime/world.c — top-down grid world: Pokémon-style cell stepping,
 * facing/interaction, exit/auto triggers, soft camera follow on both axes,
 * and scripted grid walks for cutscenes. Active while the cue VM is parked
 * in WAITING_WORLD (OP_WORLD) or during OP_WALK (WAITING_BUSY + wk_active). */
#include "saga.h"

static const s8 DX[4] = {0, 0, -1, 1}; /* DOWN, UP, LEFT, RIGHT */
static const s8 DY[4] = {1, -1, 0, 0};

static const SagaWorld *wld(void) {
  return g.sc->world;
}

/* place a sprite's top-left so its feet stand on cell (cx,cy) */
static void place_on_cell(Spr *s, u8 cx, u8 cy) {
  const SagaProto *p = &g.sc->protos[s->proto];
  s->x = (s16)(cx * C_CELL_PX + (C_CELL_PX - p->w) / 2);
  s->y = (s16)((cy + 1) * C_CELL_PX - p->h);
}

/* facing for walker protos: rows DOWN/UP/SIDE, right = SIDE hflipped */
void world_face(u8 slot, u8 dir) {
  Spr *s = &g.spr[slot];
  const SagaProto *p = &g.sc->protos[s->proto];
  u8 row;
  if (!p->walk_fpd) return;
  row = (dir == C_DIR_DOWN) ? C_WALK_ROW_DOWN : (dir == C_DIR_UP) ? C_WALK_ROW_UP : C_WALK_ROW_SIDE;
  s->mode = 0;
  s->frame = (u8)(row * p->walk_fpd);
  if (dir == C_DIR_RIGHT) s->flags |= C_SPR_HFLIP;
  else s->flags &= (u8)~C_SPR_HFLIP;
  if (g.sc->world && slot == g.sc->world->player_slot) g.pl_dir = dir;
}

static void camera_snap(void) {
  const SagaWorld *w = wld();
  Spr *s = &g.spr[w->player_slot];
  const SagaProto *p = &g.sc->protos[s->proto];
  s16 tx = (s16)(s->x + p->w / 2 - 120);
  s16 ty = (s16)(s->y + p->h / 2 - 80);
  if (tx < 0) tx = 0;
  if (tx > g.cam_max_x) tx = g.cam_max_x;
  if (ty < 0) ty = 0;
  if (ty > g.cam_max_y) ty = g.cam_max_y;
  g.fx[TW_CAM_X] = tx;
  g.fx[TW_CAM_Y] = ty;
}

static void camera_follow(void) {
  const SagaWorld *w = wld();
  Spr *s = &g.spr[w->player_slot];
  const SagaProto *p = &g.sc->protos[s->proto];
  s16 tx = (s16)(s->x + p->w / 2 - 120);
  s16 ty = (s16)(s->y + p->h / 2 - 80);
  if (tx < 0) tx = 0;
  if (tx > g.cam_max_x) tx = g.cam_max_x;
  if (ty < 0) ty = 0;
  if (ty > g.cam_max_y) ty = g.cam_max_y;
  g.fx[TW_CAM_X] += (s16)((tx - g.fx[TW_CAM_X]) >> 3);
  g.fx[TW_CAM_Y] += (s16)((ty - g.fx[TW_CAM_Y]) >> 3);
}

void world_warp(u8 cx, u8 cy, u8 dir) {
  const SagaWorld *w = wld();
  Spr *s;
  if (!w) return;
  s = &g.spr[w->player_slot];
  g.pl_cx = cx;
  g.pl_cy = cy;
  g.pl_step = 0;
  place_on_cell(s, cx, cy);
  world_face(w->player_slot, dir);
  camera_snap();
}

static u8 npc_at(u8 cx, u8 cy, const SagaNpc **out) {
  const SagaWorld *w = wld();
  int i;
  for (i = 0; i < w->n_npcs; i++) {
    if (w->npcs[i].cx == cx && w->npcs[i].cy == cy) {
      if (out) *out = &w->npcs[i];
      return 1;
    }
  }
  return 0;
}

static const SagaTrig *trig_at(u8 cx, u8 cy, u8 kind) {
  const SagaWorld *w = wld();
  int i;
  for (i = 0; i < w->n_trigs; i++) {
    const SagaTrig *t = &w->trigs[i];
    if (t->kind == kind && cx >= t->cx && cx < t->cx + t->w && cy >= t->cy && cy < t->cy + t->h)
      return t;
  }
  return 0;
}

static u8 blocked(s16 cx, s16 cy) {
  const SagaWorld *w = wld();
  const SagaNpc *n;
  if (cx < 0 || cy < 0 || cx >= w->cols || cy >= w->rows) return 1;
  if (w->solid[cy * w->cols + cx]) return 1;
  if (npc_at((u8)cx, (u8)cy, &n) && n->solid) return 1;
  return 0;
}

/* walk-cycle frame while moving: fpd 1 -> waddle (hflip toggle on down/up),
 * fpd 2 -> alternate, fpd 3 -> step-stand-step-stand, fpd 4+ -> full cycle */
static void anim_step(u8 slot, u8 dir) {
  Spr *s = &g.spr[slot];
  const SagaProto *p = &g.sc->protos[s->proto];
  u8 row = (dir == C_DIR_DOWN) ? C_WALK_ROW_DOWN : (dir == C_DIR_UP) ? C_WALK_ROW_UP : C_WALK_ROW_SIDE;
  u8 ph = (u8)((g.anim_phase >> 3) & 3);
  if (!p->walk_fpd) return;
  if (p->walk_fpd >= 4) {
    s->frame = (u8)(row * p->walk_fpd + ((g.anim_phase >> 2) & 3));
  } else if (p->walk_fpd == 3) {
    static const u8 pat[4] = {1, 0, 2, 0};
    s->frame = (u8)(row * p->walk_fpd + pat[ph]);
  } else if (p->walk_fpd == 2) {
    s->frame = (u8)(row * p->walk_fpd + (ph & 1));
  } else {
    s->frame = (u8)(row);
    if (dir == C_DIR_DOWN || dir == C_DIR_UP) {
      if (ph & 1) s->flags |= C_SPR_HFLIP;
      else s->flags &= (u8)~C_SPR_HFLIP;
    }
  }
  if (dir == C_DIR_RIGHT) s->flags |= C_SPR_HFLIP;
  else if (dir == C_DIR_LEFT) s->flags &= (u8)~C_SPR_HFLIP;
}

/* one frame of a 16px step in flight; returns 1 when it just finished */
static u8 step_advance(void) {
  const SagaWorld *w = wld();
  Spr *s = &g.spr[w->player_slot];
  s->x += g.pl_dx;
  s->y += g.pl_dy;
  g.anim_phase++;
  anim_step(w->player_slot, g.pl_dir);
  if (--g.pl_step == 0) {
    g.pl_cx = (u8)((s16)g.pl_cx + DX[g.pl_dir]);
    g.pl_cy = (u8)((s16)g.pl_cy + DY[g.pl_dir]);
    place_on_cell(s, g.pl_cx, g.pl_cy); /* snap out drift */
    return 1;
  }
  return 0;
}

void world_enter(void) {
  if (!wld()) return;
  g.waiting = WAITING_WORLD;
}

void world_service(void) {
  const SagaWorld *w = wld();
  Spr *s;
  if (!w) {
    g.waiting = WAITING_RUN;
    return;
  }
  s = &g.spr[w->player_slot];

  if (g.pl_step) {
    if (step_advance()) {
      const SagaTrig *t;
      /* landed on a cell: exits end the roam, autos run their cue once */
      if ((t = trig_at(g.pl_cx, g.pl_cy, C_TRIG_EXIT)) != 0) {
        world_face(w->player_slot, g.pl_dir);
        vm_push(t->value);
        g.waiting = WAITING_RUN;
        return;
      }
      if ((t = trig_at(g.pl_cx, g.pl_cy, C_TRIG_AUTO)) != 0) {
        u8 bit = (u8)(t - w->trigs);
        if (!(g.trig_seen & (1u << bit))) {
          g.trig_seen |= (u16)(1u << bit);
          world_face(w->player_slot, g.pl_dir);
          vm_run_sub(t->cue);
          return;
        }
      }
    }
  } else {
    /* idle on a cell */
    u8 dir = 0xff;
    if (key_held(KEY_DOWN)) dir = C_DIR_DOWN;
    else if (key_held(KEY_UP)) dir = C_DIR_UP;
    else if (key_held(KEY_LEFT)) dir = C_DIR_LEFT;
    else if (key_held(KEY_RIGHT)) dir = C_DIR_RIGHT;

    if (key_pressed(KEY_A)) {
      s16 fx = (s16)g.pl_cx + DX[g.pl_dir];
      s16 fy = (s16)g.pl_cy + DY[g.pl_dir];
      const SagaNpc *n;
      const SagaTrig *t;
      if (fx >= 0 && fy >= 0 && fx < w->cols && fy < w->rows && npc_at((u8)fx, (u8)fy, &n) &&
          n->cue != 0xff) {
        /* NPC turns to the player */
        static const u8 OPP[4] = {C_DIR_UP, C_DIR_DOWN, C_DIR_RIGHT, C_DIR_LEFT};
        world_face(n->slot, OPP[g.pl_dir]);
        sfx_play(C_SFX_BLIP);
        vm_run_sub(n->cue);
        return;
      }
      if (fx >= 0 && fy >= 0 && (t = trig_at((u8)fx, (u8)fy, C_TRIG_EXAMINE)) != 0 && t->cue != 0xff) {
        sfx_play(C_SFX_BLIP);
        vm_run_sub(t->cue);
        return;
      }
    }

    if (dir != 0xff) {
      s16 tx = (s16)g.pl_cx + DX[dir];
      s16 ty = (s16)g.pl_cy + DY[dir];
      if (dir != g.pl_dir) world_face(w->player_slot, dir);
      if (!blocked(tx, ty)) {
        g.pl_step = C_STEP_FRAMES;
        g.pl_dx = (s8)(DX[dir] * (C_CELL_PX / C_STEP_FRAMES));
        g.pl_dy = (s8)(DY[dir] * (C_CELL_PX / C_STEP_FRAMES));
      } else {
        anim_step(w->player_slot, dir); /* bump-walk in place */
        g.anim_phase++;
      }
    } else {
      /* stand */
      world_face(w->player_slot, g.pl_dir);
    }
  }

  camera_follow();
}

/* --- scripted walks (OP_WALK, any walker sprite, cutscenes) -------------------- */
void walk_start(u8 slot, u8 cx, u8 cy) {
  const SagaProto *p = &g.sc->protos[g.spr[slot].proto];
  g.wk_active = 1;
  g.wk_slot = slot;
  g.wk_tx = (s16)(cx * C_CELL_PX + (C_CELL_PX - p->w) / 2);
  g.wk_ty = (s16)((cy + 1) * C_CELL_PX - p->h);
}

u8 walk_service(void) {
  Spr *s = &g.spr[g.wk_slot];
  u8 dir;
  s16 d;
  if (!g.wk_active) return 0;
  if (s->x != g.wk_tx) {
    d = (s16)(g.wk_tx - s->x);
    dir = d > 0 ? C_DIR_RIGHT : C_DIR_LEFT;
    s->x += d > 0 ? (d > 2 ? 2 : d) : (d < -2 ? -2 : d);
  } else if (s->y != g.wk_ty) {
    d = (s16)(g.wk_ty - s->y);
    dir = d > 0 ? C_DIR_DOWN : C_DIR_UP;
    s->y += d > 0 ? (d > 2 ? 2 : d) : (d < -2 ? -2 : d);
  } else {
    const SagaWorld *w = g.sc->world;
    g.wk_active = 0;
    if (w && g.wk_slot == w->player_slot) {
      g.pl_cx = (u8)((s->x + g.sc->protos[s->proto].w / 2) / C_CELL_PX);
      g.pl_cy = (u8)((s->y + g.sc->protos[s->proto].h - 1) / C_CELL_PX);
      world_face(g.wk_slot, g.pl_dir);
      camera_snap();
    } else {
      world_face(g.wk_slot, C_DIR_DOWN);
    }
    return 0;
  }
  g.anim_phase++;
  anim_step(g.wk_slot, dir);
  if (g.sc->world && g.wk_slot == g.sc->world->player_slot) camera_follow();
  return 1;
}
