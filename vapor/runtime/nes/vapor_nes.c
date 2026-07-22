/* vapor/runtime/nes/vapor_nes.c — the NES half of the runtime (cc65).
 *
 * 2 KB of CPU RAM bounds everything: the 22x18 shadow grid + debug header
 * live in the fixed DEBUG segment at $0200 (the shadow grid IS the debug
 * block), the app pool + views in the RAM segment above it, the cc65 C
 * stack in $0700-$07FF. The font is CHR-ROM (two glyph styles, selected
 * per cell via vp_pal_style); the grid renders centered at nametable
 * offset (5,6). The NMI in crt0.s blits up to two staged rows per frame —
 * the logical grid never waits for the PPU.
 *
 * No initialized mutable globals: the DATA segment must stay empty (the
 * crt0 zeroes RAM but copies nothing).
 */
#include "vapor.h"

#define PPUSTATUS (*(volatile u8 *)0x2002)
#define PPUADDR (*(volatile u8 *)0x2006)
#define PPUDATA (*(volatile u8 *)0x2007)
#define PPUCTRL (*(volatile u8 *)0x2000)
#define PPUMASK (*(volatile u8 *)0x2001)
#define JOY1 (*(volatile u8 *)0x4016)

#define ORG_X 5
#define ORG_Y 6

/* ---- fixed-address debug block ($0200): header, state, shadow grid ---- */
#pragma bss-name(push, "DEBUG")
volatile u8 vp_dbg_hdr[16];
volatile u8 vp_dbg_state[48];
u8 vp_grid_ch[VP_GRID_H][VP_GRID_W];
u8 vp_grid_pal[VP_GRID_H][VP_GRID_W];
#pragma bss-name(pop)

/* ---- NMI staging (regular BSS) ---- */
u8 stage_hi[2];
u8 stage_lo[2];
u8 stage_data[2][32]; /* 32-byte stride: the NMI indexes rows by x<<5 */
volatile u8 stage_n;
volatile u8 nmi_count;

static u32 frame_no, flush_no;
static u32 vram_pending;

static u8 row_tile(u8 y, u8 x) {
  u16 at = (u16)y * VP_GRID_W + x;
  u8 style = vp_pal_style[((const u8 *)vp_grid_pal)[at] & 7];
  return (u8)(1 + (u8)(((const u8 *)vp_grid_ch)[at] - 0x20) + (style ? 95 : 0));
}

static void fill_stage(void) {
  u8 n = 0;
  u8 y, x;
  vram_pending |= vp_rows_dirty;
  vp_rows_dirty = 0;
  for (y = 0; y < VP_GRID_H && n < 2; y++) {
    u16 addr;
    if (!(vram_pending & vp_bit32[y])) continue;
    addr = (u16)(0x2000 + (ORG_Y + y) * 32 + ORG_X);
    stage_hi[n] = (u8)(addr >> 8);
    stage_lo[n] = (u8)addr;
    for (x = 0; x < VP_GRID_W; x++) stage_data[n][x] = row_tile(y, x);
    vram_pending &= ~vp_bit32[y];
    n++;
  }
  stage_n = n; /* single atomic byte: the NMI consumes it */
}

static void debug_commit(void) {
  u16 n;
  vp_dbg_hdr[0] = 'P';
  vp_dbg_hdr[1] = 'V';
  vp_dbg_hdr[2] = 'D';
  vp_dbg_hdr[3] = 'B';
  vp_dbg_hdr[4] = (u8)frame_no;
  vp_dbg_hdr[5] = (u8)(frame_no >> 8);
  vp_dbg_hdr[6] = (u8)(frame_no >> 16);
  vp_dbg_hdr[7] = (u8)(frame_no >> 24);
  vp_dbg_hdr[8] = (u8)flush_no;
  vp_dbg_hdr[9] = (u8)(flush_no >> 8);
  vp_dbg_hdr[10] = (u8)(flush_no >> 16);
  vp_dbg_hdr[11] = (u8)(flush_no >> 24);
  vp_dbg_hdr[12] = vp_tripwires;
  n = app_debug_state(vp_dbg_state);
  vp_dbg_hdr[14] = (u8)n;
  vp_dbg_hdr[15] = (u8)(n >> 8);
}

static u8 read_pad(void) {
  u8 i, r = 0;
  JOY1 = 1;
  JOY1 = 0;
  for (i = 0; i < 8; i++) r |= (u8)((JOY1 & 1) << i);
  /* pad order A,B,Sel,Start,Up,Down,Left,Right (bits 0..7) ->
   * shared order A,B,Sel,Start,Right,Left,Up,Down */
  return (u8)((r & 0x0f) | ((r & 0x10) << 2) | ((r & 0x20) << 2) | ((r & 0x40) >> 1) | ((r & 0x80) >> 3));
}

static void ppu_addr(u16 a) {
  (void)PPUSTATUS;
  PPUADDR = (u8)(a >> 8);
  PPUADDR = (u8)a;
}

void main(void) {
  u8 prev = 0;
  u16 i;
  u8 y, x;

  /* palettes: backdrop black; subpal0 = -, white, gray, black */
  ppu_addr(0x3f00);
  PPUDATA = 0x0f;
  PPUDATA = 0x30;
  PPUDATA = 0x10;
  PPUDATA = 0x0f;
  for (i = 4; i < 32; i++) PPUDATA = 0x0f;

  /* nametable + attributes clear (rendering is still off) */
  ppu_addr(0x2000);
  for (i = 0; i < 0x400; i++) PPUDATA = 0;

  vp_row_clear(0, VP_GRID_H);
  app_init();
  app_flush();
  flush_no++;

  /* full first paint straight to the PPU while rendering is off */
  for (y = 0; y < VP_GRID_H; y++) {
    ppu_addr((u16)(0x2000 + (ORG_Y + y) * 32 + ORG_X));
    for (x = 0; x < VP_GRID_W; x++) PPUDATA = row_tile(y, x);
  }
  vp_rows_dirty = 0;
  vram_pending = 0;

  ppu_addr(0x2000); /* leave the address away from render range */
  (void)PPUSTATUS;
  PPUCTRL = 0x80; /* NMI on */
  PPUMASK = 0x0a; /* BG on + left column */

  for (;;) {
    u8 keys, edges, b, seen;
    seen = nmi_count;
    while (nmi_count == seen) {}
    if (!stage_n && vram_pending | vp_rows_dirty) fill_stage();
    frame_no++;
    debug_commit();

    keys = read_pad();
    edges = (u8)(keys & (u8)~prev);
    prev = keys;
    for (b = 0; b < 8; b++)
      if (edges & (u8)(1 << b)) app_on_button(b);
    if (app_flush()) flush_no++;
  }
}
