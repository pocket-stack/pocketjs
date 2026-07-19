/* static/runtime/nes/hal_nes.c — the NES platform layer.
 *
 * cc65, mapper 2 (UNROM) with CHR-RAM. The NMI (crt0.s) owns all steady-
 * state PPU traffic: OAM DMA + a 64-entry VRAM write ring (single writes and
 * fill-8 runs). C touches the PPU directly only with rendering + NMI off
 * (init, map loads). No scrolling: maps are one nametable, and the textbox
 * permanently owns tile rows 24-29 (whole attribute rows).
 */
#include "hal.h"

#define PPU_CTRL (*(volatile u8 *)0x2000)
#define PPU_MASK (*(volatile u8 *)0x2001)
#define PPU_STATUS (*(volatile u8 *)0x2002)
#define PPU_ADDR (*(volatile u8 *)0x2006)
#define PPU_DATA (*(volatile u8 *)0x2007)
#define APU_STATUS (*(volatile u8 *)0x4015)
#define APU_P1_ENV (*(volatile u8 *)0x4000)
#define APU_P1_SWEEP (*(volatile u8 *)0x4001)
#define APU_P1_LO (*(volatile u8 *)0x4002)
#define APU_P1_HI (*(volatile u8 *)0x4003)
#define JOY1 (*(volatile u8 *)0x4016)

#define OAM_SHADOW ((volatile u8 *)0x0200)
#define NT0 0x2000
#define ATTR0 0x23c0

/* PPUCTRL shadow: NMI on, 8x16 sprites, BG table 0, inc +1, NT 0. */
#define CTRL_ON 0xa0

/* generated (fixed bank) */
extern const u8 ps_blob_bank[];
extern const u8 *const ps_blob_addr[];
extern const u8 ps_art_blob;
extern const u8 ps_bg_tile_count;
extern const u8 ps_font_blob;
extern const u8 ps_obj_blob;
extern const u16 ps_obj_tile_bytes;
extern const u8 ps_bg_pal[4];  /* backdrop + art subpal */
extern const u8 ps_obj_pal[16]; /* 4 OBJ subpals */
extern u8 ps_banktable[]; /* crt0: bus-conflict-safe latch */

/* shared with crt0's NMI (volatile: the NMI mutates head/count) */
u8 q_hi[64], q_lo[64], q_val[64];
volatile u8 q_head;
volatile u8 q_tail;
u8 ppuctrl;
volatile u8 nmi_count;

static u8 text_rows;
static u8 restore_rows; /* box rows pending blank-restore after close */

const u8 *hal_blob(u8 blob) {
  u8 b = ps_blob_bank[blob];
  ps_banktable[b] = b;
  return ps_blob_addr[blob];
}

/* ring producer (NMI consumes) */
static void qpush(u8 hi, u8 lo, u8 val) {
  while ((u8)(q_tail - q_head) >= 64) {} /* ring full: the NMI will drain */
  {
    u8 i = q_tail & 63;
    q_hi[i] = hi;
    q_lo[i] = lo;
    q_val[i] = val;
  }
  ++q_tail;
}
#define QFILL8 0x80

static void nmi_wait(void) {
  u8 start = nmi_count;
  while (nmi_count == start) {}
}

/* ---- init -------------------------------------------------------------------*/
static void ppu_addr(u16 a) {
  (void)PPU_STATUS;
  PPU_ADDR = (u8)(a >> 8);
  PPU_ADDR = (u8)a;
}

static void upload_chr(u16 base, const u8 *src, u16 bytes) {
  u16 i;
  ppu_addr(base);
  for (i = 0; i < bytes; i++) PPU_DATA = src[i];
}

void hal_init(void) {
  u8 i;
  const u8 *src;

  /* CHR-RAM: BG table 0 = blank + art + font(fixed base); table 1 = OBJ */
  src = hal_blob(ps_art_blob);
  upload_chr(16, src, (u16)ps_bg_tile_count << 4);
  src = hal_blob(ps_font_blob);
  upload_chr((u16)PS_BG_FONT_BASE << 4, src, FONT_GLYPHS * 16);
  src = hal_blob(ps_obj_blob);
  upload_chr(0x1000, src, ps_obj_tile_bytes);

  /* palettes */
  ppu_addr(0x3f00);
  for (i = 0; i < 4; i++) PPU_DATA = ps_bg_pal[i];
  for (i = 0; i < 8; i++) PPU_DATA = 0x0f; /* subpal 1,2 unused */
  PPU_DATA = ps_bg_pal[0];
  PPU_DATA = 0x30; /* white */
  PPU_DATA = 0x2d; /* grey */
  PPU_DATA = 0x0f; /* black — subpal 3 = textbox */
  ppu_addr(0x3f10);
  for (i = 0; i < 16; i++) PPU_DATA = ps_obj_pal[i];

  /* OAM shadow off-screen */
  for (i = 0; i < 64; i++) OAM_SHADOW[(u8)(i << 2)] = 0xff;

  APU_STATUS = 0x01; /* pulse 1 on */

  ppuctrl = CTRL_ON;
  PPU_CTRL = CTRL_ON;
  PPU_MASK = 0x1e; /* BG + sprites on, left column shown */
}

/* ---- frame -------------------------------------------------------------------*/
void hal_frame(void) {
  nmi_wait();
}

