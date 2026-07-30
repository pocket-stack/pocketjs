#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "framebuffer.h"
#include "pd_api.h"
#include "vapor.h"

extern u8 vp_grid_ch[VP_GRID_H][VP_GRID_W];
extern u8 vp_grid_pal[VP_GRID_H][VP_GRID_W];
int eventHandler(PlaydateAPI *playdate, PDSystemEvent event, uint32_t arg);

const u8 vp_font_tiles[95 * 8] = {0};
const u8 vp_palette_count = 2;
const u8 vp_pal_style[2] = {0, 1};
const char vp_app_title[] = "TEST";

static int app_init_calls;
static int app_flush_calls;
static int buttons[16];
static int button_count;
static int axes[16];
static int axis_deltas[16];
static int axis_count;

void app_init(void) {
  app_init_calls++;
  vp_ln_reset();
  vp_ln_str("BOOT");
  vp_ln_commit(0, 0, 0, VP_ALIGN_LEFT);
}

void app_on_button(u8 button) {
  buttons[button_count++] = button;
  vp_ln_reset();
  vp_ln_str("BUTTON ");
  vp_ln_int(button);
  vp_ln_commit(1, 0, 0, VP_ALIGN_LEFT);
}

void app_on_axis_delta(u8 axis, s32 delta) {
  axes[axis_count] = axis;
  axis_deltas[axis_count] = (int)delta;
  axis_count++;
  vp_ln_reset();
  vp_ln_str("AXIS ");
  vp_ln_int(axis);
  vp_ln_ch(' ');
  vp_ln_int(delta);
  vp_ln_commit(2, 0, 0, VP_ALIGN_LEFT);
}

u8 app_flush(void) {
  app_flush_calls++;
  return 1;
}

u16 app_debug_state(volatile u8 *out) {
  out[0] = (u8)button_count;
  return 1;
}

static uint8_t framebuffer[VP_PD_LCD_ROWS * VP_PD_LCD_ROWSIZE];
static PDButtons next_pushed;
static float next_crank_change;
static int crank_docked;
static PDCallbackFunction *installed_update;
static void *installed_userdata;
static float refresh_rate;
static int marked_first[64];
static int marked_last[64];
static int mark_count;
static char logs[8192];
static size_t logs_len;

static void fake_log(const char *fmt, ...) {
  va_list args;
  int written;
  va_start(args, fmt);
  written = vsnprintf(logs + logs_len, sizeof(logs) - logs_len, fmt, args);
  va_end(args);
  if (written > 0) {
    logs_len += (size_t)written;
    if (logs_len + 1 < sizeof(logs)) logs[logs_len++] = '\n';
  }
}

static void fake_set_update(PDCallbackFunction *update, void *userdata) {
  installed_update = update;
  installed_userdata = userdata;
}

static void fake_buttons(PDButtons *current, PDButtons *pushed, PDButtons *released) {
  if (current) *current = next_pushed;
  if (pushed) *pushed = next_pushed;
  if (released) *released = 0;
  next_pushed = 0;
}

static float fake_crank_change(void) {
  float change = next_crank_change;
  next_crank_change = 0.0f;
  return change;
}

static int fake_crank_docked(void) {
  return crank_docked;
}

static uint8_t *fake_get_frame(void) {
  return framebuffer;
}

static void fake_mark_rows(int first, int last) {
  marked_first[mark_count] = first;
  marked_last[mark_count] = last;
  mark_count++;
}

static void fake_refresh(float rate) {
  refresh_rate = rate;
}

static int check(int condition, const char *message) {
  if (condition) return 1;
  fprintf(stderr, "playdate runtime test failed: %s\nlogs:\n%s", message, logs);
  return 0;
}

