// aot/runtime/3ds/runtime.h — internal contract for the PocketJS-AOT 3DS
// runtime.
//
// The 3DS target reuses the GBA-format PJGB blob verbatim (4bpp tiles,
// BGR555 palettes) and renders it IN SOFTWARE. The runtime is split in two:
//
//   core (runtime/shared/*.c compiled against this header) — platform-free
//     game logic + the shared software renderer. No libctru, no hardware
//     registers. Input comes in through pj_frame(keys); video goes out
//     through two BGR555 buffers:
//       top    200x120  world view (the ctru shell upscales 2x -> 400x240)
//       bottom 320x240  textbox / choice UI (1:1)
//     The same core compiles as a host dylib for the E2E harness
//     (test/harness/host_runner.ts), so every scenario assertion runs
//     against the exact code that ships on the console.
//
//   shell (ctru_main.c, device build only) — libctru main loop: hidKeysHeld
//     -> pj_frame, core buffers -> rotated 3DS framebuffers. It talks to the
//     core only through the pj_* surface (libctru owns the KEY_* names,
//     hence the core's PJ_KEY_* prefix).
//
// Dual-screen plan: the world always owns the whole top screen; dialogue and
// choices own the bottom screen, so text never covers the map.
#ifndef PJGB_RUNTIME_3DS_H
#define PJGB_RUNTIME_3DS_H
#include <stdint.h>
#include "pjgb_gen.h"

typedef uint8_t u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef int8_t s8;
typedef int16_t s16;
typedef int32_t s32;

// Key bits: same layout as the GBA KEYINPUT (and libctru's hidKeysHeld low
// byte, which matches bit-for-bit: A,B,SELECT,START,RIGHT,LEFT,UP,DOWN).
#define PJ_KEY_A 0x0001
#define PJ_KEY_B 0x0002
#define PJ_KEY_SELECT 0x0004
#define PJ_KEY_START 0x0008
#define PJ_KEY_RIGHT 0x0010
#define PJ_KEY_LEFT 0x0020
#define PJ_KEY_UP 0x0040
#define PJ_KEY_DOWN 0x0080

// Screen geometry (world view is PJGB_SCREEN_W/H from pjgb_gen.h = 200x120).
#define PJ_TOP_W PJGB_SCREEN_W
#define PJ_TOP_H PJGB_SCREEN_H
#define PJ_BOTTOM_W 320
#define PJ_BOTTOM_H 240

// Bottom-screen text layout (px) for the shared software renderer.
#define PJ_TX_Y0 32
#define PJ_TX_CHOICE_Y0 32
#define PJ_TX_LINE_PITCH 24 // 16px glyphs on a 24px rhythm
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
  u8 active;    // a script is running (incl. suspended)
  u8 suspend;   // VM_SUSP_*
  const u8 *code;
  u32 ip;
  s16 stack[PJGB_VM_MAX_STACK];
  u8 sp;
  u16 wait_frames;
  s16 actor_slot; // actor that started the script (for FACE_PLAYER), or -1
} VM;

enum { VM_SUSP_NONE = 0, VM_SUSP_TEXT, VM_SUSP_CHOICE, VM_SUSP_WAIT };

typedef struct {
  // player, in tile coords + sub-tile pixel progress for smooth walking
  s32 px; // pixel position (world) x = tile*8 + progress
  s32 py;
  u8 dir;
  u8 moving;    // 1 while sliding between tiles
  u8 anim_frame;
  u8 anim_timer;
  u8 locked;    // LOCK_PLAYER
  u8 sprite_id; // player sprite
} Player;

typedef struct {
  const GameHeader *game;
  // current map
  u8 map_id;
  u16 map_w, map_h;
  const u16 *map_tiles;    // u16[w*h]
  const u8 *map_collision; // u8[w*h]
  const ActorRec *actors;
  u16 n_actors;
  const WarpRec *warps;
  u16 n_warps;
  u8 bg_palbank;
  u8 actor_dir[BUDGET_MAX_ACTORS_PER_MAP];   // runtime facing override (FACE_PLAYER)
  u8 actor_frame[BUDGET_MAX_ACTORS_PER_MAP]; // runtime anim frame

  Player player;
  s32 cam_x, cam_y; // pixel scroll (top-left of view in world px)

  VM vm;

  // textbox
  u8 text_active;
  u16 cur_text;
  // choice menu
  u8 choice_active;
  u8 choice_n;
  u16 choice_ids[8];
  u8 choice_cursor;
  s16 choice_result; // -1 until chosen

  // persistent state
  u8 flags[16]; // 128 bits
  s16 vars[16];

  // deferred map on-enter script (set by map_enter, started by the main loop)
  s16 pending_enter; // script id or -1

  // OP_RND state
  u16 rng;

  u16 keys, keys_prev;
  u32 frame;
} Game;

extern Game g;

// --- core.c — the embeddable frame interface --------------------------------
void pj_init(void);
void pj_frame(u32 keys); // one logic+render tick
const u16 *pj_top_fb(void);    // BGR555, PJ_TOP_W x PJ_TOP_H
const u16 *pj_bottom_fb(void); // BGR555, PJ_BOTTOM_W x PJ_BOTTOM_H
const u8 *pj_debug_block(void); // PJGB_DEBUG_BLOCK_SIZE bytes

int key_held(int mask);
int key_pressed(int mask); // held this frame, not last

// --- cart.c -----------------------------------------------------------------
void cart_load(const void *blob);
const u8 *cart_chunk(u32 kind, u32 id, u32 *out_size);

// --- shared/render_soft.c ----------------------------------------------------
void render_init(void);   // no-op in the software backend
void render_frame(void);  // world -> top buffer, textbox/choice -> bottom
void bg_load_map(void);   // no-op (render reads the map each frame); kept so
void bg_set_scroll(void); // map.c stays line-identical with the GBA runtime

// --- map.c ------------------------------------------------------------------
void map_enter(int map_id, int tx, int ty, int dir);
int map_solid(int tx, int ty);
int map_actor_at(int tx, int ty);

// --- player.c ----------------------------------------------------------------
void player_update(void);

// --- actor.c ----------------------------------------------------------------
void actors_update(void);

// --- camera.c ---------------------------------------------------------------
void camera_follow(void);

// --- script_vm.c ------------------------------------------------------------
void vm_start(int script_id, int actor_slot);
void vm_tick(void);
int vm_active(void);

// --- textbox.c — pure state machine; the renderer draws it ------------------
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
void debug_update(void); // mirror game state into the debug block buffer

#endif // PJGB_RUNTIME_3DS_H
