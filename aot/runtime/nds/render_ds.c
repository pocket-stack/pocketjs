// aot/runtime/nds/render_ds.c — DEVICE hardware renderer (libnds, dual engine).
//
// Decodes the GBA-format PJGB assets (4bpp tiles, BGR555 palettes) into the DS
// 2D hardware:
//
//   MAIN engine -> TOP screen: the world as a 128x96 viewport hardware-scaled
//     2x to fill 256x192 (GBA-sized maps letterbox at 1:1 on the DS panel).
//     The map rides an EXTENDED-AFFINE BG (16-bit text-style entries, 8bpp
//     tiles — the affine path has no 4bpp mode, so tiles are expanded on map
//     load with the map's palbank baked in). Sprites are affine double-size
//     OBJs sharing one 2x matrix.
//   SUB engine -> BOTTOM screen (256x192, 1:1): BG0 = textbox / choice menu.
//
// The bottom screen STREAMS cjk16 glyph tiles into a fixed slot region of sub
// BG VRAM, GBA-style: a screen entry's 10-bit tile index cannot address a
// whole CJK store, so each page copies just the glyphs it shows. The page is
// re-streamed only when the textbox/choice state changes.
#include <nds.h>
#include "runtime.h"

// --- VRAM layout ------------------------------------------------------------
// Main BG3 (ext. affine): tilemap at map base 0 (32x32 entries = 2KB),
// 8bpp tiles at tile base 1 (16KB in). Sub BG0 (text): same bases.
#define MAIN_MAP_BASE 0
#define MAIN_TILE_BASE 1
#define SUB_MAP_BASE 0
#define SUB_TILE_BASE 1

static u16 *main_map;   // 32x32 screen entries (top world)
static u8 *main_tiles;  // 8bpp BG char data (top world)
static u16 *sub_map;    // 32x24 used (bottom text)
static u16 *sub_tiles;  // 4bpp glyph/box char data (bottom text)

#define TEXT_PALBANK 15
#define TEXT_BG_IDX 6
#define SUB_BOX_TILE 1
#define SUB_SLOT_BASE 2 // first glyph-slot tile; slots occupy 2 tiles each
#define SE(tile, pal) (((tile) & 0x3ff) | (((pal) & 0xf) << 12))

// Text layout in tile coords, derived from the SAME PJ_TX_* pixel anchors the
// shared software renderer uses (runtime.h keeps them multiples of 8), so
// host harness screenshots match this hardware layout exactly.
#define TX_COL0 (((PJ_BOTTOM_W - PJGB_TEXT_COLS * 8) / 2) / 8)
#define TX_ROW0 (PJ_TX_Y0 / 8)
#define TX_LINE_TILES (PJ_TX_LINE_PITCH / 8)
#define TX_CHOICE_ROW0 (PJ_TX_CHOICE_Y0 / 8)
#define TX_CHOICE_CURSOR_COL TX_COL0
#define TX_CHOICE_TEXT_COL (TX_COL0 + PJ_TX_CHOICE_DX / 8)

static const SpriteRec *sprites;
static const u8 *bg_tiles4; // neutral 4bpp BG tiles from the cart
static u32 bg_tile_count;
static const u8 *glyphs; // the GLYPHS chunk (cjk16 store)

static void copy16(u16 *dst, const u16 *src, u32 bytes) {
  for (u32 i = 0; i < bytes / 2; i++) dst[i] = src[i];
}

