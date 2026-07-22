/* vapor/runtime/gba/vapor_gba.c — the whole fixed GBA runtime.
 *
 * Mode 0, BG0 only: a 30x20 cell text grid. Cells live in a shadow buffer
 * (chars + palettes); writes diff at the cell and mark the row dirty, and
 * the commit after vblank copies only dirty rows into the screenblock. The
 * generated app never touches VRAM, keys or timing — it paints cells and
 * flips reactive state; this file is the machine.
 *
 * Layout carried over from Pocket Static's GBA target (same crt0/ld
 * lineage): charblock 0 holds tile 0 = blank plus 95 font glyphs at tile 1,
 * screenblock 8 is the visible map, EWRAM base is the debug block.
 */
#include "vapor.h"

#define REG(addr) (*(volatile u16 *)(addr))
#define REG_DISPCNT REG(0x04000000)
#define REG_VCOUNT REG(0x04000006)
#define REG_BG0CNT REG(0x04000008)
#define REG_BG0HOFS REG(0x04000010)
#define REG_BG0VOFS REG(0x04000012)
#define REG_KEYINPUT REG(0x04000130)
#define PAL_BG ((volatile u16 *)0x05000000)
#define VRAM ((volatile u16 *)0x06000000)
#define SB_MAP 8
#define SCREENBLOCK(n) ((volatile u16 *)(0x06000000 + (n) * 0x800))

#define DBG_BASE ((volatile u8 *)0x02000000)
#define DBG_FRAME ((volatile u32 *)(0x02000000 + 4))
#define DBG_FLUSHES ((volatile u32 *)(0x02000000 + 8))
#define DBG_TRIPS ((volatile u8 *)(0x02000000 + 12))
#define DBG_STATE_BYTES ((volatile u16 *)(0x02000000 + 14))
#define DBG_STATE ((volatile u8 *)(0x02000000 + 16))
#define DBG_CHARS ((volatile u8 *)(0x02000000 + 0x100))
#define DBG_PALS ((volatile u8 *)(0x02000000 + 0x360))

u8 vp_tripwires;

/* Freestanding: gcc lowers struct assignment to memcpy/memset calls. */
void *memcpy(void *dst, const void *src, unsigned long n) {
  u8 *d = (u8 *)dst;
  const u8 *s = (const u8 *)src;
  while (n--) *d++ = *s++;
  return dst;
}

void *memset(void *dst, int v, unsigned long n) {
  u8 *d = (u8 *)dst;
  while (n--) *d++ = (u8)v;
  return dst;
}

static u8 grid_ch[VP_GRID_H][VP_GRID_W];
static u8 grid_pal[VP_GRID_H][VP_GRID_W];
static u32 rows_dirty;

/* ---- grid ------------------------------------------------------------------- */
static void cell(u8 y, u8 x, u8 ch, u8 pal) {
  if (grid_ch[y][x] == ch && grid_pal[y][x] == pal) return;
  grid_ch[y][x] = ch;
  grid_pal[y][x] = pal;
  rows_dirty |= (u32)1 << y;
}

void vp_row_clear(u8 y0, u8 y1) {
  u8 y, x;
  for (y = y0; y < y1 && y < VP_GRID_H; y++)
    for (x = 0; x < VP_GRID_W; x++) cell(y, x, ' ', 0);
}

void vp_put_ch(u8 y, u8 *col, u8 pal, char c) {
  u8 ch = (u8)c;
  if (*col >= VP_GRID_W) return;
  if (ch < 0x20 || ch > 0x7e) ch = '?';
  cell(y, *col, ch, pal);
  *col = (u8)(*col + 1);
}

void vp_put_str(u8 y, u8 *col, u8 pal, const char *s) {
  while (*s) vp_put_ch(y, col, pal, *s++);
}

void vp_put_sb(u8 y, u8 *col, u8 pal, const vp_sb *s) {
  u8 i;
  for (i = 0; i < s->len; i++) vp_put_ch(y, col, pal, s->b[i]);
}

void vp_put_int(u8 y, u8 *col, u8 pal, s32 v) {
  char buf[12];
  u8 n = 0;
  u32 mag;
  if (v < 0) {
    vp_put_ch(y, col, pal, '-');
    mag = (u32)(-v);
  } else {
    mag = (u32)v;
  }
  do {
    buf[n++] = (char)('0' + (mag % 10));
    mag /= 10;
  } while (mag && n < 11);
  while (n) vp_put_ch(y, col, pal, buf[--n]);
}

void vp_pad(u8 y, u8 col, u8 pal) {
  u8 x;
  for (x = col; x < VP_GRID_W; x++) cell(y, x, ' ', pal);
}

