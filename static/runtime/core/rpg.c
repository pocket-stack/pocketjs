/* static/runtime/core/rpg.c — the portable RPG engine.
 *
 * Owns every gameplay decision: grid movement + collision, actors, talk/
 * trigger/warp dispatch, the textbox + choice state machines (typewriter,
 * FMT decimal slots), the RPG syscalls, and the debug block. The HAL only
 * moves pixels and beeps.
 *
 * Determinism: all state transitions happen here in fixed order, driven by
 * hal_keys() once per tick — the cross-target E2E suite holds every console
 * to the same trace.
 */
#include "vm.h"

#define DBGB ((volatile u8 *)PS_DEBUG_ADDR)
#define DBG8(off) (*(volatile u8 *)(PS_DEBUG_ADDR + (off)))
#define DBG16(off) (*(volatile u16 *)(PS_DEBUG_ADDR + (off)))
#define DBG32(off) (*(volatile u32 *)(PS_DEBUG_ADDR + (off)))

#define MAX_ACTORS 16

typedef struct {
  u8 x, y;   /* tile (committed at step end) */
  u16 px, py; /* pixels */
  u8 spriteId;
  u8 dir;
  u8 move;
  u8 flags;   /* ACTOR_F_* */
  u16 talk;
  u8 stepLeft; /* pixels remaining in the current step */
  u8 anim;
  u8 phase; /* wander cadence offset (slot * WANDER_PHASE, precomputed) */
  u16 lcg;
} ActorRt;
/* NOTE: 8-bit-safe arithmetic only in this file — sdcc 4.6 (SM83) miscompiles
 * some u8*u8 multiply frames (__muluchar), so anything that would lower to it
 * is written as accumulation or shifts instead. */

static ActorRt actors[MAX_ACTORS];
static u8 actor_count;

static u8 cur_map;
static u8 map_w, map_h;
static u8 mblob; /* blob index of the current map */
static u16 tiles_off, coll_off, actors_off, warps_off, trig_off;
static u8 warp_count, trig_count;
static u16 pending_enter; /* onEnter deferred while a script is running */

/* player */
static u8 ptx, pty, pdir;
static u16 ppx, ppy;
static u8 pstep, panim, plock;

/* input */
static u8 keys_now, keys_prev;
#define PRESSED(k) ((keys_now & (k)) && !(keys_prev & (k)))

/* textbox */
#define TB_NONE 0
#define TB_SAY 1
#define TB_CHOICE 2
static u8 tb_mode;
static u16 tb_text;
static u8 tb_blob;
static u16 tb_off;
static u8 tb_col, tb_row;
static u8 tb_done;
static u8 ch_n, ch_cursor, ch_drawn;
static u16 ch_texts[PS_MAX_CHOICES];
static u8 interact_slot; /* actor that started the current script, 0xFF none */

static u32 frame_no;

static const s8 DIRDX[4] = { 0, 0, -1, 1 };
static const s8 DIRDY[4] = { 1, -1, 0, 0 };

/* ---- data helpers ---------------------------------------------------------*/
static u16 rd16(const u8 *p) { return (u16)(p[0] | ((u16)p[1] << 8)); }

static void map_view_load(void) {
  const u8 *m;
  mblob = ps_map_blob[cur_map];
  m = hal_blob(mblob);
  map_w = m[0];
  map_h = m[1];
  actor_count = m[2];
  warp_count = m[3];
  trig_count = m[4];
  tiles_off = rd16(m + 8);
  coll_off = rd16(m + 10);
  actors_off = rd16(m + 12);
  warps_off = rd16(m + 14);
  trig_off = rd16(m + 16);
}

static u8 tile_solid(u8 x, u8 y) {
  const u8 *m;
  u16 i;
  if (x >= map_w || y >= map_h) return 1;
  i = (u16)y * map_w + x;
  m = hal_blob(mblob);
  return (m[coll_off + (i >> 3)] >> (i & 7)) & 1;
}

static u8 actor_at(u8 x, u8 y) {
  u8 i;
  for (i = 0; i < actor_count; i++) {
    if (actors[i].flags & ACTOR_F_HIDDEN) continue;
    if (actors[i].x == x && actors[i].y == y) return i;
  }
  return 0xff;
}

