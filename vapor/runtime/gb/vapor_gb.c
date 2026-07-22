/* vapor/runtime/gb/vapor_gb.c — the Game Boy (DMG) half of the runtime.
 *
 * The 20x18 cell grid from vapor_core.c lives (with the debug header) at
 * absolute WRAM addresses — the shadow grid IS the debug block, so the
 * harness always reads the logical screen even while the physical VRAM
 * commit trickles through vblank at 2 rows per frame.
 *
 * DMG has one background palette, so logical palettes map to glyph STYLES:
 * two baked font copies (normal / inverse) selected per cell through
 * vp_pal_style. BG map at 0x9800, unsigned tile addressing (0x8000), no
 * scroll, no window, no sprites. Joypad matrix normalized to the GBA bit
 * order the whole stack shares. Pocket Static hal_gb lineage.
 */
#include "vapor.h"

#define REG8(a) (*(volatile u8 *)(a))
#define rP1 REG8(0xFF00)
#define rLCDC REG8(0xFF40)
#define rSTAT REG8(0xFF41)
#define rSCY REG8(0xFF42)
#define rSCX REG8(0xFF43)
#define rLY REG8(0xFF44)
#define rBGP REG8(0xFF47)
#define VRAM8(a) ((volatile u8 *)(a))
#define BG_MAP 0x9800

/* debug block: header 16 + state 48 + chars 360 + pals 360 = 784 B */
#define DBG_BASE 0xD800
__at(DBG_BASE) volatile u8 vp_dbg_hdr[16];
__at(DBG_BASE + 16) volatile u8 vp_dbg_state[48];
__at(DBG_BASE + 64) u8 vp_grid_ch[VP_GRID_H][VP_GRID_W];
__at(DBG_BASE + 64 + VP_GRID_H * VP_GRID_W) u8 vp_grid_pal[VP_GRID_H][VP_GRID_W];

static u32 frame_no, flush_no;

static void wait_vblank(void) {
  while (rLY >= 144) {}
  while (rLY < 144) {}
}

/* Convert + blit up to 2 dirty shadow rows into the BG map. Row writes are
 * ~500 M-cycles each against a ~1140-cycle vblank; leftover rows keep
 * their dirty bits and land next frame (the logical grid is already
 * correct — only pixels lag). */
static u32 vram_pending;

static void commit_rows(void) {
  u8 budget = 2;
  u8 y, x;
  vram_pending |= vp_rows_dirty;
  vp_rows_dirty = 0;
  for (y = 0; y < VP_GRID_H && budget; y++) {
    volatile u8 *out;
    if (!(vram_pending & vp_bit32[y])) continue;
    out = VRAM8(BG_MAP + (u16)y * 32);
    {
      const u8 *rc = (const u8 *)vp_grid_ch + (u16)y * VP_GRID_W;
      const u8 *rp = (const u8 *)vp_grid_pal + (u16)y * VP_GRID_W;
      for (x = 0; x < VP_GRID_W; x++) {
        u8 style = vp_pal_style[rp[x] & 7];
        out[x] = (u8)(1 + (u8)(rc[x] - 0x20) + (style ? 95 : 0));
      }
    }
    vram_pending &= ~vp_bit32[y];
    budget--;
  }
}

static void debug_commit(void) {
  u16 n;
  vp_dbg_hdr[0] = 'P';
  vp_dbg_hdr[1] = 'V';
  vp_dbg_hdr[2] = 'D';
  vp_dbg_hdr[3] = 'B';
  *(volatile u32 *)(vp_dbg_hdr + 4) = frame_no;
  *(volatile u32 *)(vp_dbg_hdr + 8) = flush_no;
  vp_dbg_hdr[12] = vp_tripwires;
  n = app_debug_state(vp_dbg_state);
  vp_dbg_hdr[14] = (u8)n;
  vp_dbg_hdr[15] = (u8)(n >> 8);
}

static u8 read_keys(void) {
  u8 pad, btn;
  rP1 = 0x20; /* select dpad */
  pad = rP1;
  pad = rP1;
  pad = (u8)(~pad & 0x0f); /* right,left,up,down (bits 0-3) */
  rP1 = 0x10; /* select buttons */
  btn = rP1;
  btn = rP1;
  btn = rP1;
  btn = (u8)(~btn & 0x0f); /* a,b,select,start */
  rP1 = 0x30;
  /* normalize to the shared order: a,b,select,start,right,left,up,down */
  return (u8)(btn | (pad << 4));
}

static void upload_font(void) {
  /* 2 styles x 95 glyphs, 2bpp interleaved; tile 0 stays blank */
  volatile u8 *d = VRAM8(0x8000 + 16);
  u16 i;
  for (i = 0; i < (u16)(2 * 95 * 16); i++) d[i] = vp_font_tiles[i];
}

void main(void) {
  u8 prev = 0;
  u16 i;
  volatile u8 *d;

  vp_dbg_hdr[0] = 'P';
  vp_dbg_hdr[1] = 'V';
  vp_dbg_hdr[2] = 'D';
  vp_dbg_hdr[3] = 'B';
  vp_dbg_hdr[13] = 1; /* boot progress marker */

  wait_vblank();
  rLCDC = 0x00; /* LCD off: free VRAM access */
  rBGP = 0xE4;  /* identity ramp 3,2,1,0 */
  upload_font();
  d = VRAM8(BG_MAP);
  for (i = 0; i < 32 * 32; i++) d[i] = 0; /* blank map */
  rSCX = 0;
  rSCY = 0;

  vp_row_clear(0, VP_GRID_H);
  vp_dbg_hdr[13] = 2;
  app_init();
  vp_dbg_hdr[13] = 3;
  app_flush();
  flush_no++;
  vp_dbg_hdr[13] = 4;
  vram_pending = 0xFFFFFFFF; /* full first paint */
  vp_rows_dirty = 0;

  /* blast the whole first frame while the LCD is still off */
  {
    u8 y, x;
    for (y = 0; y < VP_GRID_H; y++) {
      volatile u8 *out = VRAM8(BG_MAP + (u16)y * 32);
      const u8 *rc = (const u8 *)vp_grid_ch + (u16)y * VP_GRID_W;
      const u8 *rp = (const u8 *)vp_grid_pal + (u16)y * VP_GRID_W;
      for (x = 0; x < VP_GRID_W; x++) {
        u8 style = vp_pal_style[rp[x] & 7];
        out[x] = (u8)(1 + (u8)(rc[x] - 0x20) + (style ? 95 : 0));
      }
    }
    vram_pending = 0;
  }

  rLCDC = 0x80 | 0x01 | 0x10; /* LCD on, BG on, unsigned tiles at 0x8000 */

  for (;;) {
    u8 keys, edges, b;
    wait_vblank();
    commit_rows();
    frame_no++;
    debug_commit();

    keys = read_keys();
    edges = (u8)(keys & (u8)~prev);
    prev = keys;
    for (b = 0; b < 8; b++)
      if (edges & (u8)(1 << b)) app_on_button(b);
    if (app_flush()) flush_no++;
  }
}
