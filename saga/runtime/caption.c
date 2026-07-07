/* saga/runtime/caption.c — typewriter captions, dialog and choice UI on BG0.
 *
 * Text tokens (compiler-paginated, <=2 lines x 26 cells):
 *   0x00 end · 0x0a newline · 0x20..0x7e ASCII halfcell · 0x80|hi,lo fullwidth
 * Glyphs are 8x16 halfcells: two stacked 4bpp tiles (64 bytes) DMA'd into a
 * ring of C_GLYPH_SLOTS slots inside shared charblock 2, one halfcell per
 * frame (typewriter) or synchronously (choice menus, speaker chips).
 * Halfcells are baked ink-on-box-color, so text always sits on the navy bar. */
#include "saga.h"

#define UI_MAP ((u16 *)SCREENBLOCK(C_SBB_UI))

/* per-style geometry */
typedef struct {
  u8 box_r0, box_rows; /* cleared/boxed region */
  u8 text_r0;          /* first text row (lines at +0 and +2) */
  u8 margin;           /* left col for text (0xff = center per line) */
  u8 boxed;            /* draw T_BOX under the region */
} CapGeo;

static const CapGeo GEO[4] = {
    /* CHIP  */ {1, 2, 1, 1, 1},
    /* SUB   */ {14, 6, 15, 2, 1},
    /* CARD  */ {8, 4, 8, 0xff, 0},
    /* DIALOG*/ {12, 8, 15, 2, 1},
};

typedef struct {
  const u8 *tok;
  u8 style;
  u8 line; /* 0/1 */
  u8 col;
  u8 pending; /* second halfcell of a fullwidth glyph (hc+1), 0 = none */
  u8 starts[C_CAP_LINES];
  u8 emitted;
} Typing;

static Typing ty;
static u8 choice_active_n;
static u8 choice_r0;

static const u8 *text_tokens(u16 id) {
  return film.text_blob + film.text_offs[id];
}

/* measure token stream: cell widths per line */
static u8 measure(const u8 *t, u8 *w0, u8 *w1) {
  u8 w[C_CAP_LINES] = {0, 0};
  u8 line = 0;
  for (;;) {
    u8 c = *t++;
    if (c == C_TOK_END) break;
    if (c == C_TOK_NL) {
      if (++line >= C_CAP_LINES) break;
      continue;
    }
    if (c & 0x80) {
      t++; /* low byte */
      w[line] = (u8)(w[line] + 2);
    } else {
      w[line]++;
    }
  }
  *w0 = w[0];
  *w1 = w[1];
  return (u8)(line + 1);
}

static void wipe_rows(u8 r0, u8 rows) {
  int r, c;
  for (r = r0; r < r0 + rows; r++)
    for (c = 0; c < 32; c++) UI_MAP[r * 32 + c] = 0;
}

static void box_rows(u8 r0, u8 rows) {
  int r, c;
  for (r = r0; r < r0 + rows; r++)
    for (c = 0; c < 30; c++) UI_MAP[r * 32 + c] = SE(C_T_BOX, C_PALBANK_UI);
}

static void accent_row(u8 r, u8 c0, u8 c1) {
  int c;
  for (c = c0; c < c1; c++) UI_MAP[r * 32 + c] = SE(C_T_BOX_ACCENT, C_PALBANK_UI);
}

/* Slot plan: the chip caption (place/date) persists across a whole scene while
 * subs/dialogs churn, so it gets a private slot range; everything else shares
 * a ring above it. */
#define CHIP_SLOTS 24
static u16 chip_next;

static u8 cur_region; /* 0 = general ring, 1 = chip range */

