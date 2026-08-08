/*
 * 3DS keys and circle pad onto the frame contract's two arguments.
 *
 * The button bitmask is the PSP's (contracts/spec/spec.ts BTN) on every host,
 * so the mapping here is positional: A/B/X/Y sit where CIRCLE/CROSS/TRIANGLE/
 * SQUARE sit, which keeps CIRCLE as confirm exactly as the PSP host and the
 * launcher expect.
 *
 * The touchscreen is deliberately not read. It is the BOTTOM screen (320x240)
 * while the UI renders on the top (400x240), so reporting its contacts as
 * logical coordinates in the top screen's space would be a lie; the 3DS
 * profile does not advertise input.touch.
 */

#include "input.h"

#include <3ds.h>
#include <stddef.h>

/* contracts/spec/spec.ts BTN. */
#define BTN_SELECT 0x0001
#define BTN_START 0x0008
#define BTN_UP 0x0010
#define BTN_RIGHT 0x0020
#define BTN_DOWN 0x0040
#define BTN_LEFT 0x0080
#define BTN_LTRIGGER 0x0100
#define BTN_RTRIGGER 0x0200
#define BTN_TRIANGLE 0x1000
#define BTN_CIRCLE 0x2000
#define BTN_CROSS 0x4000
#define BTN_SQUARE 0x8000

/* Full-deflection reading of the circle pad on both console revisions. */
#define CIRCLE_PAD_RANGE 156

static const struct {
  uint32_t key;
  int32_t button;
} KEY_MAP[] = {
  { KEY_A, BTN_CIRCLE },
  { KEY_B, BTN_CROSS },
  { KEY_X, BTN_TRIANGLE },
  { KEY_Y, BTN_SQUARE },
  { KEY_L, BTN_LTRIGGER },
  { KEY_R, BTN_RTRIGGER },
  { KEY_START, BTN_START },
  { KEY_SELECT, BTN_SELECT },
  { KEY_DUP, BTN_UP },
  { KEY_DDOWN, BTN_DOWN },
  { KEY_DLEFT, BTN_LEFT },
  { KEY_DRIGHT, BTN_RIGHT },
};

int32_t input_buttons(void) {
  uint32_t held = hidKeysHeld();
  int32_t buttons = 0;
  for (size_t index = 0; index < sizeof KEY_MAP / sizeof KEY_MAP[0]; index += 1) {
    if (held & KEY_MAP[index].key) buttons |= KEY_MAP[index].button;
  }
  return buttons;
}

/* One axis to the PSP nub's 0..255 with 128 the centre. */
static int32_t axis(int value) {
  int scaled = 128 + (value * 127) / CIRCLE_PAD_RANGE;
  if (scaled < 0) scaled = 0;
  if (scaled > 255) scaled = 255;
  return scaled;
}

int32_t input_analog(void) {
  circlePosition pad;
  hidCircleRead(&pad);
  /* The circle pad reads dy positive UP; the contract's Y is positive DOWN. */
  return (axis(pad.dx) << 8) | axis(-pad.dy);
}
