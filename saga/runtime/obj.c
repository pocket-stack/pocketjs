/* saga/runtime/obj.c — scene sprites, the var-bound digit counter HUD, and the
 * blinking A prompt. Everything draws into oam_shadow; the VBlank ISR DMAs it. */
#include "saga.h"

#define UI_TILE_PROMPT (C_OBJ_UI_BASE)
#define UI_TILE_DIGIT(d) (C_OBJ_UI_BASE + 4 + (d) * 2)
#define UI_TILE_METER_FULL (C_OBJ_UI_BASE + 24)
#define UI_TILE_METER_EMPTY (C_OBJ_UI_BASE + 25)

/* attr0 shape / attr1 size for w x h */
static u16 shape_bits(u8 w, u8 h) {
  if (w == h) return ATTR0_SQUARE;
  return (w > h) ? ATTR0_WIDE : ATTR0_TALL;
}
static u16 size_bits(u8 w, u8 h) {
  u8 m = (w > h) ? w : h;
  u8 n = (w > h) ? h : w;
  if (w == h) return (u16)(w == 8 ? 0 : w == 16 ? 1 : w == 32 ? 2 : 3);
  if (m == 16) return 0;            /* 16x8 */
  if (m == 32 && n == 8) return 1;  /* 32x8 */
  if (m == 32) return 2;            /* 32x16 */
  return 3;                         /* 64x32 */
}

void sprites_update(void) {
  int i;
  for (i = 0; i < C_MAX_SPRITES; i++) {
    Spr *s = &g.spr[i];
    const SagaProto *p;
    if (!s->active || s->mode != 1) continue;
    p = &g.sc->protos[s->proto];
    if (p->frames <= 1) continue;
    if (++s->timer >= s->fps) {
      s->timer = 0;
      s->frame++;
      if (s->frame >= p->frames) s->frame = 0;
    }
  }
  if (g.counter_bounce) g.counter_bounce--;
}

s16 spr_screen_x(const Spr *s) {
  return (s->flags & C_SPR_SCREEN) ? s->x : (s16)(s->x - g.fx[TW_CAM_X]);
}

