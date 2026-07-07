/* saga/runtime/irq.c — VBlank/HBlank interrupt service.
 *
 * The HBlank handler is the raster engine: per scanline it writes the backdrop
 * color (sky gradients get ~160 shades from a 15-color-per-bank system; the
 * letterbox forces the out-of-window band to black) and, when a wave effect is
 * active, a sine offset into one BG's HOFS. It runs from IWRAM (.iwram.text,
 * copied by crt0) so it fits comfortably inside the 272-cycle HBlank.
 *
 * The VBlank handler DMAs the OAM shadow, latches the frame's scroll values,
 * preloads line 0's backdrop, and bumps the frame counter. */
#include "saga.h"

volatile u32 vbl_count;
u16 isr_hofs[4], isr_vofs[4];
u16 isr_lb;
const u16 *isr_grad;
u16 isr_backdrop;
u16 isr_wave_amp;
u8 isr_wave_bg;
u16 isr_wave_phase;

s8 sin8[256]; /* q7 sine, built at boot (quarter-wave parabola — FX grade) */

ObjAttr oam_shadow[128];

IWRAM_CODE static void master_isr(void) {
  u16 f = REG_IF;
  if (f & IRQ_HBLANK) {
    u32 vc = REG_VCOUNT;
    u32 line = (vc >= 227) ? 0 : vc + 1; /* the line about to be drawn */
    if (line < 160) {
      u16 c;
      if (isr_lb && (line < isr_lb || line >= 160u - isr_lb)) c = 0;
      else if (isr_grad) c = isr_grad[line];
      else c = isr_backdrop;
      BG_PAL[0] = c;
      if (isr_wave_amp) {
        u32 idx = (line * 3 + isr_wave_phase) & 255;
        s32 s = sin8[idx];
        REG_BGHOFS(isr_wave_bg) = (u16)(isr_hofs[isr_wave_bg] + ((s * (s32)isr_wave_amp) >> 7));
      }
    }
  }
  if (f & IRQ_VBLANK) {
    int i;
    dma3_copy32(OAM_MEM, oam_shadow, sizeof(oam_shadow) / 4);
    for (i = 0; i < 4; i++) {
      REG_BGHOFS(i) = isr_hofs[i];
      REG_BGVOFS(i) = isr_vofs[i];
    }
    BG_PAL[0] = isr_lb ? 0 : (isr_grad ? isr_grad[0] : isr_backdrop);
    isr_wave_phase += 2;
    vbl_count++;
  }
  REG_IF = f;
  BIOS_IF |= f;
}

void irq_init(void) {
  int i;
  for (i = 0; i < 128; i++) {
    /* parabola per quadrant: peaks ~127 at i=64 */
    s32 v = (i * (128 - i)) >> 5;
    if (v > 127) v = 127;
    sin8[i] = (s8)v;
    sin8[128 + i] = (s8)-v;
  }
  REG_IME = 0;
  ISR_VECTOR = (u32)master_isr;
  REG_DISPSTAT = DSTAT_VBL_IRQ | DSTAT_HBL_IRQ;
  REG_IE = IRQ_VBLANK | IRQ_HBLANK;
  REG_IF = 0xffff;
  REG_IME = 1;
}

void frame_wait(void) {
  u32 f = vbl_count;
  while (vbl_count == f) {}
}
