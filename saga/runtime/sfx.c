/* saga/runtime/sfx.c — PSG micro-sfx: typewriter blip, confirm, whoosh, star.
 * Channel 1 (square w/ sweep) + channel 4 (noise). Deliberately tiny. */
#include "saga.h"

void sfx_boot(void) {
  REG_SOUNDCNT_X = 0x0080; /* master enable */
  REG_SOUNDCNT_L = 0xff77; /* all PSG channels L+R, max PSG volume */
  REG_SOUNDCNT_H = 0x0002; /* PSG full mix */
}

void sfx_play(u8 id) {
  switch (id) {
    case C_SFX_BLIP: /* short mid square tick */
      REG_SOUND1CNT_L = 0x0000;
      REG_SOUND1CNT_H = 0x4140 | (3 << 12); /* duty 25%, env dec fast, quiet */
      REG_SOUND1CNT_X = 0x8000 | 1848;      /* ~1.3 kHz */
      break;
    case C_SFX_CONFIRM: /* brighter, longer */
      REG_SOUND1CNT_L = 0x0000;
      REG_SOUND1CNT_H = 0x0180 | (10 << 12); /* duty 50%, slow decay */
      REG_SOUND1CNT_X = 0x8000 | 1985;       /* ~2.1 kHz */
      break;
    case C_SFX_WHOOSH: /* noise swell */
      REG_SOUND4CNT_L = (u16)(0x0300 | (9 << 12));
      REG_SOUND4CNT_H = 0x8000 | 0x0034;
      break;
    case C_SFX_STAR: /* rising sweep chirp */
      REG_SOUND1CNT_L = 0x0017; /* sweep up, shift 7 */
      REG_SOUND1CNT_H = 0x0180 | (9 << 12);
      REG_SOUND1CNT_X = 0x8000 | 1750;
      break;
  }
}