static void emit_halfcell(u16 hc, u8 col, u8 row) {
  u16 slot;
  u16 tile;
  if (cur_region) {
    slot = chip_next;
    chip_next = (u16)((slot + 1) % CHIP_SLOTS);
  } else {
    slot = g.slot_next;
    g.slot_next = (u16)(slot + 1);
    if (g.slot_next >= C_GLYPH_SLOTS) g.slot_next = CHIP_SLOTS;
  }
  tile = (u16)(C_GLYPH_SLOT_BASE + slot * 2);
  dma3_copy32(CHARBLOCK(C_CBB_SHARED) + tile * 16, film.glyphs + (u32)hc * 64, 64 / 4);
  UI_MAP[row * 32 + col] = SE(tile, C_PALBANK_UI);
  UI_MAP[(row + 1) * 32 + col] = (u16)SE(tile + 1, C_PALBANK_UI);
}

/* fullwidth halfcell ids exceed a u8; the pending right half lives in a u16 */
static u16 ty_pend16;

static void type_start(u8 style, u16 text_id) {
  const CapGeo *ge = &GEO[style];
  const u8 *t = text_tokens(text_id);
  u8 w0, w1;
  measure(t, &w0, &w1);
  ty.tok = t;
  ty.style = style;
  ty.line = 0;
  ty.emitted = 0;
  ty_pend16 = 0;
  ty.pending = 0;
  if (ge->margin == 0xff) {
    ty.starts[0] = (u8)((30 - w0) / 2);
    ty.starts[1] = (u8)((30 - (w1 ? w1 : w0)) / 2);
  } else {
    ty.starts[0] = ge->margin;
    ty.starts[1] = ge->margin;
  }
  ty.col = ty.starts[0];
  g.caption_busy = 1;
}

/* one halfcell per frame, honoring a pending fullwidth right half */
void caption_update(void) {
  const CapGeo *ge;
  u8 row;
  if (!g.caption_busy) return;
  cur_region = (ty.style == C_CAP_CHIP);
  ge = &GEO[ty.style];
  row = (u8)(ge->text_r0 + ty.line * 2);
  if (ty_pend16) {
    emit_halfcell(ty_pend16, ty.col++, row);
    ty_pend16 = 0;
    return;
  }
  for (;;) {
    u8 c;
    if (!ty.tok) {
      g.caption_busy = 0;
      return;
    }
    c = *ty.tok++;
    if (c == C_TOK_END) {
      ty.tok = 0;
      g.caption_busy = 0;
      return;
    }
    if (c == C_TOK_NL) {
      ty.line++;
      if (ty.line >= C_CAP_LINES) {
        ty.tok = 0;
        g.caption_busy = 0;
        return;
      }
      ty.col = ty.starts[ty.line];
      row = (u8)(ge->text_r0 + ty.line * 2);
      continue;
    }
    if (c & 0x80) {
      u16 gid = (u16)(((c & 0x7f) << 8) | *ty.tok++);
      u16 hc = (u16)(C_ASCII_HALF + gid * 2);
      emit_halfcell(hc, ty.col++, row);
      ty_pend16 = (u16)(hc + 1);
    } else {
      emit_halfcell((u16)(c - 0x20), ty.col++, row);
    }
    if ((++ty.emitted & 3) == 1) sfx_play(C_SFX_BLIP);
    return;
  }
}

u8 caption_typing(void) {
  return g.caption_busy;
}

/* draw a whole token stream synchronously at (col0, row) */
static void render_now(const u8 *t, u8 col0, u8 row) {
  u8 col = col0;
  cur_region = 0;
  for (;;) {
    u8 c = *t++;
    if (c == C_TOK_END) break;
    if (c == C_TOK_NL) {
      row += 2;
      col = col0;
      continue;
    }
    if (c & 0x80) {
      u16 gid = (u16)(((c & 0x7f) << 8) | *t++);
      u16 hc = (u16)(C_ASCII_HALF + gid * 2);
      emit_halfcell(hc, col++, row);
      emit_halfcell((u16)(hc + 1), col++, row);
    } else {
      emit_halfcell((u16)(c - 0x20), col++, row);
    }
  }
}