void render_init(void) {
  powerOn(POWER_ALL_2D);

  // Main: mode 5 gives BG3 as an extended-affine BG (16-bit entries).
  videoSetMode(MODE_5_2D | DISPLAY_BG3_ACTIVE | DISPLAY_SPR_ACTIVE | DISPLAY_SPR_1D);
  videoSetModeSub(MODE_0_2D | DISPLAY_BG0_ACTIVE);
  vramSetBankA(VRAM_A_MAIN_BG);
  vramSetBankB(VRAM_B_MAIN_SPRITE);
  vramSetBankC(VRAM_C_SUB_BG);

  oamInit(&oamMain, SpriteMapping_1D_32, false);

  REG_BG3CNT = BG_MAP_BASE(MAIN_MAP_BASE) | BG_TILE_BASE(MAIN_TILE_BASE) | BG_PRIORITY(1) | (1 << 14); // 256x256
  REG_BG0CNT_SUB = BG_MAP_BASE(SUB_MAP_BASE) | BG_TILE_BASE(SUB_TILE_BASE) | BG_COLOR_16 | BG_32x32 | BG_PRIORITY(0);

  main_map = (u16 *)BG_MAP_RAM(MAIN_MAP_BASE);
  main_tiles = (u8 *)BG_TILE_RAM(MAIN_TILE_BASE);
  sub_map = (u16 *)BG_MAP_RAM_SUB(SUB_MAP_BASE);
  sub_tiles = (u16 *)BG_TILE_RAM_SUB(SUB_TILE_BASE);

  // --- upload static assets from the cart blob (once) ---
  u32 sz;
  const u16 *bgpal = (const u16 *)cart_chunk(CHUNK_PAL_BG, 0, &sz);
  if (bgpal) {
    copy16(BG_PALETTE, bgpal, sz);
    copy16(BG_PALETTE_SUB, bgpal, sz); // text uses BG bank 15, shared palette
  }
  const u16 *objpal = (const u16 *)cart_chunk(CHUNK_PAL_OBJ, 0, &sz);
  if (objpal) copy16(SPRITE_PALETTE, objpal, sz);

  bg_tiles4 = cart_chunk(CHUNK_TILES_BG, 0, &sz);
  bg_tile_count = sz / PJGB_TILE_4BPP_BYTES;
  const u16 *objt = (const u16 *)cart_chunk(CHUNK_TILES_OBJ, 0, &sz);
  if (objt) copy16(SPRITE_GFX, objt, sz);

  sprites = (const SpriteRec *)cart_chunk(CHUNK_SPRITE_TABLE, 0, 0);

  // One shared 2x rot/scale matrix for all sprites (identity/2 in 8.8).
  oamMain.oamRotationMemory[0].hdx = 0x80;
  oamMain.oamRotationMemory[0].hdy = 0;
  oamMain.oamRotationMemory[0].vdx = 0;
  oamMain.oamRotationMemory[0].vdy = 0x80;

  // Sub tile 0 = blank; tile SUB_BOX_TILE = solid TEXT_BG fill.
  for (int i = 0; i < 16; i++) sub_tiles[i] = 0;
  {
    u8 fill = (TEXT_BG_IDX & 0xf) | (TEXT_BG_IDX << 4);
    u16 word = fill | (fill << 8);
    for (int i = 0; i < 16; i++) sub_tiles[SUB_BOX_TILE * 16 + i] = word;
  }
  glyphs = cart_chunk(CHUNK_GLYPHS, 0, 0);
}

// Center maps smaller than the viewport (matches the software renderer).
static int view_off_x, view_off_y;

static void compute_view_off(void) {
  int max_px = (int)g.map_w * 8, max_py = (int)g.map_h * 8;
  view_off_x = max_px < PJ_TOP_W ? (PJ_TOP_W - max_px) / 2 : 0;
  view_off_y = max_py < PJ_TOP_H ? (PJ_TOP_H - max_py) / 2 : 0;
}

// The affine BG path has no 4bpp mode, so expand the neutral 4bpp tiles to
// 8bpp on map load with the map's palette bank baked into each pixel (index 0
// stays 0 = backdrop). Tile 0 is kept blank; game tiles shift +1.
// NB: VRAM ignores 8-bit writes (bytes are silently dropped on DS/GBA BG
// VRAM), so every store below is a composed u16 — one per source 4bpp byte.
void bg_load_map(void) {
  u16 *vram = (u16 *)main_tiles;
  for (int i = 0; i < 32; i++) vram[i] = 0; // blank tile 0 (64 bytes)
  u32 base = (u32)g.bg_palbank * 16;
  for (u32 t = 0; t < bg_tile_count; t++) {
    const u8 *src = bg_tiles4 + t * PJGB_TILE_4BPP_BYTES;
    u16 *dst = vram + (t + 1) * 32; // 8bpp tile = 64 bytes = 32 u16
    for (int i = 0; i < PJGB_TILE_4BPP_BYTES; i++) {
      u8 b = src[i];
      u8 lo = b & 0xf, hi = b >> 4;
      dst[i] = (u16)((lo ? base + lo : 0) | ((hi ? base + hi : 0) << 8));
    }
  }
  for (int cy = 0; cy < 32; cy++)
    for (int cx = 0; cx < 32; cx++) {
      u16 se = 0;
      if (cx < g.map_w && cy < g.map_h) se = (u16)((g.map_tiles[cy * g.map_w + cx] + 1) & 0x3ff);
      main_map[cy * 32 + cx] = se;
    }
}

