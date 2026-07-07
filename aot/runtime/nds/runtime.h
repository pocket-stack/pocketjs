// aot/runtime/nds/runtime.h — internal contract for the PocketJS-AOT DS runtime.
//
// The DS target reuses the GBA-format PJGB blob verbatim (4bpp tiles, BGR555
// palettes) — the DS 2D hardware is essentially "GBA x2", so the same assets
// drive it directly. The runtime is split like the 3DS one:
//
//   core (this header + every .c except render_ds.c / nds_main.c) —
//     platform-free game logic. Input arrives via pj_frame(keys); the debug
//     block is exported through pj_debug_block(). No libnds here.
//
//   render, two interchangeable backends behind one interface (render_frame +
//     pj_top_fb/pj_bottom_fb):
//       render_ds.c   — DEVICE: libnds HARDWARE tiles. MAIN engine = top
//                       screen = world (BG tilemap + OBJ sprites); SUB engine
//                       = bottom screen = textbox/choices. Real 2D hardware.
//       render_soft.c — HOST: the same software renderer the 3DS core uses,
//                       so the E2E harness drives identical logic and can
//                       screenshot both screens over Bun FFI.
//
//   shell (nds_main.c, device build only) — libnds main loop: keysHeld()
//     -> pj_frame, present both engines.
//
// Dual-screen plan: the world always owns the top screen; dialogue/choices own
// the bottom screen, so text never covers the map.
#ifndef PJGB_RUNTIME_NDS_H
#define PJGB_RUNTIME_NDS_H
#include <stdint.h>
#include "pjgb_gen.h"

typedef uint8_t u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef int8_t s8;
typedef int16_t s16;
typedef int32_t s32;

// Key bits: the GBA/DS KEYINPUT layout (libnds KEY_* low bits match:
// A,B,SELECT,START,RIGHT,LEFT,UP,DOWN). nds_main.c folds these from keysHeld().
#define PJ_KEY_A 0x0001
#define PJ_KEY_B 0x0002
#define PJ_KEY_SELECT 0x0004
#define PJ_KEY_START 0x0008
#define PJ_KEY_RIGHT 0x0010
#define PJ_KEY_LEFT 0x0020
#define PJ_KEY_UP 0x0040
#define PJ_KEY_DOWN 0x0080

// Top: a PJGB_SCREEN_W/H (128x96) world viewport, hardware-scaled 2x to fill
// the 256x192 panel. Bottom: 1:1 text at full panel resolution.
#define PJ_TOP_W PJGB_SCREEN_W
#define PJ_TOP_H PJGB_SCREEN_H
#define PJ_BOTTOM_W 256
#define PJ_BOTTOM_H 192

// Bottom-screen text layout (px). Single source of truth for BOTH renderers:
// render_ds.c stamps tiles at these anchors (all multiples of 8) and the
// shared software renderer draws pixels at the same ones, so host harness
// screenshots match real hardware.
#define PJ_TX_Y0 24         // first dialogue line (tile row 3)
#define PJ_TX_CHOICE_Y0 16  // first choice row (tile row 2)
#define PJ_TX_LINE_PITCH 24 // 16px glyphs on a 3-tile-row rhythm
#define PJ_TX_CHOICE_DX 16  // cursor halfcell + one cell gap

// The cartridge blob, emitted by the compiler as gen_cart.c and linked in.
extern const unsigned char pjgb_cart[];

// --- ROM record structs (must match the PJGB binary layout) -----------------
typedef struct {
  char title[24];
  u8 start_map, start_dir;
  u16 start_x, start_y;
  u8 map_count, sprite_count;
  u16 flag_count, text_count, script_count;
  u16 font_base, box_tile;
  u8 text_mode, rsv;
  u16 glyph_slot_base, glyph_slot_count;
} GameHeader;
_Static_assert(sizeof(GameHeader) == PJGB_GAME_HEADER_SIZE, "GameHeader size");

typedef struct {
  u16 width, height, num_actors, num_warps;
  u8 bg_palbank, on_enter;
  u16 rsv;
  u32 tiles_off, collision_off, actors_off, warps_off;
} MapHeader;
_Static_assert(sizeof(MapHeader) == PJGB_MAP_HEADER_SIZE, "MapHeader size");

