/* aot/runtime/nes/nesrt.h — internal contract for the PocketJS-AOT NES
 * runtime (cc65, UNROM mapper 2 with 8 KB CHR-RAM).
 *
 * MEMORY / PPU PLAN:
 *   CHR-RAM PT0 ($0000): BG tiles — 0 blank, 1.. tileset, PJ_BOX_TILE, then
 *   PJ_SLOT_BASE.. dynamic glyph slots (2 tiles per halfcell).
 *   CHR-RAM PT1 ($1000): OBJ tiles (8x16 sprites; tile byte bit0 selects PT1).
 *   Nametable 0 only; NES v1 does not scroll (maps are <= 32x30).
 *   BG palette 0 = map tiles (luminance-clustered), palette 1 = textbox.
 *
 * All PPU traffic while rendering is on goes through the NMI VRAM buffer
 * (pj_vbuf); the main thread only appends. Map (re)loads flip pj_ppu_off and
 * write the PPU directly with rendering disabled.
 *
 * Banked data ($8000 window): tile gfx, glyphs, texts, per-map tiles — the
 * compiler records each symbol's bank as PJ_BANK_* in gen_data.h. Collision
 * (bit-packed), actors, warps, scripts, and all code live in the fixed bank
 * ($C000), so the VM and collision paths never switch banks. */
#ifndef PJ_NESRT_H
#define PJ_NESRT_H

#include <stdint.h>
#include "pjgb_gen.h"
#include "gen_data.h"

typedef uint8_t u8;
typedef uint16_t u16;
typedef int8_t s8;
typedef int16_t s16;

/* keys (PJ layout, matches GBA/GB runtimes) */
#define PJK_A 0x01
#define PJK_B 0x02
#define PJK_SELECT 0x04
#define PJK_START 0x08
#define PJK_RIGHT 0x10
#define PJK_LEFT 0x20
#define PJK_UP 0x40
#define PJK_DOWN 0x80

enum { VM_SUSP_NONE = 0, VM_SUSP_TEXT, VM_SUSP_CHOICE, VM_SUSP_WAIT };

typedef struct {
  u8 active;
  u8 suspend;
  const u8 *code; /* fixed-bank pointer */
  u16 ip;
  s16 stack[PJGB_VM_MAX_STACK];
  u8 sp;
  u16 wait_frames;
  s8 actor_slot;
} PjVm;

typedef struct {
  u8 map_id;
  u8 map_w, map_h;
  const u8 *map_coll; /* fixed bank, bit-packed */
  const u8 *map_tiles; /* banked (map_tiles_bank) — used by textbox restore */
  u8 map_tiles_bank;
  const PjActor *actors; /* fixed bank */
  const PjWarp *warps; /* fixed bank */
  u8 n_actors, n_warps;

  s16 px, py;
  u8 dir;
  u8 moving;
  u8 anim_frame, anim_timer;
  u8 locked;

  u8 actor_dir[BUDGET_MAX_ACTORS_PER_MAP];
  u8 actor_frame[BUDGET_MAX_ACTORS_PER_MAP];

  PjVm vm;
  s8 pending_enter;

  u8 text_active;
  u16 cur_text;
  u8 choice_active;
  u8 choice_n;
  u16 choice_ids[8];
  u8 choice_cursor;
  s8 choice_result;

  u8 flags[16];
  s16 vars[16];

  u16 slot_next;
  u16 rng;

  u8 keys, keys_prev;
  u16 frame;
} PjGame;

extern PjGame g;

/* NMI interface (crt0.s) */
extern volatile u8 pj_nmi_flag;
extern volatile u8 pj_ppu_off;
extern u8 pj_ppuctrl;
extern u8 pj_vbuf[72]; /* sized so the NMI flush + OAM DMA always fit in vblank; CJK glyphs stream one halfcell per frame */
void __fastcall__ pj_bank_switch(u8 bank);

/* nesrt.c */
void video_boot(void);
void map_enter(u8 map_id, u8 tx, u8 ty, u8 dir);
u8 map_solid(s16 tx, s16 ty);
s8 map_actor_at(s16 tx, s16 ty);
void player_update(void);
void scene_draw(void);
void input_poll(void);
u8 key_held(u8 mask);
u8 key_pressed(u8 mask);
void debug_flush(void);
void frame_sync(void); /* wait for NMI, then reset the vbuf append cursor */
/* vbuf appends (main thread only) */
u8 vbuf_room(u8 payload);
void vbuf_copy(u16 ppu_addr, const u8 *src, u8 len); /* src in RAM/fixed */
void vbuf_byte(u16 ppu_addr, u8 v);
void vbuf_fill(u16 ppu_addr, u8 v, u8 len);

/* vm.c */
void vm_start(u8 script_id, s8 actor_slot);
void vm_tick(void);
u8 vm_active(void);

/* textbox.c */
void textbox_init(void);
void textbox_show(u16 text_id);
void textbox_hide(void);
u8 textbox_active(void);
void textbox_tick(void);
void textbox_pump(void); /* appends this frame's VRAM work */
void choice_show(u8 n, const u16 *text_ids);
u8 choice_active(void);
void choice_tick(void);
s8 choice_result(void);

#define flag_get(id) ((g.flags[(id) >> 3] >> ((id) & 7)) & 1)
#define flag_set1(id) (g.flags[(id) >> 3] |= (u8)(1 << ((id) & 7)))
#define flag_set0(id) (g.flags[(id) >> 3] &= (u8) ~(1 << ((id) & 7)))

#endif
