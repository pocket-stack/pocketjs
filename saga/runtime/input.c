/* saga/runtime/input.c */
#include "saga.h"

void input_poll(void) {
  g.keys_prev = g.keys;
  g.keys = (u16)(~REG_KEYINPUT) & KEY_MASK;
  g.rng = g.rng * 25173 + 13849;
}

u16 key_held(u16 m) {
  return g.keys & m;
}

u16 key_pressed(u16 m) {
  return g.keys & ~g.keys_prev & m;
}