static u8 blocked(u8 x, u8 y) {
  u8 a;
  if (tile_solid(x, y)) return 1;
  a = actor_at(x, y);
  if (a != 0xff && (actors[a].flags & ACTOR_F_SOLID)) return 1;
  return 0;
}

/* ---- map load --------------------------------------------------------------*/
static void map_load(u8 map, u8 x, u8 y, u8 dir) {
  const u8 *m;
  const u8 *a;
  u8 i, phase;
  u16 lcg, enter;

  cur_map = map;
  map_view_load();
  m = hal_blob(mblob);
  enter = rd16(m + 6);

  a = m + actors_off;
  phase = 0;
  lcg = 0x1234;
  for (i = 0; i < actor_count; i++) {
    actors[i].x = a[0];
    actors[i].y = a[1];
    actors[i].px = (u16)a[0] << 3;
    actors[i].py = (u16)a[1] << 3;
    actors[i].spriteId = a[2];
    actors[i].dir = a[3];
    actors[i].move = a[4];
    actors[i].flags = a[5];
    actors[i].talk = rd16(a + 6);
    actors[i].stepLeft = 0;
    actors[i].anim = 0;
    actors[i].phase = phase;
    actors[i].lcg = lcg;
    a += ACTOR_SIZE;
    phase = (u8)(phase + WANDER_PHASE);
    lcg = (u16)(lcg + 977);
  }

  ptx = x;
  pty = y;
  pdir = dir;
  ppx = (u16)x << 3;
  ppy = (u16)y << 3;
  pstep = 0;
  interact_slot = 0xff;

  hal_map_draw(mblob, map_w, map_h);

  if (enter != SCRIPT_NONE) {
    if (vm.active) pending_enter = enter;
    else vm_start(enter);
  }
}

/* ---- textbox ---------------------------------------------------------------*/
static void text_locate(u16 id) {
  const u8 *e = ps_text_table + (u16)id * TEXT_ENTRY_SIZE;
  tb_blob = e[0];
  tb_off = rd16(e + 1);
}

static void say_open(u16 id) {
  tb_mode = TB_SAY;
  tb_text = id;
  text_locate(id);
  tb_col = 0;
  tb_row = 0;
  tb_done = 0;
  hal_text_open(PS_TEXT_LINES);
}

static void choice_open(void) {
  tb_mode = TB_CHOICE;
  tb_text = ch_texts[0];
  ch_cursor = 0;
  ch_drawn = 0;
  tb_done = 0;
  hal_text_open(ch_n);
}

static void tb_close(void) {
  tb_mode = TB_NONE;
  tb_text = TEXT_NONE;
  hal_text_close();
}

/* Render a signed decimal at the current cell; returns cells written. */
static void tb_put(u8 glyph) {
  if (tb_col < PS_TEXT_COLS) {
    hal_text_glyph(tb_col, tb_row, glyph);
    tb_col++;
  }
}

static void tb_number(s16 v) {
  u8 buf[6];
  u8 n = 0;
  u16 mag;
  if (v < 0) {
    tb_put((u8)('-' - 0x20));
    mag = (u16)(-v);
  } else {
    mag = (u16)v;
  }
  do {
    buf[n++] = (u8)(mag % 10);
    mag /= 10;
  } while (mag && n < 6);
  while (n) {
    n--;
    tb_put((u8)('0' - 0x20 + buf[n]));
  }
}

/* Advance the typewriter by one token; returns 0 when the page is done. */
static u8 tb_step(void) {
  const u8 *t = hal_blob(tb_blob);
  u8 tok = t[tb_off];
  if (tok == TOK_END) {
    tb_done = 1;
    return 0;
  }
  tb_off++;
  if (tok == TOK_NEWLINE) {
    tb_row++;
    tb_col = 0;
    return 1;
  }
  if (tok == TOK_FMT) {
    u8 var = t[tb_off];
    tb_off++;
    tb_number(vm_get_var(var));
    return 1;
  }
  tb_put((u8)(tok - TOK_ASCII_MIN));
  return 1;
}

