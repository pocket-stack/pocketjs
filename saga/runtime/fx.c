/* saga/runtime/fx.c — maps tween-target values onto GBA effect hardware:
 * camera/parallax scroll, BLDCNT fades (black/white) and BG1 ghost alpha,
 * mosaic, WIN0 letterbox (raster-assisted for the bars), screen shake, and
 * OBJ affine matrix 0 (scale/angle). Runs once per frame after tween_step. */
#include "saga.h"

extern s8 sin8[256];

void fx_reset(void) {
  int i;
  for (i = 0; i < 16; i++) g.fx[i] = 0;
  g.fx[TW_EVA] = 16;
  g.fx[TW_EVB] = 0;
  g.fx[TW_OBJ_SCALE] = 256;
  g.far_off_q8 = 0;
  g.sky_off_q8 = 0;
  for (i = 0; i < C_MAX_TWEENS; i++) g.tw[i].active = 0;
  g.tween_mask = 0;
}

static s16 clamp16(s32 v, s32 lo, s32 hi) {
  if (v < lo) return (s16)lo;
  if (v > hi) return (s16)hi;
  return (s16)v;
}

void fx_apply(void) {
  const SagaScene *sc = g.sc;
  s16 cam = g.fx[TW_CAM_X];
  s16 camy = g.fx[TW_CAM_Y];
  s16 shake = g.fx[TW_SHAKE];
  s16 sx = 0, sy = 0;
  u16 dispcnt;

  if (shake > 0) {
    sx = (s16)((g.rng >> 4) % (u16)(2 * shake + 1)) - shake;
    sy = (s16)((g.rng >> 9) % (u16)(shake + 1)) - (shake >> 1);
  }

  /* autoscroll accumulators */
  g.far_off_q8 += sc->far_vx_q8 + g.fx[TW_FAR_VX];
  g.sky_off_q8 += sc->sky_vx_q8 + g.fx[TW_SKY_VX];

  isr_hofs[0] = 0;
  isr_vofs[0] = 0;
  isr_hofs[1] = (u16)(cam + sx);
  isr_vofs[1] = (u16)(camy + sy);
  isr_hofs[2] = (u16)((((s32)cam * sc->far_fac_q8) >> 8) + (s16)(g.far_off_q8 >> 8) + sx);
  isr_vofs[2] = (u16)(((s32)camy * sc->far_fac_q8) >> 8);
  isr_hofs[3] = (u16)((((s32)cam * sc->sky_fac_q8) >> 8) + (s16)(g.sky_off_q8 >> 8));
  isr_vofs[3] = 0;

  /* --- blending state machine ------------------------------------------------ */
  {
    s16 y = g.fx[TW_BLDY];
    if (y < 0) y = 0;
    if (y > 16) y = 16;
    if (y > 0) {
      REG_BLDCNT = (u16)(((g.fade_mode >= C_FADE_IN_WHITE) ? BLD_MODE_WHITE : BLD_MODE_BLACK) | BLD_ALL);
      REG_BLDY = (u16)y;
    } else if (g.fx[TW_EVA] != 16 || g.fx[TW_EVB] != 0) {
      /* ghost/crossfade: BG1(+OBJ) over far/sky/backdrop */
      REG_BLDCNT = (u16)(BLD_MODE_ALPHA | BLD_BG1 | BLD_OBJ | BLD_2ND(BLD_BG2 | BLD_BG3 | BLD_BD));
      REG_BLDALPHA = (u16)((g.fx[TW_EVA] & 31) | ((g.fx[TW_EVB] & 31) << 8));
      REG_BLDY = 0;
    } else {
      /* idle: keep 2nd targets armed so SPR_GHOST OBJs still blend */
      REG_BLDCNT = (u16)(BLD_MODE_OFF | BLD_2ND(BLD_BG1 | BLD_BG2 | BLD_BG3 | BLD_BD));
      REG_BLDALPHA = (u16)(10 | (8 << 8));
      REG_BLDY = 0;
    }
  }

  /* --- mosaic ------------------------------------------------------------------ */
  {
    u16 m = (u16)(g.fx[TW_MOSAIC] & 15);
    REG_MOSAIC = (u16)(m | (m << 4) | (m << 8) | (m << 12));
  }

  /* --- letterbox (WIN0 band + ISR blackout outside) ----------------------------- */
  {
    s16 lb = clamp16(g.fx[TW_LETTERBOX], 0, 48);
    isr_lb = (u16)lb;
    dispcnt = DCNT_MODE0 | DCNT_OBJ | DCNT_OBJ_1D | DCNT_BG0 | DCNT_BG1;
    if (sc->map_far) dispcnt |= DCNT_BG2;
    if (sc->map_sky) dispcnt |= DCNT_BG3;
    if (lb > 0) {
      REG_WIN0H = 240;
      REG_WIN0V = (u16)((lb << 8) | (160 - lb));
      REG_WININ = WIN_ALL;
      REG_WINOUT = WIN_BLD; /* backdrop only (ISR paints it black) */
      dispcnt |= DCNT_WIN0;
    }
    REG_DISPCNT = dispcnt;
  }

  /* --- raster feed ---------------------------------------------------------------- */
  isr_backdrop = sc->backdrop;
  isr_grad = (g.raster_mode == C_RASTER_GRADIENT && sc->gradient) ? sc->gradient : 0;
  if (g.raster_mode == C_RASTER_WAVE_MAIN || g.raster_mode == C_RASTER_WAVE_FAR) {
    isr_wave_bg = (g.raster_mode == C_RASTER_WAVE_MAIN) ? 1 : 2;
    isr_wave_amp = (u16)(g.fx[TW_WAVE_AMP] < 0 ? 0 : g.fx[TW_WAVE_AMP]);
  } else {
    isr_wave_amp = 0;
  }

  /* --- OBJ affine matrix 0 ----------------------------------------------------------- */
  {
    s16 scale = g.fx[TW_OBJ_SCALE];
    u8 ang = (u8)g.fx[TW_OBJ_ANGLE];
    s32 c = sin8[(u8)(ang + 64)]; /* q7 cos */
    s32 s = sin8[ang];
    s32 inv; /* q8 of 1/scale */
    ObjAffine *m = &OAM_AFF[0];
    ObjAffine *ms = (ObjAffine *)oam_shadow;
    if (scale < 16) scale = 16;
    inv = 65536 / scale;
    ms->pa = (s16)((c * inv) >> 7);
    ms->pb = (s16)((-s * inv) >> 7);
    ms->pc = (s16)((s * inv) >> 7);
    ms->pd = (s16)((c * inv) >> 7);
    (void)m;
  }
}
