/* saga/runtime/breakout.c — the playable Breakout set piece (Atari, 1976).
 * Bricks/ball/paddle are OBJs from the built-in UI sheet over whatever BG the
 * scene shows. Deterministic (no rng): launch angle fixed, physics integer.
 * OP_BREAKOUT blocks in WAITING_MINIGAME and pushes the number of bricks
 * cleared; the game ends on full clear, on running out of lives, or on the
 * frame budget expiring — history only needs the night to pass. */
#include "saga.h"

#define COURT_X0 24
#define COURT_X1 216 /* 12 bricks x 16px */
#define COURT_Y0 16
#define COURT_Y1 156
#define BRICK_Y0 32
#define PADDLE_Y 144
#define PADDLE_W 32

static struct {
  u8 active, lives, rows, launched;
  u8 left, cleared;
  u16 timer, budget;
  s16 px;                     /* paddle left */
  s16 bx_q4, by_q4, dx_q4, dy_q4; /* ball top-left, 12.4 fixed */
  u8 brick[C_BRICK_ROWS_MAX * C_BRICK_COLS];
} bk;

u8 breakout_left(void) {
  return bk.active ? bk.left : 0;
}

static void ball_reset(void) {
  bk.launched = 0;
  bk.bx_q4 = (s16)((bk.px + PADDLE_W / 2 - 4) << 4);
  bk.by_q4 = (s16)((PADDLE_Y - 8) << 4);
  bk.dx_q4 = 24; /* 1.5 px/frame */
  bk.dy_q4 = -32; /* 2 px/frame up */
}

void breakout_start(u8 rows, u8 lives, u16 budget) {
  int i;
  if (rows > C_BRICK_ROWS_MAX) rows = C_BRICK_ROWS_MAX;
  bk.active = 1;
  bk.rows = rows;
  bk.lives = lives;
  bk.cleared = 0;
  bk.left = (u8)(rows * C_BRICK_COLS);
  bk.timer = 0;
  bk.budget = budget ? budget : 3600;
  bk.px = 120 - PADDLE_W / 2;
  for (i = 0; i < rows * C_BRICK_COLS; i++) bk.brick[i] = 1;
  ball_reset();
  g.waiting = WAITING_MINIGAME;
}

static void finish(void) {
  int i;
  bk.active = 0;
  for (i = 0; i < C_BRICK_ROWS_MAX * C_BRICK_COLS; i++)
    oam_shadow[C_OAM_BRICK + i].attr0 = ATTR0_HIDE;
  oam_shadow[C_OAM_BALL].attr0 = ATTR0_HIDE;
  oam_shadow[C_OAM_PADDLE].attr0 = ATTR0_HIDE;
  vm_push((s16)bk.cleared);
  g.waiting = WAITING_RUN;
}

/* returns 1 if a brick at ball point (px coords) was hit */
static u8 hit_brick(s16 x, s16 y) {
  s16 c, r;
  if (y < BRICK_Y0 || y >= BRICK_Y0 + bk.rows * 8) return 0;
  if (x < COURT_X0 || x >= COURT_X1) return 0;
  c = (s16)((x - COURT_X0) >> 4);
  r = (s16)((y - BRICK_Y0) >> 3);
  if (r < 0 || r >= bk.rows || c < 0 || c >= C_BRICK_COLS) return 0;
  if (!bk.brick[r * C_BRICK_COLS + c]) return 0;
  bk.brick[r * C_BRICK_COLS + c] = 0;
  bk.left--;
  bk.cleared++;
  sfx_play(C_SFX_BLIP);
  return 1;
}

