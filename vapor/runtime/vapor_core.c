/* vapor/runtime/vapor_core.c — target-independent runtime half.
 *
 * The cell grid IS the debug block: each target defines vp_grid_ch /
 * vp_grid_pal at its console's fixed debug address (GBA copies to EWRAM
 * instead — it can afford to), so the harness reads the same logical screen
 * the paint effects wrote, regardless of how far the console's vblank
 * budget has gotten with the physical VRAM commit. Compiled per target
 * with the same VP_* defines as gen_app.c.
 */
#include "vapor.h"

u8 vp_tripwires;
u32 vp_rows_dirty;

/* Bit table instead of `(u32)1 << n`: sdcc 4.6 (SM83) miscompiles some
 * u8-operand shifts/multiplies, and 6502 variable long shifts are slow. */
const u32 vp_bit32[32] = {
  0x1UL,       0x2UL,       0x4UL,       0x8UL,       0x10UL,       0x20UL,       0x40UL,       0x80UL,
  0x100UL,     0x200UL,     0x400UL,     0x800UL,     0x1000UL,     0x2000UL,     0x4000UL,     0x8000UL,
  0x10000UL,   0x20000UL,   0x40000UL,   0x80000UL,   0x100000UL,   0x200000UL,   0x400000UL,   0x800000UL,
  0x1000000UL, 0x2000000UL, 0x4000000UL, 0x8000000UL, 0x10000000UL, 0x20000000UL, 0x40000000UL, 0x80000000UL,
};

/* u16 row math: u8*u8 would lower to sdcc's buggy __muluchar */
#define ROW_CH(y) ((u8 *)vp_grid_ch + (u16)(y) * VP_GRID_W)
#define ROW_PAL(y) ((u8 *)vp_grid_pal + (u16)(y) * VP_GRID_W)

/* defined by the per-target runtime, at that console's debug address */
extern u8 vp_grid_ch[VP_GRID_H][VP_GRID_W];
extern u8 vp_grid_pal[VP_GRID_H][VP_GRID_W];

static void cell(u8 y, u8 x, u8 ch, u8 pal) {
  u8 *pc = ROW_CH(y) + x;
  u8 *pp = ROW_PAL(y) + x;
  if (*pc == ch && *pp == pal) return;
  *pc = ch;
  *pp = pal;
  vp_rows_dirty |= vp_bit32[y];
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
    buf[n++] = (char)('0' + (u8)(mag % 10));
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
