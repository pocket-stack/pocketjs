/* static/runtime/gba/hal_gba.c — the whole GBA platform layer.
 *
 * Mode 0. BG0 = map (charblock 0, screenblock 8, scrolls), BG1 = textbox
 * (screenblock 9, priority 0, never scrolls), OBJ 1D mapping with a shadow
 * OAM committed each vblank. VRAM on the GBA is CPU-writable at any time, so
 * there is no update queue — the HAL is embarrassingly direct.
 */
#include "gba.h"

/* generated data (gen_data.c) */
extern const u8 *const ps_blobs[];
extern const u8 ps_bg_art[];
extern const u16 ps_bg_art_tiles;
extern const u8 ps_font[];
extern const u8 ps_obj_tiles[];
extern const u16 ps_obj_tile_count;
extern const u16 ps_bg_pal0[];
extern const u16 ps_text_pal[];
extern const u16 ps_obj_pal[];
extern const u8 ps_sprite_count;

#define TEXT_PALBANK 15

static u16 oam_shadow[128 * 4];
static u8 text_rows, text_top;

const u8 *hal_blob(u8 blob) { return ps_blobs[blob]; }

/* ---- boot -------------------------------------------------------------------*/
static void upload_tiles(void) {
  const u16 *src;
  volatile u16 *dst;
  u16 i, n;

  /* art at tile 1 (tile 0 = blank, VRAM already zero) */
  src = (const u16 *)ps_bg_art;
  dst = VRAM + 16; /* one 4bpp tile = 32 bytes = 16 u16 */
  n = (u16)(ps_bg_art_tiles * 16);
  for (i = 0; i < n; i++) dst[i] = src[i];

  /* font at the fixed base */
  src = (const u16 *)ps_font;
  dst = VRAM + (u32)PS_BG_FONT_BASE * 16;
  n = FONT_GLYPHS * 16;
  for (i = 0; i < n; i++) dst[i] = src[i];

  /* OBJ tiles */
  src = (const u16 *)ps_obj_tiles;
  dst = VRAM_OBJ;
  n = (u16)(ps_obj_tile_count * 16);
  for (i = 0; i < n; i++) dst[i] = src[i];
}

void hal_init(void) {
  u16 i;
  for (i = 0; i < 16; i++) PAL_BG[i] = ps_bg_pal0[i];
  for (i = 0; i < 16; i++) PAL_BG[TEXT_PALBANK * 16 + i] = ps_text_pal[i];
  for (i = 0; i < (u16)(ps_sprite_count * 16); i++) PAL_OBJ[i] = ps_obj_pal[i];
  upload_tiles();

  for (i = 0; i < 128; i++) oam_shadow[i * 4] = 0x0200; /* disabled */

  REG_BG0CNT = (SB_MAP << 8) | 1;  /* 4bpp, charblock 0, sb 8, prio 1 */
  REG_BG1CNT = (SB_TEXT << 8) | 0; /* 4bpp, charblock 0, sb 9, prio 0 */
  REG_BG1HOFS = 0;
  REG_BG1VOFS = 0;

  /* PSG on */
  REG_SOUNDCNT_X = 0x0080;
  REG_SOUNDCNT_L = 0xff77;
  REG_SOUNDCNT_H = 0x0002;

  REG_DISPCNT = 0x0040 /* OBJ 1D */ | 0x1000 /* OBJ on */ | 0x0100 /* BG0 */ | 0x0200 /* BG1 */;
}

/* ---- frame ------------------------------------------------------------------*/
static void oam_commit(void) {
  u16 i;
  for (i = 0; i < 128 * 4; i++) OAM[i] = oam_shadow[i];
}

void hal_frame(void) {
  while (REG_VCOUNT >= 160) {}
  while (REG_VCOUNT < 160) {}
  oam_commit();
}

u8 hal_keys(void) { return (u8)(~REG_KEYINPUT & 0xff); }