void bg_set_scroll(void) {
  // 2x zoom: texture step 0.5 per screen px (8.8 fixed), reference point at
  // the camera corner (20.8 fixed). Negative ref (centering offset) wraps the
  // affine BG; the wrapped-in area is blank tile 0 -> backdrop.
  REG_BG3PA = 0x80;
  REG_BG3PB = 0;
  REG_BG3PC = 0;
  REG_BG3PD = 0x80;
  REG_BG3X = ((s32)g.cam_x - view_off_x) << 8;
  REG_BG3Y = ((s32)g.cam_y - view_off_y) << 8;
}

// --- sprites: affine double-size OBJs sharing matrix 0 (2x) ------------------
#define OA0_HIDE 0x0200
#define OA0_AFFINE_DOUBLE 0x0300 // rotscale + double-size
#define OA1_SIZE_16 0x4000
#define PJ_SPRITE_COUNT 128

static void put_sprite(int slot, int vx, int vy, int tile, int pal) {
  // view coords (128x96 space) -> screen px (2x); the 32x32 double-size box's
  // top-left lands exactly on the doubled position.
  int sx = vx * 2, sy = vy * 2;
  SpriteEntry *e = &oamMain.oamMemory[slot];
  e->attribute[0] = (u16)(sy & 0xff) | OA0_AFFINE_DOUBLE;
  e->attribute[1] = (u16)(sx & 0x1ff) | OA1_SIZE_16; // matrix index 0
  e->attribute[2] = (u16)((tile & 0x3ff) | ((pal & 0xf) << 12));
}

static int sprite_tile(const SpriteRec *sp, int dir, int frame) {
  int frames = sp->frames ? sp->frames : 1;
  return sp->tile_base + dir * (frames * 4) + (frame % frames) * 4;
}

static int offscreen(int vx, int vy) {
  return vx + 16 <= 0 || vx >= PJ_TOP_W || vy + 16 <= 0 || vy >= PJ_TOP_H;
}

static void draw_sprites(void) {
  for (int i = 0; i < PJ_SPRITE_COUNT; i++) oamMain.oamMemory[i].attribute[0] = OA0_HIDE;

  int slot = 0;
  // Actors first, player last (player wins ties, matching the GBA slot order).
  for (int i = 0; i < g.n_actors && i < BUDGET_MAX_ACTORS_PER_MAP; i++) {
    const ActorRec *a = &g.actors[i];
    if (a->sprite == 0xff) continue;
    const SpriteRec *sp = &sprites[a->sprite];
    int vx = a->x * 8 - (int)g.cam_x + view_off_x - 4;
    int vy = a->y * 8 - (int)g.cam_y + view_off_y - 8;
    if (offscreen(vx, vy)) continue;
    put_sprite(slot++, vx, vy, sprite_tile(sp, g.actor_dir[i], g.actor_frame[i]), sp->palbank);
  }
  {
    const SpriteRec *sp = &sprites[g.player.sprite_id];
    int frames = sp->frames ? sp->frames : 1;
    int vx = (int)g.player.px - (int)g.cam_x + view_off_x - 4;
    int vy = (int)g.player.py - (int)g.cam_y + view_off_y - 8;
    if (!offscreen(vx, vy)) put_sprite(slot++, vx, vy, sprite_tile(sp, g.player.dir, g.player.anim_frame % frames), sp->palbank);
  }
}

// --- bottom screen: textbox / choices (streamed glyph slots) -----------------
// A screen entry's tile field is 10 bits (<= 1023), but a game may bake up to
// BUDGET_MAX_FULL_GLYPHS fullwidth glyphs (thousands of tiles) — far more than
// a tile index can address. So, exactly like the GBA runtime, glyph pixel data
// is STREAMED: each halfcell drawn on the current page copies its 2 tiles from
// the cart's GLYPHS chunk into the next free VRAM slot (PJGB_TEXT_GLYPH_SLOTS
// slots after the box tile; the compiler wraps pages so a page always fits).
// The page is re-streamed only when the textbox/choice state changes.

