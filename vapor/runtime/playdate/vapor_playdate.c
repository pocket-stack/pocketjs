/* Pocket Vapor native Playdate host.
 *
 * The generated app and vapor_core.c remain allocator-free. This file owns
 * only the SDK boundary: lifecycle, pushed-button sampling, framebuffer
 * commits, and machine-readable diagnostics.
 */
#include "vapor.h"

#include <stddef.h>
#include <stdint.h>

#include "framebuffer.h"
#include "pd_api.h"

#ifndef VP_BUILD_ID
#define VP_BUILD_ID "unknown"
#endif

_Static_assert(VP_GRID_W == VP_PD_GRID_W, "Playdate requires a 50-column grid");
_Static_assert(VP_GRID_H == VP_PD_GRID_H, "Playdate requires a 30-row grid");
_Static_assert(VP_GRID_H <= 32, "Playdate dirty-row mask supports at most 32 rows");

u8 vp_grid_ch[VP_GRID_H][VP_GRID_W];
u8 vp_grid_pal[VP_GRID_H][VP_GRID_W];

static PlaydateAPI *pd;
static u32 frame_no;
static u32 flush_no;
static u32 commit_no;
static u32 axis_event_no;
static float crank_sub_millidegrees;
static u8 stopped;

static u32 full_dirty_mask(void) {
  return vp_bit32[VP_GRID_H] - 1;
}

static void log_render_error(const vp_pd_render_error *error) {
  pd->system->logToConsole(
      "PVERROR stage=render code=%u x=%u y=%u ch=%u pal=%u dirty=%lx",
      (unsigned int)error->code,
      (unsigned int)error->x,
      (unsigned int)error->y,
      (unsigned int)error->ch,
      (unsigned int)error->palette,
      (unsigned long)vp_rows_dirty);
}

static int commit_rows(void) {
  vp_pd_render_result result;
  vp_pd_render_error error;
  uint8_t *frame;
  uint32_t dirty = (uint32_t)vp_rows_dirty;
  uint8_t i;

  if (!dirty) return 0;
  frame = pd->graphics->getFrame();
  if (!frame) {
    vp_tripwires |= VP_TRIP_PLATFORM_RENDER;
    stopped = 1;
    pd->system->logToConsole(
        "PVERROR stage=getFrame code=null-frame dirty=%lx",
        (unsigned long)vp_rows_dirty);
    return 0;
  }

  if (vp_pd_render_frame(
          frame,
          dirty,
          (const uint8_t *)vp_grid_ch,
          (const uint8_t *)vp_grid_pal,
          vp_font_tiles,
          vp_pal_style,
          vp_palette_count,
          &result,
          &error) != VP_PD_RENDER_OK) {
    vp_tripwires |= VP_TRIP_PLATFORM_RENDER;
    stopped = 1;
    log_render_error(&error);
    return 0;
  }

  for (i = 0; i < result.run_count; i++)
    pd->graphics->markUpdatedRows(result.runs[i].first, result.runs[i].last);
  vp_rows_dirty &= ~(u32)result.rendered_mask;
  commit_no++;
  return result.rendered_mask != 0;
}

static void dispatch_pushed(PDButtons pushed) {
  static const struct {
    PDButtons physical;
    u8 logical;
  } map[] = {
      {kButtonA, 0},
      {kButtonB, 1},
      {kButtonRight, 4},
      {kButtonLeft, 5},
      {kButtonUp, 6},
      {kButtonDown, 7},
  };
  uint8_t i;
  for (i = 0; i < sizeof(map) / sizeof(map[0]); i++)
    if (pushed & map[i].physical) app_on_button(map[i].logical);
}

static void reset_crank_input(const char *reason) {
  float discarded = pd->system->getCrankChange();
  crank_sub_millidegrees = 0.0f;
  pd->system->logToConsole(
      "PVINPUT axis=primary event=reset reason=%s discarded_mdeg=%ld",
      reason,
      (long)(discarded * 1000.0f));
}