/* ---- strings ---------------------------------------------------------------- */
void vp_sb_reset(vp_sb *s) { s->len = 0; }

void vp_sb_ch(vp_sb *s, char c) {
  if (s->len >= VP_STR_CAP) {
    vp_tripwires |= VP_TRIP_STR_TRUNC;
    return;
  }
  s->b[s->len++] = c;
}

void vp_sb_str(vp_sb *s, const char *lit) {
  while (*lit) vp_sb_ch(s, *lit++);
}

void vp_sb_sb(vp_sb *s, const vp_sb *src) {
  u8 i;
  for (i = 0; i < src->len; i++) vp_sb_ch(s, src->b[i]);
}

void vp_sb_slice(vp_sb *dst, const vp_sb *src, s32 start, s32 end) {
  s32 len = src->len, i;
  if (start < 0) start += len;
  if (end < 0) end += len;
  if (start < 0) start = 0;
  if (end > len) end = len;
  dst->len = 0;
  for (i = start; i < end; i++) vp_sb_ch(dst, src->b[i]);
}

u8 vp_sb_eq(const vp_sb *a, const vp_sb *b) {
  u8 i;
  if (a->len != b->len) return 0;
  for (i = 0; i < a->len; i++)
    if (a->b[i] != b->b[i]) return 0;
  return 1;
}

u8 vp_sb_assign(vp_sb *dst, const vp_sb *tmp) {
  u8 i;
  if (vp_sb_eq(dst, tmp)) return 0;
  dst->len = tmp->len;
  for (i = 0; i < tmp->len; i++) dst->b[i] = tmp->b[i];
  return 1;
}

/* ---- video ------------------------------------------------------------------ */
static void upload_font(void) {
  const u16 *src = (const u16 *)vp_font_tiles;
  volatile u16 *dst = VRAM + 16; /* tile 1; tile 0 stays blank */
  u16 i;
  for (i = 0; i < 95 * 16; i++) dst[i] = src[i];
}

static void commit_rows(void) {
  volatile u16 *sb = SCREENBLOCK(SB_MAP);
  u8 y, x;
  if (!rows_dirty) return;
  for (y = 0; y < VP_GRID_H; y++) {
    if (!(rows_dirty & ((u32)1 << y))) continue;
    for (x = 0; x < VP_GRID_W; x++) {
      /* glyph tile = 1 + (ascii - 0x20); palette bank in the high nibble */
      u16 entry = (u16)((1 + (grid_ch[y][x] - 0x20)) | ((u16)grid_pal[y][x] << 12));
      sb[(u16)y * 32 + x] = entry;
    }
  }
  rows_dirty = 0;
}

static void debug_commit(u32 frame, u32 flushes) {
  u16 i;
  DBG_BASE[0] = 'P';
  DBG_BASE[1] = 'V';
  DBG_BASE[2] = 'D';
  DBG_BASE[3] = 'B';
  *DBG_FRAME = frame;
  *DBG_FLUSHES = flushes;
  *DBG_TRIPS = vp_tripwires;
  *DBG_STATE_BYTES = app_debug_state(DBG_STATE);
  for (i = 0; i < VP_GRID_H * VP_GRID_W; i++) {
    DBG_CHARS[i] = ((const u8 *)grid_ch)[i];
    DBG_PALS[i] = ((const u8 *)grid_pal)[i];
  }
}

static void vsync(void) {
  while (REG_VCOUNT >= 160) {}
  while (REG_VCOUNT < 160) {}
}

/* ---- entry ------------------------------------------------------------------ */
int main(void) {
  u16 i;
  u16 prev_keys = 0x03ff;
  u32 frame = 0, flushes = 0;

  for (i = 0; i < vp_palette_count * 16; i++) PAL_BG[i] = vp_palettes[i];
  PAL_BG[0] = vp_backdrop;
  upload_font();
  REG_BG0CNT = (SB_MAP << 8) | 0; /* 4bpp, charblock 0, priority 0 */
  REG_BG0HOFS = 0;
  REG_BG0VOFS = 0;

  vp_row_clear(0, VP_GRID_H);
  app_init();
  app_flush();
  flushes++;

  REG_DISPCNT = 0x0100; /* mode 0, BG0 on */

  for (;;) {
    u16 keys, edges;
    u8 b;
    vsync();
    commit_rows();
    frame++;
    debug_commit(frame, flushes);

    keys = (u16)(REG_KEYINPUT & 0x03ff);
    edges = (u16)(prev_keys & ~keys); /* KEYINPUT is active-low */
    prev_keys = keys;
    for (b = 0; b < 10; b++)
      if (edges & (u16)(1 << b)) app_on_button(b);
    if (app_flush()) flushes++;
  }
}
