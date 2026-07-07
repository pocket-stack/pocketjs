/* saga/runtime/tween.c — 16-slot property tween engine.
 * Targets < 16 index g.fx[] (camera, blend, mosaic, wave, letterbox, shake,
 * autoscroll, affine scale/angle). Targets >= C_TW_SPRITE_BASE address sprite
 * slot x/y. One active tween per target; restarting replaces. */
#include "saga.h"

s16 *tween_slot_value(u8 target) {
  if (target >= C_TW_SPRITE_BASE) {
    u8 slot = (u8)((target - C_TW_SPRITE_BASE) >> 1);
    if (slot >= C_MAX_SPRITES) return 0;
    return (target & 1) ? &g.spr[slot].y : &g.spr[slot].x;
  }
  if (target < 16) return &g.fx[target];
  return 0;
}

static u16 easef(u16 t, u16 T, u8 mode) {
  u32 f = ((u32)t << 8) / T;
  switch (mode) {
    case C_EASE_IN:
      f = (f * f) >> 8;
      break;
    case C_EASE_OUT: {
      u32 inv = 256 - f;
      f = 256 - ((inv * inv) >> 8);
      break;
    }
    case C_EASE_INOUT:
      f = ((u32)f * f * (768 - 2 * f)) >> 16;
      break;
  }
  return (u16)f;
}

void tween_start(u8 target, s16 to, u16 T, u8 ease) {
  int i, free_i = -1;
  s16 *v = tween_slot_value(target);
  if (!v) return;
  if (T == 0) {
    *v = to;
    return;
  }
  for (i = 0; i < C_MAX_TWEENS; i++) {
    if (g.tw[i].active && g.tw[i].target == target) {
      free_i = i; /* replace in place */
      break;
    }
    if (!g.tw[i].active && free_i < 0) free_i = i;
  }
  if (free_i < 0) return; /* out of slots: drop (compiler budget prevents this) */
  g.tw[free_i].active = 1;
  g.tw[free_i].target = target;
  g.tw[free_i].ease = ease;
  g.tw[free_i].from = *v;
  g.tw[free_i].to = to;
  g.tw[free_i].t = 0;
  g.tw[free_i].T = T;
}

void tween_step(void) {
  int i;
  u16 mask = 0;
  for (i = 0; i < C_MAX_TWEENS; i++) {
    Tween *tw = &g.tw[i];
    s16 *v;
    if (!tw->active) continue;
    v = tween_slot_value(tw->target);
    tw->t++;
    if (tw->t >= tw->T) {
      *v = tw->to;
      tw->active = 0;
      continue;
    }
    {
      u16 f = easef(tw->t, tw->T, tw->ease);
      *v = (s16)(tw->from + (((s32)(tw->to - tw->from) * f) >> 8));
    }
    mask |= (u16)(1u << i);
  }
  g.tween_mask = mask;
}