// Byte offsets into the GLYPHS chunk (same formulas as the shared renderer).
static u32 half_glyph_off(int id) {
  return PJGB_GLYPH_STORE_HEADER_SIZE + (u32)id * 2 * PJGB_TILE_4BPP_BYTES;
}
static u32 full_glyph_off(int id, int half) {
  u16 half_count = *(const u16 *)glyphs;
  return PJGB_GLYPH_STORE_HEADER_SIZE +
         ((u32)half_count * 2 + (u32)id * 4 + (u32)half * 2) * PJGB_TILE_4BPP_BYTES;
}

static u16 slot_next;

// Stream one halfcell (2 stacked tiles) into the next free slot and stamp it
// at tile cell (row, col). Drops on overflow (the compiler sizes pages so this
// cannot happen — same contract as the GBA runtime).
static void put_halfcell(u32 glyph_off, int row, int col) {
  if (col < 0 || col >= 32 || row < 0 || row >= 23) return;
  if (slot_next >= PJGB_TEXT_GLYPH_SLOTS) return;
  u32 tile = SUB_SLOT_BASE + (u32)slot_next * 2;
  copy16(sub_tiles + tile * 16, (const u16 *)(glyphs + glyph_off), 2 * PJGB_TILE_4BPP_BYTES);
  slot_next++;
  sub_map[row * 32 + col] = SE(tile, TEXT_PALBANK);
  sub_map[(row + 1) * 32 + col] = SE(tile + 1, TEXT_PALBANK);
}

static void render_tokens(const u8 *t, int row0, int col0) {
  int row = row0, col = col0;
  while (*t) {
    u8 tok = *t++;
    if (tok == TOK_NEWLINE) {
      row += TX_LINE_TILES;
      col = col0;
      continue;
    }
    if (tok & TOK_FULL_FLAG) {
      int id = ((tok & 0x3f) << 8) | *t++;
      put_halfcell(full_glyph_off(id, 0), row, col);
      put_halfcell(full_glyph_off(id, 1), row, col + 1);
      col += 2;
    } else {
      put_halfcell(half_glyph_off(tok - TOK_ASCII_MIN), row, col);
      col += 1;
    }
  }
}

// Re-stream/stamp only when the textbox state changes (VRAM writes are not
// free, and the state is stable for many frames at a time).
static void draw_bottom(void) {
  static u8 p_text = 0xff, p_choice, p_cursor, p_n;
  static u16 p_cur, p_id0;
  if (g.text_active == p_text && g.choice_active == p_choice && g.choice_cursor == p_cursor &&
      g.choice_n == p_n && g.cur_text == p_cur && g.choice_ids[0] == p_id0)
    return;
  p_text = g.text_active;
  p_choice = g.choice_active;
  p_cursor = g.choice_cursor;
  p_n = g.choice_n;
  p_cur = g.cur_text;
  p_id0 = g.choice_ids[0];

  int active = g.text_active || g.choice_active;
  u16 fill = active ? SE(SUB_BOX_TILE, TEXT_PALBANK) : SE(0, 0);
  for (int i = 0; i < 32 * 24; i++) sub_map[i] = fill;
  slot_next = 0;
  if (!active) return;

  if (g.choice_active) {
    for (int i = 0; i < g.choice_n; i++) {
      int row = TX_CHOICE_ROW0 + i * TX_LINE_TILES;
      if (i == g.choice_cursor) put_halfcell(half_glyph_off('>' - TOK_ASCII_MIN), row, TX_CHOICE_CURSOR_COL);
      render_tokens((const u8 *)text_get(g.choice_ids[i]), row, TX_CHOICE_TEXT_COL);
    }
    return;
  }
  render_tokens((const u8 *)text_get(g.cur_text), TX_ROW0, TX_COL0);
}

void render_frame(void) {
  compute_view_off();
  bg_set_scroll();
  draw_sprites();
  draw_bottom();
  oamUpdate(&oamMain);
}

// The host runner reads these; on device they are unused (real screens present
// the hardware engines), but the symbols must exist for the shared interface.
const u16 *pj_top_fb(void) { return 0; }
const u16 *pj_bottom_fb(void) { return 0; }
