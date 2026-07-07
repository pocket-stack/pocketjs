/* saga/runtime/video.c — boot video state + whole-scene VRAM loads.
 * Scene loads happen behind force-blank (the author fades/mosaics out first),
 * so we can DMA palettes, three tile sets, four tilemaps and the OBJ sheets
 * in one go without fighting the PPU. */
#include "saga.h"

Saga g;

static void bgcnt_setup(u8 map_sz) {
  u16 sz = map_sz == 2 ? BG_SIZE_64x64 : map_sz == 1 ? BG_SIZE_64x32 : BG_SIZE_32x32;
  REG_BGCNT(0) = BG_4BPP | BG_PRIO(0) | BG_CBB(C_CBB_SHARED) | BG_SBB(C_SBB_UI) | BG_SIZE_32x32;
  REG_BGCNT(1) = BG_4BPP | BG_PRIO(2) | BG_CBB(C_CBB_MAIN) | BG_SBB(C_SBB_MAIN) | BG_MOSAIC | sz;
  REG_BGCNT(2) = BG_4BPP | BG_PRIO(3) | BG_CBB(C_CBB_SHARED) | BG_SBB(C_SBB_FAR) | BG_MOSAIC | BG_SIZE_32x32;
  REG_BGCNT(3) = BG_4BPP | BG_PRIO(3) | BG_CBB(C_CBB_SHARED) | BG_SBB(C_SBB_SKY) | BG_SIZE_32x32;
}

void video_boot(void) {
  REG_DISPCNT = DCNT_FORCE_BLANK;
  /* fixed UI BG tiles at shared-charblock 0..3 (blank/box/accent/cursor) */
  dma3_copy32(CHARBLOCK(C_CBB_SHARED), film.ui_bg_tiles, (4 * 32) / 4);
  /* built-in UI OBJ sheet (A prompt + digits + meter/breakout) at the top */
  dma3_copy32(OBJ_VRAM + C_OBJ_UI_BASE * 16, film.ui_obj_tiles, film.ui_obj_bytes / 4);
  bgcnt_setup(0);
  g.pending_scene = 0xff;
  g.last_choice = -1;
  g.rng = 0xbeef;
}

static void fill_map(u16 *sb, u16 se, u32 count) {
  u32 i;
  u32 v = se | ((u32)se << 16);
  for (i = 0; i < count / 2; i++) ((u32 *)sb)[i] = v;
}