static void say_tick(void) {
  u8 i;
  if (!tb_done) {
    for (i = 0; i < 2; i++) {
      if (!tb_step()) break;
    }
    if (PRESSED(PS_KEY_A)) {
      while (tb_step()) {}
    }
    return;
  }
  if (PRESSED(PS_KEY_A)) {
    tb_close();
    vm_resume();
    /* eat the edge: the dismissing press must not double as an interact */
    keys_prev |= PS_KEY_A;
  }
}

static void choice_row(u8 row, u16 textId, u8 selected) {
  u16 save_off;
  u8 save_blob, save_col, save_row;
  tb_col = 0;
  tb_row = row;
  tb_put(selected ? (u8)('>' - 0x20) : 0);
  tb_put(0);
  save_blob = tb_blob;
  save_off = tb_off;
  save_col = tb_col;
  save_row = tb_row;
  text_locate(textId);
  {
    const u8 *t;
    u8 tok;
    for (;;) {
      t = hal_blob(tb_blob);
      tok = t[tb_off];
      if (tok == TOK_END) break;
      tb_off++;
      if (tok == TOK_FMT) {
        u8 var = t[tb_off];
        tb_off++;
        tb_number(vm_get_var(var));
        continue;
      }
      tb_put((u8)(tok - TOK_ASCII_MIN));
    }
  }
  tb_blob = save_blob;
  tb_off = save_off;
  tb_col = save_col;
  tb_row = save_row;
}

static void choice_tick(void) {
  u8 i;
  if (!ch_drawn) {
    for (i = 0; i < ch_n; i++) choice_row(i, ch_texts[i], i == ch_cursor);
    ch_drawn = 1;
    return;
  }
  if (PRESSED(PS_KEY_UP) && ch_cursor > 0) {
    tb_col = 0;
    tb_row = ch_cursor;
    tb_put(0);
    ch_cursor--;
    tb_col = 0;
    tb_row = ch_cursor;
    tb_put((u8)('>' - 0x20));
  }
  if (PRESSED(PS_KEY_DOWN) && ch_cursor < ch_n - 1) {
    tb_col = 0;
    tb_row = ch_cursor;
    tb_put(0);
    ch_cursor++;
    tb_col = 0;
    tb_row = ch_cursor;
    tb_put((u8)('>' - 0x20));
  }
  if (PRESSED(PS_KEY_A)) {
    hal_sfx(SFX_CONFIRM);
    tb_close();
    vm_resume_value(ch_cursor);
    keys_prev |= PS_KEY_A;
  }
}

/* ---- warps / triggers -------------------------------------------------------*/
static void check_warp_trigger(void) {
  const u8 *m = hal_blob(mblob);
  const u8 *w;
  const u8 *t;
  u8 i;
  w = m + warps_off;
  for (i = 0; i < warp_count; i++, w += WARP_SIZE) {
    if (w[0] == ptx && w[1] == pty) {
      map_load(w[2], w[3], w[4], w[5]);
      return;
    }
  }
  t = m + trig_off;
  for (i = 0; i < trig_count; i++, t += TRIGGER_SIZE) {
    if (t[0] == ptx && t[1] == pty) {
      u16 script = rd16(t + 2);
      if ((t[4] & TRIGGER_F_ONCE) && vm_get_flag(t[5])) continue;
      if (t[4] & TRIGGER_F_ONCE) vm_set_flag(t[5], 1);
      if (script != SCRIPT_NONE && !vm.active) {
        interact_slot = 0xff;
        vm_start(script);
      }
      return;
    }
  }
}

/* ---- player ------------------------------------------------------------------*/
static u8 face_from_keys(void) {
  if (keys_now & PS_KEY_DOWN) return DIR_DOWN;
  if (keys_now & PS_KEY_UP) return DIR_UP;
  if (keys_now & PS_KEY_LEFT) return DIR_LEFT;
  if (keys_now & PS_KEY_RIGHT) return DIR_RIGHT;
  return 0xff;
}

