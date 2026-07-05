// aot/runtime/runtime.h — internal contract for the PocketJS-AOT GBA runtime.
//
// This is the shared header every runtime .c module includes. It defines the
// global game state, the ROM record structs (mirroring the PJGB binary layout
// from pjgb_gen.h), and every module's function signatures. The runtime never
// allocates during gameplay; all state lives in these globals (EWRAM/IWRAM).
//
// MEMORY MAP / VRAM PLAN (see gba.h):
//   Mode 0. BG0 = map (32x32 screen, 4bpp, charblock 0, screenblock 8).
//           BG1 = textbox/menu (charblock 0, screenblock 9, higher priority).
//   BG char data (map tiles + font glyphs) -> charblock 0 (tiles 0..511).
//   OBJ tiles (sprites) -> OBJ_VRAM, 1D mapping, 16x16 sprites (4 tiles each).
//   BG palette bank 0 = map tileset; bank 15 = textbox/font.
//   OBJ palette bank 0 = sprites.
//   v1 caps maps at 32x32 tiles so the whole map fits one screenblock.
#ifndef PJGB_RUNTIME_H
#define PJGB_RUNTIME_H
#include "gba.h"
#include "pjgb_gen.h"

// The cartridge blob, emitted by the compiler as gen_cart.c and linked in.
extern const unsigned char pjgb_cart[];

// --- ROM record structs (must match the PJGB binary layout) -----------------
typedef struct {
  char title[24];
  u8 start_map, start_dir;
  u16 start_x, start_y;
  u8 map_count, sprite_count;
  u16 flag_count, text_count, script_count;
  u16 font_base, box_tile, rsv;
} GameHeader;
_Static_assert(sizeof(GameHeader) == PJGB_GAME_HEADER_SIZE, "GameHeader size");

typedef struct {
  u16 width, height, num_actors, num_warps;
  u8 bg_palbank, on_load;
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

  u16 keys, keys_prev;
  u32 frame;
} Game;

extern Game g;

// --- cart.c -----------------------------------------------------------------
void cart_load(const void *blob);
// Returns pointer to chunk data (or 0) and writes its size.
const u8 *cart_chunk(u32 kind, u32 id, u32 *out_size);

// --- video.c ----------------------------------------------------------------
void video_init(void);      // DISPCNT, BG regs, load OBJ tiles + palettes once
void video_load_palettes(void);
void video_load_obj_tiles(void);

// --- bg.c -------------------------------------------------------------------
void bg_load_map(void);     // load current map's tiles->charblock + screenblock + BG palette
void bg_set_scroll(void);   // write BG0 HOFS/VOFS from camera

// --- obj.c ------------------------------------------------------------------
void obj_reset(void);                 // hide all sprites in shadow OAM
void obj_commit(void);                // DMA shadow OAM -> hardware OAM (at vblank)
void obj_draw_scene(void);            // place player + visible actors into shadow OAM
// low-level: set one 16x16 sprite slot (screen px). tile = OBJ tile index.
void obj_put(int slot, int sx, int sy, int tile, int palbank);

// --- input.c ----------------------------------------------------------------
void input_poll(void);
int key_held(int mask);
int key_pressed(int mask); // held this frame, not last

// --- map.c ------------------------------------------------------------------
void map_enter(int map_id, int tx, int ty, int dir); // switch map + place player
int map_solid(int tx, int ty);            // 1 if tile blocks, incl. actors + bounds
int map_actor_at(int tx, int ty);         // actor slot index at tile, or -1

// --- player.c / movement.c --------------------------------------------------
void player_update(void); // input -> grid move w/ collision, camera follow, A=interact

// --- actor.c ----------------------------------------------------------------
void actors_update(void);

// --- camera.c ---------------------------------------------------------------
void camera_follow(void); // clamp camera to player + map bounds

// --- script_vm.c ------------------------------------------------------------
void vm_start(int script_id, int actor_slot);
void vm_tick(void);       // run/resume the VM this frame (until suspended/END)
int vm_active(void);

// --- textbox.c --------------------------------------------------------------
void textbox_init(void);
void textbox_show(int text_id);
void textbox_hide(void);
int textbox_active(void);
void textbox_tick(void);  // handle A to advance; clears active when dismissed
// choice menu (rendered in the textbox area)
void choice_show(int n, const u16 *text_ids);
int choice_active(void);
void choice_tick(void);   // up/down + A; sets result and clears active when chosen
int choice_result(void);

// text bank access
const char *text_get(int text_id);

// --- flags/vars -------------------------------------------------------------
static inline int flag_get(int id) { return (g.flags[id >> 3] >> (id & 7)) & 1; }
static inline void flag_set(int id, int v) {
  if (v) g.flags[id >> 3] |= (1 << (id & 7));
  else g.flags[id >> 3] &= ~(1 << (id & 7));
}

// --- debug.c ----------------------------------------------------------------
void debug_init(void);
void debug_update(void); // mirror game state into the fixed EWRAM debug block

#endif // PJGB_RUNTIME_H
