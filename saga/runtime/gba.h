/* saga/runtime/gba.h — GBA hardware definitions for the saga runtime.
 * Fuller register set than aot's: blending, mosaic, windows, affine OBJ,
 * HBlank/VBlank IRQs, PSG sound. Freestanding, per GBATEK/Tonc. */
#ifndef SAGA_GBA_H
#define SAGA_GBA_H
#include <stdint.h>

typedef uint8_t u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef int8_t s8;
typedef int16_t s16;
typedef int32_t s32;
typedef volatile uint8_t vu8;
typedef volatile uint16_t vu16;
typedef volatile uint32_t vu32;

#define MEM_EWRAM 0x02000000
#define MEM_IWRAM 0x03000000
#define MEM_IO 0x04000000
#define MEM_PAL 0x05000000
#define MEM_VRAM 0x06000000
#define MEM_OAM 0x07000000

/* --- display ---------------------------------------------------------------- */
#define REG_DISPCNT (*(vu16 *)(MEM_IO + 0x0000))
#define REG_DISPSTAT (*(vu16 *)(MEM_IO + 0x0004))
#define REG_VCOUNT (*(vu16 *)(MEM_IO + 0x0006))
#define REG_BGCNT(n) (*(vu16 *)(MEM_IO + 0x0008 + (n) * 2))
#define REG_BGHOFS(n) (*(vu16 *)(MEM_IO + 0x0010 + (n) * 4))
#define REG_BGVOFS(n) (*(vu16 *)(MEM_IO + 0x0012 + (n) * 4))

#define DCNT_MODE0 0x0000
#define DCNT_FORCE_BLANK 0x0080
#define DCNT_BG0 0x0100
#define DCNT_BG1 0x0200
#define DCNT_BG2 0x0400
#define DCNT_BG3 0x0800
#define DCNT_OBJ 0x1000
#define DCNT_WIN0 0x2000
#define DCNT_OBJ_1D 0x0040

#define DSTAT_VBL_IRQ 0x0008
#define DSTAT_HBL_IRQ 0x0010

#define BG_4BPP 0x0000
#define BG_MOSAIC 0x0040
#define BG_PRIO(n) ((n) & 3)
#define BG_CBB(n) (((n) & 3) << 2)
#define BG_SBB(n) (((n) & 0x1f) << 8)
#define BG_SIZE_32x32 0x0000
#define BG_SIZE_64x32 0x4000
#define BG_SIZE_32x64 0x8000
#define BG_SIZE_64x64 0xC000

/* --- effects ------------------------------------------------------------------ */
#define REG_MOSAIC (*(vu16 *)(MEM_IO + 0x004c))
#define REG_BLDCNT (*(vu16 *)(MEM_IO + 0x0050))
#define REG_BLDALPHA (*(vu16 *)(MEM_IO + 0x0052))
#define REG_BLDY (*(vu16 *)(MEM_IO + 0x0054))

#define BLD_BG0 0x0001
#define BLD_BG1 0x0002
#define BLD_BG2 0x0004
#define BLD_BG3 0x0008
#define BLD_OBJ 0x0010
#define BLD_BD 0x0020
#define BLD_ALL 0x003f
#define BLD_MODE_OFF 0x0000
#define BLD_MODE_ALPHA 0x0040
#define BLD_MODE_WHITE 0x0080
#define BLD_MODE_BLACK 0x00c0
#define BLD_2ND(t) ((t) << 8)

/* --- windows -------------------------------------------------------------------- */
#define REG_WIN0H (*(vu16 *)(MEM_IO + 0x0040))
#define REG_WIN0V (*(vu16 *)(MEM_IO + 0x0044))
#define REG_WININ (*(vu16 *)(MEM_IO + 0x0048))
#define REG_WINOUT (*(vu16 *)(MEM_IO + 0x004a))
#define WIN_BG0 0x01
#define WIN_BG1 0x02
#define WIN_BG2 0x04
#define WIN_BG3 0x08
#define WIN_OBJ 0x10
#define WIN_BLD 0x20
#define WIN_ALL 0x3f

/* --- interrupts ----------------------------------------------------------------- */
#define REG_IE (*(vu16 *)(MEM_IO + 0x0200))
#define REG_IF (*(vu16 *)(MEM_IO + 0x0202))
#define REG_IME (*(vu16 *)(MEM_IO + 0x0208))
#define IRQ_VBLANK 0x0001
#define IRQ_HBLANK 0x0002
#define ISR_VECTOR (*(vu32 *)(0x03007ffc))
#define BIOS_IF (*(vu16 *)(0x03007ff8))

