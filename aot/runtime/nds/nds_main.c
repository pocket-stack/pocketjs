// aot/runtime/nds/nds_main.c — the libnds shell (device build only).
//
// Everything game-shaped lives in the core; this file only runs the libnds
// main loop and maps input. The core renders straight into the DS 2D engines
// (render_ds.c), so there is nothing to blit — presentation is the hardware
// swapping scanned VRAM each vblank.
//
// Deliberately does NOT include runtime.h: libnds's <nds.h> owns the KEY_*
// names (the core's key macros were renamed PJ_KEY_* to avoid the clash), so
// the shell talks to the core through the pj_* surface + the numeric mask.
#include <nds.h>

extern void pj_init(void);
extern void pj_frame(unsigned int keys);

// Core key mask == GBA/DS KEYINPUT bit layout (A,B,SELECT,START,R,L,U,D).
int main(void) {
  // swiWaitForVBlank() halts until the VBlank IRQ fires; without it enabled the
  // very first wait never returns and the game appears stuck loading.
  irqEnable(IRQ_VBLANK);

  pj_init();

  while (1) {
    swiWaitForVBlank();
    scanKeys();
    int held = keysHeld();
    if ((held & KEY_START) && (held & KEY_SELECT)) break; // exit to menu

    // libnds KEY_A..KEY_DOWN occupy the same low 8 bits as the core mask;
    // KEY_UP/DOWN/LEFT/RIGHT already fold the d-pad. Pass the low byte through.
    unsigned int keys = (unsigned int)(held & 0xff);
    pj_frame(keys);
  }
  return 0;
}
