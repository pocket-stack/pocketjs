/* aot/runtime/nes/textbox.c — nametable-overlay textbox + choice menu.
 *
 * The NES has no window layer, so the box is drawn INTO nametable 0 over the
 * map, and closing it restores the covered rows from the (banked) map tile
 * data. All writes flow through the NMI VRAM buffer; the pump appends as
 * much work per frame as the buffer allows, which yields the same typewriter
 * reveal as the Game Boy runtime.
 *
 * Layout: box occupies tile rows [box_row0 .. 29] full-width; text lines are
 * 16 px tall starting at box_row0+1, text col 1. Choice rows start at
 * box_row0+1 with the cursor in col 1 and option text from col 3. The box
 * area uses BG palette 1 (attribute quadrants), the map palette 0.
 */
#include "nesrt.h"

#define NT0 0x2000
#define ATTR0 0x23C0
#define SCREEN_ROWS 30

#define TB_TEXT_COL0 1
#define TB_CHOICE_CURSOR_COL 1
#define TB_CHOICE_TEXT_COL 3

#define MAX_JOBS 5
#define TOKBUF 160

enum {
  PH_IDLE = 0,
  PH_FILL,
  PH_ATTR_ON,
  PH_GLYPHS,
  PH_SHOWN,
  PH_RESTORE,
  PH_ATTR_OFF
};

typedef struct {
  u16 text_id;
  u8 row, col;
} TbJob;

static TbJob jobs[MAX_JOBS];
static u8 n_jobs, cur_job;
static u8 tokbuf[TOKBUF];
static u8 tok_pos, tok_loaded;
static u8 cur_row, cur_col;
static u8 box_row0;
static u8 phase;
static u8 work_row; /* fill/restore progress */
static u8 attr_i;
static u8 cursor_slot_ready;
static u8 cursor_row_prev;
/* right half of a fullwidth glyph awaiting the next frame's vbuf budget */
static u16 pend_id;
static u8 pend_row, pend_col, pend_on;

/* --- helpers ----------------------------------------------------------------- */
static u16 nt_addr(u8 row, u8 col) { return (u16)(NT0 + (u16)row * 32 + col); }

static void load_tokens(u16 text_id) {
  u16 off;
  u8 i;
  pj_bank_switch(PJ_BANK_TEXTS);
  off = pj_text_offs[text_id];
  for (i = 0; i < TOKBUF - 1; i++) {
    tokbuf[i] = pj_texts[off + i];
    if (tokbuf[i] == TOK_END) break;
  }
  tokbuf[TOKBUF - 1] = TOK_END;
  tok_pos = 0;
  tok_loaded = 1;
}

/* Upload one halfcell (2 CHR tiles) into slot and point (row,col) at it.
 * Returns 0 if the vbuf is full this frame (caller retries next frame). */
static u8 draw_halfcell(const u8 *src, u8 bank, u8 row, u8 col, u16 slot) {
  u8 tile;
  if (!vbuf_room(32 + 11)) return 0; /* CHR entry + two 1-byte NT entries */
  tile = (u8)(PJ_SLOT_BASE + slot * 2);
  pj_bank_switch(bank);
  vbuf_copy((u16)tile * 16, src, 32);
  vbuf_byte(nt_addr(row, col), tile);
  vbuf_byte(nt_addr(row + 1, col), (u8)(tile + 1));
  return 1;
}

static u16 alloc_slot(void) {
  u16 s = g.slot_next;
  if (s * 2 + 2 > (u16)PJGB_TEXT_GLYPH_SLOTS * 2) return 0;
  g.slot_next++;
  return s;
}

/* attr bytes overlapping box rows: quadrant fields set to palette 1 */
static u8 attr_rows_n;
static u8 attr_vals[16];
static u16 attr_addrs[16];

static void attr_plan(u8 on) {
  u8 ay;
  attr_rows_n = 0;
  for (ay = 0; ay < 8; ay++) {
    u8 r0 = (u8)(ay * 4); /* attr byte covers tile rows r0..r0+3 */
    u8 v = 0;
    if (!on) v = 0;
    else {
      if (r0 + 0 >= box_row0 && r0 + 0 < SCREEN_ROWS) v |= 0x05; /* top quads */
      if (r0 + 2 >= box_row0 && r0 + 2 < SCREEN_ROWS) v |= 0x50; /* bottom quads */
      if (v == 0) continue;
    }
    if (on || ((r0 + 3 >= box_row0) && (r0 < SCREEN_ROWS))) {
      u8 ax;
      for (ax = 0; ax < 8; ax++) {
        if (attr_rows_n >= 16) break;
        /* one entry per attr row is enough: 8 bytes contiguous */
        (void)ax;
      }
      attr_addrs[attr_rows_n] = (u16)(ATTR0 + (u16)ay * 8);
      attr_vals[attr_rows_n] = v;
      attr_rows_n++;
    }
  }
}

