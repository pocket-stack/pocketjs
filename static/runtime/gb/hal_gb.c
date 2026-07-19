/* static/runtime/gb/hal_gb.c — the Game Boy (DMG) platform layer.
 *
 * BG = map (0x9800, SCX/SCY scroll), Window = textbox (0x9C00 — showing the
 * box is a register write, no map restore ever). BG tiles use signed
 * addressing (0x8800-0x97FF) so OBJ own 0x8000-0x87FF; OBJ are 8x16 pairs.
 * All VRAM traffic outside map loads goes through a small write queue
 * drained during vblank; map loads switch the LCD off (inside vblank) and
 * blast directly. OAM goes up via the classic HRAM DMA stub.
 */
#include "hal.h"

#define REG8(a) (*(volatile u8 *)(a))
#define rP1 REG8(0xFF00)
#define rDIV REG8(0xFF04)
#define rLCDC REG8(0xFF40)
#define rSTAT REG8(0xFF41)
#define rSCY REG8(0xFF42)
#define rSCX REG8(0xFF43)
#define rLY REG8(0xFF44)
#define rBGP REG8(0xFF47)
#define rOBP0 REG8(0xFF48)
#define rOBP1 REG8(0xFF49)
#define rWY REG8(0xFF4A)
#define rWX REG8(0xFF4B)
#define rDMA REG8(0xFF46)
#define rNR10 REG8(0xFF10)
#define rNR11 REG8(0xFF11)
#define rNR12 REG8(0xFF12)
#define rNR13 REG8(0xFF13)
#define rNR14 REG8(0xFF14)
#define rNR50 REG8(0xFF24)
#define rNR51 REG8(0xFF25)
#define rNR52 REG8(0xFF26)

#define MBC5_BANK (*(volatile u8 *)0x2000)

#define VRAM8(a) ((volatile u8 *)(a))
#define BG_MAP 0x9800
#define WIN_MAP 0x9C00

/* generated (gen data, bank 0). Art lives in banked blobs: latch + copy at
 * init (LCD off), so bank 0 stays code + tables only. */
extern const u8 ps_blob_bank[];
extern const u8 *const ps_blob_addr[];
extern const u8 ps_art_blob; /* blob of 2bpp art tiles (ids 1..) */
extern const u8 ps_bg_tile_count;
extern const u8 ps_font_blob; /* blob of 95 2bpp glyphs */
extern const u8 ps_obj_blob;  /* blob of OBJ tiles */
extern const u16 ps_obj_tile_bytes;

/* shadow OAM: DMA source must be 0xXX00-aligned; crt0 zeroed WRAM.
 * Linker keeps _DATA at 0xC0A0+, so 0xC000 is ours. */
#define OAM_SHADOW ((volatile u8 *)0xC000)

/* write queue: [q_head, q_n) pending. Drained strictly inside vblank —
 * the DMG drops VRAM writes outside modes 0/1, so the drain loop watches
 * STAT and stops the moment vblank ends (the tail waits a frame). */
#define QCAP 192
static u8 q_hi[QCAP], q_lo[QCAP], q_val[QCAP];
static u8 q_head, q_n;
static u8 text_rows, text_top;
static u8 scroll_x, scroll_y;
static u8 dma_stub_ready;

const u8 *hal_blob(u8 blob) {
  MBC5_BANK = ps_blob_bank[blob];
  return ps_blob_addr[blob];
}

static void qpush(u16 addr, u8 val) {
  if (q_n >= QCAP) {
    u8 i, len;
    if (q_head == 0) return; /* truly full: drop (budgets keep us below QCAP) */
    len = (u8)(q_n - q_head);
    for (i = 0; i < len; i++) {
      q_hi[i] = q_hi[i + q_head];
      q_lo[i] = q_lo[i + q_head];
      q_val[i] = q_val[i + q_head];
    }
    q_head = 0;
    q_n = len;
  }
  q_hi[q_n] = (u8)(addr >> 8);
  q_lo[q_n] = (u8)addr;
  q_val[q_n] = val;
  q_n++;
}

static void wait_vblank(void) {
  while (rLY >= 144) {}
  while (rLY < 144) {}
}

