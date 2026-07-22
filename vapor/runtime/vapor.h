/* vapor/runtime/vapor.h — the Pocket Vapor runtime contract, all targets.
 *
 * Two parties compile against this header: the fixed per-console runtime
 * (gba/vapor_gba.c, gb/vapor_gb.c, nes/vapor_nes.c) and the compiler-
 * generated application (gen_app.c). The runtime owns the cell grid, video
 * commit, input edges, the frame loop and the debug block; the generated
 * app owns all reactive state, computeds, paint effects and button
 * handlers. No allocator exists anywhere — every byte is planned at
 * compile time.
 *
 * Portability: this compiles under arm-none-eabi-gcc (ARM7TDMI),
 * sdcc (SM83) and cc65 (6502). `int` is 16-bit on the 8-bit consoles, so
 * the 32-bit types are `long`; cc65 is C89, so `inline` vanishes there.
 */
#ifndef POCKET_VAPOR_H
#define POCKET_VAPOR_H

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned long u32;
typedef signed char s8;
typedef signed short s16;
typedef signed long s32;

#if defined(__CC65__)
#define inline
#endif

/* Geometry + budgets: per-target, injected by the compiler as #defines in
 * gen_app.c before this header; the defaults are the GBA profile. */
#ifndef VP_GRID_W
#define VP_GRID_W 30
#endif
#ifndef VP_GRID_H
#define VP_GRID_H 20
#endif
#ifndef VP_STR_CAP
#define VP_STR_CAP 24 /* max chars in a pooled/scratch string */
#endif
#ifndef VP_VIEW_CAP
#define VP_VIEW_CAP 32 /* max elements a list view can hold */
#endif

/* A bounded string: len + bytes, no heap, no NUL required. */
typedef struct {
  u8 len;
  char b[VP_STR_CAP];
} vp_sb;

/* A list view: indices into an app pool, produced by filter/slice chains. */
typedef struct {
  u8 len;
  u8 idx[VP_VIEW_CAP];
} vp_view;

/* ---- grid (runtime-owned) -------------------------------------------------- */
void vp_row_clear(u8 y0, u8 y1); /* rows [y0, y1): space, palette 0 */
void vp_put_str(u8 y, u8 *col, u8 pal, const char *s);
void vp_put_sb(u8 y, u8 *col, u8 pal, const vp_sb *s);
void vp_put_ch(u8 y, u8 *col, u8 pal, char c);
void vp_put_int(u8 y, u8 *col, u8 pal, s32 v);
void vp_pad(u8 y, u8 col, u8 pal); /* fill [col, W) with spaces in pal */

/* ---- strings ---------------------------------------------------------------- */
void vp_sb_reset(vp_sb *s);
void vp_sb_str(vp_sb *s, const char *lit);
void vp_sb_sb(vp_sb *s, const vp_sb *src);
void vp_sb_ch(vp_sb *s, char c);
/* JS String.prototype.slice(start, end) with clamping, ASCII only. */
void vp_sb_slice(vp_sb *dst, const vp_sb *src, s32 start, s32 end);
/* Assign tmp into dst; returns 1 if the value changed (Vue set semantics). */
u8 vp_sb_assign(vp_sb *dst, const vp_sb *tmp);
u8 vp_sb_eq(const vp_sb *a, const vp_sb *b);

/* ---- tripwires -------------------------------------------------------------- */
#define VP_TRIP_POOL_FULL 1
#define VP_TRIP_STR_TRUNC 2
#define VP_TRIP_VIEW_FULL 4
extern u8 vp_tripwires;

/* core state shared with the per-target runtime */
extern u32 vp_rows_dirty;
extern const u32 vp_bit32[32]; /* vp_bit32[n] == 1UL << n */

/* ---- generated app hooks ----------------------------------------------------- */
void app_init(void);      /* seed state + first paint (all effects) */
void app_on_button(u8 b); /* one press edge, GBA key bit index */
u8 app_flush(void);       /* computeds + dirty effects; 1 if painted */
u16 app_debug_state(volatile u8 *out); /* mirror reactive state; returns bytes */

/* generated data the runtime uploads at boot (per-target encodings):
 *   GBA: vp_font_tiles 95x32B 4bpp, vp_palettes/vp_palette_count/vp_backdrop
 *   GB:  vp_font_tiles (2 styles x 95) x 16B 2bpp interleaved
 *   NES: vp_font_tiles (2 styles x 95) x 16B 2bpp planar
 *   GB/NES: vp_pal_style[8] maps logical palette -> glyph style (0/1) */
extern const u8 vp_font_tiles[];
extern const u16 vp_palettes[];
extern const u8 vp_palette_count;
extern const u16 vp_backdrop;
extern const u8 vp_pal_style[];
extern const char vp_app_title[]; /* cartridge title, <= 12 chars */

#endif