/* --- input ------------------------------------------------------------------------ */
#define REG_KEYINPUT (*(vu16 *)(MEM_IO + 0x0130))
#define KEY_A 0x0001
#define KEY_B 0x0002
#define KEY_SELECT 0x0004
#define KEY_START 0x0008
#define KEY_RIGHT 0x0010
#define KEY_LEFT 0x0020
#define KEY_UP 0x0040
#define KEY_DOWN 0x0080
#define KEY_MASK 0x03ff

/* --- PSG sound -------------------------------------------------------------------- */
#define REG_SOUNDCNT_L (*(vu16 *)(MEM_IO + 0x0080))
#define REG_SOUNDCNT_H (*(vu16 *)(MEM_IO + 0x0082))
#define REG_SOUNDCNT_X (*(vu16 *)(MEM_IO + 0x0084))
#define REG_SOUND1CNT_L (*(vu16 *)(MEM_IO + 0x0060)) /* sweep */
#define REG_SOUND1CNT_H (*(vu16 *)(MEM_IO + 0x0062)) /* duty/len/env */
#define REG_SOUND1CNT_X (*(vu16 *)(MEM_IO + 0x0064)) /* freq/ctrl */
#define REG_SOUND4CNT_L (*(vu16 *)(MEM_IO + 0x0078)) /* noise len/env */
#define REG_SOUND4CNT_H (*(vu16 *)(MEM_IO + 0x007c)) /* noise freq/ctrl */

/* --- VRAM / palettes ----------------------------------------------------------------- */
#define CHARBLOCK(n) ((u16 *)(MEM_VRAM + (n) * 0x4000))
#define SCREENBLOCK(n) ((u16 *)(MEM_VRAM + (n) * 0x800))
#define OBJ_VRAM ((u16 *)(MEM_VRAM + 0x10000))
#define BG_PAL ((vu16 *)MEM_PAL)
#define OBJ_PAL ((vu16 *)(MEM_PAL + 0x200))
#define SE(tile, palbank) (((tile) & 0x3ff) | (((palbank) & 0xf) << 12))
#define SE_HFLIP 0x0400
#define SE_VFLIP 0x0800

/* --- OAM ------------------------------------------------------------------------------- */
typedef struct {
  u16 attr0, attr1, attr2, fill;
} ObjAttr;
typedef struct {
  u16 f0[3];
  s16 pa;
  u16 f1[3];
  s16 pb;
  u16 f2[3];
  s16 pc;
  u16 f3[3];
  s16 pd;
} ObjAffine;
#define OAM_MEM ((ObjAttr *)MEM_OAM)
#define OAM_AFF ((ObjAffine *)MEM_OAM)

#define ATTR0_Y(y) ((y) & 0xff)
#define ATTR0_AFFINE 0x0100
#define ATTR0_HIDE 0x0200
#define ATTR0_AFF_DBL 0x0300
#define ATTR0_BLEND 0x0400
#define ATTR0_MOSAIC 0x1000
#define ATTR0_SQUARE 0x0000
#define ATTR0_WIDE 0x4000
#define ATTR0_TALL 0x8000
#define ATTR1_X(x) ((x) & 0x1ff)
#define ATTR1_AFF(n) (((n) & 31) << 9)
#define ATTR1_HFLIP 0x1000
#define ATTR1_VFLIP 0x2000
#define ATTR1_SIZE(n) (((n) & 3) << 14)
#define ATTR2_TILE(t) ((t) & 0x3ff)
#define ATTR2_PRIO(p) (((p) & 3) << 10)
#define ATTR2_PALBANK(n) (((n) & 0xf) << 12)

/* --- DMA3 -------------------------------------------------------------------------------- */
#define REG_DMA3SAD (*(vu32 *)(MEM_IO + 0x00d4))
#define REG_DMA3DAD (*(vu32 *)(MEM_IO + 0x00d8))
#define REG_DMA3CNT (*(vu32 *)(MEM_IO + 0x00dc))
#define DMA_ENABLE 0x80000000
#define DMA_32 0x04000000

static inline void dma3_copy32(volatile void *dst, const void *src, u32 words) {
  REG_DMA3SAD = (u32)src;
  REG_DMA3DAD = (u32)dst;
  REG_DMA3CNT = words | DMA_ENABLE | DMA_32;
}

#define IWRAM_CODE __attribute__((section(".iwram.text"), long_call, target("arm")))

#endif