static void open_box(u8 rows_used) {
  box_row0 = (u8)(SCREEN_ROWS - rows_used);
  phase = PH_FILL;
  work_row = box_row0;
  attr_i = 0;
  cur_job = 0;
  tok_loaded = 0;
  pend_on = 0;
  g.slot_next = 0;
  cursor_slot_ready = 0;
  attr_plan(1);
}

/* --- public API ----------------------------------------------------------------- */
void textbox_init(void) {
  g.text_active = 0;
  g.choice_active = 0;
  g.choice_result = -1;
  phase = PH_IDLE;
  n_jobs = 0;
}

void textbox_show(u16 text_id) {
  g.cur_text = text_id;
  g.text_active = 1;
  g.choice_n = 0;
  n_jobs = 1;
  jobs[0].text_id = text_id;
  jobs[0].row = (u8)(SCREEN_ROWS - (PJGB_TEXT_LINES * 2 + 2) + 1);
  jobs[0].col = TB_TEXT_COL0;
  open_box((u8)(PJGB_TEXT_LINES * 2 + 2));
}

void textbox_hide(void) {
  g.text_active = 0;
  n_jobs = 0;
  phase = PH_RESTORE;
  work_row = box_row0;
  attr_i = 0;
}

u8 textbox_active(void) { return g.text_active; }

void textbox_tick(void) {
  if (g.text_active && !g.choice_active && key_pressed(PJK_A)) textbox_hide();
}

void choice_show(u8 n, const u16 *text_ids) {
  u8 i;
  g.choice_active = 1;
  g.choice_n = n;
  g.choice_cursor = 0;
  g.choice_result = -1;
  for (i = 0; i < n && i < 8; i++) g.choice_ids[i] = text_ids[i];
  g.text_active = 1;
  n_jobs = n;
  open_box((u8)(n * 2 + 2));
  for (i = 0; i < n; i++) {
    jobs[i].text_id = g.choice_ids[i];
    jobs[i].row = (u8)(box_row0 + 1 + i * 2);
    jobs[i].col = TB_CHOICE_TEXT_COL;
  }
  g.slot_next = 1; /* slot 0 = cursor glyph */
  cursor_row_prev = (u8)(box_row0 + 1);
}

u8 choice_active(void) { return g.choice_active; }
s8 choice_result(void) { return g.choice_result; }

void choice_tick(void) {
  if (!g.choice_active) return;
  if (key_pressed(PJK_UP) && g.choice_cursor > 0) g.choice_cursor--;
  else if (key_pressed(PJK_DOWN) && g.choice_cursor < g.choice_n - 1) g.choice_cursor++;
  if (key_pressed(PJK_A)) {
    g.choice_result = (s8)g.choice_cursor;
    g.choice_active = 0;
    textbox_hide();
  }
}

/* --- token streaming ---------------------------------------------------------------
 * The vbuf is deliberately small (NMI budget), so a fullwidth glyph streams
 * as two halfcells that may land on consecutive frames (pend_*). */
static u8 pump_token(void) {
  u8 tok;
  if (pend_on) {
    if (!draw_halfcell(pj_glyphs_full + (pend_id << 6) + 32, PJ_BANK_GLYPHS_FULL, pend_row, pend_col, alloc_slot()))
      return 2;
    pend_on = 0;
    return 1;
  }
  if (!tok_loaded) return 0;
  tok = tokbuf[tok_pos];
  if (tok == TOK_END) return 0;
  if (tok == TOK_NEWLINE) {
    tok_pos++;
    cur_row += 2;
    cur_col = jobs[cur_job].col;
    return 1;
  }
  if (tok & TOK_FULL_FLAG) {
    u16 id = (((u16)(tok & 0x3f)) << 8) | tokbuf[tok_pos + 1];
    if (!draw_halfcell(pj_glyphs_full + (id << 6), PJ_BANK_GLYPHS_FULL, cur_row, cur_col, alloc_slot()))
      return 2;
    pend_id = id;
    pend_row = cur_row;
    pend_col = (u8)(cur_col + 1);
    pend_on = 1;
    tok_pos += 2;
    cur_col += 2;
  } else {
    if (!draw_halfcell(pj_glyphs_half + (u16)(tok - TOK_ASCII_MIN) * 32, PJ_BANK_GLYPHS_HALF, cur_row, cur_col, alloc_slot()))
      return 2;
    tok_pos++;
    cur_col += 1;
  }
  return 1;
}