int main(void) {
  const struct playdate_sys system = {
      .logToConsole = fake_log,
      .setUpdateCallback = fake_set_update,
      .getButtonState = fake_buttons,
      .getCrankChange = fake_crank_change,
      .isCrankDocked = fake_crank_docked,
  };
  const struct playdate_graphics graphics = {
      fake_get_frame,
      fake_mark_rows,
  };
  const struct playdate_display display = {
      fake_refresh,
  };
  PlaydateAPI api = {
      &system,
      NULL,
      &graphics,
      NULL,
      &display,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
  };
  int before;

  memset(framebuffer, 0xa5, sizeof(framebuffer));
  if (!check(eventHandler(&api, kEventInit, 0) == 0, "init handler failed")) return 1;
  if (!check(app_init_calls == 1 && app_flush_calls == 1, "boot app sequence is wrong"))
    return 1;
  if (!check(refresh_rate == 30.0f && installed_update, "30 Hz update callback was not installed"))
    return 1;
  if (!check(mark_count == 1 && marked_first[0] == 0 && marked_last[0] == 239, "first frame is not full"))
    return 1;
  if (!check(strstr(logs, "PVREADY target=playdate") != NULL, "PVREADY receipt missing"))
    return 1;
  if (!check(framebuffer[50] == 0xa5 && framebuffer[51] == 0xa5, "first-frame padding changed"))
    return 1;

  before = app_flush_calls;
  next_pushed = (PDButtons)(kButtonA | kButtonLeft | kButtonDown);
  if (!check(installed_update(installed_userdata) == 1, "button update did not paint")) return 1;
  if (!check(app_flush_calls == before + 1, "button batch flushed more than once")) return 1;
  if (!check(
          button_count == 3 && buttons[0] == 0 && buttons[1] == 5 && buttons[2] == 7,
          "physical buttons were not normalized in deterministic order"))
    return 1;

  before = app_flush_calls;
  next_crank_change = 7.25f;
  if (!check(installed_update(installed_userdata) == 1, "raw crank movement did not paint"))
    return 1;
  if (!check(
          axis_count == 1 && axes[0] == 0 && axis_deltas[0] == 7250,
          "positive crank millidegrees were not preserved"))
    return 1;
  next_crank_change = 8.0f;
  if (!check(installed_update(installed_userdata) == 1, "second raw crank movement did not paint"))
    return 1;
  if (!check(axis_count == 2 && axis_deltas[1] == 8000, "second crank delta was quantized"))
    return 1;
  if (!check(app_flush_calls == before + 2, "each crank frame did not get exactly one flush"))
    return 1;

  next_crank_change = -31.5f;
  if (!check(installed_update(installed_userdata) == 1, "reverse crank movement did not paint"))
    return 1;
  if (!check(axis_count == 3 && axis_deltas[2] == -31500, "reverse crank delta was quantized"))
    return 1;

  next_crank_change = 0.0004f;
  if (!check(installed_update(installed_userdata) == 0, "sub-millidegree crank movement painted"))
    return 1;
  if (!check(axis_count == 3, "sub-millidegree crank movement dispatched too early"))
    return 1;
  next_crank_change = 0.0007f;
  if (!check(installed_update(installed_userdata) == 1, "fractional millidegrees were lost"))
    return 1;
  if (!check(axis_count == 4 && axis_deltas[3] == 1, "fractional millidegrees did not accumulate"))
    return 1;

  crank_docked = 1;
  next_crank_change = 45.0f;
  if (!check(installed_update(installed_userdata) == 0, "docked crank dispatched movement"))
    return 1;
  crank_docked = 0;
  next_crank_change = 15.0f;
  if (!check(installed_update(installed_userdata) == 1, "undocked crank did not restart cleanly"))
    return 1;
  if (!check(
          axis_count == 5 && axis_deltas[4] == 15000,
          "docked crank movement leaked into the next event"))
    return 1;
  if (!check(
          strstr(logs, "PVINPUT axis=primary delta_mdeg=") != NULL,
          "crank input receipt missing"))
    return 1;

  before = mark_count;
  next_crank_change = 10.0f;
  eventHandler(&api, kEventResume, 0);
  if (!check(installed_update(installed_userdata) == 1, "resume did not force a repaint"))
    return 1;
  if (!check(
          mark_count == before + 1 && marked_first[before] == 0 && marked_last[before] == 239,
          "resume repaint was not full-screen"))
    return 1;
  next_crank_change = 5.0f;
  if (!check(installed_update(installed_userdata) == 1, "new post-resume movement was lost"))
    return 1;
  if (!check(
          axis_count == 6 && axis_deltas[5] == 5000,
          "resume leaked stale movement or suppressed new movement"))
    return 1;

  vp_grid_ch[0][0] = 0;
  vp_rows_dirty |= 1;
  if (!check(installed_update(installed_userdata) == 0, "invalid cell reported a painted frame"))
    return 1;
  if (!check((vp_tripwires & VP_TRIP_PLATFORM_RENDER) != 0, "render tripwire was not set"))
    return 1;
  if (!check((vp_rows_dirty & 1) != 0, "failed render cleared dirty state")) return 1;
  if (!check(strstr(logs, "PVERROR stage=render") != NULL, "render error receipt missing"))
    return 1;

  puts("playdate runtime: ok");
  return 0;
}