/* OAM DMA stub in HRAM (0xFF80): ldh (rDMA),a; loop 40; ret */
static void install_dma_stub(void) {
  static const u8 stub[] = { 0xe0, 0x46, 0x3e, 0x28, 0x3d, 0x20, 0xfd, 0xc9 };
  u8 i;
  for (i = 0; i < sizeof stub; i++) *(volatile u8 *)(0xFF80 + i) = stub[i];
  dma_stub_ready = 1;
}

static void oam_dma(void) {
  __asm__("ld a, #0xC0");
  __asm__("call 0xFF80");
}

/* ---- init ---------------------------------------------------------------------*/
static void upload_bg_tile(u8 id, const u8 *src) {
  /* signed addressing: ids 0..127 -> 0x9000, 128..255 -> 0x8800 */
  u16 base = id < 128 ? (u16)(0x9000 + (u16)id * 16) : (u16)(0x8800 + (u16)(id - 128) * 16);
  volatile u8 *d = VRAM8(base);
  u8 i;
  for (i = 0; i < 16; i++) d[i] = src[i];
}

void hal_init(void) {
  u16 i;
  u8 t;
  volatile u8 *d;

  wait_vblank();
  rLCDC = 0x00; /* LCD off: free VRAM access */

  /* palettes: BGP dark-descending; OBP0 same ramp, color 0 transparent */
  rBGP = 0xE4;  /* 3,2,1,0 */
  rOBP0 = 0xE4;
  rOBP1 = 0xE4;

  /* art tiles (id 1..) + blank (id 0) */
  {
    static const u8 zero[16] = { 0 };
    upload_bg_tile(0, zero);
  }
  {
    const u8 *src = hal_blob(ps_art_blob);
    for (t = 0; t < ps_bg_tile_count; t++) upload_bg_tile((u8)(t + 1), src + (u16)t * 16);
  }
  /* font at the fixed base */
  {
    const u8 *src = hal_blob(ps_font_blob);
    for (t = 0; t < FONT_GLYPHS; t++) upload_bg_tile((u8)(PS_BG_FONT_BASE + t), src + (u16)t * 16);
  }

  /* OBJ tiles at 0x8000 */
  {
    const u8 *src = hal_blob(ps_obj_blob);
    d = VRAM8(0x8000);
    for (i = 0; i < ps_obj_tile_bytes; i++) d[i] = src[i];
  }

  /* clear both maps to blank; window rows prefill with the space glyph */
  d = VRAM8(BG_MAP);
  for (i = 0; i < 32 * 32; i++) d[i] = 0;
  d = VRAM8(WIN_MAP);
  for (i = 0; i < 32 * 32; i++) d[i] = PS_BG_FONT_BASE;

  install_dma_stub();

  /* sound on, both terminals, square 1 ready */
  rNR52 = 0x80;
  rNR50 = 0x77;
  rNR51 = 0x11;

  rWX = 7;
  rWY = 144; /* window parked off-screen */
  /* LCD on: BG on, OBJ on 8x16, window on (map 0x9C00), signed BG tiles */
  rLCDC = 0x80 | 0x01 | 0x02 | 0x04 | 0x20 | 0x40;
}

/* ---- frame ---------------------------------------------------------------------*/
void hal_frame(void) {
  wait_vblank();
  /* OAM + scroll first (cheap, must not miss the frame), then drain the
   * queue for as long as vblank lasts — STAT mode 1 is the gate. */
  oam_dma();
  rSCX = scroll_x;
  rSCY = scroll_y;
  {
    u8 budget = 12;
    while (q_head < q_n && budget) {
      if ((rSTAT & 3) != 1 || rLY > 150) break; /* vblank over: next frame */
      *(volatile u8 *)(((u16)q_hi[q_head] << 8) | q_lo[q_head]) = q_val[q_head];
      q_head++;
      budget--;
    }
  }
  if (q_head == q_n) {
    q_head = 0;
    q_n = 0;
  }
}

/* ---- input ----------------------------------------------------------------------*/
u8 hal_keys(void) {
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
  /* normalize: PS mask = a,b,select,start,right,left,up,down */
  return (u8)(btn | (pad << 4));
}

