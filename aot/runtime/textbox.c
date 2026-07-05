// aot/runtime/textbox.c — BG1 textbox + choice menu (screenblock PJ_TEXT_SBB).
#include "runtime.h"

#define BOX_ROW0 12
#define BOX_ROW1 19
#define TEXT_COL0 1
#define TEXT_ROW0 13
#define TEXT_COLMAX 28

const char *text_get(int text_id) {
  const u8 *chunk = cart_chunk(CHUNK_TEXT_BANK, 0, 0);
  // u16 count, u16 rsv, u32 offsets[count] (from chunk start), then strings.
  const u32 *offs = (const u32 *)(chunk + 4);
  return (const char *)(chunk + offs[text_id]);
}

static void box_fill(void) {
  u16 *sb = SCREENBLOCK(PJ_TEXT_SBB);
  for (int row = BOX_ROW0; row <= BOX_ROW1; row++)
    for (int col = 0; col < 30; col++)
      sb[row * 32 + col] = SE(g.game->box_tile, 15);
}

static void put_char(u16 *sb, int row, int col, unsigned char c) {
  if (c >= 0x20) sb[row * 32 + col] = SE(g.game->font_base + (c - 0x20), 15);
}

void textbox_init(void) {
  g.text_active = 0;
  g.choice_active = 0;
  g.choice_result = -1;
}

void textbox_show(int text_id) {
  g.cur_text = (u16)text_id;
  g.text_active = 1;

  u16 *sb = SCREENBLOCK(PJ_TEXT_SBB);
  box_fill();

  const char *t = text_get(text_id);
  int col = TEXT_COL0, row = TEXT_ROW0;
  for (const char *c = t; *c; c++) {
    if (*c == '\n') {
      row++;
      col = TEXT_COL0;
      if (row > BOX_ROW1) break;
      continue;
    }
    if (col > TEXT_COLMAX) {
      row++;
      col = TEXT_COL0;
    }
    if (row > BOX_ROW1) break;
    put_char(sb, row, col, (unsigned char)*c);
    col++;
  }

  REG_DISPCNT |= DCNT_BG1;
}

void textbox_hide(void) {
  g.text_active = 0;
  REG_DISPCNT &= ~DCNT_BG1;
}

int textbox_active(void) { return g.text_active; }

void textbox_tick(void) {
  if (g.text_active && !g.choice_active && key_pressed(KEY_A)) textbox_hide();
}

// --- choice menu -----------------------------------------------------------
static void choice_render(void) {
  u16 *sb = SCREENBLOCK(PJ_TEXT_SBB);
  box_fill();
  for (int i = 0; i < g.choice_n; i++) {
    int row = TEXT_ROW0 + i;
    if (row > BOX_ROW1) break;
    if (i == g.choice_cursor) put_char(sb, row, TEXT_COL0, '>');
    const char *t = text_get(g.choice_ids[i]);
    int col = TEXT_COL0 + 2;
    for (const char *c = t; *c && col <= TEXT_COLMAX; c++, col++)
      put_char(sb, row, col, (unsigned char)*c);
  }
}

void choice_show(int n, const u16 *text_ids) {
  g.choice_active = 1;
  g.choice_n = (u8)n;
  g.choice_cursor = 0;
  g.choice_result = -1;
  for (int i = 0; i < n && i < 8; i++) g.choice_ids[i] = text_ids[i];
  choice_render();
  REG_DISPCNT |= DCNT_BG1;
}

int choice_active(void) { return g.choice_active; }

int choice_result(void) { return g.choice_result; }

void choice_tick(void) {
  if (!g.choice_active) return;
  if (key_pressed(KEY_UP) && g.choice_cursor > 0) {
    g.choice_cursor--;
    choice_render();
  } else if (key_pressed(KEY_DOWN) && g.choice_cursor < g.choice_n - 1) {
    g.choice_cursor++;
    choice_render();
  }
  if (key_pressed(KEY_A)) {
    g.choice_result = g.choice_cursor;
    g.choice_active = 0;
    textbox_hide();
  }
}
