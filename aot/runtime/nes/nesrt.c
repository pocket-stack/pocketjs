/* aot/runtime/nes/nesrt.c — platform layer: PPU boot, map load, collision,
 * player movement, OAM scene, input, VRAM buffer, debug block. */
#include "nesrt.h"

PjGame g;
volatile u8 pj_nmi_flag;
volatile u8 pj_ppu_off;
u8 pj_ppuctrl;
u8 pj_vbuf[72];
static u8 vbuf_len;

#define PPUCTRL (*(volatile u8 *)0x2000)
#define PPUMASK (*(volatile u8 *)0x2001)
#define PPUSTATUS (*(volatile u8 *)0x2002)
#define PPUADDR (*(volatile u8 *)0x2006)
#define PPUDATA (*(volatile u8 *)0x2007)
#define JOY1 (*(volatile u8 *)0x4016)

#define OAM ((u8 *)0x0200)

static const s8 DX[4] = {0, 0, -1, 1};
static const s8 DY[4] = {1, -1, 0, 0};

#define PLAYER_SPEED 2
#define ANIM_RATE 6

/* --- frame sync + VRAM buffer -------------------------------------------- */
void frame_sync(void) {
  u8 f = pj_nmi_flag;
  while (f == pj_nmi_flag) {}
  /* NMI flushed the buffer and rewrote the terminator */
  vbuf_len = 0;
}

u8 vbuf_room(u8 payload) {
  return (u8)(vbuf_len + 3 + payload + 1 <= sizeof(pj_vbuf));
}

static void vbuf_hdr(u16 ppu_addr, u8 len) {
  pj_vbuf[vbuf_len++] = (u8)(ppu_addr >> 8);
  pj_vbuf[vbuf_len++] = (u8)ppu_addr;
  pj_vbuf[vbuf_len++] = len;
}

void vbuf_copy(u16 ppu_addr, const u8 *src, u8 len) {
  u8 i;
  if (!vbuf_room(len)) return;
  vbuf_hdr(ppu_addr, len);
  for (i = 0; i < len; i++) pj_vbuf[vbuf_len++] = src[i];
  pj_vbuf[vbuf_len] = 0xFF;
}

void vbuf_byte(u16 ppu_addr, u8 v) {
  if (!vbuf_room(1)) return;
  vbuf_hdr(ppu_addr, 1);
  pj_vbuf[vbuf_len++] = v;
  pj_vbuf[vbuf_len] = 0xFF;
}

void vbuf_fill(u16 ppu_addr, u8 v, u8 len) {
  u8 i;
  if (!vbuf_room(len)) return;
  vbuf_hdr(ppu_addr, len);
  for (i = 0; i < len; i++) pj_vbuf[vbuf_len++] = v;
  pj_vbuf[vbuf_len] = 0xFF;
}

/* --- raw PPU access (rendering off only) ----------------------------------- */
static void ppu_addr(u16 a) {
  (void)PPUSTATUS;
  PPUADDR = (u8)(a >> 8);
  PPUADDR = (u8)a;
}

static void ppu_copy_banked(u16 dst, u8 bank, const u8 *src, u16 len) {
  u16 i;
  pj_bank_switch(bank);
  ppu_addr(dst);
  for (i = 0; i < len; i++) PPUDATA = src[i];
}

/* --- boot ------------------------------------------------------------------ */
void video_boot(void) {
  u8 i;
  pj_ppu_off = 1;
  PPUCTRL = 0x00;
  PPUMASK = 0x00;

  /* palettes */
  ppu_addr(0x3F00);
  for (i = 0; i < 32; i++) PPUDATA = pj_palettes[i];

  /* CHR-RAM: BG tiles -> PT0, OBJ tiles -> PT1 */
  ppu_copy_banked(0x0000, PJ_BANK_BG_TILES, pj_bg_tiles, (u16)PJ_BG_TILE_COUNT * 16);
  ppu_copy_banked(0x1000, PJ_BANK_OBJ_TILES, pj_obj_tiles, (u16)PJ_OBJ_TILE_COUNT * 16);

  pj_ppuctrl = 0xA8; /* NMI on | 8x16 sprites | BG PT0 */
}

