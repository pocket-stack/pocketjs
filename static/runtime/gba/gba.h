/* static/runtime/gba/gba.h — the handful of GBA registers this runtime uses. */
#ifndef PS_GBA_H
#define PS_GBA_H

#include "hal.h"

#define REG(addr) (*(volatile u16 *)(addr))
#define REG32(addr) (*(volatile u32 *)(addr))

#define REG_DISPCNT REG(0x04000000)
#define REG_VCOUNT REG(0x04000006)
#define REG_BG0CNT REG(0x04000008)
#define REG_BG1CNT REG(0x0400000a)
#define REG_BG0HOFS REG(0x04000010)
#define REG_BG0VOFS REG(0x04000012)
#define REG_BG1HOFS REG(0x04000014)
#define REG_BG1VOFS REG(0x04000016)
#define REG_KEYINPUT REG(0x04000130)

#define REG_SOUNDCNT_L REG(0x04000080)
#define REG_SOUNDCNT_H REG(0x04000082)
#define REG_SOUNDCNT_X REG(0x04000084)
#define REG_SOUND1CNT_L REG(0x04000060)
#define REG_SOUND1CNT_H REG(0x04000062)
#define REG_SOUND1CNT_X REG(0x04000064)

#define PAL_BG ((volatile u16 *)0x05000000)
#define PAL_OBJ ((volatile u16 *)0x05000200)
#define VRAM ((volatile u16 *)0x06000000)
#define VRAM_OBJ ((volatile u16 *)0x06010000)
#define OAM ((volatile u16 *)0x07000000)

/* charblock 0 = BG tiles; screenblock 8 = map, 9 = textbox layer */
#define SB_MAP 8
#define SB_TEXT 9
#define SCREENBLOCK(n) ((volatile u16 *)(0x06000000 + (n) * 0x800))

#endif