u8 hal_keys(void) {
  u8 i, v, out = 0;
  /* standard shift order: A,B,Select,Start,Up,Down,Left,Right */
  static const u8 MAP[8] = { 0x01, 0x02, 0x04, 0x08, 0x40, 0x80, 0x20, 0x10 };
  JOY1 = 1;
  JOY1 = 0;
  for (i = 0; i < 8; i++) {
    v = JOY1;
    if (v & 1) out |= MAP[i];
  }
  return out;
}

/* ---- video ---------------------------------------------------------------------*/
void hal_map_draw(u8 mapBlob, u8 w, u8 h) {
  const u8 *m;
  const u8 *row;
  u8 x, y;

  nmi_wait();
  PPU_CTRL = 0; /* NMI off */
  PPU_MASK = 0; /* rendering off */

  m = hal_blob(mapBlob);
  row = m + (u16)(m[8] | ((u16)m[9] << 8));
  ppu_addr(NT0);
  for (y = 0; y < 30; y++) {
    for (x = 0; x < 32; x++) {
      u8 e = 0;
      if (x < w && y < h) e = row[x];
      PPU_DATA = e;
    }
    if (y < h) row += w;
  }
  /* attributes: everything subpal 0 */
  ppu_addr(ATTR0);
  for (x = 0; x < 64; x++) PPU_DATA = 0;

  q_head = 0;
  q_tail = 0;
  restore_rows = 0;

  ppu_addr(0x2000); /* leave the address away from palette space */
  (void)PPU_STATUS;
  PPU_CTRL = ppuctrl;
  PPU_MASK = 0x1e;
}

void hal_scroll(u16 px, u16 py) {
  (void)px;
  (void)py;
}

void hal_obj(u8 slot, s16 px, s16 py, u8 spriteId, u8 dir, u8 frame, u8 hidden) {
  volatile u8 *o = OAM_SHADOW + ((u8)(slot << 3)); /* 2 hw sprites */
  const u8 *sp = ps_sprite_table + ((u16)spriteId << 2);
  u16 tile_base = (u16)(sp[0] | ((u16)sp[1] << 8));
  u8 frames = sp[2];
  u8 pal = sp[3];
  u8 flip = 0;
  u8 dblock = dir;
  u8 pair;

  if (hidden || px <= -16 || py <= -16 || px >= 256 || py >= 240) {
    o[0] = 0xff;
    o[4] = 0xff;
    return;
  }
  if (dir == DIR_LEFT) {
    dblock = DIR_RIGHT;
    flip = 0x40;
  }
  if (frame >= frames) frame = 0;
  /* frame block = 4 tiles [Ltop,Lbot,Rtop,Rbot] in pattern table 1.
   * 8x16 OAM tile byte: bit0 selects the table (1), bits 1-7 pick the even
   * tile of the pair — so left column = t|1, right column = (t+2)|1. */
  pair = frames == 2 ? (u8)(dblock << 1) : dblock; /* dblock*frames, no mul */
  {
    u8 t = (u8)((u8)tile_base + ((u8)(pair + frame) << 2));
    /* NES renders sprites one line late; py 0 clamps (255 would hide it) */
    u8 oy = py > 0 ? (u8)(py - 1) : 0;
    o[0] = oy;
    o[1] = (u8)(t | 1);
    o[2] = (u8)(pal | flip);
    o[3] = flip ? (u8)(px + 8) : (u8)px;
    o[4] = oy;
    o[5] = (u8)((t + 2) | 1);
    o[6] = (u8)(pal | flip);
    o[7] = flip ? (u8)px : (u8)(px + 8);
  }
}

/* ---- textbox -----------------------------------------------------------------------
 * Box = tile rows 24..29 (attr rows 6-7). Text row r -> tile row 25+r,
 * cols 2..29. Open paints paper fills + attr; close restores blank fills.
 */
static void box_fills(u8 tile, u8 attr) {
  u8 y, q;
  for (y = 24; y < 30; y++) {
    u16 base = NT0 + ((u16)y << 5);
    for (q = 0; q < 4; q++) {
      qpush((u8)((base >> 8) | QFILL8), (u8)(base & 0xff), tile);
      base += 8;
    }
  }
  {
    u16 a = ATTR0 + 48;
    for (q = 0; q < 2; q++) {
      qpush((u8)((a >> 8) | QFILL8), (u8)(a & 0xff), attr);
      a += 8;
    }
  }
}

void hal_text_open(u8 rows) {
  text_rows = rows;
  box_fills(PS_BG_FONT_BASE, 0xff); /* paper + subpal 3 */
}

void hal_text_close(void) {
  box_fills(0, 0x00); /* blank + subpal 0 (maps never reach these rows) */
}

void hal_text_glyph(u8 col, u8 row, u8 glyph) {
  u16 a = NT0 + ((u16)(25 + row) << 5) + 2 + col;
  qpush((u8)(a >> 8), (u8)a, (u8)(PS_BG_FONT_BASE + glyph));
}

/* ---- sfx ------------------------------------------------------------------------------*/
void hal_sfx(u8 id) {
  static const u8 env[5] = { 0x86, 0x84, 0x83, 0x86, 0x87 };
  static const u8 lo[5] = { 0x60, 0xa0, 0xf0, 0x70, 0x50 };
  if (id > 4) return;
  APU_P1_ENV = env[id];
  APU_P1_SWEEP = 0x08;
  APU_P1_LO = lo[id];
  APU_P1_HI = 0x08;
}

/* ---- entry ----------------------------------------------------------------------------*/
void main(void) {
  hal_init();
  rpg_boot();
  for (;;) {
    rpg_tick();
    hal_frame();
  }
}