void caption_show(u8 style, u16 text_id) {
  const CapGeo *ge = &GEO[style];
  /* finish any in-flight typing instantly */
  while (g.caption_busy) caption_update();
  wipe_rows(ge->box_r0, ge->box_rows);
  if (ge->boxed) {
    if (style == C_CAP_CHIP) {
      u8 w0, w1;
      measure(text_tokens(text_id), &w0, &w1);
      {
        int r, c;
        for (r = ge->box_r0; r < ge->box_r0 + 2; r++)
          for (c = 0; c < 2 + w0; c++) UI_MAP[r * 32 + c] = SE(C_T_BOX, C_PALBANK_UI);
        accent_row((u8)(ge->box_r0 + 2), 0, (u8)(2 + w0));
      }
    } else {
      box_rows(ge->box_r0, ge->box_rows);
    }
  }
  type_start(style, text_id);
  g.cur_text = (u16)(text_id + 1);
}

void caption_clear(u8 style) {
  if (style == 0xff) {
    wipe_rows(0, 20);
  } else {
    const CapGeo *ge = &GEO[style];
    wipe_rows(ge->box_r0, ge->box_rows);
    if (style == C_CAP_CHIP) wipe_rows((u8)(ge->box_r0 + 2), 1);
  }
  if (g.caption_busy && (style == 0xff || style == ty.style)) {
    ty.tok = 0;
    ty_pend16 = 0;
    g.caption_busy = 0;
  }
}

void caption_dialog(u16 speaker, u16 body) {
  const CapGeo *ge = &GEO[C_CAP_DIALOG];
  while (g.caption_busy) caption_update();
  wipe_rows(ge->box_r0, ge->box_rows);
  box_rows(ge->box_r0, ge->box_rows);
  render_now(text_tokens(speaker), 2, (u8)(ge->box_r0 + 0)); /* rows 12-13 */
  accent_row((u8)(ge->box_r0 + 2), 1, 29);                   /* row 14 */
  type_start(C_CAP_DIALOG, body);                            /* rows 15.. */
  g.cur_text = (u16)(body + 1);
}

/* --- choice menu --------------------------------------------------------------- */
static void choice_cursor_draw(u8 on) {
  u8 r = (u8)(choice_r0 + g.choice_cursor * 2);
  UI_MAP[r * 32 + 2] = on ? SE(C_T_CURSOR, C_PALBANK_UI) : SE(C_T_BOX, C_PALBANK_UI);
}

void choice_show(u8 n, const u16 *ids) {
  int i;
  while (g.caption_busy) caption_update();
  g.choice_n = n;
  g.choice_cursor = 0;
  choice_r0 = (u8)(18 - 2 * n);
  choice_active_n = n;
  wipe_rows((u8)(choice_r0 - 1), (u8)(2 * n + 3));
  box_rows((u8)(choice_r0 - 1), (u8)(2 * n + 3));
  for (i = 0; i < n; i++) render_now(text_tokens(ids[i]), 4, (u8)(choice_r0 + i * 2));
  choice_cursor_draw(1);
}

void choice_update(void) {
  if (!choice_active_n) return;
  if (key_pressed(KEY_UP) && g.choice_cursor > 0) {
    choice_cursor_draw(0);
    g.choice_cursor--;
    choice_cursor_draw(1);
    sfx_play(C_SFX_BLIP);
  }
  if (key_pressed(KEY_DOWN) && g.choice_cursor + 1 < g.choice_n) {
    choice_cursor_draw(0);
    g.choice_cursor++;
    choice_cursor_draw(1);
    sfx_play(C_SFX_BLIP);
  }
}

u8 choice_done(s8 *out) {
  if (!choice_active_n) return 0;
  if (key_pressed(KEY_A)) {
    *out = (s8)g.choice_cursor;
    wipe_rows((u8)(choice_r0 - 1), (u8)(2 * choice_active_n + 3));
    choice_active_n = 0;
    sfx_play(C_SFX_CONFIRM);
    return 1;
  }
  return 0;
}

void caption_boot(void) {
  wipe_rows(0, 20);
  ty.tok = 0;
  ty_pend16 = 0;
  g.caption_busy = 0;
  g.slot_next = CHIP_SLOTS;
  chip_next = 0;
  cur_region = 0;
  choice_active_n = 0;
}