void scene_load(u8 id) {
  const SagaScene *sc = &film.scenes[id];
  int i;

  REG_DISPCNT = DCNT_FORCE_BLANK;
  g.scene = id;
  g.sc = sc;
  g.pending_scene = 0xff;
  g.frame = 0;

  /* palettes (backdrop entry 0 is raster-owned; keep a copy) */
  dma3_copy32(BG_PAL, sc->pal_bg, 512 / 4);
  dma3_copy32(OBJ_PAL, sc->pal_obj, 512 / 4);

  /* tiles */
  if (sc->n_main) dma3_copy32(CHARBLOCK(C_CBB_MAIN), sc->tiles_main, ((u32)sc->n_main * 32) / 4);
  if (sc->n_shared)
    dma3_copy32(CHARBLOCK(C_CBB_SHARED) + C_FARSKY_BASE * 16, sc->tiles_shared, ((u32)sc->n_shared * 32) / 4);
  /* clear glyph slots */
  {
    u32 *gz = (u32 *)(CHARBLOCK(C_CBB_SHARED) + C_GLYPH_SLOT_BASE * 16);
    for (i = 0; i < (C_GLYPH_SLOTS * 2 * 32) / 4; i++) gz[i] = 0;
  }

  /* maps. map_sz 2 = 64x64: four consecutive screenblocks starting at
   * SBB_MAIN (TL,TR,BL,BR), which covers the far/sky blocks — no parallax
   * layers in world scenes. */
  if (sc->map_sz == 2) {
    dma3_copy32(SCREENBLOCK(C_SBB_MAIN), sc->map_main, 0x2000 / 4);
  } else {
    dma3_copy32(SCREENBLOCK(C_SBB_MAIN), sc->map_main, (sc->map_sz ? 0x1000u : 0x800u) / 4);
    if (sc->map_far) dma3_copy32(SCREENBLOCK(C_SBB_FAR), sc->map_far, 0x800 / 4);
    else fill_map(SCREENBLOCK(C_SBB_FAR), 0, 0x400);
    if (sc->map_sky) dma3_copy32(SCREENBLOCK(C_SBB_SKY), sc->map_sky, 0x800 / 4);
    else fill_map(SCREENBLOCK(C_SBB_SKY), 0, 0x400);
  }
  fill_map(SCREENBLOCK(C_SBB_UI), 0, 0x400);

  /* OBJ sheets (below the persistent UI sheet) */
  if (sc->obj_bytes) dma3_copy32(OBJ_VRAM, sc->obj_tiles, sc->obj_bytes / 4);

  bgcnt_setup(sc->map_sz);

  /* world + fx reset */
  fx_reset();
  g.fx[TW_CAM_X] = sc->cam0;
  g.fx[TW_LETTERBOX] = sc->letterbox0;
  g.fx[TW_BLDY] = 16; /* scenes wake up faded out; the cue's FADE reveals */
  g.raster_mode = sc->raster_mode;
  if (sc->raster_mode == C_RASTER_WAVE_MAIN || sc->raster_mode == C_RASTER_WAVE_FAR)
    g.fx[TW_WAVE_AMP] = sc->raster_amp;

  for (i = 0; i < C_MAX_SPRITES; i++) g.spr[i].active = 0;
  for (i = 0; i < 128; i++) oam_shadow[i].attr0 = ATTR0_HIDE;
  g.counter_show = 0;
  g.counter_bounce = 0;
  g.prompt_on = 0;
  g.meter_on[0] = g.meter_on[1] = 0;
  g.wk_active = 0;
  g.in_sub = 0;
  g.trig_seen = 0;
  g.pl_step = 0;
  g.cam_max_x = sc->cam_max;
  g.cam_max_y = 0;

  /* world scenes wake up populated: player + NPCs stand on their cells so the
   * author's fade-in reveals a living room, before OP_WORLD hands over input */
  if (sc->kind == C_SCENE_WORLD && sc->world) {
    const SagaWorld *w = sc->world;
    g.cam_max_x = (s16)(w->cols * C_CELL_PX - 240);
    g.cam_max_y = (s16)(w->rows * C_CELL_PX - 160);
    if (g.cam_max_x < 0) g.cam_max_x = 0;
    if (g.cam_max_y < 0) g.cam_max_y = 0;
    {
      Spr *s = &g.spr[w->player_slot];
      s->active = 1;
      s->proto = w->player_proto;
      s->mode = 0;
      s->frame = 0;
      s->timer = 0;
      s->flags = 0;
      s->affine = 0;
      s->fps = sc->protos[s->proto].fps;
    }
    world_warp(w->start_cx, w->start_cy, w->start_dir);
    for (i = 0; i < w->n_npcs; i++) {
      const SagaNpc *n = &w->npcs[i];
      Spr *s = &g.spr[n->slot];
      s->active = 1;
      s->proto = n->proto;
      s->mode = 0;
      s->frame = 0;
      s->timer = 0;
      s->flags = 0;
      s->affine = 0;
      s->x = (s16)(n->cx * C_CELL_PX + (C_CELL_PX - sc->protos[s->proto].w) / 2);
      s->y = (s16)((n->cy + 1) * C_CELL_PX - sc->protos[s->proto].h);
      s->fps = sc->protos[s->proto].fps;
      world_face(n->slot, n->dir);
    }
  }

  caption_boot();

  /* cue vm */
  g.ip = 0;
  g.sp = 0;
  g.waiting = WAITING_RUN;
  g.wait_frames = 0;
  g.cur_text = 0;

  fx_apply(); /* also re-enables the display */
}