/* --- the per-frame pump --------------------------------------------------------------- */
void textbox_pump(void) {
  u8 r;
  switch (phase) {
    case PH_IDLE:
    case PH_SHOWN:
      break;

    case PH_FILL:
      while (work_row < SCREEN_ROWS && vbuf_room(32)) {
        vbuf_fill(nt_addr(work_row, 0), PJ_BOX_TILE, 32);
        work_row++;
      }
      if (work_row >= SCREEN_ROWS) phase = PH_ATTR_ON;
      break;

    case PH_ATTR_ON:
      while (attr_i < attr_rows_n && vbuf_room(8)) {
        vbuf_fill(attr_addrs[attr_i], attr_vals[attr_i], 8);
        attr_i++;
      }
      if (attr_i >= attr_rows_n) phase = PH_GLYPHS;
      break;

    case PH_GLYPHS:
      /* choice cursor first (slot 0), then option/text glyph streaming */
      if (g.choice_active && !cursor_slot_ready) {
        if (!draw_halfcell(pj_glyphs_half + (u16)('>' - TOK_ASCII_MIN) * 32, PJ_BANK_GLYPHS_HALF,
                           (u8)(box_row0 + 1 + g.choice_cursor * 2), TB_CHOICE_CURSOR_COL, 0))
          return;
        cursor_slot_ready = 1;
        cursor_row_prev = (u8)(box_row0 + 1 + g.choice_cursor * 2);
      }
      for (;;) {
        if (!tok_loaded) {
          if (cur_job >= n_jobs) {
            phase = PH_SHOWN;
            break;
          }
          load_tokens(jobs[cur_job].text_id);
          cur_row = jobs[cur_job].row;
          cur_col = jobs[cur_job].col;
        }
        r = pump_token();
        if (r == 2) break; /* vbuf full this frame */
        if (r == 0) {
          tok_loaded = 0;
          cur_job++;
        }
      }
      break;

    case PH_RESTORE:
      while (work_row < SCREEN_ROWS && vbuf_room(32)) {
        if (work_row < g.map_h) {
          pj_bank_switch(g.map_tiles_bank);
          vbuf_copy(nt_addr(work_row, 0), g.map_tiles + (u16)work_row * g.map_w, g.map_w);
          if (g.map_w < 32) vbuf_fill(nt_addr(work_row, g.map_w), 0, (u8)(32 - g.map_w));
        } else {
          vbuf_fill(nt_addr(work_row, 0), 0, 32);
        }
        work_row++;
      }
      if (work_row >= SCREEN_ROWS) {
        attr_plan(1); /* reuse addr list; values overwritten below */
        attr_i = 0;
        phase = PH_ATTR_OFF;
      }
      break;

    case PH_ATTR_OFF:
      while (attr_i < attr_rows_n && vbuf_room(8)) {
        vbuf_fill(attr_addrs[attr_i], 0, 8);
        attr_i++;
      }
      if (attr_i >= attr_rows_n) phase = PH_IDLE;
      break;
  }

  /* cursor tracking while the menu is up */
  if (g.choice_active && cursor_slot_ready) {
    u8 row = (u8)(box_row0 + 1 + g.choice_cursor * 2);
    if (row != cursor_row_prev && vbuf_room(8)) {
      vbuf_byte(nt_addr(cursor_row_prev, TB_CHOICE_CURSOR_COL), PJ_BOX_TILE);
      vbuf_byte(nt_addr(cursor_row_prev + 1, TB_CHOICE_CURSOR_COL), PJ_BOX_TILE);
      vbuf_byte(nt_addr(row, TB_CHOICE_CURSOR_COL), PJ_SLOT_BASE);
      vbuf_byte(nt_addr(row + 1, TB_CHOICE_CURSOR_COL), PJ_SLOT_BASE + 1);
      cursor_row_prev = row;
    }
  }
}
