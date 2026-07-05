// aot/runtime/video.c — display setup + one-time VRAM/palette upload.
#include "runtime.h"

static void copy16(u16 *dst, const u16 *src, u32 bytes) {
  for (u32 i = 0; i < bytes / 2; i++) dst[i] = src[i];
}

void video_load_palettes(void) {
  u32 sz;
  const u16 *bg = (const u16 *)cart_chunk(CHUNK_PAL_BG, 0, &sz);
  if (bg) copy16(BG_PAL, bg, sz);
  const u16 *ob = (const u16 *)cart_chunk(CHUNK_PAL_OBJ, 0, &sz);
  if (ob) copy16(OBJ_PAL, ob, sz);
}

void video_load_obj_tiles(void) {
  u32 sz;
  const u16 *t = (const u16 *)cart_chunk(CHUNK_TILES_OBJ, 0, &sz);
  if (t) copy16(OBJ_VRAM, t, sz);
}

void video_init(void) {
  REG_DISPCNT = DCNT_MODE0 | DCNT_BG0 | DCNT_OBJ | DCNT_OBJ_1D;
  REG_BG0CNT = BG_CBB(PJ_BG_CBB) | BG_SBB(PJ_MAP_SBB) | BG_4BPP | BG_REG_32x32 | BG_PRIO(1);
  REG_BG1CNT = BG_CBB(PJ_BG_CBB) | BG_SBB(PJ_TEXT_SBB) | BG_4BPP | BG_REG_32x32 | BG_PRIO(0);

  video_load_palettes();
  video_load_obj_tiles();

  // BG character data (map tileset + font glyphs) -> BG charblock.
  u32 sz;
  const u16 *bgt = (const u16 *)cart_chunk(CHUNK_TILES_BG, 0, &sz);
  if (bgt) copy16(CHARBLOCK(PJ_BG_CBB), bgt, sz);
}