static void player_tick(void) {
  u8 want;
  if (pstep) {
    ppx = (u16)(ppx + STEP_PX * DIRDX[pdir]);
    ppy = (u16)(ppy + STEP_PX * DIRDY[pdir]);
    pstep -= STEP_PX;
    if ((pstep & 3) == 0) panim ^= 1;
    if (pstep == 0) {
      ptx = (u8)(ppx >> 3);
      pty = (u8)(ppy >> 3);
      check_warp_trigger();
    }
    return;
  }
  if (plock || vm.active || tb_mode != TB_NONE) return;

  want = face_from_keys();
  if (want != 0xff) {
    u8 nx, ny;
    pdir = want;
    nx = (u8)(ptx + DIRDX[pdir]);
    ny = (u8)(pty + DIRDY[pdir]);
    if (!blocked(nx, ny)) pstep = 8;
  }

  if (PRESSED(PS_KEY_A)) {
    u8 fx = (u8)(ptx + DIRDX[pdir]);
    u8 fy = (u8)(pty + DIRDY[pdir]);
    u8 a = actor_at(fx, fy);
    if (a != 0xff && actors[a].talk != SCRIPT_NONE) {
      /* the classic: the NPC turns to face you */
      actors[a].dir = (u8)(pdir ^ 1); /* down<->up, left<->right */
      interact_slot = a;
      vm_start(actors[a].talk);
    }
  }
}

/* ---- actors --------------------------------------------------------------------*/
static void actors_tick(void) {
  u8 i;
  for (i = 0; i < actor_count; i++) {
    ActorRt *a = &actors[i];
    if (a->flags & ACTOR_F_HIDDEN) continue;
    if (a->stepLeft) {
      a->px = (u16)(a->px + STEP_PX * DIRDX[a->dir]);
      a->py = (u16)(a->py + STEP_PX * DIRDY[a->dir]);
      a->stepLeft -= STEP_PX;
      if ((a->stepLeft & 3) == 0) a->anim ^= 1;
      continue;
    }
    if (a->move != MOVE_WANDER) continue;
    if (vm.active || tb_mode != TB_NONE) continue;
    if (((u16)((u16)frame_no + a->phase) % WANDER_PERIOD) != 0) continue;
    a->lcg = (u16)(a->lcg * 25173u + 13849u);
    {
      u8 d = (u8)((a->lcg >> 8) & 3);
      u8 nx = (u8)(a->x + DIRDX[d]);
      u8 ny = (u8)(a->y + DIRDY[d]);
      a->dir = d;
      if (!blocked(nx, ny) && !(nx == ptx && ny == pty)) {
        a->x = nx;
        a->y = ny;
        a->stepLeft = 8;
      }
    }
  }
}

/* ---- camera / objects ------------------------------------------------------------*/
static u16 cam_x, cam_y;

static void camera_tick(void) {
  u16 vieww = (u16)PS_SCREEN_TILES_W << 3;
  u16 viewh = (u16)PS_SCREEN_TILES_H << 3;
  u16 mapw = (u16)map_w << 3;
  u16 maph = (u16)map_h << 3;
  s16 cx = (s16)(ppx + 4 - (s16)(vieww >> 1));
  s16 cy = (s16)(ppy + 4 - (s16)(viewh >> 1));
  if (cx < 0) cx = 0;
  if (cy < 0) cy = 0;
  if (mapw > vieww && cx > (s16)(mapw - vieww)) cx = (s16)(mapw - vieww);
  if (mapw <= vieww) cx = 0;
  if (maph > viewh && cy > (s16)(maph - viewh)) cy = (s16)(maph - viewh);
  if (maph <= viewh) cy = 0;
  cam_x = (u16)cx;
  cam_y = (u16)cy;
  hal_scroll(cam_x, cam_y);
}

static void objects_tick(void) {
  u8 i;
  hal_obj(0, (s16)(ppx - cam_x - 4), (s16)(ppy - cam_y - 8), ps_game_header[26], pdir,
          (u8)(pstep ? panim : 0), 0);
  for (i = 0; i < actor_count; i++) {
    ActorRt *a = &actors[i];
    hal_obj((u8)(i + 1), (s16)(a->px - cam_x - 4), (s16)(a->py - cam_y - 8), a->spriteId, a->dir,
            (u8)(a->stepLeft ? a->anim : 0), (u8)(a->flags & ACTOR_F_HIDDEN ? 1 : 0));
  }
}

