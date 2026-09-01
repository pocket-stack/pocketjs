#ifndef POCKET_VAPOR_PLAYDATE_FRAMEBUFFER_H
#define POCKET_VAPOR_PLAYDATE_FRAMEBUFFER_H

#include <stdint.h>

#define VP_PD_GRID_W 50
#define VP_PD_GRID_H 30
#define VP_PD_CELL_SIZE 8
#define VP_PD_LCD_ROWS 240
#define VP_PD_LCD_ROWSIZE 52
#define VP_PD_VISIBLE_ROW_BYTES 50
#define VP_PD_MAX_DIRTY_RUNS VP_PD_GRID_H

typedef enum {
  VP_PD_RENDER_OK = 0,
  VP_PD_RENDER_NULL_ARGUMENT = 1,
  VP_PD_RENDER_DIRTY_RANGE = 2,
  VP_PD_RENDER_INVALID_CHAR = 3,
  VP_PD_RENDER_INVALID_PALETTE = 4,
} vp_pd_render_code;

typedef struct {
  uint8_t first;
  uint8_t last;
} vp_pd_updated_rows;

typedef struct {
  uint32_t rendered_mask;
  uint8_t run_count;
  vp_pd_updated_rows runs[VP_PD_MAX_DIRTY_RUNS];
} vp_pd_render_result;

typedef struct {
  vp_pd_render_code code;
  uint8_t x;
  uint8_t y;
  uint8_t ch;
  uint8_t palette;
} vp_pd_render_error;

/*
 * Render a snapshot of logical dirty rows into Playdate's raw framebuffer.
 *
 * The function validates the complete dirty snapshot before writing a byte,
 * so callers can preserve vp_rows_dirty unchanged on any contract error.
 * On success, result->rendered_mask identifies exactly what was written and
 * result->runs contains inclusive physical-row ranges for markUpdatedRows().
 */
vp_pd_render_code vp_pd_render_frame(
    uint8_t *frame,
    uint32_t dirty,
    const uint8_t *grid_ch,
    const uint8_t *grid_pal,
    const uint8_t *font,
    const uint8_t *pal_style,
    uint8_t palette_count,
    vp_pd_render_result *result,
    vp_pd_render_error *error);

#endif
