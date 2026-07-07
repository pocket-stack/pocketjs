// aot/runtime/shared/render_soft.c — the software renderer.
//
// Decodes the GBA-format PJGB assets (4bpp tiles, BGR555 palettes) straight
// out of the cart blob every frame:
//   top    (PJ_TOP_W x PJ_TOP_H)       — camera window over the map + sprites
//   bottom (PJ_BOTTOM_W x PJ_BOTTOM_H) — textbox / choice menu, drawn from
//     textbox.c state with cjk16 halfcell glyphs pulled from the GLYPHS chunk
//
// Dimensions and the PJ_TX_* text layout come from the target's runtime.h, so
// one file serves two roles: the 3DS DEVICE renderer (its ctru shell just
// blits these buffers) and the HOST harness backend for every pj_frame core
// (Bun FFI reads the buffers; for hardware-rendering targets like the DS the
// PJ_TX_* constants keep this layout identical to the device renderer's).
#include "runtime.h"

static u16 fb_top[PJ_TOP_W * PJ_TOP_H];
static u16 fb_bottom[PJ_BOTTOM_W * PJ_BOTTOM_H];

const u16 *pj_top_fb(void) { return fb_top; }
const u16 *pj_bottom_fb(void) { return fb_bottom; }

// No device VRAM to set up in the software backend.
void render_init(void) {}

// Kept so map.c stays line-identical with the GBA runtime: there is no VRAM
// to preload and the camera is read fresh each frame.
void bg_load_map(void) {}
void bg_set_scroll(void) {}

// --- cached chunk pointers ---------------------------------------------------
static const u16 *bg_pal, *obj_pal;
static const u8 *bg_tiles, *obj_tiles, *glyphs;
static const SpriteRec *sprites;

static void cache_chunks(void) {
  if (bg_pal) return;
  bg_pal = (const u16 *)cart_chunk(CHUNK_PAL_BG, 0, 0);
  obj_pal = (const u16 *)cart_chunk(CHUNK_PAL_OBJ, 0, 0);
  bg_tiles = cart_chunk(CHUNK_TILES_BG, 0, 0);
  obj_tiles = cart_chunk(CHUNK_TILES_OBJ, 0, 0);
  glyphs = cart_chunk(CHUNK_GLYPHS, 0, 0);
  sprites = (const SpriteRec *)cart_chunk(CHUNK_SPRITE_TABLE, 0, 0);
}

// 4bpp tile pixel: tile data is 32 bytes, 4 bytes/row, low nibble = left px.
static inline int tile4_px(const u8 *tile, int x, int y) {
  u8 b = tile[y * 4 + (x >> 1)];
  return (x & 1) ? (b >> 4) : (b & 0xf);
}

// --- top screen: map + sprites ----------------------------------------------
static void draw_world(void) {
  int max_px = (int)g.map_w * 8, max_py = (int)g.map_h * 8;
  // Center maps smaller than the viewport (camera pins them to 0).
  int off_x = max_px < PJ_TOP_W ? (PJ_TOP_W - max_px) / 2 : 0;
  int off_y = max_py < PJ_TOP_H ? (PJ_TOP_H - max_py) / 2 : 0;
  u16 backdrop = bg_pal[0];

  for (int y = 0; y < PJ_TOP_H; y++) {
    int wy = (int)g.cam_y + y - off_y;
    for (int x = 0; x < PJ_TOP_W; x++) {
      int wx = (int)g.cam_x + x - off_x;
      u16 c = backdrop;
      if (wx >= 0 && wy >= 0 && wx < max_px && wy < max_py) {
        u16 tile = g.map_tiles[(wy >> 3) * g.map_w + (wx >> 3)];
        int idx = tile4_px(bg_tiles + tile * PJGB_TILE_4BPP_BYTES, wx & 7, wy & 7);
        c = idx ? bg_pal[g.bg_palbank * 16 + idx] : backdrop;
      }
      fb_top[y * PJ_TOP_W + x] = c;
    }
  }

  // 16x16 sprite at screen px (sx, sy): 4 tiles, TL TR BL BR.
  // The camera-centering offset applies to sprites too.
  #define DRAW_SPRITE(sp, sx0, sy0, tile0)                                     \
    do {                                                                       \
      static const int OX[4] = {0, 8, 0, 8}, OY[4] = {0, 0, 8, 8};             \
      for (int t = 0; t < 4; t++) {                                            \
        const u8 *td = obj_tiles + ((tile0) + t) * PJGB_TILE_4BPP_BYTES;       \
        for (int py = 0; py < 8; py++) {                                       \
          int y2 = (sy0) + OY[t] + py;                                         \
          if (y2 < 0 || y2 >= PJ_TOP_H) continue;                              \
          for (int px = 0; px < 8; px++) {                                     \
            int x2 = (sx0) + OX[t] + px;                                       \
            if (x2 < 0 || x2 >= PJ_TOP_W) continue;                            \
            int idx = tile4_px(td, px, py);                                    \
            if (idx) fb_top[y2 * PJ_TOP_W + x2] = obj_pal[(sp)->palbank * 16 + idx]; \
          }                                                                    \
        }                                                                      \
      }                                                                        \
    } while (0)

  int frames, tile;
  // Actors first, player on top (matches OAM slot 0 priority on the GBA).
  for (int i = 0; i < g.n_actors && i < BUDGET_MAX_ACTORS_PER_MAP; i++) {
    const ActorRec *a = &g.actors[i];
    if (a->sprite == 0xff) continue; // 0xFF = no sprite (e.g. a sign)
    const SpriteRec *sp = &sprites[a->sprite];
    frames = sp->frames ? sp->frames : 1;
    tile = sp->tile_base + g.actor_dir[i] * (frames * 4) + (g.actor_frame[i] % frames) * 4;
    DRAW_SPRITE(sp, a->x * 8 - (int)g.cam_x + off_x - 4, a->y * 8 - (int)g.cam_y + off_y - 8, tile);
  }
  {
    const SpriteRec *sp = &sprites[g.player.sprite_id];
    frames = sp->frames ? sp->frames : 1;
    tile = sp->tile_base + g.player.dir * (frames * 4) + (g.player.anim_frame % frames) * 4;
    DRAW_SPRITE(sp, (int)g.player.px - (int)g.cam_x + off_x - 4, (int)g.player.py - (int)g.cam_y + off_y - 8, tile);
  }
  #undef DRAW_SPRITE
}