/* --- map -------------------------------------------------------------------- */
void map_enter(u8 map_id, u8 tx, u8 ty, u8 dir) {
  const PjMapInfo *mi = &pj_maps[map_id];
  u8 cx, cy, i;

  pj_ppu_off = 1;
  PPUCTRL = 0x00; /* NMI off while we own the PPU */
  PPUMASK = 0x00;

  g.map_id = map_id;
  g.map_w = mi->w;
  g.map_h = mi->h;
  g.map_coll = mi->coll;
  g.map_tiles = mi->tiles;
  g.map_tiles_bank = mi->tiles_bank;
  g.actors = mi->actors;
  g.warps = mi->warps;
  g.n_actors = mi->n_actors;
  g.n_warps = mi->n_warps;

  /* stale VRAM work targets the old map; drop it (rendering is off) */
  vbuf_len = 0;
  pj_vbuf[0] = 0xFF;
  for (i = 0; i < g.n_actors; i++) {
    g.actor_dir[i] = mi->actors[i].facing;
    g.actor_frame[i] = 0;
  }

  /* nametable 0: map rows then blank; attributes all palette 0 */
  pj_bank_switch(mi->tiles_bank);
  ppu_addr(0x2000);
  for (cy = 0; cy < 30; cy++) {
    if (cy < g.map_h) {
      const u8 *row = mi->tiles + (u16)cy * g.map_w;
      for (cx = 0; cx < 32; cx++) PPUDATA = (cx < g.map_w) ? row[cx] : 0;
    } else {
      for (cx = 0; cx < 32; cx++) PPUDATA = 0;
    }
  }
  ppu_addr(0x23C0);
  for (i = 0; i < 64; i++) PPUDATA = 0;

  g.px = (s16)tx * 8;
  g.py = (s16)ty * 8;
  g.dir = dir;
  g.moving = 0;
  g.anim_frame = 0;
  g.anim_timer = 0;

  g.pending_enter = (mi->on_enter == 0xff) ? -1 : (s8)mi->on_enter;

  /* scroll + rendering back on */
  ppu_addr(0x2000); /* reset address latch usage */
  (void)PPUSTATUS;
  *(volatile u8 *)0x2005 = 0;
  *(volatile u8 *)0x2005 = 0;
  PPUCTRL = pj_ppuctrl;
  PPUMASK = 0x1E; /* BG + sprites, no clipping */
  pj_ppu_off = 0;
}

static const u8 BITMASK[8] = {1, 2, 4, 8, 16, 32, 64, 128};

u8 map_solid(s16 tx, s16 ty) {
  u16 idx;
  u8 i;
  if (tx < 0 || ty < 0 || tx >= (s16)g.map_w || ty >= (s16)g.map_h) return 1;
  idx = (u16)ty * g.map_w + (u16)tx;
  if (g.map_coll[idx >> 3] & BITMASK[idx & 7]) return 1;
  for (i = 0; i < g.n_actors; i++) {
    if ((g.actors[i].flags & ACTOR_FLAG_SOLID) && (s16)g.actors[i].x == tx && (s16)g.actors[i].y == ty) return 1;
  }
  return 0;
}

s8 map_actor_at(s16 tx, s16 ty) {
  u8 i;
  for (i = 0; i < g.n_actors; i++) {
    if ((s16)g.actors[i].x == tx && (s16)g.actors[i].y == ty) return (s8)i;
  }
  return -1;
}

/* --- player ------------------------------------------------------------------ */
void player_update(void) {
  if (!g.moving && !g.locked) {
    if (key_pressed(PJK_A)) {
      s16 tx = g.px >> 3;
      s16 ty = g.py >> 3;
      s16 fx = tx + DX[g.dir];
      s16 fy = ty + DY[g.dir];
      s8 slot = map_actor_at(fx, fy);
      if (slot >= 0 && g.actors[(u8)slot].on_talk != PJGB_SCRIPT_NONE) {
        vm_start((u8)g.actors[(u8)slot].on_talk, slot);
        return;
      }
    }
    {
      s8 dir = -1;
      if (key_held(PJK_DOWN)) dir = DIR_DOWN;
      else if (key_held(PJK_UP)) dir = DIR_UP;
      else if (key_held(PJK_LEFT)) dir = DIR_LEFT;
      else if (key_held(PJK_RIGHT)) dir = DIR_RIGHT;
      if (dir >= 0) {
        s16 nx, ny;
        g.dir = (u8)dir;
        nx = (g.px >> 3) + DX[g.dir];
        ny = (g.py >> 3) + DY[g.dir];
        if (!map_solid(nx, ny)) g.moving = 1;
      }
    }
  }

  if (g.moving) {
    g.px += DX[g.dir] * PLAYER_SPEED;
    g.py += DY[g.dir] * PLAYER_SPEED;
    ++g.anim_timer;
    if (g.anim_timer >= ANIM_RATE) {
      g.anim_timer = 0;
      g.anim_frame++;
    }
    if (((g.px & 7) == 0) && ((g.py & 7) == 0)) {
      s16 tx = g.px >> 3;
      s16 ty = g.py >> 3;
      u8 i;
      g.moving = 0;
      for (i = 0; i < g.n_warps; i++) {
        if ((s16)g.warps[i].x == tx && (s16)g.warps[i].y == ty) {
          map_enter(g.warps[i].dest_map, (u8)g.warps[i].dest_x, (u8)g.warps[i].dest_y, g.warps[i].dest_dir);
          return;
        }
      }
    }
  }
}