typedef struct {
  u16 x, y;
  u8 sprite, facing, move, flags;
  u16 on_talk, rsv;
} ActorRec;
_Static_assert(sizeof(ActorRec) == PJGB_ACTOR_INSTANCE_SIZE, "ActorRec size");

typedef struct {
  u16 x, y;
  u8 dest_map, dest_dir;
  u16 dest_x, dest_y, rsv;
} WarpRec;
_Static_assert(sizeof(WarpRec) == PJGB_WARP_SIZE, "WarpRec size");

typedef struct {
  u16 tile_base;
  u8 w, h, palbank, frames;
  u16 rsv;
} SpriteRec;
_Static_assert(sizeof(SpriteRec) == PJGB_SPRITE_PROTO_SIZE, "SpriteRec size");

// --- Runtime state ----------------------------------------------------------
typedef struct {
  u8 active;
  u8 suspend;
  const u8 *code;
  u32 ip;
  s16 stack[PJGB_VM_MAX_STACK];
  u8 sp;
  u16 wait_frames;
  s16 actor_slot;
} VM;

enum { VM_SUSP_NONE = 0, VM_SUSP_TEXT, VM_SUSP_CHOICE, VM_SUSP_WAIT };

typedef struct {
  s32 px, py;
  u8 dir;
  u8 moving;
  u8 anim_frame;
  u8 anim_timer;
  u8 locked;
  u8 sprite_id;
} Player;

typedef struct {
  const GameHeader *game;
  u8 map_id;
  u16 map_w, map_h;
  const u16 *map_tiles;
  const u8 *map_collision;
  const ActorRec *actors;
  u16 n_actors;
  const WarpRec *warps;
  u16 n_warps;
  u8 bg_palbank;
  u8 actor_dir[BUDGET_MAX_ACTORS_PER_MAP];
  u8 actor_frame[BUDGET_MAX_ACTORS_PER_MAP];

  Player player;
  s32 cam_x, cam_y;

  VM vm;

  u8 text_active;
  u16 cur_text;
  u8 choice_active;
  u8 choice_n;
  u16 choice_ids[8];
  u8 choice_cursor;
  s16 choice_result;

  u8 flags[16];
  s16 vars[16];

  s16 pending_enter;
  u16 rng;

  u16 keys, keys_prev;
  u32 frame;
} Game;

extern Game g;

// --- core.c -----------------------------------------------------------------
void pj_init(void);
void pj_frame(u32 keys);
const u16 *pj_top_fb(void);
const u16 *pj_bottom_fb(void);
const u8 *pj_debug_block(void);

int key_held(int mask);
int key_pressed(int mask);

// --- cart.c -----------------------------------------------------------------
void cart_load(const void *blob);
const u8 *cart_chunk(u32 kind, u32 id, u32 *out_size);

// --- render (render_ds.c device / shared render_soft.c host) ----------------
void render_init(void); // one-time VRAM/engine setup (device); no-op on host
void render_frame(void);
void bg_load_map(void);
void bg_set_scroll(void);

// --- map.c ------------------------------------------------------------------
void map_enter(int map_id, int tx, int ty, int dir);
int map_solid(int tx, int ty);
int map_actor_at(int tx, int ty);

// --- player.c / actor.c / camera.c ------------------------------------------
void player_update(void);
void actors_update(void);
void camera_follow(void);

// --- script_vm.c ------------------------------------------------------------
void vm_start(int script_id, int actor_slot);
void vm_tick(void);
int vm_active(void);

// --- textbox.c (state only; render draws it) --------------------------------
void textbox_init(void);
void textbox_show(int text_id);
void textbox_hide(void);
int textbox_active(void);
void textbox_tick(void);
void choice_show(int n, const u16 *text_ids);
int choice_active(void);
void choice_tick(void);
int choice_result(void);
const char *text_get(int text_id);

// --- flags/vars -------------------------------------------------------------
static inline int flag_get(int id) { return (g.flags[id >> 3] >> (id & 7)) & 1; }
static inline void flag_set(int id, int v) {
  if (v) g.flags[id >> 3] |= (1 << (id & 7));
  else g.flags[id >> 3] &= ~(1 << (id & 7));
}

// --- debug.c ----------------------------------------------------------------
void debug_init(void);
void debug_update(void);

#endif // PJGB_RUNTIME_NDS_H