// --- bottom screen: textbox / choices ----------------------------------------
// Text palette lives in BG bank 15 (indices 240+): 1..5 ink shades, 6 box bg.
// Vertical anchors/pitch (PJ_TX_*) come from the target's runtime.h so a
// hardware backend (DS render_ds.c) and this renderer share one layout.
#define TEXT_PALBANK 15
#define TEXT_BG_IDX 6
#define TEXT_X0 ((PJ_BOTTOM_W - PJGB_TEXT_COLS * 8) / 2)

static u32 half_glyph_off(int id) {
  return PJGB_GLYPH_STORE_HEADER_SIZE + (u32)id * 2 * PJGB_TILE_4BPP_BYTES;
}
static u32 full_glyph_off(int id, int half) {
  u16 half_count = *(const u16 *)glyphs;
  return PJGB_GLYPH_STORE_HEADER_SIZE +
         ((u32)half_count * 2 + (u32)id * 4 + (u32)half * 2) * PJGB_TILE_4BPP_BYTES;
}

// One halfcell = two stacked 8x8 tiles (top, bottom) at pixel (x0, y0).
static void draw_halfcell(u32 glyph_off, int x0, int y0) {
  for (int half = 0; half < 2; half++) {
    const u8 *td = glyphs + glyph_off + half * PJGB_TILE_4BPP_BYTES;
    for (int py = 0; py < 8; py++) {
      int y = y0 + half * 8 + py;
      if (y < 0 || y >= PJ_BOTTOM_H) continue;
      for (int px = 0; px < 8; px++) {
        int x = x0 + px;
        if (x < 0 || x >= PJ_BOTTOM_W) continue;
        int idx = tile4_px(td, px, py);
        fb_bottom[y * PJ_BOTTOM_W + x] = bg_pal[TEXT_PALBANK * 16 + idx];
      }
    }
  }
}

// Walk a cjk16 token stream from (x0, y0); newline drops one text line.
static void draw_tokens(const u8 *t, int x0, int y0) {
  int x = x0, y = y0;
  while (*t) {
    u8 tok = *t++;
    if (tok == TOK_NEWLINE) {
      y += PJ_TX_LINE_PITCH;
      x = x0;
      continue;
    }
    if (tok & TOK_FULL_FLAG) {
      int id = ((tok & 0x3f) << 8) | *t++;
      draw_halfcell(full_glyph_off(id, 0), x, y);
      draw_halfcell(full_glyph_off(id, 1), x + 8, y);
      x += 16;
    } else {
      draw_halfcell(half_glyph_off(tok - TOK_ASCII_MIN), x, y);
      x += 8;
    }
  }
}

static void draw_bottom(void) {
  int active = g.text_active || g.choice_active;
  u16 fill = active ? bg_pal[TEXT_PALBANK * 16 + TEXT_BG_IDX] : 0;
  for (int i = 0; i < PJ_BOTTOM_W * PJ_BOTTOM_H; i++) fb_bottom[i] = fill;
  if (!active) return;

  if (g.choice_active) {
    for (int i = 0; i < g.choice_n; i++) {
      int y = PJ_TX_CHOICE_Y0 + i * PJ_TX_LINE_PITCH;
      if (i == g.choice_cursor) draw_halfcell(half_glyph_off('>' - TOK_ASCII_MIN), TEXT_X0, y);
      draw_tokens((const u8 *)text_get(g.choice_ids[i]), TEXT_X0 + PJ_TX_CHOICE_DX, y);
    }
    return;
  }
  draw_tokens((const u8 *)text_get(g.cur_text), TEXT_X0, PJ_TX_Y0);
}

void render_frame(void) {
  cache_chunks();
  draw_world();
  draw_bottom();
}