void sprites_draw(void) {
  int i;
  u16 mos = (g.fx[TW_MOSAIC] > 0) ? ATTR0_MOSAIC : 0;

  for (i = 0; i < C_MAX_SPRITES; i++) {
    Spr *s = &g.spr[i];
    ObjAttr *o = &oam_shadow[i];
    const SagaProto *p;
    s16 sx, sy;
    if (!s->active) {
      o->attr0 = ATTR0_HIDE;
      continue;
    }
    p = &g.sc->protos[s->proto];
    sx = spr_screen_x(s);
    sy = (s->flags & C_SPR_SCREEN) ? s->y : (s16)(s->y - g.fx[TW_CAM_Y]);
    if (sx <= -(s16)p->w * 2 || sx >= 240 + p->w || sy <= -(s16)p->h * 2 || sy >= 160 + p->h) {
      o->attr0 = ATTR0_HIDE;
      continue;
    }
    if (s->affine) {
      /* matrix 0, double-size render area, centered on (x,y) */
      o->attr0 = (u16)(ATTR0_Y(sy - p->h) | ATTR0_AFF_DBL | shape_bits(p->w, p->h) | mos |
                       ((s->flags & C_SPR_GHOST) ? ATTR0_BLEND : 0));
      o->attr1 = (u16)(ATTR1_X(sx - p->w) | ATTR1_AFF(0) | (size_bits(p->w, p->h) << 14));
    } else {
      o->attr0 = (u16)(ATTR0_Y(sy) | shape_bits(p->w, p->h) | mos |
                       ((s->flags & C_SPR_GHOST) ? ATTR0_BLEND : 0));
      o->attr1 = (u16)(ATTR1_X(sx) | ((s->flags & C_SPR_HFLIP) ? ATTR1_HFLIP : 0) |
                       (size_bits(p->w, p->h) << 14));
    }
    o->attr2 = (u16)(ATTR2_TILE(p->tile_base + s->frame * ((p->w / 8) * (p->h / 8))) |
                     ATTR2_PRIO((s->flags & C_SPR_BEHIND) ? 3 : 1) | ATTR2_PALBANK(p->palbank));
  }

  /* counter HUD: right-aligned digits bound to a var */
  {
    s16 v = g.counter_show ? g.vars[g.counter_var] : -1;
    int d;
    if (g.counter_show && v != g.counter_prev) {
      g.counter_bounce = 8;
      g.counter_prev = v;
    }
    for (d = 0; d < C_COUNTER_DIGITS; d++) {
      ObjAttr *o = &oam_shadow[C_OAM_COUNTER + d];
      if (!g.counter_show || v < 0) {
        o->attr0 = ATTR0_HIDE;
        continue;
      }
      {
        s16 dx = (s16)(g.counter_x - d * 9);
        s16 dy = (s16)(g.counter_y - ((g.counter_bounce > 4) ? (g.counter_bounce - 4) : 0));
        u16 digit = (u16)(v % 10);
        o->attr0 = (u16)(ATTR0_Y(dy) | ATTR0_TALL);
        o->attr1 = (u16)(ATTR1_X(dx) | (0 << 14)); /* 8x16 */
        o->attr2 = (u16)(ATTR2_TILE(UI_TILE_DIGIT(digit)) | ATTR2_PRIO(0) | ATTR2_PALBANK(C_PALBANK_OBJ_UI));
        v /= 10;
        if (v == 0 && d + 1 < C_COUNTER_DIGITS) {
          int k;
          for (k = d + 1; k < C_COUNTER_DIGITS; k++) oam_shadow[C_OAM_COUNTER + k].attr0 = ATTR0_HIDE;
          break;
        }
      }
    }
  }

  /* blinking A prompt */
  {
    ObjAttr *o = &oam_shadow[C_OAM_PROMPT];
    u8 blink = (g.frame & 31) < 22;
    if (g.prompt_on && blink) {
      o->attr0 = (u16)(ATTR0_Y(142) | ATTR0_SQUARE);
      o->attr1 = (u16)(ATTR1_X(220) | (1 << 14)); /* 16x16 */
      o->attr2 = (u16)(ATTR2_TILE(UI_TILE_PROMPT) | ATTR2_PRIO(0) | ATTR2_PALBANK(C_PALBANK_OBJ_UI));
    } else {
      o->attr0 = ATTR0_HIDE;
    }
  }
}

/* encounter meters: var-bound segment bars (conviction/resolve) */
void meters_draw(void) {
  int m, i;
  for (m = 0; m < 2; m++) {
    s16 v;
    s16 filled;
    for (i = 0; i < C_METER_SEGS; i++) oam_shadow[C_OAM_METER + m * C_METER_SEGS + i].attr0 = ATTR0_HIDE;
    if (!g.meter_on[m]) continue;
    v = g.vars[g.meter_var[m]];
    if (v < 0) v = 0;
    if (v > g.meter_max[m]) v = g.meter_max[m];
    filled = (s16)((v * C_METER_SEGS + g.meter_max[m] - 1) / g.meter_max[m]); /* ceil */
    for (i = 0; i < C_METER_SEGS; i++) {
      ObjAttr *o = &oam_shadow[C_OAM_METER + m * C_METER_SEGS + i];
      o->attr0 = (u16)(ATTR0_Y(g.meter_y[m]) | ATTR0_SQUARE);
      o->attr1 = (u16)(ATTR1_X(g.meter_x[m] + i * 8) | (0 << 14)); /* 8x8 */
      o->attr2 = (u16)(ATTR2_TILE(i < filled ? UI_TILE_METER_FULL : UI_TILE_METER_EMPTY) |
                       ATTR2_PRIO(0) | ATTR2_PALBANK(C_PALBANK_OBJ_UI));
    }
  }
}
