/* static/runtime/core/hal.h — the platform seam of Pocket Static.
 *
 * Everything above this line of the runtime (vm.c, rpg.c) is PORTABLE C —
 * compiled unchanged by arm-none-eabi-gcc (GBA), sdcc (GB) and cc65 (NES).
 * Everything below it is one small HAL per console. Gameplay decisions all
 * happen in portable code, which is what makes the logical state identical
 * across targets by construction.
 *
 * Portable code rules (the intersection of three compilers):
 *   - C89 declarations (locals at block top), no VLAs, no floats.
 *   - Explicit-width typedefs below; int is 16-bit on two targets.
 *   - No pointer caching across HAL calls that may re-latch ROM banks:
 *     re-fetch hal_blob() after any call that could touch another blob.
 *   - No standard library.
 */
#ifndef PS_HAL_H
#define PS_HAL_H

#include "spec_gen.h"

typedef unsigned char u8;
typedef signed char s8;
typedef unsigned short u16;
typedef signed short s16;
typedef unsigned long u32;

/* ---- ROM data -------------------------------------------------------------
 * Blob index space is the compiler's (link.ts): scripts, texts, maps in
 * order, then target-appended art. hal_blob() returns a readable pointer,
 * latching the bank on banked targets — the pointer is valid until the next
 * hal_blob() call.
 */
const u8 *hal_blob(u8 blob);

/* Fixed-region tables (generated as native arrays by the target packagers): */
extern const u8 ps_game_header[];       /* GAME_HEADER_SIZE bytes            */
extern const u16 ps_script_table[];     /* per script: offset in SCRIPTS blob */
extern const u8 ps_text_table[];        /* per text: u8 blob, u16 offset      */
extern const u8 ps_map_blob[];          /* per map: blob index                */
extern const u8 ps_sprite_table[];      /* per sprite: SPRITE_ENTRY_SIZE      */

/* ---- frame / input --------------------------------------------------------*/
void hal_init(void);
/* Wait for vblank, commit queued video work + OAM, then return. */
void hal_frame(void);
/* Held keys as the normalized PS_KEY_* mask. */
u8 hal_keys(void);

/* ---- video ---------------------------------------------------------------*/
/* Redraw the whole BG from the current map blob (rendering may be blanked). */
void hal_map_draw(u8 mapBlob, u8 w, u8 h);
/* Camera top-left in pixels (ignored on non-scrolling targets). */
void hal_scroll(u16 px, u16 py);
/* Position one 16x16 actor object. slot 0 = player. hidden -> off-screen. */
void hal_obj(u8 slot, s16 px, s16 py, u8 spriteId, u8 dir, u8 frame, u8 hidden);

/* Textbox (fixed PS_TEXT_COLS-wide region, `rows` text lines tall).
 * open MUST present a clean box (all cells cleared to the box fill);
 * close restores the map view. Both may be gradual on queued targets. */
void hal_text_open(u8 rows);
void hal_text_close(void);
/* Write one glyph cell (glyph 0..FONT_GLYPHS-1) at textbox col/row. */
void hal_text_glyph(u8 col, u8 row, u8 glyph);

/* ---- audio ----------------------------------------------------------------*/
void hal_sfx(u8 id);

/* ---- engine entry points (portable side, called by each main.c) ----------*/
void rpg_boot(void);
void rpg_tick(void);

#endif /* PS_HAL_H */
