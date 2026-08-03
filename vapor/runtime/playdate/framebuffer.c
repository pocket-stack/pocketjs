#include "framebuffer.h"

#include <stddef.h>
#include <string.h>

#define VP_PD_VALID_DIRTY_MASK ((UINT32_C(1) << VP_PD_GRID_H) - UINT32_C(1))

static void reset_result(vp_pd_render_result *result) {
  memset(result, 0, sizeof(*result));
}

static vp_pd_render_code fail(
    vp_pd_render_error *error,
    vp_pd_render_code code,
    uint8_t x,
    uint8_t y,
    uint8_t ch,
    uint8_t palette) {
  if (error) {
    error->code = code;
    error->x = x;
    error->y = y;
    error->ch = ch;
    error->palette = palette;
  }
  return code;
}

vp_pd_render_code vp_pd_render_frame(
    uint8_t *frame,
    uint32_t dirty,
    const uint8_t *grid_ch,
    const uint8_t *grid_pal,
    const uint8_t *font,
    const uint8_t *pal_style,
    uint8_t palette_count,
    vp_pd_render_result *result,
    vp_pd_render_error *error) {
  uint8_t x;
  uint8_t y;
  int run = -1;

  if (!result) return fail(error, VP_PD_RENDER_NULL_ARGUMENT, 0, 0, 0, 0);
  reset_result(result);
  if (error) memset(error, 0, sizeof(*error));
  if (!dirty) return VP_PD_RENDER_OK;
  if (!frame || !grid_ch || !grid_pal || !font || !pal_style)
    return fail(error, VP_PD_RENDER_NULL_ARGUMENT, 0, 0, 0, 0);
  if (dirty & ~VP_PD_VALID_DIRTY_MASK)
    return fail(error, VP_PD_RENDER_DIRTY_RANGE, 0, 0, 0, 0);
  if (!palette_count)
    return fail(error, VP_PD_RENDER_INVALID_PALETTE, 0, 0, 0, 0);

  /* Validate first. A malformed cell must never leave a half-painted frame. */
  for (y = 0; y < VP_PD_GRID_H; y++) {
    size_t row;
    if (!(dirty & (UINT32_C(1) << y))) continue;
    row = (size_t)y * VP_PD_GRID_W;
    for (x = 0; x < VP_PD_GRID_W; x++) {
      uint8_t ch = grid_ch[row + x];
      uint8_t palette = grid_pal[row + x];
      if (ch < 0x20 || ch > 0x7e)
        return fail(error, VP_PD_RENDER_INVALID_CHAR, x, y, ch, palette);
      if (palette >= palette_count)
        return fail(error, VP_PD_RENDER_INVALID_PALETTE, x, y, ch, palette);
    }
  }

  for (y = 0; y < VP_PD_GRID_H; y++) {
    size_t row;
    uint8_t glyph_y;
    if (!(dirty & (UINT32_C(1) << y))) continue;
    row = (size_t)y * VP_PD_GRID_W;
    for (glyph_y = 0; glyph_y < VP_PD_CELL_SIZE; glyph_y++) {
      uint8_t *dst =
          frame + ((size_t)y * VP_PD_CELL_SIZE + glyph_y) * VP_PD_LCD_ROWSIZE;
      for (x = 0; x < VP_PD_GRID_W; x++) {
        uint8_t ch = grid_ch[row + x];
        uint8_t glyph = font[(size_t)(ch - 0x20) * VP_PD_CELL_SIZE + glyph_y];
        uint8_t style = pal_style[grid_pal[row + x]];
        /* Font bits are ink; Playdate framebuffer bits are white. Style 0 is
         * dark-on-light (ink bits cleared to black on a set white paper),
         * style 1 is light-on-dark — matching the styles2 luminance contract
         * shared with GB/NES and the oracle preview. */
        dst[x] = style ? glyph : (uint8_t)~glyph;
      }
    }

    if (run < 0 || result->runs[run].last + 1 != y * VP_PD_CELL_SIZE) {
      run++;
      result->runs[run].first = y * VP_PD_CELL_SIZE;
    }
    result->runs[run].last = y * VP_PD_CELL_SIZE + VP_PD_CELL_SIZE - 1;
    result->rendered_mask |= UINT32_C(1) << y;
  }
  result->run_count = (uint8_t)(run + 1);
  return VP_PD_RENDER_OK;
}
