// aot/runtime/shared/textbox.c — textbox + choice STATE only.
//
// Unlike the tile targets (which must stream glyphs into VRAM when a box
// opens), the 3DS renderer redraws the bottom screen from this state every
// frame (render.c), so showing a textbox is just bookkeeping. The tick logic
// (A to dismiss, up/down/A on choices) is line-for-line the GBA runtime's.
#include "runtime.h"

const char *text_get(int text_id) {
  const u8 *chunk = cart_chunk(CHUNK_TEXT_BANK, 0, 0);
  // u16 count, u16 rsv, u32 offsets[count] (from chunk start), then strings.
  const u32 *offs = (const u32 *)(chunk + 4);
  return (const char *)(chunk + offs[text_id]);
}

void textbox_init(void) {
  g.text_active = 0;
  g.choice_active = 0;
  g.choice_result = -1;
}

void textbox_show(int text_id) {
  g.cur_text = (u16)text_id;
  g.text_active = 1;
}

void textbox_hide(void) { g.text_active = 0; }

int textbox_active(void) { return g.text_active; }

void textbox_tick(void) {
  if (g.text_active && !g.choice_active && key_pressed(PJ_KEY_A)) textbox_hide();
}

void choice_show(int n, const u16 *text_ids) {
  g.choice_active = 1;
  g.choice_n = (u8)n;
  g.choice_cursor = 0;
  g.choice_result = -1;
  for (int i = 0; i < n && i < 8; i++) g.choice_ids[i] = text_ids[i];
}

int choice_active(void) { return g.choice_active; }

int choice_result(void) { return g.choice_result; }

void choice_tick(void) {
  if (!g.choice_active) return;
  if (key_pressed(PJ_KEY_UP) && g.choice_cursor > 0) {
    g.choice_cursor--;
  } else if (key_pressed(PJ_KEY_DOWN) && g.choice_cursor < g.choice_n - 1) {
    g.choice_cursor++;
  }
  if (key_pressed(PJ_KEY_A)) {
    g.choice_result = g.choice_cursor;
    g.choice_active = 0;
    textbox_hide();
  }
}