u8 breakout_service(void) {
  s16 bx, by;
  if (!bk.active) return 0;
  bk.timer++;

  /* paddle */
  if (key_held(KEY_LEFT)) bk.px -= 3;
  if (key_held(KEY_RIGHT)) bk.px += 3;
  if (bk.px < COURT_X0) bk.px = COURT_X0;
  if (bk.px > COURT_X1 - PADDLE_W) bk.px = (s16)(COURT_X1 - PADDLE_W);

  if (!bk.launched) {
    bk.bx_q4 = (s16)((bk.px + PADDLE_W / 2 - 4) << 4);
    if (key_pressed(KEY_A)) {
      bk.launched = 1;
      sfx_play(C_SFX_CONFIRM);
    }
  } else {
    bk.bx_q4 += bk.dx_q4;
    bk.by_q4 += bk.dy_q4;
    bx = (s16)(bk.bx_q4 >> 4);
    by = (s16)(bk.by_q4 >> 4);

    if (bx <= COURT_X0) {
      bk.bx_q4 = COURT_X0 << 4;
      bk.dx_q4 = (s16)-bk.dx_q4;
    } else if (bx >= COURT_X1 - 8) {
      bk.bx_q4 = (s16)((COURT_X1 - 8) << 4);
      bk.dx_q4 = (s16)-bk.dx_q4;
    }
    if (by <= COURT_Y0) {
      bk.by_q4 = COURT_Y0 << 4;
      bk.dy_q4 = (s16)-bk.dy_q4;
    }

    bx = (s16)(bk.bx_q4 >> 4);
    by = (s16)(bk.by_q4 >> 4);

    /* bricks: test ball center against the grid, flip vertical on hit */
    if (hit_brick((s16)(bx + 4), (s16)(bk.dy_q4 < 0 ? by : by + 8))) {
      bk.dy_q4 = (s16)-bk.dy_q4;
      g.fx[TW_SHAKE] = 1;
    }

    /* paddle catch */
    if (bk.dy_q4 > 0 && by + 8 >= PADDLE_Y && by + 8 < PADDLE_Y + 6 && bx + 8 > bk.px &&
        bx < bk.px + PADDLE_W) {
      s16 off = (s16)((bx + 4) - (bk.px + PADDLE_W / 2)); /* -16..16 */
      bk.dy_q4 = (s16)-bk.dy_q4;
      bk.dx_q4 = (s16)(off * 2);
      if (bk.dx_q4 > 40) bk.dx_q4 = 40;
      if (bk.dx_q4 < -40) bk.dx_q4 = -40;
      if (bk.dx_q4 > -8 && bk.dx_q4 < 8) bk.dx_q4 = bk.dx_q4 < 0 ? -8 : 8;
      sfx_play(C_SFX_BLIP);
    }

    /* lost ball */
    if (by > COURT_Y1) {
      if (--bk.lives == 0) {
        finish();
        return 0;
      }
      ball_reset();
    }
  }

  if (bk.left == 0 || bk.timer >= bk.budget) {
    finish();
    return 0;
  }
  return 1;
}

void breakout_draw(void) {
  int r, c;
  if (!bk.active) return;
  for (r = 0; r < bk.rows; r++) {
    for (c = 0; c < C_BRICK_COLS; c++) {
      ObjAttr *o = &oam_shadow[C_OAM_BRICK + r * C_BRICK_COLS + c];
      if (!bk.brick[r * C_BRICK_COLS + c]) {
        o->attr0 = ATTR0_HIDE;
        continue;
      }
      o->attr0 = (u16)(ATTR0_Y(BRICK_Y0 + r * 8) | ATTR0_WIDE);
      o->attr1 = (u16)(ATTR1_X(COURT_X0 + c * 16) | (0 << 14)); /* 16x8 */
      o->attr2 = (u16)(ATTR2_TILE(C_OBJ_UI_BASE + 26) | ATTR2_PRIO(1) | ATTR2_PALBANK(C_PALBANK_OBJ_UI));
    }
  }
  {
    ObjAttr *o = &oam_shadow[C_OAM_BALL];
    o->attr0 = (u16)(ATTR0_Y(bk.by_q4 >> 4) | ATTR0_SQUARE);
    o->attr1 = (u16)(ATTR1_X(bk.bx_q4 >> 4) | (0 << 14)); /* 8x8 */
    o->attr2 = (u16)(ATTR2_TILE(C_OBJ_UI_BASE + 28) | ATTR2_PRIO(1) | ATTR2_PALBANK(C_PALBANK_OBJ_UI));
  }
  {
    ObjAttr *o = &oam_shadow[C_OAM_PADDLE];
    o->attr0 = (u16)(ATTR0_Y(PADDLE_Y) | ATTR0_WIDE);
    o->attr1 = (u16)(ATTR1_X(bk.px) | (1 << 14)); /* 32x8 */
    o->attr2 = (u16)(ATTR2_TILE(C_OBJ_UI_BASE + 29) | ATTR2_PRIO(1) | ATTR2_PALBANK(C_PALBANK_OBJ_UI));
  }
}
