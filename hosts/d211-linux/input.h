#ifndef POCKETJS_D211_LINUX_INPUT_H
#define POCKETJS_D211_LINUX_INPUT_H

/*
 * Linux evdev touch sampling for the D211 fbdev host.
 *
 * The device is found by capability, never by a fixed /dev/input/eventN. A
 * multi-touch axis pair is preferred and parsed with the protocol-B slot
 * state machine (ABS_MT_SLOT / ABS_MT_TRACKING_ID); ABS_X/ABS_Y plus
 * BTN_TOUCH is the single-contact fallback. Raw axis values are scaled to
 * the logical viewport by the caller.
 */

#define D211_MAX_CONTACTS 8

typedef struct {
  int id; /* contact slot, stable while the contact is down */
  int x;  /* raw evdev coordinate */
  int y;
} D211Contact;

typedef struct {
  int count;
  D211Contact contacts[D211_MAX_CONTACTS];
} D211ContactState;

typedef struct {
  int fd;
  int axis_x;
  int axis_y;
  int max_x;
  int max_y;
  int tracking_axis;
  int slot_axis;
  int multi_touch;
  int current_slot;
  int slot_active[D211_MAX_CONTACTS];
  int slot_x[D211_MAX_CONTACTS];
  int slot_y[D211_MAX_CONTACTS];
  int slot_pending_down[D211_MAX_CONTACTS];
  int single_down;
  int single_x;
  int single_y;
  int single_pending_down;
  char name[64];
} D211Input;

/** Opens the first touch-capable evdev device; returns 0 when none exists. */
int d211_input_open(D211Input *input);

void d211_input_close(D211Input *input);

/**
 * Drains pending events and fills the active-contact snapshot. Returns a
 * bitmask over `state->contacts`: bit i is set when entry i went down in this
 * batch, so the caller resolves each bounds hit once at its down edge.
 */
unsigned int d211_input_pump(D211Input *input, D211ContactState *state);

#endif
