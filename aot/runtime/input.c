// aot/runtime/input.c — key polling with edge detection.
#include "runtime.h"

void input_poll(void) {
  g.keys_prev = g.keys;
  g.keys = (u16)((~REG_KEYINPUT) & 0x3ff); // active-low -> active-high held mask
}

int key_held(int mask) { return (g.keys & mask) != 0; }

int key_pressed(int mask) {
  return (g.keys & mask) != 0 && (g.keys_prev & mask) == 0;
}
