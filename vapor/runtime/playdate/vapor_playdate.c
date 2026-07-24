/* vapor/runtime/playdate/vapor_playdate.c — Pocket Vapor on Playdate.
 *
 * A 50x30 logical grid maps exactly onto the 400x240 1-bit display with the
 * compiler's 8x8 font. The runtime writes Panic's 52-byte-stride framebuffer
 * directly and marks only rows changed by reactive paint effects.
 *
 * Playdate has six game buttons. D-pad and short A/B presses map directly;
 * holding A emits Pocket Start (new/save) and holding B emits Pocket Select
 * (clear/cancel). This preserves every Todo action without impossible
 * opposite-direction D-pad chords.
 */
#include "vapor.h"

#include <stddef.h>

#include "pd_api.h"

#define VP_BTN_A 0
#define VP_BTN_B 1
#define VP_BTN_SELECT 2
#define VP_BTN_START 3
#define VP_BTN_RIGHT 4
#define VP_BTN_LEFT 5
#define VP_BTN_UP 6
#define VP_BTN_DOWN 7

#define VP_LONG_PRESS_MS 500U

_Static_assert(VP_GRID_W == LCD_COLUMNS / 8, "Playdate target must use 50 columns");
_Static_assert(VP_GRID_H == LCD_ROWS / 8, "Playdate target must use 30 rows");
_Static_assert(VP_GRID_H <= 32, "dirty-row mask supports at most 32 rows");
_Static_assert(sizeof(u32) == 4, "Playdate ABI requires exact 32-bit u32");
_Static_assert(sizeof(s32) == 4, "Playdate ABI requires exact 32-bit s32");

u8 vp_grid_ch[VP_GRID_H][VP_GRID_W];
u8 vp_grid_pal[VP_GRID_H][VP_GRID_W];

static PlaydateAPI *pd;
static u8 a_down;
static u8 b_down;
static u8 a_long_sent;
static u8 b_long_sent;
static u32 a_started_at;
static u32 b_started_at;

static void dispatch(u8 button) {
  if (button < 10) app_on_button(button);
}

static void poll_buttons(void) {
  PDButtons current = 0;
  PDButtons pushed = 0;
  PDButtons released = 0;
  u32 now;

  pd->system->getButtonState(&current, &pushed, &released);
  now = (u32)pd->system->getCurrentTimeMilliseconds();

  if (pushed & kButtonUp) dispatch(VP_BTN_UP);
  if (pushed & kButtonDown) dispatch(VP_BTN_DOWN);
  if (pushed & kButtonLeft) dispatch(VP_BTN_LEFT);
  if (pushed & kButtonRight) dispatch(VP_BTN_RIGHT);

  if (pushed & kButtonA) {
    a_down = 1;
    a_long_sent = 0;
    a_started_at = now;
  }
  if (pushed & kButtonB) {
    b_down = 1;
    b_long_sent = 0;
    b_started_at = now;
  }

  if (a_down && !a_long_sent && (current & kButtonA) && (u32)(now - a_started_at) >= VP_LONG_PRESS_MS) {
    dispatch(VP_BTN_START);
    a_long_sent = 1;
  }
  if (b_down && !b_long_sent && (current & kButtonB) && (u32)(now - b_started_at) >= VP_LONG_PRESS_MS) {
    dispatch(VP_BTN_SELECT);
    b_long_sent = 1;
  }

  if ((released & kButtonA) && a_down) {
    if (!a_long_sent) {
      if ((u32)(now - a_started_at) >= VP_LONG_PRESS_MS)
        dispatch(VP_BTN_START);
      else
        dispatch(VP_BTN_A);
    }
    a_down = 0;
  }
  if ((released & kButtonB) && b_down) {
    if (!b_long_sent) {
      if ((u32)(now - b_started_at) >= VP_LONG_PRESS_MS)
        dispatch(VP_BTN_SELECT);
      else
        dispatch(VP_BTN_B);
    }
    b_down = 0;
  }
}

static int commit_rows(void) {
  u32 dirty = vp_rows_dirty;
  u8 *frame;
  u8 y;

  if (!dirty) return 0;
  frame = pd->graphics->getFrame();
  if (frame == NULL) return 0;

  for (y = 0; y < VP_GRID_H; y++) {
    u8 py;
    if (!(dirty & vp_bit32[y])) continue;
    for (py = 0; py < 8; py++) {
      u8 *row = frame + (u16)(y * 8 + py) * LCD_ROWSIZE;
      u8 x;
      for (x = 0; x < VP_GRID_W; x++) {
        u8 ch = vp_grid_ch[y][x];
        u8 style = vp_pal_style[vp_grid_pal[y][x]];
        u8 bits;
        if (ch < 0x20 || ch > 0x7e) ch = '?';
        bits = vp_font_tiles[(u16)(ch - 0x20) * 8 + py];
        /* Playdate framebuffer bit 1 is white. */
        row[x] = style ? bits : (u8)~bits;
      }
    }
    pd->graphics->markUpdatedRows((int)y * 8, (int)y * 8 + 7);
  }

  vp_rows_dirty = 0;
  return 1;
}

static void runtime_reset(void) {
  vp_tripwires = 0;
  vp_rows_dirty = 0;
  a_down = 0;
  b_down = 0;
  a_long_sent = 0;
  b_long_sent = 0;
  vp_row_clear(0, VP_GRID_H);
  app_init();
  app_flush();
  vp_rows_dirty = VP_GRID_H == 32 ? 0xffffffffUL : vp_bit32[VP_GRID_H] - 1;
  commit_rows();
}

static int update(void *userdata) {
  (void)userdata;
  poll_buttons();
  app_flush();
  return commit_rows();
}

#ifdef _WINDLL
__declspec(dllexport)
#endif
int eventHandler(PlaydateAPI *playdate, PDSystemEvent event, uint32_t arg) {
  (void)arg;
  if (event == kEventInit) {
    pd = playdate;
    pd->display->setRefreshRate(30.0f);
    pd->graphics->setBackgroundColor(kColorWhite);
    pd->graphics->clear(kColorWhite);
    runtime_reset();
    pd->system->logToConsole(
        "PVREADY target=playdate grid=%dx%d controls=short-a-b,long-a-start,long-b-select",
        VP_GRID_W,
        VP_GRID_H);
    pd->system->setUpdateCallback(update, NULL);
  }
  return 0;
}