static s32 dispatch_crank_delta(void) {
  float change = pd->system->getCrankChange();
  float accumulated_millidegrees;
  s32 delta_millidegrees;

  if (pd->system->isCrankDocked()) {
    crank_sub_millidegrees = 0.0f;
    return 0;
  }
  accumulated_millidegrees =
      crank_sub_millidegrees + (change * 1000.0f);
  delta_millidegrees = (s32)accumulated_millidegrees;
  crank_sub_millidegrees =
      accumulated_millidegrees - (float)delta_millidegrees;
  if (!delta_millidegrees) return 0;

  app_on_axis_delta(VP_RELATIVE_AXIS_PRIMARY, delta_millidegrees);
  axis_event_no++;
  pd->system->logToConsole(
      "PVINPUT axis=primary delta_mdeg=%ld raw_mdeg=%ld sub_mdeg_x1000=%ld event=%lu",
      (long)delta_millidegrees,
      (long)(change * 1000.0f),
      (long)(crank_sub_millidegrees * 1000.0f),
      (unsigned long)axis_event_no);
  return delta_millidegrees;
}

static int update(void *userdata) {
  PDButtons pushed = 0;
  int painted;
  (void)userdata;

  if (stopped) return 0;
  pd->system->getButtonState(NULL, &pushed, NULL);
  dispatch_pushed(pushed);
  dispatch_crank_delta();
  if (app_flush()) flush_no++;
  painted = commit_rows();
  frame_no++;
  if (painted) {
    pd->system->logToConsole(
        "PVFRAME frame=%lu flush=%lu commit=%lu trips=%u",
        (unsigned long)frame_no,
        (unsigned long)flush_no,
        (unsigned long)commit_no,
        (unsigned int)vp_tripwires);
  }
  return painted;
}

static void force_full_redraw(const char *reason) {
  if (stopped) return;
  vp_rows_dirty |= full_dirty_mask();
  pd->system->logToConsole("PVLIFECYCLE event=%s redraw=full", reason);
}

#ifdef _WINDLL
__declspec(dllexport)
#endif
int eventHandler(PlaydateAPI *playdate, PDSystemEvent event, uint32_t arg) {
  pd = playdate;
  if (!pd || !pd->system) return 0;

  switch (event) {
    case kEventInit:
      if (!pd->graphics || !pd->display) {
        pd->system->logToConsole("PVERROR stage=init code=missing-sdk-api");
        stopped = 1;
        return 0;
      }
      if (!pd->system->getCrankChange || !pd->system->isCrankDocked) {
        pd->system->logToConsole("PVERROR stage=init code=missing-relative-axis-api");
        stopped = 1;
        return 0;
      }
      stopped = 0;
      frame_no = 0;
      flush_no = 0;
      commit_no = 0;
      axis_event_no = 0;
      crank_sub_millidegrees = 0.0f;
      vp_tripwires = 0;
      vp_rows_dirty = 0;
      vp_row_clear(0, VP_GRID_H);
      app_init();
      app_flush();
      flush_no++;
      vp_rows_dirty |= full_dirty_mask();
      if (!commit_rows()) {
        pd->system->logToConsole("PVERROR stage=init code=first-frame");
        stopped = 1;
        return 0;
      }
      reset_crank_input("init");
      pd->display->setRefreshRate(30.0f);
      pd->system->setUpdateCallback(update, NULL);
      pd->system->logToConsole(
          "PVREADY target=playdate build=%s grid=%dx%d frame=%lu flush=%lu commit=%lu",
          VP_BUILD_ID,
          VP_GRID_W,
          VP_GRID_H,
          (unsigned long)frame_no,
          (unsigned long)flush_no,
          (unsigned long)commit_no);
      break;
    case kEventUnlock:
      reset_crank_input("unlock");
      force_full_redraw("unlock");
      break;
    case kEventResume:
      reset_crank_input("resume");
      force_full_redraw("resume");
      break;
    case kEventMirrorStarted:
      force_full_redraw("mirror-started");
      break;
    case kEventMirrorEnded:
      force_full_redraw("mirror-ended");
      break;
    case kEventLock:
      pd->system->logToConsole("PVLIFECYCLE event=lock arg=%lu", (unsigned long)arg);
      break;
    case kEventPause:
      pd->system->logToConsole("PVLIFECYCLE event=pause arg=%lu", (unsigned long)arg);
      break;
    case kEventLowPower:
      pd->system->logToConsole("PVLIFECYCLE event=low-power arg=%lu", (unsigned long)arg);
      break;
    case kEventTerminate:
      stopped = 1;
      pd->system->logToConsole("PVLIFECYCLE event=terminate arg=%lu", (unsigned long)arg);
      break;
    case kEventInitLua:
    case kEventKeyPressed:
    case kEventKeyReleased:
      pd->system->logToConsole(
          "PVLIFECYCLE event=ignored-native code=%u arg=%lu",
          (unsigned int)event,
          (unsigned long)arg);
      break;
  }
  return 0;
}
