// aot/runtime/gba.h — minimal GBA hardware definitions (Tonc-style).
// Freestanding, no libc. Register addresses per GBATEK / Tonc.
#ifndef PJGB_GBA_H
#define PJGB_GBA_H
#include <stdint.h>

typedef uint8_t u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef int8_t s8;
typedef int16_t s16;
typedef int32_t s32;
typedef volatile uint16_t vu16;
typedef volatile uint32_t vu32;

// --- Memory regions ---------------------------------------------------------
#define MEM_IO 0x04000000
#define MEM_PAL 0x05000000
#define MEM_VRAM 0x06000000
#define MEM_OAM 0x07000000

#define REG_DISPCNT (*(vu32 *)(MEM_IO + 0x0000))
#define REG_DISPSTAT (*(vu16 *)(MEM_IO + 0x0004))
#define REG_VCOUNT (*(vu16 *)(MEM_IO + 0x0006))
#define REG_BG0CNT (*(vu16 *)(MEM_IO + 0x0008))
#define REG_BG1CNT (*(vu16 *)(MEM_IO + 0x000a))
#define REG_BG0HOFS (*(vu16 *)(MEM_IO + 0x0010))
#define REG_BG0VOFS (*(vu16 *)(MEM_IO + 0x0012))
#define REG_BG1HOFS (*(vu16 *)(MEM_IO + 0x0014))
#define REG_BG1VOFS (*(vu16 *)(MEM_IO + 0x0016))
#define REG_KEYINPUT (*(vu16 *)(MEM_IO + 0x0130))

// DISPCNT bits
#define DCNT_MODE0 0x0000
#define DCNT_BG0 0x0100
#define DCNT_BG1 0x0200
#define DCNT_OBJ 0x1000
#define DCNT_OBJ_1D 0x0040

// BGxCNT bits
#define BG_4BPP 0x0000
#define BG_8BPP 0x0080
#define BG_REG_32x32 0x0000
#define BG_PRIO(n) ((n) & 3)
#define BG_CBB(n) (((n) & 3) << 2)   // char base block (charblock)
#define BG_SBB(n) (((n) & 0x1f) << 8) // screen base block (screenblock)

// --- VRAM helpers -----------------------------------------------------------
// Charblock = 0x4000 bytes (512 4bpp tiles); screenblock = 0x800 bytes.
#define CHARBLOCK(n) ((u16 *)(MEM_VRAM + (n) * 0x4000))
#define SCREENBLOCK(n) ((u16 *)(MEM_VRAM + (n) * 0x800))
#define OBJ_VRAM ((u16 *)(MEM_VRAM + 0x10000)) // OBJ tiles (charblock 4)
#define BG_PAL ((u16 *)MEM_PAL)                // 256 entries (16 banks of 16)
#define OBJ_PAL ((u16 *)(MEM_PAL + 0x200))     // 256 entries

// Layout used by the PocketJS-AOT runtime:
#define PJ_BG_CBB 0     // BG char base charblock (tiles 0..)
#define PJ_MAP_SBB 8    // BG0 map screenblock
#define PJ_TEXT_SBB 9   // BG1 textbox screenblock

// A 4bpp BG/screen entry: bits 0-9 tile index, 10 hflip, 11 vflip, 12-15 palbank
#define SE(tile, palbank) (((tile) & 0x3ff) | (((palbank) & 0xf) << 12))

// --- Keys (active-low in REG_KEYINPUT; bit index matches mGBA GBAKey) --------
#define KEY_A 0x0001
#define KEY_B 0x0002
#define KEY_SELECT 0x0004
#define KEY_START 0x0008
#define KEY_RIGHT 0x0010
#define KEY_LEFT 0x0020
#define KEY_UP 0x0040
#define KEY_DOWN 0x0080
#define KEY_R 0x0100
#define KEY_L 0x0200

// --- OAM --------------------------------------------------------------------
typedef struct {
  u16 attr0;
  u16 attr1;
  u16 attr2;
  u16 fill;
} ObjAttr; // 8 bytes; 128 in OAM

#define OAM ((ObjAttr *)MEM_OAM)

// attr0
#define ATTR0_Y(y) ((y) & 0xff)
#define ATTR0_SQUARE 0x0000
#define ATTR0_HIDE 0x0200
#define ATTR0_4BPP 0x0000
// attr1
#define ATTR1_X(x) ((x) & 0x1ff)
#define ATTR1_SIZE_16 0x4000 // with ATTR0_SQUARE => 16x16
// attr2
#define ATTR2_TILE(t) ((t) & 0x3ff)
#define ATTR2_PRIO(p) (((p) & 3) << 10)
#define ATTR2_PALBANK(n) (((n) & 0xf) << 12)

// --- DMA (channel 3, used to blit OAM shadow at VBlank) ---------------------
#define REG_DMA3SAD (*(vu32 *)(MEM_IO + 0x00d4))
#define REG_DMA3DAD (*(vu32 *)(MEM_IO + 0x00d8))
#define REG_DMA3CNT (*(vu32 *)(MEM_IO + 0x00dc))
#define DMA_ENABLE 0x80000000
#define DMA_32 0x04000000

static inline void dma3_copy32(void *dst, const void *src, u32 words) {
  REG_DMA3SAD = (u32)src;
  REG_DMA3DAD = (u32)dst;
  REG_DMA3CNT = words | DMA_ENABLE | DMA_32;
}

static inline void vblank_wait(void) {
  while (REG_VCOUNT >= 160) {} // wait for end of any current vblank
  while (REG_VCOUNT < 160) {}  // wait for start of vblank
}

#endif // PJGB_GBA_H