/* ---- syscalls -----------------------------------------------------------------*/
void rpg_syscall(u8 op) {
  switch (op) {
    case OP_SAY: {
      u16 id = vm_fetch16();
      say_open(id);
      vm.waiting = WAITING_TEXT;
      break;
    }
    case OP_CHOICE: {
      u8 i;
      ch_n = vm_fetch8();
      for (i = 0; i < ch_n && i < PS_MAX_CHOICES; i++) ch_texts[i] = vm_fetch16();
      choice_open();
      vm.waiting = WAITING_CHOICE;
      break;
    }
    case OP_LOCK:
      plock = 1;
      break;
    case OP_RELEASE:
      plock = 0;
      break;
    case OP_FACE: {
      u8 slot = vm_fetch8();
      if (slot == FACE_SELF) slot = interact_slot;
      if (slot < actor_count) actors[slot].dir = (u8)(pdir ^ 1);
      break;
    }
    case OP_AVIS: {
      u8 slot = vm_fetch8();
      u8 on = vm_fetch8();
      if (slot < actor_count) {
        if (on) actors[slot].flags &= (u8)~ACTOR_F_HIDDEN;
        else actors[slot].flags |= ACTOR_F_HIDDEN;
      }
      break;
    }
    case OP_WARP: {
      u8 map = vm_fetch8();
      u8 x = vm_fetch8();
      u8 y = vm_fetch8();
      u8 dir = vm_fetch8();
      map_load(map, x, y, dir);
      break;
    }
    case OP_SFX:
      hal_sfx(vm_fetch8());
      break;
    default:
      /* unknown syscall: stop the script, keep the game alive */
      vm.active = 0;
      break;
  }
}

/* ---- debug block -----------------------------------------------------------------*/
static void debug_tick(void) {
  DBG8(DBGO_PLAYER_DIR) = pdir;
  DBG8(DBGO_CUR_MAP) = cur_map;
  DBG8(DBGO_TEXT_ACTIVE) = tb_mode != TB_NONE;
  DBG8(DBGO_SCRIPT_ACTIVE) = vm.active;
  DBG8(DBGO_CHOICE_CURSOR) = ch_cursor;
  DBG8(DBGO_WAITING) = vm.waiting;
  DBG16(DBGO_PLAYER_X) = ptx;
  DBG16(DBGO_PLAYER_Y) = pty;
  DBG16(DBGO_CUR_TEXT) = tb_mode != TB_NONE ? tb_text : TEXT_NONE;
  DBG16(DBGO_CUR_SCRIPT) = vm.active ? vm.script : SCRIPT_NONE;
  DBG32(DBGO_FRAME) = frame_no;
  DBG16(DBGO_RNG) = vm.rng;
}

/* ---- entry points -------------------------------------------------------------------*/
void rpg_boot(void) {
  u8 i;
  /* flags/vars storage is the debug block: zero it before use */
  for (i = 0; i < DEBUG_BLOCK_SIZE; i++) DBGB[i] = 0;
  DBGB[0] = DEBUG_MAGIC_0;
  DBGB[1] = DEBUG_MAGIC_1;
  DBGB[2] = DEBUG_MAGIC_2;
  DBGB[3] = DEBUG_MAGIC_3;

  vm.rng = PS_RNG_SEED;
  vm.active = 0;
  vm.waiting = WAITING_NONE;
  pending_enter = SCRIPT_NONE;
  tb_mode = TB_NONE;
  tb_text = TEXT_NONE;
  interact_slot = 0xff;
  frame_no = 0;
  plock = 0;

  map_load(ps_game_header[16], ps_game_header[17], ps_game_header[18], ps_game_header[19]);
  DBG8(DBGO_BOOTED) = 1;
}

void rpg_tick(void) {
  keys_prev = keys_now;
  keys_now = hal_keys();

  if (tb_mode == TB_SAY) say_tick();
  else if (tb_mode == TB_CHOICE) choice_tick();

  if (vm.active && vm.waiting == WAITING_FRAMES) {
    if (vm.wait_frames) vm.wait_frames--;
    if (vm.wait_frames == 0) vm_resume();
  }

  if (vm.active && vm.waiting == WAITING_NONE && tb_mode == TB_NONE) vm_run();

  if (!vm.active && pending_enter != SCRIPT_NONE) {
    u16 e = pending_enter;
    pending_enter = SCRIPT_NONE;
    vm_start(e);
    vm_run();
  }

  player_tick();
  actors_tick();
  camera_tick();
  objects_tick();

  frame_no++;
  debug_tick();
}
