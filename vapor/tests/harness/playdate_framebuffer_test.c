#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "framebuffer.h"

static uint8_t frame[VP_PD_LCD_ROWS * VP_PD_LCD_ROWSIZE];
static uint8_t chars[VP_PD_GRID_W * VP_PD_GRID_H];
static uint8_t palettes[VP_PD_GRID_W * VP_PD_GRID_H];
static uint8_t font[95 * VP_PD_CELL_SIZE];
static const uint8_t styles[2] = {0, 1};

static int check(int condition, const char *message) {
  if (condition) return 1;
  fprintf(stderr, "playdate framebuffer test failed: %s\n", message);
  return 0;
}

static int visible_and_padding(void) {
  vp_pd_render_result result;
  vp_pd_render_error error;
  uint32_t dirty = UINT32_C(1) | (UINT32_C(1) << 29);
  int y;

  memset(frame, 0xa5, sizeof(frame));
  memset(chars, ' ', sizeof(chars));
  memset(palettes, 0, sizeof(palettes));
  memset(font, 0, sizeof(font));
  font[('A' - 0x20) * 8 + 0] = 0x81;
  font[('A' - 0x20) * 8 + 7] = 0x42;
  chars[0] = 'A';
  chars[VP_PD_GRID_W * VP_PD_GRID_H - 1] = 'A';
  palettes[VP_PD_GRID_W * VP_PD_GRID_H - 1] = 1;

  if (!check(
          vp_pd_render_frame(
              frame,
              dirty,
              chars,
              palettes,
              font,
              styles,
              2,
              &result,
              &error) == VP_PD_RENDER_OK,
          "valid render returned an error"))
    return 0;
  if (!check(result.rendered_mask == dirty, "rendered mask differs from dirty snapshot"))
    return 0;
  if (!check(result.run_count == 2, "disjoint logical rows did not produce two runs"))
    return 0;
  if (!check(
          result.runs[0].first == 0 && result.runs[0].last == 7 &&
              result.runs[1].first == 232 && result.runs[1].last == 239,
          "physical updated-row ranges are wrong"))
    return 0;
  /* Playdate framebuffer bits are white; font bits are ink. Style 0 must
   * paint dark ink on light paper (ink bits cleared), style 1 the inverse. */
  if (!check(
          frame[0] == (uint8_t)~0x81,
          "dark-on-light glyph byte or MSB order is wrong"))
    return 0;
  if (!check(
          frame[(size_t)232 * VP_PD_LCD_ROWSIZE + 49] == 0x81,
          "light-on-dark boundary glyph byte is wrong"))
    return 0;
  if (!check(
          frame[(size_t)239 * VP_PD_LCD_ROWSIZE + 49] == 0x42,
          "last scanline boundary write is wrong"))
    return 0;

  for (y = 0; y < VP_PD_LCD_ROWS; y++) {
    if (!check(
            frame[(size_t)y * VP_PD_LCD_ROWSIZE + 50] == 0xa5 &&
                frame[(size_t)y * VP_PD_LCD_ROWSIZE + 51] == 0xa5,
            "row padding was modified"))
      return 0;
  }
  return 1;
}

static int contiguous_runs(void) {
  vp_pd_render_result result;
  vp_pd_render_error error;
  memset(frame, 0, sizeof(frame));
  memset(chars, ' ', sizeof(chars));
  memset(palettes, 0, sizeof(palettes));
  if (!check(
          vp_pd_render_frame(
              frame,
              UINT32_C(3),
              chars,
              palettes,
              font,
              styles,
              2,
              &result,
              &error) == VP_PD_RENDER_OK,
          "adjacent render returned an error"))
    return 0;
  return check(
      result.run_count == 1 && result.runs[0].first == 0 && result.runs[0].last == 15,
      "adjacent logical rows did not merge into one physical run");
}

static int failures_are_transactional(void) {
  vp_pd_render_result result;
  vp_pd_render_error error;
  size_t i;

  memset(frame, 0x5a, sizeof(frame));
  memset(chars, ' ', sizeof(chars));
  memset(palettes, 0, sizeof(palettes));
  chars[17] = 0x1f;
  if (!check(
          vp_pd_render_frame(
              frame,
              UINT32_C(1),
              chars,
              palettes,
              font,
              styles,
              2,
              &result,
              &error) == VP_PD_RENDER_INVALID_CHAR,
          "invalid character was accepted"))
    return 0;
  if (!check(error.x == 17 && error.y == 0 && error.ch == 0x1f, "invalid character receipt is wrong"))
    return 0;
  for (i = 0; i < sizeof(frame); i++)
    if (!check(frame[i] == 0x5a, "failed render changed framebuffer bytes")) return 0;

  chars[17] = ' ';
  palettes[23] = 2;
  if (!check(
          vp_pd_render_frame(
              frame,
              UINT32_C(1),
              chars,
              palettes,
              font,
              styles,
              2,
              &result,
              &error) == VP_PD_RENDER_INVALID_PALETTE,
          "invalid palette was accepted"))
    return 0;
  if (!check(error.x == 23 && error.palette == 2, "invalid palette receipt is wrong"))
    return 0;

  palettes[23] = 0;
  return check(
      vp_pd_render_frame(
          frame,
          UINT32_C(1) << 31,
          chars,
          palettes,
          font,
          styles,
          2,
          &result,
          &error) == VP_PD_RENDER_DIRTY_RANGE,
      "dirty bit above the logical grid was accepted");
}

int main(void) {
  if (!visible_and_padding()) return 1;
  if (!contiguous_runs()) return 1;
  if (!failures_are_transactional()) return 1;
  puts("playdate framebuffer: ok");
  return 0;
}
