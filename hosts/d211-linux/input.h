#ifndef POCKETJS_D211_LINUX_INPUT_H
#define POCKETJS_D211_LINUX_INPUT_H

/*
 * Linux evdev touch sampling for the D211 fbdev host.
 *
 * The device is found by capability, never by a fixed /dev/input/eventN: the
 * host scans /dev/input, reads EVIOCGNAME/EVIOCGBIT(EV_ABS), and prefers a
 * multi-touch axis pair over the single-touch one. Raw axis values are scaled
 * to the logical viewport by the caller.
 */

typedef struct {
  int fd;
  int axis_x;
  int axis_y;
  int max_x;
  int max_y;
  int x;
  int y;
  int down;
  int have_position;
  char name[64];
} D211Input;

/** Opens the first touch-capable evdev device; returns 0 when none exists. */
int d211_input_open(D211Input *input);

void d211_input_close(D211Input *input);

/**
 * Drains pending events. Returns 1 when the contact went down in this batch,
 * so the caller resolves the bounds hit once at the down edge.
 */
int d211_input_pump(D211Input *input);

#endif