/* ---- video --------------------------------------------------------------------*/
void hal_map_draw(u8 mapBlob, u8 w, u8 h) {
  const u8 *m = hal_blob(mapBlob);
  u16 tiles_off = (u16)(m[8] | ((u16)m[9] << 8));
  volatile u16 *sb = SCREENBLOCK(SB_MAP);
  u8 x, y;
  for (y = 0; y < 32; y++) {
    for (x = 0; x < 32; x++) {
      u16 e = 0;
      if (x < w && y < h) e = m[tiles_off + (u16)y * w + x];
      sb[(u16)y * 32 + x] = e;
    }
  }
}

void hal_scroll(u16 px, u16 py) {
  REG_BG0HOFS = px;
  REG_BG0VOFS = py;
}

void hal_obj(u8 slot, s16 px, s16 py, u8 spriteId, u8 dir, u8 frame, u8 hidden) {
  u16 *o = &oam_shadow[(u16)slot * 4];
  const u8 *sp = ps_sprite_table + (u16)spriteId * SPRITE_ENTRY_SIZE;
  u16 tile_base = (u16)(sp[0] | ((u16)sp[1] << 8));
  u8 frames = sp[2];
  u8 pal = sp[3];
  u8 flip = 0;
  u8 dblock = dir;

  if (hidden || px <= -16 || py <= -16 || px >= 240 || py >= 160) {
    o[0] = 0x0200; /* disable */
    return;
  }
  if (dir == DIR_LEFT) {
    dblock = DIR_RIGHT;
    flip = 1;
  }
  if (frame >= frames) frame = 0;
  o[0] = (u16)((py & 0xff) | 0x0000);                 /* square, 4bpp */
  o[1] = (u16)((px & 0x1ff) | (flip << 12) | 0x4000); /* size 16x16 */
  o[2] = (u16)((tile_base + ((u16)dblock * frames + frame) * 4) | ((u16)pal << 12));
}

/* ---- textbox ---------------------------------------------------------------------*/
void hal_text_open(u8 rows) {
  volatile u16 *sb = SCREENBLOCK(SB_TEXT);
  u8 x, y;
  text_rows = rows;
  text_top = (u8)(PS_SCREEN_TILES_H - rows - 2);
  for (y = text_top; y < PS_SCREEN_TILES_H; y++) {
    for (x = 0; x < PS_SCREEN_TILES_W; x++) {
      /* space glyph = opaque paper */
      sb[(u16)y * 32 + x] = (u16)(PS_BG_FONT_BASE | (TEXT_PALBANK << 12));
    }
  }
}

void hal_text_close(void) {
  volatile u16 *sb = SCREENBLOCK(SB_TEXT);
  u8 x, y;
  for (y = text_top; y < PS_SCREEN_TILES_H; y++) {
    for (x = 0; x < PS_SCREEN_TILES_W; x++) sb[(u16)y * 32 + x] = 0;
  }
}

void hal_text_glyph(u8 col, u8 row, u8 glyph) {
  volatile u16 *sb = SCREENBLOCK(SB_TEXT);
  u16 cell = (u16)(text_top + 1 + row) * 32 + 1 + col;
  sb[cell] = (u16)((PS_BG_FONT_BASE + glyph) | (TEXT_PALBANK << 12));
}

/* ---- sfx --------------------------------------------------------------------------*/
void hal_sfx(u8 id) {
  /* square channel 1 presets: (duty/envelope, frequency) */
  static const u16 env[5] = { 0xa1c0, 0x81c0, 0xa1c0, 0xa1c0, 0xa2c0 };
  static const u16 freq[5] = { 1750, 1200, 900, 1650, 1900 };
  if (id > 4) return;
  REG_SOUND1CNT_L = 0x0008;
  REG_SOUND1CNT_H = env[id];
  REG_SOUND1CNT_X = (u16)(0x8000 | freq[id]);
}

/* ---- entry -------------------------------------------------------------------------*/
int main(void) {
  hal_init();
  rpg_boot();
  for (;;) {
    rpg_tick();
    hal_frame();
  }
}
