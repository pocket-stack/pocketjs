// aot/runtime/3ds/ctru_main.c — the libctru shell (device build only).
//
// Everything game-shaped lives in the core; this file only:
//   - maps hidKeysHeld() to the core key mask (the low byte of the 3DS HID
//     bitfield — A,B,SELECT,START,DRIGHT,DLEFT,DUP,DDOWN — happens to match
//     the GBA KEYINPUT layout bit-for-bit, so it passes straight through;
//     the circle pad is folded in as a d-pad alias),
//   - blits the core's BGR555 buffers into the rotated RGB565 3DS
//     framebuffers: top 200x120 world -> 400x240 at 2x, bottom 320x240 1:1.
//
// Deliberately does NOT include runtime.h: libctru's <3ds.h> owns the KEY_*
// names (as enums, with d-pad|C-pad combos), so the shell talks to the core
// through the pj_* surface alone.
//
// 3DS framebuffers are 240 px wide column-major panels: screen pixel (x, y)
// lives at fb[x * 240 + (239 - y)].
#include <3ds.h>
#include "pjgb_gen.h"

#define PJ_TOP_W PJGB_SCREEN_W  // 200
#define PJ_TOP_H PJGB_SCREEN_H  // 120
#define PJ_BOTTOM_W 320
#define PJ_BOTTOM_H 240

extern void pj_init(void);
extern void pj_frame(u32 keys);
extern const u16 *pj_top_fb(void);
extern const u16 *pj_bottom_fb(void);

static inline u16 bgr555_to_rgb565(u16 v) {
  u16 r = v & 0x1f;
  u16 gr = (v >> 5) & 0x1f;
  u16 b = (v >> 10) & 0x1f;
  return (u16)((r << 11) | ((u16)((gr << 1) | (gr >> 4)) << 5) | b);
}

static void blit_top(void) {
  u16 *fb = (u16 *)gfxGetFramebuffer(GFX_TOP, GFX_LEFT, NULL, NULL);
  const u16 *src = pj_top_fb();
  for (int wy = 0; wy < PJ_TOP_H; wy++) {
    for (int wx = 0; wx < PJ_TOP_W; wx++) {
      u16 c = bgr555_to_rgb565(src[wy * PJ_TOP_W + wx]);
      int x = wx * 2, y = wy * 2;
      u16 *col0 = fb + x * 240 + (239 - (y + 1)); // two screen columns, two rows
      u16 *col1 = col0 + 240;
      col0[0] = c; col0[1] = c;
      col1[0] = c; col1[1] = c;
    }
  }
}

static void blit_bottom(void) {
  u16 *fb = (u16 *)gfxGetFramebuffer(GFX_BOTTOM, GFX_LEFT, NULL, NULL);
  const u16 *src = pj_bottom_fb();
  for (int y = 0; y < PJ_BOTTOM_H; y++) {
    for (int x = 0; x < PJ_BOTTOM_W; x++) {
      fb[x * 240 + (239 - y)] = bgr555_to_rgb565(src[y * PJ_BOTTOM_W + x]);
    }
  }
}

int main(void) {
  gfxInitDefault();
  gfxSetScreenFormat(GFX_TOP, GSP_RGB565_OES);
  gfxSetScreenFormat(GFX_BOTTOM, GSP_RGB565_OES);
  gfxSetDoubleBuffering(GFX_TOP, true);
  gfxSetDoubleBuffering(GFX_BOTTOM, true);

  pj_init();

  while (aptMainLoop()) {
    hidScanInput();
    u32 held = hidKeysHeld();
    if ((held & KEY_START) && (held & KEY_SELECT)) break; // exit to hbmenu

    // Low byte matches the core's GBA-style mask; KEY_UP/DOWN/LEFT/RIGHT are
    // libctru's d-pad|C-pad combos, folded onto the d-pad bits.
    u32 keys = held & 0xff;
    if (held & KEY_RIGHT) keys |= 0x10;
    if (held & KEY_LEFT) keys |= 0x20;
    if (held & KEY_UP) keys |= 0x40;
    if (held & KEY_DOWN) keys |= 0x80;

    pj_frame(keys);
    blit_top();
    blit_bottom();

    gfxFlushBuffers();
    gfxSwapBuffers();
    gspWaitForVBlank();
  }

  gfxExit();
  return 0;
}