/* ---- video -----------------------------------------------------------------------*/
void hal_map_draw(u8 mapBlob, u8 w, u8 h) {
  const u8 *row;
  volatile u8 *d = VRAM8(BG_MAP);
  volatile u8 *out;
  u8 x, y;

  wait_vblank();
  rLCDC &= 0x7f; /* LCD off inside vblank: safe on hardware */
  {
    const u8 *m = hal_blob(mapBlob);
    row = m + (u16)(m[8] | ((u16)m[9] << 8));
  }
  out = d;
  for (y = 0; y < 32; y++) {
    for (x = 0; x < 32; x++) {
      u8 e = 0;
      if (x < w && y < h) e = row[x];
      out[x] = e;
    }
    if (y < h) row += w;
    out += 32;
  }
  q_head = 0;
  q_n = 0; /* stale textbox writes are void after a map change */
  rLCDC |= 0x80;
}

void hal_scroll(u16 px, u16 py) {
  scroll_x = (u8)px;
  scroll_y = (u8)py;
}

void hal_obj(u8 slot, s16 px, s16 py, u8 spriteId, u8 dir, u8 frame, u8 hidden) {
  volatile u8 *o = OAM_SHADOW + (u16)slot * 8; /* 2 hw sprites = 8 bytes */
  const u8 *sp = ps_sprite_table + (u16)spriteId * SPRITE_ENTRY_SIZE;
  u16 tile_base = (u16)(sp[0] | ((u16)sp[1] << 8));
  u8 frames = sp[2];
  u8 flip = 0;
  u8 dblock = dir;
  u8 t;

  if (hidden || px <= -16 || py <= -16 || px >= 160 || py >= 144) {
    o[0] = 0;
    o[4] = 0;
    return;
  }
  if (dir == DIR_LEFT) {
    dblock = DIR_RIGHT;
    flip = 0x20;
  }
  if (frame >= frames) frame = 0;
  /* frame block = 4 tiles as [leftTop,leftBottom,rightTop,rightBottom];
   * 8x16 OBJ tile index ignores bit 0. frames is 1 or 2 — shift, don't
   * multiply (see the __muluchar note in rpg.c). */
  t = frames == 2 ? (u8)(dblock << 1) : dblock;
  t = (u8)(tile_base + ((u16)(t + frame) << 2));
  /* left column */
  o[0] = (u8)(py + 16);
  o[1] = (u8)(px + 8 + (flip ? 8 : 0));
  o[2] = t;
  o[3] = flip;
  /* right column */
  o[4] = (u8)(py + 16);
  o[5] = (u8)(px + 8 + (flip ? 0 : 8));
  o[6] = (u8)(t + 2);
  o[7] = flip;
}

/* ---- textbox ---------------------------------------------------------------------*/
void hal_text_open(u8 rows) {
  u8 x, y;
  text_rows = rows;
  text_top = 0;
  /* clear the window's used rows back to paper */
  for (y = 0; y < (u8)(rows + 2); y++) {
    for (x = 0; x < 20; x++) qpush((u16)(WIN_MAP + (u16)y * 32 + x), PS_BG_FONT_BASE);
  }
  rWY = (u8)(144 - ((u8)(rows + 2)) * 8);
}

void hal_text_close(void) {
  rWY = 144;
}

void hal_text_glyph(u8 col, u8 row, u8 glyph) {
  qpush((u16)(WIN_MAP + (u16)(row + 1) * 32 + 1 + col), (u8)(PS_BG_FONT_BASE + glyph));
}

/* ---- sfx --------------------------------------------------------------------------*/
void hal_sfx(u8 id) {
  static const u8 duty[5] = { 0x80, 0x40, 0x80, 0x80, 0xc0 };
  static const u8 hi[5] = { 0xc6, 0xc4, 0xc3, 0xc6, 0xc7 };
  if (id > 4) return;
  rNR10 = 0x00;
  rNR11 = duty[id];
  rNR12 = 0xa3;
  rNR13 = 0x00;
  rNR14 = hi[id];
}

/* ---- entry --------------------------------------------------------------------------*/
void main(void) {
  hal_init();
  rpg_boot();
  for (;;) {
    rpg_tick();
    hal_frame();
  }
}