/* --- OAM scene ---------------------------------------------------------------- */
/* 8x16 sprites: OAM tile byte = (tile & 0xFE) | 1 (pattern table 1).
 * Hot path: cc65 is slow, so this avoids multiplies (frames is 1 or 2 by
 * compiler contract) and parks only the previously used OAM range. */
static u8 oam_i;
static u8 oam_used_prev;

static void draw_char(const PjSprite *sp, u8 dir, u8 frame, s16 sx, s16 sy) {
  register u8 *o;
  u16 tile;
  u8 idx, attr, y8, x8;
  if (oam_i > 248) return;
  if (sx <= -16 || sx >= PJGB_SCREEN_W || sy <= -16 || sy >= PJGB_SCREEN_H) return;
  idx = (sp->frames > 1) ? (u8)((dir << 1) | (frame & 1)) : dir;
  tile = sp->tile_base + ((u16)idx << 2);
  attr = sp->pal & 3;
  y8 = (u8)(sy - 1);
  x8 = (u8)sx;
  o = OAM + oam_i;
  o[0] = y8;
  o[1] = (u8)(tile & 0xFE) | 1;
  o[2] = attr;
  o[3] = x8;
  o[4] = y8;
  o[5] = (u8)((tile + 2) & 0xFE) | 1;
  o[6] = attr;
  o[7] = (u8)(x8 + 8);
  oam_i += 8;
}

void scene_draw(void) {
  register u8 i;
  const PjActor *a;
  oam_i = 0;
  draw_char(&pj_sprites[0], g.dir, g.anim_frame, g.px - 4, g.py - 8);
  a = g.actors;
  for (i = 0; i < g.n_actors; ++i, ++a) {
    if (a->sprite != 0xff) {
      draw_char(&pj_sprites[a->sprite], g.actor_dir[i], g.actor_frame[i],
                (s16)a->x * 8 - 4, (s16)a->y * 8 - 8);
    }
  }
  /* park slots used last frame but not this one */
  for (i = oam_i; i < oam_used_prev; i += 4) OAM[i] = 0xFF;
  oam_used_prev = oam_i;
}

/* --- input ------------------------------------------------------------------- */
void input_poll(void) {
  u8 i, j, k = 0;
  static const u8 MAP[8] = {PJK_A, PJK_B, PJK_SELECT, PJK_START, PJK_UP, PJK_DOWN, PJK_LEFT, PJK_RIGHT};
  JOY1 = 1;
  JOY1 = 0;
  for (i = 0; i < 8; i++) {
    j = JOY1 & 3;
    if (j) k |= MAP[i];
  }
  g.keys_prev = g.keys;
  g.keys = k;
}

u8 key_held(u8 mask) { return (u8)((g.keys & mask) != 0); }
u8 key_pressed(u8 mask) { return (u8)((g.keys & mask) != 0 && (g.keys_prev & mask) == 0); }

/* --- debug block ---------------------------------------------------------------- */
/* Hot path: one flat pointer walk (the block layout matches DBG_* offsets). */
void debug_flush(void) {
  register volatile u8 *d = (volatile u8 *)PJGB_DEBUG_ADDR;
  register const u8 *s;
  register u8 i;
  u16 cur;
  d[0x00] = 0x50; /* 'PJDB' */
  d[0x01] = 0x4A;
  d[0x02] = 0x44;
  d[0x03] = 0x42;
  d[0x04] = (u8)(g.px >> 3); /* maps are <= 32 tiles: high bytes stay 0 */
  d[0x05] = 0;
  d[0x06] = (u8)(g.py >> 3);
  d[0x07] = 0;
  d[0x08] = g.dir;
  d[0x09] = g.map_id;
  d[0x0a] = g.text_active;
  d[0x0b] = g.vm.active;
  d[0x0c] = (u8)g.frame;
  d[0x0d] = (u8)(g.frame >> 8);
  d[0x0e] = 0;
  d[0x0f] = 0;
  cur = g.text_active ? g.cur_text : 0xFFFF;
  d[0x10] = (u8)cur;
  d[0x11] = (u8)(cur >> 8);
  d[0x12] = g.choice_cursor;
  d[0x13] = 1; /* BOOTED */
  s = g.flags;
  for (i = 0; i < 16; ++i) d[0x14 + i] = s[i];
  s = (const u8 *)g.vars;
  for (i = 0; i < 32; ++i) d[0x24 + i] = s[i];
}
